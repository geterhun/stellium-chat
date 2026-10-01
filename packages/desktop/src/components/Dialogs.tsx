import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { BarChart3, Bell, Forward, Hash, Lock, Plus, Trash2, X } from 'lucide-react';
import type { Message } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { useT, t , currentUiLanguage } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { kanalName } from '../lib/format.js';
import { useKlartext } from './Vertraulich.jsx';

/* ── Weiterleiten ─────────────────────────────────────────────── */

export function ForwardDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const channels = useStore((s) => s.channels);
  const users = useStore((s) => s.users);
  const [comment, setComment] = useState('');
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<string | null>(null);

  /* Vertrauliche Kanäle sind kein Ziel: der Server setzt den weitergeleiteten
     Text selbst zusammen und hat dort keinen Schlüssel — der Kommentar käme
     offen in einem Kanal an, den jemand ausdrücklich geschlossen hat. */
  const list = Object.values(channels)
    .filter((c) => !c.archived && !c.vertraulich && c.id !== message.channelId)
    .filter((c) => {
      const label = c.kind === 'dm' ? users[c.dmPeerId ?? '']?.displayName ?? '' : c.name;
      return label.toLowerCase().includes(query.trim().toLowerCase());
    })
    .slice(0, 40);

  return (
    <Frame title={t('msg.forward')} icon={<Forward size={18} />} onClose={onClose} width={520}>
      <div className="forward-preview">{message.text.slice(0, 300) || `🎙️ ${t('msg.voiceNote')}`}</div>

      <div className="field">
        <label className="field__label">{t('forward.comment')}</label>
        <input className="input" value={comment} placeholder={t('forward.why')} onChange={(e) => setComment(e.target.value)} />
      </div>

      <div className="field">
        <label className="field__label">{t('forward.target')}</label>
        <input className="input" value={query} autoFocus placeholder={t('forward.search')} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: 'var(--sp-3)' }}>
        {list.map((c) => {
          const peer = c.kind === 'dm' ? users[c.dmPeerId ?? ''] : null;
          return (
            <button key={c.id} className="result" data-active={target === c.id} onClick={() => setTarget(c.id)}>
              {c.kind === 'dm' ? <Avatar user={peer} size={24} />
                : c.kind === 'private' ? <Lock size={15} className="muted" /> : <Hash size={15} className="muted" />}
              <div className="result__main">
                <div className="result__title">{c.kind === 'dm' ? peer?.displayName ?? t('chat.dmShort') : `#${kanalName(c)}`}</div>
              </div>
            </button>
          );
        })}
      </div>

      <button
        className="btn btn--primary btn--block"
        disabled={!target}
        onClick={() => target && useStore.getState().forwardMessage(message.id, target, comment.trim() || undefined)}
      >
        {t('msg.forward')}
      </button>
    </Frame>
  );
}

/* ── Erinnerung ───────────────────────────────────────────────── */

export function ReminderDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [custom, setCustom] = useState('');
  /* Erinnern geht auch in einem vertraulichen Kanal — dort steht im Zustand
     das Chiffrat, und die Vorschau zeigte sonst einen Block Zeichen. */
  const { text: klartext, unlesbar, laeuft } = useKlartext(message.channelId, message.text);

  const presets = [
    { label: t('reminder.in20'), ms: 20 * 60_000 },
    { label: t('reminder.in1h'), ms: 3600_000 },
    { label: t('reminder.tonight'), ms: msUntilHour(18) },
    { label: t('schedule.tomorrow9'), ms: msUntilHour(9, 1) },
    { label: t('reminder.nextWeek'), ms: 7 * 86_400_000 },
  ];

  const create = (remindAt: number) => useStore.getState().createReminder({
    channelId: message.channelId, messageId: message.id,
    note: note.trim() || null, remindAt,
  });

  return (
    <Frame title={t('reminder.title')} icon={<Bell size={18} />} onClose={onClose} width={460}>
      <div className="forward-preview">
        {unlesbar ? t('vertraulich.nichtLesbar')
          : laeuft ? '…'
          : klartext.slice(0, 220) || `🎙️ ${t('msg.voiceNote')}`}
      </div>

      <div className="field">
        <label className="field__label">{t('reminder.about')}</label>
        <input className="input" value={note} autoFocus placeholder={t('reminder.aboutPlaceholder')} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div className="stack gap-2">
        {presets.map((p) => (
          <button key={p.label} className="btn btn--block" onClick={() => create(Date.now() + p.ms)}>{p.label}</button>
        ))}
      </div>

      <div className="field" style={{ marginTop: 'var(--sp-4)' }}>
        <label className="field__label">{t('schedule.ownTime')}</label>
        <div className="hstack gap-2">
          <input className="input" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button
            className="btn btn--primary"
            disabled={!custom}
            onClick={() => {
              const ts = new Date(custom).getTime();
              if (Number.isFinite(ts) && ts > Date.now()) create(ts);
            }}
          >{t('auth.set')}</button>
        </div>
      </div>
    </Frame>
  );
}

function msUntilHour(hour: number, addDays = 0): number {
  const d = new Date();
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, 0, 0, 0);
  const delta = d.getTime() - Date.now();
  return delta > 0 ? delta : delta + 86_400_000;
}

/* ── Umfrage anlegen ──────────────────────────────────────────── */

export function PollDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const ready = question.trim().length > 2 && filled.length >= 2;

  return (
    <Frame title={t('poll.start')} icon={<BarChart3 size={18} />} onClose={onClose} width={520}>
      <div className="field">
        <label className="field__label">{t('poll.question')}</label>
        <input
          className="input"
          value={question}
          autoFocus
          placeholder={t('poll.questionPlaceholder')}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('poll.options')}</label>
        <div className="stack gap-2">
          {options.map((option, i) => (
            <div key={i} className="hstack gap-2">
              <input
                className="input"
                value={option}
                placeholder={t('poll.option', { n: i + 1 })}
                onChange={(e) => setOptions((prev) => prev.map((o, n) => (n === i ? e.target.value : o)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && i === options.length - 1 && options.length < 12) {
                    setOptions((prev) => [...prev, '']);
                  }
                }}
              />
              {options.length > 2 && (
                <button
                  className="icon-btn icon-btn--sm"
                  onClick={() => setOptions((prev) => prev.filter((_, n) => n !== i))}
                  title={t('common.remove')}
                  aria-label={t('common.remove')}
                ><Trash2 size={14} /></button>
              )}
            </div>
          ))}
        </div>
        {options.length < 12 && (
          <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={() => setOptions((prev) => [...prev, ''])}>
            <Plus size={14} /> {t('poll.addOption')}
          </button>
        )}
      </div>

      <Toggle title={t('poll.multiple')} sub={t('poll.multipleHint')} value={multiple} onChange={setMultiple} />
      <Toggle
        title={t('poll.anonymousTitle')}
        sub={`${t('poll.anonymousHint')} ${t('poll.anonymousFinal')}`}
        value={anonymous}
        onChange={setAnonymous}
      />

      <button
        className="btn btn--primary btn--block"
        style={{ marginTop: 'var(--sp-4)' }}
        disabled={!ready}
        onClick={() => useStore.getState().createPoll({
          channelId, question: question.trim(), options: filled, multiple, anonymous,
        })}
      >
        {t('poll.start')}
      </button>
    </Frame>
  );
}

/* ── Erinnerungsliste ─────────────────────────────────────────── */

export function RemindersPanel({ onClose }: { onClose: () => void }) {
  const reminders = useStore((s) => s.reminders);
  const channels = useStore((s) => s.channels);
  const { cancelReminder, jumpToMessage } = useStore.getState();

  return (
    <Frame title={t('reminder.listTitle')} icon={<Bell size={18} />} onClose={onClose} width={520}>
      {reminders.length === 0 && (
        <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
          {t('reminder.nothing')}
        </p>
      )}
      {reminders.map((r) => (
        <div key={r.id} className="row">
          <div className="row__main">
            <div className="row__title">{r.note || t('reminder.one')}</div>
            <div className="row__sub">
              {new Date(r.remindAt).toLocaleString(currentUiLanguage(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              {channels[r.channelId] && ` · #${kanalName(channels[r.channelId])}`}
            </div>
          </div>
          {r.messageId && (
            <button className="btn btn--ghost" onClick={() => { jumpToMessage(r.channelId, r.messageId!); onClose(); }}>
              {t('reminder.show')}
            </button>
          )}
          <button className="icon-btn" onClick={() => cancelReminder(r.id)} title={t('reminder.delete')} aria-label={t('reminder.delete')}><Trash2 size={15} /></button>
        </div>
      ))}
    </Frame>
  );
}

/* ── Gemeinsamer Rahmen ───────────────────────────────────────── */

function Frame({ title, icon, onClose, width, children }: {
  title: string; icon: React.ReactNode; onClose: () => void; width: number; children: React.ReactNode;
}) {
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, onClose);
  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        ref={kasten}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel"
        style={{ width: `min(${width}px, 100%)` }}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ duration: 0.19, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          {icon}
          <h2>{title}</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title={t('common.close')} aria-label={t('common.close')}><X size={17} /></button>
        </div>
        <div className="panel__body">{children}</div>
      </motion.div>
    </div>
  );
}

function Toggle({ title, sub, value, onChange }: { title: string; sub: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row">
      <div className="row__main">
        <div className="row__title">{title}</div>
        <div className="row__sub">{sub}</div>
      </div>
      <button className="switch" role="switch" aria-checked={value} onClick={() => onChange(!value)} />
    </div>
  );
}
