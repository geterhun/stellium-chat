/**
 * Das Schreibfenster — eine neue Mail an eine beliebige Adresse.
 *
 * Eigenständige Komponente, absichtlich: PostPanel.tsx teilt sich ein
 * anderer Auftrag gerade für die Dringlichkeits-Sortierung und die
 * Benachrichtigungen. Diese Datei hängt sich dort mit einer einzigen Zeile
 * ein (`<PostSchreiben onGesendet={...} />` in den `actions` der Kopfzeile)
 * und verwaltet ihren eigenen Zustand vollständig selbst — Knopf und Fenster
 * in einem, kein zweiter Ort, an dem eine offen/zu-Variable gepflegt werden
 * müsste.
 *
 * Nutzt denselben Versandweg wie die Antwort im Postfach-Reiter
 * (`POST /api/post/senden`, siehe post.ts::senden) — es gibt keinen
 * zweiten. Neu ist nur der Weg DORTHIN für jemanden, der von sich aus
 * schreiben will, nicht auf etwas Bestehendes antwortet: Absenderfach,
 * Empfänger, Betreff, Text, Senden.
 *
 * DIE SPRACHREGEL
 * Jede Adresse beginnt auf Englisch und wechselt dauerhaft auf Deutsch,
 * sobald von dort Deutsch kam (services/post.ts::spracheFuer/spracheLernen).
 * Beim Schreiben an eine neue Adresse ist das fast immer Englisch — und
 * genau das tippt eine deutschsprachige Person leicht falsch ein, wenn sie
 * es nicht sieht. Deshalb wird die Sprache HIER, bevor gesendet wird,
 * nachgeschlagen (`GET /api/post/sprache`) und angezeigt, sobald die
 * eingetippte Adresse plausibel aussieht — kein Rätsel, keine Übersetzung
 * durch diese Oberfläche selbst (die käme ohnehin zu spät: die Sprachregel
 * lebt am Empfänger, nicht an dieser Eingabe).
 *
 * DIE ADRESSPRÜFUNG
 * `ADRESSE_GROB` unten ist nur ein Hinweis fürs Auge, keine Sperre — die
 * echte, strenge Prüfung (genau EINE Adresse, kein Komma, das Resend zu zwei
 * Empfängern machen würde) sitzt serverseitig in post.ts::senden() und lässt
 * sich von hier aus nicht umgehen.
 *
 * DIE KI
 * Der Knopf „KI schreibt" befüllt nur das Textfeld — er heißt bewusst nicht
 * „senden". Gesendet wird ausschließlich über den Knopf „Senden", von einem
 * Menschen, der den Text vorher sieht (siehe services/post-entwurf-ki.ts für
 * die Sperre: `senden` ist dort nicht einmal eingebunden). Ohne bestehenden
 * Verlauf hat die KI hier nichts, worauf sie aufbauen könnte — deshalb öffnet
 * der Knopf zunächst ein eigenes, kleines Feld für die Themenangabe, statt
 * irgendetwas zu erfinden (siehe post-entwurf-ki.ts: „Erfinde keine Fakten").
 *
 * Die Kennzeichnung „von StelliumAI erzeugt"/„mithilfe von … bearbeitet"
 * steht NICHT mehr im Text dieses Fensters — sie ist eine Fußzeile, die
 * `post.ts::senden()` server-seitig anhängt, erst nach dem eigentlichen
 * Text, siehe post-fussnote.ts. Diese Tafel hier merkt sich nur, bytegleich
 * unter `textKi`, was die KI zuletzt geliefert hat (`r.text` aus
 * `kiEntwurfHolen()`), und reicht das beim Senden als `textKi` an
 * `/api/post/senden` weiter — DORT, nicht hier, entscheidet
 * `kiHerkunft()` durch einen Wortvergleich zwischen `textKi` und dem
 * tatsächlich gesendeten Text, ob und welche Fußzeile es gibt.
 *
 * `textKi` MUSS deshalb geleert werden, sobald das Textfeld nicht mehr von
 * diesem Entwurf abstammt — sonst vergliche der Server zwei unabhängige
 * Texte und behauptete fälschlich „mithilfe von KI bearbeitet", obwohl gar
 * keine KI beteiligt war. Drei Stellen tun das hier: ein neuer Entwurf
 * ersetzt `textKi` gleich mit (kiSchreiben() unten), ein vollständig
 * geleertes Textfeld setzt `textKi` mit zurück auf `null` (Textarea
 * weiter unten), und das Schließen des Fensters räumt ohnehin alles ab,
 * weil `SchreibFenster` beim nächsten Öffnen frisch gemountet wird (siehe
 * `PostSchreiben` oben: `{offen && <SchreibFenster .../>}`). Bloßes
 * Weiterbearbeiten eines Entwurfs — und sei die Änderung noch so groß —
 * leert `textKi` dagegen bewusst NICHT: genau diese Bearbeitung ist der
 * Fall „mithilfe von … bearbeitet", den es zu erkennen gilt.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Loader2, Mail, Paperclip, Send, Sparkles, X,
} from 'lucide-react';
import { useStore } from '../state/store.js';
import { t as tStatisch, useT, spracheName, type TranslationKey } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { ApiError, serverUrl, token } from '../net/api.js';
import { fileSize } from '../lib/format.js';
import { textKiNachTextaenderung } from '../lib/post-schreiben-entwurf.js';
import '../styles/post-schreiben.css';

/* ── Abruf ───────────────────────────────────────────────────────
   Ein eigener, kleiner Ersatz für `request()` aus net/api.ts — aus demselben
   Grund wie in PostPanel.tsx: an api.ts wird gerade an anderer Stelle
   gearbeitet, `request()` ist dort nicht exportiert, und diese Tafel braucht
   nur einen kleinen Ausschnitt (Basisadresse, Anmeldenachweis, das Lesen von
   `code`/`error`/`werte` aus einer Fehlerantwort). Wortgleich mit der Fassung
   in PostPanel.tsx, aber bewusst noch einmal hier: ein Import über die
   Komponentengrenze für eine nicht exportierte, modul-lokale Funktion gibt
   es nicht, und beide Tafeln sollen unabhängig voneinander lesbar bleiben. */
async function postFetch<T>(pfad: string, init: RequestInit = {}): Promise<T> {
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

/** Ein Fach zur Auswahl: `fach` ist die Kennung, die tatsächlich gesendet
    wird (etwa `"support"`), `adresse` die vollständige Adresse nur für die
    Anzeige (etwa `"support@stellium.club"`) — dieselbe Hülle, die
    `services/post.ts::absenderFaecher()` liefert. */
interface SchreibFach { fach: string; adresse: string }

async function faecherHolen(): Promise<SchreibFach[]> {
  const r = await postFetch<{ faecher: SchreibFach[] }>('/api/post/schreibfaecher');
  return r.faecher;
}

async function spracheHolen(adresse: string): Promise<string> {
  const r = await postFetch<{ sprache: string }>(`/api/post/sprache?adresse=${encodeURIComponent(adresse)}`);
  return r.sprache;
}

interface KiEntwurf { text: string; sprache: string; modell: string | null }

async function kiEntwurfHolen(eingabe: { fach: string; an: string; thema: string }): Promise<KiEntwurf> {
  return postFetch<KiEntwurf>('/api/post/ki-entwurf', {
    method: 'POST',
    body: JSON.stringify({ modus: 'neu', ...eingabe }),
  });
}

async function neueMailSenden(
  eingabe: {
    fach: string; an: string; betreff: string; text: string; anhaenge?: string[];
    /** Der zuletzt gelieferte KI-Entwurf, roh — fehlt oder `null`, wenn diese
        Mail nicht (mehr) von einem Entwurf abstammt. Siehe Dateikopf und
        Ausgang.textKi in services/post.ts: der Server entscheidet aus dem
        Vergleich mit `text`, ob und welche Fußzeile die Mail bekommt. */
    textKi?: string | null;
  },
): Promise<{ id: string }> {
  return postFetch<{ id: string }>('/api/post/senden', { method: 'POST', body: JSON.stringify(eingabe) });
}

/* ── Anhänge ─────────────────────────────────────────────────────
   Hochgeladen wird SOFORT beim Auswählen, nicht erst beim Senden — dieselbe
   Reihenfolge wie beim Anhängen im Chat (Composer.tsx): die Kennung liegt
   dann längst bereit, wenn `senden()` unten sie nur noch mitschickt.
   `mail_id` bleibt beim Server so lange NULL, bis wirklich gesendet wird
   (siehe services/post.ts, ausgehenderAnhangAnlegen). */

interface AusgehenderAnhang { id: string; name: string; mime: string; size: number }

/** Eigener `fetch()` statt `postFetch()`: eine Datei geht als `FormData`
    hinaus, und `postFetch()` setzt bei jedem gesetzten Rumpf ausnahmslos
    `content-type: application/json` — das zerstört die Mehrteil-Grenze
    (`boundary`) eines Formulardatensatzes, der Server bekäme keine gültige
    Mehrteil-Anfrage mehr zu sehen. */
async function anhangHochladen(datei: File): Promise<AusgehenderAnhang> {
  const form = new FormData();
  form.append('file', datei);
  const headers = new Headers();
  const nachweis = token();
  if (nachweis) headers.set('authorization', `Bearer ${nachweis}`);

  let antwort: Response;
  try {
    antwort = await fetch(`${serverUrl()}/api/post/anhang`, { method: 'POST', body: form, headers });
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
  return (await antwort.json() as { anhang: AusgehenderAnhang }).anhang;
}

/** Ohne Rumpf — `postFetch()` setzt hier keinen Kopf, der stören könnte. */
async function anhangVerwerfen(id: string): Promise<void> {
  await postFetch(`/api/post/anhang/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Höchstens so viele auf einmal — reine Übersichtsgrenze für DIESES
    Fenster, keine Sicherheitsgrenze (die sitzt serverseitig in post.ts,
    AUSGANG_ANHANG_MAX/AUSGANG_ANHAENGE_MAX_GESAMT). */
const ANHAENGE_MAX_UI = 10;

/** Nur ein Hinweis fürs Auge — die echte Sperre steht serverseitig, siehe Dateikopf. */
const ADRESSE_GROB = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

const LETZTES_FACH_SCHLUESSEL = 'stellium.post.letztesFach';

/* ── Knopf + Fenster in einem ──────────────────────────────────── */

export function PostSchreiben({ onGesendet }: { onGesendet: () => void }) {
  const t = useT();
  const [offen, setOffen] = useState(false);
  return (
    <>
      <button
        className="icon-btn"
        title={t('post.neueNachricht')}
        aria-label={t('post.neueNachricht')}
        onClick={() => setOffen(true)}
      >
        <Mail size={15} />
      </button>
      {offen && <SchreibFenster onClose={() => setOffen(false)} onGesendet={onGesendet} />}
    </>
  );
}

function SchreibFenster({ onClose, onGesendet }: { onClose: () => void; onGesendet: () => void }) {
  const t = useT();

  const [faecher, setFaecher] = useState<SchreibFach[] | null>(null);
  const [faecherFehler, setFaecherFehler] = useState<string | null>(null);
  // Die letzte Wahl merken: das Absenderfach ist eine echte Entscheidung
  // (siehe Dateikopf), keine Nebensache, die bei jedem Öffnen neu getroffen
  // werden muss.
  const [absenderFach, setAbsenderFach] = useState(() => localStorage.getItem(LETZTES_FACH_SCHLUESSEL) || '');

  const [an, setAn] = useState('');
  const [betreff, setBetreff] = useState('');
  const [text, setText] = useState('');
  const [sendenLaedt, setSendenLaedt] = useState(false);

  const [sprache, setSprache] = useState<string | null>(null);
  const [spracheLaedt, setSpracheLaedt] = useState(false);

  const [kiOffen, setKiOffen] = useState(false);
  const [thema, setThema] = useState('');
  const [kiLaedt, setKiLaedt] = useState(false);
  // Bytegleicher Wortlaut des zuletzt von der KI gelieferten Entwurfs — geht
  // beim Senden als `textKi` hinaus, siehe Dateikopf für die Räumpflicht.
  const [textKi, setTextKi] = useState<string | null>(null);

  const [anhaenge, setAnhaenge] = useState<AusgehenderAnhang[]>([]);
  const [hochladend, setHochladend] = useState(0);
  const dateiInput = useRef<HTMLInputElement>(null);

  const dateienHinzufuegen = async (dateien: FileList) => {
    const liste = Array.from(dateien).slice(0, Math.max(0, ANHAENGE_MAX_UI - anhaenge.length));
    setHochladend((v) => v + liste.length);
    await Promise.all(liste.map(async (datei) => {
      try {
        const angelegt = await anhangHochladen(datei);
        setAnhaenge((v) => [...v, angelegt]);
      } catch (err) {
        useStore.getState().toast({
          kind: 'error', title: t('post.anhangHochladenFehlgeschlagen'), body: (err as Error).message,
        });
      } finally {
        setHochladend((v) => v - 1);
      }
    }));
  };

  const anhangEntfernen = (id: string) => {
    // Sofort aus der Ansicht — nicht erst, wenn der Server geantwortet hat:
    // dieselbe Vorgabe wie überall sonst beim Entfernen in dieser App.
    setAnhaenge((v) => v.filter((a) => a.id !== id));
    void anhangVerwerfen(id).catch(() => { /* verwaist harmlos, siehe post.ts */ });
  };

  /* Fenster schließen — ob durch Abbrechen oder nach erfolgreichem Senden.
     Ein bereits VERSCHICKTER Anhang (mail_id längst gesetzt) lehnt der Server
     beim Verwerfen einfach ab (siehe ausgehenderAnhangVerwerfen in post.ts) —
     kein Sonderfall hier nötig, nur ein harmloser Fehlschlag im Hintergrund. */
  const schliessen = () => {
    anhaenge.forEach((a) => { void anhangVerwerfen(a.id).catch(() => {}); });
    onClose();
  };

  useEffect(() => {
    (async () => {
      try {
        const liste = await faecherHolen();
        setFaecher(liste);
        setAbsenderFach((bisher) => (
          bisher && liste.some((f) => f.fach === bisher) ? bisher : (liste[0]?.fach ?? '')
        ));
      } catch (err) {
        setFaecherFehler((err as Error).message);
      }
    })();
  }, []);

  const adresseGueltig = ADRESSE_GROB.test(an.trim());

  // Sprache nachschlagen, sobald die Adresse plausibel aussieht — mit
  // kleiner Verzögerung, damit nicht bei jedem Tastendruck eine Anfrage
  // hinausgeht.
  useEffect(() => {
    if (!adresseGueltig) { setSprache(null); setSpracheLaedt(false); return; }
    let lebt = true;
    const adresse = an.trim();
    const zeitgeber = setTimeout(() => {
      setSpracheLaedt(true);
      spracheHolen(adresse)
        .then((s) => { if (lebt) setSprache(s); })
        .catch(() => { if (lebt) setSprache(null); })
        .finally(() => { if (lebt) setSpracheLaedt(false); });
    }, 350);
    return () => { lebt = false; clearTimeout(zeitgeber); };
  }, [an, adresseGueltig]);

  const absenderWaehlen = (fach: string) => {
    setAbsenderFach(fach);
    localStorage.setItem(LETZTES_FACH_SCHLUESSEL, fach);
  };

  const kiSchreiben = async () => {
    const themaText = thema.trim();
    if (!themaText || !absenderFach || !adresseGueltig) return;
    if (text.trim() && !window.confirm(t('post.kiUeberschreibenWarnung'))) return;
    setKiLaedt(true);
    try {
      const r = await kiEntwurfHolen({ fach: absenderFach, an: an.trim(), thema: themaText });
      setText(r.text);
      // Ersetzt einen älteren Entwurf gleich mit — kein separates Leeren
      // nötig, der neue Wortlaut ist ab hier der einzig gültige Bezug.
      setTextKi(r.text);
      setKiOffen(false);
    } catch (err) {
      // `thema` bleibt stehen — nichts wird bei einem Fehlschlag geleert,
      // sonst tippt die Person nach einem Netzfehler alles noch einmal.
      useStore.getState().toast({
        kind: 'error', title: t('post.kiFehlgeschlagen'), body: (err as Error).message,
      });
    } finally {
      setKiLaedt(false);
    }
  };

  const senden = async () => {
    setSendenLaedt(true);
    try {
      await neueMailSenden({
        fach: absenderFach, an: an.trim(), betreff: betreff.trim(), text, textKi,
        anhaenge: anhaenge.length ? anhaenge.map((a) => a.id) : undefined,
      });
      useStore.getState().toast({ kind: 'ok', title: t('post.gesendet') });
      onGesendet();
      onClose();
    } catch (err) {
      useStore.getState().toast({
        kind: 'error', title: t('post.sendenFehlgeschlagen'), body: (err as Error).message,
      });
    } finally {
      setSendenLaedt(false);
    }
  };

  const sendenGesperrt = !absenderFach || !adresseGueltig || !betreff.trim() || !text.trim()
    || sendenLaedt || hochladend > 0;

  return (
    <Shell title={t('post.neueNachricht')} icon={<Mail size={18} />} onClose={schliessen} width={540}>
      <div className="post-schreiben">
        {faecherFehler && <div className="post__fehler"><AlertTriangle size={13} /> {faecherFehler}</div>}

        <div className="field">
          <label className="field__label">{t('post.absenderfach')}</label>
          {!faecher && !faecherFehler && <Loader2 size={14} className="spin muted" role="status" aria-label={t('post.laedt')} />}
          {faecher && !faecher.length && <p className="field__hint">{t('post.keineFaecher')}</p>}
          {faecher && !!faecher.length && (
            <select className="select" value={absenderFach} onChange={(e) => absenderWaehlen(e.target.value)}>
              {faecher.map((f) => <option key={f.fach} value={f.fach}>{f.adresse}</option>)}
            </select>
          )}
        </div>

        <div className="field">
          <label className="field__label">{t('post.empfaenger')}</label>
          <input
            className="input"
            value={an}
            autoFocus
            placeholder={t('post.empfaengerPlatzhalter')}
            onChange={(e) => setAn(e.target.value)}
          />
          {an.trim() !== '' && !adresseGueltig && (
            <p className="field__hint post-schreiben__warnung">{t('post.empfaengerUngueltig')}</p>
          )}
          {adresseGueltig && spracheLaedt && (
            <p className="field__hint"><Loader2 size={11} className="spin" /></p>
          )}
          {adresseGueltig && !spracheLaedt && sprache && (
            <p className="field__hint">{t('post.spracheHinweis', { sprache: spracheName(sprache) })}</p>
          )}
        </div>

        <div className="field">
          <label className="field__label">{t('post.betreffLabel')}</label>
          <input
            className="input"
            value={betreff}
            placeholder={t('post.betreffPlatzhalter')}
            onChange={(e) => setBetreff(e.target.value)}
          />
        </div>

        <div className="field">
          <textarea
            className="textarea"
            aria-label={t('post.neuTextLabel')}
            placeholder={t('post.neuTextPlatzhalter')}
            rows={9}
            value={text}
            onChange={(e) => {
              const wert = e.target.value;
              setText(wert);
              // Regel + Begründung stehen in lib/post-schreiben-entwurf.ts,
              // dort auch ohne React geprüft (siehe Dateikopf, „Räumpflicht").
              setTextKi((bisher) => textKiNachTextaenderung(bisher, wert));
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !sendenGesperrt) { e.preventDefault(); void senden(); }
            }}
          />
        </div>

        <div className="field">
          <input
            ref={dateiInput}
            type="file"
            multiple
            hidden
            onChange={(e) => { if (e.target.files?.length) void dateienHinzufuegen(e.target.files); e.target.value = ''; }}
          />
          <div className="post-schreiben__anhaenge">
            {anhaenge.map((a) => (
              <span key={a.id} className="post-schreiben__anhang" title={a.name}>
                <span className="post-schreiben__anhang-name truncate">{a.name}</span>
                <span className="post-schreiben__anhang-groesse">{fileSize(a.size)}</span>
                <button
                  type="button"
                  className="post-schreiben__anhang-entfernen"
                  title={t('common.remove')}
                  aria-label={t('common.remove')}
                  onClick={() => anhangEntfernen(a.id)}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {hochladend > 0 && (
              <span className="post-schreiben__anhang muted">
                <Loader2 size={11} className="spin" /> {t('post.anhangWirdHochgeladen')}
              </span>
            )}
            {anhaenge.length + hochladend < ANHAENGE_MAX_UI && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => dateiInput.current?.click()}
              >
                <Paperclip size={13} /> {t('post.anhangHinzufuegen')}
              </button>
            )}
          </div>
        </div>

        {kiOffen && (
          <div className="field post-schreiben__ki-thema">
            <label className="field__label">{t('post.kiThemaLabel')}</label>
            <input
              className="input"
              value={thema}
              autoFocus
              placeholder={t('post.kiThemaPlatzhalter')}
              onChange={(e) => setThema(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void kiSchreiben(); }}
            />
            <div className="hstack gap-2">
              <button className="btn btn--primary" disabled={!thema.trim() || kiLaedt} onClick={() => void kiSchreiben()}>
                {kiLaedt ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} {t('post.kiEntwurfErzeugen')}
              </button>
              <button className="btn" disabled={kiLaedt} onClick={() => setKiOffen(false)}>{t('common.cancel')}</button>
            </div>
          </div>
        )}

        <div className="post-schreiben__fuss">
          <span className="muted post-schreiben__hinweis">{t('post.sendenHinweis')}</span>
          <div className="hstack gap-2">
            {!kiOffen && (
              <button
                className="btn"
                disabled={!adresseGueltig || !absenderFach || kiLaedt}
                title={t('post.kiSchreibenKnopf')}
                onClick={() => setKiOffen(true)}
              >
                <Sparkles size={14} /> {t('post.kiSchreibenKnopf')}
              </button>
            )}
            <button className="btn btn--primary" disabled={sendenGesperrt} onClick={() => void senden()}>
              {sendenLaedt ? <Loader2 size={14} className="spin" /> : <Send size={14} />} {t('post.senden')}
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}
