import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, WifiOff } from 'lucide-react';
import { useStore } from './state/store.js';
import { t } from './i18n/index.js';
import { Cosmos } from './components/Cosmos.jsx';
import { Rail } from './components/Rail.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { ChannelHeader } from './components/ChannelHeader.jsx';
import { MessageList } from './components/MessageList.jsx';
import { Composer } from './components/Composer.jsx';
import { TypingBar } from './components/TypingBar.jsx';
import { ThreadPanel } from './components/ThreadPanel.jsx';
import { QuickSwitcher } from './components/QuickSwitcher.jsx';
import { SearchOverlay } from './components/SearchOverlay.jsx';
import { Settings } from './components/Settings.jsx';
import { CatchupPanel, GlossaryPanel, NewChannelDialog, PeoplePanel } from './components/Panels.jsx';
import { ForwardDialog, PollDialog, ReminderDialog, RemindersPanel } from './components/Dialogs.jsx';
import { ProfileCard } from './components/ProfileCard.jsx';
import { ChannelSettings } from './components/ChannelSettings.jsx';
import { Tour, tourBereitsGesehen } from './components/Tour.jsx';
import { Login } from './components/Login.jsx';
import { Setup } from './components/Setup.jsx';
import { TeamAdmin } from './components/TeamAdmin.jsx';
import { TasksBoard } from './components/TasksBoard.jsx';
import { CalendarPanel } from './components/CalendarPanel.jsx';
import { FilesPanel } from './components/FilesPanel.jsx';
import { ProtocolPanel } from './components/ProtocolPanel.jsx';
import { IdeaBoard } from './components/IdeaBoard.jsx';
import { VorschlagPosteingang } from './components/VorschlagPosteingang.jsx';
import { useVorschlaege } from './state/vorschlaege.js';
import { PartnerGruppenPanel } from './components/PartnerGruppenPanel.jsx';
import { usePartnerGruppenUi } from './state/partnergruppen.js';
import { useGedaechtnisUi } from './state/gedaechtnis.js';
import { PostGedaechtnis } from './components/PostGedaechtnis.jsx';
import { EinmalcodePanel } from './components/EinmalcodePanel.jsx';
import { useEinmalcodeUi } from './state/einmalcode.js';
import { PasswortPanel } from './components/PasswortPanel.jsx';
import { NotzugangPanel } from './components/NotzugangPanel.jsx';
import { NotzugangHinweis } from './components/NotzugangHinweis.jsx';
import { usePasswortUi } from './state/passwort.js';
import { useNotzugangUi } from './state/notzugang.js';
import { PaypalPanel } from './components/PaypalPanel.jsx';
import { usePaypalUi } from './state/paypal.js';
import { VerkaufMeldungen } from './components/VerkaufMeldungen.jsx';
import { useVerkaufMeldungenUi } from './state/verkaufMeldungen.js';
import { DownloadPanel } from './components/DownloadPanel.jsx';
import { Fernsteuerung } from './components/Fernsteuerung.jsx';
import { SystemPanel } from './components/SystemPanel.jsx';
import { PostPanel } from './components/PostPanel.jsx';
import { PostMeldungen } from './components/PostMeldungen.jsx';
import { UpdateBanner, UpdateWillkommen, ServerWartung } from './components/UpdateBanner.jsx';
import { MeldungBitte } from './components/MeldungBitte.jsx';
import { DownloadHinweis } from './components/DownloadHinweis.jsx';
import { Toasts } from './components/Toasts.jsx';
import { Fangkorb } from './components/Fangkorb.jsx';
import { FreigabenDialog, VorfallDialog, WiederherstellungHinweis } from './components/Vertraulich.jsx';
import { NotizenPanel } from './components/NotizenPanel.jsx';
import { clsx } from './lib/format.js';
/* Die Schlüsselarbeit für vertrauliche Kanäle bzw. für Notizen hängt sich
   beim Laden jeweils selbst an den Draht zum Server. Beide Zeilen stehen
   hier ausdrücklich, obwohl der Zustand sie ohnehin lädt: wer eine streicht,
   soll merken, dass etwas fehlt. */
import './lib/vertraulich.js';
import './lib/notizen.js';

export function App() {
  const booted = useStore((s) => s.booted);
  const self = useStore((s) => s.self);
  const connection = useStore((s) => s.connection);
  const connectionDetail = useStore((s) => s.connectionDetail);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const threadParentId = useStore((s) => s.threadParentId);
  const schubladeOffen = useStore((s) => s.schubladeOffen);
  const overlay = useStore((s) => s.overlay);
  /* Der Eingang für KI-Vorschläge hängt an einem eigenen Laden, nicht an
     `overlay`: er geht mit einem Filter auf, und eine Kennung allein hat dafür
     keinen Platz. Siehe state/vorschlaege.ts. */
  const vorschlagFilter = useVorschlaege((s) => s.offen);
  /* Dieselbe Begründung wie bei vorschlagFilter direkt darüber: ein eigener,
     winziger Laden statt `overlay`, weil state/store.ts gerade an anderer
     Stelle bearbeitet wird. Siehe state/partnergruppen.ts. */
  const partnerGruppenOffen = usePartnerGruppenUi((s) => s.offen);
  const gedaechtnisOffen = useGedaechtnisUi((s) => s.offen);
  const einmalcodeOffen = useEinmalcodeUi((s) => s.offen);
  const passwortOffen = usePasswortUi((s) => s.offen);
  const notzugangOffen = useNotzugangUi((s) => s.offen);
  const bankOffen = usePaypalUi((s) => s.offen);
  const verkaufOffen = useVerkaufMeldungenUi((s) => s.offen);
  const lightbox = useStore((s) => s.lightbox);
  const forwarding = useStore((s) => s.forwarding);
  const remindingAbout = useStore((s) => s.remindingAbout);
  const profileUserId = useStore((s) => s.profileUserId);

  /* Beim allerersten Mal die Einführung zeigen — danach nie wieder von selbst.
     Bewusst in einem Effekt: mitten in der Darstellung darf kein Zustand
     gesetzt werden, und beim Schließen ginge die Einführung sonst sofort
     wieder auf. */
  const angemeldet = Boolean(self && !self.mustChangePassword && !self.mustCompleteProfile);
  useEffect(() => {
    if (angemeldet && !tourBereitsGesehen()) useStore.getState().setOverlay('tour');
  }, [angemeldet]);

  /* Tastenkürzel */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const store = useStore.getState();
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); store.setOverlay('quick'); }
      else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); store.setOverlay('search'); }
      else if (mod && e.key === ',') { e.preventDefault(); store.setOverlay('settings'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); store.setOverlay('newChannel'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); store.setOverlay('tasks'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); store.setOverlay('calendar'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); store.setOverlay('files'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); store.setOverlay('ideas'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        if (store.activeChannelId) store.runCatchup(store.activeChannelId);
      } else if (e.key === 'Escape') {
        if (store.lightbox) store.setLightbox(null);
        else if (store.profileUserId) store.setProfileUser(null);
        else if (store.forwarding) store.startForward(null);
        else if (store.remindingAbout) store.startReminder(null);
        else if (store.overlay) store.setOverlay(null);
        else if (store.schubladeOffen) store.setSchublade(false);
        else if (store.threadParentId) store.openThread(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Menü-Befehle aus dem Electron-Hauptprozess */
  useEffect(() => {
    const off = window.stellium?.onMenu((action) => {
      const store = useStore.getState();
      if (action === 'settings') store.setOverlay('settings');
      if (action === 'new-channel') store.setOverlay('newChannel');
      if (action === 'quick-switch') store.setOverlay('quick');
      if (action === 'search') store.setOverlay('search');
      if (action === 'catchup' && store.activeChannelId) store.runCatchup(store.activeChannelId);
    });
    const offClick = window.stellium?.onNotificationClick((channelId) => {
      useStore.getState().openChannel(channelId);
    });
    // Dasselbe im Browser: die Benachrichtigung meldet sich über ein Ereignis.
    const imBrowser = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) useStore.getState().openChannel(id);
    };
    window.addEventListener('stellium:kanal-oeffnen', imBrowser);
    return () => {
      off?.();
      offClick?.();
      window.removeEventListener('stellium:kanal-oeffnen', imBrowser);
    };
  }, []);

  useEffect(() => { void useStore.getState().boot(); }, []);


  if (!booted) {
    return (
      <>
        <Cosmos />
        <div className="auth">
          <Loader2 size={26} className="spin" style={{ color: 'var(--violet-soft)' }} />
        </div>
      </>
    );
  }

  if (!self) {
    return (
      <>
        <Cosmos />
        <Login />
        <Toasts />
      </>
    );
  }

  // Wer mit einem Einmal-Passwort da ist, richtet zuerst sein Konto ein.
  if (self.mustChangePassword || self.mustCompleteProfile) {
    return (
      <>
        <Cosmos />
        <Setup />
        <Toasts />
      </>
    );
  }

  const closeOverlay = () => useStore.getState().setOverlay(null);

  /* Rücksetz-Schlüssel für den eingebetteten Fangkorb unten: er muss JEDES
     Feld enthalten, das ein Panel darin schaltet -- sonst bleibt die
     Fehlerkarte stehen, obwohl das auslösende Panel längst geschlossen oder
     zu einem anderen gewechselt wurde (Fangkorb.tsx, getDerivedStateFromProps
     vergleicht nur DIESEN Wert, nicht die Kinder). `overlay` deckt die
     Dialoge ab, die direkt daran hängen; die übrigen Felder kommen aus
     eigenen Laden (siehe deren Begründung weiter oben bei den `useState`-
     Zeilen) und müssen darum von Hand dazu -- kommt ein siebtes Panel mit
     eigenem Laden hinzu, gehört sein Offen-Feld HIER in die Liste -- und sein
     `schliessen()` in `fangkorbEscape` direkt darunter. Beides zusammen, nie
     nur eines: scripts/fangkorb-ausweg-pruefen.mjs verlangt jede
     `useXUi((s) => s.offen)`-Anmeldung dieser Datei in BEIDEN Listen.
     `activeChannelId` gehört ebenfalls dazu: ChannelSettings, PollDialog,
     VorfallDialog und FreigabenDialog hängen weiter unten zusätzlich an
     `overlay === 'x' && activeChannelId` bzw. direkt an `activeChannelId` --
     ein Kanalwechsel bei GLEICHBLEIBENDEM `overlay` (z. B. ChannelSettings
     für Kanal A wirft, dann Wechsel zu Kanal B) ließ die Fehlerkarte für A
     sonst stehen, und B bekam sein eigenes ChannelSettings nie zu sehen --
     derselbe Fehlerklasse wie ein fehlendes Laden-Feld, nur an `overlay`
     vorbei.
     JSON.stringify statt eines rohen Arrays: der Vergleich in Fangkorb.tsx
     läuft über `!==`, und ein frisches Array wäre bei jedem Zeichnen ein
     neuer Verweis -- also IMMER "anders", und die Fehlerkarte verschwände
     sofort wieder, noch bevor sie irgendwer gelesen hätte. Ein String
     vergleicht sich dagegen über seinen Inhalt. */
  const fangkorbSchluessel = JSON.stringify([
    overlay, activeChannelId, vorschlagFilter, partnerGruppenOffen, gedaechtnisOffen, einmalcodeOffen,
    passwortOffen, notzugangOffen, bankOffen, verkaufOffen,
  ]);

  /* Rettungsanker für die Fehlerkarte selbst: sie liegt als
     `scrim scrim--center` über der GANZEN Fensterschicht, inklusive Rail und
     Sidebar. Für die vier `overlay`-gebundenen Dialoge (ChannelSettings,
     PollDialog, VorfallDialog, FreigabenDialog) rettet App.tsx' globales
     Escape (weiter oben) schon heraus, weil es `overlay` selbst löscht --
     aber die laden-gestützten Tafeln (vorschlagFilter, partnerGruppenOffen und
     Co.) hängen an eigenen Laden, die dieses Escape nicht anfasst (siehe
     deren Begründung oben bei den `useXUi`-Zeilen). Für sie war die
     Fehlerkarte bisher eine echte Sackgasse: "Erneut versuchen" zeichnet
     dieselbe, deterministisch werfende Tafel einfach noch einmal. Dieser
     Anker schließt darum ALLES, was der Fangkorb hier unten umschließt --
     unabhängig davon, welches Panel geworfen hat, denn genau das weiß die
     Fehlerkarte selbst nicht.

     KEINE ZAHL IM TEXT, UND DAS MIT ABSICHT: hier stand "die fünf
     laden-gestützten Tafeln", während es längst sieben waren. Genau in dieser
     Lücke ist `usePasswortUi` zweimal hintereinander untergegangen -- der
     Passwort-Tresor stand im Rücksetz-Schlüssel und hinter dem Fangkorb, aber
     nicht hier, und "Schließen" führte für ihn zurück auf dieselbe werfende
     Tafel, mit einem Schleier über Rail und Sidebar. Statt einer Zahl
     bewacht scripts/fangkorb-ausweg-pruefen.mjs die Liste: der Lauf sucht
     JEDE `useXUi((s) => s.offen)`-Anmeldung in dieser Datei und verlangt sie
     in BEIDEN Listen -- im Schlüssel oben und im Ausweg hier. Ein achtes
     Panel schlägt dort fehl, bevor es jemandem auffallen müsste. */
  const fangkorbEscape = () => {
    useStore.getState().setOverlay(null);
    useVorschlaege.getState().schliessen();
    usePartnerGruppenUi.getState().schliessen();
    useGedaechtnisUi.getState().schliessen();
    useEinmalcodeUi.getState().schliessen();
    usePasswortUi.getState().schliessen();
    useNotzugangUi.getState().schliessen();
    usePaypalUi.getState().schliessen();
    useVerkaufMeldungenUi.getState().schliessen();
  };

  return (
    <>
      <Cosmos />
      <div className="rahmen">
        <ServerWartung />
        <UpdateBanner />
        <MeldungBitte />
        <NotzugangHinweis />
        <DownloadHinweis />
        <div className={clsx('app', threadParentId && 'app--thread', schubladeOffen && 'app--schublade')}>
        <Rail />
        <Sidebar />
        {/* Auf dem Telefon liegt die Liste über dem Chat. Ein Tippen daneben
            schließt sie — der übliche Handgriff. */}
        <div
          className="schublade-schleier"
          onClick={() => useStore.getState().setSchublade(false)}
          aria-hidden="true"
        />

        <main className="main">
          {connection !== 'open' && (
            <div className={clsx('conn-banner', connection === 'failed' && 'conn-banner--error')}>
              {connection === 'failed'
                ? <><WifiOff size={14} /> {t('conn.lost')}</>
                : <><Loader2 size={14} className="spin" /> {t('conn.connecting')}{connectionDetail ? ` · ${connectionDetail}` : '…'}</>}
            </div>
          )}

          {activeChannelId ? (
            <>
              <ChannelHeader channelId={activeChannelId} />
              <WiederherstellungHinweis channelId={activeChannelId} />
              <MessageList channelId={activeChannelId} />
              <TypingBar channelId={activeChannelId} />
              <Composer channelId={activeChannelId} autoFocus />
            </>
          ) : (
            <div className="empty">
              <div className="empty__orb" />
              <h2>{t('app.pickChannel')}</h2>
              <p>
                {t('common.pickChannelHint', { shortcut: `${navigator.platform.includes('Mac') ? '⌘' : t('common.ctrlKey')}+K` })}
              </p>
            </div>
          )}
        </main>

        <AnimatePresence>
          {threadParentId && <ThreadPanel key={threadParentId} parentId={threadParentId} />}
        </AnimatePresence>
        </div>
      </div>

      {/* Eigener Fangkorb um die Fensterschicht: wirft ein Dialog beim
          Zeichnen, soll der Chat dahinter weiterlaufen statt mitzugehen.
          Zurückgesetzt über fangkorbSchluessel (siehe dort), sobald sich
          eines der darin gerenderten Panels ändert -- nicht nur bei
          `overlay`, das deckt nur einen Teil davon ab. */}
      <Fangkorb eingebettet zuruecksetzenBei={fangkorbSchluessel} onEscape={fangkorbEscape}>
      <AnimatePresence>
        {overlay === 'quick' && <QuickSwitcher key="quick" onClose={closeOverlay} />}
        {(overlay === 'search' || overlay === 'saved') && (
          /* Dieselbe Tafel für beide Werte, nur mit unterschiedlichem
             Startreiter -- siehe Overlay-Typ in state/store.ts. Ein `key`
             für beide zusammen, nicht je einer: sonst würde AnimatePresence
             einen Wechsel zwischen den beiden als Aus- und Wiedereinbau
             behandeln statt als denselben, weiter offenen Dialog. */
          <SearchOverlay key="search" onClose={closeOverlay} initialTab={overlay === 'saved' ? 'saved' : 'search'} />
        )}
        {overlay === 'settings' && <Settings key="settings" onClose={closeOverlay} />}
        {overlay === 'newChannel' && <NewChannelDialog key="new" onClose={closeOverlay} />}
        {overlay === 'glossary' && <GlossaryPanel key="glossary" onClose={closeOverlay} />}
        {overlay === 'people' && <PeoplePanel key="people" onClose={closeOverlay} />}
        {overlay === 'catchup' && <CatchupPanel key="catchup" onClose={closeOverlay} />}
        {overlay === 'reminders' && <RemindersPanel key="reminders" onClose={closeOverlay} />}
        {overlay === 'team' && <TeamAdmin key="team" onClose={closeOverlay} />}
        {overlay === 'tour' && <Tour key="tour" onClose={closeOverlay} />}
        {overlay === 'tasks' && <TasksBoard key="tasks" onClose={closeOverlay} />}
        {overlay === 'calendar' && <CalendarPanel key="calendar" onClose={closeOverlay} />}
        {overlay === 'files' && <FilesPanel key="files" onClose={closeOverlay} />}
        {overlay === 'protocol' && <ProtocolPanel key="protocol" onClose={closeOverlay} />}
        {overlay === 'ideas' && <IdeaBoard key="ideas" onClose={closeOverlay} />}
        {overlay === 'download' && <DownloadPanel key="download" onClose={closeOverlay} />}
        {overlay === 'fern' && <Fernsteuerung key="fern" onClose={closeOverlay} />}
        {overlay === 'system' && <SystemPanel key="system" onClose={closeOverlay} />}
        {overlay === 'post' && <PostPanel key="post" onClose={closeOverlay} />}
        {overlay === 'postMeldungen' && <PostMeldungen key="postMeldungen" onClose={closeOverlay} />}
        {overlay === 'notizen' && <NotizenPanel key="notizen" onClose={closeOverlay} />}
        {vorschlagFilter && (
          <VorschlagPosteingang
            key="vorschlaege"
            startFilter={vorschlagFilter}
            onClose={() => useVorschlaege.getState().schliessen()}
          />
        )}
        {/* Jede der fünf Tafeln unten ist zusätzlich hinter demselben Recht
            geschützt, das ihren Eintrag im Stern-Menü schaltet (Rail.tsx).
            `xOffen` allein reicht nicht als Wächter: der Laden dahinter lebt
            unabhängig von `self` (siehe deren Dateikopf) und übersteht darum
            auch einen Wechsel des angemeldeten Kontos auf demselben Fenster
            unverändert -- logout() setzt ihn zwar zurück (state/store.ts),
            aber ein Recht hier zu prüfen kostet nichts und fängt jede Lücke
            ab, die dieser Rücksetzung einmal entwischt. */}
        {partnerGruppenOffen && self?.permissions['mail.lesen'] && (
          <PartnerGruppenPanel key="partnerGruppen" onClose={() => usePartnerGruppenUi.getState().schliessen()} />
        )}
        {gedaechtnisOffen && self?.permissions['mail.lesen'] && (
          <PostGedaechtnis key="gedaechtnis" onClose={() => useGedaechtnisUi.getState().schliessen()} />
        )}
        {einmalcodeOffen && self?.permissions['einmalcode.nutzen'] && (
          <EinmalcodePanel key="einmalcode" onClose={() => useEinmalcodeUi.getState().schliessen()} />
        )}
        {passwortOffen && self?.permissions['passwort.nutzen'] && (
          <PasswortPanel key="passwort" onClose={() => usePasswortUi.getState().schliessen()} />
        )}
        {/* Bewusst OHNE Rechteprüfung, anders als alle Tafeln daneben: der
            Notzugang schützt die EIGENEN Notizen und den EIGENEN Tresor, und
            wer Anteile für andere hält, ist irgendwer im Team. Ein Recht
            davorzusetzen hieße, dass eine Person ohne dieses Recht ihre
            eigenen Daten nicht absichern und einem Kollegen nicht helfen
            könnte — beides gehört niemandem sonst. */}
        {notzugangOffen && (
          <NotzugangPanel key="notzugang" onClose={() => useNotzugangUi.getState().schliessen()} />
        )}
        {bankOffen && (self?.permissions['bank.sehen'] || self?.permissions['bank.verwalten']) && (
          <PaypalPanel key="bank" onClose={() => usePaypalUi.getState().schliessen()} />
        )}
        {/* "Ein Kauf ist passiert" — Öffnen-Knopf und Abzeichen sitzen im
            Stern-Menü (Rail.tsx), die Tafel aber ausdrücklich HIER, im
            eingebetteten Fangkorb: ein Fehler beim Zeichnen darf den Chat
            dahinter nicht mitreißen (siehe Begründung in Rail.tsx bei
            `verkaufJuengste`). */}
        {verkaufOffen && self?.permissions['verkauf.sehen'] && (
          <VerkaufMeldungen key="verkaufMeldungen" onClose={() => useVerkaufMeldungenUi.getState().schliessen()} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        <UpdateWillkommen key="neu" />
        {overlay === 'channelSettings' && activeChannelId && (
          /* Kennung je Kanal: ChannelSettings übernimmt Name, Thema und Zweck
             nur beim ersten Zeichnen in den eigenen Zustand. Wechselte der
             Kanal bei offenem Fenster (Klick auf eine Benachrichtigung),
             schrieb das nächste Verlassen eines Felds die Werte des alten
             Kanals in den neuen. */
          <ChannelSettings key={`chset:${activeChannelId}`} channelId={activeChannelId} onClose={closeOverlay} />
        )}
        {overlay === 'poll' && activeChannelId && (
          <PollDialog key="poll" channelId={activeChannelId} onClose={closeOverlay} />
        )}
        {overlay === 'vorfall' && activeChannelId && (
          <VorfallDialog key="vorfall" channelId={activeChannelId} onClose={closeOverlay} />
        )}
        {overlay === 'freigaben' && (
          <FreigabenDialog key="freigaben" channelId={activeChannelId} onClose={closeOverlay} />
        )}
      </AnimatePresence>
      </Fangkorb>

      <AnimatePresence>
        {forwarding && (
          <ForwardDialog key="forward" message={forwarding} onClose={() => useStore.getState().startForward(null)} />
        )}
        {remindingAbout && (
          <ReminderDialog key="remind" message={remindingAbout} onClose={() => useStore.getState().startReminder(null)} />
        )}
        {profileUserId && (
          <ProfileCard key="profile" userId={profileUserId} onClose={() => useStore.getState().setProfileUser(null)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {lightbox && (
          <motion.div
            className="lightbox"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => useStore.getState().setLightbox(null)}
          >
            <motion.img
              src={lightbox}
              alt=""
              initial={{ scale: 0.94 }} animate={{ scale: 1 }} exit={{ scale: 0.94 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <Toasts />
    </>
  );
}
