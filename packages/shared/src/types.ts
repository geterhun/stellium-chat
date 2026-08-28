/** Domänenmodelle — von Server und Desktop-Client geteilt. */

import type { Messwert } from './einheiten.js';
import type { MemberRoleName, PermissionKey } from './permissions.js';
import type { DateiHuelle } from './vertraulich.js';

export type UserStatus = 'online' | 'away' | 'dnd' | 'offline';
export type ChannelKind = 'public' | 'private' | 'dm';
export type MemberRole = MemberRoleName;

export interface User {
  id: string;
  handle: string;              // eindeutig, z.B. "don"
  displayName: string;
  email: string;
  avatarColor: string;         // Fallback-Avatar (Gradient-Seed)
  avatarUrl: string | null;
  title: string | null;        // Jobtitel
  timezone: string;            // IANA, z.B. "Europe/Berlin"
  language: string;            // Anzeigesprache (BCP-47 kurz: "de")
  autoTranslate: boolean;
  status: UserStatus;
  statusEmoji: string | null;
  statusText: string | null;
  /** Zeitpunkt, ab dem der Status automatisch zurückgesetzt wird. */
  statusExpiresAt: number | null;
  lastSeenAt: number | null;
  role: MemberRole;
  /** Gesperrte Konten können sich nicht anmelden, bleiben aber im Verlauf sichtbar. */
  disabled: boolean;
  /**
   * Ein technisches Konto — Assistent, Wartungszugang, Ausliefer-Konto.
   *
   * Es bleibt in der Liste, weil sonst seine Nachrichten ohne Namen dastünden,
   * ist aber nirgends anzutippen: nicht in der Erwähnungsliste, nicht in der
   * Mitgliederliste eines Kanals, nicht als Ziel einer Direktnachricht. Wer
   * verwalten darf, sieht es weiterhin im Reiter „Mitglieder".
   */
  technisch: boolean;
  createdAt: number;
}

/** Was der Client über sich selbst weiß (inkl. privater Felder). */
export interface SelfUser extends User {
  notifyOn: 'all' | 'mentions' | 'none';
  /** Status folgt dem Fenster: im Vordergrund online, sonst abwesend. */
  autoStatus: boolean;
  /**
   * Gilt `timezone` (siehe User oben) noch als unbestätigt?
   *
   * true: niemand hat die Zeitzone je bestätigt — weder von Hand in
   * Settings.tsx noch durch den einmaligen Nachtrag vom Browser (siehe
   * state/store.ts, zeitzoneNachtragen). Der Wert in `timezone` kann dann
   * ein bloßer Platzhalter sein (createAccount() in services/users.ts setzt
   * beim Anlegen durch die Leitung immer 'Europe/Berlin', ganz gleich, wo
   * die Person sitzt). Der Client darf in diesem Zustand die vom Browser
   * erkannte Zeitzone einmal automatisch eintragen.
   *
   * false: die Zeitzone ist bestätigt (Mensch oder Nachtrag hat sie
   * geschrieben) — kein Client darf sie ab jetzt noch von selbst ändern,
   * auch nicht nach einer Dienstreise. Nur andere über sich selbst sichtbar,
   * deshalb auf SelfUser und nicht auf User.
   */
  timezoneAuto: boolean;
  /**
   * Andere sehen dann nicht mehr, OB und WANN diese Person eine Nachricht
   * gelesen hat — weder in der gebündelten Anfrage (readReceiptsBatch) noch
   * in der laufenden Meldung an offene Kanäle. Die eigene Lesemarke läuft
   * serverseitig unverändert weiter, und mit ihr der eigene Ungelesen-Zähler:
   * abgeschaltet wird nur die Ausgabe an andere, nicht das Mitschreiben.
   */
  lesebestaetigungAus: boolean;
  quietHoursStart: number | null;  // Minuten seit Mitternacht, lokal
  quietHoursEnd: number | null;
  composeTargetPreview: boolean;   // Übersetzungs-Vorschau vor dem Senden
  theme: 'system' | 'dark' | 'light';
  density: 'comfortable' | 'compact';
  /** Klang bei Benachrichtigungen — "aus" schaltet ihn ab. */
  notificationSound: string;
  /** "fast" nutzt das kleine Modell, "accurate" das große, "balanced" entscheidet nach Textlänge. */
  translationSpeed: 'fast' | 'balanced' | 'accurate';
  /** Sprache der Oberfläche — unabhängig von der Übersetzungssprache. */
  uiLanguage: string;
  /** Was diese Person darf. Vom Server berechnet, hier nur zur Anzeige. */
  permissions: Record<PermissionKey, boolean>;
  /** Erstanmeldung mit Einmal-Passwort: eigenes Passwort setzen. */
  mustChangePassword: boolean;
  /** Benutzername und E-Mail fehlen noch. */
  mustCompleteProfile: boolean;
  email: string;
}

/** Was die Verwaltung über ein Konto sieht. */
/**
 * Schubladen in der Kontenverwaltung.
 *
 * Bei acht Konten hilft eine Liste, bei achtzig nicht mehr. Die Einordnung
 * geschieht von selbst — neue Konten landen unter "neu", Bots unter
 * "technisch", gelöschte unter "geloescht" — und lässt sich jederzeit von Hand
 * ändern. Nur "geloescht" ist nicht verhandelbar: was gelöscht ist, gehört
 * nirgendwo anders hin.
 */
export const KONTO_KATEGORIEN = [
  'neu', 'mitglieder', 'leitung', 'technisch', 'extern', 'geloescht',
] as const;
export type KontoKategorie = (typeof KONTO_KATEGORIEN)[number];

export interface ManagedUser {
  id: string;
  handle: string;
  displayName: string;
  /** Aus Datenschutzgründen nur angedeutet, z.B. "an•••@firma.de". */
  emailMasked: string;
  role: MemberRole;
  disabled: boolean;
  /** Gelöscht heißt: anonymisiert, damit Nachrichten lesbar bleiben. */
  deletedAt: number | null;
  /** Schublade in der Verwaltung. Leer heißt: von selbst einsortieren. */
  kategorie: KontoKategorie | null;
  mustChangePassword: boolean;
  /**
   * Hat dieses Konto einen Notzugang? Mehr nicht — nicht wer Anteile hält,
   * nicht wie viele noch tragen.
   *
   * Die Verwaltung braucht genau diese eine Auskunft, und zwar im Augenblick
   * des Zurücksetzens: mit Notzugang SCHONT das Zurücksetzen den
   * Kontoschlüssel (services/kontoschluessel.ts, verwerfen()), das alte
   * Passwort öffnet die Notiz- und Tresorpakete also weiterhin, sobald
   * jemand an eine Sicherung kommt. Bei einem DURCHGESICKERTEN Passwort ist
   * das der falsche Weg — dort gehört erst der Notzugang aufgehoben. Ohne
   * dieses Feld setzt eine Verwaltung zurück und glaubt, der alte Schlüssel
   * sei verbrannt.
   */
  hatNotzugang: boolean;
  /**
   * Würde „Notzugang aufheben" für DIESES Konto JETZT den Kontoschlüssel
   * niederbrennen, statt nur die Rettungsleine zu kappen?
   *
   * Eine engere, zweite Auskunft neben `hatNotzugang` — nicht WER Anteile
   * hält, nicht WIE VIELE noch tragen, sondern die unmittelbare Folge des
   * einen Knopfs, den TeamAdmin.tsx zeigt. Ohne dieses Feld sah die
   * Verwaltung ein und denselben Knopf mit ein und derselben Beschriftung,
   * der je nach Zustand des Ziels entweder nur eine künftige Absicherung
   * kappt oder Notizen und Passwort-Tresor sofort und endgültig vernichtet
   * — und konnte die beiden vor dem Klick nicht unterscheiden.
   */
  notzugangAufhebenVerbrennt: boolean;
  lastSeenAt: number | null;
  createdAt: number;
  createdBy: string | null;
  /** Abweichungen von der Rollenvorgabe. */
  overrides: Partial<Record<PermissionKey, boolean>>;
  permissions: Record<PermissionKey, boolean>;
  /**
   * Welche Fassung dieses Konto zuletzt beim Anmelden gemeldet hat — und von
   * welcher Plattform. Auslöser: eine Rückfrage aus dem Support ("ich habe
   * die neue Version noch nicht"), die sich von der Verwaltung aus nicht
   * nachprüfen ließ. Siehe ws/gateway.ts (authenticate()) fürs Melden und
   * services/store.ts (clientMeldung()) fürs Schreiben.
   *
   * Bewusst NUR hier auf ManagedUser, nicht auf User/SelfUser: welche Version
   * ein Gerät fährt, ist eine betriebliche, keine geheime Tatsache — aber
   * eben doch eine Tatsache über EIN GERÄT einer bestimmten Person, und geht
   * nur die Verwaltung etwas an (dieselbe Schranke wie bei `hatNotzugang`
   * oben: nicht alles, was man wüsste, muss man auch herausgeben). Wer diese
   * Auskunft sehen darf, bestimmt schon die Berechtigung hinter
   * `/api/admin/users` (`user.manage`) — keine zusätzliche Schranke nötig.
   *
   * `null` heißt: noch nie gemeldet — ein Konto, das sich seit dieser
   * Fassung noch nicht angemeldet hat, oder ein Client, der das Feld noch
   * nicht kennt.
   */
  clientVersion: string | null;
  /** 'darwin' | 'win32' | 'linux' (App) oder 'browser' (Web/PWA). Siehe clientVersion. */
  clientPlatform: string | null;
  /** Wann zuletzt gemeldet — nicht dasselbe wie lastSeenAt, das während einer offenen Verbindung weiterläuft. */
  clientVersionAt: number | null;
  /**
   * Ist `clientVersion` die für `clientPlatform` aktuell verteilte Fassung?
   * Rechnet services/releases.ts (clientAktuell()) mit derselben istNeuer()-
   * Prüfung aus, die auch /api/releases/check verwendet — keine zweite,
   * eigene Versionsvergleichslogik (die gab es in UpdatePanel.tsx schon
   * einmal als Nachbau, ein drittes Mal muss es nicht sein).
   *
   * `null`: keine Vergleichsgrundlage — entweder wurde noch nie gemeldet,
   * oder für `clientPlatform` liegt (noch) gar keine Fassung bereit.
   */
  clientVersionAktuell: boolean | null;
}

/** Ergebnis, wenn ein Konto angelegt oder ein Passwort zurückgesetzt wurde. */
export interface OneTimeCredential {
  userId: string;
  handle: string;
  displayName: string;
  oneTimePassword: string;
  /** Nur ein einziges Mal sichtbar — danach nicht mehr abrufbar. */
  expiresAt: number;
}

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;                // bei DMs leer -> Client rendert Teilnehmer
  topic: string | null;
  purpose: string | null;
  /** "Lingua Franca" des Kanals — Basis für die Compose-Vorschau. */
  primaryLanguage: string | null;
  /** Mischt der KI-Assistent hier mit? "off" | "mention" | "always" */
  aiMode: 'off' | 'mention' | 'always';
  /** Nur Berechtigte dürfen schreiben — für Ankündigungskanäle. */
  readOnly: boolean;
  /**
   * Ende-zu-Ende verschlüsselt: der Server sieht nur Chiffrat.
   *
   * Damit fallen alle Funktionen weg, die Klartext brauchen — Übersetzung,
   * Zusammenfassungen, Antwortvorschläge, serverseitige Suche,
   * Aufgabenerkennung. Das ist kein Versehen, sondern der Preis dafür, dass
   * auch der Server nicht mitliest.
   */
  vertraulich: boolean;
  /**
   * Welche Fassung des Kanalschlüssels gerade gilt.
   *
   * Sie zählt hoch, sobald jemand den Kanal verlässt. Alte Nachrichten bleiben
   * mit der alten Fassung lesbar: wer geht, verliert nicht rückwirkend, was er
   * ohnehin schon gelesen hat — aber alles Neue bleibt ihm verschlossen.
   */
  schluesselFassung: number;
  archived: boolean;
  createdBy: string;
  createdAt: number;
  memberIds: string[];
  /** Nur bei DMs gefüllt. */
  dmPeerId?: string | null;
  /** Angezeigter Name, Thema und Zweck in der Lesesprache. */
  translation?: {
    lang: string;
    name: string | null;
    topic: string | null;
    purpose: string | null;
  } | null;
}

export interface ChannelState {
  channelId: string;
  lastReadMessageId: string | null;
  unreadCount: number;
  mentionCount: number;
  muted: boolean;
  starred: boolean;
}

/**
 * Wer eine Nachricht gelesen hat, und wann.
 *
 * Abgeleitet aus der Lesemarke des Kanals (channel_members.last_read_message_id
 * / last_read_at), nicht aus einer eigenen Zeile pro Nachricht — sonst gäbe es
 * zwei Wahrheiten darüber, was gelesen ist, und die Tabelle wüchse mit
 * Nachrichten × Personen statt mit Personen × Kanälen.
 *
 * `at` ist null, wenn die Marke vor dieser Fassung gesetzt wurde: der genaue
 * Zeitpunkt ist dann nicht mehr bekannt. Die Nachricht gilt trotzdem als
 * gelesen, nur ohne Uhrzeit dazu — erfunden wird hier nichts.
 */
export interface ReadReceipt {
  userId: string;
  at: number | null;
}

export interface Attachment {
  id: string;
  messageId: string;
  name: string;
  mime: string;
  size: number;
  url: string;                 // relativ zum Server: /files/<id>
  width: number | null;
  height: number | null;
  /**
   * Für welchen Kreis der Dateischlüssel verpackt ist — null heißt: offen.
   *
   * Die Oberfläche braucht das, bevor sie irgendetwas anzeigt: bei einer
   * verschlossenen Datei sind `name` und `mime` nur Platzhalter, die echten
   * stehen im Umschlag der Datei. Ein `<img src>` darauf ergäbe ein kaputtes
   * Bild — geholt, aufgeschlossen und angezeigt wird sie in der App.
   */
  huelle: DateiHuelle | null;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

/** Ergebnis einer Übersetzung, wie es der Client sieht. */
export interface TranslationView {
  lang: string;                // Zielsprache
  text: string;
  provider: string;            // "groq" | "deepl" | "libre" | "demo"
  model: string | null;
  /** 0..1 — Heuristik aus Round-Trip-Ähnlichkeit bzw. Provider-Angabe. */
  confidence: number | null;
  cached: boolean;
  /**
   * true heißt: es gibt keine Übersetzung, `text` ist das Original.
   *
   * Der Anbieter hat entweder den Eingabetext zurückgegeben oder gar nicht
   * geantwortet. Die Oberfläche muss das dann als Original ausweisen — ein
   * „Übersetzt aus …" an unübersetztem Text ist eine Falschauskunft.
   */
  unuebersetzt?: boolean;
  /**
   * Erkannte Maßangaben (25 °C, 10 kg, …), NUR serverseitig zwischen
   * translateMessage() und messwerteFuerEmpfaenger() (siehe translation/
   * index.ts) — an dieser Stelle steht in `text` an ihrer Position noch ein
   * sprach- und regionsneutraler Sentinel, keine fertige Zahl. Ein Client
   * bekommt dieses Feld nie zu Gesicht: messwerteFuerEmpfaenger() löst die
   * Sentinels für die einzelne Empfängerin auf und entfernt das Feld wieder,
   * bevor die Ansicht über die Leitung geht.
   */
  measurements?: Record<number, Messwert>;
}

/**
 * Übersetzte Textfelder einer Karte: Aufgabe, Termin, Idee, Vorschlag.
 *
 * Bis hierher konnte die Oberfläche nur den Chat übersetzen. Kanal, Nachricht
 * und Umfrage hatten je eine eigene, benannte Gestalt (`name`/`topic`,
 * `question`/`options`) — vier weitere davon wären vier fast gleiche
 * Schnittstellen gewesen, die sich nur in den Feldnamen unterscheiden.
 *
 * Darum ein Wörterbuch: `felder` trägt nur, was es zu übersetzen GAB. Ein
 * Feld, das leer war oder schon in der Lesesprache stand, fehlt hier — und
 * `uebersetztesFeld()` fällt dann auf das Original zurück. Das ist der
 * Unterschied zu „übersetzt zu einer leeren Zeichenkette", der sonst eine
 * gefüllte Beschreibung stillschweigend verschwinden ließe.
 */
export interface KartenUebersetzung {
  /** Zielsprache — dieselbe Schreibweise wie `User.language`. */
  lang: string;
  /** Feldname der Karte -> übersetzter Text. */
  felder: Record<string, string>;
  provider: string;
}

/**
 * Ein Textfeld in der Lesesprache, sonst das Original.
 *
 * Warum an einer Stelle und nicht je Karte: alle vier Ansichten treffen
 * dieselbe Entscheidung, und sie ist leicht falsch zu treffen — `??` allein
 * greift bei `''` nicht, `||` wirft eine echte Übersetzung weg, die
 * absichtlich leer ist. Hier steht sie einmal.
 */
export function uebersetztesFeld<T extends { translation?: KartenUebersetzung | null }>(
  karte: T,
  feld: string,
  original: string | null,
): string | null {
  const uebersetzt = karte.translation?.felder[feld];
  return uebersetzt === undefined ? original : uebersetzt;
}

export interface Message {
  id: string;
  channelId: string;
  userId: string;
  parentId: string | null;     // Thread-Wurzel
  text: string;                // IMMER das Original
  sourceLang: string | null;   // erkannt oder vom Client gesetzt
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  systemKind: string | null;   // "join" | "leave" | "topic" | null
  attachments: Attachment[];
  reactions: Reaction[];
  replyCount: number;
  lastReplyAt: number | null;
  threadParticipantIds: string[];
  mentionUserIds: string[];
  pinned: boolean;
  /** "text" | "voice" | "poll" — bestimmt, wie die Nachricht dargestellt wird. */
  kind: string;
  /** Gesetzt, wenn die Nachricht aus einem anderen Kanal weitergeleitet wurde. */
  forwardedFrom: { messageId: string; channelId: string; userId: string } | null;
  /** Umfrage, falls kind === "poll". */
  poll: Poll | null;
  /** Sprachnachricht, falls kind === "voice". */
  voice: VoiceNote | null;
  /** Vorschauen zu Links im Text. */
  links: LinkPreview[];
  /** Für den Empfänger vorbereitete Übersetzung (falls Sprache abweicht). */
  translation: TranslationView | null;
  /** Für mich ausgeblendet (nicht für alle gelöscht). */
  hiddenForMe?: boolean;
  /** Optimistisch gesendete Nachricht — nur clientseitig gesetzt. */
  pending?: boolean;
  failed?: boolean;
  clientId?: string;
  /**
   * Anhänge, die beim Senden noch nicht fertig hochgeladen waren.
   *
   * Nichts davon steht in der Datenbank — die Nachricht selbst ging schon
   * hinaus, damit niemand auf einen Bildupload warten muss. Der Server merkt
   * sich diese Liste nur im Speicher (siehe ws/gateway.ts) und schickt sie mit
   * `message:new`/`message:updated` mit, solange noch etwas aussteht; sobald
   * ein Anhang ankommt oder aufgegeben wird, verschwindet sein Eintrag hier.
   * Ein Neustart des Servers oder ein Nachladen des Verlaufs zeigt deshalb nie
   * einen für immer "wird hochgeladen" hängenden Platzhalter — bestenfalls
   * fehlt der Hinweis, nie eine falsche Zusage.
   */
  pendingAttachments?: { tempId: string; name: string; mime: string }[];
}

export interface SearchHit {
  message: Message;
  channelId: string;
  /** Textausschnitt mit <em>-Markierungen. */
  snippet: string;
  /** true, wenn der Treffer in der Übersetzung lag, nicht im Original. */
  matchedTranslation: boolean;
  score: number;
}

export interface GlossaryEntry {
  id: string;
  term: string;
  /** null = Begriff bleibt in jeder Sprache unverändert (z.B. Produktnamen). */
  translations: Record<string, string> | null;
  caseSensitive: boolean;
  note: string | null;
  createdBy: string;
  createdAt: number;
}

export interface ScheduledMessage {
  id: string;
  channelId: string;
  userId: string;
  text: string;
  sendAt: number;
  parentId: string | null;
  createdAt: number;
}

export interface AiSummary {
  channelId: string;
  fromMessageId: string | null;
  language: string;
  headline: string;
  bullets: string[];
  actionItems: { text: string; assigneeId: string | null }[];
  decisions: string[];
  messageCount: number;
  generatedAt: number;
  model: string;
}

export interface SmartReply {
  text: string;
  tone: 'kurz' | 'freundlich' | 'formell' | 'nachfrage';
}

/* ── Umfragen ─────────────────────────────────────────────────── */

export interface PollOption {
  id: string;
  text: string;
  voterIds: string[];      // bei anonymen Umfragen leer
  votes: number;
}

export interface Poll {
  id: string;
  messageId: string;
  question: string;
  options: PollOption[];
  multiple: boolean;
  anonymous: boolean;
  closed: boolean;
  closesAt: number | null;
  createdBy: string;
  totalVoters: number;
  /**
   * Optionen, die der Betrachter gewählt hat.
   * Bei anonymen Umfragen immer leer, auch für die eigene Stimme — welche
   * Antwort es war, steht nach dem Abstimmen nirgends mehr, siehe hasVoted.
   */
  myVotes: string[];
  /**
   * Hat der Betrachter überhaupt schon abgestimmt? Bei offenen Umfragen
   * gleichbedeutend mit `myVotes.length > 0`. Bei anonymen Umfragen die
   * EINZIGE Auskunft, die es zur eigenen Stimme noch gibt — welche Option es
   * war, weiß danach niemand mehr, auch der Server nicht.
   */
  hasVoted: boolean;
  /** Frage und Antworten in der Lesesprache, falls übersetzt. */
  translation?: {
    lang: string;
    question: string;
    options: Record<string, string>;
    provider: string;
  } | null;
}

/* ── Link-Vorschau ────────────────────────────────────────────── */

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site: string | null;
}

/* ── Sprachnachricht ──────────────────────────────────────────── */

export interface VoiceNote {
  attachmentId: string;
  url: string;
  durationMs: number | null;
  /** Von Whisper erzeugtes Transkript — null, solange es noch läuft. */
  transcript: string | null;
  transcriptLang: string | null;
  /** Transkript in der Sprache des Betrachters. */
  translatedTranscript: string | null;
}

/* ── Erinnerungen ─────────────────────────────────────────────── */

export interface Reminder {
  id: string;
  messageId: string | null;
  channelId: string;
  note: string | null;
  remindAt: number;
  done: boolean;
  createdAt: number;
}

/* ── Web Push ─────────────────────────────────────────────────── */

/**
 * Genau die Form, die `PushSubscription.toJSON()` im Browser liefert.
 *
 * Absichtlich nicht das ganze `PushSubscription`-Objekt: das hat Methoden
 * (`unsubscribe()`, `getKey()`) und lässt sich nicht über die Leitung
 * schicken. Diese drei Felder sind alles, was der Server braucht, um später
 * — ohne dass die App offen ist — eine verschlüsselte Nachricht an genau
 * dieses Gerät zu schicken.
 */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: {
    /** Öffentlicher ECDH-Schlüssel des Geräts, für die Verschlüsselung. */
    p256dh: string;
    /** Geheimnis des Geräts, geht als Salz in dieselbe Verschlüsselung ein. */
    auth: string;
  };
}

/* ── Entwürfe ─────────────────────────────────────────────────── */

export interface Draft {
  channelId: string;
  parentId: string | null;
  text: string;
  updatedAt: number;
}

/* ── Modellwahl ───────────────────────────────────────────────── */

export interface AiModelInfo {
  id: string;
  contextWindow: number;
  params: number | null;
  ownedBy: string;
  usable: boolean;
  rejected: string | null;
}

export interface AiModelSelection {
  quality: string;
  fast: string;
  source: 'auto' | 'pinned' | 'manual' | 'fallback';
  refreshedAt: number;
}

/* ── Aufgaben ─────────────────────────────────────────────────── */

export type TaskStatus = 'pending' | 'working' | 'review' | 'finished' | 'blocked';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Reihenfolge der Spalten auf dem Brett. */
export const TASK_STATUSES: TaskStatus[] = ['pending', 'working', 'review', 'finished', 'blocked'];
export const TASK_PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

/**
 * Wer den Eintrag angelegt hat — und ob ein Mensch schon daraufgesehen hat.
 *
 * Trägt die KI selbst ein (Einstellung „kiTraegtEin"), landet der Eintrag
 * nicht mitten im Brett, sondern im Reiter „Prüfen": sichtbar, aber als
 * ungeprüft gekennzeichnet. Erst ein Mensch macht daraus einen normalen
 * Eintrag. Ohne diese Trennung stünde nach einer Woche ein Brett voll
 * halbrichtiger Karten, und niemand wüsste mehr, welche davon jemand
 * gelesen hat.
 */
export interface KiHerkunft {
  /** Von der KI angelegt (statt von einem Menschen). */
  vonKi: boolean;
  /** Von einem Menschen bestätigt. Bis dahin steht der Eintrag unter „Prüfen". */
  geprueft: boolean;
}

export interface Task extends KiHerkunft {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  channelId: string | null;
  messageId: string | null;
  dueAt: number | null;
  /** Projekt, zu dem die Aufgabe gehört. Ohne Projekt: null. */
  projektId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  watcherIds: string[];
  /** Titel und Beschreibung in der Lesesprache, falls übersetzt. */
  translation?: KartenUebersetzung | null;
}

/**
 * Ein Projekt bündelt Aufgaben.
 *
 * Bewusst schlank: Name, Farbe, ein Satz dazu. Wer Projekte mit Terminen,
 * Budgets und Phasen aufbläht, baut ein zweites Aufgabenbrett daneben —
 * hier ist es eine Schublade, mehr nicht.
 */
export interface Projekt {
  id: string;
  name: string;
  beschreibung: string | null;
  /** Eine der Farben aus PROJEKT_FARBEN — für den Punkt am Kartenrand. */
  farbe: string;
  archiviert: boolean;
  createdBy: string;
  createdAt: number;
  /** Wie viele Aufgaben daran hängen, und wie viele davon fertig sind. */
  aufgaben: number;
  fertig: number;
}

/** Die Farben, aus denen ein Projekt wählen kann. */
export const PROJEKT_FARBEN = [
  '#7c5cff', '#22b8cf', '#37b24d', '#f59f00', '#f03e3e', '#ae3ec9',
] as const;

export interface TaskEvent {
  id: string;
  taskId: string;
  userId: string;
  kind: 'created' | 'status' | 'assignee' | 'due' | 'priority' | 'title' | 'comment';
  von: string | null;
  nach: string | null;
  text: string | null;
  createdAt: number;
}

/* ── Kalender ─────────────────────────────────────────────────── */

export type EventKind = 'meeting' | 'deadline' | 'absence' | 'holiday' | 'reminder';
export type AttendeeResponse = 'pending' | 'yes' | 'no' | 'maybe';

export const EVENT_KINDS: EventKind[] = ['meeting', 'deadline', 'absence', 'holiday', 'reminder'];

export interface EventAttendee {
  userId: string;
  response: AttendeeResponse;
}

export interface CalendarEvent extends KiHerkunft {
  id: string;
  title: string;
  description: string | null;
  kind: EventKind;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location: string | null;
  channelId: string | null;
  createdBy: string;
  createdAt: number;
  attendees: EventAttendee[];
  /** Titel, Beschreibung und Ort in der Lesesprache, falls übersetzt. */
  translation?: KartenUebersetzung | null;
}

/* ── Ankündigung einer Serverauszeit ──────────────────────────── */

export interface ServerUpdateInfo {
  version: string;
  notes: string | null;
  /** Wann es losgeht — Millisekunden seit der Epoche. */
  startetUm: number;
  /** Wie lange es voraussichtlich dauert, in Millisekunden. */
  dauertEtwa: number;
  /** Uhrzeit des Servers beim Absenden, um Abweichungen auszugleichen. */
  serverZeit: number;
}

/* ── App-Versionen ────────────────────────────────────────────── */

/** Auch der Server selbst bekommt seine Stände über denselben Weg. */
export type ReleasePlatform = 'darwin' | 'win32' | 'linux' | 'server';

export interface ReleaseInfo {
  platform: ReleasePlatform;
  version: string;
  notes: string | null;
  size: number;
  /** Prüfsumme der Datei, damit der Client den Download überprüfen kann. */
  sha256: string;
  fileName: string;
  url: string;
  publishedBy: string;
  publishedAt: number;
}

/* ── Ideenboard ───────────────────────────────────────────────── */

export type IdeaStatus = 'new' | 'working' | 'done' | 'rejected';
export const IDEA_STATUSES: IdeaStatus[] = ['new', 'working', 'done', 'rejected'];

export interface Idea extends KiHerkunft {
  id: string;
  title: string;
  body: string | null;
  status: IdeaStatus;
  tag: string;
  channelId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decision: string | null;
  upvotes: number;
  downvotes: number;
  /** Eigene Stimme: 1 dafür, -1 dagegen, 0 keine. */
  myVote: 1 | -1 | 0;
  commentCount: number;
  /** Titel, Text und Entscheidung in der Lesesprache, falls übersetzt. */
  translation?: KartenUebersetzung | null;
}

export interface IdeaComment {
  id: string;
  ideaId: string;
  userId: string;
  text: string;
  createdAt: number;
}

/* ── Vorschlagseingang ────────────────────────────────────────── */

/**
 * Woraus ein angenommener Vorschlag wird.
 *
 * Die Art rät das Modell — sie ist der unsicherste Teil eines Vorschlags.
 * Deshalb ist sie auf der Karte umschaltbar und nicht als Reiter verbaut:
 * ein Fehlgriff kostet einen Klick, nicht den ganzen Vorschlag.
 */
export type VorschlagArt = 'aufgabe' | 'idee' | 'termin';

/** Alle Arten in der Reihenfolge, in der die Oberfläche sie zeigt. */
export const VORSCHLAG_ARTEN: VorschlagArt[] = ['aufgabe', 'idee', 'termin'];

/**
 * Der Weg eines Vorschlags: `offen` -> angenommen, abgelehnt oder verfallen.
 *
 * Abgelehnte und verfallene Zeilen bleiben stehen. Sie belegen weiter ihren
 * Platz in `UNIQUE(channel_id, art, abdruck)` und sind damit das Gedächtnis,
 * das denselben Vorschlag nicht wiederkommen lässt — auch nicht anders
 * formuliert, auch nicht nach einem Neustart.
 */
export type VorschlagZustand = 'offen' | 'angenommen' | 'abgelehnt' | 'verfallen';

/** Was die Oberfläche von einem Vorschlag sieht. */
export interface Vorschlag {
  id: string;
  art: VorschlagArt;
  zustand: VorschlagZustand;
  titel: string;
  channelId: string;
  /** Name des Kanals, damit die Karte ihn ohne zweiten Abruf zeigen kann. */
  channelName: string;
  quelleMessageId: string | null;
  /**
   * Der Wortlaut der Nachricht, aus der er stammt — gekürzt.
   *
   * Aus einem vertraulichen Kanal steht hier immer `null`: der Server kann
   * den Inhalt nicht lesen, und was er nicht lesen kann, gibt er nicht heraus.
   */
  quelleText: string | null;
  quelleUserId: string | null;
  quelleAm: number | null;
  /** Genau ein Adressat — wer ihn annehmen oder ablehnen darf. */
  fuerUserId: string;
  genanntUserId: string | null;
  faelligAm: number | null;
  /** Nur bei „termin": Beginn und Dauer des vorgeschlagenen Kalendereintrags. */
  beginntAm: number | null;
  dauerMinuten: number | null;
  erstelltAm: number;
  /** Bei angenommenen: die Kennung der entstandenen Aufgabe oder Idee. */
  ergebnisId: string | null;
  /**
   * Titel und Quelltext in der Lesesprache, falls übersetzt.
   *
   * Aus einem vertraulichen Kanal bleibt das immer `null` — dort ist schon
   * `quelleText` null, und der Titel darf denselben Weg nicht gehen: was der
   * Server nicht lesen darf, schickt er auch nicht an ein Übersetzungsmodell.
   */
  translation?: KartenUebersetzung | null;
}

/**
 * Was sich vor dem Annehmen ändern lässt.
 *
 * Genau die vier Felder entscheiden, ob man Ja sagen kann, und genau die
 * trifft das Modell knapp daneben. Beschreibung, Wichtigkeit, Schlagwort und
 * Status gehören dem fertigen Ding und bleiben dem Brett.
 */
export interface VorschlagAenderung {
  titel?: string;
  art?: VorschlagArt;
  zustaendigId?: string | null;
  faelligAm?: number | null;
}

/* ── Post-Sichtung: KI-Meldungen zur Firmenpost ──────────────────
 *
 * Was `packages/server/src/services/post-sichtung.ts` aus einer eingegangenen
 * Mail macht, für die Oberfläche — strukturiert statt als Fließtext, und ohne
 * jede technische Kennung (die bleibt serverseitig; `mailId` ist die einzige
 * Ausnahme und wird selbst nirgends angezeigt, sie führt nur über
 * `jumpToPostMail()` in den Postfach-Reiter).
 */

/**
 * Wer geschrieben hat, so wie die KI-Sichtung es einordnet.
 *
 * Dieselben vier Werte wie in der Anweisung an das Modell
 * (server/services/post-ki.ts) — `behörde` bleibt mit Umlaut, exakt der Wert,
 * den Modell und Datenbank tragen.
 */
export type Absenderart = 'privatperson' | 'firma' | 'behörde' | 'automat';

/** Wie dringend die KI-Sichtung eine eingegangene Mail einordnet. */
export type Dringlichkeit = 'niedrig' | 'normal' | 'hoch';

/**
 * Der Weg einer Sichtung — dieselben Werte wie `mail_sichtung.zustand` auf
 * dem Server (siehe dort). `laeuft` heißt: eben erst eingegangen, die KI
 * fragt gerade noch das Modell.
 */
export type Sichtungszustand = 'laeuft' | 'gemeldet' | 'entwurf' | 'gesendet' | 'abgelehnt' | 'fehler';

/** Was die KI aus einer Mail herausgelesen hat. */
export interface Einordnung {
  absenderart: Absenderart;
  anliegen: string;
  dringlichkeit: Dringlichkeit;
  antwortNoetig: boolean;
  begruendung: string;
  /** In welcher Sprache geantwortet würde. */
  sprache: string;
  /** Welches Modell geurteilt hat. */
  modell: string | null;
}

/**
 * Warum (noch) kein Entwurf entstand, oder dass einer bereitliegt oder schon
 * entschieden ist — eine Kennung, kein Satz.
 *
 * post-sichtung.ts läuft auf dem Server, ohne Wörterbuch-Kontext, und legt
 * deshalb keinen deutschen Anzeigetext mehr fest — dieselbe Bauart wie bei
 * `PostFehler`/`fehler()` in routes.ts: Kennung hin, Übersetzung erst in der
 * Oberfläche (`postSichtung.grund.*` im Wörterbuch).
 */
export type MeldungGrundCode =
  | 'entwurfWartet' | 'entwurfGesendet' | 'entwurfAbgelehnt'
  | 'keinAntwortNoetig' | 'keinDmarc' | 'keineAdresse' | 'modellFehler';

/**
 * Der Warnsatz bei abweichender Reply-To-Domäne — als Werte, nicht als
 * fertiger Satz, aus demselben Grund wie bei `MeldungGrundCode`: die beiden
 * Adressen füllen die Platzhalter in `postSichtung.abweichung` im
 * Wörterbuch. Die Bedeutung bleibt dieselbe wie in `abweichungsHinweis()`
 * (post-sichtung.ts): DMARC bestätigt nur die Domäne im `From:`, eine
 * Antwort ginge aber an `an` — und das muss vor einer Freigabe auffallen.
 */
export interface PostMeldungAbweichung {
  /** Wohin die Antwort tatsächlich ginge. */
  an: string;
  /** Wer die Mail sichtbar geschrieben hat. */
  von: string;
}

/** Eine Zeile im Reiter „Post-Sichtung" — eine eingegangene Mail und was die KI daraus machte. */
export interface PostMeldung {
  /** Führt über `jumpToPostMail()` zur Mail im Postfach-Reiter — wird selbst nicht angezeigt. */
  mailId: string;
  fach: string;
  von: string;
  betreff: string;
  /** Wann die Sichtung zuletzt einen Stand festhielt — Sortier- und Blätterkennung zugleich. */
  gesichtetAm: number;
  zustand: Sichtungszustand;
  /** `null`, solange die Sichtung noch läuft oder das Modell nicht geantwortet hat. */
  einordnung: Einordnung | null;
  grundCode: MeldungGrundCode | null;
  /** Nur gesetzt, solange ein Entwurf offen ist und die Domänen abweichen. */
  abweichung: PostMeldungAbweichung | null;
}

/**
 * Ein Anhang an einer Mail — eingegangen oder ausgehend.
 *
 * `typ` ist die Behauptung des Absenders (oder, beim Verfassen, der eigene
 * Dateityp) und taugt nur für ein Symbol in der Oberfläche. Ausgeliefert wird
 * ein eingegangener Anhang IMMER als `application/octet-stream` mit
 * erzwungenem Download — welcher Typ hier steht, ändert daran nichts (siehe
 * die Begründung an der Auslieferungsroute in http/routes.ts).
 *
 * `id` fehlt (ist `null`), wenn es zu diesem Anhang keine Bytes gibt — zu
 * groß für den Cloudflare-Worker, keine oder eine unlesbare Kodierung. Das
 * ist ein Zustand, den die Oberfläche ZEIGEN muss (siehe PostAnhaenge.tsx),
 * nicht stillschweigend weglassen: eine Bewerbung ohne Lebenslauf soll
 * auffallen, nicht als vollständig durchgehen.
 */
export interface MailAnhang {
  /** Kennung des `mail_anhaenge`-Eintrags — Grundlage für den Downloadpfad. `null` ohne Bytes. */
  id: string | null;
  name: string;
  typ: string;
  groesse: number;
  /** Keine Bytes verfügbar — meist zu groß für den Worker (>1 MB je Anhang
      oder die Mail insgesamt >5 MB), seltener eine unlesbare Kodierung.
      In beiden Fällen bleibt `id` null — siehe Dateikopf. */
  uebergross: boolean;
}

/* ── Protokoll ────────────────────────────────────────────────── */

/** Ergebnis einer Besprechung, weitergabefähig zusammengefasst. */
export interface MeetingProtocol {
  channelId: string;
  language: string;
  title: string;
  topics: { heading: string; points: string[] }[];
  decisions: string[];
  openQuestions: string[];
  actionItems: { text: string; assigneeId: string | null }[];
  messageCount: number;
  generatedAt: number;
}

/* ── Dateiablage ──────────────────────────────────────────────── */

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  /**
   * Privat heißt: der Inhalt wurde in der App verschlüsselt, bevor er den
   * Rechner verlassen hat. Der Server verwahrt ihn, kann ihn aber nicht
   * öffnen — auch nicht mit dem Masterpasswort.
   */
  privat: boolean;
  folder: string;
  channelId: string | null;
  description: string | null;
  uploadedBy: string;
  createdAt: number;
  updatedAt: number;
  url: string;
}

export interface StorageUsage {
  used: number;
  quota: number;
  fileCount: number;
}

/** Wie eine Nachricht gelöscht wird. */
export type DeleteScope = 'all' | 'me';

/* ── Notizen ──────────────────────────────────────────────────── */

/**
 * Eine persönliche Notiz — Ende-zu-Ende verschlüsselt wie ein vertraulicher
 * Kanal, aber kein Kanal: eine Notiz ist ein einzelnes, sich veränderndes
 * Schriftstück, kein Nachrichtenstrom. Titel und Text stecken zusammen in
 * `chiffrat` (dieselbe Hülle wie eine Nachricht in einem vertraulichen Kanal,
 * siehe `E2ENutzlast` in vertraulich.ts) — der Server sieht auch vom Titel
 * nichts im Klartext.
 */
export interface Notiz {
  id: string;
  ownerId: string;
  /** "e1:<fassung>:<iv>:<daten>" — enthält { titel, text } als JSON. */
  chiffrat: string;
  /**
   * Inhaltsstand. Zählt bei jedem Speichern hoch — die Grundlage dafür, dass
   * die App merkt, wenn zwischenzeitlich von anderswo gespeichert wurde
   * (siehe notiz:speichern im Protokoll), statt es stillschweigend zu
   * überschreiben.
   */
  version: number;
  /**
   * Welche Fassung des Notizschlüssels aktuell gilt. Wechselt, wenn die
   * besitzende Person jemanden entfernt — dieselbe Idee wie
   * `Channel.schluesselFassung`, nur ohne Vergangenheit: anders als bei einem
   * Kanal gibt es keine alten Nachrichten, die unter einer älteren Fassung
   * lesbar bleiben müssten. Nach einem Wechsel ist die alte Fassung deshalb
   * einfach weg.
   */
  schluesselFassung: number;
  /** Wer zusätzlich zur besitzenden Person lesen und bearbeiten darf. */
  memberIds: string[];
  /**
   * Wer schon einmal Zugriff hatte und wieder entfernt wurde, mit Zeitpunkt.
   *
   * Nicht aus Sammelwut — aus Ehrlichkeit: die Oberfläche sagt beim Entfernen,
   * dass Gelesenes damit nicht ungelesen wird. Diese Liste ist der Beleg
   * dafür, dass genau das offen bleibt, statt es zu verschweigen.
   */
  ehemaligeMitglieder: { userId: string; entferntAm: number }[];
  geaendertVon: string;
  geaendertAm: number;
  erstelltAm: number;
}

/* ── Passwort-Tresor ──────────────────────────────────────────── */

/**
 * Ein Tresoreintrag — Ende-zu-Ende verschlüsselt nach genau demselben Muster
 * wie eine {@link Notiz}: dieselben Tabellen (Eintrag, Mitglieder,
 * Geräteweg-Pakete, Kontoweg-Pakete), dieselbe `E2ENutzlast`-Hülle, derselbe
 * Server, der `chiffrat` nie im Klartext sieht. Was den Tresor von einer
 * Notiz unterscheidet: der Inhalt ist auf ZWEI Hüllen verteilt (Schaufenster
 * hier, Geheimnis in passwort_geheimnisse), und jede Aushändigung des
 * Geheimnisses wird protokolliert — siehe `PasswortOffenlegung` unten.
 */
export interface Passworteintrag {
  id: string;
  ownerId: string;
  /**
   * DAS SCHAUFENSTER, NICHT DER GANZE EINTRAG.
   *
   * "e1:<fassung>:<iv>:<daten>" — enthält als JSON nur, was die LISTE
   * braucht: { label, benutzername, notiz, url, totpKontoId }. Ein
   * `passwort`-Feld steht hier nicht mehr drin. Wer die Tafel öffnet,
   * entschlüsselt damit kein einziges Passwort — das war vorher anders und
   * ist der Grund für die Trennung (siehe schema.sql,
   * passwort_geheimnisse).
   *
   * Das Passwort liegt in einer zweiten Hülle und kommt ausschließlich über
   * POST /api/passwoerter/:id/geheimnis heraus — ein Weg, der beim
   * Ausliefern selbst eine {@link PasswortOffenlegung} schreibt.
   *
   * LEER bei einem Eintrag aus dem Altbestand (`altbestand: true`): dessen
   * eine alte Hülle enthält das Passwort noch mit, und der Server reicht sie
   * deshalb nicht über die Liste heraus, sondern nur über denselben
   * vermerkten Weg wie ein Geheimnis.
   */
  chiffrat: string;
  /**
   * Noch in der alten Form von vor der Trennung: eine Hülle mit allem drin,
   * keine Zeile in passwort_geheimnisse. `chiffrat` ist dann leer.
   *
   * Umgestellt wird ein solcher Eintrag vom ersten Gerät, das ihn ohnehin
   * schon öffnen kann — derselbe Gedanke wie beim Kontoweg-Nachtragen. Der
   * Server kann es nicht selbst: er hat keinen der Schlüssel.
   */
  altbestand: boolean;
  version: number;
  /** Siehe Notiz.schluesselFassung — dieselbe Bedeutung, derselbe Anlass. */
  schluesselFassung: number;
  /** Wer außer der besitzenden Person diesen Eintrag lesen und bearbeiten
   *  darf — nie "alle", immer einzeln ausgewählt. */
  memberIds: string[];
  ehemaligeMitglieder: { userId: string; entferntAm: number }[];
  geaendertVon: string;
  geaendertAm: number;
  erstelltAm: number;
}

/**
 * Dass jemand auf „aufdecken" oder „kopieren" gedrückt hat — nie, bei welchem
 * Wert.
 *
 * WAS SIE BELEGT: dass der Server dieser Person zu diesem Zeitpunkt das
 * Geheimnis dieses Eintrags AUSGEHÄNDIGT hat. Sie entsteht in derselben
 * Transaktion wie die Auslieferung (server/services/passwoerter.ts,
 * geheimnisAusliefern()) — es gibt keinen Weg an ihr vorbei: wer die Anfrage
 * unterdrückt, bekommt kein Passwort, und ohne Anfrage hat niemand eines.
 * Die Tafel entschlüsselt beim Öffnen nur noch das Schaufenster; ein
 * Passwort steht dort erst, wenn eine dieser Zeilen dazu existiert.
 *
 * WAS SIE WEITERHIN NICHT BELEGT — und das ist keine Kleinigkeit: was NACH
 * der Aushändigung geschah. Wer einmal geholt hat, hat den Wert; ob er ihn
 * abschrieb, weitergab oder nur ansah, steht hier nicht und kann hier nicht
 * stehen. Die Zeile bezeugt das Holen, nicht das Wissen. Wer ein Passwort
 * überhaupt HABEN kann, sagt ohnehin nicht diese Zeile, sondern die
 * Mitgliederliste des Eintrags — sie bleibt die eigentliche Eingrenzung.
 *
 * Ein Wert stünde dem im Weg, nicht im Dienst: er wäre selbst das Geheimnis,
 * das dieser Datensatz nur bezeugen soll.
 */
export interface PasswortOffenlegung {
  id: string;
  eintragId: string;
  userId: string;
  am: number;
}

/* ── Briefpartner: Gruppen im Unternehmenspostfach ───────────────
 *
 * ZWEI SCHICHTEN, EIN GRUND
 *
 * Ursprünglich war diese Liste vollständig fest — die KI kann nur in eine
 * Gruppe einordnen, die sie kennt, und bei frei erfundenen Namen bliebe ihr
 * nur Raten oder ständiges Neuerfinden ähnlicher Namen ("Kunde" neben
 * "Kunden" neben "Kundschaft"). Diese Eigenschaft gilt weiterhin — nur nicht
 * mehr für ALLE Gruppen:
 *
 *   · EINGEBAUTE Gruppen (diese Liste hier, `PARTNER_GRUPPEN`) sind fest im
 *     Quelltext, haben eine Übersetzung in allen 22 Sprachen
 *     (`partnerGruppen.gruppe.<id>` im Wörterbuch) und sind der KI namentlich
 *     bekannt. `sonstige` ist ihr Auffangkorb und immer vorhanden — er
 *     verhindert, dass die KI etwas erfindet, weil keine der übrigen passt.
 *     `intern` ist ebenfalls eingebaut, aber ein Sonderfall: siehe dort.
 *     Eingebaute Gruppen lassen sich nicht umbenennen (ihr Name kommt aus
 *     dem Wörterbuch, nicht aus einer Datenbankzeile) und nicht löschen (die
 *     KI und `gruppeFuer()` & Co. verweisen fest auf ihre Kennung).
 *
 *   · BENUTZERDEFINIERTE Gruppen sind DATEN, keine Konstante — eine Zeile in
 *     `post_partnergruppen` (packages/server/src/services/
 *     post-partnergruppen.ts, `gruppeErstellen()`/`gruppeUmbenennen()`/
 *     `gruppeLoeschen()`), angelegt von einem Menschen mit `mail.verwalten`.
 *     Ihr Name ist genau der Wortlaut, den diese Person eingegeben hat — in
 *     KEINER Sprache übersetzt, weil er in keiner geschrieben wurde. Genau
 *     deshalb NIE als Wörterbuchschlüssel behandeln und NIE durch `t()`
 *     schicken: das wäre eine Übersetzung erfinden, wo keine existiert. Die
 *     KI erfährt bei jedem Lauf die AKTUELLE Liste (siehe dort) und darf
 *     auch in eine benutzerdefinierte Gruppe einordnen — nur `intern` bleibt
 *     ihr für immer verschlossen.
 *
 * Beide Schichten zusammen ergeben EINE Liste für die Oberfläche —
 * `PartnerGruppeInfo` weiter unten ist die gemeinsame Form, in der der
 * Server sie ausliefert (`GET /api/post/partnergruppen`).
 *
 * INTERN — GEPRÜFT, NICHT GERATEN UND NICHT GEGLAUBT
 *
 * Anders als die übrigen sechs wird `intern` nie von der KI vorgeschlagen:
 * ob eine Adresse auf der eigenen Versanddomäne liegt (services/
 * mailzugang.ts, `mail.domaene`), entscheidet post-partnergruppen.ts mit
 * einem Domänenvergleich, bevor die KI überhaupt gefragt wird.
 *
 * Der Vergleich allein genügt aber nicht: er liest den `From:`-Kopf, und den
 * schreibt der Absender selbst — jeder Fremde kann eine Adresse auf der
 * Firmendomäne behaupten. Erst der Absenderbeleg derselben Mail
 * (`dmarc=pass`, siehe packages/server/src/util/absenderbeleg.ts) macht aus
 * der Behauptung einen Sachverhalt. Nur DANN gilt „intern" ohne Nachfrage
 * und ohne die EINE Gelegenheit der KI zu verbrauchen; ohne Beleg wird die
 * Adresse einem Menschen vorgelegt (siehe `gruppeBeleg` bei `MailPartner`
 * weiter unten und `internZuweisen()` dort). Abgewiesen wird deswegen keine
 * Mail — die Prüfung ist ein Signal, keine Sperre.
 */
export const PARTNER_GRUPPEN = [
  'intern', 'kunden', 'firmen', 'lieferanten', 'bewerber', 'behoerden', 'sonstige',
] as const;
export type PartnerGruppe = (typeof PARTNER_GRUPPEN)[number];

/**
 * Eine Gruppe, wie die Oberfläche sie zur Auswahl anbietet — eingebaut oder
 * von einem Menschen angelegt (siehe Dateikopf für den Unterschied).
 */
export interface PartnerGruppeInfo {
  id: string;
  eingebaut: boolean;
  /** Nur bei benutzerdefinierten Gruppen gesetzt (`eingebaut === false`) —
      der Wortlaut, wie die Person ihn eingegeben hat, unübersetzt. Bei
      eingebauten `null`: der Name kommt über `partnerGruppen.gruppe.<id>`
      aus dem Wörterbuch. */
  name: string | null;
  /** Bei eingebauten Gruppen `0` — sie haben kein echtes Anlegedatum. */
  erstelltAm: number;
  /** Nur bei benutzerdefinierten Gruppen gesetzt. */
  erstelltVon: string | null;
  /** Wie viele Briefpartner gerade in dieser Gruppe stehen. */
  anzahl: number;
}

/**
 * Ein Briefpartner, so wie die Oberfläche ihn sieht — eine Zeile aus
 * `mail_partner` (packages/server/src/services/post-partnergruppen.ts).
 *
 * `gruppe` ist bewusst `string`, nicht `PartnerGruppe`: es kann ebenso gut
 * die Kennung einer benutzerdefinierten Gruppe sein (siehe Dateikopf). Ob ein
 * Wert eine eingebaute oder eine benutzerdefinierte Gruppe meint, entscheidet
 * seine Mitgliedschaft in `PARTNER_GRUPPEN` — oder ein Blick in die Liste aus
 * `GET /api/post/partnergruppen` (`PartnerGruppeInfo`).
 *
 * `gruppeVonKi` unterscheidet Vorschlag von Tatsache: `true` heißt, die
 * Gruppe steht so da, wie die KI sie einmalig vorgeschlagen hat, und noch
 * kein Mensch hat zugestimmt oder umentschieden. `gruppeVorschlagAm` ist
 * unabhängig davon der Zeitpunkt der EINEN Gelegenheit, die die KI je
 * Adresse hat — er bleibt stehen, auch wenn `gruppe` später von Hand
 * geändert wird, und verhindert genau dadurch jeden weiteren Vorschlag.
 *
 * `intern` ist dabei der eine Sonderfall, und `gruppeBeleg` sagt, welcher
 * Art: eine BELEGTE Zuordnung (`gruppeBeleg: 'dmarc'`) zählt wie eine
 * menschliche Entscheidung (`gruppeVonKi: false`) — die Absenderdomäne
 * wurde nicht bloß gelesen, sondern geprüft. Fehlt der Beleg oder fiel er
 * durch (`'ungeprueft'`, `'altbestand'`), steht die Zeile als VORSCHLAG da
 * (`gruppeVonKi: true`) und wartet auf einen Menschen: der `From:`-Kopf, an
 * dem die Domäne hängt, ist eine Behauptung des Absenders, und jeder Fremde
 * kann eine Adresse auf der eigenen Firmendomäne behaupten.
 */
export interface MailPartner {
  adresse: string;
  gruppe: string | null;
  gruppeVonKi: boolean;
  gruppeVorschlagAm: number | null;
  /** Ein Satz der KI, warum sie so entschieden hat — nur bei `gruppeVonKi`. */
  begruendung: string | null;
  /**
   * Worauf eine AUTOMATISCHE `intern`-Einordnung beruht (siehe Dateikopf
   * dieses Abschnitts). `null`: diese Zeile kam nicht über den Domänenweg —
   * KI-Vorschlag, menschliche Entscheidung oder noch gar keine Gruppe.
   *
   * Die Oberfläche wertet das Feld heute noch nicht aus; der Server liefert
   * es trotzdem, damit „warum steht hier intern?" überhaupt beantwortbar
   * ist. Wer es anzeigt, braucht dafür drei Wörterbuchschlüssel in allen 22
   * Sprachen — der Wert selbst ist eine Kennung, nie ein anzeigbarer Text.
   */
  gruppeBeleg: 'dmarc' | 'ungeprueft' | 'altbestand' | null;
  sprache: string;
  /** Seit wann diese Adresse bekannt ist (erster Kontakt oder erste Zuordnung). */
  seit: number;
}

/* ── Das Gedächtnis der Firmenpost ──────────────────────────────
 *
 * Zwei Formen, und der Unterschied zwischen ihnen ist die ganze Sperre:
 * ein `WissenEintrag` GILT und geht in die Anweisung ans Modell; ein
 * `WissenVorschlag` ist eine Bitte der KI, etwas merken zu dürfen, und wirkt
 * auf keine einzige Antwort, bis ein Mensch zugestimmt hat.
 *
 * Beide stehen hier statt je einmal auf Server und Oberfläche: sie gehen als
 * JSON über dieselbe Leitung, und zwei Beschreibungen desselben Objekts
 * laufen mit der Zeit auseinander. Der Server (services/post-wissen.ts) baut
 * sie, die Oberfläche (components/PostGedaechtnis.tsx) zeigt sie.
 */

/** `wissen` = Tatsache über die Firma, `stil` = Schreibgewohnheit. */
export type WissenArt = 'wissen' | 'stil';

export interface WissenEintrag {
  id: string;
  art: WissenArt;
  /** Überschrift und zugleich der Griff, über den zur Mail passendes Wissen gefunden wird. */
  thema: string;
  inhalt: string;
  /** Kommaliste. Fängt, was im Thema nicht wörtlich vorkommt. */
  stichworte: string;
  /** Grundwissen: geht mit, auch wenn die Mail das Thema nicht erwähnt. */
  immer: boolean;
  /** Nur für dieses Fach gültig (lokaler Teil), oder null für alle. */
  fach: string | null;
  /** Woher das stammt — ohne Herkunft lässt sich nicht beurteilen, ob es stimmt. */
  quelle: string | null;
  angelegtVon: string | null;
  angelegtAm: number;
  geaendertAm: number | null;
  /** Welchen Eintrag dieser hier abgelöst hat. */
  ersetztId: string | null;
  /** Gesetzt heißt: gilt nicht mehr. Bleibt trotzdem lesbar. */
  ersetztAm: number | null;
  ersetztDurch: string | null;
}

/** Woher ein Vorschlag stammt — im Wortlaut nachprüfbar, nicht als Behauptung. */
export interface WissenHerkunft {
  /** 'bearbeitet': ein Mensch hat einen KI-Entwurf vor dem Senden geändert. */
  art: 'bearbeitet' | 'gesendet';
  mailId: string;
  entwurfId: string | null;
  betreff: string;
  an: string;
  /** Was die KI geschrieben hatte — nur bei 'bearbeitet'. */
  textKi: string | null;
  /** Was tatsächlich hinausging. */
  textGesendet: string;
}

export interface WissenVorschlag {
  id: string;
  art: WissenArt;
  thema: string;
  inhalt: string;
  /** Ein Satz der KI: warum das dauerhaft gilt. */
  begruendung: string | null;
  herkunft: WissenHerkunft | null;
  /**
   * Ein GELTENDER Eintrag zum selben Thema, samt Wortlaut.
   *
   * Gesetzt heißt: hier widerspricht sich etwas. Beide Fassungen gehören
   * nebeneinander vor den Menschen, der entscheidet — das Alte wird nie
   * stillschweigend überschrieben.
   */
  widerspruchZu: { id: string; thema: string; inhalt: string } | null;
  zustand: 'offen' | 'angenommen' | 'abgelehnt';
  erstelltAm: number;
  entschiedenAm: number | null;
  entschiedenVon: string | null;
  eintragId: string | null;
}
