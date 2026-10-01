import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, Check, ClipboardList, Copy, HelpCircle, ListChecks, Loader2, RefreshCw } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';

/**
 * Protokoll eines Kanals: Themen, Beschlüsse, offene Fragen, Aufgaben.
 * Anders als die Zusammenfassung ist das ein Ergebnis zum Weitergeben — es
 * lässt sich als Text kopieren und die Aufgaben daraus direkt anlegen.
 */
export function ProtocolPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const protokoll = useStore((s) => s.protocol);
  const laeuft = useStore((s) => s.protocolLoading);
  const fehler = useStore((s) => s.protocolFehler);
  const users = useStore((s) => s.users);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const { loadProtocol, clearProtocol, createTask, toast } = useStore.getState();
  const [kopiert, setKopiert] = useState(false);

  /* Nur beim Öffnen anstoßen. Ohne die Fehlerabfrage liefe nach einem
     Fehlschlag sofort der nächste Versuch — der Kreisel wäre wieder da, nur
     mit einem Umweg. */
  useEffect(() => {
    /* Frisch aus dem Store, nicht aus dem Rendern: wechselt der Kanal bei
       offener Tafel, hat das Aufräumen eben alles geleert — die Werte aus dem
       Rendern zeigten aber noch das alte Protokoll, und die Tafel bliebe leer,
       statt für den neuen Kanal anzufragen. */
    const s = useStore.getState();
    if (activeChannelId && !s.protocol && !s.protocolLoading && !s.protocolFehler) loadProtocol(activeChannelId);
    return () => clearProtocol();
  }, [activeChannelId]);

  const alsText = () => {
    if (!protokoll) return '';
    const zeilen = [protokoll.title, ''];
    for (const thema of protokoll.topics) {
      zeilen.push(`## ${thema.heading}`);
      zeilen.push(...thema.points.map((p) => `- ${p}`), '');
    }
    if (protokoll.decisions.length) {
      zeilen.push(`## ${t('protocol.decisions')}`, ...protokoll.decisions.map((d) => `- ${d}`), '');
    }
    if (protokoll.openQuestions.length) {
      zeilen.push(`## ${t('protocol.open')}`, ...protokoll.openQuestions.map((q) => `- ${q}`), '');
    }
    if (protokoll.actionItems.length) {
      zeilen.push(`## ${t('protocol.actions')}`, ...protokoll.actionItems.map((a) => {
        const wer = a.assigneeId ? users[a.assigneeId]?.displayName : null;
        return `- ${a.text}${wer ? ` (${wer})` : ''}`;
      }));
    }
    return zeilen.join('\n');
  };

  return (
    <Shell
      title={t('protocol.title')}
      subtitle={protokoll ? t('protocol.fromMessages', { n: protokoll.messageCount }) : undefined}
      icon={<ClipboardList size={18} />}
      onClose={onClose}
      width={640}
      actions={protokoll ? (
        <button
          className="pill"
          onClick={async () => {
            await navigator.clipboard.writeText(alsText());
            setKopiert(true);
            setTimeout(() => setKopiert(false), 1800);
          }}
        >
          {kopiert ? <Check size={13} /> : <Copy size={13} />} {t('protocol.copy')}
        </button>
      ) : undefined}
    >
      {laeuft && (
        <div className="empty-state" data-zustand="laeuft">
          <Loader2 size={26} className="spin" />
          <p>{t('protocol.running')}</p>
        </div>
      )}

      {/* Der Fehlschlag gehört hierher, nicht nur in ein Meldungsfenster am
          Rand. Vorher blieb an dieser Stelle der Kreisel stehen, während die
          Meldung nebenan aufging — man wartete auf etwas, das längst
          entschieden war. */}
      {!laeuft && fehler && (
        <div className="empty-state" data-zustand="fehler" role="alert">
          <AlertCircle size={26} style={{ color: 'var(--rose)' }} />
          <p>{t('protocol.failed')}</p>
          <p className="muted" style={{ fontSize: 12.5, maxWidth: '52ch', wordBreak: 'break-word' }}>{fehler}</p>
          <button
            className="btn btn--primary"
            onClick={() => activeChannelId && loadProtocol(activeChannelId)}
            disabled={!activeChannelId}
          >
            <RefreshCw size={14} /> {t('common.retry')}
          </button>
        </div>
      )}

      {!laeuft && !fehler && protokoll && !protokoll.messageCount && (
        <div className="empty-state"><p>{t('protocol.empty')}</p></div>
      )}

      {!laeuft && protokoll && !!protokoll.messageCount && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          <h3 className="proto__head">{protokoll.title}</h3>

          {protokoll.topics.map((thema, i) => (
            <motion.section
              key={i}
              className="proto__block"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.04 * i, duration: 0.22 }}
            >
              <h4 className="proto__title">{thema.heading}</h4>
              <ul className="proto__list">
                {thema.points.map((p, j) => <li key={j}>{p}</li>)}
              </ul>
            </motion.section>
          ))}

          {!!protokoll.decisions.length && (
            <section className="proto__block proto__block--gut">
              <h4 className="proto__title"><Check size={13} /> {t('protocol.decisions')}</h4>
              <ul className="proto__list">
                {protokoll.decisions.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </section>
          )}

          {!!protokoll.openQuestions.length && (
            <section className="proto__block proto__block--offen">
              <h4 className="proto__title"><HelpCircle size={13} /> {t('protocol.open')}</h4>
              <ul className="proto__list">
                {protokoll.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
            </section>
          )}

          {!!protokoll.actionItems.length && (
            <section className="proto__block">
              <h4 className="proto__title"><ListChecks size={13} /> {t('protocol.actions')}</h4>
              <div className="proto__actions">
                {protokoll.actionItems.map((a, i) => {
                  const wer = a.assigneeId ? users[a.assigneeId] : null;
                  return (
                    <div key={i} className="proto__action">
                      <span className="proto__action-text">{a.text}</span>
                      {wer && <span className="proto__who"><Avatar user={wer} size={16} /> {wer.displayName}</span>}
                      <button
                        className="pill"
                        onClick={() => {
                          createTask({ title: a.text, assigneeId: a.assigneeId, channelId: activeChannelId });
                          toast({ kind: 'ok', title: t('protocol.taskCreated'), body: a.text });
                        }}
                      >
                        <ListChecks size={12} /> {t('protocol.makeTask')}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </motion.div>
      )}
    </Shell>
  );
}
