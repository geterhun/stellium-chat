/**
 * Briefpartner nach Gruppe — Intern, Kunden, Firmen, Lieferanten, Bewerber,
 * Behörden, Sonstige, und beliebig viele Gruppen, die ein Mensch selbst
 * anlegt.
 *
 * EIGENSTÄNDIG, GENAU EINE EINTRITTSSTELLE
 *
 * `components/PostPanel.tsx` ist gerade in fremder Hand (siehe die Aufgabe)
 * — diese Tafel hängt sich deshalb nirgends dort ein. Sie holt ihre Daten
 * selbst (eigener kleiner Ersatz für `request()` aus net/api.ts, genau wie
 * PostPanel.tsx es für sich selbst schon vormacht, aus demselben Grund: die
 * eine Datei, die beide bräuchten, wird gerade woanders bearbeitet), zeigt
 * sich selbst als eigenes Fenster (`Shell`, wie jedes andere Fenster im
 * Haus) und braucht nur EINE Zeile, um zu erscheinen — siehe
 * state/partnergruppen.ts für die Tür (offen/öffnen/schließen) und den
 * Bericht am Ende der Aufgabe für die genaue Stelle in Rail.tsx und
 * App.tsx.
 *
 * Wer stattdessen die Gruppe direkt neben einer geöffneten Mail sehen will
 * (in PostPanel.tsx), kann optional `<PartnerGruppenBadge adresse={...} />`
 * einhängen (weiter unten, ebenfalls hier exportiert) — das ist ein
 * Bonus-Einstiegspunkt für später, keine Voraussetzung: diese Tafel hier
 * deckt "Gruppe je Briefpartner, änderbar", "Vorschlag erkennbar", "nach
 * Gruppe filtern" und "eigene Gruppen anlegen/umbenennen/löschen" bereits
 * vollständig ab, unabhängig davon, ob die Badge irgendwo eingehängt wird.
 *
 * EINGEBAUT VS. BENUTZERDEFINIERT
 *
 * `alleGruppen()` auf dem Server (services/post-partnergruppen.ts) liefert
 * BEIDE Arten als EINE Liste (`PartnerGruppeInfo[]` aus @stellium/shared):
 * eingebaute Gruppen (`eingebaut: true`, `name: null` — ihre Beschriftung
 * kommt über `partnerGruppen.gruppe.<id>` aus dem Wörterbuch, wie jeder
 * andere Text auch) und benutzerdefinierte (`eingebaut: false`, `name` ist
 * genau der Wortlaut, den die Person eingegeben hat). Der zweite Fall geht
 * NIE durch `t()` — das wäre eine Übersetzung erfinden, wo keine existiert
 * und keine gebraucht wird (der Name IST schon Text, in der Sprache, in der
 * er eingegeben wurde).
 *
 * Anlegen/Umbenennen/Löschen einer eigenen Gruppe braucht `mail.verwalten`
 * (dieselbe Schwelle wie das Einrichten des Postfach-Zugangs — eine
 * Änderung, die jede Person mit Postfach-Zugriff sieht, ist Einrichtung,
 * kein Tagesgeschäft) und ist deshalb strenger als das Ändern der Gruppe
 * EINES Briefpartners weiter unten (`mail.senden`, siehe `darfAendern`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, Pencil, Plus, RefreshCw, Trash2, Users, X } from 'lucide-react';
import type { MailPartner, PartnerGruppeInfo } from '@stellium/shared';
import { PARTNER_GRUPPEN } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { t as tStatisch, useT, type TranslationKey } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { ApiError, serverUrl, token } from '../net/api.js';
import { clsx, relativeTime } from '../lib/format.js';
import { kollidiertMitEingebautemAnzeigenamen } from '../lib/partnergruppen-name.js';

/* ── Abruf — eigener, kleiner Ersatz für request() aus net/api.ts ────
   Siehe Dateikopf: net/api.ts wird an anderer Stelle bearbeitet, und diese
   Tafel soll die Datei nicht anfassen müssen. Spiegelt nur, was sie braucht
   — Basisadresse, Anmeldenachweis, das Lesen von `code`/`error` aus einer
   Fehlerantwort — damit vorhandene Übersetzungen für Fehlerkennungen (etwa
   'fehler.unbekannteGruppe' aus routes.ts) auch hier greifen. */
async function partnerFetch<T>(pfad: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null) headers.set('content-type', 'application/json');
  const nachweis = token();
  if (nachweis) headers.set('authorization', `Bearer ${nachweis}`);

  let antwort: Response;
  try {
    antwort = await fetch(`${serverUrl()}${pfad}`, { ...init, headers });
  } catch {
    throw new ApiError(tStatisch('api.serverUnreachable', { adresse: serverUrl() }), 0);
  }

  if (!antwort.ok) {
    let message = tStatisch('api.error', { status: antwort.status });
    let code: string | undefined;
    let werte: Record<string, string> | undefined;
    try {
      const rumpf = await antwort.json() as { error?: string; code?: string; werte?: Record<string, string> };
      message = rumpf.error ?? message;
      code = rumpf.code;
      werte = rumpf.werte;
    } catch { /* keine JSON-Antwort */ }
    if (code) {
      const uebersetzt = tStatisch(code as TranslationKey, werte);
      if (uebersetzt && uebersetzt !== code) message = uebersetzt;
    }
    throw new ApiError(message, antwort.status, code);
  }
  return antwort.status === 204 ? (undefined as T) : ((await antwort.json()) as T);
}

async function partnerHolen(filter: { gruppe?: string; nurVorschlaege?: boolean }): Promise<{ partner: MailPartner[]; offen: number }> {
  const qs = new URLSearchParams();
  if (filter.gruppe) qs.set('gruppe', filter.gruppe);
  if (filter.nurVorschlaege) qs.set('nurVorschlaege', '1');
  const anhang = qs.toString();
  return partnerFetch<{ partner: MailPartner[]; offen: number }>(`/api/post/partner${anhang ? `?${anhang}` : ''}`);
}

async function gruppeSpeichern(adresse: string, gruppe: string | null): Promise<{ partner: MailPartner }> {
  return partnerFetch<{ partner: MailPartner }>('/api/post/partner/gruppe', {
    method: 'POST', body: JSON.stringify({ adresse, gruppe }),
  });
}

/* ── Abruf der Gruppen SELBST (nicht der Briefpartner darin) — siehe
   Dateikopf, "EINGEBAUT VS. BENUTZERDEFINIERT". Drei einfache Wege für
   Anlegen/Umbenennen/Löschen, dieselbe Fehlerbehandlung wie oben. */
async function gruppenHolen(): Promise<{ gruppen: PartnerGruppeInfo[] }> {
  return partnerFetch<{ gruppen: PartnerGruppeInfo[] }>('/api/post/partnergruppen');
}

async function gruppeAnlegenApi(name: string): Promise<{ gruppe: PartnerGruppeInfo }> {
  return partnerFetch<{ gruppe: PartnerGruppeInfo }>('/api/post/partnergruppen', {
    method: 'POST', body: JSON.stringify({ name }),
  });
}

async function gruppeUmbenennenApi(id: string, name: string): Promise<{ gruppe: PartnerGruppeInfo }> {
  return partnerFetch<{ gruppe: PartnerGruppeInfo }>(`/api/post/partnergruppen/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ name }),
  });
}

async function gruppeLoeschenApi(id: string): Promise<{ betroffenePartner: number }> {
  return partnerFetch<{ betroffenePartner: number }>(`/api/post/partnergruppen/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** Fallback-Form, solange `gruppenHolen()` noch nicht beantwortet ist — damit
    die eingebauten Chips vom allerersten Bild an dastehen, statt bis zur
    ersten Serverantwort leer zu bleiben. Genau die eingebauten Gruppen, ohne
    Anzahl (die kennt nur der Server). */
const EINGEBAUTE_ALS_FALLBACK: PartnerGruppeInfo[] = PARTNER_GRUPPEN.map((id) => ({
  id, eingebaut: true, name: null, erstelltAm: 0, erstelltVon: null, anzahl: 0,
}));

function gruppenName(g: PartnerGruppeInfo, t: ReturnType<typeof useT>): string {
  return g.eingebaut ? t(`partnerGruppen.gruppe.${g.id}` as TranslationKey) : (g.name ?? '');
}

/** Welche Badge (falls überhaupt) neben der Gruppen-Auswahl steht, und was ihr
    Tooltip sagt. `gruppeBeleg` ist eine Kennung, kein Anzeigetext (siehe
    MailPartner in @stellium/shared) — hier wird sie einmalig auf drei Fälle
    abgebildet, statt irgendwo im Baum roh angezeigt zu werden:
      · 'dmarc'      → gilt bereits als menschliche Entscheidung
                        (`gruppeVonKi: false`), taucht also nie hier auf. Der
                        gesunde Normalfall bekommt bewusst KEINE Badge — eine
                        Markierung auf jeder Zeile würde alle unsichtbar
                        machen, siehe unten den Vorschlag-Fall.
      · 'ungeprueft' → die Domäne passt, aber der Absenderbeleg fehlt oder
                        fiel durch. Bestätigen heißt hier: für eine
                        unauthentifizierte Adresse bürgen — deshalb eine
                        Warnung (Pill in `partnergruppen__vorschlag--warnung`,
                        amber statt violett), keine neutrale Badge.
      · 'altbestand' → derselbe Vorschlag-Status, aber aus der Zeit vor
                        dieser Prüfung. Unbekannt ist nicht dasselbe wie
                        durchgefallen — die Badge sagt das auch so.
    Ist `gruppeBeleg` `null` und `gruppeVonKi` trotzdem `true`, handelt es
    sich um einen echten KI-Vorschlag aus den übrigen sechs Gruppen — dafür
    bleibt der ursprüngliche, neutrale Vorschlag-Hinweis. */
function belegBadge(
  partner: MailPartner,
  t: ReturnType<typeof useT>,
): { label: string; hinweis: string; warnung: boolean } | null {
  if (!partner.gruppeVonKi) return null;
  if (partner.gruppeBeleg === 'ungeprueft') {
    return {
      label: t('partnerGruppen.belegUngeprueftBadge'),
      hinweis: t('partnerGruppen.belegUngeprueftHinweis'),
      warnung: true,
    };
  }
  if (partner.gruppeBeleg === 'altbestand') {
    return {
      label: t('partnerGruppen.belegAltbestandBadge'),
      hinweis: t('partnerGruppen.belegAltbestandHinweis'),
      warnung: false,
    };
  }
  return { label: t('partnerGruppen.vorschlagBadge'), hinweis: t('partnerGruppen.vorschlagHinweis'), warnung: false };
}

/* ── Die Tafel ─────────────────────────────────────────────────── */

export function PartnerGruppenPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  // `darfAendern` (mail.senden) gilt je Briefpartner-Zeile und lebt deshalb
  // in Zeile() selbst, nicht hier — hier zählt nur die strengere Schwelle
  // fürs Verwalten der Gruppen SELBST (siehe Dateikopf).
  const darfGruppenVerwalten = useStore((s) => s.self?.permissions['mail.verwalten']);

  const [filter, setFilter] = useState<string>('alle');
  const [partner, setPartner] = useState<MailPartner[] | null>(null);
  const [offen, setOffen] = useState(0);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);

  const [gruppen, setGruppen] = useState<PartnerGruppeInfo[] | null>(null);
  const gruppenListe = gruppen ?? EINGEBAUTE_ALS_FALLBACK;

  const [neuOffen, setNeuOffen] = useState(false);
  const [neuerName, setNeuerName] = useState('');
  const [legtAn, setLegtAn] = useState(false);

  const [umbenennenOffen, setUmbenennenOffen] = useState(false);
  const [umbenennenName, setUmbenennenName] = useState('');

  const aktiveBenutzerGruppe = useMemo(
    () => gruppenListe.find((g) => g.id === filter && !g.eingebaut) ?? null,
    [gruppenListe, filter],
  );

  const gruppenNeuLaden = async () => {
    try {
      setGruppen((await gruppenHolen()).gruppen);
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('partnerGruppen.gruppenAktionFehlgeschlagen'), body: (err as Error).message });
    }
  };

  /* `laden` bedient zwei Aufrufer mit unterschiedlichem Bedarf: den
     Aktualisieren-Knopf weiter unten (eine bewusste Einzelanfrage) und den
     Effekt direkt darunter, der bei jedem Filterwechsel neu anfragt. Nur
     Letzterer braucht eine Veraltungs-Wache — klickt man schnell
     hintereinander "Kunden" und dann "Lieferanten", kann auf einer
     langsamen Verbindung die ältere Antwort NACH der neueren ankommen und
     zeigt dann die falsche Gruppe unter dem inzwischen aktiven Reiter.
     Dieselbe Bauart wie die Suche in PostPanel.tsx bzw. die
     Sprachabfrage in PostSchreiben.tsx (`let lebt = true`, beim Aufräumen
     auf `false`) — hier als Parameter statt als feste Variable, weil
     dieselbe Funktion auch ohne Wache vom Knopf aus aufgerufen wird. */
  /* Zusätzlich eine laufende Nummer: auch der Knopf braucht eine Wache,
     sobald danach der Filter wechselt — sonst überschreibt seine späte
     Antwort (alter Filter) die Liste des neuen Reiters. Es gilt nur die
     zuletzt gestellte Anfrage, gleich von wo. */
  const ladeNummer = useRef(0);
  const laden = async (pruefeAktuellVon: () => boolean = () => true) => {
    const nummer = ++ladeNummer.current;
    const pruefeAktuell = () => nummer === ladeNummer.current && pruefeAktuellVon();
    setLaedt(true); setFehler(null);
    try {
      const antwort = await partnerHolen({
        gruppe: filter !== 'alle' && filter !== 'ohne' && filter !== 'vorschlaege' ? filter : undefined,
        nurVorschlaege: filter === 'vorschlaege',
      });
      if (!pruefeAktuell()) return;
      // "Ohne Gruppe" filtert die Tafel selbst — der Server kennt nur "eine
      // bestimmte Gruppe" oder "alle", nicht deren Verneinung.
      setPartner(filter === 'ohne' ? antwort.partner.filter((p) => !p.gruppe) : antwort.partner);
      setOffen(antwort.offen);
    } catch (err) {
      if (pruefeAktuell()) setFehler((err as Error).message);
    } finally {
      if (pruefeAktuell()) setLaedt(false);
    }
  };

  useEffect(() => {
    let lebt = true;
    void laden(() => lebt);
    return () => { lebt = false; };
  }, [filter]);

  // Einmal beim Öffnen — die Liste der Gruppen ändert sich nicht mit dem
  // Filter, deshalb ein eigener Effekt statt Teil von `laden()`.
  useEffect(() => { void gruppenNeuLaden(); }, []);

  const gruppeAnlegen = async () => {
    const name = neuerName.trim();
    if (!name || legtAn) return;
    // Vor dem Absenden, in JEDER Sprache — siehe
    // kollidiertMitEingebautemAnzeigenamen() für die Begründung. Die
    // serverseitige Prüfung (nur gegen die Kennungen) bleibt daneben die
    // letzte Instanz, falls diese hier je aus dem Takt gerät.
    if (kollidiertMitEingebautemAnzeigenamen(name, t)) {
      useStore.getState().toast({ kind: 'error', title: t('partnerGruppen.gruppenAktionFehlgeschlagen'), body: t('fehler.gruppeNameEingebaut') });
      return;
    }
    setLegtAn(true);
    try {
      await gruppeAnlegenApi(name);
      setNeuOffen(false);
      setNeuerName('');
      await gruppenNeuLaden();
      useStore.getState().toast({ kind: 'ok', title: t('partnerGruppen.gruppeAngelegt') });
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('partnerGruppen.gruppenAktionFehlgeschlagen'), body: (err as Error).message });
    } finally {
      setLegtAn(false);
    }
  };

  const gruppeUmbenennenSpeichern = async () => {
    if (!aktiveBenutzerGruppe) return;
    const name = umbenennenName.trim();
    if (!name) return;
    if (kollidiertMitEingebautemAnzeigenamen(name, t)) {
      useStore.getState().toast({ kind: 'error', title: t('partnerGruppen.gruppenAktionFehlgeschlagen'), body: t('fehler.gruppeNameEingebaut') });
      return;
    }
    try {
      await gruppeUmbenennenApi(aktiveBenutzerGruppe.id, name);
      setUmbenennenOffen(false);
      await gruppenNeuLaden();
      useStore.getState().toast({ kind: 'ok', title: t('partnerGruppen.gruppeUmbenannt') });
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('partnerGruppen.gruppenAktionFehlgeschlagen'), body: (err as Error).message });
    }
  };

  const gruppeLoeschenKlick = async (g: PartnerGruppeInfo) => {
    if (!window.confirm(t('partnerGruppen.gruppeLoeschenBestaetigen', { name: g.name ?? '' }))) return;
    try {
      const antwort = await gruppeLoeschenApi(g.id);
      if (filter === g.id) setFilter('alle'); else void laden();
      await gruppenNeuLaden();
      useStore.getState().toast({
        kind: 'ok',
        title: t('partnerGruppen.gruppeGeloescht'),
        body: antwort.betroffenePartner
          ? t('partnerGruppen.gruppeGeloeschtBetroffen', { n: antwort.betroffenePartner })
          : undefined,
      });
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('partnerGruppen.gruppenAktionFehlgeschlagen'), body: (err as Error).message });
    }
  };

  return (
    <Shell
      title={t('partnerGruppen.titel')}
      subtitle={t('partnerGruppen.untertitel', { n: offen })}
      icon={<Users size={18} />}
      onClose={onClose}
      width={860}
      actions={
        <button className="icon-btn" title={t('partnerGruppen.aktualisieren')} aria-label={t('partnerGruppen.aktualisieren')} onClick={() => { void laden(); void gruppenNeuLaden(); }}>
          <RefreshCw size={15} />
        </button>
      }
    >
      <div className="partnergruppen">
        <div className="partnergruppen__filter">
          {(['alle', 'vorschlaege', 'ohne'] as const).map((f) => (
            <button
              key={f}
              className={clsx('btn btn--sm', filter === f && 'btn--primary')}
              onClick={() => setFilter(f)}
            >
              {f === 'alle' ? t('partnerGruppen.filterAlle')
                : f === 'ohne' ? t('partnerGruppen.filterOhne')
                  : t('partnerGruppen.filterVorschlaege')}
            </button>
          ))}
          {gruppenListe.map((g) => (
            <button
              key={g.id}
              className={clsx('btn btn--sm', filter === g.id && 'btn--primary')}
              onClick={() => setFilter(g.id)}
            >
              {gruppenName(g, t)}
            </button>
          ))}
          {darfGruppenVerwalten && (
            neuOffen ? (
              <span className="partnergruppen__gruppe-feld">
                <input
                  className="input"
                  style={{ width: 160 }}
                  autoFocus
                  value={neuerName}
                  maxLength={30}
                  placeholder={t('partnerGruppen.neueGruppePlatzhalter')}
                  onChange={(e) => setNeuerName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void gruppeAnlegen();
                    if (e.key === 'Escape') { setNeuOffen(false); setNeuerName(''); }
                  }}
                />
                <button
                  className="icon-btn" title={t('partnerGruppen.gruppeAnlegen')} aria-label={t('partnerGruppen.gruppeAnlegen')}
                  disabled={!neuerName.trim() || legtAn} onClick={() => void gruppeAnlegen()}
                >
                  {legtAn ? <Loader2 size={13} className="spin" /> : <Check size={14} />}
                </button>
                <button
                  className="icon-btn" title={t('partnerGruppen.abbrechen')} aria-label={t('partnerGruppen.abbrechen')}
                  onClick={() => { setNeuOffen(false); setNeuerName(''); }}
                >
                  <X size={14} />
                </button>
              </span>
            ) : (
              <button className="btn btn--sm" title={t('partnerGruppen.neueGruppe')} aria-label={t('partnerGruppen.neueGruppe')} onClick={() => setNeuOffen(true)}>
                <Plus size={13} />
              </button>
            )
          )}
        </div>

        {/* Umbenennen/Löschen: nur für die GERADE aktive, benutzerdefinierte
            Gruppe — eingebaute Chips bekommen diese Zeile nie (siehe
            Dateikopf, Server weist beides ohnehin ab). Absichtlich NICHT an
            jedem Chip gleichzeitig: drei anklickbare Ziele auf einer
            einzigen kleinen Fläche (auswählen, umbenennen, löschen) wären
            eine schlechtere Bedienung als diese eine, kontextabhängige
            Zeile. */}
        {darfGruppenVerwalten && aktiveBenutzerGruppe && (
          <div className="partnergruppen__filter">
            {umbenennenOffen ? (
              <span className="partnergruppen__gruppe-feld">
                <input
                  className="input"
                  style={{ width: 160 }}
                  autoFocus
                  value={umbenennenName}
                  maxLength={30}
                  onChange={(e) => setUmbenennenName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void gruppeUmbenennenSpeichern();
                    if (e.key === 'Escape') setUmbenennenOffen(false);
                  }}
                />
                <button className="icon-btn" title={t('partnerGruppen.speichern')} aria-label={t('partnerGruppen.speichern')} onClick={() => void gruppeUmbenennenSpeichern()}>
                  <Check size={14} />
                </button>
                <button className="icon-btn" title={t('partnerGruppen.abbrechen')} aria-label={t('partnerGruppen.abbrechen')} onClick={() => setUmbenennenOffen(false)}>
                  <X size={14} />
                </button>
              </span>
            ) : (
              <>
                <button
                  className="icon-btn" title={t('partnerGruppen.gruppeUmbenennen')} aria-label={t('partnerGruppen.gruppeUmbenennen')}
                  onClick={() => { setUmbenennenName(aktiveBenutzerGruppe.name ?? ''); setUmbenennenOffen(true); }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-btn" title={t('partnerGruppen.gruppeLoeschen')} aria-label={t('partnerGruppen.gruppeLoeschen')}
                  onClick={() => void gruppeLoeschenKlick(aktiveBenutzerGruppe)}
                >
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </div>
        )}

        {fehler && <div className="post__fehler"><AlertTriangle size={13} /> {fehler}</div>}

        {laedt && !partner && (
          <div className="empty-state">
            <Loader2 size={26} className="spin muted" role="status" aria-label={t('partnerGruppen.laedt')} />
          </div>
        )}

        {!laedt && partner && !partner.length && (
          <div className="empty-state">
            <Users size={26} className="muted" />
            <p>{filter === 'alle' ? t('partnerGruppen.leer') : t('partnerGruppen.leerGefiltert')}</p>
          </div>
        )}

        {!!partner?.length && (
          <div className="partnergruppen__liste">
            <div className="partnergruppen__kopf">
              <span>{t('partnerGruppen.spalteAdresse')}</span>
              <span>{t('partnerGruppen.spalteGruppe')}</span>
              <span>{t('partnerGruppen.spalteSeit')}</span>
            </div>
            {partner.map((p) => (
              <Zeile key={p.adresse} partner={p} gruppen={gruppenListe} onGeaendert={(neu) => {
                setPartner((liste) => liste?.map((x) => (x.adresse === neu.adresse ? neu : x)) ?? liste);
                setOffen((n) => n + (neu.gruppeVonKi ? 0 : (p.gruppeVonKi ? -1 : 0)));
              }}
              />
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}

function Zeile({ partner, gruppen, onGeaendert }: {
  partner: MailPartner; gruppen: PartnerGruppeInfo[]; onGeaendert: (neu: MailPartner) => void;
}) {
  const t = useT();
  const darfAendern = useStore((s) => s.self?.permissions['mail.senden']);
  const [speichertGerade, setSpeichertGerade] = useState(false);

  const speichern = async (wert: string) => {
    if (!darfAendern) return;
    setSpeichertGerade(true);
    try {
      const antwort = await gruppeSpeichern(partner.adresse, wert || null);
      onGeaendert(antwort.partner);
      useStore.getState().toast({ kind: 'ok', title: t('partnerGruppen.gespeichert') });
    } catch (err) {
      useStore.getState().toast({
        kind: 'error', title: t('partnerGruppen.speichernFehlgeschlagen'), body: (err as Error).message,
      });
    } finally {
      setSpeichertGerade(false);
    }
  };

  return (
    <div className="partnergruppen__zeile">
      <span className="partnergruppen__adresse truncate">{partner.adresse}</span>
      <span className="partnergruppen__gruppe-feld">
        <select
          className="select partnergruppen__select"
          value={partner.gruppe ?? ''}
          disabled={!darfAendern || speichertGerade}
          onChange={(e) => void speichern(e.target.value)}
          title={partner.begruendung ? t('partnerGruppen.begruendung', { text: partner.begruendung }) : undefined}
        >
          <option value="">{t('partnerGruppen.keineGruppe')}</option>
          {gruppen.map((g) => (
            <option key={g.id} value={g.id}>{gruppenName(g, t)}</option>
          ))}
        </select>
        {/* Ein Vorschlag ist eine Vermutung, keine Tatsache — genau deshalb
            eigens markiert, statt einfach nur als Gruppe angezeigt zu
            werden. Auswählen desselben oder eines anderen Werts bestätigt
            oder ändert ihn (siehe gruppeSetzen() auf dem Server). Eine
            automatische "intern"-Zuordnung mit belegter Absenderprüfung
            (`gruppeBeleg: 'dmarc'`) zählt als menschliche Entscheidung und
            taucht hier NIE auf; ohne Beleg oder mit einem Altbestand-Eintrag
            bleibt sie ein Vorschlag — mit eigener Badge, siehe belegBadge()
            oben (Warnung für 'ungeprueft', neutraler Hinweis für
            'altbestand'). */}
        {(() => {
          const badge = belegBadge(partner, t);
          if (!badge) return null;
          return (
            <span
              className={clsx('pill partnergruppen__vorschlag', badge.warnung && 'partnergruppen__vorschlag--warnung')}
              title={badge.hinweis}
            >
              {badge.warnung && <AlertTriangle size={11} />}
              {badge.label}
            </span>
          );
        })()}
        {speichertGerade && <Loader2 size={13} className="spin muted" />}
      </span>
      <span className="muted">{relativeTime(partner.seit)}</span>
    </div>
  );
}

/* ── Optionaler Bonus-Einstiegspunkt: eine Adresse inline anzeigen ───
 * Siehe Dateikopf. Holt sich ihren Stand selbst — kein globaler Zustand
 * nötig für eine einzelne Adresse. Holt zusätzlich die Gruppenliste, um
 * eine benutzerdefinierte Gruppe mit ihrem echten Namen statt ihrer
 * Kennung zu zeigen. */
export function PartnerGruppenBadge({ adresse }: { adresse: string }) {
  const t = useT();
  const [partner, setPartner] = useState<MailPartner | null>(null);
  const [gruppen, setGruppen] = useState<PartnerGruppeInfo[] | null>(null);

  useEffect(() => {
    let lebt = true;
    void partnerHolen({}).then((r) => {
      if (lebt) setPartner(r.partner.find((p) => p.adresse === adresse) ?? null);
    }).catch(() => { /* stille Randanzeige — kein eigener Fehlerzustand nötig */ });
    void gruppenHolen().then((r) => { if (lebt) setGruppen(r.gruppen); }).catch(() => { /* dito */ });
    return () => { lebt = false; };
  }, [adresse]);

  if (!partner?.gruppe) return null;
  const g = gruppen?.find((x) => x.id === partner.gruppe);
  // Dieselbe Unterscheidung wie in Zeile() oben (siehe belegBadge) — nur als
  // reiner Text statt Pill, weil dieser Bonus-Einstiegspunkt keinen Platz für
  // eine zweite Farbe hat. Wichtig ist, dass 'ungeprueft' hier nicht als
  // dieselbe harmlose "Vorschlag"-Beschriftung wie ein echter KI-Vorschlag
  // erscheint.
  const badge = belegBadge(partner, t);
  return (
    <span className="pill partnergruppen__badge-inline">
      {g ? gruppenName(g, t) : partner.gruppe}
      {badge && <em title={badge.hinweis}>{badge.label}</em>}
    </span>
  );
}
