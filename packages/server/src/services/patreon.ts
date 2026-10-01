/**
 * Die eigentliche Patreon-Anbindung: Erneuerung des Zugriffstokens, Abruf
 * von Kampagne und Mitgliedern, und eine Sonde, die ehrlich sagt, welche
 * Felder und Rechte wirklich da sind.
 *
 * Trennung von verkaufzugang.ts bewusst: dort liegen nur die vier Werte
 * (verschlüsselt, austauschbar) und das Ablaufdatum — dieser Dienst hier ist
 * die Datei, die tatsächlich mit Patreon spricht. Wer künftig an den
 * Zugangsdaten selbst etwas ändert (siehe Kopf von verkaufzugang.ts, das
 * teilt sich dieser Auftrag mit der Gumroad-Anbindung), muss dafür nicht in
 * diese Datei hinein — und umgekehrt ändert sich an den Zugangsdaten nichts,
 * wenn hier eine neue Kennzahl dazukommt.
 *
 * Drei Dinge, die beim Bau dieser Datei den Ausschlag gaben:
 *
 * 1. ERNEUERN VOR ABLAUF, NICHT NACH EINEM FEHLSCHLAG. Patreons
 *    Zugriffstoken gilt nur einen Monat (siehe expires_in in der Antwort).
 *    Der Hintergrundlauf unten prüft alle paar Stunden, ob das Ablaufdatum
 *    näher als VORLAUF_MS liegt — nicht, ob der letzte Aufruf mit 401
 *    scheiterte. Wer erst auf einen Fehlschlag reagiert, hat für die Dauer
 *    bis zur nächsten Erneuerung schon Datenlücken.
 *
 * 2. BEIDE NEUEN WERTE SPEICHERN. Patreon gibt bei jeder Erneuerung einen
 *    NEUEN Refresh-Token heraus, nicht nur einen neuen Access-Token — der
 *    alte Refresh-Token verliert dabei seine Gültigkeit. Wer nur den
 *    Access-Token übernimmt, ist beim übernächsten Versuch ausgesperrt, und
 *    das fällt erst einen Monat später auf.
 *
 * 3. EINE LEERE LISTE IST KEIN "KEINE UNTERSTÜTZER". Fehlt dem Zugriffstoken
 *    das Recht `campaigns.members`, antwortet Patreon nicht mit einem
 *    Fehler, sondern mit `data: []` — technisch eine gültige Antwort, inhaltlich
 *    aber falsch: es heißt "darf nicht sehen", nicht "es gibt niemanden".
 *    sondeFelder() unten prüft deshalb jedes angefragte Feld einzeln nach,
 *    statt eine Ablehnung nur zu raten, und diagnoseLauf() vergleicht
 *    `campaign.patron_count` (braucht nur `campaigns`) gegen die Länge der
 *    tatsächlich abgerufenen Mitgliederliste (braucht `campaigns.members`) —
 *    genau der stille Fehlschlag, den man sonst erst an leeren Zahlen in der
 *    Oberfläche bemerkt.
 */
import {
  patreonAblaufLesen, patreonAblaufSetzen, patreonAccessTokenLesen,
  patreonClientIdLesen, patreonClientSecretLesen, patreonRefreshTokenLesen, patreonSetzen,
} from './verkaufzugang.js';
import { getSetting, setSetting } from './settings.js';
import { db } from '../db/index.js';
import { ereignisseVerarbeiten, type VerkaufEreignisEingabe } from './verkaufBenachrichtigung.js';

const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const API_BASE = 'https://www.patreon.com/api/oauth2/v2';
const ANFRAGE_TIMEOUT_MS = 15_000;

/* ── Zusätzliche Ablage — eigene Schlüssel, damit verkaufzugang.ts (von der
   Gumroad-Anbindung mitbenutzt) unangetastet bleibt. Dieselbe generische
   app_settings-Tabelle wie dort, nur mit eigenem Namensraum. */
const SCHLUESSEL_SCOPE = 'verkauf.patreon.scope';
const SCHLUESSEL_LETZTER_FEHLER = 'verkauf.patreon.letzterFehler';
/**
 * Kennung zu `SCHLUESSEL_LETZTER_FEHLER`, eigener Schlüssel statt eines
 * gemeinsamen JSON-Werts — `getSetting`/`setSetting` (services/settings.ts)
 * kennen nur Zeichenketten. Steht nur, wenn der zuletzt hinterlegte Fehler
 * ein selbst geschriebener Satz war (siehe `code` in `ErneuerungErgebnis`);
 * bei Netzwerkdiagnosen und Patreons eigenem Antworttext bleibt er leer —
 * und muss darum bei JEDER Stelle, die `SCHLUESSEL_LETZTER_FEHLER` ohne
 * Kennung setzt, ausdrücklich mitgeleert werden, sonst zeigt die Oberfläche
 * irgendwann eine Kennung zu einem längst anderen Fehlertext.
 */
const SCHLUESSEL_LETZTER_FEHLER_CODE = 'verkauf.patreon.letzterFehlerCode';
const SCHLUESSEL_LETZTER_VERSUCH = 'verkauf.patreon.letzterVersuchAm';
const SCHLUESSEL_LETZTER_ERFOLG = 'verkauf.patreon.letzteErneuerungAm';

/** Automatisierte Schreibvorgänge tragen 'system' als Urheber — dieselbe
 *  Konvention wie in vorschlaege.ts und emoji-vorschlaege.ts. */
const SYSTEM = 'system';

/** Fünf Tage Vorlauf bei rund dreißig Tagen Gültigkeit: reichlich Zeit für
 *  mehrere Versuche, falls Patreon oder das eigene Netz gerade klemmt, und
 *  weit weg vom tatsächlichen Ablauf, damit ein einzelner Fehlschlag nie
 *  zur Lücke wird. */
const VORLAUF_MS = 5 * 24 * 60 * 60_000;
/** Alle sechs Stunden nachsehen — genug Versuche vor dem Ablauf, ohne
 *  Patreon grundlos zu behelligen (die Erneuerung selbst ändert nichts,
 *  solange sie nicht nötig ist). */
const TAKT_MS = 6 * 60 * 60_000;

/* ── Bekannte Rechte (Scopes) ─────────────────────────────────────
   Patreon nennt im Antwort-Feld "scope" jeder Token-Ausgabe genau, welche
   davon der Schlüssel wirklich trägt — das ist die einzige verlässliche
   Quelle dafür, nicht raten, was beim Anlegen des Clients angehakt wurde.
   Für unsere Kennzahlen (Unterstützerzahl, Einnahmen, Zu-/Abgänge) sind nur
   die beiden PFLICHT-Scopes nötig; der Rest steht hier nur zur Auskunft. */
export const PATREON_SCOPES_PFLICHT = ['campaigns', 'campaigns.members'] as const;
export const PATREON_SCOPES_BEKANNT = [
  'identity', 'identity[email]', 'identity.memberships',
  'campaigns', 'campaigns.members', 'campaigns.members[email]', 'campaigns.members.address',
  'campaigns.posts', 'campaigns.webhook', 'w:campaigns.webhook',
] as const;

/* ── Feldkandidaten ────────────────────────────────────────────────
   Patreons API v2 verlangt für jede Ressource ein ausdrückliches
   fields[typ]=... — ein unbekannter Feldname lässt die GANZE Anfrage mit 400
   scheitern, keine Teilantwort. sondeFelder() prüft deshalb erst im Block
   und bei einer Ablehnung Feld für Feld nach, damit am Ende feststeht, was
   es wirklich gibt — nicht, was diese Liste vermutet. */
export const KAMPAGNE_FELDER = [
  'created_at', 'creation_name', 'discord_server_id', 'google_analytics_id',
  'has_rss', 'has_sent_rss_notify', 'image_small_url', 'image_url',
  'is_charged_immediately', 'is_monthly', 'is_nsfw', 'main_video_embed', 'main_video_url',
  'one_liner', 'patron_count', 'pay_per_name', 'pledge_url', 'published_at',
  'rss_artwork_url', 'rss_feed_title', 'summary', 'thanks_embed', 'thanks_msg',
  'thanks_video_url', 'url', 'vanity', 'currency',
  /* 'earnings_visibility' stand hier auch — Patreon lehnt es mit 400 ab
     ("Invalid parameter for 'fields[campaign]' on type campaign"), live gegen
     die echte Kampagne geprüft am 22.08.2026. Kein Tippfehler, das Feld gibt
     es in der aktuellen API-Fassung schlicht nicht (mehr). */
] as const;

export const MITGLIED_FELDER = [
  'campaign_lifetime_support_cents', 'currently_entitled_amount_cents', 'email', 'full_name',
  'is_follower', 'last_charge_date', 'last_charge_status', 'lifetime_support_cents',
  'next_charge_date', 'note', 'patron_status',
  'pledge_relationship_start', 'will_pay_amount_cents',
  /* 'pledge_cause_id' stand hier auch — dieselbe Ablehnung wie bei
     earnings_visibility oben, live geprüft. */
] as const;

/* ── HTTP-Hilfen ──────────────────────────────────────────────────── */

export class PatreonApiError extends Error {
  constructor(readonly status: number, readonly body: string, message: string) {
    super(message);
    this.name = 'PatreonApiError';
  }
}

async function mitZeitlimit<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANFRAGE_TIMEOUT_MS);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET gegen die Patreon-API. Ein einzelner Wiederholungsversuch bei 429 —
 * mit der Wartezeit, die Patreon selbst im `Retry-After`-Kopf nennt, gedeckelt
 * auf zehn Sekunden, damit ein Diagnoselauf nicht minutenlang hängt.
 */
async function patreonGet(url: URL, accessToken: string): Promise<Response> {
  const abrufen = () => mitZeitlimit((signal) => fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal,
  }));
  const erster = await abrufen();
  if (erster.status !== 429) return erster;
  const warten = Math.min(10_000, Number(erster.headers.get('retry-after')) * 1000 || 3_000);
  await new Promise((f) => setTimeout(f, warten));
  return abrufen();
}

/* ── Erneuerung ───────────────────────────────────────────────────── */

interface TokenAntwort {
  access_token: string; refresh_token: string; expires_in: number;
  scope: string; token_type: string;
}

export interface ErneuerungErgebnis {
  ok: boolean;
  /** 'nichtEingerichtet' | 'anfrageFehlgeschlagen' | Fehlertext von Patreon */
  grund?: string;
  /**
   * Kennung aus dem Wörterbuch der Oberfläche, wenn `grund` ein selbst
   * geschriebener Satz ist (nicht: Netzwerkdiagnose oder Patreons eigener
   * Antworttext — die bleiben unübersetzt, wie überall sonst in dieser
   * Datei). Dieselbe Bauart wie bei `fail()`/`abweisung()`: Kennung hin,
   * `grund` bleibt der deutsche Rückfall.
   */
  code?: string;
  scope?: string;
  ablaufAm?: number;
}

/**
 * Den Access-Token erneuern und — das ist der Teil, den man leicht vergisst
 * — den dabei neu ausgegebenen Refresh-Token gleich mit übernehmen.
 *
 * Ruft niemand automatisch bei jedem API-Fehler auf: das gehört in
 * startPatreonErneuerungJob() und läuft nach der Ablauffrist, nicht nach
 * einem 401. Diese Funktion selbst weiß nichts von einem Zeitplan.
 *
 * Höchstens EINE Erneuerung gleichzeitig: der Hintergrundlauf und ein
 * Diagnoselauf mit `?erneuern=1` (oder ein Doppelklick darauf) schickten
 * sonst denselben Refresh-Token zweimal los. Patreon tauscht ihn bei der
 * ersten Anfrage aus, die zweite scheitert mit `invalid_grant` — und deren
 * Fehler landete NACH dem Erfolg der ersten in der Ablage, sodass die
 * Oberfläche eine gescheiterte Erneuerung meldete, obwohl der neue Token
 * längst gespeichert war. Ein zweiter Aufrufer bekommt deshalb das Ergebnis
 * des laufenden.
 */
let erneuerungLaeuft: Promise<ErneuerungErgebnis> | null = null;

export function patreonErneuern(): Promise<ErneuerungErgebnis> {
  if (erneuerungLaeuft) return erneuerungLaeuft;
  erneuerungLaeuft = erneuernEinmalig().finally(() => { erneuerungLaeuft = null; });
  return erneuerungLaeuft;
}

async function erneuernEinmalig(): Promise<ErneuerungErgebnis> {
  const clientId = patreonClientIdLesen();
  const clientSecret = patreonClientSecretLesen();
  const refreshToken = patreonRefreshTokenLesen();
  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: false, grund: 'nichtEingerichtet' };
  }

  setSetting(SCHLUESSEL_LETZTER_VERSUCH, String(Date.now()), SYSTEM);

  let res: Response;
  try {
    res = await mitZeitlimit((signal) => fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal,
    }));
  } catch (err) {
    const grund = `Anfrage fehlgeschlagen: ${(err as Error).message}`;
    setSetting(SCHLUESSEL_LETZTER_FEHLER, grund, SYSTEM);
    // Netzwerkdiagnose, kein selbst geschriebener Satz — keine Kennung dafür,
    // siehe Dateikopf von SCHLUESSEL_LETZTER_FEHLER_CODE. Ausdrücklich leeren,
    // sonst überlebt eine ältere Kennung diesen neuen, uncodierten Fehler.
    setSetting(SCHLUESSEL_LETZTER_FEHLER_CODE, null, SYSTEM);
    console.error('[patreon] Erneuerung:', grund);
    return { ok: false, grund };
  }

  if (!res.ok) {
    /* Absichtlich NUR der Antworttext von Patreon, niemals refresh_token,
       client_secret oder irgendein anderer Teil der eigenen Anfrage — die
       Meldung landet im Protokoll und in der Oberfläche. */
    const text = await res.text().catch(() => '');
    const grund = `Patreon antwortet ${res.status}: ${text.slice(0, 300)}`;
    setSetting(SCHLUESSEL_LETZTER_FEHLER, grund, SYSTEM);
    // Patreons eigener Antworttext — dieselbe Begründung wie im Zweig oben.
    setSetting(SCHLUESSEL_LETZTER_FEHLER_CODE, null, SYSTEM);
    console.error('[patreon] Erneuerung fehlgeschlagen —', grund);
    return { ok: false, grund };
  }

  let daten: TokenAntwort;
  try {
    daten = await res.json() as TokenAntwort;
  } catch {
    const grund = 'Antwort von Patreon war kein gültiges JSON.';
    const code = 'fehler.patreonUngueltigesJson';
    setSetting(SCHLUESSEL_LETZTER_FEHLER, grund, SYSTEM);
    setSetting(SCHLUESSEL_LETZTER_FEHLER_CODE, code, SYSTEM);
    return { ok: false, grund, code };
  }

  const ablaufAm = Date.now() + daten.expires_in * 1000;
  patreonSetzen({ accessToken: daten.access_token, refreshToken: daten.refresh_token }, SYSTEM);
  patreonAblaufSetzen(ablaufAm, SYSTEM);
  setSetting(SCHLUESSEL_SCOPE, daten.scope ?? '', SYSTEM);
  setSetting(SCHLUESSEL_LETZTER_FEHLER, null, SYSTEM);
  setSetting(SCHLUESSEL_LETZTER_FEHLER_CODE, null, SYSTEM);
  setSetting(SCHLUESSEL_LETZTER_ERFOLG, String(Date.now()), SYSTEM);
  console.log(`[patreon] Zugriffstoken erneuert, gültig bis ${new Date(ablaufAm).toISOString()}.`);
  return { ok: true, scope: daten.scope, ablaufAm };
}

/** Was der Einstellungsreiter zusätzlich zu verkaufzugang.patreonStand()
 *  zeigen kann — Erneuerungsstand, ohne die vier Werte selbst zu berühren. */
export function patreonErneuerungsStand(): {
  scope: string | null; letzterFehler: string | null; letzterFehlerCode: string | null;
  letzterVersuchAm: number | null; letzteErneuerungAm: number | null;
} {
  return {
    scope: getSetting(SCHLUESSEL_SCOPE),
    letzterFehler: getSetting(SCHLUESSEL_LETZTER_FEHLER),
    letzterFehlerCode: getSetting(SCHLUESSEL_LETZTER_FEHLER_CODE),
    letzterVersuchAm: (() => { const v = getSetting(SCHLUESSEL_LETZTER_VERSUCH); return v ? Number(v) : null; })(),
    letzteErneuerungAm: (() => { const v = getSetting(SCHLUESSEL_LETZTER_ERFOLG); return v ? Number(v) : null; })(),
  };
}

/* ── Hintergrundlauf ──────────────────────────────────────────────── */

function sollErneuern(): boolean {
  if (!patreonAccessTokenLesen() || !patreonRefreshTokenLesen()) return false;   // nichts eingerichtet
  const ablauf = patreonAblaufLesen();
  if (ablauf == null) return true;    // noch nie erneuert — Ablaufdatum erst herstellen
  return ablauf - Date.now() < VORLAUF_MS;
}

/**
 * Der Hintergrundlauf. Gleiche Form wie vorschlaege.startVorschlagJob():
 * eine Funktion zum Anhalten, damit startBackgroundJobs() im Gateway sie in
 * einer Zeile einhängen kann.
 *
 * Prüft sofort beim Start (falls der Server während des Vorlaufs offline
 * war, sonst bliebe das erst nach TAKT_MS bemerkt) und danach im Takt.
 */
export function startPatreonErneuerungJob(): () => void {
  let laeuft = false;

  const einmalPruefen = () => {
    if (laeuft) return;
    if (!sollErneuern()) return;
    laeuft = true;
    void patreonErneuern()
      .catch((err) => console.error('[patreon] Erneuerungslauf:', (err as Error).message))
      .finally(() => { laeuft = false; });
  };

  einmalPruefen();
  const takt = setInterval(einmalPruefen, TAKT_MS);
  return () => clearInterval(takt);
}

/* ── Feldsonde ────────────────────────────────────────────────────── */

export interface FeldSondeErgebnis {
  funktionierend: string[];
  abgelehnt: { feld: string; fehler: string }[];
  antwort: any | null;
}

/**
 * Welche der angefragten Felder gibt es wirklich?
 *
 * Erst alle zusammen versuchen — meist klappt das, und dann war es genau
 * ein Aufruf. Scheitert der Block, wird JEDES Feld einzeln gegen die echte
 * Schnittstelle geprüft, statt aus der Fehlermeldung zu raten, welches der
 * Übeltäter war: Patreons 400-Antworten nennen zwar das erste unbekannte
 * Feld, aber nicht zuverlässig alle auf einmal.
 */
async function sondeFelder(
  basisUrl: URL, typ: 'campaign' | 'member', kandidaten: readonly string[], accessToken: string,
): Promise<FeldSondeErgebnis> {
  const versuchen = async (felder: string[]): Promise<{ ok: true; json: any } | { ok: false; fehler: string }> => {
    const url = new URL(basisUrl);
    url.searchParams.set(`fields[${typ}]`, felder.join(','));
    const res = await patreonGet(url, accessToken);
    if (res.ok) return { ok: true, json: await res.json() };
    return { ok: false, fehler: `${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` };
  };

  const voll = await versuchen([...kandidaten]);
  if (voll.ok) return { funktionierend: [...kandidaten], abgelehnt: [], antwort: voll.json };

  const funktionierend: string[] = [];
  const abgelehnt: { feld: string; fehler: string }[] = [];
  for (const feld of kandidaten) {
    const r = await versuchen([feld]);
    if (r.ok) funktionierend.push(feld); else abgelehnt.push({ feld, fehler: r.fehler });
    await new Promise((f) => setTimeout(f, 120));   // Patreons Ratenbremse schonen
  }
  const antwort = funktionierend.length ? (await versuchen(funktionierend)) : null;
  return { funktionierend, abgelehnt, antwort: antwort && antwort.ok ? antwort.json : null };
}

/* ── Diagnose ─────────────────────────────────────────────────────── */

export interface PatreonDiagnose {
  eingerichtet: boolean;
  erneuerung: { versucht: boolean; ok: boolean; grund?: string; code?: string };
  scope: { roh: string | null; vorhanden: Record<string, boolean>; pflichtFehlt: string[] };
  kampagnen: {
    anzahl: number;
    ersteId: string | null;
    gefundeneFelder: string[];
    abgelehnteFelder: { feld: string; fehler: string }[];
    patronCountLautKampagne: number | null;
  } | null;
  mitglieder: {
    abgerufeneSeiten: number;
    abgerufeneAnzahl: number;
    aktiv: number;
    deklination: number;
    ehemalig: number;
    /** patron_status ist bei diesen null — noch nie etwas zugesagt. */
    ohneStatus: number;
    /** is_follower === true, unabhängig vom Status — überschneidet sich meist
     *  mit ohneStatus, siehe Kommentar in diagnoseLauf(). */
    follower: number;
    gefundeneFelder: string[];
    abgelehnteFelder: { feld: string; fehler: string }[];
  } | null;
  stillerAusfallVerdacht: boolean;
  fehler: string | null;
}

/**
 * Der vollständige Prüflauf: erneuern (falls fällig oder erzwungen), Rechte
 * auslesen, Kampagne und eine Mitgliederseite abrufen, jedes Feld einzeln
 * bestätigen. Gibt NUR Auskünfte zurück — Zähler, Ja/Nein, Fehlertexte —
 * nie einen Token- oder Geheimniswert.
 */
export async function diagnoseLauf(opts: { erneuernErzwingen?: boolean } = {}): Promise<PatreonDiagnose> {
  const clientId = patreonClientIdLesen();
  const accessTokenVorher = patreonAccessTokenLesen();
  const refreshToken = patreonRefreshTokenLesen();
  if (!clientId || !accessTokenVorher || !refreshToken) {
    return {
      eingerichtet: false,
      erneuerung: { versucht: false, ok: false },
      scope: { roh: null, vorhanden: {}, pflichtFehlt: [...PATREON_SCOPES_PFLICHT] },
      kampagnen: null, mitglieder: null, stillerAusfallVerdacht: false,
      fehler: 'Client-ID, Access- oder Refresh-Token fehlt — siehe Einstellungen → Verkauf → Patreon.',
    };
  }

  const mussErneuern = opts.erneuernErzwingen || sollErneuern();
  const erneuerung = mussErneuern
    ? await patreonErneuern()
    : { ok: true as const };
  const accessToken = mussErneuern && erneuerung.ok
    ? (patreonAccessTokenLesen() ?? accessTokenVorher)
    : accessTokenVorher;

  const scopeRoh = mussErneuern
    ? ('scope' in erneuerung ? erneuerung.scope ?? null : getSetting(SCHLUESSEL_SCOPE))
    : getSetting(SCHLUESSEL_SCOPE);
  const scopeListe = new Set((scopeRoh ?? '').split(/\s+/).filter(Boolean));
  const scopeVorhanden = Object.fromEntries(PATREON_SCOPES_BEKANNT.map((s) => [s, scopeListe.has(s)]));
  const pflichtFehlt = PATREON_SCOPES_PFLICHT.filter((s) => !scopeListe.has(s));

  if (mussErneuern && !erneuerung.ok) {
    return {
      eingerichtet: true,
      erneuerung: {
        versucht: true, ok: false,
        grund: 'grund' in erneuerung ? erneuerung.grund : undefined,
        code: 'code' in erneuerung ? erneuerung.code : undefined,
      },
      scope: { roh: scopeRoh, vorhanden: scopeVorhanden, pflichtFehlt },
      kampagnen: null, mitglieder: null, stillerAusfallVerdacht: false,
      fehler: 'Erneuerung ist gescheitert, der bisherige Zugriffstoken wird trotzdem geprüft.',
    };
  }

  try {
    // ── Kampagne(n) ─────────────────────────────────────────────
    const kampagnenUrl = new URL(`${API_BASE}/campaigns`);
    const kampagnenSonde = await sondeFelder(kampagnenUrl, 'campaign', KAMPAGNE_FELDER, accessToken);
    const kampagnenListe: any[] = kampagnenSonde.antwort?.data ?? [];
    const ersteId: string | null = kampagnenListe[0]?.id ?? null;
    const patronCountLautKampagne = ersteId != null
      ? (kampagnenListe[0]?.attributes?.patron_count ?? null) : null;

    const kampagnen = {
      anzahl: kampagnenListe.length,
      ersteId,
      gefundeneFelder: kampagnenSonde.funktionierend,
      abgelehnteFelder: kampagnenSonde.abgelehnt,
      patronCountLautKampagne,
    };

    if (!ersteId) {
      return {
        eingerichtet: true,
        erneuerung: { versucht: mussErneuern, ok: erneuerung.ok },
        scope: { roh: scopeRoh, vorhanden: scopeVorhanden, pflichtFehlt },
        kampagnen, mitglieder: null, stillerAusfallVerdacht: false,
        fehler: kampagnenListe.length === 0
          ? 'Keine Kampagne gefunden — entweder gibt es wirklich keine, oder dem Schlüssel fehlt das Recht "campaigns".'
          : null,
      };
    }

    // ── Mitglieder der ersten Kampagne (eine Seite reicht für die Sonde) ──
    const mitgliederUrl = new URL(`${API_BASE}/campaigns/${ersteId}/members`);
    mitgliederUrl.searchParams.set('page[count]', '100');
    const mitgliederSonde = await sondeFelder(mitgliederUrl, 'member', MITGLIED_FELDER, accessToken);
    const mitgliederListe: any[] = mitgliederSonde.antwort?.data ?? [];

    /* patron_status ist null, wenn jemand der Kampagne nur folgt, ohne je
       etwas zugesagt zu haben — is_follower unterscheidet das von einem
       echten (wenn auch inaktiven) Unterstützer. Ohne diese Zählung sah eine
       reine Follower-Zahl aus wie ein Loch in der Zählung: patron_count auf
       der Kampagne zählt SIE MIT, aktiv/deklination/ehemalig zusammen aber
       nicht — live an der eigenen Kampagne beobachtet (22.08.2026: ein
       Follower ohne Zusage, patron_count meldete trotzdem 1). */
    let aktiv = 0; let deklination = 0; let ehemalig = 0; let ohneStatus = 0; let follower = 0;
    for (const m of mitgliederListe) {
      const status = m.attributes?.patron_status;
      if (status === 'active_patron') aktiv += 1;
      else if (status === 'declined_patron') deklination += 1;
      else if (status === 'former_patron') ehemalig += 1;
      else ohneStatus += 1;
      if (m.attributes?.is_follower) follower += 1;
    }

    const mitglieder = {
      abgerufeneSeiten: 1,
      abgerufeneAnzahl: mitgliederListe.length,
      aktiv, deklination, ehemalig, follower, ohneStatus,
      gefundeneFelder: mitgliederSonde.funktionierend,
      abgelehnteFelder: mitgliederSonde.abgelehnt,
    };

    /* Der stille Fehlschlag aus dem Dateikopf: die Kampagne meldet
       Unterstützer, aber die Mitgliederliste kam leer zurück. */
    const stillerAusfallVerdacht = (patronCountLautKampagne ?? 0) > 0 && mitgliederListe.length === 0;

    return {
      eingerichtet: true,
      erneuerung: { versucht: mussErneuern, ok: erneuerung.ok },
      scope: { roh: scopeRoh, vorhanden: scopeVorhanden, pflichtFehlt },
      kampagnen, mitglieder, stillerAusfallVerdacht,
      fehler: pflichtFehlt.length
        ? `Dem Zugriffstoken fehlt: ${pflichtFehlt.join(', ')}. Im Patreon-Entwicklerbereich beim Client unter "App Scopes" nachtragen und den Zugriffstoken neu ausstellen.`
        : null,
    };
  } catch (err) {
    if (err instanceof PatreonApiError) {
      return {
        eingerichtet: true,
        erneuerung: { versucht: mussErneuern, ok: erneuerung.ok },
        scope: { roh: scopeRoh, vorhanden: scopeVorhanden, pflichtFehlt },
        kampagnen: null, mitglieder: null, stillerAusfallVerdacht: false,
        fehler: `Patreon antwortet ${err.status}: ${err.body.slice(0, 300)}`,
      };
    }
    return {
      eingerichtet: true,
      erneuerung: { versucht: mussErneuern, ok: erneuerung.ok },
      scope: { roh: scopeRoh, vorhanden: scopeVorhanden, pflichtFehlt },
      kampagnen: null, mitglieder: null, stillerAusfallVerdacht: false,
      fehler: (err as Error).message,
    };
  }
}

/* ── Kennzahlen ───────────────────────────────────────────────────── */

export interface PatreonKennzahlen {
  stand: number;
  kampagneId: string;
  aktiveUnterstuetzer: number;
  deklinierteUnterstuetzer: number;
  ehemaligeUnterstuetzer: number;
  /** Folgt der Kampagne, hat aber nie etwas zugesagt — patron_status ist bei
   *  diesen null. Zählt bei Patreons eigenem "patron_count" auf der Kampagne
   *  MIT, bei den drei Zahlen oben NICHT — live geprüft am 22.08.2026. Ohne
   *  dieses Feld sähe patron_count wie eine falsche Unterstützerzahl aus. */
  follower: number;
  /** Summe von currently_entitled_amount_cents über alle aktiven Mitglieder,
   *  in kleinster Währungseinheit (Cent). */
  monatlicheEinnahmenCents: number;
  /** 'currency' auf der Kampagne — live bestätigtes, echtes Feld (nicht in
   *  jeder Patreon-API-Fassung dokumentiert, aber vorhanden). null, falls die
   *  Kampagne ausnahmsweise keine trägt. */
  waehrung: string | null;
  /** Neu seit Beginn des laufenden Kalendermonats (UTC), nach
   *  pledge_relationship_start — ein echtes Feld, kein Schätzwert. */
  neuDiesenMonat: number;
  /** Patreon nennt keinen Zeitpunkt, an dem jemand former_patron wurde —
   *  ohne eigene Verlaufsmessung (Momentaufnahmen über die Zeit) lässt sich
   *  "wie viele sind diesen Monat gegangen" nicht ehrlich beantworten. Bewusst
   *  weggelassen statt geschätzt; siehe Bericht am Auftragsende. */
  abgaengeDiesenMonat: null;
}

let kennzahlenStand: { zeit: number; werte: PatreonKennzahlen } | null = null;
let kennzahlenLaufen: Promise<PatreonKennzahlen> | null = null;
/** Fünfzehn Minuten: Verkaufszahlen ändern sich nicht sekündlich, und die
 *  Sondierung mehrerer Kampagnenseiten soll nicht bei jedem Öffnen der
 *  Verkaufskachel neu anfallen (siehe Auftrag: "nicht bei jedem Durchlauf
 *  neu holen, wenn es sich vermeiden lässt"). */
const KENNZAHLEN_FRIST_MS = 15 * 60_000;

async function kennzahlenHolen(): Promise<PatreonKennzahlen> {
  const accessToken = patreonAccessTokenLesen();
  if (!accessToken) throw new Error('Patreon ist nicht eingerichtet.');

  const kampagnenUrl = new URL(`${API_BASE}/campaigns`);
  kampagnenUrl.searchParams.set('fields[campaign]', 'patron_count,currency');
  const kampagnenRes = await patreonGet(kampagnenUrl, accessToken);
  if (!kampagnenRes.ok) {
    throw new PatreonApiError(kampagnenRes.status, await kampagnenRes.text().catch(() => ''),
      `Kampagnen-Abruf fehlgeschlagen (${kampagnenRes.status})`);
  }
  const kampagnenJson = await kampagnenRes.json() as {
    data: { id: string; attributes?: { currency?: string | null } }[];
  };
  const kampagneId = kampagnenJson.data[0]?.id;
  if (!kampagneId) throw new Error('Keine Patreon-Kampagne gefunden.');
  const waehrung = kampagnenJson.data[0]?.attributes?.currency ?? null;

  const monatsanfang = (() => {
    const jetzt = new Date();
    return Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), 1);
  })();

  let aktiv = 0; let deklination = 0; let ehemalig = 0; let follower = 0;
  let einnahmenCents = 0; let neuDiesenMonat = 0;
  let seiten = 0;
  /* Für die Verkaufsmeldung ("ein Kauf ist passiert") gesammelt, unten in
     EINEM Aufruf verarbeitet — siehe services/verkaufBenachrichtigung.ts.
     `art` ist immer 'neu': Patreons Mitgliederliste ist ein STAND JETZT,
     keine Kette einzelner Abbuchungen, eine Verlängerung ließe sich nur
     raten (siehe Dateikopf dort für die ausführliche Begründung, warum das
     hier bewusst NICHT versucht wird). */
  const verkaufEingaben: VerkaufEreignisEingabe[] = [];

  let url: URL | null = new URL(`${API_BASE}/campaigns/${kampagneId}/members`);
  url.searchParams.set('page[count]', '200');
  url.searchParams.set('fields[member]',
    'patron_status,currently_entitled_amount_cents,pledge_relationship_start,is_follower');

  /* Sanftes Deckel: eine kaputte "next"-Verkettung soll nicht in eine
     Endlosschleife laufen. 100 Seiten à 200 sind 20.000 Mitglieder — mehr,
     als dieses Vorhaben je haben wird; wer darüber hinauswächst, bekommt hier
     eine ehrliche Untergrenze statt eines hängenden Aufrufs. */
  while (url && seiten < 100) {
    seiten += 1;
    const res: Response = await patreonGet(url, accessToken);
    if (!res.ok) {
      throw new PatreonApiError(res.status, await res.text().catch(() => ''),
        `Mitglieder-Abruf fehlgeschlagen (${res.status}, Seite ${seiten})`);
    }
    const json = await res.json() as {
      /* `id` steht auf jeder JSON:API-Ressource neben `attributes` — dasselbe
         Feld, das diese Datei an anderer Stelle schon für die Kampagne selbst
         liest (`kampagnenJson.data[0]?.id` oben). */
      data: { id: string; attributes: Record<string, unknown> }[];
      links?: { next?: string | null };
    };
    for (const m of json.data) {
      const status = m.attributes.patron_status;
      if (status === 'active_patron') {
        aktiv += 1;
        const betragCent = Number(m.attributes.currently_entitled_amount_cents ?? 0);
        einnahmenCents += betragCent;
        verkaufEingaben.push({
          fingerabdruck: `patreon:mitglied:${m.id}`,
          art: 'neu',
          produktName: null,
          betragCent: Number.isFinite(betragCent) ? betragCent : null,
          waehrung,
          inProbe: null,
        });
      } else if (status === 'declined_patron') deklination += 1;
      else if (status === 'former_patron') ehemalig += 1;
      if (m.attributes.is_follower) follower += 1;

      const beginn = m.attributes.pledge_relationship_start;
      if (typeof beginn === 'string' && Date.parse(beginn) >= monatsanfang) neuDiesenMonat += 1;
    }
    url = json.links?.next ? new URL(json.links.next) : null;
  }

  /* Siehe Kommentar bei verkaufEingaben oben. In try/catch: ein Fehler in der
     Meldung über Unterstützer:innen darf die Kennzahlen selbst nicht mit sich
     reißen — dieselbe Abwägung wie beim gleichnamigen Block in
     gumroad.ts, gumroadSyncLauf(). */
  try {
    ereignisseVerarbeiten('patreon', verkaufEingaben);
  } catch (err) {
    console.error('[patreon] Verkaufsmeldung:', (err as Error)?.message ?? err);
  }

  const werte: PatreonKennzahlen = {
    stand: Date.now(), kampagneId,
    aktiveUnterstuetzer: aktiv, deklinierteUnterstuetzer: deklination, ehemaligeUnterstuetzer: ehemalig,
    follower, monatlicheEinnahmenCents: einnahmenCents, waehrung, neuDiesenMonat, abgaengeDiesenMonat: null,
  };
  momentaufnahmeSichernFallsFaellig(werte);
  return werte;
}

/**
 * Patreon kennt kein "ehemalig seit wann" — die einzige Quelle für einen
 * Verlauf ist eine eigene, regelmäßige Momentaufnahme (siehe schema.sql,
 * Tabelle `verkauf_momentaufnahmen`, und der Auftrag "Verkaufsstatistik
 * ausbauen"). Höchstens eine Zeile je Tag (Primärschlüssel anbieter+tag,
 * UTC): ruft `patreonKennzahlen()` mehrfach am selben Tag auf — was der
 * Fünfzehn-Minuten-Zwischenspeicher oben ohnehin selten macht —, wird nur
 * die Zeile des heutigen Tages aktualisiert, nicht eine zweite angelegt.
 * Läuft absichtlich HIER, nicht in einem eigenen Hintergrundlauf: dieselbe
 * Netzabfrage wird so mitbenutzt, statt Patreon ein zweites Mal für
 * denselben Stand zu behelligen.
 */
function momentaufnahmeSichernFallsFaellig(werte: PatreonKennzahlen): void {
  const tag = new Date(werte.stand).toISOString().slice(0, 10);
  db.run(
    `INSERT INTO verkauf_momentaufnahmen (
       anbieter, tag, erfasst_am, aktive, deklination, ehemalig, follower, einnahmen_cent, waehrung, neu_diesen_monat
     ) VALUES ('patreon', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(anbieter, tag) DO UPDATE SET
       erfasst_am = excluded.erfasst_am, aktive = excluded.aktive, deklination = excluded.deklination,
       ehemalig = excluded.ehemalig, follower = excluded.follower, einnahmen_cent = excluded.einnahmen_cent,
       waehrung = excluded.waehrung, neu_diesen_monat = excluded.neu_diesen_monat`,
    tag, werte.stand, werte.aktiveUnterstuetzer, werte.deklinierteUnterstuetzer, werte.ehemaligeUnterstuetzer,
    werte.follower, werte.monatlicheEinnahmenCents, werte.waehrung, werte.neuDiesenMonat,
  );
}

export interface PatreonMomentaufnahme {
  tag: string; aktive: number; deklination: number; ehemalig: number; follower: number;
  einnahmenCents: number; waehrung: string | null; neuDiesenMonat: number;
}

/** Der Verlauf, wie er wirklich entstanden ist: eine Zeile je Tag, an dem
 *  die Kennzahlen abgerufen wurden — keine Zeile für einen Tag, an dem der
 *  Server nicht lief oder niemand die Verkaufskachel geöffnet hat. Das ist
 *  ehrlicher als Lücken zu erfinden, aber es heißt auch: der Verlauf ist so
 *  vollständig, wie die Kachel benutzt wurde, nicht lückenlos von Anfang an. */
export function patreonVerlauf(tageAnzahl = 90): PatreonMomentaufnahme[] {
  return db.all<{
    tag: string; aktive: number; deklination: number; ehemalig: number; follower: number;
    einnahmen_cent: number; waehrung: string | null; neu_diesen_monat: number;
  }>(
    `SELECT tag, aktive, deklination, ehemalig, follower, einnahmen_cent, waehrung, neu_diesen_monat
     FROM verkauf_momentaufnahmen WHERE anbieter = 'patreon' ORDER BY tag DESC LIMIT ?`,
    tageAnzahl,
  ).reverse().map((z) => ({
    tag: z.tag, aktive: z.aktive, deklination: z.deklination, ehemalig: z.ehemalig, follower: z.follower,
    einnahmenCents: z.einnahmen_cent, waehrung: z.waehrung, neuDiesenMonat: z.neu_diesen_monat,
  }));
}

/**
 * Die echten Zahlen, höchstens KENNZAHLEN_FRIST_MS alt. Gleiches Muster wie
 * systemwerte.werte(): mehrere gleichzeitige Anfragen teilen sich einen
 * Abruf, und ein einzelner Fehlschlag leert nicht die zuletzt bekannten
 * Zahlen, sondern reicht sie weiter.
 */
export async function patreonKennzahlen(): Promise<PatreonKennzahlen> {
  const jetzt = Date.now();
  if (kennzahlenStand && jetzt - kennzahlenStand.zeit < KENNZAHLEN_FRIST_MS) return kennzahlenStand.werte;
  if (kennzahlenLaufen) return kennzahlenLaufen;
  kennzahlenLaufen = kennzahlenHolen()
    .then((w) => { kennzahlenStand = { zeit: Date.now(), werte: w }; return w; })
    .finally(() => { kennzahlenLaufen = null; });
  try {
    return await kennzahlenLaufen;
  } catch (err) {
    if (kennzahlenStand) return kennzahlenStand.werte;
    throw err;
  }
}
