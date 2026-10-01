/**
 * Gumroad: rohe Verkäufe und Abonnements ablegen, Kennzahlen daraus rechnen.
 *
 * Getrennt von server-setup/stellium-konsole.mjs, ganz bewusst. Die Konsole
 * dort bedient die kleine Übersichtskachel und das Terminalbild auf dem Pi
 * selbst — beides funktioniert, beides bleibt unangetastet. Diese Datei hier
 * ist die neue, ausführliche Ansicht, und die braucht etwas, das eine
 * gecachte JSON-Datei nicht hergibt: Zahlen, die sich nachträglich RICHTIG
 * STELLEN, wenn eine Erstattung erst Wochen nach dem Verkauf eintrifft. Das
 * geht nur mit einer echten Ablage — deshalb Tabellen statt einer Datei, und
 * deshalb dieselbe Bauart wie services/patreon.ts (Zugriff über den
 * gespeicherten Token, Fastify-Server hat direkten Datenbankzugriff), nicht
 * die der Konsole (abgekoppelter Kindprozess, Datei als Übergabe).
 *
 * ENTWURFSENTSCHEIDUNG 1 — ROH SPEICHERN, SUMMEN RECHNEN:
 * `gumroadVerkaeufeSpeichern` / `gumroadAbonnentenSpeichern` legen JEDEN
 * Datensatz einzeln ab, mit Gumroads eigener Kennung als Primärschlüssel.
 * Ein erneuter Sync-Lauf AKTUALISIERT dieselbe Zeile (ON CONFLICT), zählt sie
 * nie doppelt — und weil eine bereits gespeicherte Zeile beim nächsten Mal
 * einfach überschrieben wird, korrigiert eine späte Erstattung automatisch
 * den Monat des ursprünglichen Verkaufs, nicht den Monat, in dem die
 * Erstattung ankam. `gumroadBerechnen` liest bei JEDEM Aufruf frisch aus
 * diesen Rohdaten — es gibt nirgends eine gespeicherte Summe, die veralten
 * könnte.
 *
 * ENTWURFSENTSCHEIDUNG 2 — KEIN INKREMENTELLER ABRUF:
 * Jeder Sync-Lauf holt Verkäufe seit einem weit zurückliegenden Datum neu,
 * nicht nur "seit dem letzten Mal". Das ist bei Gumroad nötig, weil eine
 * Erstattung das ERSTELLUNGSDATUM eines Verkaufs nicht ändert — ein Sync nur
 * "seit gestern" würde einen drei Monate alten Verkauf nie wieder abfragen
 * und eine Erstattung darauf nie sehen. Bei der aktuellen Größe (eine
 * Handvoll Produkte, heute null Verkäufe) ist das billig; wächst der Bestand
 * einmal sehr groß, wäre eine inkrementelle Abfrage mit regelmäßigem vollen
 * Abgleich der nächste Schritt — siehe Bericht am Auftragsende.
 */
import { db } from '../db/index.js';
import { tokenLesen } from './verkaufzugang.js';
import { kursFuerDatum, kursZaehlerZuruecksetzen } from './wechselkurse.js';
import { ereignisseVerarbeiten, type VerkaufEreignisEingabe } from './verkaufBenachrichtigung.js';

const API_BASE = 'https://api.gumroad.com/v2';
const ZEITLIMIT_MS = 15_000;
/* Wie viele Seiten ein einzelner Abruf höchstens durchblättert — großzügiger
   als die Diagnose (die nur einmalig läuft), aber immer noch gedeckelt: ein
   hängender "next_page_url" soll nie eine Endlosschleife auf einem Pi
   auslösen. 20 Seiten à ~25-100 Zeilen decken diesen Geschäftsumfang um
   Größenordnungen ab. */
const MAX_SEITEN = 20;
/* Wie weit zurück Verkäufe abgefragt werden — siehe Dateikopf, Punkt 2. */
const VERKAEUFE_SEIT = '2020-01-01';
const MAX_PRODUKTE = 20;

/** Wie viele Monate eine Laufzeit umfasst — dieselbe Tabelle wie in
 *  stellium-konsole.mjs (dort LAUFZEIT_MONATE), unabhängig dupliziert: die
 *  beiden Dateien haben keine gemeinsame Importquelle (siehe Dateikopf). */
const LAUFZEIT_MONATE: Record<string, number> = {
  monthly: 1, quarterly: 3, biannually: 6, yearly: 12, every_two_years: 24,
};

/** Ist das eine wirkliche Zahl? `Number(null)` ist 0 — wer nur auf
 *  `Number.isFinite` prüft, macht aus "unbekannt" eine stille Null. */
export function zahl(wert: unknown): number | null {
  if (wert === null || wert === undefined || wert === '') return null;
  const n = Number(wert);
  return Number.isFinite(n) ? n : null;
}

function zeitpunkt(wert: unknown): number | null {
  if (typeof wert !== 'string' || !wert) return null;
  const ms = Date.parse(wert);
  return Number.isFinite(ms) ? ms : null;
}

function bool01(wert: unknown): 0 | 1 { return wert ? 1 : 0; }

/* ── Rohe Gumroad-Formen (nur die Felder, die wir wirklich benutzen) ──── */

export interface RohVerkauf {
  id: string;
  product_id?: string | null;
  subscription_id?: string | null;
  price?: number | string | null;
  gumroad_fee?: number | string | null;
  created_at?: string | null;
  refunded?: boolean;
  partially_refunded?: boolean;
  amount_refundable_in_currency?: number | string | null;
  disputed?: boolean;
  dispute_won?: boolean;
  /* Zwei Schreibweisen — siehe laufzeitVonVerkauf() und istRueckgebucht(). */
  chargedback?: boolean;
  chargebacked?: boolean;
  recurrence?: string | null;
  subscription_duration?: string | null;
}

export interface RohAbonnent {
  id: string;
  product_id?: string | null;
  status?: string | null;
  recurrence?: string | null;
  created_at?: string | null;
  free_trial_ends_at?: string | null;
  cancelled_at?: string | null;
  ended_at?: string | null;
  failed_at?: string | null;
}

export interface RohAuszahlung {
  id: string;
  amount?: number | string | null;
  currency?: string | null;
  status?: string | null;
  [feld: string]: unknown;
}

/** Gumroad nennt dasselbe Feld je nach Endpunkt anders: `/v2/sales` (und
 *  damit alles, was hier ankommt) benutzt `recurrence` für den Verkauf ODER
 *  `subscription_duration` — live an unterschiedlichen Antworten beobachtet.
 *  Beide prüfen statt sich auf eine zu verlassen, aus demselben Grund wie bei
 *  chargedback/chargebacked unten: die falsche Annahme fällt sonst erst auf,
 *  wenn Gumroad wirklich die andere Schreibweise schickt. */
export function laufzeitVonVerkauf(v: RohVerkauf): string | null {
  return v.recurrence ?? v.subscription_duration ?? null;
}

/** Gumroads Doku (archive.org, Snapshot 4.12.2025): `/v2/sales` nennt das
 *  Feld `chargedback`, `/v2/licenses/*` (eine andere Ressource) dagegen
 *  `chargebacked`. Nur eine Schreibweise zu prüfen hieße, eine echte
 *  Rückbuchung könnte still als Umsatz weiterzählen. */
export function istRueckgebucht(v: RohVerkauf): boolean {
  return !!(v.chargedback || v.chargebacked);
}

/** Zählt dieser Verkauf gerade als Umsatz? Vollständige Erstattung,
 *  Anfechtung oder Rückbuchung nehmen das Geld wieder weg. Eine TEILWEISE
 *  Erstattung (`partially_refunded`) zählt hier bewusst weiter voll mit —
 *  Gumroad gibt mit `amount_refundable_in_currency` nur den noch
 *  erstattungsfähigen Rest an, nicht den bereits erstatteten Betrag, und ohne
 *  einen echten Fall zum Nachprüfen wäre jede Umrechnung geraten. Die Zahl
 *  `teilerstattet` steht separat in der Übersicht (siehe gumroadBerechnen),
 *  gut sichtbar statt still in den Umsatz gemischt. */
export function zaehltAlsUmsatz(v: RohVerkauf): boolean {
  return !v.refunded && !v.disputed && !istRueckgebucht(v);
}

/* ── Speichern: roh ablegen, per Kennung aktualisieren ─────────────────── */

/**
 * Verkäufe ablegen. Der Wechselkurs zum Verkaufsdatum wird nur einmal
 * aufgelöst — `COALESCE` beim Update lässt einen bereits bekannten Kurs
 * stehen, auch wenn eine spätere Auflösung (rein rechnerisch) zum selben
 * Ergebnis käme. Das erspart unnötige Anfragen an einen fremden Dienst,
 * siehe services/wechselkurse.ts.
 */
export async function gumroadVerkaeufeSpeichern(
  verkaeufe: RohVerkauf[], waehrung = 'USD',
): Promise<{ gespeichert: number }> {
  let gespeichert = 0;
  for (const v of verkaeufe) {
    if (!v?.id) continue;
    const erstelltAm = zeitpunkt(v.created_at);
    let kursWert: number | null = null;
    let kursDatum: string | null = null;
    if (erstelltAm !== null && waehrung !== 'EUR') {
      const tag = new Date(erstelltAm).toISOString().slice(0, 10);
      const kurs = await kursFuerDatum(tag, waehrung, 'EUR');
      if (kurs) { kursWert = kurs.kurs; kursDatum = kurs.quelldatum ?? tag; }
    }
    db.run(
      `INSERT INTO verkauf_gumroad_verkaeufe (
         id, produkt_id, subscription_id, preis_cent, gebuehr_cent, waehrung, laufzeit,
         erstellt_am, erstattet, teilerstattet, erstattbar_cent, angefochten,
         anfechtung_gewonnen, rueckgebucht, kurs_eur_je_usd, kurs_datum, zuletzt_gesehen_am
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         produkt_id = excluded.produkt_id,
         subscription_id = excluded.subscription_id,
         preis_cent = excluded.preis_cent,
         gebuehr_cent = excluded.gebuehr_cent,
         waehrung = excluded.waehrung,
         laufzeit = excluded.laufzeit,
         erstellt_am = excluded.erstellt_am,
         erstattet = excluded.erstattet,
         teilerstattet = excluded.teilerstattet,
         erstattbar_cent = excluded.erstattbar_cent,
         angefochten = excluded.angefochten,
         anfechtung_gewonnen = excluded.anfechtung_gewonnen,
         rueckgebucht = excluded.rueckgebucht,
         /* Einmal aufgelöst, bleibt stehen — siehe Dateikopf. */
         kurs_eur_je_usd = COALESCE(verkauf_gumroad_verkaeufe.kurs_eur_je_usd, excluded.kurs_eur_je_usd),
         kurs_datum = COALESCE(verkauf_gumroad_verkaeufe.kurs_datum, excluded.kurs_datum),
         zuletzt_gesehen_am = excluded.zuletzt_gesehen_am`,
      v.id, v.product_id ?? null, v.subscription_id ?? null,
      zahl(v.price) ?? 0, zahl(v.gumroad_fee) ?? 0, waehrung, laufzeitVonVerkauf(v),
      erstelltAm, bool01(v.refunded), bool01(v.partially_refunded), zahl(v.amount_refundable_in_currency),
      bool01(v.disputed), v.dispute_won === undefined ? null : bool01(v.dispute_won),
      bool01(istRueckgebucht(v)), kursWert, kursDatum, Date.now(),
    );
    gespeichert += 1;
  }
  return { gespeichert };
}

export async function gumroadAbonnentenSpeichern(
  abonnenten: RohAbonnent[],
): Promise<{ gespeichert: number }> {
  let gespeichert = 0;
  for (const a of abonnenten) {
    if (!a?.id || !a.status) continue;
    db.run(
      `INSERT INTO verkauf_gumroad_abonnenten (
         id, produkt_id, status, laufzeit, erstellt_am, probe_bis,
         gekuendigt_am, beendet_am, fehlgeschlagen_am, zuletzt_gesehen_am
       ) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         produkt_id = excluded.produkt_id,
         status = excluded.status,
         laufzeit = excluded.laufzeit,
         erstellt_am = excluded.erstellt_am,
         probe_bis = excluded.probe_bis,
         gekuendigt_am = excluded.gekuendigt_am,
         beendet_am = excluded.beendet_am,
         fehlgeschlagen_am = excluded.fehlgeschlagen_am,
         zuletzt_gesehen_am = excluded.zuletzt_gesehen_am`,
      a.id, a.product_id ?? null, a.status, a.recurrence ?? null,
      zeitpunkt(a.created_at), zeitpunkt(a.free_trial_ends_at),
      zeitpunkt(a.cancelled_at), zeitpunkt(a.ended_at), zeitpunkt(a.failed_at), Date.now(),
    );
    gespeichert += 1;
  }
  return { gespeichert };
}

/** Best-effort: welches Feld auf einer Gumroad-Auszahlung die Zahlungsart
 *  trägt, ist ohne echten Zugang nicht bestätigt (siehe schema.sql). Diese
 *  Liste ist eine Vermutung anhand üblicher Gumroad-Feldnamen, keine
 *  geprüfte Tatsache — deshalb `rohdaten` als Netz daneben. */
function zahlungsartRaten(p: RohAuszahlung): string | null {
  const kandidat = p.payment_processor ?? p.processor ?? p.type ?? p.payout_method ?? null;
  return typeof kandidat === 'string' && kandidat ? kandidat : null;
}

export async function gumroadAuszahlungenSpeichern(
  auszahlungen: RohAuszahlung[],
): Promise<{ gespeichert: number }> {
  let gespeichert = 0;
  for (const p of auszahlungen) {
    if (!p?.id) continue;
    db.run(
      `INSERT INTO verkauf_gumroad_auszahlungen (id, betrag, waehrung, status, zahlungsart, rohdaten, zuletzt_gesehen_am)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         betrag = excluded.betrag, waehrung = excluded.waehrung, status = excluded.status,
         zahlungsart = excluded.zahlungsart, rohdaten = excluded.rohdaten, zuletzt_gesehen_am = excluded.zuletzt_gesehen_am`,
      p.id, zahl(p.amount), p.currency ?? null, p.status ?? null,
      zahlungsartRaten(p), JSON.stringify(p), Date.now(),
    );
    gespeichert += 1;
  }
  return { gespeichert };
}

/* ── Abruf gegen die echte Gumroad-Schnittstelle ───────────────────────── */

class GumroadApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'GumroadApiError'; }
}

async function abruf(pfad: string, token: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZEITLIMIT_MS);
  try {
    const url = pfad.startsWith('http') ? pfad : `${API_BASE}${pfad}`;
    const verbunden = url.includes('?') ? `${url}&access_token=${encodeURIComponent(token)}`
      : `${url}?access_token=${encodeURIComponent(token)}`;
    const res = await fetch(verbunden, { signal: ctrl.signal });
    if (!res.ok) throw new GumroadApiError(res.status, `Gumroad antwortet ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function listeHolen(pfad: string, token: string, listenSchluessel: string): Promise<any[]> {
  let adresse: string | null = pfad;
  let seiten = 0;
  let ergebnis: any[] = [];
  while (adresse && seiten < MAX_SEITEN) {
    const antwort = await abruf(adresse, token);
    const teil = antwort?.[listenSchluessel];
    if (Array.isArray(teil)) ergebnis = ergebnis.concat(teil);
    seiten += 1;
    adresse = antwort?.next_page_url ? `https://api.gumroad.com${antwort.next_page_url}` : null;
  }
  return ergebnis;
}

export interface GumroadSyncErgebnis {
  ok: boolean;
  grund?: string;
  produkte: number;
  verkaeufe: number;
  abonnenten: number;
  auszahlungen: number;
}

/** Der eigentliche Sync-Lauf: alle Produkte, alle Verkäufe, alle Abonnenten
 *  je Produkt, alle Auszahlungen — kontoweit, siehe Dateikopf. */
export async function gumroadSyncLauf(): Promise<GumroadSyncErgebnis> {
  const token = tokenLesen();
  if (!token) return { ok: false, grund: 'kein-token', produkte: 0, verkaeufe: 0, abonnenten: 0, auszahlungen: 0 };

  kursZaehlerZuruecksetzen();

  try {
    const produkteAntwort = await abruf('/products', token);
    /* `name` ist ein bestätigtes Feld von /v2/products — live geprüft, siehe
       server-setup/stellium-konsole.mjs, gumroadDiagnose() ("Katalog des
       Kontos ... eigene Produkte des Verkäufers, keine Kundendaten"). Nur für
       die Verkaufsmeldung gebraucht (siehe unten); nirgends sonst in dieser
       Datei verwendet, deshalb keine eigene Ablage dafür — der Name wird
       direkt aus DIESEM Abruf gelesen, nicht aus einer zweiten, potenziell
       veralteten Kopie. */
    const produkte: { id: string; name?: string | null; currency?: string | null }[] =
      (produkteAntwort?.products ?? []).slice(0, MAX_PRODUKTE);
    /* Vereinfachung: EINE Leitwährung fürs ganze Konto (die des ersten
       Produkts) statt einer Karte je Produkt-ID. Bei praktisch jedem
       Gumroad-Konto stimmt das — ein Verkäufer stellt sein Konto auf eine
       Währung, nicht jedes Produkt einzeln. Träfe das eines Tages nicht mehr
       zu, bräuchte gumroadVerkaeufeSpeichern eine Karte je Produkt-ID statt
       eines einzelnen Werts; siehe Bericht am Auftragsende. */
    const waehrung = String(produkte[0]?.currency ?? 'usd').toUpperCase();

    const sales = await listeHolen(`/sales?after=${VERKAEUFE_SEIT}`, token, 'sales');
    const { gespeichert: verkaeufeGespeichert } = await gumroadVerkaeufeSpeichern(sales, waehrung);

    let abonnentenGespeichert = 0;
    for (const p of produkte) {
      if (!p.id) continue;
      const subs = await listeHolen(`/products/${encodeURIComponent(p.id)}/subscribers?paginated=true`, token, 'subscribers');
      const { gespeichert } = await gumroadAbonnentenSpeichern(subs);
      abonnentenGespeichert += gespeichert;
    }

    let auszahlungenGespeichert = 0;
    try {
      const payouts = await listeHolen('/payouts', token, 'payouts');
      const { gespeichert } = await gumroadAuszahlungenSpeichern(payouts);
      auszahlungenGespeichert = gespeichert;
    } catch {
      /* Auszahlungen sind ein Zusatz, kein Kernstück — ein Fehlschlag hier
         soll Verkäufe und Abonnenten nicht mit hinreißen. */
    }

    /* Verkaufsmeldung: "ein Kauf ist passiert" — siehe
       services/verkaufBenachrichtigung.ts für die Dublettensperre und die
       Bündelung. Läuft NACH dem Abonnenten-Block oben, ausdrücklich nicht
       davor: `probe_bis` unten muss der Stand NACH diesem Sync-Lauf sein,
       nicht der von vor einer Minute. In try/catch wie der
       Auszahlungen-Block — ein Fehler hier ist ein Fehler in der Meldung
       über einen Verkauf, nicht im Verkauf selbst, und darf das Ergebnis
       dieses Sync-Laufs nicht mit sich reißen. Absichtlich NICHT Teil von
       gumroadVerkaeufeSpeichern() selbst: das bleibt die reine
       Ablage-Funktion, unverändert von pruefungen/verkaufsstatistik.mts
       direkt gegen sie geprüft. */
    try {
      const produktName = new Map(produkte.map((p) => [p.id, p.name ?? null]));
      const eingaben: VerkaufEreignisEingabe[] = [];
      for (const v of sales) {
        if (!v.id || !zaehltAlsUmsatz(v)) continue;
        const abo = v.subscription_id ?? null;
        /* Neuer Abonnent oder Verlängerung? Verlängerungen legen eine NEUE
           Zeile mit demselben subscription_id an (siehe Dateikopf, Punkt zu
           laufzeitVonVerkauf/subscription_duration weiter unten in dieser
           Datei) — trägt `verkauf_gumroad_verkaeufe` schon eine ANDERE Zeile
           mit demselben subscription_id, ist dies nicht die erste Abbuchung.
           Nur ÄLTERE Zeilen zählen: die Ablage oben hat alle Verkäufe dieses
           Laufs schon geschrieben — fallen Erstkauf und erste Verlängerung in
           denselben Lauf (die Kachel war einen Monat zu), stünde sonst die
           Verlängerung als „andere Zeile" neben dem Erstkauf, und der neue
           Abonnent würde nie als neu gemeldet. */
        const erstelltAm = zeitpunkt(v.created_at);
        const aelterVorhanden = !abo ? false : (erstelltAm !== null
          ? db.get<{ n: number }>(
              'SELECT COUNT(*) as n FROM verkauf_gumroad_verkaeufe WHERE subscription_id = ? AND id != ? AND erstellt_am < ?',
              abo, v.id, erstelltAm,
            )?.n ?? 0
          : db.get<{ n: number }>(
              'SELECT COUNT(*) as n FROM verkauf_gumroad_verkaeufe WHERE subscription_id = ? AND id != ?',
              abo, v.id,
            )?.n ?? 0) > 0;
        const art = !abo ? 'einmalig' as const
          : aelterVorhanden ? 'verlaengerung' as const : 'neu' as const;
        const probeBis = abo
          ? db.get<{ probe_bis: number | null }>(
              'SELECT probe_bis FROM verkauf_gumroad_abonnenten WHERE id = ?', abo,
            )?.probe_bis ?? null
          : null;
        eingaben.push({
          fingerabdruck: `gumroad:verkauf:${v.id}`,
          art,
          produktName: produktName.get(v.product_id ?? '') ?? null,
          betragCent: zahl(v.price),
          waehrung,
          inProbe: probeBis !== null ? probeBis > Date.now() : null,
        });
      }
      ereignisseVerarbeiten('gumroad', eingaben);
    } catch (err) {
      console.error('[gumroad] Verkaufsmeldung:', (err as Error)?.message ?? err);
    }

    return {
      ok: true, produkte: produkte.length, verkaeufe: verkaeufeGespeichert,
      abonnenten: abonnentenGespeichert, auszahlungen: auszahlungenGespeichert,
    };
  } catch (f) {
    const grund = f instanceof GumroadApiError ? f.message : String((f as Error)?.message ?? f);
    return { ok: false, grund, produkte: 0, verkaeufe: 0, abonnenten: 0, auszahlungen: 0 };
  }
}

/* ── Berechnen: frisch aus den Rohdaten, bei jedem Aufruf ──────────────── */

export interface GumroadUebersicht {
  stand: number;
  hatDaten: boolean;
  /** Steckt ein Gumroad-Token in den Einstellungen? Unterscheidet "noch
   *  nicht eingerichtet" (Hinweis: Einstellungen öffnen) von "eingerichtet,
   *  aber wirklich null Verkäufe" (Hinweis: abwarten) — beides sieht in
   *  `hatDaten: false` sonst gleich aus. */
  tokenVorhanden: boolean;
  waehrung: string;
  umsatz: {
    monatCent: number; zahlend: number; inProbe: number;
    aufteilung: { laufzeit: string; anzahl: number; monatCent: number }[];
  };
  abonnenten: {
    aktiv: number; probe: number; zahlend: number; gekuendigt: number; gescheitert: number;
    statusVerteilung: Record<string, number>;
  };
  verlauf: { monat: string; bruttoCent: number; nettoCent: number; anzahl: number }[];
  zuAbgaenge: { monat: string; neu: number; abgang: number }[];
  erstattungen: { anzahl: number; betragCent: number; teilweise: number };
  anfechtungen: { anzahl: number; betragCent: number };
  rueckbuchungen: { anzahl: number; betragCent: number };
  einmalig: { anzahl: number; bruttoCent: number };
  wiederkehrend: { anzahl: number; bruttoCent: number };
  auszahlungen: { status: string; waehrung: string | null; anzahl: number; summeRoh: number }[];
}

export function gumroadBerechnen(jetzt = Date.now()): GumroadUebersicht {
  const anzahlVerkaeufe = db.get<{ n: number }>('SELECT COUNT(*) as n FROM verkauf_gumroad_verkaeufe')?.n ?? 0;
  const anzahlAbos = db.get<{ n: number }>('SELECT COUNT(*) as n FROM verkauf_gumroad_abonnenten')?.n ?? 0;
  const hatDaten = anzahlVerkaeufe > 0 || anzahlAbos > 0;

  const waehrungZeile = db.get<{ waehrung: string }>(
    'SELECT waehrung, COUNT(*) as n FROM verkauf_gumroad_verkaeufe GROUP BY waehrung ORDER BY n DESC LIMIT 1',
  );
  const waehrung = waehrungZeile?.waehrung ?? 'USD';

  /* ── Abonnenten nach Status, Probezeit getrennt ──────────────────────
     `>` (nicht `>=`) am Ablaufmoment: bis genau zur Sekunde des Ablaufs
     zählt jemand noch als in der Probewoche, ab dieser Sekunde nicht mehr —
     auch am Tag des Ablaufs selbst, siehe scripts/verkaufsstatistik-pruefen.mjs. */
  const statusZeilen = db.all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) as n FROM verkauf_gumroad_abonnenten GROUP BY status',
  );
  const statusVerteilung = Object.fromEntries(statusZeilen.map((z) => [z.status, z.n]));
  const aktiv = (statusVerteilung.alive ?? 0) + (statusVerteilung.pending_cancellation ?? 0);
  const probe = db.get<{ n: number }>(
    `SELECT COUNT(*) as n FROM verkauf_gumroad_abonnenten
     WHERE status IN ('alive','pending_cancellation') AND probe_bis IS NOT NULL AND probe_bis > ?`,
    jetzt,
  )?.n ?? 0;
  const gekuendigt = (statusVerteilung.pending_cancellation ?? 0) + (statusVerteilung.cancelled ?? 0);
  const gescheitert = (statusVerteilung.failed_payment ?? 0) + (statusVerteilung.pending_failure ?? 0);

  /* ── Monatlich wiederkehrender Umsatz aus den WIRKLICHEN Abos ────────
     Je aktivem, zahlendem Abonnenten der Preis aus seinem jüngsten
     Verkaufsdatensatz (Verlängerungen legen neue Zeilen mit demselben
     subscription_id an — die jüngste gilt, ein Alttarif bleibt beim
     Alttarif stehen, nicht beim heutigen Preis). */
  const abosMitPreis = db.all<{ id: string; abo_laufzeit: string | null; preis_cent: number | null; verkauf_laufzeit: string | null; probe_bis: number | null }>(
    `SELECT a.id, a.laufzeit as abo_laufzeit, a.probe_bis, v.preis_cent, v.laufzeit as verkauf_laufzeit
     FROM verkauf_gumroad_abonnenten a
     LEFT JOIN verkauf_gumroad_verkaeufe v
       ON v.subscription_id = a.id
       AND v.erstellt_am = (SELECT MAX(v2.erstellt_am) FROM verkauf_gumroad_verkaeufe v2 WHERE v2.subscription_id = a.id)
     WHERE a.status IN ('alive','pending_cancellation')`,
  );
  const aufteilungKarte = new Map<string, { laufzeit: string; anzahl: number; monatCent: number }>();
  let monatCentSumme = 0;
  let zahlendMitPreis = 0;
  for (const a of abosMitPreis) {
    const inProbe = a.probe_bis !== null && a.probe_bis > jetzt;
    if (inProbe) continue;
    const laufzeit = a.abo_laufzeit ?? a.verkauf_laufzeit;
    const monate = laufzeit ? LAUFZEIT_MONATE[laufzeit] : null;
    if (!monate || a.preis_cent === null) continue;
    const jeMonat = a.preis_cent / monate;
    monatCentSumme += jeMonat;
    zahlendMitPreis += 1;
    const eintrag = aufteilungKarte.get(laufzeit!) ?? { laufzeit: laufzeit!, anzahl: 0, monatCent: 0 };
    eintrag.anzahl += 1; eintrag.monatCent += jeMonat;
    aufteilungKarte.set(laufzeit!, eintrag);
  }

  /* ── Verlauf: Umsatz je Monat, nach dem VERKAUFSDATUM ───────────────
     Bewusst der Zahlungseingang je Monat (wie viel kam wirklich rein), nicht
     der rückwirkend rekonstruierte MRR-Verlauf — letzterer bräuchte, welcher
     Abonnent in JEDEM vergangenen Monat aktiv war, und das ist mit den drei
     Zeitstempeln (erstellt/gekündigt/beendet) zwar möglich, aber deutlich
     aufwendiger als für den Rahmen dieser Kachel gerechtfertigt; siehe
     Bericht am Auftragsende. */
  const verlaufZeilen = db.all<{ monat: string; bruttoCent: number; nettoCent: number; anzahl: number }>(
    `SELECT strftime('%Y-%m', erstellt_am/1000, 'unixepoch') as monat,
            SUM(CASE WHEN erstattet=0 AND angefochten=0 AND rueckgebucht=0 THEN preis_cent ELSE 0 END) as bruttoCent,
            SUM(CASE WHEN erstattet=0 AND angefochten=0 AND rueckgebucht=0 THEN preis_cent-gebuehr_cent ELSE 0 END) as nettoCent,
            SUM(CASE WHEN erstattet=0 AND angefochten=0 AND rueckgebucht=0 THEN 1 ELSE 0 END) as anzahl
     FROM verkauf_gumroad_verkaeufe WHERE erstellt_am IS NOT NULL GROUP BY monat ORDER BY monat`,
  );
  const verlauf = verlaufZeilen.slice(-12);

  /* ── Zu- und Abgänge je Monat ─────────────────────────────────────── */
  const neuZeilen = db.all<{ monat: string; n: number }>(
    `SELECT strftime('%Y-%m', erstellt_am/1000, 'unixepoch') as monat, COUNT(*) as n
     FROM verkauf_gumroad_abonnenten WHERE erstellt_am IS NOT NULL GROUP BY monat`,
  );
  const abgangZeilen = db.all<{ monat: string; n: number }>(
    `SELECT strftime('%Y-%m', COALESCE(beendet_am, gekuendigt_am)/1000, 'unixepoch') as monat, COUNT(*) as n
     FROM verkauf_gumroad_abonnenten WHERE COALESCE(beendet_am, gekuendigt_am) IS NOT NULL GROUP BY monat`,
  );
  const monate = new Set([...neuZeilen.map((z) => z.monat), ...abgangZeilen.map((z) => z.monat)]);
  const zuAbgaenge = [...monate].sort().slice(-12).map((monat) => ({
    monat,
    neu: neuZeilen.find((z) => z.monat === monat)?.n ?? 0,
    abgang: abgangZeilen.find((z) => z.monat === monat)?.n ?? 0,
  }));

  /* ── Erstattungen, Anfechtungen, Rückbuchungen — Anzahl UND Betrag ──── */
  const erstattungZeile = db.get<{ n: number; summe: number | null }>(
    'SELECT COUNT(*) as n, SUM(preis_cent) as summe FROM verkauf_gumroad_verkaeufe WHERE erstattet = 1',
  );
  const teilweiseZeile = db.get<{ n: number }>(
    'SELECT COUNT(*) as n FROM verkauf_gumroad_verkaeufe WHERE teilerstattet = 1',
  );
  const anfechtungZeile = db.get<{ n: number; summe: number | null }>(
    'SELECT COUNT(*) as n, SUM(preis_cent) as summe FROM verkauf_gumroad_verkaeufe WHERE angefochten = 1',
  );
  const rueckbuchungZeile = db.get<{ n: number; summe: number | null }>(
    'SELECT COUNT(*) as n, SUM(preis_cent) as summe FROM verkauf_gumroad_verkaeufe WHERE rueckgebucht = 1',
  );

  /* ── Einmalig gegen wiederkehrend ─────────────────────────────────── */
  const artZeilen = db.all<{ art: string; n: number; summe: number | null }>(
    `SELECT CASE WHEN subscription_id IS NULL THEN 'einmalig' ELSE 'wiederkehrend' END as art,
            COUNT(*) as n, SUM(preis_cent) as summe
     FROM verkauf_gumroad_verkaeufe WHERE erstattet=0 AND angefochten=0 AND rueckgebucht=0 GROUP BY art`,
  );
  const einmalig = artZeilen.find((z) => z.art === 'einmalig');
  const wiederkehrend = artZeilen.find((z) => z.art === 'wiederkehrend');

  /* ── Auszahlungen nach Status ─────────────────────────────────────── */
  const auszahlungen = db.all<{ status: string; waehrung: string | null; anzahl: number; summeRoh: number | null }>(
    `SELECT status, waehrung, COUNT(*) as anzahl, SUM(betrag) as summeRoh
     FROM verkauf_gumroad_auszahlungen GROUP BY status, waehrung`,
  ).map((z) => ({ ...z, summeRoh: z.summeRoh ?? 0 }));

  return {
    stand: jetzt,
    hatDaten,
    tokenVorhanden: tokenLesen() !== null,
    waehrung,
    umsatz: {
      monatCent: Math.round(monatCentSumme), zahlend: zahlendMitPreis, inProbe: probe,
      aufteilung: [...aufteilungKarte.values()].map((a) => ({ ...a, monatCent: Math.round(a.monatCent) }))
        .sort((a, b) => (LAUFZEIT_MONATE[a.laufzeit] ?? 99) - (LAUFZEIT_MONATE[b.laufzeit] ?? 99)),
    },
    abonnenten: { aktiv, probe, zahlend: aktiv - probe, gekuendigt, gescheitert, statusVerteilung },
    verlauf,
    zuAbgaenge,
    erstattungen: { anzahl: erstattungZeile?.n ?? 0, betragCent: erstattungZeile?.summe ?? 0, teilweise: teilweiseZeile?.n ?? 0 },
    anfechtungen: { anzahl: anfechtungZeile?.n ?? 0, betragCent: anfechtungZeile?.summe ?? 0 },
    rueckbuchungen: { anzahl: rueckbuchungZeile?.n ?? 0, betragCent: rueckbuchungZeile?.summe ?? 0 },
    einmalig: { anzahl: einmalig?.n ?? 0, bruttoCent: einmalig?.summe ?? 0 },
    wiederkehrend: { anzahl: wiederkehrend?.n ?? 0, bruttoCent: wiederkehrend?.summe ?? 0 },
    auszahlungen,
  };
}

/* ── Der lauwarme Zwischenspeicher: Berechnen ist billig (nur SQL-Lesen),
   nur der Netzabruf wird gedrosselt ────────────────────────────────────
   Anders als bei services/patreon.ts (dort ist JEDER Aufruf ein Netzabruf,
   deshalb wird das GANZE Ergebnis zwischengespeichert) liest
   gumroadBerechnen() nur aus der eigenen Datenbank — das darf bei jedem
   Aufruf frisch laufen. Gedrosselt wird ausschließlich gumroadSyncLauf(),
   der fremde Schnittstelle behelligt. */
const SYNC_FRIST_MS = 15 * 60_000;
let letzterSyncVersuch = 0;
let syncLaeuft: Promise<GumroadSyncErgebnis> | null = null;

export async function gumroadKennzahlen(): Promise<GumroadUebersicht> {
  const jetzt = Date.now();
  if (jetzt - letzterSyncVersuch >= SYNC_FRIST_MS && !syncLaeuft) {
    letzterSyncVersuch = jetzt;
    syncLaeuft = gumroadSyncLauf()
      .catch((f) => {
        console.error('[gumroad] Sync-Lauf:', (f as Error)?.message ?? f);
        return { ok: false, produkte: 0, verkaeufe: 0, abonnenten: 0, auszahlungen: 0 } as GumroadSyncErgebnis;
      })
      .finally(() => { syncLaeuft = null; });
    /* Lieber alte Zahlen sofort als jede Anfrage auf einen vollen
       Seitenumlauf warten zu lassen — anders als bei Patreon oben ist
       "berechnen" hier so billig, dass ein Aufrufer nicht auf den Netzabruf
       warten muss; der nächste Aufruf (Sekunden später) sieht die neuen
       Zeilen dann von selbst. */
    await Promise.race([syncLaeuft, new Promise((f) => setTimeout(f, 2500))]);
  }
  return gumroadBerechnen();
}
