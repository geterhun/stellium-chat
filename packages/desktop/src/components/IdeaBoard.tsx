import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check, Hash, Inbox, Lightbulb, MessageSquare, Plus, Send, Sparkles, ThumbsDown, ThumbsUp,
  Trash2, X,
} from 'lucide-react';
import { IDEA_STATUSES, uebersetztesFeld, type Idea, type IdeaStatus } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useVorschlaege } from '../state/vorschlaege.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { PruefListe } from './PruefListe.jsx';
import { clsx, relativeTime } from '../lib/format.js';

const STATUS_FARBE: Record<IdeaStatus, string> = {
  new: 'var(--blue)',
  working: 'var(--amber)',
  done: 'var(--green)',
  rejected: 'var(--text-dim)',
};

export function IdeaBoard({ onClose }: { onClose: () => void }) {
  const t = useT();
  /* Wie viele Vorschläge dieser Art warten. Aus demselben Laden wie der
     Eingang selbst — keine zweite Zählung, die irgendwann abweicht. */
  const offeneVorschlaege = useVorschlaege(
    (s) => s.liste.filter((v) => v.art === 'idee').length,
  );

  const ideas = useStore((s) => s.ideas);
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const { loadIdeas, ideeGeprueft, deleteIdea } = useStore.getState();

  const [filter, setFilter] = useState<IdeaStatus | 'alle'>('alle');
  const [sortierung, setSortierung] = useState<'stimmen' | 'neu'>('stimmen');
  const [neuOffen, setNeuOffen] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  /** Der Reiter „Prüfen": nur, was die KI selbst eingebracht hat. */
  const [pruefen, setPruefen] = useState(false);

  useEffect(() => { loadIdeas(); }, [loadIdeas]);

  const ungeprueft = useMemo(
    () => Object.values(ideas).filter((i) => i.vonKi && !i.geprueft),
    [ideas],
  );
  /* Leerer Reiter führt ins Nichts — dann zurück auf die Liste. */
  useEffect(() => {
    if (pruefen && !ungeprueft.length) setPruefen(false);
  }, [pruefen, ungeprueft.length]);

  const liste = useMemo(() => {
    const alle = Object.values(ideas).filter((i) => filter === 'alle' || i.status === filter);
    return alle.sort((a, b) => sortierung === 'stimmen'
      // Zustimmung minus Ablehnung; bei Gleichstand die neuere zuerst.
      ? (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes) || b.updatedAt - a.updatedAt
      : b.createdAt - a.createdAt);
  }, [ideas, filter, sortierung]);

  const zahlen = useMemo(() => {
    const k: Record<string, number> = { alle: Object.keys(ideas).length };
    for (const s of IDEA_STATUSES) k[s] = Object.values(ideas).filter((i) => i.status === s).length;
    return k;
  }, [ideas]);

  return (
    <Shell
      title={t('ideas.title')}
      subtitle={t('ideas.subtitle')}
      icon={<Lightbulb size={18} />}
      onClose={onClose}
      width={860}
      actions={
        <>
          {/* Dons „jeweils": das Brett zeigt, dass Vorschläge dieser Art
              warten, und führt in den einen Eingang — vorgefiltert. Ein
              eigener Reiter je Brett wäre der zweite Ort zum Nachsehen. */}
          {offeneVorschlaege > 0 && (
            <button
              className="pill"
              onClick={() => useVorschlaege.getState().oeffnen('idee')}
            >
              <Inbox size={13} /> {t('vorschlaege.doorIdeas', { n: offeneVorschlaege })}
            </button>
          )}
          {ungeprueft.length > 0 && (
            <button
              className={clsx('pill', pruefen ? 'pill--accent' : 'pill--warn')}
              onClick={() => setPruefen((v) => !v)}
            >
              <Sparkles size={13} /> {t('pruefen.count', { n: ungeprueft.length })}
            </button>
          )}
          <button
            className="pill pill--accent"
            disabled={!self?.permissions['idea.create']}
            onClick={() => setNeuOffen(true)}
          >
            <Plus size={13} /> {t('ideas.new')}
          </button>
        </>
      }
    >
      {pruefen ? (
        <PruefListe
          eintraege={ungeprueft.map((i) => ({
            id: i.id,
            titel: i.title,
            neben: i.tag || null,
          }))}
          onOeffnen={(id) => { setPruefen(false); setOffen(id); }}
          onPasst={(id) => ideeGeprueft(id)}
          onWeg={(id) => { if (confirm(t('ideas.deleteConfirm'))) deleteIdea(id); }}
        />
      ) : (
      <>
      <div className="idea-bar">
        <div className="idea-filter">
          {(['alle', ...IDEA_STATUSES] as const).map((s) => (
            <button
              key={s}
              className={clsx('idea-tab', filter === s && 'idea-tab--on')}
              onClick={() => setFilter(s)}
            >
              {s !== 'alle' && <span className="idea-dot" style={{ background: STATUS_FARBE[s] }} />}
              {s === 'alle' ? t('ideas.all') : t(`ideas.status.${s}` as never)}
              <span className="idea-tab__n">{zahlen[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <select
          className="select" style={{ width: 'auto' }}
          value={sortierung}
          onChange={(e) => setSortierung(e.target.value as 'stimmen' | 'neu')}
        >
          <option value="stimmen">{t('ideas.sortVotes')}</option>
          <option value="neu">{t('ideas.sortNew')}</option>
        </select>
      </div>

      {!liste.length ? (
        <div className="empty-state">
          <Lightbulb size={30} className="muted" />
          <p>{Object.keys(ideas).length ? t('ideas.noneHere') : t('ideas.empty')}</p>
        </div>
      ) : (
        <div className="idea-list">
          <AnimatePresence initial={false}>
            {liste.map((idee) => (
              <IdeaRow key={idee.id} idea={idee} onOpen={() => setOffen(idee.id)} />
            ))}
          </AnimatePresence>
        </div>
      )}
      </>
      )}

      <AnimatePresence>
        {neuOffen && <IdeaDialog key="neu" onClose={() => setNeuOffen(false)} />}
        {offen && ideas[offen] && (
          <IdeaDetail key={offen} idea={ideas[offen]} onClose={() => setOffen(null)} />
        )}
      </AnimatePresence>
    </Shell>
  );

  function IdeaRow({ idea, onOpen }: { idea: Idea; onOpen: () => void }) {
    const wer = users[idea.createdBy];
    return (
      <motion.div
        layout
        className="idea-row"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.17 }}
      >
        <VoteBox idea={idea} />

        <button className="idea-row__main" onClick={onOpen}>
          <span className="idea-row__title">{uebersetztesFeld(idea, 'title', idea.title)}</span>
          <span className="idea-row__meta">
            <span className="idea-status" style={{ color: STATUS_FARBE[idea.status] }}>
              <span className="idea-dot" style={{ background: STATUS_FARBE[idea.status] }} />
              {t(`ideas.status.${idea.status}` as never)}
            </span>
            {idea.tag && <span className="idea-tagmark">{idea.tag}</span>}
            {wer && <><Avatar user={wer} size={15} /> {wer.displayName}</>}
            · {relativeTime(idea.createdAt)}
            {idea.commentCount > 0 && (
              <> · <MessageSquare size={10} /> {idea.commentCount}</>
            )}
          </span>
        </button>
      </motion.div>
    );
  }

  function VoteBox({ idea }: { idea: Idea }) {
    const { voteIdea } = useStore.getState();
    const darf = Boolean(self?.permissions['idea.vote']);
    const saldo = idea.upvotes - idea.downvotes;

    return (
      <div className="idea-vote">
        <button
          className={clsx('idea-vote__btn', idea.myVote === 1 && 'idea-vote__btn--on')}
          disabled={!darf}
          title={t('ideas.voteUp')}
          aria-label={t('ideas.voteUp')}
          onClick={() => voteIdea(idea.id, 1)}
        >
          <ThumbsUp size={14} />
        </button>
        <motion.span
          key={saldo}
          className="idea-vote__zahl"
          initial={{ scale: 1.35 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 18 }}
          style={{ color: saldo > 0 ? 'var(--green)' : saldo < 0 ? 'var(--red)' : undefined }}
        >
          {saldo > 0 ? `+${saldo}` : saldo}
        </motion.span>
        <button
          className={clsx('idea-vote__btn', idea.myVote === -1 && 'idea-vote__btn--off')}
          disabled={!darf}
          title={t('ideas.voteDown')}
          aria-label={t('ideas.voteDown')}
          onClick={() => voteIdea(idea.id, -1)}
        >
          <ThumbsDown size={14} />
        </button>
      </div>
    );
  }
}

/* ── Neue Idee ──────────────────────────────────────────────── */

function IdeaDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const channels = useStore((s) => s.channels);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tag, setTag] = useState('');
  const [channelId, setChannelId] = useState('');

  const absenden = () => {
    if (title.trim().length < 3) return;
    useStore.getState().createIdea({
      title: title.trim(),
      body: body.trim() || null,
      tag: tag.trim(),
      channelId: channelId || null,
    });
    onClose();
  };

  return (
    <Shell title={t('ideas.new')} icon={<Lightbulb size={18} />} onClose={onClose} width={520}>
      <div className="field">
        <label className="field__label">{t('ideas.titleLabel')}</label>
        <input
          className="input" value={title} autoFocus placeholder={t('ideas.titlePlaceholder')}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') absenden(); }}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('ideas.bodyLabel')}</label>
        <textarea
          className="input" rows={4} value={body} placeholder={t('ideas.bodyPlaceholder')}
          onChange={(e) => setBody(e.target.value)}
        />
        <p className="field__hint">{t('ideas.bodyHint')}</p>
      </div>

      <div className="grid-2">
        <div className="field">
          <label className="field__label">{t('ideas.tag')}</label>
          <input className="input" value={tag} placeholder={t('ideas.tagPlaceholder')}
            onChange={(e) => setTag(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">{t('tasks.channel')}</label>
          <select className="select" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">—</option>
            {Object.values(channels).filter((c) => c.kind !== 'dm' && !c.archived).map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel__foot">
        <button className="btn btn--primary" disabled={title.trim().length < 3} onClick={absenden}>
          {t('ideas.post')}
        </button>
      </div>
    </Shell>
  );
}

/* ── Einzelansicht ──────────────────────────────────────────── */

function IdeaDetail({ idea, onClose }: { idea: Idea; onClose: () => void }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const self = useStore((s) => s.self);
  const kommentare = useStore((s) => s.ideaComments[idea.id]);
  const {
    loadIdeaComments, commentIdea, deleteIdeaComment, setIdeaStatus, deleteIdea,
  } = useStore.getState();
  const [text, setText] = useState('');

  useEffect(() => { loadIdeaComments(idea.id); }, [idea.id, loadIdeaComments]);

  const wer = users[idea.createdBy];
  const kanal = idea.channelId ? channels[idea.channelId] : null;
  const darfEntscheiden = Boolean(self?.permissions['idea.manage']);
  const darfLoeschen = idea.createdBy === self?.id || darfEntscheiden;

  return (
    <Shell
      title={uebersetztesFeld(idea, 'title', idea.title) ?? idea.title}
      subtitle={wer ? `${wer.displayName} · ${relativeTime(idea.createdAt)}` : undefined}
      icon={<Lightbulb size={18} />}
      onClose={onClose}
      width={620}
      actions={darfLoeschen ? (
        <button
          className="icon-btn icon-btn--danger"
          title={t('ideas.delete')}
          aria-label={t('ideas.delete')}
          onClick={() => {
            if (confirm(t('ideas.deleteConfirm'))) { deleteIdea(idea.id); onClose(); }
          }}
        >
          <Trash2 size={16} />
        </button>
      ) : undefined}
    >
      {idea.body && <p className="idea-body">{uebersetztesFeld(idea, 'body', idea.body)}</p>}

      <div className="idea-meta">
        <span className="idea-status" style={{ color: STATUS_FARBE[idea.status] }}>
          <span className="idea-dot" style={{ background: STATUS_FARBE[idea.status] }} />
          {t(`ideas.status.${idea.status}` as never)}
        </span>
        {idea.tag && <span className="idea-tagmark">{idea.tag}</span>}
        {kanal && <span className="idea-tagmark"><Hash size={10} />{kanal.name}</span>}
        <span className="idea-saldo">
          <ThumbsUp size={11} /> {idea.upvotes} · <ThumbsDown size={11} /> {idea.downvotes}
        </span>
      </div>

      {idea.decision && (
        <p className="idea-decision">
          <Check size={13} /> {uebersetztesFeld(idea, 'decision', idea.decision)}
          {idea.decidedBy && users[idea.decidedBy] && ` — ${users[idea.decidedBy].displayName}`}
        </p>
      )}

      {darfEntscheiden && (
        <div className="field">
          <label className="field__label">{t('ideas.setStatus')}</label>
          <div className="idea-filter">
            {IDEA_STATUSES.map((s) => (
              <button
                key={s}
                className={clsx('idea-tab', idea.status === s && 'idea-tab--on')}
                onClick={() => {
                  // Bei einer Entscheidung darf eine Begründung mit — sie ist
                  // für alle sichtbar und erspart Rückfragen.
                  const begruendung = (s === 'done' || s === 'rejected')
                    ? prompt(t('ideas.decisionPrompt')) ?? undefined
                    : undefined;
                  setIdeaStatus(idea.id, s, begruendung);
                }}
              >
                <span className="idea-dot" style={{ background: STATUS_FARBE[s] }} />
                {t(`ideas.status.${s}` as never)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label className="field__label">
          {t('ideas.comments')} {kommentare?.length ? `(${kommentare.length})` : ''}
        </label>
        <div className="idea-comments">
          {(kommentare ?? []).map((k) => {
            const autor = users[k.userId];
            const meiner = k.userId === self?.id;
            return (
              <div key={k.id} className="idea-comment">
                <Avatar user={autor} size={22} />
                <div className="idea-comment__main">
                  <span className="idea-comment__kopf">
                    <strong>{autor?.displayName ?? '—'}</strong>
                    <span className="muted">{relativeTime(k.createdAt)}</span>
                  </span>
                  <span className="idea-comment__text">{k.text}</span>
                </div>
                {(meiner || darfEntscheiden) && (
                  <button
                    className="icon-btn icon-btn--danger"
                    title={t('ideas.deleteComment')}
                    aria-label={t('ideas.deleteComment')}
                    onClick={() => deleteIdeaComment(idea.id, k.id)}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            );
          })}
          {!kommentare?.length && <p className="muted" style={{ fontSize: 12 }}>{t('ideas.noComments')}</p>}
        </div>
      </div>

      <div className="field" style={{ display: 'flex', gap: 8 }}>
        <input
          className="input" value={text} placeholder={t('ideas.commentPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) { commentIdea(idea.id, text.trim()); setText(''); }
          }}
        />
        <button
          className="btn btn--primary"
          disabled={!text.trim()}
          onClick={() => { commentIdea(idea.id, text.trim()); setText(''); }}
          aria-label={t('post.senden')}
        >
          <Send size={14} />
        </button>
      </div>
    </Shell>
  );
}
