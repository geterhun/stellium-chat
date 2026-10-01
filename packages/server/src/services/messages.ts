import fs from 'node:fs';
import {
  detectLanguage, extractMentions, istE2EChiffrat, mentionsEveryone, normalizeLang,
  withinDeleteWindow, withinEditWindow, type DeleteScope, type Message, type ReadReceipt,
} from '@stellium/shared';
import { db, placeholders, reindexMessage, removeFromIndex } from '../db/index.js';
import { newId, newIdMitZeit } from '../util/id.js';
import { abweisung } from '../util/abweisung.js';
import { dropMessageTranslations } from '../translation/index.js';
import { getMessage, getUserByHandle, hydrateMessages } from './store.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { huelleLesen } from '../crypto/dateien.js';
import * as ablage from './ablage.js';

export interface CreateMessageInput {
  channelId: string;
  userId: string;
  text: string;
  parentId?: string | null;
  attachmentIds?: string[];
  /**
   * Anhänge, die beim Senden noch nicht fertig waren — zählen mit, damit eine
   * Nachricht mit einem einzelnen, noch hochladenden Bild und ohne Text nicht
   * als "leer" abgewiesen wird. Gespeichert wird davon nichts; das Merken der
   * Platzhalter bis zum Eintreffen (oder Aufgeben) übernimmt ws/gateway.ts.
   */
  pendingAttachments?: { tempId: string; name: string; mime: string }[];
  sourceLang?: string | null;
  systemKind?: string | null;
  /** "text" | "voice" | "poll" */
  kind?: string;
  /** Herkunft bei Weiterleitungen: "<messageId>|<channelId>|<userId>" */
  forwardedFrom?: string | null;
  /** Darf die Person einzelne Personen erwähnen? Sonst wird nichts eingetragen. */
  mayMention?: boolean;
  /** Darf sie den ganzen Kanal erwähnen (@alle)? */
  mayMentionEveryone?: boolean;
}

/**
 * Anhänge in einem vertraulichen Kanal müssen verschlossen sein.
 *
 * Das ist die zweite Hälfte der Zusage, die für Nachrichtentexte längst
 * gehalten wird. Bis hierher nahm der Kanal Anhänge weiter offen entgegen:
 * der Text kam als `e1:…` an, das Bild darunter lag anhörbar und ansehbar auf
 * der Platte. Wer ein Foto in einen vertraulichen Kanal legte, bekam damit
 * eine Zusage, die für seinen Anhang nicht galt.
 *
 * Geprüft wird hier und nicht in der Ereignisleitung, weil hier die einzige
 * Tür ist: senden, weiterleiten, geplant absenden, Sprachnachricht — alles
 * geht durch createMessage(). Eine Prüfung weiter außen müsste an jeder dieser
 * Stellen noch einmal stehen, und die nächste neue käme ohne sie.
 *
 * Zwei Richtungen, eine Regel: die Hülle des Anhangs muss zu dem Kanal passen,
 * in dem er landet.
 *
 *   vertraulicher Kanal, offener Anhang    → abgewiesen (der eigentliche Fall)
 *   vertraulicher Kanal, fremde Hülle      → abgewiesen; lesen könnte ihn dort
 *                                            niemand, und liegen hätte ihn ein
 *                                            Kreis, der nie gemeint war
 *   offener Kanal, verschlossener Anhang   → abgewiesen; eine private Datei aus
 *                                            der Ablage gehört nicht als
 *                                            unöffenbarer Klumpen in einen Chat
 */
function anhaengePruefen(channelId: string, attachmentIds: string[] | undefined): void {
  if (!attachmentIds?.length) return;
  const vertraulich = Boolean(db.get<{ vertraulich: number }>(
    'SELECT vertraulich FROM channels WHERE id = ?', channelId,
  )?.vertraulich);

  for (const attId of attachmentIds) {
    const zeile = db.get<{ huelle: string | null }>(
      'SELECT huelle FROM attachments WHERE id = ?', attId,
    );
    if (!zeile) continue;                     // gibt es nicht — fällt unten ohnehin weg
    const huelle = huelleLesen(zeile.huelle);

    if (!vertraulich) {
      if (huelle) {
        throw abweisung(
          'fehler.anhangFalscherKanal',
          'Ein verschlüsselter Anhang gehört in den Kanal, für den er verschlüsselt wurde.',
        );
      }
      continue;
    }
    if (!huelle) {
      throw abweisung(
        'fehler.anhangVerschluesselungNoetig',
        'Dieser Kanal ist vertraulich — ein Anhang muss verschlüsselt ankommen. '
        + 'Diese App kann das noch nicht; bitte aktualisieren.',
      );
    }
    if (huelle.art !== 'kanal' || huelle.channelId !== channelId) {
      throw abweisung('fehler.anhangFalscherKreis', 'Dieser Anhang wurde für einen anderen Kreis verschlüsselt.');
    }
  }
}

/**
 * Höchstzahl an Platzhaltern für noch hochladende Anhänge, in einer einzigen
 * Nachricht.
 *
 * Ohne diese Grenze reichte `pendingAttachments.length` allein, um die
 * "Nachricht ist nicht leer"-Prüfung oben zu erfüllen — eine angemeldete
 * Person könnte damit ein `message:send` mit zehntausenden Platzhaltern in
 * einer einzigen Nachricht schicken (der WebSocket erlaubt bis zu 4 MB pro
 * Nachricht, siehe maxPayload in index.ts) und alle blieben unbegrenzt in
 * `ausstehendeAnhaenge` (ws/gateway.ts) hängen, an jede Person im Kanal
 * gesendet — auf einem Pi ein billiger Weg, den Speicher zu füllen. Der
 * echte Client (Composer.tsx) kennt heute keine eigene Obergrenze — wer
 * tatsächlich mehrere Dateien auf einmal zieht, tut das in der Praxis nie in
 * dreistelliger Zahl. 30 liegt spürbar über jedem plausiblen Gebrauch (ein
 * ganzer Ordner Urlaubsfotos passt locker darunter) und weit unter dem, was
 * eine einzelne Nachricht an Speicher kosten darf.
 */
const PENDING_ANHAENGE_MAX = 30;

/**
 * Höchstlänge des Dateinamens eines Platzhalter-Anhangs.
 *
 * 255 Zeichen ist die klassische Namensobergrenze gängiger Dateisysteme
 * (NTFS, APFS, ext4) — kein echter Dateiauswahldialog liefert je einen
 * längeren Namen. Ohne diese Prüfung könnte derselbe unbegrenzte
 * `pendingAttachments`-Eintrag zusätzlich beliebig lange Namen tragen, die
 * bei jedem `message:updated`-Rundruf an alle Mitglieder mitgeschickt
 * würden.
 */
const PENDING_ANHANG_NAME_MAX = 255;

export function createMessage(input: CreateMessageInput): Message {
  const text = input.text.trim();
  if (!text && !(input.attachmentIds?.length) && !(input.pendingAttachments?.length)) {
    throw abweisung('fehler.nachrichtLeer', 'Leere Nachricht');
  }

  /* Ende-zu-Ende verschlüsselte Nachrichten sind länger als ihr Klartext:
     Base64 kostet ein Drittel, dazu Zähler und Prüfsumme. Dieselbe Grenze für
     beide hieße, dass in einem vertraulichen Kanal weniger Text passt als in
     einem gewöhnlichen — ausgerechnet dort, wo man es nicht erklären kann. */
  const verschlossen = istE2EChiffrat(text);
  const grenze = verschlossen ? 20_000 : 12_000;
  if (text.length > grenze) {
    /* Die beiden Zweige waren vertauscht: in einem vertraulichen Kanal wurde
       bei 20.000 Zeichen abgewiesen und dazu „max. 12.000" gemeldet. Wer die
       Nachricht kürzte, kürzte auf einen Wert, der gar nicht galt. */
    throw abweisung('fehler.nachrichtZuLang', `Nachricht zu lang (max. ${grenze / 1000}.000 Zeichen)`, { max: String(grenze / 1000) });
  }

  /* Siehe PENDING_ANHAENGE_MAX / PENDING_ANHANG_NAME_MAX oben: Anzahl und
     Namenslänge sind die beiden Stellen, an denen `pendingAttachments`
     bislang unbegrenzt war. Vor dem Anlegen geprüft, aus demselben Grund wie
     bei anhaengePruefen() gleich danach — eine abgewiesene Nachricht soll gar
     nicht erst entstehen. */
  if (input.pendingAttachments && input.pendingAttachments.length > PENDING_ANHAENGE_MAX) {
    throw abweisung(
      'fehler.anhangPlatzhalterObergrenze',
      `Eine Nachricht kann höchstens ${PENDING_ANHAENGE_MAX} gleichzeitig hochladende Anhänge tragen.`,
      { max: String(PENDING_ANHAENGE_MAX) },
    );
  }
  for (const p of input.pendingAttachments ?? []) {
    if (p.name.length > PENDING_ANHANG_NAME_MAX) {
      throw abweisung(
        'fehler.anhangNameZuLang',
        `Ein Dateiname ist zu lang (höchstens ${PENDING_ANHANG_NAME_MAX} Zeichen).`,
        { max: String(PENDING_ANHANG_NAME_MAX) },
      );
    }
  }

  /* Vor dem Anlegen und nicht mittendrin: eine abgewiesene Nachricht soll gar
     nicht erst entstehen, statt zurückgerollt zu werden. */
  anhaengePruefen(input.channelId, input.attachmentIds);

  /* id UND at aus DERSELBEN Vergabe (newIdMitZeit(), util/id.ts) — nicht id
     hier und `at = Date.now()` daneben: channelHistory() (store.ts)
     vergleicht `id < before` und `ORDER BY created_at DESC` in derselben
     Abfrage, ein zweiter, unabhängiger Zeitstempel könnte in den Sekunden
     nach einem Neustart mit hinterherhinkender Uhr von der geklemmten
     Wasserlinie abweichen, die schon in `id` steckt, und die Blätterei
     durcheinanderbringen. */
  const { id, zeit: at } = newIdMitZeit('m_');
  /* Bei unsicherer Erkennung lieber nichts eintragen: das Übersetzungsmodell
     erkennt die Sprache zuverlässiger und das Ergebnis wird zurückgeschrieben.

     Bei einem Chiffrat wird gar nicht erst geraten. Die Erkennung liefe über
     Base64-Zeichen und käme mit einiger Sicherheit zu einem Ergebnis — einem
     falschen, das dann als Ausgangssprache in der Datenbank stünde und die
     Nachricht in Statistiken und Filtern einer Sprache zuschlüge, mit der sie
     nichts zu tun hat. */
  const erkannt = verschlossen
    ? { lang: 'unknown', confidence: 0 }
    : input.sourceLang ? { lang: normalizeLang(input.sourceLang), confidence: 1 } : detectLanguage(text);
  const sourceLang = erkannt.lang === 'unknown' || erkannt.confidence < 0.35 ? null : erkannt.lang;

  db.transaction(() => {
    // Die Wurzel muss im selben Kanal liegen. Sonst ließe sich eine Antwort in
    // einen Thread schieben, zu dem die schreibende Person keinen Zugang hat:
    // store.threadHistory() wählt allein über parent_id aus und liefert sie
    // dort mit aus, während sie im eigenen Kanal gar nicht erst auftaucht.
    // Die Prüfung steht vor dem INSERT, damit die Zugangsentscheidung nicht am
    // Rückabwicklungspfad hängt.
    if (input.parentId) {
      const parent = db.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', input.parentId);
      if (!parent) throw abweisung('fehler.threadWurzelFehlt', 'Thread-Wurzel nicht gefunden');
      if (parent.channel_id !== input.channelId) throw abweisung('fehler.threadWurzelFalscherKanal', 'Thread-Wurzel gehört zu einem anderen Kanal');
    }

    db.run(
      `INSERT INTO messages (id, channel_id, user_id, parent_id, text, source_lang, system_kind, pinned, kind, forwarded_from, created_at)
       VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
      id, input.channelId, input.userId, input.parentId ?? null, verschluesseln(text), sourceLang,
      input.systemKind ?? null, input.kind ?? 'text', input.forwardedFrom ?? null, at,
    );

    /* Erwähnungen nur eintragen, wenn das Recht dafür da ist. Ohne Eintrag
       gibt es keine Benachrichtigung und keine Hervorhebung.

       Aus einem Chiffrat kommt hier nichts heraus — das ist kein Mangel,
       sondern die Folge: wer erwähnt wurde, weiß nur, wer entschlüsseln kann.
       Die App der empfangenden Person erkennt die Erwähnung im Klartext und
       hebt sie hervor; der Server zählt sie nicht mit. */
    if (input.mayMention !== false && !verschlossen) {
      for (const handle of extractMentions(text)) {
        const user = getUserByHandle(handle);
        if (user) db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', id, user.id);
      }
    }

    // @alle betrifft jede Person im Kanal außer der schreibenden.
    if (input.mayMentionEveryone && !verschlossen && mentionsEveryone(text)) {
      const mitglieder = db.all<{ user_id: string }>(
        'SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id <> ?',
        input.channelId, input.userId,
      );
      for (const m of mitglieder) {
        db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', id, m.user_id);
      }
    }

    /* Nur eigene Anhänge — dieselbe Regel wie in attachUpload(). Ohne die
       Bedingung genügte eine fremde, noch freie Anhangskennung, um die Datei
       einer anderen Person an die eigene Nachricht zu hängen; /files/:id gibt
       sie dann jedem Mitglied heraus, obwohl sie vorher nur ihrer Urheberin
       zugänglich war. */
    for (const attId of input.attachmentIds ?? []) {
      db.run('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL AND uploader_id = ?',
        id, attId, input.userId);
    }
  });

  reindexMessage(id);
  return getMessage(id, input.userId)!;
}

/**
 * Einen Anhang, der erst nach dem Senden fertig hochgeladen ist, an die schon
 * verschickte Nachricht hängen.
 *
 * Nur die sendende Person darf das, und nur für eine Nachricht, die es aus
 * ihrer Sicht noch gibt — sonst hinge ein Anhang plötzlich an einer fremden
 * Nachricht oder an einer, die gerade gelöscht wurde. Dieselbe Prüfung wie
 * beim Senden selbst (`anhaengePruefen`) gilt auch hier: ein vertraulicher
 * Kanal nimmt einen offenen Anhang so wenig nachträglich an wie beim ersten
 * Mal.
 *
 * Gibt `null` zurück, wenn nichts zu tun war — der Aufrufer (ws/gateway.ts)
 * entscheidet dann, ob der Anhang als verwaist weggeworfen gehört.
 */
export function attachUpload(messageId: string, userId: string, attachmentId: string): Message | null {
  const nachricht = db.get<{ user_id: string; channel_id: string; deleted_at: number | null }>(
    'SELECT user_id, channel_id, deleted_at FROM messages WHERE id = ?', messageId,
  );
  if (!nachricht || nachricht.deleted_at || nachricht.user_id !== userId) return null;

  const zeile = db.get<{ uploader_id: string; message_id: string | null }>(
    'SELECT uploader_id, message_id FROM attachments WHERE id = ?', attachmentId,
  );
  if (!zeile || zeile.uploader_id !== userId || zeile.message_id !== null) return null;

  anhaengePruefen(nachricht.channel_id, [attachmentId]);

  const geaendert = db.run(
    'UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL', messageId, attachmentId,
  );
  if (!geaendert.changes) return null;
  return getMessage(messageId, userId);
}

/**
 * Einen Anhang wegwerfen, der zu keiner Nachricht mehr passt.
 *
 * Zwei Wege führen hierher: die Nachricht wurde gelöscht, während der Upload
 * noch lief, oder der Aufruf gehört gar nicht der Person, die ihn hochgeladen
 * hat. Ohne dieses Aufräumen bliebe die Datei für immer als Zeile ohne
 * Nachricht liegen — `deleteMessage()` sieht sie nicht, denn sie hängt an
 * keiner Nachricht, an der sie über ON DELETE CASCADE mitgehen könnte.
 *
 * Still, wenn nichts zu tun ist: ein doppelter Aufruf (zum Beispiel nach
 * einer Wiederholung über die Warteschlange in net/socket.ts) soll nicht
 * scheitern, nur weil die erste Ausführung schon aufgeräumt hat.
 */
export function discardOrphanAttachment(attachmentId: string, userId: string): void {
  const zeile = db.get<{ path: string; uploader_id: string; message_id: string | null }>(
    'SELECT path, uploader_id, message_id FROM attachments WHERE id = ?', attachmentId,
  );
  if (!zeile || zeile.uploader_id !== userId || zeile.message_id !== null) return;
  ablage.loeschen(attachmentId, 'attachment');
  db.run('DELETE FROM attachments WHERE id = ?', attachmentId);
  fs.promises.rm(zeile.path, { force: true }).catch(() => {});
}

export function editMessage(messageId: string, userId: string, text: string, mayMention = true): Message {
  const row = db.get<{ user_id: string; deleted_at: number | null; created_at: number; kind: string }>(
    'SELECT user_id, deleted_at, created_at, kind FROM messages WHERE id = ?', messageId,
  );
  if (!row) throw abweisung('fehler.nachrichtNichtGefunden', 'Nachricht nicht gefunden');
  if (row.user_id !== userId) throw abweisung('fehler.nachrichtNichtEigen', 'Nur eigene Nachrichten lassen sich bearbeiten');
  if (row.deleted_at) throw abweisung('fehler.nachrichtGeloescht', 'Nachricht wurde gelöscht');
  if (row.kind === 'poll') throw abweisung('fehler.umfrageNichtBearbeitbar', 'Umfragen lassen sich nicht nachträglich ändern.');
  // Nach dem Zeitfenster ist die Nachricht Teil des Verlaufs, auf den sich
  // andere schon bezogen haben.
  if (!withinEditWindow(row.created_at)) {
    throw abweisung('fehler.nachrichtBearbeitenFrist', 'Bearbeiten geht nur in den ersten zwei Stunden nach dem Senden.');
  }

  const clean = text.trim();
  if (!clean) throw abweisung('fehler.nachrichtLeer', 'Leere Nachricht');

  const verschlossen = istE2EChiffrat(clean);
  const detected = verschlossen ? 'unknown' : detectLanguage(clean).lang;
  /* Text, Erwähnungen, Übersetzungen und Volltextindex gehören zusammen und
     lagen bisher zur Hälfte außerhalb der Transaktion. Bricht es dazwischen
     ab, steht der neue Text da, während die Übersetzung noch den alten
     wiedergibt und die Suche ihn noch unter den alten Wörtern führt — beides
     sieht aus wie ein Fehler des Modells und ist keiner. */
  db.transaction(() => {
    db.run(
      'UPDATE messages SET text = ?, source_lang = ?, edited_at = ? WHERE id = ?',
      verschluesseln(clean), detected === 'unknown' ? null : detected, Date.now(), messageId,
    );
    db.run('DELETE FROM message_mentions WHERE message_id = ?', messageId);
    if (mayMention && !verschlossen) {
      for (const handle of extractMentions(clean)) {
        const user = getUserByHandle(handle);
        if (user) db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', messageId, user.id);
      }
    }
    // Alte Übersetzungen passen nicht mehr zum neuen Text.
    dropMessageTranslations(messageId);
    reindexMessage(messageId);
  });
  return getMessage(messageId)!;
}

/**
 * Löschen in zwei Stufen.
 *
 *   "all"  nimmt die Nachricht für alle zurück. Erlaubt für eigene Nachrichten
 *          innerhalb des Zeitfensters, für Moderation jederzeit.
 *   "me"   blendet sie nur für die aufrufende Person aus. Immer möglich, auch
 *          bei fremden Nachrichten und nach Ablauf des Fensters.
 */
export function deleteMessage(
  messageId: string, userId: string, canDeleteAny: boolean, scope: DeleteScope = 'all',
): { channelId: string; scope: DeleteScope } {
  const row = db.get<{ user_id: string; channel_id: string; created_at: number }>(
    'SELECT user_id, channel_id, created_at FROM messages WHERE id = ?', messageId,
  );
  if (!row) throw abweisung('fehler.nachrichtNichtGefunden', 'Nachricht nicht gefunden');

  if (scope === 'me') {
    db.run('INSERT OR IGNORE INTO hidden_messages (user_id, message_id, created_at) VALUES (?,?,?)',
      userId, messageId, Date.now());
    return { channelId: row.channel_id, scope: 'me' };
  }

  const eigene = row.user_id === userId;
  if (!eigene && !canDeleteAny) throw abweisung('fehler.nachrichtLoeschenFremdrecht', 'Fremde Nachrichten darf nur die Moderation löschen.');
  if (eigene && !canDeleteAny && !withinDeleteWindow(row.created_at)) {
    throw abweisung('fehler.nachrichtLoeschenFrist', 'Für alle zurücknehmen geht nur in den ersten zwei Stunden. Du kannst sie noch für dich ausblenden.');
  }

  /* Anhangspfade vor dem Löschen lesen — dieselbe Reihenfolge wie in
     deleteChannel() (channels.ts): ist die Zeile erst weg, weiß niemand mehr,
     welche Datei zu ihr gehörte. */
  const pfade = db.all<{ path: string }>(
    'SELECT path FROM attachments WHERE message_id = ?', messageId,
  ).map((r) => r.path);

  /* Auch hier alles auf einmal: eine Nachricht, deren Text weg ist, die aber
     noch im Index steht, wäre über die Suche weiter auffindbar — und ihre
     gespeicherte Übersetzung gäbe den Inhalt wieder, den das Löschen gerade
     entfernt hat. dropMessageTranslations() nimmt dabei auch den
     Übersetzungsspeicher mit (translation_memory) — sonst überlebte Quelle
     und Übersetzung dort weiter, unter einem Schlüssel statt unter dem Namen
     der Nachricht, aber genauso lesbar.

     Das UPDATE unten bleibt ein SOFT delete (siehe Funktionskopf): die Zeile
     steht weiter, weil channelHistory() gelöschte Nachrichten ABSICHTLICH
     mitliefert, damit die Oberfläche einen Löschvermerk zeichnen kann statt
     einer Lücke (store.hydrateMessages() — dort bleibt `kind` aus demselben
     Grund stehen: „Sprachnachricht gelöscht“ statt nur „Nachricht gelöscht“).
     Weil die Zeile bleibt, feuert kein ON DELETE CASCADE: jede Tabelle mit
     einem Fremdschlüssel auf messages(id) behält ihre Zeilen einfach weiter.
     editMessage() (oben) räumt message_mentions deshalb schon bei jeder
     Bearbeitung ab — deleteMessage() tat das bisher NICHT, und mentionsFor()
     (store.ts) las die Tabelle ungeprüft: eine gelöschte Nachricht verriet
     über mentionUserIds weiter, wen sie erwähnt hatte. hydrateMessages()
     redigiert das Feld inzwischen in der Ausgabe (siehe dortiger Kommentar),
     aber die Zeile selbst blieb bis eben stehen — genau dieselbe Lücke wie
     bei translation_memory (siehe deleteChannel() in channels.ts), nur eine
     Tabelle weiter.

     Bei der Gelegenheit der Rest durchgegangen, der an einer Nachricht hängt:

       message_mentions  DELETE, s.o. — editMessage() macht es bei jeder
                          Bearbeitung schon richtig, deleteMessage() jetzt auch.
       polls              DELETE (poll_options/poll_votes/poll_participants
                          hängen an polls(id) mit ON DELETE CASCADE und gehen
                          mit). Frage, Antworten und wer wie abgestimmt hat
                          sind Inhalt der Nachricht wie ihr Text — und
                          getPoll() (services/polls.ts) liest eine Umfrage
                          über ihre eigene ID, ohne deleted_at der Nachricht
                          zu prüfen. Bliebe die Zeile stehen, wäre eine
                          gelöschte Umfrage über diesen Weg weiter lesbar.
       attachments        DELETE, samt Datei (ablage.verwaisteAufraeumen() +
                          ablage.dateienAufraeumen() unten, dasselbe Paar wie
                          in deleteChannel()). /files/:id (http/routes.ts)
                          prüft beim Ausliefern nur, ob die Nachricht noch
                          existiert und die anfragende Person Mitglied des
                          Kanals ist — nicht, ob sie gelöscht ist. Bliebe die
                          Zeile stehen, bliebe die Datei über die alte URL
                          abrufbar, obwohl der Chat sie nicht mehr zeigt.
       voice_transcripts  kein Extra — hängt an attachments(id) mit
                          ON DELETE CASCADE und geht mit den Anhängen mit.
       message_links      DELETE — dieselbe Randtabelle wie message_mentions,
                          nur für Links: hält fest, welche URL in DIESER
                          Nachricht stand.
       link_previews      KEEP — anders als message_links ein globaler,
                          über die URL adressierter Cache ohne Bezug zu einer
                          bestimmten Nachricht; dieselbe Rolle wie
                          translation_memory für Übersetzungen, und genauso
                          wenig zu räumen, nur weil EINE Nachricht mit dieser
                          URL verschwindet.
       reactions          KEEP — fremder Inhalt (wer reagiert hat), nicht der
                          Inhalt der gelöschten Nachricht; siehe die
                          Begründung in store.hydrateMessages(), der hier
                          nicht ohne triftigen Grund widersprochen wird.
       saved_messages,
       hidden_messages    KEEP — reine Zeiger ohne eigenen Inhalt.
                          savedMessages() filtert deleted_at IS NULL schon
                          selbst heraus, zeigt nach diesem Löschen also
                          ohnehin nichts mehr.
       reminders          KEEP — message_id ist dort nur ein Zeiger, `note`
                          eine frei getippte, eigene Notiz der erinnerten
                          Person, kein Auszug aus der Nachricht. Die
                          Erinnerung feuert später gegen die (dann
                          redigierte) Nachricht, statt sie eigenmächtig zu
                          verlieren — das wäre der schlechtere Fehler.
       pins               kein Extra — `messages.pinned` ist eine Spalte
                          dieser Zeile und steht im UPDATE unten schon auf 0.
       message_fts, message_translations/translation_memory
                          bereits erledigt — removeFromIndex() und
                          dropMessageTranslations() liefen hier schon vorher
                          richtig.
       scheduled_messages nicht betroffen — hat gar kein message_id, sondern
                          ist eine eigenständige, noch nicht verschickte Zeile. */
  db.transaction(() => {
    db.run("UPDATE messages SET deleted_at = ?, text = '', pinned = 0 WHERE id = ?", Date.now(), messageId);
    db.run('DELETE FROM message_mentions WHERE message_id = ?', messageId);
    db.run('DELETE FROM polls WHERE message_id = ?', messageId);
    db.run('DELETE FROM message_links WHERE message_id = ?', messageId);
    db.run('DELETE FROM attachments WHERE message_id = ?', messageId);
    dropMessageTranslations(messageId);
    removeFromIndex(messageId);
  });

  ablage.verwaisteAufraeumen();
  ablage.dateienAufraeumen(pfade);

  return { channelId: row.channel_id, scope: 'all' };
}

/** Für eine Person ausgeblendete Nachrichten. */
export function hiddenFor(userId: string, messageIds: string[]): Set<string> {
  if (!messageIds.length) return new Set();
  const rows = db.all<{ message_id: string }>(
    `SELECT message_id FROM hidden_messages WHERE user_id = ? AND message_id IN (${messageIds.map(() => '?').join(',')})`,
    userId, ...messageIds,
  );
  return new Set(rows.map((r) => r.message_id));
}

/**
 * Wie viele verschiedene Reaktionen an einer Nachricht hängen dürfen.
 *
 * Die Länge eines einzelnen Zeichens war begrenzt, ihre Anzahl nicht: eine
 * einzige Person konnte beliebig viele verschiedene daranhängen. Jede davon
 * geht danach mit jeder Auslieferung der Nachricht mit hinaus — der Verlauf
 * eines Kanals wächst also mit, ohne dass jemand etwas geschrieben hätte.
 * Fünfzig ist großzügig; auf einem Bildschirm sind zwölf schon viel.
 */
const REAKTIONSARTEN_MAX = 50;

export function toggleReaction(messageId: string, userId: string, emoji: string): { channelId: string } {
  const row = db.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', messageId);
  if (!row) throw abweisung('fehler.nachrichtNichtGefunden', 'Nachricht nicht gefunden');

  const clean = emoji.trim().slice(0, 32);
  if (!clean) throw abweisung('fehler.emojiFehlt', 'Emoji fehlt');

  const existing = db.get('SELECT 1 AS x FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, clean);
  if (!existing) {
    // Zurücknehmen geht immer; nur das Hinzufügen einer *neuen* Art ist begrenzt.
    const arten = db.get<{ n: number }>(
      'SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', messageId,
    )?.n ?? 0;
    if (arten >= REAKTIONSARTEN_MAX) {
      throw abweisung('fehler.reaktionenObergrenze', `An einer Nachricht sind höchstens ${REAKTIONSARTEN_MAX} verschiedene Reaktionen möglich.`, { max: String(REAKTIONSARTEN_MAX) });
    }
  }
  if (existing) {
    db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, clean);
  } else {
    db.run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)', messageId, userId, clean, Date.now());
  }
  return { channelId: row.channel_id };
}

export function setPinned(messageId: string, pinned: boolean): Message | null {
  db.run('UPDATE messages SET pinned = ? WHERE id = ?', pinned ? 1 : 0, messageId);
  return getMessage(messageId);
}

export function setSaved(messageId: string, userId: string, saved: boolean): void {
  if (saved) {
    db.run('INSERT OR IGNORE INTO saved_messages (user_id, message_id, created_at) VALUES (?,?,?)', userId, messageId, Date.now());
  } else {
    db.run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', userId, messageId);
  }
}

/**
 * Die Lesemarke einer Person in einem Kanal vorwärts schieben.
 *
 * Bewusst nur vorwärts (siehe WHERE-Klausel) und mit genau einem Zeitpunkt für
 * den ganzen Sprung: rückt die Marke von Nachricht 10 auf Nachricht 40, tragen
 * 11 bis 40 fortan denselben Zeitpunkt — den dieses Sprungs. Feinere Zeiten
 * gibt es nicht, und erfunden werden sie hier auch nicht; wer wissen will, ob
 * eine bestimmte Nachricht gelesen ist, vergleicht ihre Kennung mit
 * last_read_message_id (siehe readReceiptsBatch weiter unten).
 *
 * Gibt den neuen Zeitpunkt zurück, wenn die Marke wirklich weiterrückte, sonst
 * null — daran erkennt die Ereignisleitung, ob eine Rundmeldung an die
 * anderen Mitglieder überhaupt etwas Neues zu sagen hätte.
 */
export function markRead(channelId: string, userId: string, lastMessageId: string): number | null {
  const at = Date.now();
  const { changes } = db.run(
    `UPDATE channel_members SET last_read_message_id = ?, last_read_at = ?
     WHERE channel_id = ? AND user_id = ? AND (last_read_message_id IS NULL OR last_read_message_id < ?)`,
    lastMessageId, at, channelId, userId, lastMessageId,
  );
  return changes > 0 ? at : null;
}

/**
 * Wer eine Nachricht gelesen hat, und wann — für mehrere Nachrichten auf
 * einmal, damit ein offener Kanal mit vielen eigenen Beiträgen nicht eine
 * Anfrage pro Nachricht auslöst.
 *
 * „Gelesen" heißt: die Lesemarke der Person in channel_members hat die
 * Nachricht erreicht oder überschritten (lexikalischer Vergleich — Kennungen
 * sind zeitlich sortierbar, siehe util/id.ts). Der Zeitpunkt ist der, zu dem
 * die Marke zuletzt weiterrückte; steht dort NULL, wurde die Marke vor dieser
 * Fassung gesetzt, und der genaue Moment ist nicht mehr bekannt. Die Nachricht
 * gilt trotzdem als gelesen, nur ohne Uhrzeit dazu.
 *
 * Wer eine Nachricht selbst geschrieben hat, taucht nicht in deren eigener
 * Leserliste auf — dass man die eigene Nachricht „gelesen" hat, sagt niemandem
 * etwas Neues.
 *
 * Wer Lesebestätigungen abgeschaltet hat (users.lesebestaetigung_aus), taucht
 * in KEINER Leserliste auf, ganz gleich, welchen Kanal die Nachricht betrifft.
 * Die Lesemarke selbst (channel_members.last_read_message_id/last_read_at)
 * ist davon unberührt — sie rückt in messages.markRead() weiter vor wie
 * immer, denn genau daran hängt der eigene Ungelesen-Zähler dieser Person
 * (siehe store.unreadCounts). Abgeschaltet wird hier nur die Ausgabe: wer
 * gelesen hat, wird weiter vermerkt, nur niemandem mehr verraten.
 *
 * Prüft NICHT, ob die anfragende Person die Nachrichten überhaupt sehen darf —
 * das übernimmt die Ereignisleitung vorher, mit derselben Prüfung wie beim
 * Öffnen eines Threads (darfNachrichtSehen). Wer keinen Zugang zu einer
 * Nachricht hat, bekommt ihre Kennung hier gar nicht erst zur Anfrage gereicht.
 */
export function readReceiptsBatch(messageIds: string[]): Record<string, ReadReceipt[]> {
  const out: Record<string, ReadReceipt[]> = {};
  if (!messageIds.length) return out;

  const rows = db.all<{ id: string; channel_id: string; user_id: string }>(
    `SELECT id, channel_id, user_id FROM messages WHERE id IN (${placeholders(messageIds.length)})`,
    ...messageIds,
  );
  const byChannel = new Map<string, { id: string; userId: string }[]>();
  for (const r of rows) {
    const list = byChannel.get(r.channel_id) ?? [];
    list.push({ id: r.id, userId: r.user_id });
    byChannel.set(r.channel_id, list);
  }

  for (const [channelId, msgs] of byChannel) {
    const members = db.all<{
      user_id: string; last_read_message_id: string | null; last_read_at: number | null;
      lesebestaetigung_aus: number;
    }>(
      `SELECT cm.user_id, cm.last_read_message_id, cm.last_read_at, u.lesebestaetigung_aus
       FROM channel_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = ?`,
      channelId,
    );
    for (const m of msgs) {
      out[m.id] = members
        .filter((mem) => mem.user_id !== m.userId
          && mem.last_read_message_id != null && mem.last_read_message_id >= m.id
          && !mem.lesebestaetigung_aus)
        .map((mem) => ({ userId: mem.user_id, at: mem.last_read_at }))
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    }
  }
  return out;
}

/* ── Geplante Nachrichten ─────────────────────────────────────── */

/** Wie weit im Voraus sich eine Nachricht planen lässt. */
const PLANUNG_MAX_MS = 366 * 86_400_000;

export function scheduleMessage(input: {
  channelId: string; userId: string; text: string; sendAt: number; parentId?: string | null;
}) {
  const text = input.text.trim();
  if (!text) throw abweisung('fehler.nachrichtLeer', 'Leere Nachricht');
  if (!Number.isFinite(input.sendAt)) throw abweisung('fehler.sendezeitpunktUngueltig', 'Sendezeitpunkt muss ein Zeitpunkt sein');
  if (input.sendAt < Date.now() + 10_000) throw abweisung('fehler.sendezeitpunktZuBald', 'Sendezeitpunkt muss mindestens 10 Sekunden in der Zukunft liegen');
  /* Nach oben fehlte die Grenze ganz. Eine geplante Nachricht in fünfhundert
     Jahren wäre für immer im Speicher der Sitzung und in jeder Antwort auf
     'ready' — und der Zeitgeber sähe sie nie wieder an. */
  if (input.sendAt > Date.now() + PLANUNG_MAX_MS) throw abweisung('fehler.sendezeitpunktZuSpaet', 'Später als ein Jahr im Voraus geht nicht');

  // Dieselbe Prüfung wie beim sofortigen Senden, nur früher: fiele sie erst
  // beim Absetzen im Ticker auf, verschwände die geplante Nachricht dort
  // kommentarlos — hier merkt es wenigstens die Person, die sie plant.
  if (input.parentId) {
    const parent = db.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', input.parentId);
    if (!parent) throw abweisung('fehler.threadWurzelFehlt', 'Thread-Wurzel nicht gefunden');
    if (parent.channel_id !== input.channelId) throw abweisung('fehler.threadWurzelFalscherKanal', 'Thread-Wurzel gehört zu einem anderen Kanal');
  }

  const id = newId('sc_');
  db.run(
    'INSERT INTO scheduled_messages (id, channel_id, user_id, parent_id, text, send_at, created_at) VALUES (?,?,?,?,?,?,?)',
    id, input.channelId, input.userId, input.parentId ?? null, verschluesseln(text), input.sendAt, Date.now(),
  );
  return id;
}

export function cancelScheduled(id: string, userId: string): boolean {
  const res = db.run('DELETE FROM scheduled_messages WHERE id = ? AND user_id = ?', id, userId);
  return res.changes > 0;
}

export function dueScheduled(now: number) {
  return db.all<{ id: string; channel_id: string; user_id: string; parent_id: string | null; text: string }>(
    'SELECT id, channel_id, user_id, parent_id, text FROM scheduled_messages WHERE send_at <= ? ORDER BY send_at ASC LIMIT 50',
    now,
  ).map((r) => ({ ...r, text: entschluesseln(r.text) }));
}

export function removeScheduled(id: string): void {
  db.run('DELETE FROM scheduled_messages WHERE id = ?', id);
}

export function messagesByIds(ids: string[]): Message[] {
  if (!ids.length) return [];
  const rows = db.all(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return hydrateMessages(rows);
}
