import { db } from './index.js';
import { blindIndex, encryptField, encryptionActive } from '../crypto/pii.js';
import { entschluesseln, istChiffrat, verschluesseln, verschluesselungAktiv } from '../crypto/nachrichten.js';
import { ECHO_MIN_WOERTER, woerter } from '../translation/echo.js';
import { tmKennung } from './schluesselprobe.js';

/**
 * Spalten nachrüsten, die in älteren Datenbanken fehlen.
 * Neue Tabellen erledigt schema.sql mit CREATE TABLE IF NOT EXISTS —
 * für Spalten gibt es kein "IF NOT EXISTS", deshalb dieser Weg.
 */
const COLUMNS: { table: string; column: string; definition: string }[] = [
  // Verschlüsselte Personendaten: Suchwert getrennt vom Chiffrat
  { table: 'users', column: 'handle_bidx',          definition: 'TEXT' },
  { table: 'users', column: 'email_bidx',           definition: 'TEXT' },
  // Kontoverwaltung
  { table: 'users', column: 'must_change_password', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'must_complete_profile',definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'disabled',             definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'created_by',           definition: 'TEXT' },
  { table: 'users', column: 'password_set_at',      definition: 'INTEGER' },
  /* Ab wann Sitzungen dieses Kontos gelten: jedes Token, das älter ist, weist
     `verifyToken` ab. Bewusst eine eigene Spalte und nicht `password_set_at`,
     obwohl beide fast immer denselben Wert tragen — die Ersteinrichtung setzt
     ein Passwort mit genau dem Token in der Hand, das sie sonst selbst
     entwerten würde. Wer beides zusammenlegt, sperrt jeden neuen Kollegen
     mitten in seiner Einrichtung aus. */
  { table: 'users', column: 'sitzungen_ab',         definition: 'INTEGER' },
  { table: 'users', column: 'deleted_at',           definition: 'INTEGER' },
  // Prüfsumme des Inhalts: damit muss dieselbe Datei nur einmal übertragen werden.
  { table: 'attachments', column: 'sha256',        definition: 'TEXT' },
  /* Wie die Datei auf der Platte liegt und wie viel Platz sie dort belegt.
     `size` bleibt die Größe, die der Mensch hochgeladen hat und wiederbekommt —
     `stored_size` ist, was das Kontingent wirklich kostet. */
  { table: 'attachments', column: 'encoding',      definition: 'TEXT' },
  { table: 'attachments', column: 'stored_size',   definition: 'INTEGER' },
  { table: 'files',       column: 'encoding',      definition: 'TEXT' },
  { table: 'files',       column: 'stored_size',   definition: 'INTEGER' },
  // Schublade in der Verwaltung; leer heißt "von selbst einsortieren".
  { table: 'users', column: 'kategorie',            definition: 'TEXT' },
  { table: 'users', column: 'ui_language',          definition: "TEXT" },
  { table: 'users',    column: 'status_expires_at',  definition: 'INTEGER' },
  { table: 'users',    column: 'notification_sound', definition: "TEXT NOT NULL DEFAULT 'ping'" },
  { table: 'users',    column: 'translation_speed',  definition: "TEXT NOT NULL DEFAULT 'balanced'" },
  { table: 'messages', column: 'forwarded_from',     definition: 'TEXT' },
  { table: 'messages', column: 'kind',               definition: "TEXT NOT NULL DEFAULT 'text'" },
  { table: 'channels', column: 'ai_mode',            definition: "TEXT NOT NULL DEFAULT 'off'" },
  { table: 'channels', column: 'read_only',          definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'channel_members', column: 'hidden',      definition: 'INTEGER NOT NULL DEFAULT 0' },
  /* Vertrauliche Kanäle. `schluessel_fassung` bleibt bei 0, solange nichts
     verschlüsselt ist — die erste Fassung ist die 1, und daran erkennt der
     Server, ob überhaupt schon ein Schlüssel ausgehandelt wurde. */
  { table: 'channels', column: 'vertraulich',        definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'channels', column: 'schluessel_fassung', definition: 'INTEGER NOT NULL DEFAULT 0' },
  /* Private Dateien in der Ablage. Der Inhalt ist dann schon verschlüsselt,
     wenn er hier ankommt — die Spalte sagt nur, dass man ihn nicht als
     Klartext ausliefern oder in eine Vorschau stecken darf. */
  { table: 'files', column: 'privat',                definition: 'INTEGER NOT NULL DEFAULT 0' },
  /* Die Hülle einer verschlüsselten Datei: für welchen Kreis ihr Schlüssel
     verpackt wurde. Sie steht ohnehin im Umschlag der Datei selbst — hier
     liegt sie noch einmal, weil der Server sie bei jeder Nachricht braucht
     und dafür nicht jedes Mal eine Datei aufmachen soll.

     NULL heißt: unverschlüsselt. Das gilt für alles, was vor dieser Fassung
     hochgeladen wurde, und für jeden Anhang in einem offenen Kanal. */
  { table: 'attachments', column: 'huelle',          definition: 'TEXT' },
  { table: 'files',       column: 'huelle',          definition: 'TEXT' },
  /* Was die KI selbst angelegt hat, wartet auf einen Menschen.
     `von_ki` sagt, woher der Eintrag kommt, `geprueft_am`, wann jemand
     daraufgesehen hat — solange das fehlt, steht er im Reiter „Prüfen"
     statt mitten im Brett. Alte Einträge gelten als geprüft (0/NULL wäre
     sonst rückwirkend eine Behauptung über Dinge, die Menschen angelegt
     haben): deshalb `von_ki` mit Vorgabe 0, und ungeprüft ist nur, was
     `von_ki = 1` UND kein `geprueft_am` hat. */
  { table: 'tasks',  column: 'von_ki',      definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'tasks',  column: 'geprueft_am', definition: 'INTEGER' },
  { table: 'ideas',  column: 'von_ki',      definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'ideas',  column: 'geprueft_am', definition: 'INTEGER' },
  { table: 'events', column: 'von_ki',      definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'events', column: 'geprueft_am', definition: 'INTEGER' },
  /* Projekte bündeln Aufgaben. Ohne Projekt bleibt die Spalte NULL — genau
     so, wie das Brett vorher aussah. */
  { table: 'tasks',  column: 'projekt_id',  definition: 'TEXT' },
  /* Der Status folgt dem Fenster: vorn = online, weg = abwesend. Wer das
     nicht will, schaltet es hier ab. Vorgabe an, weil es die Erwartung der
     allermeisten ist — und weil ein vergessener offener Rechner sonst für
     alle anderen grün bleibt. */
  { table: 'users', column: 'auto_status', definition: 'INTEGER NOT NULL DEFAULT 1' },

  /* Vorschläge der Art „termin" brauchen einen Zeitpunkt. */
  { table: 'vorschlaege', column: 'beginnt_am',    definition: 'INTEGER' },
  { table: 'vorschlaege', column: 'dauer_minuten', definition: 'INTEGER' },

  /* Lesebestätigungen: wann die Lesemarke einer Person zuletzt vorwärts
     sprang. Siehe schema.sql bei channel_members für die Begründung — hier
     nur die Nachrüstung für eine Datenbank, die es noch nicht kennt. Auf
     einer bestehenden Datenbank bleibt die Spalte für jede schon vorhandene
     Zeile NULL: der genaue Zeitpunkt vergangener Lesevorgänge ist nicht
     bekannt, und diese Migration erfindet keinen. */
  { table: 'channel_members', column: 'last_read_at', definition: 'INTEGER' },
  /* Lesebestätigungen abschalten: dieselbe Marke wird weiter gesetzt (siehe
     last_read_at direkt darüber und messages.markRead) — nur herausgegeben
     wird sie dann an niemanden mehr. Siehe schema.sql bei users für die
     ausführliche Begründung. Vorgabe 0, nach dem Muster von auto_status. */
  { table: 'users', column: 'lesebestaetigung_aus', definition: 'INTEGER NOT NULL DEFAULT 0' },

  /* Anonyme Umfragen: Zählung je Antwort getrennt von der Sperre gegen
     Mehrfachabstimmen. Siehe schema.sql bei poll_options/poll_participants —
     hier nur die Nachrüstung für eine bestehende Datenbank. Bestehende
     Stimmen zu schon vorhandenen anonymen Umfragen zieht
     anonymeUmfragenAnonymisieren() weiter unten in diese Spalte um. */
  { table: 'poll_options', column: 'votes', definition: 'INTEGER NOT NULL DEFAULT 0' },

  /* Übersetzungsspeicher: Verweiszähler je Phrase (translation_memory) und
     die Zeile, die ihn hält (message_translations). Siehe schema.sql und
     tmVerweiseNachrechnen() in translation/index.ts. */
  { table: 'translation_memory',   column: 'verweise', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'message_translations', column: 'tm_key',   definition: 'TEXT' },

  /* Postfach: mail_nachrichten wuchs während der Entwicklung um vier Felder,
     nachdem die Tabelle selbst schon stand — auf jeder Datenbank, die die
     Tabelle vorher schon kannte, fehlen sie deshalb bis hierher. Genau daran
     scheiterte der Index auf zustell_schluessel weiter unten: der lief in
     schema.sql, bevor diese Nachrüstung ihn anlegen konnte (siehe Kommentar
     dort, dieselbe Art Fehler wie bei sha256/projekt_id). */
  { table: 'mail_nachrichten', column: 'umschlag_von',       definition: 'TEXT' },
  { table: 'mail_nachrichten', column: 'antwort_an',         definition: 'TEXT' },
  { table: 'mail_nachrichten', column: 'pruefung',           definition: 'TEXT' },
  { table: 'mail_nachrichten', column: 'zustell_schluessel', definition: 'TEXT' },

  /* users.timezone stand bisher bei jedem Konto, das die Leitung anlegte,
     auf dem Platzhalter aus createAccount() ('Europe/Berlin') — die Leitung
     kann beim Anlegen nicht wissen, wo die Person sitzt, und Setup.tsx fragte
     nur die Sprache ab, nie die Zeitzone. Die Profilkarte zeigte dadurch
     unter dem Namen der anderen Person still die Zeitzone des Betrachters.
     timezone_auto = 1 heißt "noch nicht bestätigt" und gilt hier für JEDE
     bestehende Zeile, unabhängig davon, was in timezone steht — auch für ein
     Konto, dessen Zeitzone zufällig schon richtig ist. Das ist gewollt: der
     Nachtrag in state/store.ts (zeitzoneNachtragen) schreibt nur, wenn die
     vom Browser erkannte Zeitzone von der gespeicherten abweicht, sonst
     bleibt einfach nichts zu tun. Siehe schema.sql beim users-Feld
     timezone_auto für die ausführliche Begründung, und ws/gateway.ts
     (prefs:update) dafür, wie die Spalte wieder auf 0 fällt. */
  { table: 'users', column: 'timezone_auto', definition: 'INTEGER NOT NULL DEFAULT 1' },

  /* Briefpartner-Gruppen (Kunden, Firmen, Bewerber, …) — mail_partner stand
     schon vor diesem Feld, siehe schema.sql dort für die Begründung der
     vier Spalten und services/post-partnergruppen.ts für ihre Verwendung. */
  { table: 'mail_partner', column: 'gruppe',              definition: 'TEXT' },
  { table: 'mail_partner', column: 'gruppe_von_ki',       definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'mail_partner', column: 'gruppe_vorschlag_am', definition: 'INTEGER' },
  { table: 'mail_partner', column: 'gruppe_begruendung',  definition: 'TEXT' },

  /* Der Absenderbeleg hinter einer automatischen "intern"-Einordnung — siehe
     schema.sql bei derselben Spalte und util/absenderbeleg.ts. Nachgeruestet
     wie die vier oben: mail_partner stand schon davor. NULL auf jeder
     bestehenden Zeile ist genau richtig — keine davon kam ueber einen
     geprueften Weg zustande, und internBackfillEinmalig()
     (services/post-partnergruppen.ts) raeumt die betroffenen Zeilen beim
     naechsten Takt in ihre ehrliche Form. */
  { table: 'mail_partner', column: 'gruppe_beleg',         definition: 'TEXT' },

  /* Postfach: Archivieren und „aus dem Weg räumen" — beides nullbare
     Zeitpunkte, NULL heißt "gilt nicht". Siehe services/post.ts,
     archiviertSetzen()/entferntSetzen() für die Verwendung und den
     Dateikopf dort für die Begründung, warum das zwei unabhängige Spalten
     sind und keine gemeinsame. */
  { table: 'mail_nachrichten', column: 'archiviert_am', definition: 'INTEGER' },
  { table: 'mail_nachrichten', column: 'entfernt_am',   definition: 'INTEGER' },

  /* Der Wortlaut, wie die KI ihn geschrieben hat, bevor ein Mensch ihn beim
     Freigeben überschrieb. `text` trägt seit jeher, was tatsächlich hinausging
     (entwurfBearbeiten() in services/post-sichtung.ts) — ohne diese Spalte
     wäre der Unterschied zwischen beiden beim Senden für immer weg, und
     services/post.ts::senden() bräuchte ihn für die Fußzeile am Mailende
     (unverändert = "von StelliumAI erstellt", verändert = "mit
     Unterstützung von StelliumAI bearbeitet"). NULL bei jedem Entwurf aus
     der Zeit davor: was nie gespeichert wurde, lässt sich nicht nachträglich
     erfinden — eine solche Mail bekommt beim Senden keine Fußzeile, weil sich
     nicht mehr sagen lässt, ob eine KI beteiligt war. Siehe schema.sql und
     services/post-lernen.ts. */
  { table: 'mail_entwuerfe', column: 'text_ki', definition: 'TEXT' },

  /* Ob und wie eine KI an einer GESENDETEN Mail mitgeschrieben hat —
     'ki' (unverändert übernommen), 'ki_bearbeitet' (ein Mensch hat den
     KI-Entwurf vor dem Senden verändert) oder NULL (keine KI beteiligt,
     oder eine Mail von vor dieser Spalte). Gesetzt einzig von
     services/post.ts::senden() im selben Moment, in dem auch die Fußzeile
     entsteht — DER EINE Ort, durch den jeder Versand läuft (siehe
     Dateikopf dort). Zwei Gründe, warum das eine eigene Spalte auf der
     GESENDETEN Zeile ist und nicht nur eine Textsuche im Fließtext:
     services/post-lernen.ts muss zuverlässig erkennen können, ob an einer
     Mail eine KI mitgeschrieben hat, OHNE sich auf eine Zeichenkette
     verlassen zu müssen, die im Fließtext stehen könnte oder nicht (die
     Fußzeile selbst steht nur noch im tatsächlich verschickten `text`, nie
     mehr im bearbeitbaren Entwurf — eine Textsuche fände sie dort gar nicht
     mehr zuverlässig). Und: dieselbe Spalte deckt auch den Weg über „KI
     schreibt" (services/post-entwurf-ki.ts), der nie eine Zeile in
     `mail_entwuerfe` anlegt und für den es deshalb kein `text_ki` zum
     Nachschlagen gäbe. NULL auf jeder bestehenden Zeile: was vor dieser
     Spalte gesendet wurde, lässt sich nicht mehr nachträglich einordnen —
     post-lernen.ts behandelt eine solche Zeile wie jede andere ohne
     KI-Beteiligung, weil sich das Gegenteil nicht mehr beweisen lässt. */
  { table: 'mail_nachrichten', column: 'ki_art', definition: 'TEXT' },

  /* Einmalcodes: dieselben vier mit encryptField (crypto/pii.ts)
     verschlüsselten Felder wie im vollständigen CREATE TABLE weiter unten in
     dieser Datei und in schema.sql. `einmalcode_konten` ist eine brandneue
     Tabelle mit vollständiger Spaltenliste von Anfang an — diese vier Zeilen
     greifen deshalb im Alltag nie (die Tabelle existiert nie ohne sie), sie
     sind das gleiche Sicherheitsnetz, das ADD-COLUMN hier für jede Tabelle
     bietet, falls doch einmal etwas anders lief. Nullbar statt NOT NULL,
     nach demselben Vorbehalt wie attachments.sha256 oben: ein ALTER TABLE ADD
     COLUMN … NOT NULL bräuchte einen DEFAULT, und diese Definition dient
     nur der Nachrüstung, nicht der eigentlichen Spaltendefinition. */
  { table: 'einmalcode_konten', column: 'bezeichnung', definition: 'TEXT' },
  { table: 'einmalcode_konten', column: 'aussteller',  definition: 'TEXT' },
  { table: 'einmalcode_konten', column: 'konto',       definition: 'TEXT' },
  { table: 'einmalcode_konten', column: 'geheimnis',   definition: 'TEXT' },

  /* Zuletzt gemeldete App-Fassung und Plattform je Konto — Anlass war eine
     Support-Rückfrage ("ich habe die neue Version noch nicht"), die sich von
     der Verwaltung aus nicht nachprüfen ließ. Geschrieben bei JEDER
     erfolgreichen Anmeldung (ws/gateway.ts, authenticate() ->
     services/store.ts, clientMeldung()), nicht nur beim ersten Mal — bei
     mehreren gleichzeitig offenen Geräten gewinnt, wer zuletzt (wieder)
     angemeldet hat, dieselbe Regel wie bei last_seen_at. NULL auf jeder
     bestehenden Zeile ist ehrlich: was vor dieser Fassung zuletzt lief, ist
     nirgends festgehalten worden, und diese Nachrüstung erfindet nichts. */
  { table: 'users', column: 'client_version',    definition: 'TEXT' },
  { table: 'users', column: 'client_platform',   definition: 'TEXT' },
  { table: 'users', column: 'client_version_at', definition: 'INTEGER' },
];

export function migrate(): void {
  /* Ohne das schreibt SQLite gelöschte Inhalte nur aus dem Baum aus, nicht
     aus der Datei: der Platz gilt als frei, die alten Bytes bleiben aber
     unverändert liegen, bis eine spätere Schreibung dieselbe Seite wieder
     benutzt — auf einer kleinen, selten geschriebenen Datenbank unter
     Umständen sehr lange. Für die meisten Tabellen im Haus ist das
     hinnehmbar; für services/post.ts (endgueltigLoeschen(), Art. 17 DSGVO)
     ist es das GENAUE GEGENTEIL dessen, was "endgültig löschen" verspricht —
     ein DELETE allein reicht dafür nicht, die Bytes müssen überschrieben
     werden. Eine Ausnahme nur für die Post zu schalten, ginge nicht: die
     Einstellung gilt für die ganze Verbindung, nicht je Tabelle. Sie gilt
     deshalb hier für das ganze Haus — jede andere Löschung (Konten,
     Nachrichten, Notizen) bekommt dieselbe Härtung nebenbei geschenkt.
     Muss bei JEDEM Start neu gesetzt werden: anders als journal_mode ist
     secure_delete keine Eigenschaft der Datei, sondern der Verbindung. */
  db.exec('PRAGMA secure_delete = ON');

  for (const { table, column, definition } of COLUMNS) {
    const existing = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!existing.length) continue;                       // Tabelle gibt es noch nicht
    if (existing.some((c) => c.name === column)) continue; // Spalte ist schon da
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] Spalte ${table}.${column} ergänzt`);
  }

  /* Auf einer bestehenden Datenbank gibt es die Tabelle noch nicht — sie
     steht zwar in schema.sql, aber die läuft nur beim ersten Anlegen. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS praesenz_tage (
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tag      TEXT NOT NULL,
      sekunden INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, tag)
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_praesenz_tag ON praesenz_tage(tag)');

  /* Anonyme Umfragen: Sperre gegen Mehrfachabstimmen, getrennt von der
     Zählung (poll_options.votes oben). Siehe schema.sql für die Begründung. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_participants (
      poll_id    TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (poll_id, user_id)
    )`);

  /* Auf einer bestehenden Datenbank gibt es die Tabellen noch nicht — sie
     stehen zwar in schema.sql, aber die läuft nur beim ersten Anlegen. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_sichtung (
      mail_id      TEXT PRIMARY KEY,
      thread_id    TEXT NOT NULL,
      gesichtet_am INTEGER NOT NULL,
      einordnung   TEXT,
      zustand      TEXT NOT NULL DEFAULT 'gemeldet'
    )`);
  /* Für den Reiter „Post-Sichtung" (PostMeldungen.tsx): die Liste dort blättert
     rückwärts über `gesichtet_am`, neueste zuerst — ohne Index liefe das auf
     einen vollen Tabellendurchlauf samt Sortierung bei jeder Seite. Hier und
     nicht in schema.sql, aus demselben Grund wie bei der Tabelle selbst zwei
     Zeilen darüber: schema.sql läuft nur beim ersten Anlegen. */
  db.exec('CREATE INDEX IF NOT EXISTS idx_mail_sichtung_gesichtet ON mail_sichtung(gesichtet_am)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_entwuerfe (
      id              TEXT PRIMARY KEY,
      mail_id         TEXT NOT NULL,
      thread_id       TEXT NOT NULL,
      an              TEXT NOT NULL,
      betreff         TEXT NOT NULL,
      text            TEXT NOT NULL,
      text_ki         TEXT,
      begruendung     TEXT,
      zustand         TEXT NOT NULL DEFAULT 'offen',
      erstellt_am     INTEGER NOT NULL,
      entschieden_am  INTEGER,
      entschieden_von TEXT REFERENCES users(id) ON DELETE SET NULL,
      gesendet_id     TEXT
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mail_entwurf_zustand ON mail_entwuerfe(zustand, erstellt_am)');
  /* Der Lernlauf sucht zu einer gesendeten Mail den Entwurf, aus dem sie
     entstand (services/post-lernen.ts, `WHERE gesendet_id = ?`). Hier und
     nicht in schema.sql, aus demselben Grund wie beim Index auf
     zustell_schluessel weiter unten: `gesendet_id` fehlt auf einer Datenbank,
     die mail_entwuerfe vor diesem Feld angelegt hat, und ein Index auf eine
     Spalte, die es noch nicht gibt, lässt den Server gar nicht erst starten.
     Teilindex, weil nur die winzige Minderheit der Zeilen ihn je braucht:
     ein Entwurf ohne `gesendet_id` ist offen oder abgelehnt. */
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_mail_entwurf_gesendet ON mail_entwuerfe(gesendet_id) WHERE gesendet_id IS NOT NULL');
  } catch (err) {
    console.warn('[db] Index idx_mail_entwurf_gesendet:', (err as Error).message);
  }

  /* Das Gedächtnis der Firmenpost. Auf einer bestehenden Datenbank gibt es
     die beiden Tabellen noch nicht — sie stehen zwar in schema.sql, aber die
     läuft nur beim ersten Anlegen. Wortgleich mit dort; wer eine Spalte
     ergänzt, ergänzt sie an beiden Stellen. Die ausführliche Begründung je
     Spalte steht in schema.sql, der Umgang damit in
     services/post-wissen.ts. "Wortgleich" wird nicht nur behauptet:
     pruefungen/tabellen-abgleich.mts vergleicht bei jedem Lauf die
     Spaltenliste jeder hier UND in schema.sql geführten Tabelle und schlägt
     laut fehl, falls beide auseinanderlaufen — ohne feste Namensliste, jede
     künftige Tabelle nach diesem Muster ist automatisch mit dabei. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_wissen (
      id            TEXT PRIMARY KEY,
      art           TEXT NOT NULL DEFAULT 'wissen',
      thema         TEXT NOT NULL,
      inhalt        TEXT NOT NULL,
      stichworte    TEXT,
      immer         INTEGER NOT NULL DEFAULT 0,
      fach          TEXT,
      quelle        TEXT,
      angelegt_von  TEXT REFERENCES users(id) ON DELETE SET NULL,
      angelegt_am   INTEGER NOT NULL,
      geaendert_am  INTEGER,
      ersetzt_id    TEXT,
      ersetzt_am    INTEGER,
      ersetzt_durch TEXT
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mail_wissen_aktiv ON mail_wissen(ersetzt_am, art)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_wissen_vorschlaege (
      id              TEXT PRIMARY KEY,
      abdruck         TEXT NOT NULL,
      art             TEXT NOT NULL DEFAULT 'wissen',
      thema           TEXT NOT NULL,
      inhalt          TEXT NOT NULL,
      begruendung     TEXT,
      herkunft        TEXT,
      widerspruch_zu  TEXT,
      zustand         TEXT NOT NULL DEFAULT 'offen',
      erstellt_am     INTEGER NOT NULL,
      entschieden_am  INTEGER,
      entschieden_von TEXT REFERENCES users(id) ON DELETE SET NULL,
      eintrag_id      TEXT
    )`);
  /* Der eindeutige Index IST die Regel „ein abgelehnter Vorschlag kommt nicht
     wieder": derselbe Fingerabdruck lässt sich kein zweites Mal eintragen,
     unabhängig davon, wie damals entschieden wurde. Er steht in der Datenbank
     und nicht im Arbeitsspeicher, damit ein Neustart ihn nicht vergisst —
     dieselbe Haltung wie bei der Dublettensperre in services/vorschlaege.ts. */
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_wissen_abdruck ON mail_wissen_vorschlaege(abdruck)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mail_wissen_vorschlag ON mail_wissen_vorschlaege(zustand, erstellt_am)');

  /* Eine frühere Fassung von schema.sql hatte hier ein fehlendes Leerzeichen
     vor dem Typnamen — `idTEXT PRIMARY KEY` und `anTEXT NOT NULL` wurden
     dadurch zu Spalten NAMENS `idTEXT` und `anTEXT`, nicht zu `id TEXT` und
     `an TEXT`. Jede Datenbank, die schema.sql in diesem Zustand einmal
     durchlaufen hat, trägt die Tabelle seither so — das CREATE TABLE IF NOT
     EXISTS oben (wie das in schema.sql) rührt einen bestehenden Tabellennamen
     nicht mehr an, egal wie seine Spalten heißen.
     Umbenennen statt neu anlegen ist hier gefahrlos möglich, und zwar nicht
     nur "vermutlich": `entwurfAnlegen()` in post-sichtung.ts schreibt `id`
     und `an` namentlich in ein INSERT — auf der falschen Spalte wäre das immer
     sofort gescheitert. Es kann in dieser Tabelle also gar keine Zeile geben,
     ganz gleich auf welcher Datenbank. */
  const entwuerfeSpalten = db.all<{ name: string }>('PRAGMA table_info(mail_entwuerfe)');
  if (entwuerfeSpalten.some((c) => c.name === 'idTEXT')) {
    db.exec('ALTER TABLE mail_entwuerfe RENAME COLUMN idTEXT TO id');
    console.log('[db] Spalte mail_entwuerfe.idTEXT in id umbenannt (Tippfehler aus einer früheren schema.sql behoben)');
  }
  if (entwuerfeSpalten.some((c) => c.name === 'anTEXT')) {
    db.exec('ALTER TABLE mail_entwuerfe RENAME COLUMN anTEXT TO an');
    console.log('[db] Spalte mail_entwuerfe.anTEXT in an umbenannt (Tippfehler aus einer früheren schema.sql behoben)');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS mail_nachrichten (
  id           TEXT PRIMARY KEY,
  /* An welche Adresse sie ging — daraus entstehen die Ordner in der
     Oberflaeche. "support@stellium.club" und "billing@stellium.club" landen
     im selben Postfach, sollen aber getrennt zu lesen sein. */
  fach         TEXT NOT NULL,
  richtung     TEXT NOT NULL,           -- 'ein' oder 'aus'
  /* Verschluesselt wie Chatnachrichten: das ist Schriftwechsel mit Kunden,
     und wer die Datenbankdatei hat, soll ihn nicht lesen koennen. */
  von          TEXT NOT NULL,
  an           TEXT NOT NULL,
  betreff      TEXT NOT NULL,
  text         TEXT NOT NULL,
  html         TEXT,
  /* Die Kennungen, an denen Mailprogramme einen Verlauf aufhaengen. Ohne sie
     waere jede Antwort eine neue Nachricht mit "Re:" davor. */
  message_id   TEXT,
  referenzen   TEXT,
  thread_id    TEXT,
  /* Der Umschlagabsender ist NICHT der sichtbare. "From:" steht im
     Mailprogramm, "MAIL FROM" zaehlt fuer SPF. Gehen sie auseinander, gehoert
     das dem Menschen gezeigt, der eine Antwort freigibt. */
  umschlag_von TEXT,
  antwort_an   TEXT,
  /* Was Cloudflare zu SPF/DKIM/DMARC gemeldet hat. Als Signal, nie als
     Sperre: Post zu verlieren waere schlimmer. Der KI-Entwurf haengt daran. */
  pruefung     TEXT,
  /* Zustellschluessel des Workers — SHA-256 ueber den Rumpf. NICHT die
     Message-ID des Absenders: die ist bei vielen Systemen vorhersagbar, und
     wer sie vorher anmeldet, laesst die echte Mail lautlos als Dublette
     verschwinden. */
  zustell_schluessel TEXT,
  am           INTEGER NOT NULL,
  gelesen      INTEGER NOT NULL DEFAULT 0,
  /* Anhaenge liegen als JSON daneben: Name, Typ, Groesse und der Ort in der
     Ablage. Der Inhalt selbst gehoert nicht in die Datenbank. */
  anhaenge     TEXT
)`);
  /* Absicherung für den einen Fall, in dem nicht die COLUMNS-Schleife oben,
     sondern GENAU DIESES CREATE TABLE die Tabelle zum ersten Mal anlegt —
     weil schema.sql seine eigene mail_nachrichten-Anweisung übersprungen hat
     (initDb() toleriert das, siehe dort). `ki_art` fehlte dann bis zum
     NÄCHSTEN migrate()-Lauf, weil die COLUMNS-Schleife oben schon durchlief,
     als es die Tabelle noch nicht gab — und services/post.ts::senden()
     schreibt bei jedem Versand in diese Spalte, ohne Ausnahme. Auf dem Pi
     nicht erreichbar (die Tabelle steht dort längst), auf einer wirklich
     frischen Installation aber doch. Eigener Schutz statt Umsortieren der
     COLUMNS-Schleife: die verlässt sich an mehreren Stellen weiter unten
     darauf, VOR den hier folgenden CREATE-TABLE-Anweisungen zu laufen. */
  if (!db.all<{ name: string }>('PRAGMA table_info(mail_nachrichten)').some((c) => c.name === 'ki_art')) {
    db.exec('ALTER TABLE mail_nachrichten ADD COLUMN ki_art TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_mail_fach ON mail_nachrichten(fach, am DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail_nachrichten(thread_id)');
  /* Eindeutig, nicht nur schnell: damit die Idempotenz an der Datenbank
     haengt und nicht daran, dass zwei Anfragen zufaellig nacheinander
     laufen. Läuft absichtlich erst hier und nicht in schema.sql: die
     COLUMNS-Nachrüstung oben hat zustell_schluessel bis zu dieser Zeile
     garantiert ergänzt, falls eine bestehende Datenbank die Spalte noch
     nicht kannte. Trotzdem try/catch, nicht nackt — derselbe Vorbehalt wie
     bei idx_tasks_projekt weiter unten: eine Überraschung hier darf den
     Start nicht verweigern, nur melden. */
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_zustell ON mail_nachrichten(zustell_schluessel) WHERE zustell_schluessel IS NOT NULL');
  } catch (err) {
    console.warn('[db] Index idx_mail_zustell:', (err as Error).message);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS mail_partner (
  /* Der Suchwert: derselbe Blindindex wie bei Konten. Die Adresse selbst ist
     personenbezogen und liegt daneben verschluesselt — gesucht wird ueber den
     Index, gelesen wird das Chiffrat. */
  adresse_bidx TEXT PRIMARY KEY,
  adresse      TEXT NOT NULL,
  sprache      TEXT NOT NULL,
  /* Wie sicher die Erkennung war, die zu dieser Sprache gefuehrt hat. Eine
     spaetere, unsicherere Messung soll eine sichere nicht umwerfen. */
  sicher       REAL NOT NULL DEFAULT 0,
  seit         INTEGER NOT NULL,
  /* Siehe schema.sql beim selben Feld fuer die ausfuehrliche Begruendung. */
  gruppe               TEXT,
  gruppe_von_ki        INTEGER NOT NULL DEFAULT 0,
  gruppe_vorschlag_am  INTEGER,
  gruppe_begruendung   TEXT,
  gruppe_beleg         TEXT
)`);
  /* Filterung nach Gruppe in der Oberflaeche — siehe COLUMNS oben fuer die
     Nachruestung auf einer Datenbank, die mail_partner schon vor diesem Feld
     kannte. Erst hier und nicht in schema.sql, aus demselben Grund wie bei
     idx_mail_zustell oben: die Spalte ist auf einer bestehenden Datenbank
     bis zu dieser Stelle im Ablauf garantiert nachgeruestet. */
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_mail_partner_gruppe ON mail_partner(gruppe)');
  } catch (err) {
    console.warn('[db] Index idx_mail_partner_gruppe:', (err as Error).message);
  }

  /* Benutzerdefinierte Briefpartner-Gruppen — siehe schema.sql fuer dieselbe
     Tabelle wortgleich (post_partnergruppen.mts prueft das) und
     packages/shared/src/types.ts fuer den Unterschied zu den eingebauten
     Gruppen. Brandneue Tabelle, keine Vorgaengerform — deshalb reicht ein
     einfaches CREATE TABLE IF NOT EXISTS hier, ohne Spalten-Nachruestung
     ueber die COLUMNS-Liste oben. */
  db.exec(`CREATE TABLE IF NOT EXISTS post_partnergruppen (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
)`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_post_partnergruppen_name ON post_partnergruppen(name COLLATE NOCASE)');

  /* Indizes auf archiviert_am/entfernt_am — beide erst hier und nicht in
     schema.sql, aus demselben Grund wie idx_mail_zustell oben: die Spalten
     sind auf einer bestehenden Datenbank erst über die COLUMNS-Nachrüstung
     weiter oben in dieser Datei entstanden, garantiert bis zu dieser Stelle.
     Partielle Indizes (nur die gesetzten Werte), weil im Alltag fast jede
     Zeile NULL trägt — ein Index über lauter NULL brächte nichts. */
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_mail_archiviert ON mail_nachrichten(fach, archiviert_am) WHERE archiviert_am IS NOT NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mail_entfernt ON mail_nachrichten(fach, entfernt_am) WHERE entfernt_am IS NOT NULL');
  } catch (err) {
    console.warn('[db] Indizes für Archiv/Papierkorb der Post:', (err as Error).message);
  }

  /* services/post.ts, liste() OHNE Fachfilter — die "alle Fächer"-Übersicht,
     vermutlich die meistgenutzte Ansicht des Postfachs überhaupt — fragt in
     ihrer Vorgabe-Ansicht ('aktiv'):
       WHERE am < ? AND archiviert_am IS NULL AND entfernt_am IS NULL
       ORDER BY am DESC LIMIT ?
     Jeder bis hierher vorhandene Index auf dieser Tabelle beginnt mit
     `fach` (idx_mail_fach, idx_mail_archiviert, idx_mail_entfernt) — ohne
     Fach in der WHERE-Bedingung kann keiner von ihnen etwas beitragen.
     Nachgemessen an 20 000 Zeilen: SCAN mail_nachrichten + eigener
     Sortierschritt (TEMP B-TREE), rund 3 ms. mail_nachrichten hat KEINE
     Aufbewahrungsfrist als Vorgabe (siehe post_fristen, fristenAnwenden() in
     services/post.ts) und wird von einem Cloudflare Worker mit jeder ein-
     UND ausgehenden Kundenmail gefüllt — die Tabelle wächst unbegrenzt,
     der volle Durchlauf wird also nur schlimmer, nie von selbst besser.
     Partieller Index auf genau `archiviert_am IS NULL AND entfernt_am IS
     NULL` — exakt die WHERE-Bedingung der 'aktiv'-Ansicht — mit `am DESC`
     als einziger Spalte: SQLite bedient damit sowohl die Bedingung als auch
     die Sortierung direkt aus dem Index, ohne eigenen Sortierschritt.
     Bewusst OHNE Gegenstück für 'archiviert'/'papierkorb' ohne Fachfilter
     (deren WHERE-Bedingung ist das Gegenteil von der dieses Index, ein
     eigener Index bräuchte also seine eigene Partition): diese beiden
     Ansichten werden seltener aufgerufen, und ein dritter/vierter Index auf
     einer Tabelle mit dieser Schreiblast (jede einzelne ein- und ausgehende
     Mail) kostet bei jedem INSERT/UPDATE mit, ohne dass es dafür einen
     entsprechend häufigen Lesefall gäbe. */
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_mail_alle_aktiv ON mail_nachrichten(am DESC) WHERE archiviert_am IS NULL AND entfernt_am IS NULL');
  } catch (err) {
    console.warn('[db] Index für die Postfach-Übersicht ohne Fachfilter:', (err as Error).message);
  }

  /* Aufbewahrungsfrist der Post, je Fach. Fehlt eine Zeile für ein Fach, gilt
     dort KEINE Frist — das ist die Vorgabe, bis jemand mit `mail.verwalten`
     ausdrücklich eine setzt (siehe services/post.ts, fristSetzen()/
     fristenStand()/fristenAnwenden()). Eine eigene, kleine Tabelle statt
     eines JSON-Werts in app_settings: es gibt genau eine Zeile je Fach, sie
     soll einzeln abfragbar und mit `gesetzt_von`/`gesetzt_am` nachvollziehbar
     sein — dieselbe Bauart wie user_permissions oder mail_partner, nicht die
     wie app_settings (dort stehen einzelne, globale Werte, keine Liste). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_fristen (
      fach        TEXT PRIMARY KEY,
      tage        INTEGER NOT NULL,
      gesetzt_von TEXT REFERENCES users(id) ON DELETE SET NULL,
      gesetzt_am  INTEGER NOT NULL
    )`);

  /* Notizen — dieselben drei Tabellen wie in schema.sql, aus demselben Grund
     wie poll_participants und mail_partner oben: auf einer bestehenden
     Datenbank bringt CREATE TABLE IF NOT EXISTS in schema.sql sie nicht
     zuverlässig nach, wenn ein früheres Statement in derselben Datei auf
     einer älteren Datenbank stolpert (siehe Kommentar am Kopf dieser Datei
     zu genau diesem Ausfall, Fassung 1.0.17). Hier läuft jede Tabelle für
     sich, unabhängig vom Rest von schema.sql. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS notizen (
      id                 TEXT PRIMARY KEY,
      owner_id           TEXT NOT NULL REFERENCES users(id),
      chiffrat           TEXT NOT NULL,
      version            INTEGER NOT NULL DEFAULT 1,
      schluessel_fassung INTEGER NOT NULL DEFAULT 1,
      geaendert_von      TEXT NOT NULL REFERENCES users(id),
      geaendert_am       INTEGER NOT NULL,
      erstellt_am        INTEGER NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notiz_mitglieder (
      notiz_id         TEXT NOT NULL REFERENCES notizen(id) ON DELETE CASCADE,
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hinzugefuegt_von TEXT NOT NULL REFERENCES users(id),
      hinzugefuegt_am  INTEGER NOT NULL,
      entfernt_am      INTEGER,
      entfernt_grund   TEXT,
      PRIMARY KEY (notiz_id, user_id)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notiz_schluessel_pakete (
      notiz_id    TEXT NOT NULL REFERENCES notizen(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fassung     INTEGER NOT NULL,
      von_user_id TEXT NOT NULL,
      alg         TEXT NOT NULL,
      iv          TEXT NOT NULL,
      daten       TEXT NOT NULL,
      erstellt_am INTEGER NOT NULL,
      PRIMARY KEY (notiz_id, user_id)
    )`);
  /* Kontoschlüssel und der zweite Weg zum Notizschlüssel — wortgleich mit
     schema.sql, aus demselben Grund wie die drei Notiztabellen darüber.
     Ausführliche Begründung steht dort. Kurz: `notiz_schluessel_pakete`
     verwechselt Konto und Gerät (`von` ist eine Konto-Kennung, gerechnet
     wurde mit dem privaten Teil EINES Geräts), deshalb kann ein zweites
     Gerät desselben Kontos eine Notiz nie öffnen. Der Kontoschlüssel hebt
     die Verwechslung auf, der Geräteweg bleibt daneben bestehen. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS konto_schluessel (
      user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      kdf          TEXT NOT NULL,
      salz         TEXT NOT NULL,
      runden       INTEGER NOT NULL,
      alg          TEXT NOT NULL,
      iv           TEXT NOT NULL,
      daten        TEXT NOT NULL,
      abdruck      TEXT NOT NULL,
      fassung      INTEGER NOT NULL,
      erstellt_am  INTEGER NOT NULL,
      geaendert_am INTEGER NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notiz_konto_pakete (
      notiz_id      TEXT NOT NULL REFERENCES notizen(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fassung       INTEGER NOT NULL,
      konto_fassung INTEGER NOT NULL,
      alg           TEXT NOT NULL,
      iv            TEXT NOT NULL,
      daten         TEXT NOT NULL,
      erstellt_am   INTEGER NOT NULL,
      PRIMARY KEY (notiz_id, user_id)
    )`);
  /* Der Anmeldenachweis — wortgleich mit schema.sql, aus demselben Grund wie
     die Notiztabellen darüber. Ausführliche Begründung steht dort. Kurz: der
     Kontoschlüssel ruht darauf, dass nur die Geräte das Passwort kennen —
     solange die Anmeldung es im Klartext hinschickt, gilt das nicht. Diese
     Tabelle hält den scrypt-Abdruck eines aus dem Passwort abgeleiteten
     Nachweises; users.password_hash bleibt daneben stehen, damit jede alte
     App weiter hereinkommt. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS anmelde_nachweise (
      user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      kdf          TEXT NOT NULL,
      salz         TEXT NOT NULL,
      runden       INTEGER NOT NULL,
      nachweis     TEXT NOT NULL,
      erstellt_am  INTEGER NOT NULL,
      geaendert_am INTEGER NOT NULL
    )`);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notizen_owner ON notizen(owner_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notiz_mitglieder_user ON notiz_mitglieder(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notiz_pakete_user ON notiz_schluessel_pakete(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notiz_konto_pakete_user ON notiz_konto_pakete(user_id)');
  } catch (err) {
    console.warn('[db] Indizes für Notizen:', (err as Error).message);
  }

  /* Verkaufsstatistik — dieselben fünf Tabellen wie in schema.sql, aus
     demselben Grund wie bei Notizen und Post oben: auf einer bestehenden
     Datenbank bringt CREATE TABLE IF NOT EXISTS in schema.sql sie nicht
     zuverlässig nach. Jede Tabelle für sich, unabhängig vom Rest von
     schema.sql — siehe dort für die ausführliche Begründung der beiden
     Entwurfsentscheidungen (roh speichern statt Summen, Momentaufnahmen für
     Anbieter ohne eigene Historie). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS verkauf_gumroad_verkaeufe (
      id                  TEXT PRIMARY KEY,
      produkt_id          TEXT,
      subscription_id     TEXT,
      preis_cent          INTEGER NOT NULL DEFAULT 0,
      gebuehr_cent        INTEGER NOT NULL DEFAULT 0,
      waehrung            TEXT NOT NULL DEFAULT 'USD',
      laufzeit            TEXT,
      erstellt_am         INTEGER,
      erstattet           INTEGER NOT NULL DEFAULT 0,
      teilerstattet       INTEGER NOT NULL DEFAULT 0,
      erstattbar_cent     INTEGER,
      angefochten         INTEGER NOT NULL DEFAULT 0,
      anfechtung_gewonnen INTEGER,
      rueckgebucht        INTEGER NOT NULL DEFAULT 0,
      kurs_eur_je_usd     REAL,
      kurs_datum          TEXT,
      zuletzt_gesehen_am  INTEGER NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS verkauf_gumroad_abonnenten (
      id                 TEXT PRIMARY KEY,
      produkt_id         TEXT,
      status             TEXT NOT NULL,
      laufzeit           TEXT,
      erstellt_am        INTEGER,
      probe_bis          INTEGER,
      gekuendigt_am      INTEGER,
      beendet_am         INTEGER,
      fehlgeschlagen_am  INTEGER,
      zuletzt_gesehen_am INTEGER NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS verkauf_gumroad_auszahlungen (
      id                 TEXT PRIMARY KEY,
      betrag             REAL,
      waehrung           TEXT,
      status             TEXT,
      zahlungsart        TEXT,
      rohdaten           TEXT,
      zuletzt_gesehen_am INTEGER NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS verkauf_momentaufnahmen (
      anbieter          TEXT NOT NULL,
      tag               TEXT NOT NULL,
      erfasst_am        INTEGER NOT NULL,
      aktive            INTEGER NOT NULL DEFAULT 0,
      deklination       INTEGER NOT NULL DEFAULT 0,
      ehemalig          INTEGER NOT NULL DEFAULT 0,
      follower          INTEGER NOT NULL DEFAULT 0,
      einnahmen_cent    INTEGER NOT NULL DEFAULT 0,
      waehrung          TEXT,
      neu_diesen_monat  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (anbieter, tag)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wechselkurse (
      datum      TEXT NOT NULL,
      basis      TEXT NOT NULL,
      ziel       TEXT NOT NULL,
      kurs       REAL NOT NULL,
      quelldatum TEXT,
      geholt_am  INTEGER NOT NULL,
      PRIMARY KEY (datum, basis, ziel)
    )`);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_verkauf_gr_verkaeufe_erstellt ON verkauf_gumroad_verkaeufe(erstellt_am)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_verkauf_gr_verkaeufe_abo ON verkauf_gumroad_verkaeufe(subscription_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_verkauf_gr_abo_status ON verkauf_gumroad_abonnenten(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_verkauf_gr_auszahl_status ON verkauf_gumroad_auszahlungen(status)');
  } catch (err) {
    console.warn('[db] Indizes für Verkaufsstatistik:', (err as Error).message);
  }

  /* Verkaufsmeldungen — dieselbe Tabelle wie in schema.sql, aus demselben
     Grund wie bei Verkaufsstatistik direkt darüber: CREATE TABLE IF NOT
     EXISTS in schema.sql bringt sie auf einer bestehenden Datenbank nicht
     zuverlässig nach. Wortgleich mit dort. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS verkauf_ereignisse (
      id            TEXT PRIMARY KEY,
      fingerabdruck TEXT NOT NULL,
      anbieter      TEXT NOT NULL,
      art           TEXT NOT NULL,
      produkt_name  TEXT,
      betrag_cent   INTEGER,
      waehrung      TEXT,
      in_probe      INTEGER,
      stumm         INTEGER NOT NULL DEFAULT 0,
      erkannt_am    INTEGER NOT NULL
    )`);
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_verkauf_ereignisse_abdruck ON verkauf_ereignisse(fingerabdruck)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_verkauf_ereignisse_liste ON verkauf_ereignisse(stumm, erkannt_am)');
  } catch (err) {
    console.warn('[db] Indizes für Verkaufsmeldungen:', (err as Error).message);
  }

  /* Einmalcodes — zweiter Faktor fürs Firmenkonto (TOTP). Dieselben zwei
     Tabellen wie in schema.sql, wortgleich (pruefungen/tabellen-abgleich.mts
     prüft das) — auf einer bestehenden Datenbank bringt CREATE TABLE IF NOT
     EXISTS in schema.sql sie nicht zuverlässig nach, aus demselben Grund wie
     bei notizen/mail_wissen oben: hier läuft die Tabelle für sich,
     unabhängig vom Rest von schema.sql. `bezeichnung`, `aussteller`, `konto`
     und `geheimnis` sind mit encryptField (crypto/pii.ts) verschlüsselt —
     siehe services/einmalcode.ts. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS einmalcode_konten (
      id            TEXT PRIMARY KEY,
      bezeichnung   TEXT NOT NULL,
      aussteller    TEXT,
      konto         TEXT,
      geheimnis     TEXT NOT NULL,
      algorithmus   TEXT NOT NULL DEFAULT 'SHA1',
      stellen       INTEGER NOT NULL DEFAULT 6,
      periode       INTEGER NOT NULL DEFAULT 30,
      angelegt_von  TEXT NOT NULL REFERENCES users(id),
      angelegt_am   INTEGER NOT NULL,
      geaendert_von TEXT REFERENCES users(id),
      geaendert_am  INTEGER
    )`);
  /* Wer wann einen Code geholt hat — `konto_id` trägt bewusst KEIN REFERENCES
     … ON DELETE CASCADE, siehe schema.sql für die Begründung (der Nachweis
     muss ein gelöschtes Konto überleben). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS einmalcode_abrufe (
      id          TEXT PRIMARY KEY,
      konto_id    TEXT NOT NULL,
      bezeichnung TEXT NOT NULL,
      user_id     TEXT NOT NULL REFERENCES users(id),
      am          INTEGER NOT NULL
    )`);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_einmalcode_abrufe_am ON einmalcode_abrufe(am DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_einmalcode_abrufe_konto ON einmalcode_abrufe(konto_id)');
  } catch (err) {
    console.warn('[db] Indizes für Einmalcodes:', (err as Error).message);
  }

  /* Passwort-Tresor — dieselben fünf Tabellen wie in schema.sql, wortgleich
     (pruefungen/tabellen-abgleich.mts prüft das), aus demselben Grund wie
     bei Notizen und Einmalcodes oben: CREATE TABLE IF NOT EXISTS in
     schema.sql bringt sie auf einer bestehenden Datenbank nicht zuverlässig
     nach. Ausführliche Begründung des Aufbaus steht dort. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS passwort_eintraege (
      id                 TEXT PRIMARY KEY,
      owner_id           TEXT NOT NULL REFERENCES users(id),
      chiffrat           TEXT NOT NULL,
      version            INTEGER NOT NULL DEFAULT 1,
      schluessel_fassung INTEGER NOT NULL DEFAULT 1,
      geaendert_von      TEXT NOT NULL REFERENCES users(id),
      geaendert_am       INTEGER NOT NULL,
      erstellt_am        INTEGER NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS passwort_mitglieder (
      eintrag_id       TEXT NOT NULL REFERENCES passwort_eintraege(id) ON DELETE CASCADE,
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hinzugefuegt_von TEXT NOT NULL REFERENCES users(id),
      hinzugefuegt_am  INTEGER NOT NULL,
      entfernt_am      INTEGER,
      entfernt_grund   TEXT,
      PRIMARY KEY (eintrag_id, user_id)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS passwort_schluessel_pakete (
      eintrag_id  TEXT NOT NULL REFERENCES passwort_eintraege(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fassung     INTEGER NOT NULL,
      von_user_id TEXT NOT NULL,
      alg         TEXT NOT NULL,
      iv          TEXT NOT NULL,
      daten       TEXT NOT NULL,
      erstellt_am INTEGER NOT NULL,
      PRIMARY KEY (eintrag_id, user_id)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS passwort_konto_pakete (
      eintrag_id    TEXT NOT NULL REFERENCES passwort_eintraege(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fassung       INTEGER NOT NULL,
      konto_fassung INTEGER NOT NULL,
      alg           TEXT NOT NULL,
      iv            TEXT NOT NULL,
      daten         TEXT NOT NULL,
      erstellt_am   INTEGER NOT NULL,
      PRIMARY KEY (eintrag_id, user_id)
    )`);
  /* Das getrennte Geheimnis — wortgleich mit schema.sql, ausführliche
     Begründung steht dort. Für eine BESTEHENDE Datenbank ist das der einzige
     Weg: die Tabelle kommt nach 32 Fassungen dazu, in denen es sie nicht gab.
     Bestehende Einträge haben hier zunächst KEINE Zeile — sie tragen ihr
     Passwort noch in der einen alten Hülle, und nur ein Gerät, das den
     Eintragsschlüssel schon hat, kann das umstellen (services/passwoerter.ts,
     geheimnisAusliefern()/speichern()). Der Server kann es nicht: er hat den
     Schlüssel nicht und soll ihn nicht haben. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS passwort_geheimnisse (
      eintrag_id   TEXT PRIMARY KEY REFERENCES passwort_eintraege(id) ON DELETE CASCADE,
      chiffrat     TEXT NOT NULL,
      fassung      INTEGER NOT NULL,
      geaendert_am INTEGER NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS passwort_offenlegungen (
      id         TEXT PRIMARY KEY,
      eintrag_id TEXT NOT NULL,
      user_id    TEXT NOT NULL REFERENCES users(id),
      am         INTEGER NOT NULL
    )`);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_passwort_eintraege_owner ON passwort_eintraege(owner_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_passwort_mitglieder_user ON passwort_mitglieder(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_passwort_pakete_user ON passwort_schluessel_pakete(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_passwort_konto_pakete_user ON passwort_konto_pakete(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_passwort_offenlegungen_eintrag ON passwort_offenlegungen(eintrag_id, am DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_passwort_offenlegungen_am ON passwort_offenlegungen(am DESC)');
  } catch (err) {
    console.warn('[db] Indizes für den Passwort-Tresor:', (err as Error).message);
  }

  /* Notzugang — dieselben fünf Tabellen wie in schema.sql, wortgleich
     (pruefungen/tabellen-abgleich.mts prüft das), aus demselben Grund wie
     beim Passwort-Tresor darüber. Die ausführliche Begründung des Aufbaus
     steht dort; hier steht nur, was eine BESTEHENDE Datenbank nachholen
     muss. Auf einer solchen gibt es zunächst keine einzige Zeile — ein
     Notzugang entsteht ausschließlich auf einem Gerät, das den
     Kontoschlüssel gerade offen hat, und der Server kann ihn nicht
     nachträglich anlegen. Er hat den Schlüssel nicht und soll ihn nicht
     haben. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS konto_notzugang (
      user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      alg           TEXT NOT NULL,
      iv            TEXT NOT NULL,
      daten         TEXT NOT NULL,
      konto_abdruck TEXT NOT NULL,
      konto_fassung INTEGER NOT NULL,
      schwelle      INTEGER NOT NULL,
      anteile       INTEGER NOT NULL,
      erstellt_am   INTEGER NOT NULL,
      geaendert_am  INTEGER NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notzugang_anteile (
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      halter_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stelle         INTEGER NOT NULL,
      alg            TEXT NOT NULL,
      eph            TEXT NOT NULL,
      iv             TEXT NOT NULL,
      daten          TEXT NOT NULL,
      halter_abdruck TEXT NOT NULL,
      erstellt_am    INTEGER NOT NULL,
      PRIMARY KEY (user_id, halter_id)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notzugang_anfragen (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_abdruck  TEXT NOT NULL,
      stand         TEXT NOT NULL,
      laeuft_ab     INTEGER NOT NULL,
      erstellt_am   INTEGER NOT NULL,
      eingeloest_am INTEGER
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notzugang_beitraege (
      anfrage_id  TEXT NOT NULL REFERENCES notzugang_anfragen(id) ON DELETE CASCADE,
      halter_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stelle      INTEGER NOT NULL,
      alg         TEXT NOT NULL,
      eph         TEXT NOT NULL,
      iv          TEXT NOT NULL,
      daten       TEXT NOT NULL,
      erstellt_am INTEGER NOT NULL,
      PRIMARY KEY (anfrage_id, halter_id)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notzugang_protokoll (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      anfrage_id TEXT,
      art        TEXT NOT NULL,
      halter_id  TEXT,
      am         INTEGER NOT NULL
    )`);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_notzugang_anteile_halter ON notzugang_anteile(halter_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notzugang_anfragen_user ON notzugang_anfragen(user_id, erstellt_am DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notzugang_protokoll_user ON notzugang_protokoll(user_id, am DESC)');
  } catch (err) {
    console.warn('[db] Indizes für den Notzugang:', (err as Error).message);
  }

  /* Indizes auf nachgerüstete Spalten gehören hierher, nicht in schema.sql:
     die läuft VOR dieser Nachrüstung, und auf einer bestehenden Datenbank
     gibt es die Spalte dort noch nicht. Fassung 1.0.17 ist genau daran auf
     dem Server nicht hochgekommen ("no such column: projekt_id") — auf einer
     frischen Datenbank fiel es nicht auf, weil CREATE TABLE die Spalten
     gleich mitbringt. */
  for (const [name, ausdruck] of [
    ['idx_tasks_projekt', 'tasks(projekt_id)'],
    ['idx_tasks_pruefen', 'tasks(von_ki, geprueft_am)'],
  ] as const) {
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${ausdruck}`);
    } catch (err) {
      /* Fehlt die Tabelle noch (ganz frische Datenbank in einer anderen
         Reihenfolge), ist das kein Grund, den Start zu verweigern. */
      console.warn(`[db] Index ${name}:`, (err as Error).message);
    }
  }

  // Die alten UNIQUE-Bedingungen hingen am Klartext. Nach der Verschlüsselung
  // muss die Eindeutigkeit über die Suchwerte laufen.
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_bidx ON users(handle_bidx) WHERE handle_bidx IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_bidx  ON users(email_bidx)  WHERE email_bidx  IS NOT NULL');
  } catch (err) {
    console.warn('[db] Eindeutigkeitsindex für Personendaten:', (err as Error).message);
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256)');
  } catch (err) {
    console.warn('[db] Index für Anhang-Prüfsummen:', (err as Error).message);
  }

  /**
   * Der Index für die Ungelesen-Zählung.
   *
   * store.unreadCounts() fragt `channel_id = ? AND ... AND id > ?`, und diese
   * Abfrage läuft nicht selten: zweimal je Empfänger und ausgelieferter
   * Nachricht, dazu einmal je Kanal bei jeder Anmeldung. Der vorhandene Index
   * liegt auf (channel_id, created_at) — SQLite konnte damit nur den Kanal
   * aufschlagen und musste jede seiner Zeilen ansehen. Der Aufwand wuchs also
   * mit dem Gespräch, nicht mit dem Ungelesenen.
   *
   * Nachgemessen an 200.000 Nachrichten, davon die Hälfte in einem Kanal, im
   * üblichen Fall „fast alles gelesen": 19,8 ms je Aufruf vorher, 0,008 ms
   * nachher. Auf dem Pi ist der Abstand größer.
   */
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id)');
  } catch (err) {
    console.warn('[db] Index für die Ungelesen-Zählung:', (err as Error).message);
  }

  rebuildUsersTable();
  encryptExistingUsers();
  bestehendeTexteVerschluesseln();
  echosVergessen();
  geloeschteNachtragen();
  anonymeUmfragenAnonymisieren();
}

/**
 * Konten, die vor dieser Fassung gelöscht wurden, tragen kein Datum.
 *
 * Erkennbar sind sie am Platzhalternamen: nur so kamen sie zustande. Ohne
 * diesen Nachtrag stünden sie weiter wie gewöhnliche Konten in der Verwaltung —
 * und genau das sah aus, als hätte das Löschen nicht gewirkt.
 */
function geloeschteNachtragen(): void {
  const spalten = db.all<{ name: string }>('PRAGMA table_info(users)');
  if (!spalten.some((c) => c.name === 'deleted_at')) return;

  const offen = db.all<{ id: string }>(
    "SELECT id FROM users WHERE deleted_at IS NULL AND display_name = 'Ehemaliges Mitglied'",
  );
  if (!offen.length) return;
  const jetzt = Date.now();
  db.transaction(() => {
    for (const u of offen) db.run('UPDATE users SET deleted_at = ? WHERE id = ?', jetzt, u.id);
  });
  console.log(`[db] ${offen.length} bereits gelöschte Konten als solche gekennzeichnet.`);
}

/**
 * Bestehende Stimmen zu anonymen Umfragen anonymisieren.
 *
 * Vor dieser Fassung stand `poll_votes(poll_id, option_id, user_id)` für
 * JEDE Umfrage — auch für anonyme, wo die Oberfläche seit jeher zusagt: "Es
 * wird nur gezählt, nicht wer gestimmt hat". Die Zusage stimmte für die
 * Anzeige, nicht für die Datenbank: die Zuordnung Person→Antwort lag für
 * anonyme Umfragen genauso offen da wie für offene.
 *
 * Diese Wanderung holt das nach, einmalig und für jede anonyme Umfrage
 * einzeln: die Zählung je Antwort zieht nach poll_options.votes um, WER
 * abgestimmt hat nach poll_participants (ohne Bezug auf die Antwort — nötig,
 * damit dieselbe Person nicht ein zweites Mal abstimmen kann), und die Zeilen
 * in poll_votes, die die beiden verknüpften, werden gelöscht. Für offene
 * Umfragen bleibt poll_votes unangetastet — dort ist genau diese Verknüpfung
 * die einzige Quelle für Gesichter unter den Antworten und für "Stimme
 * ändern".
 *
 * IDEMPOTENT OHNE MERKER: eine anonyme Umfrage, deren poll_votes-Zeilen schon
 * weg sind, liefert bei der Abfrage unten nichts mehr und wird übersprungen —
 * anders als bei bestehendeTexteVerschluesseln() braucht es dafür keinen
 * Vermerk in app_settings, denn selbst eine Datenbank mit tausend Umfragen
 * ist eine Abfrage, die auf jedem Start vernachlässigbar wenig kostet.
 *
 * Der Zeitpunkt in poll_participants ist nicht der Zeitpunkt dieser
 * Wanderung, sondern die früheste erhaltene Stimme der Person in dieser
 * Umfrage — erfunden wird hier nichts, was sich aus den vorhandenen Zeilen
 * ablesen lässt.
 */
function anonymeUmfragenAnonymisieren(): void {
  if (!db.all('PRAGMA table_info(poll_participants)').length) return;
  const spalten = db.all<{ name: string }>('PRAGMA table_info(poll_options)');
  if (!spalten.some((c) => c.name === 'votes')) return;

  const anonyme = db.all<{ id: string }>('SELECT id FROM polls WHERE anonymous = 1');
  let betroffen = 0;
  for (const { id: pollId } of anonyme) {
    const stimmen = db.all<{ option_id: string; user_id: string; created_at: number }>(
      'SELECT option_id, user_id, created_at FROM poll_votes WHERE poll_id = ?', pollId,
    );
    if (!stimmen.length) continue;   // schon anonymisiert, oder nie eine Stimme

    db.transaction(() => {
      const jeOption = new Map<string, number>();
      const fruehesteStimme = new Map<string, number>();
      for (const s of stimmen) {
        jeOption.set(s.option_id, (jeOption.get(s.option_id) ?? 0) + 1);
        const bisher = fruehesteStimme.get(s.user_id);
        if (bisher === undefined || s.created_at < bisher) fruehesteStimme.set(s.user_id, s.created_at);
      }
      for (const [optionId, anzahl] of jeOption) {
        db.run('UPDATE poll_options SET votes = votes + ? WHERE id = ?', anzahl, optionId);
      }
      for (const [userId, zeitpunkt] of fruehesteStimme) {
        db.run(
          'INSERT OR IGNORE INTO poll_participants (poll_id, user_id, created_at) VALUES (?,?,?)',
          pollId, userId, zeitpunkt,
        );
      }
      db.run('DELETE FROM poll_votes WHERE poll_id = ?', pollId);
    });
    betroffen += 1;
  }
  if (betroffen) {
    console.log(`[db] ${betroffen} anonyme Umfrage(n): Zuordnung Person→Antwort aus der Datenbank entfernt, Zählung erhalten.`);
  }
}

/**
 * Nachrichten, die vor der Umstellung im Klartext angelegt wurden,
 * nachträglich verschlüsseln.
 *
 * In Schritten von tausend Zeilen und in einer Transaktion: auf einem
 * Raspberry Pi mit hunderttausend Nachrichten soll der Start nicht am
 * Speicher scheitern. Wer schon verschlüsselt ist, wird übersprungen —
 * der Durchlauf darf jederzeit abbrechen und beim nächsten Start weitergehen.
 */
function bestehendeTexteVerschluesseln(): void {
  if (!verschluesselungAktiv()) return;

  const tabellen: { tabelle: string; schluessel: string }[] = [
    { tabelle: 'messages', schluessel: 'id' },
    { tabelle: 'message_translations', schluessel: 'rowid' },
    { tabelle: 'scheduled_messages', schluessel: 'id' },
    { tabelle: 'drafts', schluessel: 'rowid' },
    { tabelle: 'voice_transcripts', schluessel: 'attachment_id' },
    { tabelle: 'poll_options', schluessel: 'id' },
  ];

  /* Umfragen und der Übersetzungsspeicher tragen ihren Text in anders
     benannten Spalten. Der Zwischenspeicher lag am längsten offen: dort stehen
     Quelle und Übersetzung jeder je übersetzten Nachricht nebeneinander. */
  const sonderfaelle: { tabelle: string; spalte: string; schluessel: string }[] = [
    { tabelle: 'polls', spalte: 'question', schluessel: 'id' },
    { tabelle: 'poll_translations', spalte: 'payload', schluessel: 'rowid' },
    { tabelle: 'translation_memory', spalte: 'source_text', schluessel: 'key' },
    { tabelle: 'translation_memory', spalte: 'target_text', schluessel: 'key' },
    /* Der Grund einer Freigabe steht in der Systemnachricht im Kanal und ist
       damit ohnehin sichtbar — in der Datenbank hat er trotzdem nichts im
       Klartext zu suchen, wie jeder andere geschriebene Satz auch. */
    { tabelle: 'vertraulich_freigaben', spalte: 'grund', schluessel: 'id' },
    /* Die Begründung eines KI-Gruppenvorschlags fasst den Inhalt einer
       fremden Mail zusammen ("Bewerbung als …") — derselbe Stoff, der in
       mail_nachrichten verschlüsselt liegt. Sie lag bis zu
       services/post-partnergruppen.ts::vorschlagEintragen() im Klartext. */
    { tabelle: 'mail_partner', spalte: 'gruppe_begruendung', schluessel: 'adresse_bidx' },
  ];

  let gesamt = 0;
  for (const { tabelle, schluessel } of tabellen) {
    if (!db.all(`PRAGMA table_info(${tabelle})`).length) continue;
    for (;;) {
      const offen = db.all<{ k: string | number; text: string }>(
        `SELECT ${schluessel} AS k, text FROM ${tabelle}
         WHERE text IS NOT NULL AND text <> '' AND substr(text, 1, 3) <> 'm1:' LIMIT 1000`,
      ).filter((r) => !istChiffrat(r.text));
      if (!offen.length) break;
      db.transaction(() => {
        for (const r of offen) {
          db.run(`UPDATE ${tabelle} SET text = ? WHERE ${schluessel} = ?`, verschluesseln(r.text), r.k);
        }
      });
      gesamt += offen.length;
    }
  }

  for (const { tabelle, spalte, schluessel } of sonderfaelle) {
    if (!db.all(`PRAGMA table_info(${tabelle})`).length) continue;
    for (;;) {
      const offen = db.all<{ k: string | number; wert: string }>(
        `SELECT ${schluessel} AS k, ${spalte} AS wert FROM ${tabelle}
         WHERE ${spalte} IS NOT NULL AND ${spalte} <> '' AND substr(${spalte}, 1, 3) <> 'm1:' LIMIT 1000`,
      ).filter((r) => !istChiffrat(r.wert));
      if (!offen.length) break;
      db.transaction(() => {
        for (const r of offen) {
          db.run(`UPDATE ${tabelle} SET ${spalte} = ? WHERE ${schluessel} = ?`, verschluesseln(r.wert), r.k);
        }
      });
      gesamt += offen.length;
    }
  }

  uebersetzungsspeicherPruefen();

  if (gesamt) {
    console.log(`[db] ${gesamt} gespeicherte Texte nachträglich verschlüsselt.`);
  }
}

/**
 * Passen die Schlüsselwerte im Übersetzungsspeicher noch?
 *
 * HIER STAND EINE PRÜFUNG, DIE NIE ETWAS GEMESSEN HAT
 * Der Schlüsselwert entstand früher als sha1 über den Klartext, heute als
 * HMAC mit dem Hausschlüssel. Beide sind vierzig Hexzeichen lang. Der Nachlauf
 * versuchte trotzdem, sie an der Zeichenkette zu unterscheiden: gezählt wurde
 * `length(key) = 40`, gelöscht `length(key) <> 40`. Die Bedingung traf auf
 * jeden Eintrag zu, das DELETE auf keinen — der Aufräumlauf lief bei jedem
 * Start und tat nichts. Die Meldung „Einträge verworfen" kam nie, und niemand
 * hat sie vermisst.
 *
 * Am Schlüssel selbst lässt sich das nicht entscheiden, also wird es
 * aufgeschrieben — dieselbe Machart wie beim Volltextindex nebenan. Die
 * Kennung entsteht aus dem Hausschlüssel: kommt später ein Masterpasswort
 * dazu oder fällt es weg, ändert sie sich, und dann passt wirklich kein
 * gespeicherter Wert mehr. Genau dann, und nur dann, wird geleert.
 *
 * Beim ersten Lauf nach dieser Änderung wird nichts weggeworfen, sondern nur
 * vermerkt. Die vorhandenen Einträge sind mit dem heutigen Schlüssel
 * entstanden und werden weiter gefunden; sie jetzt zu verwerfen hieße, jede
 * Übersetzung noch einmal zu bezahlen. Was aus der sha1-Zeit übrig ist, bleibt
 * damit liegen — unauffindbar, aber verschlüsselt und harmlos, und es gibt
 * kein Merkmal, an dem man es erkennen könnte.
 */
function uebersetzungsspeicherPruefen(): void {
  try {
    if (!db.all('PRAGMA table_info(translation_memory)').length) return;
    /* Dieselbe Kennung, nur an einer Stelle: db/schluesselprobe.ts hält das
       Rezept, weil dort die Prüfung sitzt, die einen Schlüsselwechsel MELDET,
       statt nur den Übersetzungsspeicher zu leeren. Der Wert bleibt Zeichen
       für Zeichen derselbe — sonst hielte jede bestehende Installation den
       nächsten Start für einen Wechsel und würfe ihren Speicher weg. */
    const kennung = tmKennung();
    const stand = db.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'tm_format'",
    )?.value;

    if (stand && stand !== kennung) {
      const weg = db.run('DELETE FROM translation_memory');
      if (weg.changes) {
        console.log(`[db] ${weg.changes} Einträge im Übersetzungsspeicher verworfen — der Schlüsselwert hat sich geändert.`);
      }
    }
    if (stand !== kennung) {
      db.run(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('tm_format', ?, NULL, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        kennung, Date.now(),
      );
    }
  } catch (err) {
    console.warn('[db] Übersetzungsspeicher:', (err as Error).message);
  }
}

/**
 * Die ursprüngliche users-Tabelle hatte UNIQUE auf handle und email im
 * Klartext. Seit beide verschlüsselt sind, gehört die Eindeutigkeit an die
 * Suchwerte (handle_bidx, email_bidx) — als partieller Index, der mehrere
 * NULL-Werte erlaubt.
 *
 * Die alte Bedingung ist nicht nur überflüssig, sie ist falsch: Konten ohne
 * E-Mail speichern alle denselben leeren Wert und kollidieren miteinander.
 * Man konnte also genau ein Konto ohne E-Mail anlegen.
 *
 * SQLite kann Bedingungen nicht einzeln entfernen, deshalb wird die Tabelle
 * einmalig neu aufgebaut.
 *
 * DRITTER ANLAUF FÜR DENSELBEN FEHLER — diesmal an der Wurzel, nicht am Symptom.
 * `CREATE TABLE users_neu` stand hier früher als eigene, von Hand getippte
 * Spaltenliste: eine DRITTE Liste neben COLUMNS oben und der Basisdefinition
 * in schema.sql, die von Hand mit beiden Schritt halten musste. Am 19.08.
 * (Commit 5052828, "users-Neuaufbau vollständig") bekam sie fünf fehlende
 * Spalten nachgetragen, weil genau dieses Auseinanderlaufen den Server nicht
 * mehr starten ließ ("table users_neu has no column named ..."). Drei Tage
 * später fehlte `timezone_auto` auf dieselbe Art — dieselbe Ursache, DRITTES
 * Mal. Eine von Hand gepflegte Liste, die mit zwei anderen Stellen Schritt
 * halten muss, ist kein Unfall, der irgendwann von selbst aufhört, sondern
 * eine Frage der Zeit bis zum nächsten Mal. WER HIER WIEDER EINE FESTE LISTE
 * HINSCHREIBT, FÜHRT DENSELBEN FEHLER EIN VIERTES MAL EIN — bitte nicht.
 *
 * Deshalb jetzt keine dritte Liste mehr: `users_neu` entsteht aus der
 * Spaltendefinition, wie SQLite sie für die LEBENDE `users`-Tabelle in genau
 * diesem Moment kennt (PRAGMA table_info) — also inklusive jeder Spalte, die
 * die COLUMNS-Nachrüstung weiter oben in dieser Datei VOR diesem Aufruf schon
 * ergänzt hat (siehe migrate(): die Schleife über COLUMNS läuft vor
 * rebuildUsersTable()). Wer COLUMNS künftig um eine weitere users-Spalte
 * erweitert — wie es zwischen den beiden vorigen Ausfällen bereits zweimal
 * passiert ist, ohne dass hier je etwas von Hand nachgezogen wurde —, muss an
 * dieser Stelle nichts mehr tun: die nächste Zeile, die COLUMNS ergänzt,
 * kommt automatisch mit, auch wenn sie erst NACH diesem Umbau hinzukommt.
 *
 * Dass dabei ausgerechnet das alte UNIQUE nicht mit herüberkommt, ist kein
 * Zufall, um den man sich weiter kümmern müsste: PRAGMA table_info liefert
 * ausschließlich Spalten-Metadaten (Name, Typ, NOT NULL, DEFAULT, ob Teil
 * des Primärschlüssels) — Tabellen- oder Spalten-UNIQUE gehört nicht dazu,
 * ganz gleich, ob die Ursprungstabelle sie als `UNIQUE(handle)` oder als
 * `handle ... UNIQUE` geschrieben hat. Ein CREATE TABLE, das ausschließlich
 * aus table_info-Zeilen zusammengesetzt wird, KANN die alte Eindeutigkeits-
 * bedingung also gar nicht mehr enthalten — das ist die ganze Absicht dieser
 * Funktion, jetzt durch die Bauart erzwungen statt durch Sorgfalt beim
 * Abtippen erhofft.
 */
function rebuildUsersTable(): void {
  const definition = db.get<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  )?.sql;
  if (!definition || !/UNIQUE/i.test(definition)) return;   // schon erledigt

  const spalten = db.all<{
    name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }>('PRAGMA table_info(users)');
  /* users hat seit jeher genau eine Primärschlüssel-Spalte (id). Unten wird
     PRIMARY KEY je Spalte einzeln angehängt — bei mehr als einer pk-Spalte
     entstünde damit stillschweigend falsches SQL (mehrere eigenständige
     PRIMARY KEY statt einem zusammengesetzten). Lieber hier laut scheitern
     als eine kaputte CREATE TABLE erzeugen, die erst beim Ausführen auffällt. */
  if (spalten.filter((c) => c.pk > 0).length > 1) {
    throw new Error('rebuildUsersTable(): users hat einen zusammengesetzten Primärschlüssel — diese Funktion setzt genau eine PRIMARY-KEY-Spalte voraus und muss angepasst werden.');
  }
  const liste = spalten.map((c) => c.name).join(', ');
  /* dflt_value kommt von SQLite bereits als einsetzbarer SQL-Ausdruck zurück
     (bei TEXT inklusive der Anführungszeichen, z. B. "'#7c5cff'") — nicht als
     Rohwert, der erst noch zitiert werden müsste. */
  const definitionenNeu = spalten.map((c) => {
    let teil = `${c.name} ${c.type}`;
    if (c.notnull) teil += ' NOT NULL';
    if (c.dflt_value !== null) teil += ` DEFAULT ${c.dflt_value}`;
    if (c.pk) teil += ' PRIMARY KEY';
    return teil;
  }).join(',\n          ');

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_neu (
          ${definitionenNeu}
        )
      `);
      db.exec(`INSERT INTO users_neu (${liste}) SELECT ${liste} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_neu RENAME TO users');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_bidx ON users(handle_bidx) WHERE handle_bidx IS NOT NULL');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_bidx  ON users(email_bidx)  WHERE email_bidx  IS NOT NULL');
    });
    console.log('[db] users-Tabelle neu aufgebaut: Eindeutigkeit liegt jetzt auf den Suchwerten.');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Bestehende Konten nachträglich verschlüsseln.
 * Läuft nur, solange noch Klartext dasteht — danach passiert nichts mehr.
 */
function encryptExistingUsers(): void {
  const spalten = db.all<{ name: string }>('PRAGMA table_info(users)');
  if (!spalten.some((c) => c.name === 'handle_bidx')) return;
  if (!encryptionActive()) return;   // ohne Masterpasswort bleibt alles wie es ist

  /* Nicht am fehlenden Blind-Index festmachen: den schreibt createAccount
     immer, auch ohne Masterpasswort (dann eben mit dem Ersatzschlüssel).
     Konten aus dieser Zeit blieben sonst für immer im Klartext stehen. Das
     fehlende Chiffrat-Präfix ist das ehrliche Merkmal. */
  const offen = db.all<{ id: string; handle: string; email: string }>(
    "SELECT id, handle, email FROM users WHERE handle NOT LIKE 'v1:%'",
  );
  if (!offen.length) return;

  db.transaction(() => {
    for (const u of offen) {
      db.run(
        'UPDATE users SET handle = ?, handle_bidx = ?, email = ?, email_bidx = ? WHERE id = ?',
        encryptField(u.handle), blindIndex(u.handle),
        encryptField(u.email), blindIndex(u.email),
        u.id,
      );
    }
  });
  console.log(`[db] ${offen.length} Konten verschlüsselt (E-Mail und Benutzername).`);
}

/**
 * Unübersetzte Texte aus dem Übersetzungsspeicher werfen.
 *
 * Bis 1.0.26 wurde jede Modellantwort gemerkt — auch die, in denen das Modell
 * den Eingabetext unverändert zurückgegeben hatte. Damit war dieser Text
 * dauerhaft unübersetzt: jeder spätere Treffer kam aus dem Speicher und
 * bekam nie wieder eine Chance. Gemessen wurden 356 solcher Meldungen an
 * einem Tag, bei keinem einzigen gescheiterten Nachfassen.
 *
 * Der Fehler selbst ist behoben (index.ts merkt Echos nicht mehr), aber die
 * bereits gemerkten Zeilen blockieren weiter. Sie stehen verschlüsselt in der
 * Datenbank, lassen sich also nicht mit SQL vergleichen — es bleibt der
 * Durchgang durch alle Zeilen.
 *
 * HÖCHSTENS EINMAL, NICHT BEI JEDEM START.
 * Ein Merker in app_settings hält fest, dass aufgeräumt wurde — dasselbe
 * Muster wie bei `uebersetzungsspeicherPruefen` nebenan. Ohne ihn läse und
 * entschlüsselte jeder Start erneut bis zu 50 000 Zeilen, obwohl es nach dem
 * ersten erfolgreichen Durchgang nichts mehr zu finden gibt.
 *
 * Läuft deshalb auch NACH `bestehendeTexteVerschluesseln()` (die wiederum
 * `uebersetzungsspeicherPruefen` aufruft), nicht davor: hat sich der
 * Schlüssel seit dem letzten Start geändert, LEERT diese Prüfung
 * `translation_memory` bereits vollständig, weil dann ohnehin kein
 * gespeicherter Wert mehr zum aktuellen Schlüssel passt. Liefe dieser
 * Durchgang vorher, entschlüsselte und bewertete er bis zu 50 000 Zeilen, die
 * Sekunden später im selben Start weggeworfen werden — reine Arbeit für den
 * Papierkorb.
 *
 * Bei fehlendem ODER falschem Masterpasswort läuft gar nichts an: ohne
 * Schlüssel gibt es nichts zu entschlüsseln, und mit einem Schlüssel, der
 * nicht zu den vorhandenen Chiffraten passt, schlägt jede Zeile fehl — nicht
 * nur, aber auch weil `entschluesseln` bei jedem Fehlschlag eine eigene
 * Fehlermeldung schreibt, macht ein Durchgang durch alle Zeilen daraus
 * zehntausende Meldungen synchron im Journal. Eine einzelne Probezeile
 * VORAB reicht: derselbe Schlüssel gilt für alle Zeilen, schlägt also entweder
 * keine oder (praktisch) jede fehl. Schlägt die Probe fehl, bricht die
 * Funktion ab, OHNE den Merker unten zu setzen — ein späterer Start mit dem
 * richtigen Masterpasswort bekommt dadurch weiterhin seine Chance.
 */
function echosVergessen(): void {
  if (!verschluesselungAktiv()) return;  // kein Masterpasswort — nichts zu entschlüsseln

  const erledigt = db.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'echos_vergessen'",
  )?.value;
  if (erledigt === '1') return;          // schon einmal erfolgreich gelaufen

  let zeilen: Array<{ key: string; source_text: string; target_text: string }>;
  try {
    zeilen = db.all('SELECT key, source_text, target_text FROM translation_memory LIMIT 50000');
  } catch { return; }              // Tabelle gibt es noch nicht

  if (zeilen.length) {
    // Probezeile: siehe Erklärung oben. Nur eine bereits verschlüsselte Zeile
    // taugt als Probe (am "m1:"-Kopf erkennbar, wie in
    // bestehendeTexteVerschluesseln) — reiner Klartext aus der Zeit vor der
    // Verschlüsselung bliebe bei jedem Schlüssel unverändert lesbar und
    // sagte damit nichts darüber, ob der aktuelle Schlüssel zu den echten
    // Chiffraten in dieser Tabelle passt.
    const probe = zeilen.find((z) => z.source_text.startsWith('m1:'));
    if (probe && !entschluesseln(probe.source_text)) return;

    const weg: string[] = [];
    for (const z of zeilen) {
      const quelle = entschluesseln(z.source_text);
      const ziel = entschluesseln(z.target_text);
      /* Leer heißt NICHT gleich — sonst wäre nach einer fehlgeschlagenen
         Probe (die den Durchgang oben schon abgebrochen hätte) oder bei
         einer einzelnen unlesbaren Zeile jede „Übersetzung" ein Treffer. */
      if (!quelle || !ziel) continue;
      /* Dieselbe Untergrenze wie `istEcho` im Schreibpfad.
         Unter drei Wörtern gilt ein unveränderter Text dort ausdrücklich
         NICHT als Echo: „ok", „+1", „Update" oder ein Firmenname lauten in
         beiden Sprachen gleich, und die unveränderte Rückgabe ist die
         richtige Antwort. Der Schreibpfad merkt solche Zeilen deshalb mit
         Absicht. Ohne diese Grenze löscht das Aufräumen sie wieder weg — und
         arbeitet damit gegen die Stelle, die es aufräumen soll. */
      if (woerter(quelle).length < ECHO_MIN_WOERTER) continue;
      /* Genau gleich, nicht ähnlich: `istEcho` wertet auch Wortähnlichkeit,
         und was dort knapp durchging, ist hier keine sichere Fehlmessung.
         Gelöscht wird nur, was zweifelsfrei unübersetzt ist. */
      if (quelle === ziel) weg.push(z.key);
    }
    if (weg.length) {
      db.transaction(() => {
        for (const k of weg) db.run('DELETE FROM translation_memory WHERE key = ?', k);
      });
      console.log(`[db] ${weg.length} unübersetzte Einträge aus dem Übersetzungsspeicher entfernt`);
    }
  }

  db.run(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('echos_vergessen', '1', NULL, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    Date.now(),
  );
}
