/**
 * Woraus die Firmenpost lernt — und woraus auf keinen Fall.
 *
 * Dieser Lauf erzeugt ausschließlich VORSCHLÄGE. Er schreibt nie in
 * `mail_wissen`; der einzige Weg dorthin führt über einen Menschen
 * (services/post-wissen.ts, `vorschlagEntscheiden`). Was hier entsteht, wirkt
 * auf keine einzige Antwort, solange niemand zugestimmt hat.
 *
 * DIE EINE QUELLE — UND WARUM ALLE ANDEREN VERBOTEN SIND
 *
 * **Frühere Fassung dieser Datei kannte zwei erlaubte Quellen: einen von
 * einem Menschen VOR dem Senden bearbeiteten KI-Entwurf ("das stärkste
 * Lernsignal, das es gibt") und tatsächlich von Hand geschriebene Post.**
 * Der Auftraggeber hat das ausdrücklich zurückgenommen: **ein von der KI
 * mitgeschriebener Entwurf ist NIE mehr eine Quelle, auch nicht bearbeitet.**
 * Der Grund ist Rückkopplung: lernt der Stil-Teil des Gedächtnisses aus
 * Formulierungen, die von der KI selbst stammen (und ein Mensch beim
 * Freigeben nur redigiert hat), rutscht "wie Stellium schreibt" langsam in
 * Richtung "wie die KI schon schreibt" — und das merkt niemand, bis jede
 * Antwort gleich klingt. Übrig bleibt genau EINE erlaubte Quelle:
 *
 *   · **JA: tatsächlich gesendete Post ohne jede KI-Beteiligung.** So
 *     schreibt die Firma wirklich, ohne Umweg über ein Modell.
 *
 *   · **NIEMALS: eingehende Post.** Die Abfrage in `quellen()` kennt genau
 *     eine Richtung — `NUR_AUSGEHEND`. Das ist keine Prüfung, die man
 *     vergessen kann, sondern die WHERE-Bedingung selbst; es gibt in dieser
 *     Datei keine zweite Abfrage auf `mail_nachrichten`.
 *
 *     Der Grund ist der Schadensunterschied: `post-ki.ts` wehrt eine
 *     eingeschleuste Anweisung für EINE Mail ab. Käme sie ins Gedächtnis,
 *     wirkte sie bei JEDER künftigen Antwort — aus einem Angriff auf eine
 *     Mail würde einer auf alle.
 *
 *     Eine Richtungsprüfung allein genügt dafür nicht, weil ausgehende Post
 *     fremden Text mitschleppen kann. Drei Wege sind zu, jeder einzeln
 *     nachlesbar:
 *       1. `ohneZitat()` (post-wissen-ki.ts) schneidet den Zitatblock unter
 *          einer Antwort ab.
 *       2. `istWeiterleitung()` unten wirft jede Mail heraus, deren Betreff
 *          mit „Fwd:"/„Wg:" beginnt — genau die Marke, die `weiterleiten()`
 *          in services/post.ts selbst setzt. Eine Weiterleitung IST
 *          eingegangener Text unter ausgehender Richtung.
 *       3. `spiegeltEingang()` unten vergleicht den ausgehenden Text mit
 *          jeder eingegangenen Mail desselben Verlaufs. Wer über 60 %
 *          Wortüberschneidung liegt, gibt fremden Text wieder, gleich über
 *          welchen Weg er dorthin kam.
 *     Und selbst wenn alle drei versagten, entstünde nur eine Karte im
 *     Reiter, die ein Mensch ablehnt. Das ist der Sinn der Freigabe.
 *
 *   · **NIEMALS: irgendeine Mail, an der die KI mitgeschrieben hat** — ob
 *     unverändert übernommen oder von einem Menschen bearbeitet. Eine KI, die
 *     aus ihrer eigenen (und sei es redigierten) Ausgabe lernt, verstärkt
 *     ihre eigenen Formulierungen, bis nur noch die übrig sind (siehe oben).
 *     ZWEI Wege, wie eine gesendete Mail als KI-beteiligt gilt, jeder einzeln
 *     nachlesbar:
 *       1. Es gibt einen Entwurf in `mail_entwuerfe` mit `gesendet_id` auf
 *          diese Mail (`entwurf.text_ki` gesetzt) — der Weg über die
 *          automatische Sichtung (post-sichtung.ts). Fällt hier IMMER heraus,
 *          mit zwei verschiedenen Gründen fürs Protokoll (`kaumVeraendert`
 *          bei `MINDEST_VERAENDERUNG` = 0, `kiBearbeitet` sonst) — aber ohne
 *          Unterschied in der Wirkung: keiner der beiden liefert einen
 *          Kandidaten.
 *       2. `mail_nachrichten.ki_art` (gesetzt von services/post.ts::senden(),
 *          IMMER wenn `Ausgang.textKi` gesetzt war) ist nicht NULL. Das
 *          deckt den zweiten Weg, auf dem KI-Text ohne Entwurfszeile
 *          hinausgeht: „KI schreibt" (post-entwurf-ki.ts). Ersetzt die
 *          frühere Textsuche `traegtKennzeichnung()` nach der Kennzeichnung
 *          im Fließtext — die gibt es dort seit Kurzem gar nicht mehr, die
 *          Kennzeichnung ist eine Fußzeile geworden, die services/post.ts
 *          erst BEIM SENDEN anhängt (services/post-fussnote.ts). Eine
 *          Textsuche fände sie deshalb nicht mehr zuverlässig; die Spalte
 *          dagegen steht unabhängig davon fest, was im Fließtext steht.
 *
 * ABGELEHNTE UND UMGESCHRIEBENE ENTWÜRFE — BEWUSST KEINE QUELLE
 *
 * Ein abgelehnter Entwurf sagt „so nicht". Er sagt nicht, was stattdessen
 * richtig gewesen wäre, und aus „nicht so" lässt sich keine Regel bilden — zu
 * zählen, wie oft abgelehnt wurde, ergäbe eine Zahl ohne Handlung. Nach dem
 * Grund zu fragen wäre mehr wert, hieße aber, das Ablehnen um ein Pflichtfeld
 * zu erweitern; ein Knopf, der eine Begründung verlangt, wird umgangen, und
 * dann steht dort „passt nicht".
 *
 * **Frühere Fassung:** wer einen Entwurf umschreibt und sendet, hat ihn
 * abgelehnt UND die Antwort mitgeliefert — das war die einzige Stelle, an der
 * eine Ablehnung wirklich etwas zu sagen hatte. Das ist jetzt trotzdem KEINE
 * Quelle mehr: der Wortlaut steht immer noch zu großen Teilen von der KI da,
 * und genau das will der Auftraggeber nicht mehr im Gedächtnis wiederfinden
 * (siehe oben). Eine Ablehnung bleibt deshalb eine Karte, die verschwindet,
 * ohne eine Spur im Gedächtnis zu hinterlassen — genau wie eine stumme
 * Ablehnung ohne Umschreiben.
 *
 * KEIN MODELLAUFRUF IM ANFRAGEZYKLUS
 *
 * Wie bei post-partnergruppen.ts: eigener, ruhiger Hintergrundtakt. Ein
 * Modellaufruf auf einem Raspberry Pi dauert Sekunden bis Minuten und darf
 * nichts blockieren, was gerade Post entgegennimmt.
 */
import { db } from '../db/index.js';
import { entschluesseln } from '../crypto/nachrichten.js';
import { wortAehnlichkeit } from '../translation/echo.js';
import { assistant } from '../translation/index.js';
import { getSetting, setSetting } from './settings.js';
import {
  KENNZEICHNUNG_DE, KENNZEICHNUNG_EN, KENNZEICHNUNG_BEARBEITET_DE, KENNZEICHNUNG_BEARBEITET_EN,
} from './post-ki.js';
import {
  lernAnweisung, lernEingabe, ohneZitat, veraenderung,
  type WissenArt,
} from './post-wissen-ki.js';
import {
  aktiveEintraege, offeneAnzahl, schonVorgelegt, vorschlagEintragen,
  OFFEN_MAX, type WissenHerkunft,
} from './post-wissen.js';

/* ── Die eine erlaubte Richtung ───────────────────────────────────
   Als benannte Konstante und nicht in die Abfrage geschrieben, damit sie
   beim Lesen dieser Datei ins Auge fällt und ein Prüflauf sie zitieren kann.
   Es gibt in dieser Datei keine zweite Abfrage auf `mail_nachrichten`. */
const NUR_AUSGEHEND = "richtung = 'aus'";

/* ── Stellschrauben ───────────────────────────────────────────── */

/** Marke: bis zu dieser Mailkennung wurde gelernt. Überlebt den Neustart. */
const WASSERSTAND_SCHLUESSEL = 'wissen_lernen_ab';

/**
 * Der Wasserstand fehlt in GENAU einem Fall dauerhaft, nicht nur beim allerersten
 * Neustart: dieser Datei selbst gibt es auf einer laufenden Installation noch
 * nicht — `getSetting()` liefert dann nicht „ganz am Anfang", sondern schlicht
 * `null`, weil niemand je etwas hineingeschrieben hat. Ohne diese Funktion
 * würde `quellen()` in genau diesem Fall bei der ÄLTESTEN je gesendeten Mail
 * anfangen (siehe die `marke`-Fallunterscheidung dort) — und jede davon fiele
 * auf `mail_entwuerfe.text_ki` bzw. `mail_nachrichten.ki_art`, denn BEIDE
 * Spalten sind ebenfalls neu: jede Altzeile trägt dort NULL, unabhängig
 * davon, ob die KI beteiligt war. Der Filter, der genau das verhindern soll
 * (siehe Dateikopf), liefe damit für die gesamte Vergangenheit leer durch —
 * jede von der KI mitgeschriebene Mail vor diesem Release bestünde beide
 * Prüfungen und würde zur Lernquelle. Genau der eine Fehler, den diese Datei
 * laut eigenem Kopf NIE zulassen darf.
 *
 * ENTSCHEIDUNG GEGEN einen Text-Rückfall auf die alte, inline im Fließtext
 * gespeicherte Kennzeichnung (`KENNZEICHNUNG_DE`/`_EN`, siehe post-ki.ts —
 * `kennzeichnungSichern()` in post-sichtung.ts hängt sie seit jeher an). Der
 * Wortlaut ist zwar unverändert, aber „unverändert seit der aktuellen
 * Fassung" ist keine Zusage für 32 Releases Produktionsverlauf, und dieselbe
 * Datei verlangt oben ausdrücklich NIE, nicht „vermutlich nicht" — ein
 * Textvergleich wäre eine Vermutung, die Wasserlinie ist ein Beweis. Der
 * Preis dafür ist klar benannt: die GESAMTE vor diesem Release gesendete
 * Post fällt als Lernquelle weg, für immer — auch die, an der die KI
 * nachweislich NICHT beteiligt war. Das ist tragbar: dieser Lauf erzeugt
 * ohnehin nur Vorschläge (fünf je zehn Minuten, siehe STAPEL/TAKT_MS) und
 * bekommt nach vorn unbegrenzt Nachschub — verlorene Vergangenheit kostet
 * hier nur Zeit, ein falscher Vorschlag hätte das Vertrauen in das ganze
 * Gedächtnis gekostet.
 *
 * Läuft LAUT, nicht still: ein Blick ins Log muss zeigen, dass hier ein
 * ganzer Bestand übersprungen wurde, statt zu vermuten, es sei einfach noch
 * nichts gefunden worden.
 */
function sicherstellenWasserstandsstart(): void {
  if (getSetting(WASSERSTAND_SCHLUESSEL) !== null) return;
  const hoechste = db.get<{ id: string }>('SELECT id FROM mail_nachrichten ORDER BY id DESC LIMIT 1')?.id;
  if (!hoechste) return; // Leere Tabelle: nichts zu überspringen -- der normale Weg unten (marke bleibt
  // null, quellen() beginnt bei der ältesten Zeile) ist hier schon richtig,
  // weil es gar keine Altzeile gibt, die es falsch klassifizieren könnte.
  setSetting(WASSERSTAND_SCHLUESSEL, hoechste, 'system');
  console.log(
    `[post-lernen] Erster Lauf nach diesem Release: Wasserstand auf die aktuell höchste `
    + `mail_nachrichten-Kennung gesetzt (${hoechste}). Der GESAMTE Bestand VOR diesem Release wird NICHT `
    + 'als Lernquelle geprüft -- text_ki/ki_art sind auf Altzeilen "unbekannt", nicht "keine KI beteiligt". '
    + 'Gelernt wird ab jetzt nur aus künftig gesendeter Post.',
  );
}

/**
 * Trennt in `quellen()` unten nur noch zwei GRÜNDE, aus denen ein
 * KI-beteiligter Entwurf keine Quelle ist — nicht mehr, OB er einer ist:
 * das ist er nie mehr, unverändert wie bearbeitet (siehe Dateikopf, „NIEMALS:
 * irgendeine Mail, an der die KI mitgeschrieben hat"). 0,15 heißt: rund jedes
 * siebte Wort ist ein anderes. Darunter (`kaumVeraendert`) liegen Tippfehler,
 * ein eingesetzter Name, ein umgestellter Gruß — kaum vom unveränderten
 * Entwurf zu unterscheiden. Darüber (`kiBearbeitet`) hat ein Mensch
 * inhaltlich eingegriffen, aber der Text stammt trotzdem noch großteils von
 * der KI. Für die Rechnung selbst ist der Unterschied ohne Bedeutung — beide
 * enden in `abgehakt`, keiner liefert einen Kandidaten —, für das Protokoll
 * schon: „kaum verändert" und „bearbeitet, aber trotzdem KI-Text" sind zwei
 * verschiedene Beobachtungen.
 */
const MINDEST_VERAENDERUNG = 0.15;

/**
 * Wie lang eine von Hand geschriebene Mail sein muss, damit sie als Quelle
 * taugt. „Passt, danke." enthält nichts Allgemeines.
 */
const MINDEST_ZEICHEN = 200;

/**
 * Ab wann ein ausgehender Text als Wiedergabe eingegangenen Textes gilt.
 *
 * `wortAehnlichkeit` ist dieselbe Messlatte, mit der translation/echo.ts eine
 * unübersetzte Rückgabe erkennt. 0,6 liegt weit über dem, was zwei
 * unabhängige Texte zum selben Thema erreichen (dort sind es typisch 0,2–0,3
 * über gemeinsame Sachwörter), und deutlich unter dem, was eine Weiterleitung
 * oder ein Vollzitat erreicht (nahe 1).
 */
const SPIEGEL_SCHWELLE = 0.6;

/** Wie viele gesendete Mails ein Durchlauf höchstens ansieht. */
const STAPEL = 5;
/** Wie oft nachgesehen wird. Seltener als bei den Briefpartnern: hier ist der
    Stoff seltener (gesendete Post), und Eile hat niemand. */
const TAKT_MS = 10 * 60_000;
/** Was die Antwort des Modells kosten darf — Thema, drei Sätze, ein Satz Grund. */
const ANTWORT_MARKEN = 300;

/* ── Was das Modell zurückgibt ────────────────────────────────── */

interface LernAntwort {
  merken?: unknown;
  art?: unknown;
  thema?: unknown;
  inhalt?: unknown;
  begruendung?: unknown;
}

/** Ein Durchgang durch das Modell — austauschbar, damit der Prüflauf ohne Netz auskommt. */
export type Modellfrage = (system: string, user: string) => Promise<LernAntwort>;

async function echteFrage(system: string, user: string): Promise<LernAntwort> {
  const ai = assistant();
  if (!ai) throw new Error('Die KI ist für diesen Server nicht eingerichtet.');
  return ai.json<LernAntwort>([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { temperature: 0.2, maxTokens: ANTWORT_MARKEN, reasoning: 'low' });
}

/* ── Die Quellen ──────────────────────────────────────────────── */

interface GesendeteZeile {
  id: string; thread_id: string | null; an: string; betreff: string; text: string; fach: string;
  /**
   * 'ki' | 'ki_bearbeitet' | null — von services/post.ts::senden() gesetzt,
   * NIE von dieser Datei. Ersetzt die frühere Textsuche `traegtKennzeichnung()`
   * nach der Kennzeichnung im Fließtext (siehe Dateikopf): die Kennzeichnung
   * ist eine Fußzeile geworden, die `senden()` erst beim tatsächlichen
   * Versand anhängt (services/post-fussnote.ts) — eine Textsuche im
   * gespeicherten `text` fände sie zwar auch noch (die Fußzeile steht ja
   * mit drin), aber nur zufällig richtig: sie wüsste nichts von einer Mail,
   * deren KI-Anteil aus irgendeinem Grund keine Fußzeile bekam. Die Spalte
   * ist der Fakt selbst, keine Ableitung aus Prosa.
   */
  ki_art: string | null;
}

/** Dieselbe Marke, die `weiterleiten()` in services/post.ts selbst setzt. */
function istWeiterleitung(betreff: string): boolean {
  return /^\s*(fwd|fw|wg)[:.]/i.test(betreff.trim());
}

/**
 * Gibt dieser ausgehende Text im Wesentlichen eingegangenen Text wieder?
 *
 * Vergleicht mit jeder eingegangenen Mail desselben Verlaufs. Das ist die
 * dritte und breiteste der drei Sperren gegen Fremdtext (siehe Dateikopf):
 * sie greift unabhängig davon, auf welchem Weg der fremde Text in die
 * ausgehende Mail geraten ist — Weiterleitung, Vollzitat ohne „>", oder ein
 * Kopieren von Hand.
 */
function spiegeltEingang(threadId: string | null, text: string): boolean {
  if (!threadId) return false;
  const eingegangen = db.all<{ text: string }>(
    `SELECT text FROM mail_nachrichten WHERE thread_id = ? AND richtung = 'ein' ORDER BY am DESC LIMIT 10`,
    threadId,
  );
  for (const z of eingegangen) {
    const fremd = entschluesseln(z.text);
    if (!fremd) continue;
    if (wortAehnlichkeit(fremd, text) >= SPIEGEL_SCHWELLE) return true;
  }
  return false;
}

/**
 * Die Fußzeile abschneiden, BEVOR `veraenderung()` unten vergleicht.
 *
 * `mail_entwuerfe.text_ki` ist der reine Entwurfstext OHNE Fußzeile (die
 * entsteht erst bei services/post.ts::senden(), nicht beim Anlegen des
 * Entwurfs — siehe post-sichtung.ts, Abschnitt „Die Kennzeichnung"). Der
 * tatsächlich GESENDETE Text dagegen trägt sie. Ohne diesen Schnitt hier
 * verglichen `veraenderung()` also IMMER „Entwurf ohne Fußzeile" gegen
 * „gesendeter Text MIT Fußzeile" — ein unverändert freigegebener Entwurf
 * sähe dadurch permanent wie „bearbeitet" aus, nur wegen der paar Wörter der
 * Fußzeile selbst. Am ERGEBNIS ändert das nichts (beide Fälle sind ohnehin
 * NIE eine Quelle, siehe Dateikopf) — aber am GRUND, der ins Protokoll geht
 * (`kaumVeraendert` vs. `kiBearbeitet`), und der soll ehrlich bleiben.
 */
function ohneFussnote(text: string): string {
  for (const marke of [KENNZEICHNUNG_DE, KENNZEICHNUNG_EN, KENNZEICHNUNG_BEARBEITET_DE, KENNZEICHNUNG_BEARBEITET_EN]) {
    const suffix = `\n\n${marke}`;
    if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
  }
  return text;
}

/**
 * Ein Kandidat, fertig geprüft — bereit für den Modellaufruf.
 *
 * `vorher` ist inzwischen immer `null`: die einzige verbliebene Quelle ist
 * Post ohne jede KI-Beteiligung (siehe Dateikopf). Das Feld bleibt trotzdem
 * stehen, statt es zu entfernen — `WissenHerkunft` (siehe post-wissen.ts,
 * `@stellium/shared`) kennt weiterhin `art: 'bearbeitet'` für ALTE Einträge,
 * die vor dieser Änderung entstanden sind, und ein schmalerer Typ hier hätte
 * diese Altlast nur in `quellen()` versteckt, nicht beseitigt.
 */
export interface Lernquelle {
  mailId: string;
  fach: string;
  herkunft: WissenHerkunft;
  /** Was die KI geschrieben hatte — immer `null`, siehe oben. */
  vorher: string | null;
  /** Was tatsächlich hinausging. */
  nachher: string;
}

/**
 * Warum eine gesendete Mail NICHT als Quelle taugt — für das Protokoll und
 * für den Prüflauf, der sich auf die einzelnen Gründe berufen können soll.
 *
 * `kaumVeraendert`/`kiBearbeitet`: ein Entwurf mit `text_ki` — die KI war
 * beteiligt, ob nur minimal oder inhaltlich verändert (siehe
 * MINDEST_VERAENDERUNG). `kiText`: keine Entwurfszeile, aber
 * `mail_nachrichten.ki_art` gesetzt — der Weg über „KI schreibt". Beide
 * Gruppen sind seit dieser Fassung gleich streng: NIE eine Quelle.
 */
export type Absage =
  | 'weiterleitung' | 'spiegeltEingang' | 'zuKurz' | 'kaumVeraendert' | 'kiBearbeitet' | 'kiText';

/**
 * Die nächsten gesendeten Mails ansehen und entscheiden, welche als Quelle
 * taugt.
 *
 * Gibt beides zurück: die Kandidaten UND die Kennungen, die abgehakt werden
 * dürfen, ohne dass gefragt werden muss. Der Aufrufer schiebt den
 * Wasserstand nur über das, was er wirklich erledigt hat — dieselbe Vorsicht
 * wie in post-partnergruppen.ts.
 */
export function quellen(anzahl = STAPEL): {
  kandidaten: Lernquelle[]; abgehakt: string[]; absagen: Record<string, Absage>;
} {
  /* Muss VOR dem Lesen von `marke` laufen -- sonst ist genau der erste
     Aufruf auf einer produktiven Datenbank der eine, der noch bei `null`
     ankommt und unten in den unbegrenzten Zweig fällt (siehe Funktionskopf). */
  sicherstellenWasserstandsstart();
  const marke = getSetting(WASSERSTAND_SCHLUESSEL);
  /* Die EINZIGE Abfrage auf `mail_nachrichten` in dieser Datei — und sie
     kennt nur eine Richtung. Siehe Dateikopf. */
  const zeilen = marke
    ? db.all<GesendeteZeile>(
      `SELECT id, thread_id, an, betreff, text, fach, ki_art FROM mail_nachrichten
        WHERE ${NUR_AUSGEHEND} AND id > ? ORDER BY id ASC LIMIT ?`, marke, anzahl)
    : db.all<GesendeteZeile>(
      `SELECT id, thread_id, an, betreff, text, fach, ki_art FROM mail_nachrichten
        WHERE ${NUR_AUSGEHEND} ORDER BY id ASC LIMIT ?`, anzahl);

  const kandidaten: Lernquelle[] = [];
  const abgehakt: string[] = [];
  const absagen: Record<string, Absage> = {};

  for (const z of zeilen) {
    const betreff = entschluesseln(z.betreff);
    const gesendet = ohneZitat(entschluesseln(z.text));

    if (istWeiterleitung(betreff)) {
      abgehakt.push(z.id); absagen[z.id] = 'weiterleitung'; continue;
    }
    if (spiegeltEingang(z.thread_id, gesendet)) {
      abgehakt.push(z.id); absagen[z.id] = 'spiegeltEingang'; continue;
    }

    const entwurf = db.get<{ id: string; text_ki: string | null }>(
      'SELECT id, text_ki FROM mail_entwuerfe WHERE gesendet_id = ? LIMIT 1', z.id,
    );
    const textKi = entwurf?.text_ki ? entschluesseln(entwurf.text_ki) : null;

    if (textKi) {
      /* Die KI hatte etwas geschrieben — ob ein Mensch es unverändert
         freigegeben oder inhaltlich umgeschrieben hat, ändert nichts mehr am
         Ergebnis: NIE eine Quelle (siehe Dateikopf). Nur der Grund fürs
         Protokoll unterscheidet sich noch. */
      const grund: Absage = veraenderung(textKi, ohneFussnote(gesendet)) < MINDEST_VERAENDERUNG
        ? 'kaumVeraendert' : 'kiBearbeitet';
      abgehakt.push(z.id); absagen[z.id] = grund; continue;
    }

    if (gesendet.length < MINDEST_ZEICHEN) {
      abgehakt.push(z.id); absagen[z.id] = 'zuKurz'; continue;
    }
    /* Keine Entwurfszeile, aber `ki_art` steht: das kam über „KI schreibt"
       (post-entwurf-ki.ts) und ist damit KI-Text, kein menschlicher. Auch
       dann heraus, wenn ein Mensch daran gefeilt hat — ohne Entwurfszeile
       lässt sich nicht sagen, wie viel davon von wem stammt, und im Zweifel
       wird nicht gelernt. */
    if (z.ki_art) {
      abgehakt.push(z.id); absagen[z.id] = 'kiText'; continue;
    }

    kandidaten.push({
      mailId: z.id, fach: z.fach, vorher: null, nachher: gesendet,
      herkunft: {
        art: 'gesendet', mailId: z.id, entwurfId: null,
        betreff, an: entschluesseln(z.an), textKi: null, textGesendet: gesendet,
      },
    });
  }

  return { kandidaten, abgehakt, absagen };
}

/* ── Der Lauf ─────────────────────────────────────────────────── */

export interface LernBericht {
  angesehen: number;
  gefragt: number;
  vorschlaege: number;
  /** Warum nichts entstand — für das Protokoll. */
  verworfen: Record<string, number>;
  /** true, wenn wegen voller Warteschlange gar nicht erst gefragt wurde. */
  wartet: boolean;
}

function zaehlen(bericht: LernBericht, grund: string): void {
  bericht.verworfen[grund] = (bericht.verworfen[grund] ?? 0) + 1;
}

/** Ein Posten aus dem Stapel, in der ursprünglichen `id`-Reihenfolge. */
type Stapelposten =
  | { art: 'abgehakt'; id: string }
  | { art: 'kandidat'; quelle: Lernquelle };

/**
 * `kandidaten` und `abgehakt` sind je für sich aufsteigend nach `id`
 * sortiert — beide entstehen aus demselben `ORDER BY id ASC`-Durchlauf in
 * `quellen()`, nur in zwei Töpfe sortiert. Für den Wasserstand zählt aber
 * die GEMEINSAME Reihenfolge: ein `abgehakt`-Posten kann zwischen zwei
 * Kandidaten liegen. Diese Funktion mischt beide Listen wieder zur
 * ursprünglichen Reihenfolge zusammen (klassisches Merge zweier sortierter
 * Folgen, O(n)) — Voraussetzung dafür, dass `lauf()` den Wasserstand erst
 * hinter einem Posten setzt, wenn wirklich jeder Posten davor erledigt ist.
 */
function stapelMischen(kandidaten: Lernquelle[], abgehakt: string[]): Stapelposten[] {
  const ergebnis: Stapelposten[] = [];
  let i = 0;
  let j = 0;
  while (i < kandidaten.length && j < abgehakt.length) {
    if (kandidaten[i].mailId < abgehakt[j]) {
      ergebnis.push({ art: 'kandidat', quelle: kandidaten[i] });
      i += 1;
    } else {
      ergebnis.push({ art: 'abgehakt', id: abgehakt[j] });
      j += 1;
    }
  }
  while (i < kandidaten.length) { ergebnis.push({ art: 'kandidat', quelle: kandidaten[i] }); i += 1; }
  while (j < abgehakt.length) { ergebnis.push({ art: 'abgehakt', id: abgehakt[j] }); j += 1; }
  return ergebnis;
}

/**
 * Ein Durchlauf.
 *
 * `frage` ist austauschbar, damit sich die ganze Kette ohne Modell und ohne
 * Netz prüfen lässt (scripts/e2e-postgedaechtnis.mjs) — dieselbe Absicht wie
 * beim eigens exportierten `vorschlagEintragen()` in post-partnergruppen.ts,
 * nur eine Ebene höher.
 *
 * Der Wasserstand rückt nur über das vor, was WIRKLICH erledigt ist — und
 * zwar in der `id`-Reihenfolge, in der die Mails wirklich liegen, nicht in
 * der Reihenfolge, in der `quellen()` sie in „Kandidat" und „abgehakt"
 * aufgeteilt hat. Frühere Fassung schrieb ALLE `abgehakt`-Kennungen vor dem
 * Kandidaten-Durchlauf, unabhängig davon, ob eine davon eigentlich HINTER
 * einem noch unbearbeiteten Kandidaten lag. Scheiterte der erste
 * Modellaufruf, stand der Wasserstand dann schon hinter Kandidaten, die nie
 * gefragt wurden — genau die Mail, die laut diesem Kommentar eine zweite
 * Gelegenheit bekommen sollte, bekam keine mehr. `stapelMischen()` stellt die
 * echte Reihenfolge wieder her; der Wasserstand rückt erst hinter einen
 * Kandidaten, wenn der Modellaufruf für ihn tatsächlich durch ist. Scheitert
 * ein Modellaufruf, bricht der Durchlauf an dieser Stelle ab und der nächste
 * setzt dort wieder an — mit allen `abgehakt`-Posten UND Kandidaten davor,
 * aber keinem Posten danach.
 */
export async function lauf(frage: Modellfrage = echteFrage): Promise<LernBericht> {
  const bericht: LernBericht = { angesehen: 0, gefragt: 0, vorschlaege: 0, verworfen: {}, wartet: false };

  /* Die Bremse gegen die Zumutung: sind schon genug Karten offen, wird gar
     nicht erst gefragt UND der Wasserstand bleibt stehen. Nichts geht
     verloren, es wartet nur, bis wieder Platz ist. */
  if (offeneAnzahl() >= OFFEN_MAX) {
    bericht.wartet = true;
    return bericht;
  }

  const { kandidaten, abgehakt, absagen } = quellen();
  if (!kandidaten.length && !abgehakt.length) return bericht;

  /* Nur gebraucht, wenn überhaupt gefragt wird — bei einem reinen
     „abgehakt"-Stapel bliebe das sonst verschwendete Arbeit. */
  const system = kandidaten.length ? lernAnweisung(aktiveEintraege().map((e) => e.thema)) : '';

  for (const posten of stapelMischen(kandidaten, abgehakt)) {
    if (posten.art === 'abgehakt') {
      setSetting(WASSERSTAND_SCHLUESSEL, posten.id, 'system');
      bericht.angesehen += 1;
      zaehlen(bericht, absagen[posten.id]);
      continue;
    }

    const quelle = posten.quelle;
    if (offeneAnzahl() >= OFFEN_MAX) { bericht.wartet = true; break; }

    let antwort: LernAntwort;
    try {
      antwort = await frage(system, lernEingabe({
        vorher: quelle.vorher, nachher: quelle.nachher, fach: quelle.fach,
      }));
      bericht.gefragt += 1;
    } catch (err) {
      console.warn('[post-lernen] Modellaufruf fehlgeschlagen, nächster Durchlauf setzt hier an:',
        (err as Error).message);
      break;
    }

    /* Während des Modellaufrufs kann die Mail endgültig gelöscht worden sein
       (post.ts::mailsHartLoeschen()). Ein Vorschlag jetzt trüge in
       `herkunft` eine vollständige Kopie genau des Textes, der eben gelöscht
       wurde — also überspringen, als wäre nichts zu lernen gewesen. */
    if (!db.get('SELECT 1 FROM mail_nachrichten WHERE id = ?', quelle.mailId)) {
      setSetting(WASSERSTAND_SCHLUESSEL, quelle.mailId, 'system');
      bericht.angesehen += 1;
      zaehlen(bericht, 'geloescht');
      continue;
    }

    /* Ein echtes JSON-true, keine Zeichenkette „true": im Zweifel wird nichts
       gemerkt — dieselbe Vorsicht wie bei `antwortNoetig` in post-sichtung.ts. */
    const merken = antwort.merken === true;
    const thema = typeof antwort.thema === 'string' ? antwort.thema.trim() : '';
    const inhalt = typeof antwort.inhalt === 'string' ? antwort.inhalt.trim() : '';
    if (!merken || !thema || !inhalt) {
      setSetting(WASSERSTAND_SCHLUESSEL, quelle.mailId, 'system');
      bericht.angesehen += 1;
      zaehlen(bericht, 'nichtsGefunden');
      continue;
    }

    /* Vor dem Eintragen noch einmal geprüft, obwohl `vorschlagEintragen()`
       es selbst tut: so steht im Protokoll, dass die Beobachtung schon einmal
       vorlag, statt nur „nichts eingetragen". */
    if (schonVorgelegt(thema, inhalt)) {
      setSetting(WASSERSTAND_SCHLUESSEL, quelle.mailId, 'system');
      bericht.angesehen += 1;
      zaehlen(bericht, 'schonVorgelegt');
      continue;
    }

    const art: WissenArt = antwort.art === 'stil' ? 'stil' : 'wissen';
    const ergebnis = vorschlagEintragen({
      art, thema, inhalt,
      begruendung: typeof antwort.begruendung === 'string' ? antwort.begruendung.trim() : null,
      herkunft: quelle.herkunft,
    });
    if (ergebnis.ergebnis === 'eingetragen') bericht.vorschlaege += 1;
    else zaehlen(bericht, ergebnis.ergebnis);

    setSetting(WASSERSTAND_SCHLUESSEL, quelle.mailId, 'system');
    bericht.angesehen += 1;
  }

  return bericht;
}

/* ── Der Hintergrundtakt ──────────────────────────────────────────
   Gleiche Bauart wie startPartnerGruppenJob(): eine Wächtervariable statt
   einer Warteschlange, weil es nur EINEN Aufrufer gibt — den Takt selbst. */
export function startLernJob(): () => void {
  let laeuft = false;
  const takt = setInterval(() => {
    if (laeuft) return;
    laeuft = true;
    void lauf()
      .then((bericht) => {
        if (bericht.vorschlaege) {
          console.log(`[post-lernen] ${bericht.vorschlaege} neue Gedächtnis-Vorschläge `
            + `(${bericht.angesehen} gesendete Mails angesehen, ${bericht.gefragt} Modellaufrufe)`);
        }
      })
      .catch((err) => console.warn('[post-lernen]', (err as Error).message))
      .finally(() => { laeuft = false; });
  }, TAKT_MS);
  return () => clearInterval(takt);
}
