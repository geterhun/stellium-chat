/**
 * PayPal — der Kontostand der Firma, und nur ANSEHEN.
 *
 * ═══ DIE GRENZE, DIE NICHT VERHANDELBAR IST ════════════════════════════
 * Diese Datei liest. Sie bewegt kein Geld. Es gibt hier keinen Aufruf, der
 * auszahlt, überweist, erstattet, umtauscht oder storniert — auch keinen
 * ausgegrauten, auch keinen auskommentierten. Angesprochen werden GENAU ZWEI
 * Endpunkte, beide `GET`, beide aus PayPals Berichtsteil:
 *
 *     GET /v1/reporting/balances       Kontostand je Währung
 *     GET /v1/reporting/transactions   Bewegungen in einem Zeitfenster
 *
 * Wer hier künftig etwas ergänzt: alles unter `/v1/payments/…`,
 * `/v2/payments/…`, `/v1/payments/payouts…`, `/v2/checkout/orders…` gehört
 * nicht in diese Datei. Nicht „noch nicht", sondern nicht. Auch die dafür
 * nötigen Rechte werden bewusst nie angefragt — siehe PAYPAL_SCOPES_PFLICHT
 * unten: zwei Leserechte, mehr bekommt der Schlüssel nicht, und mehr braucht
 * er nicht. Ein Schlüssel, der nichts anderes darf, kann auch nichts anderes
 * anrichten, falls er einmal abhandenkommt.
 *
 * ═══ VIER DINGE, DIE BEIM BAU DEN AUSSCHLAG GABEN ══════════════════════
 *
 * 1. TOKEN ZWISCHENSPEICHERN, NICHT JE ANFRAGE HOLEN. PayPals eigene
 *    Ratenbremsen-Anleitung (developer.paypal.com/reference/guidelines/
 *    rate-limiting, Stand 12.06.2026) nennt genau zwei Ratschläge, und einer
 *    davon lautet wörtlich: „Rather than generate an OAuth 2.0 access token
 *    for each transaction, cache tokens." Der Zugriffstoken aus dem
 *    client-credentials-Fluss gilt mehrere Stunden (`expires_in` in der
 *    Antwort, in PayPals Beispiel 31.668 Sekunden). Er liegt hier deshalb im
 *    Arbeitsspeicher, mit VORLAUF_MS Sicherheitsabstand vor dem Ablauf, und
 *    mehrere gleichzeitige Aufrufer teilen sich EINEN Holvorgang.
 *
 *    Bewusst NICHT in der Datenbank: ein Zugriffstoken ist aus Client-ID und
 *    Secret jederzeit neu herstellbar. Ihn zusätzlich auf die Platte zu
 *    schreiben hieße, ein drittes Geheimnis dauerhaft zu lagern, das man
 *    nach einem Neustart ohnehin geschenkt bekommt.
 *
 * 2. ANDERE ERNEUERUNGSREGEL ALS BEI PATREON — MIT ABSICHT. services/
 *    patreon.ts schreibt sich im Kopf ausdrücklich vor: „erneuern vor
 *    Ablauf, nicht nach einem Fehlschlag". Das gilt dort, weil Patreon einen
 *    Refresh-Token benutzt, der bei jeder Erneuerung ausgetauscht wird — ein
 *    verpasster Zeitpunkt sperrt einen für einen Monat aus. Hier ist die
 *    Lage eine andere: client_credentials braucht keinen Refresh-Token, ein
 *    neuer Token ist immer nur einen Aufruf entfernt. Deshalb hier BEIDES:
 *    vorbeugend vor dem Ablauf UND genau ein Wiederholungsversuch nach einem
 *    401 — denn ein Token kann auch VOR seinem Ablauf ungültig werden, etwa
 *    wenn der Inhaber im PayPal-Entwicklerbereich das Secret wechselt.
 *
 * 3. 31 TAGE SIND EINE HARTE GRENZE, UND PAYPAL KÜRZT NICHT — ES LEHNT AB.
 *    `/v1/reporting/transactions` verlangt `start_date` UND `end_date` und
 *    nimmt höchstens 31 Tage Abstand („The maximum supported range is 31
 *    days"). Eine zu große Ergebnismenge quittiert PayPal mit
 *    `RESULTSET_TOO_LARGE` („Result set size is greater than the maximum
 *    limit. Change the filter criteria and try again.") — es kommt also
 *    keine gekürzte Liste zurück, sondern ein Fehler. Wer das nicht
 *    behandelt, hat bei wachsendem Geschäft eines Tages statt Zahlen einen
 *    roten Kasten. fensterHolen() unten halbiert das Fenster daraufhin und
 *    versucht es erneut, bis hinunter auf einen Tag.
 *
 * 4. DIE ZAHLEN SIND BIS ZU DREI STUNDEN ALT — UND DAS MUSS MAN SEHEN.
 *    PayPal sagt es für beide Endpunkte selbst: „It takes a maximum of three
 *    hours for executed transactions to appear" bzw. „…for balances to
 *    appear". Deshalb trägt jede Antwort ZWEI Zeitpunkte: `standUnser` (wann
 *    haben WIR geholt) und `standPaypal` (`last_refresh_time` aus PayPals
 *    Saldo-Antwort — wann war der Stand bei PAYPAL frisch). Nur der zweite
 *    beantwortet ehrlich „wie alt ist diese Zahl".
 *
 * ═══ DREI ZUSTÄNDE, DIE NIE GLEICH AUSSEHEN DÜRFEN ═════════════════════
 * `nichtEingerichtet` — es liegen keine Zugangsdaten vor.
 * `fehler`            — es liegen welche vor, der letzte Abruf ging schief.
 *                       Die zuletzt bekannten Zahlen kommen trotzdem mit,
 *                       mit IHREM Zeitpunkt, damit man sieht, wie alt sie sind.
 * `aktuell`           — der letzte Abruf hat geklappt.
 * Ein leeres Konto ist KEIN eigener Zustand: es ist `aktuell` mit Salden von
 * null. Genau diese Verwechslung („kaputt" sieht aus wie „leer") war der
 * Grund, den Zustand überhaupt in die Antwort zu schreiben, statt ihn die
 * Oberfläche aus vorhandenen oder fehlenden Feldern raten zu lassen.
 *
 * ═══ WAS ABSICHTLICH NICHT ABGERUFEN WIRD ══════════════════════════════
 * `fields` bleibt auf dem Vorgabewert `transaction_info`. Damit fragen wir
 * NIE `payer_info` an — also keine Namen, keine E-Mail-Adressen, keine
 * Anschriften von Kundinnen und Kunden. Ein Kontostand braucht das nicht,
 * und was man nicht holt, muss man weder verschlüsseln noch löschen noch
 * jemandem gegenüber verantworten. Aus demselben Grund legt diese Datei
 * KEINE einzelne Buchung ab, sondern nur Summen (siehe verdichten()).
 */
import { getSetting, setSetting } from './settings.js';
import { encryptField, decryptField, encryptionActive } from '../crypto/pii.js';
import { kursFuerDatum, kursZaehlerZuruecksetzen } from './wechselkurse.js';

/* ── Adressen ──────────────────────────────────────────────────────────
   PayPal trennt Übungs- und Ernstfall nicht über einen Schalter in der
   Anfrage, sondern über zwei verschiedene Hostnamen — und die Zugangsdaten
   sind je Umgebung andere. Deshalb steht die Umgebung neben den Zugangsdaten
   in der Ablage und nicht in einer Umgebungsvariablen: wer die Zugangsdaten
   wechselt, wechselt in aller Regel auch die Umgebung, und beides gehört an
   dieselbe Stelle. */
const BASIS_LIVE = 'https://api-m.paypal.com';
const BASIS_SANDBOX = 'https://api-m.sandbox.paypal.com';

export type PaypalUmgebung = 'live' | 'sandbox';

/** Zeitlimit je einzelnem Aufruf. Dieselbe Größenordnung wie in
 *  services/patreon.ts und services/gumroad.ts — ein hängender Fremddienst
 *  soll nie ein offenes Ende haben. */
const ANFRAGE_TIMEOUT_MS = 15_000;

/** Zeitbudget für einen GANZEN Abrufdurchgang (Token + Salden + alle
 *  Fenster + alle Seiten). Ohne diese zweite, größere Schranke könnte ein
 *  PayPal, das jede einzelne Anfrage knapp unterhalb des Zeitlimits
 *  beantwortet, den Durchgang beliebig lange laufen lassen. Ist das Budget
 *  aufgebraucht, bricht der Durchgang ab und meldet `vollstaendig: false` —
 *  eine ehrliche Teilantwort statt eines Laufs ohne Ende. */
const DURCHGANG_BUDGET_MS = 60_000;

/** Wie viel Vorlauf vor dem Ablauf des Zugriffstokens genügt. Eine Minute
 *  reicht bei mehreren Stunden Gültigkeit reichlich und verhindert den
 *  Grenzfall, dass der Token zwischen Prüfung und Ankunft der Anfrage bei
 *  PayPal abläuft. */
const TOKEN_VORLAUF_MS = 60_000;

/** Wie oft der Hintergrundlauf nachsieht. Drei Stunden, weil PayPals Daten
 *  selbst bis zu drei Stunden alt sind (siehe Dateikopf, Punkt 4) —
 *  häufiger zu fragen liefert keine neueren Zahlen, kostet aber Anfragen. */
const TAKT_MS = 3 * 60 * 60_000;

/** Der Saldo allein ist EIN Aufruf und beantwortet die häufigste Frage
 *  („wie viel ist drauf"). Den holt ein zweiter, kleinerer Takt öfter, ohne
 *  jedes Mal den ganzen Bewegungsverlauf mitzuziehen. */
const SALDO_TAKT_MS = 30 * 60_000;

/** Wie weit der Bewegungsteil zurückreicht. 13 Wochen (91 Tage) ergeben in
 *  Sieben-Tage-Eimern einen Verlauf, an dem ein Trend erkennbar ist, und
 *  brauchen bei PayPals 31-Tage-Grenze genau drei Fenster. */
const VERLAUF_TAGE = 91;
const FENSTER_TAGE = 31;
const WOCHE_MS = 7 * 24 * 60 * 60_000;

/** Größte Seite, die PayPal zulässt (`page_size`, 1…500). Große Seiten
 *  heißen wenige Aufrufe — genau richtig für einen Raspberry Pi. */
const SEITE_GROESSE = 500;
/** Deckel gegen eine kaputte Seitenzählung. 20 Seiten à 500 sind 10.000
 *  Buchungen je Fenster — weit über allem, was hier vorkommt. Greift der
 *  Deckel, wird das als `vollstaendig: false` gemeldet, nicht verschwiegen. */
const MAX_SEITEN = 20;
/** Wie oft ein zu großes Ergebnisfenster höchstens halbiert wird, ehe
 *  aufgegeben wird: 31 → 16 → 8 → 4 → 2 → 1 Tag. */
const MAX_HALBIERUNGEN = 5;

/** Automatisierte Schreibvorgänge tragen 'system' als Urheber — dieselbe
 *  Konvention wie in services/patreon.ts und services/vorschlaege.ts. */
const SYSTEM = 'system';

/* ── Rechte (Scopes) ───────────────────────────────────────────────────
   Was der Schlüssel wirklich darf, sagt PayPal im Feld `scope` JEDER
   Token-Antwort — das ist die einzige verlässliche Quelle, nicht die
   Vermutung, was im Entwicklerbereich angehakt wurde. Genau derselbe Griff
   wie in services/patreon.ts, und aus demselben Grund: ein fehlendes Recht
   fällt sonst erst an leeren Zahlen in der Oberfläche auf. */
export const PAYPAL_SCOPES_PFLICHT = [
  'https://uri.paypal.com/services/reporting/balances/read',
  'https://uri.paypal.com/services/reporting/search/read',
] as const;

/** Zwei weitere Leserechte desselben Berichtsteils, die es gibt, die diese
 *  Datei aber NICHT anfragt: `…/dataapiserv/balance-net-activity/read` für
 *  `GET /v1/reporting/get-balance-net-summary` und `…/dataapiserv/daily/read`
 *  für `GET /v1/reporting/get-daily-summary`. Beide liefern Tages- und
 *  Nettosummen, die sich aus den ohnehin geholten Buchungen selbst rechnen
 *  lassen (siehe verdichten()). Zwei zusätzliche Rechte für Zahlen, die man
 *  schon hat, wären genau der falsche Tausch. Sie stehen hier nur, damit die
 *  Diagnose ehrlich sagen kann „vorhanden, aber ungenutzt", statt sie
 *  stillschweigend als unbekannt zu führen. */
export const PAYPAL_SCOPES_UNGENUTZT = [
  'https://uri.paypal.com/services/reporting/dataapiserv/balance-net-activity/read',
  'https://uri.paypal.com/services/reporting/dataapiserv/daily/read',
] as const;

/* ── Ablageschlüssel ───────────────────────────────────────────────────
   Eigener Namensraum `bank.paypal.*` in derselben generischen
   app_settings-Tabelle, die auch services/verkaufzugang.ts und
   services/patreon.ts benutzen. Bewusst NICHT `verkauf.*`: der Kontostand
   ist nicht die Verkaufszahl (siehe Kopf von PaypalPanel.tsx), und ein
   eigener Namensraum macht später ein Löschen oder Umziehen zu einer
   einzigen `DELETE … LIKE 'bank.paypal.%'`-Zeile. */
const SCHLUESSEL_CLIENT_ID = 'bank.paypal.clientId';
const SCHLUESSEL_CLIENT_SECRET = 'bank.paypal.clientSecret';
const SCHLUESSEL_UMGEBUNG = 'bank.paypal.umgebung';
const SCHLUESSEL_UEBERSICHT = 'bank.paypal.letzteUebersicht';
const SCHLUESSEL_SCOPE = 'bank.paypal.scope';
const SCHLUESSEL_LETZTER_FEHLER = 'bank.paypal.letzterFehler';
const SCHLUESSEL_LETZTER_FEHLER_DETAIL = 'bank.paypal.letzterFehlerDetail';
const SCHLUESSEL_LETZTER_FEHLER_SEIT = 'bank.paypal.letzterFehlerSeit';
const SCHLUESSEL_LETZTER_VERSUCH = 'bank.paypal.letzterVersuchAm';

/* ══ Zugangsdaten ══════════════════════════════════════════════════════
 *
 * Diese Abteilung gehörte der Bauart des Hauses nach neben die anderen
 * Zugänge — services/verkaufzugang.ts (Gumroad, Patreon) und
 * services/mailzugang.ts. Sie liegt hier, weil verkaufzugang.ts während
 * dieses Auftrags von anderer Seite bearbeitet wird und ein zweiter
 * Schreiber dieselbe Datei nur zerreißen würde. Wer später aufräumt: der
 * Block bis zum nächsten Doppelstrich lässt sich unverändert nach
 * `services/bankzugang.ts` schieben, er hängt an nichts weiter unten.
 *
 * SCHREIBEN, NIE LESEN. Beide Werte gehen verschlüsselt in die Ablage
 * (crypto/pii.ts, derselbe Feldschlüssel wie für Benutzernamen und das
 * Fern-Passwort) und kommen über KEINE Route und in KEINER Antwort wieder
 * heraus — auch nicht gekürzt, auch nicht maskiert, auch nicht für den, der
 * sie eingetragen hat.
 *
 * UND DIE CLIENT-ID? Bei Patreon ist sie die eine ausdrückliche Ausnahme von
 * dieser Regel (siehe Kopf von verkaufzugang.ts): sie kommt entschlüsselt
 * zurück, „damit im Formular sichtbar bleibt, welcher Client hinterlegt
 * ist". Hier NICHT — und das ist eine Entscheidung, keine Nachlässigkeit:
 *
 *   • Der Grund der Patreon-Ausnahme ist ein Unterscheidungsbedarf. Wer
 *     mehrere Patreon-Clients angelegt hat, muss sehen können, welcher davon
 *     eingetragen ist. Diese Firma hat genau EIN PayPal-Geschäftskonto und
 *     darin eine App; es gibt nichts zu unterscheiden.
 *   • PayPal nennt die Client-ID zwar selbst öffentlich („A public
 *     identifier for your PayPal app. Safe to use in client-side code",
 *     developer.paypal.com/apps-scopes-and-credentials) — aber sie ist auch
 *     die Kennung, mit der im Bezahlvorgang der EMPFÄNGER des Geldes benannt
 *     wird. In einem Fenster, das daneben den Kontostand zeigt, ist das ein
 *     Zugewinn an Risiko ohne Zugewinn an Nutzen.
 *   • Eine Ausnahme bleibt nur so lange eine Ausnahme, wie sie eine bleibt.
 *
 * Zurück kommt darum nur, DASS etwas hinterlegt ist.
 */

function clientIdLesen(): string | null {
  return decryptField(getSetting(SCHLUESSEL_CLIENT_ID)) || null;
}
function clientSecretLesen(): string | null {
  return decryptField(getSetting(SCHLUESSEL_CLIENT_SECRET)) || null;
}

export function paypalUmgebung(): PaypalUmgebung {
  return getSetting(SCHLUESSEL_UMGEBUNG) === 'sandbox' ? 'sandbox' : 'live';
}

function basisUrl(): string {
  return paypalUmgebung() === 'sandbox' ? BASIS_SANDBOX : BASIS_LIVE;
}

export interface PaypalZugangStand {
  /** Beides da? Ohne BEIDE Werte kommt kein Token zustande — deshalb ist das
   *  und nicht die bloße Anwesenheit eines der beiden das Kernkriterium. */
  hinterlegt: boolean;
  clientIdHinterlegt: boolean;
  clientSecretHinterlegt: boolean;
  umgebung: PaypalUmgebung;
  /** Ohne Masterpasswort liegen die Werte im Klartext in der Datenbank. Kein
   *  Fehler (dasselbe gilt für Gumroad und Patreon), aber die Verwaltung soll
   *  es wissen — genau wie tokenStand() in verkaufzugang.ts es meldet. */
  verschluesselt: boolean;
}

export function paypalZugangStand(): PaypalZugangStand {
  const id = clientIdLesen();
  const secret = clientSecretLesen();
  return {
    hinterlegt: id !== null && secret !== null,
    clientIdHinterlegt: id !== null,
    clientSecretHinterlegt: secret !== null,
    umgebung: paypalUmgebung(),
    verschluesselt: encryptionActive(),
  };
}

/**
 * Ein weggelassenes Feld lässt den bisherigen Wert stehen; ein ausdrücklich
 * leeres löscht ihn — dieselbe Regel wie bei patreonSetzen() in
 * verkaufzugang.ts. So lässt sich das Secret nach einem Wechsel im
 * PayPal-Entwicklerbereich austauschen, ohne die Client-ID erneut abzutippen.
 *
 * Jede Änderung wirft den zwischengespeicherten Zugriffstoken weg: er gehört
 * zu den ALTEN Zugangsdaten und wäre nach einem Wechsel der Umgebung sogar
 * für den falschen Hostnamen ausgestellt.
 */
export function paypalZugangSetzen(werte: {
  clientId?: string; clientSecret?: string; umgebung?: string;
}, userId: string): void {
  if (werte.clientId !== undefined) {
    const wert = werte.clientId.trim();
    setSetting(SCHLUESSEL_CLIENT_ID, wert ? encryptField(wert) : null, userId);
  }
  if (werte.clientSecret !== undefined) {
    const wert = werte.clientSecret.trim();
    setSetting(SCHLUESSEL_CLIENT_SECRET, wert ? encryptField(wert) : null, userId);
  }
  if (werte.umgebung !== undefined) {
    /* Nur die zwei bekannten Werte werden übernommen; alles andere ist
       'live'. Ein Tippfehler darf nicht dazu führen, dass gegen einen
       Hostnamen gefragt wird, den es nicht gibt. */
    const neueUmgebung: PaypalUmgebung = werte.umgebung === 'sandbox' ? 'sandbox' : 'live';
    /* Ein Wechsel der Umgebung ist ein Wechsel des KONTOS — die bisher
       gezeigten Zahlen gehören dann zu einem anderen Konto und wären nicht
       nur alt, sondern falsch. Also weg damit; bis zum nächsten Abruf zeigt
       die Tafel „noch keine Zahlen". Beim bloßen Austausch des Secrets
       passiert das ABSICHTLICH nicht: da bleibt es dasselbe Konto, und alte
       Zahlen mit ihrem alten Zeitpunkt sind besser als eine leere Tafel. */
    if (neueUmgebung !== paypalUmgebung()) {
      werteStand = null;
      werteGeladen = true;
      setSetting(SCHLUESSEL_UEBERSICHT, null, userId);
      setSetting(SCHLUESSEL_LETZTER_FEHLER, null, userId);
      setSetting(SCHLUESSEL_LETZTER_FEHLER_DETAIL, null, userId);
      setSetting(SCHLUESSEL_LETZTER_FEHLER_SEIT, null, userId);
    }
    setSetting(SCHLUESSEL_UMGEBUNG, neueUmgebung, userId);
  }
  /* Der zwischengespeicherte Zugriffstoken gehört zu den ALTEN Zugangsdaten
     und wäre nach einem Umgebungswechsel sogar für den falschen Hostnamen
     ausgestellt. */
  tokenVergessen();
  /* Und die Rechteauskunft aus der letzten Token-Antwort gilt ebenso nur für
     den alten Schlüssel — sonst behauptete die Diagnose nach einem Wechsel
     Rechte, die der neue Schlüssel vielleicht gar nicht hat. */
  setSetting(SCHLUESSEL_SCOPE, null, userId);
  /* Was in diesem Moment noch unterwegs ist (ein Token-Abruf, ein ganzer
     Durchgang), wurde mit den ALTEN Zugangsdaten gestartet. Kommt es danach
     an, darf es weder den Token-Speicher noch die Zahlen füllen — siehe
     tokenHolen() und paypalAktualisieren(). */
  zugangsFassung += 1;
}

/** Zählt jede Änderung der Zugangsdaten mit. Ein Abruf merkt sich den Stand
 *  bei seinem Start; passt er bei der Ankunft nicht mehr, gehört die Antwort
 *  zu Zugangsdaten, die es nicht mehr gibt (womöglich einem anderen Konto
 *  oder der anderen Umgebung). */
let zugangsFassung = 0;

/* ══ HTTP ══════════════════════════════════════════════════════════════ */

/**
 * Ein Fehler von PayPal, so weit er sich gefahrlos weiterreichen lässt.
 *
 * `debugId` ist PayPals Korrelationskennung aus dem Kopf `paypal-debug-id`
 * bzw. dem Feld `debug_id` — kein Geheimnis, sondern genau die Nummer, nach
 * der PayPals Unterstützung fragt. Sie darf und soll in der Diagnose stehen.
 * Der `rumpf` ist AUSSCHLIESSLICH PayPals Antworttext; niemals ein Teil der
 * eigenen Anfrage, in der die Zugangsdaten stecken.
 */
export class PaypalFehler extends Error {
  constructor(
    readonly status: number,
    readonly rumpf: string,
    readonly debugId: string | null,
    readonly problem: string | null,
    /** ABSICHTLICH kein Anzeigetext, sondern eine technische Marke wie
     *  `paypal:kein-access-token`. Was der Mensch liest, entsteht aus
     *  `code` (siehe fehlerEinordnen unten) im Wörterbuch der Oberfläche —
     *  hier darf kein Satz in irgendeiner Sprache stehen. */
    readonly marke: string,
  ) {
    super(marke);
    this.name = 'PaypalFehler';
  }
}

/* ── Fehler, die die Oberfläche versteht ───────────────────────────────
 *
 * Ein Fehlschlag verlässt diese Datei NIE als fertiger Satz. Er verlässt sie
 * als KENNUNG plus, getrennt davon, PayPals eigenem Wortlaut.
 *
 * Der Grund: die Oberfläche gibt es in 22 Sprachen, der Server kennt keine
 * davon. Ein deutscher Satz aus einer Serverantwort steht in der englischen
 * Oberfläche auf Deutsch — genau das, was hier niemand mehr will. Also
 * schickt der Server `code: 'zugangAbgelehnt'`, und die Tafel macht daraus
 * „Die Zugangsdaten hat PayPal abgelehnt" bzw. „PayPal rejected the
 * credentials".
 *
 * `detail` ist davon ausgenommen und bleibt unübersetzt: das ist PayPals
 * eigener Wortlaut („invalid_client: Client Authentication failed"), so wie
 * ein HTTP-Status auch nicht übersetzt wird. Er steht in der Tafel getrennt
 * und als Fremdtext erkennbar darunter — weil genau dieser Satz derjenige
 * ist, den man beim Nachschlagen oder bei PayPals Unterstützung braucht.
 */
export type PaypalFehlerCode =
  | 'nichtEingerichtet'
  | 'zugangAbgelehnt'
  | 'rechteFehlen'
  | 'zuVieleDaten'
  | 'paypalFehler'
  | 'zeitlimit'
  | 'netz'
  | 'unbekannt';

export interface PaypalFehlerInfo {
  code: PaypalFehlerCode;
  /** PayPals eigener Wortlaut, gekürzt. Enthält NIE einen Teil der eigenen
   *  Anfrage — Client-ID und Secret stehen in einem Kopf, den PayPal nicht
   *  zurückschickt. */
  detail: string | null;
  debugId: string | null;
}

export function fehlerEinordnen(f: unknown): PaypalFehlerInfo {
  if (f instanceof PaypalFehler) {
    if (f.marke === 'paypal:nicht-eingerichtet') {
      return { code: 'nichtEingerichtet', detail: null, debugId: null };
    }
    const detail = [
      `HTTP ${f.status}`,
      f.problem,
      f.rumpf ? f.rumpf.slice(0, 200) : null,
    ].filter(Boolean).join(' · ');

    if (f.problem === 'RESULTSET_TOO_LARGE') return { code: 'zuVieleDaten', detail, debugId: f.debugId };
    if (f.status === 403) return { code: 'rechteFehlen', detail, debugId: f.debugId };
    if (f.status === 401 || f.status === 400) {
      /* Ein 401/400 am Token-Endpunkt heißt „falsche Zugangsdaten"; derselbe
         Status an einem Berichtspfad heißt etwas anderes, deshalb die
         Unterscheidung an der OAuth-Fehlerform, die nur der Token-Endpunkt
         benutzt (live nachgeprüft, siehe tokenHolen). */
      const zugang = f.marke === 'paypal:token' || /invalid_client|unsupported_grant/.test(f.rumpf);
      return { code: zugang ? 'zugangAbgelehnt' : 'paypalFehler', detail, debugId: f.debugId };
    }
    return { code: 'paypalFehler', detail, debugId: f.debugId };
  }

  const err = f as { name?: string; message?: string };
  if (err?.name === 'AbortError') return { code: 'zeitlimit', detail: null, debugId: null };
  /* `fetch` wirft bei Netzproblemen einen TypeError („fetch failed"). Der
     Wortlaut ist englisch und stammt aus der Laufzeitumgebung, nicht aus
     dieser Datei — er darf als Fremdtext ins Detail, so wie PayPals Wortlaut
     auch. */
  if (err?.name === 'TypeError') return { code: 'netz', detail: err.message ?? null, debugId: null };
  return { code: 'unbekannt', detail: err?.message ?? null, debugId: null };
}

/** Prüfstelle für Prüfläufe: die einzige Stelle, an der diese Datei ins Netz
 *  greift. scripts/paypal-pruefung.mts tauscht sie gegen eine Attrappe, die
 *  echte PayPal-Antwortformen (und -Fehlerformen) liefert, ohne dass je ein
 *  Byte das Gerät verlässt. Im Betrieb steht hier `fetch`. */
export type PaypalTransport = (url: string, init: RequestInit) => Promise<Response>;
const STANDARD_TRANSPORT: PaypalTransport = (url, init) => fetch(url, init);
let transport: PaypalTransport = STANDARD_TRANSPORT;
export function paypalTransportSetzen(neu: PaypalTransport | null): void {
  transport = neu ?? STANDARD_TRANSPORT;
}

/**
 * JEDER ausgehende Aufruf dieser Datei geht durch diese Funktion, und damit
 * durch einen AbortController mit Zeitlimit. Kein zweiter Weg nach draußen —
 * das ist der Sinn der einen Stelle: ein hängendes PayPal kann keine Anfrage
 * dieses Servers länger als ANFRAGE_TIMEOUT_MS festhalten.
 */
async function mitZeitlimit(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANFRAGE_TIMEOUT_MS);
  try {
    return await transport(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** PayPals Zeitangaben sind je nach Kontoeinstellung mal streng nach RFC 3339
 *  („…+02:00"), mal in der alten Schreibweise ohne Doppelpunkt im Versatz
 *  („…+0200"). Die zweite Form parst nicht jede Laufzeitumgebung gleich
 *  zuverlässig, deshalb hier ein zweiter Versuch mit eingesetztem
 *  Doppelpunkt, statt sich auf einen Umschalter zu verlassen (PayPal bietet
 *  dafür den Kopf `PayPal-Enforce-ISO8601-Format` an — den setzen wir
 *  bewusst nicht, weil PayPal ihn als Wanderungsschalter für „das neue
 *  Datumsformat UND Plattformänderungen" beschreibt und offenlässt, was
 *  „Plattformänderungen" sonst noch umfasst). */
export function zeitAus(wert: unknown): number | null {
  if (typeof wert !== 'string' || !wert) return null;
  const direkt = Date.parse(wert);
  if (Number.isFinite(direkt)) return direkt;
  const mitDoppelpunkt = wert.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3');
  const zweiter = Date.parse(mitDoppelpunkt);
  return Number.isFinite(zweiter) ? zweiter : null;
}

/* ── Geldbeträge ───────────────────────────────────────────────────────
   PayPal schickt Beträge als Zeichenkette mit Dezimalpunkt („1234.56"), und
   die Zahl der Nachkommastellen hängt an der Währung: JPY hat keine, die
   meisten haben zwei, TND hat drei. Ein fester Cent-Faktor rechnet bei zwei
   von drei Fällen falsch — deshalb hier MIKROEINHEITEN (ein Millionstel der
   Währungseinheit) als gemeinsames, währungsunabhängiges Maß.

   Warum ganze Zahlen und nicht einfach Gleitkomma: Beträge werden hier
   aufsummiert, und 0.1 + 0.2 ist in Gleitkomma bekanntlich nicht 0.3. In
   Mikroeinheiten ist jede Summe exakt, solange sie unter rund neun
   Milliarden Währungseinheiten bleibt — mit Abstand genug.

   Die Oberfläche teilt am Ende durch eine Million und überlässt die richtige
   Zahl Nachkommastellen dem Intl-Währungsformat, das sie je Währung kennt. */
const MIKRO = 1_000_000;

export function mikroAus(wert: unknown): number | null {
  if (typeof wert === 'number') {
    return Number.isFinite(wert) ? Math.round(wert * MIKRO) : null;
  }
  if (typeof wert !== 'string') return null;
  const roh = wert.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(roh)) return null;
  const negativ = roh.startsWith('-');
  const ohneVorzeichen = roh.replace(/^[+-]/, '');
  const [ganz, bruch = ''] = ohneVorzeichen.split('.');
  /* Auf sechs Stellen auffüllen bzw. abschneiden — mehr als sechs
     Nachkommastellen gibt es bei keiner Währung, und abgeschnitten wird
     dann höchstens ein Rundungsrest weit unterhalb des kleinsten
     Zahlungsmittels. */
  const stellen = `${bruch}000000`.slice(0, 6);
  const betrag = Number(ganz) * MIKRO + Number(stellen);
  return negativ ? -betrag : betrag;
}

/* ══ Zugriffstoken ═════════════════════════════════════════════════════ */

interface TokenAntwort {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  app_id?: string;
  nonce?: string;
}

/** Der Token lebt NUR hier, im Arbeitsspeicher, und nur bis zum Neustart.
 *  `laeuft` ist die Einzelspur: fragen fünf Aufrufer gleichzeitig, holt
 *  trotzdem nur einer. */
let tokenStand: { wert: string; gueltigBisAm: number } | null = null;
let tokenLaeuft: Promise<string> | null = null;

function tokenVergessen(): void {
  tokenStand = null;
  tokenLaeuft = null;
}

async function tokenHolen(): Promise<string> {
  const fassung = zugangsFassung;
  const clientId = clientIdLesen();
  const clientSecret = clientSecretLesen();
  /* Technische Marke, kein Anzeigetext — fehlerEinordnen() macht daraus den
     Code 'nichtEingerichtet', und erst die Oberfläche einen Satz. Der eigene
     Fehlertyp und nicht `new Error(...)`: so gibt es in dieser Datei genau
     EINEN Weg, auf dem ein Fehlschlag nach oben geht, und keinen zweiten,
     an dem irgendwann doch ein Satz für Menschen landet. */
  if (!clientId || !clientSecret) {
    throw new PaypalFehler(0, '', null, 'NOT_CONFIGURED', 'paypal:nicht-eingerichtet');
  }

  /* Basic-Auth im KOPF, nicht in der Adresse. Das ist nicht nur PayPals
     Vorgabe, sondern auch der Grund, warum in dieser Datei nie eine URL
     protokolliert werden kann, die ein Geheimnis enthält — anders als bei
     Gumroad, wo der Token als Abfrageparameter mitläuft. */
  const nachweis = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');

  const res = await mitZeitlimit(`${basisUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${nachweis}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    /* Der Token-Endpunkt antwortet NICHT in PayPals sonstiger Fehlerform
       (`name`/`message`/`details`), sondern nach OAuth 2:
       {"error":"invalid_client","error_description":"Client Authentication
       failed"} — live gegen api-m.sandbox.paypal.com nachgeprüft am
       22.08.2026. Wer hier nach `name` sucht, bekommt bei falschen
       Zugangsdaten eine leere Meldung statt der einzigen, die weiterhilft. */
    const text = await res.text().catch(() => '');
    let grund = text.slice(0, 300);
    let problem: string | null = null;
    try {
      const json = JSON.parse(text) as { error?: string; error_description?: string };
      if (json.error) {
        problem = json.error;
        grund = `${json.error}${json.error_description ? `: ${json.error_description}` : ''}`;
      }
    } catch { /* kein JSON — dann eben der rohe Text */ }
    throw new PaypalFehler(res.status, grund, res.headers.get('paypal-debug-id'), problem, 'paypal:token');
  }

  const daten = await res.json() as TokenAntwort;
  if (!daten.access_token) {
    throw new PaypalFehler(res.status, '', res.headers.get('paypal-debug-id'),
      'NO_ACCESS_TOKEN', 'paypal:kein-access-token');
  }

  /* Wurden die Zugangsdaten gewechselt, während diese Anfrage unterwegs
     war, gehört der Token zu den alten: dem Aufrufer, der ihn angefordert
     hat, nützt er nichts mehr (sein Durchgang wird ohnehin verworfen, siehe
     paypalAktualisieren()), und im Zwischenspeicher bediente er bis zu
     seinem Ablauf — Stunden — jeden weiteren Abruf mit dem alten Konto. */
  if (fassung !== zugangsFassung) return daten.access_token;

  /* Die tatsächlich gewährten Rechte merken — die Diagnose vergleicht sie
     später gegen PAYPAL_SCOPES_PFLICHT. Der Token selbst wird NICHT
     gespeichert, nur diese Auskunft darüber, was er darf. */
  setSetting(SCHLUESSEL_SCOPE, daten.scope ?? '', SYSTEM);

  const gueltigBisAm = Date.now() + Math.max(0, Number(daten.expires_in) || 0) * 1000;
  tokenStand = { wert: daten.access_token, gueltigBisAm };
  return daten.access_token;
}

/**
 * Der gültige Zugriffstoken — aus dem Zwischenspeicher, sonst frisch geholt.
 *
 * `erzwingen` ist der Weg für den einen Wiederholungsversuch nach einem 401
 * (siehe Dateikopf, Punkt 2): der bisherige Token wird verworfen und ein
 * neuer geholt, ohne auf sein rechnerisches Ablaufdatum zu warten.
 */
async function zugriffstoken(erzwingen = false): Promise<string> {
  if (erzwingen) tokenVergessen();
  const jetzt = Date.now();
  if (tokenStand && tokenStand.gueltigBisAm - jetzt > TOKEN_VORLAUF_MS) return tokenStand.wert;
  if (tokenLaeuft) return tokenLaeuft;
  tokenLaeuft = tokenHolen().finally(() => { tokenLaeuft = null; });
  return tokenLaeuft;
}

/** Nur für die Diagnose: bis wann gilt der zwischengespeicherte Token?
 *  Gibt den ZEITPUNKT zurück, nie den Token. */
export function tokenGueltigBis(): number | null {
  return tokenStand?.gueltigBisAm ?? null;
}

/* ── Lesende Aufrufe ───────────────────────────────────────────────────── */

/** Steckt in der Fehlerantwort ein bestimmtes Problem? PayPal nennt die
 *  grobe Klasse in `name` (etwa INVALID_REQUEST) und die feine Ursache in
 *  `details[].issue` (etwa RESULTSET_TOO_LARGE). Beide Stellen prüfen, statt
 *  sich auf eine zu verlassen — sonst hängt das Verhalten davon ab, wie
 *  PayPal denselben Fall gerade einsortiert. */
function problemAus(text: string): string | null {
  try {
    const json = JSON.parse(text) as {
      name?: string; details?: { issue?: string }[];
    };
    const feines = json.details?.find((d) => d.issue)?.issue;
    return feines ?? json.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Ein GET gegen PayPals Berichtsteil, mit genau einem Wiederholungsversuch
 * bei 401 (abgelaufener oder zurückgezogener Token) und bei 429 (PayPals
 * Ratenbremse). Alles andere kommt als PaypalFehler zurück — mit Status,
 * Antworttext und `debug_id`, ohne jeden Teil der eigenen Anfrage.
 */
async function paypalGet(pfad: string, suche: Record<string, string>): Promise<any> {
  const url = new URL(`${basisUrl()}${pfad}`);
  for (const [k, v] of Object.entries(suche)) url.searchParams.set(k, v);

  const einmal = async (tokenErzwingen: boolean): Promise<Response> => {
    const token = await zugriffstoken(tokenErzwingen);
    return mitZeitlimit(url.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  };

  let res = await einmal(false);

  if (res.status === 401) {
    /* Ein Token kann auch vor seinem rechnerischen Ablauf ungültig werden —
       etwa weil der Inhaber das Secret gewechselt hat. Genau EIN neuer
       Versuch; scheitert auch der, ist es kein Token-, sondern ein
       Zugangsproblem, und dann soll der Fehler stehen bleiben statt in eine
       Schleife zu laufen. */
    res = await einmal(true);
  } else if (res.status === 429) {
    /* PayPal veröffentlicht keine Ratengrenze („While we do not publish a
       rate limiting policy…", Stand 12.06.2026) und nennt im 429-Fall keinen
       verlässlichen Retry-After. Ein einzelner, kurzer zweiter Versuch —
       gedeckelt, damit ein Diagnoselauf nicht minutenlang hängt; alles
       Weitere überlässt der Hintergrundlauf dem nächsten Takt. */
    await new Promise((f) => setTimeout(f, Math.min(10_000, Number(res.headers.get('retry-after')) * 1000 || 3_000)));
    res = await einmal(false);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const debugId = res.headers.get('paypal-debug-id');
    throw new PaypalFehler(res.status, text.slice(0, 500), debugId, problemAus(text), 'paypal:antwort');
  }
  return res.json();
}

/* ══ Salden ════════════════════════════════════════════════════════════ */

export interface PaypalSaldo {
  waehrung: string;
  /** PayPals eigenes Kennzeichen der Hauptwährung des Kontos. */
  primaer: boolean;
  /** Alles, was dem Konto gehört — einschließlich dessen, was noch nicht
   *  angefasst werden kann. */
  gesamtMikro: number;
  /** Was heute wirklich zur Verfügung steht. */
  verfuegbarMikro: number | null;
  /** Was PayPal zurückhält: Reserven, Sperren, offene Vorgänge. Die
   *  Differenz zwischen „gehört uns" und „können wir benutzen" — genau die
   *  Zahl, die man sonst erst merkt, wenn eine Zahlung nicht durchgeht. */
  einbehaltenMikro: number | null;
  /** Richtwert in Euro, umgerechnet mit dem EZB-Referenzkurs des unten
   *  genannten Tages (services/wechselkurse.ts). Nur Anzeige, nie Grundlage
   *  einer Buchung — und `null`, wenn kein Kurs zu bekommen war, statt einer
   *  erfundenen Zahl. Bei einem Euro-Saldo bleibt es null: da gibt es nichts
   *  umzurechnen. */
  euroMikro: number | null;
  kursQuelldatum: string | null;
}

interface SaldoAntwort {
  balances?: {
    currency?: string;
    primary?: boolean;
    total_balance?: { currency_code?: string; value?: string };
    available_balance?: { currency_code?: string; value?: string };
    withheld_balance?: { currency_code?: string; value?: string };
  }[];
  account_id?: string;
  as_of_time?: string;
  last_refresh_time?: string;
}

async function saldenHolen(): Promise<{ salden: PaypalSaldo[]; standPaypal: number | null }> {
  const json = await paypalGet('/v1/reporting/balances', {}) as SaldoAntwort;
  const salden: PaypalSaldo[] = (json.balances ?? []).map((b) => ({
    waehrung: b.currency ?? b.total_balance?.currency_code ?? '?',
    primaer: b.primary === true,
    gesamtMikro: mikroAus(b.total_balance?.value) ?? 0,
    verfuegbarMikro: mikroAus(b.available_balance?.value),
    einbehaltenMikro: mikroAus(b.withheld_balance?.value),
    euroMikro: null,
    kursQuelldatum: null,
  }));
  /* `last_refresh_time` ist PayPals eigene Aussage darüber, wie frisch der
     Stand IST — nicht wann wir gefragt haben. Fehlt sie, fällt `as_of_time`
     ein; fehlt auch die, bleibt es null, und die Oberfläche sagt dann
     ehrlich „unbekannt" statt unsere Abrufzeit als Datenalter auszugeben. */
  return { salden, standPaypal: zeitAus(json.last_refresh_time) ?? zeitAus(json.as_of_time) };
}

/* ══ Bewegungen ════════════════════════════════════════════════════════ */

/** Eine Buchung, auf das reduziert, was für Summen gebraucht wird. Mehr
 *  wird gar nicht erst aus PayPals Antwort übernommen — siehe Dateikopf,
 *  „Was absichtlich nicht abgerufen wird". */
export interface PaypalBuchung {
  zeit: number | null;
  waehrung: string;
  betragMikro: number;
  gebuehrMikro: number;
  /** 'S' erfolgreich · 'P' schwebend · 'D' abgelehnt · 'V' storniert */
  status: string;
  /** PayPals fünfstelliger Ereigniscode, etwa T0006 (Express-Checkout-
   *  Zahlung) oder T0400 (Auszahlung aufs Bankkonto). */
  code: string;
}

interface BewegungAntwort {
  transaction_details?: {
    transaction_info?: {
      transaction_amount?: { currency_code?: string; value?: string };
      fee_amount?: { currency_code?: string; value?: string };
      transaction_status?: string;
      transaction_event_code?: string;
      transaction_initiation_date?: string;
      transaction_updated_date?: string;
    };
  }[];
  total_items?: number;
  total_pages?: number;
  page?: number;
  last_refreshed_datetime?: string;
}

function rfc3339(ms: number): string {
  /* Sekunden sind Pflicht, Bruchteile sind erlaubt aber unnötig; die
     Mindestlänge des Feldes ist 20 Zeichen, und genau so lang ist diese
     Form. */
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Ein Zeitfenster abrufen, notfalls in Hälften.
 *
 * PayPal lehnt eine zu große Ergebnismenge mit `RESULTSET_TOO_LARGE` ab,
 * statt sie zu kürzen (siehe Dateikopf, Punkt 3). Die Antwort darauf kann
 * nicht „mehr Seiten holen" sein — das Ergebnis entsteht ja gar nicht erst.
 * Sie kann nur „engeren Zeitraum fragen" sein, und genau das tut diese
 * Funktion: sie halbiert und ruft sich selbst zweimal auf, bis hinunter auf
 * einen Tag. Ohne diese Behandlung hätte ein wachsendes Geschäft eines Tages
 * statt eines Verlaufs eine Fehlermeldung.
 */
async function fensterHolen(
  vonMs: number, bisMs: number, frist: number, tiefe = 0,
): Promise<{ buchungen: PaypalBuchung[]; vollstaendig: boolean }> {
  const buchungen: PaypalBuchung[] = [];
  let vollstaendig = true;

  for (let seite = 1; seite <= MAX_SEITEN; seite += 1) {
    if (Date.now() > frist) return { buchungen, vollstaendig: false };

    let json: BewegungAntwort;
    try {
      json = await paypalGet('/v1/reporting/transactions', {
        start_date: rfc3339(vonMs),
        end_date: rfc3339(bisMs),
        /* Vorgabewert, bewusst ausgeschrieben: `transaction_info` und NICHTS
           sonst — kein payer_info, kein shipping_info. */
        fields: 'transaction_info',
        /* Vorgabewert 'Y', ebenfalls bewusst ausgeschrieben: nur Buchungen,
           die den Saldo bewegen. Mit 'N' kämen auch Autorisierungen mit, die
           nie Geld bewegen — die Summen unten würden dann nicht mehr zum
           Kontostand passen, und genau dieser Abgleich ist der Sinn der
           Sache. */
        balance_affecting_records_only: 'Y',
        page_size: String(SEITE_GROESSE),
        page: String(seite),
      }) as BewegungAntwort;
    } catch (f) {
      if (f instanceof PaypalFehler && f.problem === 'RESULTSET_TOO_LARGE' && tiefe < MAX_HALBIERUNGEN) {
        const mitte = vonMs + Math.floor((bisMs - vonMs) / 2);
        /* `mitte` ist zugleich das Ende von `links` und (unverändert) der
           Beginn von `rechts` — beide Enden sind bei PayPal inklusiv, also
           läge eine Buchung genau in dieser Sekunde in BEIDEN Hälften. Die
           ältere Hälfte (`links`) bekommt die Grenzsekunde, `rechts` startet
           eine Sekunde später. rfc3339() rundet ohnehin auf ganze Sekunden
           ab, darum ist ein Sprung um exakt 1000 ms hier immer „die nächste
           Sekunde", unabhängig von Millisekundenresten in `mitte`. */
        const links = await fensterHolen(vonMs, mitte, frist, tiefe + 1);
        const rechts = await fensterHolen(mitte + 1000, bisMs, frist, tiefe + 1);
        return {
          buchungen: [...links.buchungen, ...rechts.buchungen],
          vollstaendig: links.vollstaendig && rechts.vollstaendig,
        };
      }
      throw f;
    }

    for (const d of json.transaction_details ?? []) {
      const i = d.transaction_info;
      if (!i) continue;
      const betrag = mikroAus(i.transaction_amount?.value);
      if (betrag === null) continue;
      buchungen.push({
        zeit: zeitAus(i.transaction_initiation_date) ?? zeitAus(i.transaction_updated_date),
        waehrung: i.transaction_amount?.currency_code ?? '?',
        betragMikro: betrag,
        gebuehrMikro: mikroAus(i.fee_amount?.value) ?? 0,
        status: i.transaction_status ?? 'S',
        code: i.transaction_event_code ?? '',
      });
    }

    const seitenGesamt = Number(json.total_pages ?? 1);
    if (!Number.isFinite(seitenGesamt) || seite >= seitenGesamt) break;
    if (seite === MAX_SEITEN) vollstaendig = false;   // Deckel griff — ehrlich melden
  }

  return { buchungen, vollstaendig };
}

/* ══ Verdichten ════════════════════════════════════════════════════════ */

export interface PaypalWocheneimer {
  /** Erster Tag des Sieben-Tage-Eimers, UTC, als 'JJJJ-MM-TT'. */
  start: string;
  eingangMikro: number;
  ausgangMikro: number;
  gebuehrenMikro: number;
  nettoMikro: number;
}

export interface PaypalBewegung {
  waehrung: string;
  /** Alles, was im Fenster hereinkam (brutto, vor Gebühren). */
  eingangMikro: number;
  /** Alles, was hinausging — Erstattungen, Rückbuchungen, Auszahlungen
   *  aufs Bankkonto, Käufe. Als positive Zahl. */
  ausgangMikro: number;
  /** Was PayPal für sich einbehalten hat. Steckt bei PayPal AM VORGANG
   *  (`fee_amount`), nicht in einer eigenen Buchung — deshalb hier eine
   *  eigene Summe und nicht Teil von `ausgangMikro`. */
  gebuehrenMikro: number;
  /** eingang − ausgang − gebühren. Das ist die Zahl, um die sich der Saldo
   *  im Fenster verändert haben sollte. */
  nettoMikro: number;
  /** Schwebend („pending"): angekündigt, noch nicht gutgeschrieben. Die
   *  ehrliche Antwort auf „was kommt noch". */
  offenEingangMikro: number;
  offenAusgangMikro: number;
  /** Was hier eine zweite Betrachtung verdient. */
  erstattungen: { anzahl: number; mikro: number };
  rueckbuchungen: { anzahl: number; mikro: number };
  /** Abgebucht aufs eigene Bankkonto (T0400/T0401). Steckt in `ausgangMikro`
   *  mit drin — hier noch einmal einzeln, damit eine große Abbuchung nicht
   *  wie eine große Ausgabe aussieht. */
  zurBank: { anzahl: number; mikro: number };
  /** Von PayPal oder den eigenen Regeln abgelehnt (Status 'D'). */
  abgelehntAnzahl: number;
  /** Nachträglich rückabgewickelt (Status 'V'). Bewusst NUR gezählt und
   *  NICHT in die Summen gerechnet: die Rückabwicklung selbst steht als
   *  eigene Buchung (T11xx, Status 'S') schon in `ausgangMikro`. Beides zu
   *  addieren hieße, dasselbe Geld zweimal abzuziehen. */
  storniertAnzahl: number;
  wochen: PaypalWocheneimer[];
}

function leereBewegung(waehrung: string): PaypalBewegung {
  return {
    waehrung,
    eingangMikro: 0, ausgangMikro: 0, gebuehrenMikro: 0, nettoMikro: 0,
    offenEingangMikro: 0, offenAusgangMikro: 0,
    erstattungen: { anzahl: 0, mikro: 0 },
    rueckbuchungen: { anzahl: 0, mikro: 0 },
    zurBank: { anzahl: 0, mikro: 0 },
    abgelehntAnzahl: 0, storniertAnzahl: 0,
    wochen: [],
  };
}

function tagUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Aus rohen Buchungen die Summen je Währung.
 *
 * Vorzeichen kommen von PayPal, nicht aus einer eigenen Tabelle: ein
 * abgehender Betrag ist bei PayPal negativ. Der Ereigniscode (T-Code)
 * entscheidet hier nur über die EINORDNUNG (Erstattung, Rückbuchung,
 * Abbuchung), nie über die Richtung — PayPals eigene Übersicht führt jeden
 * T-Code als `CR`/`DR`, also in beide Richtungen möglich, und wer die
 * Richtung aus dem Code ableitet, liegt bei jedem zweiten Fall falsch.
 */
export function verdichten(
  buchungen: PaypalBuchung[], bisMs: number, wochenAnzahl: number,
): PaypalBewegung[] {
  const karte = new Map<string, PaypalBewegung>();
  /* Eimergrenzen einmal vorab: der letzte Eimer endet bei `bisMs`, jeder
     weitere liegt sieben Tage davor. UTC, nicht Ortszeit — sonst verschöbe
     sich der Verlauf, je nachdem wer gerade hinsieht. */
  const eimerStart: number[] = [];
  for (let i = wochenAnzahl - 1; i >= 0; i -= 1) eimerStart.push(bisMs - (i + 1) * WOCHE_MS);

  const hole = (waehrung: string): PaypalBewegung => {
    let b = karte.get(waehrung);
    if (!b) {
      b = leereBewegung(waehrung);
      b.wochen = eimerStart.map((s) => ({
        start: tagUtc(s), eingangMikro: 0, ausgangMikro: 0, gebuehrenMikro: 0, nettoMikro: 0,
      }));
      karte.set(waehrung, b);
    }
    return b;
  };

  for (const buchung of buchungen) {
    const b = hole(buchung.waehrung);

    if (buchung.status === 'D') { b.abgelehntAnzahl += 1; continue; }
    if (buchung.status === 'V') { b.storniertAnzahl += 1; continue; }
    if (buchung.status === 'P') {
      if (buchung.betragMikro >= 0) b.offenEingangMikro += buchung.betragMikro;
      else b.offenAusgangMikro += -buchung.betragMikro;
      continue;
    }

    /* Ab hier: Status 'S' — wirklich passiert. */
    const gebuehr = buchung.gebuehrMikro < 0 ? -buchung.gebuehrMikro : 0;
    b.gebuehrenMikro += gebuehr;
    if (buchung.betragMikro >= 0) b.eingangMikro += buchung.betragMikro;
    else b.ausgangMikro += -buchung.betragMikro;

    if (buchung.code.startsWith('T11')) {
      b.erstattungen.anzahl += 1;
      b.erstattungen.mikro += Math.abs(buchung.betragMikro);
    } else if (buchung.code.startsWith('T12')) {
      b.rueckbuchungen.anzahl += 1;
      b.rueckbuchungen.mikro += Math.abs(buchung.betragMikro);
    } else if (buchung.code === 'T0400' || buchung.code === 'T0401') {
      b.zurBank.anzahl += 1;
      b.zurBank.mikro += Math.abs(buchung.betragMikro);
    }

    if (buchung.zeit !== null) {
      const index = eimerStart.findIndex((s, i) => buchung.zeit! >= s
        && (i === eimerStart.length - 1 ? buchung.zeit! <= bisMs : buchung.zeit! < eimerStart[i + 1]));
      if (index >= 0) {
        const e = b.wochen[index];
        if (buchung.betragMikro >= 0) e.eingangMikro += buchung.betragMikro;
        else e.ausgangMikro += -buchung.betragMikro;
        e.gebuehrenMikro += gebuehr;
      }
    }
  }

  for (const b of karte.values()) {
    b.nettoMikro = b.eingangMikro - b.ausgangMikro - b.gebuehrenMikro;
    for (const e of b.wochen) e.nettoMikro = e.eingangMikro - e.ausgangMikro - e.gebuehrenMikro;
  }
  /* Die Währung mit dem meisten Umsatz zuerst — die Oberfläche zeigt sie
     oben, und das ist in aller Regel die, um die es geht. */
  return [...karte.values()].sort(
    (x, y) => (y.eingangMikro + y.ausgangMikro) - (x.eingangMikro + x.ausgangMikro),
  );
}

/* ══ Die Übersicht ═════════════════════════════════════════════════════ */

export interface PaypalWerte {
  /** Wann WIR geholt haben. */
  standUnser: number;
  /** Wann der Stand bei PAYPAL frisch war (`last_refresh_time`). `null`,
   *  wenn PayPal nichts dazu gesagt hat — dann ist „unbekannt" die einzige
   *  ehrliche Auskunft, siehe Dateikopf Punkt 4. */
  standPaypal: number | null;
  /** Alle Seiten und alle Fenster geschafft? Bei `false` sind die
   *  Bewegungszahlen eine Untergrenze, nicht die Wahrheit. */
  vollstaendig: boolean;
  /** Wie viele Tage der Bewegungsteil umfasst. */
  fensterTage: number;
  salden: PaypalSaldo[];
  bewegung: PaypalBewegung[];
}

export type PaypalZustand = 'nichtEingerichtet' | 'fehler' | 'aktuell';

export interface PaypalUebersicht {
  zustand: PaypalZustand;
  umgebung: PaypalUmgebung;
  /** Nur bei `zustand: 'fehler'` gesetzt — und dann als KENNUNG, nicht als
   *  Satz: die Oberfläche macht daraus ihren eigenen Text in ihrer eigenen
   *  Sprache (siehe PaypalFehlerCode oben). `null` heißt hier „eingerichtet,
   *  aber noch kein Durchgang gelaufen" — kein Fehler, nur noch nichts da. */
  fehlerCode: PaypalFehlerCode | null;
  /** PayPals eigener Wortlaut, unübersetzt und als Fremdtext gekennzeichnet.
   *  Nie Client-ID, Secret oder Token, auch nicht in Teilen. */
  fehlerDetail: string | null;
  fehlerSeit: number | null;
  /** Die zuletzt bekannten Zahlen. Bei `zustand: 'fehler'` sind sie ALT —
   *  ihr eigener `standUnser` sagt, wie alt. Bei `nichtEingerichtet` null.
   *  Ein leeres Konto ist `zustand: 'aktuell'` mit leeren `salden`, kein
   *  `null` — sonst sähe „leer" wieder aus wie „nicht eingerichtet". */
  werte: PaypalWerte | null;
}

/* Der Zwischenspeicher im Arbeitsspeicher. Die Ablage in app_settings ist
   nur die Kopie für den Neustart — ohne sie stünde das Fenster nach jedem
   Update-Neustart des Pi minutenlang leer, obwohl es die Zahlen gerade eben
   noch gab. */
let werteStand: PaypalWerte | null = null;
let werteGeladen = false;

/** Die verdichteten Zahlen gehen VERSCHLÜSSELT in die Ablage — mit demselben
 *  Feldschlüssel wie die Zugangsdaten (crypto/pii.ts). Es sind keine
 *  personenbezogenen Daten (nur Summen, Zähler, Währungskürzel), aber es ist
 *  der Kontostand der Firma; permissions.ts begründet an der Stelle von
 *  `verkauf.sehen` genau diesen Unterschied zwischen Betriebszahlen und
 *  Geldzahlen. Wer die Datenbankdatei in die Hand bekommt, soll ihn nicht
 *  nebenbei mitlesen. */
function werteSichern(w: PaypalWerte): void {
  try {
    setSetting(SCHLUESSEL_UEBERSICHT, encryptField(JSON.stringify(w)), SYSTEM);
  } catch (f) {
    console.error('[paypal] Übersicht ließ sich nicht ablegen:', (f as Error)?.message ?? f);
  }
}

function werteLaden(): PaypalWerte | null {
  if (werteGeladen) return werteStand;
  werteGeladen = true;
  const roh = decryptField(getSetting(SCHLUESSEL_UEBERSICHT));
  if (!roh) return null;
  try {
    werteStand = JSON.parse(roh) as PaypalWerte;
  } catch {
    /* Ein kaputter oder mit einem anderen Masterpasswort geschriebener
       Eintrag ist kein Grund abzustürzen — er ist schlicht kein Stand. Der
       nächste Abrufdurchgang schreibt ihn neu. */
    werteStand = null;
  }
  return werteStand;
}

/**
 * Der Stand, wie ihn die Oberfläche bekommt — OHNE Netzzugriff.
 *
 * Diese Funktion fragt PayPal nie. Sie liest den Zwischenspeicher und
 * beantwortet daraus die drei Zustände. Das ist der ganze Grund, warum es
 * den Hintergrundlauf gibt: eine Ansicht, die beim Öffnen einen fremden
 * Dienst befragt, ist so schnell wie dieser Dienst gerade ist — und auf
 * einem Raspberry Pi mit zehn Leuten heißt das, dass ein langsames PayPal
 * alle warten lässt.
 */
export function paypalUebersicht(): PaypalUebersicht {
  const zugang = paypalZugangStand();
  const umgebung = zugang.umgebung;
  if (!zugang.hinterlegt) {
    return {
      zustand: 'nichtEingerichtet', umgebung,
      fehlerCode: null, fehlerDetail: null, fehlerSeit: null, werte: null,
    };
  }

  const werte = werteLaden();
  const code = getSetting(SCHLUESSEL_LETZTER_FEHLER) as PaypalFehlerCode | null;
  if (code) {
    const seitRoh = getSetting(SCHLUESSEL_LETZTER_FEHLER_SEIT);
    return {
      zustand: 'fehler', umgebung,
      fehlerCode: code,
      fehlerDetail: getSetting(SCHLUESSEL_LETZTER_FEHLER_DETAIL),
      fehlerSeit: seitRoh ? Number(seitRoh) : null,
      werte,
    };
  }
  if (!werte) {
    /* Eingerichtet, noch kein Durchgang gelaufen und auch kein Fehler
       vermerkt: das ist der Zustand zwischen „Zugangsdaten gespeichert" und
       „erster Abruf fertig". Als 'aktuell' mit leeren Zahlen auszugeben wäre
       schlimmer als alles andere — dann sähe es aus wie ein leeres Konto.
       Also 'fehler' OHNE Kennung: die Tafel liest das als „noch nichts da"
       und zeigt ihren eigenen Wartetext (siehe PaypalPanel.tsx). */
    return {
      zustand: 'fehler', umgebung,
      fehlerCode: null, fehlerDetail: null, fehlerSeit: null, werte: null,
    };
  }
  return { zustand: 'aktuell', umgebung, fehlerCode: null, fehlerDetail: null, fehlerSeit: null, werte };
}

/* ══ Der Abrufdurchgang ════════════════════════════════════════════════ */

let durchgangLaeuft: Promise<PaypalWerte> | null = null;
/** Mit welchem Stand der Zugangsdaten (zugangsFassung) der laufende Durchgang
 *  gestartet wurde. */
let durchgangFassung = 0;
let letzterVollerDurchgang = 0;

async function euroKurseNachtragen(salden: PaypalSaldo[]): Promise<void> {
  /* Nur wenn es überhaupt etwas umzurechnen gibt: bei einem einzigen
     Euro-Konto — dem Normalfall hier — passiert gar nichts, und dann wird
     auch kein fremder Kursdienst behelligt. */
  const fremde = salden.filter((s) => s.waehrung !== 'EUR' && s.waehrung !== '?');
  if (fremde.length === 0) return;

  kursZaehlerZuruecksetzen();
  const heute = tagUtc(Date.now());
  for (const s of fremde) {
    /* Der Kurs des heutigen Tages: api.frankfurter.dev löst ein Datum ohne
       Notierung (Wochenende, Feiertag) selbst auf den letzten Handelstag auf
       und nennt ihn in `quelldatum` — den zeigt die Oberfläche mit an, damit
       „Richtwert von wann" beantwortbar bleibt. Ein Fehlschlag lässt
       `euroMikro` auf null: lieber keine Umrechnung als eine erfundene. */
    const kurs = await kursFuerDatum(heute, s.waehrung, 'EUR');
    if (!kurs) continue;
    s.euroMikro = Math.round(s.gesamtMikro * kurs.kurs);
    s.kursQuelldatum = kurs.quelldatum ?? heute;
  }
}

async function durchgangAusfuehren(nurSalden: boolean): Promise<PaypalWerte> {
  const frist = Date.now() + DURCHGANG_BUDGET_MS;
  setSetting(SCHLUESSEL_LETZTER_VERSUCH, String(Date.now()), SYSTEM);

  const { salden, standPaypal } = await saldenHolen();
  await euroKurseNachtragen(salden);

  const vorher = werteLaden();
  if (nurSalden && vorher) {
    /* Der kleine Takt: nur der Saldo ist neu, der Bewegungsteil bleibt
       stehen — mit SEINEM Zeitpunkt. Deshalb wandert `standUnser` mit dem
       Saldo mit, `fensterTage`/`bewegung` aber unverändert aus dem letzten
       vollen Durchgang. */
    return { ...vorher, standUnser: Date.now(), standPaypal, salden };
  }

  const bisMs = Date.now();
  const vonMs = bisMs - VERLAUF_TAGE * 24 * 60 * 60_000;
  const buchungen: PaypalBuchung[] = [];
  let vollstaendig = true;

  /* Von hinten nach vorn in Fenstern von höchstens FENSTER_TAGE Tagen —
     PayPals harte Grenze (siehe Dateikopf, Punkt 3). Das jüngste Fenster
     zuerst: reicht das Zeitbudget nicht für alle, fehlen die ÄLTESTEN
     Wochen, nicht die letzten Tage. */
  let fensterBis = bisMs;
  while (fensterBis > vonMs) {
    if (Date.now() > frist) { vollstaendig = false; break; }
    const fensterVon = Math.max(vonMs, fensterBis - FENSTER_TAGE * 24 * 60 * 60_000);
    /* `fensterBis` dieses Durchlaufs wird im nächsten Durchlauf zu
       `fensterVon` des NÄCHSTEN (älteren) Fensters — und beide Enden sind
       bei PayPal inklusiv. Ohne Korrektur läge eine Buchung genau in dieser
       Grenzsekunde in beiden Fenstern und würde doppelt gezählt. Die Lösung
       ist keine Deduplizierung nach dem Holen, sondern eine, die von
       vornherein verhindert, dass die Sekunde zweimal angefragt wird: jedes
       Fenster außer dem ältesten (das an `vonMs` grenzt, wo es keinen älteren
       Nachbarn gibt, der die Sekunde beanspruchen könnte) fragt eine Sekunde
       NACH seiner eigentlichen unteren Grenze ab. Die Grenzsekunde selbst
       bleibt so immer genau einem — dem älteren — Fenster zugeordnet, nie
       keinem und nie beiden. */
    const holVon = fensterVon > vonMs ? fensterVon + 1000 : fensterVon;
    const teil = await fensterHolen(holVon, fensterBis, frist);
    buchungen.push(...teil.buchungen);
    if (!teil.vollstaendig) vollstaendig = false;
    fensterBis = fensterVon;
  }

  letzterVollerDurchgang = Date.now();
  return {
    standUnser: Date.now(),
    standPaypal,
    vollstaendig,
    fensterTage: VERLAUF_TAGE,
    salden,
    bewegung: verdichten(buchungen, bisMs, Math.floor(VERLAUF_TAGE / 7)),
  };
}

/**
 * Einen Abrufdurchgang anstoßen — höchstens einen gleichzeitig.
 *
 * Die Einzelspur (`durchgangLaeuft`) ist hier wichtiger als bei Gumroad oder
 * Patreon: ein voller Durchgang macht bis zu einem guten Dutzend Aufrufe.
 * Ohne die Sperre könnten ein fälliger Takt und ein Knopfdruck im Fenster
 * gleichzeitig loslaufen und sich auf einem Pi gegenseitig ausbremsen —
 * genau die Art Stapelung, die einmal für zwanzig Sekunden stehende
 * Ereignisschleife gesorgt hat.
 */
export async function paypalAktualisieren(
  opts: { nurSalden?: boolean } = {},
): Promise<{ ok: boolean; code?: PaypalFehlerCode; detail?: string | null }> {
  if (!paypalZugangStand().hinterlegt) return { ok: false, code: 'nichtEingerichtet', detail: null };
  if (durchgangLaeuft) {
    /* Ein bereits laufender Durchgang wird MITBENUTZT, nicht abgewartet und
       dann noch einmal gemacht. Scheitert er, hat er seinen Fehler bereits
       selbst vermerkt — der Mitbenutzer liest ihn aus der Ablage.
       Ausnahme: er läuft noch mit Zugangsdaten, die inzwischen gewechselt
       wurden (der typische Fall: speichern, dann sofort „aktualisieren").
       Dann wird er abgewartet und danach frisch gefragt — sein Ergebnis
       gehört zum alten Schlüssel und taugt nicht als Antwort. */
    const veraltet = durchgangFassung !== zugangsFassung;
    try {
      await durchgangLaeuft;
      if (!veraltet) return { ok: true };
    } catch (f) {
      if (!veraltet) {
        const info = fehlerEinordnen(f);
        return { ok: false, code: info.code, detail: info.detail };
      }
    }
    return paypalAktualisieren(opts);
  }

  const fassung = zugangsFassung;
  durchgangFassung = fassung;
  durchgangLaeuft = durchgangAusfuehren(opts.nurSalden === true)
    .finally(() => { durchgangLaeuft = null; });

  try {
    const werte = await durchgangLaeuft;
    /* Während des Durchgangs (bis zu DURCHGANG_BUDGET_MS) wurden die
       Zugangsdaten gewechselt: die Zahlen gehören zum alten Schlüssel,
       womöglich zur anderen Umgebung. paypalZugangSetzen() hat die Tafel
       für genau diesen Fall geleert — sie hier wieder zu füllen, zeigte
       „aktuell" mit dem Kontostand eines anderen Kontos. */
    if (fassung !== zugangsFassung) return paypalAktualisieren(opts);
    werteStand = werte;
    werteGeladen = true;
    werteSichern(werte);
    setSetting(SCHLUESSEL_LETZTER_FEHLER, null, SYSTEM);
    setSetting(SCHLUESSEL_LETZTER_FEHLER_DETAIL, null, SYSTEM);
    setSetting(SCHLUESSEL_LETZTER_FEHLER_SEIT, null, SYSTEM);
    return { ok: true };
  } catch (f) {
    // Ein Fehlschlag mit den alten Zugangsdaten sagt über die neuen nichts.
    if (fassung !== zugangsFassung) return paypalAktualisieren(opts);
    const info = fehlerEinordnen(f);
    /* Der Zeitpunkt des ERSTEN Fehlschlags bleibt stehen, solange es nicht
       wieder klappt: „scheitert seit 11:02" ist eine andere Auskunft als
       „scheitert seit gerade eben", und nur die erste verrät, dass etwas
       länger kaputt ist. */
    if (!getSetting(SCHLUESSEL_LETZTER_FEHLER)) {
      setSetting(SCHLUESSEL_LETZTER_FEHLER_SEIT, String(Date.now()), SYSTEM);
    }
    setSetting(SCHLUESSEL_LETZTER_FEHLER, info.code, SYSTEM);
    setSetting(SCHLUESSEL_LETZTER_FEHLER_DETAIL, info.detail, SYSTEM);
    /* Im Protokoll steht die Kennung und PayPals Wortlaut — nie ein Teil der
       eigenen Anfrage. */
    console.error('[paypal]', info.code, info.detail ?? '', info.debugId ? `debug_id=${info.debugId}` : '');
    return { ok: false, code: info.code, detail: info.detail };
  }
}

/**
 * Der Hintergrundlauf. Gleiche Form wie patreon.startPatreonErneuerungJob():
 * eine Funktion zum Anhalten, damit startBackgroundJobs() im Gateway sie in
 * einer Zeile einhängen kann.
 *
 * Zwei Takte, weil die beiden Abrufe unterschiedlich teuer sind: der Saldo
 * ist EIN Aufruf und beantwortet die häufigste Frage, der Verlauf sind
 * mehrere und ändert sich träge. Beide teilen sich dieselbe Einzelspur, also
 * können sie sich nicht überholen.
 *
 * Der erste, volle Durchgang startet ABSICHTLICH nicht sofort, sondern nach
 * ANLAUF_MS: beim Start eines Servers auf einem Pi ist ohnehin genug los
 * (Datenbank, Nachrüstungen, WebSocket), und ein Fremddienst, der nicht
 * antwortet, soll sich da nicht dazwischendrängen.
 */
const ANLAUF_MS = 20_000;

export function startPaypalJob(): () => void {
  let anlauf: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    anlauf = null;
    void paypalAktualisieren().catch(() => { /* schon protokolliert */ });
  }, ANLAUF_MS);

  const vollerTakt = setInterval(() => {
    void paypalAktualisieren().catch(() => { /* schon protokolliert */ });
  }, TAKT_MS);

  const saldoTakt = setInterval(() => {
    /* Kein eigener Saldo-Lauf, wenn der volle Durchgang ohnehin gerade fällig
       war — sonst zwei Abrufe im Abstand von Sekunden. */
    if (Date.now() - letzterVollerDurchgang < SALDO_TAKT_MS) return;
    void paypalAktualisieren({ nurSalden: true }).catch(() => { /* schon protokolliert */ });
  }, SALDO_TAKT_MS);

  return () => {
    if (anlauf) clearTimeout(anlauf);
    clearInterval(vollerTakt);
    clearInterval(saldoTakt);
  };
}

/* ══ Diagnose ══════════════════════════════════════════════════════════ */

export interface PaypalDiagnose {
  eingerichtet: boolean;
  umgebung: PaypalUmgebung;
  /** Ohne Masterpasswort liegen die Zugangsdaten im Klartext — kein Fehler,
   *  aber eine Auskunft, die der Inhaber haben soll. */
  verschluesselt: boolean;
  token: {
    geholt: boolean;
    /** Zeitpunkt, NIE der Token. */
    gueltigBisAm: number | null;
    fehler: PaypalFehlerInfo | null;
  };
  scope: {
    roh: string | null;
    vorhanden: Record<string, boolean>;
    pflichtFehlt: string[];
    /** Rechte, die der Schlüssel trägt, die diese App aber gar nicht
     *  benutzt — siehe PAYPAL_SCOPES_UNGENUTZT. Kein Fehler, nur eine
     *  Auskunft: wer sie nicht braucht, kann sie im Entwicklerbereich
     *  wieder abwählen. */
    ungenutztVorhanden: string[];
  };
  salden: {
    abgerufen: boolean;
    waehrungen: string[];
    standPaypal: number | null;
    fehler: PaypalFehlerInfo | null;
  };
  bewegung: {
    abgerufen: boolean;
    /** Wie viele Buchungen in EINEM Fenster von sieben Tagen. Bewusst ein
     *  kurzes Fenster: die Diagnose soll beweisen, dass der Weg funktioniert,
     *  nicht den ganzen Verlauf noch einmal holen. */
    zeilen: number;
    vollstaendig: boolean;
    fehler: PaypalFehlerInfo | null;
  };
  /** PayPals Korrelationskennung des letzten fehlgeschlagenen Aufrufs — kein
   *  Geheimnis, sondern genau das, wonach PayPals Unterstützung fragt. */
  debugId: string | null;
  /** Der stille Fehlschlag: die Bewegungen kommen, die Salden sind leer.
   *  Das heißt fast immer „das Recht für die Salden fehlt", nicht „das Konto
   *  ist leer" — und ohne diesen Hinweis sieht beides gleich aus. */
  stillerAusfallVerdacht: boolean;
  /** Eine KENNUNG, kein Satz — die Oberfläche macht daraus ihren Text.
   *  Siehe PaypalFehlerCode oben für dieselbe Begründung. */
  hinweis: 'nichtEingerichtet' | 'tokenFehlgeschlagen' | 'rechteFehlen'
    | 'saldenLeerTrotzBewegung' | 'abrufFehlgeschlagen' | null;
}

/**
 * Der Prüflauf gegen die echte Schnittstelle: Token holen, Rechte auslesen,
 * Salden abrufen, ein kurzes Bewegungsfenster abrufen.
 *
 * Gibt AUSSCHLIESSLICH Auskünfte zurück — Zähler, Ja/Nein, Zeitpunkte,
 * Fehlertexte von PayPal, PayPals Korrelationskennung. Nie die Client-ID, nie
 * das Secret, nie den Zugriffstoken, auch nicht gekürzt.
 */
export async function paypalDiagnose(): Promise<PaypalDiagnose> {
  const zugang = paypalZugangStand();
  const leer: PaypalDiagnose = {
    eingerichtet: zugang.hinterlegt,
    umgebung: zugang.umgebung,
    verschluesselt: zugang.verschluesselt,
    token: { geholt: false, gueltigBisAm: null, fehler: null },
    scope: { roh: null, vorhanden: {}, pflichtFehlt: [...PAYPAL_SCOPES_PFLICHT], ungenutztVorhanden: [] },
    salden: { abgerufen: false, waehrungen: [], standPaypal: null, fehler: null },
    bewegung: { abgerufen: false, zeilen: 0, vollstaendig: false, fehler: null },
    debugId: null,
    stillerAusfallVerdacht: false,
    hinweis: null,
  };

  if (!zugang.hinterlegt) {
    return { ...leer, hinweis: 'nichtEingerichtet' };
  }

  let debugId: string | null = null;

  /* ── Token ── */
  try {
    await zugriffstoken(true);
    leer.token = { geholt: true, gueltigBisAm: tokenGueltigBis(), fehler: null };
  } catch (f) {
    if (f instanceof PaypalFehler) debugId = f.debugId;
    return {
      ...leer,
      token: { geholt: false, gueltigBisAm: null, fehler: fehlerEinordnen(f) },
      debugId,
      hinweis: 'tokenFehlgeschlagen',
    };
  }

  /* ── Rechte ── */
  const scopeRoh = getSetting(SCHLUESSEL_SCOPE);
  const scopeListe = new Set((scopeRoh ?? '').split(/\s+/).filter(Boolean));
  const alleBekannt = [...PAYPAL_SCOPES_PFLICHT, ...PAYPAL_SCOPES_UNGENUTZT];
  leer.scope = {
    roh: scopeRoh,
    vorhanden: Object.fromEntries(alleBekannt.map((s) => [s, scopeListe.has(s)])),
    pflichtFehlt: PAYPAL_SCOPES_PFLICHT.filter((s) => !scopeListe.has(s)),
    ungenutztVorhanden: PAYPAL_SCOPES_UNGENUTZT.filter((s) => scopeListe.has(s)),
  };

  /* ── Salden ── */
  try {
    const { salden, standPaypal } = await saldenHolen();
    leer.salden = {
      abgerufen: true,
      waehrungen: salden.map((s) => s.waehrung),
      standPaypal,
      fehler: null,
    };
  } catch (f) {
    if (f instanceof PaypalFehler) debugId = f.debugId ?? debugId;
    leer.salden = { abgerufen: false, waehrungen: [], standPaypal: null, fehler: fehlerEinordnen(f) };
  }

  /* ── Bewegungen, kurzes Fenster ── */
  try {
    const bis = Date.now();
    const teil = await fensterHolen(bis - 7 * 24 * 60 * 60_000, bis, Date.now() + 30_000);
    leer.bewegung = {
      abgerufen: true, zeilen: teil.buchungen.length,
      vollstaendig: teil.vollstaendig, fehler: null,
    };
  } catch (f) {
    if (f instanceof PaypalFehler) debugId = f.debugId ?? debugId;
    leer.bewegung = { abgerufen: false, zeilen: 0, vollstaendig: false, fehler: fehlerEinordnen(f) };
  }

  const stillerAusfallVerdacht = leer.bewegung.abgerufen
    && leer.bewegung.zeilen > 0
    && leer.salden.waehrungen.length === 0;

  return {
    ...leer,
    debugId,
    stillerAusfallVerdacht,
    hinweis: leer.scope.pflichtFehlt.length ? 'rechteFehlen'
      : stillerAusfallVerdacht ? 'saldenLeerTrotzBewegung'
        : (!leer.salden.abgerufen || !leer.bewegung.abgerufen) ? 'abrufFehlgeschlagen'
          : null,
  };
}

/** Nur für Prüfläufe: alle Zwischenspeicher dieser Datei vergessen, damit
 *  jeder Fall bei null anfängt. Rührt die Ablage NICHT an. */
export function paypalZustandZuruecksetzen(): void {
  tokenVergessen();
  werteStand = null;
  werteGeladen = false;
  durchgangLaeuft = null;
  letzterVollerDurchgang = 0;
}
