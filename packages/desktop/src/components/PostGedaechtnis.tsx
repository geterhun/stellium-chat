/**
 * Der Reiter „Gedächtnis" — was die KI über das Unternehmen weiß, und was sie
 * sich merken möchte.
 *
 * ZWEI LISTEN, UND DER UNTERSCHIED IST DIE GANZE SPERRE
 *
 *   · **Vorschläge** — was die KI aus gesendeter Post abgeleitet hat. Steht
 *     hier und wirkt nirgends: kein Vorschlag geht in eine Anweisung ans
 *     Modell, solange niemand zugestimmt hat. Deshalb ist diese Liste der
 *     erste Reiter und nicht der zweite.
 *   · **Gedächtnis** — was gilt. Genau das, was die KI bei einer passenden
 *     Mail mitliest.
 *
 * DREI KNÖPFE, NICHT ZWEI
 *
 * Ja, Nein, Ändern. „Ändern" ist der wichtigste: oft ist die Beobachtung
 * richtig und nur die Formulierung schief, und wer dann nur Ja und Nein hat,
 * wirft eine richtige Beobachtung weg. Gespeichert wird der Wortlaut des
 * Menschen, nicht der der KI — der bleibt daneben stehen, damit sich später
 * ablesen lässt, wie oft die KI danebenlag.
 *
 * HERKUNFT STEHT DABEI
 *
 * Zu jedem Vorschlag: aus welcher gesendeten Mail er stammt, ob ein Mensch
 * den Entwurf dafür bearbeitet hat, und beide Wortlaute zum Aufklappen. Ohne
 * Herkunft kann niemand beurteilen, ob eine Aussage stimmt — dann wäre die
 * Karte eine Behauptung und die Entscheidung ein Ratespiel.
 *
 * WIDERSPRUCH WIRD GEZEIGT, NICHT AUFGELÖST
 *
 * Trägt ein Vorschlag `widerspruchZu`, stehen beide Fassungen nebeneinander
 * und aus „Annehmen" werden zwei Knöpfe: „Ersetzen" (der alte Eintrag wird
 * abgelöst, bleibt aber lesbar) und „Zusätzlich" (beide gelten nebeneinander).
 * Stillschweigend überschrieben wird nie.
 *
 * MACHART
 *
 * Aufbau, Karten und Filterleiste sind bewusst dieselben wie im Reiter
 * „Post-Sichtung" (PostMeldungen.tsx) — Shell, `postsicht-leiste`, die
 * Farbtoken aus tokens.css. Ein zweiter Reiter zur selben Sache soll nicht
 * aussehen wie aus einem anderen Programm. Eigen ist nur, was diese Karten
 * zusätzlich brauchen (siehe styles/post-gedaechtnis.css).
 *
 * RECHTE
 *
 * Ansehen mit `mail.lesen`, ändern und entscheiden mit `mail.verwalten` —
 * dieselben zwei Schwellen wie auf dem Server (http/postgedaechtnis.ts). Die
 * Oberfläche blendet die Knöpfe nur zusätzlich aus; durchgesetzt wird es
 * dort.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Brain, Check, ChevronDown, ChevronUp, Loader2, Pencil,
  Plus, RefreshCw, Trash2, X,
} from 'lucide-react';
import type { WissenEintrag, WissenVorschlag } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { t as tStatisch, useT, type TranslationKey } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { ApiError, serverUrl, token } from '../net/api.js';
import { clsx, relativeTime } from '../lib/format.js';
import '../styles/post-gedaechtnis.css';

/* ── Abruf — eigener, kleiner Ersatz für request() aus net/api.ts ────
   Wortgleich mit dem in PostMeldungen.tsx und PartnerGruppenPanel.tsx, aus
   demselben Grund: net/api.ts wird an anderer Stelle bearbeitet. Spiegelt
   nur, was gebraucht wird — Basisadresse, Anmeldenachweis und das Lesen von
   `code`/`error`, damit die Fehlerkennungen des Servers (etwa
   'post.wissenVoll') übersetzt ankommen statt als Serversatz. */
async function wissenFetch<T>(pfad: string, init: RequestInit = {}): Promise<T> {
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
    try {
      const rumpf = await antwort.json() as { error?: string; code?: string };
      message = rumpf.error ?? message;
      code = rumpf.code;
    } catch { /* keine JSON-Antwort */ }
    if (code) {
      const uebersetzt = tStatisch(code as TranslationKey);
      if (uebersetzt && uebersetzt !== code) message = uebersetzt;
    }
    throw new ApiError(message, antwort.status, code);
  }
  return antwort.status === 204 ? (undefined as T) : ((await antwort.json()) as T);
}

type Reiter = 'vorschlaege' | 'gedaechtnis';

/* ── Die Tafel ─────────────────────────────────────────────────── */

export function PostGedaechtnis({ onClose }: { onClose: () => void }) {
  const t = useT();
  const darfPflegen = useStore((s) => s.self?.permissions['mail.verwalten'] === true);

  const [reiter, setReiter] = useState<Reiter>('vorschlaege');
  const [vorschlaege, setVorschlaege] = useState<WissenVorschlag[] | null>(null);
  const [eintraege, setEintraege] = useState<WissenEintrag[] | null>(null);
  const [mitVerlauf, setMitVerlauf] = useState(false);
  const [grenze, setGrenze] = useState({ anzahl: 0, max: 0, offen: 0, offenMax: 0 });
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neuOffen, setNeuOffen] = useState(false);

  /* Nur die zuletzt gestellte Anfrage zählt: wer „mit Verlauf" schnell an-
     und wieder ausschaltet, bekäme sonst womöglich die spätere Antwort der
     ersten Anfrage — und sähe abgelöste Einträge bei ausgeschaltetem Haken. */
  const ladeNummer = useRef(0);
  const laden = async (verlauf = mitVerlauf) => {
    const nummer = ++ladeNummer.current;
    setLaedt(true); setFehler(null);
    try {
      const [w, v] = await Promise.all([
        wissenFetch<{ eintraege: WissenEintrag[]; anzahl: number; max: number; offeneVorschlaege: number }>(
          `/api/post/wissen${verlauf ? '?alle=1' : ''}`),
        wissenFetch<{ vorschlaege: WissenVorschlag[]; offen: number; max: number }>(
          '/api/post/wissen/vorschlaege'),
      ]);
      if (nummer !== ladeNummer.current) return;
      setEintraege(w.eintraege);
      setVorschlaege(v.vorschlaege);
      setGrenze({ anzahl: w.anzahl, max: w.max, offen: v.offen, offenMax: v.max });
    } catch (err) {
      if (nummer === ladeNummer.current) setFehler((err as Error).message);
    } finally {
      if (nummer === ladeNummer.current) setLaedt(false);
    }
  };

  useEffect(() => { void laden(); }, []);

  const offene = (vorschlaege ?? []).filter((v) => v.zustand === 'offen');
  const entschieden = (vorschlaege ?? []).filter((v) => v.zustand !== 'offen');

  return (
    <Shell
      title={t('gedaechtnis.titel')}
      icon={<Brain size={18} />}
      onClose={onClose}
      width={760}
      subtitle={t('gedaechtnis.untertitel', { n: grenze.anzahl, max: grenze.max })}
      actions={
        <button className="icon-btn" title={t('post.aktualisieren')} aria-label={t('post.aktualisieren')} onClick={() => void laden()}>
          <RefreshCw size={15} />
        </button>
      }
    >
      <p className="gedaechtnis__hinweis">{t('gedaechtnis.hinweis')}</p>

      <div className="postsicht-leiste">
        <button
          className={clsx('postsicht-tab', reiter === 'vorschlaege' && 'postsicht-tab--on')}
          onClick={() => setReiter('vorschlaege')}
        >
          {t('gedaechtnis.reiterVorschlaege')}
          <span className="postsicht-tab__n">{offene.length}</span>
        </button>
        <button
          className={clsx('postsicht-tab', reiter === 'gedaechtnis' && 'postsicht-tab--on')}
          onClick={() => setReiter('gedaechtnis')}
        >
          {t('gedaechtnis.reiterGedaechtnis')}
          <span className="postsicht-tab__n">{grenze.anzahl}</span>
        </button>
      </div>

      {fehler && <div className="post__fehler"><AlertTriangle size={13} /> {fehler}</div>}

      {laedt && !eintraege && (
        <Loader2 size={22} className="spin muted" role="status" aria-label={t('post.laedt')} />
      )}

      {reiter === 'vorschlaege' && !!vorschlaege && (
        <>
          <p className="gedaechtnis__zaehler">
            {t('gedaechtnis.offenVon', { n: grenze.offen, max: grenze.offenMax })}
          </p>
          {!offene.length && (
            <div className="empty-state">
              <Brain size={28} className="muted" />
              <p>{t('gedaechtnis.keineVorschlaege')}</p>
            </div>
          )}
          <div className="postsicht-liste">
            {offene.map((v) => (
              <VorschlagKarte
                key={v.id} v={v} t={t} darfPflegen={darfPflegen}
                onFertig={() => void laden()}
                onFehler={setFehler}
              />
            ))}
          </div>
          {!!entschieden.length && (
            <details className="gedaechtnis__verlauf">
              <summary>{t('gedaechtnis.entschiedene', { n: entschieden.length })}</summary>
              <div className="postsicht-liste">
                {entschieden.map((v) => (
                  <div key={v.id} className="gedaechtnis-karte gedaechtnis-karte--still">
                    <div className="gedaechtnis-karte__kopf">
                      <span className={clsx('pill', v.zustand === 'angenommen'
                        ? 'gedaechtnis-pill--ja' : 'gedaechtnis-pill--nein')}
                      >
                        {t(`gedaechtnis.zustand.${v.zustand}` as TranslationKey)}
                      </span>
                      <span className="postsicht-karte__zeit">{relativeTime(v.entschiedenAm ?? v.erstelltAm)}</span>
                    </div>
                    <div className="gedaechtnis-karte__thema">{v.thema}</div>
                    <p className="gedaechtnis-karte__inhalt">{v.inhalt}</p>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {reiter === 'gedaechtnis' && !!eintraege && (
        <>
          <div className="gedaechtnis__werkzeug">
            <label className="gedaechtnis__schalter">
              <input
                type="checkbox"
                checked={mitVerlauf}
                onChange={(e) => { setMitVerlauf(e.target.checked); void laden(e.target.checked); }}
              />
              {t('gedaechtnis.mitVerlauf')}
            </label>
            {darfPflegen && (
              <button className="btn btn--ghost" onClick={() => setNeuOffen((o) => !o)}>
                <Plus size={14} /> {t('gedaechtnis.neu')}
              </button>
            )}
          </div>

          {neuOffen && darfPflegen && (
            <EintragFormular
              t={t}
              onAbbrechen={() => setNeuOffen(false)}
              onSpeichern={async (werte) => {
                await wissenFetch('/api/post/wissen', { method: 'POST', body: JSON.stringify(werte) });
                setNeuOffen(false);
                await laden();
              }}
              onFehler={setFehler}
            />
          )}

          {!eintraege.length && (
            <div className="empty-state">
              <Brain size={28} className="muted" />
              <p>{t('gedaechtnis.leer')}</p>
            </div>
          )}

          <div className="postsicht-liste">
            {eintraege.map((e) => (
              <EintragKarte
                key={e.id} e={e} t={t} darfPflegen={darfPflegen}
                onFertig={() => void laden()} onFehler={setFehler}
              />
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}

/* ── Ein Vorschlag ─────────────────────────────────────────────── */

/**
 * Auf Modulebene wie `Meldung` in PostMeldungen.tsx und aus demselben Grund:
 * eine hier verschachtelte Komponente bekäme bei jedem Rendern der Tafel
 * einen neuen Bauplan, und React baute sie bei jeder Änderung komplett neu
 * auf statt sie zu aktualisieren. `t` kommt deshalb als Wert herein.
 */
function VorschlagKarte({ v, t, darfPflegen, onFertig, onFehler }: {
  v: WissenVorschlag;
  darfPflegen: boolean;
  onFertig: () => void;
  onFehler: (text: string) => void;
  t: (key: TranslationKey, werte?: Record<string, string | number>) => string;
}) {
  const [aendern, setAendern] = useState(false);
  const [thema, setThema] = useState(v.thema);
  const [inhalt, setInhalt] = useState(v.inhalt);
  const [herkunftOffen, setHerkunftOffen] = useState(false);
  const [laeuft, setLaeuft] = useState(false);

  const entscheiden = async (ergebnis: 'angenommen' | 'abgelehnt', ersetzen = false) => {
    setLaeuft(true);
    try {
      await wissenFetch(`/api/post/wissen/vorschlaege/${v.id}/entscheiden`, {
        method: 'POST',
        body: JSON.stringify({ ergebnis, thema, inhalt, ersetzen }),
      });
      useStore.getState().toast({
        kind: 'ok',
        title: t(ergebnis === 'angenommen' ? 'gedaechtnis.gemerkt' : 'gedaechtnis.verworfen'),
      });
      onFertig();
    } catch (err) {
      onFehler((err as Error).message);
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <div className={clsx('gedaechtnis-karte', v.widerspruchZu && 'gedaechtnis-karte--widerspruch')}>
      <div className="gedaechtnis-karte__kopf">
        <span className="pill gedaechtnis-pill--art">
          {t(`gedaechtnis.art.${v.art}` as TranslationKey)}
        </span>
        <span className="postsicht-karte__zeit">{relativeTime(v.erstelltAm)}</span>
      </div>

      {aendern ? (
        <>
          <input
            className="input gedaechtnis-karte__feld"
            value={thema}
            maxLength={80}
            aria-label={t('gedaechtnis.feldThema')}
            onChange={(e) => setThema(e.target.value)}
          />
          <textarea
            className="input gedaechtnis-karte__feld"
            value={inhalt}
            rows={3}
            maxLength={500}
            aria-label={t('gedaechtnis.feldInhalt')}
            onChange={(e) => setInhalt(e.target.value)}
          />
        </>
      ) : (
        <>
          <div className="gedaechtnis-karte__thema">{thema}</div>
          <p className="gedaechtnis-karte__inhalt">{inhalt}</p>
        </>
      )}

      {v.begruendung && (
        <p className="gedaechtnis-karte__grund">{t('gedaechtnis.warum', { text: v.begruendung })}</p>
      )}

      {/* Widerspruch: beide Fassungen nebeneinander, nie das Alte still
          überschreiben. Genau dieser Fall ist der wertvollste — er zeigt,
          dass sich etwas geändert hat. */}
      {v.widerspruchZu && (
        <div className="gedaechtnis-karte__widerspruch">
          <p className="gedaechtnis-karte__widerspruch-kopf">
            <AlertTriangle size={12} /> {t('gedaechtnis.widerspruch')}
          </p>
          <div className="gedaechtnis-karte__bisher">
            <span className="gedaechtnis-karte__marke">{t('gedaechtnis.bisher')}</span>
            <strong>{v.widerspruchZu.thema}</strong>
            <p>{v.widerspruchZu.inhalt}</p>
          </div>
        </div>
      )}

      {/* Herkunft: ohne sie ist die Karte eine Behauptung. Zugeklappt, damit
          die Liste kurz bleibt — aber immer da. */}
      {v.herkunft && (
        <div className="gedaechtnis-karte__herkunft">
          <button className="gedaechtnis-karte__herkunft-knopf" onClick={() => setHerkunftOffen((o) => !o)}>
            {herkunftOffen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {t(v.herkunft.art === 'bearbeitet' ? 'gedaechtnis.herkunftBearbeitet' : 'gedaechtnis.herkunftGesendet', {
              betreff: v.herkunft.betreff || t('post.ohneBetreff'),
              an: v.herkunft.an,
            })}
          </button>
          {herkunftOffen && (
            <div className="gedaechtnis-karte__quelltexte">
              {v.herkunft.textKi && (
                <div>
                  <span className="gedaechtnis-karte__marke">{t('gedaechtnis.textKi')}</span>
                  <pre>{v.herkunft.textKi}</pre>
                </div>
              )}
              <div>
                <span className="gedaechtnis-karte__marke">{t('gedaechtnis.textGesendet')}</span>
                <pre>{v.herkunft.textGesendet}</pre>
              </div>
            </div>
          )}
        </div>
      )}

      {darfPflegen && (
        <div className="gedaechtnis-karte__knoepfe">
          {v.widerspruchZu ? (
            <>
              <button className="btn btn--primary" disabled={laeuft} onClick={() => void entscheiden('angenommen', true)}>
                <Check size={14} /> {t('gedaechtnis.ersetzen')}
              </button>
              <button className="btn" disabled={laeuft} onClick={() => void entscheiden('angenommen', false)}>
                {t('gedaechtnis.zusaetzlich')}
              </button>
            </>
          ) : (
            <button className="btn btn--primary" disabled={laeuft} onClick={() => void entscheiden('angenommen')}>
              <Check size={14} /> {t('gedaechtnis.merken')}
            </button>
          )}
          <button className="btn" disabled={laeuft} onClick={() => setAendern((a) => !a)}>
            <Pencil size={14} /> {t('gedaechtnis.aendern')}
          </button>
          <button className="btn btn--ghost" disabled={laeuft} onClick={() => void entscheiden('abgelehnt')}>
            <X size={14} /> {t('gedaechtnis.ablehnen')}
          </button>
          {laeuft && <Loader2 size={14} className="spin muted" />}
        </div>
      )}
      {!darfPflegen && <p className="gedaechtnis-karte__grund muted">{t('gedaechtnis.nurAnsehen')}</p>}
    </div>
  );
}

/* ── Ein geltender Eintrag ─────────────────────────────────────── */

function EintragKarte({ e, t, darfPflegen, onFertig, onFehler }: {
  e: WissenEintrag;
  darfPflegen: boolean;
  onFertig: () => void;
  onFehler: (text: string) => void;
  t: (key: TranslationKey, werte?: Record<string, string | number>) => string;
}) {
  const [bearbeiten, setBearbeiten] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const abgeloest = e.ersetztAm !== null;

  const loeschen = async () => {
    setLaeuft(true);
    try {
      await wissenFetch(`/api/post/wissen/${e.id}`, { method: 'DELETE' });
      useStore.getState().toast({ kind: 'ok', title: t('gedaechtnis.geloescht') });
      onFertig();
    } catch (err) {
      onFehler((err as Error).message);
    } finally {
      setLaeuft(false);
    }
  };

  if (bearbeiten && darfPflegen && !abgeloest) {
    return (
      <EintragFormular
        t={t}
        start={e}
        onAbbrechen={() => setBearbeiten(false)}
        onSpeichern={async (werte) => {
          await wissenFetch(`/api/post/wissen/${e.id}`, { method: 'PATCH', body: JSON.stringify(werte) });
          setBearbeiten(false);
          onFertig();
        }}
        onFehler={onFehler}
      />
    );
  }

  return (
    <div className={clsx('gedaechtnis-karte', abgeloest && 'gedaechtnis-karte--still')}>
      <div className="gedaechtnis-karte__kopf">
        <span className="pill gedaechtnis-pill--art">{t(`gedaechtnis.art.${e.art}` as TranslationKey)}</span>
        {e.immer && <span className="pill gedaechtnis-pill--immer">{t('gedaechtnis.immer')}</span>}
        {e.fach && <span className="postsicht-karte__fach">{e.fach}</span>}
        {abgeloest && <span className="pill gedaechtnis-pill--nein">{t('gedaechtnis.abgeloest')}</span>}
        <span className="postsicht-karte__zeit">{relativeTime(e.angelegtAm)}</span>
      </div>
      <div className="gedaechtnis-karte__thema">{e.thema}</div>
      <p className="gedaechtnis-karte__inhalt">{e.inhalt}</p>
      {e.stichworte && (
        <p className="gedaechtnis-karte__grund">{t('gedaechtnis.stichworte', { text: e.stichworte })}</p>
      )}
      {e.quelle && <p className="gedaechtnis-karte__grund muted">{e.quelle}</p>}

      {darfPflegen && !abgeloest && (
        <div className="gedaechtnis-karte__knoepfe">
          <button className="btn" disabled={laeuft} onClick={() => setBearbeiten(true)}>
            <Pencil size={14} /> {t('gedaechtnis.bearbeiten')}
          </button>
          <button className="btn btn--ghost" disabled={laeuft} onClick={() => void loeschen()}>
            <Trash2 size={14} /> {t('gedaechtnis.loeschen')}
          </button>
          {laeuft && <Loader2 size={14} className="spin muted" />}
        </div>
      )}
    </div>
  );
}

/* ── Formular für einen Eintrag ────────────────────────────────── */

interface FormularWerte {
  art: 'wissen' | 'stil';
  thema: string;
  inhalt: string;
  stichworte: string;
  immer: boolean;
  fach: string | null;
}

function EintragFormular({ t, start, onSpeichern, onAbbrechen, onFehler }: {
  start?: WissenEintrag;
  onSpeichern: (werte: FormularWerte) => Promise<void>;
  onAbbrechen: () => void;
  onFehler: (text: string) => void;
  t: (key: TranslationKey, werte?: Record<string, string | number>) => string;
}) {
  const [werte, setWerte] = useState<FormularWerte>({
    art: start?.art ?? 'wissen',
    thema: start?.thema ?? '',
    inhalt: start?.inhalt ?? '',
    stichworte: start?.stichworte ?? '',
    immer: start?.immer ?? false,
    fach: start?.fach ?? null,
  });
  const [laeuft, setLaeuft] = useState(false);

  const speichern = async () => {
    setLaeuft(true);
    try {
      await onSpeichern(werte);
    } catch (err) {
      onFehler((err as Error).message);
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <div className="gedaechtnis-karte gedaechtnis-karte--formular">
      <label className="gedaechtnis__feld">
        <span>{t('gedaechtnis.feldArt')}</span>
        <select
          className="select"
          value={werte.art}
          onChange={(e) => setWerte((w) => ({ ...w, art: e.target.value as 'wissen' | 'stil' }))}
        >
          <option value="wissen">{t('gedaechtnis.art.wissen')}</option>
          <option value="stil">{t('gedaechtnis.art.stil')}</option>
        </select>
      </label>
      <label className="gedaechtnis__feld">
        <span>{t('gedaechtnis.feldThema')}</span>
        <input
          className="input" value={werte.thema} maxLength={80}
          placeholder={t('gedaechtnis.themaBeispiel')}
          onChange={(e) => setWerte((w) => ({ ...w, thema: e.target.value }))}
        />
      </label>
      <label className="gedaechtnis__feld">
        <span>{t('gedaechtnis.feldInhalt')}</span>
        <textarea
          className="input" value={werte.inhalt} rows={4} maxLength={500}
          placeholder={t('gedaechtnis.inhaltBeispiel')}
          onChange={(e) => setWerte((w) => ({ ...w, inhalt: e.target.value }))}
        />
        <span className="gedaechtnis__zaehler">{werte.inhalt.length} / 500</span>
      </label>
      <label className="gedaechtnis__feld">
        <span>{t('gedaechtnis.feldStichworte')}</span>
        <input
          className="input" value={werte.stichworte} maxLength={200}
          placeholder={t('gedaechtnis.stichworteBeispiel')}
          onChange={(e) => setWerte((w) => ({ ...w, stichworte: e.target.value }))}
        />
      </label>
      <label className="gedaechtnis__feld">
        <span>{t('gedaechtnis.feldFach')}</span>
        <input
          className="input" value={werte.fach ?? ''} maxLength={40}
          placeholder={t('gedaechtnis.fachBeispiel')}
          onChange={(e) => setWerte((w) => ({ ...w, fach: e.target.value.trim() || null }))}
        />
      </label>
      <label className="gedaechtnis__schalter">
        <input
          type="checkbox" checked={werte.immer}
          onChange={(e) => setWerte((w) => ({ ...w, immer: e.target.checked }))}
        />
        {t('gedaechtnis.feldImmer')}
      </label>
      <div className="gedaechtnis-karte__knoepfe">
        <button className="btn btn--primary" disabled={laeuft} onClick={() => void speichern()}>
          {laeuft ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {t('gedaechtnis.speichern')}
        </button>
        <button className="btn btn--ghost" disabled={laeuft} onClick={onAbbrechen}>
          {t('gedaechtnis.abbrechen')}
        </button>
      </div>
    </div>
  );
}
