/**
 * stellium-fern-dienst — der Vermittler auf dem Pi.
 *
 * Er verwaltet `fern-host` (Bild und Eingabe), nimmt Verbindungen an, prüft
 * ID und Passwort und reicht danach beides verschlüsselt durch.
 *
 * Drei Entscheidungen, die man beim Lesen kennen sollte:
 *
 * 1. `fern-host` läuft **nur, solange jemand zusieht**. Ohne Verbindung
 *    gibt es keinen Prozess, der abgreift — TeamViewer lässt seinen Dienst
 *    dauerhaft mitlaufen und belegt dabei 815 MB.
 *
 * 2. **Es wird nicht gestaut.** Kommt die Leitung nicht nach, werden Bilder
 *    weggeworfen statt gepuffert. Ein verlorenes Bild sieht niemand, ein
 *    Rückstau von zwei Sekunden macht die Fernsteuerung unbenutzbar. Nur
 *    Schlüsselbilder werden nie verworfen — ohne sie bleibt das Bild stehen.
 *
 *    Diese Regel stand hier von Anfang an, griff aber jahrelang ins Leere.
 *    Gemessen wurde `ws.bufferedAmount`, und der zählt nur, was INNERHALB von
 *    Node wartet. Der Stau lag woanders: im Sendepuffer des Kerns, den TCP bei
 *    langer Laufzeit selbsttätig auf mehrere hundert KB vergrößert. Node gab
 *    die Bilder ab, der Kern nahm sie an, der Zähler blieb bei null — und die
 *    Schwelle löste nie aus. Auf dem Gerät gemessen (21.08.2026): 350–642 KB
 *    dauerhaft im Kern, dazu `verworfen 0` in der Anzeige. Das waren gut
 *    anderthalb Sekunden Bild, die dem Betrachter davonliefen.
 *    Deshalb wird der Rückstau jetzt dort gelesen, wo er wirklich liegt —
 *    siehe `sendestau()`.
 *
 * 4. **Die Bitrate folgt der Leitung.** Fest eingestellt waren 6000 kbit/s;
 *    die Leitung trug gemessen 1,6–2,5. Wer mehr erzeugt, als durchpasst,
 *    baut genau den Rückstau auf, den Punkt 2 verhindern soll — Verwerfen
 *    repariert dann nur noch die Folgen. `rateWunschNachziehen()` regelt
 *    deshalb an der Ursache.
 *
 * 3. **Mehrere sehen zu, einer steuert.** Der Abgriff läuft genau einmal,
 *    sein Bild geht an alle. Ein zweiter Abgriff daneben würde die Bildrate
 *    halbieren — auf vier Kernen gemessen, siehe LIESMICH.md. Geteilt wird
 *    also das Bild, nicht die Maus: ein Schreibtisch, an dem zwei
 *    gleichzeitig zeigen, ist unbrauchbar. Wer als Erster etwas eingibt, hat
 *    Tastatur und Maus; nach `STEUER_RUHE_MS` ohne Eingabe darf der Nächste
 *    übernehmen (siehe `steuerungBeanspruchen`).
 *
 *    Bis 09/2026 stand hier „Immer nur einer", und ein zweiter Zuschauer
 *    wurde mit 4009 abgewiesen („schon jemand verbunden").
 *
 * 5. **Lebenszeichen.** Genau das machte aus der Regel von damals einen
 *    Fehler, der auch den einen Zuschauer aussperrte, der erlaubt war: eine
 *    Verbindung, die nicht ordentlich auflegt — Deckel zu, WLAN gewechselt,
 *    App abgeschossen, Weiterleitung im Router abgelaufen —, schickt kein
 *    `close`. Ohne Lebenszeichen merkt das niemand: der Platz blieb belegt,
 *    bis TCP von selbst aufgab, und das dauert eine Viertelstunde und mehr.
 *    In dieser Zeit meldete der Pi jedem anderen „schon jemand verbunden",
 *    obwohl in Wahrheit niemand zusah. Deshalb jetzt `ping`/`pong`: wer
 *    zweimal nicht antwortet, ist weg und macht den Platz frei.
 */
import { WebSocketServer } from 'ws';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { kennungLaden, grussBauen, antwortPruefen, Schatulle } from './anmeldung.mjs';

const ORDNER   = process.env.FERN_ORDNER ?? '/var/lib/stellium/fern';
const HOST_BIN = process.env.FERN_HOST   ?? '/usr/local/lib/stellium/fern-host';
const PORT     = Number(process.env.FERN_PORT ?? 7788);
const ZUSTAND  = path.join(ORDNER, 'zustand.json');

/*
 * Wie viele gleichzeitig zusehen dürfen.
 *
 * Das Bild wird nur einmal erzeugt, aber jedem einzeln geschickt — die
 * Obergrenze schützt also nicht den Pi, sondern seine Leitung nach draußen.
 * Vier ist keine gemessene Zahl, sondern eine Annahme über den Alltag: eine
 * Handvoll Leute schaut demselben Schreibtisch zu. Wird sie erreicht, kommt
 * 4010 zurück und die App sagt, dass schon so viele zusehen, wie möglich ist
 * — nicht mehr „schon jemand verbunden", denn das war ja nie der Grund.
 */
const ZUSCHAUER_MAX = Math.max(1, Number(process.env.FERN_ZUSCHAUER ?? 4));

/*
 * Lebenszeichen: wie oft gefragt wird, ob die Gegenstelle noch da ist.
 *
 * Zehn Sekunden, und nach zwei unbeantworteten Fragen ist Schluss — also
 * spätestens nach zwanzig Sekunden statt nach der Viertelstunde, die TCP von
 * allein braucht (siehe Punkt 5 im Kopf). Kürzer bringt nichts: eine lange
 * Leitung mit 240 ms Laufzeit kommt damit bequem hin, und jede Frage kostet
 * einen Rahmen auf einer Leitung, auf der Bilder wichtiger sind.
 */
const PING_MS = Math.max(1000, Number(process.env.FERN_PING_MS ?? 10_000));

/*
 * Wie lange die Steuerung bei jemandem bleibt, der nichts eingibt.
 *
 * Ohne diese Frist wäre die Maus für alle anderen weg, sobald einer sie
 * einmal angefasst hat und dann Mittag macht — und niemand könnte etwas
 * dagegen tun, ohne ihn anzurufen. Fünfzehn Sekunden sind lang genug, um
 * einen Satz zu lesen, ohne die Steuerung zu verlieren (beim Tippen und
 * Zeigen kommt ohnehin ständig etwas), und kurz genug, dass eine Übergabe
 * nicht wie ein Ausfall aussieht.
 */
const STEUER_RUHE_MS = Math.max(1000, Number(process.env.FERN_STEUER_RUHE ?? 15_000));

/* Rahmenarten, die `fern-host` ausgibt. */
const H_BILD = 1, H_ABLAGE = 2, H_MELDUNG = 3;
/* Nachrichtenarten auf der Leitung. */
const N_BILD = 1, N_ABLAGE = 2, N_INFO = 3, N_EINGABE = 4, N_STEUER = 5;

/*
 * Wieviel Rückstand erlaubt ist — als **Zeit**, nicht als Bytes.
 *
 * Hier stand lange `96 * 1024`, gewählt für 960x540 bei rund 2 Mbit/s. Auf
 * kurzer Leitung ist eine feste Byte-Zahl auch richtig: dort ist alles, was
 * unterwegs ist, tatsächlich Rückstand.
 *
 * Über eine lange Leitung stimmt das nicht mehr. Bei 236 ms Laufzeit müssen
 * für 6 Mbit/s dauerhaft rund 176 KB unterwegs sein — das ist die Füllung
 * des Rohrs, kein Stau. Die alte Regel hielt genau diese Füllung für
 * Überlastung und drosselte, bis weniger als 96 KB unterwegs waren. Damit
 * war der Durchsatz fest gedeckelt:
 *
 *     96 KB × 8 / 0,236 s ≈ 3,3 Mbit/s
 *
 * Gemessen wurde genau das: Regelung bei 2531–3375 kbit/s, während der Kern
 * `delivery_rate 4,4 Mbit/s` meldete und dabei `app_limited` setzte — er
 * wartete auf Daten. Die Regel hat sich selbst ausgebremst und das Bild
 * unnötig weich gemacht. Auf dem Schreibtisch nebenan fiel das nie auf, weil
 * dort die Laufzeit unter einer Millisekunde liegt und die Rohrfüllung damit
 * praktisch null ist.
 *
 * Jetzt wird abgezogen, was ohnehin unterwegs sein muss (Rate × Laufzeit),
 * und nur der Rest zählt als Stau. Der darf höchstens diese Zeit kosten.
 */
const STAU_ZEIT_S = 0.15;
/* Wie lange eine Messung aus `ss` gilt. Danach zählt sie nicht mehr, und es
   gilt wieder die strenge Rechnung ohne Rohrfüllung — lieber zu vorsichtig
   als auf Grundlage von Zahlen, die nicht mehr stimmen. */
const LEITUNG_FRIST_MS = 6000;
/* Selbst bei kleiner Rate soll nicht schon ein einzelnes Bild als Stau
   gelten — ein Schlüsselbild ist gut und gern 100 KB. */
const STAU_MINDEST = 64 * 1024;

/* Wie oft der Rückstau aus /proc gelesen wird. Bei 45 Bildern/s wäre einmal
   je Bild verschwendet — die Zahl ändert sich nicht so schnell. */
const STAU_TAKT_MS = 200;

const kennung = kennungLaden(ORDNER);

/* ── Zustand für das Dashboard ───────────────────────────────── */

/* Ausdrücklich nur, OB jemand verbunden ist — nie, was er dabei sieht oder
   tut. Genau so hat Don es verlangt.

   Seit Kurzem steht hier auch WER — aber nur als Behauptung, kein Nachweis.
   Angemeldet wird sich allein über das gemeinsame Passwort; wer es kennt,
   kann jeden Namen eintragen (siehe `alsProtokollname` weiter unten). Auf
   einem Rechner, an dem mehrere mit demselben Passwort zusehen dürfen, ist
   „irgendjemand sieht gerade zu" trotzdem zu wenig — es geht um
   Nachvollziehbarkeit im Alltag, nicht um Beweiskraft. Am WAS ändert das
   nichts: das steht hier weiterhin nirgends. */
/* Alle offenen Sitzungen, in der Reihenfolge, in der sie dazugekommen sind
   (ein Set behält sie) — die erste ist die, die im Dashboard als `konto`
   steht, damit dort nicht mit jedem Dazukommen ein anderer Name auftaucht. */
const sitzungen = new Set();

/* Wer gerade Tastatur und Maus hat, und wann von dort zuletzt etwas kam.
   Siehe `steuerungBeanspruchen`. */
let steuerer = null;
let steuerBeruehrt = 0;

/* Die letzte Taktmeldung des Abgreifers. Sie gehört dem Abgriff, nicht einer
   Sitzung: es gibt nur einen, und er meldet für alle dasselbe. */
let hostMeldung = '';

/** Die älteste Sitzung — die, die das Dashboard beim Namen nennt. */
function erste() {
  for (const s of sitzungen) return s;
  return null;
}

function zustandSchreiben() {
  const s1 = erste();
  const z = {
    verbunden: sitzungen.size > 0,
    seit: s1?.seit ?? null,
    konto: s1?.kontoName ?? null,
    /* Neu, und der Grund, dass es diese Fassung gibt: es kann mehr als einer
       zusehen. `verbunden`, `seit` und `konto` bleiben daneben stehen, weil
       ältere Anzeigen (stellium-konsole, konsole-gui) nur diese drei kennen —
       sie zeigen dann eben den Ersten, so wie bisher. */
    zuschauer: sitzungen.size,
    namen: [...sitzungen].map((s) => s.kontoName).filter(Boolean),
    /* Wer die Maus hat. Auch das eine Behauptung, siehe unten. */
    steuerung: steuerer?.kontoName ?? null,
    id: kennung.id,
    hafen: PORT,
    aktualisiert: new Date().toISOString(),
    /* Wie schnell es gerade läuft — Takt, Rückstau, Verworfene.
       Das ist KEIN Bruch mit der Regel darüber: hier steht, wie schnell
       Bilder fließen, nirgends WAS auf ihnen zu sehen ist.
       Der Grund dafür ist praktischer Natur: um zu messen, wie sich die
       Fernsteuerung im Betrieb schlägt, wurde bisher ein zweiter Abgriff
       daneben gestartet — und der halbiert auf vier Kernen genau das, was
       er messen soll. Mehrere Messreihen sind daran gescheitert. Die
       laufende Sitzung selbst berichten zu lassen, kostet nichts und
       verfälscht nichts. */
    leistung: sitzungen.size ? {
      takt: hostMeldung || null,
      /* Bei mehreren Zuschauern die ungünstigste Zahl: wer den größten
         Rückstand hat, bestimmt, wie es sich anfühlt. Die Rate ist die des
         Abgreifers und damit ohnehin für alle dieselbe. */
      stau: Math.max(...[...sitzungen].map((s) => s.stau ?? 0)),
      rate: hostRate || null,
      verworfenGesamt: [...sitzungen].reduce((n, s) => n + (s.verworfenGesamt ?? 0), 0),
      bilder: [...sitzungen].reduce((n, s) => n + (s.bilder ?? 0), 0),
    } : null,
  };
  try {
    fs.writeFileSync(ZUSTAND + '.neu', JSON.stringify(z, null, 2), { mode: 0o644 });
    fs.renameSync(ZUSTAND + '.neu', ZUSTAND);   /* atomar, damit das Dashboard
                                                   nie eine halbe Datei liest */
  } catch { /* nicht schreiben zu können darf die Sitzung nicht beenden */ }
}

/* ── Bremse gegen Durchprobieren ─────────────────────────────── */

const fehlversuche = new Map();   /* Adresse → { anzahl, bis } */

function darfVersuchen(adresse) {
  const e = fehlversuche.get(adresse);
  if (!e) return true;
  if (Date.now() > e.bis) { fehlversuche.delete(adresse); return true; }
  return e.anzahl < 5;
}

function versuchGescheitert(adresse) {
  const e = fehlversuche.get(adresse) ?? { anzahl: 0, bis: 0 };
  e.anzahl += 1;
  /* Wartezeit verdoppelt sich: 2s, 4s, 8s … bis 5 Minuten. Wer das Passwort
     rät, kommt so auf eine Handvoll Versuche pro Stunde. */
  e.bis = Date.now() + Math.min(2000 * 2 ** e.anzahl, 300_000);
  fehlversuche.set(adresse, e);
}

function versuchGelungen(adresse) { fehlversuche.delete(adresse); }

/* ── Der Abgreifer ───────────────────────────────────────────── */

/*
 * Es gibt genau einen, und alle Zuschauer sehen sein Bild.
 *
 * Vorher hing er an einer Sitzung — das war richtig, solange es nur eine
 * geben durfte, und ist jetzt die Stelle, an der sich entscheidet, ob
 * mehrere Zuschauer etwas kosten. Sie kosten Leitung (jeder bekommt das Bild
 * einzeln geschickt), aber keine Rechenzeit: abgegriffen, gewandelt und
 * kodiert wird einmal. Ein zweiter Abgriff daneben halbiert die Bildrate,
 * das ist auf dem Gerät gemessen — deshalb hier ein Verweis auf genau einen
 * Prozess und ein `hostSichern()`, das zweimal Starten ausschließt, auch
 * wenn zwei Leute im selben Augenblick verbinden.
 */
let host = null;        /* { kind, rest } — der laufende Abgriff */
let hostRate = 0;       /* welche Bitrate ihm zuletzt gesagt wurde */
let hostMax = 0;        /* seine Obergrenze — Vorgabe für neue Sitzungen */

/** Startet den Abgriff, falls er nicht schon läuft. */
function hostSichern() {
  if (!host) hostStarten({});
}

/** Beendet ihn, wenn niemand mehr zusieht — er soll nichts kosten, solange
 *  keiner hinschaut (siehe Kopf, Punkt 1). */
function hostFreigebenWennLeer() {
  if (sitzungen.size > 0 || !host) return;
  const k = host.kind;
  host = null; hostRate = 0;
  try { k.kill('SIGTERM'); } catch { /* schon weg */ }
  /* Wer auf SIGTERM nicht hört, bekommt nach zwei Sekunden SIGKILL — sonst
     bliebe ein Abgreifer hängen und der nächste Anlauf fände den Compositor
     besetzt. */
  const notaus = setTimeout(() => { try { k.kill('SIGKILL'); } catch {} }, 2000);
  notaus.unref();
}

/** Eine Befehlszeile an den Abgreifer. `writable` wird geprüft, weil `kind`
 *  nach einem Neustart kurz auf einen geschlossenen Kanal zeigt. */
function hostSchreiben(zeile) {
  if (!host?.kind.stdin?.writable) return false;
  try { host.kind.stdin.write(zeile); return true; } catch { return false; }
}

/*
 * „Bitte ein vollständiges Bild."
 *
 * Nötig, sobald jemand mitten in einen laufenden Strom dazukommt: ein
 * Zwischenbild ohne seinen Bezug ergibt nur Grün und Schlieren, und die App
 * wartet darum von sich aus auf ein Schlüsselbild. Von allein kommt eins erst
 * nach `i_keyint_max` — vier Sekunden bei 45 Bildern —, und so lange sähe der
 * Dazugekommene ein schwarzes Fenster und hielte es für einen Fehler.
 *
 * Ältere Abgreifer kennen den Befehl nicht und überlesen ihn stillschweigend
 * (`default: break` in fern-host.c). Dann bleibt es bei der Wartezeit von
 * vorher — schlechter als vorher wird es dadurch nie.
 */
function schluesselbildBitte() { hostSchreiben('s\n'); }

function hostStarten(einstellungen) {
  /* OHNE `--ausgabe`: der Host sendet dann in der Größe des Schirms, also
     pixelgenau und ohne jede Skalierung (SWS_POINT statt Bilinear).

     Verkleinern klingt nach dem naheliegenden Weg zu mehr Bildern, bringt
     hier aber nichts. Auf dem Gerät abgelesen, während es lief:
         lesen 55,1 ms · Farbe 5,3 ms · kodieren 2,5 ms
     Der Abgriff holt IMMER den ganzen Schirm — was danach verkleinert wird,
     ändert daran nichts. Und Farbe und Kodieren laufen auf einem eigenen
     Faden; zusammen kosten sie 7,8 ms gegen 55,1 fürs Lesen. In voller
     Größe werden daraus etwa 20 ms — immer noch weit unter dem Lesen, das
     den Takt allein bestimmt. Volle Auflösung ist also praktisch gratis.
     Sie kostet Bandbreite, nicht Bilder — und darum kümmert sich
     `rateNachziehen`.

     Die Rate ist nur die OBERGRENZE. Sie darf hoch stehen, seit die
     Regelung den echten Rückstau sieht: gemessen trägt die Leitung
     2,2–4,4 Mbit/s, und wo sie mehr hergibt, soll das Bild schärfer werden
     statt Reserve zu verschenken. */
  const rateMax = einstellungen.rate ?? 6000;
  /* Weder `--auftraege` noch `--faeden`: der Host bringt die gemessenen
     Werte selbst mit (1 Anforderung, 4 Fäden). Sie hier zu wiederholen hieße
     nur, sie an zwei Stellen pflegen zu müssen — und beim nächsten Mal steht
     an einer davon etwas Veraltetes. */
  const args = [
    '--bilder', String(einstellungen.bilder ?? 45),
    '--rate',   String(rateMax),
  ];
  if (einstellungen.auftraege) args.push('--auftraege', String(einstellungen.auftraege));
  /* Nur wenn ausdrücklich gewünscht — sonst bleibt es bei der Schirmgröße.
     Die Höhe zieht der Host am Seitenverhältnis nach, damit nichts staucht. */
  if (einstellungen.breite) {
    args.push('--ausgabe', `${einstellungen.breite}x${einstellungen.hoehe ?? 0}`);
  }
  hostMax = rateMax;
  hostRate = rateMax;
  const kind = spawn(HOST_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '/run/user/1000',
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? 'wayland-0',
    },
  });

  host = { kind, rest: Buffer.alloc(0) };
  const dieser = host;

  /*
   * Ein `spawn`, das gar nicht startet — fehlendes Programm, kein Recht —
   * meldet sich als `error`-Ereignis. Ohne Hörer dafür wirft Node es als
   * unbehandelte Ausnahme, und dann ist nicht der Abgriff weg, sondern der
   * ganze Dienst: niemand kommt mehr herein, bis systemd ihn neu startet.
   * Dasselbe gilt für `stdin` — eine Pipe, deren Gegenseite verschwunden ist,
   * meldet EPIPE nicht beim Schreiben, sondern später als Ereignis. Beides
   * hier abgefangen; um das Aufräumen kümmert sich `exit` weiter unten.
   */
  kind.on('error', (f) => console.error('[host] Start misslungen:', f.message));
  kind.stdin.on('error', () => { /* Abgriff ist weg — `exit` räumt auf */ });

  /* Der Strom kommt als [Art:1][Länge:4 LE][Inhalt] — über eine Pipe
     zerfällt das in beliebige Stücke, also selbst zusammensetzen. */
  kind.stdout.on('data', (stueck) => {
    dieser.rest = dieser.rest.length ? Buffer.concat([dieser.rest, stueck]) : stueck;
    for (;;) {
      if (dieser.rest.length < 5) return;
      const art = dieser.rest[0];
      const laenge = dieser.rest.readUInt32LE(1);
      if (dieser.rest.length < 5 + laenge) return;
      const inhalt = dieser.rest.subarray(5, 5 + laenge);
      dieser.rest = dieser.rest.subarray(5 + laenge);
      hostRahmen(art, inhalt);
    }
  });

  kind.stderr.on('data', (d) => {
    const t = String(d).trim();
    /* x264 meldet beim Start zwei Zeilen über die CPU — das ist keine
       Störung und soll das Protokoll nicht fluten. */
    if (t && !t.startsWith('x264 [info]')) console.error('[host]', t);
  });

  kind.on('exit', (code, signal) => {
    /* Nur, wenn das noch der aktuelle Abgriff ist: bei `neuStarten` läuft der
       alte Prozess noch kurz aus, während der neue schon steht. */
    if (host !== dieser) return;
    host = null; hostRate = 0;
    console.error(`[host] beendet (${signal ?? code})`);
    /* Ohne Bild hat Zusehen keinen Sinn — alle auflegen. Sie kommen gleich
       wieder herein, und dann wird der Abgriff neu gestartet. */
    for (const s of [...sitzungen]) {
      try { s.ws.close(1011, 'Abgriff beendet'); } catch { /* schon zu */ }
    }
  });

  return host;
}

/** Ein Schlüsselbild fängt in Annex-B mit einem IDR-Kopf an. Bei
 *  `b_repeat_headers` steht davor SPS (Art 7) — daran erkennt man es. */
function istSchluesselbild(buf) {
  for (let i = 0; i + 4 < buf.length && i < 64; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      const art = buf[i + 3] & 0x1f;
      if (art === 7 || art === 5) return true;      /* SPS oder IDR */
      if (art === 1) return false;                  /* gewöhnliches Bild */
    }
  }
  return false;
}

/*
 * Der echte Rückstau: was der Kern noch nicht losgeworden ist.
 *
 * `ws.bufferedAmount` taugt dafür nicht (siehe Kopf, Punkt 2). Was zählt,
 * steht in /proc/net/tcp: Feld 4 ist `tx_queue:rx_queue`, und tx_queue sind
 * genau die Bytes, die geschrieben, aber noch nicht bestätigt sind.
 *
 * Gefunden wird die Zeile über den Port der Gegenstelle — der ist je
 * Verbindung eindeutig, anders als die Adresse. IPv6 zuerst, weil eine
 * IPv4-Verbindung auf einem Lauscher ohne Bindung als ::ffff:… dort steht.
 *
 * Nur Linux. Das ist kein Mangel: dieser Dienst läuft auf dem Pi und nirgends
 * sonst. Fehlt die Datei, liefert die Funktion 0 und es gilt wieder allein
 * der Node-Zähler — schlechter als vorher wird es dadurch nie.
 */
/*
 * Die Tabelle wird für ALLE Zuschauer zusammen gelesen, nicht je Zuschauer.
 *
 * Bei vier Verbindungen wäre das sonst viermal dieselbe Datei in derselben
 * Millisekunde — und `/proc/net/tcp` ist nicht billig: der Kern setzt sie bei
 * jedem Lesen aus der Verbindungstabelle neu zusammen.
 */
let stauTabelleStand = 0;
let stauTabelle = new Map();      /* Port der Gegenstelle → tx_queue */

function stauTabelleFrischen() {
  const jetzt = Date.now();
  if (jetzt - stauTabelleStand < STAU_TAKT_MS) return;
  stauTabelleStand = jetzt;
  const tabelle = new Map();
  /* Nur Zeilen dieses Lauschers zählen. Der Port der Gegenstelle ist je
     Rechner eindeutig, aber zwei verschiedene Rechner können denselben
     erwischen — und dann stünde hier der Rückstau einer fremden Verbindung. */
  const hexHier = PORT.toString(16).toUpperCase().padStart(4, '0');
  for (const datei of ['/proc/net/tcp6', '/proc/net/tcp']) {
    let text;
    try { text = fs.readFileSync(datei, 'utf8'); } catch { continue; }
    for (const zeile of text.split('\n')) {
      const f = zeile.trim().split(/\s+/);
      if (f.length < 5 || !f[1] || !f[2] || !f[4]) continue;
      if (!f[1].endsWith(':' + hexHier)) continue;
      const tx = parseInt(f[4].split(':')[0], 16);
      const port = parseInt(f[2].split(':').pop(), 16);
      /* IPv6 zuerst gelesen, IPv4 überschreibt nicht: eine IPv4-Verbindung
         auf einem Lauscher ohne Bindung steht in tcp6 als ::ffff:… — und nur
         dort mit dem richtigen Rückstau. */
      if (Number.isFinite(tx) && Number.isFinite(port) && !tabelle.has(port)) {
        tabelle.set(port, tx);
      }
    }
  }
  stauTabelle = tabelle;
}

function sendestau(sitzung) {
  const jetzt = Date.now();
  if (jetzt - (sitzung.stauGelesen ?? 0) < STAU_TAKT_MS) return sitzung.stau ?? 0;
  sitzung.stauGelesen = jetzt;
  stauTabelleFrischen();

  const port = sitzung.ws?._socket?.remotePort;
  const tx = port ? stauTabelle.get(port) : undefined;
  if (tx === undefined) { sitzung.stau = 0; return 0; }
  sitzung.stau = tx;
  /* Kurzer Verlauf für die Wachstumsprüfung. Fünf Messungen sind eine
     Sekunde — lang genug, um Zufall auszuschließen, kurz genug, um
     schneller zu sein als die Ratenregelung mit ihren zwei Sekunden. */
  const v = (sitzung.stauVerlauf ??= []);
  v.push(tx);
  if (v.length > 5) v.shift();
  return tx;
}

/*
 * Was der Kern über die Leitung weiß.
 *
 * `/proc/net/tcp` liefert nur den Rückstau. Laufzeit und tatsächlich
 * erreichten Durchsatz kennt allein die TCP-Schicht, und `ss -tni` gibt sie
 * heraus. Beides ist hier nötig: ohne Laufzeit lässt sich Rohrfüllung nicht
 * von Rückstau trennen, und ohne gemessenen Durchsatz müsste sich die
 * Regelung in kleinen Schritten an die Obergrenze herantasten.
 *
 * Bewusst nebenläufig und höchstens alle zwei Sekunden: ein Prozessstart im
 * Bildpfad wäre genau die Art Ruckler, die hier abgestellt werden soll.
 * Fehlt `ss`, bleiben beide Werte leer — dann gilt wieder die alte Rechnung
 * ohne Rohrfüllung, und schlechter als vorher wird es dadurch nie.
 */
function leitungMessen(sitzung) {
  const jetzt = Date.now();
  if (jetzt - (sitzung.leitungGelesen ?? 0) < 2000) return;
  sitzung.leitungGelesen = jetzt;
  const port = sitzung.ws?._socket?.remotePort;
  if (!port) return;
  execFile('ss', ['-tni', `sport = :${PORT} and dport = :${port}`],
    { timeout: 1500 }, (fehler, aus) => {
      if (fehler || !aus) return;
      /* `minrtt` und NICHT `rtt`.
         `rtt` ist die aktuelle Laufzeit — die durch Warteschlangen bereits
         verlängert ist. Damit würde sich der Fehler selbst verstärken:
         mehr Stau → höhere gemessene Laufzeit → größer gerechnete
         Rohrfüllung → echter Stau wird unsichtbar → hochregeln → noch mehr
         Stau. `minrtt` ist die kürzeste je gesehene Laufzeit, also die
         Strecke ohne Warteschlange — genau das, was die Rohrfüllung meint.
         Gemessen auf dieser Leitung: rtt 236,0 ms, minrtt 224,5 ms; unter
         Last laufen die beiden weit auseinander. */
      const l = /\bminrtt:([\d.]+)/.exec(aus) ?? /\brtt:([\d.]+)/.exec(aus);
      const d = /\bdelivery_rate (\d+)bps/.exec(aus);
      if (l) sitzung.laufzeitMs   = Number(l[1]);
      if (d) sitzung.durchsatzKbit = Math.round(Number(d[1]) / 1000);
      /* Wann diese Werte entstanden sind. Ohne das bleiben sie nach einem
         Fehlschlag von `ss` beliebig lange stehen — unbemerkt, weil nichts
         sie als veraltet kennzeichnet. */
      if (l || d) sitzung.leitungStand = Date.now();
    });
}

/*
 * Wächst der Rückstand gerade?
 *
 * Das ist die ehrlichste Frage, die dieses Programm stellen kann, und die
 * einzige, die ohne Schätzung auskommt. `stauMasse` unten muss die
 * Rohrfüllung aus Laufzeit und Durchsatz RECHNEN — beides kommt aus `ss`,
 * höchstens alle zwei Sekunden, und liegt daneben, wenn die Leitung sich
 * gerade ändert. Der rohe Rückstand dagegen steht alle 200 ms frisch da.
 *
 * Ob er STEIGT beantwortet direkt: läuft mehr hinein als hinaus. Dafür
 * braucht es keine Ahnung davon, wie groß das Rohr ist.
 *
 * Bewusst streng: durchgehend steigend über eine Sekunde UND spürbar
 * gewachsen. Einzelne Ausschläge sind normal — TCP schiebt in Wellen.
 */
const WACHSTUM_MINDEST = 16 * 1024;

function waechstStau(sitzung) {
  const v = sitzung.stauVerlauf;
  if (!v || v.length < 5) return false;
  for (let i = 1; i < v.length; i += 1) if (v[i] <= v[i - 1]) return false;
  return v[v.length - 1] - v[0] > WACHSTUM_MINDEST;
}

/*
 * Rückstau von Rohrfüllung trennen.
 *
 * `unterwegs` ist alles, was noch nicht beim Betrachter ist. Davon ist
 * `rohr` unvermeidlich — es ist die Strecke selbst. Nur was darüber liegt,
 * wartet wirklich irgendwo und kostet zusätzliche Verzögerung.
 */
function stauMasse(sitzung) {
  const unterwegs = sendestau(sitzung) + (sitzung.ws?.bufferedAmount ?? 0);
  const ziel      = hostRate || hostMax || 2000;
  /* Für die Rohrfüllung zählt, wie schnell die Daten **wirklich** abfließen,
     nicht was wir uns vorgenommen haben. Ein Schreibtisch, der sich kaum
     ändert, braucht die Zielrate gar nicht aus — rechnet man trotzdem mit
     ihr, erscheint das Rohr größer als es ist und echter Rückstau bleibt
     unsichtbar. Genau das war zu sehen: Ziel 6000, tatsächlich 2900, und
     der Rückstand wuchs unbemerkt auf über 300 KB. Deshalb der kleinere
     der beiden Werte. */
  const kbit      = Math.min(ziel, sitzung.durchsatzKbit || ziel);
  const bytesJeS  = kbit * 1000 / 8;
  const rohr      = bytesJeS * ((sitzung.laufzeitMs ?? 0) / 1000);
  const erlaubt   = Math.max(STAU_MINDEST, bytesJeS * STAU_ZEIT_S);
  return { unterwegs, stau: Math.max(0, unterwegs - rohr), erlaubt };
}

/*
 * Die Bitrate an das anpassen, was wirklich durchgeht.
 *
 * Bewusst unsymmetrisch — schnell runter, langsam hoch. Ein zu hoher Wert
 * kostet sofort Verzögerung und ist eine Sekunde später noch zu spüren; ein
 * zu niedriger kostet nur etwas Schärfe. Wer beim Runterregeln zögert,
 * bezahlt das mit genau dem Ruckeln, das hier abgestellt werden soll.
 *
 * Der Rückstau ist dabei das bessere Maß als die reine Durchsatzmessung: er
 * sagt nicht nur, wie viel ankommt, sondern ob der Betrachter hinterherhängt.
 */
function rateWunschNachziehen(sitzung) {
  const jetzt = Date.now();
  if (jetzt - (sitzung.rateGeprueft ?? 0) < 2000) return;
  sitzung.rateGeprueft = jetzt;
  if (!host || !hostMax) return;

  leitungMessen(sitzung);
  const { stau, erlaubt } = stauMasse(sitzung);
  const jetzige = sitzung.rateWunsch ?? hostRate ?? hostMax;
  let neu = jetzige;

  /* Zwei Wege nach unten, und der zweite ist der schnellere: `stau > erlaubt`
     hängt an Werten, die bis zu zwei Sekunden alt sein können, das Wachstum
     an einer Zahl von vor 200 ms. Wer nur auf den ersten hört, regelt zu spät
     — genau das war an der alten Regelung falsch, nur andersherum. */
  if (stau > erlaubt || waechstStau(sitzung)) {
    neu = Math.round(jetzige * 0.75);          /* Rückstau: deutlich runter */
    /* Verlauf leeren, sonst löst dasselbe Wachstum beim nächsten Durchgang
       ein zweites Mal aus, obwohl schon gedrosselt wurde. */
    sitzung.stauVerlauf = [];
  } else if (stau < erlaubt / 4) {
    /* Der Kern weiß besser als jede Schätzung, was die Leitung trägt — er
       misst es an den Bestätigungen. Solange Luft ist, gehen wir gleich in
       die Nähe dieses Werts, statt uns in 8-%-Schritten heranzutasten: von
       2500 auf 6000 kbit/s wären das elf Schritte, also gut zwanzig
       Sekunden weiches Bild nach jeder Störung. Die 0,95 lassen Abstand,
       damit die Messung nicht ihre eigene Obergrenze bestätigt. */
    const gemessen = sitzung.durchsatzKbit ? Math.round(sitzung.durchsatzKbit * 0.95) : 0;
    neu = Math.max(Math.round(jetzige * 1.08), gemessen);
  }
  neu = Math.max(400, Math.min(hostMax, neu));
  if (neu === jetzige) return;
  sitzung.rateWunsch = neu;
  rateAnHost();
}

/*
 * Aus mehreren Wünschen eine Bitrate machen: die KLEINSTE gewinnt.
 *
 * Es gibt nur einen Kodierer, also auch nur eine Rate — sie muss zu der
 * schwächsten Leitung passen, die gerade zusieht. Andersherum wäre es keine
 * Wahl zwischen scharf und unscharf, sondern zwischen Bild und keinem Bild:
 * ein Bild, das für den Langsamsten zu groß ist, erreicht ihn überhaupt nicht
 * — er würde fast alles verwerfen und ein stehendes Bild sehen. Dem Schnellen
 * kostet dieselbe Entscheidung nur Schärfe, und das ist die Abwägung, die
 * `rateWunschNachziehen` oben schon für den Einzelnen trifft („ein zu
 * niedriger Wert kostet nur etwas Schärfe").
 *
 * Wer daran etwas ändern will, braucht keinen zweiten Kodierer, sondern
 * `--faeden`-Reserve und Messungen: zwei Ströme in zwei Auflösungen kosten
 * auf vier Kernen mehr, als die Leitung hergibt.
 */
function rateAnHost() {
  if (!host || !hostMax) return;
  let kleinster = hostMax;
  for (const s of sitzungen) {
    const w = s.rateWunsch ?? hostMax;
    if (w < kleinster) kleinster = w;
  }
  const neu = Math.max(400, Math.min(hostMax, kleinster));
  if (neu === hostRate) return;
  if (hostSchreiben(`b${neu}\n`)) hostRate = neu;
}

/*
 * Ein Rahmen vom Abgreifer geht an alle, die zusehen.
 *
 * Verworfen wird dagegen JE ZUSCHAUER: der Rückstand ist eine Eigenschaft
 * seiner Leitung, nicht des Bildes. Wer nicht nachkommt, verliert einzelne
 * Bilder, ohne dass die anderen davon etwas merken — das ist der ganze
 * Unterschied zwischen „mehrere sehen zu" und „alle sehen so schlecht wie der
 * Schlechteste".
 *
 * Schlüsselbilder werden nie verworfen (siehe Kopf, Punkt 2) — deshalb steht
 * die Prüfung hier oben einmal und nicht je Zuschauer: sie kostet sonst
 * viermal dasselbe.
 */
function hostRahmen(art, inhalt) {
  if (art === H_BILD) {
    const schluessel = istSchluesselbild(inhalt);
    for (const sitzung of sitzungen) {
      if (sitzung.ws.readyState !== sitzung.ws.OPEN) continue;
      rateWunschNachziehen(sitzung);
      /* Beide Zähler zusammen: was in Node wartet UND was der Kern noch nicht
         losgeworden ist. Der zweite ist auf einer langsamen Leitung der weitaus
         größere — genau ihn hat die Regel früher übersehen. */
      const { stau, erlaubt } = stauMasse(sitzung);
      /* Auch hier beide Wege. Das Verwerfen ist die letzte Verteidigungslinie;
         sie darf nicht an denselben veralteten Zahlen hängen wie die
         Ratenregelung, sonst fällt bei einer schnellen Verschlechterung beides
         gleichzeitig aus. */
      if ((stau > erlaubt || waechstStau(sitzung)) && !schluessel) {
        sitzung.verworfen += 1;
        continue;                     /* siehe Kopf: verwerfen statt stauen */
      }
      senden(sitzung, N_BILD, inhalt);
      sitzung.bilder += 1;
    }
  } else if (art === H_ABLAGE) {
    /* Die Zwischenablage des Pi geht an alle — sie ist Teil dessen, was man
       sieht. Der Weg hinein ist die Gegenrichtung und darum dem vorbehalten,
       der gerade steuert (siehe `N_ABLAGE` unten). */
    for (const sitzung of sitzungen) senden(sitzung, N_ABLAGE, inhalt);
  } else if (art === H_MELDUNG) {
    hostMeldung = String(inhalt);
    /* Bei jeder Meldung mitschreiben — so steht im Zustand immer der Stand
       der letzten zwei Sekunden, ohne eigenen Zeitgeber. */
    for (const sitzung of sitzungen) {
      sitzung.verworfenGesamt = (sitzung.verworfenGesamt ?? 0) + sitzung.verworfen;
    }
    zustandSchreiben();
    for (const sitzung of sitzungen) {
      infoSenden(sitzung);
      sitzung.verworfen = 0;
    }
  }
}

/**
 * Wie es gerade läuft — und wer außer einem selbst noch zusieht.
 *
 * Geht im Takt der Taktmeldung hinaus (alle zwei Sekunden) und zusätzlich
 * sofort, wenn sich an der Steuerung etwas ändert: ein Knopf, der erst zwei
 * Sekunden später umspringt, fühlt sich kaputt an.
 *
 * Ältere Apps lesen aus dieser Nachricht nur `takt` und `verworfen` und
 * überlesen den Rest — deshalb kommen die neuen Felder hier dazu und nicht in
 * einer neuen Nachrichtenart, die sie als Fehler werten würden.
 */
function infoSenden(sitzung) {
  const mass = stauMasse(sitzung);
  senden(sitzung, N_INFO, Buffer.from(JSON.stringify({
    takt: hostMeldung,
    verworfen: sitzung.verworfen,
    /* `stau` ist jetzt der echte Rückstand ohne Rohrfüllung. `unterwegs`
       steht daneben, sonst wäre auf einer langen Leitung nicht zu sehen,
       wieviel überhaupt in der Luft ist. */
    stau: Math.round(mass.stau),
    unterwegs: mass.unterwegs,
    laufzeit: Math.round(sitzung.laufzeitMs ?? 0),
    durchsatz: sitzung.durchsatzKbit ?? 0,
    rate: hostRate || hostMax || 0,
    /* Wie viele gerade zusehen, und ob die Maus bei mir liegt. Ohne das
       zweite wäre der Knopf „Steuerung an" eine Behauptung der App über sich
       selbst — er soll aber zeigen, was der Pi tatsächlich annimmt. */
    zuschauer: sitzungen.size,
    steuert: steuerer === sitzung,
    /* Wenn ein anderer steuert: sein Name, damit die App nicht „irgendwer"
       anzeigen muss. Eine Behauptung wie jeder Name hier, siehe unten. */
    steuerungBei: steuerer && steuerer !== sitzung ? (steuerer.kontoName ?? '') : null,
  })));
}

/*
 * Wer darf Tastatur und Maus?
 *
 * Der Erste, der etwas eingibt — und danach er allein, solange er dabei
 * bleibt. Die Frist (`STEUER_RUHE_MS`) ist der Grund, dass das im Alltag
 * trägt: ohne sie könnte einer die Maus mitnehmen und nie wieder hergeben.
 *
 * Kein Verhandeln, keine Warteschlange, keine Rechte: wer das Passwort hat,
 * ist gleichberechtigt. Die Frage „darf der das?" ist beim Passwort
 * entschieden, nicht hier.
 *
 * `beansprucht` trennt die zwei Wege hierher: der Knopf in der App fragt
 * ausdrücklich (`true`) und darf einen abgelaufenen Halter ablösen; eine
 * Eingabe fragt nebenbei (`false`) und übernimmt nur, wenn gerade niemand
 * steuert oder die Frist abgelaufen ist. Das kommt auf dasselbe hinaus und
 * steht nur deshalb getrennt da, weil ältere Apps den Knopf nicht kennen und
 * einfach lostippen — auch die sollen steuern können.
 */
function steuerungFrei() {
  return !steuerer || !sitzungen.has(steuerer)
    || Date.now() - steuerBeruehrt > STEUER_RUHE_MS;
}

function steuerungBeanspruchen(sitzung) {
  if (steuerer === sitzung) { steuerBeruehrt = Date.now(); return true; }
  if (!steuerungFrei()) return false;
  const vorher = steuerer;
  steuerer = sitzung;
  steuerBeruehrt = Date.now();
  console.error(`[steuerung] jetzt bei ${sitzung.kontoName ?? '?'}`);
  zustandSchreiben();
  /* Beide Seiten sofort benachrichtigen — der neue bekommt einen Knopf, der
     leuchtet, der alte einen, der ausgeht. */
  infoSenden(sitzung);
  if (vorher && sitzungen.has(vorher)) infoSenden(vorher);
  return true;
}

function steuerungAbgeben(sitzung) {
  if (steuerer !== sitzung) return;
  steuerer = null;
  zustandSchreiben();
  for (const s of sitzungen) infoSenden(s);
}

function senden(sitzung, art, inhalt) {
  try {
    sitzung.ws.send(sitzung.hinaus.zu(art, inhalt), { binary: true });
  } catch { /* Verbindung weg — der close-Umgang räumt auf */ }
}

/**
 * Auf eine kurze, harmlose Zeile kürzen — für die Anzeige im Protokoll.
 *
 * Kein Identitätsnachweis, siehe oben: der Name ist eine Behauptung. Trotzdem
 * soll ein launischer oder falsch verdrahteter Client das Dashboard nicht mit
 * Steuerzeichen oder endlosem Text durcheinanderbringen können — deshalb
 * Steuerzeichen raus und eine Länge, die auf einer Zeile bleibt.
 *
 * Gefiltert wird über den Zahlenwert (`codePointAt`), nicht über eine Regex
 * mit Kontrollbytes in der Zeichenklasse — die sind in einer Quelldatei
 * kaum verlässlich zu halten und machen daraus für Werkzeuge wie `grep`
 * leicht eine "binäre" Datei. `Array.from` statt `.slice` direkt auf dem
 * String, damit ein Emoji am Rand nicht mitten im Surrogatpaar zerschnitten
 * wird.
 */
function alsProtokollname(roh) {
  if (typeof roh !== 'string') return null;
  const zeichen = Array.from(roh).filter((z) => {
    const p = z.codePointAt(0);
    return p >= 32 && p !== 127;
  });
  const platt = zeichen.join('').trim();
  if (!platt) return null;
  return Array.from(platt).slice(0, 60).join('');
}

/* ── Verbindungen ────────────────────────────────────────────── */

const server = new WebSocketServer({ port: PORT, maxPayload: 4 * 1024 * 1024 });
console.error(`stellium-fern lauscht auf ${PORT}   ID ${kennung.id}   `
  + `bis zu ${ZUSCHAUER_MAX} Zuschauer`);
zustandSchreiben();

/*
 * Woran man merkt, dass niemand mehr zusieht.
 *
 * Eine Verbindung, die ordentlich auflegt, schickt `close` — dann räumt der
 * Hörer weiter unten auf. Der schwierige Fall ist der andere: Deckel zu,
 * WLAN gewechselt, App abgeschossen, Weiterleitung im Router abgelaufen. Dann
 * kommt nichts, und ohne Nachfrage bleibt die Sitzung stehen. Genau das war
 * der Fehler, an dem die Fernsteuerung im Alltag scheiterte: solange nur
 * einer zusehen durfte, hat so eine Geisterverbindung alle anderen
 * ausgesperrt, und die App sagte wahrheitsgemäß, aber unbrauchbar: „Es ist
 * schon jemand verbunden."
 *
 * Auf TCP zu warten hilft dabei nicht. Es merkt es irgendwann selbst — nach
 * mehr als einer Viertelstunde Neuversuchen, und nur, solange überhaupt etwas
 * gesendet wird. Eine Frage alle zehn Sekunden kostet nichts und beantwortet
 * dieselbe Frage in Sekunden. `pong` beantwortet jede Gegenstelle von sich
 * aus — dafür braucht keine App eine neue Fassung.
 *
 * Ein Zeitgeber für alle, nicht einer je Sitzung: bei vier Zuschauern wären
 * das vier Wecker für dieselbe Sekunde.
 */
const lebenszeichen = setInterval(() => {
  for (const sitzung of [...sitzungen]) {
    if (!sitzung.lebt) {
      console.error(`[sitzung] keine Antwort mehr von ${sitzung.adresse} — getrennt`);
      /* `terminate`, nicht `close`: eine Gegenstelle, die nicht mehr da ist,
         beantwortet auch den Schließen-Handschlag nicht, und `close` würde
         darauf bis zu 30 Sekunden warten. */
      try { sitzung.ws.terminate(); } catch { /* schon weg */ }
      continue;
    }
    sitzung.lebt = false;
    try { sitzung.ws.ping(); } catch { /* schon weg */ }
  }
}, PING_MS);
lebenszeichen.unref();

server.on('connection', (ws, anfrage) => {
  const adresse = anfrage.socket.remoteAddress ?? '?';

  if (!darfVersuchen(adresse)) {
    ws.close(4029, 'zu viele Versuche');
    return;
  }
  if (sitzungen.size >= ZUSCHAUER_MAX) {
    /* Nicht mehr „schon jemand verbunden", sondern „so viele wie möglich" —
       siehe ZUSCHAUER_MAX. Ältere Apps kennen 4010 nicht und zeigen dann
       ihren allgemeinen Verbindungsfehler; das ist unschön, aber nicht
       falsch, und es passiert erst ab dem fünften Zuschauer. */
    ws.close(4010, 'schon so viele wie möglich');
    return;
  }

  let phase = 'hallo';
  let handschlag = null;
  const sitzung = {
    ws, adresse, hinaus: null, herein: null,
    seit: null, bilder: 0, verworfen: 0,
    kontoName: null,        /* Behauptung der Gegenstelle, siehe oben */
    /* Für die Lebenszeichen oben: beim Verbinden gilt sie als lebendig, jedes
       `pong` bestätigt das erneut. */
    lebt: true,
  };
  ws.on('pong', () => { sitzung.lebt = true; });

  /* Wer sich nicht binnen zehn Sekunden ausweist, fliegt. Sonst könnte man
     mit offenen, halbfertigen Verbindungen die Plätze blockieren. */
  const frist = setTimeout(() => {
    if (phase !== 'offen') { try { ws.close(4008, 'zu langsam'); } catch {} }
  }, 10_000);

  ws.on('message', (roh) => {
    try {
      /* Auch eine Nachricht ist ein Lebenszeichen — sie kann nur von einer
         Gegenstelle kommen, die noch da ist. */
      sitzung.lebt = true;

      if (phase === 'hallo') {
        const hallo = JSON.parse(String(roh));
        if (hallo.art !== 'hallo') throw new Error('erwartet: hallo');
        handschlag = grussBauen(kennung, hallo);
        if (!handschlag) throw new Error('Schlüssel unbrauchbar');
        phase = 'antwort';
        ws.send(JSON.stringify(handschlag.hinaus));
        return;
      }

      if (phase === 'antwort') {
        const antwort = JSON.parse(String(roh));
        const urteil = antwortPruefen(handschlag, antwort);
        if (!urteil.ok) {
          versuchGescheitert(adresse);
          console.error(`[anmeldung] abgewiesen von ${adresse}: ${urteil.grund}`);
          /* Der Grund geht bewusst NICHT hinaus: „Passwort stimmt nicht" wäre
             für den, der rät, eine Bestätigung, dass die ID stimmt. */
          ws.close(4003, 'abgewiesen');
          return;
        }
        versuchGelungen(adresse);
        clearTimeout(frist);
        phase = 'offen';

        sitzung.hinaus = new Schatulle(urteil.schluessel, 'pi');
        sitzung.herein = new Schatulle(urteil.schluessel, 'mac');
        sitzung.seit = new Date().toISOString();
        /* Die Prüfung oben zählt `sitzungen`, und eingetragen wird erst hier —
           dazwischen liegt der Handschlag. Zwei Leute, die im selben
           Augenblick verbinden, kämen damit beide an einer Grenze von einem
           vorbei. Das war bisher der zweite Weg zu einem Platz, den niemand
           mehr räumt: die eine Sitzung überschrieb die andere, und der
           überschriebene Abgriff lief weiter, ohne dass ihn noch jemand
           zurückgeben konnte. Jetzt kann das nichts mehr anrichten — die
           Grenze ist weich (einer zu viel), und der Abgriff hängt an
           `hostSichern()` statt an einer einzelnen Sitzung. */
        sitzungen.add(sitzung);
        zustandSchreiben();

        ws.send(JSON.stringify({ art: 'offen' }));
        /* Genau ein Abgriff für alle. Beim ersten Zuschauer startet er, für
           jeden weiteren gibt es sofort ein vollständiges Bild, damit das
           Fenster nicht schwarz bleibt, bis von selbst eins kommt. */
        const ersterZuschauer = !host;
        hostSichern();
        if (!ersterZuschauer) schluesselbildBitte();
        /* Der Wunsch fängt oben an und wird von der Regelung heruntergezogen,
           falls die Leitung nicht mitkommt — nicht umgekehrt. */
        sitzung.rateWunsch = hostMax;
        rateAnHost();
        /* Alle anderen erfahren sofort, dass jemand dazugekommen ist. */
        for (const s of sitzungen) if (s !== sitzung) infoSenden(s);
        console.error(`[sitzung] offen für ${adresse}   (${sitzungen.size} von ${ZUSCHAUER_MAX})`);
        return;
      }

      /* Ab hier ist alles verschlüsselt. */
      const paket = sitzung.herein.auf(Buffer.from(roh));
      if (!paket) {
        /* Verfälscht oder falscher Schlüssel — nicht raten, auflegen. */
        console.error('[sitzung] Nachricht ließ sich nicht entschlüsseln');
        ws.close(4002, 'kaputt');
        return;
      }

      if (paket.art === N_EINGABE) {
        /* Zeilenweise Befehle, so wie `fern-host` sie erwartet — aber nur von
           dem, der gerade steuert. Ohne diese Zeile führen zwei Zuschauer
           denselben Zeiger, und dabei kommt nichts Brauchbares heraus. */
        if (!steuerungBeanspruchen(sitzung)) return;
        hostSchreiben(paket.inhalt);
      } else if (paket.art === N_ABLAGE) {
        /* Auch das gehört zur Steuerung, und zwar aus einem Grund, der ohne
           Hinsehen nicht auffällt: die App schickt ihre Zwischenablage von
           selbst, zweimal je Sekunde, sobald sie sich ändert (siehe
           electron/fernsteuerung.ts, `ablageBeobachten`). Vier Zuschauer
           würden die Ablage des Pi also im Sekundentakt gegenseitig
           überschreiben, ohne dass einer von ihnen etwas dafür getan hat. */
        if (steuerer !== sitzung) return;
        hostSchreiben('a ' + paket.inhalt.toString('base64') + '\n');
      } else if (paket.art === N_STEUER) {
        const w = JSON.parse(paket.inhalt.toString('utf8'));
        if (w.art === 'steuerung') {
          /* Der Knopf in der App. Antwort kommt als `info`, nicht als eigene
             Nachricht: die App hört dort ohnehin zu, und so steht die Lage in
             genau einer Quelle. */
          if (w.an) steuerungBeanspruchen(sitzung);
          else steuerungAbgeben(sitzung);
          infoSenden(sitzung);
        } else if (w.art === 'neuStarten') {
          /* Auflösung oder Bildrate ändern heißt: den Kodierer neu aufsetzen.
             Einfacher und verlässlicher, als ihn im Lauf umzustellen.
             Das trifft alle Zuschauer, nicht nur den, der es verlangt —
             deshalb darf es nur, wer auch die Maus hat. */
          if (!steuerungBeanspruchen(sitzung) || !host) return;
          const alt = host.kind;
          host = null;
          try { alt.kill('SIGTERM'); } catch { /* schon weg */ }
          hostStarten(w);
          for (const s of sitzungen) s.rateWunsch = hostMax;
          rateAnHost();
        } else if (w.art === 'konto') {
          /* Kommt aus der App, NICHT aus dem Handschlag — der stand zu dem
             Zeitpunkt noch offen, hier ist die Leitung längst verschlüsselt.
             Wer das schickt, hat sich schon übers Passwort ausgewiesen; der
             Name selbst bleibt trotzdem eine Behauptung, siehe oben. */
          sitzung.kontoName = alsProtokollname(w.name);
          zustandSchreiben();
          /* Die anderen sollen den Namen sehen, sobald er da ist — er kommt
             erst nach dem Handschlag und damit nach ihrer letzten Meldung. */
          for (const s of sitzungen) if (s !== sitzung) infoSenden(s);
        }
      }
    } catch (fehler) {
      console.error('[sitzung]', fehler.message);
      try { ws.close(4000, 'Fehler'); } catch { /* schon zu */ }
    }
  });

  const aufraeumen = () => {
    clearTimeout(frist);
    if (!sitzungen.delete(sitzung)) return;   /* schon aufgeräumt */
    /* Wer geht, gibt die Maus frei — sonst wäre sie für die Übrigen bis zum
       Ablauf der Frist blockiert. */
    if (steuerer === sitzung) steuerer = null;
    /* Der Abgriff läuft nur, solange jemand zusieht (siehe Kopf, Punkt 1).
       Beim Letzten geht er aus; sind noch andere da, läuft er weiter — und
       deren Bild reißt dabei nicht ab. */
    hostFreigebenWennLeer();
    rateAnHost();
    zustandSchreiben();
    for (const s of sitzungen) infoSenden(s);
    console.error(`[sitzung] beendet   (noch ${sitzungen.size})`);
  };

  ws.on('close', () => { aufraeumen(); });
  ws.on('error', (f) => { console.error('[sitzung] Fehler:', f.message); aufraeumen(); });
});

for (const zeichen of ['SIGINT', 'SIGTERM']) {
  process.on(zeichen, () => {
    if (host) { try { host.kind.kill('SIGKILL'); } catch {} }
    host = null;
    sitzungen.clear();
    steuerer = null;
    zustandSchreiben();
    process.exit(0);
  });
}
