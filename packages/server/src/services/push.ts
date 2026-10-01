import crypto from 'node:crypto';
import type { PushSubscriptionJSON } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { config, pushConfigured } from '../config.js';
import { oeffentlichAusRoh, rohOeffentlich, schluesselpaarAusRoh } from '../crypto/ec.js';
import { uiLanguageOf } from './store.js';
import { WOERTERBUECHER as PUSH_WOERTERBUECHER, type PushKey } from './push-i18n.js';

/**
 * Web Push — Benachrichtigungen, die ankommen, ohne dass die App läuft.
 *
 * DER UNTERSCHIED ZUM BISHERIGEN WEG
 *
 * Jede Benachrichtigung bis hierher — `state/store.ts` → `zeigen()` →
 * `ServiceWorkerRegistration.showNotification` oder `new Notification()` —
 * setzt eine offene Verbindung voraus: ein Browser-Tab oder eine
 * Startbildschirm-App, die gerade läuft und am Draht hängt. Auf einem
 * gesperrten Telefon ist beides nicht der Fall, egal wie das Ereignis
 * entsteht. Deshalb kam bisher jedes ECHTE Ereignis nie an, während die
 * Probe-Benachrichtigung funktionierte — sie entsteht ja genau in dem
 * Moment, in dem man auf die offene App schaut.
 *
 * Web Push braucht keine offene Verbindung. Der Server schickt eine
 * verschlüsselte Nachricht an einen Push-Dienst (Apples, Googles oder
 * Mozillas, je nachdem woher das Gerät kam) — der liefert sie zu, auch wenn
 * das Telefon in der Tasche liegt. Der eigentliche Anzeige-Aufruf läuft dann
 * im Service Worker (`public/sw.js`, Ereignis `push`), nicht mehr in dieser
 * Datei.
 *
 * WARUM OHNE DAS PAKET "web-push"
 *
 * Fünf andere Beauftragte arbeiten gerade an diesem Repository, mehrere davon
 * an package.json-Dateien. Eine gemeinsame package-lock.json mitten in einem
 * `npm install` von zwei Prozessen gleichzeitig zu treffen, ist ein Risiko,
 * das dieses eine Paket nicht wert ist — der Algorithmus dahinter (RFC 8291,
 * RFC 8292) ist mit Node-Bordmitteln (node:crypto, HKDF, AES-128-GCM,
 * ECDH) vollständig nachbaubar, siehe unten.
 *
 * ZUSTÄNDIGKEIT
 *
 * Dieser Dienst kennt weder das Gateway noch den Aufbau einer Nachricht. Er
 * beantwortet zwei Fragen — "soll diese Person gerade etwas hören?" und
 * "dann schick es ihr" — und lässt offen, WELCHES Ereignis das war. Das
 * Gateway entscheidet, wann er gerufen wird.
 *
 * SPRACHE VON TITEL UND TEXT — WARUM HIER UND NICHT IM SERVICE WORKER
 *
 * `sendenAn()` nimmt für `titel` und `text` kein fertiges `string` mehr
 * entgegen, sondern ein `PushTextfeld` — ein deutscher Rückfalltext, plus
 * optional ein `code` aus dem kleinen Wörterbuch in push-i18n.ts, plus
 * optionale Platzhalterwerte. Genau die Form, die `fail()` in ws/gateway.ts
 * für Server→Client-Fehlertexte schon vorlebt (`code`, `message`, `werte`).
 *
 * Zwei Stellen kämen für die Auflösung infrage: hier (der Server kennt die
 * Sprache über `uiLanguageOf()` und verschickt fertigen Text) oder im
 * Service Worker (der Server verschickt nur `code`+`werte`, `public/sw.js`
 * löst über ein eigenes kleines Wörterbuch auf). Entschieden für HIER, aus
 * drei Gründen:
 *
 * 1. STILLSTAND EINES SERVICE WORKERS. `public/sw.js` wird per
 *    `skipWaiting()`/`clients.claim()` zwar zügig ersetzt, aber "zügig" ist
 *    nicht "sofort" — zwischen zwei Besuchen kann ein Gerät mit einem
 *    Service-Worker-Stand unterwegs sein, der einen neueren `code` (aus
 *    einer künftigen Auslieferung) nicht kennt. Löst DER SERVER auf, ist das
 *    ohne Bedeutung — er schickt in jedem Fall fertigen Text, egal wie alt
 *    der Service Worker ist, der ihn nur noch anzeigt. Löst der Service
 *    Worker auf, fiele ein unbekannter `code` auf den deutschen Rückfall
 *    zurück — für niemanden falsch, aber für alle außer deutschsprachigen
 *    Personen schlechter, als es sein müsste, und zwar genau in der Zeit
 *    kurz nach jeder Auslieferung, in der neue Schlüssel am ehesten
 *    vorkommen.
 * 2. KEIN drittes Sprachfeld nötig. Der Service-Worker-Weg bräuchte neben
 *    `code`/`werte` zusätzlich die Zielsprache selbst in der Nutzlast (der
 *    Worker kennt sie sonst nicht) — noch ein Feld, noch ein Fall, in dem es
 *    fehlen oder falsch sein kann. Löst der Server auf, bleibt die Nutzlast
 *    bei genau den Feldern, die es vorher schon gab: `{ titel, text,
 *    kanalId, gruppe }` — `public/sw.js` braucht dafür keine einzige
 *    Änderung.
 * 3. PRÜFBARKEIT OHNE BROWSER. Die Auflösung lässt sich mit einem einzigen
 *    Node-Aufruf für alle 22 Sprachen nachvollziehen (`textAufloesen()`
 *    unten) — kein Service-Worker-Kontext nötig, um zu sehen, was auf einem
 *    Sperrbildschirm stünde.
 *
 * Der oft genannte Einwand gegen eine Sprachänderung ZWISCHEN Absenden und
 * Zustellung trifft beide Wege GLEICH: die Sprache wird so oder so beim
 * Absenden festgelegt (hier direkt als Text, beim anderen Weg als
 * `code`+Sprachkennung) — kein Entwurf kann eine Nachricht nachträglich
 * umschreiben, die der Push-Dienst schon angenommen hat. Das ist kein
 * Nachteil dieser Entscheidung, sondern eine Eigenschaft von Push
 * überhaupt.
 */

interface Abo { id: string; endpoint: string; p256dh: string; auth: string }

/**
 * Darf der Server diesen Endpoint überhaupt ansprechen?
 *
 * Der Endpoint kommt vom Client und wird später hier per fetch() angesprochen
 * — ohne Prüfung wäre er ein SSRF-Hebel aus jeder angemeldeten Sitzung: eine
 * http-Adresse ins interne Netz (Admin-Panels, Metadaten-Dienste, andere
 * Geräte hinter dem Tunnel), und der Server POSTet aktiv dorthin. Zugelassen
 * wird deshalb nur https mit einem namentlichen Host; IP-Literale und alles,
 * was nach innen zeigt (localhost, .local, .internal, private Bereiche),
 * fliegt heraus. Echte Push-Dienste (FCM, Mozilla, Apple) haben ohnehin
 * Namen — diese Prüfung nimmt ihnen nichts weg.
 */
function endpointTauglich(endpoint: string): boolean {
  /* Ausweg NUR für Prüfläufe: die E2E-Skripte sprechen einen fingierten
     Push-Dienst auf 127.0.0.1 an. Die Variable wird nie in einer echten
     Umgebung gesetzt — server-setup und .env.example kennen sie nicht. */
  if (process.env.STELLIUM_PUSH_TESTZIELE === '1') return true;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  /* Ohne Punkt im Namen gibt es keine echten Push-Dienste — und localhost
     fällt ohnehin gleich darunter. */
  if (!host || !host.includes('.')) return false;
  if (host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.startsWith('[')) return false; // IPv6-Literale: Push-Dienste haben Namen
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const intern = a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
    if (intern) return false;
  }
  return true;
}

/* ── Abonnements ──────────────────────────────────────────────── */

export function abonnieren(userId: string, sub: PushSubscriptionJSON): void {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return;
  /* Erste Sperre am Eingang: ein Endpoint, der nicht nach außen zeigt, wird
     gar nicht erst gespeichert. */
  if (!endpointTauglich(sub.endpoint)) return;
  db.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    newId('psh_'), userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now(),
  );
}

/**
 * Ein Abonnement entfernen.
 *
 * Mit `userId` nur die ZEILE DIESES KONTOs — der Weg aus dem Gateway
 * (`push:unsubscribe`). Ohne die Einschränkung könnte jedes angemeldete
 * Konto die Zeile eines fremden Kontos löschen: die Endpoint-URL steht im
 * Klartext im Abonnement und liegt dauerhaft in der Tabelle — wer sie
 * erfährt, hätte dem Opfer sonst still alle Push-Benachrichtigungen
 * abgedreht, ohne dass dessen Client es merkt. Der interne Aufruf unten
 * (`anEinGeraet`, Aufräumen nach 404/410) kommt ohne Konto aus: der Endpoint
 * stammt dort aus derselben Tabelle, nicht von einem Client.
 */
export function abbestellen(endpoint: string, userId?: string): void {
  if (userId) db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, userId);
  else db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
}

function abosFuer(userId: string): Abo[] {
  return db.all<Abo>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', userId,
  );
}

/* ── Soll überhaupt benachrichtigt werden? ───────────────────────
   Gegenstück zu notifyIfNeeded() in packages/desktop/src/state/store.ts.
   Muss hier noch einmal stehen, weil im Moment des Zustellens kein
   Browser-Tab mehr läuft, der selbst entscheiden könnte. */

interface Empfaenger {
  notify_on: string;
  status: string;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  timezone: string;
}

/** Minuten seit Mitternacht — in der Zeitzone der Person, nicht des Servers. */
function minutenSeitMitternacht(timezone: string): number {
  try {
    const teile = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    // hour12:false liefert für Mitternacht in manchen Engines "24" statt "00".
    const stunde = Number(teile.find((t) => t.type === 'hour')?.value ?? '0') % 24;
    const minute = Number(teile.find((t) => t.type === 'minute')?.value ?? '0');
    return stunde * 60 + minute;
  } catch {
    // Unbekannte oder falsch eingetragene Zeitzone: lieber wie "immer wach"
    // rechnen als eine Ruhezeit zu erfinden, die niemand gesetzt hat.
    const jetzt = new Date();
    return jetzt.getUTCHours() * 60 + jetzt.getUTCMinutes();
  }
}

function inRuhezeit(u: Empfaenger): boolean {
  if (u.quiet_hours_start == null || u.quiet_hours_end == null) return false;
  const jetzt = minutenSeitMitternacht(u.timezone);
  const { quiet_hours_start: start, quiet_hours_end: end } = u;
  return start <= end ? jetzt >= start && jetzt < end : jetzt >= start || jetzt < end;
}

/**
 * Soll diese Person gerade eine Push-Benachrichtigung bekommen?
 *
 * `dringend` steht für alles, was direkt an die Person adressiert ist —
 * eine Erwähnung, eine Direktnachricht, eine zugeteilte Aufgabe, ein für sie
 * bestimmter KI-Vorschlag, eine eigene fällige Erinnerung. Genau wie im
 * Vorbild in store.ts kommt Dringendes durch Ruhezeiten, Stummschaltung und
 * "nur Erwähnungen" hindurch — nur "aus" und "nicht stören" halten auch das
 * noch zurück.
 */
export function sollBenachrichtigen(
  userId: string,
  opts: { channelId?: string | null; dringend: boolean },
): boolean {
  const u = db.get<Empfaenger>(
    'SELECT notify_on, status, quiet_hours_start, quiet_hours_end, timezone FROM users WHERE id = ?', userId,
  );
  if (!u) return false;
  if (u.notify_on === 'none') return false;
  if (u.status === 'dnd') return false;
  if (u.notify_on === 'mentions' && !opts.dringend) return false;
  if (opts.channelId && !opts.dringend) {
    const mitgliedschaft = db.get<{ muted: number }>(
      'SELECT muted FROM channel_members WHERE channel_id = ? AND user_id = ?', opts.channelId, userId,
    );
    if (mitgliedschaft?.muted) return false;
  }
  if (inRuhezeit(u) && !opts.dringend) return false;
  return true;
}

/* ── VAPID: diesen Server gegenüber dem Push-Dienst ausweisen ───── */

function b64url(input: Buffer): string { return input.toString('base64url'); }

/**
 * Ein VAPID-JWT für genau diesen Push-Dienst (RFC 8292).
 *
 * `aud` muss der bloße Ursprung des Zustell-Endpunkts sein (z. B.
 * "https://fcm.googleapis.com"), nicht die volle Adresse — sonst weist der
 * Dienst die Anfrage ab. Zwölf Stunden Gültigkeit sind großzügig: das Token
 * entsteht neu bei jedem Versand, es muss nur diesen einen Versand
 * überstehen.
 */
function vapidJwt(audience: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: config.push.subject,
  })));
  const signingInput = `${header}.${claims}`;
  const schluessel = schluesselpaarAusRoh(
    Buffer.from(config.push.privateKey, 'base64url'),
    Buffer.from(config.push.publicKey, 'base64url'),
  );
  /* dsaEncoding: 'ieee-p1363' liefert r‖s als feste 64 Byte statt ASN.1/DER —
     genau die Rohform, die ein JWS-Signaturteil braucht. Ohne diese Angabe
     läge hier eine DER-Struktur, die kein Browser als JWT akzeptiert. */
  const signatur = crypto.sign('sha256', Buffer.from(signingInput), {
    key: schluessel, dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signatur)}`;
}

/* ── Nutzlast verschlüsseln (RFC 8291, Content-Encoding aes128gcm) ── */

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, laenge: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, laenge));
}

/**
 * Eine Nutzlast für genau ein Abonnement verschlüsseln.
 *
 * Ein zweites Schlüsselpaar kommt hier ins Spiel — nicht das VAPID-Paar von
 * oben (das weist nur den Server aus), sondern ein frisches, nur für diese
 * eine Nachricht erzeugtes ECDH-Paar. Der Push-Dienst selbst kann die
 * Nutzlast nicht lesen, nur das Gerät, dessen `p256dh`/`auth` hier eingehen —
 * das ist der Sinn der Übung: der Dienst liefert nur zu, er liest nicht mit.
 */
function verschluesseln(klartext: Buffer, p256dhB64: string, authB64: string): Buffer {
  const empfaengerPunkt = Buffer.from(p256dhB64, 'base64url');
  const authSecret = Buffer.from(authB64, 'base64url');
  const empfaenger = oeffentlichAusRoh(empfaengerPunkt);

  const { publicKey: ephPub, privateKey: ephPriv } =
    crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ephPubRoh = rohOeffentlich(ephPub);

  const geheim = crypto.diffieHellman({ privateKey: ephPriv, publicKey: empfaenger });

  // Erste HKDF-Runde: aus dem ECDH-Geheimnis und dem Auth-Secret des Geräts
  // ein gemeinsames IKM ableiten (RFC 8291 Abschnitt 3.4).
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), empfaengerPunkt, ephPubRoh]);
  const ikm = hkdf(authSecret, geheim, authInfo, 32);

  // Zweite Runde: aus dem IKM und einem zufälligen Salt Schlüssel und Nonce
  // für AES-128-GCM ableiten (RFC 8188).
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // 0x02 markiert "letzter (und hier: einziger) Datensatz" — die Nutzlast
  // ist ein paar hundert Byte groß, Push-Dienste erlauben ohnehin nur bis
  // 4096 verschlüsselt, ein zweiter Datensatz wird nie gebraucht.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const chiffrat = Buffer.concat([
    cipher.update(Buffer.concat([klartext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // Aufbau nach RFC 8188 §2: Salt(16) ‖ RecordSize(4, big-endian) ‖
  // KeyIdLänge(1) ‖ KeyId(der eigene öffentliche Punkt) ‖ Chiffrat.
  const kopf = Buffer.alloc(16 + 4 + 1);
  salt.copy(kopf, 0);
  kopf.writeUInt32BE(4096, 16);
  kopf.writeUInt8(ephPubRoh.length, 20);

  return Buffer.concat([kopf, ephPubRoh, chiffrat]);
}

/* ── Versand ──────────────────────────────────────────────────── */

/** Ein Tag — länger liegen gebliebene Chat-Ereignisse sind meist ohnehin überholt. */
const TTL_SEKUNDEN = 24 * 3600;

/**
 * Die einzige ausgehende Anfrage im ganzen Server ohne eigenes Zeitlimit war
 * die hier — jede andere (KI-Anbieter, DeepL, LibreTranslate, Patreon,
 * Gumroad, Link-Vorschau, Wechselkurse, Transkription) trägt einen
 * AbortController. Ohne ihn hält ein Push-Dienst, der die Verbindung
 * annimmt und dann einfach schweigt, Socket UND das nie erwartete Promise
 * offen — und weil sendenAn() bewusst mit `void` aufgerufen wird (siehe
 * ws/gateway.ts), merkt das niemand von selbst.
 *
 * 8 Sekunden: großzügiger als die Link-Vorschau (6s, dort ein beliebiges,
 * nicht vertrauenswürdiges Ziel) — ein verlorenes Push ist eine verpasste
 * Benachrichtigung, das soll nicht an einer kurzen Verzögerung bei FCM,
 * Mozilla oder Apple scheitern. Aber weit unter dem, was ungebremst
 * passieren könnte: die Nutzlast ist klein (höchstens 4096 Byte
 * verschlüsselt, siehe RecordSize weiter oben), ein gesunder Push-Dienst
 * antwortet in der Praxis in Millisekunden.
 */
const ZEITLIMIT_MS = 8_000;

async function anEinGeraet(abo: Abo, nutzlast: Buffer): Promise<void> {
  /* Zweite Sperre am Ausgang: Zeilen, die VOR dieser Prüfung gespeichert
     wurden (oder aus einem Import stammen), werden hier nicht mehr
     angesprochen — und gleich mit wegräumt, statt den Versuch bei jeder
     Nachricht zu wiederholen. */
  if (!endpointTauglich(abo.endpoint)) {
    abbestellen(abo.endpoint);
    return;
  }
  const ziel = new URL(abo.endpoint);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZEITLIMIT_MS);
  try {
    const antwort = await fetch(abo.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        ttl: String(TTL_SEKUNDEN),
        authorization: `vapid t=${vapidJwt(ziel.origin)}, k=${config.push.publicKey}`,
      },
      body: nutzlast,
      signal: ctrl.signal,
      /* Keiner Umleitung folgen. endpointTauglich() prüft nur die ERSTE
         Adresse; ein Endpoint auf einem eigenen, öffentlichen Host könnte mit
         `307 -> http://192.168.1.1/…` antworten, und fetch trüge denselben
         POST samt Körper ins Heimnetz des Pi — an allen Sperren oben vorbei.
         Echte Push-Dienste leiten nicht um; eine 3xx-Antwort landet unten als
         gewöhnlicher Fehlschlag im Protokoll. */
      redirect: 'manual',
    });

    if (antwort.status === 404 || antwort.status === 410) {
      // Der Push-Dienst kennt das Gerät nicht mehr — abgemeldet, Browserdaten
      // gelöscht, oder es war nie ein gültiges Abonnement. Aufräumen statt bei
      // jeder künftigen Nachricht erneut daran zu scheitern.
      //
      // Dieser Zweig sieht ausschließlich eine tatsächlich eingegangene
      // Antwort mit diesem Statuscode. Ein Abbruch durchs Zeitlimit läuft nie
      // hier durch — fetch() wirft dann direkt (siehe catch unten), bevor
      // "antwort" überhaupt existiert. Ein bloß hängender Dienst darf also
      // nie als "kennt das Gerät nicht mehr" missverstanden und ein
      // eigentlich gültiges Abonnement dafür abbestellt werden.
      abbestellen(abo.endpoint);
      return;
    }
    if (!antwort.ok) {
      throw new Error(`Push-Dienst antwortete ${antwort.status} ${antwort.statusText}`);
    }
  } catch (err) {
    // Dieselbe Unterscheidung wie überall sonst im Haus (siehe etwa
    // services/voice.ts, services/links.ts): ein Abbruch durchs Zeitlimit
    // trägt den Namen "AbortError" und ist kein HTTP-Fehler. Ohne diese
    // Umbenennung liefe er als anonyme Ausnahme bei sendenAn() auf und ließe
    // sich von einem echten Serverfehler beim Fehlersuchen nicht mehr
    // unterscheiden.
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Push-Dienst antwortete nicht innerhalb von ${ZEITLIMIT_MS / 1000}s (${ziel.origin}).`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Sprache von Titel und Text ──────────────────────────────────
   Siehe Dateikopf, Abschnitt "SPRACHE VON TITEL UND TEXT". */

/**
 * Ein Titel- oder Textfeld für `sendenAn()`.
 *
 * `text` ist der deutsche Text — für echten Nachrichteninhalt (eine
 * Chatnachricht, ein Aufgabentitel, ein Mailbetreff) OHNE `code` der EINZIGE
 * Text, den es je gibt: so etwas darf nie durch eine Übersetzung ersetzt
 * werden. Mit `code` ist er der Rückfall, falls für die Zielsprache (noch)
 * kein Eintrag in push-i18n.ts besteht, oder ganz ohne Bedeutung, wenn die
 * Auflösung gelingt — dann gewinnt IMMER push-i18n.ts, auch für Deutsch
 * selbst, damit es nicht zwei leicht verschiedene deutsche Fassungen
 * desselben Satzes gibt (eine hier, eine in push-i18n.ts).
 */
export interface PushTextfeld {
  /** Deutscher Text — Rückfall (`code` fehlt/unbekannt) oder, ohne `code`, der einzige Text. */
  text: string;
  /** Schlüssel aus push-i18n.ts. Fehlt er, bleibt es beim deutschen Text aus `text`. */
  code?: PushKey;
  /** Platzhalterwerte für `code`, z. B. `{ fach: 'billing' }`. */
  werte?: Record<string, string>;
}

/**
 * `feld` in `sprache` auflösen.
 *
 * Rückfallkette wie `translate()` in packages/desktop/src/i18n/kern.ts:
 * eigene Sprache → Deutsch → der deutsche Rückfalltext aus `feld.text` selbst
 * (praktisch nie nötig — push-i18n.ts trägt alle neun Schlüssel für alle 22
 * Sprachen, geprüft von scripts/push-woerterbuch-pruefen.mjs). Platzhalter
 * `{name}` — derselbe reguläre Ausdruck wie in kern.ts, damit ein Text ohne
 * Änderung zwischen beiden Wörterbüchern wandern kann.
 */
export function textAufloesen(sprache: string, feld: PushTextfeld): string {
  if (!feld.code) return feld.text;
  const kurz = sprache.toLowerCase().split(/[-_]/)[0];
  const wb = PUSH_WOERTERBUECHER[kurz] ?? PUSH_WOERTERBUECHER.de;
  const roh = wb[feld.code] ?? PUSH_WOERTERBUECHER.de[feld.code] ?? feld.text;
  if (!feld.werte) return roh;
  const werte = feld.werte;
  return roh.replace(/\{\{?(\w+)\}?\}/g, (ganz, name) => werte[name] ?? ganz);
}

/**
 * Eine Benachrichtigung an alle Geräte einer Person schicken.
 *
 * Wirft nie — ein unerreichbarer Push-Dienst oder ein einzelnes verfallenes
 * Abonnement darf weder das Absenden einer Chat-Nachricht verzögern noch die
 * Zustellung an die anderen Geräte derselben Person verhindern. Der Aufrufer
 * ruft das bewusst ohne `await` auf (siehe ws/gateway.ts).
 *
 * `titel`/`text` lösen sich hier auf, nicht erst in `public/sw.js` — siehe
 * Dateikopf. `uiLanguageOf()` ist ein einfacher, synchroner DB-Read und
 * kennt die Zielsprache unabhängig davon, ob gerade ein Fenster offen ist.
 */
export async function sendenAn(
  userId: string,
  nachricht: { titel: PushTextfeld; text: PushTextfeld; kanalId?: string | null; gruppe?: string },
): Promise<void> {
  if (!pushConfigured()) return;
  const abos = abosFuer(userId);
  if (!abos.length) return;

  const sprache = uiLanguageOf(userId);
  const nutzlast = Buffer.from(JSON.stringify({
    titel: textAufloesen(sprache, nachricht.titel).slice(0, 200),
    text: textAufloesen(sprache, nachricht.text).slice(0, 500),
    kanalId: nachricht.kanalId ?? null,
    gruppe: nachricht.gruppe ?? null,
  }));

  await Promise.all(abos.map(async (abo) => {
    try {
      await anEinGeraet(abo, verschluesseln(nutzlast, abo.p256dh, abo.auth));
    } catch (err) {
      console.error('[push]', abo.id, (err as Error).message);
    }
  }));
}
