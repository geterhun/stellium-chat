/**
 * Die KI-Sichtung eingehender Firmenpost — die Verdrahtung zwischen
 * `post-ki.ts` (was die KI lesen soll), `ai.ts`/`translation` (wie in diesem
 * Haus ein Modell angesprochen wird) und den Tabellen `mail_sichtung` und
 * `mail_entwuerfe`.
 *
 * DER ABLAUF
 *
 *   1. `sichten(mailId)` läuft, NACHDEM die Mail gespeichert und die
 *      HTTP-Antwort hinaus ist. Deshalb `sichtungAnstossen()` weiter unten:
 *      ein Modellaufruf dauert auf einem Raspberry Pi Sekunden bis Minuten,
 *      und solange stünde der Worker von Cloudflare in der Leitung.
 *   2. Mail laden, Anweisung für ihr Fach holen, Modell fragen.
 *   3. Ergebnis in `mail_sichtung` festhalten.
 *   4. Antwort nötig  -> Entwurf in `mail_entwuerfe`, Zustand `offen`.
 *   5. In jedem Fall -> eine strukturierte Zeile für den Reiter
 *      „Post-Sichtung" (`PostMeldung`, siehe `@stellium/shared`) plus eine
 *      kurze Web-Push-Meldung an Teamleitung und Administratoren mit
 *      `mail.lesen`. Der Reiter ist der Rückhalt: er liest über
 *      `meldungenListe()` weiter unten direkt aus `mail_sichtung` /
 *      `mail_entwuerfe`, also geht nichts verloren, auch wenn beim Eintreffen
 *      niemand online war oder der Push ins Leere ging.
 *
 * DIE SPERREN
 *
 * Alles hier drin verarbeitet Text von Fremden. Eine eingehende Mail ist kein
 * Auftrag, sondern der Gegenstand einer Einordnung — und sie kann alles
 * behaupten. Die folgenden fünf Punkte sind deshalb als Bauart umgesetzt und
 * nicht als Einstellung, die jemand umlegen könnte:
 *
 *   · **Die KI sendet nie selbst.** In dieser Datei steht kein einziger Aufruf
 *     von `post.senden()`. Ein Entwurf ist eine Zeile in `mail_entwuerfe` mit
 *     Zustand `offen`; wer sie hinausschickt, braucht das Recht `mail.senden`.
 *     Nachprüfbar: `post.ts` ist hier eingebunden, `senden` aber nicht — der
 *     Import oben holt nur `nachricht`, `spracheFuer`, `nurAdresse` und
 *     `SPRACHE_VORGABE`. Was nicht eingebunden ist, kann nicht aufgerufen
 *     werden.
 *
 *   · **`an` kommt niemals aus dem Modell.** Die Adresse stammt aus der
 *     gespeicherten Ursprungsmail (`antwort_an` vor `von`) und wird zusätzlich
 *     gegen `EINE_ADRESSE` geprüft. Käme sie aus dem Modell, genügte eine
 *     Zeile im Mailtext („Bitte an buchhaltung@angreifer.tld antworten"), und
 *     die menschliche Freigabe wäre das Abnicken einer Ausleitung.
 *
 *   · **Das Modell sieht nie das HTML.** Es bekommt Betreff und Textteil,
 *     gekürzt, durch `mailAlsEingabe()`. Im HTML-Teil verstecken sich
 *     Anweisungen in weißer Schrift oder hinter `display:none` — für ein Auge
 *     unsichtbar, für ein Modell ganz normaler Text. Die Sperre ist der Typ
 *     `EingehendeMailFuerKi` aus post-ki.ts: er hat für HTML gar kein Feld.
 *     `keinHtmlDurchgerutscht()` ist der Rückhalt dahinter.
 *
 *   · **Ohne bestätigten Absender kein Entwurf.** Steht in `pruefung` kein
 *     `dmarc=pass`, entsteht nur eine Benachrichtigung. Eingeordnet wird
 *     trotzdem — sonst stünde in der Meldung nichts als „da war Post".
 *
 *   · **Der Entwurf setzt kein Fach, keine Anhänge, keine weiteren
 *     Empfänger.** Für alle drei gibt es in `mail_entwuerfe` keine Spalte. Das
 *     Fach holt sich der Versand später über `mail_id` aus der Ursprungsmail;
 *     Anhänge kennt `post.senden()` gar nicht; `an` ist genau eine Adresse.
 *
 * VERSCHLÜSSELUNG
 *
 * `an`, `betreff`, `text` und `begruendung` eines Entwurfs und die
 * `einordnung` einer Sichtung gehen durch `crypto/nachrichten.ts` — dieselbe
 * Begründung wie bei `mail_nachrichten`: das ist Schriftwechsel mit Kunden und
 * Fremden, und wer die Datenbankdatei in die Hand bekommt, soll ihn nicht
 * lesen können. Wer diese Zeilen liest, nimmt dafür die Lesefunktionen weiter
 * unten (`entwurfLesen`, `offeneEntwuerfe`, `sichtungFuer`) und liest nicht
 * selbst aus der Tabelle.
 */
import { languageInfo, type PostMeldung, type PostMeldungAbweichung, type MeldungGrundCode } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { verschluesseln, entschluesseln } from '../crypto/nachrichten.js';
import { assistant as kiAnbieter } from '../translation/index.js';
import { fensterFuer, fensterVerkleinern, markenSchaetzung, verlaufsBudget } from '../translation/fenster.js';
import { nachricht, spracheFuer, nurAdresse, SPRACHE_VORGABE, type Nachricht } from './post.js';
import {
  anweisungFuerFach, mailAlsEingabe,
  type Absenderart, type Dringlichkeit, type EingehendeMailFuerKi,
} from './post-ki.js';
import { wissenFuerMail } from './post-wissen.js';
import { luecken } from './post-wissen-ki.js';
import { may } from './users.js';

/* ── Stellschrauben ───────────────────────────────────────────── */

/**
 * Was die Antwort des Modells kosten darf.
 *
 * Großzügiger als bei den Vorschlägen (dort 8 Titel), denn hier steht ein
 * ganzer Brief drin — Anrede, Text und Unterschrift. Die Kennzeichnung
 * gehört seit Kurzem NICHT mehr dazu — sie entsteht erst beim Senden als
 * Fußzeile (services/post.ts, services/post-fussnote.ts), nicht mehr hier.
 */
const ANTWORT_MARKEN = 900;

/**
 * Wie viel Mailtext dem Modell höchstens gezeigt wird.
 *
 * Dieselbe Zahl, die `mailAlsEingabe()` ohnehin zieht. Sie steht hier noch
 * einmal, weil bei einem zu kleinen Fenster halbiert wird — und gekürzt wird
 * dann der TEXT, bevor `mailAlsEingabe()` ihn einrahmt. Andersherum (erst
 * einrahmen, dann die Zeichenkette kürzen) fiele die schließende Marke weg,
 * und genau die trennt Anweisung von Mail.
 */
const TEXT_START = 6000;
/** Kürzer als das lohnt nicht — darunter gilt die Anweisung als zu groß. */
const TEXT_MINDEST = 500;

/** Wie lang die Felder werden dürfen, die aus dem Modell kommen. */
const ANLIEGEN_MAX = 300;
const BEGRUENDUNG_MAX = 600;
const ENTWURF_MAX = 8000;
const BETREFF_MAX = 300;

/**
 * Wann ein hängengebliebener oder fehlgeschlagener Lauf noch einmal darf.
 *
 * Ein Absturz mitten im Modellaufruf ließe die Zeile sonst für immer auf
 * `laeuft` stehen, und die Mail wäre nie gesichtet — ohne dass es jemand
 * merkt. Nach dieser Frist ist ein zweiter Anlauf erlaubt.
 */
const WIEDERHOLUNG_AB_MS = 15 * 60_000;

/**
 * Wie lange ein Versand-Anspruch gilt, bevor ihn ein neuer Anlauf übernehmen
 * darf.
 *
 * Derselbe Gedanke wie bei `WIEDERHOLUNG_AB_MS` direkt darüber, nur eine
 * Stufe schärfer: Stirbt der Server zwischen dem Anspruch und dem Abschluss,
 * stünde der Entwurf sonst für immer auf `sendet` und ließe sich nie wieder
 * freigeben — ein Kunde bekäme nie eine Antwort, und niemand sähe warum. Der
 * Versandaufruf selbst hat eine Frist von zwanzig Sekunden; fünf Minuten sind
 * also weit jenseits von allem, was ein laufender Versand braucht, und kurz
 * genug, dass ein Mensch es im selben Arbeitsgang noch einmal versuchen kann.
 *
 * Der gewöhnliche Fehlschlag wartet diese Frist gar nicht ab: die Route gibt
 * den Anspruch sofort zurück (`entwurfAnspruchLoesen()` weiter unten). Diese
 * Frist ist nur für den Fall, dass niemand mehr da ist, der ihn zurückgeben
 * könnte.
 */
const VERSAND_ANSPRUCH_MS = 5 * 60_000;

/* ── Zustände ─────────────────────────────────────────────────── */

/**
 * Der Zustand einer Sichtung.
 *
 * `gemeldet`, `entwurf`, `gesendet` und `abgelehnt` stehen so im Schema
 * (db/schema.sql). Dazu zwei, die der Ablauf braucht:
 *   `laeuft` — beansprucht, das Modell antwortet noch. Verhindert, dass zwei
 *              Aufrufe für dieselbe Mail zwei Entwürfe erzeugen.
 *   `fehler` — das Modell hat nicht geantwortet. Die Mail ist NICHT verloren:
 *              Menschen wurden benachrichtigt, und `nachzusichten()` findet
 *              die Zeile für einen zweiten Anlauf.
 */
export type Sichtungszustand =
  'laeuft' | 'gemeldet' | 'entwurf' | 'gesendet' | 'abgelehnt' | 'fehler';

export interface Einordnung {
  absenderart: Absenderart;
  anliegen: string;
  dringlichkeit: Dringlichkeit;
  antwortNoetig: boolean;
  begruendung: string;
  /** In welcher Sprache geantwortet würde. */
  sprache: string;
  /** Welches Modell geurteilt hat — für die Frage „warum war das damals so?". */
  modell: string | null;
}

export interface SichtungBericht {
  mailId: string;
  zustand: Sichtungszustand;
  /** Die Kennung des Entwurfs, wenn einer entstanden ist. */
  entwurfId: string | null;
  /** An wie viele Menschen die Meldung ging. */
  benachrichtigt: number;
  /**
   * Warum kein Entwurf entstand — null, wenn einer entstand. Deutscher
   * Rückfalltext für Aufrufer ohne Wörterbuch-Kontext (Protokollzeile,
   * ältere Clients); `grundCode` ist die zu übersetzende Kennung dazu —
   * dieselbe Bauart wie bei `PostFehler`/`fehler()` in routes.ts, und
   * dieselben Kennungen wie bei `PostMeldung.grundCode` (siehe
   * `grundCodeFuer()` oben): wer das hier einmal anzeigt, kann dieselbe
   * `postSichtung.grund.*`-Übersetzung wiederverwenden, die PostMeldungen.tsx
   * für `grundCode` schon kennt.
   */
  grund: string | null;
  grundCode: MeldungGrundCode | null;
}

export interface PostEntwurf {
  id: string;
  mailId: string;
  threadId: string;
  /** Immer genau eine Adresse, immer aus der Ursprungsmail. */
  an: string;
  /**
   * Das Fach der URSPRUNGSMAIL — bestimmt beim Freigeben die Absenderadresse
   * (siehe services/post.ts, `senden()`, `Ausgang.fach`), vorbelegt, aber
   * beim Freigeben änderbar (siehe `/api/post/entwuerfe/:id/senden` in
   * routes.ts). `null` nur, wenn die Ursprungsmail zum Zeitpunkt des Lesens
   * nicht mehr geladen wird — siehe `entwurfAuspacken()` weiter unten, aus
   * demselben Grund wie bei `abweichung`.
   */
  fach: string | null;
  betreff: string;
  text: string;
  begruendung: string | null;
  zustand: string;
  erstelltAm: number;
  entschiedenAm: number | null;
  entschiedenVon: string | null;
  gesendetId: string | null;
  /**
   * Strukturiert wie `PostMeldung.abweichung` — derselbe Warnsatz, nur als
   * Werte statt Fließtext (siehe `abweichungAdressen()` weiter unten). Nur
   * gesetzt, solange der Entwurf offen ist: einmal entschieden, ist der
   * Hinweis Geschichte statt Handlungsaufforderung, genau wie bei
   * `bauMeldung()` oben.
   */
  abweichung: PostMeldungAbweichung | null;
  /**
   * Der Wortlaut, wie die KI ihn geschrieben hat — nie überschrieben (siehe
   * schema.sql, `mail_entwuerfe.text_ki`). Für `/api/post/entwuerfe/:id/senden`
   * in routes.ts: die Route reicht diesen Wortlaut unverändert als
   * `Ausgang.textKi` an `post.senden()` weiter, das daraus beim Versand die
   * passende Fußzeile berechnet (services/post-fussnote.ts) — dieselbe Zeile
   * entscheidet damit sowohl über die Fußzeile als auch, im Nachhinein, über
   * das Lernsignal in services/post-lernen.ts.
   */
  textKi: string | null;
}

/* ── Wer benachrichtigt wird ──────────────────────────────────── */

/**
 * Teamleitung und Administratoren — aber nur die, die Post lesen dürfen.
 *
 * Zwei Bedingungen und nicht eine, weil beide etwas anderes bedeuten. Die
 * Rolle sagt, WER gemeint ist (die Führung, nicht die Technik — Behördenpost
 * und Abo-Anfragen landen bei ihr). Das Recht `mail.lesen` sagt, wer den
 * Inhalt sehen DARF, und es lässt sich einzelnen Konten nehmen. In der
 * Meldung stehen Absender und Betreff einer echten Kundenmail; wem das Recht
 * genommen wurde, bekommt sie nicht auf dem Umweg über eine Meldung.
 *
 * Gesperrte Konten fallen heraus: eine Meldung in einem Postfach, das niemand
 * mehr öffnet, ist keine Meldung.
 */
function empfaengerkreis(): string[] {
  const kandidaten = db.all<{ id: string }>(
    `SELECT id FROM users
      WHERE role IN ('owner', 'admin', 'teamlead')
        AND disabled = 0
      ORDER BY role, created_at`,
  );
  return kandidaten.map((k) => k.id).filter((id) => may(id, 'mail.lesen'));
}

/* ── Zustellung ───────────────────────────────────────────────── */

type Melder = (userId: string, meldung: PostMeldung) => void;
let melder: Melder | null = null;

/**
 * Wie eine frische Meldung noch im selben Moment ihre Web-Push-Benachrichtigung
 * auslöst.
 *
 * Dieselbe Machart wie `vorschlaege.zustellerSetzen()`: der Dienst kennt das
 * Gateway nicht und soll es nicht kennen — sonst ließe er sich in einem
 * Prüflauf nicht ohne WebSocket starten. Das Gateway meldet sich beim Start
 * einmal hier an und baut daraus die Push-Meldung (siehe dort,
 * `postMeldungPushMelden`).
 *
 * Meldet sich niemand an, geht nichts verloren: die Zeile steht in
 * `mail_sichtung` (und bei einem Entwurf zusätzlich in `mail_entwuerfe`) und
 * damit im Reiter „Post-Sichtung", sobald ihn wieder jemand öffnet —
 * `meldungenListe()` weiter unten liest von dort, nicht aus einem
 * Zwischenspeicher, der einen fehlenden Gateway-Start überleben müsste.
 */
export function melderSetzen(fn: Melder | null): void { melder = fn; }

/**
 * Die Meldung zustellen — an jede Person des Kreises einzeln.
 *
 * Bis Fassung 1.0.30 stand hier eine Direktnachricht des Assistenten im Chat:
 * sieben Zeilen Fließtext mit einer technischen Kennung am Ende, zwischen
 * echten Gesprächen. Der Reiter „Post-Sichtung" ist jetzt der Rückhalt (siehe
 * `melderSetzen` oben) — eine zusätzliche Kopie im Chat hätte denselben Stand
 * an zwei Stellen gehalten, die mit der Zeit auseinanderliefen: der Zustand
 * einer Sichtung ändert sich (`entwurf` -> `gesendet`/`abgelehnt`), eine schon
 * verschickte Chatnachricht nie mit. Was bleibt, ist die kurze Web-Push-
 * Meldung — für den Moment gedacht, in dem gerade niemand hinschaut.
 *
 * Gibt zurück, wie viele Menschen sie wirklich bekommen haben.
 */
function benachrichtigen(meldung: PostMeldung): number {
  const kreis = empfaengerkreis();
  if (!kreis.length) {
    /* Kein Wurf: die Mail liegt im Postfach, sie ist nicht weg. Aber es soll
       im Protokoll stehen, dass niemand sie zu sehen bekommt. */
    console.warn('[post-sichtung] Niemand mit Rolle Leitung/Administration und Recht mail.lesen — die Meldung geht ins Leere.');
    return 0;
  }

  let zugestellt = 0;
  for (const userId of kreis) {
    try {
      melder?.(userId, meldung);
      zugestellt += 1;
    } catch (err) {
      /* Eine Person, deren Zustellung klemmt (etwa ein totes Push-Abonnement),
         darf die anderen nicht mitnehmen. */
      console.error('[post-sichtung] Meldung an', userId, 'fehlgeschlagen:', (err as Error).message);
    }
  }
  return zugestellt;
}

/* ── Die PostMeldung bauen ────────────────────────────────────── */

/**
 * Wortlaut aus einer fremden Mail für die Anzeige entschärfen.
 *
 * Zeilenumbrüche heraus, damit ein Absender in einem einzeiligen Feld (Fach,
 * Von, Betreff) nicht selbst welche einschmuggelt. Unsichtbare Zeichen heraus,
 * aus demselben Grund wie in post-ki.ts. Und eine Länge, die auf einen Schirm
 * passt. Galt schon für die frühere Chatnachricht und gilt unverändert für
 * jedes Feld einer `PostMeldung` — strukturierte Felder statt Fließtext
 * nehmen einem Absender zwar die Möglichkeit, eine ganze Zeile der Meldung
 * vorzutäuschen, aber nicht die, ein einzelnes Feld zu verunstalten.
 */
function fuerMeldung(wert: string, max: number): string {
  const sauber = wert
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sauber.length > max ? `${sauber.slice(0, max)}…` : (sauber || '—');
}

/**
 * Warum (noch) kein Entwurf entstand, oder dass einer bereitliegt oder schon
 * entschieden ist — als Kennung für `PostMeldung.grundCode`. Die Übersetzung
 * dazu steht im Wörterbuch der Oberfläche (`postSichtung.grund.*`), nicht
 * hier: diese Datei läuft auf dem Server, ohne Wörterbuch-Kontext. Dieselbe
 * Bauart wie bei `PostFehler`/`fehler()` in routes.ts.
 *
 * Für `zustand === 'gemeldet'` fällt hier derselbe Dreiweg-Entscheid wie in
 * `sichten()` weiter unten noch einmal — nicht aus Bequemlichkeit doppelt,
 * sondern weil `meldungenListe()` eine Zeile Tage später aus der Datenbank
 * liest, ohne dass der Grund von damals irgendwo mitgespeichert wäre. Er
 * lässt sich verlustfrei zurückgewinnen, weil `einordnung`, DMARC-Stand und
 * `an` selbst gespeichert bleiben und derselbe Vorrang gilt.
 */
function grundCodeFuer(
  zustand: Sichtungszustand, einordnung: Einordnung | null, dmarcOk: boolean, an: string | null,
): MeldungGrundCode | null {
  switch (zustand) {
    case 'entwurf': return 'entwurfWartet';
    case 'gesendet': return 'entwurfGesendet';
    case 'abgelehnt': return 'entwurfAbgelehnt';
    case 'fehler': return 'modellFehler';
    case 'laeuft': return null;
    case 'gemeldet':
      if (!einordnung?.antwortNoetig) return 'keinAntwortNoetig';
      if (!dmarcOk) return 'keinDmarc';
      if (!an) return 'keineAdresse';
      // Unerreichbar: 'gemeldet' entsteht in sichten() nur, wenn einer der
      // drei Gründe oben zutraf. Der Zweig ist für TypeScript da (jeder Pfad
      // muss etwas zurückgeben), nicht weil er je liefe.
      return 'keinAntwortNoetig';
  }
}

/**
 * Eine `PostMeldung` bauen — für den Reiter „Post-Sichtung" und für die
 * Web-Push-Benachrichtigung im selben Moment (siehe `benachrichtigen` oben).
 *
 * `an` und `dmarcOk` sind nur für die Feinunterscheidung innerhalb von
 * `zustand === 'gemeldet'` nötig (siehe `grundCodeFuer`) und für den
 * Warnsatz bei abweichender Reply-To-Domäne — deshalb optional: Die drei
 * Aufrufer in `sichten()` unten haben beides ohnehin schon in der Hand,
 * `meldungenListe()` beschafft es sich nur dort, wo es wirklich gebraucht
 * wird (siehe dort).
 */
function bauMeldung(input: {
  mail: Nachricht; zustand: Sichtungszustand; einordnung: Einordnung | null;
  gesichtetAm: number; an?: string | null; dmarcOk?: boolean;
}): PostMeldung {
  const { mail, zustand, einordnung, gesichtetAm, an = null, dmarcOk = false } = input;
  return {
    mailId: mail.id,
    fach: fuerMeldung(mail.fach, 60),
    von: fuerMeldung(mail.von, 200),
    betreff: fuerMeldung(mail.betreff, 200),
    gesichtetAm,
    zustand,
    einordnung,
    grundCode: grundCodeFuer(zustand, einordnung, dmarcOk, an),
    // Nur solange ein Entwurf offen ist: einmal entschieden, ist der Hinweis
    // Geschichte statt Handlungsaufforderung — siehe abweichungAdressen() weiter unten.
    abweichung: (zustand === 'entwurf' && an) ? abweichungAdressen(mail, an) : null,
  };
}

/* ── Die Mail, wie sie gespeichert liegt ──────────────────────── */

interface Zusatz {
  /** `Reply-To`, entschlüsselt — oder null. */
  antwortAn: string | null;
  /** Was Cloudflare zu SPF/DKIM/DMARC gemeldet hat, im Klartext. */
  pruefung: string | null;
}

/**
 * Zwei Spalten, die `post.nachricht()` bewusst nicht herausgibt.
 *
 * `Nachricht` ist die Sicht für die Oberfläche; `antwort_an` und `pruefung`
 * gehören zur Entscheidung darüber, ob überhaupt geantwortet werden darf.
 * Sie hier einzeln zu holen ist ehrlicher, als `Nachricht` (und damit jeden
 * Aufrufer von `post.nachricht()`) um zwei Felder zu erweitern, die nur diese
 * Datei braucht.
 */
function zusatzLesen(mailId: string): Zusatz {
  const z = db.get<{ antwort_an: string | null; pruefung: string | null }>(
    'SELECT antwort_an, pruefung FROM mail_nachrichten WHERE id = ?', mailId,
  );
  return {
    antwortAn: z?.antwort_an ? entschluesseln(z.antwort_an) || null : null,
    pruefung: z?.pruefung ?? null,
  };
}

/**
 * Hat Cloudflare den Absender bestätigt?
 *
 * Wortgleich mit `istBestaetigt()` in post.ts — dort ist sie nicht exportiert.
 * Dieselbe Prüfung an zwei
 * Stellen ist hier vertretbar, weil beide dasselbe Feld gegen dieselbe feste
 * Zeichenfolge prüfen; wer sie ändert, ändert sie an beiden.
 *
 * Für den Eingang ist das ein Signal (Post zu verlieren wäre schlimmer). Für
 * den ENTWURF ist es eine Sperre: ein Brief, der im Namen des Unternehmens
 * hinausgeht, antwortet nicht auf etwas Ungeprüftes.
 */
function absenderBestaetigt(pruefung: string | null): boolean {
  return typeof pruefung === 'string' && /dmarc=pass/i.test(pruefung);
}

/**
 * Genau eine Mailadresse — kein Komma, kein Semikolon, keine spitzen Klammern,
 * kein Leerzeichen.
 *
 * `nurAdresse()` in post.ts holt die Adresse aus „Name <a@b.de>" heraus, prüft
 * aber nicht, ob am Ende EINE übrig bleibt: „a@b.de, c@d.tld" käme unverändert
 * durch und stünde später als `to` beim Versanddienst — der macht daraus
 * bereitwillig zwei Empfänger. Genau das ist der „keine zusätzlichen
 * Empfänger"-Fall, und deshalb steht die Prüfung hier und nicht in der Route.
 */
const EINE_ADRESSE = /^[^\s@,;:<>"'()[\]\\]+@[^\s@,;:<>"'()[\]\\]+\.[^\s@,;:<>"'()[\]\\]{2,}$/;

/**
 * An wen die Antwort ginge — aus der gespeicherten Mail, nie aus dem Modell.
 *
 * `antwortAn` vor `von`, wie vorgegeben: wer ein `Reply-To` setzt, will dort
 * die Antwort haben. Beides sind Kopfzeilen, die der Absender schreibt —
 * deshalb entsteht ein Entwurf ohnehin nur bei bestätigtem Absender, und eine
 * Abweichung zwischen beiden wird dem freigebenden Menschen gezeigt (siehe
 * `abweichungsHinweis`).
 */
function antwortAdresse(mail: Nachricht, zusatz: Zusatz): string | null {
  const roh = zusatz.antwortAn || mail.von;
  if (!roh) return null;
  const adresse = nurAdresse(roh);
  return EINE_ADRESSE.test(adresse) ? adresse : null;
}

/**
 * Weicht die Antwortadresse vom sichtbaren Absender ab? Reine Werte, kein
 * Satz — `abweichungsHinweis()` baut daraus den deutschen Text für die
 * verschlüsselte `begruendung` eines Entwurfs, `bauMeldung()` weiter oben
 * dieselben zwei Werte für `PostMeldung.abweichung` (die Übersetzung dazu
 * steht im Wörterbuch der Oberfläche, `postSichtung.abweichung`, mit `an`
 * und `von` als Platzhalter — der Server legt hier keinen Anzeigetext mehr
 * fest, siehe `grundCodeFuer` weiter oben für dieselbe Bauart).
 *
 * DMARC bestätigt die Domain im `From:`, nicht die im `Reply-To:`. Zeigen die
 * beiden auf verschiedene Domains, ist das genau der Umleitungsversuch, nur
 * eine Kopfzeile höher als im Mailtext. Verhindern lässt er sich hier nicht —
 * die Vorgabe lautet `antwortAn` vor `von`, und meistens ist er harmlos. Was
 * sich verhindern lässt, ist die stille Freigabe: der Hinweis steht in der
 * Begründung des Entwurfs UND im Reiter „Post-Sichtung", also an beiden
 * Stellen, an denen der freigebende Mensch hinsieht. Dieselbe Haltung wie
 * beim Umschlagabsender in db/schema.sql.
 */
function abweichungAdressen(mail: Nachricht, an: string): PostMeldungAbweichung | null {
  const vonDomaene = nurAdresse(mail.von).split('@')[1];
  const anDomaene = an.split('@')[1];
  if (!vonDomaene || !anDomaene || vonDomaene === anDomaene) return null;
  return { an, von: nurAdresse(mail.von) };
}

/** Derselbe Vergleich wie `abweichungAdressen()`, als fertiger deutscher Satz
    für `mail_entwuerfe.begruendung` (verschlüsselt, kein Wörterbuch-Text). */
function abweichungsHinweis(mail: Nachricht, an: string): string | null {
  const adressen = abweichungAdressen(mail, an);
  if (!adressen) return null;
  return `Achtung: Die Antwort ginge an ${adressen.an}, geschrieben hat aber ${adressen.von}. `
    + 'Die Mail hat eine abweichende Antwortadresse gesetzt — bitte vor der Freigabe prüfen.';
}

/* ── Was das Modell zu sehen bekommt ──────────────────────────── */

/**
 * Betreff und Textteil, sonst nichts.
 *
 * Die eigentliche Sperre gegen das HTML ist der Rückgabetyp: `EingehendeMail-
 * FuerKi` aus post-ki.ts hat für HTML kein Feld, also gibt es keine Stelle,
 * an der es versehentlich mitginge. Diese Funktion ist der einzige Weg von
 * einer gespeicherten `Nachricht` zu dieser Eingabe.
 */
function nurWasDasModellSehenDarf(mail: Nachricht, textGrenze: number): EingehendeMailFuerKi {
  const text = mail.text.trim();
  return {
    von: mail.von,
    betreff: mail.betreff,
    /* Eine Mail ganz ohne Textteil gibt es — dann liegt alles im HTML. Statt
       dem Modell ein leeres Feld zu geben (und es raten zu lassen), steht dort
       ausdrücklich, dass nichts vorliegt. Das HTML wird auch dann nicht
       ausgewertet: was ein Mensch nicht sieht, soll auch das Modell nicht
       lesen. */
    text: text
      ? (text.length > textGrenze ? `${text.slice(0, textGrenze)}\n[… gekürzt]` : text)
      : '[Diese Mail hat keinen Textteil. Der HTML-Teil wird nicht ausgewertet.]',
    /* Nur die Namen. Der Inhalt eines Anhangs geht nie an ein Modell — er
       liegt dafür gar nicht erst in der Datenbank. */
    anhaenge: mail.anhaenge.slice(0, 25).map((a) => ({ name: a.name })),
  };
}

/**
 * Rückhalt, kein Ersatz: ist doch HTML in der Eingabe gelandet?
 *
 * Die Sperre darüber ist der Typ; diese Prüfung fängt den Fall, dass jemand
 * sie eines Tages umbaut. Sie vergleicht gegen den Anfang des gespeicherten
 * HTML — trifft also den plumpen Durchstich, nicht jede denkbare Umformung.
 * Genau wie der Chiffrat-Rückhalt in ai.ts::zeile(): billig, und der eine
 * Fehler, den es nicht geben darf, bliebe sonst unsichtbar.
 */
function keinHtmlDurchgerutscht(eingabe: string, html: string | null): boolean {
  if (!html) return true;
  const probe = html.trim().slice(0, 120);
  return probe.length < 40 || !eingabe.includes(probe);
}

/* ── Das Modell fragen ────────────────────────────────────────── */

/** Was vom Modell zurückkommt, bevor irgendetwas davon geglaubt wird. */
interface RohAntwort {
  absenderart?: unknown;
  anliegen?: unknown;
  dringlichkeit?: unknown;
  antwortNoetig?: unknown;
  begruendung?: unknown;
  entwurf?: unknown;
}

const ABSENDERARTEN: readonly Absenderart[] = ['privatperson', 'firma', 'behörde', 'automat'];
const DRINGLICHKEITEN: readonly Dringlichkeit[] = ['niedrig', 'normal', 'hoch'];

/** Ein Feld aus der Antwort des Modells — nur als Zeichenkette, nur gekappt. */
function feld(wert: unknown, max: number): string {
  return typeof wert === 'string' ? wert.trim().slice(0, max) : '';
}

function absenderartDeuten(wert: unknown): Absenderart {
  const w = typeof wert === 'string' ? wert.trim().toLowerCase() : '';
  /* „behoerde" und „behorde" kommen von Modellen, die keine Umlaute
     ausgeben — das ist offensichtlich gemeint und kein Grund zu raten. */
  const vereinheitlicht = w === 'behoerde' || w === 'behorde' ? 'behörde' : w;
  return (ABSENDERARTEN as readonly string[]).includes(vereinheitlicht)
    ? vereinheitlicht as Absenderart
    : 'firma';
}

function dringlichkeitDeuten(wert: unknown): Dringlichkeit {
  const w = typeof wert === 'string' ? wert.trim().toLowerCase() : '';
  return (DRINGLICHKEITEN as readonly string[]).includes(w) ? w as Dringlichkeit : 'normal';
}

/**
 * Die Anweisung für dieses Fach, plus die Sprache, plus das Firmenwissen.
 *
 * Die Fachanweisungen stehen fertig in post-ki.ts und werden hier nicht
 * nachgebaut. Angehängt wird genau eine Zeile: die GRUNDANWEISUNG sagt „in der
 * Sprache der Mail", maßgeblich ist aber die Sprache, die am Briefpartner
 * gelernt wurde (post.ts::spracheFuer). Wer sonst immer auf Deutsch schreibt
 * und einmal einen englischen Satz schickt, bekommt weiter Deutsch.
 *
 * Danach kommt der Wissensblock (services/post-wissen.ts) — das, was ein
 * Mensch für dieses Haus freigegeben hat, ausgewählt nach dieser einen Mail
 * und begrenzt auf das, was ins Fenster passt. Er trägt immer mindestens die
 * Regel gegen erfundene Auskünfte, auch wenn gar nichts gespeichert ist:
 * lieber ein sichtbares „[unbekannt: …]" im Entwurf als eine plausibel
 * klingende, falsche Produktauskunft an einen Kunden.
 *
 * `fenster` fließt ein, weil der Block danach bemessen wird — schrumpft das
 * gemerkte Fenster (translation/fenster.ts), schrumpft der Block mit, statt
 * die Anweisung platzen zu lassen.
 */
function anweisungMitSprache(mail: Nachricht, sprache: string, fenster: number): {
  text: string; themen: string[];
} {
  const s = languageInfo(sprache);
  const wissen = wissenFuerMail({
    fach: mail.fach, betreff: mail.betreff, text: mail.text, fenster,
  });
  return {
    text: `${anweisungFuerFach(mail.fach)}\n`
      + `Die Antwort in \`entwurf\` schreibst du auf ${s.name} (${s.native}) — `
      + 'das ist die Sprache dieses Briefpartners, unabhängig davon, in welcher Sprache diese eine Mail verfasst ist.\n'
      + wissen.block,
    /* Wandert bis in die Begründung des Entwurfs durch (siehe
       `wissensHinweis()` weiter unten). Gemessen: dieses Modell markiert eine
       Wissenslücke NICHT zuverlässig, auch wenn die Anweisung es verlangt
       (scripts/postantwort-messen.mjs, Prüfpunkt `luecke`). Was sich dagegen
       zuverlässig sagen lässt, ist, worauf die Antwort tatsächlich beruht —
       das rechnet dieser Server selbst aus und muss es dem Modell nicht
       glauben. */
    themen: wissen.themen,
  };
}

/**
 * Ein Durchgang durch das Modell.
 *
 * Derselbe Aufbau wie `ai.ts::vorschlaegeAusVerlauf()`: Anweisung als
 * "system", Daten als "user", `ai.json<T>` für die Antwort, und eine Absage
 * wegen Länge halbiert das gemerkte Fenster statt als Fehler durchzugehen
 * (translation/fenster.ts). Passt die Mail auch dann nicht, wird der MAILTEXT
 * kürzer — nicht die fertige Eingabe, sonst fiele die schließende Marke weg.
 */
async function modellFragen(mail: Nachricht, sprache: string): Promise<{
  roh: RohAntwort; modell: string | null; themen: string[];
}> {
  const ai = kiAnbieter();
  if (!ai) throw new Error('Die KI ist für diesen Server nicht eingerichtet.');

  let fenster = fensterFuer(ai.kennung, ai.kontextfenster());
  let grenze = TEXT_START;

  for (;;) {
    /* Im Schleifenrumpf und nicht davor: der Wissensblock wird nach dem
       Fenster bemessen, und `fenster` schrumpft weiter unten, wenn das Modell
       wegen Länge absagt. Neu gebaut kostet er nichts (ein Datenbankblick,
       kein Modellaufruf) — vorher gebaut wäre er nach dem ersten Schrumpfen
       zu groß und der zweite Anlauf scheiterte an derselben Länge. */
    const { text: anweisung, themen } = anweisungMitSprache(mail, sprache, fenster);
    const eingabe = mailAlsEingabe(nurWasDasModellSehenDarf(mail, grenze));
    if (!keinHtmlDurchgerutscht(eingabe, mail.html)) {
      throw new Error('Der HTML-Teil wäre in die Eingabe geraten — abgebrochen.');
    }

    const budget = verlaufsBudget({ fenster, fest: anweisung, antwort: ANTWORT_MARKEN });
    if (budget > 0 && markenSchaetzung(eingabe) <= budget) {
      try {
        const roh = await ai.json<RohAntwort>([
          { role: 'system', content: anweisung },
          { role: 'user', content: eingabe },
        ], { temperature: 0.2, maxTokens: ANTWORT_MARKEN, reasoning: 'low' });
        return { roh, modell: ai.letzterVerbrauch()?.modell ?? ai.kennung, themen };
      } catch (err) {
        /* Nur die Absage wegen Länge wird kleiner versucht. Ein Netzfehler
           bleibt ein Netzfehler — den kleiner zu wiederholen hilft niemandem. */
        if ((err as { art?: string }).art !== 'zuLang') throw err;
        const kleiner = fensterVerkleinern(ai.kennung, fenster);
        if (!kleiner) throw err;
        fenster = kleiner;
        continue;
      }
    }

    if (grenze <= TEXT_MINDEST) {
      throw new Error(
        `Das Kontextfenster des Modells (${fenster} Marken) reicht für die Fachanweisung nicht aus.`,
      );
    }
    grenze = Math.max(TEXT_MINDEST, Math.floor(grenze / 2));
  }
}

/* ── Die Kennzeichnung ─────────────────────────────────────────────
   Bis hierher stand an dieser Stelle `kennzeichnungSichern()`: die
   GRUNDANWEISUNG verlangte vom Modell einen Absatz „Hinweis: … von
   StelliumAI erstellt" im Entwurf selbst, und diese Funktion trug ihn
   nach, wenn das Modell ihn wegließ. Der Auftraggeber wollte diesen Absatz
   nicht mehr MITTEN im Entwurfstext — dort, wo ein Mensch beim Freigeben
   liest und bearbeitet — sondern als kleingedruckte Fußzeile ganz unten in
   der tatsächlich versendeten Mail. Die KI schreibt die Kennzeichnung
   deshalb gar nicht mehr (siehe post-ki.ts, GRUNDANWEISUNG); `entwurfAnlegen()`
   unten speichert `text`/`text_ki` jetzt unverändert, wie das Modell sie
   geliefert hat. Die Fußzeile selbst entsteht erst beim tatsächlichen
   Versand, aus genau diesem `text_ki` im Vergleich zum dann gesendeten Text
   — siehe services/post.ts::senden() und services/post-fussnote.ts. */

/**
 * Die Lücken eines Entwurfs als deutscher Satz für `mail_entwuerfe.begruendung`
 * — oder null, wenn keine da sind.
 *
 * Fester deutscher Text wie `abweichungsHinweis()` gleich oben und aus
 * demselben Grund: das Feld ist verschlüsselter Fließtext für die Freigabe,
 * kein Wörterbuchschlüssel (der Server hat hier keinen Wörterbuch-Kontext).
 */
function lueckenHinweis(entwurf: string): string | null {
  const offen = luecken(entwurf);
  if (!offen.length) return null;
  return `Die KI hat ${offen.length === 1 ? 'eine Lücke' : `${offen.length} Lücken`} gelassen, `
    + `weil ihr das Firmenwissen dazu fehlt: ${offen.join('; ')}. `
    + 'Bitte vor dem Senden ausfüllen.';
}

/**
 * Worauf der Entwurf beruht — als Satz für die Begründung.
 *
 * DER WICHTIGERE DER BEIDEN HINWEISE, und zwar aus einem gemessenen Grund:
 * `lueckenHinweis()` oben hängt daran, dass das Modell seine Wissenslücke
 * selbst zugibt, und genau das tut dieses Modell nicht zuverlässig — es
 * schrieb im Messlauf lieber „Wir unterstützen die Anbindung an SAP", als
 * eine Lücke zu markieren (scripts/postantwort-messen.mjs, Prüfpunkt
 * `luecke`: 0 von 1, in allen drei Läufen).
 *
 * Dieser Hinweis hängt an nichts, was ein Modell behaupten müsste: Der Server
 * hat die Einträge selbst ausgewählt und weiß deshalb genau, worauf die
 * Antwort beruhen KONNTE. Wer freigibt, liest die Themen und sieht damit
 * auch, was NICHT dabei war — steht im Entwurf eine Aussage über etwas, das
 * hier nicht steht, ist sie ungedeckt. Das ist keine Sperre, sondern die
 * Voraussetzung dafür, dass die Freigabe durch einen Menschen mehr ist als
 * ein Abnicken.
 *
 * Ohne jeden Treffer ist die Warnung ausdrücklich: dann hat die KI gar keine
 * Grundlage, und genau dort erfindet sie am ehesten.
 */
function wissensHinweis(themen: readonly string[]): string {
  if (!themen.length) {
    return 'Zu dieser Mail passte kein Eintrag aus dem Firmengedächtnis — die KI hatte keine '
      + 'gesicherte Grundlage. Bitte jede Sachaussage im Entwurf prüfen.';
  }
  return `Grundlage aus dem Firmengedächtnis: ${themen.join('; ')}. `
    + 'Was darüber hinausgeht, ist ungedeckt.';
}

/** „Re:" genau einmal davor. */
function antwortBetreff(betreff: string): string {
  const roh = betreff.trim() || '(ohne Betreff)';
  const schon = /^(re|aw|antw|antwort)\s*:/i.test(roh);
  return (schon ? roh : `Re: ${roh}`).slice(0, BETREFF_MAX);
}

/* ── Buchführung ──────────────────────────────────────────────── */

/**
 * Die Mail für diesen Lauf beanspruchen.
 *
 * Der Primärschlüssel auf `mail_id` ist die eigentliche Sperre: zwei Aufrufe
 * für dieselbe Mail erzeugen nie zwei Entwürfe. Ein zweiter Anlauf ist nur
 * erlaubt, wenn der erste hängengeblieben oder fehlgeschlagen ist und lange
 * genug her — sonst wäre ein abgestürzter Lauf ein für immer ungesichteter
 * Brief.
 */
function beanspruchen(mailId: string, threadId: string): boolean {
  const jetzt = Date.now();
  const neu = db.run(
    `INSERT OR IGNORE INTO mail_sichtung (mail_id, thread_id, gesichtet_am, einordnung, zustand)
     VALUES (?,?,?,NULL,'laeuft')`,
    mailId, threadId, jetzt,
  ).changes > 0;
  if (neu) return true;

  return db.run(
    `UPDATE mail_sichtung SET zustand = 'laeuft', gesichtet_am = ?
      WHERE mail_id = ? AND zustand IN ('laeuft','fehler') AND gesichtet_am < ?`,
    jetzt, mailId, jetzt - WIEDERHOLUNG_AB_MS,
  ).changes > 0;
}

function sichtungFesthalten(
  mailId: string, zustand: Sichtungszustand, einordnung: Einordnung | null,
): void {
  db.run(
    'UPDATE mail_sichtung SET zustand = ?, einordnung = ?, gesichtet_am = ? WHERE mail_id = ?',
    zustand,
    einordnung ? verschluesseln(JSON.stringify(einordnung)) : null,
    Date.now(), mailId,
  );
}

/* ── Der Ablauf ───────────────────────────────────────────────── */

/**
 * Eine eingegangene Mail sichten.
 *
 * **Nicht im Aufruf ausführen.** Diese Funktion fragt ein Sprachmodell; auf
 * einem Raspberry Pi dauert das Sekunden bis Minuten. Wer sie aus einer Route
 * heraus abwartet, lässt den Cloudflare-Worker so lange in der Leitung stehen
 * und blockiert nebenbei alles andere, was der Server gerade tut. Der Weg
 * dafür ist `sichtungAnstossen()` weiter unten.
 *
 * Gibt `null` zurück, wenn es die Mail nicht gibt, sie ausgehend ist oder ein
 * anderer Lauf sie gerade bearbeitet.
 */
export async function sichten(mailId: string): Promise<SichtungBericht | null> {
  const mail = nachricht(mailId);
  if (!mail) {
    console.warn('[post-sichtung] Unbekannte Mail:', mailId);
    return null;
  }
  /* Eigene Post sichtet sich nicht selbst. Ohne diese Zeile antwortete die KI
     eines Tages auf eine Antwort, die sie selbst vorgeschlagen hat. */
  if (mail.richtung !== 'ein') return null;

  const threadId = mail.threadId ?? mail.id;
  if (!beanspruchen(mailId, threadId)) return null;

  const zusatz = zusatzLesen(mailId);
  const an = antwortAdresse(mail, zusatz);
  /* Die Sprache steht am Briefpartner (post.ts), gelernt beim Eintreffen an
     der Adresse im `From:`. Geantwortet wird aber an `Reply-To`. Weiß der
     Server zu dieser Adresse nichts, gilt das, was er über den Schreiber
     gelernt hat — sonst ginge die Antwort an einen deutschen Kunden auf
     Englisch hinaus, nur weil er ein anderes Postfach für Antworten nutzt. */
  const schreiber = nurAdresse(mail.von);
  const gelernt = spracheFuer(an ?? schreiber);
  const sprache = gelernt === SPRACHE_VORGABE && an && an !== schreiber
    ? spracheFuer(schreiber)
    : gelernt;

  let roh: RohAntwort;
  let modell: string | null;
  let themen: string[];
  /* Der Modellaufruf dauert Sekunden bis Minuten. Wurde die Mail in dieser
     Zeit endgültig gelöscht (Art. 17 DSGVO oder die Aufbewahrungsfrist,
     post.ts::mailsHartLoeschen() räumt dabei auch mail_sichtung und
     mail_entwuerfe ab), darf hinterher nichts mehr über sie entstehen —
     sonst bliebe ein Entwurf mit Empfängeradresse und Antworttext zu einer
     Mail liegen, die es nicht mehr gibt, und eine Push-Meldung trüge ihren
     Absender und Betreff noch hinaus. Ab der Prüfung läuft alles bis zum
     Ende ohne `await`, eine Löschung kann also nicht mehr dazwischenkommen. */
  const nochDa = (): boolean =>
    db.get<{ da: number }>('SELECT 1 AS da FROM mail_nachrichten WHERE id = ?', mailId) !== undefined;

  try {
    ({ roh, modell, themen } = await modellFragen(mail, sprache));
  } catch (err) {
    if (!nochDa()) return null;
    /* Ein Modell, das nicht antwortet, ist kein Grund, die Mail zu verlieren.
       Zustand vermerken, Menschen benachrichtigen, fertig — `nachzusichten()`
       findet die Zeile später für einen zweiten Anlauf. */
    const grund = (err as Error).message;
    console.warn('[post-sichtung]', mailId, '—', grund);
    sichtungFesthalten(mailId, 'fehler', null);
    const benachrichtigt = benachrichtigen(bauMeldung({
      mail, zustand: 'fehler', einordnung: null, gesichtetAm: Date.now(),
    }));
    return { mailId, zustand: 'fehler', entwurfId: null, benachrichtigt, grund, grundCode: 'modellFehler' };
  }
  if (!nochDa()) return null;

  /* `antwortNoetig` muss ein echtes JSON-true sein. Eine Zeichenkette "true"
     zählt nicht: im Zweifel entscheidet ein Mensch, und eine Meldung zu viel
     ist billiger als ein Entwurf, den niemand bestellt hat. */
  const willAntworten = roh.antwortNoetig === true;
  const entwurfstext = feld(roh.entwurf, ENTWURF_MAX);

  const einordnung: Einordnung = {
    absenderart: absenderartDeuten(roh.absenderart),
    anliegen: feld(roh.anliegen, ANLIEGEN_MAX) || 'Kein Anliegen erkannt.',
    dringlichkeit: dringlichkeitDeuten(roh.dringlichkeit),
    antwortNoetig: willAntworten && entwurfstext.length > 0,
    begruendung: feld(roh.begruendung, BEGRUENDUNG_MAX) || 'Ohne Begründung.',
    sprache,
    modell,
  };

  /* Die drei Gründe, aus denen trotz `antwortNoetig` kein Entwurf entsteht.
     Alle drei hängen an gespeicherten Daten, keiner am Urteil des Modells. */
  const grund = !einordnung.antwortNoetig
    ? 'Die KI hält keine Antwort für nötig — bitte nur zur Kenntnis nehmen.'
    : !absenderBestaetigt(zusatz.pruefung)
      ? 'Der Absender wurde nicht bestätigt (kein dmarc=pass) — deshalb entsteht kein Entwurf.'
      : !an
        ? 'Aus der Mail lässt sich keine eindeutige Antwortadresse lesen — deshalb entsteht kein Entwurf.'
        : null;

  if (grund || !an) {
    sichtungFesthalten(mailId, 'gemeldet', einordnung);
    const benachrichtigt = benachrichtigen(bauMeldung({
      mail, zustand: 'gemeldet', einordnung, gesichtetAm: Date.now(),
      an, dmarcOk: absenderBestaetigt(zusatz.pruefung),
    }));
    return {
      mailId, zustand: 'gemeldet', entwurfId: null, benachrichtigt, grund,
      // Derselbe Dreiweg-Entscheid wie zwei Zeilen weiter oben, nur als
      // Kennung statt als Satz — grundCodeFuer() ist die eine Stelle, die
      // ihn kennt (siehe dort), damit hier keine zweite, unabhängige Kopie
      // der Rangfolge entsteht.
      grundCode: grundCodeFuer('gemeldet', einordnung, absenderBestaetigt(zusatz.pruefung), an),
    };
  }

  /* Entwurf und Zustand in einem Zug. Bräche es dazwischen ab, stünde ein
     Entwurf in der Tabelle, während die Sichtung noch auf `laeuft` steht —
     und der Nachlauf legte nach der Frist einen zweiten daneben. */
  const entwurfId = db.transaction(() => {
    const id = entwurfAnlegen({
      mail, threadId, an,
      text: entwurfstext,
      begruendung: [
        einordnung.begruendung,
        abweichungsHinweis(mail, an),
        /* Was die KI nicht wusste, steht bei der Freigabe daneben — nicht nur
           mitten im Text. Die Regel dazu (services/post-wissen-ki.ts) lässt
           sie eine Lücke markieren statt etwas zu erfinden; wer den Entwurf
           freigibt, soll die Liste dieser Lücken vor Augen haben, bevor er
           liest. Eine erfundene Produktauskunft ist der teuerste Fehler
           dieses Systems, eine übersehene Lücke der zweitteuerste. */
        lueckenHinweis(entwurfstext),
        wissensHinweis(themen),
      ].filter(Boolean).join(' '),
    });
    sichtungFesthalten(mailId, 'entwurf', einordnung);
    return id;
  });

  /* Auch ein Entwurf wird gemeldet. Ein Vorschlag, den niemand sieht, ist
     keiner — und niemand soll das Postfach im Verdacht öffnen müssen.
     `entwurfId` geht bewusst NICHT in die Meldung: eine technische Kennung
     hat in der Anzeige nichts verloren (siehe `PostMeldung` in
     @stellium/shared) — wer den Entwurf sehen will, folgt `mailId` in den
     Postfach-Reiter, dort steht er ohnehin beim jüngsten Eintrag der Mail. */
  const benachrichtigt = benachrichtigen(bauMeldung({
    mail, zustand: 'entwurf', einordnung, gesichtetAm: Date.now(), an,
  }));

  return { mailId, zustand: 'entwurf', entwurfId, benachrichtigt, grund: null, grundCode: null };
}

/**
 * Den Entwurf schreiben.
 *
 * Getrennt von `sichten()`, weil hier die Sperren sitzen, die man einzeln
 * nachlesen können soll:
 *
 *   · `an` ist der Parameter, den `antwortAdresse()` aus der gespeicherten
 *     Mail geholt hat. Aus `roh.entwurf` kommt ausschließlich der Fließtext.
 *   · Ein `fach` gibt es nicht. Der Versand holt es später über `mail_id` aus
 *     der Ursprungsmail — ein anderes Fach lässt sich hier nicht setzen, weil
 *     es dafür keine Spalte gibt.
 *   · Anhänge gibt es nicht. `post.senden()` kennt keine, und `mail_entwuerfe`
 *     hat kein Feld dafür.
 *   · Der Betreff entsteht aus dem Betreff der Ursprungsmail, nicht aus der
 *     Antwort des Modells.
 *   · Text und `text_ki` sind der reine Wortlaut des Modells — KEINE
 *     Kennzeichnung wird hier mehr ergänzt (siehe „Die Kennzeichnung" weiter
 *     oben). Sie entsteht erst beim tatsächlichen Versand als Fußzeile.
 *
 * Zustand `offen`: von hier führt kein Weg nach draußen, der nicht über einen
 * Menschen mit `mail.senden` geht.
 */
function entwurfAnlegen(input: {
  mail: Nachricht; threadId: string; an: string;
  text: string; begruendung: string;
}): string {
  const id = newId('pe_');
  db.run(
    `INSERT INTO mail_entwuerfe
       (id, mail_id, thread_id, an, betreff, text, text_ki, begruendung, zustand, erstellt_am)
     VALUES (?,?,?,?,?,?,?,?,'offen',?)`,
    id, input.mail.id, input.threadId,
    verschluesseln(input.an),
    verschluesseln(antwortBetreff(input.mail.betreff)),
    verschluesseln(input.text),
    /* Dieselbe Zeichenkette ein zweites Mal — und das ist der Punkt: `text`
       wird beim Freigeben mit dem überschrieben, was ein Mensch tatsächlich
       hinausschickt (`entwurfBearbeiten()` weiter unten), `text_ki` bleibt
       für immer stehen. Der Unterschied zwischen beiden entscheidet später
       services/post.ts::senden() über die Fußzeile der Mail (services/
       post-fussnote.ts) und services/post-lernen.ts darüber, dass an dieser
       Mail eine KI mitgeschrieben hat und deshalb NICHT gelernt werden darf
       (siehe dort). Ohne diese Kopie wäre der Unterschied im Moment des
       Sendens spurlos weg. */
    verschluesseln(input.text),
    verschluesseln(input.begruendung),
    Date.now(),
  );
  return id;
}

/* ── Anstoßen, ohne die Ereignisschleife anzuhalten ───────────── */

/**
 * Eine Sichtung im Hintergrund anstoßen und sofort zurückkehren.
 *
 * Aus einer Route heraus so und nicht anders: `void sichten(id)` sähe ähnlich
 * aus, startet den Modellaufruf aber noch im selben Durchgang der
 * Ereignisschleife — also bevor die Antwort auf dem Draht ist. Der kleine
 * Zeitgeber schiebt ihn dahinter.
 *
 * Sauberer ist ein `onResponse`-Haken in Fastify; wo es den gibt, gehört der
 * Aufruf dorthin. Diese Fassung ist die, die ohne Änderung an der Route
 * funktioniert.
 *
 * Läufe stehen in einer Reihe. Kommen fünf Mails auf einmal, fragte sonst
 * fünfmal gleichzeitig ein Modell — auf einem Pi heißt das: keine antwortet.
 */
let warteschlange: Promise<unknown> = Promise.resolve();

export function sichtungAnstossen(mailId: string, verzoegerungMs = 250): void {
  setTimeout(() => {
    warteschlange = warteschlange
      .then(() => sichten(mailId))
      .then((bericht) => {
        if (bericht) {
          console.log(`[post-sichtung] ${mailId}: ${bericht.zustand}`
            + (bericht.entwurfId ? `, Entwurf ${bericht.entwurfId}` : '')
            + `, ${bericht.benachrichtigt} benachrichtigt`);
        }
      })
      .catch((err) => {
        /* Bis hierher kommt nur, was `sichten()` selbst nicht mehr auffangen
           konnte — etwa eine Datenbank, die gerade nicht schreibt. Der Server
           darf daran nicht sterben. */
        console.error('[post-sichtung]', mailId, (err as Error).message);
      });
  }, verzoegerungMs);
}

/* ── Lesen ────────────────────────────────────────────────────── */

/** Eine Zeile aus `mail_entwuerfe`, so wie sie in der Datenbank steht. */
interface EntwurfZeile {
  id: string; mail_id: string; thread_id: string; an: string; betreff: string;
  text: string; text_ki: string | null; begruendung: string | null; zustand: string; erstellt_am: number;
  entschieden_am: number | null; entschieden_von: string | null; gesendet_id: string | null;
}

function entwurfAuspacken(z: EntwurfZeile): PostEntwurf {
  const text = entschluesseln(z.text);
  const an = entschluesseln(z.an);
  /* Für die Abweichungswarnung UND das Fach wird die Ursprungsmail noch
     einmal gebraucht, genau wie in meldungenListe() weiter unten — und aus
     demselben Grund nur dort abgefragt, wo sie überhaupt noch etwas bedeutet
     (siehe PostEntwurf oben): ein bereits entschiedener Entwurf bekommt gar
     nicht erst einen zusätzlichen Lesezugriff auf `mail_nachrichten`
     spendiert. */
  const mail = (z.zustand === 'offen' || z.zustand === 'sendet') ? nachricht(z.mail_id) : null;
  return {
    id: z.id,
    mailId: z.mail_id,
    threadId: z.thread_id,
    an,
    fach: mail?.fach ?? null,
    betreff: entschluesseln(z.betreff),
    text,
    begruendung: z.begruendung ? entschluesseln(z.begruendung) : null,
    zustand: z.zustand,
    erstelltAm: z.erstellt_am,
    entschiedenAm: z.entschieden_am,
    entschiedenVon: z.entschieden_von,
    gesendetId: z.gesendet_id,
    abweichung: mail ? abweichungAdressen(mail, an) : null,
    textKi: z.text_ki ? entschluesseln(z.text_ki) : null,
  };
}

/**
 * Ein Entwurf, entschlüsselt.
 *
 * **Wer versendet, nimmt `an` von hier und von nirgendwo sonst.** Diese
 * Adresse stammt aus der gespeicherten Ursprungsmail; jede andere Quelle —
 * ein Formularfeld, ein Wert aus dem Mailtext, ein Vorschlag des Modells —
 * hebelt die Sperre aus, um die es bei diesem ganzen Ablauf geht.
 */
export function entwurfLesen(id: string): PostEntwurf | null {
  const z = db.get<EntwurfZeile>(
    'SELECT * FROM mail_entwuerfe WHERE id = ?', id,
  );
  return z ? entwurfAuspacken(z) : null;
}

/**
 * Alles, was auf eine Entscheidung wartet — das Älteste zuerst.
 *
 * `sendet` gehört ausdrücklich dazu, sobald der Anspruch alt genug ist. Ohne
 * diese zweite Bedingung wäre der Schutz gegen den Doppelversand
 * (`entwurfBearbeiten()` weiter unten) an einer Stelle zu scharf: stirbt der
 * Server mitten im Versand, bliebe der Entwurf auf `sendet` stehen, und diese
 * Liste — die einzige, aus der ein Mensch einen Entwurf überhaupt aufruft —
 * zeigte ihn nie wieder. Der Brief wäre nie beantwortet, und niemand sähe
 * warum. Die Frist ist dieselbe, mit der `entwurfBearbeiten()` einen alten
 * Anspruch übernimmt; beide Zahlen müssen dieselbe sein, sonst zeigt die
 * Liste etwas an, das sich noch nicht freigeben lässt.
 */
export function offeneEntwuerfe(anzahl = 50): PostEntwurf[] {
  const grenze = Math.min(Math.max(1, Math.trunc(anzahl) || 50), 200);
  return db.all<EntwurfZeile>(
    `SELECT * FROM mail_entwuerfe
      WHERE zustand = 'offen'
         OR (zustand = 'sendet' AND entschieden_am IS NOT NULL AND entschieden_am < ?)
      ORDER BY erstellt_am ASC LIMIT ?`,
    Date.now() - VERSAND_ANSPRUCH_MS, grenze,
  ).map(entwurfAuspacken);
}

/** Der Entwurf zu einer Mail, falls es einen gibt. */
export function entwurfZurMail(mailId: string): PostEntwurf | null {
  const z = db.get<EntwurfZeile>(
    'SELECT * FROM mail_entwuerfe WHERE mail_id = ? ORDER BY erstellt_am DESC LIMIT 1', mailId,
  );
  return z ? entwurfAuspacken(z) : null;
}

/** Was die KI zu einer Mail entschieden hat. */
export function sichtungFuer(mailId: string): {
  zustand: Sichtungszustand; gesichtetAm: number; einordnung: Einordnung | null;
} | null {
  const z = db.get<{ zustand: string; gesichtet_am: number; einordnung: string | null }>(
    'SELECT zustand, gesichtet_am, einordnung FROM mail_sichtung WHERE mail_id = ?', mailId,
  );
  if (!z) return null;
  let einordnung: Einordnung | null = null;
  if (z.einordnung) {
    /* Eine Zeile, die sich nicht mehr lesen lässt (falsches Masterpasswort,
       geänderter Aufbau), darf die Ansicht nicht mitnehmen. */
    try { einordnung = JSON.parse(entschluesseln(z.einordnung)) as Einordnung; } catch { einordnung = null; }
  }
  return { zustand: z.zustand as Sichtungszustand, gesichtetAm: z.gesichtet_am, einordnung };
}

/**
 * Zustand und Einordnung mehrerer Mails auf einen Schlag, nach `mailId`
 * geordnet — für den Postfach-Reiter (PostPanel.tsx), der eine ganze Seite
 * der Liste einfärbt und nach Dringlichkeit sortiert und dafür nicht 50
 * einzelne Anfragen stellen soll (dasselbe Anliegen wie `may()`, das für
 * mehrere Rechte auch nicht einzeln aufgerufen wird).
 *
 * Mails ohne eigene Zeile in `mail_sichtung` (frisch eingegangen, die
 * Sichtung hat noch nicht einmal `beanspruchen()` durchlaufen) fehlen im
 * Ergebnis einfach — das ist Absicht: die aufrufende Seite unterscheidet so
 * „noch nie gesichtet" von jedem tatsächlichen Zustand, und genau diese
 * Unterscheidung braucht sie, um eine ganz frische Mail nicht so zu
 * behandeln, als sei sie als „niedrig" eingestuft.
 */
export function sichtungenFuer(mailIds: string[]): Record<string, {
  zustand: Sichtungszustand; einordnung: Einordnung | null;
}> {
  const eindeutig = [...new Set(mailIds)].filter(Boolean).slice(0, 200);
  const ergebnis: Record<string, { zustand: Sichtungszustand; einordnung: Einordnung | null }> = {};
  if (!eindeutig.length) return ergebnis;

  const platzhalter = eindeutig.map(() => '?').join(',');
  const zeilen = db.all<{ mail_id: string; zustand: string; einordnung: string | null }>(
    `SELECT mail_id, zustand, einordnung FROM mail_sichtung WHERE mail_id IN (${platzhalter})`,
    ...eindeutig,
  );
  for (const z of zeilen) {
    let einordnung: Einordnung | null = null;
    if (z.einordnung) {
      try { einordnung = JSON.parse(entschluesseln(z.einordnung)) as Einordnung; } catch { einordnung = null; }
    }
    ergebnis[z.mail_id] = { zustand: z.zustand as Sichtungszustand, einordnung };
  }
  return ergebnis;
}

/**
 * Die Zeilen für den Reiter „Post-Sichtung" — neueste zuerst, `vor` als
 * Blätterkennung. Dieselbe Bauart wie `post.liste()`: `vor` ist der
 * `gesichtetAm`-Wert der letzten schon geladenen Zeile, keine Seitenzahl —
 * eine neu eingegangene Mail zwischen zwei Abrufen verschiebt damit keine
 * andere Zeile auf eine falsche Seite.
 *
 * Liest die Mail selbst ausschließlich über `nachricht()` aus post.ts, nie
 * direkt aus der Tabelle `mail` — dieselbe Grenze, die der Dateikopf für die
 * ganze Datei zieht. Eine Mail, die es nicht mehr gibt, lässt die Zeile
 * stillschweigend aus, statt eine Lücke in der Liste zu zeigen.
 *
 * `an`/die DMARC-Bestätigung werden nur dort nachgeschlagen, wo `bauMeldung()`
 * sie wirklich braucht (`entwurf` für den Abweichungshinweis, `gemeldet` für
 * die Feinunterscheidung des Grundes) — die Mehrheit der Zeilen (`gesendet`,
 * `abgelehnt`, `fehler`, `laeuft`) kommt ohne eine weitere Abfrage aus.
 */
export function meldungenListe(anzahl = 50, vor?: number): PostMeldung[] {
  const grenze = Math.min(Math.max(1, Math.trunc(anzahl) || 50), 200);
  const zeilen = db.all<{ mail_id: string; zustand: string; einordnung: string | null; gesichtet_am: number }>(
    vor
      ? `SELECT mail_id, zustand, einordnung, gesichtet_am FROM mail_sichtung
          WHERE gesichtet_am < ? ORDER BY gesichtet_am DESC LIMIT ?`
      : `SELECT mail_id, zustand, einordnung, gesichtet_am FROM mail_sichtung
          ORDER BY gesichtet_am DESC LIMIT ?`,
    ...(vor ? [vor, grenze] : [grenze]),
  );

  const ergebnis: PostMeldung[] = [];
  for (const z of zeilen) {
    const mail = nachricht(z.mail_id);
    if (!mail) continue;
    const zustand = z.zustand as Sichtungszustand;

    let einordnung: Einordnung | null = null;
    if (z.einordnung) {
      try { einordnung = JSON.parse(entschluesseln(z.einordnung)) as Einordnung; } catch { einordnung = null; }
    }

    let an: string | null = null;
    let dmarcOk = false;
    if (zustand === 'entwurf') {
      an = entwurfZurMail(z.mail_id)?.an ?? null;
    } else if (zustand === 'gemeldet') {
      const zusatz = zusatzLesen(z.mail_id);
      an = antwortAdresse(mail, zusatz);
      dmarcOk = absenderBestaetigt(zusatz.pruefung);
    }

    ergebnis.push(bauMeldung({ mail, zustand, einordnung, gesichtetAm: z.gesichtet_am, an, dmarcOk }));
  }
  return ergebnis;
}

/**
 * Mails, deren Sichtung hängengeblieben oder fehlgeschlagen ist.
 *
 * Für einen Nachlauf: war die KI eine Stunde lang nicht erreichbar, liegen
 * hier die Briefe, die niemand eingeordnet hat. Menschen wurden über jeden
 * einzelnen benachrichtigt — verloren ist keiner —, aber die Einordnung fehlt
 * noch. `sichtungAnstossen()` auf jede Kennung holt sie nach.
 */
export function nachzusichten(anzahl = 20): string[] {
  const grenze = Math.min(Math.max(1, Math.trunc(anzahl) || 20), 100);
  return db.all<{ mail_id: string }>(
    `SELECT mail_id FROM mail_sichtung
      WHERE zustand IN ('laeuft','fehler') AND gesichtet_am < ?
      ORDER BY gesichtet_am ASC LIMIT ?`,
    Date.now() - WIEDERHOLUNG_AB_MS, grenze,
  ).map((z) => z.mail_id);
}

/* ── Die Entscheidung eines Menschen festhalten ───────────────── */

/**
 * Den Text (und Betreff) eines offenen Entwurfs mit dem überschreiben, was
 * ein Mensch beim Freigeben eingetippt hat — VOR dem Versand aufgerufen,
 * nicht danach (siehe die Route `/api/post/entwuerfe/:id/senden` in
 * routes.ts).
 *
 * Die geänderte Regel lautet: was im Feld steht, geht hinaus — vormals gab
 * es dafür überhaupt kein Feld, „freigegeben wurde genau das, was geprüft
 * wurde". Damit im Verlauf hinterher trotzdem exakt das steht, was
 * tatsächlich gesendet wurde, muss die Bearbeitung hier landen, BEVOR
 * `post.senden()` läuft — sonst zeigte `entwurfLesen()` bei einem späteren
 * Blick in den Verlauf den ALTEN, ungeprüften Wortlaut, obwohl längst der
 * neue hinausging.
 *
 * `an` ändert sich hier bewusst NICHT — dafür gibt es keinen Parameter, aus
 * demselben Sicherheitsgrund wie beim ursprünglichen Entwurf (siehe
 * Dateikopf: „an kommt niemals aus dem Modell" — und jetzt zusätzlich: nie
 * aus einer Anfrage, auch wenn ein Mensch mit `mail.senden` dahintersteht).
 *
 * DIESE FUNKTION HÄLT NICHT NUR FEST, SIE BEANSPRUCHT AUCH
 *
 * Sie schreibt `zustand = 'sendet'`. Das ist neu, und es ist der eigentliche
 * Punkt: vorher setzte sie NUR `text` und `betreff` und ließ den Zustand auf
 * `offen` stehen. Ihr `WHERE zustand = 'offen'` sah damit für JEDEN Aufrufer
 * gleich aus, solange keiner fertig war — und fertig wurde erst
 * `entwurfAbschliessen()`, nach dem Versand. Alles zwischen dem
 * `entwurfLesen()` der Route und dem `await post.senden()` ist synchron; zwei
 * fast gleichzeitige Anfragen liefen deshalb beide durch diese Prüfung, und
 * beide riefen den Versanddienst auf. Nachgestellt: zwei echte Sendungen, und
 * das `entwurfAbschliessen()` der zweiten meldete brav `nichtOffen` — da war
 * die Mail beim Kunden schon zweimal angekommen. Ein Doppelklick oder ein
 * Client, der nach einem Zeitablauf noch einmal fragt, genügt. Eine
 * Kennung, an der Resend eine Wiederholung erkennen könnte, gibt es nicht.
 *
 * Jetzt schließt derselbe UPDATE die Tür, durch die er gerade gegangen ist:
 * er ändert den Zustand mit, also findet der zweite Aufruf kein `offen` mehr
 * vor und bekommt `false`. Dieselbe Bauart wie `beanspruchen()` weiter oben
 * — ein bedingter UPDATE, dessen `changes` entscheidet, wer weitermachen
 * darf —, und aus demselben Grund auch dessen Frist: ein Anspruch, den
 * niemand mehr zurückgeben kann, weil der Server dazwischen gestorben ist,
 * darf nicht ewig gelten (siehe `VERSAND_ANSPRUCH_MS`). Der gewöhnliche
 * Fehlschlag wartet nicht so lange — die Route gibt den Anspruch sofort
 * zurück (`entwurfAnspruchLoesen()` gleich unten).
 *
 * `sendet` ist bewusst ein Zustand und keine zweite Tabelle: eine neue
 * Tabelle wäre eine Wanderung (db/migrate.ts), die Spalte hat kein CHECK,
 * und `offeneEntwuerfe()` filtert ohnehin auf `offen` — ein Entwurf, der
 * gerade hinausgeht, verschwindet also für die paar Sekunden aus der Liste
 * der zu Entscheidenden und kommt zurück, wenn der Versand scheitert. Genau
 * das soll er.
 *
 * `entschieden_am` trägt in diesem Zustand die Uhrzeit des Anspruchs, nicht
 * die einer Entscheidung. Beim Abschluss wird sie mit der echten
 * überschrieben, und solange `sendet` gilt, ist der Entwurf für die
 * Oberfläche gar nicht sichtbar.
 *
 * Der alte `WHERE zustand = 'offen'`-Schutz bleibt darin enthalten: lief
 * zwischen dem `entwurfLesen()` der Route und diesem Aufruf schon eine
 * zweite Entscheidung durch, ändert diese Funktion nichts (`changes` bleibt
 * 0) — die Route bricht ab, BEVOR irgendetwas an den Versanddienst geht.
 *
 * `text_ki` steht bewusst NICHT in diesem UPDATE. Dort liegt, was die KI
 * geschrieben hatte (siehe `entwurfAnlegen()` oben); überschriebe man es hier
 * mit, wäre der Unterschied zwischen Vorschlag und Freigabe genau in dem
 * Moment weg, in dem er entsteht — und das ist das stärkste Lernsignal, das
 * dieses Haus hat (services/post-lernen.ts).
 */
export function entwurfBearbeiten(entwurfId: string, eingabe: { text: string; betreff: string }): boolean {
  const jetzt = Date.now();
  /* Die erste Zeile bleibt bewusst EINE Zeile: der Prüflauf
     (scripts/e2e-postgedaechtnis.mjs) liest genau diese Anweisung aus dem
     Quelltext und stellt sicher, dass hier kein `text_ki` steht. Wer sie
     umbricht, nimmt dieser Zusage still ihren Wächter. */
  return db.run(
    `UPDATE mail_entwuerfe SET text = ?, betreff = ?, zustand = 'sendet', entschieden_am = ?
      WHERE id = ?
        AND (zustand = 'offen'
             OR (zustand = 'sendet' AND entschieden_am IS NOT NULL AND entschieden_am < ?))`,
    verschluesseln(eingabe.text), verschluesseln(eingabe.betreff), jetzt,
    entwurfId, jetzt - VERSAND_ANSPRUCH_MS,
  ).changes > 0;
}

/**
 * Einen Versand-Anspruch wieder hergeben.
 *
 * Geht der Versand schief, war der Anspruch umsonst — der Entwurf gehört
 * zurück auf `offen`, damit derselbe Mensch es sofort noch einmal versuchen
 * kann. Ohne das wäre jeder Aussetzer des Versanddienstes eine fünf Minuten
 * lange Sperre auf einem Entwurf, der nie hinausging.
 *
 * `WHERE zustand = 'sendet'` ist die Sicherung: hat inzwischen ein anderer
 * Lauf den Anspruch übernommen und ist schon fertig (`gesendet`), darf dieser
 * hier ihn nicht nachträglich wieder aufmachen.
 */
export function entwurfAnspruchLoesen(entwurfId: string): void {
  db.run(
    `UPDATE mail_entwuerfe SET zustand = 'offen', entschieden_am = NULL
      WHERE id = ? AND zustand = 'sendet'`,
    entwurfId,
  );
}

/**
 * Was aus einem Entwurf geworden ist.
 *
 * Diese Funktion sendet NICHT — sie schreibt nur auf, was ein Mensch
 * entschieden hat. Das Senden selbst bleibt bei `post.senden()`. Der
 * Aufrufer nimmt `an` weiterhin ausschließlich aus `entwurfLesen()`;
 * `betreff` und `text` stammen inzwischen aus der Freigabe-Anfrage selbst
 * (siehe `entwurfBearbeiten()` direkt oben) — sie liegen zu diesem Zeitpunkt
 * aber ohnehin schon, unverändert, in genau dieser Tabelle.
 *
 * Das Recht wird hier geprüft und nicht erst in der Route — aus demselben
 * Grund, aus dem post.ts den Eingang im Dienst prüft: eine zweite Stelle, die
 * später Entwürfe abschließt (ein Knopf, ein Nachtlauf, eine
 * Wiedereinspielung), käme sonst an der Prüfung vorbei.
 *
 * Rückgabe statt Wurf, damit die Route ihre eigene Meldung mit ihrer eigenen
 * Wörterbuchkennung dazu setzen kann.
 */
export function entwurfAbschliessen(input: {
  entwurfId: string;
  userId: string;
  ergebnis: 'gesendet' | 'abgelehnt';
  /** Die Kennung der wirklich gesendeten Mail — der Beweis, dass es hinaus ist. */
  gesendetId?: string | null;
}): 'ok' | 'unbekannt' | 'nichtOffen' | 'keinRecht' {
  const entwurf = entwurfLesen(input.entwurfId);
  if (!entwurf) return 'unbekannt';
  /* Welchen Zustand dieses Ergebnis abschließen darf, ist NICHT dasselbe:
     `gesendet` kommt aus der Freigabe-Route und findet den Entwurf dort auf
     `sendet` vor — sie hat ihn selbst gerade dafür beansprucht (siehe
     `entwurfBearbeiten()` oben). `abgelehnt` darf das ausdrücklich NICHT:
     einen Entwurf wegzuwerfen, während er gerade beim Versanddienst liegt,
     hieße, ihn als abgelehnt zu verbuchen, obwohl er in derselben Sekunde
     beim Kunden ankommt. Wer ablehnen will, muss ihn offen vorfinden. */
  const darfSendend = input.ergebnis === 'gesendet';
  if (entwurf.zustand !== 'offen' && !(darfSendend && entwurf.zustand === 'sendet')) {
    return 'nichtOffen';
  }
  /* Zwischen Entwurf und Versand steht ein Mensch mit `mail.senden`. Ablehnen
     darf, wer die Post lesen darf — etwas wegzuwerfen, das nie hinausging,
     ist kein Versand. */
  const recht = input.ergebnis === 'gesendet' ? 'mail.senden' : 'mail.lesen';
  if (!may(input.userId, recht)) return 'keinRecht';

  db.transaction(() => {
    db.run(
      `UPDATE mail_entwuerfe
          SET zustand = ?, entschieden_am = ?, entschieden_von = ?, gesendet_id = ?
        WHERE id = ?
          AND (zustand = 'offen' OR (zustand = 'sendet' AND ? = 1))`,
      input.ergebnis, Date.now(), input.userId,
      input.ergebnis === 'gesendet' ? input.gesendetId ?? null : null,
      input.entwurfId, darfSendend ? 1 : 0,
    );
    /* Die Sichtung zieht mit: `gesendet` und `abgelehnt` stehen dort als
       „entschieden" (db/schema.sql). Sonst hinge am Brief für immer „ein
       Entwurf wartet", obwohl längst jemand entschieden hat. Beides in einem
       Zug, sonst widersprechen sich die zwei Tabellen nach einem Abbruch. */
    db.run(
      "UPDATE mail_sichtung SET zustand = ? WHERE mail_id = ? AND zustand = 'entwurf'",
      input.ergebnis, entwurf.mailId,
    );
  });
  return 'ok';
}
