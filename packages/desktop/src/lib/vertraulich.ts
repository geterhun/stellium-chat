import {
  CODE_ALPHABET, PAKET_ALG,
  codeNormalisieren, istE2EChiffrat, nutzlastLesen, nutzlastSchreiben,
  umschlagLesen, umschlagSchreiben, wiederherstellungNormalisieren,
  WIEDERHERSTELLUNG_GRUPPEN, WIEDERHERSTELLUNG_GRUPPENLAENGE,
  type DateiHuelle, type DateiUmschlag, type SchluesselPaket, type ServerEvent,
} from '@stellium/shared';
import { socket } from '../net/socket.js';
import { dateiUrl } from '../net/api.js';
import { useStore } from '../state/store.js';
import { spracheDesSystems, translate, type TranslationKey } from '../i18n/kern.js';

/**
 * Meldungen dieser Ebene in der eingestellten Oberflächensprache.
 *
 * Derselbe Weg wie in net/api.ts, jetzt richtig: über den Kern (i18n/kern.js)
 * geladen, nicht über i18n/index.js — DAS lädt seinerseits den Zustand, und
 * erst dabei entstünde (über diese Datei, die der Zustand ihrerseits
 * einbindet) ein Ringschluss. Der Zustand selbst lässt sich unabhängig davon
 * gefahrlos direkt anfassen, wie state/store.ts es in seiner eigenen
 * ts()-Funktion vormacht: useStore.getState() liest nur beim tatsächlichen
 * Aufruf, nicht beim Laden des Moduls — beide Module sind zu dem Zeitpunkt
 * längst fertig geladen.
 *
 * Vorher stand hier spracheDesSystems() für alle 17 Meldungen dieser Datei —
 * die Sprache des Rechners statt der eingestellten Oberflächensprache. Vor
 * der Anmeldung ist self noch null, dann greift der Rückfall auf
 * spracheDesSystems() ohnehin von selbst.
 */
function txt(key: TranslationKey, werte?: Record<string, string | number>): string {
  return translate(useStore.getState().self?.uiLanguage || spracheDesSystems(), key, werte);
}

/**
 * Ende-zu-Ende-Verschlüsselung — die Seite, auf der die Schlüssel liegen.
 *
 * Der Server verwahrt öffentliche Schlüsselteile und verschlossene Pakete;
 * geöffnet wird ausschließlich hier. Das ist der ganze Unterschied zur
 * Verschlüsselung in `crypto/nachrichten.ts` auf dem Server: die schützt gegen
 * den gestohlenen Datenträger, diese hier gegen den Server selbst.
 *
 * Der Aufbau in drei Sätzen:
 *
 *   Jedes Konto hat ein Schlüsselpaar (ECDH P-256). Der öffentliche Teil liegt
 *   beim Server, der private nur hier.
 *
 *   Jeder vertrauliche Kanal hat einen symmetrischen Schlüssel (AES-GCM). Er
 *   wird für jedes Mitglied einzeln verpackt — mit einem Geheimnis, das aus
 *   dem eigenen privaten und dem fremden öffentlichen Teil entsteht und das
 *   der Server nicht nachbilden kann.
 *
 *   Nachrichten werden mit dem Kanalschlüssel verschlossen. Der Server sieht
 *   "e1:2:…" und sonst nichts.
 *
 * Was diese Datei bewusst NICHT tut: den privaten Schlüssel verstecken. Er
 * liegt im localStorage, genau wie das Anmelde-Token daneben. Wer an die Platte
 * kommt und das Konto entsperrt hat, hat ohnehin die laufende Sitzung — ein
 * zusätzliches Passwort bei jedem Start hätte hier nichts gewonnen, was nicht
 * schon verloren wäre, und hätte jeden Start um eine Eingabe verlängert.
 */

/* ── Ablage auf dem Gerät ─────────────────────────────────────── */

const SCHL_PRIVAT = 'stellium.vertraulich.privat';
const SCHL_OEFFENTLICH = 'stellium.vertraulich.oeffentlich';

function ablegen(schluessel: string, wert: string): void {
  try { localStorage.setItem(schluessel, wert); } catch { /* voll oder gesperrt */ }
}
function holen(schluessel: string): string | null {
  try { return localStorage.getItem(schluessel); } catch { return null; }
}

/* ── Kleinkram ────────────────────────────────────────────────── */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(daten: ArrayBuffer | Uint8Array): string {
  const bytes = daten instanceof Uint8Array ? daten : new Uint8Array(daten);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Der Puffertyp steht bei den beiden folgenden Rückgaben ausgeschrieben da.
   Ein blankes `Uint8Array` kann seit TypeScript 5.7 auch auf einem geteilten
   Puffer sitzen, und den nimmt die Web Crypto API nicht an.

   Ausgeschrieben statt weggecastet, weil es hier keine Behauptung ist, sondern
   eine Tatsache: `new Uint8Array(n)` legt immer einen eigenen ArrayBuffer an,
   und `digest()` gibt immer einen zurück. Ein `as BufferSource` an jeder
   Aufrufstelle hätte dasselbe erreicht — aber als Zusicherung, die niemand
   mehr nachprüft. So steht die Wahrheit einmal an der Quelle statt siebenmal
   als Beteuerung weiter unten. */
export function unb64u(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256(text: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const daten = typeof text === 'string' ? enc.encode(text) : text;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', daten));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Zufällige Zeichen aus dem verwechslungsfreien Vorrat. */
function zufallsCode(zeichen: number): string {
  const roh = new Uint32Array(zeichen);
  crypto.getRandomValues(roh);
  /* Modulo über 2^32 verzerrt bei 31 Zeichen um weniger als ein
     Zehnmilliardstel — das ist bedeutungslos gegenüber dem, was ein Mensch
     beim Abschreiben eines Codes an Entropie verliert. */
  return [...roh].map((z) => CODE_ALPHABET[z % CODE_ALPHABET.length]).join('');
}

/* ── Das eigene Schlüsselpaar ─────────────────────────────────── */

let meineId: string | null = null;
let privatSchluessel: CryptoKey | null = null;
let oeffentlichJwk: string | null = null;

/** Öffentliche Teile der anderen — kommen vom Server, wenn wir fragen. */
const fremdeSchluessel = new Map<string, string>();

/**
 * Ein einzelner öffentlicher Teil, sofern schon angefordert.
 *
 * Für lib/notizen.ts: nach schluesselAnfordern() liegt der Teil hier, und
 * paketPacken() braucht ihn als eigenes Argument statt ihn sich selbst aus
 * der Karte zu holen — dieselbe Karte bleibt trotzdem die einzige, die es
 * davon gibt.
 */
export function fremderOeffentlicherSchluessel(userId: string): string | null {
  return fremdeSchluessel.get(userId) ?? null;
}

/**
 * Einen fremden öffentlichen Teil von Hand in die Karte legen — NUR für
 * Prüfläufe (scripts/notzugang-pruefen.mjs, Teil 3).
 *
 * Im Betrieb füllt sie sich ausschließlich aus `vertraulich:schluessel` über
 * den Draht. Ein Prüflauf lädt diese Datei aber ohne laufende Verbindung; ohne
 * diesen Zugang müsste er die halbe Sockelschicht nachbauen, nur um an eine
 * Karte zu kommen, die der geprüfte Code selbst gar nicht anzweifelt.
 * Derselbe Gedanke und dieselbe Namensendung wie bei
 * `_platzhalterAlternLassenFuerPruefung()` in ws/gateway.ts.
 */
export function _schluesselMerkenFuerPruefung(userId: string, jwk: string): void {
  fremdeSchluessel.set(userId, jwk);
}

/** Kanalschlüssel, entpackt. Nur im Speicher; auf der Platte bleiben Pakete. */
const kanalSchluessel = new Map<string, CryptoKey>();      // "<channelId>:<fassung>"

/** Welche Fassung in einem Kanal gerade gilt. */
const kanalFassung = new Map<string, number>();

function paarErzeugen(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as Promise<CryptoKeyPair>;
}

async function privatEinlesen(jwkText: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk', JSON.parse(jwkText), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
}

async function oeffentlichEinlesen(jwkText: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk', JSON.parse(jwkText), { name: 'ECDH', namedCurve: 'P-256' }, true, [],
  );
}

/**
 * Der Abdruck zum Vorlesen.
 *
 * Er ist die einzige Möglichkeit festzustellen, dass der Server keinen eigenen
 * Schlüssel untergeschoben hat: er könnte für jedes Konto einen zweiten
 * hinterlegen, alles mitlesen und weiterreichen, ohne dass jemandem etwas
 * auffiele. Zwei Menschen, die ihre Abdrücke am Telefon vergleichen, schließen
 * genau das aus — deshalb ist er kurz genug zum Vorlesen.
 */
export async function abdruckVon(jwkText: string): Promise<string> {
  const jwk = JSON.parse(jwkText) as { x?: string; y?: string };
  const roh = await sha256(`${jwk.x ?? ''}|${jwk.y ?? ''}`);
  const s = hex(roh.slice(0, 8)).toUpperCase();
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/**
 * Sicherstellen, dass dieses Gerät ein Schlüsselpaar hat, und den öffentlichen
 * Teil beim Server hinterlegen.
 *
 * Wird beim Start gerufen, nicht erst beim ersten vertraulichen Kanal. Der
 * Grund ist praktisch: für jemanden ohne hinterlegten öffentlichen Teil lässt
 * sich nichts verpacken — er könnte in keinen vertraulichen Kanal aufgenommen
 * werden und in keiner Verwaltung eine Freigabe entgegennehmen. Ein
 * Schlüsselpaar kostet Millisekunden; darauf zu warten, bis es gebraucht wird,
 * kostet den Moment, in dem es gebraucht wird.
 */
export async function schluesselBereitstellen(): Promise<{ abdruck: string; neu: boolean }> {
  const vorhanden = holen(SCHL_PRIVAT);
  const oeffentlich = holen(SCHL_OEFFENTLICH);

  if (vorhanden && oeffentlich) {
    privatSchluessel = await privatEinlesen(vorhanden);
    oeffentlichJwk = oeffentlich;
  } else {
    const paar = await paarErzeugen();
    const priv = await crypto.subtle.exportKey('jwk', paar.privateKey);
    const pub = await crypto.subtle.exportKey('jwk', paar.publicKey);
    privatSchluessel = paar.privateKey;
    oeffentlichJwk = JSON.stringify(pub);
    ablegen(SCHL_PRIVAT, JSON.stringify(priv));
    ablegen(SCHL_OEFFENTLICH, oeffentlichJwk);
  }

  const abdruck = await abdruckVon(oeffentlichJwk);
  socket.send({ t: 'vertraulich:schluessel-melden', jwk: oeffentlichJwk, abdruck });
  return { abdruck, neu: !vorhanden };
}

export function habeSchluessel(): boolean {
  return Boolean(privatSchluessel);
}

export function meinAbdruck(): Promise<string> {
  return oeffentlichJwk ? abdruckVon(oeffentlichJwk) : Promise.resolve('');
}

/**
 * Der eigene öffentliche Teil, roh — für lib/notizen.ts.
 *
 * Notizen brauchen dieselbe „ECDH mit sich selbst"-Verpackung wie private
 * Dateien (siehe kontoHuelle unten), aber als echtes, ablegbares Paket statt
 * einer deterministischen Ableitung: der Notizschlüssel muss sich rotieren
 * lassen, ein aus dem Kontoschlüssel abgeleiteter könnte das nicht. Dafür
 * braucht die aufrufende Stelle den eigenen öffentlichen Teil, so wie sie
 * ihn für jedes andere Mitglied auch aus fremdeSchluessel bekäme.
 */
export function eigenerOeffentlicherSchluessel(): string | null {
  return oeffentlichJwk;
}

/**
 * Der eigene PRIVATE Teil — ausschließlich für lib/notzugang.ts.
 *
 * Er wird sonst nirgends herausgegeben und soll es auch nicht; jede
 * Verpackung in diesem Haus läuft über gemeinsamerSchluessel() weiter unten,
 * ohne ihn je anzufassen. Der Notzugang ist die eine Ausnahme, und der Grund
 * steht bei gemeinsamerSchluesselMit(): dort muss NEBEN dem ECDH-Geheimnis
 * ein zweites (der mündlich weitergegebene Code) in dieselbe Ableitung, und
 * dafür braucht diese Rechnung den privaten Teil als Argument. Ausgeführt
 * wird er trotzdem nicht: er bleibt ein CryptoKey mit `extractable`, wie ihn
 * privatEinlesen() anlegt — was hier herauskommt, ist ein Griff, kein
 * Schlüsselmaterial zum Wegschreiben.
 */
export function eigenerPrivaterSchluessel(): CryptoKey | null {
  return privatSchluessel;
}

/* ── Verpacken und Auspacken ──────────────────────────────────── */

/**
 * Der gemeinsame Schlüssel zwischen zwei Konten.
 *
 * ECDH liefert für beide Seiten dasselbe Geheimnis — ich rechne mit meinem
 * privaten und deinem öffentlichen Teil, du mit deinem privaten und meinem
 * öffentlichen. Der Server hat von beidem nur die öffentlichen Hälften und
 * kommt damit nicht hin; das ist der ganze Trick.
 *
 * Der Kontext geht in die Ableitung ein, damit derselbe Schlüssel nie zweimal
 * für Verschiedenes benutzt wird: für jede Fassung jedes Kanals und jede
 * Richtung entsteht ein eigener.
 */
/* Exportiert (nicht nur für diese Datei): lib/notizen.ts braucht exakt
   dieselbe Ableitung, Verpackung und Auspackung — mit einem eigenen
   Kontext-Präfix (siehe dort), aber ohne eine zweite Fassung dieses Codes.
   Siehe Kommentar am Kopf von lib/notizen.ts. */
export async function gemeinsamerSchluessel(fremdJwk: string, kontext: string): Promise<CryptoKey> {
  if (!privatSchluessel) throw new Error(txt('fehler.keinSchluesselpaar'));
  return gemeinsamerSchluesselMit(privatSchluessel, fremdJwk, kontext, 'stellium/vertraulich/paket/v1');
}

/**
 * Dieselbe Rechnung mit einem MITGEGEBENEN privaten Teil — und, wenn nötig,
 * mit einem zweiten Geheimnis daneben.
 *
 * Zwei Gründe, warum es diese Fassung gibt, und beide kommen vom Notzugang
 * (lib/notzugang.ts):
 *
 *   DER FLÜCHTIGE ABSENDER. Ein Anteil wird mit einem WEGWERF-Schlüsselpaar
 *   verpackt, nicht mit dem eigenen dauerhaften. Der Grund ist die Lage, für
 *   die der Notzugang da ist: wer sein Gerät verloren hat, hat ein neues
 *   Schlüsselpaar — ein Anteil, der auf das alte rechnet, wäre genau dann
 *   unbrauchbar, wenn er gebraucht wird. Dafür muss der private Teil von
 *   außen hereinkommen; `privatSchluessel` ist er in diesem Fall nicht.
 *
 *   DAS ZWEITE SCHLOSS. `zusatz` sind weitere Bytes, die neben dem
 *   ECDH-Geheimnis in dieselbe Ableitung gehen — beim Notzugang die aus dem
 *   mündlich weitergegebenen Code abgeleiteten. Ergebnis: Öffnen kann nur,
 *   wer BEIDES hat. Der Server hat keines von beiden, auch dann nicht, wenn
 *   er einen falschen öffentlichen Teil untergeschoben hätte.
 *
 *   Bewusst EINE Ableitung aus beidem statt zwei Schichten übereinander
 *   (so wie es vorfallMelden() weiter unten macht): zwei Schichten brauchen
 *   zwei Zufallszahlen, zwei Formate und zwei Wege, an denen etwas
 *   schiefgehen kann. „Beides oder nichts" leistet die gemeinsame Ableitung
 *   genauso — HKDF bindet jedes Bit seines Eingabematerials.
 */
export async function gemeinsamerSchluesselMit(
  privat: CryptoKey, fremdJwk: string, kontext: string, info: string,
  zusatz?: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const fremd = await oeffentlichEinlesen(fremdJwk);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: fremd }, privat, 256));
  const material = zusatz ? new Uint8Array(bits.length + zusatz.length) : bits;
  if (zusatz) { material.set(bits, 0); material.set(zusatz, bits.length); }
  try {
    const roh = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode(info) },
      roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  } finally {
    // Das gemeinsame Geheimnis ist so gut wie der Schlüssel daraus.
    bits.fill(0);
    if (zusatz) material.fill(0);
  }
}

/** Kontext eines Pakets. Beide Seiten müssen ihn gleich bilden. */
function paketKontext(channelId: string, fassung: number, von: string, fuer: string): string {
  return `stellium/kanal/${channelId}/${fassung}/${von}>${fuer}`;
}

export async function paketPacken(
  kanalKey: CryptoKey, fremdJwk: string, kontext: string,
): Promise<SchluesselPaket> {
  const roh = await crypto.subtle.exportKey('raw', kanalKey);
  const huelle = await gemeinsamerSchluessel(fremdJwk, kontext);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return { alg: PAKET_ALG, von: meineId ?? '', iv: b64u(iv), daten: b64u(daten) };
}

export async function paketAuspacken(paket: SchluesselPaket, kontext: string): Promise<CryptoKey> {
  const fremdJwk = fremdeSchluessel.get(paket.von);
  if (!fremdJwk) throw new Error(txt('fehler.absenderSchluesselFehlt'));
  const huelle = await gemeinsamerSchluessel(fremdJwk, kontext);
  const roh = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten),
  );
  return crypto.subtle.importKey('raw', roh, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Öffentliche Teile anfordern und warten, bis sie da sind. */
export function schluesselAnfordern(userIds: string[]): Promise<void> {
  const fehlend = userIds.filter((id) => !fremdeSchluessel.has(id));
  if (!fehlend.length) return Promise.resolve();
  return new Promise((fertig) => {
    const ab = socket.onEvent((ev) => {
      if (ev.t !== 'vertraulich:schluessel') return;
      if (fehlend.every((id) => fremdeSchluessel.has(id))) { ab(); fertig(); }
    });
    socket.send({ t: 'vertraulich:schluessel-holen', userIds: fehlend });
    // Wer keinen Schlüssel hinterlegt hat, taucht nie auf. Nach fünf Sekunden
    // weitermachen ist besser als ewig warten — die Übrigen bekommen ihr Paket,
    // sobald ihre App sich meldet.
    setTimeout(() => { ab(); fertig(); }, 5000);
  });
}

/* ── Kanäle ───────────────────────────────────────────────────── */

function kanalKey(channelId: string, fassung: number): string {
  return `${channelId}:${fassung}`;
}

/** Ist dieser Kanal auf diesem Gerät lesbar? */
export function kanalLesbar(channelId: string, fassung = kanalFassung.get(channelId) ?? 0): boolean {
  return kanalSchluessel.has(kanalKey(channelId, fassung));
}

/**
 * Einen Kanal vertraulich stellen.
 *
 * Der Kanalschlüssel entsteht hier und verlässt das Gerät nur verpackt —
 * einmal für jedes Mitglied. Wer keinen öffentlichen Teil hinterlegt hat,
 * bekommt kein Paket und wird nachversorgt, sobald seine App sich meldet.
 */
export async function kanalVertraulichStellen(channelId: string, mitgliedIds: string[]): Promise<void> {
  await schluesselBereitstellen();
  await schluesselAnfordern(mitgliedIds);

  const kanalKeyNeu = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
  const fassung = 1;
  const pakete: { userId: string; paket: SchluesselPaket }[] = [];
  for (const uid of mitgliedIds) {
    const jwk = fremdeSchluessel.get(uid);
    if (!jwk) continue;
    pakete.push({
      userId: uid,
      paket: await paketPacken(kanalKeyNeu, jwk, paketKontext(channelId, fassung, meineId ?? '', uid)),
    });
  }
  kanalSchluessel.set(kanalKey(channelId, fassung), kanalKeyNeu);
  kanalFassung.set(channelId, fassung);
  socket.send({ t: 'vertraulich:einschalten', channelId, pakete });
}

/**
 * Fehlende Pakete für andere nachreichen.
 *
 * Der Server fragt danach, sobald jemand aufgenommen wurde oder einen neuen
 * Schlüssel gemeldet hat. Er fragt alle, die lesen können — wer zuerst
 * antwortet, hat verpackt, die übrigen Antworten laufen ins Leere.
 */
export async function paketeNachreichen(channelId: string, fassung: number, userIds: string[]): Promise<void> {
  const key = kanalSchluessel.get(kanalKey(channelId, fassung));
  if (!key) return;
  await schluesselAnfordern(userIds);

  const pakete: { userId: string; paket: SchluesselPaket }[] = [];
  for (const uid of userIds) {
    const jwk = fremdeSchluessel.get(uid);
    if (!jwk) continue;
    pakete.push({
      userId: uid,
      paket: await paketPacken(key, jwk, paketKontext(channelId, fassung, meineId ?? '', uid)),
    });
  }
  if (pakete.length) socket.send({ t: 'vertraulich:pakete', channelId, fassung, pakete });
}

/**
 * Den Kanalschlüssel wechseln, weil jemand gegangen ist.
 *
 * Der alte bleibt liegen: mit ihm ist der bisherige Verlauf verschlüsselt, und
 * ihn wegzuwerfen hieße, das eigene Archiv zu verlieren. Wer den Kanal
 * verlassen hat, behält ihn ebenfalls — und liest damit weiterhin, was er
 * ohnehin schon gelesen hat, aber nichts Neues mehr.
 */
export async function kanalSchluesselWechseln(channelId: string, mitgliedIds: string[]): Promise<void> {
  await schluesselAnfordern(mitgliedIds);
  const neu = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const fassung = (kanalFassung.get(channelId) ?? 0) + 1;

  const pakete: { userId: string; paket: SchluesselPaket }[] = [];
  for (const uid of mitgliedIds) {
    const jwk = fremdeSchluessel.get(uid);
    if (!jwk) continue;
    pakete.push({
      userId: uid,
      paket: await paketPacken(neu, jwk, paketKontext(channelId, fassung, meineId ?? '', uid)),
    });
  }
  kanalSchluessel.set(kanalKey(channelId, fassung), neu);
  kanalFassung.set(channelId, fassung);
  socket.send({ t: 'vertraulich:wechseln', channelId, pakete });
}

/* ── Nachrichten ──────────────────────────────────────────────── */

/**
 * Text für einen vertraulichen Kanal verschließen.
 *
 * Wirft, wenn der Schlüssel fehlt — bewusst, statt still den Klartext
 * durchzulassen. Der Server würde ihn ohnehin abweisen, aber schon hier
 * abzubrechen ist die ehrlichere Stelle: die Person sieht, dass ihre
 * Nachricht nicht rausging, statt sie später offen im Kanal zu finden.
 */
export async function nachrichtVerschluesseln(channelId: string, text: string): Promise<string> {
  const fassung = kanalFassung.get(channelId) ?? 0;
  const key = kanalSchluessel.get(kanalKey(channelId, fassung));
  if (!key) throw new Error(txt('fehler.kanalSchluesselFehlt'));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return nutzlastSchreiben({ fassung, iv: b64u(iv), daten: b64u(daten) });
}

/**
 * Umkehrung. Gibt null zurück, wenn der Schlüssel fehlt.
 *
 * Null und nicht ein geworfener Fehler: eine unlesbare Nachricht ist kein
 * Ausnahmefall, sondern ein normaler Zustand — etwa direkt nach einem
 * Gerätewechsel, bevor die Pakete da sind. Die Oberfläche zeigt dafür einen
 * Hinweis, keine Fehlermeldung.
 */
export async function nachrichtEntschluesseln(channelId: string, roh: string): Promise<string | null> {
  const nutzlast = nutzlastLesen(roh);
  if (!nutzlast) return roh;                 // gar nicht verschlüsselt
  const key = kanalSchluessel.get(kanalKey(channelId, nutzlast.fassung));
  if (!key) return null;
  try {
    const klar = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(nutzlast.iv) }, key, unb64u(nutzlast.daten),
    );
    return dec.decode(klar);
  } catch {
    return null;
  }
}

export { istE2EChiffrat };

/* ── Wiederherstellung nach einem Gerätewechsel ───────────────── */

/**
 * Der Schlüssel, mit dem ein Code etwas verschließt.
 *
 * PBKDF2 mit vielen Runden, weil ein Code kurz ist. Sechs Zeichen aus 31 sind
 * knapp neunhundert Millionen Möglichkeiten — ohne Runden hätte eine
 * Grafikkarte sie in Minuten durch. Mit 310.000 Runden kostet jeder Versuch
 * spürbar Zeit, und der Angreifer bräuchte Jahre statt Minuten.
 */
async function codeSchluessel(code: string, salzText: string, runden: number): Promise<CryptoKey> {
  const roh = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: await sha256(salzText), iterations: runden, hash: 'SHA-256' },
    roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/**
 * Einen Wiederherstellungscode erzeugen und die Sicherung hochladen.
 *
 * Das ist die Antwort auf den Gerätewechsel: der private Schlüssel liegt nur
 * in dieser App, und ein verlorenes Gerät hieße sonst, dass jeder vertrauliche
 * Kanal für diese Person für immer zu ist. Der Server verwahrt den privaten
 * Teil — verschlossen mit einem Code, den nur die Person hat. Er kann ihn
 * herausgeben und trotzdem nicht öffnen.
 *
 * Der Code wird genau einmal angezeigt. Nirgends gespeichert, auch nicht hier.
 */
export async function wiederherstellungscodeErzeugen(): Promise<string> {
  if (!privatSchluessel) throw new Error(txt('fehler.keinSchluesselpaar'));
  const roh = zufallsCode(WIEDERHERSTELLUNG_GRUPPEN * WIEDERHERSTELLUNG_GRUPPENLAENGE);
  const code = wiederherstellungNormalisieren(roh);

  const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', privatSchluessel));
  const key = await codeSchluessel(code.replace(/-/g, ''), `stellium/wiederherstellung/${meineId}`, 310_000);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(jwk));

  socket.send({
    t: 'vertraulich:schluessel-melden',
    jwk: oeffentlichJwk!,
    abdruck: await abdruckVon(oeffentlichJwk!),
    sicherung: JSON.stringify({ iv: b64u(iv), daten: b64u(daten) }),
  });
  return code;
}

/**
 * Auf einem neuen Gerät den alten Schlüssel zurückholen.
 *
 * Gelingt es, sind alle bisherigen Kanäle sofort wieder lesbar — die Pakete
 * liegen ja beim Server und waren immer schon für diesen Schlüssel bestimmt.
 */
export async function mitCodeWiederherstellen(codeRoh: string): Promise<boolean> {
  const code = wiederherstellungNormalisieren(codeRoh).replace(/-/g, '');
  const paket = await new Promise<string | null>((fertig) => {
    const ab = socket.onEvent((ev) => {
      if (ev.t !== 'vertraulich:sicherung') return;
      ab(); fertig(ev.paket);
    });
    socket.send({ t: 'vertraulich:sicherung-holen' });
    setTimeout(() => { ab(); fertig(null); }, 8000);
  });
  if (!paket) return false;

  try {
    const { iv, daten } = JSON.parse(paket) as { iv: string; daten: string };
    const key = await codeSchluessel(code, `stellium/wiederherstellung/${meineId}`, 310_000);
    const jwkText = dec.decode(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(iv) }, key, unb64u(daten),
    ));
    privatSchluessel = await privatEinlesen(jwkText);
    const pub = await crypto.subtle.exportKey('jwk', await abgeleiteterOeffentlicher(jwkText));
    oeffentlichJwk = JSON.stringify(pub);
    ablegen(SCHL_PRIVAT, jwkText);
    ablegen(SCHL_OEFFENTLICH, oeffentlichJwk);
    kanalSchluessel.clear();
    /* Auch die Dateien: was mit dem alten Stand nicht aufging, geht jetzt
       vielleicht — der Merkzettel hielte sonst die alte Antwort fest. */
    dateienVergessen();
    return true;
  } catch {
    return false;
  }
}

/**
 * Den öffentlichen Teil aus dem privaten gewinnen.
 *
 * Ein privates JWK trägt die Koordinaten des öffentlichen Punktes ohnehin bei
 * sich (x und y); es genügt, den privaten Anteil d wegzulassen. Das erspart
 * es, den öffentlichen Teil ein zweites Mal zu sichern.
 */
async function abgeleiteterOeffentlicher(privatJwk: string): Promise<CryptoKey> {
  const { d, key_ops: _ops, ...rest } = JSON.parse(privatJwk) as Record<string, unknown>;
  void d; void _ops;
  return crypto.subtle.importKey(
    'jwk', { ...rest, ext: true } as JsonWebKey, { name: 'ECDH', namedCurve: 'P-256' }, true, [],
  );
}

/* ── Freigabe bei Vorfällen ───────────────────────────────────── */

function freigabeKontext(channelId: string, fassung: number, von: string, fuer: string): string {
  return `stellium/freigabe/${channelId}/${fassung}/${von}>${fuer}`;
}

/**
 * Einen Vorfall melden und den Kanal für die Verwaltung öffnen.
 *
 * Zwei Schlösser hintereinander. Innen der Kanalschlüssel, verpackt für den
 * öffentlichen Teil jedes Verwaltungskontos — ohne dessen privaten Schlüssel
 * geht das nicht auf. Außen derselbe Inhalt noch einmal, verschlossen mit dem
 * Freigabecode.
 *
 * Warum beides? Das innere Schloss sorgt dafür, dass der Server nichts öffnen
 * kann. Das äußere sorgt dafür, dass er auch nichts weiterreichen kann, ohne
 * dass jemand den Code kennt — sonst wäre die Codeprüfung eine Hausregel, an
 * die sich der Server halten müsste, statt einer Tatsache.
 *
 * Der Code entsteht hier und nicht auf dem Server. Der Auftrag sah es anders
 * vor, aber ein Code, den der Server erzeugt, ist ein Code, den der Server
 * einen Moment lang kennt — und damit fiele genau das äußere Schloss weg.
 * Nach außen bleibt es dabei: die meldende Person bekommt den Code als
 * Antwort auf ihre Meldung und gibt ihn weiter.
 *
 * @returns Der Code. Er wird genau einmal angezeigt und nirgends gespeichert.
 */
export async function vorfallMelden(input: {
  channelId: string; grund: string; verwaltungIds: string[]; tage?: number;
}): Promise<string> {
  const fassung = kanalFassung.get(input.channelId) ?? 0;
  const key = kanalSchluessel.get(kanalKey(input.channelId, fassung));
  if (!key) throw new Error(txt('fehler.kanalSchluesselFehlt'));
  if (!input.verwaltungIds.length) throw new Error(txt('fehler.keineVerwaltung'));

  const roh = zufallsCode(6);
  const code = codeNormalisieren(roh);
  const codeKey = await codeSchluessel(
    code.replace(/-/g, ''), `stellium/freigabe/${input.channelId}/${meineId}`, 310_000,
  );

  await schluesselAnfordern(input.verwaltungIds);
  const pakete: { userId: string; paket: SchluesselPaket }[] = [];
  for (const uid of input.verwaltungIds) {
    const jwk = fremdeSchluessel.get(uid);
    if (!jwk) continue;
    // Innen: für den privaten Schlüssel dieses Verwaltungskontos.
    const innen = await paketPacken(
      key, jwk, freigabeKontext(input.channelId, fassung, meineId ?? '', uid),
    );
    // Außen: derselbe Inhalt, noch einmal mit dem Code verschlossen.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const daten = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, codeKey, enc.encode(JSON.stringify(innen)),
    );
    pakete.push({
      userId: uid,
      paket: { alg: PAKET_ALG, von: meineId ?? '', iv: b64u(iv), daten: b64u(daten) },
    });
  }
  if (!pakete.length) throw new Error(txt('fehler.verwaltungNichtVerpackbar'));

  socket.send({
    t: 'vertraulich:vorfall-melden',
    channelId: input.channelId,
    grund: input.grund,
    codeAbdruck: hex(await sha256(code.replace(/-/g, ''))),
    tage: input.tage,
    pakete,
  });
  return code;
}

/**
 * Als Verwaltung eine Freigabe einlösen.
 *
 * Der Code wird nie übertragen, nur sein Abdruck. Stimmt er, gibt der Server
 * das äußere Paket heraus; geöffnet wird es hier, und darunter liegt das
 * innere, das ohne den eigenen privaten Schlüssel nichts hergibt.
 */
export async function freigabeOeffnen(input: {
  freigabeId: string; code: string;
}): Promise<{ ok: true; channelId: string } | { ok: false; grund: string }> {
  const code = codeNormalisieren(input.code).replace(/-/g, '');
  const codeAbdruck = hex(await sha256(code));

  const antwort = await new Promise<ServerEvent | null>((fertig) => {
    const ab = socket.onEvent((ev) => {
      if (ev.t === 'vertraulich:freigabe-schluessel' && ev.schluessel.freigabeId === input.freigabeId) {
        ab(); fertig(ev);
      } else if (ev.t === 'error') {
        ab(); fertig(ev);
      }
    });
    socket.send({ t: 'vertraulich:freigabe-oeffnen', freigabeId: input.freigabeId, codeAbdruck });
    setTimeout(() => { ab(); fertig(null); }, 10_000);
  });

  if (!antwort) return { ok: false, grund: txt('fehler.serverStumm') };
  if (antwort.t === 'error') return { ok: false, grund: antwort.message };
  /* Kann nicht eintreten — das Versprechen löst nur mit diesen beiden Arten auf.
     Der Zweig steht da, damit TypeScript den Typ verengt, und teilt sich den
     Text mit dem Fall "keine Antwort": beides heißt, dass nicht kam, was
     gefragt war. */
  if (antwort.t !== 'vertraulich:freigabe-schluessel') return { ok: false, grund: txt('fehler.serverStumm') };

  const { channelId, fassung, paket } = antwort.schluessel;
  try {
    // Außen den Code, innen den eigenen Schlüssel — in dieser Reihenfolge.
    const codeKey = await codeSchluessel(code, `stellium/freigabe/${channelId}/${paket.von}`, 310_000);
    const innenText = dec.decode(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(paket.iv) }, codeKey, unb64u(paket.daten),
    ));
    const innen = JSON.parse(innenText) as SchluesselPaket;
    await schluesselAnfordern([innen.von]);
    const key = await paketAuspacken(
      innen, freigabeKontext(channelId, fassung, innen.von, meineId ?? ''),
    );
    kanalSchluessel.set(kanalKey(channelId, fassung), key);
    kanalFassung.set(channelId, Math.max(kanalFassung.get(channelId) ?? 0, fassung));
    return { ok: true, channelId };
  } catch {
    return { ok: false, grund: txt('fehler.codePasstNicht') };
  }
}

/* ── Dateien ──────────────────────────────────────────────────── */

/**
 * Woher der Dateischlüssel kommt — und warum ausgerechnet so.
 *
 * Jede verschlüsselte Datei bekommt einen **frisch gewürfelten** Schlüssel.
 * Nicht einen aus ihrem Inhalt abgeleiteten, obwohl das verlockend wäre:
 * gleicher Inhalt ergäbe gleiches Chiffrat, und der Blockspeicher legte
 * dieselbe Datei nur einmal ab. Genau das ist der Grund, es nicht zu tun. Wer
 * eine bestimmte Datei sucht — ein durchgestochenes Papier, ein bekanntes
 * Bild — verschlüsselt sie selbst und sieht nach, ob ihre Blöcke schon da
 * sind. Die Antwort wäre ja oder nein, und damit wüsste der Server, was er
 * verwahrt, ohne einen einzigen Schlüssel zu haben. Privatsphäre geht hier vor
 * Speicherplatz: private Dateien werden nicht zusammengelegt, und weil ihr
 * Chiffrat ohnehin jedes Mal anders aussieht, gibt es dabei auch nichts mehr
 * zu sparen.
 *
 * Verschlossen wird dieser Zufallsschlüssel dann mit einer **Hülle**, und die
 * ist die eigentliche Entscheidung:
 *
 *   Anhang in einem vertraulichen Kanal → Hülle ist der Kanalschlüssel.
 *   Der Dateischlüssel gehört damit zum Kanal, nicht zum Inhalt: wer die
 *   Nachrichten liest, liest auch die Bilder darin, und wer den Kanal verlässt,
 *   verliert beides zur selben Zeit. Die Fassung steht mit im Umschlag —
 *   sonst wäre jeder Schlüsselwechsel ein Bruch, und alte Anhänge blieben zu.
 *
 *   Private Datei in der Ablage → Hülle ist ein Schlüssel, den nur das eigene
 *   Schlüsselpaar hergibt (siehe `kontoSchluessel`). Niemand sonst kommt heran,
 *   auch kein anderes Mitglied — das ist der Unterschied zwischen "privat" und
 *   "im Kanal".
 *
 * In Stücken, nicht am Stück: eine Datei von hundert Megabyte am Stück durch
 * AES zu schicken hieße, sie dreimal gleichzeitig im Speicher zu halten —
 * Original, Chiffrat und den Puffer dazwischen. Auf einem Telefon ist damit
 * Schluss, bevor es losgeht.
 *
 * Jedes Stück trägt seine Nummer als mitgeprüfte Beigabe. Ohne das ließen sich
 * Stücke vertauschen oder weglassen, ohne dass die Prüfsumme etwas merkt —
 * jedes für sich wäre ja unversehrt.
 */
const STUECK = 4 * 1024 * 1024;

/** Name, Typ und Größe. Liegen verschlossen im Umschlag, nicht offen daneben. */
export interface DateiKopf {
  name: string;
  mime: string;
  groesse: number;
}

/**
 * Der Schlüssel, der nur aus dem eigenen Schlüsselpaar entsteht.
 *
 * Er ist ein ECDH-Geheimnis mit sich selbst: gerechnet wird mit dem eigenen
 * privaten und dem eigenen öffentlichen Teil. Das klingt kurios, ist aber
 * genau das Gewünschte — es kommt auf jedem Gerät dasselbe heraus, solange
 * dort derselbe private Teil liegt, und niemand außerhalb kann es nachbilden.
 *
 * Der große Vorteil steckt in dem, was dadurch **nicht** nötig wird: kein
 * zweites Geheimnis, das gesichert werden müsste. Der Wiederherstellungscode
 * holt den privaten Teil zurück, und mit ihm kommt dieser Schlüssel von selbst
 * wieder — ein neues Gerät öffnet die privaten Dateien, ohne dass jemals ein
 * Dateischlüssel gesichert oder übertragen wurde.
 *
 * Der Kontext geht in die Ableitung ein und unterscheidet sich von jedem
 * Paketkontext. Derselbe private Teil dient damit zwei Zwecken, ohne dass ein
 * Ergebnis des einen für den anderen taugt.
 */
function kontoKontext(userId: string): string {
  return `stellium/datei/konto/${userId}`;
}

async function kontoSchluessel(): Promise<CryptoKey> {
  if (!privatSchluessel || !oeffentlichJwk) throw new Error(txt('fehler.keinSchluesselpaar'));
  return gemeinsamerSchluessel(oeffentlichJwk, kontoKontext(meineId ?? ''));
}

/** Die Hülle für eine private Datei in der Ablage — nur für dieses Konto. */
export function kontoHuelle(): DateiHuelle {
  if (!meineId) throw new Error(txt('fehler.keinSchluesselpaar'));
  return { art: 'konto', userId: meineId };
}

/** Die Hülle für einen Anhang in einem vertraulichen Kanal. */
export function kanalHuelle(channelId: string): DateiHuelle {
  const fassung = kanalFassung.get(channelId) ?? 0;
  if (!fassung || !kanalSchluessel.has(kanalKey(channelId, fassung))) {
    throw new Error(txt('fehler.kanalSchluesselFehlt'));
  }
  return { art: 'kanal', channelId, fassung };
}

/**
 * Den Schlüssel zu einer Hülle beschaffen.
 *
 * Wirft, wenn er fehlt. Das ist der Normalfall direkt nach einem Gerätewechsel
 * und kein Programmfehler — die Aufrufer fangen es ab und zeigen "noch nicht
 * lesbar" statt einer Fehlermeldung.
 */
async function huellenSchluessel(huelle: DateiHuelle): Promise<CryptoKey> {
  if (huelle.art === 'konto') {
    if (huelle.userId !== meineId) throw new Error(txt('fehler.dateiNichtFuerDich'));
    return kontoSchluessel();
  }
  const key = kanalSchluessel.get(kanalKey(huelle.channelId, huelle.fassung));
  if (!key) throw new Error(txt('fehler.kanalSchluesselFehlt'));
  return key;
}

/** Lässt sich eine Datei mit dieser Hülle auf diesem Gerät gerade öffnen? */
export function dateiLesbar(huelle: DateiHuelle): boolean {
  if (huelle.art === 'konto') return huelle.userId === meineId && Boolean(privatSchluessel);
  return kanalSchluessel.has(kanalKey(huelle.channelId, huelle.fassung));
}

/**
 * Eine Datei verschließen.
 *
 * Das Ergebnis ist eine Datei, die alles bei sich trägt, was zu ihr gehört:
 * den verpackten Dateischlüssel, den verschlossenen Kopf mit Name und Typ, und
 * die Stücke. Der Server bekommt davon nur Bytes und eine Wegbeschreibung, an
 * der er nichts aufschließen kann.
 */
export async function dateiVerschluesseln(datei: File, huelle: DateiHuelle): Promise<Blob> {
  const huelleKey = await huellenSchluessel(huelle);

  /* Der Dateischlüssel. Gewürfelt, nicht abgeleitet — der Grund steht oben. */
  const dateiKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );

  /* Die Hülle geht als mitgeprüfte Beigabe in beide Verschlüsselungen ein.
     Damit lässt sich ein Umschlag nicht auf eine andere Hülle umschreiben:
     wer "verschlossen für Kanal X" zu "für Kanal Y" ändert, bekommt beim
     Öffnen keinen falschen Schlüssel, sondern einen Fehler. */
  const beigabe = enc.encode(JSON.stringify(huelle));

  const schluesselIv = crypto.getRandomValues(new Uint8Array(12));
  const verpackt = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: schluesselIv, additionalData: beigabe },
    huelleKey, await crypto.subtle.exportKey('raw', dateiKey),
  );

  const kopf: DateiKopf = {
    name: datei.name, mime: datei.type || 'application/octet-stream', groesse: datei.size,
  };
  const kopfIv = crypto.getRandomValues(new Uint8Array(12));
  const kopfChiffrat = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: kopfIv, additionalData: enc.encode('kopf') },
    dateiKey, enc.encode(JSON.stringify(kopf)),
  );

  const umschlag: DateiUmschlag = {
    alg: 'aes-gcm', stueck: STUECK, huelle,
    schluesselIv: b64u(schluesselIv), schluessel: b64u(verpackt),
    kopfIv: b64u(kopfIv), kopf: b64u(kopfChiffrat),
  };
  const teile: BlobPart[] = [
    `${umschlagSchreiben(umschlag, (s) => b64u(enc.encode(s)))}\n`,
  ];

  for (let nummer = 0, von = 0; von < datei.size; nummer++, von += STUECK) {
    const roh = await datei.slice(von, Math.min(von + STUECK, datei.size)).arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const chiffrat = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(String(nummer)) }, dateiKey, roh,
    );
    const laenge = new DataView(new ArrayBuffer(4));
    laenge.setUint32(0, chiffrat.byteLength, false);
    teile.push(laenge.buffer, iv, chiffrat);
  }

  /* Eine leere Datei hat kein einziges Stück. Ohne diesen Fall entstünde ein
     Umschlag ohne Inhalt, und das Zurücklesen liefe ins Leere statt eine leere
     Datei zurückzugeben. */
  return new Blob(teile, { type: 'application/octet-stream' });
}

/** Der Umschlag einer verschlüsselten Datei — ohne sie zu öffnen. */
export function umschlagVon(daten: ArrayBuffer): DateiUmschlag | null {
  const bytes = new Uint8Array(daten);
  const trenner = bytes.indexOf(10);
  if (trenner < 0) return null;
  return umschlagLesen(dec.decode(bytes.slice(0, trenner)), (s) => dec.decode(unb64u(s)));
}

/**
 * Umkehrung. Der Schlüssel steht nicht dabei — er ergibt sich aus der Hülle,
 * die im Umschlag angegeben ist.
 */
export async function dateiEntschluesseln(
  daten: ArrayBuffer,
): Promise<{ kopf: DateiKopf; blob: Blob }> {
  const bytes = new Uint8Array(daten);
  const trenner = bytes.indexOf(10);          // Zeilenumbruch nach dem Umschlag
  if (trenner < 0) throw new Error(txt('fehler.dateiKopfUnlesbar'));
  const umschlag = umschlagLesen(dec.decode(bytes.slice(0, trenner)), (s) => dec.decode(unb64u(s)));
  if (!umschlag) throw new Error(txt('fehler.dateiKopfUnlesbar'));

  const huelleKey = await huellenSchluessel(umschlag.huelle);
  const beigabe = enc.encode(JSON.stringify(umschlag.huelle));
  const rohSchluessel = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(umschlag.schluesselIv), additionalData: beigabe },
    huelleKey, unb64u(umschlag.schluessel),
  );
  const dateiKey = await crypto.subtle.importKey(
    'raw', rohSchluessel, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );

  const kopf = JSON.parse(dec.decode(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(umschlag.kopfIv), additionalData: enc.encode('kopf') },
    dateiKey, unb64u(umschlag.kopf),
  ))) as DateiKopf;

  const stuecke: BlobPart[] = [];
  let pos = trenner + 1;
  for (let nummer = 0; pos < bytes.length; nummer++) {
    const laenge = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0, false);
    pos += 4;
    const iv = bytes.slice(pos, pos + 12);
    pos += 12;
    const chiffrat = bytes.slice(pos, pos + laenge);
    pos += laenge;
    stuecke.push(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(String(nummer)) },
      dateiKey, chiffrat,
    ));
  }
  /* Die Stücknummer schützt nur vor Vertauschen, nicht vor Abschneiden: wer
     hinten ganze Stücke weglässt, bekommt eine kürzere, tadellos
     entschlüsselbare Datei. Die verschlossene Größe im Kopf verrät das. */
  const ist = stuecke.reduce((summe, s) => summe + (s as ArrayBuffer).byteLength, 0);
  if (ist !== kopf.groesse) {
    throw new Error(txt('fehler.unvollstaendig', { ist, soll: kopf.groesse }));
  }
  return { kopf, blob: new Blob(stuecke, { type: kopf.mime }) };
}

/* ── Verschlossene Dateien anzeigen ───────────────────────────── */

/**
 * Eine verschlossene Datei holen und öffnen.
 *
 * Die Adresse kommt über `dateiUrl` und damit über denselben Weg wie jedes
 * Bild und jeder Download in dieser App — der Nachweis steht darin, weil ein
 * `<img src>` keine Kopfzeile mitschicken kann. Hier wäre ein zweiter Weg
 * möglich gewesen (fetch kann Kopfzeilen), aber zwei Wege zur selben Datei
 * sind einer zu viel: sobald sich an der Anmeldung etwas ändert, wird genau
 * einer davon nachgezogen.
 *
 * Was danach kommt, kann nur die App: der Server liefert Bytes ohne Bedeutung,
 * hier entsteht daraus wieder ein Bild mit Namen und Typ.
 */
async function dateiOeffnen(pfad: string): Promise<{ kopf: DateiKopf; blob: Blob }> {
  const antwort = await fetch(dateiUrl(pfad));
  if (!antwort.ok) throw new Error(txt('fehler.dateiNichtGefunden'));
  return dateiEntschluesseln(await antwort.arrayBuffer());
}

/**
 * Dasselbe, aber jede Datei nur einmal.
 *
 * Eine Nachrichtenliste baut ihre Zeilen beim Scrollen immer wieder neu auf.
 * Ohne diesen Merkzettel lüde dasselbe Bild bei jedem Durchgang erneut herunter
 * und würde erneut entschlüsselt — bei einem Kanal voller Fotos wäre das die
 * Leitung und der Akku.
 *
 * Gemerkt wird das Versprechen und nicht das Ergebnis: zwei Zeilen, die
 * gleichzeitig dieselbe Datei anfordern, teilen sich damit einen Abruf.
 */
const offeneDateien = new Map<string, Promise<{ kopf: DateiKopf; url: string }>>();

export function dateiAnzeigen(id: string, pfad: string): Promise<{ kopf: DateiKopf; url: string }> {
  const schon = offeneDateien.get(id);
  if (schon) return schon;
  const lauf = dateiOeffnen(pfad).then(({ kopf, blob }) => ({
    kopf, url: URL.createObjectURL(blob),
  }));
  /* Ein gescheiterter Abruf darf nicht als Antwort hängenbleiben — sonst
     bliebe eine Datei für den Rest der Sitzung unlesbar, obwohl der Schlüssel
     eine Sekunde später eintrifft. */
  lauf.catch(() => offeneDateien.delete(id));
  offeneDateien.set(id, lauf);
  return lauf;
}

/**
 * Alles vergessen, was mit dem alten Schlüsselstand geöffnet wurde.
 *
 * Nötig nach einer Wiederherstellung: was vorher „nicht lesbar" war, ist es
 * jetzt vielleicht nicht mehr, und der Merkzettel hielte die alte Antwort fest.
 */
export function dateienVergessen(): void {
  for (const lauf of offeneDateien.values()) {
    void lauf.then(({ url }) => URL.revokeObjectURL(url)).catch(() => {});
  }
  offeneDateien.clear();
}

/**
 * ALLES vergessen, was zum Konto gehört — beim Abmelden.
 *
 * `dateienVergessen()` räumt nur die geöffneten Datei-Objekt-URLs weg. Hier
 * kommen die Schlüssel selbst dazu: das eigene Paar (`privatSchluessel`),
 * die öffentlichen Teile der anderen (`fremdeSchluessel`) und vor allem die
 * entpackten Kanalschlüssel (`kanalSchluessel`, `kanalFassung`) — mit denen
 * ließe sich jeder vertrauliche Kanal des abgemeldeten Kontos weiter lesen,
 * solange sie im Speicher stehen. Meldet sich auf demselben Fenster ein
 * anderes Konto an, gehören diese Geheimnisse ihm nicht.
 *
 * `schluesselBereitstellen()` legt bei der nächsten Anmeldung ohnehin alles
 * neu an oder nimmt den Kontoweg — nichts davon muss eine Abmeldung
 * überleben.
 */
export function schluesselAllesVergessen(): void {
  meineId = null;
  privatSchluessel = null;
  oeffentlichJwk = null;
  fremdeSchluessel.clear();
  kanalSchluessel.clear();
  kanalFassung.clear();
  dateienVergessen();
}

/* ── Auf Ereignisse hören ─────────────────────────────────────── */

/**
 * Der eigene Draht zum Server, ohne Umweg über den Zustand.
 *
 * Die Schlüsselarbeit läuft von selbst: fehlt jemandem ein Paket, wird es
 * verpackt; kommt ein Paket an, wird es ausgepackt. Nichts davon braucht die
 * Oberfläche, und nichts davon sollte auf sie warten müssen.
 */
socket.onEvent((ev: ServerEvent) => {
  void verarbeiten(ev);
});

async function verarbeiten(ev: ServerEvent): Promise<void> {
  try {
    switch (ev.t) {
      case 'ready':
        meineId = ev.self.id;
        await schluesselBereitstellen();
        // Die eigenen vertraulichen Kanäle gleich aufschließen.
        for (const kanal of ev.channels) {
          if (kanal.vertraulich) socket.send({ t: 'vertraulich:paket-holen', channelId: kanal.id });
        }
        return;

      case 'vertraulich:schluessel':
        for (const s of ev.schluessel) fremdeSchluessel.set(s.userId, s.jwk);
        return;

      case 'vertraulich:paket': {
        kanalFassung.set(ev.channelId, ev.fassung);
        for (const { fassung, paket } of ev.pakete) {
          if (kanalSchluessel.has(kanalKey(ev.channelId, fassung))) continue;
          await schluesselAnfordern([paket.von]);
          try {
            const key = await paketAuspacken(paket, paketKontext(ev.channelId, fassung, paket.von, meineId ?? ''));
            kanalSchluessel.set(kanalKey(ev.channelId, fassung), key);
          } catch {
            /* Ein Paket, das sich nicht öffnen lässt, ist meist eines aus der
               Zeit vor einem Schlüsselwechsel. Stillschweigend übergehen: die
               Oberfläche merkt am fehlenden Schlüssel selbst, dass etwas
               fehlt, und eine Fehlermeldung pro alter Fassung wäre Lärm. */
          }
        }
        return;
      }

      case 'vertraulich:pakete-fehlen':
        await paketeNachreichen(ev.channelId, ev.fassung, ev.userIds);
        return;

      default:
        return;
    }
  } catch (err) {
    console.warn('[vertraulich]', (err as Error).message);
  }
}

/** Wie viele Kanäle dieses Gerät gerade aufschließen kann — für Anzeigen. */
export function lesbareKanaele(): number {
  return new Set([...kanalSchluessel.keys()].map((k) => k.split(':')[0])).size;
}
