import { istE2EChiffrat, languageInfo, mentionsEveryone, extractMentions } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { assistant as aiProvider } from '../translation/index.js';
import { fensterFuer, fensterVerkleinern, markenSchaetzung, verlaufsBudget } from '../translation/fenster.js';
import { mitKennung } from '../translation/fehler.js';
import { createAccount } from './users.js';
import { encryptField, blindIndex } from '../crypto/pii.js';
import { entschluesseln } from '../crypto/nachrichten.js';
import { Abweisung } from '../util/abweisung.js';

/**
 * Der KI-Assistent als Gesprächspartner.
 *
 * Er ist ein ganz normales Konto mit der Rolle "bot" — dadurch erscheinen
 * seine Antworten als echte Nachrichten, laufen durch die Übersetzung und
 * landen in der Suche. Kein Sonderweg in der Darstellung.
 *
 * Zwei Betriebsarten:
 *   Privater Chat    eine Direktnachricht mit ihm, die nur die Person sieht.
 *   Gemeinsamer Kanal ein Kanal, in dem das ganze Team mit ihm spricht.
 */

export const ASSISTANT_HANDLE = 'stelliumai';
export const ASSISTANT_NAME = 'StelliumAI';

/** Frühere Namen des Assistenten — nötig, um Altbestände umzuziehen. */
const FRUEHERE_HANDLES = ['ki'];
export const TEAM_CHANNEL = 'ki-team';

export type AiMode = 'off' | 'mention' | 'always';

/**
 * Konto des Assistenten, bei Bedarf angelegt.
 *
 * "Bei Bedarf" heißt: erst suchen, dann anlegen — und genau dieser Abstand
 * zwischen Suchen und Schreiben ist eine Wettlaufbedingung, keine Formalie.
 * Läuft dieser Aufruf zweimal nah beieinander (zwei Serverstarts, ein Start
 * mitten in einem laufenden zweiten Prozess), können beide die erste SELECT
 * leer sehen und beide anlegen. Der partielle eindeutige Index auf
 * handle_bidx (db/migrate.ts, idx_users_handle_bidx) fängt den Fall ab, in
 * dem beide Aufrufe *denselben* Blind-Index berechnet haben: die zweite
 * INSERT scheitert dann an der Datenbank statt in der Anwendung, und der
 * catch unten holt sich über eine erneute SELECT einfach die Kennung, die
 * der andere Aufruf gerade angelegt hat — dasselbe Muster wie bei
 * idx_vorschlaege_dublette.
 *
 * Was das NICHT abfängt: läuft blindIndex() bei den beiden Aufrufen mit
 * unterschiedlichem Schlüssel (Masterpasswort zur Startzeit nicht dieselbe),
 * ergeben sich für denselben Klartext "stelliumai" zwei verschiedene,
 * beide für sich genommen gültige handle_bidx-Werte — der Index sieht dann
 * gar keinen Konflikt, weil er nur gleiche Werte als Dublette erkennt.
 *
 * Ein früherer Kommentar behauptete hier, genau das sei am 18./19.08. passiert
 * (zwei Bot-Konten, ~2,4 Stunden auseinander). Das war falsch und ist am
 * 22.08. an der laufenden Datenbank widerlegt worden: Das zweite Bot-Konto
 * heißt @claude und wurde von Hand angelegt — zwei verschiedene Namen ergeben
 * selbstverständlich zwei verschiedene Abdrücke. Alle acht Konten passen zum
 * aktuellen Schlüssel, alle Nachrichten sind lesbar, das Masterpasswort hat
 * nie gewechselt. Die Lehre daraus: ein zeitlicher Abstand belegt keine
 * Ursache.
 *
 * Der Mechanismus bleibt trotzdem real — dieselbe blindIndex()-Suche trägt
 * handleTaken()/emailTaken() und den Login (services/users.ts). Ein Wechsel
 * des Masterpassworts, der nicht alle vorhandenen Zeilen neu indiziert, macht
 * bestehende Konten unauffindbar, nicht nur diesen einen Bot. Deshalb prüft
 * db/schluesselprobe.ts das beim Start und lässt den Server gar nicht erst
 * hochkommen, wenn der Schlüssel nicht zu den Daten passt.
 */
export function ensureAssistant(): string {
  const vorhanden = db.get<{ id: string }>(
    'SELECT id FROM users WHERE handle_bidx = ?', blindIndex(ASSISTANT_HANDLE),
  );
  if (vorhanden) return vorhanden.id;

  // Die KI hieß früher @ki. Bestehende Installationen sollen dabei nicht
  // plötzlich zwei Assistenten haben — also umbenennen statt neu anlegen.
  for (const alt of FRUEHERE_HANDLES) {
    const bot = db.get<{ id: string }>(
      "SELECT id FROM users WHERE handle_bidx = ? AND role = 'bot'", blindIndex(alt),
    );
    if (!bot) continue;
    db.run(
      'UPDATE users SET handle = ?, handle_bidx = ?, display_name = ? WHERE id = ?',
      encryptField(ASSISTANT_HANDLE), blindIndex(ASSISTANT_HANDLE), ASSISTANT_NAME, bot.id,
    );
    console.log(`[ki] Assistent von @${alt} auf @${ASSISTANT_HANDLE} umbenannt.`);
    return bot.id;
  }

  let konto;
  try {
    konto = createAccount({
      displayName: ASSISTANT_NAME,
      handle: ASSISTANT_HANDLE,
      role: 'bot',
      language: 'de',
      timezone: 'UTC',
      createdBy: 'system',
    });
  } catch (err) {
    // Zwischen der SELECT oben und dieser INSERT hat ein zweiter Aufruf
    // gewonnen — entweder über handleTaken() (Abweisung, freundlicher Fall)
    // oder weil createAccount() selbst noch schneller war und erst die
    // UNIQUE-Bedingung der Datenbank zugeschlagen hat (roher Fehler aus
    // node:sqlite). Beides heißt: der Assistent existiert jetzt, nur eben
    // durch den anderen Aufruf. Erneut suchen statt einen zweiten anzulegen.
    const bereitsVorhanden = err instanceof Abweisung
      ? err.code === 'fehler.benutzernameVergeben'
      : /UNIQUE constraint failed/i.test((err as Error).message ?? '');
    if (!bereitsVorhanden) throw err;

    const jetztVorhanden = db.get<{ id: string }>(
      'SELECT id FROM users WHERE handle_bidx = ?', blindIndex(ASSISTANT_HANDLE),
    );
    if (jetztVorhanden) return jetztVorhanden.id;
    throw err;   // handle_bidx wich ab (anderer Schlüssel) — kein Gewinner auffindbar
  }

  // Ein Bot richtet nichts ein und meldet sich nie selbst an.
  db.run(
    `UPDATE users SET must_change_password = 0, must_complete_profile = 0,
            status = 'online', avatar_color = '#7c5cff', title = 'Assistent',
            auto_translate = 0
     WHERE id = ?`,
    konto.userId,
  );
  console.log(`[ki] Assistenten-Konto @${ASSISTANT_HANDLE} angelegt.`);
  return konto.userId;
}

/**
 * Bestehende Direktchats mit dem Assistenten auf "antwortet immer" setzen.
 * Nötig für Chats, die über die normale DM-Liste entstanden sind, bevor die
 * Zuordnung am Gesprächspartner hing.
 */
export function repairAssistantChats(): void {
  const bot = assistantUserId();
  if (!bot) return;
  const betroffen = db.all<{ id: string }>(
    `SELECT c.id FROM channels c
     JOIN channel_members m ON m.channel_id = c.id
     WHERE c.kind = 'dm' AND m.user_id = ? AND c.ai_mode <> 'always'`,
    bot,
  );
  for (const c of betroffen) {
    db.run("UPDATE channels SET ai_mode = 'always' WHERE id = ?", c.id);
  }
  if (betroffen.length) {
    console.log(`[ki] ${betroffen.length} stumme Direktchats mit dem Assistenten aktiviert.`);
  }
}

export function assistantUserId(): string | null {
  return db.get<{ id: string }>('SELECT id FROM users WHERE handle_bidx = ?', blindIndex(ASSISTANT_HANDLE))?.id ?? null;
}

export function isAssistant(userId: string): boolean {
  return userId === assistantUserId();
}

/** Gemeinsamer Kanal, in dem das ganze Team mit der KI spricht. */
export function ensureTeamChannel(ownerId: string): string {
  const vorhanden = db.get<{ id: string }>(
    "SELECT id FROM channels WHERE kind = 'public' AND lower(name) = ?", TEAM_CHANNEL,
  );
  const botId = ensureAssistant();
  const jetzt = Date.now();

  if (vorhanden) {
    db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)',
      vorhanden.id, botId, jetzt);
    return vorhanden.id;
  }

  const id = newId('ch_');
  db.transaction(() => {
    db.run(
      `INSERT INTO channels (id, kind, name, topic, purpose, primary_language, archived, ai_mode, created_by, created_at)
       VALUES (?, 'public', ?, ?, ?, NULL, 0, 'always', ?, ?)`,
      id, TEAM_CHANNEL,
      'Gemeinsamer Draht zum KI-Assistenten',
      'Hier redet das ganze Team mit der KI. Sie antwortet auf jede Nachricht und liest den Verlauf mit.',
      ownerId, jetzt,
    );
    for (const uid of db.all<{ id: string }>('SELECT id FROM users').map((u) => u.id)) {
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', id, uid, jetzt);
    }
  });
  return id;
}

/** Privater Chat zwischen einer Person und dem Assistenten. */
export function openPrivateChat(userId: string): string {
  const botId = ensureAssistant();
  const key = [userId, botId].sort().join(':');
  const vorhanden = db.get<{ id: string }>('SELECT id FROM channels WHERE dm_key = ?', key);
  if (vorhanden) {
    db.run("UPDATE channels SET ai_mode = 'always' WHERE id = ?", vorhanden.id);
    return vorhanden.id;
  }

  const id = newId('dm_');
  const jetzt = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO channels (id, kind, name, topic, purpose, primary_language, archived, dm_key, ai_mode, created_by, created_at)
       VALUES (?, 'dm', '', NULL, NULL, NULL, 0, ?, 'always', ?, ?)`,
      id, key, userId, jetzt,
    );
    for (const uid of [userId, botId]) {
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', id, uid, jetzt);
    }
  });
  return id;
}

export function aiModeOf(channelId: string): AiMode {
  return (db.get<{ ai_mode: string }>('SELECT ai_mode FROM channels WHERE id = ?', channelId)?.ai_mode ?? 'off') as AiMode;
}

export function setAiMode(channelId: string, mode: AiMode): void {
  db.run('UPDATE channels SET ai_mode = ? WHERE id = ?', mode, channelId);
  const botId = ensureAssistant();
  if (mode === 'off') return;
  db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)',
    channelId, botId, Date.now());
}

/** Soll der Assistent auf diese Nachricht antworten? */
export function shouldAnswer(channelId: string, text: string, authorId: string): boolean {
  if (isAssistant(authorId)) return false;          // nicht mit sich selbst reden
  const mode = aiModeOf(channelId);
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // "mention": nur wenn er direkt angesprochen wird
  const erwaehnt = extractMentions(text);
  // Der alte Name wird weiter verstanden, damit niemand ins Leere schreibt.
  return erwaehnt.includes(ASSISTANT_HANDLE)
    || FRUEHERE_HANDLES.some((alt) => erwaehnt.includes(alt))
    || mentionsEveryone(text);
}

/* ── Antwort erzeugen ─────────────────────────────────────────── */

interface VerlaufZeile {
  user_id: string; text: string; created_at: number;
  display_name: string; handle: string;
}

const VERLAUF_LAENGE = 40;

export class AssistantUnavailable extends Error {
  constructor() { super('Der KI-Assistent ist nicht konfiguriert.'); }
}

/**
 * Antwort auf den bisherigen Verlauf. Der Assistent bekommt bewusst nur den
 * Kanal, in dem er angesprochen wurde — nicht den ganzen Arbeitsbereich.
 */
export async function generateReply(channelId: string, ansprache: 'privat' | 'team'): Promise<string> {
  const ai = aiProvider();
  if (!ai) throw new AssistantUnavailable();

  const botId = assistantUserId();
  const zeilen = db.all<VerlaufZeile>(
    `SELECT m.user_id, m.text, m.created_at, u.display_name, u.handle
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.system_kind IS NULL
     ORDER BY m.created_at DESC LIMIT ?`,
    channelId, VERLAUF_LAENGE,
  ).reverse().map((z) => ({ ...z, text: entschluesseln(z.text) }))
    /* Rückhalt, kein Ersatz — derselbe wie in services/ai.ts (zeile()): ist
       ein Kanal nicht mehr vertraulich, bleibt sein alter Verlauf trotzdem
       Chiffrat (vertraulich.ausschalten()), und der ginge sonst als Anfrage
       an einen fremden Dienst. */
    .filter((z) => !istE2EChiffrat(z.text));

  if (!zeilen.length) {
    return ansprache === 'team'
      ? 'Ich bin dabei. Schreibt einfach, was ihr braucht — ich lese diesen Kanal mit.'
      : 'Ich bin da. Was brauchst du?';
  }

  // Sprache aus der letzten menschlichen Nachricht — so antwortet er in der
  // Sprache, in der man ihn angesprochen hat.
  const letzte = [...zeilen].reverse().find((z) => z.user_id !== botId);
  const sprache = letzte
    ? db.get<{ source_lang: string | null }>(
        'SELECT source_lang FROM messages WHERE channel_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
        channelId, letzte.user_id,
      )?.source_lang ?? 'de'
    : 'de';
  const zielsprache = languageInfo(sprache);

  const beteiligte = [...new Map(zeilen.filter((z) => z.user_id !== botId).map((z) => [z.user_id, z])).values()]
    .map((z) => z.display_name);

  const system = [
    `Du bist "${ASSISTANT_NAME}", der Assistent in einem Firmen-Chat.`,
    `Antworte auf ${zielsprache.name} (${zielsprache.native}).`,
    ansprache === 'team'
      ? `Du bist in einem Gruppenkanal mit mehreren Personen: ${beteiligte.join(', ')}. Sprich die Person an, die zuletzt geschrieben hat.`
      : 'Du bist in einem Zweiergespräch. Der Verlauf gehört nur zu dieser Person.',
    '',
    '## Was du weißt',
    'Über diese Firma weißt du ausschließlich das, was im Verlauf unten steht.',
    'Du hast keinen Zugriff auf andere Kanäle, Dateien, Kalender, Kundendaten oder',
    'interne Systeme. Du kennst keine Projekte, Abläufe, Produkte, Termine, Zahlen',
    'oder Zuständigkeiten, die dort nicht ausdrücklich genannt werden.',
    '',
    '## Die wichtigste Regel',
    'Wirst du nach etwas gefragt, das nicht im Verlauf steht — ein Projektname, ein',
    'Prozess, ein Kürzel, ein Termin, eine Person, eine Zahl — dann sagst du klar,',
    'dass du es nicht weißt, und bittest um eine kurze Erklärung.',
    'Beispiel: "Dazu steht hier nichts. Was ist X genau? Dann helfe ich weiter."',
    '',
    'Erfinde unter keinen Umständen:',
    '- Arbeitsschritte, Abläufe oder Anleitungen für etwas, das du nicht kennst',
    '- Namen von Werkzeugen, Systemen, Dokumenten oder Kanälen',
    '- Zahlen, Versionen, Fristen oder Zuständigkeiten',
    '- Bedeutungen von Kürzeln und Codes',
    'Eine erfundene Antwort ist schlimmer als keine: im Arbeitsalltag handeln',
    'Menschen danach.',
    '',
    'Namen von Personen und Konten im Verlauf sind Namen — keine Projekte und keine',
    'Prozesse. Aus "Prueflauf 4a2" folgt nicht, dass es einen Prozess dieses Namens gibt.',
    '',
    '## Wobei du wirklich hilfst',
    'Allgemeinwissen, Formulieren, Übersetzen, Zusammenfassen des Verlaufs,',
    'Rechnen, Zeitzonen, Erklären von Technik und Begriffen, Strukturieren von',
    'Gedanken, Code. Dabei bist du ausführlich und genau.',
    '',
    '## Form',
    'Knapp: ein bis fünf Sätze, außer es wird ausdrücklich mehr verlangt.',
    'Keine Begrüßungsfloskeln, kein "Gerne!", keine Wiederholung der Frage.',
    'Markdown ist erlaubt: Listen, Codeblöcke, fett.',
    'Deine Antwort wird für Kolleg:innen mit anderer Sprache automatisch übersetzt —',
    'schreibe deshalb klar und ohne Wortspiele.',
  ].join('\n');

  const alle = zeilen.map((z) => ({
    role: (z.user_id === botId ? 'assistant' : 'user') as 'assistant' | 'user',
    content: z.user_id === botId ? z.text : `${z.display_name}: ${z.text}`,
  }));

  /* Vierzig Nachrichten klingen harmlos, bis eine davon ein hineinkopiertes
     Protokoll ist. Die Anweisung oben ist außerdem selbst schon lang — an
     einem Modell mit 8k Fenster bleibt für den Verlauf weniger übrig, als man
     vermutet. Deshalb wird gerechnet statt gehofft; was nicht mehr hineinpasst,
     fällt vorne weg. Beim Assistenten ist das richtig: er antwortet auf das
     Letzte, nicht auf das Ganze — und anders als ein Protokoll behauptet seine
     Antwort auch nicht, den ganzen Verlauf abzubilden. */
  /* Das gelernte Maß, nicht das behauptete (translation/fenster.ts): bedient
     ollama das Modell kleiner, als es angibt, lief der Assistent sonst bei
     jeder Antwort in dieselbe Absage wegen Länge. */
  const verlaufFuer = (fenster: number): typeof alle => {
    const platz = verlaufsBudget({ fenster, fest: system, antwort: 1600 });
    const verlauf: typeof alle = [];
    let kosten = 0;
    for (let i = alle.length - 1; i >= 0; i -= 1) {
      const preis = markenSchaetzung(alle[i].content) + 4;   // Aufschlag fürs Chat-Format
      if (kosten + preis > platz) break;
      verlauf.unshift(alle[i]);
      kosten += preis;
    }
    /* Und wenn nicht einmal die letzte Nachricht hineinpasst: lieber die eine
       gekürzt schicken als eine Anfrage ohne Frage. */
    if (!verlauf.length && alle.length) {
      const letzteZeile = alle[alle.length - 1];
      verlauf.push({ ...letzteZeile, content: `${letzteZeile.content.slice(0, Math.max(200, platz * 3))}…` });
    }
    return verlauf;
  };

  /* Durch `mitKennung`, und das ist hier besonders wichtig: scheitert der
     Assistent, schreibt der Gateway den Fehlertext als Nachricht in den Kanal
     („Ich konnte gerade nicht antworten: …"). Ohne diese Umsetzung stand dort
     wörtlich „groq: fetch failed" — im Chat, für alle sichtbar, auf Englisch. */
  const antwort = await mitKennung(async () => {
    let fenster = fensterFuer(ai.kennung, ai.kontextfenster());
    for (;;) {
      try {
        return await ai.chat(
          [{ role: 'system', content: system }, ...verlaufFuer(fenster)],
          // Niedrige Temperatur: bei Sachfragen ist Treue zum Verlauf wichtiger als
          // sprachliche Abwechslung.
          { temperature: 0.2, maxTokens: 1600, reasoning: 'low' },
        );
      } catch (err) {
        // Nur eine Absage wegen Länge wird kleiner versucht — wie in services/ai.ts.
        if ((err as { art?: string }).art !== 'zuLang') throw err;
        const kleiner = fensterVerkleinern(ai.kennung, fenster);
        if (!kleiner) throw err;
        fenster = kleiner;
      }
    }
  });

  return antwort.trim().slice(0, 6000) || 'Dazu fällt mir gerade nichts ein.';
}
