import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowUpRight, Check, Hash, Inbox, Lightbulb, ListChecks, Loader2, Pencil,
  Undo2, X,
} from 'lucide-react';
import { useStore } from '../state/store.js';
import { uebersetztesFeld, type Vorschlag, type VorschlagArt } from '@stellium/shared';
import { useVorschlaege } from '../state/vorschlaege.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { clsx, kanalName, relativeTime } from '../lib/format.js';

/**
 * Der Eingang: was StelliumAI vorschlägt, bevor es etwas wird.
 *
 * EIN ORT, NICHT ZWEI
 *
 * Aufgaben und Ideen liegen hier zusammen. Zwei Reiter an zwei Brettern wären
 * zwei Orte, an die man morgens denken muss — und die Art ist ohnehin geraten:
 * liegt das Modell daneben, landet der Vorschlag im falschen Reiter und ist
 * verloren. Hier ist die Art ein Schalter auf der Karte. Die Reiter oben
 * filtern nur; sie trennen nichts.
 *
 * WAS AUF DER KARTE STEHT
 *
 * Titel, Kanal, und die Nachricht, aus der er stammt. Das Letzte ist das
 * Wichtigste: ohne den Wortlaut kann niemand beurteilen, ob der Vorschlag
 * stimmt — man müsste dem Modell glauben. Der Sprung in den Kanal steht
 * daneben, für den Fall, dass ein Satz nicht reicht.
 *
 * WAS SICH HIER ÄNDERN LÄSST
 *
 * Titel, Art, zuständige Person, Frist. Genau die vier entscheiden darüber, ob
 * man Ja sagen kann, und genau die vier trifft das Modell am ehesten knapp
 * daneben. Beschreibung, Wichtigkeit, Schlagwort und Status gehören dem
 * fertigen Ding und stehen auf dem Brett — ein zweiter, schlechterer Editor
 * hier hülfe niemandem.
 *
 * AUF DEM TELEFON
 *
 * Die Karte ist eine Spalte, keine Tabelle: Kopf, Quelle, Knöpfe untereinander.
 * Die Knopfzeile darf umbrechen, und jeder Knopf ist mindestens 40 px hoch —
 * bei 375 px Breite passen "Annehmen" und "Ablehnen" nebeneinander, alles
 * Weitere rutscht in die zweite Zeile.
 */

export type VorschlagFilter = 'alle' | VorschlagArt;

export function VorschlagPosteingang({ onClose, startFilter = 'alle' }: {
  onClose: () => void;
  /** Womit der Eingang aufgeht — die Türen an den Brettern kommen vorgefiltert. */
  startFilter?: VorschlagFilter;
}) {
  const t = useT();
  const liste = useVorschlaege((s) => s.liste);
  const geladen = useVorschlaege((s) => s.geladen);
  const zuletzt = useVorschlaege((s) => s.zuletzt);
  const { laden, zuruecknehmen } = useVorschlaege.getState();

  const [filter, setFilter] = useState<VorschlagFilter>(startFilter);

  useEffect(() => { laden(); }, [laden]);

  const zahlen = useMemo(() => ({
    alle: liste.length,
    aufgabe: liste.filter((v) => v.art === 'aufgabe').length,
    idee: liste.filter((v) => v.art === 'idee').length,
  }), [liste]);

  const sichtbar = useMemo(
    () => (filter === 'alle' ? liste : liste.filter((v) => v.art === filter)),
    [liste, filter],
  );

  return (
    <Shell
      title={t('vorschlaege.title')}
      subtitle={t('vorschlaege.subtitle', { n: liste.length })}
      icon={<Inbox size={18} />}
      onClose={onClose}
      width={720}
    >
      <div className="vorschlag-leiste">
        {(['alle', 'aufgabe', 'idee'] as const).map((f) => (
          <button
            key={f}
            className={clsx('vorschlag-tab', filter === f && 'vorschlag-tab--on')}
            onClick={() => setFilter(f)}
          >
            {f === 'aufgabe' && <ListChecks size={12} />}
            {f === 'idee' && <Lightbulb size={12} />}
            {f === 'alle' ? t('vorschlaege.all')
              : f === 'aufgabe' ? t('vorschlaege.kindTask') : t('vorschlaege.kindIdea')}
            <span className="vorschlag-tab__n">{zahlen[f]}</span>
          </button>
        ))}
      </div>

      {/* Rückgängig steht nur, solange man noch weiß, worauf es sich bezieht. */}
      <AnimatePresence>
        {zuletzt && (
          <motion.div
            className="vorschlag-zurueck"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <Check size={14} className="ok" />
            <span className="vorschlag-zurueck__text">
              {t('vorschlaege.accepted', { titel: zuletzt.titel })}
            </span>
            <button className="btn btn--ghost btn--sm" onClick={() => zuruecknehmen(zuletzt.id)}>
              <Undo2 size={13} /> {t('common.undo')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {!geladen ? (
        <div className="empty-state">
          <Loader2 size={26} className="spin muted" />
          <p>{t('vorschlaege.loading')}</p>
        </div>
      ) : !sichtbar.length ? (
        <div className="empty-state">
          <Inbox size={30} className="muted" />
          <p>{liste.length ? t('vorschlaege.emptyHere') : t('vorschlaege.empty')}</p>
        </div>
      ) : (
        <div className="vorschlag-liste">
          <AnimatePresence initial={false}>
            {sichtbar.map((v) => <Karte key={v.id} vorschlag={v} onClose={onClose} />)}
          </AnimatePresence>
        </div>
      )}

      <p className="vorschlag-fuss">{t('vorschlaege.laterHint')}</p>
    </Shell>
  );
}

/* ── Eine Karte ─────────────────────────────────────────────── */

function Karte({ vorschlag, onClose }: { vorschlag: Vorschlag; onClose: () => void }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const laeuft = useVorschlaege((s) => s.laeuft === vorschlag.id);
  const { annehmen, ablehnen } = useVorschlaege.getState();

  const [offen, setOffen] = useState(false);
  const [titel, setTitel] = useState(vorschlag.titel);
  const [art, setArt] = useState<VorschlagArt>(vorschlag.art);
  const [zustaendig, setZustaendig] = useState(vorschlag.genanntUserId ?? '');
  const [frist, setFrist] = useState(vorschlag.faelligAm ? tagesFeld(vorschlag.faelligAm) : '');

  const schreiber = vorschlag.quelleUserId ? users[vorschlag.quelleUserId] : null;
  const genannt = vorschlag.genanntUserId ? users[vorschlag.genanntUserId] : null;

  /* Gelesen wird die Lesesprache, gespeichert das Original — dieselbe Regel
     wie bei einer Nachricht, deren `text` IMMER das Original trägt. Darum
     hängt die Übersetzung nur am Titel OBEN und nicht am Eingabefeld weiter
     unten: was dort steht, geht beim Annehmen wirklich so in die Aufgabe.
     Sobald jemand den Titel angefasst hat, gilt seine Fassung — sonst
     schriebe die eintreffende Übersetzung ihm ins Feld zurück. */
  const titelAnzeige = titel === vorschlag.titel
    ? (uebersetztesFeld(vorschlag, 'titel', vorschlag.titel) ?? titel)
    : titel;
  const quelleAnzeige = uebersetztesFeld(vorschlag, 'quelleText', vorschlag.quelleText);

  const bestaetigen = () => annehmen(vorschlag.id, {
    titel: titel.trim(),
    art,
    // Bei Ideen gibt es keine zuständige Person — der Wert würde verworfen,
    // aber ihn erst gar nicht zu schicken ist ehrlicher.
    zustaendigId: art === 'aufgabe' ? (zustaendig || null) : null,
    faelligAm: art === 'aufgabe' && frist ? new Date(`${frist}T23:59`).getTime() : null,
  });

  return (
    <motion.div
      layout
      className="vorschlag"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.18 }}
    >
      <div className="vorschlag__kopf">
        <span className={clsx('vorschlag__art', art === 'idee' && 'vorschlag__art--idee')}>
          {art === 'idee' ? <Lightbulb size={12} /> : <ListChecks size={12} />}
          {art === 'idee' ? t('vorschlaege.kindIdea') : t('vorschlaege.kindTask')}
        </span>
        <h3 className="vorschlag__titel">{titelAnzeige}</h3>
      </div>

      <div className="vorschlag__meta">
        <span className="vorschlag__chan">
          <Hash size={11} />
          {kanalName(channels[vorschlag.channelId] ?? { name: vorschlag.channelName })}
        </span>
        {genannt && (
          <span className="vorschlag__wer"><Avatar user={genannt} size={15} /> {genannt.displayName}</span>
        )}
        {vorschlag.faelligAm && (
          <span>{t('tasks.due')}: {relativeTime(vorschlag.faelligAm)}</span>
        )}
        <span className="muted">{relativeTime(vorschlag.erstelltAm)}</span>
      </div>

      {/* Die Herkunft. Ohne sie ist ein Vorschlag eine Behauptung. */}
      {vorschlag.quelleText && (
        <div className="vorschlag__quelle">
          <span className="vorschlag__quelle-kopf">
            {schreiber && <Avatar user={schreiber} size={15} />}
            <strong>{schreiber?.displayName ?? '—'}</strong>
            {vorschlag.quelleAm && <span className="muted">{relativeTime(vorschlag.quelleAm)}</span>}
          </span>
          <p className="vorschlag__quelle-text">{quelleAnzeige}</p>
          {vorschlag.quelleMessageId && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                useStore.getState().jumpToMessage(vorschlag.channelId, vorschlag.quelleMessageId!);
                onClose();
              }}
            >
              <ArrowUpRight size={13} /> {t('vorschlaege.goToMessage')}
            </button>
          )}
        </div>
      )}

      <AnimatePresence initial={false}>
        {offen && (
          <motion.div
            className="vorschlag__aendern"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="field">
              <label className="field__label">{t('vorschlaege.titleField')}</label>
              <input className="input" value={titel} onChange={(e) => setTitel(e.target.value)} />
            </div>

            <div className="field">
              <label className="field__label">{t('vorschlaege.kindLabel')}</label>
              <div className="hstack gap-2">
                <button
                  className={clsx('btn btn--sm', art === 'aufgabe' && 'btn--primary')}
                  onClick={() => setArt('aufgabe')}
                >
                  <ListChecks size={13} /> {t('vorschlaege.kindTask')}
                </button>
                <button
                  className={clsx('btn btn--sm', art === 'idee' && 'btn--primary')}
                  onClick={() => setArt('idee')}
                >
                  <Lightbulb size={13} /> {t('vorschlaege.kindIdea')}
                </button>
              </div>
              <p className="field__hint">{t('vorschlaege.kindHint')}</p>
            </div>

            {/* Eine Idee hat noch niemanden, der sie macht — nur jemanden, der
                sie hatte. Zuständigkeit und Frist gehören deshalb allein zur
                Aufgabe. */}
            {art === 'aufgabe' && (
              <div className="grid-2">
                <div className="field">
                  <label className="field__label">{t('tasks.assignee')}</label>
                  <select
                    className="select" value={zustaendig}
                    onChange={(e) => setZustaendig(e.target.value)}
                  >
                    <option value="">{t('tasks.unassigned')}</option>
                    {Object.values(users)
                      .filter((u) => !u.disabled && u.role !== 'bot' && !u.technisch)
                      .map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="field__label">{t('tasks.due')}</label>
                  <input
                    className="input" type="date" value={frist}
                    onChange={(e) => setFrist(e.target.value)}
                  />
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="vorschlag__knoepfe">
        <button
          className="btn btn--primary"
          disabled={laeuft || titel.trim().length < 3}
          onClick={bestaetigen}
        >
          {laeuft ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
          {t('vorschlaege.accept')}
        </button>
        <button className="btn" disabled={laeuft} onClick={() => ablehnen(vorschlag.id)}>
          <X size={14} /> {t('vorschlaege.reject')}
        </button>
        <button className="btn btn--ghost" onClick={() => setOffen((v) => !v)}>
          <Pencil size={14} /> {offen ? t('vorschlaege.editDone') : t('vorschlaege.edit')}
        </button>
      </div>
    </motion.div>
  );
}

function tagesFeld(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
