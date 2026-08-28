import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CalendarDays, Check, ChevronLeft, ChevronRight, Clock, HelpCircle, MapPin,
  Plus, Sparkles, Trash2, X,
} from 'lucide-react';
import { EVENT_KINDS, uebersetztesFeld, type CalendarEvent, type EventKind } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { currentUiLanguage, useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { PruefListe } from './PruefListe.jsx';
import { clsx, localTimeFor } from '../lib/format.js';

/* TypeScript kennt Intl.Locale.weekInfo noch nicht (Stand TS 5.9), obwohl
   Electron/Chromium es längst liefert — kurze Ergänzung des Typs statt eines
   pauschalen `any` an der Aufrufstelle. */
declare global {
  namespace Intl {
    interface Locale {
      weekInfo?: { firstDay: number; weekend: number[]; minimalDays: number };
    }
  }
}

const ART_FARBE: Record<EventKind, string> = {
  meeting: 'var(--violet)',
  deadline: 'var(--red)',
  absence: 'var(--amber)',
  holiday: 'var(--green)',
  reminder: 'var(--blue)',
};

const TAG = 86_400_000;

/**
 * Erster Wochentag als ISO-Zahl (1 = Montag … 7 = Sonntag) — nicht überall
 * derselbe: en-US, ja, ko, hi und pt-BR fangen die Woche sonntags an, ar
 * samstags. Ohne diese Abfrage saß „heute" für die halbe Welt in der
 * falschen Spalte.
 */
function ersterWochentag(sprache: string): number {
  try {
    return new Intl.Locale(sprache).weekInfo?.firstDay ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Die eingestellte Zeitzone — oder die leere Zeichenkette, wenn keine gültige
 * hinterlegt ist.
 *
 * Dieselbe Vorsicht wie in lib/format.ts, und aus demselben Grund: `timeZone:
 * undefined` wirft NICHT, sondern gilt Intl als „nicht angegeben" und wird
 * still durch die Zeitzone DIESES Rechners ersetzt. Ein leerer Name wirft
 * dagegen. Beides zusammen hieße, dass das sichtbare Verhalten davon abhinge,
 * ob `self.timezone` bei einem unfertigen Konto '' oder undefined ist.
 * Deshalb wird EINMAL geprüft und danach nur noch ein geprüfter Wert — oder
 * gar keiner — weitergereicht.
 */
function gueltigeZone(zone: string | null | undefined): string {
  if (!zone) return '';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return '';   // Tippfehler oder altes Kürzel: lieber der Rechner als ein Absturz
  }
}

/** Zusatz für Intl-Aufrufe: die Zeitzone nur setzen, wenn eine gültige da ist
 *  — nie `timeZone: undefined` (siehe oben). */
function zonenTeil(zone: string): { timeZone?: string } {
  return zone ? { timeZone: zone } : {};
}

/** Wie weit die Zone der UTC voraus ist, in Millisekunden. */
function zonenVersatz(ms: number, zone: string): number {
  const teile = new Intl.DateTimeFormat('en-CA', {
    ...zonenTeil(zone), hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ms);
  const p: Record<string, string> = {};
  for (const teil of teile) p[teil.type] = teil.value;
  const alsWaereEsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return alsWaereEsUtc - Math.floor(ms / 1000) * 1000;
}

/** Bürgerliches Datum einer Zeitmarke, gesehen aus einer Zone. */
function zivilTeile(ms: number, zone: string): { j: number; m: number; t: number } {
  const [j, m, t] = new Intl.DateTimeFormat('en-CA', {
    ...zonenTeil(zone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ms).split('-').map(Number);
  return { j, m, t };
}

/**
 * 00:00 desselben Kalendertags, gesehen aus `zone`.
 *
 * Zwei Durchgänge, weil der Versatz selbst vom Ergebnis abhängt: in der Nacht
 * einer Zeitumstellung ist der Versatz um Mitternacht ein anderer als um die
 * Uhrzeit, von der aus gerechnet wird. Ein zweiter Durchgang mit dem Versatz
 * AM ERGEBNIS trifft jede real vorkommende Zone.
 */
function tagesBeginn(ms: number, zone: string): number {
  const { j, m, t } = zivilTeile(ms, zone);
  const zivilAlsUtc = Date.UTC(j, m - 1, t);
  const ersteSchaetzung = zivilAlsUtc - zonenVersatz(ms, zone);
  return zivilAlsUtc - zonenVersatz(ersteSchaetzung, zone);
}

/**
 * Denselben Tag um `n` weiterschalten — über die MITTAGSZEIT, nicht durch
 * blosses Addieren von 24 Stunden.
 *
 * Ein Kalendertag ist an einer Zeitumstellung 23 oder 25 Stunden lang; wer
 * stur `+ 86_400_000` rechnet, landet dann um 23:00 des Vortags bzw. um 01:00
 * und verliert oder verdoppelt einen Tag in der Wochenansicht. Der Umweg über
 * die Tagesmitte liegt immer sicher im Zieltag, egal wie lang er ist.
 */
function tagPlus(tagBeginn: number, n: number, zone: string): number {
  return tagesBeginn(tagBeginn + n * TAG + 12 * 3_600_000, zone);
}

/** 00:00 des ersten Wochentags der Sprache, in der Woche, in der das Datum liegt. */
function wochenStart(ms: number, sprache: string, zone: string): number {
  const { j, m, t } = zivilTeile(ms, zone);
  // getUTCDay() auf dem bürgerlichen Datum: 0 = So … 6 = Sa. Auf dieselbe
  // 1..7-Zählung (Mo=1…So=7) heben, dann den Abstand zum gewünschten
  // Wochenanfang bilden.
  const isoTag = new Date(Date.UTC(j, m - 1, t)).getUTCDay() || 7;
  const versatz = (isoTag - ersterWochentag(sprache) + 7) % 7;
  return tagPlus(tagesBeginn(ms, zone), -versatz, zone);
}

function uhrzeit(ms: number, sprache: string, zone: string): string {
  return new Date(ms).toLocaleTimeString(sprache, {
    hour: '2-digit', minute: '2-digit', ...zonenTeil(zone),
  });
}

export function CalendarPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const events = useStore((s) => s.events);
  const { loadEvents, terminGeprueft, deleteEvent } = useStore.getState();

  /* Die Zeitzone der Person, nicht die des Rechners: ein Termin um 14:00 ist
     eine Aussage über einen Zeitpunkt, nicht über die Uhr, die gerade
     danebensteht. Wer in Berlin sitzt und Tokio eingestellt hat, soll seine
     Termine in Tokioter Zeit sehen — sonst steht die Wochenansicht in einer
     dritten, gar nicht gewählten Zeit. */
  const zone = gueltigeZone(useStore((s) => s.self?.timezone));

  const [anker, setAnker] = useState(() => wochenStart(Date.now(), currentUiLanguage(), zone));
  const [neuOffen, setNeuOffen] = useState<number | null>(null);
  const [offenerTermin, setOffenerTermin] = useState<string | null>(null);
  /** Der Reiter „Prüfen": nur, was die KI selbst eingetragen hat. */
  const [pruefen, setPruefen] = useState(false);

  /* Acht Grenzen für sieben Tage: die achte ist das Ende des letzten Tages.
     Anders als „Beginn + 24 h" hält das auch an einer Zeitumstellung, wo ein
     Tag 23 oder 25 Stunden hat. */
  const grenzen = useMemo(() => {
    const liste = [anker];
    for (let i = 1; i < 8; i++) liste.push(tagPlus(liste[i - 1], 1, zone));
    return liste;
  }, [anker, zone]);
  const tage = useMemo(() => grenzen.slice(0, 7), [grenzen]);
  const bis = grenzen[7];
  useEffect(() => { loadEvents(anker, bis); }, [anker, bis, loadEvents]);

  const proTag = useMemo(() => {
    const karte = new Map<number, CalendarEvent[]>();
    for (const tag of tage) karte.set(tag, []);
    for (const e of Object.values(events)) {
      for (let i = 0; i < tage.length; i++) {
        // Ein Termin erscheint an jedem Tag, den er berührt.
        if (e.startsAt < grenzen[i + 1] && e.endsAt > tage[i]) karte.get(tage[i])!.push(e);
      }
    }
    for (const liste of karte.values()) liste.sort((a, b) => a.startsAt - b.startsAt);
    return karte;
  }, [events, tage, grenzen]);

  const heute = tagesBeginn(Date.now(), zone);
  // uiLanguage, nicht self.language: Letzteres ist die Lesesprache der
  // Nachrichten, nicht die der Oberfläche — hier geht es um Wochentage,
  // Uhrzeiten und Zeiträume, also um Bedienelemente.
  const sprache = currentUiLanguage();

  const ungeprueft = useMemo(
    () => Object.values(events).filter((e) => e.vonKi && !e.geprueft),
    [events],
  );
  /* Leerer Reiter führt ins Nichts — dann zurück auf die Woche. */
  useEffect(() => {
    if (pruefen && !ungeprueft.length) setPruefen(false);
  }, [pruefen, ungeprueft.length]);

  return (
    <Shell
      title={t('calendar.title')}
      subtitle={t('calendar.subtitle')}
      icon={<CalendarDays size={18} />}
      onClose={onClose}
      width={1100}
      actions={
        <>
          <button className="icon-btn" onClick={() => setAnker((a) => tagPlus(a, -7, zone))} aria-label={t('calendar.vorherigeWoche')}><ChevronLeft size={16} /></button>
          <button className="pill" onClick={() => setAnker(wochenStart(Date.now(), currentUiLanguage(), zone))}>{t('calendar.today')}</button>
          <button className="icon-btn" onClick={() => setAnker((a) => tagPlus(a, 7, zone))} aria-label={t('calendar.naechsteWoche')}><ChevronRight size={16} /></button>
          {ungeprueft.length > 0 && (
            <button
              className={clsx('pill', pruefen ? 'pill--accent' : 'pill--warn')}
              onClick={() => setPruefen((v) => !v)}
            >
              <Sparkles size={13} /> {t('pruefen.count', { n: ungeprueft.length })}
            </button>
          )}
          <button className="pill pill--accent" onClick={() => setNeuOffen(Date.now())}>
            <Plus size={13} /> {t('calendar.new')}
          </button>
        </>
      }
    >
      {pruefen ? (
        <PruefListe
          eintraege={ungeprueft.map((e) => ({
            id: e.id,
            titel: e.title,
            neben: new Date(e.startsAt).toLocaleString(sprache, {
              weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
              ...zonenTeil(zone),
            }),
          }))}
          onOeffnen={(id) => { setPruefen(false); setOffenerTermin(id); }}
          onPasst={(id) => terminGeprueft(id)}
          onWeg={(id) => { if (confirm(t('calendar.deleteConfirm'))) deleteEvent(id); }}
        />
      ) : (
      <div className="week">
        {tage.map((tag) => {
          const liste = proTag.get(tag) ?? [];
          const d = new Date(tag);
          return (
            <div key={tag} className={clsx('week__day', tag === heute && 'week__day--today')}>
              <header className="week__head" onDoubleClick={() => setNeuOffen(tag + 9 * 3_600_000)}>
                <span className="week__dow">{d.toLocaleDateString(sprache, { weekday: 'short', ...zonenTeil(zone) })}</span>
                <span className="week__num">{zivilTeile(tag, zone).t}</span>
              </header>

              <div className="week__list">
                <AnimatePresence initial={false}>
                  {liste.map((e) => (
                    <motion.button
                      key={e.id}
                      layout
                      className="week__ev"
                      style={{ borderLeftColor: ART_FARBE[e.kind] }}
                      onClick={() => setOffenerTermin(e.id)}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      <span className="week__ev-time">
                        {e.allDay ? t('calendar.allDay') : uhrzeit(e.startsAt, sprache, zone)}
                      </span>
                      <span className="week__ev-title">{uebersetztesFeld(e, 'title', e.title)}</span>
                    </motion.button>
                  ))}
                </AnimatePresence>
                {!liste.length && <span className="week__empty">·</span>}
              </div>

              <button className="week__add" onClick={() => setNeuOffen(tag + 9 * 3_600_000)} title={t('calendar.new')} aria-label={t('calendar.new')}>
                <Plus size={13} />
              </button>
            </div>
          );
        })}
      </div>
      )}

      <AnimatePresence>
        {neuOffen !== null && <EventDialog key="neu" start={neuOffen} onClose={() => setNeuOffen(null)} />}
        {offenerTermin && events[offenerTermin] && (
          <EventDetail key={offenerTermin} event={events[offenerTermin]} onClose={() => setOffenerTermin(null)} />
        )}
      </AnimatePresence>
    </Shell>
  );
}

/**
 * Wert für <input type="datetime-local"> — in der eingestellten Zeitzone.
 *
 * Das Feld kennt keine Zeitzone, es zeigt und liefert nur bürgerliche Zeit
 * („2026-08-22T14:00"). Welche Zeitzone damit gemeint ist, muss deshalb hier
 * entschieden werden — und das ist dieselbe, in der die Wochenansicht steht.
 * Vorher stand hier der Versatz des RECHNERS: wer Tokio eingestellt hatte,
 * sah seine Termine in Tokioter Zeit, trug sie aber in Berliner Zeit ein.
 */
function feldWert(ms: number, zone: string): string {
  const teile = new Intl.DateTimeFormat('en-CA', {
    ...zonenTeil(zone), hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(ms);
  const p: Record<string, string> = {};
  for (const teil of teile) p[teil.type] = teil.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * Die Gegenrichtung: bürgerliche Zeit aus dem Feld zurück in einen Zeitpunkt.
 *
 * Zwei Durchgänge aus demselben Grund wie bei tagesBeginn() — der Versatz
 * hängt vom Ergebnis ab. Weichen die beiden Durchgänge voneinander ab, liegt
 * die eingetippte Uhrzeit auf einer Zeitumstellung, und dann gibt es sie
 * entweder ZWEIMAL (Rückstellung: „02:30" kommt in derselben Nacht zweimal
 * vor) oder GAR NICHT (Vorstellung: „02:30" wird übersprungen). Ein
 * datetime-local-Feld kann diesen Unterschied nicht ausdrücken — es liefert
 * nur die nackte bürgerliche Zeit —, also muss hier entschieden werden. Die
 * Wahl folgt der üblichen Auflösung (java.time, Temporal „compatible"):
 * zweideutig → die FRÜHERE der beiden Möglichkeiten, Lücke → der Zeitpunkt
 * dahinter. Die vorige Fassung nahm über getTimezoneOffset() dieselbe
 * Zweideutigkeit blind in Kauf; neu ist nur, dass sie hier benannt ist.
 */
function ausFeldWert(text: string, zone: string): number {
  const [datum, uhr] = text.split('T');
  const [j, m, t] = (datum ?? '').split('-').map(Number);
  const [h, min] = (uhr ?? '').split(':').map(Number);
  if (![j, m, t, h, min].every(Number.isFinite)) return new Date(text).getTime();
  if (!zone) return new Date(text).getTime();
  const zivilAlsUtc = Date.UTC(j, m - 1, t, h, min);
  /* Beide an diesem Tag möglichen Versätze durchprobieren — den von zwölf
     Stunden davor und den von zwölf Stunden danach. Zweimal hintereinander
     denselben Versatz nachzuziehen genügt hier NICHT: an einer Rückstellung
     laufen beide Durchgänge auf dieselbe (spätere) Lösung zu, und die frühere
     der beiden gleich aussehenden Uhrzeiten käme nie zum Vorschein. */
  const kandidaten = [
    zivilAlsUtc - zonenVersatz(zivilAlsUtc - 12 * 3_600_000, zone),
    zivilAlsUtc - zonenVersatz(zivilAlsUtc + 12 * 3_600_000, zone),
  ];
  const passt = kandidaten.filter((ms) => feldWert(ms, zone) === text);
  return passt.length ? Math.min(...passt) : Math.max(...kandidaten);
}

function EventDialog({ start, onClose }: { start: number; onClose: () => void }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const self = useStore((s) => s.self);

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<EventKind>('meeting');
  const zone = gueltigeZone(self?.timezone);
  const [startsAt, setStartsAt] = useState(() => feldWert(start, zone));
  const [endsAt, setEndsAt] = useState(() => feldWert(start + 3_600_000, zone));
  const [allDay, setAllDay] = useState(false);
  const [location, setLocation] = useState('');
  const [channelId, setChannelId] = useState('');
  const [teilnehmer, setTeilnehmer] = useState<Set<string>>(new Set());

  const absenden = () => {
    if (!title.trim()) return;
    useStore.getState().createEvent({
      title: title.trim(),
      kind,
      startsAt: ausFeldWert(startsAt, zone),
      endsAt: ausFeldWert(endsAt, zone),
      allDay,
      location: location.trim() || null,
      channelId: channelId || null,
      attendeeIds: [...teilnehmer],
    });
    onClose();
  };

  return (
    <Shell title={t('calendar.new')} icon={<Plus size={18} />} onClose={onClose} width={540}>
      <div className="field">
        <label className="field__label">{t('calendar.eventTitle')}</label>
        <input
          className="input" value={title} autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') absenden(); }}
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label className="field__label">{t('calendar.starts')}</label>
          <input className="input" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">{t('calendar.ends')}</label>
          <input className="input" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">{t('calendar.kindLabel')}</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
            {EVENT_KINDS.map((k) => <option key={k} value={k}>{t(`calendar.kind.${k}` as never)}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="field__label">{t('calendar.location')}</label>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
      </div>

      <label className="switch">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        <span>{t('calendar.allDay')}</span>
      </label>

      <div className="field">
        <label className="field__label">{t('tasks.channel')}</label>
        <select className="select" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          <option value="">—</option>
          {Object.values(channels).filter((c) => c.kind !== 'dm' && !c.archived).map((c) => (
            <option key={c.id} value={c.id}>#{c.name}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label">{t('calendar.attendees')}</label>
        <div className="chip-grid">
          {Object.values(users).filter((u) => !u.disabled && u.role !== 'bot' && !u.technisch && u.id !== self?.id).map((u) => {
            const drin = teilnehmer.has(u.id);
            const zeit = localTimeFor(u.timezone);
            return (
              <button
                key={u.id}
                className={clsx('chip', drin && 'chip--on')}
                onClick={() => setTeilnehmer((alt) => {
                  const neu = new Set(alt);
                  if (drin) neu.delete(u.id); else neu.add(u.id);
                  return neu;
                })}
                // Zeitzonen sind der häufigste Grund für misslungene Termine.
                title={zeit?.time ? t('calendar.otherTimezone', { name: u.displayName, time: zeit.time }) : undefined}
              >
                <Avatar user={u} size={16} /> {u.displayName}
                {zeit?.offHours && <span className="chip__moon">🌙</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel__foot">
        <button className="btn btn--primary" onClick={absenden} disabled={!title.trim()}>
          {t('tasks.create')}
        </button>
      </div>
    </Shell>
  );
}

function EventDetail({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const { respondEvent, deleteEvent } = useStore.getState();
  const sprache = currentUiLanguage();
  const zone = gueltigeZone(self?.timezone);

  const meine = event.attendees.find((a) => a.userId === self?.id);
  const darfLoeschen = event.createdBy === self?.id || self?.permissions['event.manage'];

  return (
    <Shell
      title={uebersetztesFeld(event, 'title', event.title) ?? event.title}
      icon={<CalendarDays size={18} />}
      onClose={onClose}
      width={520}
      actions={darfLoeschen ? (
        <button
          className="icon-btn icon-btn--danger"
          onClick={() => { deleteEvent(event.id); onClose(); }}
          title={t('calendar.delete')}
          aria-label={t('calendar.delete')}
        >
          <Trash2 size={16} />
        </button>
      ) : undefined}
    >
      <p className="event-when">
        <Clock size={13} />
        {event.allDay
          ? t('calendar.allDay')
          : `${new Date(event.startsAt).toLocaleString(sprache, zonenTeil(zone))} – ${uhrzeit(event.endsAt, sprache, zone)}`}
      </p>
      {event.location && <p className="event-when"><MapPin size={13} /> {uebersetztesFeld(event, 'location', event.location)}</p>}
      {event.description && <p style={{ marginTop: 10 }}>{uebersetztesFeld(event, 'description', event.description)}</p>}

      {!!event.attendees.length && (
        <div className="field">
          <label className="field__label">{t('calendar.attendees')}</label>
          <div className="chip-grid">
            {event.attendees.map((a) => {
              const u = users[a.userId];
              const zeit = localTimeFor(u?.timezone);
              return (
                <span
                  key={a.userId}
                  className={clsx('chip', a.response === 'yes' && 'chip--yes', a.response === 'no' && 'chip--no')}
                  title={zeit?.time && u ? t('calendar.otherTimezone', { name: u.displayName, time: zeit.time }) : undefined}
                >
                  <Avatar user={u} size={16} /> {u?.displayName ?? '—'}
                  {a.response === 'yes' && <Check size={11} />}
                  {a.response === 'no' && <X size={11} />}
                  {a.response === 'maybe' && <HelpCircle size={11} />}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {meine && (
        <div className="panel__foot" style={{ gap: 8 }}>
          <button
            className={clsx('btn', meine.response === 'yes' && 'btn--primary')}
            onClick={() => respondEvent(event.id, 'yes')}
          >{t('calendar.yes')}</button>
          <button
            className={clsx('btn', meine.response === 'maybe' && 'btn--primary')}
            onClick={() => respondEvent(event.id, 'maybe')}
          >{t('calendar.maybe')}</button>
          <button
            className={clsx('btn', meine.response === 'no' && 'btn--primary')}
            onClick={() => respondEvent(event.id, 'no')}
          >{t('calendar.no')}</button>
        </div>
      )}
    </Shell>
  );
}
