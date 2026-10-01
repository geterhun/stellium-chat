import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, dialog, shell, type BrowserWindow } from 'electron';
import { t, zahlFormatieren, type MainKey } from './i18n.js';

const ausfuehren = promisify(execFile);

/**
 * Selbstaktualisierung über den eigenen Firmenserver.
 *
 * Ablauf: der Renderer meldet Serveradresse und Anmeldetoken, sobald jemand
 * angemeldet ist. Von da an fragt der Hauptprozess regelmäßig nach einer
 * neueren Version, lädt sie im Hintergrund und prüft die Prüfsumme.
 *
 * Installiert wird auf Knopfdruck, und zwar wirklich: die App tauscht sich
 * selbst aus und startet neu. Wie das geht, unterscheidet sich je nach System —
 * macOS hängt ein Abbild ein und kopiert daraus, Windows ruft den Installer
 * still auf, Linux ersetzt die AppImage-Datei. Nur wenn dieser Weg scheitert,
 * bleibt der alte: die Datei öffnen und die Person entscheiden lassen.
 */

interface Fern {
  platform: string;
  version: string;
  notes: string | null;
  size: number;
  sha256: string;
  fileName: string;
  url: string;
}

/** Was zuletzt installiert wurde — für den Willkommensbildschirm danach. */
interface Vermerk {
  version: string;
  notes: string | null;
  installiertAm: number;
}

/**
 * Ein Fehlschlag, der der Person angezeigt werden soll — trägt einen
 * Wörterbuch-Schlüssel statt eines fertigen deutschen Satzes.
 *
 * WARUM: der Hauptprozess kennt die Sprache der angemeldeten Person nicht,
 * nur die Ansicht kennt sie (state/store.ts). `throw new Error('Im Abbild
 * ist keine App enthalten.')` landete bisher unverändert in {grund} von
 * update.installFailed — für eine englische Ansicht damit ein Satz, der zur
 * Hälfte Deutsch blieb (das englische "Installation failed: …" gefolgt von
 * deutschem Fließtext). UpdateFehler trägt stattdessen einen MainKey (siehe
 * electron/i18n.ts); fehlerNutzlast() unten löst ihn in die aktuell bekannte
 * Sprache auf, BEVOR er den Hauptprozess über IPC verlässt.
 *
 * Nicht jeder Fehlschlag hier bekommt einen: ein von hdiutil/ditto/fetch
 * selbst gemeldeter Fehler (Systembefehl, Netzwerk) bleibt unverändert
 * technischer Text — den zu übersetzen wäre nicht mehr Übersetzung, sondern
 * Erfindung, siehe fehlerNutzlast() unten.
 */
class UpdateFehler extends Error {
  constructor(public readonly key: MainKey, public readonly werte?: Record<string, string | number>) {
    super(key);
    this.name = 'UpdateFehler';
  }
}

/**
 * Baut aus einem gefangenen Fehler die Nutzlast für
 * melden('update:error' | 'update:retry', …): `message` steht schon in der
 * aktuellen Hauptprozess-Sprache (electron/i18n.ts, t()), dazu Schlüssel und
 * Werte für den Fall, dass die Ansicht sie künftig selbst auflöst —
 * src/lib/updates.ts tut das heute nur für 'error', nicht für 'retry',
 * darum trägt `message` hier schon den fertigen Text und nicht nur den
 * Schlüssel.
 */
function fehlerNutzlast(err: unknown): { message: string; key?: MainKey; params?: Record<string, string | number> } {
  if (err instanceof UpdateFehler) {
    return { message: t(err.key, err.werte), key: err.key, params: err.werte };
  }
  return { message: (err as Error).message };
}

// Nachfragen: beim Start bald, danach viertelstündlich. Kurz genug, dass ein
// frisch hochgeladenes Update zügig ankommt, ohne den Server zu belästigen.
const INTERVALL = 15 * 60 * 1000;

let serverUrl: string | null = null;
let token: string | null = null;
let fenster: BrowserWindow | null = null;
let timer: NodeJS.Timeout | null = null;
let laeuft = false;
/** Schon heruntergeladene Version — nicht zweimal ziehen. */
let bereit: { version: string; datei: string } | null = null;
/* Die Prüfsumme der geladenen Datei. Zwischen Laden und Einspielen liegt oft
   eine Stunde — in der Zeit kann sich die Datei verändert haben. */
let erwarteteSumme: string | null = null;
let letzteNotizen: string | null = null;

/**
 * Wartefrist bis zur Installation.
 *
 * Ein Update, das jemand wegklickt und nie wieder ansieht, ist kein Update.
 * Deshalb läuft nach dem Herunterladen eine Uhr; wer nichts tut, bekommt die
 * neue Fassung. Wer "später" sagt, verschiebt sie — und beim nächsten Beenden
 * der App wird ohnehin installiert, denn dann stört es niemanden.
 */
const FRIST_MS = 5 * 60 * 1000;
let frist: NodeJS.Timeout | null = null;
let installiertBeimBeenden = false;
/* Läuft gerade ein Austausch? Ohne diese Sperre startet app.quit() über
   'before-quit' einen zweiten Lauf, und zwei Skripte räumen gleichzeitig im
   selben App-Ordner auf. */
let installiertGerade = false;
/* Eine Version, deren Austausch stumm gescheitert ist. Die wird nicht wieder
   von selbst eingespielt — sonst dreht sich das Laden endlos im Kreis.
   Zusammen mit dem Zeitpunkt: ein für immer gültiger Ausschluss traf schon
   einmal einen Fehlschlag, der nichts mit der Version zu tun hatte (Platte
   kurz voll, Datei gerade in Benutzung) — und sperrte sie dann auf ewig vom
   automatischen Weg, bis irgendwann von Hand nachgesehen wurde. Nach der
   Abkühlung darf es die App von selbst noch einmal versuchen: lang genug, um
   keine Schleife zu drehen, kurz genug, dass ein behobenes Problem nicht
   wochenlang unbemerkt bleibt. */
let gescheitert: string | null = null;
let gescheitertSeit: number | null = null;
const GESCHEITERT_ABKUEHLUNG_MS = 24 * 60 * 60 * 1000;

function fristStarten(sekunden = FRIST_MS / 1000): void {
  if (frist) clearTimeout(frist);
  melden('update:deadline', { version: bereit?.version, sekunden });
  frist = setTimeout(() => { void installieren(); }, sekunden * 1000);
}

/** "Später": die Uhr anhalten und stattdessen beim Beenden installieren. */
export function fristVerschieben(): void {
  if (frist) { clearTimeout(frist); frist = null; }
  installiertBeimBeenden = true;
  melden('update:postponed', { version: bereit?.version });
}

/** Steht beim Beenden eine Installation an? */
export function beimBeendenInstallieren(): boolean {
  return installiertBeimBeenden && bereit !== null;
}

export function updaterInit(win: BrowserWindow): void {
  fenster = win;

  /* Nach einem Update läuft entweder die neue Fassung — oder der Austausch ist
     stumm gescheitert und es läuft weiter die alte. Letzteres würde sonst
     niemand merken: die App lädt dieselbe Datei erneut, startet neu, scheitert
     erneut. Einmal ist ein Missgeschick, in einer Schleife ist es ein Fehler. */
  try {
    const datei = path.join(app.getPath('userData'), 'letztes-update.json');
    const vermerk = JSON.parse(fs.readFileSync(datei, 'utf8')) as Vermerk;
    if (vermerk.version && vermerk.version !== app.getVersion()) {
      gescheitert = vermerk.version;
      // installiertAm ist der Zeitpunkt, zu dem der Austausch ANGESTOSSEN
      // wurde — nicht wann er scheiterte, aber nah genug dafür: gescheitert
      // ist er ja, weil dieser Start immer noch die alte Fassung meldet.
      gescheitertSeit = vermerk.installiertAm;
      // Den Vermerk wegräumen, sonst begrüßt der Willkommensgruß eine Fassung,
      // die gar nicht läuft.
      fs.rmSync(datei, { force: true });
    }
  } catch { /* kein Vermerk — dann gab es auch kein Update */ }
}

/**
 * Ein Name, mit dem sich gefahrlos ein Pfad bilden lässt.
 *
 * `fileName` und `version` kommen aus der Antwort des Servers und gingen
 * ungeprüft in `path.join`. Ein Name wie `../../../..` legt die Datei damit
 * irgendwohin im Benutzerordner statt in den Update-Ordner — und unter Windows
 * wird genau diese Datei danach ausgeführt. Der Server ist der eigene; das
 * ändert nichts daran, dass eine Antwort aus dem Netz nie ein Pfad ist.
 */
function alsDateiname(roh: string, ersatz: string): string {
  const nurName = path.basename(String(roh ?? ''));
  const sauber = nurName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return sauber || ersatz;
}

/**
 * Der Ursprung, von dem diese Installation Updates laden darf — einmal
 * gebunden, nicht mehr leise änderbar.
 *
 * WARUM DAS ÜBERHAUPT NÖTIG IST: `updaterAnmelden()` bekommt seine Adresse
 * vom Renderer (siehe main.ts, `update:signin`), und der Renderer hat im
 * Hauptprozess grundsätzlich keinen Vertrauensvorschuss. Das wiegt hier
 * schwerer als anderswo, weil am Ende dieser Kette ein heruntergeladenes
 * Programm OHNE Rückfrage ausgeführt wird (siehe installieren() unten: auf
 * macOS wird die Quarantäne-Markierung entfernt, unter Windows läuft der
 * Installer mit `/S` still). Bislang genügte ein einziger Aufruf
 * `window.stellium.updateSignIn('https://böse.example', 'irgendwas')` aus
 * dem Renderer, um genau diesen Weg auf einen fremden Server umzubiegen —
 * nach heutigem Stand findet sich kein Weg, im Renderer eigenen Code
 * auszuführen (die Postvorschau läuft sandboxed, siehe PostPanel.tsx, und
 * der Vorspann ist schmal, siehe preload.ts), aber genau DAS soll ein
 * künftiger Fehler an anderer Stelle nicht automatisch mit ausnutzen können.
 *
 * Ein hartes Verbot wäre falsch — Stellium ist selbst gehostet, es gibt
 * keine feste Adresse, die sich vorab hartkodieren ließe, und ein
 * Unternehmen kann seinen Server durchaus einmal umziehen. Die Lösung hier:
 * die Adresse wird bei der ERSTEN erfolgreichen Anmeldung dieser
 * Installation abgelegt (dorthin kommt der Renderer nicht heran — kein `fs`
 * im Vorspann), und jede spätere Anmeldung mit einem ANDEREN Ursprung
 * braucht eine ausdrückliche Bestätigung über einen echten Systemdialog,
 * nicht irgendein Feld, das ein Skript selbst ausfüllen könnte.
 *
 * WAS DAS SCHÜTZT: ein Skript im Renderer kann den Update-Ursprung nicht
 * mehr leise umbiegen — es müsste die Person vor dem Bildschirm dazu
 * bringen, einen sichtbaren Dialog mit einer fremden Adresse aktiv zu
 * bestätigen.
 * WAS DAS NICHT SCHÜTZT: das ist keine Echtheitsprüfung der
 * heruntergeladenen Datei — die sha256-Summe weiter unten stammt vom selben
 * Server wie die Datei und beweist nur, dass beim Herunterladen nichts
 * verändert wurde, nicht, dass der Server vertrauenswürdig ist. Es gibt
 * weiterhin keine Codesignatur und keine Signaturprüfung der Fassung
 * selbst — das bleibt hier absichtlich unangetastet, weil es Schlüssel-
 * material und eine andere Veröffentlichungskette braucht und eine
 * Entscheidung der Projektleitung ist, keine, die sich nebenbei in dieser
 * Änderung treffen ließe. Und wer die allererste Anmeldung dieser
 * Installation überhaupt auslöst, bestimmt auch den ersten gebundenen
 * Ursprung — dieser eine Augenblick bleibt ungeprüft, weil er mit der
 * eigenen Anmeldehandlung der Person zusammenfällt.
 */
function herkunftDatei(): string {
  return path.join(app.getPath('userData'), 'update-herkunft.json');
}

function gespeicherteHerkunft(): string | null {
  try {
    const inhalt = JSON.parse(fs.readFileSync(herkunftDatei(), 'utf8')) as { origin?: string };
    return inhalt.origin || null;
  } catch { return null; }
}

function herkunftSpeichern(origin: string): void {
  try { fs.writeFileSync(herkunftDatei(), JSON.stringify({ origin }), 'utf8'); }
  catch { /* dann fragt es beim nächsten Mal erneut nach — kein Beinbruch */ }
}

/** Fragt über einen echten Systemdialog nach, wenn sich der Update-Ursprung
 *  ändert. Ein Skript im Renderer kann diesen Dialog nicht selbst wegklicken. */
async function herkunftWechselBestaetigen(alt: string, neu: string): Promise<boolean> {
  const abbrechen = t('common.cancel');
  const optionen = {
    type: 'warning' as const,
    buttons: [abbrechen, t('update.originChangeConfirm')],
    defaultId: 0,
    cancelId: 0,
    title: t('update.originChangeTitle'),
    message: t('update.originChangeMessage'),
    detail: t('update.originChangeDetail', { alt, neu, abbrechen }),
  };
  const antwort = fenster && !fenster.isDestroyed()
    ? await dialog.showMessageBox(fenster, optionen)
    : await dialog.showMessageBox(optionen);
  return antwort.response === 1;
}

/** Der Renderer meldet sich, sobald jemand angemeldet ist. */
export async function updaterAnmelden(url: string, tok: string): Promise<boolean> {
  /* Auch diese Adresse ist nichts, worauf man sich verlassen kann: sie kommt
     aus dem Renderer, und was von dort kommt, hat im Hauptprozess keinen
     Vertrauensvorschuss. Von dieser Adresse wird gleich eine Datei geladen und
     ausgeführt — http(s) ist dafür das Mindeste, was geprüft gehört. */
  let geprueft: URL;
  try { geprueft = new URL(url); } catch { return false; }
  if (geprueft.protocol !== 'http:' && geprueft.protocol !== 'https:') return false;

  /* Der Ursprung wird gebunden — siehe der lange Kommentar oben. Stimmt er
     mit dem gemerkten überein (der Alltag: derselbe Server bei jeder
     Anmeldung), geht es sofort weiter. Weicht er ab, entscheidet die
     Person, nicht der Aufrufer. */
  const bekannteHerkunft = gespeicherteHerkunft();
  if (bekannteHerkunft && bekannteHerkunft !== geprueft.origin) {
    if (!(await herkunftWechselBestaetigen(bekannteHerkunft, geprueft.origin))) return false;
  }
  if (bekannteHerkunft !== geprueft.origin) herkunftSpeichern(geprueft.origin);

  serverUrl = url.replace(/\/+$/, '');
  token = tok;
  if (timer) clearInterval(timer);
  timer = setInterval(() => { void pruefen(); }, INTERVALL);
  // Kurz warten: beim Start ist die Verbindung oft noch nicht stabil.
  setTimeout(() => { void pruefen(); }, 8_000);
  return true;
}

export function updaterAbmelden(): void {
  serverUrl = null;
  token = null;
  if (timer) { clearInterval(timer); timer = null; }
}

function melden(kanal: string, nutzlast: unknown): void {
  if (fenster && !fenster.isDestroyed()) fenster.webContents.send(kanal, nutzlast);
}

export async function pruefen(manuell = false): Promise<Fern | null> {
  if (!serverUrl || !token || laeuft) return null;
  laeuft = true;
  try {
    const antwort = await fetch(
      `${serverUrl}/api/releases/check?platform=${process.platform}&version=${app.getVersion()}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!antwort.ok) return null;
    const { update } = (await antwort.json()) as { update: Fern | null };
    if (!update) {
      // Auch ohne Knopfdruck melden: sonst zeigt die Ansicht weiter den Stand
      // von vorhin an, obwohl längst nachgesehen wurde.
      melden('update:none', { version: app.getVersion() });
      return null;
    }
    /* Ist derselbe Austausch schon einmal stumm gescheitert, wird er nicht
       von selbst wiederholt — sonst lädt die App dieselbe Datei, startet neu,
       scheitert erneut, und das im Takt der Prüfung. Auf Knopfdruck darf man
       es weiter versuchen; vielleicht war die Platte nur kurz voll. Nach der
       Abkühlung (siehe GESCHEITERT_ABKUEHLUNG_MS) darf auch die automatische
       Prüfung es noch einmal versuchen — ein einmaliger Ausrutscher soll die
       Fassung nicht auf Dauer vom eigenen Weg ausschließen. */
    const abgekuehlt = gescheitertSeit !== null && Date.now() - gescheitertSeit > GESCHEITERT_ABKUEHLUNG_MS;
    if (update.version === gescheitert && !manuell && !abgekuehlt) {
      melden('update:error', {
        key: 'update.previouslyFailed',
        params: { version: update.version },
        version: update.version,
      });
      return null;
    }
    if (manuell || abgekuehlt) { gescheitert = null; gescheitertSeit = null; }

    melden('update:found', update);
    await laden(update);
    return update;
  } catch (err) {
    if (manuell) melden('update:error', { key: 'update.checkFailed', params: { grund: (err as Error).message } });
    return null;
  } finally {
    laeuft = false;
  }
}

async function laden(update: Fern): Promise<void> {
  if (bereit?.version === update.version && fs.existsSync(bereit.datei)) {
    melden('update:ready', { version: update.version, datei: bereit.datei });
    return;
  }

  /* Nicht in den gemeinsamen Zwischenspeicher: unter Linux ist /tmp für alle
     Konten beschreibbar. Zwischen dem Prüfen der Prüfsumme und dem Ausführen
     könnte dort jemand die Datei austauschen. Das eigene Verzeichnis der App
     gehört dem angemeldeten Konto allein. */
  const ordner = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(ordner, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ordner, 0o700); } catch { /* auf Windows ohne Belang */ }
  altesAufraeumen(ordner, update.version);

  const ziel = path.join(ordner, `${alsDateiname(update.version, 'neu')}-${alsDateiname(update.fileName, 'stellium-update')}`);
  const halb = `${ziel}.teil`;

  // Platz prüfen, bevor 170 MB gezogen werden: doppelt, weil beim Installieren
  // noch einmal entpackt wird. Ohne diese Prüfung bricht der Download erst
  // nach Minuten ab — mit einer Meldung, die niemand versteht.
  const noetig = update.size * 2;
  const frei = freierPlatz(ordner);
  if (frei !== null && frei < noetig) {
    melden('update:error', {
      key: 'update.notEnoughSpace',
      // Intl.NumberFormat statt .toFixed(1): Letzteres liefert immer einen
      // Punkt als Trennzeichen, auch für Sprachen, die ein Komma erwarten.
      params: { noetig: zahlFormatieren(noetig / 1e9), frei: zahlFormatieren(frei / 1e9) },
    });
    return;
  }

  /* Bis zu drei Anläufe, und zwar dort weiter, wo es abgerissen ist. Über eine
     Hausleitung dauert ein Update Minuten — in dieser Zeit reicht ein
     Funkloch, und ohne Wiederaufnahme fängt alles von vorn an. */
  for (let versuch = 1; versuch <= 3; versuch += 1) {
    try {
      await ladenVersuch(update, halb, ziel);
      bereit = { version: update.version, datei: ziel };
      erwarteteSumme = update.sha256;
      letzteNotizen = update.notes;
      melden('update:ready', { version: update.version, datei: ziel, notes: update.notes });
      if (!installiertBeimBeenden) fristStarten();
      return;
    } catch (err) {
      const info = fehlerNutzlast(err);
      if (versuch === 3) {
        fs.rmSync(halb, { force: true });
        melden('update:error', info);
        return;
      }
      melden('update:retry', { versuch, ...info });
      await new Promise((f) => setTimeout(f, versuch * 4000));
    }
  }
}

/** Freier Platz am Ablageort, oder null wenn nicht feststellbar. */
function freierPlatz(ordner: string): number | null {
  try {
    return fs.statfsSync(ordner).bavail * fs.statfsSync(ordner).bsize;
  } catch { return null; }
}

/** Reste früherer Läufe wegräumen — sonst füllt sich der Ablageort still. */
function altesAufraeumen(ordner: string, behalten: string): void {
  try {
    for (const name of fs.readdirSync(ordner)) {
      if (name.startsWith(alsDateiname(behalten, 'neu'))) continue;
      fs.rmSync(path.join(ordner, name), { force: true, recursive: true });
    }
  } catch { /* nicht schlimm */ }
}

/**
 * Eine Fassung herunterladen — als Datenstrom auf die Platte, nicht in den
 * Speicher.
 *
 * Vorher sammelte sich die ganze Datei im Arbeitsspeicher und wurde erst am
 * Ende geschrieben: bei 170 MB gut ein Drittel Gigabyte, und auf einem Rechner
 * mit wenig Speicher scheiterte genau daran das Update. Die Prüfsumme entsteht
 * jetzt beim Schreiben mit.
 */
async function ladenVersuch(update: Fern, halb: string, ziel: string): Promise<void> {
  const schon = fs.existsSync(halb) ? fs.statSync(halb).size : 0;
  const kopf: Record<string, string> = { authorization: `Bearer ${token}` };
  if (schon > 0 && schon < update.size) kopf.range = `bytes=${schon}-`;

  // Eine Leitung, die nichts mehr liefert, darf nicht ewig blockieren.
  const abbruch = new AbortController();
  let letzteRegung = Date.now();
  const wache = setInterval(() => {
    if (Date.now() - letzteRegung > 90_000) abbruch.abort();
  }, 10_000);

  /* Die Adresse gehört zum eigenen Server oder zu gar keinem. Vorher wurden
     zwei Zeichenketten aneinandergehängt; eine absolute Adresse in `update.url`
     hätte den Download woandershin geführt. */
  const quelle = new URL(update.url, `${serverUrl}/`);
  if (quelle.origin !== new URL(`${serverUrl}/`).origin) {
    throw new UpdateFehler('update.reason.urlMismatch');
  }

  /* Außerhalb des try, damit `finally` ihn auch nach einem Abbruch schließt.
     Ohne das blieb bei jedem gescheiterten Anlauf ein offener Dateigriff
     stehen — und ein Schreibfehler (Platte voll, Datei weggeräumt) hatte
     keinen Hörer: Node wirft ein 'error' ohne Hörer als ungefangene
     Ausnahme im Hauptprozess, und das Warten auf 'drain' darunter kam nie
     zurück. Dann hing `laeuft` für den Rest der Sitzung auf true, und es
     wurde nie wieder nach einer Fassung gefragt. */
  let schreiber: fs.WriteStream | null = null;
  let schreibFehler: Error | null = null;

  try {
    const antwort = await fetch(quelle, { headers: kopf, signal: abbruch.signal });
    if (!antwort.ok || !antwort.body) throw new UpdateFehler('update.reason.downloadFailed', { status: antwort.status });

    // Beantwortet der Server den Bereich nicht, fangen wir eben von vorn an.
    const setztFort = antwort.status === 206 && schon > 0;
    if (!setztFort && schon > 0) fs.rmSync(halb, { force: true });

    const strom = fs.createWriteStream(halb, { flags: setztFort ? 'a' : 'w', highWaterMark: 1024 * 1024 });
    schreiber = strom;
    strom.on('error', (err) => { schreibFehler = err; });
    let geladen = setztFort ? schon : 0;
    let zuletztGemeldet = 0;

    for await (const stueck of antwort.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(stueck);
      letzteRegung = Date.now();
      if (!strom.write(buf)) {
        await new Promise<void>((f) => {
          const weiter = () => { strom.off('drain', weiter); strom.off('close', weiter); f(); };
          strom.on('drain', weiter);
          strom.on('close', weiter);
        });
      }
      if (schreibFehler) throw schreibFehler;
      geladen += buf.byteLength;
      // Höchstens viermal je Sekunde melden — sonst überschwemmt der
      // Fortschritt die Oberfläche mit Nachrichten.
      const jetzt = Date.now();
      if (jetzt - zuletztGemeldet > 250) {
        zuletztGemeldet = jetzt;
        melden('update:progress', { version: update.version, geladen, gesamt: update.size });
      }
    }
    await new Promise<void>((fertig, schief) => {
      strom.end((err?: Error | null) => (err ? schief(err) : fertig()));
    });

    const gross = fs.statSync(halb).size;
    if (gross !== update.size) throw new UpdateFehler('update.reason.incomplete', { erhalten: gross, gesamt: update.size });

    // Erst prüfen, dann an den endgültigen Platz — eine halbe Datei darf nie
    // wie eine fertige aussehen.
    const summe = await summeVonDatei(halb);
    if (summe !== update.sha256) {
      fs.rmSync(halb, { force: true });
      throw new UpdateFehler('update.reason.checksumMismatch');
    }

    fs.rmSync(ziel, { force: true });
    fs.renameSync(halb, ziel);
    melden('update:progress', { version: update.version, geladen: update.size, gesamt: update.size });
  } finally {
    clearInterval(wache);
    (schreiber as fs.WriteStream | null)?.destroy();
  }
}

/** Prüfsumme einer Datei, ohne sie ganz in den Speicher zu holen. */
function summeVonDatei(datei: string): Promise<string> {
  return new Promise((fertig, schief) => {
    const hash = createHash('sha256');
    const strom = fs.createReadStream(datei, { highWaterMark: 1024 * 1024 });
    strom.on('data', (d) => hash.update(d));
    strom.on('end', () => fertig(hash.digest('hex')));
    strom.on('error', schief);
  });
}

/* ── Installieren ─────────────────────────────────────────────── */

/** Merkt, was gerade installiert wurde — der nächste Start zeigt es an. */
function vermerken(version: string, notes: string | null): void {
  try {
    const datei = path.join(app.getPath('userData'), 'letztes-update.json');
    const inhalt: Vermerk = { version, notes, installiertAm: Date.now() };
    fs.writeFileSync(datei, JSON.stringify(inhalt), 'utf8');
  } catch { /* nicht schlimm — dann fehlt nur der Hinweis danach */ }
}

/** Was beim letzten Mal installiert wurde, einmalig abzuholen. */
export function letztesUpdate(): Vermerk | null {
  const datei = path.join(app.getPath('userData'), 'letztes-update.json');
  try {
    const inhalt = JSON.parse(fs.readFileSync(datei, 'utf8')) as Vermerk;
    // Nur einmal zeigen.
    fs.rmSync(datei, { force: true });
    return inhalt;
  } catch { return null; }
}

/**
 * Schreibt das Austauschskript und startet es abgekoppelt — gemeinsamer
 * Schlussteil für beide macOS-Formen (Abbild oder entpacktes .zip).
 *
 * `neueApp` zeigt auf die bereits vollständige neue App (eingehängt oder
 * entpackt, das ist dem Skript gleich). `quelleWegraeumen` ist der Bash-Befehl,
 * der hinterher die Herkunft entsorgt — aushängen beim Abbild, löschen beim
 * Entpackordner.
 */
function macAustauschStarten(neueApp: string, quelleWegraeumen: string): void {
  const ziel = path.resolve(app.getPath('exe'), '../../..');

  // Nach dem Beenden: austauschen, Herkunft wegräumen, neu starten. Das
  // Skript läuft ohne Elternprozess weiter, deshalb überlebt es unser Ende.
  const skript = path.join(app.getPath('userData'), `update-${Date.now()}.sh`);

  /* Erst kopieren, dann tauschen — nicht andersherum.
     Vorher wurde die alte App gelöscht und danach die neue kopiert. Ging beim
     Kopieren etwas schief (Platte voll, Herkunft weg, Rechte), war überhaupt
     keine App mehr da: aus einem fehlgeschlagenen Update wurde eine
     verschwundene Anwendung. Jetzt liegt die neue vollständig daneben, bevor
     die alte weicht — und wenn etwas klemmt, kommt die alte zurück. */
  fs.writeFileSync(skript, `#!/bin/bash
# Von Stellium erzeugt. Tauscht die App aus, während sie beendet ist.
set -u
ZIEL=${JSON.stringify(ziel)}
NEU=${JSON.stringify(neueApp)}
FRISCH="$ZIEL.neu"
ALT="$ZIEL.alt"

aufraeumen() {
  rm -rf "$FRISCH"
  ${quelleWegraeumen}
  rm -f "$0"
}

for i in $(seq 1 40); do
  pgrep -x Stellium >/dev/null || break
  sleep 0.25
done

rm -rf "$FRISCH" "$ALT"
if ! cp -R "$NEU" "$FRISCH"; then
  # Nichts angefasst — die alte App läuft weiter.
  aufraeumen
  open "$ZIEL"
  exit 1
fi

xattr -dr com.apple.quarantine "$FRISCH" 2>/dev/null

if ! mv "$ZIEL" "$ALT"; then
  aufraeumen
  open "$ZIEL"
  exit 1
fi

if ! mv "$FRISCH" "$ZIEL"; then
  # Umbenennen ging schief: den alten Stand zurückholen.
  mv "$ALT" "$ZIEL" 2>/dev/null
  aufraeumen
  open "$ZIEL"
  exit 1
fi

rm -rf "$ALT"
${quelleWegraeumen}
open "$ZIEL"
rm -f "$0"
`, { mode: 0o700 });

  spawn('/bin/bash', [skript], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * macOS, wenn ein Abbild vorliegt: einhängen, die App daraus an ihren Platz
 * kopieren, wieder aushängen. Das Ersetzen läuft in einem eigenen Skript,
 * denn die laufende App kann sich nicht selbst überschreiben, während sie
 * noch läuft.
 */
async function installiereMacAusAbbild(datei: string): Promise<void> {
  const einhaengepunkt = `/Volumes/stellium-update-${Date.now()}`;
  await ausfuehren('hdiutil', ['attach', datei, '-nobrowse', '-quiet', '-mountpoint', einhaengepunkt]);

  const eintraege = fs.readdirSync(einhaengepunkt).filter((n) => n.endsWith('.app'));
  if (!eintraege.length) {
    await ausfuehren('hdiutil', ['detach', einhaengepunkt, '-force']).catch(() => {});
    throw new UpdateFehler('update.reason.noAppInImage');
  }

  const neu = path.join(einhaengepunkt, eintraege[0]);
  macAustauschStarten(neu, `hdiutil detach ${JSON.stringify(einhaengepunkt)} -force >/dev/null 2>&1`);
}

/**
 * macOS, wenn ein .zip vorliegt: entpacken statt einhängen, dann derselbe
 * Austausch wie beim Abbild.
 *
 * `ditto` statt `unzip` — das ist der Weg, den auch Finder beim Doppelklick
 * nimmt, und der einzige, der Ressourcengabeln, erweiterte Attribute und
 * Symlinks in einem App-Bündel zuverlässig erhält. Mit `unzip` allein sind
 * manche .app-Bündel danach beschädigt.
 *
 * Wieso überhaupt zwei Formen: das Bauwerkzeug erzeugt für macOS sowohl ein
 * .dmg als auch ein .zip (siehe packages/desktop/package.json, "mac.target").
 * Der eigene Weg zum Server lädt gezielt das .dmg hoch (siehe
 * scripts/veroeffentlichen.mjs). Liegt stattdessen ein .zip auf dem Server —
 * etwa weil jemand es über die Verwaltung von Hand aus packages/desktop/release
 * hochgeladen hat, wo beide Dateien nebeneinanderliegen —, scheiterte
 * `hdiutil attach` an einem .zip bisher IMMER und sofort ("Image nicht
 * erkannt"), und zwar bei jedem einzelnen Versuch: die App fiel augenblicklich
 * auf den Rückfall zurück (Ordner öffnen, Person entscheiden lassen), ohne
 * dass das je als Fehler zu erkennen war — der Ordner ging ja auf, wie
 * vorgesehen. Jetzt erkennt die App das Format und kommt mit beiden zurecht.
 */
async function installiereMacAusZip(datei: string): Promise<void> {
  const basis = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(basis, { recursive: true, mode: 0o700 });
  const zielOrdner = fs.mkdtempSync(path.join(basis, 'entpackt-'));

  try {
    await ausfuehren('ditto', ['-x', '-k', datei, zielOrdner]);
  } catch (err) {
    fs.rmSync(zielOrdner, { recursive: true, force: true });
    // (err as Error).message kommt von ditto selbst (Systembefehl) — bleibt
    // als technisches Detail unübersetzt, siehe UpdateFehler oben.
    throw new UpdateFehler('update.reason.unpackFailed', { grund: (err as Error).message });
  }

  const eintraege = fs.readdirSync(zielOrdner).filter((n) => n.endsWith('.app'));
  if (!eintraege.length) {
    fs.rmSync(zielOrdner, { recursive: true, force: true });
    throw new UpdateFehler('update.reason.noAppInPackage');
  }

  const neu = path.join(zielOrdner, eintraege[0]);
  macAustauschStarten(neu, `rm -rf ${JSON.stringify(zielOrdner)}`);
}

/** macOS: je nach geladenem Format den passenden Weg nehmen. */
async function installiereMac(datei: string): Promise<void> {
  if (/\.zip$/i.test(datei)) await installiereMacAusZip(datei);
  else await installiereMacAusAbbild(datei);
}

/**
 * Windows: der NSIS-Installer kann still laufen und die App danach starten.
 */
async function installiereWindows(datei: string): Promise<void> {
  spawn(datei, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Linux: läuft die App als AppImage, wird die Datei ersetzt. Sonst bleibt nur
 * der alte Weg über das Paketwerkzeug.
 */
async function installiereLinux(datei: string): Promise<void> {
  const appimage = process.env.APPIMAGE;
  if (!appimage) throw new UpdateFehler('update.reason.noAppImage');

  /* Für Linux gibt es serverseitig nur einen Platz, und dort kann auch ein .deb
     liegen. Über ein laufendes AppImage kopiert, wäre die App unwiderruflich
     hin — ein Debian-Paket startet nicht. Lieber von Hand installieren. */
  if (!/\.appimage$/i.test(datei)) {
    throw new UpdateFehler('update.reason.notAppImage');
  }

  /* Ins eigene Verzeichnis, nicht nach /tmp — derselbe Grund wie beim
     Ablageort in laden(): /tmp ist für alle Konten beschreibbar, der Name
     hier vorhersagbar, und zwischen Schreiben und Ausführen liegen zwei
     Sekunden. Wer die Datei vorher selbst anlegt, behält sie (writeFileSync
     schreibt in eine vorhandene Datei, ohne Eigentümer oder Rechte zu
     ändern) und kann den Inhalt austauschen, bevor bash ihn liest. */
  const skript = path.join(app.getPath('userData'), `update-${Date.now()}.sh`);
  fs.writeFileSync(skript, `#!/bin/bash
# Von Stellium erzeugt. Ersetzt das AppImage, sobald es beendet ist.
sleep 2
cp -f ${JSON.stringify(datei)} ${JSON.stringify(appimage)}
chmod +x ${JSON.stringify(appimage)}
${JSON.stringify(appimage)} &
rm -f "$0"
`, { mode: 0o700 });

  spawn('/bin/bash', [skript], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Installiert die geladene Version und startet Stellium neu.
 *
 * Schlägt der eigene Weg fehl, wird die Datei geöffnet — dann übernimmt die
 * Person. Lieber ein Handgriff mehr als eine App, die nach einem misslungenen
 * Austausch gar nicht mehr startet.
 */
export async function installieren(): Promise<boolean> {
  if (installiertGerade) return true;
  if (!bereit || !fs.existsSync(bereit.datei)) return false;
  installiertGerade = true;
  // Sonst startet das app.quit() weiter unten über 'before-quit' einen zweiten Lauf.
  installiertBeimBeenden = false;
  if (frist) { clearTimeout(frist); frist = null; }

  try {
    /* Zwischen Laden und Einspielen liegt oft eine Stunde, in der die Datei
       offen im Benutzerordner liegt. Vor dem Ausführen also noch einmal
       nachrechnen, ob es wirklich dieselbe Datei ist. */
    if (erwarteteSumme) {
      const jetzt = await summeVonDatei(bereit.datei);
      if (jetzt !== erwarteteSumme) {
        fs.rmSync(bereit.datei, { force: true });
        bereit = null;
        installiertGerade = false;
        melden('update:error', fehlerNutzlast(new UpdateFehler('update.reason.fileChanged')));
        return false;
      }
    }
    vermerken(bereit.version, letzteNotizen);
    if (process.platform === 'darwin') await installiereMac(bereit.datei);
    else if (process.platform === 'win32') await installiereWindows(bereit.datei);
    else await installiereLinux(bereit.datei);

    melden('update:installing', { version: bereit.version });
    // Kurz Luft lassen, damit die Meldung noch ankommt.
    setTimeout(() => app.quit(), 900);
    return true;
  } catch (err) {
    installiertGerade = false;
    /* Merken, dass GENAU DIESE Fassung gerade gescheitert ist — nicht erst
       beim nächsten Start (siehe updaterInit). Ohne das flackerte die
       Anzeige alle 15 Minuten von „fehlgeschlagen" zurück auf „bereit", weil
       die nächste automatische Prüfung nichts von diesem Versuch wusste und
       einfach erneut „update:ready" meldete — ein Klick auf Installieren
       hätte denselben Fehlschlag nur wiederholt. */
    gescheitert = bereit?.version ?? gescheitert;
    gescheitertSeit = Date.now();
    melden('update:error', {
      key: 'update.installFailed',
      // fehlerNutzlast(err).message ist bei einem UpdateFehler schon der
      // übersetzte Grund (siehe UpdateFehler oben) — bei jedem anderen
      // Fehler unverändert dessen (technische) .message.
      params: { grund: fehlerNutzlast(err).message },
    });
    // Nur der Prüfsummen-Zweig oben setzt `bereit` auf null, und der kehrt
    // sofort zurück — hier ist die Datei also da. Die Abfrage steht für den
    // Übersetzer, der das nicht mitverfolgen kann.
    if (bereit) await shell.openPath(bereit.datei);
    return true;
  }
}
