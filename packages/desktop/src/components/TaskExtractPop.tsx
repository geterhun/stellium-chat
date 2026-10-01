import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { AlertCircle, Check, Inbox, ListChecks, Loader2 } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useVorschlaege } from '../state/vorschlaege.js';
import { useT } from '../i18n/index.js';
import { sichereRaender } from '../lib/klemmen.js';

const BREITE = 300;
const RAND = 10;

/**
 * Rückmeldung der Aufgabenerkennung, direkt unter ihrem Knopf.
 *
 * Früher öffnete sich hier ein Fenster mit Kästchen zum Ankreuzen. Die
 * Aufgaben entstehen jetzt von selbst; hier steht nur noch, was daraus
 * geworden ist — mit einem Weg zurück, falls es daneben lag.
 */
export function TaskExtractPop({ ankerRef, onClose }: {
  ankerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const laeuft = useStore((s) => s.extractingTasks);
  const ergebnis = useStore((s) => s.extractErgebnis);
  const fehler = useStore((s) => s.extractFehler);
  const ref = useRef<HTMLDivElement>(null);
  const [ort, setOrt] = useState<{ left: number; top: number } | null>(null);

  /* `onClose` kommt aus ChannelHeader.tsx als frische Closure bei JEDEM
     Rendern (dort rund um `extractOffen`/`clearExtractedTasks` gebaut,
     nirgends mit useCallback stabilisiert) — und ChannelHeader liest
     `useStore((s) => s.users)`, ein Objekt, das bei JEDER
     Anwesenheitsänderung irgendeines Teammitglieds komplett ersetzt wird,
     auch wenn niemand aus diesem Kanal betroffen ist. Stünde `onClose` unten
     direkt in der Abhängigkeitsliste des Auto-Schließen-Effekts, risse jede
     fremde Anwesenheitsänderung dessen 3,2-Sekunden-Timer neu an — in einem
     belebten Team blieb das leere Pop dann praktisch endlos stehen, statt
     nach gut drei Sekunden zu verschwinden. Die Ref hält immer die aktuellste
     Funktion, ohne dass ihr Identitätswechsel den Timer selbst neu startet. */
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  /* Am Kopfbereich hängt ein backdrop-filter — darin wäre selbst „fixed“
     relativ zum Kopf statt zum Fenster. Darum am <body>, von Hand platziert. */
  useLayoutEffect(() => {
    const anker = ankerRef.current?.getBoundingClientRect();
    if (!anker) return;
    /* Geräteränder mitrechnen — im Querformat säße das Pop sonst unter der
       Kamera-Aussparung. */
    const rand = sichereRaender();
    setOrt({
      left: Math.min(
        window.innerWidth - BREITE - RAND - rand.rechts,
        Math.max(RAND + rand.links, anker.right - BREITE),
      ),
      top: Math.min(window.innerHeight - 120 - rand.unten, anker.bottom + 8),
    });
  }, [ankerRef, laeuft, ergebnis, fehler]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onClick);
      clearTimeout(timer);
    };
  }, [onClose]);

  /* Wenn nichts gefunden wurde, muss man das nicht wegklicken. Ein Fehlschlag
     dagegen bleibt stehen: er will gelesen werden. */
  const leer = !laeuft && !fehler && ergebnis && !ergebnis.vorgeschlagen;
  useEffect(() => {
    if (!leer) return;
    // `onCloseRef.current()` statt `onClose` direkt und `onClose` bewusst
    // nicht in der Abhängigkeitsliste (siehe Ref-Kommentar weiter oben): die
    // 3,2 Sekunden zählen ab dem Moment, in dem der Leerzustand erscheint —
    // unabhängig davon, wie oft ChannelHeader in der Zwischenzeit aus
    // fachfremdem Grund neu rendert.
    const timer = window.setTimeout(() => onCloseRef.current(), 3200);
    return () => clearTimeout(timer);
  }, [leer]);

  const anzahl = ergebnis?.vorgeschlagen ?? 0;

  return createPortal(
    <motion.div
      ref={ref}
      className="extract-pop"
      initial={{ opacity: 0, scale: 0.96, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -6 }}
      transition={{ duration: 0.15 }}
      style={{ left: ort?.left ?? -9999, top: ort?.top ?? -9999, width: BREITE }}
    >
      {laeuft && (
        <div className="extract-pop__zeile" data-zustand="laeuft">
          <Loader2 size={15} className="spin" />
          <span>{t('ai.extractRunning')}</span>
        </div>
      )}

      {/* Scheitert die Erkennung, sagte bisher nichts etwas: die Kennung ging
          hinaus, aber niemand wartete auf sie, und der Kreisel blieb stehen. */}
      {!laeuft && fehler && (
        <div className="extract-pop__zeile" data-zustand="fehler" role="alert">
          <AlertCircle size={15} style={{ color: 'var(--rose)', flex: 'none' }} />
          <span>
            <strong>{t('ai.extractFailed')}</strong>
            <span className="muted" style={{ display: 'block', fontSize: 12 }}>{fehler}</span>
          </span>
        </div>
      )}

      {!laeuft && !fehler && ergebnis && (
        <>
          <div className="extract-pop__zeile extract-pop__kopf">
            {anzahl ? <Check size={15} className="ok" /> : <ListChecks size={15} className="muted" />}
            <strong>
              {anzahl
                ? t(anzahl === 1 ? 'ai.extractOneProposed' : 'ai.extractProposed', { n: anzahl })
                : t('ai.extractEmpty')}
            </strong>
          </div>

          {/* Keine Titelliste mehr. Sie zeigte, was gerade angelegt worden
              war — jetzt ist noch nichts angelegt, und die Titel stehen
              vollständig im Eingang, wo man sie auch ändern kann. */}

          {ergebnis.uebersprungen > 0 && (
            <p className="extract-pop__hinweis">{t('ai.extractSkipped', { n: ergebnis.uebersprungen })}</p>
          )}

          {/* Kein Rückgängig mehr: es ist nichts entstanden, was man
              zurücknehmen müsste. Das Ja steht noch aus, und es wird im
              Eingang gegeben. */}
          {anzahl > 0 && (
            <div className="extract-pop__fuss">
              <button
                className="btn btn--sm"
                onClick={() => { useVorschlaege.getState().oeffnen('aufgabe'); onClose(); }}
              >
                <Inbox size={13} /> {t('ai.extractOpenInbox')}
              </button>
            </div>
          )}
        </>
      )}
    </motion.div>,
    document.body,
  );
}
