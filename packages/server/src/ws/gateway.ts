import type { WebSocket } from 'ws';
import { kennungVon } from '../util/abweisung.js';
import {
  decode, encode, isSupportedLang, normalizeLang, regionFuerZeitzone, WS_PROTOCOL_VERSION,
  type ClientEvent, type Message, type ServerEvent, type Task, type TranslationView, type UserStatus,
  type Vorschlag, type PostMeldung, type StoredFile,
} from '@stellium/shared';
import { verifyToken } from '../auth.js';
import { db } from '../db/index.js';
import { config, pushConfigured } from '../config.js';
import { newId } from '../util/id.js';
import {
  aiCapabilities, assistant, cachedReleaseNotes, messwerteFuerEmpfaenger, messwerteRecordFuer, roundTrip,
  translate, translateMessage, translatePoll, translateChannel, translateReleaseNotes,
} from '../translation/index.js';
import * as ai from '../services/ai.js';
import * as praesenz from '../services/praesenz.js';
import * as channels from '../services/channels.js';
import * as messages from '../services/messages.js';
import * as store from '../services/store.js';
import { grenze } from '../services/search.js';
import * as polls from '../services/polls.js';
import { may } from '../services/users.js';
import { extractMentions, mentionsEveryone, PERMISSIONS, type PermissionKey } from '@stellium/shared';
import * as reminders from '../services/reminders.js';
import * as drafts from '../services/drafts.js';
import { attachPreviews, extractUrls } from '../services/links.js';
import { saveTranscript, transcribe, voiceNoteFor } from '../services/voice.js';
import * as ki from '../services/assistant.js';
import * as tasks from '../services/tasks.js';
import * as projekte from '../services/projekte.js';
import * as settings from '../services/settings.js';
import * as releases from '../services/releases.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import * as vertraulich from '../services/vertraulich.js';
import * as notizen from '../services/notizen.js';
import { istE2EChiffrat } from '@stellium/shared';
import * as events from '../services/events.js';
import * as files from '../services/files.js';
import * as ideas from '../services/ideas.js';
import * as vorschlaege from '../services/vorschlaege.js';
import * as patreon from '../services/patreon.js';
import * as paypal from '../services/paypal.js';
import * as post from '../services/post.js';
import * as partnerGruppen from '../services/post-partnergruppen.js';
import * as postLernen from '../services/post-lernen.js';
import * as postSichtung from '../services/post-sichtung.js';
import * as verkaufBenachrichtigung from '../services/verkaufBenachrichtigung.js';
import * as push from '../services/push.js';
import * as wartung from '../services/wartung.js';
import * as emojiVorschlaege from '../services/emoji-vorschlaege.js';
import { db as database } from '../db/index.js';
import { reindexMessage } from '../db/index.js';

interface Session {
  id: string;
  socket: WebSocket;
  userId: string | null;
  language: string;
  autoTranslate: boolean;
  /** Der Kanal, den diese Sitzung gerade offen hat — gelesen von
      deliverMessage() (öffentliche Kanäle an aktuelle Betrachter:innen) und
      von prefs:update() (Sprachwechsel liefert den offenen Kanal neu aus).
      Wird beim Verlassen/Ausblenden/Entfernen aus einem Kanal geleert
      (offenenKanalVergessen(), siehe unten) — das ist Aufräumen, nicht die
      eigentliche Garantie: die sitzt an den beiden Lesestellen selbst, die
      die Mitgliedschaft jedes Mal frisch nachprüfen. */
  openChannelId: string | null;
  alive: boolean;
}

const sessions = new Map<string, Session>();
const byUser = new Map<string, Set<Session>>();
/** Verhindert doppelte Übersetzungsaufträge für dieselbe Nachricht+Sprache. */
const inflight = new Map<string, Promise<unknown>>();

function send(session: Session, ev: ServerEvent): void {
  if (session.socket.readyState !== 1) return;
  try { session.socket.send(encode(ev)); } catch { /* Socket ist weg */ }
}

function sendToUser(userId: string, ev: ServerEvent): void {
  for (const s of byUser.get(userId) ?? []) send(s, ev);
}

/**
 * Die Ankündigung einer Serverauszeit an eine einzelne Sitzung — in deren
 * Lesesprache, wenn schon vorhanden.
 *
 * Diese Notizen sind dieselben wie die der Server-Fassung selbst (die
 * Ankündigung entsteht erst, NACHDEM die Fassung veröffentlicht ist — siehe
 * server-setup/stellium-selbstupdate.sh), deshalb reicht derselbe
 * Zwischenspeicher wie für /api/releases/check (siehe translation/index.ts).
 * Fehlt eine Übersetzung noch, geht sofort das Original hinaus — eine
 * Ankündigung, die auf eine Übersetzung wartet, käme zu spät, siehe
 * Auftrag — und im Hintergrund wird eine übersetzte Fassung nachgereicht,
 * sobald sie da ist, genau wie bei Kanälen (kanalUebersetzungNachreichen)
 * und Umfragen (pollUebersetzungNachreichen) weiter unten.
 *
 * Die Sprache kommt über uiLanguageOf(), nicht über session.language: Jenes
 * ist die Übersetzungssprache für Nachrichteninhalte, hier geht es um
 * Oberflächentext — genau die Unterscheidung, die store.ts bei
 * uiLanguageOf() trifft, und derselbe Weg wie in services/push.ts.
 */
function wartungMelden(session: Session, w: wartung.Wartung): void {
  if (!session.userId) { send(session, { t: 'server:update', ...w, serverZeit: Date.now() }); return; }
  const sprache = store.uiLanguageOf(session.userId);
  const uebersetzt = w.notes ? cachedReleaseNotes('server', sprache) : null;
  send(session, { t: 'server:update', ...w, notes: uebersetzt ?? w.notes, serverZeit: Date.now() });
  if (!w.notes || uebersetzt !== null) return;
  void translateReleaseNotes('server', sprache)
    .then((notes) => { if (notes) send(session, { t: 'server:update', ...w, notes, serverZeit: Date.now() }); })
    .catch((err) => console.error('[wartung]', (err as Error).message));
}

/** Für Ereignisse, die außerhalb des Gateways entstehen (z. B. HTTP-Uploads). */
export function broadcastAll(ev: ServerEvent): void {
  broadcast(ev);
}

/**
 * Darf diese Person die Nachricht überhaupt sehen?
 *
 * Mehrere Ereignisse nehmen eine Nachrichtenkennung entgegen und antworten mit
 * deren Inhalt — übersetzen, Thread öffnen, merken. Ohne diese Prüfung genügte
 * eine bekannte Kennung, um an Nachrichten aus fremden Kanälen und
 * Direktchats zu kommen. Kennungen sind zufällig, aber sie wandern: durch
 * Weiterleitungen, Zitate, Protokolle.
 *
 * Die Arbeitsteilung mit darfNachrichtAendern() ist bewusst so: lesen und
 * alles, was an der eigenen Person hängt — merken, anheften, abstimmen —
 * verlangt Mitgliedschaft; einwirken auf den Nachrichtenkörper geht auch für
 * stille Mitleser:innen offener Kanäle.
 */
function darfNachrichtSehen(userId: string, messageId: string): boolean {
  const msg = database.get<{ channel_id: string }>(
    'SELECT channel_id FROM messages WHERE id = ?', messageId,
  );
  if (!msg) return false;
  return store.memberIds(msg.channel_id).includes(userId);
}

/**
 * Darf diese Person auf die Nachricht einwirken — reagieren, löschen?
 *
 * Wie darfNachrichtSehen(), nur zählen offene Kanäle mit: dort liest jede
 * Person mit, ohne beigetreten zu sein, und Mitglied wird man erst mit dem
 * ersten eigenen Beitrag. Eine strenge Mitgliedsprüfung sperrte hier also
 * stille Mitleser:innen aus. In privaten Kanälen und Direktchats bleibt es
 * bei der Mitgliedschaft — sonst genügte eine bekannte Kennung, um dort
 * Nachrichten verschwinden zu lassen oder Reaktionen zu hinterlassen.
 *
 * Bekannte Einschränkung: der Rundruf danach geht an store.memberIds(), also
 * gerade nicht an die stillen Mitleser:innen. Sie dürfen reagieren, sehen ihre
 * eigene Reaktion aber erst, wenn sie den Kanal neu öffnen.
 */
function darfNachrichtAendern(userId: string, messageId: string): boolean {
  return darfNachrichtLesen(userId, messageId);
}

/**
 * Darf diese Person in diesen Kanal hineinsehen?
 *
 * Nicht zu verwechseln mit store.getChannel(): das beantwortet eine andere
 * Frage, nämlich ob es den Kanal überhaupt gibt. Genau diese Verwechslung war
 * hier der teuerste Fund des Durchgangs — fünf Stellen prüften mit
 * `if (!store.getChannel(id, userId))`, und der Kommentar daneben behauptete
 * „also nur, wo man mitliest". In Wahrheit genügte die Kennung eines fremden
 * privaten Kanals, um sich seinen Inhalt zusammenfassen, protokollieren oder
 * beantworten zu lassen.
 *
 * Die Regel ist dieselbe wie bei darfNachrichtLesen(): offene Kanäle stehen
 * jedem offen, auch ohne Beitritt; alles andere verlangt Mitgliedschaft.
 */
function darfKanalSehen(userId: string, channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  const ch = database.get<{ kind: string }>('SELECT kind FROM channels WHERE id = ?', channelId);
  if (!ch) return false;
  return ch.kind === 'public' || store.isMember(channelId, userId);
}

/** Dasselbe mit Abweisung — spart die Zeile an jeder einzelnen Stelle. */
function kanalZugang(session: Session, channelId: string | null | undefined, requestId?: string): boolean {
  if (darfKanalSehen(session.userId!, channelId)) return true;
  fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal', requestId);
  return false;
}

/**
 * Wer ein Element sehen darf, das an einem Kanal hängen kann.
 *
 * `undefined` heißt „alle" — genau das, was broadcast() ohne Empfängerkreis
 * tut. Aufgaben, Termine und Ideen ohne Kanal gehen das ganze Team an und
 * bleiben für alle sichtbar; was an einem Kanal hängt, geht nur an dessen
 * Kreis. Offene Kanäle darf jeder sehen, also auch hier: alle.
 *
 * Gibt es den Kanal nicht mehr, ist die Bindung fort und das Element wieder
 * für alle da. Über die Fremdschlüssel (ON DELETE SET NULL) kann das gar
 * nicht eintreten — die Zeile trägt dann NULL —, aber die Antwort soll
 * dieselbe sein wie in dem Fall, den es wirklich gibt.
 */
function empfaengerFuer(channelId: string | null | undefined): string[] | undefined {
  if (!channelId) return undefined;
  const ch = database.get<{ kind: string }>('SELECT kind FROM channels WHERE id = ?', channelId);
  if (!ch || ch.kind === 'public') return undefined;
  return store.memberIds(channelId);
}

/**
 * Darf diese Person das Element sehen?
 *
 * Bewusst aus empfaengerFuer() abgeleitet und nicht daneben noch einmal
 * formuliert: sonst gäbe es zwei Regeln, die dasselbe entscheiden sollen, und
 * eines Tages entscheiden sie es verschieden. Die Liste ist der Rundruf, die
 * Prüfung ist die Einzelabfrage — dieselbe Antwort, zwei Verwendungen.
 */
function darfElementSehen(userId: string, channelId: string | null | undefined): boolean {
  const kreis = empfaengerFuer(channelId);
  return kreis === undefined || kreis.includes(userId);
}

/**
 * Wen geht eine Datei etwas an?
 *
 * `undefined` heißt „alle" — genau das, was broadcast() ohne Empfängerkreis
 * tut. Sonst die Mitglieder des Kanals, an dem sie hängt.
 *
 * WARUM ZWEI QUELLEN FÜR EINE ANTWORT
 * Die Grenze selbst kommt aus der Ablage: `files.fuerAlleSichtbar()` steht in
 * services/files.ts direkt neben `listFiles()`, damit Lesen und Rundruf
 * dieselbe Regel benutzen und nicht zwei — dort ist beschrieben, warum ein
 * Verzeichnis, das beim Lesen dicht ist und beim Schreiben nicht, keine Zusage
 * ist. Die NAMENSLISTE kommt von `empfaengerFuer()` oben, weil nur das Gateway
 * weiß, wie ein Rundruf mit Kreis aussieht.
 *
 * Beide ziehen laut ihrer eigenen Beschreibung dieselbe Linie (kein Kanal oder
 * ein offener Kanal heißt „alle"). Das `?? []` verlässt sich trotzdem nicht
 * darauf: sagt die Ablage „nicht für alle" und die Empfängerliste gleichwohl
 * „alle", weichen die beiden eines Tages voneinander ab — dann geht die
 * Meldung an niemanden statt an jeden. Die Datei ist über `GET /api/files`
 * weiterhin für die zu sehen, die sie sehen dürfen; ein Name, der bei
 * Unbeteiligten aufblitzt, lässt sich dagegen nicht zurücknehmen. Von zwei
 * möglichen Irrtümern der billigere.
 *
 * Für eine private Datei (huelle.art === 'konto') ist das hier nicht die
 * richtige Frage — sie geht ausschließlich ihren Besitzer an. Die Aufrufer
 * behandeln den Fall vorher; `fuerAlleSichtbar()` würde ihn zwar auch
 * abfangen, aber zu „nur der Kanalkreis" statt zu „nur der Besitzer".
 */
function dateiKreis(datei: StoredFile): string[] | undefined {
  if (files.fuerAlleSichtbar(datei)) return undefined;
  return empfaengerFuer(datei.channelId) ?? [];
}

/**
 * Wer ein Element nach einem Umzug nicht mehr sehen darf.
 *
 * Zieht eine Aufgabe in einen privaten Kanal (oder eine Idee), verschwindet
 * sie für alle anderen — aber nur, wenn man es ihnen sagt. Der Client hält
 * seine Bretter als Zuordnung und räumt einen Eintrag erst auf ein
 * `*:removed` hin weg; ohne diese Meldung bliebe die Aufgabe dort stehen,
 * bis jemand die Liste neu lädt. Sichtbar wäre sie dann für Leute, die sie
 * gerade verloren haben.
 */
function verlorenGegangen(vorher: string[] | undefined, nachher: string[] | undefined): string[] {
  if (nachher === undefined) return [];                    // jetzt sehen es alle
  const jetzt = new Set(nachher);
  // `undefined` vorher heißt: es sahen alle. Stale Zustand kann nur haben,
  // wer gerade verbunden ist.
  const vorherige = vorher ?? [...byUser.keys()];
  return vorherige.filter((uid) => !jetzt.has(uid));
}

/**
 * Was aus einem Kanal stammt, von den Brettern derer nehmen, die ihn gerade
 * verloren haben.
 *
 * Aufgaben, Termine und Ideen bleiben bestehen, wenn jemand einen Kanal
 * verlässt — sie gehören dem Kanal, nicht ihm. Auf seinem Schirm stehen sie
 * trotzdem weiter, denn der Client räumt einen Eintrag erst auf ein
 * `*:removed` hin weg. Wer eine App über Nacht offen lässt, säße also am
 * nächsten Morgen noch vor den Aufgabentiteln eines Kanals, aus dem er
 * gestern entfernt wurde.
 */
function kanalElementeZuruecknehmen(channelId: string, userIds: string[]): void {
  if (!userIds.length) return;
  // Bei einem offenen Kanal — oder wenn es ihn nicht mehr gibt — ist nichts
  // zurückzunehmen: dann darf es ohnehin jeder sehen.
  if (empfaengerFuer(channelId) === undefined) return;
  const aufgaben = tasks.idsImKanal(channelId);
  const termine = events.idsImKanal(channelId);
  const ideen = ideas.idsImKanal(channelId);
  const vorschlaegeImKanal = vorschlaege.idsImKanal(channelId);
  for (const uid of userIds) {
    if (store.isMember(channelId, uid)) continue;      // doch noch dabei
    for (const id of aufgaben) sendToUser(uid, { t: 'task:removed', taskId: id });
    for (const id of termine) sendToUser(uid, { t: 'event:removed', eventId: id });
    for (const id of ideen) sendToUser(uid, { t: 'idea:removed', ideaId: id });
    /* Vorschläge gehören genau einer Person, aber dieselbe Überlegung gilt:
       wer den Kanal verliert, darf dessen Vorschläge nicht weiter im Eingang
       stehen haben — in ihren Titeln steht, worüber dort geredet wurde. */
    for (const id of vorschlaegeImKanal) sendToUser(uid, { t: 'vorschlag:removed', vorschlagId: id });
  }
}

/**
 * `openChannelId` in allen Sitzungen dieser Person leeren, wenn sie gerade
 * genau diesen Kanal "offen" hatten.
 *
 * Über alle Sitzungen der Person und nicht nur die aufrufende: wer den Kanal
 * auf dem Handy verlässt, soll ihn nicht auf dem angemeldeten Laptop
 * weiterhin als "offen" markiert haben — das Handy hat dort ja gar nichts
 * getan.
 *
 * WICHTIG: das hier ist Aufräumen, nicht die Garantie. Die eigentliche
 * Garantie gegen das Zustellen an Nicht-Mitglieder sitzt an den LESESTELLEN
 * selbst (deliverMessage() prüft inzwischen die Kanalart, prefs:update()
 * prüft die Mitgliedschaft frisch) — ein künftiger Weg aus einem Kanal, den
 * diese Funktion nicht kennt, darf das Loch nicht wieder aufmachen, nur weil
 * hier eine Fundstelle vergessen wurde. Aufgerufen wird sie trotzdem an jeder
 * bekannten Stelle: sauberer Zustand ist billiger als sich ausschließlich auf
 * die Lesestellen zu verlassen, und ein `deliverMessage()`, das für einen
 * privaten Kanal aus genau diesem Grund nie wieder über `openChannelId`
 * zustellt, braucht diese Sitzungen ohnehin nicht mehr als "offen" stehen.
 */
function offenenKanalVergessen(userId: string, channelId: string): void {
  for (const s of byUser.get(userId) ?? []) {
    if (s.openChannelId === channelId) s.openChannelId = null;
  }
}

/** Der Kanal einer Nachricht — und ob man ihn sehen darf. */
function darfNachrichtLesen(userId: string, messageId: string): boolean {
  const row = database.get<{ channel_id: string }>(
    'SELECT channel_id FROM messages WHERE id = ?', messageId,
  );
  return Boolean(row) && darfKanalSehen(userId, row!.channel_id);
}

function broadcast(ev: ServerEvent, userIds?: Iterable<string>): void {
  if (userIds) { for (const uid of userIds) sendToUser(uid, ev); return; }
  for (const s of sessions.values()) if (s.userId) send(s, ev);
}

/**
 * Eine Meldung an den Client.
 *
 * `code` ist eine Kennung aus dem Wörterbuch der Oberfläche, `werte` füllt
 * ihre Platzhalter. Der deutsche Text daneben ist nur der Rückfall für ältere
 * Clients — welche Sprache am anderen Ende läuft, muss der Server nicht
 * wissen. Wer hier eine neue Kennung einführt, legt sie in
 * packages/desktop/src/i18n/de.ts an; scripts/e2e-fehlertexte.mjs liest die
 * Kennungen aus dieser Datei und schlägt an, wenn eine ohne Eintrag bleibt.
 */
function fail(
  session: Session, code: string | undefined, message: string,
  requestId?: string, werte?: Record<string, string>, clientId?: string,
): void {
  send(session, { t: 'error', code, message, werte, requestId, clientId });
}

/**
 * Rechteprüfung. Die Oberfläche blendet Dinge zwar aus, aber verlassen darf
 * man sich nur auf das hier — ein eigener Client könnte alles schicken.
 *
 * `clientId` ist optional und geht nur bei `message:send` mit — dort weist
 * die abgelehnte Nachricht sich selbst zu, statt dass der Client raten muss
 * (siehe `error`-Ereignis in packages/shared/src/protocol.ts).
 */
function darf(session: Session, permission: PermissionKey, clientId?: string): boolean {
  if (!session.userId) return false;
  if (may(session.userId, permission)) return true;
  const info = PERMISSIONS.find((p) => p.key === permission);
  const name = info?.labelDe ?? permission;
  fail(session, 'fehler.keinRechtName', `Dafür fehlt dir das Recht "${name}".`,
    undefined, { recht: name }, clientId);
  return false;
}

function isOnline(userId: string): boolean {
  return (byUser.get(userId)?.size ?? 0) > 0;
}

/* ── Vertrauliche Kanäle ──────────────────────────────────────── */

/**
 * Alles abweisen, was Klartext braucht.
 *
 * Übersetzung, Zusammenfassungen, Antwortvorschläge, Aufgabenerkennung und der
 * Assistent haben eines gemeinsam: sie lesen den Nachrichtentext. In einem
 * vertraulichen Kanal hat der Server keinen — er hätte also nur Base64 an ein
 * fremdes Modell zu schicken und bekäme Unsinn zurück.
 *
 * Der Aufruf steht deshalb an jeder dieser Stellen einzeln, statt einmal
 * zentral: eine Prüfung, die man beim Hinzufügen einer neuen KI-Funktion
 * vergessen kann, ist keine Prüfung. Wer eine neue Funktion baut und sie hier
 * nicht einträgt, merkt es am fehlenden Eintrag in VERTRAULICH_ABGESCHALTET.
 */
function klartextNoetig(session: Session, channelId: string | null | undefined): boolean {
  if (!channelId || !vertraulich.istVertraulich(channelId)) return false;
  fail(session, 'fehler.vertraulich',
    'In einem vertraulichen Kanal geht das nicht — der Server sieht dort nur Chiffrat. '
    + 'Übersetzung, KI-Hilfen und die serverseitige Suche sind hier bewusst abgeschaltet.');
  return true;
}

/**
 * Der Hinweis, den ein vertraulicher Kanal zurückgibt, wenn offener Text
 * ankommt. Er steht hier einmal und nicht an jeder Fundstelle: die Oberfläche
 * übersetzt anhand der Kennung, und zwei Formulierungen für denselben Fall
 * wären zwei Einträge in zweiundzwanzig Sprachen.
 */
const VERTRAULICH_NOETIG =
  'Dieser Kanal ist vertraulich. Diese App kann noch nicht verschlüsseln — bitte aktualisieren.';

/**
 * Alles abweisen, was offenen Text in einen vertraulichen Kanal schreiben will.
 *
 * Das Gegenstück zu klartextNoetig(): dort geht es um Funktionen, die den Text
 * lesen wollen, hier um solche, die welchen hineinschreiben. Die Zusage "nur
 * die Beteiligten lesen mit" hält nur, solange wirklich jeder Inhalt
 * verschlossen ankommt — ein einziger offener Weg genügt, und im Kanal steht
 * lesbarer Text, ohne dass es jemandem auffällt. Die Oberfläche blendet solche
 * Wege zwar aus, aber darauf verlassen darf man sich nicht: eine ältere Fassung
 * der App bietet sie weiter an, und eine selbstgebaute fragt gar nicht erst.
 *
 * Mehrere Texte werden alle geprüft und nicht nur der erste. Eine verschlüsselte
 * Umfragefrage mit offenen Antwortmöglichkeiten verriete das Thema genauso —
 * "Bleibt Standort Nord?" braucht die Frage gar nicht, wenn darunter "Ja,
 * schließen" steht.
 *
 * Wie bei klartextNoetig() steht der Aufruf an jeder Stelle einzeln. Eine
 * zentrale Prüfung erwischte nur die Ereignisse, die heute jemand durch sie
 * hindurchführt — und das nächste neue eben nicht.
 */
function chiffratNoetig(
  session: Session,
  channelId: string | null | undefined,
  texte: (string | null | undefined) | (string | null | undefined)[],
  hinweis: string = VERTRAULICH_NOETIG,
  kennung = 'fehler.vertraulichNoetig',
  // Nur `message:send` gibt das mit — siehe Begründung an `darf()` oben.
  clientId?: string,
): boolean {
  if (!channelId || !vertraulich.istVertraulich(channelId)) return false;
  const alle = Array.isArray(texte) ? texte : [texte];
  // Eine leere Liste ist kein Nachweis, sondern das Fehlen eines Nachweises.
  if (alle.length > 0 && alle.every((t) => istE2EChiffrat(t))) return false;
  fail(session, kennung, hinweis, undefined, undefined, clientId);
  return true;
}

/** Dasselbe für Nachrichten, deren Kanal man erst nachschlagen muss. */
function klartextNoetigFuerNachricht(session: Session, messageId: string): boolean {
  const row = database.get<{ channel_id: string }>(
    'SELECT channel_id FROM messages WHERE id = ?', messageId,
  );
  return klartextNoetig(session, row?.channel_id);
}

/**
 * Systemnachricht in den Kanal, wenn sich am Zugang etwas ändert.
 *
 * Sie ist der Kern der Freigabe-Regelung: eine Freigabe, von der die
 * Betroffenen nichts erfahren, wäre genau die stille Hintertür, gegen die
 * diese Verschlüsselung gebaut ist. Deshalb erzeugt der Server sie selbst und
 * nicht die App der meldenden Person — sonst könnte man sie weglassen.
 *
 * Der Text steht bewusst im Klartext, obwohl der Kanal vertraulich ist: er
 * muss auch dann lesbar sein, wenn jemandem der Schlüssel fehlt, und er ist
 * kein Gesprächsinhalt, sondern eine Auskunft über den Kanal selbst.
 */
function zugangsMeldung(channelId: string, userId: string, text: string, art: string): void {
  try {
    const msg = messages.createMessage({
      channelId, userId, text, systemKind: art,
      mayMention: false, mayMentionEveryone: false,
    });
    deliverMessage(msg);
  } catch (err) {
    console.error('[vertraulich] Systemnachricht:', (err as Error).message);
  }
}

/**
 * Den Mitgliedern sagen, dass ein Schlüssel fehlt oder gewechselt werden muss.
 *
 * Der Server kann beides nicht selbst erledigen — er hat den Kanalschlüssel
 * nicht. Er kann nur fragen, und zwar alle, die ihn haben. Wer zuerst
 * antwortet, hat verpackt; die übrigen Antworten laufen ins Leere. Das ist
 * billiger als eine Absprache darüber, wer zuständig ist, und es funktioniert
 * auch dann noch, wenn die eine zuständige Person gerade im Urlaub ist.
 */
function schluesselarbeitAnstossen(channelId: string): void {
  if (!vertraulich.istVertraulich(channelId)) return;
  const fassung = vertraulich.aktuelleFassung(channelId);
  const fehlend = vertraulich.fehlendePakete(channelId, fassung);
  if (!fehlend.length) return;
  for (const uid of store.memberIds(channelId)) {
    if (fehlend.includes(uid)) continue;          // wer selbst wartet, kann nicht helfen
    if (!vertraulich.kannLesen(channelId, uid)) continue;
    sendToUser(uid, { t: 'vertraulich:pakete-fehlen', channelId, fassung, userIds: fehlend });
  }
}

/* ── Übersetzung für Empfänger ────────────────────────────────── */

/**
 * Maßangaben-Sentinel (⟦m0⟧, …) einer TranslationView für GENAU eine
 * Empfängerin auflösen — muss vor jedem Versand einer TranslationView an
 * eine bestimmte Person laufen (siehe messwerteFuerEmpfaenger(),
 * translation/index.ts, für die ausführliche Begründung: zwei Personen mit
 * derselben Zielsprache können in unterschiedlichen Zeitzonen sitzen und
 * brauchen deshalb unterschiedliche Einheiten aus demselben, geteilten
 * Übersetzungsspeicher).
 *
 * `Session` trägt nur die Sprache, keine Zeitzone — deshalb hier immer ein
 * zusätzlicher store.getUser()-Griff. `sprache` ist absichtlich view.lang
 * und nicht etwa self.language: view.lang ist dieselbe Zielsprache, in die
 * gerade übersetzt wurde, und bleibt auch dann richtig, wenn sich die
 * Spracheinstellung der Person zwischen Übersetzung und Versand geändert hat.
 */
function messwerteFuerNutzer(view: TranslationView, userId: string): TranslationView {
  return messwerteFuerEmpfaenger(view, regionFuerZeitzone(store.getUser(userId)?.timezone), view.lang);
}

/**
 * Füllt Übersetzungen aus dem Cache und meldet, was noch fehlt.
 *
 * Liest message_translations über eine EIGENE SQL-Abfrage statt über
 * translateMessage() — und setzt darum `m.translation` von Hand, inklusive
 * der Maßangaben-Sentinel, die dort sonst translateMessage() auflösen würde.
 * messwerteRecordFuer() bildet dieselbe Sentinel-Nummerierung nach (siehe
 * dort), und messwerteFuerNutzer() löst sie SOFORT für `userId` auf: diese
 * Funktion hier ist der einzige Ort, der message_translations direkt liest,
 * und `list` geht im Anschluss unverändert weiter (channel:history,
 * thread:history, oder einzeln als {t:'translation'} bei prefs:update) — ein
 * ungelöster Sentinel oder rohe Messwert-Daten dürften also gar nicht erst
 * entstehen, statt an jeder der mehreren Versandstellen erneut aufgelöst
 * werden zu müssen.
 */
function fillCachedTranslations(list: Message[], lang: string, userId: string): Message[] {
  const target = normalizeLang(lang);
  const region = regionFuerZeitzone(store.getUser(userId)?.timezone);
  const need: Message[] = [];
  for (const m of list) {
    if (!m.text || m.deletedAt) continue;
    // Ein Chiffrat zu übersetzen ergäbe ein übersetztes Chiffrat.
    if (istE2EChiffrat(m.text)) continue;
    if ((m.sourceLang ?? 'unknown') === target) continue;
    const row = db.get<{ text: string; provider: string; model: string | null; confidence: number | null }>(
      'SELECT text, provider, model, confidence FROM message_translations WHERE message_id = ? AND lang = ?',
      m.id, target,
    );
    if (row) {
      const view: TranslationView = {
        lang: target, text: entschluesseln(row.text), provider: row.provider, model: row.model,
        confidence: row.confidence, cached: true, measurements: messwerteRecordFuer(m.text, target),
      };
      m.translation = messwerteFuerEmpfaenger(view, region, target);
    } else {
      need.push(m);
    }
  }
  return need;
}

/** Übersetzt fehlende Nachrichten im Hintergrund und schiebt sie nach. */
function translateInBackground(list: Message[], lang: string, userId: string, context?: string | null): void {
  const target = normalizeLang(lang);
  let chain = Promise.resolve();
  for (const m of list) {
    const key = `${m.id}:${target}`;
    chain = chain.then(async () => {
      let job = inflight.get(key);
      if (!job) {
        job = translateMessage(m.id, target, { context }).finally(() => inflight.delete(key));
        inflight.set(key, job);
      }
      const view = await job as Awaited<ReturnType<typeof translateMessage>>;
      if (view) sendToUser(userId, { t: 'translation', messageId: m.id, translation: messwerteFuerNutzer(view, userId) });
    }).catch((err) => console.error('[ws] Übersetzung fehlgeschlagen:', (err as Error).message));
  }
}

/** Kurzer Gesprächskontext, damit das Modell Anrede und Fachbegriffe trifft. */
function channelContext(channelId: string): string | null {
  const ch = db.get<{ name: string; topic: string | null; purpose: string | null }>(
    'SELECT name, topic, purpose FROM channels WHERE id = ?', channelId,
  );
  if (!ch) return null;
  const parts = [ch.name && `Kanal #${ch.name}`, ch.topic, ch.purpose].filter(Boolean);
  return parts.length ? parts.join(' — ').slice(0, 300) : null;
}

/**
 * Anhänge, die zu einer schon verschickten Nachricht noch unterwegs sind.
 *
 * Rein im Speicher — absichtlich, denn eine Spalte dafür bräuchte eine
 * Nachrüstung der bestehenden Datenbank (siehe db/migrate.ts), und für einen
 * Hinweis, der binnen Sekunden bis Minuten sowieso verschwindet, lohnt sich
 * das nicht: geht der Server neu, ist der Platzhalter weg, aber die Datei
 * bleibt für sich stehen (`attachments.message_id IS NULL`) und wartet
 * geduldig auf `message:attach` — oder verwaist harmlos, bis jemand sie
 * wegwirft (siehe messages.discardOrphanAttachment).
 *
 * Aber: "verschwindet binnen Sekunden bis Minuten" gilt nur, wenn message:attach
 * oder message:attachGiveUp auch wirklich ankommen. Bricht die Verbindung ab,
 * während der Upload noch läuft — App beendet, Auto-Updater dazwischen,
 * Rechner schläft ein —, kommt keins von beiden je an. Ohne eigenes Verfallsdatum
 * überlebte der Eintrag dann bis zum nächsten Serverneustart, und jede Person,
 * die die Nachricht schon zugestellt bekommen hat, sähe "wird hochgeladen" auf
 * ewig weiterdrehen — nur die sendende Person selbst nicht: Kanalverläufe geben
 * `pendingAttachments` gar nicht erst mit (siehe `ausstehendListe` unten, benutzt
 * nur für den gezielten `message:updated`-Rundruf), ihre eigene Ansicht bliebe
 * also sauber. Genau das macht den Fehler für Betroffene undiagnostizierbar.
 *
 * `seit` trägt deshalb jeder Eintrag mit — siehe `PLATZHALTER_FRIST_MS` und
 * `ausstehendeAnhaengeAufraeumen()` unten für die Verfallsregel selbst.
 *
 * Nachricht-Kennung -> temporäre Kennung -> was der Platzhalter zeigen soll.
 */
const ausstehendeAnhaenge = new Map<string, Map<string, { name: string; mime: string; uploaderId: string; seit: number }>>();

/** Was von einer Nachricht noch aussteht — für den nächsten `message:updated`-Rundruf. */
function ausstehendListe(messageId: string): { tempId: string; name: string; mime: string }[] {
  const eintrag = ausstehendeAnhaenge.get(messageId);
  if (!eintrag?.size) return [];
  return [...eintrag].map(([tempId, w]) => ({ tempId, name: w.name, mime: w.mime }));
}

/**
 * Wie lange ein Platzhalter höchstens leben darf, bevor er als verwaist gilt.
 *
 * Muss länger sein als jeder echte Upload dauern kann — sonst risse diese
 * Aufräumroutine gerade die Uploads ab, die noch gutgehen, und das wäre
 * schlimmer als der Fehler, den sie beheben soll. Die längste ehrliche
 * Laufzeit hängt an packages/desktop/src/net/api.ts (uploadSchnell): Dateien
 * über 8 MB gehen in 4-MB-Teilen zu je bis zu vier gleichzeitig, jeder Teil
 * mit eigener 5-Minuten-XHR-Frist (UPLOAD_XHR_FRIST_MS dort). Bei der
 * Standard-Obergrenze von 50 MB (MAX_UPLOAD_MB) sind das höchstens 13 Teile —
 * vier gleichzeitige Ströme brauchen dafür rechnerisch höchstens vier
 * Runden. Bleibt jeder Teil knapp unter der 5-Minuten-Frist, ohne sie zu
 * reißen (reißt sie, scheitert der Upload sofort komplett, und
 * message:attachGiveUp kommt ohnehin), sind das bis zu 20 Minuten für eine
 * Übertragung, die immer noch gutgeht. 30 Minuten geben darauf spürbaren
 * Sicherheitsabstand, ohne einen wirklich abgebrochenen Platzhalter
 * unbegrenzt leben zu lassen.
 *
 * Bewusst NICHT an das Schließen einer Sitzung gekoppelt: der XHR-Upload
 * läuft unabhängig vom WebSocket, über eine eigene HTTP-Verbindung. Wer die
 * App kurz verliert und neu verbindet — flackerndes WLAN, ein Neustart durch
 * den Auto-Updater mitten in einer anderen Aktion —, hat einen weiterhin
 * laufenden Upload, der am Ende ganz normal `message:attach` schickt. Ein
 * harter Schnitt beim `close`-Ereignis der Sitzung würde genau diesen
 * gesunden Fall canceln, nicht nur den kaputten.
 */
const PLATZHALTER_FRIST_MS = 30 * 60_000;

/**
 * Verwaiste Platzhalter aufräumen — Einträge, deren Upload nie ankam und die
 * ihre Frist überschritten haben.
 *
 * Periodisch statt beim Lesen geprüft: anders als etwa bei einer Ablage, die
 * bei jedem Zugriff frisch geprüft werden könnte, gibt es hier keine
 * natürliche Lesestelle, an der ein Ablauf auffiele — die Empfänger:innen
 * bekommen ihren Platzhalter einmalig per `message:updated`-Rundruf
 * zugestellt, sie fragen ihn nie erneut ab (Kanalverläufe liefern
 * `pendingAttachments` absichtlich nicht mit, siehe oben). Ohne einen aktiven
 * Rundruf von hier aus bliebe der Kreisel bei ihnen stehen, ganz gleich, wie
 * sauber die Map auf dem Server aussieht — deshalb derselbe Zustellweg wie
 * bei message:attachGiveUp, nicht nur das Entfernen aus der Map.
 *
 * Exportiert, damit pruefungen/anhaenge-platzhalter-frist.mts sie auslösen
 * kann, ohne echte 30 Minuten abzuwarten oder den Server dafür zu starten.
 */
export function ausstehendeAnhaengeAufraeumen(): number {
  const jetzt = Date.now();
  let entfernt = 0;
  for (const [messageId, eintrag] of [...ausstehendeAnhaenge]) {
    let uploaderId: string | undefined;
    let veraendert = false;
    for (const [tempId, w] of [...eintrag]) {
      uploaderId ??= w.uploaderId;
      if (jetzt - w.seit < PLATZHALTER_FRIST_MS) continue;
      eintrag.delete(tempId);
      entfernt++;
      veraendert = true;
    }
    if (!eintrag.size) ausstehendeAnhaenge.delete(messageId);
    if (!veraendert || !uploaderId) continue;

    // Derselbe Rundruf wie bei message:attachGiveUp (siehe dort) — sonst
    // dreht sich der Kreisel bei allen anderen weiter, obwohl der Server
    // längst aufgeräumt hat.
    const nachricht = store.getMessage(messageId, uploaderId);
    if (!nachricht) continue; // Nachricht inzwischen weg — nichts mehr zuzustellen
    broadcast(
      { t: 'message:updated', message: { ...nachricht, pendingAttachments: ausstehendListe(messageId) } },
      store.memberIds(nachricht.channelId),
    );
  }
  return entfernt;
}

/**
 * Nur für Prüfläufe: setzt „seit" eines einzelnen Platzhalters künstlich in
 * die Vergangenheit, damit ein Testlauf nicht wirklich PLATZHALTER_FRIST_MS
 * abwarten muss, um seinen Ablauf zu erzwingen. Rührt an nichts als diesem
 * einen Eintrag — die Frist selbst bleibt unverändert.
 */
export function _platzhalterAlternLassenFuerPruefung(messageId: string, tempId: string, alterMs: number): void {
  const eintrag = ausstehendeAnhaenge.get(messageId)?.get(tempId);
  if (eintrag) eintrag.seit = Date.now() - alterMs;
}

/**
 * Nachricht ausliefern: erst sofort an alle (schnell), dann pro Zielsprache
 * genau einmal übersetzen und das Ergebnis nachschieben.
 */
function deliverMessage(message: Message, senderClientId?: string): void {
  const recipients = new Set(store.memberIds(message.channelId));
  const kanalDerNachricht = store.getChannel(message.channelId);
  /* Öffentliche Kanäle: auch Nicht-Mitglieder, die gerade zuschauen — aber
     NUR dort. Es fehlte hier lange die Artprüfung: `openChannelId` wird beim
     Verlassen/Ausblenden/Entfernen zwar geleert (offenenKanalVergessen, siehe
     oben), aber das ist Aufräumen, nicht die Garantie — ein künftiger Weg aus
     einem Kanal, der das vergisst, hätte sonst dasselbe Loch wieder
     aufgemacht: wer aus einem PRIVATEN Kanal entfernt wurde, aber ihn noch
     als "offen" in der Sitzung stehen hatte, bekam jede neue Nachricht
     weiter zugestellt, ganz ohne erneute Mitgliedsprüfung — bis er die App
     neu startete. Für einen öffentlichen Kanal braucht es diese Prüfung
     dagegen gar nicht: den darf ohnehin jede angemeldete Person sehen,
     Mitglied oder nicht — genau das drückt die Artprüfung hier aus, nicht
     mehr und nicht weniger. Das ist die eigentliche Garantie; die Leerung
     oben ist nur Hygiene dafür, dass diese Schleife möglichst selten etwas
     zu tun hat. */
  if (kanalDerNachricht?.kind === 'public') {
    for (const s of sessions.values()) {
      if (s.userId && s.openChannelId === message.channelId) recipients.add(s.userId);
    }
  }

  for (const uid of recipients) {
    const payload: ServerEvent = {
      t: 'message:new',
      message,
      ...(uid === message.userId && senderClientId ? { clientId: senderClientId } : {}),
    };
    sendToUser(uid, payload);
    const state = store.channelState(message.channelId, uid);
    if (state) sendToUser(uid, { t: 'channel:state', state });
  }

  /* Web Push — läuft nebenher und blockiert die WS-Zustellung oben nicht.
     Geht an ALLE Empfänger mit Abonnement, unabhängig davon, ob sie gerade
     eine offene Verbindung haben: ein Gerät im Hintergrund bekommt den Push
     genau dann, wenn ein anderes Gerät derselben Person längst per WS bedient
     wurde. Das Doppelt-Anzeigen auf einem Gerät, das gerade aktiv zusieht,
     verhindert der Service Worker selbst (sw.js, Ereignis 'push') — nicht
     der Server, der die Sichtbarkeit eines Fensters nicht kennt. */
  if (!message.systemKind) {
    const kanal = kanalDerNachricht;
    const istDm = kanal?.kind === 'dm';
    const autor = store.getUser(message.userId);
    for (const uid of recipients) {
      if (uid === message.userId) continue;
      const dringend = istDm || message.mentionUserIds.includes(uid);
      if (!push.sollBenachrichtigen(uid, { channelId: message.channelId, dringend })) continue;
      // DM mit bekanntem Namen oder Kanalname: kein Übersetzungsfall, ein
      // Eigenname bleibt in jeder Sprache derselbe. Nur der Rückfall ohne
      // Namen braucht einen Code — 'toast.newMessage', derselbe Rückfall,
      // den state/store.ts (notifyIfNeeded()) für dieselbe Lage schon zeigt.
      const titel: push.PushTextfeld = !istDm
        ? { text: `#${kanal?.name || 'Kanal'}` }
        : autor
          ? { text: autor.displayName }
          : { text: 'Neue Nachricht', code: 'toast.newMessage' };
      // Vertraulicher Kanal: der Server kann den Klartext gar nicht lesen (er
      // hat ihn nie gesehen), also auch nichts Falsches verschicken — aber
      // ohne diese Abfrage stünde hier das Chiffrat selbst als "Vorschau".
      // Derselbe Platzhaltertext wie im Frontend für dieselbe Lage:
      // 'vertraulich.titel' steht in state/store.ts (notifyIfNeeded()) genau
      // dann als Textkörper, wenn istE2EChiffrat() zutrifft.
      const text: push.PushTextfeld = istE2EChiffrat(message.text)
        ? { text: 'Vertraulicher Kanal', code: 'vertraulich.titel' }
        : { text: istDm ? message.text : `${autor?.displayName ?? '…'}: ${message.text}` };
      void push.sendenAn(uid, { titel, text, kanalId: message.channelId, gruppe: message.channelId });
    }
  }

  /* Ende hier, wenn der Text verschlüsselt ist. Alles Folgende — Zielsprachen
     sammeln, übersetzen, Umfragen nachziehen — arbeitet am Klartext, und den
     gibt es nicht. Die App der empfangenden Person entschlüsselt selbst; eine
     Übersetzung gibt es in vertraulichen Kanälen bewusst nicht. */
  if (istE2EChiffrat(message.text)) return;

  // Zielsprachen einsammeln (nur für Leute, die auto-translate anhaben)
  const sourceLang = message.sourceLang ?? 'unknown';
  const langs = new Map<string, string[]>();
  for (const uid of recipients) {
    if (uid === message.userId) continue;
    const u = db.get<{ language: string; auto_translate: number; role: string }>(
      'SELECT language, auto_translate, role FROM users WHERE id = ?', uid,
    );
    // Für Bots übersetzen wäre verschenkte Rechenzeit — sie lesen nichts.
    if (!u || !u.auto_translate || u.role === 'bot') continue;
    const target = normalizeLang(u.language);
    if (target === sourceLang) continue;
    langs.set(target, [...(langs.get(target) ?? []), uid]);
  }

  // Eine Umfrage steht nicht im Nachrichtentext, sondern in eigenen Zeilen.
  // Ohne diesen Anstoß bliebe sie mitten im übersetzten Gespräch deutsch.
  if (message.poll) {
    for (const [target, users] of langs) {
      void translatePoll(message.poll.id, target, { sourceLang: message.sourceLang })
        .then((sicht) => {
          if (!sicht) return;
          for (const uid of users) {
            const poll = polls.getPoll(message.poll!.id, uid);
            if (poll) sendToUser(uid, { t: 'poll:updated', poll: { ...poll, translation: sicht }, channelId: message.channelId });
          }
        })
        .catch((err) => console.error('[ws] Umfrage-Übersetzung:', (err as Error).message));
    }
  }

  const context = channelContext(message.channelId);
  for (const [target, users] of langs) {
    const key = `${message.id}:${target}`;
    let job = inflight.get(key);
    if (!job) {
      job = translateMessage(message.id, target, { context }).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    void job
      .then((view) => {
        if (!view) return;
        // Gleiche Zielsprache, verschiedene Personen — jede braucht ihre
        // eigene Auflösung der Maßangaben-Sentinel (siehe messwerteFuerNutzer).
        for (const uid of users) {
          sendToUser(uid, { t: 'translation', messageId: message.id, translation: messwerteFuerNutzer(view as TranslationView, uid) });
        }
      })
      .catch((err) => console.error('[ws] Übersetzung fehlgeschlagen:', (err as Error).message));
  }
}

/* ── Presence ─────────────────────────────────────────────────── */

/**
 * Wie lange ein selbst gesetzter Status gilt.
 *
 * Acht Stunden sind ein Arbeitstag. Wer morgens „bitte nicht stören" wählt,
 * findet es nachmittags noch vor — und am nächsten Morgen nicht mehr. Kürzer
 * wäre lästig, weil die Frist mitten in der Besprechung abliefe, für die man
 * sie gesetzt hat. Unbegrenzt wäre schlimmer: ein einmal gesetztes „abwesend"
 * bliebe wochenlang stehen, und dann glaubt niemand mehr den Punkten neben
 * den Namen.
 *
 * Solange die Frist läuft, hat die eigene Wahl Vorrang vor allem, was von
 * selbst geschieht — sonst nähme ein einziger Tastendruck sie zurück.
 */
const MANUELL_HAELT_MS = 8 * 60 * 60_000;

/**
 * Ab wann jemand ohne Zutun auf „abwesend" wandert.
 *
 * Der Server sieht keine Mausbewegung, nur Ereignisse. Eine halbe Stunde ohne
 * jede Handlung ist deshalb mit Absicht großzügig: wer lange in einem Kanal
 * liest, ohne zu wechseln oder zu schreiben, soll nicht fälschlich abwesend
 * erscheinen. Der genaue Wächter sitzt in der Oberfläche (StatusMenu) und
 * meldet schon nach fünf Minuten ohne Eingabe; das hier ist das Netz für
 * alles, was ihn nicht mitbringt — ältere Apps und fremde Clients.
 */
const LEERLAUF_MS = 30 * 60_000;

/** Wann jemand zuletzt etwas getan hat, hinter dem ein Mensch stecken muss. */
const letzteAktion = new Map<string, number>();

/**
 * Ereignisse, die als Lebenszeichen zählen.
 *
 * Bewusst eine Auswahlliste und keine Ausnahmeliste: alles Neue gilt erst
 * einmal als Hintergrundrauschen, statt versehentlich jemanden wachzuhalten.
 * Nicht dabei ist vor allem "read" — das schickt die Oberfläche von selbst,
 * sobald in einem sichtbaren Fenster eine Nachricht ankommt. Ein vergessener,
 * offener Rechner bliebe damit für immer grün, und genau das ist der Fehler,
 * den dieser Wächter beheben soll.
 */
const MENSCHLICHE_EREIGNISSE = new Set<string>([
  'message:send', 'message:edit', 'message:delete', 'message:react',
  'message:pin', 'message:forward', 'message:schedule', 'typing', 'draft:save',
  'channel:open', 'channel:create', 'channel:join', 'channel:leave',
  'thread:open', 'dm:open', 'poll:create', 'poll:vote', 'voice:send',
  'task:create', 'task:update', 'task:move', 'task:comment',
  'idea:create', 'idea:vote', 'idea:comment', 'event:create', 'event:respond',
  'vorschlag:accept', 'vorschlag:reject', 'vorschlag:undo',
  'ai:ask', 'ai:rewrite', 'compose:preview',
]);

/** Gilt der selbst gesetzte Status gerade noch? */
function statusHaelt(userId: string): boolean {
  return (store.getUser(userId)?.statusExpiresAt ?? 0) > Date.now();
}

/**
 * Ein Lebenszeichen verbuchen — und wer wieder da ist, ist wieder online.
 *
 * Die Rückkehr geschieht nur aus einem von selbst entstandenen „abwesend".
 * Eine eigene Wahl bleibt stehen, solange ihre Frist läuft; sonst hätte das
 * Statusmenü keinen Wert, weil schon das Tippen einer Antwort sie zurücknähme.
 */
function aktivitaetMerken(userId: string): void {
  letzteAktion.set(userId, Date.now());
  if (statusHaelt(userId)) return;
  if (store.getUser(userId)?.status === 'away') setStatus(userId, 'online');
}

function setStatus(
  userId: string, status: UserStatus,
  emoji?: string | null, text?: string | null, expiresAt?: number | null,
): void {
  const sets = ['status = ?', 'last_seen_at = ?'];
  const vals: any[] = [status, Date.now()];
  if (emoji !== undefined) { sets.push('status_emoji = ?'); vals.push(emoji); }
  if (text !== undefined) { sets.push('status_text = ?'); vals.push(text); }
  if (expiresAt !== undefined) { sets.push('status_expires_at = ?'); vals.push(expiresAt); }
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, userId);

  const u = store.getUser(userId);
  if (!u) return;
  const ereignis = {
    t: 'presence' as const, userId, status: u.status,
    statusEmoji: u.statusEmoji, statusText: u.statusText,
    statusExpiresAt: u.statusExpiresAt, lastSeenAt: u.lastSeenAt,
  };

  /*
   * „Unsichtbar" ist offline bei stehender Verbindung — und muss von einem
   * echten offline ununterscheidbar sein, sonst ist es das Versprechen nicht
   * wert. Die Frist daneben würde es verraten: an ihr sähe man, dass hier
   * jemand ausdrücklich gewählt hat, statt einfach fort zu sein. Die Person
   * selbst bekommt sie weiterhin, sie gehört zu ihrem eigenen Menü.
   */
  if (u.status === 'offline' && u.statusExpiresAt !== null) {
    sendToUser(userId, ereignis);
    broadcast({ ...ereignis, statusExpiresAt: null },
      [...byUser.keys()].filter((id) => id !== userId));
    return;
  }
  broadcast(ereignis);
}

/**
 * `requestId` und `clientId` stehen jeweils nur auf einem Teil der
 * ClientEvent-Vereinigung — der generische Fänger unten weiß beim Fang eines
 * Wurfs nicht mehr, welche Ereignisart es war. Der `in`-Operator engt die
 * Vereinigung typsicher auf die Varianten mit dem jeweiligen Feld ein, statt
 * dass eine der beiden Kennungen als `any` durchgeschmuggelt werden muss.
 */
function requestIdVon(ev: ClientEvent): string | undefined {
  return 'requestId' in ev ? ev.requestId : undefined;
}
function clientIdVon(ev: ClientEvent): string | undefined {
  return 'clientId' in ev ? ev.clientId : undefined;
}

/* ── Verbindungsaufbau ────────────────────────────────────────── */

export function handleConnection(socket: WebSocket): void {
  const session: Session = {
    id: newId('s_'), socket, userId: null, language: 'en',
    autoTranslate: true, openChannelId: null, alive: true,
  };
  sessions.set(session.id, session);

  const authTimer = setTimeout(() => {
    if (!session.userId) { fail(session, 'fehler.anmeldungZeit', 'Keine Anmeldung innerhalb von 10 Sekunden'); socket.close(); }
  }, 10_000);

  socket.on('message', (raw: Buffer | string) => {
    /* Wer etwas schickt, lebt — unabhängig davon, ob die Gegenstelle auf
       Protokoll-Pings antwortet. Manche Zwischenstellen schlucken die
       Ping/Pong-Rahmen; ohne diese Zeile würfe der Wächter unten eine
       einwandfreie Verbindung alle 60 Sekunden weg, und die Person flackerte
       für alle anderen zwischen online und offline. */
    session.alive = true;
    const ev = decode<ClientEvent>(raw.toString());
    if (!ev || typeof ev.t !== 'string') return;
    if (ev.t === 'auth') {
      clearTimeout(authTimer);
      // Ohne dieses catch würde ein Fehler beim Anmelden — eine hakende
      // Datenbank genügt — als unbehandelte Zurückweisung den ganzen Server
      // mitreißen, mitsamt allen anderen Verbindungen.
      void authenticate(session, ev).catch((err) => {
        console.error('[ws] Anmeldung:', (err as Error).message);
        fail(session, 'fehler.anmeldungFehlgeschlagen', 'Anmeldung fehlgeschlagen. Bitte noch einmal versuchen.');
        session.socket.close();
      });
      return;
    }
    if (!session.userId) { fail(session, 'fehler.nichtAngemeldet', 'Bitte zuerst anmelden'); return; }
    void handleEvent(session, ev).catch((err) => {
      console.error('[ws]', ev.t, (err as Error).message);
      /* Trägt der Wurf eine Kennung, geht die mit hinaus und die Oberfläche
         setzt ihren eigenen Satz ein. Trägt er keine, bleibt es beim
         deutschen Text des Dienstes: „Nur eigene Nachrichten lassen sich
         bearbeiten" sagt einer Person mehr als ein übersetztes „etwas ist
         schiefgegangen" — das klänge nach einem Serverfehler, wo in Wahrheit
         nur ein Titel fehlt. Lieber genau und deutsch als übersetzt und falsch.
         Wer einen dieser Würfe auf abweisung() umstellt, macht ihn übersetzbar. */
      const { code, werte } = kennungVon(err);
      /* Wurf statt Rückgabe: die allermeisten Abweisungen aus
         messages.createMessage() (leerer Text, zu lang, falscher Kanal für
         den Anhang, …) verlassen case 'message:send' genau hier und nicht
         über eines der fail()-Returns oben — ohne clientId bliebe die
         optimistische Zeile beim Senden für immer als "wird gesendet"
         stehen, denn nur ein error-Ereignis mit clientId räumt sie ab
         (siehe markMessageFailed in packages/desktop/src/state/store.ts). */
      fail(session, code, (err as Error).message, requestIdVon(ev), werte, clientIdVon(ev));
    });
  });

  socket.on('pong', () => { session.alive = true; });

  socket.on('close', () => {
    clearTimeout(authTimer);
    sessions.delete(session.id);
    if (session.userId) {
      const set = byUser.get(session.userId);
      set?.delete(session);
      if (set && set.size === 0) {
        byUser.delete(session.userId);
        /* Der Merker darf nicht überleben: käme dieselbe Person morgen wieder,
           läse der Leerlaufwächter einen uralten Zeitpunkt und stellte sie
           sofort auf abwesend. */
        letzteAktion.delete(session.userId);
        setStatus(session.userId, 'offline');
      }
    }
  });

  socket.on('error', () => { /* close folgt */ });
}

async function authenticate(session: Session, ev: Extract<ClientEvent, { t: 'auth' }>): Promise<void> {
  if (ev.protocol !== WS_PROTOCOL_VERSION) {
    fail(session, 'fehler.protokollVeraltet',
      `Client-Protokoll ${ev.protocol}, Server erwartet ${WS_PROTOCOL_VERSION}. Bitte App aktualisieren.`,
      undefined, { client: String(ev.protocol), server: String(WS_PROTOCOL_VERSION) });
    session.socket.close();
    return;
  }
  const userId = verifyToken(ev.token);
  if (!userId) { fail(session, 'fehler.anmeldungAbgelaufen', 'Anmeldung abgelaufen'); session.socket.close(); return; }

  const self = store.getSelf(userId);
  if (!self) { fail(session, 'fehler.kontoWeg', 'Konto existiert nicht mehr'); session.socket.close(); return; }

  /* Ein gültiges Token allein genügt nicht: Sperren und Löschen wirkten sonst
     erst, wenn das Token nach 30 Tagen abläuft — bis dahin bliebe der Zugang
     bestehen. Bei jeder Anmeldung wird deshalb der Kontostand mitgeprüft. */
  const stand = database.get<{ deleted_at: number | null }>(
    'SELECT deleted_at FROM users WHERE id = ?', userId,
  );
  if (stand?.deleted_at) {
    fail(session, 'fehler.kontoInaktiv', 'Dieses Konto ist nicht mehr aktiv.');
    session.socket.close();
    return;
  }

  /* Ein Einmal-Passwort öffnet die Ereignisleitung nicht.
   *
   * Die Sperre gegen einen Ausweis, der nur aus einem Einmal-Passwort stammt,
   * sitzt als Haken vor allen HTTP-Wegen (einrichtungsRiegel() in index.ts,
   * dort steht die ausführliche Begründung). Ein preHandler deckt aber nur
   * HTTP ab, und hier kommt DASSELBE Token noch einmal herein — über die
   * Ereignisleitung. Ohne diese Zeilen wäre die eine Hälfte zu und die andere
   * offen, und die offene ist die ergiebigere: gleich unten geht ein `ready`
   * hinaus, und das trägt das gesamte Verzeichnis des Hauses — jedes Konto
   * mit Anwesenheit, jeden sichtbaren Kanal, jeden Lesestand, jede vorgemerkte
   * Nachricht. Danach ginge über dieselbe Leitung auch Lesen und Schreiben.
   *
   * Der Riegel steht bewusst VOR `session.userId = userId`: alles, was danach
   * kommt, hält die Sitzung für angemeldet — die Aufnahme in `byUser`, die
   * Anwesenheitsmeldung an die anderen, das `ready`. Eine Prüfung weiter
   * unten wäre eine Prüfung nach der Auslieferung.
   *
   * Bewusst dieselbe Machart wie die drei Prüfungen darüber: melden, schließen,
   * fertig. Kein Sonderzustand, keine halb angemeldete Sitzung — die wäre in
   * der sicherheitsempfindlichsten Funktion dieser Datei genau die Art
   * Zwischenstufe, aus der die nächste Lücke entsteht.
   *
   * DER PREIS, UND WARUM ER RICHTIG HERUM LIEGT
   * Der Client baut die Leitung nach dem Anmelden sofort auf und verbindet nach
   * einem Abbruch mit wachsendem Abstand neu (net/socket.ts, höchstens 20 s).
   * Wer gerade seine Einrichtung ausfüllt, sieht davon nichts — App.tsx zeigt
   * in diesem Zustand nur den Einrichtungsschirm, keine Verbindungsanzeige, und
   * Setup.tsx kommt mit `POST /api/auth/setup` allein aus. Nach dem Abschließen
   * steht die Leitung beim nächsten Versuch von selbst wieder, also spätestens
   * nach 20 Sekunden; was in der Zwischenzeit entsteht (`prefs:update` aus
   * updatePrefs/zeitzoneNachtragen), wartet in der Warteschlange von
   * net/socket.ts und geht dann mit hinaus. Einmalig pro Konto, selbstheilend
   * — gegen ein Verzeichnis des ganzen Hauses, das sich nicht zurückholen
   * lässt, ist das der kleinere Preis. (Wegzubekommen wäre er mit einer Zeile
   * in desktop/src/components/Setup.tsx: `socket.wake()` nach dem geglückten
   * `api.setup()` setzt den Abstand zurück und verbindet sofort.)
   *
   * Ohne Kennung aus dem Wörterbuch, aus demselben Grund wie in index.ts: eine
   * neue müsste in allen 22 Sprachen stehen. Der deutsche Rückfalltext genügt
   * hier besonders gut, weil ihn im offiziellen Client niemand zu sehen
   * bekommt — er ist für den Fremdclient gedacht, der wissen soll, warum. */
  if (self.mustChangePassword) {
    fail(session, undefined,
      'Erst die Ersteinrichtung abschließen — mit einem Einmal-Passwort '
      + 'öffnet dieser Zugang sonst nichts.');
    session.socket.close();
    return;
  }

  session.userId = userId;
  session.language = normalizeLang(self.language);
  session.autoTranslate = self.autoTranslate;

  /* Für die Verwaltung: welche Fassung und Plattform dieses Konto gerade
     fährt (siehe ManagedUser.clientVersion in @stellium/shared und
     TeamAdmin.tsx). Nach dem Riegel oben, wie alles hier — eine Anmeldung,
     die nicht durchkommt, hinterlässt keine Spur. */
  store.clientMeldung(userId, ev.appVersion, ev.platform);

  const set = byUser.get(userId) ?? new Set<Session>();
  const wasOffline = set.size === 0;
  set.add(session);
  byUser.set(userId, set);

  send(session, {
    t: 'ready',
    self,
    users: store.listUsers().map((u) => ({
      ...u,
      status: isOnline(u.id) ? u.status : 'offline',
      // Aus demselben Grund wie in setStatus: die Frist verriete ein „unsichtbar".
      statusExpiresAt: u.id === userId || u.status !== 'offline' ? u.statusExpiresAt : null,
    })),
    channels: store.visibleChannels(userId),
    states: store.channelStates(userId),
    scheduled: store.scheduledFor(userId),
    reminders: reminders.remindersFor(userId),
    drafts: drafts.draftsFor(userId),
    serverTime: Date.now(),
    serverVersion: config.version,
    /* Auch ohne Verwaltungsrecht soll jeder sehen, dass gleich neu gestartet
       wird — die Liste der Fassungen bekommt nur die Verwaltung zu sehen. */
    serverUpdate: (() => {
      const bereit = releases.getRelease('server');
      return bereit && releases.istNeuer(bereit.version, config.version) ? bereit.version : null;
    })(),
    ai: aiCapabilities(),
    // null heißt: dem Server fehlt ein brauchbares VAPID-Schlüsselpaar (siehe
    // config.ts) — kommt praktisch nicht vor, da es sich beim ersten Start
    // selbst erzeugt, aber sauberer als eine leere Zeichenkette zu schicken.
    vapidPublicKey: pushConfigured() ? config.push.publicKey : null,
  });

  // Steht eine Auszeit an, soll auch wer gerade erst kommt sie sehen.
  const auszeit = wartung.anstehend();
  if (auszeit) wartungMelden(session, auszeit);

  /* Ohne diese Zeile hielte der Leerlaufwächter unten den Zeitpunkt 0 für die
     letzte Handlung und stellte jeden sofort nach dem Anmelden auf abwesend. */
  letzteAktion.set(userId, Date.now());

  if (wasOffline) {
    /*
     * Ein selbst gesetzter Status übersteht den Verbindungsabriss, solange
     * seine Frist läuft. Vorher wurde hier stur „offline" zu „online" — und
     * damit war „unsichtbar" nach dem ersten Netzwackler aufgehoben, ohne
     * dass die Person etwas davon merkte. Läuft keine Frist mehr, ist online
     * der ehrliche Wert: die App ist ja gerade wieder da.
     */
    setStatus(userId, statusHaelt(userId) ? self.status : 'online');

    /* Derselbe Anstoß wie in vertraulich:schluessel-melden (jemand fehlt
       noch ein Notizpaket) — hier aber aus Sicht der besitzenden Person
       selbst und bei jeder Rückkehr aus dem Offline-Zustand, nicht nur beim
       einmaligen Schlüsselwechsel eines Mitglieds. Ohne diesen zweiten Weg
       verpufft der Anstoß spurlos, wenn die besitzende Person gerade offline
       war, als ihn jemand auslöste — siehe eigeneUnverpackteMitglieder()
       für die ausführliche Begründung. */
    for (const eintrag of notizen.eigeneUnverpackteMitglieder(userId)) {
      sendToUser(userId, { t: 'notiz:pakete-fehlen', notizId: eintrag.notizId, userId: eintrag.userId });
    }
  }

  // Kanalnamen und -themen in die Lesesprache bringen. Im Hintergrund, damit
  // die Oberfläche sofort steht; die Übersetzungen kommen nach.
  if (self.autoTranslate) {
    for (const kanal of store.visibleChannels(userId)) {
      if (kanal.kind === 'dm' || kanal.translation) continue;
      void kanalUebersetzungNachreichen(kanal.id, userId);
    }
  }
}

/* ── Einstellungen ────────────────────────────────────────────── */

/**
 * Was 'prefs:update' schreiben darf — und in welcher Form.
 *
 * Vorher stand hier nur eine Zuordnung von Feldname zu Spalte, und der Wert
 * ging ungeprüft in das UPDATE. Damit ließ sich über diesen Weg alles
 * hineinschreiben, was ein eigener Client schickte: ein Anzeigename mit
 * sechzigtausend Zeichen (bei der Ersteinrichtung sind achtzig die Grenze),
 * ein Sprachkürzel, das es nicht gibt, ein Aussehen namens „lila". Der
 * Anzeigename ging von dort per user:upsert an jede offene Verbindung im
 * Haus, das Sprachkürzel in jede Übersetzungsanfrage.
 *
 * `pruefen` gibt den Wert zurück, der geschrieben werden soll, oder
 * `undefined` — dann bleibt das Feld unangetastet.
 */
const EINSTELLUNGEN: Record<string, { spalte: string; pruefen: (w: unknown) => unknown }> = {
  language: { spalte: 'language', pruefen: (w) => sprache(w) },
  /* Die Sprache der Oberfläche gibt es auch als "gar nicht gesetzt" — dann
     gilt die Übersetzungssprache. Deshalb ist null hier ein gültiger Wert. */
  uiLanguage: { spalte: 'ui_language', pruefen: (w) => (w === null ? null : sprache(w)) },
  autoTranslate: { spalte: 'auto_translate', pruefen: (w) => (typeof w === 'boolean' ? (w ? 1 : 0) : undefined) },
  composeTargetPreview: { spalte: 'compose_target_preview', pruefen: (w) => (typeof w === 'boolean' ? (w ? 1 : 0) : undefined) },
  autoStatus: { spalte: 'auto_status', pruefen: (w) => (typeof w === 'boolean' ? (w ? 1 : 0) : undefined) },
  lesebestaetigungAus: { spalte: 'lesebestaetigung_aus', pruefen: (w) => (typeof w === 'boolean' ? (w ? 1 : 0) : undefined) },
  notifyOn: { spalte: 'notify_on', pruefen: (w) => ausListe(w, ['all', 'mentions', 'none']) },
  theme: { spalte: 'theme', pruefen: (w) => ausListe(w, ['system', 'dark', 'light']) },
  density: { spalte: 'density', pruefen: (w) => ausListe(w, ['comfortable', 'compact']) },
  notificationSound: { spalte: 'notification_sound', pruefen: (w) => ausListe(w, ['ping', 'blip', 'chime', 'aus']) },
  translationSpeed: { spalte: 'translation_speed', pruefen: (w) => ausListe(w, ['fast', 'balanced', 'accurate']) },
  /* Dieselbe Grenze wie in users.completeSetup(). Sie stand dort allein, und
     damit war sie keine Grenze, sondern eine Höflichkeit. */
  displayName: { spalte: 'display_name', pruefen: (w) => text(w, 80, { leerErlaubt: false }) },
  title: { spalte: 'title', pruefen: (w) => text(w, 120) },
  timezone: { spalte: 'timezone', pruefen: (w) => text(w, 64) },
  // Minuten seit Mitternacht; null hebt die Ruhezeit auf.
  quietHoursStart: { spalte: 'quiet_hours_start', pruefen: (w) => minuten(w) },
  quietHoursEnd: { spalte: 'quiet_hours_end', pruefen: (w) => minuten(w) },
};

function sprache(w: unknown): string | undefined {
  if (typeof w !== 'string') return undefined;
  const code = normalizeLang(w);
  return isSupportedLang(code) ? code : undefined;
}

function ausListe(w: unknown, erlaubt: string[]): string | undefined {
  return typeof w === 'string' && erlaubt.includes(w) ? w : undefined;
}

function text(w: unknown, grenze: number, opt: { leerErlaubt?: boolean } = {}): string | null | undefined {
  if (w === null) return opt.leerErlaubt === false ? undefined : null;
  if (typeof w !== 'string') return undefined;
  const sauber = w.trim().slice(0, grenze);
  if (!sauber) return opt.leerErlaubt === false ? undefined : null;
  return sauber;
}

function minuten(w: unknown): number | null | undefined {
  if (w === null) return null;
  if (typeof w !== 'number' || !Number.isFinite(w)) return undefined;
  const m = Math.trunc(w);
  return m >= 0 && m < 1440 ? m : undefined;
}

/* ── Bremse gegen unbegrenzte KI-Aufrufe ──────────────────────────
 *
 * Betroffen: compose:preview, translate:request, ai:catchup, ai:protocol,
 * ai:ask, ai:extract-tasks — jeder dieser Wege ruft am Ende einen bezahlten
 * Anbieter (Vorgabe groq, siehe config.ts, aktiverAnbieter()). `void
 * handleEvent(...)` in handleConnection() oben wartet nicht auf die Antwort,
 * bevor es das nächste Ereignis desselben Sockets annimmt — eine Sitzung
 * kann also beliebig viele dieser Aufrufe hintereinander lospipelinen, ohne
 * dass eine Antwort abgewartet würde. `darf(session,'ai.translate')` allein
 * bremst das nicht: ein `readonly`-Konto trägt genau dieses eine Recht und
 * ist automatisch Mitglied jedes offenen Kanals (besteht also `kanalZugang`
 * überall).
 *
 * Dieselbe Bauart wie `versuche`/`zuVieleVersuche`/`versuchGezaehlt` in
 * http/routes.ts (dort für Anmeldeversuche) — ein fester Zeitraum, ein
 * Zähler je Schlüssel, kein drittes Muster daneben. Der Schlüssel ist hier
 * die Benutzerkennung statt "Herkunft + Name": anders als bei einer
 * anonymen HTTP-Route (siehe http/posteingang.ts, wo hinter cloudflared
 * jede Anfrage von außen als 127.0.0.1 ankommt und nur ein einziger,
 * globaler Eimer übrigbleibt) hat jede WebSocket-Sitzung ab der Anmeldung
 * eine feste, geprüfte userId — dieselbe Kennung, mit der auch `darf()`
 * schon rechnet.
 *
 * KI_GRENZE = 20 je Minute: eine Person, die aktiv komponiert (Vorschau je
 * Tippause) oder den Assistenten mehrfach hintereinander befragt, kommt in
 * einer normalen Arbeitsminute auf einen niedrigen einstelligen bis knapp
 * zweistelligen Wert — zehn Kolleg:innen, die gleichzeitig arbeiten, stören
 * sich damit nicht gegenseitig, jede hat ihren eigenen Zähler. Eine Sitzung,
 * die das Pipelining oben ausnutzt, reißt die Grenze dagegen binnen weniger
 * Millisekunden.
 *
 * force:true bei translate:request schaltet den Übersetzungs-Cache
 * ausdrücklich ab (skipCache:true, siehe translation/index.ts) — jede so
 * markierte Anfrage kostet also garantiert einen echten Modellaufruf, nie
 * einen Treffer. Eine eigene, engere Grenze verhindert, dass eine Schleife
 * genau diesen Weg wählt, um den gemeinsamen Topf schnell zu leeren, ohne
 * dass es wie ein Missbrauch der anderen, cachefähigen KI-Wege aussieht.
 */
const kiAnfragen = new Map<string, { anzahl: number; bis: number }>();
const KI_GRENZE = 20;
const KI_FENSTER = 60_000;
const kiForceAnfragen = new Map<string, { anzahl: number; bis: number }>();
const KI_FORCE_GRENZE = 5;

function ueberBremse(zaehler: Map<string, { anzahl: number; bis: number }>, grenze: number, schluessel: string): boolean {
  const eintrag = zaehler.get(schluessel);
  if (!eintrag) return false;
  if (Date.now() > eintrag.bis) { zaehler.delete(schluessel); return false; }
  return eintrag.anzahl >= grenze;
}

function bremseZaehlen(zaehler: Map<string, { anzahl: number; bis: number }>, fenster: number, schluessel: string): void {
  const jetzt = Date.now();
  const eintrag = zaehler.get(schluessel);
  if (!eintrag || jetzt > eintrag.bis) zaehler.set(schluessel, { anzahl: 1, bis: jetzt + fenster });
  else eintrag.anzahl += 1;
  // Dieselbe Aufräumzeile wie bei `versuchGezaehlt` in http/routes.ts.
  if (zaehler.size > 5000) {
    for (const [k, w] of zaehler) if (jetzt > w.bis) zaehler.delete(k);
  }
}

/** Abweisen, wenn diese Person die KI-Bremse für diese Minute schon erreicht hat. */
function kiZugang(session: Session, requestId?: string): boolean {
  const userId = session.userId!;
  if (ueberBremse(kiAnfragen, KI_GRENZE, userId)) {
    fail(session, 'fehler.kiUeberlastet',
      'Zu viele KI-Anfragen kurz hintereinander — bitte kurz warten.', requestId);
    return false;
  }
  bremseZaehlen(kiAnfragen, KI_FENSTER, userId);
  return true;
}

/**
 * Dieselbe Bremse, enger, für Anfragen, die den Übersetzungs-Cache
 * ausdrücklich umgehen (translate:request mit force:true). Zusätzlich zur
 * gemeinsamen Grenze oben, nicht statt ihr — kiZugang() bleibt daneben
 * bestehen.
 */
function kiForceZugang(session: Session): boolean {
  const userId = session.userId!;
  if (ueberBremse(kiForceAnfragen, KI_FORCE_GRENZE, userId)) {
    fail(session, 'fehler.kiUeberlastet',
      'Zu viele erzwungene Übersetzungen kurz hintereinander — bitte kurz warten.');
    return false;
  }
  bremseZaehlen(kiForceAnfragen, KI_FENSTER, userId);
  return true;
}

/** Höchstlänge für Freitext, der roh an einen bezahlten Anbieter geht
    (compose:preview) — vor der Bremse oben schon eine Sache der Kosten pro
    einzelner Anfrage, nicht nur ihrer Häufigkeit. Großzügig genug für die
    längste ehrliche Nachricht, eng genug gegen eine eingefügte Textwand. */
const KI_TEXT_MAX = 4000;

/* ── Event-Dispatch ───────────────────────────────────────────── */

async function handleEvent(session: Session, ev: ClientEvent): Promise<void> {
  const userId = session.userId!;

  /* Ein Ereignis von hier ist der einzige Hinweis, den der Server darauf hat,
     dass jemand tatsächlich am Rechner sitzt. */
  if (MENSCHLICHE_EREIGNISSE.has(ev.t)) aktivitaetMerken(userId);

  switch (ev.t) {
    case 'ping':
      send(session, { t: 'pong', ts: ev.ts });
      return;

    case 'channel:open': {
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden');
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal');
      }
      session.openChannelId = ch.id;

      /* Math.min allein reicht nicht: eine negative Zahl kommt kleiner durch
         und wird in SQL zu LIMIT -1 — das liefert den ganzen Kanal auf einmal.
         Dieselbe Regel wie bei der Suche, und sie steht dort: eine Zahl, die
         keine brauchbare Grenze ist, wird auf die Vorgabe zurückgesetzt. */
      const wieviele = grenze(ev.limit, 50, 100);
      const { messages: list, hasMore } = store.channelHistory(ch.id, ev.before ?? null, wieviele, userId);
      const missing = session.autoTranslate ? fillCachedTranslations(list, session.language, userId) : [];
      send(session, { t: 'channel:history', channelId: ch.id, messages: list, hasMore });
      if (missing.length) translateInBackground(missing, session.language, userId, channelContext(ch.id));
      /* Beim Öffnen gleich mitschicken, was zum Entschlüsseln nötig ist —
         sonst müsste die App erst merken, dass sie nichts lesen kann, und
         dann nachfragen. Das sähe für einen Wimpernschlag aus wie ein
         kaputter Kanal. */
      if (ch.vertraulich) {
        send(session, {
          t: 'vertraulich:paket', channelId: ch.id,
          fassung: vertraulich.aktuelleFassung(ch.id),
          pakete: vertraulich.paketeFuer(ch.id, userId),
        });
        schluesselarbeitAnstossen(ch.id);
      }
      return;
    }

    case 'channel:create': {
      if (!darf(session, ev.kind === 'private' ? 'channel.create_private' : 'channel.create')) return;
      const ch = channels.createChannel({
        kind: ev.kind, name: ev.name, topic: ev.topic ?? null,
        primaryLanguage: ev.primaryLanguage ?? null, createdBy: userId, memberIds: ev.memberIds,
      });
      const audience = ev.kind === 'public' ? undefined : ch.memberIds;
      broadcast({ t: 'channel:upsert', channel: ch }, audience);
      for (const uid of ch.memberIds) {
        const st = store.channelState(ch.id, uid);
        if (st) sendToUser(uid, { t: 'channel:state', state: st });
      }
      return;
    }

    case 'channel:join': {
      const ch = channels.joinChannel(ev.channelId, userId);
      sendToUser(userId, { t: 'channel:upsert', channel: ch });
      const st = store.channelState(ch.id, userId);
      if (st) sendToUser(userId, { t: 'channel:state', state: st });
      /* systemKind: 'join' — der Text hier ist der Rückfall für Clients ohne
         Wörterbuch-Kennung, dieselbe Bauart wie bei den vier vertraulich.*-
         Systemtexten (siehe zugangsMeldung() oben). MessageItem.tsx kennt in
         SYSTEMTEXTE bislang nur die vier vertraulich.*-Werte; 'join' fehlt
         dort und rendert deshalb im Verlauf jeder Person dauerhaft deutsch —
         Client-seitig zu ergänzen (packages/desktop, nicht dieses Paket):
         ein Eintrag `'join': 'sys.beigetreten'` in SYSTEMTEXTE plus der
         Schlüssel `sys.beigetreten` in allen Sprachdateien unter
         packages/desktop/src/i18n/, nach demselben Muster wie
         'sys.vertraulichEin' ("{name} ist diesem Kanal beigetreten." /
         "{name} joined this channel."). Der Name kommt dabei wie bei den
         vier bestehenden Einträgen aus message.userId, nicht aus dem Text
         hier — server-seitig ist an der Kennzeichnung selbst nichts falsch. */
      const sys = messages.createMessage({
        channelId: ch.id, userId, text: `@${store.getUser(userId)?.handle} ist dem Kanal beigetreten`, systemKind: 'join',
      });
      deliverMessage(sys);
      return;
    }

    case 'channel:leave': {
      const warVertraulich = vertraulich.istVertraulich(ev.channelId);
      channels.leaveChannel(ev.channelId, userId);
      sendToUser(userId, { t: 'channel:removed', channelId: ev.channelId });
      kanalElementeZuruecknehmen(ev.channelId, [userId]);
      /* Ohne dies blieb `openChannelId` auf diesem Kanal stehen, und
         deliverMessage()/prefs:update() lasen ihn weiter aus (siehe die
         ausführliche Begründung bei offenenKanalVergessen() oben). */
      offenenKanalVergessen(userId, ev.channelId);
      /* Wer geht, nimmt den Kanalschlüssel auf seinem Gerät mit. Ohne Wechsel
         läse er alles Neue weiter mit — er müsste den Kanal dafür nicht einmal
         sehen, ein mitgeschriebenes Chiffrat genügte. */
      if (warVertraulich) {
        for (const uid of store.memberIds(ev.channelId)) {
          if (!vertraulich.kannLesen(ev.channelId, uid)) continue;
          sendToUser(uid, {
            t: 'vertraulich:wechsel-noetig', channelId: ev.channelId,
            grund: 'Jemand hat den Kanal verlassen.',
          });
        }
      }
      return;
    }

    case 'channel:update': {
      // Nach einer Änderung sind alte Übersetzungen hinfällig; die Prüfsumme
      // sorgt dafür, dass sie beim nächsten Anfassen neu entstehen.
      if (!darf(session, ev.archived !== undefined ? 'channel.archive' : 'channel.manage')) return;
      const ch = channels.updateChannel(ev.channelId, {
        name: ev.name, topic: ev.topic, purpose: ev.purpose,
        primaryLanguage: ev.primaryLanguage, archived: ev.archived, readOnly: ev.readOnly,
      });
      if (ch) broadcast({ t: 'channel:upsert', channel: ch }, ch.kind === 'public' ? undefined : ch.memberIds);
      return;
    }

    case 'channel:delete': {
      if (!darf(session, 'channel.delete')) return;
      const betroffen = store.memberIds(ev.channelId);
      const info = channels.deleteChannel(ev.channelId);
      broadcast({ t: 'channel:removed', channelId: ev.channelId }, betroffen);
      console.log(`[kanal] #${info.name} gelöscht (${info.messages} Nachrichten) von ${userId}`);
      return;
    }

    case 'channel:hide': {
      /* Bei einem gewöhnlichen Kanal tut Ausblenden dasselbe wie Verlassen:
         die Mitgliedschaft fällt weg (siehe channels.hideChannel). Der
         Schlüsselwechsel hing aber allein an 'channel:leave' — wer stattdessen
         ausblendete, ging mit dem Kanalschlüssel auf seinem Gerät hinaus, und
         im Kanal merkte es niemand. Zwei Wege, eine Wirkung: dann gehört auch
         dieselbe Folge daran. */
      const warVertraulich = vertraulich.istVertraulich(ev.channelId);
      const warMitglied = store.isMember(ev.channelId, userId);
      channels.hideChannel(ev.channelId, userId);
      sendToUser(userId, { t: 'channel:removed', channelId: ev.channelId });
      kanalElementeZuruecknehmen(ev.channelId, [userId]);
      // Dieselbe Begründung wie bei channel:leave — Ausblenden tut hier
      // dasselbe wie Verlassen, also braucht es auch dieselbe Aufräumung.
      offenenKanalVergessen(userId, ev.channelId);
      if (warVertraulich && warMitglied && !store.isMember(ev.channelId, userId)) {
        for (const uid of store.memberIds(ev.channelId)) {
          if (!vertraulich.kannLesen(ev.channelId, uid)) continue;
          sendToUser(uid, {
            t: 'vertraulich:wechsel-noetig', channelId: ev.channelId,
            grund: 'Jemand hat den Kanal verlassen.',
          });
        }
      }
      return;
    }

    case 'channel:members': {
      if (!darf(session, 'channel.members')) return;
      const ch = channels.setMembers(ev.channelId, ev.add ?? [], ev.remove ?? []);
      // Neue Mitglieder brauchen den Kanal, entfernte sollen ihn verlieren.
      for (const uid of ch.memberIds) {
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ch.id, uid)! });
        const st = store.channelState(ch.id, uid);
        if (st) sendToUser(uid, { t: 'channel:state', state: st });
      }
      for (const uid of ev.remove ?? []) {
        if (!ch.memberIds.includes(uid)) {
          sendToUser(uid, { t: 'channel:removed', channelId: ch.id });
          // Dieselbe Begründung wie bei channel:leave/channel:hide — nur hier
          // für eine ANDERE Person als die aufrufende, darum keine Session,
          // sondern die userId, über die offenenKanalVergessen() selbst geht.
          offenenKanalVergessen(uid, ch.id);
        }
      }
      kanalElementeZuruecknehmen(ch.id, ev.remove ?? []);

      /* Vertrauliche Kanäle: Aufnahme heißt verpacken, Entfernen heißt
         wechseln. Beides kann nur eine App erledigen, die den Kanalschlüssel
         hat — der Server bittet lediglich darum. Der Wechsel steht zuerst,
         weil er der dringendere ist: bis er passiert, liest die entfernte
         Person alles Neue weiter mit. */
      if (ch.vertraulich) {
        if ((ev.remove ?? []).length) {
          for (const uid of ch.memberIds) {
            if (!vertraulich.kannLesen(ch.id, uid)) continue;
            sendToUser(uid, {
              t: 'vertraulich:wechsel-noetig', channelId: ch.id,
              grund: 'Jemand hat den Kanal verlassen.',
            });
          }
        }
        schluesselarbeitAnstossen(ch.id);
      }
      return;
    }

    case 'channel:mute': {
      channels.setMuted(ev.channelId, userId, ev.muted);
      const st = store.channelState(ev.channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      return;
    }

    case 'channel:star': {
      channels.setStarred(ev.channelId, userId, ev.starred);
      const st = store.channelState(ev.channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      return;
    }

    case 'dm:open': {
      if (!darf(session, 'dm.start')) return;
      /* Technische Konten nehmen keine Direktnachrichten an. Die Oberfläche
         zeigt sie gar nicht erst an — diese Prüfung ist die, auf die es
         ankommt: eine Oberfläche lässt sich umgehen, ein Server nicht.
         Wer verwalten darf, sieht die Konten weiterhin im Reiter
         „Mitglieder"; auch dort führt kein Weg in einen Chat mit ihnen. */
      const ziel = store.getUser(ev.userId);
      if (ziel?.technisch) {
        return fail(session, 'fehler.technischesKonto',
          'Technische Konten nehmen keine Nachrichten an.');
      }
      const ch = channels.openDm(userId, ev.userId);
      for (const uid of ch.memberIds) {
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ch.id, uid)! });
        const st = store.channelState(ch.id, uid);
        if (st) sendToUser(uid, { t: 'channel:state', state: st });
      }
      session.openChannelId = ch.id;
      const { messages: list, hasMore } = store.channelHistory(ch.id, null, 50, userId);
      const missing = session.autoTranslate ? fillCachedTranslations(list, session.language, userId) : [];
      send(session, { t: 'channel:history', channelId: ch.id, messages: list, hasMore });
      /* channel:upsert geht an alle Mitglieder des Direktchats. Wer daraus
         navigiert, reißt auch den Gegenüber aus seinem Kanal — springen darf
         nur die Session, die den Chat gerade geöffnet hat. Erst nach dem
         Verlauf, sonst zeigt die Ansicht kurz einen leeren Kanal. */
      send(session, { t: 'channel:focus', channelId: ch.id });
      if (missing.length) translateInBackground(missing, session.language, userId, null);
      return;
    }

    case 'message:send': {
      /* Jede Abweisung ab hier gibt `ev.clientId` an `fail()`/`darf()`/
         `chiffratNoetig()` weiter — der Client kann die betroffene Zeile
         damit direkt treffen, statt raten zu müssen, welche gerade
         ausstehende Nachricht gemeint war (siehe `case 'error'` in
         packages/desktop/src/state/store.ts). */
      if (!darf(session, 'message.send', ev.clientId)) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden', undefined, undefined, ev.clientId);
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal', undefined, undefined, ev.clientId);
      }
      if (ch.kind === 'public') channels.ensureMember(ch.id, userId);

      // Ankündigungskanäle: nur wer sie verwalten darf, schreibt auch hinein.
      if (ch.readOnly && !may(userId, 'channel.manage')) {
        return fail(session, 'fehler.nurKanalverwaltung', 'In diesen Kanal schreibt nur die Kanalverwaltung.',
          undefined, undefined, ev.clientId);
      }

      /* In einem vertraulichen Kanal nimmt der Server keinen Klartext an.
         Das ist die Stelle, an der die Zusage steht oder fällt: eine App mit
         altem Stand — oder eine selbstgebaute — würde sonst munter unverschlüsselt
         hineinschreiben, und niemandem im Kanal fiele es auf. Lieber eine
         abgewiesene Nachricht als eine, die stillschweigend offen liegt. */
      if (chiffratNoetig(session, ch.id, ev.text, undefined, undefined, ev.clientId)) return;

      // Wer einen Chat ausgeblendet hat, soll ihn bei neuer Aktivität wiedersehen.
      channels.unhideForAll(ch.id);

      // Erwähnungen sind ein eigenes Recht: wer es nicht hat, soll das auch
      // erfahren, statt dass die Benachrichtigung still verschluckt wird.
      const darfErwaehnen = may(userId, 'mention.user');
      const darfAlle = may(userId, 'mention.everyone');
      if (!darfErwaehnen && extractMentions(ev.text).length > 0) {
        return fail(session, 'fehler.keinRechtErwaehnen', 'Dafür fehlt dir das Recht "Personen erwähnen".',
          undefined, undefined, ev.clientId);
      }
      if (!darfAlle && mentionsEveryone(ev.text)) {
        return fail(session, 'fehler.keinRechtAlleErwaehnen', 'Dafür fehlt dir das Recht "Alle erwähnen".',
          undefined, undefined, ev.clientId);
      }

      const msg = messages.createMessage({
        channelId: ch.id, userId, text: ev.text, parentId: ev.parentId ?? null,
        attachmentIds: ev.attachmentIds, pendingAttachments: ev.pendingAttachments,
        sourceLang: ev.sourceLang ?? null,
        mayMention: darfErwaehnen, mayMentionEveryone: darfAlle,
      });
      messages.markRead(ch.id, userId, msg.id);

      /* Bilduploads sollen niemanden aufhalten: steht die Nachricht schon,
         bevor ein Anhang fertig ist, geht sie trotzdem sofort hinaus — mit
         einem Platzhalter für das, was noch fehlt. message:attach trägt die
         fertige Datei nach, message:attachGiveUp räumt auf, wenn daraus
         nichts wird. */
      if (ev.pendingAttachments?.length) {
        const jetzt = Date.now();
        ausstehendeAnhaenge.set(msg.id, new Map(
          ev.pendingAttachments.map((p) => [p.tempId, { name: p.name, mime: p.mime, uploaderId: userId, seit: jetzt }]),
        ));
      }
      deliverMessage(
        ev.pendingAttachments?.length ? { ...msg, pendingAttachments: ev.pendingAttachments } : msg,
        ev.clientId,
      );
      enrichLinks(msg.id, msg.text, ch.id);
      vielleichtAntworten(ch.id, msg.text, userId);
      return;
    }

    case 'message:edit': {
      if (!darf(session, 'message.edit_own')) return;
      if (!may(userId, 'mention.user') && extractMentions(ev.text).length > 0) {
        return fail(session, 'fehler.keinRechtErwaehnen', 'Dafür fehlt dir das Recht "Personen erwähnen".');
      }
      /* Dieselbe Zusage wie beim Senden: eine Bearbeitung darf eine
         verschlüsselte Nachricht nicht in eine offene verwandeln. */
      const kanalDerNachricht = database.get<{ channel_id: string }>(
        'SELECT channel_id FROM messages WHERE id = ?', ev.messageId,
      )?.channel_id;
      if (chiffratNoetig(session, kanalDerNachricht, ev.text)) return;
      const msg = messages.editMessage(ev.messageId, userId, ev.text);
      broadcast({ t: 'message:updated', message: msg }, store.memberIds(msg.channelId));
      // Neu übersetzen für alle, die zuschauen
      const targets = new Set<string>();
      for (const uid of store.memberIds(msg.channelId)) {
        if (uid === userId || !isOnline(uid)) continue;
        const u = store.getUser(uid);
        if (u?.autoTranslate) targets.add(normalizeLang(u.language));
      }
      for (const lang of targets) {
        void translateMessage(msg.id, lang, { force: true, context: channelContext(msg.channelId) })
          .then((view) => {
            if (!view) return;
            for (const uid of store.memberIds(msg.channelId)) {
              const u = store.getUser(uid);
              if (u && u.autoTranslate && normalizeLang(u.language) === lang) {
                // u ist schon geholt — direkt die Region daraus statt eines
                // zweiten store.getUser()-Griffs über messwerteFuerNutzer().
                sendToUser(uid, {
                  t: 'translation', messageId: msg.id,
                  translation: messwerteFuerEmpfaenger(view, regionFuerZeitzone(u.timezone), lang),
                });
              }
            }
          })
          .catch(() => { /* Original bleibt sichtbar */ });
      }
      return;
    }

    case 'message:delete': {
      // Ohne diese Prüfung genügte eine bekannte Kennung, um Nachrichten in
      // fremden Kanälen und Direktchats verschwinden zu lassen.
      if (!darfNachrichtAendern(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const scope = ev.scope ?? 'all';
      const eigene = store.getMessage(ev.messageId)?.userId === userId;
      // Für sich ausblenden darf jede:r immer — das ändert nichts für andere.
      if (scope === 'all' && !darf(session, eigene ? 'message.delete_own' : 'message.delete_any')) return;

      const ergebnis = messages.deleteMessage(ev.messageId, userId, may(userId, 'message.delete_any'), scope);
      if (ergebnis.scope === 'me') {
        // Nur die eigene Ansicht ändert sich.
        send(session, { t: 'message:deleted', messageId: ev.messageId, channelId: ergebnis.channelId });
      } else {
        /* Für alle zurückgenommen: ein Anhang, der noch unterwegs war, hat
           jetzt nichts mehr, woran er hängen könnte. Der Platzhalter fällt
           hier weg — message:attach findet die Nachricht dann als "nicht
           mehr meine" und wirft den Anhang weg, statt ihn irgendwo
           anzuheften (siehe messages.attachUpload). */
        ausstehendeAnhaenge.delete(ev.messageId);
        broadcast({ t: 'message:deleted', messageId: ev.messageId, channelId: ergebnis.channelId },
          store.memberIds(ergebnis.channelId));
      }
      return;
    }

    case 'message:attach': {
      /* Erst nachsehen, ob die Nachricht überhaupt noch der aufrufenden
         Person gehört — unabhängig davon, was im Speicher noch über einen
         Platzhalter steht. Der Platzhalter ist nur eine Anzeige-Hilfe; die
         Wahrheit steht in der Datenbank.

         Die Reihenfolge ist hier bewusst: ERST prüfen, DANN den geteilten
         Speicher `ausstehendeAnhaenge` anfassen. Vorher stand die Löschung
         des Platzhalters vor dieser Prüfung — jede angemeldete Sitzung, die
         eine tempId kannte (sie geht als Teil der Nachricht an alle
         Empfänger:innen hinaus, siehe deliverMessage), konnte damit den
         Platzhalter-Eintrag einer FREMDEN Person löschen, noch bevor die
         Prüfung überhaupt lief. Wirkung nur auf die Anzeige (die Datei selbst
         blieb unberührt), aber message:attachGiveUp direkt darunter hatte die
         Reihenfolge schon immer richtig — jetzt stimmen beide überein. */
      const nachricht = store.getMessage(ev.messageId, userId);
      const eigeneOffeneNachricht = Boolean(nachricht) && nachricht!.userId === userId && !nachricht!.deletedAt;

      if (!eigeneOffeneNachricht) {
        // Nachricht weg, fremd oder schon gelöscht: der Anhang gehört jetzt
        // nirgendwo mehr hin und bleibt nicht als Leiche liegen.
        messages.discardOrphanAttachment(ev.attachmentId, userId);
        return;
      }

      const eintrag = ausstehendeAnhaenge.get(ev.messageId);
      eintrag?.delete(ev.tempId);
      if (eintrag && !eintrag.size) ausstehendeAnhaenge.delete(ev.messageId);

      let aktualisiert: Message | null;
      try {
        aktualisiert = messages.attachUpload(ev.messageId, userId, ev.attachmentId);
      } catch (fehler) {
        // Zum Beispiel: der Kanal ist inzwischen vertraulich geworden und der
        // Anhang wurde dafür nie verschlossen. Dieselbe Meldung wie beim
        // Senden selbst, über den allgemeinen Fehlerfang in handleConnection().
        messages.discardOrphanAttachment(ev.attachmentId, userId);
        throw fehler;
      }
      if (!aktualisiert) {
        messages.discardOrphanAttachment(ev.attachmentId, userId);
        return;
      }

      broadcast(
        { t: 'message:updated', message: { ...aktualisiert, pendingAttachments: ausstehendListe(ev.messageId) } },
        store.memberIds(aktualisiert.channelId),
      );
      return;
    }

    case 'message:attachGiveUp': {
      /* Der Upload ist gescheitert oder die Verbindung brach ab, während er
         lief — was ankommt, ist hier immer nur "vergiss den Platzhalter",
         nie eine Datei: die gibt es in diesem Fall gar nicht. */
      const nachricht = store.getMessage(ev.messageId, userId);
      if (!nachricht || nachricht.userId !== userId) return;

      const eintrag = ausstehendeAnhaenge.get(ev.messageId);
      if (!eintrag?.has(ev.tempId)) return;
      eintrag.delete(ev.tempId);
      if (!eintrag.size) ausstehendeAnhaenge.delete(ev.messageId);

      broadcast(
        { t: 'message:updated', message: { ...nachricht, pendingAttachments: ausstehendListe(ev.messageId) } },
        store.memberIds(nachricht.channelId),
      );
      return;
    }

    case 'message:react': {
      if (!darf(session, 'reaction.add')) return;
      // Sonst ließe sich in fremden Kanälen reagieren — sichtbar für alle dort.
      if (!darfNachrichtAendern(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const { channelId } = messages.toggleReaction(ev.messageId, userId, ev.emoji);
      const msg = store.getMessage(ev.messageId);
      if (msg) broadcast({ t: 'reaction:updated', messageId: msg.id, channelId, reactions: msg.reactions }, store.memberIds(channelId));
      return;
    }

    case 'message:pin': {
      if (!darf(session, 'message.pin')) return;
      // Sonst ließe sich in fremden Kanälen anheften — sichtbar für alle dort.
      if (!darfNachrichtSehen(userId, ev.messageId)) return;
      const msg = messages.setPinned(ev.messageId, ev.pinned);
      if (msg) broadcast({ t: 'message:updated', message: msg }, store.memberIds(msg.channelId));
      return;
    }

    case 'message:save':
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      messages.setSaved(ev.messageId, userId, ev.saved);
      return;

    case 'message:schedule': {
      if (!darf(session, 'message.schedule')) return;
      // Ohne diese Prüfung ließe sich in jeden Kanal schreiben — auch in
      // private und in fremde Direktchats. Nur eben zeitversetzt.
      if (!store.getChannel(ev.channelId, userId) || !store.isMember(ev.channelId, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal');
      }
      if (chiffratNoetig(session, ev.channelId, ev.text,
        'Dieser Kanal ist vertraulich. Eine geplante Nachricht muss schon beim Planen verschlüsselt sein — '
        + 'sonst läge sie bis zum Absenden offen auf dem Server.',
        'fehler.vertraulichGeplantNoetig')) return;
      const id = messages.scheduleMessage({
        channelId: ev.channelId, userId, text: ev.text, sendAt: ev.sendAt, parentId: ev.parentId ?? null,
      });
      const item = db.get('SELECT * FROM scheduled_messages WHERE id = ?', id);
      if (item) send(session, { t: 'scheduled:upsert', item: store.toScheduled(item) });
      return;
    }

    case 'message:unschedule':
      if (messages.cancelScheduled(ev.scheduledId, userId)) {
        sendToUser(userId, { t: 'scheduled:removed', scheduledId: ev.scheduledId });
      }
      return;

    case 'thread:open': {
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const list = store.threadHistory(ev.messageId, userId);
      if (!list.length) return fail(session, 'fehler.threadNichtGefunden', 'Thread nicht gefunden');
      const missing = session.autoTranslate ? fillCachedTranslations(list, session.language, userId) : [];
      send(session, { t: 'thread:history', parentId: ev.messageId, channelId: list[0].channelId, messages: list });
      if (missing.length) translateInBackground(missing, session.language, userId, channelContext(list[0].channelId));
      return;
    }

    case 'typing': {
      /* Ohne Zugang kein Lebenszeichen. Still abgewiesen wie draft:save: das
         schickt die Oberfläche beim Tippen nebenher, eine Meldung pro
         Tastendruck hülfe niemandem. Ohne diese Zeile konnte jede Person mit
         der Kennung eines privaten Kanals dort „schreibt gerade" erscheinen
         lassen — sichtbar für alle Mitglieder. */
      if (!darfKanalSehen(userId, ev.channelId)) return;
      const audience = store.memberIds(ev.channelId).filter((uid) => uid !== userId);
      broadcast({ t: 'typing', channelId: ev.channelId, userId, parentId: ev.parentId ?? null }, audience);
      return;
    }

    case 'read': {
      // Dasselbe wie bei 'typing': ohne Zugang zum Kanal geht die Meldung
      // nicht an dessen Mitglieder hinaus.
      if (!darfKanalSehen(userId, ev.channelId)) return;
      const at = messages.markRead(ev.channelId, userId, ev.lastMessageId);
      const st = store.channelState(ev.channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      // null heißt: die Marke stand schon dort oder weiter — dann gibt es
      // auch nichts Neues für die anderen Mitglieder zu erfahren.
      // Wer Lesebestätigungen abgeschaltet hat: die eigene Marke rückt oben
      // unverändert vor (channel:state kommt weiter an diese Session), nur
      // dieser Ruf an die anderen Mitglieder unterbleibt.
      if (at !== null && !store.lesebestaetigungAus(userId)) {
        broadcast({ t: 'read', channelId: ev.channelId, userId, lastMessageId: ev.lastMessageId, at },
          store.memberIds(ev.channelId).filter((uid) => uid !== userId));
      }
      return;
    }

    case 'message:read-receipts': {
      // Nur für Nachrichten, die diese Person sehen darf -- dieselbe Prüfung
      // wie beim Öffnen eines Threads. Der Rest fällt still heraus.
      const erlaubt = ev.messageIds.slice(0, 300).filter((id) => darfNachrichtSehen(userId, id));
      send(session, { t: 'message:read-receipts', receipts: messages.readReceiptsBatch(erlaubt) });
      return;
    }

    case 'presence:set': {
      /*
       * Zwei Absender, ein Ereignis — unterschieden an der Frist:
       *
       *   fehlt sie      -> ein Mensch hat gewählt. Der Server legt seine
       *                     Regelfrist darüber, damit die Wahl eine Weile hält.
       *   ist sie null   -> der Leerlaufwächter der Oberfläche meldet, was er
       *                     beobachtet hat. Das darf eine laufende eigene Wahl
       *                     nicht verdrängen.
       *   ist sie eine Zahl -> ausdrücklich bis dahin.
       *
       * „online" bekommt bei eigener Wahl keine Frist: es ist der Zustand, in
       * den alles von selbst zurückfällt. Ihn festzuhalten hieße, den
       * Leerlaufwächter für acht Stunden abzuschalten.
       */
      const automatisch = ev.statusExpiresAt === null;
      if (automatisch && statusHaelt(userId)) return;
      const frist = automatisch
        ? null
        : ev.statusExpiresAt ?? (ev.status === 'online' ? null : Date.now() + MANUELL_HAELT_MS);
      if (!automatisch) letzteAktion.set(userId, Date.now());
      setStatus(userId, ev.status, ev.statusEmoji, ev.statusText, frist);
      return;
    }

    case 'prefs:update': {
      const sets: string[] = [];
      const vals: any[] = [];
      let zeitzoneGeschrieben = false;
      for (const [key, value] of Object.entries(ev.patch)) {
        const feld = EINSTELLUNGEN[key];
        if (!feld) continue;
        const wert = feld.pruefen(value);
        // Was nicht durchkommt, wird still übergangen — wie bisher schon jedes
        // unbekannte Feld. Eine Meldung pro verworfenem Wert hülfe niemandem.
        if (wert === undefined) continue;
        sets.push(`${feld.spalte} = ?`);
        vals.push(wert);
        if (key === 'timezone') zeitzoneGeschrieben = true;
      }
      if (!sets.length) return;
      /* Jede Zeitzone, die hier ankommt, gilt ab sofort als bestätigt — ganz
         gleich, ob ein Mensch sie in Settings.tsx gewählt hat oder der
         einmalige Nachtrag vom Browser sie eingetragen hat (state/store.ts,
         zeitzoneNachtragen): dieselbe Leitung liefert beides an, der Server
         kann und muss die beiden Fälle nicht unterscheiden. Ab hier fasst
         kein Client timezone_auto mehr automatisch an — siehe schema.sql
         beim Feld timezone_auto für die ausführliche Begründung. Ein
         Literal statt eines Platzhalters: es braucht keinen gebundenen Wert. */
      if (zeitzoneGeschrieben) sets.push('timezone_auto = 0');
      db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, userId);

      const self = store.getSelf(userId)!;
      session.language = normalizeLang(self.language);
      session.autoTranslate = self.autoTranslate;
      for (const s of byUser.get(userId) ?? []) {
        s.language = session.language;
        s.autoTranslate = session.autoTranslate;
        send(s, { t: 'self:updated', self });
      }
      broadcast({ t: 'user:upsert', user: store.getUser(userId)! });

      // Sprache gewechselt -> offenen Kanal in der neuen Sprache nachliefern
      if (ev.patch.language && session.openChannelId) {
        /* Die eigentliche Garantie sitzt HIER, nicht beim Leeren von
           openChannelId an den Stellen, die eine Mitgliedschaft beenden
           (channel:leave, channel:hide, channel:members — siehe
           offenenKanalVergessen()): die räumen zwar ordentlich auf, aber ein
           künftiger Weg, der das vergisst, öffnete dasselbe Loch wieder.
           store.channelHistory()/hydrateMessages() prüfen selbst KEINE
           Berechtigung (siehe store.ts) — sie liefern, was verlangt wird, und
           verlassen sich auf den Aufrufer. Ohne diese Zeile bekäme jemand,
           der aus einem privaten Kanal entfernt wurde, dessen letzte 50
           Nachrichten allein durch einen Sprachwechsel zugestellt, ganz ohne
           channel:open — genau dieselbe Prüfung, die channel:open selbst vor
           demselben Aufruf macht (siehe dort). */
        const offenerKanal = store.getChannel(session.openChannelId, userId);
        if (offenerKanal && (offenerKanal.kind === 'public' || store.isMember(offenerKanal.id, userId))) {
          const { messages: list } = store.channelHistory(session.openChannelId, null, 50, userId);
          const missing = fillCachedTranslations(list, session.language, userId);
          // m.translation kommt hier bereits aufgelöst aus fillCachedTranslations()
          // (kein Sentinel, kein measurements-Feld mehr) — nichts weiter zu tun.
          for (const m of list) {
            if (m.translation) send(session, { t: 'translation', messageId: m.id, translation: m.translation });
          }
          if (missing.length) translateInBackground(missing, session.language, userId, channelContext(session.openChannelId));

          // Umfragen stehen nicht im Nachrichtentext und blieben sonst in der
          // alten Sprache stehen, während ringsum alles gewechselt hat.
          for (const m of list) {
            if (!m.poll) continue;
            void pollUebersetzungNachreichen(m.poll.id, userId, session.openChannelId);
          }
        } else {
          // Kein Zugriff mehr, oder der Kanal ist weg: openChannelId zeigt
          // ins Leere — hier gleich aufräumen, statt bei jedem weiteren
          // Sprachwechsel dieselbe Prüfung erneut ins Leere laufen zu lassen.
          session.openChannelId = null;
        }
      }

      // Dasselbe für die Kanäle selbst — Name, Thema, Zweck.
      if (ev.patch.language) {
        for (const kanal of store.visibleChannels(userId)) {
          if (kanal.kind === 'dm') continue;
          void kanalUebersetzungNachreichen(kanal.id, userId);
        }
      }
      return;
    }

    /* Kein Bestätigungsereignis nötig: der Client legt sein Abonnement lokal
       an (siehe lib/benachrichtigung.ts) und meldet es hier nur zur
       Aufbewahrung. Schlägt das Anlegen fehl, bleibt es beim alten Weg —
       kein Grund, die ganze Verbindung daran scheitern zu lassen. */
    case 'push:subscribe':
      push.abonnieren(userId, ev.subscription);
      return;

    case 'push:unsubscribe':
      // Nur die ZEILE DIESES KONTOs löschen — sonst könnte jedes angemeldete
      // Konto die Subscription eines fremden Kontos still entfernen (die
      // Endpoint-URL steht im Klartext im Abonnement) und dem Opfer alle
      // Push-Benachrichtigungen abdrehen, ohne dass dessen Client es merkt.
      push.abbestellen(ev.endpoint, userId);
      return;

    case 'translate:request': {
      if (!darf(session, 'ai.translate')) return;
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      if (klartextNoetigFuerNachricht(session, ev.messageId)) return;
      // force:true kostet garantiert einen echten Modellaufruf (siehe
      // Begründung bei kiForceZugang oben) — deshalb die engere Bremse ZUERST
      // und zusätzlich zur allgemeinen, nicht statt ihr.
      if (ev.force && !kiForceZugang(session)) return;
      if (!kiZugang(session)) return;
      const view = await translateMessage(ev.messageId, ev.targetLang, { force: ev.force });
      if (view) send(session, { t: 'translation', messageId: ev.messageId, translation: messwerteFuerNutzer(view, userId) });
      else fail(session, 'fehler.keineUebersetzungNoetig', 'Keine Übersetzung nötig oder möglich');
      return;
    }

    case 'translate:roundtrip': {
      if (!darf(session, 'ai.translate')) return;
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      if (klartextNoetigFuerNachricht(session, ev.messageId)) return;
      const result = await roundTrip(ev.messageId, ev.targetLang);
      if (!result) return fail(session, 'fehler.keineUebersetzungDa', 'Für diese Nachricht liegt keine Übersetzung vor');
      send(session, { t: 'roundtrip', messageId: ev.messageId, targetLang: ev.targetLang, ...result });
      return;
    }

    case 'compose:preview': {
      if (!darf(session, 'ai.translate')) return;
      /* Besonders wichtig hier: die Vorschau schickt Text, den die Person
         gerade erst tippt — noch unverschlüsselt, weil sie ihn ja noch nicht
         abgeschickt hat. Ginge das durch, wäre die ganze Verschlüsselung
         umsonst: der Klartext läge beim Übersetzungsdienst, bevor er den
         Kanal überhaupt erreicht. */
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      if (!kiZugang(session, ev.requestId)) return;
      // Vorher ging ev.text roh und ungekappt an den Übersetzer — der
      // sanitisierende Helfer text() (siehe oben) war hier nie angewendet.
      const rohtext = text(ev.text, KI_TEXT_MAX, { leerErlaubt: false });
      // text() liefert mit leerErlaubt:false laut Definition nie null, nur
      // string | undefined (siehe die Funktion oben) — die Typprüfung kennt
      // diese Zusicherung nicht, darum hier beide Fälle ausschließen.
      if (!rohtext) return; // leer oder kein Text — nichts zu tun, wie bei draft:save
      const outcome = await translate({
        text: rohtext, targetLang: ev.targetLang, context: channelContext(ev.channelId),
      });
      send(session, {
        t: 'compose:preview', requestId: ev.requestId,
        text: outcome.text, targetLang: ev.targetLang, sourceLang: outcome.sourceLang,
      });
      return;
    }

    case 'ai:catchup': {
      if (!darf(session, 'ai.assistant')) return;
      /* Zugang vor allem anderen: erst danach darf überhaupt herauskommen,
         ob es diesen Kanal gibt und ob er vertraulich ist. */
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden', ev.requestId);
      if (!kiZugang(session, ev.requestId)) return;
      const state = store.channelState(ev.channelId, userId);
      const summary = await ai.catchUp({
        channelId: ev.channelId,
        sinceMessageId: ev.sinceMessageId ?? state?.lastReadMessageId ?? null,
        language: session.language,
        channelName: channels.channelLabel(ch, userId, (id) => store.getUser(id)?.displayName ?? 'Unbekannt'),
        fuerUserId: userId,
      });
      send(session, { t: 'ai:catchup', requestId: ev.requestId, summary });
      return;
    }

    case 'ai:thread-summary': {
      if (!darf(session, 'ai.assistant')) return;
      /* Ohne diese Prüfung ließe sich jeder Thread zusammenfassen, dessen
         Kennung man kennt — auch aus einem Kanal, in dem man nichts verloren
         hat. Die Zusammenfassung gäbe den Inhalt dann wieder. */
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.nachrichtNichtGefunden', 'Nachricht nicht gefunden', ev.requestId);
      }
      if (klartextNoetigFuerNachricht(session, ev.messageId)) return;
      const summary = await ai.summarizeThread(ev.messageId, session.language);
      send(session, { t: 'ai:thread-summary', requestId: ev.requestId, messageId: ev.messageId, summary });
      return;
    }

    case 'ai:smart-replies': {
      if (!darf(session, 'ai.assistant')) return;
      // Vorschläge entstehen aus dem Verlauf — also nur, wo man mitliest.
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const self = store.getSelf(userId)!;
      const replies = await ai.smartReplies({
        channelId: ev.channelId, parentId: ev.parentId ?? null,
        language: session.language, selfName: self.displayName,
      });
      send(session, { t: 'ai:smart-replies', requestId: ev.requestId, replies });
      return;
    }

    case 'ai:reaction-suggest': {
      if (!darf(session, 'ai.assistant')) return;
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'fehler.nachrichtNichtGefunden', 'Nachricht nicht gefunden', ev.requestId);
      }
      if (klartextNoetigFuerNachricht(session, ev.messageId)) return;
      const emojis = await emojiVorschlaege.reactionSuggest(ev.messageId, session.language);
      send(session, { t: 'ai:reaction-suggest', requestId: ev.requestId, messageId: ev.messageId, emojis });
      return;
    }

    case 'ai:rewrite': {
      if (!darf(session, 'ai.assistant')) return;
      /* channelId dient hier nur der Vertraulichkeitsprüfung; wer einen
         fremden Kanal angibt, soll aber auch nicht erfahren, ob er
         vertraulich ist. */
      if (ev.channelId && !kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const text = await ai.rewrite({ text: ev.text, tone: ev.tone, targetLang: ev.targetLang ?? null });
      send(session, { t: 'ai:rewrite', requestId: ev.requestId, text });
      return;
    }

    /* ── Umfragen ─────────────────────────────────────────── */

    case 'poll:create': {
      /* Dieselbe Zusage wie bei 'message:send' oben: jede Abweisung ab hier
         gibt ev.clientId weiter, sonst bleibt die optimistische Zeile für
         immer als "wird gesendet" stehen (siehe Begründung dort). */
      if (!darf(session, 'poll.create', ev.clientId)) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden', undefined, undefined, ev.clientId);
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal', undefined, undefined, ev.clientId);
      }

      /* Die Frage wird zum Nachrichtentext, die Antwortmöglichkeiten landen in
         poll_options — beides also im Kanal und in der Datenbank, beides mit
         derselben Zusage wie eine gewöhnliche Nachricht. Geprüft wird alles
         zusammen: eine Umfrage, bei der nur die Frage verschlossen ist, gibt
         ihren Gegenstand über die Antworten preis. */
      if (chiffratNoetig(session, ch.id, [ev.question, ...ev.options], undefined, undefined, ev.clientId)) return;

      const msg = messages.createMessage({
        channelId: ch.id, userId, text: ev.question.trim(),
        parentId: ev.parentId ?? null, kind: 'poll',
      });
      polls.createPoll({
        messageId: msg.id, question: ev.question, options: ev.options,
        multiple: ev.multiple, anonymous: ev.anonymous, closesAt: ev.closesAt ?? null, userId,
      });
      // Neu laden, damit die Umfrage dranhängt.
      deliverMessage(store.getMessage(msg.id, userId)!, ev.clientId);
      return;
    }

    case 'poll:vote': {
      // Eine Umfrage hängt an einer Nachricht — wer die nicht sehen darf,
      // stimmt auch nicht mit ab.
      const zugehoerig = database.get<{ message_id: string }>(
        'SELECT message_id FROM polls WHERE id = ?', ev.pollId,
      );
      if (!zugehoerig || !darfNachrichtSehen(userId, zugehoerig.message_id)) {
        return fail(session, 'fehler.keinUmfrageZugang', 'Zu dieser Umfrage hast du keinen Zugang.');
      }
      polls.vote(ev.pollId, userId, ev.optionIds);
      broadcastPoll(ev.pollId);
      return;
    }

    case 'poll:close': {
      polls.closePoll(ev.pollId, userId, may(userId, 'poll.close_any'));
      broadcastPoll(ev.pollId);
      return;
    }

    /* ── Weiterleiten ─────────────────────────────────────── */

    case 'message:forward': {
      /* Dieselbe Zusage wie bei 'message:send' oben: jede Abweisung ab hier
         gibt ev.clientId weiter, sonst bleibt die optimistische Zeile für
         immer als "wird gesendet" stehen (siehe Begründung dort). */
      if (!darf(session, 'message.forward', ev.clientId)) return;
      const original = store.getMessage(ev.messageId, userId);
      if (!original) return fail(session, 'fehler.nachrichtNichtGefunden', 'Nachricht nicht gefunden', undefined, undefined, ev.clientId);
      const target = store.getChannel(ev.toChannelId, userId);
      if (!target) return fail(session, 'fehler.zielkanalNichtGefunden', 'Zielkanal nicht gefunden', undefined, undefined, ev.clientId);
      if (target.kind !== 'public' && !store.isMember(target.id, userId)) {
        return fail(session, 'fehler.keinZielkanalZugriff', 'Kein Zugriff auf den Zielkanal', undefined, undefined, ev.clientId);
      }
      if (!store.isMember(original.channelId, userId) && store.getChannel(original.channelId)?.kind !== 'public') {
        return fail(session, 'fehler.keinUrsprungZugriff', 'Kein Zugriff auf die Ursprungsnachricht', undefined, undefined, ev.clientId);
      }

      /* Weiterleiten und Vertraulichkeit vertragen sich in keine Richtung.
         Die vier Fälle einzeln:

           offen → offen             bleibt erlaubt, hier ist nichts zu schützen.

           offen → vertraulich       der Text käme im Klartext in einen Kanal,
                                     in dem laut Zusage nur Chiffrat liegt. Er
                                     stünde dort für den Server lesbar — und
                                     zwar dauerhaft, während alle daneben
                                     stehenden Nachrichten verschlossen sind.

           vertraulich → offen       das Chiffrat verließe den Kanal. Lesen
                                     kann es im Zielkanal niemand, aber es
                                     liegt ab dann bei Leuten, die nie dabei
                                     waren — und wer später an den Schlüssel
                                     kommt, über ein Gerät oder eine Freigabe,
                                     liest es nachträglich mit. Umwandeln kann
                                     der Server es nicht: er hat den Schlüssel
                                     nicht, das ist der ganze Zweck.

           vertraulich → vertraulich zwei Kanäle, zwei Kanalschlüssel. Das
                                     Chiffrat des einen ist im anderen wertlos,
                                     und die Mitglieder dort sähen einen Block
                                     Zeichen, den sie für einen Fehler halten.

         Ein Weiterleiten, das wirklich funktioniert, müsste die App erledigen:
         entschlüsseln, mit dem Schlüssel des Zielkanals neu verschlüsseln und
         als gewöhnliche Nachricht senden. Dem Protokoll fehlt dafür das Feld,
         und der Server kann diesen Schritt nicht übernehmen. Bis dahin also
         nein — mit eigener Kennung und eigenem Text, denn "bitte aktualisieren"
         wäre hier gelogen: kein Stand dieser App kann das.

         Der Text der Nachricht wird zusätzlich geprüft, nicht nur die beiden
         Kanäle. Ein Kanal lässt sich abschalten (vertraulich.ausschalten), die
         alten Nachrichten darin bleiben verschlüsselt — ohne diese Prüfung
         ließe sich ein solches Chiffrat danach überallhin verteilen. */
      if (vertraulich.istVertraulich(original.channelId)
        || vertraulich.istVertraulich(target.id)
        || istE2EChiffrat(original.text)) {
        return fail(session, 'fehler.vertraulichWeiterleiten',
          'Aus einem vertraulichen Kanal heraus und in einen hinein lässt sich nichts weiterleiten — '
          + 'jeder vertrauliche Kanal hat seinen eigenen Schlüssel, und offener Text gehört nicht hinein.',
          undefined, undefined, ev.clientId);
      }

      const text = [ev.comment?.trim(), original.text].filter(Boolean).join('\n\n');
      const msg = messages.createMessage({
        channelId: target.id, userId, text,
        forwardedFrom: `${original.id}|${original.channelId}|${original.userId}`,
      });
      deliverMessage(msg, ev.clientId);
      enrichLinks(msg.id, msg.text, target.id);
      return;
    }

    /* ── Erinnerungen ─────────────────────────────────────── */

    case 'reminder:create': {
      /* Der Zeitgeber schickt beim Auslösen die ganze Nachricht mit (siehe
         startBackgroundJobs). Ohne diese beiden Zeilen genügte eine bekannte
         Kennung, um sich den Text einer fremden Nachricht zustellen zu
         lassen — mit fünf Sekunden Verzögerung und ganz ohne Mitgliedschaft. */
      if (!kanalZugang(session, ev.channelId)) return;
      if (ev.messageId && !darfNachrichtLesen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const reminder = reminders.createReminder({
        userId, channelId: ev.channelId, messageId: ev.messageId ?? null,
        note: ev.note ?? null, remindAt: ev.remindAt,
      });
      send(session, { t: 'reminder:upsert', reminder });
      return;
    }

    case 'reminder:cancel':
      if (reminders.cancel(ev.reminderId, userId)) {
        sendToUser(userId, { t: 'reminder:removed', reminderId: ev.reminderId });
      }
      return;

    case 'reminder:done':
      if (reminders.markDone(ev.reminderId, userId)) {
        sendToUser(userId, { t: 'reminder:removed', reminderId: ev.reminderId });
      }
      return;

    /* ── Entwürfe ─────────────────────────────────────────── */

    case 'draft:save':
      /* Ein Entwurf für einen vertraulichen Kanal bleibt auf dem Gerät.
         Sonst wäre die ganze Verschlüsselung umsonst: die App speichert beim
         Tippen mit, also käme jede Nachricht schon vor dem Absenden Zeichen
         für Zeichen offen auf dem Server an — und bliebe dort liegen, während
         die fertige Nachricht daneben verschlossen ist.

         Abgewiesen wird hier still, nicht mit einer Fehlermeldung. Das
         Zwischenspeichern ist keine Handlung, die jemand auslöst, sondern
         läuft beim Tippen nebenher; ein Fehler dafür wäre eine Meldung pro
         Tastendruck. Dieselbe Linie wie bei enrichLinks() und
         runTranscription(): was im Hintergrund läuft und hier nicht sein darf,
         unterbleibt einfach.

         Der leere Text löscht dabei, was noch dasteht — ein Entwurf aus der
         Zeit vor der Umstellung soll nicht liegen bleiben. */
      if (vertraulich.istVertraulich(ev.channelId) && !istE2EChiffrat(ev.text)) {
        drafts.saveDraft(userId, ev.channelId, ev.parentId ?? null, '');
        return;
      }
      drafts.saveDraft(userId, ev.channelId, ev.parentId ?? null, ev.text);
      return;

    /* ── Sprachnachrichten ────────────────────────────────── */

    case 'voice:send': {
      /* Dieselbe Zusage wie bei 'message:send' oben: jede Abweisung ab hier
         gibt ev.clientId weiter, sonst bleibt die optimistische Zeile für
         immer als "wird gesendet" stehen (siehe Begründung dort). */
      if (!darf(session, 'voice.send', ev.clientId)) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden', undefined, undefined, ev.clientId);
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal', undefined, undefined, ev.clientId);
      }
      /* Sprachnachrichten gibt es in einem vertraulichen Kanal nicht.
         Anders als beim Tippen liegt es hier nicht an der App: die Aufnahme
         geht als Anhang über dieselbe Ablage wie jede andere Datei, und für
         Anhänge gibt es die Ende-zu-Ende-Verschlüsselung noch nicht. Der
         Inhalt läge also anhörbar auf dem Server — genau das, was dieser Kanal
         ausschließt. Das Transkript unterbleibt schon länger (siehe
         runTranscription), aber die Aufnahme selbst bliebe liegen, und die ist
         der eigentliche Inhalt.

         Deshalb eine eigene Kennung: "bitte aktualisieren" verspräche, dass
         eine neuere App das könnte. Kann sie nicht — dafür müssten zuerst die
         Anhänge verschlüsselt werden. */
      if (ch.vertraulich) {
        return fail(session, 'fehler.vertraulichSprachnachricht',
          'In einem vertraulichen Kanal gibt es keine Sprachnachrichten — '
          + 'die Aufnahme läge unverschlüsselt auf dem Server.',
          undefined, undefined, ev.clientId);
      }

      const msg = messages.createMessage({
        channelId: ch.id, userId, text: '🎙️ Sprachnachricht',
        parentId: ev.parentId ?? null, attachmentIds: [ev.attachmentId], kind: 'voice',
      });
      messages.markRead(ch.id, userId, msg.id);
      deliverMessage(msg, ev.clientId);
      void runTranscription(msg.id, ev.attachmentId).catch((err) => console.error('[ws] Umschrift:', (err as Error).message));
      return;
    }

    /* ── KI als Gesprächspartner ──────────────────────────── */

    case 'ai:open-chat': {
      if (!darf(session, 'ai.assistant')) return;
      const channelId = ki.openPrivateChat(userId);
      const ch = store.getChannel(channelId, userId)!;
      send(session, { t: 'channel:upsert', channel: ch });
      const st = store.channelState(channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      session.openChannelId = channelId;
      const { messages: list, hasMore } = store.channelHistory(channelId, null, 50, userId);
      send(session, { t: 'channel:history', channelId, messages: list, hasMore });
      // Ohne diese Zeile lädt der Kanal im Hintergrund und die Ansicht bleibt,
      // wo sie war — der Klick sähe aus, als hätte er nichts bewirkt.
      send(session, { t: 'channel:focus', channelId });
      return;
    }

    case 'ai:open-team-channel': {
      if (!darf(session, 'ai.assistant')) return;
      const self = store.getSelf(userId);
      const channelId = ki.ensureTeamChannel(self?.id ?? userId);
      channels.ensureMember(channelId, userId);
      const ch = store.getChannel(channelId, userId)!;
      broadcast({ t: 'channel:upsert', channel: ch });
      const zustand = store.channelState(channelId, userId);
      if (zustand) send(session, { t: 'channel:state', state: zustand });
      session.openChannelId = channelId;
      const { messages: list, hasMore } = store.channelHistory(channelId, null, 50, userId);
      send(session, { t: 'channel:history', channelId, messages: list, hasMore });
      send(session, { t: 'channel:focus', channelId });
      return;
    }

    case 'ai:set-mode': {
      if (!darf(session, 'channel.manage')) return;
      /* Den Assistenten in einem vertraulichen Kanal einzuschalten geht nicht.
         Er bekäme nur Chiffrat zu sehen — und die Einstellung stünde dann als
         eingeschaltet da, während nie etwas passiert. */
      if (klartextNoetig(session, ev.channelId)) return;
      ki.setAiMode(ev.channelId, ev.mode);
      const ch = store.getChannel(ev.channelId, userId);
      if (ch) broadcast({ t: 'channel:upsert', channel: ch }, ch.kind === 'public' ? undefined : ch.memberIds);
      return;
    }

    /* ── Aufgaben ─────────────────────────────────────────── */

    case 'task:list':
      send(session, {
        t: 'task:list',
        tasks: tasks.listTasks({
          channelId: ev.channelId, assigneeId: ev.assigneeId, sichtbarFuer: userId,
        }),
      });
      return;

    case 'task:create': {
      if (!darf(session, 'task.create')) return;
      if (ev.assigneeId && ev.assigneeId !== userId && !may(userId, 'task.assign')) {
        return fail(session, 'fehler.keinRechtUebergeben', 'Aufgaben an andere zu übergeben ist ein eigenes Recht.');
      }
      /* An einen Kanal hängen darf sie nur, wer den Kanal auch sieht. Sonst
         ließe sich eine Aufgabe in einem fremden privaten Kanal ablegen — und
         nachher fragen, was aus ihr geworden ist. */
      if (ev.channelId && !kanalZugang(session, ev.channelId)) return;
      const task = tasks.createTask({ ...ev, createdBy: userId });
      // Alle Beteiligten sollen die Aufgabe sofort sehen.
      broadcastTask(task);
      taskZuteilungMelden(task, null, userId);
      return;
    }

    case 'task:update': {
      if (!darf(session, 'task.create')) return;
      const vorher = tasks.getTask(ev.taskId);
      if (!vorher) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, vorher)) return;
      if (ev.patch.assigneeId !== undefined && ev.patch.assigneeId !== userId && !may(userId, 'task.assign')) {
        return fail(session, 'fehler.keinRechtUebergeben', 'Aufgaben an andere zu übergeben ist ein eigenes Recht.');
      }
      /* Das Protokoll kennt in diesem Feld keinen Kanalwechsel — der Dienst
         schon, und ein selbstgebauter Client schickt, was er will. Wer eine
         Aufgabe umhängt, muss beide Kanäle sehen dürfen. */
      const zielKanal = (ev.patch as { channelId?: string | null }).channelId;
      if (zielKanal && !kanalZugang(session, zielKanal)) return;
      const nachher = tasks.updateTask(ev.taskId, ev.patch, userId);
      umzugMelden(vorher, nachher);
      taskZuteilungMelden(nachher, vorher.assigneeId, userId);
      return;
    }

    case 'task:move': {
      if (!darf(session, 'task.create')) return;
      const vorher = tasks.getTask(ev.taskId);
      if (!vorher) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, vorher)) return;
      broadcastTask(tasks.reorder(ev.taskId, ev.status, ev.afterId ?? null, userId));
      return;
    }

    case 'task:comment': {
      const ziel = tasks.getTask(ev.taskId);
      if (!ziel) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, ziel)) return;
      const verlauf = tasks.addComment(ev.taskId, userId, ev.text);
      send(session, { t: 'task:history', taskId: ev.taskId, events: verlauf });
      const task = tasks.getTask(ev.taskId);
      if (task) broadcastTask(task);
      return;
    }

    case 'task:watch': {
      const ziel = tasks.getTask(ev.taskId);
      if (!ziel) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, ziel)) return;
      broadcastTask(tasks.setWatching(ev.taskId, userId, ev.watching));
      return;
    }

    case 'task:delete': {
      const task = tasks.getTask(ev.taskId);
      if (!task) return;
      if (!aufgabeSichtbar(session, task)) return;
      const eigene = task.createdBy === userId;
      if (!eigene && !may(userId, 'task.delete')) {
        return fail(session, 'fehler.nurModerationAufgaben', 'Fremde Aufgaben darf nur die Moderation löschen.');
      }
      tasks.deleteTask(ev.taskId);
      // Der Kreis muss vor dem Löschen feststehen — danach ist die Zeile weg.
      broadcast({ t: 'task:removed', taskId: ev.taskId }, empfaengerFuer(task.channelId));
      return;
    }

    /* „Passt" — die KI-Aufgabe ist angesehen und verlässt den Reiter „Prüfen".
       Bewusst dasselbe Recht wie zum Anlegen: wer Aufgaben anlegen darf, darf
       auch bestätigen, was die KI vorgelegt hat. */
    case 'task:geprueft': {
      if (!darf(session, 'task.create')) return;
      const vorher = tasks.getTask(ev.taskId);
      if (!vorher || !aufgabeSichtbar(session, vorher)) return;
      const task = tasks.aufgabeGeprueft(ev.taskId);
      if (task) broadcastTask(task);
      return;
    }

    /* ── Projekte ──────────────────────────────────────────────
       Sie hängen an keinem Kanal und tragen keinen vertraulichen Inhalt —
       Name und Farbe. Deshalb gehen sie an alle und brauchen dasselbe Recht
       wie Aufgaben selbst. */
    case 'projekt:list': {
      send(session, { t: 'projekt:list', projekte: projekte.listProjekte() });
      return;
    }

    case 'projekt:create': {
      if (!darf(session, 'task.create')) return;
      try {
        const neu = projekte.createProjekt({ ...ev, createdBy: userId });
        broadcast({ t: 'projekt:upsert', projekt: neu });
      } catch (err) {
        fail(session, 'fehler.projektName', (err as Error).message);
      }
      return;
    }

    case 'projekt:update': {
      if (!darf(session, 'task.create')) return;
      try {
        broadcast({ t: 'projekt:upsert', projekt: projekte.updateProjekt(ev.projektId, ev.patch) });
      } catch (err) {
        fail(session, 'fehler.projektName', (err as Error).message);
      }
      return;
    }

    case 'projekt:delete': {
      /* Löschen ist die eine Stelle, an der ein Griff fremde Arbeit umsortiert
         (alle Aufgaben liegen danach ohne Projekt da) — deshalb das
         Löschrecht, nicht das Anlegerecht. */
      if (!darf(session, 'task.delete')) return;
      projekte.deleteProjekt(ev.projektId);
      broadcast({ t: 'projekt:deleted', projektId: ev.projektId });
      /* Die Aufgaben tragen jetzt kein Projekt mehr — ohne diese Zeile stünde
         auf den Karten noch die alte Schublade, bis jemand neu lädt. */
      for (const task of tasks.listTasks({ includeFinished: true })) {
        if (task.projektId === null) continue;
        broadcastTask(task);
      }
      return;
    }

    /* Beide waren die einzigen Ausreißer im ganzen Datei: jeder verwandte
       Griff prüft die Sichtbarkeit VOR der Wirkung und liefert danach über
       den Kanalkreis aus, nie über den bloßen broadcast() an alle —
       idea:update/status/vote/comments/comment/comment-delete/delete über
       ideeSichtbar() + broadcastIdee(), event:update/respond/attendees/delete
       über terminSichtbar() + broadcastTermin(), sogar task:geprueft direkt
       darüber über aufgabeSichtbar(). services/ideas.ts::getIdea() und
       services/events.ts::getEvent() prüfen selbst nichts (bare
       `SELECT * FROM … WHERE id = ?`) — das ist hier bewusst so und keine
       Lücke: die Sichtbarkeitsprüfung braucht die Kanalkennung aus der Zeile,
       um überhaupt entscheiden zu können, kommt also zwangsläufig NACH dem
       Lesen. Die Prüfung deshalb im Dienst zu verdoppeln hieße, dieselbe
       Regel an zwei Stellen zu formulieren, die eines Tages auseinanderlaufen
       (vgl. die Begründung bei darfElementSehen() oben) — und der Dienst
       kennt für andere, nicht sitzungsgebundene Aufrufer gar keine feste
       Bedeutung von "sichtbar". Die Garantie gehört an die eine Stelle, die
       weiß, WER fragt: den Handler hier, wie überall sonst in dieser Datei. */
    case 'idea:geprueft': {
      if (!darf(session, 'idea.create')) return;
      const vorher = ideas.getIdea(ev.ideaId, userId);
      if (!vorher || !ideeSichtbar(session, vorher)) return;
      const idee = ideas.ideeGeprueft(ev.ideaId, userId);
      if (idee) broadcastIdee(idee);
      return;
    }

    case 'event:geprueft': {
      if (!darf(session, 'event.create')) return;
      const vorher = events.getEvent(ev.eventId);
      if (!vorher || !terminSichtbar(session, vorher)) return;
      const termin = events.terminGeprueft(ev.eventId);
      if (termin) broadcastTermin(termin);
      return;
    }

    /* Ob die KI selbst einträgt, ist eine Entscheidung für den ganzen
       Arbeitsbereich — deshalb das Verwaltungsrecht. */
    case 'ki:selbst-eintragen': {
      /* Dasselbe Recht wie für die Wahl des Modells: beides entscheidet für
         alle, was die KI im Arbeitsbereich tut. */
      if (!darf(session, 'ai.model_select')) return;
      vorschlaege.selbstEintragenSetzen(ev.an, userId);
      broadcast({ t: 'ai:einstellung', selbstEintragen: ev.an });
      return;
    }

    case 'task:history': {
      /* Der Verlauf trägt Titel, Kommentare und wer was geändert hat. Ohne
         diese Prüfung nützte die gefilterte Liste nichts: man müsste die
         Kennung nur kennen und direkt hier fragen. */
      const ziel = tasks.getTask(ev.taskId);
      if (!ziel) return fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
      if (!aufgabeSichtbar(session, ziel)) return;
      send(session, { t: 'task:history', taskId: ev.taskId, events: tasks.historyOf(ev.taskId) });
      return;
    }

    /* ── Vorschlagseingang ─────────────────────────────────────

       Ein Vorschlag gehört genau einer Person. Der Empfängerkreis ist
       deshalb nicht `broadcast(..., empfaengerFuer(...))`, sondern die eine
       Person — aber erst, nachdem `vorschlagSichtbar()` bestätigt hat, dass
       sie den Kanal noch sehen darf. Was daraus entsteht, geht dagegen an
       den vollen Kanalkreis: eine angenommene Aufgabe gehört dem Kanal. */

    case 'vorschlag:list': {
      send(session, { t: 'vorschlag:list', vorschlaege: vorschlaege.listeFuer(userId) });
      return;
    }

    case 'vorschlag:accept': {
      if (!vorschlagSichtbar(session, ev.vorschlagId, ev.requestId)) return;
      try {
        const { vorschlag, aufgabe, idee } = vorschlaege.annehmen(ev.vorschlagId, userId, ev.aenderung);
        /* Erst das Entstandene an den Kanalkreis, dann die Quittung an den
           einen Wartenden: so steht die Aufgabe schon auf dem Brett, wenn
           der Eingang sie als angenommen meldet. */
        if (aufgabe) broadcast({ t: 'task:upsert', task: aufgabe }, empfaengerFuer(aufgabe.channelId));
        if (idee) broadcast({ t: 'idea:upsert', idea: idee }, empfaengerFuer(idee.channelId));
        sendToUser(userId, { t: 'vorschlag:upsert', requestId: ev.requestId, vorschlag });
      } catch (e) {
        return vorschlagFehler(session, e, ev.requestId);
      }
      return;
    }

    case 'vorschlag:reject': {
      if (!vorschlagSichtbar(session, ev.vorschlagId, ev.requestId)) return;
      try {
        const vorschlag = vorschlaege.ablehnen(ev.vorschlagId, userId);
        sendToUser(userId, { t: 'vorschlag:upsert', requestId: ev.requestId, vorschlag });
      } catch (e) {
        return vorschlagFehler(session, e, ev.requestId);
      }
      return;
    }

    case 'vorschlag:undo': {
      if (!vorschlagSichtbar(session, ev.vorschlagId, ev.requestId)) return;
      try {
        const vorher = vorschlaege.getVorschlag(ev.vorschlagId);
        const vorschlag = vorschlaege.zuruecknehmen(ev.vorschlagId, userId);
        /* Das Entstandene ist weg — sonst bliebe die Aufgabe auf den
           Brettern aller anderen stehen, bis jemand neu lädt. */
        if (vorher?.ergebnisId) {
          const kreis = empfaengerFuer(vorschlag.channelId);
          if (vorher.art === 'aufgabe') broadcast({ t: 'task:removed', taskId: vorher.ergebnisId }, kreis);
          else broadcast({ t: 'idea:removed', ideaId: vorher.ergebnisId }, kreis);
        }
        sendToUser(userId, { t: 'vorschlag:upsert', requestId: ev.requestId, vorschlag });
      } catch (e) {
        return vorschlagFehler(session, e, ev.requestId);
      }
      return;
    }

    case 'ai:extract-tasks': {
      if (!darf(session, 'ai.assistant')) return;
      // Aufgaben entstehen aus dem Verlauf des Kanals — nur aus einem eigenen.
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      if (!kiZugang(session, ev.requestId)) return;
      /* Nur das Neue seit dem letzten Durchgang ansehen. */
      const marke = `aufgaben_ab:${ev.channelId}`;
      const seit = settings.getSetting(marke);
      /* Die neue Wasserstandsmarke wird HIER erfasst — VOR dem Modellaufruf,
         nicht danach. ai.extractTasks() liest die Nachrichten über
         fetchMessages() synchron, bevor es selbst zum ersten Mal wartet
         (node:sqlite/DatabaseSync ist "genuinely synchronous", siehe
         Dateikopf des Pakets); zwischen diesem Aufruf hier und dem Start
         seines eigenen ersten await liegt kein einziges await, also auch
         keine Gelegenheit für eine neu hereinkommende Nachricht, sich
         dazwischenzuschieben. Ein "neuste" von NACH dem await wäre dagegen zu
         weit: die Modelllaufzeit auf dem Pi liegt im Bereich von Sekunden bis
         zu einer knappen Minute, in der mehrere neue Nachrichten hereinkommen
         können — jede davon läge dann für immer vor dem Wasserstand, ohne je
         geprüft worden zu sein, denn extractTasks() selbst gibt keine
         Grenze zurück, bis wohin es tatsächlich gelesen hat.
         Unverändert bestehen bleibt eine ANDERE, ältere Grenze: fetchMessages()
         deckelt auf 120 Zeilen und nimmt bei mehr als 120 neuen Nachrichten
         die JÜNGSTEN 120 — bei einem so großen Rückstand blieben die
         dazwischenliegenden älteren für immer ungeprüft, Rennen hin oder her.
         Das zu beheben bräuchte eine echte Rückgabe aus services/ai.ts, wie
         weit es tatsächlich gekommen ist — dort nicht mein Zugriff, deshalb
         hier nicht angefasst; siehe Bericht. */
      const neuste = database.get<{ id: string }>(
        'SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1', ev.channelId,
      )?.id;
      const gefunden = await ai.extractTasks({
        channelId: ev.channelId,
        language: session.language,
        sinceMessageId: seit,
      });

      /* Der Knopf legt nichts mehr an, er füllt den Eingang.
         Vorher entstanden die Aufgaben sofort auf dem Brett — wer drückte,
         fand hinterher fünf Karten, von denen zwei stimmten. Jetzt geht
         beides denselben Weg: was von Hand angestoßen wird und was der
         Hintergrundlauf findet, landet als Vorschlag und wartet auf ein Ja.
         Der Abdruck im Dienst sorgt dafür, dass ein Titel, den der
         Hintergrundlauf schon vorgeschlagen hat, hier als Dublette zählt
         statt zweimal im Eingang zu liegen. */
      const bericht = vorschlaege.kandidatenEintragen(
        ev.channelId,
        gefunden.map((g) => ({
          art: 'aufgabe' as const,
          titel: g.title,
          quelleMessageId: null,
          genanntUserId: g.assigneeId,
          faelligAm: g.dueAt,
          /* Von Hand angestoßen entstehen nur Aufgaben — Termine kennt
             dieser Weg nicht, deshalb kein Beginn. */
          beginntAm: null,
          dauerMinuten: 60,
        })),
      );
      for (const v of bericht.angelegt) {
        if (darfElementSehen(v.fuerUserId, v.channelId)) {
          sendToUser(v.fuerUserId, { t: 'vorschlag:neu', vorschlag: v });
          vorschlagPushMelden(v);
        }
      }

      // Erst nach dem Eintragen merken — bricht etwas ab, wird beim nächsten
      // Mal derselbe Abschnitt noch einmal gelesen statt übersprungen.
      if (neuste) settings.setSetting(marke, neuste, userId);

      send(session, {
        t: 'ai:extract-tasks', requestId: ev.requestId,
        tasks: gefunden,
        vorgeschlagen: bericht.angelegt.length,
        uebersprungen: bericht.dubletten + bericht.ohneAdressat,
      });
      return;
    }

    case 'ai:protocol': {
      if (!darf(session, 'ai.assistant')) return;
      if (!kanalZugang(session, ev.channelId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const kanal = store.getChannel(ev.channelId, userId);
      if (!kanal) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden.');
      if (!kiZugang(session)) return;
      send(session, {
        t: 'ai:protocol',
        protocol: await ai.protokoll({
          channelId: ev.channelId,
          channelName: kanal.name,
          language: session.language,
          sinceMessageId: ev.sinceMessageId ?? null,
        }),
      });
      return;
    }

    /* ── Kalender ─────────────────────────────────────────── */

    case 'event:list':
      send(session, { t: 'event:list', events: events.listEvents(ev.from, ev.to, userId) });
      return;

    case 'event:create': {
      if (!darf(session, 'event.create')) return;
      if (ev.channelId && !kanalZugang(session, ev.channelId)) return;
      const termin = events.createEvent({ ...ev, createdBy: userId });
      broadcastTermin(termin);
      return;
    }

    case 'event:update': {
      const termin = events.getEvent(ev.eventId);
      if (!termin) return fail(session, 'fehler.terminNichtGefunden', 'Termin nicht gefunden.');
      if (!terminSichtbar(session, termin)) return;
      if (termin.createdBy !== userId && !may(userId, 'event.manage')) {
        return fail(session, 'fehler.nurVerwaltungTermine', 'Fremde Termine darf nur die Verwaltung ändern.');
      }
      broadcastTermin(events.updateEvent(ev.eventId, ev.patch));
      return;
    }

    case 'event:respond': {
      /* Zusagen ohne den Termin sehen zu dürfen ginge sonst — und mit der
         Zusage stünde man in der Teilnehmerliste eines Termins, von dem man
         nichts wissen sollte. */
      const termin = events.getEvent(ev.eventId);
      if (!termin) return fail(session, 'fehler.terminNichtGefunden', 'Termin nicht gefunden.');
      if (!terminSichtbar(session, termin)) return;
      broadcastTermin(events.respond(ev.eventId, userId, ev.response));
      return;
    }

    case 'event:attendees': {
      const termin = events.getEvent(ev.eventId);
      if (!termin) return;
      if (!terminSichtbar(session, termin)) return;
      if (termin.createdBy !== userId && !may(userId, 'event.manage')) {
        return fail(session, 'fehler.nurEinladerTeilnehmende', 'Nur wer eingeladen hat, ändert die Teilnehmenden.');
      }
      broadcastTermin(events.setAttendees(ev.eventId, ev.add, ev.remove));
      return;
    }

    case 'event:delete': {
      const termin = events.getEvent(ev.eventId);
      if (!termin) return;
      if (!terminSichtbar(session, termin)) return;
      if (termin.createdBy !== userId && !may(userId, 'event.manage')) {
        return fail(session, 'fehler.nurVerwaltungTermineLoeschen', 'Fremde Termine darf nur die Verwaltung löschen.');
      }
      events.deleteEvent(ev.eventId);
      broadcast({ t: 'event:removed', eventId: ev.eventId }, empfaengerFuer(termin.channelId));
      return;
    }

    /* ── Ideenboard ───────────────────────────────────────── */

    case 'idea:list':
      send(session, { t: 'idea:list', ideas: ideas.listIdeas(userId) });
      return;

    case 'idea:create': {
      if (!darf(session, 'idea.create')) return;
      if (ev.channelId && !kanalZugang(session, ev.channelId)) return;
      broadcastIdee(ideas.createIdea({ ...ev, createdBy: userId }));
      return;
    }

    case 'idea:update': {
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      if (idee.createdBy !== userId && !may(userId, 'idea.manage')) {
        return fail(session, 'fehler.nurModerationIdeen', 'Fremde Ideen darf nur die Moderation ändern.');
      }
      // Anders als bei Aufgaben kennt das Protokoll den Kanalwechsel hier
      // ausdrücklich — er braucht denselben Zugang wie das Anlegen.
      if (ev.patch.channelId && !kanalZugang(session, ev.patch.channelId)) return;
      ideenUmzugMelden(idee.channelId, ideas.updateIdea(ev.ideaId, ev.patch, userId));
      return;
    }

    case 'idea:status': {
      if (!darf(session, 'idea.manage')) return;
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      broadcastIdee(ideas.setStatus(ev.ideaId, ev.status, userId, ev.decision));
      return;
    }

    case 'idea:vote': {
      if (!darf(session, 'idea.vote')) return;
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      ideas.vote(ev.ideaId, userId, ev.wert);
      // Die eigene Stimme steckt in der Antwort — jede Person bekommt daher
      // ihre eigene Sicht auf dieselbe Idee. broadcastIdee() macht genau das
      // und hält sich dabei an den Kreis des Kanals.
      broadcastIdee(ideas.getIdea(ev.ideaId, userId));
      return;
    }

    case 'idea:comments': {
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      send(session, { t: 'idea:comments', ideaId: ev.ideaId, comments: ideas.comments(ev.ideaId) });
      return;
    }

    case 'idea:comment': {
      if (!darf(session, 'message.send')) return;
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      const liste = ideas.addComment(ev.ideaId, userId, ev.text);
      broadcast({ t: 'idea:comments', ideaId: ev.ideaId, comments: liste }, empfaengerFuer(idee.channelId));
      broadcastIdee(ideas.getIdea(ev.ideaId, userId));
      return;
    }

    case 'idea:comment-delete': {
      /* Die Kennung der Idee kommt vom Client und muss nicht zum Kommentar
         gehören — geprüft wird deshalb die Idee, deren Kommentare gleich
         herausgehen. */
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
      if (!ideeSichtbar(session, idee)) return;
      ideas.deleteComment(ev.commentId, userId, may(userId, 'idea.manage'));
      broadcast({ t: 'idea:comments', ideaId: ev.ideaId, comments: ideas.comments(ev.ideaId) },
        empfaengerFuer(idee.channelId));
      return;
    }

    case 'idea:delete': {
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return;
      if (!ideeSichtbar(session, idee)) return;
      if (idee.createdBy !== userId && !may(userId, 'idea.manage')) {
        return fail(session, 'fehler.nurModerationIdeenLoeschen', 'Fremde Ideen darf nur die Moderation löschen.');
      }
      ideas.deleteIdea(ev.ideaId);
      broadcast({ t: 'idea:removed', ideaId: ev.ideaId }, empfaengerFuer(idee.channelId));
      return;
    }

    /* ── Dateiablage ──────────────────────────────────────── */

    case 'file:list':
      send(session, {
        t: 'file:list',
        // fuerUserId fehlte: ohne den Fragenden liefert dieser Weg gar keine
        // privaten Dateien — sicher, aber unvollständig, und die eigene Datei
        // im eigenen Verzeichnis nicht zu sehen ist kein Schutz, sondern ein Fehler.
        files: files.listFiles({ channelId: ev.channelId, folder: ev.folder, fuerUserId: userId }),
        usage: files.usage(),
      });
      return;

    case 'file:update': {
      const datei = files.getFile(ev.fileId);
      if (!datei) return fail(session, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden.');
      if (datei.uploadedBy !== userId && !may(userId, 'file.manage')) {
        return fail(session, 'fehler.nurVerwaltungDateien', 'Fremde Dateien darf nur die Verwaltung ändern.');
      }
      const geaendert = files.updateFile(ev.fileId, ev);
      /* Eine private Datei an alle zu rufen verrät ihre Existenz und ihren
         Namen — auch wenn der Client sie hinterher wegfiltert. Was niemanden
         angeht, wird gar nicht erst verschickt.

         `privat` allein reichte dafür nicht, und das war die halbe Miete für
         eine Lücke: privat heißt in dieser Tabelle ausschließlich „für ein
         einzelnes Konto verschlüsselt" (huelle.art === 'konto'). Eine Datei in
         einem privaten oder vertraulichen KANAL ist das nicht — ihr Name, ihre
         Beschreibung und ihre Kanalkennung gingen hier an jedes angemeldete
         Konto im Haus. Beim Anlegen (`POST /api/files` in http/routes.ts) ist
         genau das inzwischen zu; das Umbenennen stand noch offen und verriet
         damit dasselbe, nur eine Bearbeitung später. Für „Kündigung Meier.pdf"
         macht es keinen Unterschied, ob der Name beim Hochladen oder beim
         Umbenennen hinausgeht.

         Wer den Kreis zieht, steht in dateiKreis() weiter unten. */
      if (geaendert.privat) sendToUser(geaendert.uploadedBy, { t: 'file:upsert', file: geaendert });
      else broadcast({ t: 'file:upsert', file: geaendert }, dateiKreis(geaendert));
      return;
    }

    case 'file:delete': {
      const datei = files.getFile(ev.fileId);
      if (!datei) return;
      if (datei.uploadedBy !== userId && !may(userId, 'file.manage')) {
        return fail(session, 'fehler.nurVerwaltungDateienLoeschen', 'Fremde Dateien darf nur die Verwaltung löschen.');
      }
      /* Denselben Kreis wie beim Anlegen und beim Ändern, und aus demselben
         Grund. Hier ging bisher gar keine Prüfung mit — nicht einmal die auf
         `privat`, die das Umbenennen zwei Fälle weiter oben immerhin hatte.
         Es geht zwar nur eine Kennung hinaus und kein Name, aber die drei Wege
         müssen dieselbe Grenze ziehen: sonst ist es eine Frage der Zeit, bis
         jemand `file:removed` um ein Feld erweitert und mit ihm den Namen. Und
         ein Wegfall verrät für sich schon etwas — dass es die Datei gab und
         wann sie verschwand.

         Der Kreis wird vor dem Löschen bestimmt, obwohl er die Mitgliederliste
         des Kanals liest und nicht die Datei: was gleich nicht mehr existiert,
         soll auch nicht mehr befragt werden müssen. */
      const kreis = datei.privat ? [datei.uploadedBy] : dateiKreis(datei);
      files.deleteFile(ev.fileId);
      broadcast({ t: 'file:removed', fileId: ev.fileId }, kreis);
      return;
    }

    case 'voice:retranscribe': {
      /* Dieselbe Prüfung wie bei 'translate:request' und 'thread:open'. Sie
         fehlte hier als einziger Stelle, und das war nicht folgenlos: die
         Abschrift wird zum Nachrichtentext (siehe runTranscription), also
         ließ sich mit einer bekannten Kennung eine fremde Nachricht in einem
         Kanal umschreiben, den man nie gesehen hat. */
      if (!darfNachrichtLesen(userId, ev.messageId)) {
        return fail(session, 'fehler.keinNachrichtZugang', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const voice = voiceNoteFor(ev.messageId);
      if (!voice) return fail(session, 'fehler.keineAufnahme', 'Keine Aufnahme an dieser Nachricht');
      /* Ohne diese Prüfung erreichen zwei gleichzeitige Läufe für dieselbe
         Nachricht — etwa der automatische Anschluss an voice:send und ein
         dazwischengefunktes voice:retranscribe von einem zweiten Gerät — beide
         dieselbe UPDATE-Zeile in runTranscription(); wer zuletzt schreibt,
         gewinnt, ohne dass irgendwo eine Meldung entstünde. Die eigentliche
         Bremse steht in runTranscription() selbst (transkriptionLaeuft, siehe
         unten) — hier nur die Voraborientierung, damit die anfragende Person
         eine Antwort bekommt statt eines stillen Nichtstuns. */
      if (transkriptionLaeuft.has(ev.messageId)) {
        return fail(session, 'fehler.umschriftLaeuftSchon', 'Für diese Nachricht läuft schon eine Umschrift.');
      }
      void runTranscription(ev.messageId, voice.attachmentId).catch((err) => console.error('[ws] Umschrift:', (err as Error).message));
      return;
    }

    case 'ai:ask': {
      if (!darf(session, 'ai.assistant')) return;
      if (!kanalZugang(session, ev.channelId, ev.requestId)) return;
      if (klartextNoetig(session, ev.channelId)) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'fehler.kanalNichtGefunden', 'Kanal nicht gefunden', ev.requestId);
      if (!kiZugang(session, ev.requestId)) return;
      const result = await ai.askChannel({
        channelId: ev.channelId, question: ev.question, language: session.language,
        channelName: channels.channelLabel(ch, userId, (id) => store.getUser(id)?.displayName ?? 'Unbekannt'),
      });
      send(session, { t: 'ai:ask', requestId: ev.requestId, ...result });
      return;
    }

    /* ── Vertrauliche Kanäle ────────────────────────────────
       Der Server nimmt hier Verschlossenes entgegen und gibt Verschlossenes
       heraus. Was er prüft, ist ausschließlich, wer wem etwas geben darf —
       nie, was darin steht. */

    case 'vertraulich:schluessel-melden': {
      if (!ev.jwk || !ev.abdruck) return fail(session, 'fehler.schluesselUnvollstaendig', 'Der Schlüssel ist unvollständig.');
      if (ev.jwk.length > 4000) return fail(session, 'fehler.schluesselZuGross', 'Der Schlüssel ist zu groß.');
      const ergebnis = vertraulich.schluesselMelden({
        userId, jwk: ev.jwk, abdruck: ev.abdruck, sicherung: ev.sicherung ?? null,
      });
      send(session, { t: 'vertraulich:schluessel', schluessel: vertraulich.oeffentlicheSchluessel([userId]) });
      /* Ein neu hinterlegter Schlüssel heißt: in jedem vertraulichen Kanal
         dieser Person fehlt jetzt ein Paket. Ohne diesen Anstoß säße sie in
         ihren eigenen Kanälen vor lauter unlesbaren Nachrichten und wüsste
         nicht, warum. */
      if (ergebnis.neu || ergebnis.gewechselt) {
        for (const kanal of store.visibleChannels(userId)) {
          if (kanal.vertraulich) schluesselarbeitAnstossen(kanal.id);
        }
        /* Dieselbe Lage bei Notizen: jemand wurde zu einer Notiz hinzugefügt,
           bevor die eigene App je einen Schlüssel hinterlegt hatte — jetzt
           kann die besitzende Person nachverpacken (notiz:pakete-nachreichen). */
        for (const eintrag of notizen.fehlendeMitgliedschaften(userId)) {
          sendToUser(eintrag.ownerId, { t: 'notiz:pakete-fehlen', notizId: eintrag.notizId, userId });
        }
      }
      return;
    }

    case 'vertraulich:schluessel-holen': {
      /* Öffentliche Teile sind öffentlich — für alle Konten abrufbar, nicht
         nur für Kanalmitglieder. Sie sind zum Verteilen da, und wer sie
         einschränkte, verhinderte nur, dass man jemanden in einen
         vertraulichen Kanal aufnehmen kann, mit dem man noch keinen teilt. */
      send(session, { t: 'vertraulich:schluessel', schluessel: vertraulich.oeffentlicheSchluessel(ev.userIds) });
      return;
    }

    case 'vertraulich:sicherung-holen':
      send(session, { t: 'vertraulich:sicherung', paket: vertraulich.sicherungHolen(userId) });
      return;

    case 'vertraulich:einschalten': {
      if (!darf(session, 'vertraulich.kanal')) return;
      if (!store.isMember(ev.channelId, userId)) {
        return fail(session, 'fehler.nurMitgliederVertraulich', 'Nur Mitglieder können einen Kanal vertraulich stellen.');
      }
      const fassung = vertraulich.einschalten({ channelId: ev.channelId, userId, pakete: ev.pakete ?? [] });
      const kanal = store.getChannel(ev.channelId, userId)!;
      for (const uid of kanal.memberIds) {
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ev.channelId, uid)! });
      }
      /* Auch das ist eine Zugangsänderung und gehört sichtbar in den Kanal:
         ab hier lesen Übersetzung und KI nicht mehr mit, und wer ohne
         Schlüssel dasteht, soll den Grund im Verlauf finden. */
      zugangsMeldung(
        ev.channelId, userId,
        `@${store.getUser(userId)?.handle} hat diesen Kanal vertraulich gestellt — ab hier liest nur noch mit, wer den Schlüssel hat.`,
        'vertraulich.ein',
      );
      /* Sechste Sperre: was die KI aus diesem Kanal schon vorgeschlagen hat,
         verschwindet jetzt. Die Titel stammen aus Nachrichten, die ab hier
         niemand mehr im Klartext sehen soll — auch nicht rückwirkend. */
      for (const id of vorschlaege.idsImKanal(ev.channelId)) {
        for (const uid of kanal.memberIds) sendToUser(uid, { t: 'vorschlag:removed', vorschlagId: id });
      }
      vorschlaege.kanalGeschlossen(ev.channelId);
      schluesselarbeitAnstossen(ev.channelId);
      void fassung;
      return;
    }

    case 'vertraulich:pakete': {
      const anzahl = vertraulich.paketeNachreichen({
        channelId: ev.channelId, fassung: ev.fassung, vonUserId: userId, pakete: ev.pakete ?? [],
      });
      // Jedes versorgte Konto erfährt sofort davon, statt bis zum nächsten
      // Öffnen des Kanals vor unlesbaren Nachrichten zu sitzen.
      for (const eintrag of ev.pakete ?? []) {
        sendToUser(eintrag.userId, {
          t: 'vertraulich:paket', channelId: ev.channelId,
          fassung: vertraulich.aktuelleFassung(ev.channelId),
          pakete: vertraulich.paketeFuer(ev.channelId, eintrag.userId),
        });
      }
      void anzahl;
      return;
    }

    case 'vertraulich:wechseln': {
      const fassung = vertraulich.wechseln({
        channelId: ev.channelId, userId, pakete: ev.pakete ?? [],
      });
      for (const uid of store.memberIds(ev.channelId)) {
        sendToUser(uid, {
          t: 'vertraulich:paket', channelId: ev.channelId, fassung,
          pakete: vertraulich.paketeFuer(ev.channelId, uid),
        });
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ev.channelId, uid)! });
      }
      schluesselarbeitAnstossen(ev.channelId);
      return;
    }

    case 'vertraulich:paket-holen': {
      if (!store.isMember(ev.channelId, userId)) {
        return fail(session, 'fehler.keinKanalZugriff', 'Kein Zugriff auf diesen Kanal');
      }
      send(session, {
        t: 'vertraulich:paket', channelId: ev.channelId,
        fassung: vertraulich.aktuelleFassung(ev.channelId),
        pakete: vertraulich.paketeFuer(ev.channelId, userId),
      });
      return;
    }

    case 'vertraulich:vorfall-melden': {
      const freigabe = vertraulich.freigabeAnlegen({
        channelId: ev.channelId, melderId: userId, grund: ev.grund,
        codeAbdruck: ev.codeAbdruck, tage: ev.tage, pakete: ev.pakete ?? [],
      });
      /* Erst die Meldung im Kanal, dann die Bestätigung an die meldende Person.
         In dieser Reihenfolge, weil die Systemnachricht der eigentliche Zweck
         ist: schlüge sie fehl, soll niemand eine Freigabe in der Hand halten,
         von der der Kanal nichts weiß. */
      zugangsMeldung(
        ev.channelId, userId,
        `@${store.getUser(userId)?.handle} hat diesen Kanal für die Verwaltung geöffnet — Grund: ${freigabe.grund}`,
        'vertraulich.freigabe',
      );
      send(session, { t: 'vertraulich:freigabe', freigabe });
      for (const uid of new Set([...store.memberIds(ev.channelId), ...vertraulich.verwaltungIds()])) {
        if (uid === userId) continue;
        sendToUser(uid, { t: 'vertraulich:freigabe', freigabe });
      }
      return;
    }

    case 'vertraulich:freigaben':
      send(session, {
        t: 'vertraulich:freigaben', channelId: ev.channelId ?? null,
        freigaben: vertraulich.freigabenFuer(userId, ev.channelId ?? null),
      });
      return;

    case 'vertraulich:freigabe-oeffnen': {
      const schluessel = vertraulich.freigabeOeffnen({
        freigabeId: ev.freigabeId, userId, codeAbdruck: ev.codeAbdruck,
      });
      send(session, { t: 'vertraulich:freigabe-schluessel', schluessel });
      /* Auch das Öffnen gehört in den Kanal. Die Freigabe selbst war schon
         sichtbar; dass jemand sie tatsächlich benutzt hat, ist die zweite
         Hälfte derselben Auskunft. */
      zugangsMeldung(
        schluessel.channelId, userId,
        `@${store.getUser(userId)?.handle} hat die Freigabe eingelöst und liest diesen Kanal jetzt mit.`,
        'vertraulich.eingeloest',
      );
      return;
    }

    case 'vertraulich:freigabe-zuruecknehmen': {
      const freigabe = vertraulich.freigabeZuruecknehmen(ev.freigabeId, userId);
      zugangsMeldung(
        freigabe.channelId, userId,
        `@${store.getUser(userId)?.handle} hat die Freigabe für die Verwaltung zurückgenommen.`,
        'vertraulich.zurueckgenommen',
      );
      for (const uid of new Set([...store.memberIds(freigabe.channelId), ...vertraulich.verwaltungIds()])) {
        sendToUser(uid, { t: 'vertraulich:freigabe', freigabe });
      }
      return;
    }

    /* ── Notizen ──────────────────────────────────────────────
       Dieselbe Zurückhaltung wie bei den vertraulichen Kanälen oben: der
       Server nimmt nur entgegen, was schon verschlossen ist, und gibt nur
       heraus, wofür die anfragende Person auch ein Paket hat. Kein eigenes
       Recht dafür — jedes Konto darf eigene Notizen führen, genau wie
       Entwürfe oder Erinnerungen; geschützt wird über die Mitgliedschaft
       selbst (services/notizen.ts prüft das bei jedem Zugriff). */

    case 'notiz:list': {
      send(session, { t: 'notiz:list', notizen: notizen.listNotizen(userId) });
      /* Die Reihenfolge der drei Rutsche ist keine Laune.

         Zuerst die Lückenliste: die App muss WISSEN, für welche Notiz noch
         ein Kontopaket fehlt, bevor sie die erste entschlüsselt — sonst
         müsste sie hinterher raten oder für jede Notiz vorsichtshalber neu
         verpacken.

         Dann die Kontopakete: sie sind der Weg, der auf JEDEM Gerät
         desselben Kontos funktioniert, und sollen deshalb vor dem
         geräteeigenen ankommen.

         Zuletzt die Gerätepakete — der zweite, unabhängige Weg. Er bleibt
         vollständig erhalten; die App nimmt ihn, wo der Kontoweg (noch) nicht
         trägt. */
      send(session, { t: 'notiz:konto-fehlt', notizIds: notizen.notizenOhneKontoPaket(userId) });
      for (const p of notizen.kontoPaketeFuerAlle(userId)) {
        send(session, { t: 'notiz:konto-paket', notizId: p.notizId, fassung: p.fassung, paket: p.paket });
      }
      // Die eigenen Schlüsselpakete gleich hinterher — ein Rutsch für alle
      // statt einer Anfrage je Notiz, siehe paketeFuerAlle().
      for (const p of notizen.paketeFuerAlle(userId)) {
        send(session, { t: 'notiz:schluessel', notizId: p.notizId, fassung: p.fassung, paket: p.paket });
      }
      return;
    }

    case 'notiz:anlegen': {
      const notiz = notizen.anlegen({
        id: ev.id, ownerId: userId, chiffrat: ev.chiffrat, paket: ev.paket, kontoPaket: ev.kontoPaket,
      });
      send(session, { t: 'notiz:erstellt', requestId: ev.requestId, notiz });
      return;
    }

    case 'notiz:konto-paket-setzen': {
      notizen.kontoPaketSetzen({
        notizId: ev.notizId, userId, fassung: ev.fassung, paket: ev.paket,
      });
      /* Zurück an ALLE Sitzungen dieses Kontos, nicht nur an die absendende:
         genau darum geht es bei diesem Schlüssel. Ein zweites Gerät, das
         gerade offen daneben liegt, kann die Notiz damit sofort öffnen,
         statt bis zum nächsten notiz:list zu warten. */
      sendToUser(userId, { t: 'notiz:konto-paket', notizId: ev.notizId, fassung: ev.fassung, paket: ev.paket });
      return;
    }

    case 'notiz:speichern': {
      const ergebnis = notizen.speichern({
        notizId: ev.notizId, userId, chiffrat: ev.chiffrat, version: ev.version, force: ev.force,
      });
      if (ergebnis.ok) {
        for (const uid of notizen.empfaengerIds(ev.notizId)) {
          sendToUser(uid, { t: 'notiz:upsert', notiz: ergebnis.notiz, requestId: uid === userId ? ev.requestId : undefined });
        }
      } else {
        // Nur an die anfragende Person — die anderen wissen von diesem
        // Versuch nichts und sollen auch nichts davon zu sehen bekommen.
        send(session, { t: 'notiz:konflikt', requestId: ev.requestId, notizId: ev.notizId, aktuell: ergebnis.notiz });
      }
      return;
    }

    case 'notiz:loeschen': {
      const empfaenger = notizen.empfaengerIds(ev.notizId);
      notizen.loeschen(ev.notizId, userId);
      for (const uid of empfaenger) sendToUser(uid, { t: 'notiz:entfernt', notizId: ev.notizId });
      return;
    }

    case 'notiz:mitglied-hinzufuegen': {
      const notiz = notizen.mitgliedHinzufuegen({
        notizId: ev.notizId, ownerId: userId, zielUserId: ev.userId, paket: ev.paket,
      });
      for (const uid of notizen.empfaengerIds(ev.notizId)) sendToUser(uid, { t: 'notiz:upsert', notiz });
      // Ohne dieses Paket säße die neu hinzugefügte Person vor einer Notiz,
      // die sie laut Mitgliederliste lesen darf, aber nicht aufschließen
      // kann — dasselbe Versehen, das vertraulich:einschalten oben mit
      // seinem Rundruf an alle kanal.memberIds gerade vermeidet.
      const paket = notizen.paketFuer(ev.notizId, ev.userId);
      if (paket) sendToUser(ev.userId, { t: 'notiz:schluessel', notizId: ev.notizId, ...paket });
      return;
    }

    case 'notiz:mitglied-entfernen': {
      // Vor dem Entfernen gemerkt: danach zählt die entfernte Person nicht
      // mehr zu empfaengerIds(), bekäme die Nachricht „entfernt" also nie.
      const bisherige = notizen.empfaengerIds(ev.notizId);
      const notiz = notizen.mitgliedEntfernen({
        notizId: ev.notizId, ownerId: userId, zielUserId: ev.userId,
        neueFassung: ev.neueFassung, chiffrat: ev.chiffrat, version: ev.version, pakete: ev.pakete ?? [],
      });
      for (const uid of bisherige) {
        if (uid === ev.userId) { sendToUser(uid, { t: 'notiz:entfernt', notizId: ev.notizId }); continue; }
        sendToUser(uid, { t: 'notiz:upsert', notiz, requestId: uid === userId ? ev.requestId : undefined });
        // Dieselbe Begründung wie oben bei mitglied-hinzufuegen: die neue
        // Fassung nützt nichts, wenn niemand außer der besitzenden Person
        // (die sie selbst gerade errechnet hat) ihr Paket dafür bekommt.
        if (uid !== userId) {
          const paket = notizen.paketFuer(ev.notizId, uid);
          if (paket) sendToUser(uid, { t: 'notiz:schluessel', notizId: ev.notizId, ...paket });
        }
      }
      return;
    }

    case 'notiz:pakete-nachreichen': {
      notizen.paketeNachreichen({
        notizId: ev.notizId, ownerId: userId, zielUserId: ev.userId, paket: ev.paket,
      });
      const paket = notizen.paketFuer(ev.notizId, ev.userId);
      if (paket) sendToUser(ev.userId, { t: 'notiz:schluessel', notizId: ev.notizId, ...paket });
      return;
    }
  }
}


/* ── Helfer für die neuen Funktionen ──────────────────────────── */

// Dieselben drei Titel, die state/vorschlaege.ts im Frontend für denselben
// Rundruf zeigt (toast.vorschlagNeu{Aufgabe,Idee,Termin}).
const VORSCHLAG_TITEL: Record<Vorschlag['art'], push.PushTextfeld> = {
  aufgabe: { text: 'Neue Aufgabe vorgeschlagen', code: 'toast.vorschlagNeuAufgabe' },
  termin: { text: 'Neuer Termin vorgeschlagen', code: 'toast.vorschlagNeuTermin' },
  idee: { text: 'Neue Idee vorgeschlagen', code: 'toast.vorschlagNeuIdee' },
};

/** Push für einen frischen KI-Vorschlag — sowohl vom Hintergrundlauf als auch von Hand angestoßene. */
function vorschlagPushMelden(v: Vorschlag): void {
  if (!push.sollBenachrichtigen(v.fuerUserId, { channelId: v.channelId, dringend: true })) return;
  void push.sendenAn(v.fuerUserId, {
    titel: VORSCHLAG_TITEL[v.art], text: { text: v.titel }, kanalId: v.channelId, gruppe: `vorschlag:${v.id}`,
  });
}

/**
 * Push für eine Meldung der Postfach-Sichtung — der einzige Rest der alten
 * Chatnachricht, der als echte Zustellung übrig bleibt (siehe Dateikopf von
 * post-sichtung.ts). Der Reiter „Post-Sichtung" selbst liest live über
 * `GET /api/post/meldungen`, nicht über einen WebSocket-Kanal — wie
 * PostPanel.tsx daneben, aus demselben Grund: Postfach und Post-Sichtung
 * teilen sich `mail.lesen`, keinen eigenen Draht.
 *
 * `kanalId` bleibt aus: es gibt keinen Kanal, in den ein Klick auf die
 * Systembenachrichtigung führen könnte. Ohne `kanalId` öffnet ein Klick nur
 * die App (siehe electron/mac-notify.ts) — von dort führt der Reiter
 * „Post-Sichtung" weiter, genau wie ein Vorschlag-Push in den Kanal führt,
 * nicht direkt in den Eingang.
 *
 * Titel je Zustand — der Text (`${m.von} — ${m.betreff}`) bleibt in jedem
 * Fall unübersetzt, das ist der tatsächliche Inhalt der Mail, kein
 * Oberflächentext:
 *   · 'entwurf' — derselbe Satz, den PostMeldungen.tsx für dieselbe Zeile
 *     schon als Begründung zeigt (postSichtung.grund.entwurfWartet, siehe
 *     `t(\`postSichtung.grund.${m.grundCode}\`)` dort). Auflösung über
 *     push.ts/push-i18n.ts, siehe Dateikopf von services/push.ts.
 *   · sonst ("neue Post im Fach {fach}") — dafür gibt es in keinem der 22
 *     Wörterbücher einen passenden Schlüssel. 'post.neueNachricht' wäre die
 *     naheliegende Wiederverwendung, ist aber der Titel des Schreiben-Knopfs
 *     (PostSchreiben.tsx) und trägt z. B. auf Japanisch ausdrücklich die
 *     Compose-Bedeutung ("新規メール", wörtlich "neu zu erstellende Mail"),
 *     nicht die Eingangs-Bedeutung — als Titel für "dir ist Post zugegangen"
 *     wäre das irreführend. Bleibt darum unverändert deutsch, bis ein
 *     eigener Schlüssel in den 22 Wörterbüchern angelegt ist (außerhalb
 *     dieses Zuständigkeitsbereichs) — siehe scripts/push-woerterbuch-erzeugen.mjs,
 *     Abschnitt „Fehlt noch".
 */
function postMeldungPushMelden(userId: string, m: PostMeldung): void {
  if (!push.sollBenachrichtigen(userId, { dringend: true })) return;
  const titel: push.PushTextfeld = m.zustand === 'entwurf'
    ? { text: 'Antwortentwurf wartet auf Freigabe', code: 'postSichtung.grund.entwurfWartet' }
    : { text: `Neue Post im Fach ${m.fach}`, code: 'push.neuePostImFach', werte: { fach: m.fach } };
  void push.sendenAn(userId, {
    titel, text: { text: `${m.von} — ${m.betreff}` }, gruppe: `post-meldung:${m.mailId}`,
  });
}

// Eigenname je Anbieter — anders als bei VORSCHLAG_TITEL oben kein
// Übersetzungsschlüssel nötig: „Gumroad"/„Patreon" stehen in allen 22
// Wörterbüchern identisch (siehe verkaufMeldung.anbieter.* dort), reine
// Markennamen, kein UI-Text.
const VERKAUF_ANBIETER_NAME: Record<verkaufBenachrichtigung.VerkaufAnbieter, string> = {
  gumroad: 'Gumroad', patreon: 'Patreon',
};

/** Dieselbe Rundung wie lib/format.ts geld() im Frontend — dessen
 *  Intl-Zweig braucht `sprache()` (nur im Browser bekannt), hier genügt der
 *  reine Zahlen-Rückfall von dort: eine Zahl mit ISO-Kürzel ist in jeder
 *  Sprache verständlich, anders als deutscher Fließtext. */
function betragFormatiert(cent: number, waehrung: string): string {
  return `${(cent / 100).toFixed(2)} ${waehrung}`.trim();
}

/**
 * Push für einen oder mehrere neu erkannte Verkäufe — dieselben zwei Titel
 * (Einzeln/Sammel), die derselbe Toast im Frontend für dasselbe Ereignis
 * schon zeigt (state/verkaufMeldungen.ts, `abrufen()`:
 * verkaufMeldung.toastTitelEinzeln/toastTitelSammel/toastKoerperSammel).
 *
 * `ereignisseVerarbeiten()` in verkaufBenachrichtigung.ts bündelt bereits auf
 * höchstens einen Aufruf von `benachrichtigen()` je Anbieter je Sync-Lauf
 * (siehe dessen Dateikopf, „WARUM NICHT FLUTEN") — darum hier je Aufruf
 * genau EIN Push, nie einer je einzelner Meldung: alles andere würde die
 * Bündelung dort zunichtemachen und genau den Schwall auslösen, den sie
 * verhindern soll.
 *
 * `gruppe` bleibt je Anbieter stabil (nicht je Meldung, anders als bei
 * post-meldung/vorschlag oben): eine noch offene, nicht weggewischte
 * Sperrbildschirm-Meldung vom letzten Sync-Lauf wird von der nächsten
 * ersetzt statt sich davor zu stapeln — dieselbe Zurückhaltung wie beim
 * Fünfzehn-Minuten-Takt selbst, nur eine Ebene weiter oben.
 */
function verkaufPushMelden(
  userId: string, anbieter: verkaufBenachrichtigung.VerkaufAnbieter,
  meldungen: verkaufBenachrichtigung.VerkaufMeldung[],
): void {
  if (!meldungen.length) return;
  if (!push.sollBenachrichtigen(userId, { dringend: true })) return;
  const anbieterName = VERKAUF_ANBIETER_NAME[anbieter];
  const gruppe = `verkauf-meldung:${anbieter}`;

  if (meldungen.length === 1) {
    const name = meldungen[0].produktName ?? anbieterName;
    void push.sendenAn(userId, {
      titel: { text: `Neuer Verkauf: ${name}`, code: 'verkaufMeldung.toastTitelEinzeln', werte: { name } },
      // Echter Inhalt (Produktname) bzw. reiner Eigenname — kein UI-Text,
      // derselbe Grund, warum postMeldungPushMelden() oben `text` ohne
      // `code` lässt.
      text: { text: meldungen[0].produktName ?? anbieterName },
      gruppe,
    });
    return;
  }

  const anzahl = String(meldungen.length);
  // Dieselbe, bewusst nicht wasserdichte Wahl wie im Frontend-Vorbild:
  // die erste gefundene Währung der Serie, nicht zwingend die aller Zeilen.
  const waehrung = meldungen.find((m) => m.waehrung)?.waehrung;
  const gesamtCent = meldungen.reduce((summe, m) => summe + (m.betragCent ?? 0), 0);
  const text: push.PushTextfeld = waehrung
    ? {
        text: `Zusammen ${betragFormatiert(gesamtCent, waehrung)}`,
        code: 'verkaufMeldung.toastKoerperSammel',
        werte: { betrag: betragFormatiert(gesamtCent, waehrung) },
      }
    : { text: anbieterName };
  void push.sendenAn(userId, {
    titel: { text: `${anzahl} neue Verkäufe`, code: 'verkaufMeldung.toastTitelSammel', werte: { anzahl } },
    text,
    gruppe,
  });
}

/** Umfrage-Stand an alle im Kanal schicken — jede:r sieht die eigene Wahl. */
function broadcastPoll(pollId: string): void {
  const row = database.get<{ message_id: string }>('SELECT message_id FROM polls WHERE id = ?', pollId);
  if (!row) return;
  const msg = database.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', row.message_id);
  if (!msg) return;
  for (const uid of store.memberIds(msg.channel_id)) {
    const poll = polls.getPoll(pollId, uid);
    if (!poll) continue;
    sendToUser(uid, { t: 'poll:updated', poll, channelId: msg.channel_id });
    // Die Übersetzung kommt nach, sobald sie da ist — auf sie zu warten würde
    // das Ergebnis einer Abstimmung für alle anderen verzögern.
    void pollUebersetzungNachreichen(pollId, uid, msg.channel_id);
  }
}

/**
 * Name, Thema und Zweck eines Kanals in die Lesesprache bringen. Läuft im
 * Hintergrund; steht der Kanal schon in dieser Sprache, passiert nichts.
 */
async function kanalUebersetzungNachreichen(channelId: string, userId: string): Promise<void> {
  const sprache = store.getSelf(userId)?.language;
  if (!sprache) return;
  try {
    const sicht = await translateChannel(channelId, sprache);
    const kanal = store.getChannel(channelId, userId);
    if (kanal) sendToUser(userId, { t: 'channel:upsert', channel: { ...kanal, translation: sicht } });
  } catch (err) {
    console.error('[kanal]', (err as Error).message);
  }
}

/**
 * Frage und Antworten in die Lesesprache bringen und nachliefern.
 * Steht die Umfrage schon in dieser Sprache, passiert nichts.
 */
async function pollUebersetzungNachreichen(pollId: string, userId: string, channelId: string): Promise<void> {
  /* Dieselbe Grenze wie bei fillCachedTranslations(): eine verschlüsselte
     Umfrage zu übersetzen hieße, das Chiffrat an ein fremdes Modell zu
     schicken. Zurück käme Unsinn — hingegangen wäre es trotzdem. */
  if (vertraulich.istVertraulich(channelId)) return;
  const sprache = store.getSelf(userId)?.language;
  if (!sprache) return;
  try {
    const sicht = await translatePoll(pollId, sprache);
    const poll = polls.getPoll(pollId, userId);
    if (!poll) return;
    // Auch ohne Übersetzung senden: wer zurück in die Ausgangssprache wechselt,
    // säße sonst weiter vor der englischen Fassung.
    sendToUser(userId, { t: 'poll:updated', poll: { ...poll, translation: sicht }, channelId });
  } catch (err) {
    console.error('[umfrage]', (err as Error).message);
  }
}

/**
 * Link-Vorschauen nachreichen. Läuft bewusst nach der Zustellung —
 * eine langsame fremde Website darf den Chat nicht aufhalten.
 */
function enrichLinks(messageId: string, text: string, channelId: string): void {
  /* Aus einem Chiffrat holt extractUrls ohnehin nichts heraus. Die Prüfung
     steht hier ausdrücklich, damit niemand sie später wieder wegoptimiert:
     eine Vorschau bedeutet, dass der Server die Adresse abruft — und damit
     jemandem verrät, welche Seite in einem vertraulichen Gespräch verlinkt
     wurde. */
  if (istE2EChiffrat(text)) return;
  if (!extractUrls(text).length) return;
  void attachPreviews(messageId, text)
    .then((links) => {
      if (!links.length) return;
      broadcast({ t: 'links', messageId, links }, store.memberIds(channelId));
    })
    .catch((err) => console.warn('[links]', (err as Error).message));
}

/**
 * Läuft für eine Nachricht schon eine Transkription?
 *
 * Ohne diese Bremse erreichen zwei gleichzeitige Läufe für dieselbe
 * Nachricht — der automatische Anschluss an voice:send und ein
 * dazwischengefunktes voice:retranscribe, möglicherweise von einem zweiten
 * Gerät — beide dieselbe UPDATE-Zeile unten; wer zuletzt schreibt, gewinnt,
 * ohne dass irgendwo eine Fehlermeldung entstünde. `voice:retranscribe`
 * fragt zusätzlich schon VOR diesem Aufruf nach (siehe dort) — das ist nur
 * die schnellere Rückmeldung an die anfragende Person. Die eigentliche
 * Bremse steht hier, weil hier beide Aufrufer durchlaufen.
 */
const transkriptionLaeuft = new Set<string>();

/**
 * Aufnahme transkribieren und das Ergebnis zum Nachrichtentext machen.
 * Damit greifen Suche und Übersetzung genauso wie bei getippten Nachrichten:
 * eine japanische Sprachnachricht landet auf Deutsch im Fenster.
 */
async function runTranscription(messageId: string, attachmentId: string): Promise<void> {
  if (transkriptionLaeuft.has(messageId)) return;
  transkriptionLaeuft.add(messageId);
  try {
    const msg = store.getMessage(messageId);
    if (!msg || msg.deletedAt) return;
    /* In einem vertraulichen Kanal wird nicht transkribiert. Das Transkript
       würde zum Nachrichtentext — im Klartext, auf dem Server, für ein Gespräch,
       das ausdrücklich niemand außer den Beteiligten lesen soll. Die Aufnahme
       bleibt hörbar, sie bekommt nur keine Abschrift. */
    if (vertraulich.istVertraulich(msg.channelId)) return;

    try {
      const result = await transcribe(attachmentId);
      saveTranscript(attachmentId, result);

      /* Nur schreiben, wenn die Nachricht seit dem Start dieses Laufs weder
         gelöscht noch von Hand bearbeitet wurde. `msg.editedAt` ist die
         Fassung von VOR dem Warten auf transcribe() (Sekunden bis zu einer
         knappen Minute auf dem Pi) — die WHERE-Bedingung verlangt genau
         diesen Stand noch einmal, sonst ändert sie nichts. Ohne sie
         überschrieb die Abschrift blind eine Bearbeitung, die währenddessen
         ankam: editMessage() sperrt nur kind === 'poll', Sprachnachrichten
         sind änderbar, und das Zwei-Stunden-Fenster dafür reicht bei weitem
         über jede Transkriptionsdauer hinaus. Eine inzwischen gelöschte
         Nachricht trifft `deleted_at IS NULL` gar nicht erst — die Abschrift
         bleibt dann nur in voice_transcripts stehen (dort ohne Bezug zu
         einer noch sichtbaren Nachricht), aber sie wird nicht mehr in
         `messages` geschrieben, und nichts davon geht unten hinaus. */
      const geschrieben = database.run(
        'UPDATE messages SET text = ?, source_lang = ? WHERE id = ? AND deleted_at IS NULL AND COALESCE(edited_at, 0) = ?',
        verschluesseln(result.text), result.lang, messageId, msg.editedAt ?? 0,
      ).changes > 0;
      if (!geschrieben) return;
      reindexMessage(messageId);

      /* Frisch abgefragt, NICHT die Momentaufnahme von vor dem Warten auf
         transcribe(): sendToUser() prüft bei der Zustellung selbst keine
         Mitgliedschaft mehr nach, die Empfängerliste muss also hier so aktuell
         wie möglich sein. Wer den Kanal während der Transkription verlassen
         hat oder entfernt wurde, bekommt das Transkript damit nicht mehr
         zugestellt — mit der alten, vor dem await erfassten Liste hätte er es
         noch bekommen, obwohl er den Kanal (und das Chiffrat/den Klartext
         darin) gar nicht mehr sehen darf. Dieselbe Überlegung wie bei
         deliverMessage() und prefs:update() oben, hier nur ohne
         `openChannelId`: der Empfängerkreis selbst war die Momentaufnahme. */
      const audience = store.memberIds(msg.channelId);
      for (const uid of audience) {
        sendToUser(uid, { t: 'message:updated', message: store.getMessage(messageId, uid)! });
        // Das Feld `voice` kommt ab jetzt aus services/voice.ts::voiceNoteFor(),
        // die selbst prüft, dass die Nachricht nicht gelöscht ist (siehe dort)
        // — dieselbe Prüfung greift auch beim `voice`-Feld in hydrateMessages()
        // eine Zeile darüber, ohne dass hier ein zweiter Check nötig wäre.
        sendToUser(uid, { t: 'voice:transcript', messageId, voice: voiceNoteFor(messageId)! });
      }

      // Und jetzt wie jede andere Nachricht in die Sprachen der Empfänger bringen.
      const context = channelContext(msg.channelId);
      const langs = new Map<string, string[]>();
      for (const uid of audience) {
        if (uid === msg.userId) continue;
        const u = store.getUser(uid);
        if (!u?.autoTranslate) continue;
        const target = normalizeLang(u.language);
        if (target === (result.lang ?? 'unknown')) continue;
        langs.set(target, [...(langs.get(target) ?? []), uid]);
      }
      for (const [target, users] of langs) {
        void translateMessage(messageId, target, { force: true, context })
          .then((view) => {
            if (!view) return;
            for (const uid of users) sendToUser(uid, { t: 'translation', messageId, translation: messwerteFuerNutzer(view, uid) });
          })
          .catch(() => { /* Original bleibt sichtbar */ });
      }
    } catch (err) {
      console.warn('[voice]', (err as Error).message);
      // Dieselbe Frische wie oben — kein Empfängerkreis von vor dem Warten,
      // und nichts mehr zustellen, wenn die Nachricht inzwischen weg ist.
      const still = store.getMessage(messageId);
      if (!still || still.deletedAt) return;
      for (const uid of store.memberIds(still.channelId)) {
        sendToUser(uid, { t: 'voice:transcript', messageId, voice: voiceNoteFor(messageId)! });
      }
    }
  } finally {
    transkriptionLaeuft.delete(messageId);
  }
}

/**
 * Antwortet der Assistent auf diese Nachricht? Läuft nach der Zustellung,
 * damit die Nachricht der Person sofort im Kanal steht und nicht auf das
 * Modell wartet.
 */
function vielleichtAntworten(channelId: string, text: string, authorId: string): void {
  /* In vertraulichen Kanälen schweigt der Assistent. Er könnte gar nicht
     antworten — er läse Base64 — aber die Prüfung steht trotzdem hier und
     nicht erst im Modell: der Verlauf ginge sonst als Anfrage an einen fremden
     Dienst, bevor irgendwer merkt, dass nichts dabei herauskommt. */
  if (vertraulich.istVertraulich(channelId)) return;
  if (!ki.shouldAnswer(channelId, text, authorId)) return;

  const botId = ki.assistantUserId();
  if (!botId) return;
  const empfaenger = store.memberIds(channelId);
  const istDm = store.getChannel(channelId)?.kind === 'dm';

  // "Denkt nach"-Anzeige, damit niemand ins Leere schaut.
  broadcast({ t: 'ai:thinking', channelId, active: true }, empfaenger);

  void ki.generateReply(channelId, istDm ? 'privat' : 'team')
    .then((antwort) => {
      const msg = messages.createMessage({
        channelId, userId: botId, text: antwort,
        mayMention: false, mayMentionEveryone: false,
      });
      deliverMessage(msg);
      /* Was die Antwort gekostet hat. Nach dem Zustellen: die Nachricht ist
         das Wichtige, die Zahl daneben das Beiwerk. */
      const verbrauch = assistant()?.letzterVerbrauch();
      if (verbrauch) {
        broadcast({
          t: 'ai:verbrauch',
          channelId,
          eingabe: verbrauch.eingabe,
          ausgabe: verbrauch.ausgabe,
          modell: verbrauch.modell,
        }, empfaenger);
      }
    })
    .catch((err) => {
      /* err ist hier meist schon eine Abweisung — der freundliche Satz, den
         auch der Kanal gleich bekommt ("Die KI konnte das gerade nicht
         erledigen"). Der protokolliert sich damit selbst nur schön: wer das
         liest, weiß, DASS es scheiterte, nicht WORAN. Die Einordnung in
         fehler.ts loggt den echten Grund normalerweise schon an der Quelle —
         aber das ist die einzige Stelle, die das tut. Fällt dieser eine
         Log-Aufruf aus irgendeinem Grund aus (Prozess beendet sich mitten im
         Schreiben, o. Ä.), bleibt sonst nichts übrig, an dem sich der Ausfall
         nachher noch nachvollziehen ließe. Deshalb hier ein zweiter,
         unabhängiger Versuch: `cause` trägt den Fehler, aus dem die Abweisung
         gebaut wurde, und der steht hier zusätzlich — an einer zweiten
         Stelle, mit einem zweiten Log-Aufruf, der nicht von demselben
         Codepfad abhängt wie der erste. */
      const fehler = err as Error & { cause?: unknown };
      const ursache = fehler.cause;
      const ursacheText = ursache === undefined ? ''
        : ` — Ursache: ${ursache instanceof Error ? `${ursache.constructor.name}: ${ursache.message}` : String(ursache)}`;
      console.warn(`[ki] ${channelId}: ${fehler.message}${ursacheText}`);
      // Fehler gehören in den Chat, nicht nur ins Log — sonst wartet man endlos.
      const msg = messages.createMessage({
        channelId, userId: botId,
        text: `Ich konnte gerade nicht antworten: ${fehler.message}`,
        mayMention: false, mayMentionEveryone: false,
      });
      deliverMessage(msg);
    })
    .finally(() => {
      broadcast({ t: 'ai:thinking', channelId, active: false }, empfaenger);
    });
}

/**
 * Eine geänderte Idee geht an alle — mit der jeweils eigenen Stimme, denn
 * "myVote" unterscheidet sich je Person.
 */
/** Ein Termin geht an den Kreis seines Kanals — oder an alle, wenn er keinen hat. */
function broadcastTermin(termin: ReturnType<typeof events.getEvent>): void {
  if (!termin) return;
  broadcast({ t: 'event:upsert', event: termin }, empfaengerFuer(termin.channelId));
}

/** Abweisen, wenn der Termin an einem Kanal hängt, den man nicht sieht. */
function terminSichtbar(session: Session, termin: { channelId: string | null }): boolean {
  if (darfElementSehen(session.userId!, termin.channelId)) return true;
  fail(session, 'fehler.terminNichtGefunden', 'Termin nicht gefunden.');
  return false;
}

/** Dasselbe für Ideen. */
function ideeSichtbar(session: Session, idee: { channelId: string | null }): boolean {
  if (darfElementSehen(session.userId!, idee.channelId)) return true;
  fail(session, 'fehler.ideeNichtGefunden', 'Idee nicht gefunden.');
  return false;
}

/**
 * Eine Idee nach einem Umzug verteilen und bei denen aufräumen, die sie
 * verloren haben — dieselbe Überlegung wie bei umzugMelden() für Aufgaben.
 */
function ideenUmzugMelden(vorherKanal: string | null, idee: ReturnType<typeof ideas.getIdea>): void {
  if (!idee) return;
  for (const uid of verlorenGegangen(empfaengerFuer(vorherKanal), empfaengerFuer(idee.channelId))) {
    sendToUser(uid, { t: 'idea:removed', ideaId: idee.id });
  }
  broadcastIdee(idee);
}

function broadcastIdee(idee: ReturnType<typeof ideas.getIdea>): void {
  if (!idee) return;
  // Wie bei den Aufgaben: hängt sie an einem Kanal, geht sie nur an dessen Kreis.
  const kreis = empfaengerFuer(idee.channelId);
  for (const s of sessions.values()) {
    if (!s.userId) continue;
    if (kreis && !kreis.includes(s.userId)) continue;
    const eigene = ideas.getIdea(idee.id, s.userId);
    if (eigene) send(s, { t: 'idea:upsert', idea: eigene });
  }
}

/**
 * Wer eine Aufgabe sehen darf, entscheidet sich über den Kanal.
 *
 * Genau das stand hier schon als Kommentar — der Rundruf ging trotzdem an
 * jede offene Verbindung. Belegt: ein Nichtmitglied bekam „Kündigung …
 * vorbereiten" aus einem privaten Kanal zugestellt, und `task:list` gab sie
 * ihm ein zweites Mal. Seit die Aufgabenerkennung aus Nachrichten Titel
 * macht, ist das kein Schönheitsfehler mehr: der Kanal war vertraulich
 * gedacht, der Titel daraus lag im ganzen Haus.
 *
 * Ohne Kanal bleibt es wie bisher: eine Aufgabe, die niemandem gehört,
 * gehört allen.
 */
/** Abweisen, wenn die Aufgabe an einem Kanal hängt, den man nicht sieht. */
function aufgabeSichtbar(session: Session, task: Task): boolean {
  if (darfElementSehen(session.userId!, task.channelId)) return true;
  fail(session, 'fehler.aufgabeNichtGefunden', 'Aufgabe nicht gefunden.');
  return false;
}

/**
 * Der Vorschlag, den diese Person entscheiden darf — oder nichts.
 *
 * Zwei Fragen, die man nicht verwechseln darf. `nurEigener()` im Dienst prüft,
 * ob der Vorschlag ihr gehört; hier wird geprüft, ob sie den Kanal überhaupt
 * noch sehen darf. Adressat zu sein heißt nicht, dabei zu sein: wer aus einem
 * privaten Kanal entfernt wird, steht weiter unter `fuer_user_id`. Ohne diese
 * Prüfung könnte er den Vorschlag noch annehmen — und dessen Titel stammt aus
 * einer Nachricht, die er nicht mehr lesen darf.
 *
 * Dieselbe Regel wie bei Aufgaben, Terminen und Ideen, aus derselben
 * Funktion abgeleitet. Ein zweiter Empfängerkreis für Vorschläge wäre die
 * zweite Regel für dieselbe Frage.
 */
/**
 * Ein Fehler aus dem Vorschlagsdienst wird zur Kennung an die Oberfläche.
 *
 * `requestId` reist mit, damit der wartende Knopf die Absage zuordnen kann.
 * Ohne sie bliebe er drehen, bis die Frist zuschlägt — Antwort da, Kreisel an.
 */
function vorschlagFehler(session: Session, e: unknown, requestId?: string): void {
  if (e instanceof vorschlaege.VorschlagFehler) {
    fail(session, e.kennung, e.message, requestId);
    return;
  }
  throw e;
}

function vorschlagSichtbar(session: Session, vorschlagId: string, requestId?: string): Vorschlag | null {
  const v = vorschlaege.getVorschlag(vorschlagId);
  if (!v || !darfElementSehen(session.userId!, v.channelId)) {
    fail(session, 'fehler.vorschlagWeg', 'Diesen Vorschlag gibt es nicht mehr.', requestId);
    return null;
  }
  return v;
}

/**
 * Eine Aufgabe nach einer Änderung verteilen — und aufräumen, wenn sie den
 * Kanal gewechselt hat.
 *
 * Wer sie eben noch sah und jetzt nicht mehr, bekommt ein `task:removed`.
 * Ohne das bliebe sie auf seinem Brett stehen, bis er die Liste neu lädt —
 * also womöglich den ganzen Tag.
 */
function umzugMelden(vorher: Task, nachher: Task): void {
  const alterKreis = empfaengerFuer(vorher.channelId);
  const neuerKreis = empfaengerFuer(nachher.channelId);
  for (const uid of verlorenGegangen(alterKreis, neuerKreis)) {
    sendToUser(uid, { t: 'task:removed', taskId: nachher.id });
  }
  broadcast({ t: 'task:upsert', task: nachher }, neuerKreis);
}

function broadcastTask(task: Awaited<ReturnType<typeof tasks.getTask>>): void {
  if (!task) return;
  broadcast({ t: 'task:upsert', task }, empfaengerFuer(task.channelId));
}

/**
 * Push, wenn eine Aufgabe gerade neu an jemanden ging.
 *
 * Nicht bei jedem `task:upsert` — nur wenn sich der Adressat wirklich
 * geändert hat und es nicht die Person selbst war, die gerade zugeteilt hat
 * (wer sich selbst eine Aufgabe gibt, muss sich das nicht auch noch
 * zuschicken lassen).
 */
function taskZuteilungMelden(task: Task, vorherAssigneeId: string | null, vergebenVon: string): void {
  if (!task.assigneeId || task.assigneeId === vorherAssigneeId || task.assigneeId === vergebenVon) return;
  if (!push.sollBenachrichtigen(task.assigneeId, { channelId: task.channelId, dringend: true })) return;
  // Derselbe Text, den es in allen 22 Wörterbüchern schon gibt
  // (toast.taskAssigned) — bislang ohne eigenen Frontend-Toast dafür.
  void push.sendenAn(task.assigneeId, {
    titel: { text: 'Dir zugeteilt', code: 'toast.taskAssigned' },
    text: { text: task.title },
    kanalId: task.channelId, gruppe: `task:${task.id}`,
  });
}

/* ── Hintergrundaufgaben ──────────────────────────────────────── */

export function startBackgroundJobs(): () => void {
  // Geplante Nachrichten ausliefern
  const scheduler = setInterval(() => {
    try {
      for (const row of messages.dueScheduled(Date.now())) {
        try {
          /* Beim Planen wurde geprüft — aber zwischen Planen und Absenden kann
             der Kanal vertraulich geworden sein. Dann läge hier ein offener
             Text bereit, der gleich in einen Kanal ginge, in dem nur Chiffrat
             stehen darf. Verschlüsseln kann der Server ihn nicht, also geht er
             gar nicht erst hinaus; die geplante Nachricht verfällt, und wer sie
             geplant hat, erfährt warum. */
          if (vertraulich.istVertraulich(row.channel_id) && !istE2EChiffrat(row.text)) {
            messages.removeScheduled(row.id);
            sendToUser(row.user_id, { t: 'scheduled:removed', scheduledId: row.id });
            sendToUser(row.user_id, {
              t: 'error', code: 'fehler.vertraulichGeplant',
              message: 'Der Kanal ist inzwischen vertraulich — deine geplante Nachricht wurde nicht '
                + 'gesendet, weil sie noch unverschlüsselt war. Bitte schreibe sie neu.',
            });
            continue;
          }
          const msg = messages.createMessage({
            channelId: row.channel_id, userId: row.user_id, text: row.text, parentId: row.parent_id,
          });
          messages.removeScheduled(row.id);
          sendToUser(row.user_id, { t: 'scheduled:removed', scheduledId: row.id });
          deliverMessage(msg);
        } catch (err) {
          console.error('[scheduler]', (err as Error).message);
          messages.removeScheduled(row.id);
        }
      }
    } catch (err) {
      console.error('[scheduler]', (err as Error).message);
    }
  }, 5_000);

  // Fällige Erinnerungen zustellen
  const reminderTimer = setInterval(() => {
    try {
      /* Früher nur für Leute geholt, die gerade verbunden waren — und erst
         abgehakt, wenn es wirklich ankam. Wer abends „morgen um neun" setzte
         und um neun den Rechner noch zu hatte, bekam sie erst beim nächsten
         Öffnen zu sehen, manchmal Tage später und ohne Bezug mehr zum
         eigentlichen Anlass. Jetzt gehen ALLE fälligen Erinnerungen hier
         hinein — Push erreicht auch ein gesperrtes Telefon, und `sendToUser`
         ist von sich aus wirkungslos ohne offene Verbindung. Beides zusammen
         zählt als Zustellung, egal ob gerade jemand am Draht hängt. */
      for (const reminder of reminders.due(Date.now())) {
        try {
          const owner = ownerOfReminder(reminder.id);
          if (!owner) continue;
          /* Beim Anlegen wurde der Zugang geprüft (reminder:create) — aber
             zwischen Anlegen und Auslösen kann die Person aus dem Kanal
             entfernt worden und die Nachricht bearbeitet worden sein. Dann
             bekäme sie hier den neuen Text einer Nachricht, die sie nicht mehr
             lesen darf. Die Erinnerung selbst geht trotzdem hinaus, nur ohne
             Nachricht daran. */
          const message = reminder.messageId && darfNachrichtLesen(owner, reminder.messageId)
            ? store.getMessage(reminder.messageId, owner) : null;
          sendToUser(owner, { t: 'reminder:fire', reminder, message });
          if (push.sollBenachrichtigen(owner, { channelId: reminder.channelId, dringend: true })) {
            const vorschau = message?.translation?.text ?? message?.text ?? '';
            // Dieselben zwei Rückfälle, die state/store.ts für denselben Fall
            // (reminder:fire, zeigen()) schon verwendet — toast.reminderTitle
            // und toast.reminderLook. reminder.note/vorschau sind Inhalt
            // (eigener Notiztext bzw. Nachrichtenvorschau) und bleiben ohne
            // Code, also unübersetzt.
            void push.sendenAn(owner, {
              titel: reminder.note
                ? { text: reminder.note }
                : { text: 'Stellium — Erinnerung', code: 'toast.reminderTitle' },
              text: vorschau
                ? { text: vorschau }
                : { text: 'Du wolltest hier noch einmal hinschauen.', code: 'toast.reminderLook' },
              kanalId: reminder.channelId,
              gruppe: `reminder:${reminder.id}`,
            });
          }
          database.run('UPDATE reminders SET done = 1 WHERE id = ?', reminder.id);
        } catch (err) {
          // Eine kaputte Erinnerung darf die anderen dieses Durchgangs nicht
          // mitnehmen — vorher brach die Schleife beim ersten Wurf ab.
          console.error('[reminders]', reminder.id, (err as Error).message);
        }
      }
    } catch (err) {
      console.error('[reminders]', (err as Error).message);
    }
  }, 15_000);

  // Abgelaufene Status zurücksetzen ("bin gleich zurück" soll nicht ewig stehen)
  const statusTimer = setInterval(() => {
    try {
      const jetzt = Date.now();
      const expired = database.all<{ id: string }>(
        'SELECT id FROM users WHERE status_expires_at IS NOT NULL AND status_expires_at <= ?', jetzt,
      );
      for (const row of expired) {
        /*
         * Mit der Frist endet der Status selbst, nicht nur Zeichen und Text.
         * Vorher verschwand allein das Emoji, und „bitte nicht stören" stand
         * hinterher für immer da — rot, ohne Erklärung daneben. Was danach
         * gilt, entscheidet die Verbindung: wer noch dranhängt, ist online.
         */
        const zurueck: UserStatus = isOnline(row.id) ? 'online' : 'offline';
        database.run(
          "UPDATE users SET status = ?, status_emoji = NULL, status_text = NULL, status_expires_at = NULL WHERE id = ?",
          zurueck, row.id,
        );
        const u = store.getUser(row.id);
        if (u) {
          broadcast({
            t: 'presence', userId: row.id, status: u.status,
            statusEmoji: null, statusText: null, statusExpiresAt: null, lastSeenAt: u.lastSeenAt,
          });
        }
      }

      /*
       * Online-Zeit gutschreiben — 30 Sekunden je Durchgang für jeden, der
       * gerade online ist.
       *
       * Hier und nicht beim Statuswechsel, weil ein Wechsel auch ausbleiben
       * kann: ein abgestürzter Klient meldet sich nicht ab, und eine
       * abgerissene Leitung erst recht nicht. Wer zählt, was gerade IST,
       * braucht kein sauberes Ende.
       */
      try {
        const online: string[] = [];
        for (const uid of byUser.keys()) {
          if (store.getUser(uid)?.status === 'online') online.push(uid);
        }
        praesenz.gutschreiben(online, 30);
      } catch (err) {
        /* Die Zeitmessung darf den Statuslauf nicht anhalten — sie ist eine
           Beigabe, der Status ist die Aufgabe. */
        console.error('[praesenz]', (err as Error).message);
      }

      /*
       * Wer verbunden ist, aber lange nichts getan hat, wandert auf abwesend.
       * Ohne das bleibt ein offener, vergessener Rechner für alle anderen
       * grün — die Verbindung steht ja, nur der Mensch davor nicht mehr.
       */
      const grenze = jetzt - LEERLAUF_MS;
      for (const uid of byUser.keys()) {
        if ((letzteAktion.get(uid) ?? jetzt) > grenze) continue;
        if (statusHaelt(uid)) continue;
        if (store.getUser(uid)?.status !== 'online') continue;
        setStatus(uid, 'away');
      }
    } catch (err) {
      console.error('[status]', (err as Error).message);
    }
  }, 30_000);

  // Hat das Aktualisierungsskript eine Auszeit hinterlegt? Dann einmal
  // ansagen — und einmal, wenn sie wieder verschwindet.
  let angesagt: string | null = null;
  const wartungsTimer = setInterval(() => {
    try {
      const w = wartung.anstehend();
      if (w && w.version !== angesagt) {
        angesagt = w.version;
        // Nicht broadcast(): jede Sitzung bekommt die Notizen in ihrer
        // eigenen Lesesprache statt alle denselben deutschen Wortlaut, siehe
        // wartungMelden().
        for (const s of sessions.values()) if (s.userId) wartungMelden(s, w);
      } else if (!w && angesagt) {
        angesagt = null;
        broadcast({ t: 'server:update-abgesagt' });
      }
    } catch (err) {
      console.error('[wartung]', (err as Error).message);
    }
  }, 5_000);

  // Termine, die in 15 Minuten beginnen, einmal ankündigen
  const gemeldet = new Set<string>();
  const terminTimer = setInterval(() => {
    try {
      for (const termin of events.startingSoon(15 * 60_000)) {
        if (gemeldet.has(termin.id)) continue;
        gemeldet.add(termin.id);
        for (const teil of termin.attendees) {
          if (teil.response === 'no') continue;
          sendToUser(teil.userId, {
            t: 'reminder:fire',
            reminder: {
              id: `ev_${termin.id}`, messageId: null, channelId: termin.channelId ?? '',
              note: termin.title, remindAt: termin.startsAt, done: false, createdAt: Date.now(),
            },
            message: null,
          });
        }
      }
      // Der Merker darf nicht unbegrenzt wachsen.
      if (gemeldet.size > 500) gemeldet.clear();
    } catch (err) {
      console.error('[termine]', (err as Error).message);
    }
  }, 60_000);

  /* Abgelaufene Freigaben entschärfen.
     Der Ablauf wird bei jedem Öffnen geprüft — aber solange die Pakete
     daliegen, hängt alles an dieser einen Prüfung. Ein Fehler dort, und eine
     Freigabe von vor zwei Jahren stünde wieder offen. Werden die Pakete
     gelöscht, ist der Ablauf keine Regel mehr, sondern ein Zustand. */
  const freigabenTimer = setInterval(() => {
    try {
      const weg = vertraulich.abgelaufeneAufraeumen();
      if (weg) console.log(`[vertraulich] ${weg} abgelaufene Freigaben entschärft.`);
    } catch (err) {
      console.error('[vertraulich]', (err as Error).message);
    }
  }, 10 * 60_000);

  /* Verwaiste Anhang-Platzhalter aufräumen (siehe PLATZHALTER_FRIST_MS und
     ausstehendeAnhaengeAufraeumen() weiter oben). Alle 5 Minuten reicht: bei
     einer 30-Minuten-Frist bleibt ein abgebrochener Platzhalter so höchstens
     rund 5 Minuten länger stehen als nötig, ohne dass diese Runde spürbar ins
     Gewicht fällt. */
  const anhaengeTimer = setInterval(() => {
    try {
      const weg = ausstehendeAnhaengeAufraeumen();
      if (weg) console.log(`[anhaenge] ${weg} verwaiste Platzhalter aufgeräumt.`);
    } catch (err) {
      console.error('[anhaenge]', (err as Error).message);
    }
  }, 5 * 60_000);

  // Tote Sockets aussortieren
  const heartbeat = setInterval(() => {
    for (const s of sessions.values()) {
      /* Auch terminate() gehört in den Schutz. Wirft es — und bei einem
         Socket, den das Betriebssystem schon weggeräumt hat, kann es das —,
         blieb der Rest dieses Durchgangs ungeprüft: die toten Verbindungen
         dahinter überlebten bis zum nächsten Wurf an derselben Stelle. */
      try {
        if (!s.alive) { s.socket.terminate(); continue; }
        s.alive = false;
        s.socket.ping();
      } catch { /* dann eben beim nächsten Mal */ }
    }
  }, 30_000);

  /* Neue Vorschläge gehen ungefragt an genau eine Person — den Adressaten.
     Der Dienst kennt das Gateway nicht; die Zustellung wird eingehängt,
     damit er ohne WebSocket prüfbar bleibt. Auch hier gilt der Kanalkreis:
     wer den Kanal nicht mehr sieht, bekommt nichts daraus. */
  vorschlaege.zustellerSetzen((userId, neue) => {
    for (const v of neue) {
      if (!darfElementSehen(userId, v.channelId)) continue;
      sendToUser(userId, { t: 'vorschlag:neu', vorschlag: v });
      // Genau der Fall, für den Push gedacht ist: die KI findet das im
      // Hintergrund, ohne dass irgendwer gerade hinschaut.
      vorschlagPushMelden(v);
    }
  });
  const stopVorschlaege = vorschlaege.startVorschlagJob();

  /* Patreons Zugriffstoken vor dem Ablauf erneuern — nicht erst, wenn ein
     Abruf mit 401 scheitert (siehe Dateikopf von services/patreon.ts). Dieselbe
     Form wie startVorschlagJob() oben: der Dienst kennt das Gateway nicht,
     hier wird nur angestoßen und beim Herunterfahren sauber angehalten. */
  const stopPatreon = patreon.startPatreonErneuerungJob();

  /* Den PayPal-Kontostand im Hintergrund aktuell halten — Salden öfter, den
     Bewegungsverlauf seltener (siehe startPaypalJob() in services/paypal.ts).
     Dieselbe Form wie startPatreonErneuerungJob() direkt darüber: eigener
     Dienst, eigener Takt, hier nur angestoßen und beim Herunterfahren
     angehalten. */
  const stopPaypal = paypal.startPaypalJob();

  /* Die Gruppe eines Briefpartners vorschlagen — Kunden, Firmen, Bewerber
     und so weiter. Dieselbe Form wie startVorschlagJob() oben: eigener
     Dienst, eigener Takt, hier nur angestoßen und beim Herunterfahren
     angehalten. Läuft unabhängig von der Postfach-Sichtung (postSichtung
     unten) — eigener Wasserstand über mail_nachrichten, eigener
     Modellaufruf, siehe services/post-partnergruppen.ts. */
  const stopPartnerGruppen = partnerGruppen.startPartnerGruppenJob();

  /* Aus gesendeter Post lernen — genauer: VORSCHLAEGE fuer das Gedaechtnis
     der Firmenpost machen, ueber die dann ein Mensch entscheidet
     (services/post-lernen.ts). Dieselbe Form wie die Laeufe darueber: eigener
     Dienst, eigener Takt, hier nur angestossen und beim Herunterfahren
     angehalten. Der Lauf liest ausschliesslich AUSGEHENDE Post — die Sperre
     dafuer steht als WHERE-Bedingung im Dienst, nicht hier. */
  const stopLernen = postLernen.startLernJob();

  /* Meldungen der Postfach-Sichtung — dieselbe Machart wie bei vorschlaege
     oben: der Dienst kennt das Gateway nicht; die Zustellung wird
     eingehängt, damit er sich in einem Prüflauf ohne WebSocket starten
     lässt. Anders als bei Vorschlägen entscheidet post-sichtung.ts selbst,
     WER die Meldung bekommt (Leitung/Administration mit `mail.lesen`, siehe
     dort) — hier wird nur noch zugestellt, nicht mehr gefiltert.
     Zugestellt heißt seit Fassung 1.0.31 nicht mehr „als Chatnachricht
     geschrieben", sondern „per Web-Push angestoßen" — der Reiter
     „Post-Sichtung" selbst holt sich seinen Stand über
     `GET /api/post/meldungen`, siehe postMeldungPushMelden() oben. */
  postSichtung.melderSetzen((userId, meldung) => postMeldungPushMelden(userId, meldung));

  /* Meldungen "ein Kauf ist passiert" — dieselbe Machart wie bei
     post-sichtung direkt darüber: verkaufBenachrichtigung.ts kennt das
     Gateway nicht, wer wen erfährt, entscheidet dessen eigene
     `empfaengerkreis()` (verkauf.sehen, siehe dort) — hier wird nur noch
     zugestellt, nicht mehr gefiltert. Zugestellt heißt wie bei
     postMeldungPushMelden() oben ausschließlich „per Web-Push angestoßen",
     kein zusätzlicher WebSocket-Weg: die Tafel im Frontend fragt ihren
     Bestand längst selbst über `GET /api/verkauf/meldungen` ab (siehe
     state/verkaufMeldungen.ts) und zeigt ihren eigenen In-App-Toast dabei —
     ein zweiter, hier erfundener Live-Kanal hätte auf der Gegenseite gar
     keinen Empfänger. */
  verkaufBenachrichtigung.melderSetzen((userId, anbieter, meldungen) => verkaufPushMelden(userId, anbieter, meldungen));

  /* Mails nachholen, deren Sichtung hängengeblieben oder fehlgeschlagen ist.
     Ohne diesen Lauf bliebe für immer ungesichtet, was eine ausgefallene KI
     beim ersten Versuch nicht geschafft hat — Menschen wurden zwar per
     Meldung benachrichtigt, aber die Einordnung fehlt weiter.
     `nachzusichten()` filtert selbst auf das Alter (dieselbe Frist, nach der
     `sichten()` einen zweiten Anlauf überhaupt erst erlaubt) — ein Takt, der
     öfter nachsieht, als etwas fällig wird, holt also einfach wiederholt
     eine leere Liste, nichts Teureres als das. Derselbe Takt wie beim
     Vorschläge-Lauf oben (TAKT_MS dort). */
  const nachsichtungTimer = setInterval(() => {
    try {
      for (const mailId of postSichtung.nachzusichten()) postSichtung.sichtungAnstossen(mailId);
    } catch (err) {
      console.error('[post-sichtung]', (err as Error).message);
    }
  }, 5 * 60_000);

  /* Aufbewahrungsfristen der Post durchsetzen — höchstens einmal am Tag: ein
     Durchlauf, der jedes Fach mit gesetzter Frist gegen die ganze Tabelle
     prüft, muss den Pi nicht öfter beschäftigen, als er etwas zu tun haben
     kann (eine Frist zählt in Tagen, nicht in Minuten). Anders als die
     übrigen Läufe hier oben feuert dieser einmal SOFORT beim Start und dann
     erst im Takt: ohne den Sofortlauf läge eine längst abgelaufene Frist nach
     jedem Neustart bis zu 24 Stunden unbemerkt liegen — bei einer Vorschrift,
     die sich ausdrücklich auf eine Frist beruft, ist das kein Rundungsfehler,
     sondern die Zusage selbst. */
  const fristenLauf = () => {
    try {
      const weg = post.fristenAnwenden();
      if (weg) console.log(`[post] ${weg} Mail(s) wegen abgelaufener Aufbewahrungsfrist endgültig gelöscht.`);
    } catch (err) {
      console.error('[post-fristen]', (err as Error).message);
    }
  };
  fristenLauf();
  const fristenTimer = setInterval(fristenLauf, 24 * 60 * 60_000);

  return () => {
    vorschlaege.zustellerSetzen(null);
    stopVorschlaege();
    stopPatreon();
    stopPaypal();
    stopPartnerGruppen();
    stopLernen();
    postSichtung.melderSetzen(null);
    verkaufBenachrichtigung.melderSetzen(null);
    clearInterval(nachsichtungTimer);
    clearInterval(scheduler);
    clearInterval(reminderTimer);
    clearInterval(statusTimer);
    clearInterval(terminTimer);
    clearInterval(wartungsTimer);
    clearInterval(freigabenTimer);
    clearInterval(anhaengeTimer);
    clearInterval(heartbeat);
    clearInterval(fristenTimer);
  };
}

/** Zu wem gehört die Erinnerung? Die Liste liefert sie ohne Besitzer mit. */
function ownerOfReminder(reminderId: string): string {
  return database.get<{ user_id: string }>('SELECT user_id FROM reminders WHERE id = ?', reminderId)?.user_id ?? '';
}

/**
 * Beendet alle offenen Verbindungen eines Kontos.
 *
 * Wird ein Konto gelöscht oder gesperrt, hilft die Prüfung beim Anmelden
 * allein nicht: wer gerade verbunden ist, bleibt es — im schlimmsten Fall
 * einen Monat lang, bis das Token abläuft. Also aktiv hinauswerfen.
 */
export function sitzungenBeenden(userId: string, grund = 'Dieses Konto ist nicht mehr aktiv.'): void {
  for (const s of byUser.get(userId) ?? new Set<Session>()) {
    try {
      fail(s, 'fehler.kontoInaktiv', grund);
      s.socket.close();
    } catch { /* schon zu — dann ist nichts zu tun */ }
  }
}

export function onlineUserIds(): string[] {
  return [...byUser.keys()];
}

/** Wie viele Verbindungen gerade offen sind — und wie viele Menschen dahinter. */
export function verbindungen(): { clients: number; benutzer: number } {
  return { clients: sessions.size, benutzer: byUser.size };
}

/**
 * Beim Start aufräumen: niemand kann verbunden sein, bevor es einen Server gibt.
 *
 * Ohne das bleibt der Stand vom letzten Mal stehen — nach einem Absturz oder
 * einem Update stünden Leute tagelang als "online" da, die längst weg sind.
 */
export function anwesenheitZuruecksetzen(): void {
  const betroffen = database.run(
    "UPDATE users SET status = 'offline' WHERE status <> 'offline'",
  );
  void betroffen;
}
