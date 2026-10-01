import { create } from 'zustand';
import {
  normalizeLang,
  type AiCapabilities, type AiSummary, type Channel, type ChannelState,
  type Draft, type LinkPreview, type Message, type Poll, type Reminder,
  type RewriteTone, type ScheduledMessage, type SearchHit,
  type ClientEvent, type SelfUser, type ServerEvent, type SmartReply, type User, type UserStatus,
  type VoiceNote, type Task, type TaskEvent, type TaskStatus, type CalendarEvent, type Projekt,
  type StoredFile, type StorageUsage, type MeetingProtocol,
  type Idea, type IdeaComment, type IdeaStatus, type ReleaseInfo,
  type Freigabe, type PushSubscriptionJSON, type ReadReceipt, type Notiz,
} from '@stellium/shared';
import { api, serverUrl, setToken, token } from '../net/api.js';
import { socket, type ConnectionState } from '../net/socket.js';
import {
  erlaubnisStand, pushAbonnieren, titelZaehler, vapidSchluesselSetzen, zeigen,
} from '../lib/benachrichtigung.js';
/* Die Schlüsselarbeit hängt sich beim Laden selbst an den Draht. Hier wird sie
   zusätzlich benutzt: verschlüsselt wird auf dem Weg nach draußen, und zwar an
   dieser einen Stelle. Jeder Weg, auf dem Text den Rechner verlässt, führt
   durch sendMessage, editMessage oder schedule — wer eine neue Stelle baut,
   muss sie hier vorbeiführen, sonst weist der Server sie ab. */
import {
  dateiVerschluesseln, istE2EChiffrat, kanalSchluesselWechseln,
  kontoHuelle, nachrichtVerschluesseln,
} from '../lib/vertraulich.js';
import {
  kontoSchluesselAufnehmen, kontoSchluesselEinrichten, kontoSchluesselVergessen,
} from '../lib/kontoschluessel.js';
/* Die drei Vergessens-Funktionen unten: logout() ruft sie, damit keine
   entpackten Schlüssel (Kanäle, Notizen, Tresor) die Abmeldung überleben. */
import { schluesselAllesVergessen } from '../lib/vertraulich.js';
import { notizenVergessen } from '../lib/notizen.js';
import { passwoerterVergessen } from '../lib/passwoerter.js';
import { anmelden, nachweisNachtragen } from '../lib/anmeldenachweis.js';
/* Nur der Typ — die Selbstanbindung an den Draht (dieselbe Bauart wie bei
   lib/vertraulich.ts oben) übernimmt App.tsx, damit sie unabhängig davon
   aktiv ist, ob die Notizen-Tafel in dieser Sitzung je geöffnet wurde. */
import type { NotizKlartext } from '../lib/notizen.js';
/* Fünf eigene, winzige Laden für je eine Tafel (siehe deren Dateikopf: alle
   aus demselben Grund entstanden, store.ts wurde an anderer Stelle
   bearbeitet). logout() unten muss sie trotzdem kennen: ihr `offen` lebt
   unabhängig vom Selbst und überlebt eine Abmeldung sonst unverändert —
   meldet sich auf demselben Fenster gleich darauf ein anderes Konto an,
   ginge dessen Tafel von selbst auf. verkaufMeldungen.ts bringt zusätzlich
   einen laufenden Abruf-Takt und zwischengespeicherte Zeilen mit, die
   genauso wenig zur nächsten Person gehören. */
import { useEinmalcodeUi } from './einmalcode.js';
import { usePaypalUi } from './paypal.js';
import { useGedaechtnisUi } from './gedaechtnis.js';
import { usePartnerGruppenUi } from './partnergruppen.js';
import { useVerkaufMeldungenUi } from './verkaufMeldungen.js';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'ok';
  title: string;
  body?: string;
}

export type Overlay =
  | null | 'quick' | 'search' | 'settings' | 'newChannel' | 'glossary'
  | 'catchup' | 'schedule' | 'people' | 'poll' | 'reminders' | 'models' | 'team'
  | 'channelSettings' | 'tour' | 'tasks' | 'calendar' | 'files' | 'taskExtract' | 'protocol' | 'ideas' | 'download'
  | 'fern' | 'system' | 'post' | 'notizen'
  | 'vorfall' | 'freigaben'
  /** Der Reiter „Post-Sichtung" — was die KI aus eingegangener Firmenpost
      gemacht hat, siehe PostMeldungen.tsx. Neben 'post' und nicht darin
      verschachtelt: beide sind je ein eigener Rundgang durch dieselbe Post. */
  | 'postMeldungen'
  /* Dieselbe Tafel wie 'search' (SearchOverlay), nur gleich auf dem Reiter
     „Gemerkt" statt auf dem Such-Reiter gestartet — siehe App.tsx, wo beide
     Werte dieselbe Komponente rendern, nur mit anderem `initialTab`. */
  | 'saved';

interface PendingRequest<T> { resolve: (value: T) => void; reject: (err: Error) => void; timer: number }

/**
 * Ein Ablage-Upload, wie ihn die Oberfläche verfolgt.
 *
 * Lebt im Zustand und nicht im lokalen Zustand von FilesPanel: schließt man
 * die Ablage, während eine Datei noch hochlädt, darf das den Upload nicht
 * berühren — er läuft in `uploadLibraryFiles()` weiter, unabhängig davon, ob
 * gerade jemand zusieht. Öffnet man die Ablage später wieder, steht der
 * Fortschritt hier immer noch, statt dass die Datei scheinbar nie hochkam.
 */
export interface LibraryUpload {
  id: string;
  name: string;
  size: number;
  anteil: number;
  tempo?: number;
  rest?: number;
  status: 'laeuft' | 'fertig' | 'fehler';
  fehler?: string;
}

interface StoreState {
  /* Verbindung & Identität */
  connection: ConnectionState;
  connectionDetail: string | null;
  booted: boolean;
  self: SelfUser | null;
  ai: AiCapabilities | null;
  /**
   * Warten Notizen und Tresor auf eine Wiederherstellung über den Notzugang?
   *
   * Kommt vom Server (GET /api/konto/schluessel) und wird hier NICHT
   * nachgerechnet: es ist dieselbe Tatsache, mit der der Server einen
   * Ersatzschlüssel abweist (services/kontoschluessel.ts, notzugangWartet()).
   * NotzugangHinweis.tsx zeigt daraufhin den Streifen, der die einzige
   * sichtbare Spur dieses Zustands ist — ohne ihn steht eine gerade
   * zurückgesetzte Person vor leeren Notizen und erfährt nie, dass drei von
   * fünf Kolleginnen sie zurückholen können.
   */
  notzugangWartet: boolean;
  /** Stand, der auf dem Server läuft — für die Aktualisierungsansicht. */
  serverVersion: string | null;
  /** Fassung, die für den Server bereitliegt, aber noch nicht läuft. */
  serverBereitVersion: string | null;

  /* Daten */
  users: Record<string, User>;
  channels: Record<string, Channel>;
  states: Record<string, ChannelState>;
  messages: Record<string, Message[]>;         // channelId -> chronologisch
  hasMore: Record<string, boolean>;
  threads: Record<string, Message[]>;          // parentId -> [root, ...replies]
  scheduled: ScheduledMessage[];
  reminders: Reminder[];
  drafts: Record<string, string>;          // "channelId:parentId" -> Text

  /* Übersetzung */
  translating: Record<string, boolean>;        // messageId -> läuft gerade
  showOriginal: Record<string, boolean>;       // messageId -> Original einblenden
  roundTrips: Record<string, { backTranslation: string; similarity: number }>;

  /* UI */
  tasks: Record<string, Task>;
  /** Projekte — Schubladen für Aufgaben. */
  projekte: Record<string, Projekt>;
  events: Record<string, CalendarEvent>;
  files: StoredFile[];
  storageUsage: StorageUsage | null;
  /** Laufende und zuletzt gescheiterte Ablage-Uploads — siehe LibraryUpload. */
  libraryUploads: LibraryUpload[];
  taskHistory: Record<string, TaskEvent[]>;
  /** Ergebnis der Aufgabenerkennung — sie legt die Aufgaben selbst an. */
  /**
   * Was der Knopf bewirkt hat: so viele Vorschläge liegen jetzt im Eingang.
   *
   * Früher standen hier die gleich angelegten Aufgaben samt Rückgängig. Seit
   * die Erkennung in den Eingang führt, gibt es nichts zurückzunehmen — das
   * Ja ist noch nicht gegeben.
   */
  extractErgebnis: { vorgeschlagen: number; uebersprungen: number } | null;
  extractingTasks: boolean;
  /** Stand der Selbstaktualisierung. Im Browser bleibt er auf 'aus'. */
  update: {
    zustand: 'aus' | 'suche' | 'gefunden' | 'laedt' | 'bereit' | 'installiert' | 'aktuell' | 'fehler';
    version?: string;
    notes?: string | null;
    anteil?: number;
    fehler?: string;
    /** Sekunden bis zur automatischen Installation. */
    restSekunden?: number;
    verschoben?: boolean;
  };
  /**
   * Angekündigte Auszeit des Servers. Die Zeiten sind bereits auf die
   * eigene Uhr umgerechnet — der Server schickt seine mit, damit eine
   * falsch gestellte Uhr hier keinen anderen Countdown ergibt.
   */
  serverUpdate: {
    version: string;
    notes: string | null;
    startetUm: number;
    dauertEtwa: number;
  } | null;
  ideas: Record<string, Idea>;
  ideaComments: Record<string, IdeaComment[]>;
  protocol: MeetingProtocol | null;
  protocolLoading: boolean;
  /**
   * Notizen — Metadaten und Chiffrat, wie der Server sie kennt. Geöffnet und
   * verändert wird über lib/notizen.ts (dieselbe Aufteilung wie bei
   * vertraulichen Kanälen: Metadaten hier, Schlüsselarbeit dort), deshalb
   * keine eigenen Aktionen dafür in diesem Objekt.
   */
  notizen: Record<string, Notiz>;
  /** War notiz:list schon einmal da? Für die Ladeanzeige der Tafel. */
  notizenGeladen: boolean;
  /** Entschlüsselt, sobald der passende Schlüssel da ist — sonst null. */
  notizenKlartext: Record<string, NotizKlartext | null>;
  /**
   * Fehlt der Notizschlüssel länger als die kurze Anlaufzeit, die
   * lib/notizen.ts jedem Entschlüsseln zubilligt? `true` heißt: kein
   * anderes Gerät hat in dieser Zeit geantwortet — die Oberfläche zeigt
   * dann eine erklärende Meldung statt eines endlosen Kreisels (siehe
   * notizen.wirdEntschluesseltNichtMoeglich). Nie gesetzt für Notizen ohne
   * Eintrag hier — nur der kurze Regelfall kurz nach dem Laden.
   */
  notizenSchluesselFehlt: Record<string, boolean>;
  /** Ein Speichern wurde abgelehnt, weil zwischenzeitlich woanders gespeichert wurde. */
  notizKonflikte: Record<string, Notiz>;
  /**
   * Warum das Protokoll nicht zustande kam.
   *
   * Ohne dieses Feld drehte sich der Kreisel weiter, während die Meldung des
   * Servers daneben als Toast aufging: Don sah „StelliumAI schreibt mit…" und
   * „ollama 400 …" gleichzeitig und konnte nur raten, was gilt. Ein Kreisel,
   * der nie aufhört, ist die unehrlichste Anzeige, die es gibt.
   */
  protocolFehler: string | null;
  /** Dasselbe für die Aufgabenerkennung. */
  extractFehler: string | null;
  /** Auf schmalen Geräten liegt die Seitenleiste über dem Chat. */
  schubladeOffen: boolean;
  activeChannelId: string | null;
  /** Zuletzt geöffneter Kanal außerhalb des KI-Reiters. */
  lastHumanChannelId: string | null;
  threadParentId: string | null;
  overlay: Overlay;
  sidebarCollapsed: boolean;
  typing: Record<string, Record<string, number>>;   // channelId -> userId -> ts
  readMarkers: Record<string, string | null>;       // channelId -> Grenze beim Öffnen
  /**
   * Wer eine Nachricht gelesen hat, und wann — messageId -> Liste.
   *
   * Fehlt eine Kennung hier, wurde sie noch nie angefragt (siehe
   * requestReadReceipts); ein leeres Feld heißt „angefragt, noch niemand
   * gelesen". Wird laufend durch eingehende `read`-Meldungen anderer
   * Mitglieder aufgefrischt, ohne dafür erneut nachzufragen.
   */
  readReceipts: Record<string, ReadReceipt[]>;
  /** Zuletzt geöffnete Kanäle, neuester zuerst — für das Aufräumen. */
  zuletztOffen: string[];
  toasts: Toast[];
  smartReplies: SmartReply[];
  smartRepliesLoading: boolean;
  catchup: AiSummary | null;
  catchupLoading: boolean;
  lightbox: string | null;
  searchHits: SearchHit[];

  /* Vertrauliche Kanäle */
  freigaben: Freigabe[];
  /**
   * Zählt hoch, sobald ein Kanalschlüssel dazugekommen ist.
   *
   * Ohne dieses Signal bliebe eine Nachricht „nicht lesbar" stehen, bis jemand
   * den Kanal neu öffnet — die Anzeige hat keine andere Möglichkeit zu
   * erfahren, dass der Schlüssel inzwischen da ist.
   */
  vertraulichTakt: number;
  searching: boolean;
  /** Nachricht, die gerade weitergeleitet werden soll. */
  forwarding: Message | null;
  /** Nachricht, für die eine Erinnerung gesetzt wird. */
  remindingAbout: Message | null;
  /** Profilkarte, die gerade offen ist. */
  profileUserId: string | null;
  /** Nachricht, die kurz hervorgehoben wird (nach Sprung aus der Suche). */
  highlightMessageId: string | null;
  /** Welche Mail der Postfach-Reiter auswählen soll, nach einem Sprung aus
      dem Reiter „Post-Sichtung" (siehe `jumpToPostMail`). PostPanel.tsx liest
      dieses Feld einmal und meldet sich über `postJumpConsumed` wieder ab —
      sonst wählte ein späteres, unabhängiges Öffnen von Postfach dieselbe
      Mail noch einmal aus. */
  postJumpMailId: string | null;
  /** Kanäle, in denen der Assistent gerade eine Antwort formuliert. */
  aiThinking: Record<string, boolean>;
  /** Was die letzte KI-Antwort je Kanal gekostet hat — Marken hinein/heraus. */
  aiVerbrauch: Record<string, { eingabe: number; ausgabe: number; modell: string | null }>;

  /* Aktionen */
  boot: () => Promise<void>;
  login: (login: string, password: string) => Promise<void>;
  logout: () => void;
  /** Beim Server nachfragen, ob eine Wiederherstellung aussteht — siehe
   *  `notzugangWartet` oben. */
  notzugangPruefen: () => Promise<void>;
  /**
   * Zeitzone einmalig vom Browser übernehmen, solange `self.timezoneAuto`
   * steht (siehe SelfUser in @stellium/shared). Ohne Wirkung, wenn schon
   * jemand die Zeitzone bestätigt hat — von Hand in Settings.tsx oder durch
   * einen früheren Aufruf dieser Funktion selbst.
   */
  zeitzoneNachtragen: () => void;

  openChannel: (channelId: string) => void;
  loadOlder: (channelId: string) => void;
  openThread: (parentId: string | null) => void;
  openDm: (userId: string) => void;

  /**
   * Gibt die `clientId` der gesendeten Nachricht zurück — damit ein Anhang,
   * der beim Senden noch nicht fertig war, sie später wiederfindet (siehe
   * `waitForMessageId` weiter unten in dieser Datei).
   */
  sendMessage: (input: {
    channelId: string; text: string; parentId?: string | null; attachmentIds?: string[];
    pendingAttachments?: { tempId: string; name: string; mime: string }[];
  }) => string;
  /** Ein nach dem Senden fertig gewordener Anhang holt seine Nachricht ein. */
  attachUploadToMessage: (messageId: string, tempId: string, attachmentId: string) => void;
  /** Der Upload ist gescheitert oder wurde aufgegeben — nur der Platzhalter fällt weg. */
  giveUpAttachment: (messageId: string, tempId: string) => void;
  editMessage: (messageId: string, text: string) => void;
  deleteMessage: (messageId: string, scope?: 'all' | 'me') => void;
  react: (messageId: string, emoji: string) => void;
  pin: (messageId: string, pinned: boolean) => void;
  save: (messageId: string, saved: boolean) => void;
  schedule: (input: { channelId: string; text: string; sendAt: number; parentId?: string | null }) => void;
  unschedule: (id: string) => void;
  sendTyping: (channelId: string, parentId?: string | null) => void;
  /** Lesebestätigungen für eigene Nachrichten anfragen — gebündelt, siehe Implementierung. */
  requestReadReceipts: (messageIds: string[]) => void;

  toggleOriginal: (messageId: string) => void;
  requestTranslation: (messageId: string, targetLang?: string) => void;
  requestRoundTrip: (messageId: string) => void;
  composePreview: (text: string, targetLang: string, channelId: string) => Promise<string>;

  createChannel: (input: { kind: 'public' | 'private'; name: string; topic?: string; primaryLanguage?: string | null; memberIds?: string[] }) => void;
  joinChannel: (channelId: string) => void;
  leaveChannel: (channelId: string) => void;
  updateChannel: (channelId: string, patch: {
    name?: string; topic?: string; purpose?: string;
    primaryLanguage?: string | null; archived?: boolean; readOnly?: boolean;
  }) => void;
  deleteChannel: (channelId: string) => void;
  hideChannel: (channelId: string) => void;
  setChannelMembers: (channelId: string, add?: string[], remove?: string[]) => void;
  muteChannel: (channelId: string, muted: boolean) => void;
  starChannel: (channelId: string, starred: boolean) => void;

  updatePrefs: (patch: Partial<SelfUser>) => void;
  setStatus: (status: UserStatus, emoji?: string | null, text?: string | null) => void;

  runCatchup: (channelId: string) => void;
  loadSmartReplies: (channelId: string, parentId?: string | null) => void;
  clearSmartReplies: () => void;
  rewrite: (text: string, tone: RewriteTone, targetLang?: string | null) => Promise<string>;
  askChannel: (channelId: string, question: string) => Promise<{ answer: string; citedMessageIds: string[] }>;
  runSearch: (q: string, channelId?: string | null) => Promise<void>;

  ladeFreigaben: (channelId?: string | null) => void;
  freigabeZuruecknehmen: (freigabeId: string) => void;
  /** Nach einem neuen Schlüssel: alles noch einmal entschlüsseln lassen. */
  vertraulichNeuLesen: () => void;

  /* Umfragen */
  createPoll: (input: { channelId: string; question: string; options: string[]; multiple: boolean; anonymous: boolean; parentId?: string | null }) => void;
  votePoll: (pollId: string, optionIds: string[]) => void;
  closePoll: (pollId: string) => void;

  /* Weiterleiten, Erinnern, Entwürfe */
  startForward: (message: Message | null) => void;
  forwardMessage: (messageId: string, toChannelId: string, comment?: string) => void;
  startReminder: (message: Message | null) => void;
  createReminder: (input: { channelId: string; messageId?: string | null; note?: string | null; remindAt: number }) => void;
  cancelReminder: (id: string) => void;
  saveDraft: (channelId: string, parentId: string | null, text: string) => void;
  draftFor: (channelId: string, parentId: string | null) => string;

  /* Sprachnachrichten */
  sendVoice: (input: { channelId: string; attachmentId: string; durationMs: number; parentId?: string | null }) => void;
  retranscribe: (messageId: string) => void;

  /* KI als Gesprächspartner */
  openAiChat: () => void;
  openLastHumanChannel: () => void;
  setSchublade: (offen: boolean) => void;

  loadTasks: (filter?: { channelId?: string; assigneeId?: string }) => void;
  loadProjekte: () => void;
  createProjekt: (input: { name: string; beschreibung?: string | null; farbe?: string }) => void;
  updateProjekt: (projektId: string, patch: {
    name?: string; beschreibung?: string | null; farbe?: string; archiviert?: boolean;
  }) => void;
  deleteProjekt: (projektId: string) => void;
  /** „Passt" — der von der KI angelegte Eintrag ist angesehen. */
  aufgabeGeprueft: (taskId: string) => void;
  ideeGeprueft: (ideaId: string) => void;
  terminGeprueft: (eventId: string) => void;
  kiSelbstEintragen: (an: boolean) => void;
  createTask: (input: {
    title: string; description?: string | null; assigneeId?: string | null;
    channelId?: string | null; dueAt?: number | null; priority?: Task['priority'];
    projektId?: string | null;
  }) => void;
  updateTask: (taskId: string, patch: Partial<Pick<Task,
    'title' | 'description' | 'status' | 'priority' | 'assigneeId' | 'dueAt' | 'channelId' | 'projektId'>>) => void;
  moveTask: (taskId: string, status: TaskStatus, afterId?: string | null) => void;
  commentTask: (taskId: string, text: string) => void;
  watchTask: (taskId: string, watching: boolean) => void;
  deleteTask: (taskId: string) => void;
  loadTaskHistory: (taskId: string) => void;
  extractTasks: (channelId: string) => void;
  clearExtractedTasks: () => void;
  /** Die eben automatisch angelegten Aufgaben wieder entfernen. */
  loadProtocol: (channelId: string) => void;
  clearProtocol: () => void;

  checkForUpdate: () => void;
  installUpdate: () => void;
  postponeUpdate: () => void;
  loadIdeas: () => void;
  createIdea: (input: { title: string; body?: string | null; tag?: string; channelId?: string | null }) => void;
  updateIdea: (ideaId: string, patch: { title?: string; body?: string | null; tag?: string; channelId?: string | null }) => void;
  setIdeaStatus: (ideaId: string, status: IdeaStatus, decision?: string | null) => void;
  voteIdea: (ideaId: string, wert: 1 | -1) => void;
  loadIdeaComments: (ideaId: string) => void;
  commentIdea: (ideaId: string, text: string) => void;
  deleteIdeaComment: (ideaId: string, commentId: string) => void;
  deleteIdea: (ideaId: string) => void;

  loadEvents: (from: number, to: number) => void;
  createEvent: (input: {
    title: string; description?: string | null; kind?: CalendarEvent['kind'];
    startsAt: number; endsAt: number; allDay?: boolean; location?: string | null;
    channelId?: string | null; attendeeIds?: string[];
  }) => void;
  updateEvent: (eventId: string, patch: Partial<Pick<CalendarEvent,
    'title' | 'description' | 'kind' | 'startsAt' | 'endsAt' | 'allDay' | 'location' | 'channelId'>>) => void;
  respondEvent: (eventId: string, response: 'yes' | 'no' | 'maybe') => void;
  deleteEvent: (eventId: string) => void;

  loadFiles: (filter?: { channelId?: string; folder?: string }) => Promise<void>;
  /**
   * Eine oder mehrere Dateien in die Ablage hochladen.
   *
   * Läuft als Store-Aktion und nicht als Funktion in FilesPanel: der
   * Fortschritt landet in `libraryUploads`, nicht in einem lokalen useState —
   * schließt jemand die Ablage mitten im Hochladen, läuft der Upload hier
   * unbeeindruckt weiter, denn der Zustand hängt an keiner Komponente.
   */
  uploadLibraryFiles: (
    files: FileList | File[],
    meta?: { folder?: string; channelId?: string | null; description?: string; privat?: boolean },
  ) => Promise<void>;
  /** Eine fertige oder gescheiterte Zeile aus der Fortschrittsliste nehmen. */
  dismissLibraryUpload: (id: string) => void;
  updateFile: (fileId: string, patch: { name?: string; folder?: string; description?: string | null }) => void;
  deleteFile: (fileId: string) => void;
  openAiTeamChannel: () => void;
  setAiMode: (channelId: string, mode: 'off' | 'mention' | 'always') => void;

  /* Modellwahl */
  selectModels: (input: { quality?: string | null; fast?: string | null; auto?: boolean }) => Promise<void>;
  selectProvider: (input: { anbieter: string | null; baseUrl?: string; model?: string; fastModel?: string }) => Promise<boolean>;

  setProfileUser: (userId: string | null) => void;
  jumpToMessage: (channelId: string, messageId: string) => void;
  /** Postfach-Reiter öffnen und dort direkt diese Mail auswählen — der
      Verweis aus einer Zeile im Reiter „Post-Sichtung". */
  jumpToPostMail: (mailId: string) => void;
  /** PostPanel.tsx meldet sich hiermit ab, nachdem es `postJumpMailId`
      übernommen hat (siehe dort). */
  postJumpConsumed: () => void;
  setOverlay: (overlay: Overlay) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLightbox: (url: string | null) => void;
  toast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

const uid = () => Math.random().toString(36).slice(2, 11);
/* Welche Kanäle gerade eine ältere Seite nachladen. Ohne diese Sperre schickt
   jedes Scroll-Ereignis eine weitere Anfrage mit demselben `before` los. */
const seiteUnterwegs = new Set<string>();

const pending = new Map<string, PendingRequest<any>>();

/**
 * Frist für die langen KI-Aufträge — Protokoll und Aufgabenerkennung.
 *
 * Länger als die übrigen, weil beide den halben Kanal lesen und ein Modell im
 * eigenen Netz dafür Minuten brauchen darf. Endlich muss sie trotzdem sein:
 * ohne Frist wartet die Anzeige für immer, wenn gar nichts mehr kommt — etwa
 * weil die Leitung mitten in der Antwort abgerissen ist.
 */
const KI_FRIST_MS = 90_000;

function awaitReply<T>(requestId: string, timeoutMs = 45_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(ts('toast.aiTimeout')));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
  });
}

function settle(requestId: string, value: unknown, error?: Error): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  if (error) entry.reject(error);
  else entry.resolve(value);
}

/**
 * Eine Anfrage hinausschicken und beim Scheitern sofort aufgeben.
 *
 * `socket.send` puffert nur, was später noch Sinn ergibt — eine KI-Anfrage
 * gehört nicht dazu und fällt bei getrennter Leitung stillschweigend weg.
 * Vorher lief die Anzeige dann in die Frist: eine halbe Minute Kreisel für
 * etwas, das nie losgeschickt wurde. Jetzt sagt sie es sofort.
 */
function frageHinaus(requestId: string, ev: ClientEvent): void {
  if (!socket.send(ev)) settle(requestId, null, new Error(ts('fehler.keineVerbindung')));
}

/**
 * Auf die endgültige Kennung einer gerade gesendeten Nachricht warten.
 *
 * Ein Anhang, der beim Senden noch hochlud, kennt zunächst nur ihre
 * `clientId` — die echte, vom Server vergebene Kennung kommt erst mit
 * `message:new` zurück, und das kann länger dauern als der Upload selbst.
 * Dasselbe Bild wie bei `awaitReply` oben, nur unter einem eigenen
 * Namensraum: eine Nachricht und eine KI-Anfrage sollen sich nicht dieselbe
 * Kennung teilen können, nur weil der Zufall es so wollte.
 */
export function waitForMessageId(clientId: string): Promise<string> {
  return awaitReply<string>(`msg:${clientId}`, 60_000);
}

/**
 * Eine Anfrage stellen und auf ihre Antwort warten — der eine Weg dafür.
 *
 * Öffnet `awaitReply` + `frageHinaus` für Läden außerhalb dieser Datei. Wer
 * einen Kreisel anzeigt, muss ihn auch wieder ausmachen können, und zwar in
 * allen drei Fällen: Antwort da, Fehler da, Leitung weg. Genau daran hing
 * Dons ewiger Kreisel. Ein zweiter Merkspeicher neben `pending` wäre der
 * Anfang derselben Geschichte — der Abbruch bei Verbindungsverlust räumt nur
 * diesen einen ab.
 */
export function anfrage<T>(
  bauen: (requestId: string) => ClientEvent, timeoutMs?: number,
): Promise<T> {
  const requestId = uid();
  const versprechen = awaitReply<T>(requestId, timeoutMs);
  frageHinaus(requestId, bauen(requestId));
  return versprechen;
}

/**
 * Der Protokoll-Auftrag — der einzige KI-Auftrag ohne eigene Kennung.
 *
 * `ai:protocol` trägt im Protokoll (packages/shared) kein `requestId`-Feld,
 * also kann der Server einen Fehler dazu nicht zuordnen: er kommt ohne
 * Kennung herein und lief bisher ins Leere. Deshalb hier ein Merker mit
 * eigener Frist. Er fängt drei Fälle ab, die alle als ewiger Kreisel endeten:
 * ein Fehler ohne Kennung, eine abgerissene Leitung, und gar keine Antwort.
 */
let protokollFrist: number | null = null;
/** Für welchen Kanal das laufende Protokoll angefragt wurde. Ein spätes
    Protokoll für Kanal A stand sonst auf der Tafel von Kanal B. */
let protokollKanal: string | null = null;

/**
 * Die jüngste Anfrage nach Zusammenfassung bzw. Antwortvorschlägen.
 *
 * Eine KI-Antwort darf eine halbe Minute brauchen. Wer in der Zeit den Kanal
 * wechselt und dort neu fragt, bekam sonst, was zuletzt ANKAM, nicht was
 * zuletzt GEFRAGT wurde — die Vorschläge aus Kanal A standen im Schreibfeld
 * von Kanal B, ein Klick schickte sie dorthin.
 */
let catchupAnfrage: string | null = null;
let sucheNr = 0;
let vorschlagAnfrage: string | null = null;

function protokollBeenden(fehler: string | null): boolean {
  if (protokollFrist === null) return false;
  clearTimeout(protokollFrist);
  protokollFrist = null;
  useStore.setState({ protocolLoading: false, protocolFehler: fehler });
  return true;
}

/** Eine Nachricht in allen Kanallisten anfassen — wir wissen nicht immer, wo sie liegt. */
function patchEverywhere(
  messages: Record<string, Message[]>, messageId: string, patch: Partial<Message>,
): Record<string, Message[]> {
  const out: Record<string, Message[]> = {};
  for (const [channelId, list] of Object.entries(messages)) {
    out[channelId] = list.map((m) => (m.id === messageId ? { ...m, ...patch } : m));
  }
  return out;
}

function patchThreads(
  threads: Record<string, Message[]>, messageId: string, patch: Partial<Message>,
): Record<string, Message[]> {
  const out: Record<string, Message[]> = {};
  for (const [parentId, list] of Object.entries(threads)) {
    out[parentId] = list.map((m) => (m.id === messageId ? { ...m, ...patch } : m));
  }
  return out;
}

/** Nachricht in die chronologisch sortierte Liste einfügen bzw. ersetzen. */
/**
 * Wie viele Nachrichten je Kanal im Speicher bleiben.
 *
 * Vorher wuchs die Liste unbegrenzt: wer einen Vormittag lang scrollt, trägt
 * am Abend jede Nachricht des Jahres mit sich herum — samt Anhängen,
 * Vorschauen und Umfragen. Ältere werden beim Hochscrollen ohnehin wieder
 * nachgeladen, sie müssen nicht dauerhaft liegen bleiben.
 */
const NACHRICHTEN_JE_KANAL = 400;

/** Wie viele Kanäle ihre Nachrichten behalten dürfen. */
const KANAELE_IM_GEDAECHTNIS = 6;

/** Auf die jüngsten Einträge kürzen — die ältesten fallen vorne weg. */
function gekuerzt(list: Message[]): Message[] {
  return list.length > NACHRICHTEN_JE_KANAL ? list.slice(-NACHRICHTEN_JE_KANAL) : list;
}

/**
 * Nachrichten von Kanälen vergessen, die lange nicht offen waren.
 *
 * Der zuletzt geöffnete bleibt immer, dazu die fünf davor. Wer zurückwechselt,
 * bekommt sie in einem Wimpernschlag neu vom Server — dafür trägt niemand
 * zwanzig Kanäle im Arbeitsspeicher mit.
 */
function vergessen(
  messages: Record<string, Message[]>,
  zuletzt: string[],
): Record<string, Message[]> {
  const behalten = new Set(zuletzt.slice(0, KANAELE_IM_GEDAECHTNIS));
  if (Object.keys(messages).length <= KANAELE_IM_GEDAECHTNIS) return messages;
  const neu: Record<string, Message[]> = {};
  for (const [id, liste] of Object.entries(messages)) {
    if (behalten.has(id)) neu[id] = liste;
  }
  return neu;
}

/**
 * Gehört die Nachricht in den Verlauf des Kanals?
 *
 * Antworten in einem Thread gehören dorthin nicht: sie stehen im
 * Thread-Bereich, und an der Wurzel im Verlauf steht die Zahl der Antworten.
 * Der Server sieht es genauso — `channelHistory` wählt ausdrücklich nur
 * Nachrichten ohne `parent_id` aus.
 *
 * Ohne diese Frage stand eine Thread-Antwort zusätzlich als eigene neue
 * Nachricht mitten im Verlauf. Auffällig daran war, dass sie beim Neuladen
 * wieder verschwand: der Verlauf kommt dann vom Server, und der hat sie nie
 * mitgeschickt. Der doppelte Eintrag entstand allein hier im Speicher.
 */
function imKanalverlauf(msg: Message): boolean {
  return !msg.parentId;
}

function upsertMessage(list: Message[] | undefined, msg: Message): Message[] {
  const arr = list ? [...list] : [];
  const byId = arr.findIndex((m) => m.id === msg.id);
  if (byId >= 0) {
    arr[byId] = { ...arr[byId], ...msg };
    return arr;
  }
  // Optimistische Variante derselben Nachricht ersetzen
  if (msg.clientId) {
    const optimistic = arr.findIndex((m) => m.clientId === msg.clientId);
    if (optimistic >= 0) { arr[optimistic] = msg; return arr; }
  }
  let i = arr.length;
  while (i > 0 && arr[i - 1].createdAt > msg.createdAt) i--;
  arr.splice(i, 0, msg);
  return arr;
}

/**
 * Markiert die eigene, noch ausstehende Zeile zu einer `clientId` als
 * gescheitert — egal ob sie im Kanalverlauf steht oder in einem Thread.
 *
 * Sucht statt einer Merkliste zu führen (siehe Git-Verlauf: eine solche Liste
 * gab es hier einmal, `nachrichtenOhneEcho`, und sie hatte drei Fehler —
 * falsche Zuordnung bei mehreren gleichzeitig ausstehenden Nachrichten, eine
 * Lücke bei Thread-Antworten, die NIE in `s.messages` stehen, siehe
 * `sendMessage` unten, und keinerlei Aufräumen bei Verbindungsabbruch oder
 * Abmeldung). Der Server sagt inzwischen selbst, welche `clientId` er
 * abgewiesen hat (`error`-Ereignis, packages/shared/src/protocol.ts) — eine
 * Suche über den vorhandenen Zustand ist darum genau genug und kann nichts
 * mehr vergessen: es gibt nichts mehr, das vergessen werden könnte.
 *
 * `m.pending` grenzt gegen die (seltene) Möglichkeit ab, dass eine längst
 * bestätigte Nachricht noch dieselbe `clientId` trägt (der Server spiegelt
 * sie dem eigenen Absender zur Wiedererkennung zurück, siehe `message:new`
 * unten) — nur die vorläufige Zeile darf hier angefasst werden.
 *
 * Gibt zurück, ob überhaupt etwas gefunden wurde: ein alter Server ohne
 * `clientId` auf dem Fehler ruft diese Funktion gar nicht erst auf (siehe
 * `case 'error'`), und eine längst verschwundene Zeile (Kanal seither
 * verlassen, Fenster neu geladen) ist kein Fehlschlag dieser Funktion.
 */
function markMessageFailed(clientId: string): boolean {
  let gefunden = false;
  const treffer = (m: Message) => m.pending && m.clientId === clientId;
  const markiert = (m: Message): Message => (treffer(m)
    ? { ...m, pending: false, failed: true, pendingAttachments: undefined }
    : m);

  useStore.setState((s) => {
    const next: Partial<StoreState> = {};
    for (const [channelId, list] of Object.entries(s.messages)) {
      if (!list.some(treffer)) continue;
      gefunden = true;
      next.messages = { ...(next.messages ?? s.messages), [channelId]: list.map(markiert) };
    }
    for (const [parentId, list] of Object.entries(s.threads)) {
      if (!list.some(treffer)) continue;
      gefunden = true;
      next.threads = { ...(next.threads ?? s.threads), [parentId]: list.map(markiert) };
    }
    return next;
  });
  return gefunden;
}

import {
  dokumentSpracheSetzen, translate, spracheDesSystems, type TranslationKey,
} from '../i18n/kern.js';

/**
 * Die Ablage-Liste noch einmal gegenprüfen, bevor sie in den Zustand geht.
 *
 * Der Server filtert längst richtig (siehe services/files.ts) — das hier ist
 * die zweite Sicherung, nicht die erste. Sie kostet fast nichts und fängt
 * genau die Art von Fehler ab, die am schwersten wieder auffällt: eine
 * private Datei, die aus irgendeinem Grund — ein alter Zustand, der beim
 * Kontowechsel nicht geleert wurde, ein künftiger Fehler an anderer Stelle —
 * doch im Antwort- oder Ereignisstrom landet, zeigt sich trotzdem nie in der
 * Liste einer Person, der sie nicht gehört.
 */
function nurSichtbareDateien(files: StoredFile[], selfId: string | undefined): StoredFile[] {
  return files.filter((f) => !f.privat || f.uploadedBy === selfId);
}

/**
 * Meldungen aus dem Zustand in der Sprache der angemeldeten Person.
 *
 * Bewusst über den Kern statt über i18n/index: der lädt den Zustand, und ein
 * Ringschluss zwischen beiden wäre nur eine Frage der Zeit.
 */
function ts(key: TranslationKey, werte?: Record<string, string | number>): string {
  return translate(useStore.getState().self?.uiLanguage || spracheDesSystems(), key, werte);
}

/**
 * Sieht dieser Text nach Maschine aus statt nach Mensch?
 *
 * Anlass: `ollama 400: {"error":{"code":400,"message":"request (10340 tokens)
 * exceeds the available context size (8192 tokens)…` stand so im
 * Meldungsfenster — auf Englisch, mit geschweiften Klammern, bei einer Person
 * mit deutscher Oberfläche. Das ist kein Satz, den jemand lesen soll; es ist
 * die Ausgabe eines fremden Dienstes, unverändert durchgereicht.
 *
 * Erkannt wird deshalb, was nach Maschine aussieht: JSON, ein Statuscode
 * hinter einem Dienstnamen, oder schiere Länge. Diese Texte verschwinden
 * nicht — sie rutschen nur aus der Überschrift in die Einzelheiten.
 */
function nachMaschine(text: string): boolean {
  return /[{[]"|"\s*:\s*[{["]|^\S+\s+\d{3}\s*:/.test(text) || text.length > 300;
}

/** Lange Maschinenausgabe auf ein Maß kürzen, das in eine Meldung passt. */
function gekuerzterText(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/**
 * Meldung des Servers in der eingestellten Sprache — getrennt in den Satz für
 * Menschen und die rohe Ausgabe.
 *
 * Dieselbe Machart wie bei den HTTP-Fehlern in net/api.ts: kennt das
 * Wörterbuch die Kennung, gilt der eigene Satz. Kennt es sie nicht, bleibt
 * der Text des Servers stehen — aber nur, solange er wie ein Satz aussieht.
 * Sobald der Server eine Kennung für einen Fall mitschickt, gilt sie ohne
 * weiteres Zutun; das ist der Weg, auf dem eine neue Meldung übersetzt
 * ankommt, ohne dass hier etwas geändert werden müsste.
 */
function serverMeldung(
  code: string | undefined, ersatz: string, werte?: Record<string, string>,
): { satz: string; roh: string | null } {
  if (code) {
    const eigener = ts(code as TranslationKey, werte);
    if (eigener && eigener !== code) return { satz: eigener, roh: null };
  }
  if (nachMaschine(ersatz)) return { satz: ts('fehler.technisch'), roh: gekuerzterText(ersatz) };
  return { satz: ersatz, roh: null };
}

/**
 * Was in diesem Kanal nach draußen gehen darf.
 *
 * In einem gewöhnlichen Kanal der Text selbst, in einem vertraulichen das
 * Chiffrat — und `null`, wenn sich nicht verschlüsseln lässt. Null heißt:
 * nicht senden. Der Klartext still durchzureichen wäre die eine Möglichkeit,
 * die es hier nicht geben darf; der Server wiese ihn ab, aber schon hier
 * abzubrechen ist die ehrlichere Stelle.
 */
async function hinausText(channelId: string, text: string): Promise<string | null> {
  const kanal = useStore.getState().channels[channelId];
  if (!kanal?.vertraulich || !text) return text;
  try {
    return await nachrichtVerschluesseln(channelId, text);
  } catch (fehler) {
    useStore.getState().toast({
      kind: 'error', title: ts('vertraulich.titel'), body: (fehler as Error).message,
    });
    return null;
  }
}

/** In welchem Kanal liegt diese Nachricht? Aus dem, was geladen ist. */
function kanalDerNachricht(messageId: string): string | null {
  const s = useStore.getState();
  for (const [channelId, liste] of Object.entries(s.messages)) {
    if (liste.some((m) => m.id === messageId)) return channelId;
  }
  for (const liste of Object.values(s.threads)) {
    const treffer = liste.find((m) => m.id === messageId);
    if (treffer) return treffer.channelId;
  }
  return null;
}

/* ── Konto-Zustand ──────────────────────────────────────────── */

/**
 * Alles, was zu einem Konto gehört — beim Start der Anfang, bei der
 * Abmeldung die Rücksetzung.
 *
 * Aus zwei Gründen an EINEM Ort statt zweier handgeschriebener Listen:
 *
 *   1. Die Abmeldung muss dasselbe leeren, was das Anmelden füllt — Feld für
 *      Feld. Zwei getrennte Listen drifteten auseinander: Jedes neue Feld
 *      landete im Anfang, aber nicht zwangsläufig im Logout, und das Konto
 *      des Nächsten auf demselben Fenster erbte Reste des Vorigen. Betroffen
 *      waren zuletzt die entschlüsselten Notizen (`notizenKlartext`), die
 *      Entwürfe (`drafts` — fremder halb geschriebener Text in eigenen
 *      Kanälen), die Bretter (`tasks`, `ideas`, `events`, `projekte`),
 *      Erinnerungen, Freigaben, KI-Verbrauch und das offene Bild (`lightbox`).
 *
 *   2. Der Compiler zählt mit: fehlt in der Fabrik ein Feld aus `Pick`, meckert
 *      er — ein vergessenes Feld im Logout-`set()` blieb dagegen stumm.
 *
 * Bewusst NICHT hier drin: Verbindung (`connection`, `booted`), Fenster-
 * Einstellungen (`schubladeOffen`, `sidebarCollapsed`), Meldungen (`toasts`)
 * und Server-Stand (`update`, `serverUpdate`, Versionen) — die gehören zum
 * Gerät bzw. zum Server, nicht zum Konto.
 */
type KontoFelder =
  | 'self' | 'ai' | 'notzugangWartet'
  | 'users' | 'channels' | 'states' | 'messages' | 'hasMore' | 'threads'
  | 'scheduled' | 'reminders' | 'drafts'
  | 'translating' | 'showOriginal' | 'roundTrips'
  | 'tasks' | 'projekte' | 'events' | 'files' | 'storageUsage' | 'libraryUploads'
  | 'taskHistory' | 'extractErgebnis' | 'extractingTasks' | 'extractFehler'
  | 'ideas' | 'ideaComments' | 'protocol' | 'protocolLoading' | 'protocolFehler'
  | 'notizen' | 'notizenGeladen' | 'notizenKlartext' | 'notizenSchluesselFehlt'
  | 'notizKonflikte'
  | 'activeChannelId' | 'lastHumanChannelId' | 'threadParentId' | 'overlay'
  | 'typing' | 'readMarkers' | 'readReceipts' | 'zuletztOffen'
  | 'smartReplies' | 'smartRepliesLoading' | 'catchup' | 'catchupLoading'
  | 'lightbox' | 'searchHits' | 'searching' | 'freigaben' | 'vertraulichTakt'
  | 'forwarding' | 'remindingAbout' | 'profileUserId' | 'highlightMessageId'
  | 'postJumpMailId' | 'aiThinking' | 'aiVerbrauch';

function kontoZustand(): Pick<StoreState, KontoFelder> {
  return {
    self: null,
    ai: null,
    notzugangWartet: false,

    users: {},
    channels: {},
    states: {},
    messages: {},
    hasMore: {},
    threads: {},
    scheduled: [],
    reminders: [],
    drafts: {},

    translating: {},
    showOriginal: {},
    roundTrips: {},

    tasks: {},
    projekte: {},
    events: {},
    files: [],
    storageUsage: null,
    libraryUploads: [],
    taskHistory: {},
    extractErgebnis: null,
    extractingTasks: false,
    extractFehler: null,
    ideas: {},
    ideaComments: {},
    protocol: null,
    protocolLoading: false,
    protocolFehler: null,
    notizen: {},
    notizenGeladen: false,
    notizenKlartext: {},
    notizenSchluesselFehlt: {},
    notizKonflikte: {},
    activeChannelId: null,
    lastHumanChannelId: null,
    threadParentId: null,
    overlay: null,
    typing: {},
    readMarkers: {},
    readReceipts: {},
    zuletztOffen: [],
    smartReplies: [],
    smartRepliesLoading: false,
    catchup: null,
    catchupLoading: false,
    lightbox: null,
    searchHits: [],
    searching: false,
    freigaben: [],
    vertraulichTakt: 0,
    forwarding: null,
    remindingAbout: null,
    profileUserId: null,
    highlightMessageId: null,
    postJumpMailId: null,
    aiThinking: {},
    aiVerbrauch: {},
  };
}

export const useStore = create<StoreState>((set, get) => ({
  connection: 'idle',
  connectionDetail: null,
  booted: false,
  ...kontoZustand(),
  serverVersion: null,
  serverBereitVersion: null,
  update: { zustand: 'aus' },
  serverUpdate: null,
  schubladeOffen: false,
  sidebarCollapsed: false,
  toasts: [],

  /* ── Start ──────────────────────────────────────────────── */

  boot: async () => {
    if (!token()) { set({ booted: true }); return; }
    try {
      const { user, ai } = await api.me();
      set({ self: user, ai });
      applyTheme(user.theme, user.density);
      /* Den Kontoschlüssel von der letzten Anmeldung wieder aufnehmen — ohne
         Passwort geht hier nichts Neues, das gibt es beim Start nicht (siehe
         lib/kontoschluessel.ts). Findet sich keiner, bleibt es beim
         Geräteweg, bis diese Person sich das nächste Mal anmeldet. */
      kontoSchluesselAufnehmen(user.id);
      /* Und nachfragen, ob eine Wiederherstellung aussteht. Nicht nur nach
         einer Anmeldung: der schonende Zustand überlebt jeden Neustart der
         App, und ein Streifen, der nur einmal nach dem Anmelden erscheint,
         wäre beim zweiten Öffnen des Fensters wieder verschwunden — mitsamt
         dem einzigen Hinweis darauf, dass die eigenen Notizen zu retten
         sind. Ohne await: der Start soll darauf nicht warten. */
      void get().notzugangPruefen();
      socket.connect();
      // Jeder App-Start ist auch ein "Anmelden" im Sinne der Zeitzone: gerade
      // bestehende Konten öffnen die App meist über ein gültiges Token, ohne
      // je login() zu durchlaufen — siehe zeitzoneNachtragen() weiter unten.
      get().zeitzoneNachtragen();
      const t = token();
      if (t) void window.stellium?.updateSignIn?.(serverUrl(), t);
    } catch (fehler) {
      /* Nur ein abgelehnter Nachweis heißt „abmelden". Ein 500er oder ein
         kurz nicht erreichbarer Server ist kein Grund, den Zugang wegzuwerfen —
         sonst steht man nach jedem Serverneustart wieder vor der Anmeldung. */
      const status = (fehler as { status?: number }).status;
      if (status === 401 || status === 403) {
        setToken(null);
        set({ self: null });
      }
    } finally {
      set({ booted: true });
    }
  },

  login: async (login, password) => {
    /* Über anmelden() statt api.login(): der Weg ohne Passwort zuerst, der
       alte als Auffangnetz — siehe lib/anmeldenachweis.ts. Für alles, was
       danach kommt, ändert sich dabei NICHTS. `password` ist unverändert
       dasselbe Klartextpasswort aus dem Anmeldefeld; es geht nur nicht mehr
       über die Leitung. */
    const { token: t, user, ueberNachweis } = await anmelden(login, password);
    setToken(t);
    set({ self: user });
    applyTheme(user.theme, user.density);
    /* HIER und nur an den drei Stellen mit Passwort im Klartext (Anmeldung,
       Ersteinrichtung, Passwortwechsel) entsteht der Kontoschlüssel — der
       Schlüssel, der einem KONTO gehört statt einem Gerät und der eine auf
       dem Mac angelegte Notiz auf dem Handy aufgehen lässt.

       DIESE ZEILE IST DIE GEFÄHRLICHSTE STELLE DES UMBAUS und sie steht
       deshalb wortgleich da wie vorher: `password`, nicht der Nachweis.
       Der Kontoschlüssel-KEK wird aus dem PASSWORT abgeleitet (PBKDF2 mit
       eigenem Salz und 600.000 Runden, siehe lib/kontoschluessel.ts).
       Käme hier statt des Passworts irgendetwas anderes an, ginge die
       bestehende Hülle nicht mehr auf, die App legte einen NEUEN
       Kontoschlüssel an, der Server zählte die Fassung hoch und räumte
       dabei jedes Notiz-Kontopaket weg. Der Nachweis ist eine ANDERE
       Ableitung aus demselben Passwort und darf hier nie hin.

       Vor socket.connect(): der Draht bringt gleich nach `ready` die
       Notizpakete mit, und der Kontoweg soll dann schon stehen. Das kostet
       einen Augenblick (PBKDF2), aber genau einmal je Anmeldung.

       Ein Fehlschlag hält die Anmeldung nicht auf — die Funktion fängt ihn
       selbst und meldet nur, ob es geklappt hat. */
    await kontoSchluesselEinrichten(user.id, password);
    /* Steht die Passworthülle nicht mehr, aber ein Notzugang schon, dann
       hat kontoSchluesselEinrichten() bewusst KEINEN neuen Schlüssel
       gemintet (vierter Ausgang dort) — und genau dann muss der Streifen
       erscheinen. */
    void get().notzugangPruefen();
    /* Ging die Anmeldung über den alten Weg, hat der Server das Passwort
       gerade gesehen. Dann jetzt den Nachweis hinterlegen, damit es das
       nächste Mal nicht mehr passiert — die Umstellung geschieht von selbst
       und niemand muss davon wissen. Wirft nie und wird nicht abgewartet:
       eine gelungene Anmeldung darf daran nicht mehr scheitern. */
    if (!ueberNachweis) void nachweisNachtragen(login, password);
    socket.connect();
    get().zeitzoneNachtragen();
    // Ab jetzt darf der Hauptprozess nach neuen Versionen sehen.
    void window.stellium?.updateSignIn?.(serverUrl(), t);
  },

  /**
   * Zeitzone einmalig vom Browser übernehmen — siehe ausführliche Begründung
   * bei timezoneAuto in @stellium/shared (types.ts) und bei der Spalte
   * timezone_auto in migrate.ts/schema.sql.
   *
   * `createAccount()` in services/users.ts setzt beim Anlegen durch die
   * Leitung immer 'Europe/Berlin' — die Leitung kann von dort aus nicht
   * wissen, wo die angelegte Person sitzt, und Setup.tsx fragte bisher nur
   * die Sprache ab. Der Browser kennt die echte Zeitzone über
   * Intl.DateTimeFormat().resolvedOptions().timeZone; diese Funktion holt sie
   * nach, aber NUR, solange `timezoneAuto` steht. Danach schreibt updatePrefs()
   * unten denselben Weg, den auch die Zeitzonenliste in Settings.tsx nutzt —
   * der Server (ws/gateway.ts, prefs:update) setzt timezoneAuto bei jedem
   * Schreibzugriff auf false, ganz gleich ob durch diese Funktion oder von
   * Hand. Ab dann läuft dieser Aufruf hier für immer wirkungslos: eine
   * bestätigte Zeitzone soll nicht bei jeder Dienstreise wieder springen.
   */
  zeitzoneNachtragen: () => {
    const self = get().self;
    if (!self || !self.timezoneAuto) return;
    let erkannt = '';
    try {
      erkannt = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return; // kein verlässlicher Wert vom Browser -> lieber nichts eintragen
    }
    if (!erkannt || erkannt === self.timezone) return;
    get().updatePrefs({ timezone: erkannt });
  },

  notzugangPruefen: async () => {
    try {
      const { notzugangWartet } = await api.kontoSchluessel();
      set({ notzugangWartet: Boolean(notzugangWartet) });
    } catch {
      /* Kein Netz, oder der Einrichtungsriegel steht noch (ein Konto mit
         offener Ersteinrichtung kommt an diesen Weg nicht heran, siehe
         server/index.ts). Beides ist kein Grund, etwas zu behaupten — der
         Streifen bleibt, wie er war, und die nächste Anmeldung fragt neu. */
    }
  },

  logout: () => {
    socket.disconnect();
    setToken(null);
    /* Dieselbe Lücke wie bei `files` weiter unten, nur schwerer wiegend: der
       Kontoschlüssel des sich abmeldenden Kontos hat auf diesem Gerät nichts
       mehr verloren. */
    kontoSchluesselVergessen();
    /* Derselbe Grund, eine Ebene tiefer: der gesprochene Wiederherstellungs-
       Code liegt NICHT hier im Renderer, sondern im Hauptprozess
       (electron/main.ts, `notzugangCode`) — je Anfragekennung, nicht je
       Konto. Ohne diesen Aufruf überlebte er die Abmeldung: meldet sich auf
       demselben Fenster ein anderes Konto an, das zufällig einen Anteil an
       DERSELBEN offenen Anfrage hält, bekäme `aufgaben` dieselbe
       Anfragekennung genannt — und ein einziger Bridge-Aufruf läse den Code
       der vorigen Person aus. Begrenzter Schaden (der Code allein öffnet
       nichts, ein Anteil ist einer von dreien), aber ein Geheimnis, das
       seine Sitzung überlebt, ist eines zu viel. Ohne Wirkung im Browser —
       dort gibt es die Brücke nicht, und `vergessen` ist dann `undefined`. */
    void window.stellium?.notzugangCode?.vergessen();
    void window.stellium?.updateSignOut?.();
    /* Ein Satz statt einer Aufzählung: `kontoZustand()` ist dieselbe Fabrik,
       aus der auch der Anfangszustand kommt — alles, was zum Konto gehört,
       geht auf den Anfang zurück, nichts davon bleibt für das nächste Konto
       auf diesem Fenster stehen. Das waren früher einzelne, nach und nach
       ergänzte Zeilen (Ablage, Notzugang-Streifen), und genau diese Art von
       Liste vergisst beim nächsten neuen Feld etwas — etwa die
       entschlüsselten Notizen, die Entwürfe oder die Bretter. */
    set(kontoZustand());
    /* Und die Schlüssel selbst, nicht nur ihre Klartexte im Store: die
       entpackten Kanal-, Notiz- und Tresorschlüssel leben in den lib-Modulen
       und würden sonst die Abmeldung überleben — mit ihnen ließe sich der
       verschlüsselte Bestand des abgemeldeten Kontos weiter öffnen. */
    schluesselAllesVergessen();
    notizenVergessen();
    passwoerterVergessen();
    /* Die fünf Tafeln mit eigenem Laden (Einmalcode, Bank, Gedächtnis,
       Briefpartner-Gruppen, Verkaufsmeldungen): ihr `offen` steht nicht im
       Store, weil es dort gar nicht lebt. Ohne diese Zeilen bliebe eine offen
       gelassene Tafel offen, meldete sich auf demselben Fenster gleich
       darauf ein anderes Konto an — dessen Bildschirm ginge fremd auf,
       fehlt der Person das Recht dafür sogar mit einer Fehlermeldung für
       eine Tafel, die sie im eigenen Menü nie zu sehen bekäme. */
    useEinmalcodeUi.getState().schliessen();
    usePaypalUi.getState().schliessen();
    useGedaechtnisUi.getState().schliessen();
    usePartnerGruppenUi.getState().schliessen();
    useVerkaufMeldungenUi.getState().zuruecksetzen();
  },

  /* ── Kanäle ─────────────────────────────────────────────── */

  openChannel: (channelId) => {
    const state = get().states[channelId];
    const kanal = get().channels[channelId];
    // Merken, wo der Chat-Reiter zuletzt stand. Die beiden KI-Oberflächen
    // gehören zum KI-Reiter und zählen dafür nicht.
    const istKi = kanal
      && ((kanal.kind === 'dm' && get().users[kanal.dmPeerId ?? '']?.role === 'bot')
        || (kanal.kind === 'public' && kanal.name === 'ki-team'));
    set((s) => ({
      lastHumanChannelId: istKi ? s.lastHumanChannelId : channelId,
      // Auf dem Telefon liegt die Liste über dem Chat; nach der Wahl gehört
      // sie weg, sonst sieht man nicht, was man gerade geöffnet hat.
      schubladeOffen: false,
      activeChannelId: channelId,
      threadParentId: null,
      smartReplies: [],
      catchup: null,
      readMarkers: { ...s.readMarkers, [channelId]: state?.lastReadMessageId ?? null },
      zuletztOffen: [channelId, ...s.zuletztOffen.filter((id) => id !== channelId)],
      // Was lange niemand angesehen hat, muss nicht im Speicher bleiben.
      messages: vergessen(s.messages, [channelId, ...s.zuletztOffen.filter((id) => id !== channelId)]),
    }));
    socket.send({ t: 'channel:open', channelId, limit: 50 });
  },

  loadOlder: (channelId) => {
    const list = get().messages[channelId];
    if (!list?.length || !get().hasMore[channelId]) return;
    /* Beim Scrollen feuert dieser Aufruf im Dutzend, und alle Anfragen tragen
       dasselbe `before`. Jede Antwort ersetzte den Verlauf — die spätere warf
       weg, was die frühere schon nachgeladen hatte. Eine Seite zur Zeit. */
    if (seiteUnterwegs.has(channelId)) return;
    seiteUnterwegs.add(channelId);
    socket.send({ t: 'channel:open', channelId, before: list[0].id, limit: 50 });
  },

  openThread: (parentId) => {
    set({ threadParentId: parentId, smartReplies: [] });
    if (parentId) socket.send({ t: 'thread:open', messageId: parentId });
  },

  openDm: (userId) => {
    set({ overlay: null });
    socket.send({ t: 'dm:open', userId });
  },

  /* ── Nachrichten ────────────────────────────────────────── */

  sendMessage: ({ channelId, text, parentId, attachmentIds, pendingAttachments }) => {
    const self = get().self;
    if (!self) return '';
    const clientId = uid();

    // Optimistisch anzeigen — fühlt sich sofort an, auch bei langsamer Leitung.
    const optimistic: Message = {
      id: `tmp_${clientId}`, channelId, userId: self.id, parentId: parentId ?? null,
      text, sourceLang: null, createdAt: Date.now(), editedAt: null, deletedAt: null,
      systemKind: null, attachments: [], reactions: [], replyCount: 0, lastReplyAt: null,
      threadParticipantIds: [], mentionUserIds: [], pinned: false, translation: null,
      kind: 'text', forwardedFrom: null, poll: null, voice: null, links: [],
      pending: true, clientId,
      ...(pendingAttachments?.length ? { pendingAttachments } : {}),
    };

    set((s) => {
      const next: Partial<StoreState> = {};
      if (imKanalverlauf(optimistic)) {
        next.messages = { ...s.messages, [channelId]: gekuerzt(upsertMessage(s.messages[channelId], optimistic)) };
      }
      if (parentId && s.threads[parentId]) {
        next.threads = { ...s.threads, [parentId]: upsertMessage(s.threads[parentId], optimistic) };
      }
      return next;
    });

    /* Der optimistische Eintrag oben trägt den Klartext — er ist für dieses
       Fenster und geht nirgendwohin. Nach draußen geht, was hier entsteht. */
    void (async () => {
      const hinaus = await hinausText(channelId, text);
      if (hinaus === null) {
        /* Nicht verschlüsselbar: die Nachricht bleibt sichtbar stehen und ist
           als gescheitert markiert. Offen hinausschicken wäre das Gegenteil
           dessen, wofür jemand den Kanal vertraulich gestellt hat.
           `markMessageFailed` statt eines eigenen, auf `s.messages[channelId]`
           begrenzten Updates: eine Thread-Antwort steht nie dort (siehe oben,
           `imKanalverlauf`), sondern ausschließlich in `s.threads[parentId]`
           — dieselbe Lücke, die die Fehlerbehandlung unten hatte, hätte sich
           hier sonst ein zweites Mal eingeschlichen. */
        markMessageFailed(clientId);
        return;
      }
      /* Ein vertraulicher Kanal bekommt keine Platzhalter-Namen zu sehen: die
         echten stehen erst im Umschlag der fertigen Datei, und ein Klartext-
         Name für "kommt noch" wäre genau die Zusage, die dieser Kanal nicht
         geben soll. Wer dort mitschreibt, sieht die Nachricht deshalb erst
         vollständig, wenn message:attach sie nachträgt — die sendende Person
         hat ihren eigenen, lokalen Platzhalter trotzdem (siehe optimistic
         oben, das geht nirgendwohin). */
      const kanal = get().channels[channelId];
      const delivered = socket.send({
        t: 'message:send', clientId, channelId, text: hinaus,
        parentId: parentId ?? null, attachmentIds,
        pendingAttachments: kanal?.vertraulich ? undefined : pendingAttachments,
      });
      if (!delivered) {
        get().toast({ kind: 'info', title: ts('toast.offline'), body: ts('toast.offlineBody') });
      }
    })();

    return clientId;
  },

  attachUploadToMessage: (messageId, tempId, attachmentId) => {
    socket.send({ t: 'message:attach', messageId, tempId, attachmentId });
  },
  giveUpAttachment: (messageId, tempId) => {
    socket.send({ t: 'message:attachGiveUp', messageId, tempId });
  },

  editMessage: (messageId, text) => {
    void (async () => {
      /* Eine Bearbeitung darf eine verschlüsselte Nachricht nicht in eine
         offene verwandeln — der Server weist das ohnehin ab. Der Kanal steht
         nicht im Aufruf und wird hier nachgeschlagen. */
      const channelId = kanalDerNachricht(messageId);
      const hinaus = channelId ? await hinausText(channelId, text) : text;
      if (hinaus === null) return;
      socket.send({ t: 'message:edit', messageId, text: hinaus });
    })();
  },
  deleteMessage: (messageId, scope = 'all') =>
    socket.send({ t: 'message:delete', messageId, scope }) as unknown as void,
  react: (messageId, emoji) => socket.send({ t: 'message:react', messageId, emoji }) as unknown as void,
  pin: (messageId, pinned) => socket.send({ t: 'message:pin', messageId, pinned }) as unknown as void,
  save: (messageId, saved) => {
    /* Erst hinausschicken, dann bestätigen.
       `socket.send` puffert nur, was später noch Sinn ergibt — „gemerkt"
       gehört nicht dazu und fiel bei getrennter Leitung stillschweigend weg.
       Die Bestätigung ging trotzdem auf: die Oberfläche behauptete etwas, das
       nie passiert ist, und nach dem nächsten Laden war die Nachricht wieder
       nicht gemerkt. */
    if (!socket.send({ t: 'message:save', messageId, saved })) {
      get().toast({ kind: 'error', title: ts('toast.offline'), body: ts('fehler.keineVerbindung') });
      return;
    }
    get().toast({ kind: 'ok', title: saved ? ts('common.saved') : ts('toast.unsaved') });
  },

  schedule: ({ channelId, text, sendAt, parentId }) => {
    /* Schon beim Planen verschlüsseln, nicht erst beim Absenden: sonst läge
       der Text bis dahin offen auf dem Server. */
    void (async () => {
      const hinaus = await hinausText(channelId, text);
      if (hinaus === null) return;
      socket.send({ t: 'message:schedule', channelId, text: hinaus, sendAt, parentId: parentId ?? null });
    })();
    set({ overlay: null });
  },
  unschedule: (id) => socket.send({ t: 'message:unschedule', scheduledId: id }) as unknown as void,

  sendTyping: (() => {
    let last = 0;
    return (channelId: string, parentId?: string | null) => {
      const now = Date.now();
      if (now - last < 2500) return;      // nicht bei jedem Tastendruck funken
      last = now;
      socket.send({ t: 'typing', channelId, parentId: parentId ?? null });
    };
  })(),

  /**
   * Lesebestätigungen anfragen — gebündelt, damit ein Kanal mit vielen
   * eigenen Nachrichten nicht eine Anfrage pro Nachricht auslöst (dieselbe
   * Überlegung wie bei sendTyping, nur als Sammler statt als Sperrfrist).
   *
   * Einmal angefragt, wird nicht erneut angefragt: der Stand bleibt danach
   * über eingehende `read`-Meldungen frisch (siehe case 'read' oben), ohne
   * weitere Anfragen. Kennungen, die nicht dem Server-Muster "m_…" folgen
   * (z.B. eine gerade erst optimistisch angezeigte eigene Nachricht), gehen
   * gar nicht erst hinaus — für sie gibt es serverseitig ohnehin nichts zu
   * finden.
   */
  requestReadReceipts: (() => {
    const angefragt = new Set<string>();
    let sammlung: string[] = [];
    let timer: number | null = null;
    const senden = () => {
      timer = null;
      if (!sammlung.length) return;
      const messageIds = sammlung;
      sammlung = [];
      socket.send({ t: 'message:read-receipts', messageIds });
    };
    return (messageIds: string[]) => {
      const cache = get().readReceipts;
      for (const id of messageIds) {
        if (!id.startsWith('m_') || cache[id] !== undefined || angefragt.has(id)) continue;
        angefragt.add(id);
        sammlung.push(id);
      }
      if (sammlung.length && timer == null) timer = window.setTimeout(senden, 200);
    };
  })(),

  /* ── Übersetzung ────────────────────────────────────────── */

  toggleOriginal: (messageId) =>
    set((s) => ({ showOriginal: { ...s.showOriginal, [messageId]: !s.showOriginal[messageId] } })),

  requestTranslation: (messageId, targetLang) => {
    const lang = targetLang ?? get().self?.language ?? 'en';
    set((s) => ({ translating: { ...s.translating, [messageId]: true } }));
    socket.send({ t: 'translate:request', messageId, targetLang: normalizeLang(lang), force: Boolean(targetLang) });
  },

  requestRoundTrip: (messageId) => {
    const lang = get().self?.language ?? 'en';
    socket.send({ t: 'translate:roundtrip', messageId, targetLang: normalizeLang(lang) });
  },

  composePreview: async (text, targetLang, channelId) => {
    const requestId = uid();
    const promise = awaitReply<string>(requestId, 20_000);
    frageHinaus(requestId, { t: 'compose:preview', requestId, text, targetLang, channelId });
    return promise;
  },

  createChannel: (input) => {
    socket.send({
      t: 'channel:create', kind: input.kind, name: input.name, topic: input.topic,
      primaryLanguage: input.primaryLanguage ?? null, memberIds: input.memberIds,
    });
    set({ overlay: null });
  },
  joinChannel: (channelId) => socket.send({ t: 'channel:join', channelId }) as unknown as void,
  leaveChannel: (channelId) => {
    socket.send({ t: 'channel:leave', channelId });
    if (get().activeChannelId === channelId) set({ activeChannelId: null });
  },
  updateChannel: (channelId, patch) => socket.send({ t: 'channel:update', channelId, ...patch }) as unknown as void,

  deleteChannel: (channelId) => {
    socket.send({ t: 'channel:delete', channelId });
    if (get().activeChannelId === channelId) set({ activeChannelId: null });
  },
  hideChannel: (channelId) => {
    socket.send({ t: 'channel:hide', channelId });
    if (get().activeChannelId === channelId) set({ activeChannelId: null });
  },
  setChannelMembers: (channelId, add = [], remove = []) =>
    socket.send({ t: 'channel:members', channelId, add, remove }) as unknown as void,
  muteChannel: (channelId, muted) => socket.send({ t: 'channel:mute', channelId, muted }) as unknown as void,
  starChannel: (channelId, starred) => socket.send({ t: 'channel:star', channelId, starred }) as unknown as void,

  updatePrefs: (patch) => {
    const self = get().self;
    if (self) {
      const merged = { ...self, ...patch };
      set({ self: merged });
      applyTheme(merged.theme, merged.density);
    }
    socket.send({ t: 'prefs:update', patch: patch as any });
  },

  setStatus: (status, emoji, text) =>
    socket.send({ t: 'presence:set', status, statusEmoji: emoji, statusText: text }) as unknown as void,

  /* ── KI ─────────────────────────────────────────────────── */

  runCatchup: (channelId) => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? ts('toast.aiOffBody') });
      return;
    }
    const requestId = uid();
    catchupAnfrage = requestId;
    set({ catchupLoading: true, overlay: 'catchup', catchup: null });
    void awaitReply<AiSummary>(requestId)
      .then((summary) => {
        if (catchupAnfrage !== requestId) return;
        set({ catchup: summary, catchupLoading: false });
      })
      .catch((err: Error) => {
        if (catchupAnfrage !== requestId) return;
        set({ catchupLoading: false });
        get().toast({ kind: 'error', title: ts('toast.summaryFailed'), body: err.message });
      });
    /* Die Grenze mitschicken, die beim Öffnen galt.
       Ohne sie nahm der Server den Lesestand — und der ist, sobald man den
       Kanal ansieht, schon auf der neuesten Nachricht. Die Zusammenfassung
       hatte damit nie etwas zu berichten, egal wie viel aufgelaufen war. */
    frageHinaus(requestId, { t: 'ai:catchup', requestId, channelId, sinceMessageId: get().readMarkers[channelId] ?? null });
  },

  loadSmartReplies: (channelId, parentId) => {
    if (!get().ai?.assistant) return;
    const requestId = uid();
    vorschlagAnfrage = requestId;
    set({ smartRepliesLoading: true, smartReplies: [] });
    void awaitReply<SmartReply[]>(requestId, 30_000)
      .then((replies) => {
        if (vorschlagAnfrage !== requestId) return;
        // Inzwischen woanders: dort gehören diese Vorschläge nicht hin.
        const nochHier = get().activeChannelId === channelId;
        set({ smartReplies: nochHier ? replies : [], smartRepliesLoading: false });
      })
      .catch((err: Error) => {
        if (vorschlagAnfrage !== requestId) return;
        set({ smartReplies: [], smartRepliesLoading: false });
        get().toast({ kind: 'error', title: ts('toast.noSuggestions'), body: err.message });
      });
    frageHinaus(requestId, { t: 'ai:smart-replies', requestId, channelId, parentId: parentId ?? null });
  },

  clearSmartReplies: () => {
    vorschlagAnfrage = null;
    set({ smartReplies: [], smartRepliesLoading: false });
  },

  rewrite: async (text, tone, targetLang) => {
    const requestId = uid();
    const promise = awaitReply<string>(requestId, 40_000);
    // Der offene Kanal, in dem gerade geschrieben wird — der Server braucht ihn,
    // um einen Entwurf aus einem vertraulichen Kanal abweisen zu können.
    frageHinaus(requestId, { t: 'ai:rewrite', requestId, text, tone, targetLang: targetLang ?? null,
      channelId: get().activeChannelId ?? null });
    return promise;
  },

  askChannel: async (channelId, question) => {
    const requestId = uid();
    const promise = awaitReply<{ answer: string; citedMessageIds: string[] }>(requestId);
    frageHinaus(requestId, { t: 'ai:ask', requestId, channelId, question });
    return promise;
  },

  runSearch: async (q, channelId) => {
    /* Nur die jüngste Suche zählt: eine langsame Antwort für „ab" überschrieb
       sonst die schon angezeigten Treffer für „abc". */
    const nr = ++sucheNr;
    if (q.trim().length < 2) { set({ searchHits: [], searching: false }); return; }
    set({ searching: true });
    try {
      const { hits } = await api.search({ q, channelId });
      if (nr !== sucheNr) return;
      set({ searchHits: hits, searching: false });
    } catch (err) {
      if (nr !== sucheNr) return;
      set({ searchHits: [], searching: false });
      get().toast({ kind: 'error', title: ts('toast.searchFailed'), body: (err as Error).message });
    }
  },

  ladeFreigaben: (channelId) => socket.send({ t: 'vertraulich:freigaben', channelId: channelId ?? null }) as unknown as void,
  freigabeZuruecknehmen: (freigabeId) =>
    socket.send({ t: 'vertraulich:freigabe-zuruecknehmen', freigabeId }) as unknown as void,
  vertraulichNeuLesen: () => set((s) => ({ vertraulichTakt: s.vertraulichTakt + 1 })),

  /* ── UI ─────────────────────────────────────────────────── */

  createPoll: ({ channelId, question, options, multiple, anonymous, parentId }) => {
    socket.send({
      t: 'poll:create', clientId: uid(), channelId, question,
      options, multiple, anonymous, parentId: parentId ?? null,
    });
    set({ overlay: null });
  },

  votePoll: (pollId, optionIds) => socket.send({ t: 'poll:vote', pollId, optionIds }) as unknown as void,
  closePoll: (pollId) => socket.send({ t: 'poll:close', pollId }) as unknown as void,

  startForward: (message) => set({ forwarding: message }),
  forwardMessage: (messageId, toChannelId, comment) => {
    /* Weiterleiten geht am Verschlüsseln vorbei: der Server baut den neuen Text
       aus Kommentar und Original zusammen, ohne je einen Schlüssel zu haben.
       Aus einem vertraulichen Kanal käme deshalb nur ein Block Zeichen heraus,
       und in einen hinein liefe der Kommentar offen. Beides hier abfangen —
       der Server prüft es an dieser Stelle (noch) nicht. */
    const vonKanal = kanalDerNachricht(messageId);
    const vertraulich = (vonKanal && get().channels[vonKanal]?.vertraulich)
      || get().channels[toChannelId]?.vertraulich;
    if (vertraulich) {
      get().toast({ kind: 'error', title: ts('vertraulich.titel'), body: ts('fehler.vertraulich') });
      return;
    }
    if (!socket.send({ t: 'message:forward', clientId: uid(), messageId, toChannelId, comment })) {
      get().toast({ kind: 'error', title: ts('toast.offline'), body: ts('fehler.keineVerbindung') });
      return;
    }
    set({ forwarding: null });
    get().toast({ kind: 'ok', title: ts('toast.forwarded') });
  },

  startReminder: (message) => set({ remindingAbout: message }),
  createReminder: (input) => {
    if (!socket.send({ t: 'reminder:create', ...input, messageId: input.messageId ?? null, note: input.note ?? null })) {
      get().toast({ kind: 'error', title: ts('toast.offline'), body: ts('fehler.keineVerbindung') });
      return;
    }
    set({ remindingAbout: null });
    get().toast({ kind: 'ok', title: ts('toast.reminderSet'),
      body: ts('toast.reminderBody', {
        zeit: new Date(input.remindAt).toLocaleString(
          useStore.getState().self?.uiLanguage || spracheDesSystems(),
          { weekday: 'short', hour: '2-digit', minute: '2-digit' },
        ),
      }) });
  },
  cancelReminder: (id) => socket.send({ t: 'reminder:cancel', reminderId: id }) as unknown as void,

  saveDraft: (() => {
    /* Ein Zeitgeber je Kanal und Thread. Mit einem gemeinsamen Zeitgeber löschte
       der Wechsel in einen anderen Chat die anstehende Speicherung des vorigen:
       der Entwurf war nach einem Neustart weg, und ein bereits gesendeter Text
       stand wieder im Eingabefeld. */
    const timers = new Map<string, number>();
    return (channelId: string, parentId: string | null, text: string) => {
      const key = `${channelId}:${parentId ?? ''}`;
      useStore.setState((s) => ({ drafts: { ...s.drafts, [key]: text } }));
      // Nicht bei jedem Tastendruck zum Server funken.
      const laufend = timers.get(key);
      if (laufend !== undefined) clearTimeout(laufend);
      timers.set(key, window.setTimeout(() => {
        timers.delete(key);
        socket.send({ t: 'draft:save', channelId, parentId: parentId ?? null, text });
      }, 700));
    };
  })(),

  draftFor: (channelId, parentId) => get().drafts[`${channelId}:${parentId ?? ''}`] ?? '',

  sendVoice: ({ channelId, attachmentId, durationMs, parentId }) => {
    socket.send({ t: 'voice:send', clientId: uid(), channelId, attachmentId, durationMs, parentId: parentId ?? null });
  },
  retranscribe: (messageId) => socket.send({ t: 'voice:retranscribe', messageId }) as unknown as void,

  openAiChat: () => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? ts('toast.aiOffBody') });
      return;
    }
    socket.send({ t: 'ai:open-chat' });
  },

  setSchublade: (offen) => set({ schubladeOffen: offen }),

  openLastHumanChannel: () => {
    const gemerkt = get().lastHumanChannelId;
    if (gemerkt && get().channels[gemerkt]) return get().openChannel(gemerkt);
    // Nichts gemerkt: der erste offene Kanal, der nicht zur KI gehört.
    const ersatz = Object.values(get().channels).find(
      (c) => !c.archived && c.kind === 'public' && c.name !== 'ki-team',
    ) ?? Object.values(get().channels).find((c) => !c.archived && c.kind !== 'dm');
    if (ersatz) get().openChannel(ersatz.id);
  },

  /* ── Aufgaben ─────────────────────────────────────────── */

  loadTasks: (filter) => socket.send({ t: 'task:list', ...filter }) as unknown as void,
  loadProjekte: () => socket.send({ t: 'projekt:list' }) as unknown as void,
  createProjekt: (input) => socket.send({ t: 'projekt:create', ...input }) as unknown as void,
  updateProjekt: (projektId, patch) => socket.send({ t: 'projekt:update', projektId, patch }) as unknown as void,
  deleteProjekt: (projektId) => socket.send({ t: 'projekt:delete', projektId }) as unknown as void,
  aufgabeGeprueft: (taskId) => socket.send({ t: 'task:geprueft', taskId }) as unknown as void,
  ideeGeprueft: (ideaId) => socket.send({ t: 'idea:geprueft', ideaId }) as unknown as void,
  terminGeprueft: (eventId) => socket.send({ t: 'event:geprueft', eventId }) as unknown as void,
  kiSelbstEintragen: (an) => socket.send({ t: 'ki:selbst-eintragen', an }) as unknown as void,
  createTask: (input) => socket.send({ t: 'task:create', ...input }) as unknown as void,
  updateTask: (taskId, patch) => socket.send({ t: 'task:update', taskId, patch }) as unknown as void,
  moveTask: (taskId, status, afterId) => socket.send({ t: 'task:move', taskId, status, afterId }) as unknown as void,
  commentTask: (taskId, text) => socket.send({ t: 'task:comment', taskId, text }) as unknown as void,
  watchTask: (taskId, watching) => socket.send({ t: 'task:watch', taskId, watching }) as unknown as void,
  deleteTask: (taskId) => socket.send({ t: 'task:delete', taskId }) as unknown as void,
  loadTaskHistory: (taskId) => socket.send({ t: 'task:history', taskId }) as unknown as void,

  extractTasks: (channelId) => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? undefined });
      return;
    }
    /* Die Kennung ging schon immer hinaus, und der Server schickt sie im
       Fehlerfall zurück — nur wartete niemand darauf. Der Kreisel lief
       deshalb weiter, wenn die Erkennung scheiterte. Jetzt hängt an der
       Kennung ein Eintrag, der Fehler und Frist beide auffängt. */
    const requestId = uid();
    set({ extractingTasks: true, extractErgebnis: null, extractFehler: null });
    void awaitReply<unknown>(requestId, KI_FRIST_MS).then(
      () => { /* das Ereignis selbst trägt das Ergebnis ein */ },
      (err: Error) => set({ extractingTasks: false, extractFehler: err.message }),
    );
    frageHinaus(requestId, { t: 'ai:extract-tasks', channelId, requestId });
  },
  clearExtractedTasks: () => set({ extractErgebnis: null, extractingTasks: false, extractFehler: null }),
  loadProtocol: (channelId) => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? undefined });
      return;
    }
    set({ protocolLoading: true, protocol: null, protocolFehler: null });
    protokollKanal = channelId;
    if (protokollFrist !== null) clearTimeout(protokollFrist);
    protokollFrist = window.setTimeout(() => protokollBeenden(ts('toast.aiTimeout')), KI_FRIST_MS);
    if (!socket.send({ t: 'ai:protocol', channelId })) {
      protokollBeenden(ts('fehler.keineVerbindung'));
    }
  },
  clearProtocol: () => {
    protokollKanal = null;
    if (protokollFrist !== null) { clearTimeout(protokollFrist); protokollFrist = null; }
    set({ protocol: null, protocolLoading: false, protocolFehler: null });
  },

  /* ── Ideenboard ───────────────────────────────────────── */

  checkForUpdate: () => {
    if (!window.stellium?.checkForUpdate) return;
    set({ update: { zustand: 'suche' } });
    void window.stellium.checkForUpdate();
  },
  installUpdate: () => { void window.stellium?.installUpdate?.(); },
  postponeUpdate: () => { void window.stellium?.postponeUpdate?.(); },

  loadIdeas: () => socket.send({ t: 'idea:list' }) as unknown as void,
  createIdea: (input) => socket.send({ t: 'idea:create', ...input }) as unknown as void,
  updateIdea: (ideaId, patch) => socket.send({ t: 'idea:update', ideaId, patch }) as unknown as void,
  setIdeaStatus: (ideaId, status, decision) => socket.send({ t: 'idea:status', ideaId, status, decision }) as unknown as void,
  voteIdea: (ideaId, wert) => socket.send({ t: 'idea:vote', ideaId, wert }) as unknown as void,
  loadIdeaComments: (ideaId) => socket.send({ t: 'idea:comments', ideaId }) as unknown as void,
  commentIdea: (ideaId, text) => socket.send({ t: 'idea:comment', ideaId, text }) as unknown as void,
  deleteIdeaComment: (ideaId, commentId) => socket.send({ t: 'idea:comment-delete', ideaId, commentId }) as unknown as void,
  deleteIdea: (ideaId) => socket.send({ t: 'idea:delete', ideaId }) as unknown as void,

  /* ── Kalender ─────────────────────────────────────────── */

  loadEvents: (from, to) => socket.send({ t: 'event:list', from, to }) as unknown as void,
  createEvent: (input) => socket.send({ t: 'event:create', ...input }) as unknown as void,
  updateEvent: (eventId, patch) => socket.send({ t: 'event:update', eventId, patch }) as unknown as void,
  respondEvent: (eventId, response) => socket.send({ t: 'event:respond', eventId, response }) as unknown as void,
  deleteEvent: (eventId) => socket.send({ t: 'event:delete', eventId }) as unknown as void,

  /* ── Dateiablage ──────────────────────────────────────── */

  /**
   * Die Ablage laden.
   *
   * Über HTTP statt über die Leitung, seit es private Dateien gibt: nur dieser
   * Weg weiß, wer fragt, und kann deshalb die eigenen privaten Dateien
   * mitliefern und fremde weglassen.
   */
  loadFiles: async (filter) => {
    try {
      const { files, usage } = await api.libraryFiles(filter);
      set({ files: nurSichtbareDateien(files, get().self?.id), storageUsage: usage });
    } catch (err) {
      get().toast({ kind: 'error', title: ts('toast.filesFailed'), body: (err as Error).message });
    }
  },

  /**
   * Eine oder mehrere Dateien in die Ablage hochladen — als Store-Aktion.
   *
   * Vorher steckte dieselbe Arbeit in FilesPanel.tsx, mit dem Fortschritt in
   * einem lokalen useState. Das sah im Normalfall gut aus und brach doch: wer
   * die Ablage schloss, während eine Datei noch hochlud, riss der Komponente
   * den Boden unter den Füßen weg. Nicht der Upload selbst — der lief über
   * `api.uploadToLibrary()` und damit XMLHttpRequest weiter, unabhängig von
   * jeder Komponente —, sondern alles, was danach kam: der Fortschritt
   * schrieb an ein `setState`, das niemand mehr sah, und mit ihm endete
   * beim genaueren Hinsehen jede Spur, dass da noch etwas offen war. Jetzt
   * lebt der Fortschritt in `libraryUploads`, einem Teil des Zustands, der
   * kein Fenster braucht, um zu bestehen — die Ablage schließen und wieder
   * öffnen zeigt denselben Balken, an derselben Stelle.
   */
  uploadLibraryFiles: async (fileList, meta) => {
    const liste = Array.from(fileList);
    // Nacheinander, damit das Kontingent sauber geprüft wird und zwei
    // Ladevorgänge sich beim abschließenden loadFiles() nicht überholen.
    for (const file of liste) {
      const taskId = uid();
      set((s) => ({
        libraryUploads: [
          ...s.libraryUploads,
          { id: taskId, name: file.name, size: file.size, anteil: 0, status: 'laeuft' as const },
        ],
      }));
      const aktualisieren = (patch: Partial<LibraryUpload>) => set((s) => ({
        libraryUploads: s.libraryUploads.map((u) => (u.id === taskId ? { ...u, ...patch } : u)),
      }));

      try {
        const form = new FormData();
        /* Privat heißt: die Datei wird hier verschlüsselt und verlässt den
           Rechner nur als Chiffrat. Der Schlüssel dafür entsteht aus dem
           eigenen Schlüsselpaar und geht nirgends hin — auch nicht zum
           Server. Verschlüsselt wird vor allem anderen: schlägt es fehl,
           geht gar nichts hinaus. */
        let hinauf: File = file;
        if (meta?.privat) {
          const roh = await dateiVerschluesseln(file, kontoHuelle());
          // Der Typ wird neutral, der Name bleibt stehen — eine bewusste
          // Grenze, keine Nachlässigkeit (siehe kontoHuelle in lib/vertraulich.ts).
          hinauf = new File([roh], file.name, { type: 'application/octet-stream' });
          form.append('privat', '1');
        }
        form.append('file', hinauf);
        if (meta?.folder) form.append('folder', meta.folder);
        if (meta?.channelId) form.append('channelId', meta.channelId);
        if (meta?.description) form.append('description', meta.description);

        const proben: { zeit: number; bytes: number }[] = [{ zeit: performance.now(), bytes: 0 }];
        await api.uploadToLibrary(form, (anteil) => {
          const bytes = Math.round(anteil * hinauf.size);
          const jetzt = performance.now();
          proben.push({ zeit: jetzt, bytes });
          while (proben.length > 2 && jetzt - proben[0].zeit > 3000) proben.shift();
          const sekunden = (jetzt - proben[0].zeit) / 1000;
          const tempo = sekunden > 0.25 ? (bytes - proben[0].bytes) / sekunden : undefined;
          aktualisieren({ anteil, tempo, rest: tempo && tempo > 0 ? (hinauf.size - bytes) / tempo : undefined });
        });

        aktualisieren({ anteil: 1, status: 'fertig' });
        await get().loadFiles(meta?.channelId ? { channelId: meta.channelId } : undefined);
        // Fertig heißt: die Datei steht jetzt in `files`. Die Fortschrittszeile
        // hat damit ausgedient und räumt sich selbst weg.
        set((s) => ({ libraryUploads: s.libraryUploads.filter((u) => u.id !== taskId) }));
      } catch (err) {
        // Gescheiterte Zeilen bleiben stehen, bis jemand sie wegklickt — sonst
        // stünde nirgends mehr, dass diese Datei nie ankam.
        aktualisieren({ status: 'fehler', fehler: (err as Error).message });
        get().toast({ kind: 'error', title: ts('toast.uploadFailed'), body: (err as Error).message });
      }
    }
  },
  dismissLibraryUpload: (id) => set((s) => ({ libraryUploads: s.libraryUploads.filter((u) => u.id !== id) })),

  updateFile: (fileId, patch) => socket.send({ t: 'file:update', fileId, ...patch }) as unknown as void,
  deleteFile: (fileId) => socket.send({ t: 'file:delete', fileId }) as unknown as void,

  openAiTeamChannel: () => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? undefined });
      return;
    }
    socket.send({ t: 'ai:open-team-channel' });
  },

  setAiMode: (channelId, mode) => socket.send({ t: 'ai:set-mode', channelId, mode }) as unknown as void,

  selectProvider: async (input) => {
    try {
      const { ai } = await api.selectProvider(input);
      set({ ai });
      return true;
    } catch (err) {
      get().toast({ kind: 'error', title: (err as Error).message });
      return false;
    }
  },

  selectModels: async (input) => {
    try {
      const { ai } = await api.selectModels(input);
      set({ ai });
      get().toast({
        kind: 'ok',
        title: input.auto ? ts('toast.modelAuto') : ts('toast.modelTaken'),
        body: ai.model ?? undefined,
      });
    } catch (err) {
      get().toast({ kind: 'error', title: ts('toast.modelFailed'), body: (err as Error).message });
    }
  },

  setProfileUser: (profileUserId) => set({ profileUserId }),

  jumpToMessage: (channelId, messageId) => {
    get().openChannel(channelId);
    set({ highlightMessageId: messageId });
    window.setTimeout(() => {
      const el = document.querySelector(`[data-message-id="${messageId}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => set({ highlightMessageId: null }), 2600);
    }, 450);
  },

  /* Kein `openChannel()`-Gegenstück nötig wie bei jumpToMessage: das Postfach
     ist kein Kanal, sondern ein einzelner Reiter mit eigener Auswahl in
     PostPanel.tsx. `setOverlay` wechselt dahin, `postJumpMailId` trägt die
     Auswahl — PostPanel liest es in einem eigenen Effekt und ruft danach
     `postJumpConsumed()`. */
  jumpToPostMail: (mailId) => set({ overlay: 'post', postJumpMailId: mailId }),
  postJumpConsumed: () => set({ postJumpMailId: null }),

  setOverlay: (overlay) => set({ overlay }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setLightbox: (lightbox) => set({ lightbox }),

  toast: (toast) => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    window.setTimeout(() => get().dismissToast(id), toast.kind === 'error' ? 7000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/* ── Theme auf das Dokument anwenden ────────────────────────── */

function applyTheme(theme: SelfUser['theme'], density: SelfUser['density']): void {
  const root = document.documentElement;
  // Sprache und Leserichtung hängen am selben Ereignis wie das Aussehen:
  // beides gilt für das ganze Dokument und ändert sich zusammen.
  dokumentSpracheSetzen(useStore.getState().self?.uiLanguage || spracheDesSystems());
  // Natives UI im Hauptprozess (Menü, Tray, Bestätigungsdialoge) kennt diese
  // Sprache sonst nicht — siehe electron/i18n.ts.
  void window.stellium?.setLanguage?.(useStore.getState().self?.uiLanguage || spracheDesSystems());
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  root.dataset.theme = resolved;
  root.dataset.density = density;
  void window.stellium?.setTheme(theme);
}

/**
 * „Wie das System" heißt: auch dann, wenn das System umschaltet.
 *
 * Bisher wurde die Systemfarbe genau einmal abgefragt — beim Anmelden und bei
 * jeder Änderung der Einstellungen. Wer die App morgens öffnet und mittags am
 * Mac auf Hell umstellt, saß bis zum nächsten Neustart im Dunkeln, obwohl
 * ausdrücklich „wie das System" eingestellt war.
 */
if (typeof window !== 'undefined' && window.matchMedia) {
  const beobachter = window.matchMedia('(prefers-color-scheme: light)');
  beobachter.addEventListener('change', () => {
    const self = useStore.getState().self;
    if (self?.theme === 'system') applyTheme(self.theme, self.density);
  });
}

/* ── Server-Ereignisse in den Store spiegeln ────────────────── */

socket.onState((connection, detail) => {
  useStore.setState({ connection, connectionDetail: detail ?? null });
  /* Bricht die Verbindung ab, kommt auf eine laufende Anfrage nie eine Antwort.
     Bliebe die Sperre stehen, ließe sich in dem Kanal nie wieder nachladen. */
  if (connection !== 'open') seiteUnterwegs.clear();

  /* Dasselbe für alles, worauf die Oberfläche mit einem Kreisel wartet.
     Eine Antwort auf eine Anfrage der alten Leitung kommt nie mehr an: der
     Server schickt sie an die Sitzung, und die ist weg. Ohne diesen Abbruch
     drehte sich der Kreisel bis zur Frist — bei der Aufgabenerkennung
     anderthalb Minuten für etwas, das schon entschieden ist.
     Auch die „Assistent denkt nach"-Anzeige gehört zurückgesetzt: das
     abschließende ai:thinking mit active=false erreicht uns nicht mehr. */
  if (connection !== 'open' && connection !== 'connecting') {
    const grund = ts('fehler.keineVerbindung');
    for (const id of [...pending.keys()]) settle(id, null, new Error(grund));
    protokollBeenden(grund);
    if (Object.keys(useStore.getState().aiThinking).length) useStore.setState({ aiThinking: {} });
  }
  /* Nur abmelden, wenn wirklich der Nachweis das Problem ist. Bei einem zu
     alten Protokoll ist das Token einwandfrei — wer hier abmeldet, schickt in
     eine Schleife: anmelden, dieselbe Fehlermeldung, wieder abmelden. */
  if (connection === 'failed' && socket.failCode !== 'fehler.protokollVeraltet') {
    setToken(null);
    useStore.setState({ self: null });
  }
});

socket.onEvent((ev: ServerEvent) => {
  const store = useStore.getState();

  switch (ev.t) {
    case 'ready': {
      applyTheme(ev.self.theme, ev.self.density);
      // Der Schlüssel steht erst ab jetzt bereit — pushAbonnieren() (Datei
      // lib/benachrichtigung.ts) kann vorher noch kein Abonnement anlegen.
      vapidSchluesselSetzen(ev.vapidPublicKey);
      // 'ready' kommt bei JEDEM Verbindungsaufbau, nicht nur beim ersten —
      // genau deshalb der richtige Ort, um bei Gelegenheit nachzusehen, ob
      // der Server noch dasselbe Abonnement kennt wie der Browser. Läuft
      // nebenher: eine fehlgeschlagene Anmeldung soll die Anzeige nicht
      // aufhalten.
      pushSynchronisieren();
      useStore.setState({
        self: ev.self,
        ai: ev.ai,
        serverVersion: ev.serverVersion,
        serverBereitVersion: ev.serverUpdate,
        users: Object.fromEntries(ev.users.map((u) => [u.id, u])),
        channels: Object.fromEntries(ev.channels.map((c) => [c.id, c])),
        states: Object.fromEntries(ev.states.map((s) => [s.channelId, s])),
        scheduled: ev.scheduled,
        reminders: ev.reminders,
        drafts: Object.fromEntries(ev.drafts.map((d: Draft) => [`${d.channelId}:${d.parentId ?? ''}`, d.text])),
      });
      const schonOffen = useStore.getState().activeChannelId;
      const active = schonOffen
        ?? ev.channels.find((c) => c.kind === 'public')?.id
        ?? ev.channels[0]?.id;
      if (!active) break;

      /* `ready` kommt nicht nur beim ersten Anmelden, sondern nach jedem
         Wiederverbinden — nach einem Funkloch, nach dem Aufklappen des
         Laptops, nach einem Serverneustart.

         `openChannel` baut dabei die ganze Ansicht um: es schließt den Thread,
         schiebt die Schublade zu und setzt die Lesemarke neu. Gemessen am
         gebauten Stand: Thread offen, Leitung gekappt, Leitung zurück — der
         Thread war weg. Für den Kanal, der ohnehin schon offen ist, wird
         deshalb nur der Verlauf nachgezogen; ein offener Thread bekommt seinen
         eigenen Nachschlag, denn auch dort können Antworten aufgelaufen sein.

         Nur wenn noch gar kein Kanal offen ist — der erste Start — wird
         wirklich einer geöffnet. */
      if (schonOffen === active) {
        socket.send({ t: 'channel:open', channelId: active, limit: 50 });
        const offenerThread = useStore.getState().threadParentId;
        if (offenerThread) socket.send({ t: 'thread:open', messageId: offenerThread });
      } else {
        useStore.getState().openChannel(active);
      }
      /* Die Zahl am Programmsymbol hängt sonst an `channel:state` allein und
         stand nach dem Start auf dem Wert von gestern, bis sich zufällig ein
         Kanal meldete. */
      updateBadge();
      break;
    }

    case 'channel:focus':
      useStore.getState().openChannel(ev.channelId);
      break;

    case 'channel:history': {
      seiteUnterwegs.delete(ev.channelId);
      useStore.setState((s) => {
        const existing = s.messages[ev.channelId] ?? [];
        // Ältere Seite: vorne anhängen. Erste Seite: ersetzen.
        const isOlderPage = existing.length > 0 && ev.messages.length > 0
          && ev.messages[ev.messages.length - 1].createdAt < (existing[0]?.createdAt ?? Infinity);
        /* Beim Nachladen älterer Seiten nach hinten kürzen, sonst nach vorn:
           gescrollt wird nach oben, dort braucht man die alten. */
        const zusammen = isOlderPage ? [...ev.messages, ...existing] : ev.messages;
        const merged = zusammen.length > NACHRICHTEN_JE_KANAL
          ? (isOlderPage ? zusammen.slice(0, NACHRICHTEN_JE_KANAL) : zusammen.slice(-NACHRICHTEN_JE_KANAL))
          : zusammen;
        return {
          messages: { ...s.messages, [ev.channelId]: merged },
          hasMore: { ...s.hasMore, [ev.channelId]: ev.hasMore },
        };
      });
      break;
    }

    case 'thread:history':
      useStore.setState((s) => ({ threads: { ...s.threads, [ev.parentId]: ev.messages } }));
      break;

    case 'message:new': {
      const msg: Message = ev.clientId ? { ...ev.message, clientId: ev.clientId } : ev.message;
      /* Ab jetzt hat die eigene Nachricht eine echte Kennung — wer noch auf
         sie wartet, um ihr einen fertig gewordenen Anhang nachzureichen
         (siehe waitForMessageId oben), erfährt es genau hier. */
      if (ev.clientId) settle(`msg:${ev.clientId}`, msg.id);
      useStore.setState((s) => {
        const next: Partial<StoreState> = {};
        if (imKanalverlauf(msg)) {
          next.messages = { ...s.messages, [msg.channelId]: gekuerzt(upsertMessage(s.messages[msg.channelId], msg)) };
        }
        if (msg.parentId && s.threads[msg.parentId]) {
          next.threads = { ...s.threads, [msg.parentId]: upsertMessage(s.threads[msg.parentId], msg) };
        }
        // Thread-Zähler an der Wurzel hochziehen — die steht im Verlauf.
        if (msg.parentId) {
          const list = next.messages?.[msg.channelId] ?? s.messages[msg.channelId] ?? [];
          next.messages = {
            ...(next.messages ?? s.messages),
            [msg.channelId]: list.map((m) => m.id === msg.parentId
              ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: msg.createdAt,
                  threadParticipantIds: m.threadParticipantIds.includes(msg.userId)
                    ? m.threadParticipantIds : [...m.threadParticipantIds, msg.userId] }
              : m),
          };
        }
        return next;
      });
      notifyIfNeeded(msg);
      markReadIfViewing(msg);
      break;
    }

    case 'message:updated':
      useStore.setState((s) => {
        /* Auch beim Bearbeiten gilt die Trennung: `upsertMessage` würde eine
           geänderte Thread-Antwort sonst neu in den Verlauf einfügen — der
           doppelte Eintrag käme über diesen zweiten Weg zurück. */
        const next: Partial<StoreState> = imKanalverlauf(ev.message)
          ? { messages: { ...s.messages, [ev.message.channelId]: gekuerzt(upsertMessage(s.messages[ev.message.channelId], ev.message)) } }
          : {};
        if (ev.message.parentId && s.threads[ev.message.parentId]) {
          next.threads = { ...s.threads, [ev.message.parentId]: upsertMessage(s.threads[ev.message.parentId], ev.message) };
        }
        if (s.threads[ev.message.id]) {
          next.threads = { ...(next.threads ?? s.threads), [ev.message.id]: upsertMessage(s.threads[ev.message.id], ev.message) };
        }
        return next;
      });
      break;

    case 'message:deleted': {
      /* Der offene Thread zeigt dieselbe Nachricht aus einer zweiten Liste.
         Ohne diesen Zweig stünde der zurückgenommene Text dort weiter, bis
         jemand den Thread schließt und neu öffnet. */
      const geloescht: Partial<Message> = {
        deletedAt: Date.now(), text: '', attachments: [], translation: null,
        // Ein Anhang, der noch unterwegs war, findet gleich keine Nachricht
        // mehr vor (siehe attachUploadToMessage) — der Platzhalter soll das
        // hier schon vorwegnehmen, statt bis zur Serverantwort zu warten.
        pendingAttachments: [],
      };
      useStore.setState((s) => ({
        messages: {
          ...s.messages,
          [ev.channelId]: (s.messages[ev.channelId] ?? []).map((m) =>
            m.id === ev.messageId ? { ...m, ...geloescht } : m),
        },
        threads: patchThreads(s.threads, ev.messageId, geloescht),
      }));
      break;
    }

    case 'reaction:updated':
      useStore.setState((s) => {
        const patch = (list: Message[] = []) => list.map((m) => m.id === ev.messageId ? { ...m, reactions: ev.reactions } : m);
        const threads = { ...s.threads };
        for (const key of Object.keys(threads)) threads[key] = patch(threads[key]);
        return { messages: { ...s.messages, [ev.channelId]: patch(s.messages[ev.channelId]) }, threads };
      });
      break;

    case 'translation':
      useStore.setState((s) => {
        const patch = (list: Message[] = []) => list.map((m) => m.id === ev.messageId ? { ...m, translation: ev.translation } : m);
        const messages = { ...s.messages };
        for (const key of Object.keys(messages)) messages[key] = patch(messages[key]);
        const threads = { ...s.threads };
        for (const key of Object.keys(threads)) threads[key] = patch(threads[key]);
        const translating = { ...s.translating };
        delete translating[ev.messageId];
        return { messages, threads, translating };
      });
      break;

    case 'roundtrip':
      useStore.setState((s) => ({
        roundTrips: { ...s.roundTrips, [ev.messageId]: { backTranslation: ev.backTranslation, similarity: ev.similarity } },
      }));
      break;

    case 'channel:upsert':
      useStore.setState((s) => ({ channels: { ...s.channels, [ev.channel.id]: ev.channel } }));
      break;

    case 'channel:removed':
      useStore.setState((s) => {
        const channels = { ...s.channels }; delete channels[ev.channelId];
        const messages = { ...s.messages }; delete messages[ev.channelId];
        const states = { ...s.states }; delete states[ev.channelId];
        const hasMore = { ...s.hasMore }; delete hasMore[ev.channelId];
        const typing = { ...s.typing }; delete typing[ev.channelId];
        const readMarkers = { ...s.readMarkers }; delete readMarkers[ev.channelId];
        /* Bleibt der gelöschte Kanal der offene, steht danach ein leerer
           Hauptbereich da: die Kopfzeile findet den Kanal nicht mehr und zeigt
           gar nichts, das Schreibfeld aber schon — und was dort hineingeht,
           weist der Server ab. Lieber ehrlich zurück auf „wähle einen Kanal". */
        const weiter: Partial<StoreState> = { channels, messages, states, hasMore, typing, readMarkers };
        if (s.activeChannelId === ev.channelId) {
          weiter.activeChannelId = null;
          weiter.threadParentId = null;
        }
        if (s.lastHumanChannelId === ev.channelId) weiter.lastHumanChannelId = null;
        return weiter;
      });
      updateBadge();
      break;

    case 'channel:state':
      useStore.setState((s) => ({ states: { ...s.states, [ev.state.channelId]: ev.state } }));
      updateBadge();
      break;

    /* ── Lesebestätigungen ────────────────────────────────────
       Dieselbe Lesemarke wie der Ungelesen-Zähler (channel_members in der
       Datenbank, readMarkers/states hier) — es gibt keine zweite Ablage
       darüber, was gelesen ist. Diese beiden Fälle beantworten nur, WER
       gelesen hat und WANN, abgeleitet aus derselben Marke. */

    case 'read': {
      // Die eigene Marke kommt über channel:state, nicht hierüber. `at` fehlt
      // (null), wenn sich die Marke der anderen Person in Wahrheit gar nicht
      // bewegt hat (z.B. eine doppelte Meldung) — dann gibt es nichts
      // aufzufrischen.
      if (ev.at == null || ev.userId === store.self?.id) break;
      useStore.setState((s) => {
        /* Nur Nachrichten IM SELBEN KANAL berücksichtigen: Kennungen sind
           zeitlich sortierbar, aber nicht kanalübergreifend vergleichbar —
           ein lexikalischer Vergleich über Kanalgrenzen hinweg verglich zwei
           Uhren, die nichts miteinander zu tun haben. */
        const bekannt = new Set<string>();
        for (const m of s.messages[ev.channelId] ?? []) bekannt.add(m.id);
        for (const liste of Object.values(s.threads)) {
          for (const m of liste) if (m.channelId === ev.channelId) bekannt.add(m.id);
        }
        let geaendert = false;
        const readReceipts = { ...s.readReceipts };
        for (const [messageId, liste] of Object.entries(readReceipts)) {
          if (!bekannt.has(messageId) || messageId > ev.lastMessageId) continue;
          if (liste.some((r) => r.userId === ev.userId)) continue;
          readReceipts[messageId] = [...liste, { userId: ev.userId, at: ev.at! }];
          geaendert = true;
        }
        return geaendert ? { readReceipts } : {};
      });
      break;
    }

    case 'message:read-receipts':
      useStore.setState((s) => ({ readReceipts: { ...s.readReceipts, ...ev.receipts } }));
      break;

    case 'typing':
      useStore.setState((s) => ({
        typing: {
          ...s.typing,
          [ev.channelId]: { ...(s.typing[ev.channelId] ?? {}), [ev.userId]: Date.now() },
        },
      }));
      break;

    case 'presence':
      useStore.setState((s) => {
        const user = s.users[ev.userId];
        if (!user) return {};
        return {
          users: {
            ...s.users,
            // statusExpiresAt gehört mit fortgeschrieben: ohne das kennt die App
            // nach einer Live-Änderung das Ende nicht mehr, und „Endet 14:30"
            // verschwindet bis zum nächsten Laden.
            [ev.userId]: {
              ...user,
              status: ev.status,
              statusEmoji: ev.statusEmoji,
              statusText: ev.statusText,
              statusExpiresAt: ev.statusExpiresAt,
              lastSeenAt: ev.lastSeenAt,
            },
          },
        };
      });
      break;

    case 'user:upsert':
      useStore.setState((s) => ({ users: { ...s.users, [ev.user.id]: ev.user } }));
      break;

    case 'self:updated':
      applyTheme(ev.self.theme, ev.self.density);
      useStore.setState({ self: ev.self });
      break;

    case 'scheduled:upsert':
      useStore.setState((s) => ({ scheduled: [...s.scheduled.filter((x) => x.id !== ev.item.id), ev.item].sort((a, b) => a.sendAt - b.sendAt) }));
      break;

    case 'scheduled:removed':
      useStore.setState((s) => ({ scheduled: s.scheduled.filter((x) => x.id !== ev.scheduledId) }));
      break;

    case 'compose:preview': settle(ev.requestId, ev.text); break;
    case 'ai:catchup': settle(ev.requestId, ev.summary); break;
    case 'ai:thread-summary': settle(ev.requestId, ev.summary); break;
    case 'ai:smart-replies': settle(ev.requestId, ev.replies); break;
    case 'ai:rewrite': settle(ev.requestId, ev.text); break;
    case 'ai:ask': settle(ev.requestId, { answer: ev.answer, citedMessageIds: ev.citedMessageIds }); break;
    /* Trägt nur eine Kennung, wenn jemand darauf wartet — sonst kam die
       Änderung von woanders und es gibt nichts zuzuordnen. */
    case 'vorschlag:upsert': if (ev.requestId) settle(ev.requestId, ev.vorschlag); break;

    case 'poll:updated':
      useStore.setState((s) => ({
        messages: {
          ...s.messages,
          [ev.channelId]: (s.messages[ev.channelId] ?? []).map((m) =>
            m.id === ev.poll.messageId ? { ...m, poll: ev.poll } : m),
        },
        // Umfragen liegen auch in Threads; sonst blieben dort die alten Stimmen stehen.
        threads: patchThreads(s.threads, ev.poll.messageId, { poll: ev.poll }),
      }));
      break;

    case 'links':
      useStore.setState((s) => ({
        messages: patchEverywhere(s.messages, ev.messageId, { links: ev.links }),
        // Auch hier: der offene Thread hält seine eigene Kopie der Nachricht.
        threads: patchThreads(s.threads, ev.messageId, { links: ev.links }),
      }));
      break;

    case 'voice:transcript':
      useStore.setState((s) => ({
        messages: patchEverywhere(s.messages, ev.messageId, { voice: ev.voice }),
        threads: patchThreads(s.threads, ev.messageId, { voice: ev.voice }),
      }));
      break;

    case 'reminder:upsert':
      useStore.setState((s) => ({
        reminders: [...s.reminders.filter((r) => r.id !== ev.reminder.id), ev.reminder]
          .sort((a, b) => a.remindAt - b.remindAt),
      }));
      break;

    case 'reminder:removed':
      useStore.setState((s) => ({ reminders: s.reminders.filter((r) => r.id !== ev.reminderId) }));
      break;

    case 'reminder:fire': {
      useStore.setState((s) => ({ reminders: s.reminders.filter((r) => r.id !== ev.reminder.id) }));
      const channel = store.channels[ev.reminder.channelId];
      const roh = ev.message?.translation?.text ?? ev.message?.text ?? '';
      /* Aus einem vertraulichen Kanal kommt hier Chiffrat — das gehört weder
         in die Meldung noch auf den Sperrbildschirm (wie in notifyIfNeeded). */
      const preview = istE2EChiffrat(roh) ? '' : roh;
      store.toast({
        kind: 'info',
        title: ev.reminder.note || ts('reminder.one'),
        body: preview ? preview.slice(0, 140) : ts('toast.reminderIn', { ort: channel?.name ? `#${channel.name}` : ts('toast.aChannel') }),
      });
      /* War früher ein direkter window.stellium?.notify()-Aufruf — der geht
         nur in der App, weil `window.stellium` im Browser gar nicht existiert
         und der optionale Aufruf dort lautlos ins Leere lief. Eine fällige
         Erinnerung zeigte sich auf dem Telefon deshalb nie, nicht einmal bei
         offener App. zeigen() wählt selbst den richtigen Weg. */
      zeigen({
        titel: ev.reminder.note || ts('toast.reminderTitle'),
        text: preview.slice(0, 160) || ts('toast.reminderLook'),
        kanalId: ev.reminder.channelId,
        gruppe: `reminder:${ev.reminder.id}`,
      });
      break;
    }

    /* ── Aufgaben ─────────────────────────────────────────── */

    case 'projekt:list':
      useStore.setState({ projekte: Object.fromEntries(ev.projekte.map((p) => [p.id, p])) });
      return;

    case 'projekt:upsert':
      useStore.setState((s) => ({ projekte: { ...s.projekte, [ev.projekt.id]: ev.projekt } }));
      return;

    case 'projekt:deleted':
      useStore.setState((s) => {
        const { [ev.projektId]: _weg, ...rest } = s.projekte;
        return { projekte: rest };
      });
      return;

    case 'ai:einstellung':
      useStore.setState((s) => (s.ai ? { ai: { ...s.ai, selbstEintragen: ev.selbstEintragen } } : {}));
      return;

    case 'task:list':
      useStore.setState({ tasks: Object.fromEntries(ev.tasks.map((t) => [t.id, t])) });
      break;

    case 'task:upsert': {
      // Vorher festhalten, sonst lässt sich nach dem setState() nicht mehr
      // unterscheiden "war schon meine Aufgabe" von "wurde mir gerade erst
      // gegeben" — beides sieht danach gleich aus.
      const vorherigerEmpfaenger = useStore.getState().tasks[ev.task.id]?.assigneeId;
      useStore.setState((s) => ({ tasks: { ...s.tasks, [ev.task.id]: ev.task } }));
      const self = useStore.getState().self;
      if (self && ev.task.assigneeId === self.id && vorherigerEmpfaenger !== self.id) {
        /* Über das Wörterbuch statt fest verdrahtet — dieselbe Bauart wie
           bei 'reminder:fire' weiter oben. Der Schlüssel steht jetzt in allen
           22 Wörterbüchern, deshalb ist der Cast weg: ohne ihn prüft der
           Übersetzer den Namen wieder mit, und ein Tippfehler fällt beim
           Bauen auf statt erst auf dem Sperrbildschirm. */
        zeigen({ titel: ts('toast.taskAssigned'), text: ev.task.title, gruppe: `task:${ev.task.id}` });
      }
      break;
    }

    case 'task:removed':
      useStore.setState((s) => {
        const rest = { ...s.tasks };
        delete rest[ev.taskId];
        return { tasks: rest };
      });
      break;

    case 'task:history':
      useStore.setState((s) => ({ taskHistory: { ...s.taskHistory, [ev.taskId]: ev.events } }));
      break;

    case 'ai:extract-tasks':
      // Erst die Kennung abschließen: sonst läuft die Frist weiter und würde
      // gleich darauf einen Fehlschlag melden, obwohl das Ergebnis schon da ist.
      settle(ev.requestId, ev);
      useStore.setState({
        extractingTasks: false,
        extractFehler: null,
        extractErgebnis: {
          vorgeschlagen: ev.vorgeschlagen,
          uebersprungen: ev.uebersprungen,
        },
      });
      if (!ev.tasks.length) {
        store.toast({ kind: 'info', title: ts('toast.nothingFound'), body: ts('toast.noOpenTask') });
      }
      break;

    case 'ai:protocol':
      if (ev.protocol.channelId !== protokollKanal) break;
      protokollBeenden(null);
      useStore.setState({ protocol: ev.protocol, protocolLoading: false, protocolFehler: null });
      break;

    /* ── Ideenboard ───────────────────────────────────────── */

    case 'idea:list':
      useStore.setState({ ideas: Object.fromEntries(ev.ideas.map((i) => [i.id, i])) });
      break;

    case 'idea:upsert':
      useStore.setState((s) => ({ ideas: { ...s.ideas, [ev.idea.id]: ev.idea } }));
      break;

    case 'idea:removed':
      useStore.setState((s) => {
        const rest = { ...s.ideas };
        delete rest[ev.ideaId];
        return { ideas: rest };
      });
      break;

    case 'idea:comments':
      useStore.setState((s) => ({ ideaComments: { ...s.ideaComments, [ev.ideaId]: ev.comments } }));
      break;

    case 'server:update': {
      // Uhren gehen auseinander. Der Server schickt seine mit; die
      // Abweichung rechnen wir einmal heraus, dann zeigt jedes Gerät
      // dieselbe Restzeit.
      const abweichung = Date.now() - ev.serverZeit;
      useStore.setState({
        serverUpdate: {
          version: ev.version,
          notes: ev.notes,
          startetUm: ev.startetUm + abweichung,
          dauertEtwa: ev.dauertEtwa,
        },
      });
      break;
    }

    case 'server:update-abgesagt':
      useStore.setState({ serverUpdate: null });
      break;

    case 'release:available':
      // Der Hauptprozess prüft ohnehin regelmäßig; diese Meldung sorgt nur
      // dafür, dass eine frisch hochgeladene Version sofort ankommt.
      useStore.getState().checkForUpdate();
      break;

    /* ── Kalender ─────────────────────────────────────────── */

    case 'event:list':
      useStore.setState({ events: Object.fromEntries(ev.events.map((e) => [e.id, e])) });
      break;

    case 'event:upsert':
      useStore.setState((s) => ({ events: { ...s.events, [ev.event.id]: ev.event } }));
      break;

    case 'event:removed':
      useStore.setState((s) => {
        const rest = { ...s.events };
        delete rest[ev.eventId];
        return { events: rest };
      });
      break;

    /* ── Dateiablage ──────────────────────────────────────── */

    case 'file:list':
      useStore.setState((s) => ({
        files: nurSichtbareDateien(ev.files, s.self?.id), storageUsage: ev.usage,
      }));
      break;

    case 'file:upsert':
      useStore.setState((s) => {
        /* Eine fremde private Datei gehört nicht in diese Liste. Der Server
           schickt sie beim Hochladen gar nicht erst herum; bei einer
           Umbenennung geht sie inzwischen (siehe ws/gateway.ts, Fall
           file:update) nur noch an ihren Besitzer. nurSichtbareDateien()
           bleibt trotzdem stehen — die zweite Sicherung, nicht die erste. */
        return {
          files: nurSichtbareDateien([ev.file, ...s.files.filter((f) => f.id !== ev.file.id)], s.self?.id)
            .sort((a, b) => b.createdAt - a.createdAt),
          storageUsage: ev.usage ?? s.storageUsage,
        };
      });
      break;

    case 'file:removed':
      useStore.setState((s) => ({ files: s.files.filter((f) => f.id !== ev.fileId) }));
      break;

    case 'drafts':
      useStore.setState({
        drafts: Object.fromEntries(ev.drafts.map((d) => [`${d.channelId}:${d.parentId ?? ''}`, d.text])),
      });
      break;

    case 'ai:model-changed':
      useStore.setState({ ai: ev.ai });
      break;

    case 'ai:thinking':
      useStore.setState((s) => ({ aiThinking: { ...s.aiThinking, [ev.channelId]: ev.active } }));
      return;

    case 'ai:verbrauch':
      useStore.setState((s) => ({
        aiVerbrauch: {
          ...s.aiVerbrauch,
          [ev.channelId]: { eingabe: ev.eingabe, ausgabe: ev.ausgabe, modell: ev.modell },
        },
      }));
      break;

    /* ── Vertrauliche Kanäle ────────────────────────────────
       Die Schlüsselarbeit selbst erledigt lib/vertraulich.ts an seinem eigenen
       Draht. Hier steht nur, was den Zustand angeht: die Anzeige anstoßen,
       Freigaben führen und den Schlüsselwechsel auslösen — der braucht die
       Mitgliederliste und die kennt nur der Zustand. */

    case 'vertraulich:paket':
      useStore.setState((s) => ({ vertraulichTakt: s.vertraulichTakt + 1 }));
      break;

    case 'vertraulich:wechsel-noetig': {
      const kanal = useStore.getState().channels[ev.channelId];
      const ich = useStore.getState().self?.id;
      if (!kanal || !ich) break;
      /* Der Server fragt alle, die lesen können. Wechselten sie alle, gäbe es
         für ein einziges Ereignis so viele neue Fassungen wie Mitglieder.
         Deshalb macht es genau eine:r — abgemacht ohne Absprache über die
         kleinste Kennung, die alle Beteiligten gleich berechnen. */
      const zustaendig = [...kanal.memberIds].sort()[0];
      if (zustaendig === ich) void kanalSchluesselWechseln(ev.channelId, kanal.memberIds);
      break;
    }

    case 'vertraulich:freigaben':
      useStore.setState({ freigaben: ev.freigaben });
      break;

    case 'vertraulich:freigabe':
      useStore.setState((s) => ({
        freigaben: s.freigaben.some((f) => f.id === ev.freigabe.id)
          ? s.freigaben.map((f) => (f.id === ev.freigabe.id ? ev.freigabe : f))
          : [ev.freigabe, ...s.freigaben],
      }));
      break;

    case 'error': {
      const { satz, roh } = serverMeldung(ev.code, ev.message, ev.werte);
      if (ev.requestId) { settle(ev.requestId, null, new Error(satz)); break; }
      const meldung = roh ? `${satz} ${roh}` : satz;
      /* `message:send` trägt keine `requestId`, aber seit Kurzem eine
         `clientId` direkt auf dem Fehler (packages/shared/src/protocol.ts)
         — der Server weiß, welche Nachricht er abgewiesen hat, und sagt es
         jetzt. Das ersetzt die frühere Zeit-Heuristik über eine Merkliste
         ausstehender Nachrichten (`nachrichtenOhneEcho`, siehe Git-Verlauf):
         die ordnete jeden kennungslosen Fehler der einen ausstehenden
         Nachricht zu, wenn GENAU eine anstand — auch dem Protokoll, wenn das
         zufällig die einzige Sache war, die noch wartete, und blieb bei zwei
         gleichzeitig ausstehenden Nachrichten (`flush()` nach einer
         Verbindungspause) ganz ohne Zuordnung stehen.
         Ein alter Server ohne das Feld liefert `ev.clientId` als `undefined`
         — `markMessageFailed` wird dann gar nicht erst aufgerufen, und es
         geht direkt zum alten Weg über die Zeit: das Protokoll aufgeben,
         falls eins wartet. Das ist dieselbe Ungenauigkeit wie früher bei
         mehreren ausstehenden Nachrichten, aber ohne die Fehlzuordnung, die
         die alte Heuristik bei EINER ausstehenden hatte — nie schlechter als
         vorher, oft genauer. */
      if (ev.clientId && markMessageFailed(ev.clientId)) {
        store.toast({ kind: 'error', title: ts('toast.serverError'), body: meldung });
        break;
      }
      protokollBeenden(meldung);
      store.toast({ kind: 'error', title: ts('toast.serverError'), body: meldung });
      break;
    }
  }
});

/* ── Benachrichtigungen & Badge ─────────────────────────────── */

function inQuietHours(self: SelfUser): boolean {
  if (self.quietHoursStart == null || self.quietHoursEnd == null) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const { quietHoursStart: start, quietHoursEnd: end } = self;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function notifyIfNeeded(msg: Message): void {
  const s = useStore.getState();
  const self = s.self;
  if (!self || msg.userId === self.id || msg.systemKind) return;
  if (self.notifyOn === 'none') return;

  /* „Bitte nicht stören" heißt: gar nichts — auch keine Erwähnung. Anders als
     die Ruhezeiten, die dauerhaft gelten und deshalb eine Ausnahme brauchen,
     wird dieser Zustand bewusst gewählt und läuft von selbst wieder ab.
     Der Status muss aus der Nutzerliste kommen: `self` wird von
     presence-Ereignissen nicht fortgeschrieben und stünde auf dem Stand der
     Anmeldung. */
  if ((s.users[self.id]?.status ?? self.status) === 'dnd') return;

  const channel = s.channels[msg.channelId];
  const isDm = channel?.kind === 'dm';
  const isMention = msg.mentionUserIds.includes(self.id);
  if (self.notifyOn === 'mentions' && !isMention && !isDm) return;
  if (s.states[msg.channelId]?.muted && !isMention) return;

  // Ruhezeiten: nur direkte Erwähnungen kommen durch.
  if (inQuietHours(self) && !isMention) return;

  const focused = document.hasFocus() && s.activeChannelId === msg.channelId;
  if (focused) return;

  const author = s.users[msg.userId];
  const title = isDm
    ? (author?.displayName ?? ts('toast.newMessage'))
    : (channel?.name ? `#${channel.name}` : ts('toast.newMessage'));
  const prefix = isDm ? '' : `${author?.displayName ?? ''}: `;
  /* Übersetzung bevorzugen, damit die Vorschau in der eigenen Sprache steht.
     Aus einem vertraulichen Kanal geht nichts vom Inhalt in die
     Benachrichtigung: entschlüsselt wird beim Anzeigen, und eine Vorschau auf
     dem Sperrbildschirm ist genau das, was dort niemand erwartet. */
  const body = istE2EChiffrat(msg.text)
    ? `${prefix}${ts('vertraulich.titel')}`
    : `${prefix}${msg.translation?.text ?? msg.text}`.slice(0, 180);

  // In der App über Electron, im Browser über die Web-Benachrichtigung —
  // die Entscheidung darüber, OB benachrichtigt wird, steht oben und gilt für
  // beide gleich.
  zeigen({ titel: title, text: body, kanalId: msg.channelId, gruppe: msg.channelId });
}

function markReadIfViewing(msg: Message): void {
  const s = useStore.getState();
  if (s.activeChannelId !== msg.channelId || !document.hasFocus()) return;
  socket.send({ t: 'read', channelId: msg.channelId, lastMessageId: msg.id });
}

function updateBadge(): void {
  const s = useStore.getState();
  const total = Object.values(s.states).reduce((sum, st) => sum + (st.muted ? 0 : st.unreadCount), 0);
  void window.stellium?.setBadge(total);
  // Im Browser gibt es kein Dock-Symbol — dort trägt der Reitertitel die Zahl.
  titelZaehler(total);
}

/**
 * Nachsehen, ob der Server noch dasselbe Push-Abonnement kennt wie der
 * Browser — und es melden, wenn nicht.
 *
 * Läuft bei jedem 'ready' weiter unten, also bei jedem Verbindungsaufbau,
 * nicht nur beim ersten. Das ist bewusst so: die Erlaubnis kann zwischen zwei
 * Verbindungen erteilt worden sein (Knopf in den Einstellungen, während die
 * Leitung kurz stand), und ohne diese Wiederholung bliebe das erst beim
 * nächsten Neuladen der Seite nachgezogen.
 */
export function pushSynchronisieren(): void {
  if (erlaubnisStand() !== 'erlaubt') return;
  void pushAbonnieren().then((abo) => {
    if (abo) socket.send({ t: 'push:subscribe', subscription: abo });
  });
}

/* Der Browser erneuert ein Abonnement gelegentlich von sich aus (sw.js,
   'pushsubscriptionchange') — dann kommt es über den Service Worker als
   Nachricht herein (lib/benachrichtigung.ts reicht es als Ereignis weiter)
   und muss dem Server nachgereicht werden, sonst zeigt der noch auf einen
   `endpoint`, den es nicht mehr gibt. */
window.addEventListener('stellium:push-erneuert', ((e: CustomEvent<PushSubscriptionJSON>) => {
  socket.send({ t: 'push:subscribe', subscription: e.detail });
}) as EventListener);

/* Alte Tipp-Indikatoren regelmäßig aufräumen. */
window.setInterval(() => {
  const s = useStore.getState();
  const now = Date.now();
  let changed = false;
  const typing: StoreState['typing'] = {};
  for (const [channelId, users] of Object.entries(s.typing)) {
    const fresh: Record<string, number> = {};
    for (const [userId, ts] of Object.entries(users)) {
      if (now - ts < 5000) fresh[userId] = ts;
      else changed = true;
    }
    if (Object.keys(fresh).length) typing[channelId] = fresh;
  }
  if (changed) useStore.setState({ typing });
}, 2000);

/* Im Entwicklungsmodus greifbar, damit die Prüfläufe den Zustand ansehen
   können. In der gebauten App fällt dieser Block weg. */
if (import.meta.env.DEV) {
  (window as unknown as { __stelliumStore?: typeof useStore }).__stelliumStore = useStore;
}
