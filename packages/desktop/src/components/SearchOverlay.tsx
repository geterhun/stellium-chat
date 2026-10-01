import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bookmark, Filter, Languages, Loader2, Lock, Search, X } from 'lucide-react';
import type { Message } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { useT } from '../i18n/index.js';
import { useReiterleiste } from '../lib/reiterleiste.js';
import { api } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { dayLabel, timeOfDay } from '../lib/format.js';
import { useKlartext } from './Vertraulich.jsx';
import { nachrichtEntschluesseln } from '../lib/vertraulich.js';

export function SearchOverlay({ onClose, initialTab }: {
  onClose: () => void;
  /** Auf welchem Reiter das Fenster aufgeht -- Rail.tsx „Gemerkte
      Nachrichten" öffnet gezielt 'saved', alle anderen Aufrufer weiterhin
      unverändert den Such-Reiter. */
  initialTab?: 'search' | 'saved';
}) {
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, onClose);
  const t = useT();
  const hits = useStore((s) => s.searchHits);
  const searching = useStore((s) => s.searching);
  const channels = useStore((s) => s.channels);
  const users = useStore((s) => s.users);
  const activeChannelId = useStore((s) => s.activeChannelId);

  const [query, setQuery] = useState('');
  const [scopeChannel, setScopeChannel] = useState(false);
  const [tab, setTab] = useState<'search' | 'saved'>(initialTab ?? 'search');
  /* Rollen, Mausrad und der gewaehlte Reiter kommt ins Bild —
     siehe lib/reiterleiste.ts. */
  const reiter = useRef<HTMLDivElement>(null);
  useReiterleiste(reiter, tab);
  const [saved, setSaved] = useState<Message[]>([]);
  const [lokal, setLokal] = useState<{ channelId: string; message: Message; text: string }[]>([]);
  const takt = useStore((s) => s.vertraulichTakt);

  /* Welche vertraulichen Kanäle diese Suche betrifft. Der Server liefert für
     sie nichts — er hat dort keinen lesbaren Text und keinen Volltextindex. */
  const vertraulicheKanaele = Object.values(channels).filter(
    (c) => c.vertraulich && !c.archived && (!scopeChannel || c.id === activeChannelId),
  );

  /**
   * Die Suche, die nur hier stattfindet.
   *
   * Sie durchsucht, was geladen ist, und nichts darüber hinaus — mehr geht
   * nicht: ältere Nachrichten liegen als Chiffrat auf dem Server und müssten
   * erst geholt und entschlüsselt werden. Das steht so im Hinweis darüber,
   * damit niemand ein vollständiges Ergebnis vermutet, wo keines sein kann.
   */
  useEffect(() => {
    if (tab !== 'search' || query.trim().length < 2 || !vertraulicheKanaele.length) {
      setLokal([]);
      return;
    }
    let gilt = true;
    const suchen = query.trim().toLowerCase();
    void (async () => {
      const treffer: { channelId: string; message: Message; text: string }[] = [];
      const alle = useStore.getState().messages;
      for (const kanal of vertraulicheKanaele) {
        for (const msg of alle[kanal.id] ?? []) {
          if (msg.deletedAt || msg.systemKind) continue;
          const klar = await nachrichtEntschluesseln(kanal.id, msg.text);
          if (klar && klar.toLowerCase().includes(suchen)) {
            treffer.push({ channelId: kanal.id, message: msg, text: klar });
          }
        }
      }
      if (gilt) setLokal(treffer.slice(-40).reverse());
    })();
    return () => { gilt = false; };
  }, [query, scopeChannel, activeChannelId, tab, takt, vertraulicheKanaele.length]);

  useEffect(() => {
    if (tab !== 'search') return;
    const timer = window.setTimeout(() => {
      void useStore.getState().runSearch(query, scopeChannel ? activeChannelId : null);
    }, 240);
    return () => clearTimeout(timer);
  }, [query, scopeChannel, activeChannelId, tab]);

  useEffect(() => {
    if (tab !== 'saved') return;
    api.saved().then((r) => setSaved(r.messages)).catch(() => setSaved([]));
  }, [tab]);

  const jumpTo = (channelId: string) => {
    useStore.getState().openChannel(channelId);
    onClose();
  };

  return (
    <div className="scrim" onClick={onClose}>
      <motion.div
        ref={kasten}
        role="dialog"
        aria-modal="true"
        aria-label={t('search.placeholder')}
        className="panel panel--wide"
        initial={{ opacity: 0, y: -14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -14, scale: 0.98 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tabs" ref={reiter}>
          <button className="tab" aria-selected={tab === 'search'} onClick={() => setTab('search')}>{t('nav.search')}</button>
          <button className="tab" aria-selected={tab === 'saved'} onClick={() => setTab('saved')}>{t('common.saved')}</button>
          <button className="icon-btn" style={{ marginLeft: 'auto', alignSelf: 'center' }} onClick={onClose} aria-label={t('common.close')}><X size={16} /></button>
        </div>

        {tab === 'search' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 var(--sp-5)' }}>
              <Search size={17} className="muted" />
              <input
                className="omni-input"
                style={{ padding: 'var(--sp-4) 0' }}
                placeholder={t('search.placeholder')}
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              />
              {searching && <Loader2 size={16} className="spin muted" />}
            </div>

            <div style={{ display: 'flex', gap: 8, padding: '0 var(--sp-5) var(--sp-3)' }}>
              <button
                className="pill"
                aria-pressed={scopeChannel}
                onClick={() => setScopeChannel((v) => !v)}
              >
                <Filter size={12} />
                {scopeChannel ? t('search.onlyChannel', { kanal: channels[activeChannelId ?? '']?.name ?? t('search.currentChannel') }) : t('search.allChannels')}
              </button>
              <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
                {query.length >= 2 && t('search.hits', { n: hits.length })}
              </span>
            </div>

            <div className="panel__body" style={{ paddingTop: 0 }}>
              {vertraulicheKanaele.length > 0 && (
                <div className="hinweis" style={{ alignItems: 'flex-start' }}>
                  <Lock size={14} style={{ flex: 'none', marginTop: 2 }} />
                  <div>{t('vertraulich.nurLokaleSuche')}</div>
                </div>
              )}

              {lokal.map(({ channelId, message, text }) => {
                const author = users[message.userId];
                const channel = channels[channelId];
                return (
                  <button key={message.id} className="result" onClick={() => jumpTo(channelId)}>
                    <Avatar user={author} size={30} />
                    <div className="result__main">
                      <div className="result__title">
                        {author?.displayName}
                        <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                          {channel?.kind === 'dm' ? '' : `#${channel?.name}`} · {dayLabel(message.createdAt)} {timeOfDay(message.createdAt)}
                        </span>
                        <span className="msg__tag" style={{ marginLeft: 8, color: 'var(--violet-soft)' }}>
                          <Lock size={9} style={{ verticalAlign: -1 }} /> {t('vertraulich.abzeichen')}
                        </span>
                      </div>
                      <div className="result__sub" style={{ whiteSpace: 'normal' }}>{text.slice(0, 220)}</div>
                    </div>
                  </button>
                );
              })}

              {query.length < 2 && (
                <p className="muted" style={{ fontSize: 13.5 }}>
                  {t('search.minChars')}
                </p>
              )}
              {hits.map((hit) => {
                const author = users[hit.message.userId];
                const channel = channels[hit.channelId];
                return (
                  <button key={hit.message.id} className="result" onClick={() => jumpTo(hit.channelId)}>
                    <Avatar user={author} size={30} />
                    <div className="result__main">
                      <div className="result__title">
                        {author?.displayName ?? t('common.unknown')}
                        <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                          {channel?.kind === 'dm' ? t('chat.dmShort') : `#${channel?.name}`} · {dayLabel(hit.message.createdAt)} {timeOfDay(hit.message.createdAt)}
                        </span>
                        {hit.matchedTranslation && (
                          <span className="msg__tag" style={{ marginLeft: 8 }}>
                            <Languages size={9} style={{ verticalAlign: -1 }} /> {t('common.translation')}
                          </span>
                        )}
                      </div>
                      <div
                        className="result__sub"
                        style={{ whiteSpace: 'normal' }}
                        dangerouslySetInnerHTML={{ __html: sanitizeSnippet(hit.snippet) }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {tab === 'saved' && (
          <div className="panel__body">
            {saved.length === 0 && (
              <p className="muted" style={{ fontSize: 13.5 }}>
                <Bookmark size={14} style={{ verticalAlign: -2 }} /> {t('search.nothingSaved')}
              </p>
            )}
            {saved.map((msg) => {
              const author = users[msg.userId];
              const channel = channels[msg.channelId];
              return (
                <button key={msg.id} className="result" onClick={() => jumpTo(msg.channelId)}>
                  <Avatar user={author} size={30} />
                  <div className="result__main">
                    <div className="result__title">
                      {author?.displayName}
                      <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                        {channel?.kind === 'dm' ? t('chat.dmShort') : `#${channel?.name}`}
                      </span>
                    </div>
                    <GemerkterText message={msg} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </motion.div>
    </div>
  );
}

/** Eine gemerkte Nachricht kann aus einem vertraulichen Kanal stammen. */
function GemerkterText({ message }: { message: Message }) {
  const t = useT();
  const { text, unlesbar } = useKlartext(message.channelId, message.text);
  return (
    <div className="result__sub" style={{ whiteSpace: 'normal' }}>
      {unlesbar ? t('vertraulich.nichtLesbar') : text.slice(0, 220)}
    </div>
  );
}

/**
 * Der Server liefert Snippets mit <em>-Markierungen. Alles andere wird
 * escaped, damit fremder Nachrichtentext niemals als Markup landet.
 */
function sanitizeSnippet(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/&lt;em&gt;/g, '<em>').replace(/&lt;\/em&gt;/g, '</em>');
}
