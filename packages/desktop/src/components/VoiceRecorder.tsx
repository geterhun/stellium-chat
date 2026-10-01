import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Mic, Send, Square, Trash2 } from 'lucide-react';
import { useStore } from '../state/store.js';
import { t } from '../i18n/index.js';
import { api } from '../net/api.js';

interface Props {
  channelId: string;
  parentId?: string | null;
  onDone: () => void;
}

/**
 * Nimmt über das Mikrofon auf und lädt die Datei hoch. Die Transkription
 * macht danach der Server mit Groqs Whisper — hier geht es nur um die Aufnahme.
 */
export function VoiceRecorder({ channelId, parentId, onDone }: Props) {
  const [state, setState] = useState<'anfrage' | 'laeuft' | 'fertig' | 'sendet'>('anfrage');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /* Der Klangzusammenhang für die Pegelanzeige.
     Er MUSS hier stehen und nicht nur als lokale Variable im Effekt: ein
     AudioContext hält eine Ressource des Betriebssystems, und Chromium lässt
     je Seite nur sechs davon zu. Ohne das Schließen war nach der sechsten
     Aufnahme Schluss — `new AudioContext()` wirft dann, der Wurf landete im
     catch daneben, und auf dem Schirm stand „Aufnahme nicht möglich", ohne
     dass am Mikrofon irgendetwas gewesen wäre. Nach einem Neuladen der Seite
     ging es wieder; genau daran ist so etwas nicht zu erkennen. */
  const klangRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const startedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;

        // Pegelanzeige, damit man sieht, dass wirklich aufgenommen wird.
        const ctx = new AudioContext();
        klangRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(buffer);
          let sum = 0;
          for (const v of buffer) sum += (v - 128) ** 2;
          setLevel(Math.min(1, Math.sqrt(sum / buffer.length) / 40));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();

        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
          .find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
        recorder.onstop = () => {
          blobRef.current = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
          setState('fertig');
        };
        recorder.start(250);
        startedAt.current = Date.now();
        setState('laeuft');
      } catch (err) {
        setError((err as Error).name === 'NotAllowedError'
          ? t('voice.noMic')
          /* Kein eigener Wörterbuch-Eintrag „Aufnahme nicht möglich" bisher —
             bis dahin der allgemeine „Nicht möglich" statt fest deutschen
             Texts in jeder der 22 Sprachen. */
          : `${t('team.notPossible')}: ${(err as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      /* Erst die Aufnahme beenden, dann das Mikrofon, dann den Klang. Ein
         MediaRecorder, den niemand anhält, bleibt im Zustand „recording"
         stehen und hält den Datenstrom fest. */
      try { if (recorderRef.current?.state === 'recording') recorderRef.current.stop(); } catch { /* schon aus */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void klangRef.current?.close().catch(() => {});
      klangRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (state !== 'laeuft') return;
    const timer = window.setInterval(() => setSeconds((Date.now() - startedAt.current) / 1000), 100);
    return () => clearInterval(timer);
  }, [state]);

  const stop = () => {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    cancelAnimationFrame(rafRef.current);
    // Der Pegel wird ab hier nicht mehr gebraucht; die Ressource auch nicht.
    void klangRef.current?.close().catch(() => {});
    klangRef.current = null;
  };

  const send = async () => {
    const blob = blobRef.current;
    if (!blob) return;
    setState('sendet');
    try {
      const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
      const file = new File([blob], `sprachnachricht.${extension}`, { type: blob.type });
      const { attachment } = await api.upload(file);
      useStore.getState().sendVoice({
        channelId, attachmentId: attachment.id,
        durationMs: Math.round(seconds * 1000), parentId,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setState('fertig');
    }
  };

  if (error) {
    return (
      <div className="recorder recorder--error">
        <span>{error}</span>
        <button className="icon-btn icon-btn--sm" onClick={onDone} aria-label={t('voice.discard')}><Trash2 size={14} /></button>
      </div>
    );
  }

  return (
    <div className="recorder">
      <motion.span
        className="recorder__dot"
        animate={state === 'laeuft' ? { scale: [1, 1.35, 1], opacity: [1, 0.6, 1] } : { scale: 1 }}
        transition={{ duration: 1.1, repeat: state === 'laeuft' ? Infinity : 0 }}
      />
      <span className="recorder__time">{formatSeconds(seconds)}</span>

      <div className="recorder__meter">
        {Array.from({ length: 28 }, (_, i) => (
          <span
            key={i}
            className="recorder__meter-bar"
            style={{
              transform: `scaleY(${state === 'laeuft'
                ? Math.max(0.12, Math.min(1, level * (0.55 + Math.sin(i * 0.9 + seconds * 6) * 0.45) * 2.2))
                : 0.12})`,
            }}
          />
        ))}
      </div>

      <span className="spacer" />

      {state === 'laeuft' && (
        <button className="btn btn--ghost" onClick={stop} title={t('voice.stopRecording')}>
          <Square size={14} fill="currentColor" /> {t('voice.stop')}
        </button>
      )}
      {state === 'fertig' && (
        <>
          <button className="icon-btn" onClick={onDone} title={t('voice.discard')} aria-label={t('voice.discard')}><Trash2 size={16} /></button>
          <button className="send-btn" onClick={() => void send()} title={t('voice.send')} aria-label={t('voice.send')}>
            <Send size={16} />
          </button>
        </>
      )}
      {state === 'sendet' && <span className="muted" style={{ fontSize: 12.5 }}>{t('voice.sending')}</span>}
      {state === 'anfrage' && <span className="muted" style={{ fontSize: 12.5 }}>{t('voice.asking')}</span>}
    </div>
  );
}

function formatSeconds(seconds: number): string {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export { Mic };
