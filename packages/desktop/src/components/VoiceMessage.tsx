import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Languages, Loader2, Pause, Play, RefreshCw, Sparkles } from 'lucide-react';
import type { VoiceNote } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT, spracheName } from '../i18n/index.js';
import { fileUrl } from '../net/api.js';

interface Props {
  voice: VoiceNote;
  messageId: string;
  /** Übersetzung des Transkripts, falls die Sprache abweicht. */
  translatedText?: string | null;
  showOriginal?: boolean;
}

/** Feste Balkenhöhen — eine echte Wellenform bräuchte die Audiodaten. */
const BARS = [0.3, 0.55, 0.4, 0.8, 0.65, 1, 0.75, 0.45, 0.9, 0.6, 0.35, 0.7,
              0.5, 0.85, 0.55, 0.4, 0.75, 0.6, 0.3, 0.65, 0.45, 0.8, 0.5, 0.35];

export function VoiceMessage({ voice, messageId, translatedText, showOriginal }: Props) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(voice.durationMs ? voice.durationMs / 1000 : 0);
  const ai = useStore((s) => s.ai);

  /* Aufnahmen aus MediaRecorder (webm) tragen keine Länge im Kopf — Chromium
     meldet `duration` dann als Infinity. Ohne Rückfall auf die beim Aufnehmen
     gemessene Länge blieb der Fortschritt bei null stehen, und Spulen ging
     gar nicht. */
  const laenge = (audio: HTMLAudioElement) =>
    (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (voice.durationMs ?? 0) / 1000);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      const d = laenge(audio);
      setProgress(d ? Math.min(1, audio.currentTime / d) : 0);
    };
    const onMeta = () => { if (Number.isFinite(audio.duration)) setDuration(audio.duration); };
    const onEnd = () => { setPlaying(false); setProgress(0); };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('ended', onEnd);
    };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else {
      setPlaying(true);
      // Scheitert das Abspielen (Datei fehlt, Format unbekannt), stünde der
      // Knopf sonst für immer auf „Pause".
      audio.play().catch(() => setPlaying(false));
    }
  };

  const seek = (fraction: number) => {
    const audio = audioRef.current;
    const d = audio ? laenge(audio) : 0;
    if (!audio || !d) return;
    audio.currentTime = d * fraction;
    setProgress(fraction);
  };

  const text = showOriginal ? voice.transcript : (translatedText ?? voice.transcript);
  const translated = Boolean(translatedText) && !showOriginal;

  return (
    <div className="voice">
      <audio ref={audioRef} src={fileUrl(voice.url)} preload="metadata" />

      <div className="voice__player">
        <button className="voice__play" onClick={toggle} title={playing ? t('voice.pause') : t('voice.play')} aria-label={playing ? t('voice.pause') : t('voice.play')}>
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>

        <div
          className="voice__wave"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek((e.clientX - rect.left) / rect.width);
          }}
        >
          {BARS.map((height, i) => {
            const passed = i / BARS.length <= progress;
            return (
              <motion.span
                key={i}
                className={`voice__bar${passed ? ' voice__bar--on' : ''}`}
                animate={playing && passed
                  ? { scaleY: [height, Math.min(1, height * 1.35), height] }
                  : { scaleY: height }}
                transition={playing
                  ? { duration: 0.75, repeat: Infinity, delay: i * 0.035, ease: 'easeInOut' }
                  : { duration: 0.2 }}
              />
            );
          })}
        </div>

        <span className="voice__time">{formatDuration(duration * (1 - progress))}</span>
      </div>

      <AnimatePresence mode="wait">
        {text ? (
          <motion.div
            key="text"
            className="voice__transcript"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="voice__transcript-head">
              {translated ? <Languages size={10} /> : <Sparkles size={10} />}
              {/* spracheName() statt languageInfo(...).native: der Eigenname
                  einer Sprache gehört in eine Auswahlliste, nicht in einen
                  übersetzten Satz — sonst las man in englischer Oberfläche
                  wörtlich "translated from Deutsch" statt "from German". */}
              {/* '—' bei fehlender Sprachkennung: derselbe Rückfall, den
                  languageInfo(null).native vorher lieferte — nur der Weg
                  zum Namen selbst hat sich geändert, nicht der Rückfall. */}
              {translated
                ? t('voice.transcriptTranslated', { language: voice.transcriptLang ? spracheName(voice.transcriptLang) : '—' })
                : t('voice.transcript', { language: voice.transcriptLang ? spracheName(voice.transcriptLang) : '—' })}
            </div>
            {text}
          </motion.div>
        ) : ai?.transcription ? (
          <motion.div key="wait" className="voice__pending" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Loader2 size={11} className="spin" />
            {t('voice.transcribing')}
          </motion.div>
        ) : (
          <motion.button
            key="none"
            className="voice__pending"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            onClick={() => useStore.getState().retranscribe(messageId)}
            title={t('voice.retry')}
          >
            <RefreshCw size={11} />
            {t('voice.noTranscript')}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
