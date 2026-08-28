import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlarmClock, ArrowRightLeft, CalendarDays, Check, Eye, EyeOff, FolderKanban, Hash, Inbox, ListChecks,
  Loader2, MessageSquare, Pencil, Plus, Sparkles, Trash2, User as UserIcon, X,
} from 'lucide-react';
import {
  TASK_STATUSES, TASK_PRIORITIES, uebersetztesFeld, type Task, type TaskPriority, type TaskStatus,
} from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useVorschlaege } from '../state/vorschlaege.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { PruefListe } from './PruefListe.jsx';
import { ProjektDialog } from './ProjektDialog.jsx';
import { ContextMenu, type MenuEintrag, type MenuPosition } from './ContextMenu.jsx';
import { clsx, dateTime, dayLabel, relativeTime } from '../lib/format.js';

const SPALTEN_FARBE: Record<TaskStatus, string> = {
  pending: 'var(--text-dim)',
  working: 'var(--blue)',
  review: 'var(--amber)',
  finished: 'var(--green)',
  blocked: 'var(--red)',
};

const PRIO_FARBE: Record<TaskPriority, string> = {
  low: 'var(--text-dim)',
  normal: 'var(--blue)',
  high: 'var(--amber)',
  urgent: 'var(--red)',
};

/** Tagesgenaue Einordnung eines Termins — für Färbung und Kurztext. */
function faelligkeit(dueAt: number | null, jetzt = Date.now()) {
  if (!dueAt) return null;
  const tag = 86_400_000;
  const restTage = Math.floor((dueAt - jetzt) / tag);
  return { ueberfaellig: dueAt < jetzt, heute: restTage === 0 && dueAt >= jetzt, restTage };
}

export function TasksBoard({ onClose }: { onClose: () => void }) {
  const t = useT();
  /* Wie viele Vorschläge dieser Art warten. Aus demselben Laden wie der
     Eingang selbst — keine zweite Zählung, die irgendwann abweicht. */
  const offeneVorschlaege = useVorschlaege(
    (s) => s.liste.filter((v) => v.art === 'aufgabe').length,
  );

  const tasks = useStore((s) => s.tasks);
  const projekte = useStore((s) => s.projekte);
  /* Für den Reiter „Prüfen" unten (users/channels von Zuständigkeit und
     Kanal einer Aufgabe) — die Karten selbst holen sich das seit Kurzem
     JEDE FÜR SICH (siehe TaskCard weiter unten), damit ein Präsenz-Update
     nicht mehr das ganze Brett neu aufbaut. */
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  /* Nur die id, nicht das ganze self-Objekt: sonst rendert das Brett bei
     jeder Theme- oder Status-Änderung mit — hier zählt einzig, WER man ist. */
  const selfId = useStore((s) => s.self?.id);
  const ai = useStore((s) => s.ai);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const { loadTasks, loadProjekte, moveTask, deleteTask, setOverlay, aufgabeGeprueft } = useStore.getState();

  const [nurMeine, setNurMeine] = useState(false);
  /** Welches Projekt gezeigt wird: null = alle, '' = ohne Projekt. */
  const [projektFilter, setProjektFilter] = useState<string | null>(null);
  /** Der Reiter „Prüfen": zeigt nur, was die KI selbst eingetragen hat. */
  const [pruefen, setPruefen] = useState(false);
  const [projekteOffen, setProjekteOffen] = useState(false);
  const [neuOffen, setNeuOffen] = useState(false);
  const [offeneAufgabe, setOffeneAufgabe] = useState<string | null>(null);
  const [gezogen, setGezogen] = useState<string | null>(null);
  const [ueberSpalte, setUeberSpalte] = useState<TaskStatus | null>(null);
  /* Für die Tastatur-Ansage einer Spaltenverschiebung (siehe TaskCard): hier
     steht, welche Verschiebung gerade unterwegs ist, bis der Server sie
     bestätigt — angesagt wird erst DANN, nicht schon beim Klick. */
  const [erwarteteVerschiebung, setErwarteteVerschiebung] = useState<
    { taskId: string; status: TaskStatus; titel: string } | null
  >(null);
  const [ansage, setAnsage] = useState('');

  useEffect(() => { loadTasks(); loadProjekte(); }, [loadTasks, loadProjekte]);

  /* Bestätigt der Bestand die erwartete Verschiebung (derselbe Weg, über den
     auch das Ziehen mit der Maus ankommt — task:move und dieser Knopf landen
     serverseitig ohnehin am selben Dienst), wird EINMAL angesagt, danach
     verstummt die Region wieder bis zur nächsten Verschiebung. Ohne diese
     Bestätigung stünde in der Ansage etwas, das der Server am Ende ablehnen
     könnte (fehlendes Recht, gelöschte Aufgabe) — der Fehlerfall selbst zeigt
     sich schon über die Toasts (Toasts.tsx), eigens dafür ist hier nichts
     nötig. */
  useEffect(() => {
    if (!erwarteteVerschiebung) return;
    const aktuell = tasks[erwarteteVerschiebung.taskId];
    if (aktuell?.status === erwarteteVerschiebung.status) {
      setAnsage(t('tasks.verschobenAngesagt', {
        titel: erwarteteVerschiebung.titel,
        spalte: t(`tasks.status.${erwarteteVerschiebung.status}` as never),
      }));
      setErwarteteVerschiebung(null);
    }
  }, [tasks, erwarteteVerschiebung, t]);

  /* Was die KI selbst eingetragen hat und noch niemand angesehen hat. */
  const ungeprueft = useMemo(
    () => Object.values(tasks).filter((a) => a.vonKi && !a.geprueft),
    [tasks],
  );

  /* Steht nichts mehr zum Prüfen an, führt der Reiter ins Leere — dann
     zurück aufs Brett, statt eine leere Seite anzustarren. */
  useEffect(() => {
    if (pruefen && !ungeprueft.length) setPruefen(false);
  }, [pruefen, ungeprueft.length]);

  const spalten = useMemo(() => {
    const alle = Object.values(tasks)
      .filter((a) => !nurMeine || a.assigneeId === selfId)
      /* Ohne Projektwahl alles; mit '' nur das ohne Schublade. */
      .filter((a) => projektFilter === null || (a.projektId ?? '') === projektFilter)
      .sort((a, b) => {
        // Termine zuerst, dann Wichtigkeit, dann Alter.
        const af = a.dueAt ?? Infinity;
        const bf = b.dueAt ?? Infinity;
        if (af !== bf) return af - bf;
        return TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority)
          || a.createdAt - b.createdAt;
      });
    return TASK_STATUSES.map((status) => ({ status, items: alle.filter((a) => a.status === status) }));
  }, [tasks, nurMeine, selfId, projektFilter]);

  const offen = Object.values(tasks).filter((a) => a.status !== 'finished').length;

  /* Stabile Bezüge für TaskCard (Modulebene, unten): ohne das sähe jede
     Karte bei jedem Board-Render eine neue Prop-Identität, und der
     React.memo-Vergleich dort liefe leer. setState-Setter sind selbst
     immer stabil — das genügt als einziges Dependency. */
  const onOpenTask = useCallback((id: string) => setOffeneAufgabe(id), []);
  const onDragStartTask = useCallback((id: string) => setGezogen(id), []);
  const onDragEndTask = useCallback(() => { setGezogen(null); setUeberSpalte(null); }, []);
  /* Der Tastaturweg zwischen Spalten (siehe TaskCard, Menü „In andere Spalte
     verschieben"). `moveTask` ist wie `loadTasks` & Co. oben eine im Bestand
     fest verdrahtete Funktion — dieselbe Referenz bei jedem Aufruf von
     `getState()` — deshalb genügt sie allein als Abhängigkeit, ohne dass
     `tasks` hier mit hineinzieht und die Karten-Referenz bei jeder
     Bestandsänderung neu entstehen ließe. Den Titel für die Ansage holt sich
     der Aufruf selbst frisch aus `getState()`, statt `tasks` aus dem
     Komponenten-Zustand zu schließen — auch das nur, um diese eine stabile
     Referenz nicht wieder aufzubrechen. */
  const onMoveTask = useCallback((id: string, status: TaskStatus) => {
    const titel = useStore.getState().tasks[id]?.title ?? '';
    setErwarteteVerschiebung({ taskId: id, status, titel });
    moveTask(id, status);
  }, [moveTask]);

  return (
    <Shell
      title={t('tasks.title')}
      subtitle={t('tasks.openCount', { count: offen })}
      icon={<ListChecks size={18} />}
      onClose={onClose}
      width={1180}
      actions={
        <>
          <button
            className={clsx('pill', nurMeine && 'pill--accent')}
            onClick={() => setNurMeine((v) => !v)}
          >
            <UserIcon size={13} /> {nurMeine ? t('tasks.mine') : t('tasks.all')}
          </button>
          {/* Die Schublade: alles, ein Projekt, oder das ohne Projekt. */}
          <select
            className="pill pill--select"
            value={projektFilter ?? '__alle'}
            onChange={(e) => setProjektFilter(e.target.value === '__alle' ? null : e.target.value)}
            title={t('projekte.title')}
          >
            <option value="__alle">{t('projekte.all')}</option>
            <option value="">{t('projekte.none')}</option>
            {Object.values(projekte)
              .filter((p) => !p.archiviert)
              .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="pill" onClick={() => setProjekteOffen(true)} title={t('projekte.title')}>
            <FolderKanban size={13} /> {t('projekte.title')}
          </button>
          {/* „Prüfen" erscheint nur, wenn es etwas zu prüfen gibt — ein
              dauerhaft leerer Reiter ist ein Versprechen, das keiner einlöst. */}
          {ungeprueft.length > 0 && (
            <button
              className={clsx('pill', pruefen ? 'pill--accent' : 'pill--warn')}
              onClick={() => setPruefen((v) => !v)}
            >
              <Sparkles size={13} /> {t('pruefen.count', { n: ungeprueft.length })}
            </button>
          )}
          {ai?.assistant && activeChannelId && (
            <button className="pill" onClick={() => setOverlay('taskExtract')} title={t('ai.extractTasks')}>
              <Sparkles size={13} /> {t('ai.extractTasks')}
            </button>
          )}
          {/* Dons „jeweils": das Brett zeigt, dass Vorschläge dieser Art
              warten, und führt in den einen Eingang — vorgefiltert. Ein
              eigener Reiter je Brett wäre der zweite Ort zum Nachsehen. */}
          {offeneVorschlaege > 0 && (
            <button
              className="pill"
              onClick={() => useVorschlaege.getState().oeffnen('aufgabe')}
            >
              <Inbox size={13} /> {t('vorschlaege.doorTasks', { n: offeneVorschlaege })}
            </button>
          )}
          <button className="pill pill--accent" onClick={() => setNeuOffen(true)}>
            <Plus size={13} /> {t('tasks.new')}
          </button>
        </>
      }
    >
      {/* Immer im Baum, nur der Text wechselt — wie bei den Toasts (Toasts.tsx)
          und dem Tipp-Hinweis der Seitenleiste (Sidebar.tsx, DmTypingHint):
          entstünde die Region erst zusammen mit der ersten Ansage, verpassten
          manche Sprachausgaben sie, weil sie die Stelle vorher nie sahen. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{ansage}</span>

      {pruefen ? (
        <PruefListe
          eintraege={ungeprueft.map((a) => ({
            id: a.id,
            titel: a.title,
            neben: [
              a.assigneeId ? users[a.assigneeId]?.displayName : null,
              a.channelId ? `#${channels[a.channelId]?.name ?? ''}` : null,
              a.dueAt ? dayLabel(a.dueAt) : null,
            ].filter(Boolean).join(' · ') || null,
          }))}
          onOeffnen={(id) => setOffeneAufgabe(id)}
          onPasst={(id) => aufgabeGeprueft(id)}
          onWeg={(id) => { if (confirm(t('tasks.deleteConfirm'))) deleteTask(id); }}
        />
      ) : !Object.keys(tasks).length ? (
        <div className="empty-state">
          <ListChecks size={30} className="muted" />
          <p>{t('tasks.empty')}</p>
        </div>
      ) : (
        <div className="board">
          {spalten.map(({ status, items }) => (
            <div
              key={status}
              className={clsx('board__col', ueberSpalte === status && 'board__col--over')}
              onDragOver={(e) => { e.preventDefault(); setUeberSpalte(status); }}
              onDragLeave={() => setUeberSpalte((v) => (v === status ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                setUeberSpalte(null);
                const id = gezogen ?? e.dataTransfer.getData('text/plain');
                if (id && tasks[id]?.status !== status) moveTask(id, status);
                setGezogen(null);
              }}
            >
              <header className="board__head">
                <span className="board__dot" style={{ background: SPALTEN_FARBE[status] }} />
                <span className="board__title">{t(`tasks.status.${status}` as never)}</span>
                <span className="board__count">{items.length}</span>
              </header>

              <div className="board__cards">
                <AnimatePresence initial={false}>
                  {items.map((aufgabe) => (
                    <TaskCard
                      key={aufgabe.id}
                      task={aufgabe}
                      onOpen={onOpenTask}
                      onDragStart={onDragStartTask}
                      onDragEnd={onDragEndTask}
                      onMove={onMoveTask}
                    />
                  ))}
                </AnimatePresence>
                {!items.length && <p className="board__empty">{t('tasks.emptyColumn')}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {projekteOffen && <ProjektDialog key="projekte" onClose={() => setProjekteOffen(false)} />}
        {neuOffen && <TaskDialog key="neu" onClose={() => setNeuOffen(false)} />}
        {offeneAufgabe && tasks[offeneAufgabe] && (
          <TaskDetail
            key={offeneAufgabe}
            task={tasks[offeneAufgabe]}
            onClose={() => setOffeneAufgabe(null)}
            onDelete={() => {
              if (confirm(t('tasks.deleteConfirm'))) { deleteTask(offeneAufgabe); setOffeneAufgabe(null); }
            }}
          />
        )}
      </AnimatePresence>
    </Shell>
  );
}

/**
 * Eine Karte auf dem Brett — als eigene Komponente auf Modulebene.
 *
 * Stand vorher: als Funktion INNERHALB von TasksBoard definiert. Harmlos
 * aussehend, aber folgenreich — bei jedem Render von TasksBoard entstand
 * dadurch eine NEUE Funktionsidentität für TaskCard, und React sieht darin
 * keine aktualisierte Komponente, sondern einen ANDEREN Komponententyp:
 * jede Karte wurde ab- und wieder aufgebaut (echtes DOM weg und neu), nicht
 * nur neu gezeichnet — bei jedem Zwischenstand des Bretts, auch bei
 * Ereignissen, die mit der Karte selbst nichts zu tun haben (ein
 * Präsenz-Update irgendeiner Kollegin, eine von jemand anderem bearbeitete
 * Aufgabe). Genau das war die Ursache des Ruckelns beim Ziehen: das
 * Überqueren einer Spaltengrenze ändert einen einzigen State-Wert in
 * TasksBoard (`ueberSpalte`, für den Rahmen der Zielspalte) — und riss
 * dabei bisher alle zehn Karten neu auf, jedes Mal mit frischer Mess- und
 * Eintrittsanimation von framer-motion, obwohl sich an neun von zehn
 * Karten optisch nichts ändert.
 *
 * Jetzt: eine mit React.memo verglichene, eigenständige Komponente. Ändert
 * sich `task` einer Karte nicht (per Referenz — der Zustand ersetzt beim
 * Aktualisieren nur den EINEN betroffenen Eintrag, alle anderen behalten
 * ihre Objektreferenz), bleibt ihr DOM-Knoten unangetastet, ganz gleich wie
 * oft TasksBoard selbst neu rendert. `onOpen`/`onDragStart`/`onDragEnd`/
 * `onMove` kommen deshalb als vier stabile, einmal erzeugte Funktionen von
 * außen (siehe die passenden useCallback in TasksBoard) statt als frische
 * Closure pro Karte und Render — sonst liefe der Vergleich von React.memo
 * leer, weil sich „irgendeine" Prop doch bei jedem Render ändert. `menuPos`
 * unten ist davon unberührt: eigener State EINER Karte bricht den Vergleich
 * nicht, der gilt nur den PROPS.
 *
 * users/channels/projekte/self-id holt sich die Karte über eigene, enge
 * useStore-Selektoren statt sie von TasksBoard durchgereicht zu bekommen:
 * ein Präsenz-Update für eine Kollegin betrifft dann nur noch Karten, die
 * ihr auch zugeteilt sind — nicht mehr automatisch das ganze Brett.
 */
const TaskCard = memo(function TaskCard({ task, onOpen, onDragStart, onDragEnd, onMove }: {
  task: Task;
  onOpen: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onMove: (id: string, status: TaskStatus) => void;
}) {
  const t = useT();
  const zustaendig = useStore((s) => (task.assigneeId ? s.users[task.assigneeId] : null));
  const kanal = useStore((s) => (task.channelId ? s.channels[task.channelId] : null));
  const projekt = useStore((s) => (task.projektId ? s.projekte[task.projektId] : null));
  const selfId = useStore((s) => s.self?.id);
  const frist = faelligkeit(task.dueAt);

  /* Der Weg ohne Maus: ein eigener Knopf öffnet ein Menü mit den ÜBRIGEN
     Spalten (ContextMenu.tsx — dieselbe Komponente wie beim Rechtsklick in
     der Seitenleiste, jetzt auch per Tastatur geöffnet, siehe die
     Fokus-Verwaltung dort). Die Position kommt von der Lage des KNOPFS
     (`getBoundingClientRect`), nicht von `e.clientX/clientY` — ein per
     Enter/Leertaste ausgelöster Klick trägt dort ohnehin nur Nullen. Das ist
     Zustand DIESER Karte, keine Prop — bricht also nicht den React.memo-
     Vergleich oben. */
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const verschiebenKnopf = useRef<HTMLButtonElement>(null);

  const menuEintraege: MenuEintrag[] = TASK_STATUSES.filter((s) => s !== task.status).map((status) => ({
    id: status,
    label: t(`tasks.status.${status}` as never),
    icon: <span className="projekt-punkt" style={{ background: SPALTEN_FARBE[status] }} />,
    onClick: () => onMove(task.id, status),
  }));

  return (
    <motion.div
      /* `layout` ordnet um, wenn sich die Reihenfolge ändert — das genügt.
         Hier stand zusätzlich `layoutId={`task_${task.id}`}`, und das war
         die Lücke in der Spalte: `layoutId` ist für Übergänge zwischen
         VERSCHIEDENEN Komponenten gedacht (ein Element verschwindet hier
         und taucht dort wieder auf). Framer-Motion legt dafür eine eigene
         Projektion an und hält den Platz des alten Elements so lange frei,
         bis der Übergang fertig ist. Wird er unterbrochen — ein Umlauf
         mittendrin, ein Wechsel der Spalte, ein Scrollen —, bleibt der
         Platz reserviert: eine leere Kartenhöhe mitten in der Spalte,
         ohne dass eine Karte fehlt.
         Jede Karte hat längst einen stabilen `key`; `layoutId` brachte
         nichts dazu. Die Ideentafel nebenan macht es seit jeher ohne und
         hat das Problem nicht. */
      layout
      className="task-card"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.16 }}
    >
      {/* Zwei eigenständige Knöpfe statt einem Knopf im Knopf: `.task-card`
          war bisher selbst ein <button>, und ein zweiter Knopf DARIN wäre
          ungültiges HTML gewesen (Knöpfe dürfen keine anfassbaren Kinder
          enthalten) — mit unklarem Verhalten für Tastatur und Sprachausgabe.
          Deshalb jetzt ein umschließendes <div> und zwei GESCHWISTER: der
          bisherige Öffnen-Knopf (Ziehen inklusive, unverändert) und der neue
          Verschieben-Knopf daneben. */}
      <button
        className="task-card__open"
        draggable
        onDragStart={(e) => {
          e.dataTransfer?.setData('text/plain', task.id);
          onDragStart(task.id);
        }}
        onDragEnd={onDragEnd}
        onClick={() => onOpen(task.id)}
      >
        <span className="task-card__prio" style={{ background: PRIO_FARBE[task.priority] }} />
        <span className="task-card__title">{uebersetztesFeld(task, 'title', task.title)}</span>
        {task.vonKi && !task.geprueft && (
          <span className="task-card__ki" title={t('pruefen.hint')}>
            <Sparkles size={10} /> {t('pruefen.badge')}
          </span>
        )}

        <span className="task-card__meta">
          {zustaendig
            ? <Avatar user={zustaendig} size={17} />
            : <span className="task-card__nobody"><UserIcon size={11} /></span>}
          {kanal && <span className="task-card__chan"><Hash size={10} />{kanal.name}</span>}
          {projekt && (
            <span className="task-card__chan" title={t('projekte.assign')}>
              <span className="projekt-punkt" style={{ background: projekt.farbe }} />
              {projekt.name}
            </span>
          )}
          {frist && (
            <span
              className={clsx('task-card__due', frist.ueberfaellig && 'task-card__due--late')}
              title={dateTime(task.dueAt!)}
            >
              <AlarmClock size={10} />
              {frist.ueberfaellig ? t('tasks.overdue') : frist.heute ? t('tasks.dueToday') : relativeTime(task.dueAt!)}
            </span>
          )}
          {task.watcherIds.includes(selfId ?? '') && <Eye size={11} className="muted" />}
        </span>
      </button>

      <button
        ref={verschiebenKnopf}
        type="button"
        className="task-card__movebtn"
        title={t('tasks.moveTo')}
        aria-label={t('tasks.moveTo')}
        onClick={(e) => {
          // Nicht zugleich den Öffnen-Knopf auslösen — die beiden liegen übereinander.
          e.stopPropagation();
          const kasten = verschiebenKnopf.current?.getBoundingClientRect();
          if (kasten) setMenuPos({ x: kasten.left, y: kasten.bottom + 4 });
        }}
      >
        <ArrowRightLeft size={12} />
      </button>

      {menuPos && (
        <ContextMenu position={menuPos} eintraege={menuEintraege} onClose={() => setMenuPos(null)} />
      )}
    </motion.div>
  );
});

/* ── Anlegen ────────────────────────────────────────────────── */

function TaskDialog({ onClose, vorgabe }: {
  onClose: () => void;
  vorgabe?: { title?: string; assigneeId?: string | null; dueAt?: number | null };
}) {
  const t = useT();
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const dialogProjekte = useStore((s) => s.projekte);

  const [title, setTitle] = useState(vorgabe?.title ?? '');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState(vorgabe?.assigneeId ?? '');
  const [channelId, setChannelId] = useState(activeChannelId ?? '');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [due, setDue] = useState(vorgabe?.dueAt ? tagesFeld(vorgabe.dueAt) : '');
  const [projektId, setProjektId] = useState('');

  const absenden = () => {
    if (!title.trim()) return;
    useStore.getState().createTask({
      title: title.trim(),
      description: description.trim() || null,
      assigneeId: assigneeId || null,
      channelId: channelId || null,
      priority,
      // Ohne Uhrzeit ist "fällig" das Ende des gewählten Tages.
      dueAt: due ? new Date(`${due}T23:59`).getTime() : null,
      projektId: projektId || null,
    });
    onClose();
  };

  return (
    <Shell title={t('tasks.new')} icon={<Plus size={18} />} onClose={onClose} width={520}>
      <div className="field">
        <label className="field__label">{t('tasks.newTitle')}</label>
        <input
          className="input" value={title} autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') absenden(); }}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('tasks.description')}</label>
        <textarea
          className="input" rows={3} value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label className="field__label">{t('tasks.assignee')}</label>
          <select className="select" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">{t('tasks.unassigned')}</option>
            {Object.values(users).filter((u) => !u.disabled && u.role !== 'bot' && !u.technisch).map((u) => (
              <option key={u.id} value={u.id}>{u.displayName}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.priority')}</label>
          <select
            className="select" value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>{t(`tasks.priority.${p}` as never)}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.channel')}</label>
          <select className="select" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">{t('tasks.noChannel')}</option>
            {Object.values(channels).filter((c) => c.kind !== 'dm' && !c.archived).map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('projekte.assign')}</label>
          <select className="select" value={projektId} onChange={(e) => setProjektId(e.target.value)}>
            <option value="">{t('projekte.none')}</option>
            {Object.values(dialogProjekte).filter((p) => !p.archiviert).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.due')}</label>
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
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

function tagesFeld(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── Einzelansicht ──────────────────────────────────────────── */

function TaskDetail({ task, onClose, onDelete }: { task: Task; onClose: () => void; onDelete: () => void }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const verlauf = useStore((s) => s.taskHistory[task.id]);
  const { updateTask, commentTask, watchTask, loadTaskHistory } = useStore.getState();
  const [kommentar, setKommentar] = useState('');

  useEffect(() => { loadTaskHistory(task.id); }, [task.id, loadTaskHistory]);

  const beobachtet = task.watcherIds.includes(self?.id ?? '');

  return (
    <Shell
      title={uebersetztesFeld(task, 'title', task.title) ?? task.title}
      icon={<ListChecks size={18} />}
      onClose={onClose}
      width={640}
      actions={
        <>
          <button
            className="icon-btn"
            onClick={() => watchTask(task.id, !beobachtet)}
            title={beobachtet ? t('tasks.unwatch') : t('tasks.watch')}
            aria-label={beobachtet ? t('tasks.unwatch') : t('tasks.watch')}
          >
            {beobachtet ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button
            className="icon-btn icon-btn--danger"
            onClick={onDelete}
            title={t('tasks.delete')}
            aria-label={t('tasks.delete')}
          >
            <Trash2 size={16} />
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field">
          <label className="field__label">{t('tasks.statusLabel')}</label>
          <select
            className="select" value={task.status}
            onChange={(e) => updateTask(task.id, { status: e.target.value as TaskStatus })}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>{t(`tasks.status.${s}` as never)}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.assignee')}</label>
          <select
            className="select" value={task.assigneeId ?? ''}
            onChange={(e) => updateTask(task.id, { assigneeId: e.target.value || null })}
          >
            <option value="">{t('tasks.unassigned')}</option>
            {Object.values(users).filter((u) => !u.disabled && u.role !== 'bot' && !u.technisch).map((u) => (
              <option key={u.id} value={u.id}>{u.displayName}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.priority')}</label>
          <select
            className="select" value={task.priority}
            onChange={(e) => updateTask(task.id, { priority: e.target.value as TaskPriority })}
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>{t(`tasks.priority.${p}` as never)}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.due')}</label>
          <input
            className="input" type="date"
            value={task.dueAt ? tagesFeld(task.dueAt) : ''}
            onChange={(e) => updateTask(task.id, {
              dueAt: e.target.value ? new Date(`${e.target.value}T23:59`).getTime() : null,
            })}
          />
        </div>
      </div>

      <div className="field">
        <label className="field__label">{t('tasks.description')}</label>
        <textarea
          className="input" rows={3}
          defaultValue={task.description ?? ''}
          onBlur={(e) => {
            const wert = e.target.value.trim() || null;
            if (wert !== (task.description ?? null)) updateTask(task.id, { description: wert });
          }}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('tasks.history')}</label>
        <div className="task-log">
          {(verlauf ?? []).map((e) => {
            const wer = users[e.userId];
            return (
              <div key={e.id} className="task-log__row">
                <Avatar user={wer} size={18} />
                <span className="task-log__text">
                  <strong>{wer?.displayName ?? t('common.unknown')}</strong>{' '}
                  {t(`tasks.event.${e.kind}` as never)}
                  {e.kind === 'comment' && e.text && <em> — {e.text}</em>}
                  {e.kind === 'status' && e.nach && <em> → {t(`tasks.status.${e.nach}` as never)}</em>}
                </span>
                <span className="task-log__when">{relativeTime(e.createdAt)}</span>
              </div>
            );
          })}
          {!verlauf?.length && <p className="muted" style={{ fontSize: 12 }}>{t('tasks.historyEmpty')}</p>}
        </div>
      </div>

      <div className="field" style={{ display: 'flex', gap: 8 }}>
        <input
          className="input" value={kommentar} placeholder={t('tasks.comment')}
          onChange={(e) => setKommentar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && kommentar.trim()) {
              commentTask(task.id, kommentar.trim());
              setKommentar('');
            }
          }}
        />
        <button
          className="btn"
          disabled={!kommentar.trim()}
          onClick={() => { commentTask(task.id, kommentar.trim()); setKommentar(''); }}
          aria-label={t('post.senden')}
        >
          <MessageSquare size={14} />
        </button>
      </div>
    </Shell>
  );
}

/* ── Aufgaben aus einem Gespräch ────────────────────────────── */
