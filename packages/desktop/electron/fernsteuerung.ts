/**
 * Fernsteuerung — die Mac-Seite.
 *
 * Warum das hier im Hauptprozess läuft und nicht in der Ansicht: Der
 * Handschlag braucht **scrypt**, und das gibt es in der Browser-Krypto nicht
 * (dort ist nur PBKDF2 vorgesehen). Also läuft die ganze Verbindung hier,
 * und an die Ansicht gehen nur noch fertig entschlüsselte Bilder.
 *
 * Das ist auch aus einem zweiten Grund richtig: der Sitzungsschlüssel bleibt
 * damit im Hauptprozess. Die Ansicht bekommt ihn nie zu sehen.
 *
 * Der Bildstrom geht als H.264 weiter an die Ansicht, die ihn mit
 * `VideoDecoder` dekodiert — auf einem Mac läuft das über VideoToolbox, also
 * in Hardware und damit praktisch ohne Prozessorlast. Ihn hier zu dekodieren
 * und fertige Bildpunkte weiterzureichen wäre um Größenordnungen teurer:
 * 1280x720 in RGBA sind 3,7 MB je Bild.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { t } from './i18n.js';

/*
 * Benutzt wird das **eingebaute** WebSocket von Node, nicht das Paket `ws`.
 * Das ist kein Geschmacksurteil: dieses Paket führt gar keine
 * `dependencies`, und ausgeliefert werden nur `dist`, `dist-electron` und
 * `package.json` — kein `node_modules`. Ein `import … from 'ws'` liefe hier
 * beim Entwickeln anstandslos und wäre in der fertigen App nicht vorhanden.
 * Das ist die unangenehmste Sorte Fehler: einer, den man erst beim Nutzer
 * sieht.
 *
 * Die eingebaute Fassung spricht die Browser-Schnittstelle
 * (`addEventListener`) statt der von `ws` (`on`) — daher die Schreibweise
 * unten.
 */

const KURVE = 'prime256v1';

/* Nachrichtenarten auf der Leitung — dieselben Zahlen wie im Pi-Dienst. */
const N_BILD = 1, N_ABLAGE = 2, N_INFO = 3, N_EINGABE = 4, N_STEUER = 5;

/* ── Handschlag ──────────────────────────────────────────────── */

function sitzungsschluessel(gemeinsam: Buffer, passSchluessel: Buffer, nonce: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256', Buffer.concat([gemeinsam, passSchluessel]),
    nonce, Buffer.from('stellium-fern-sitzung'), 32));
}

/**
 * Jede Nachricht bekommt einen eigenen Startwert. Bei AES-GCM darf sich einer
 * mit demselben Schlüssel **nie** wiederholen — sonst fällt der Schlüssel.
 * Deshalb ein Zähler und kein Zufall: bei Zufall wächst die Wahrscheinlichkeit
 * einer Wiederholung mit der Zahl der Nachrichten, und ein Bildstrom schickt
 * sehr viele.
 */
class Schatulle {
  private zaehler = 0n;
  private kennung: number;
  constructor(private schluessel: Buffer, richtung: 'pi' | 'mac') {
    this.kennung = richtung === 'pi' ? 1 : 2;
  }
  private startwert(): Buffer {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(this.kennung, 0);
    b.writeBigUInt64BE(this.zaehler++, 4);
    return b;
  }
  zu(art: number, inhalt: Buffer): Buffer {
    const iv = this.startwert();
    const c = crypto.createCipheriv('aes-256-gcm', this.schluessel, iv);
    c.setAAD(Buffer.from([art]));
    const geheim = Buffer.concat([c.update(inhalt), c.final()]);
    return Buffer.concat([Buffer.from([art]), iv, c.getAuthTag(), geheim]);
  }
  auf(paket: Buffer): { art: number; inhalt: Buffer } | null {
    if (paket.length < 1 + 12 + 16) return null;
    const art = paket[0];
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.schluessel, paket.subarray(1, 13));
      d.setAAD(Buffer.from([art]));
      d.setAuthTag(paket.subarray(13, 29));
      return { art, inhalt: Buffer.concat([d.update(paket.subarray(29)), d.final()]) };
    } catch {
      return null;                       /* verfälscht — verwerfen, nicht raten */
    }
  }
}

/* ── Zustand einer Sitzung ───────────────────────────────────── */

type Lage = 'getrennt' | 'verbindet' | 'meldet an' | 'offen' | 'fehler';

let ws: WebSocket | null = null;
let hinaus: Schatulle | null = null;
let herein: Schatulle | null = null;
let paar: crypto.ECDH | null = null;
let passwort = '';
let lage: Lage = 'getrennt';
let letzterFehler = '';
const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
const istDev = !app.isPackaged;
/* Dieselbe Datei wie in main.ts (dist/index.html) — der Betrachter lädt sie
   nur mit einem anderen Hash (#fern). */
const EIGENER_EINTRAG = pathToFileURL(path.join(here, '../dist/index.html'));

/**
 * Dieselbe Schranke wie beim Hauptfenster — siehe navigationsEntscheidung()
 * in main.ts für die ausführliche Begründung. Hier noch einmal lokal
 * nachgebaut statt importiert: main.ts bindet bereits diese Datei ein
 * (fernsteuerungEinrichten/fernsteuerungBeenden), ein Import in die
 * Gegenrichtung wäre ein Ringschluss zwischen den beiden Modulen. Ändert
 * sich die eine Fassung, gehört die andere mitgezogen.
 *
 * Kurzfassung der Falle, damit sie hier nicht separat wieder hineinrutscht:
 * `new URL('file:///x').origin` ist NICHT `"file://"`, sondern wörtlich
 * `"null"` — file: hat keinen Host und darum keinen vergleichbaren Ursprung.
 * Ein Vergleich über `.origin` schlägt für file: darum immer fehl; hier wird
 * stattdessen der Pfad verglichen.
 */
function istHttpUrl(url: string): boolean {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}

function navigationsEntscheidung(url: string): 'erlauben' | 'extern' | 'verweigern' {
  let ziel: URL;
  try { ziel = new URL(url); } catch { return 'verweigern'; }

  const erlaubt = istDev
    ? ziel.origin === new URL(DEV_URL).origin
    : ziel.protocol === 'file:' && ziel.pathname === EIGENER_EINTRAG.pathname;
  if (erlaubt) return 'erlauben';

  return istHttpUrl(url) ? 'extern' : 'verweigern';
}

/**
 * Anfänglicher Fenstertitel des Betrachters — sichtbar, sobald das Fenster
 * entsteht (Titelleiste, Fenstermenü, Mission Control zeigen ihn schon vor
 * dem ersten Zeichnen der Seite).
 *
 * t('fern.titel') aus electron/i18n.ts — derselbe Schlüssel, den
 * `Fernsteuerung.tsx` gleich danach selbst über `document.title` setzt (und
 * den Electron dadurch automatisch als echten Fenstertitel übernimmt, siehe
 * unten). Bis dahin gilt hier die zuletzt bekannte Hauptprozess-Sprache
 * (electron/i18n.ts, spracheSetzen) — bei einem frischen Start also die
 * Systemsprache, sobald ein Konto angemeldet war schon dessen eingestellte
 * Oberflächensprache (siehe main.ts, 'app:language'). Vorher stand hier fest
 * Deutsch/Englisch, weil `src/i18n` aus dem Hauptprozess heraus nicht
 * importierbar ist (siehe Kommentar bei `anschlussFrist` unten) — das hat
 * sich nicht geändert, nur electron/i18n.ts trägt inzwischen alle 22
 * Sprachen statt nur zwei von Hand gepflegter.
 *
 * Das ist ausdrücklich nur der ERSTE Augenblick: Sobald die Seite geladen hat
 * und `Fernsteuerung.tsx` seinerseits `document.title = t('fern.titel')`
 * setzt, übernimmt Electron das automatisch als echten Fenstertitel (Electron
 * synchronisiert den Fenstertitel standardmäßig mit `document.title`, sofern
 * niemand `page-title-updated` abfängt — das tut hier niemand). Ab da zählt
 * die eingestellte Oberflächensprache aus der Ansicht, nicht mehr die hier
 * bekannte.
 */
function fensterTitel(): string {
  return t('fern.titel');
}

let fenster: (() => BrowserWindow | null) | null = null;

/*
 * Der Betrachter in einem eigenen Fenster.
 *
 * Bildstrom und Eingaben gehen dann NUR dorthin, nicht zusätzlich ins
 * Hauptfenster. Beides zu beliefern klingt bequemer — man müsste nirgends
 * umschalten —, hieße aber, jedes Bild zweimal über die Prozessgrenze zu
 * schieben und zweimal zu dekodieren. Bei 45 Bildern in der Sekunde ist das
 * kein Detail: die Hardware-Dekodierung läuft je Fenster einmal.
 */
let betrachter: BrowserWindow | null = null;

/* Wohin Bild, Zustand und Meldungen gehen. */
function ziel(): BrowserWindow | null {
  if (betrachter && !betrachter.isDestroyed()) return betrachter;
  return fenster?.() ?? null;
}

/* Was wir zuletzt selbst in die Ablage gelegt haben — damit wir es nicht
   gleich wieder zurückschicken und die beiden Seiten sich hochschaukeln. */
let ablageZuletzt = '';
let ablageWacht: NodeJS.Timeout | null = null;

/*
 * Merkt die Gegenstelle, dass die Leitung weg ist?
 *
 * Von allein nicht. Ein WebSocket, dessen Gegenseite verschwunden ist —
 * Deckel zu, WLAN gewechselt, Weiterleitung im Router abgelaufen —, meldet
 * kein `close`; die App stände weiter auf „offen" und zeigte ein Bild, das
 * eingefroren ist. Der Pi fragt seinerseits alle zehn Sekunden nach
 * (`ping`/`pong`, siehe fern-dienst.mjs) und wird die Sitzung los; hier ist
 * die Gegenprobe dazu, damit nicht die eine Seite aufgelegt hat, während die
 * andere noch wartet.
 *
 * Gemessen wird an dem, was ohnehin ständig kommt: Bilder, und alle zwei
 * Sekunden eine Lagemeldung. Fünfundzwanzig Sekunden Stille sind darum kein
 * ruhiger Schirm, sondern eine abgerissene Leitung.
 */
const LEITUNG_STILL_MS = 25_000;
let letzteNachricht = 0;
let leitungWacht: NodeJS.Timeout | null = null;

function leitungBeobachten(): void {
  letzteNachricht = Date.now();
  leitungWacht ??= setInterval(() => {
    if (lage !== 'offen') return;
    if (Date.now() - letzteNachricht > LEITUNG_STILL_MS) schliessen('fern.fehler.leitungWeg');
  }, 5000);
}

function melden(): void {
  /* Der Zustand geht an BEIDE: das Hauptfenster braucht ihn für den
     Verbinden-Knopf, auch wenn das Bild im eigenen Fenster läuft. */
  for (const w of new Set([ziel(), fenster?.() ?? null])) {
    if (w && !w.isDestroyed()) w.webContents.send('fern:zustand', { lage, fehler: letzterFehler });
  }
}

function schliessen(grund: string): void {
  if (ablageWacht) { clearInterval(ablageWacht); ablageWacht = null; }
  if (leitungWacht) { clearInterval(leitungWacht); leitungWacht = null; }
  if (ws) { try { ws.close(); } catch { /* schon zu */ } ws = null; }
  hinaus = herein = null; paar = null; passwort = '';
  lage = grund ? 'fehler' : 'getrennt';
  letzterFehler = grund;
  melden();
}

/* ── Zwischenablage ──────────────────────────────────────────── */

/**
 * Electron kann nicht melden, wenn sich die Ablage ändert — es gibt kein
 * Ereignis dafür. Also nachsehen. Zweimal je Sekunde ist oft genug, dass es
 * sich wie sofort anfühlt, und selten genug, dass es nichts kostet.
 */
function ablageBeobachten(): void {
  ablageZuletzt = clipboard.readText();
  ablageWacht = setInterval(() => {
    if (!ws || lage !== 'offen') return;
    const jetzt = clipboard.readText();
    if (jetzt && jetzt !== ablageZuletzt) {
      ablageZuletzt = jetzt;
      senden(N_ABLAGE, Buffer.from(jetzt, 'utf8'));
    }
  }, 500);
}

function senden(art: number, inhalt: Buffer): void {
  if (!ws || !hinaus || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(hinaus.zu(art, inhalt)); } catch { /* Leitung weg */ }
}

/* ── Ziel-Bestätigung ────────────────────────────────────────── */

/**
 * Die zuletzt bestätigte Adresse für die Fernsteuerung — dasselbe Muster wie
 * der Update-Ursprung in updater.ts (siehe dort die ausführliche Begründung),
 * hier für ein eigenständiges Problem:
 *
 * `verbinden()` bekommt Adresse UND Passwort vom Aufrufer — beides, siehe
 * `window.stellium.fern.verbinden` in preload.ts. Der verschlüsselte
 * Handschlag (scrypt + ECDH) prüft nur, ob GEGENSTELLE UND ANRUFER dasselbe
 * Passwort kennen; er prüft nicht, ob die Gegenstelle überhaupt der eigene
 * Pi ist. Wer beide Seiten kontrolliert — Adresse UND Passwort —, besteht
 * den Handschlag mit sich selbst, und ab dann läuft `ablageBeobachten()` los
 * und schickt zweimal die Sekunde die Zwischenablage dorthin, während
 * `N_ABLAGE`-Nachrichten von dort ungeprüft in die eigene Ablage zurück-
 * geschrieben werden.
 *
 * In der Praxis kommt die Adresse bei jedem Klick aufs Neue vom eigenen
 * Server (siehe Fernsteuerung.tsx, `api.fernZugang()`) und ändert sich so
 * gut wie nie. Darum: die zuletzt bestätigte Adresse liegt hier im
 * Hauptprozess (kein `fs` im Vorspann — der Renderer kommt an diese Datei
 * nicht heran). Stimmt eine neue Adresse damit überein, geht es ohne
 * Rückfrage weiter. Weicht sie ab — auch beim allerersten Mal, wenn noch
 * keine gemerkt ist —, sieht die Person vor dem Wählen ein echtes
 * Systemfenster mit der Adresse.
 *
 * WAS DAS SCHÜTZT: ein Aufruf von `fern.verbinden()` mit einer fremden
 * Adresse — ob durch ein künftiges Skript im Renderer oder sonst einen
 * Fehler — dialt nicht mehr leise. Die Person müsste eine ihr unbekannte
 * Adresse ausdrücklich bestätigen.
 * WAS DAS NICHT SCHÜTZT: das ist eine Sichtbarkeitsschranke, keine
 * Authentifizierung — sie beweist nicht, dass die bestätigte Adresse
 * wirklich der eigene Pi ist, nur dass jemand vor dem Bildschirm sie
 * gesehen und angenommen hat. Das Passwort bleibt bewusst ungebunden: es
 * kommt vom Server und darf sich dort jederzeit ändern, ohne dass diese
 * Schranke das für eine Adressänderung hält.
 */
function vertraueteAdresseDatei(): string {
  return path.join(app.getPath('userData'), 'fern-vertraute-adresse.json');
}

function vertraueteAdresse(): string | null {
  try {
    const inhalt = JSON.parse(fs.readFileSync(vertraueteAdresseDatei(), 'utf8')) as { adresse?: string };
    return inhalt.adresse || null;
  } catch { return null; }
}

function adresseVertrauen(adresse: string): void {
  try { fs.writeFileSync(vertraueteAdresseDatei(), JSON.stringify({ adresse }), 'utf8'); }
  catch { /* dann fragt es beim nächsten Mal erneut nach — kein Beinbruch */ }
}

/** Fragt über einen echten Systemdialog nach, wenn das Fernsteuerungs-Ziel
 *  vom zuletzt bestätigten abweicht. Kein Skript kann diesen Dialog selbst
 *  wegklicken. */
async function zielBestaetigen(neu: string, bekannt: string | null): Promise<boolean> {
  const optionen = {
    type: 'warning' as const,
    buttons: [t('common.cancel'), t('fern.verbinden')],
    defaultId: 0,
    cancelId: 0,
    title: t('fern.targetConfirmTitle'),
    message: bekannt
      ? t('fern.targetConfirmMessageChanged')
      : t('fern.targetConfirmMessageFirst'),
    detail: bekannt
      ? t('fern.targetConfirmDetailChanged', { bekannt, neu })
      : t('fern.targetConfirmDetailFirst', { neu }),
  };
  const win = fenster?.() ?? null;
  const antwort = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, optionen)
    : await dialog.showMessageBox(optionen);
  return antwort.response === 1;
}

/* ── Verbinden ───────────────────────────────────────────────── */

/**
 * `konto`: der Anzeigename des angemeldeten Chat-Kontos. Er geht NICHT in den
 * Handschlag — der ist zu diesem Zeitpunkt noch Klartext (siehe unten, kurz
 * vor `phase = 'offen'`) — sondern erst über die verschlüsselte Leitung,
 * sobald sie steht. Leer lassen ist in Ordnung: der Pi zeigt dann „unbekannt".
 */
async function verbinden(adresse: string, pw: string, konto: string): Promise<void> {
  schliessen('');

  /* Vor jeder Rückfrage: sieht die Adresse überhaupt wie eine Wahlmöglichkeit
     aus? Node prüft das Schema beim Erzeugen NICHT selbst — nachgeprüft:
     `new WebSocket('http://…')` wirft unter Node 25 nicht, sondern scheitert
     erst beim eigentlichen Verbindungsversuch. Ohne diese Prüfung liefe
     offensichtlicher Unsinn erst bis zur Bestätigungsabfrage durch, bevor
     überhaupt etwas auffiele.
     Absichtlich NICHT `ziel` genannt — das ist schon der Name der Funktion
     weiter oben, die das Zielfenster für Bild/Zustand liefert, und die wird
     weiter unten in dieser selben Funktion aufgerufen. Eine lokale
     `let ziel: URL` hätte sie für den ganzen Rest von verbinden() verdeckt. */
  let zielUrl: URL;
  try { zielUrl = new URL(adresse); } catch {
    lage = 'fehler'; letzterFehler = 'fern.fehler.allgemein'; melden();
    return;
  }
  if (zielUrl.protocol !== 'ws:' && zielUrl.protocol !== 'wss:') {
    lage = 'fehler'; letzterFehler = 'fern.fehler.allgemein'; melden();
    return;
  }

  /* Das eigentliche Tor: siehe der lange Kommentar bei vertraueteAdresse()
     oben. Weicht das Ziel vom zuletzt bestätigten ab, entscheidet die
     Person per Systemdialog — nicht der Aufrufer. */
  const bekannteAdresse = vertraueteAdresse();
  if (bekannteAdresse !== adresse) {
    if (!(await zielBestaetigen(adresse, bekannteAdresse))) {
      lage = 'getrennt'; letzterFehler = ''; melden();
      return;
    }
    adresseVertrauen(adresse);
  }

  passwort = pw;
  lage = 'verbindet'; letzterFehler = ''; melden();

  paar = crypto.createECDH(KURVE);
  paar.generateKeys();

  let phase: 'gruss' | 'offen' | 'zu' = 'gruss';
  const buchse = new WebSocket(adresse);
  /* Ohne das kämen Binärnachrichten als Blob, und daraus wieder einen Buffer
     zu machen kostet bei 15 Bildern je Sekunde unnötig Arbeit. */
  buchse.binaryType = 'arraybuffer';
  ws = buchse;

  /* Wer sich nicht binnen zehn Sekunden meldet, ist nicht da. Das eingebaute
     WebSocket kennt keine eigene Frist dafür.
     `schliessen()`/`letzterFehler` tragen ab hier eine WÖRTERBUCH-KENNUNG,
     keinen fertigen Satz mehr — übersetzt wird erst in der Ansicht, die
     `fehler` aus `fern:zustand` bekommt, genau wie es net/socket.ts mit
     `ABBRUCH_KENNUNGEN` vormacht. Das bleibt auch nach electron/i18n.ts so:
     dieses Wörterbuch trägt nur die ~50 Schlüssel für natives UI (Menü,
     Tray, Bestätigungsdialoge), das der Hauptprozess wirklich selbst
     beschriften muss. Diese Verbindungsfehler landen dagegen ausschließlich
     in der React-Ansicht, die ohnehin das volle Wörterbuch geladen hat —
     sie dort noch einmal im Hauptprozess aufzulösen wäre unnötige Arbeit.
     Die Schlüssel stehen unter `fern.fehler.*` in allen 22 Wörterbüchern
     (src/i18n/*.ts). */
  const anschlussFrist = setTimeout(() => {
    if (lage === 'verbindet') schliessen('fern.fehler.keineAntwort');
  }, 10_000);

  buchse.addEventListener('open', () => {
    clearTimeout(anschlussFrist);
    lage = 'meldet an'; melden();
    /* Zuerst nur der öffentliche Schlüssel. Nichts, woraus sich das Passwort
       herstellen ließe — der Pi muss sich als Erster ausweisen. */
    buchse.send(JSON.stringify({ art: 'hallo', oeffentlich: paar!.getPublicKey().toString('base64') }));
  });

  buchse.addEventListener('message', (ereignis: MessageEvent) => {
    const roh = ereignis.data;
    /* Jede Nachricht ist ein Lebenszeichen der Gegenstelle — siehe
       `leitungBeobachten`. Vor allem `try`, damit auch eine Nachricht zählt,
       die wir gleich verwerfen. */
    letzteNachricht = Date.now();
    try {
      if (phase === 'gruss') {
        const gruss = JSON.parse(typeof roh === 'string' ? roh : Buffer.from(roh).toString('utf8'));
        if (gruss.art !== 'gruss') throw new Error('fern.fehler.unerwarteteAntwort');

        const salz = Buffer.from(gruss.salz, 'base64');
        const nonce = Buffer.from(gruss.nonce, 'base64');
        const passSchluessel = crypto.scryptSync(passwort, salz, 32, gruss.scrypt ?? { N: 16384, r: 8, p: 1 });
        const gemeinsam = paar!.computeSecret(Buffer.from(gruss.oeffentlich, 'base64'));
        const schluessel = sitzungsschluessel(gemeinsam, passSchluessel, nonce);

        /* Erst prüfen, ob die Gegenstelle das Passwort kennt. Stimmt das
           nicht, brechen wir ab, BEVOR wir selbst etwas herausgeben —
           sonst könnte jemand den Pi vortäuschen, unseren Beweis einsammeln
           und damit in Ruhe Passwörter durchprobieren. */
        const erwartet = crypto.createHmac('sha256', schluessel).update(nonce).update('pi').digest();
        const geliefert = Buffer.from(gruss.beweis ?? '', 'base64');
        if (geliefert.length !== erwartet.length || !crypto.timingSafeEqual(geliefert, erwartet)) {
          throw new Error('fern.fehler.passwort');
        }

        hinaus = new Schatulle(schluessel, 'mac');
        herein = new Schatulle(schluessel, 'pi');
        buchse.send(JSON.stringify({
          art: 'antwort',
          beweis: crypto.createHmac('sha256', schluessel).update(nonce).update('mac').digest('base64'),
        }));
        /* Erst ab hier, nie im „hallo" oben: der Sitzungsschlüssel steht seit
           den beiden Zeilen darüber, und nur über ihn geht der Kontoname
           hinaus — im Klartext-Handschlag wäre er für jeden Mitleser auf der
           Leitung sichtbar gewesen. Alte Pi-Dienste kennen `art: 'konto'`
           nicht und ignorieren die Nachricht stillschweigend; der Handschlag
           selbst hängt an keinem Feld darin. */
        if (konto) senden(N_STEUER, Buffer.from(JSON.stringify({ art: 'konto', name: konto }), 'utf8'));
        phase = 'offen';
        return;
      }

      if (phase === 'offen' && !hinaus) return;

      /* Die erste Nachricht nach dem Beweis ist noch Text: "offen". */
      if (lage !== 'offen') {
        const o = JSON.parse(typeof roh === 'string' ? roh : Buffer.from(roh).toString('utf8'));
        if (o.art === 'offen') {
          lage = 'offen'; melden();
          ablageBeobachten();
          leitungBeobachten();
        }
        return;
      }

      if (typeof roh === 'string') return;      /* nach dem Handschlag nur Binäres */
      const paket = herein!.auf(Buffer.from(roh));
      if (!paket) return;                /* verfälscht — stillschweigend weg */

      const f = ziel();
      if (!f) return;
      if (paket.art === N_BILD) {
        f.webContents.send('fern:bild', paket.inhalt);
      } else if (paket.art === N_ABLAGE) {
        const text = paket.inhalt.toString('utf8');
        /* Merken, bevor wir schreiben — sonst hält unsere eigene Wacht das
           für eine neue Änderung und schickt es sofort zurück. */
        ablageZuletzt = text;
        clipboard.writeText(text);
      } else if (paket.art === N_INFO) {
        f.webContents.send('fern:info', JSON.parse(paket.inhalt.toString('utf8')));
      }
    } catch (fehler) {
      schliessen((fehler as Error).message);
    }
  });

  buchse.addEventListener('error', () => {
    clearTimeout(anschlussFrist);
    /* Das eingebaute WebSocket verrät im Fehlerereignis absichtlich nichts
       Näheres — sonst ließe sich von einer Seite aus abtasten, was im Netz
       dahinter erreichbar ist. Der Grund kommt deshalb aus dem close-Code. */
  });
  /* `CloseEvent` steht in diesen Typdefinitionen nicht — der Zuschnitt hier
     reicht, wir brauchen nur den Code. */
  buchse.addEventListener('close', (ereignis: { code: number }) => {
    clearTimeout(anschlussFrist);
    const code = ereignis.code;
    if (lage === 'offen' || lage === 'meldet an' || lage === 'verbindet') {
      const gruende: Record<number, string> = {
        /* 4003 ist derselbe Fall wie oben (falsches Passwort) — nur auf einer
           anderen Ebene erkannt: dort die Antwort auf den Handschlag, hier
           ein Schließen-Code vom Pi-Dienst selbst. Dieselbe Kennung, damit
           in der Ansicht nicht zwei Sätze für dieselbe Sache stehen. */
        4003: 'fern.fehler.passwort',
        /* 4009 kommt nur noch von einem Pi mit altem Dienst — dort durfte
           immer nur einer zusehen. Der Schlüssel bleibt genau deshalb stehen:
           solange auf dem Pi die alte Fassung läuft, ist das die richtige
           Auskunft. */
        4009: 'fern.fehler.besetzt',
        4010: 'fern.fehler.zuVieleZuschauer',
        4029: 'fern.fehler.zuVieleVersuche',
        4008: 'fern.fehler.zeitUeberschritten',
      };
      schliessen(gruende[code] ?? (lage === 'offen' ? '' : 'fern.fehler.allgemein'));
    }
  });
}

/* ── Anmeldung beim Hauptprozess ─────────────────────────────── */

export function fernsteuerungEinrichten(holeFenster: () => BrowserWindow | null): void {
  fenster = holeFenster;

  ipcMain.handle('fern:verbinden', (_e, adresse: string, pw: string, konto: string) => {
    /* Nicht abwarten: der eigentliche Fortschritt (Bestätigungsdialog,
       Handschlag, Fehler) geht über 'fern:zustand' an die Ansicht, genau wie
       vorher. Der Rückgabewert hier zeigt nur, dass die Anfrage ankam. */
    void verbinden(adresse, pw, konto);
    return true;
  });
  ipcMain.handle('fern:trennen', () => { schliessen(''); return true; });
  ipcMain.handle('fern:lage', () => ({ lage, fehler: letzterFehler }));

  /*
   * Den Betrachter in ein eigenes Fenster holen.
   *
   * Es lädt dieselbe Oberfläche mit `#fern` — deshalb braucht es weder einen
   * zweiten Bau noch eine zweite Vorlage. Das Anmelden am Chatserver
   * unterbleibt dort (siehe main.tsx): das Fenster zeigt nur den Bildschirm
   * des Pi, alles andere bleibt im Hauptfenster.
   *
   * Steht es schon, wird es nach vorn geholt statt ein zweites zu öffnen —
   * zwei Fenster auf denselben Strom hieße zweimal dekodieren.
   */
  ipcMain.handle('fern:fenster', () => {
    if (betrachter && !betrachter.isDestroyed()) {
      betrachter.show();
      betrachter.focus();
      return true;
    }
    betrachter = new BrowserWindow({
      width: 1280,
      height: 760,
      minWidth: 640,
      minHeight: 400,
      show: false,
      backgroundColor: '#080b16',
      title: fensterTitel(),
      webPreferences: {
        preload: path.join(here, 'preload.mjs'),
        additionalArguments: [`--stellium-locale=${app.getLocale()}`],
        contextIsolation: true,
        nodeIntegration: false,
        // sandbox: true wurde erwogen und bewusst zurückgestellt — siehe
        // dieselbe Abwägung bei mainWindow in main.ts.
        sandbox: false,
      },
    });
    /* Dieselbe Schranke wie das Hauptfenster (siehe main.ts) — ohne eigenen
       setWindowOpenHandler und ohne eigenes will-navigate hätte dieses
       zweite Fenster die Lücke aus main.ts noch einmal für sich allein
       gehabt. */
    betrachter.webContents.setWindowOpenHandler(({ url }) => {
      if (istHttpUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    betrachter.webContents.on('will-navigate', (event, url) => {
      const entscheidung = navigationsEntscheidung(url);
      if (entscheidung === 'erlauben') return;
      event.preventDefault();
      if (entscheidung === 'extern') void shell.openExternal(url);
    });
    betrachter.once('ready-to-show', () => betrachter?.show());
    /* Zuerst aufräumen, dann den Zustand melden — sonst zeigt das
       Hauptfenster den Knopf noch als "im eigenen Fenster", während das
       Fenster schon zu ist. */
    betrachter.on('closed', () => {
      betrachter = null;
      fenster?.()?.webContents.send('fern:zustand', { lage, fehler: letzterFehler });
    });

    const ziel_url = process.env.VITE_DEV_SERVER_URL ?? DEV_URL;
    if (process.env.VITE_DEV_SERVER_URL || !app.isPackaged) {
      void betrachter.loadURL(`${ziel_url}#fern`);
    } else {
      void betrachter.loadFile(path.join(here, '../dist/index.html'), { hash: 'fern' });
    }
    return true;
  });

  ipcMain.handle('fern:fensterOffen', () => Boolean(betrachter && !betrachter.isDestroyed()));

  /* Eingaben kommen als fertige Zeilen aus der Ansicht — sie weiß, wo der
     Zeiger auf der Leinwand steht, der Hauptprozess nicht. */
  ipcMain.on('fern:eingabe', (_e, zeilen: string) => {
    if (typeof zeilen === 'string' && zeilen.length < 4096) {
      senden(N_EINGABE, Buffer.from(zeilen, 'utf8'));
    }
  });

  ipcMain.on('fern:steuer', (_e, wunsch: unknown) => {
    senden(N_STEUER, Buffer.from(JSON.stringify(wunsch), 'utf8'));
  });
}

export function fernsteuerungBeenden(): void {
  if (betrachter && !betrachter.isDestroyed()) betrachter.close();
  betrachter = null; schliessen(''); }
