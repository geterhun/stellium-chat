import {
  istE2EChiffrat, languageInfo,
  type AiSummary, type SmartReply, type RewriteTone, type VorschlagArt,
} from '@stellium/shared';
import { db } from '../db/index.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { newId } from '../util/id.js';
import { abweisung } from '../util/abweisung.js';
import { assistant } from '../translation/index.js';
import { type AssistantProvider } from '../translation/providers/types.js';
import { alsAbweisung, mitKennung } from '../translation/fehler.js';
import {
  fensterFuer, fensterVerkleinern, inAbschnitte, juengsteZeilen,
  markenSchaetzung, verlaufsBudget,
} from '../translation/fenster.js';

export class AiUnavailable extends Error {
  constructor() { super('KI ist nicht konfiguriert. Setze AI_PROVIDER=groq und GROQ_API_KEY.'); }
}

interface TranscriptRow {
  id: string; user_id: string; text: string; created_at: number;
  handle: string; display_name: string; parent_id: string | null;
}

/** Eine Nachricht als Zeile, wie ein Modell sie lesen soll. */
function zeile(r: TranscriptRow): string | null {
  // Einzige Stelle, an der hier Nachrichtentext aus der Datenbank gelesen
  // wird — darum reicht es, ihn genau hier zu entschlüsseln.
  if (istE2EChiffrat(r.text)) return null;
  const klartext = entschluesseln(r.text);
  /* Rückhalt, kein Ersatz: die Aufrufer weisen vertrauliche Kanäle schon am
     Kanal ab. Diese Prüfung greift am Inhalt und fängt damit auch, was aus
     einem vertraulichen Kanal weitergereicht wurde. Base64 an ein fremdes
     Modell zu schicken ist der eine Fehler, den es nicht geben darf — und er
     bliebe unsichtbar, weil eine Antwort ja trotzdem käme. */
  if (istE2EChiffrat(klartext)) return null;
  const time = new Date(r.created_at).toISOString().slice(11, 16);
  const thread = r.parent_id ? ' (Antwort im Thread)' : '';
  return `[${r.id}] ${time} ${r.display_name} (@${r.handle})${thread}: ${klartext}`;
}

/** Eine Zeile je Nachricht — Chiffrat fällt dabei weg. */
function zeilen(rows: TranscriptRow[]): string[] {
  return rows.map(zeile).filter((z): z is string => z !== null);
}

/** Nachrichtenverlauf als kompakter, für ein Modell lesbarer Text. */
function transcript(rows: TranscriptRow[]): string {
  return zeilen(rows).join('\n');
}

/* ── Ins Fenster passen ───────────────────────────────────────── */

/**
 * Wie viel Verlauf diese Anfrage mitnehmen darf.
 *
 * `fest` ist alles, was ohnehin mitgeht — Systemanweisung, Personenliste, die
 * Frage. `antwort` ist das Budget, das die Antwort bekommen soll. Der Rest des
 * Fensters gehört dem Verlauf, abzüglich Sicherheitsabstand (siehe
 * translation/fenster.ts).
 */
function budget(ai: AssistantProvider, opts: { fest: string; antwort: number; fast?: boolean }): number {
  return verlaufsBudget({
    /* Das gelernte Maß, nicht das behauptete: hat dieses Modell schon einmal
       wegen Länge abgelehnt, gilt seither die kleinere Zahl — sonst liefe
       jede Funktion einzeln in dieselbe Wand. */
    fenster: fensterFuer(ai.kennung, ai.kontextfenster({ fast: opts.fast })),
    fest: opts.fest,
    antwort: opts.antwort,
  });
}

/**
 * Eine KI-Anfrage, die eine Absage wegen Länge nicht als Fehler nimmt.
 *
 * Lehnt das Modell ab, wird sein Maß halbiert (und gemerkt) und der Aufbau
 * wiederholt — der Aufrufer baut seinen Verlauf dabei neu, jetzt kleiner.
 * Alles andere fliegt durch: ein Netzfehler wird durch Kürzen nicht besser.
 */
async function mitFensterRueckfall<T>(ai: AssistantProvider, versuch: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await versuch();
    } catch (err) {
      if ((err as { art?: string }).art !== 'zuLang') throw err;
      const fenster = fensterFuer(ai.kennung, ai.kontextfenster());
      if (!fensterVerkleinern(ai.kennung, fenster)) throw err;
    }
  }
}

/** Die KI oder eine übersetzbare Absage — nie ein nackter Fehler. */
function ki(): AssistantProvider {
  const a = assistant();
  if (!a) {
    throw abweisung('fehler.kiNichtEingerichtet',
      'Die KI ist für diesen Server nicht eingerichtet.');
  }
  return a;
}

/* ── Zu viel Verlauf: in Abschnitten verdichten ───────────────── */

/** Was ein Teil-Auszug höchstens kosten darf. */
const TEIL_ANTWORT = 700;
/** So oft wird höchstens gefaltet, bevor abgeschnitten wird. */
const RUNDEN = 3;

const TEIL_ANWEISUNG = [
  'Du verdichtest einen Abschnitt aus einem Firmen-Chat für eine spätere Zusammenfassung.',
  'Gib eine knappe Stichpunktliste zurück, reiner Text, keine Vorrede und kein JSON.',
  'Halte fest: worum es ging, was entschieden wurde, was offen blieb, wer was übernimmt.',
  'Namen, @Kennungen und Kennungen in eckigen Klammern übernimmst du wörtlich — sie werden später gebraucht.',
  'Nichts hinzuerfinden. Steht etwas nicht im Abschnitt, steht es auch nicht in deiner Liste.',
].join('\n');

/**
 * Einen Verlauf so aufbereiten, dass er sicher ins Fenster des Modells passt.
 *
 * Passt er ohnehin, geht er unverändert durch — das ist der Normalfall und
 * kostet keine zusätzliche Anfrage.
 *
 * Passt er nicht, wird er **verdichtet und nicht abgeschnitten**. Der
 * Unterschied ist der ganze Punkt: ein Protokoll, dem der Anfang fehlt, ist
 * kein kürzeres Protokoll, sondern ein falsches — und niemand sieht ihm an,
 * dass etwas fehlt. Deshalb wird der Verlauf in Abschnitte geteilt, von denen
 * jeder für sich hineinpasst, jeder Abschnitt für sich verdichtet, und aus den
 * Verdichtungen entsteht die eigentliche Antwort. Reicht auch das nicht, wird
 * noch einmal gefaltet — ein sehr langer Kanal kommt so über zwei oder drei
 * Runden auf eine Größe, die hineinpasst.
 *
 * Erst wenn das nach `RUNDEN` Falten immer noch nicht reicht — ein Kanal mit
 * Zehntausenden Nachrichten an einem winzigen Fenster —, bleibt das Neueste
 * stehen und der Aufrufer erfährt es an `weggelassen`. Dann steht es auch im
 * Ergebnis, statt still zu verschwinden.
 */
async function verlaufAufbereiten(ai: AssistantProvider, opts: {
  zeilen: string[]; fest: string; antwort: number; fast?: boolean;
}): Promise<{ text: string; verdichtet: number; weggelassen: number }> {
  const platz = budget(ai, opts);
  if (platz <= 0) {
    /* Selbst ohne einen einzigen Verlaufseintrag passt die Anfrage nicht.
       Dann hilft kein Kürzen, sondern nur ein anderes Modell. */
    throw abweisung('fehler.modellFensterZuKlein',
      'Das eingestellte Modell nimmt zu wenig Text entgegen für diese Funktion.');
  }

  let zeilen = opts.zeilen;
  let verdichtet = 0;

  for (let runde = 0; runde < RUNDEN; runde += 1) {
    if (markenSchaetzung(zeilen.join('\n')) <= platz) break;

    /* Für die Teil-Anfragen gilt dasselbe Fenster, aber eine andere feste
       Last: nur die kurze Anweisung oben und ein kleineres Antwortbudget. */
    const teilPlatz = budget(ai, { fest: TEIL_ANWEISUNG, antwort: TEIL_ANTWORT, fast: opts.fast });
    const abschnitte = inAbschnitte(zeilen, teilPlatz);
    if (abschnitte.length <= 1) break;   // kleiner wird es so nicht mehr

    const verdichtete: string[] = [];
    for (const abschnitt of abschnitte) {
      const auszug = await ai.chat([
        { role: 'system', content: TEIL_ANWEISUNG },
        { role: 'user', content: abschnitt.join('\n') },
      ], { temperature: 0.2, maxTokens: TEIL_ANTWORT, reasoning: 'low', fast: opts.fast });
      for (const z of auszug.split('\n')) if (z.trim()) verdichtete.push(z.trim());
    }
    verdichtet += abschnitte.length;
    zeilen = verdichtete;
  }

  const passend = juengsteZeilen(zeilen, platz);
  return { text: passend.zeilen.join('\n'), verdichtet, weggelassen: passend.weggelassen };
}

function fetchMessages(
  channelId: string,
  sinceMessageId: string | null,
  limit: number,
  ohneUserId?: string | null | string[],
): TranscriptRow[] {
  const params: any[] = [channelId];
  let where = 'm.channel_id = ? AND m.deleted_at IS NULL AND m.system_kind IS NULL';
  if (sinceMessageId) { where += ' AND m.id > ?'; params.push(sinceMessageId); }
  /* Mehrere Ausnahmen, weil die Vorschlagserkennung zwei braucht: den
     Assistenten und die Systemkonten. Eine einzelne bleibt erlaubt. */
  if (Array.isArray(ohneUserId)) {
    for (const uid of ohneUserId) { where += ' AND m.user_id <> ?'; params.push(uid); }
    ohneUserId = null;
  }
  /* Die eigenen Nachrichten gehören nicht in "Was habe ich verpasst?" — man
     hat sie ja selbst geschrieben. Sie stehen dort nur im Weg und verdrängen
     das, worum es geht: was die anderen inzwischen gesagt haben. */
  if (ohneUserId) { where += ' AND m.user_id <> ?'; params.push(ohneUserId); }
  return db.all<TranscriptRow>(
    `SELECT m.id, m.user_id, m.text, m.created_at, m.parent_id, u.handle, u.display_name
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE ${where}
     ORDER BY m.created_at DESC LIMIT ?`,
    ...params, limit,
  ).reverse();
}

/* ── "Was habe ich verpasst?" ─────────────────────────────────── */

export async function catchUp(input: {
  channelId: string; sinceMessageId: string | null; language: string; channelName: string;
  /** Wessen eigene Nachrichten übersprungen werden. */
  fuerUserId?: string | null;
}): Promise<AiSummary> {
  const ai = ki();

  const rows = fetchMessages(input.channelId, input.sinceMessageId, 300, input.fuerUserId ?? null);
  const lang = languageInfo(input.language);

  if (rows.length === 0) {
    return {
      channelId: input.channelId, fromMessageId: input.sinceMessageId, language: input.language,
      headline: 'Nichts verpasst', bullets: [], actionItems: [], decisions: [],
      messageCount: 0, generatedAt: Date.now(), model: 'none',
    };
  }

  const people = [...new Map(rows.map((r) => [r.user_id, r])).values()]
    .map((r) => `${r.display_name} = @${r.handle} (id: ${r.user_id})`).join('; ');

  const anweisung = [
    `Du fasst den Verlauf eines Firmen-Chats zusammen. Antworte vollständig auf ${lang.name} (${lang.native}).`,
    'Der Verlauf kann mehrsprachig sein — fasse trotzdem einheitlich in der Zielsprache zusammen.',
    'Sei knapp und konkret. Keine Floskeln, keine Wiederholung des Offensichtlichen.',
    `Bekannte Personen: ${people}`,
    'Antworte als JSON:',
    '{"headline": "ein Satz, max 90 Zeichen",',
    ' "bullets": ["3-6 Stichpunkte zum Wesentlichen"],',
    ' "action_items": [{"text": "konkrete Aufgabe", "assignee_id": "<user-id oder null>"}],',
    ' "decisions": ["getroffene Entscheidungen, sonst leeres Array"]}',
  ].join('\n');
  const kopf = `Kanal: #${input.channelName}\n\n`;

  const data = await mitKennung(async () => mitFensterRueckfall(ai, async () => {
    const verlauf = await verlaufAufbereiten(ai, {
      zeilen: zeilen(rows),
      fest: anweisung + kopf,
      antwort: 1200,
    });
    return ai.json<{
      headline?: string; bullets?: string[];
      action_items?: { text: string; assignee_id?: string | null }[];
      decisions?: string[];
    }>([
      { role: 'system', content: anweisung },
      { role: 'user', content: kopf + verlauf.text },
    ], { temperature: 0.25, maxTokens: 1200 });
  }));

  const summary: AiSummary = {
    channelId: input.channelId,
    fromMessageId: input.sinceMessageId,
    language: input.language,
    headline: data.headline?.trim() || 'Zusammenfassung',
    bullets: (data.bullets ?? []).filter((b) => typeof b === 'string').slice(0, 8),
    actionItems: (data.action_items ?? [])
      .filter((a) => a && typeof a.text === 'string')
      .slice(0, 10)
      .map((a) => ({ text: a.text, assigneeId: a.assignee_id ?? null })),
    decisions: (data.decisions ?? []).filter((d) => typeof d === 'string').slice(0, 6),
    messageCount: rows.length,
    generatedAt: Date.now(),
    model: ai === null ? 'none' : 'assistant',
  };

  db.run(
    'INSERT INTO ai_summaries (id, channel_id, scope, ref_id, language, payload, created_at) VALUES (?,?,?,?,?,?,?)',
    newId('sum_'), input.channelId, 'catchup', input.sinceMessageId, input.language, verschluesseln(JSON.stringify(summary)), Date.now(),
  );
  return summary;
}

/* ── Thread-Zusammenfassung ───────────────────────────────────── */

export async function summarizeThread(parentId: string, language: string): Promise<AiSummary> {
  const ai = ki();

  const root = db.get<TranscriptRow & { channel_id: string }>(
    `SELECT m.id, m.channel_id, m.user_id, m.text, m.created_at, m.parent_id, u.handle, u.display_name
     FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`, parentId,
  );
  if (!root) throw new Error('Thread nicht gefunden');

  const replies = db.all<TranscriptRow>(
    `SELECT m.id, m.user_id, m.text, m.created_at, m.parent_id, u.handle, u.display_name
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.parent_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 200`, parentId,
  );
  const lang = languageInfo(language);

  const anweisung = [
    `Fasse diesen Chat-Thread auf ${lang.name} (${lang.native}) zusammen.`,
    'Wichtig ist: Worum ging es, was wurde entschieden, was ist offen?',
    'JSON: {"headline": "...", "bullets": ["..."], "decisions": ["..."], "action_items": [{"text": "...", "assignee_id": null}]}',
  ].join('\n');

  const data = await mitKennung(async () => mitFensterRueckfall(ai, async () => {
    /* Ein Thread darf bis zu 200 Antworten haben — auch das sprengt ein
       kleines Fenster, und auch hier gilt: verdichten statt abschneiden. */
    const verlauf = await verlaufAufbereiten(ai, {
      zeilen: zeilen([root, ...replies]), fest: anweisung, antwort: 900,
    });
    return ai.json<{ headline?: string; bullets?: string[]; decisions?: string[]; action_items?: { text: string; assignee_id?: string | null }[] }>([
      { role: 'system', content: anweisung },
      { role: 'user', content: verlauf.text },
    ], { temperature: 0.25, maxTokens: 900 });
  }));

  return {
    channelId: root.channel_id,
    fromMessageId: parentId,
    language,
    headline: data.headline?.trim() || 'Thread',
    /* Dieselben Filter wie bei catchUp(): ein kleines Modell liefert auch mal
       Objekte statt Zeichenketten oder ein leeres Element — ungeprüft
       weitergereicht, scheiterte die Anzeige oder schon das .map() hier. */
    bullets: (data.bullets ?? []).filter((b) => typeof b === 'string').slice(0, 8),
    actionItems: (data.action_items ?? [])
      .filter((a) => a && typeof a.text === 'string')
      .map((a) => ({ text: a.text, assigneeId: a.assignee_id ?? null })).slice(0, 10),
    decisions: (data.decisions ?? []).filter((d) => typeof d === 'string').slice(0, 6),
    messageCount: replies.length + 1,
    generatedAt: Date.now(),
    model: 'assistant',
  };
}

/* ── Smart Replies ────────────────────────────────────────────── */

export async function smartReplies(input: {
  channelId: string; parentId: string | null; language: string; selfName: string;
}): Promise<SmartReply[]> {
  const ai = ki();

  const rows = input.parentId
    ? db.all<TranscriptRow>(
        `SELECT m.id, m.user_id, m.text, m.created_at, m.parent_id, u.handle, u.display_name
         FROM messages m JOIN users u ON u.id = m.user_id
         WHERE (m.id = ? OR m.parent_id = ?) AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC LIMIT 12`, input.parentId, input.parentId).reverse()
    : fetchMessages(input.channelId, null, 12);

  if (rows.length === 0) return [];
  const lang = languageInfo(input.language);

  const anweisung = [
    `Du schlägst kurze Antworten für ${input.selfName} in einem Firmen-Chat vor.`,
    `Schreibe die Vorschläge auf ${lang.name} (${lang.native}).`,
    'Genau 3 Vorschläge, jeder höchstens 120 Zeichen, klingt wie ein echter Mensch, keine Anrede-Floskeln.',
    'Tonarten: "kurz" (Bestätigung), "freundlich", "nachfrage" (klärende Rückfrage).',
    'JSON: {"replies": [{"text": "...", "tone": "kurz"}, ...]}',
  ].join('\n');

  /* Zwölf Nachrichten sind selten ein Problem — bis eine davon ein
     hineinkopierter Fehlerbericht über zweitausend Zeilen ist. Verdichtet wird
     hier nicht: für einen Antwortvorschlag zählt das Letzte, nicht das Ganze.
     Das Schnellmodell hat außerdem oft das kleinere Fenster, deshalb `fast`
     auch in der Rechnung. */
  const passend = juengsteZeilen(
    zeilen(rows),
    budget(ai, { fest: anweisung, antwort: 400, fast: true }),
  );
  if (!passend.zeilen.length) return [];

  const data = await mitKennung(() => ai.json<{ replies?: { text: string; tone?: string }[] }>([
    { role: 'system', content: anweisung },
    { role: 'user', content: passend.zeilen.join('\n') },
  ], { temperature: 0.6, maxTokens: 400, fast: true }));

  const allowed = new Set(['kurz', 'freundlich', 'formell', 'nachfrage']);
  return (data.replies ?? [])
    .filter((r) => r && typeof r.text === 'string')
    .slice(0, 3)
    .map((r) => ({
      text: r.text.trim().slice(0, 200),
      tone: (allowed.has(r.tone ?? '') ? r.tone : 'freundlich') as SmartReply['tone'],
    }));
}

/* ── Umformulieren / Schreibhilfe ─────────────────────────────── */

const TONE_PROMPT: Record<RewriteTone, string> = {
  polish: 'Korrigiere Rechtschreibung und Grammatik. Ändere Stil und Bedeutung nicht.',
  formal: 'Formuliere den Text höflich und geschäftlich, ohne steif zu klingen.',
  friendly: 'Formuliere den Text wärmer und zugänglicher, ohne anbiedernd zu wirken.',
  concise: 'Kürze den Text auf das Wesentliche. Behalte alle Fakten.',
  expand: 'Ergänze den Text um den fehlenden Kontext, damit ihn auch jemand ohne Vorwissen versteht.',
  bullets: 'Wandle den Text in eine kompakte Stichpunktliste um.',
  apologize: 'Formuliere den Text als sachliche Entschuldigung mit klarem nächsten Schritt.',
};

export async function rewrite(input: { text: string; tone: RewriteTone; targetLang?: string | null }): Promise<string> {
  const ai = ki();

  const instructions = [TONE_PROMPT[input.tone] ?? TONE_PROMPT.polish];
  if (input.targetLang) {
    const l = languageInfo(input.targetLang);
    instructions.push(`Gib das Ergebnis auf ${l.name} (${l.native}) aus.`);
  } else {
    instructions.push('Behalte die Sprache des Originals bei.');
  }
  instructions.push('Gib ausschließlich den überarbeiteten Text zurück — keine Erklärung, keine Anführungszeichen.');
  instructions.push('Lasse Codeblöcke, Links und @Erwähnungen unverändert.');

  const anweisung = instructions.join('\n');
  const antwort = Math.min(2048, Math.max(256, input.text.length * 3));

  /* Hier gibt es nichts zu verdichten: umformuliert wird genau dieser eine
     Text. Passt er nicht ins Fenster, ist eine ehrliche Absage die einzig
     richtige Antwort — die Hälfte umzuschreiben und die andere fallen zu
     lassen wäre schlimmer als gar nichts. */
  if (markenSchaetzung(input.text) > budget(ai, { fest: anweisung, antwort })) {
    throw abweisung('fehler.textZuLangFuerModell',
      'Dieser Text ist zu lang für das eingestellte Modell. Bitte in Teilen umformulieren.');
  }

  const out = await mitKennung(() => ai.chat([
    { role: 'system', content: anweisung },
    { role: 'user', content: input.text },
  ], { temperature: 0.35, maxTokens: antwort }));

  return out.replace(/^["'`]+|["'`]+$/g, '').trim();
}

/* ── Frage an den Kanal ───────────────────────────────────────── */

export async function askChannel(input: {
  channelId: string; question: string; language: string; channelName: string;
}): Promise<{ answer: string; citedMessageIds: string[] }> {
  const ai = ki();

  const rows = fetchMessages(input.channelId, null, 400);
  if (rows.length === 0) {
    return { answer: 'In diesem Kanal gibt es noch nichts, worauf ich antworten könnte.', citedMessageIds: [] };
  }
  const lang = languageInfo(input.language);

  const anweisung = [
    `Beantworte die Frage ausschließlich anhand des Chat-Verlaufs. Antworte auf ${lang.name} (${lang.native}).`,
    'Wenn der Verlauf die Antwort nicht hergibt, sage das klar und rate nicht.',
    'Nenne die IDs der Nachrichten, auf die du dich stützt (die Werte in eckigen Klammern).',
    'JSON: {"answer": "...", "cited_message_ids": ["..."]}',
  ].join('\n');
  const rahmen = `Kanal: #${input.channelName}\n\n`;
  const frage = `\n\nFrage: ${input.question}`;

  /* Hier wird abgeschnitten und nicht verdichtet, und das mit Absicht: eine
     Antwort soll Nachrichten mit ihrer Kennung belegen können, und eine
     Verdichtung überlebt die Kennungen nur zufällig. Das Neueste bleibt also
     stehen. Damit das Modell nicht behauptet, es kenne den ganzen Kanal, wird
     ihm ausdrücklich gesagt, wie viel fehlt. */
  const passend = juengsteZeilen(
    zeilen(rows),
    budget(ai, { fest: anweisung + rahmen + frage, antwort: 900 }),
  );
  const hinweis = passend.weggelassen
    ? `\n\n(Nur die letzten ${passend.zeilen.length} Nachrichten liegen vor; `
      + `${passend.weggelassen} ältere fehlen. Sage es, wenn die Antwort davon abhängen könnte.)`
    : '';

  const data = await mitKennung(() => ai.json<{ answer?: string; cited_message_ids?: string[] }>([
    { role: 'system', content: anweisung },
    { role: 'user', content: rahmen + passend.zeilen.join('\n') + hinweis + frage },
  ], { temperature: 0.2, maxTokens: 900 }));

  const known = new Set(rows.map((r) => r.id));
  return {
    answer: data.answer?.trim() || 'Dazu finde ich nichts im Verlauf.',
    citedMessageIds: (data.cited_message_ids ?? []).filter((id) => known.has(id)).slice(0, 8),
  };
}

/* ── Aufgaben aus einem Gespräch ziehen ───────────────────────── */

/**
 * Liest den Kanalverlauf und zieht daraus die offenen Aufgaben.
 *
 * `sinceMessageId` begrenzt den Blick auf das, was seit dem letzten Durchgang
 * dazugekommen ist. Ohne diese Grenze fände ein zweiter Klick dieselben
 * Aufgaben noch einmal — nur anders formuliert, sodass auch ein Abgleich der
 * Titel sie nicht als Dublette erkennt.
 */
export async function extractTasks(input: {
  channelId: string; language: string; sinceMessageId?: string | null;
}): Promise<{
  title: string; assigneeId: string | null; dueAt: number | null;
}[]> {
  const ai = ki();

  const rows = fetchMessages(input.channelId, input.sinceMessageId ?? null, 120);
  if (!rows.length) return [];

  const lang = languageInfo(input.language);
  const personen = [...new Map(rows.map((r) => [r.user_id, r])).values()]
    .map((r) => `${r.display_name} = ${r.user_id}`).join('; ');

  const anweisung = [
    `Du liest einen Firmen-Chat und ziehst daraus offene Aufgaben. Antworte auf ${lang.name}.`,
    'Eine Aufgabe ist etwas, das jemand konkret tun muss und das noch offen ist.',
    'Was bereits erledigt gemeldet wurde, ist keine Aufgabe mehr. Reine Meinungen und Fragen auch nicht.',
    'Formuliere jeden Titel als Handlung, höchstens 90 Zeichen, ohne Namen am Anfang.',
    'Findest du nichts Konkretes, gib eine leere Liste zurück — lieber nichts als Erfundenes.',
    `Bekannte Personen: ${personen}`,
    'JSON: {"tasks": [{"title": "...", "assignee_id": "<id oder null>", "due_in_days": <Zahl oder null>}]}',
  ].join('\n');

  /* Verdichten, nicht abschneiden: eine Aufgabe, die vor hundert Nachrichten
     vereinbart wurde, ist genauso offen wie eine von eben — und der Aufruf
     kommt oft erst am Ende eines langen Tages. */
  const data = await mitKennung(async () => {
    const verlauf = await verlaufAufbereiten(ai, {
      zeilen: zeilen(rows), fest: anweisung, antwort: 1200,
    });
    return ai.json<{ tasks?: { title: string; assignee_id?: string | null; due_in_days?: number | null }[] }>([
      { role: 'system', content: anweisung },
      { role: 'user', content: verlauf.text },
    ], { temperature: 0.2, maxTokens: 1200, reasoning: 'low' });
  });

  const bekannt = new Set(rows.map((r) => r.user_id));
  return (data.tasks ?? [])
    .filter((t) => t && typeof t.title === 'string' && t.title.trim().length > 3)
    .slice(0, 12)
    .map((t) => ({
      title: t.title.trim().slice(0, 300),
      assigneeId: t.assignee_id && bekannt.has(t.assignee_id) ? t.assignee_id : null,
      dueAt: typeof t.due_in_days === 'number' && t.due_in_days > 0
        ? Date.now() + t.due_in_days * 86_400_000
        : null,
    }));
}

/* ── Protokoll ────────────────────────────────────────────────── */

export interface Protokoll {
  channelId: string;
  language: string;
  title: string;
  /** Worum es ging — je ein Absatz pro Thema. */
  topics: { heading: string; points: string[] }[];
  decisions: string[];
  openQuestions: string[];
  actionItems: { text: string; assigneeId: string | null }[];
  messageCount: number;
  generatedAt: number;
}

/**
 * Protokoll eines Kanals — anders als die Zusammenfassung nicht "was habe ich
 * verpasst", sondern ein weitergebbares Ergebnis: Themen, Beschlüsse, offene
 * Fragen. Gedacht für den Abschluss einer Besprechung oder eines Projekts.
 */
export async function protokoll(input: {
  channelId: string; channelName: string; language: string; sinceMessageId?: string | null;
}): Promise<Protokoll> {
  const ai = ki();

  const rows = fetchMessages(input.channelId, input.sinceMessageId ?? null, 400);
  const lang = languageInfo(input.language);

  if (!rows.length) {
    return {
      channelId: input.channelId, language: input.language,
      title: `#${input.channelName}`, topics: [], decisions: [], openQuestions: [],
      actionItems: [], messageCount: 0, generatedAt: Date.now(),
    };
  }

  const people = [...new Map(rows.map((r) => [r.user_id, r])).values()]
    .map((r) => `${r.display_name} = ${r.user_id}`).join('; ');

  const anweisung = [
    `Du schreibst ein Besprechungsprotokoll aus einem Firmen-Chat. Antworte vollständig auf ${lang.name} (${lang.native}).`,
    'Der Verlauf kann mehrsprachig sein — das Protokoll ist trotzdem einsprachig.',
    'Ein Protokoll hält fest, was besprochen wurde, was entschieden wurde und was offen blieb.',
    'Nichts hinzuerfinden: steht etwas nicht im Verlauf, gehört es nicht ins Protokoll.',
    'Gibt es keine Beschlüsse oder offenen Fragen, bleiben die Listen leer.',
    `Bekannte Personen: ${people}`,
    'JSON: {"title": "kurzer Titel", "topics": [{"heading": "Thema", "points": ["Stichpunkt"]}],',
    ' "decisions": ["..."], "open_questions": ["..."],',
    ' "action_items": [{"text": "...", "assignee_id": "<id oder null>"}]}',
  ].join('\n');
  const kopf = `Kanal: #${input.channelName}\n\n`;

  /* Hier ist der Fehler entstanden: 400 Nachrichten gingen ungefragt hinaus,
     und ein Modell mit 8k Fenster wies die Anfrage mit 10.340 Marken ab.
     Jetzt wird vorher gerechnet — und passt es nicht, entsteht das Protokoll
     in zwei Stufen: erst je Abschnitt ein Auszug, dann das Protokoll aus den
     Auszügen. Ein Protokoll verträgt das, weil es ohnehin verdichtet; ein
     abgeschnittener Verlauf verträgt es nicht, weil das Ergebnis dann falsch
     ist, ohne falsch auszusehen. */
  const { data, verdichtet } = await mitKennung(async () => mitFensterRueckfall(ai, async () => {
    /* Der Verlauf wird INNERHALB des Rückfalls aufgebaut: lehnt das Modell
       wegen Länge ab, gilt beim nächsten Durchgang das kleinere Maß, und der
       Verlauf wird danach neu verdichtet. Außerhalb aufgebaut wäre er beim
       zweiten Anlauf genauso lang wie beim ersten. */
    const verlauf = await verlaufAufbereiten(ai, {
      zeilen: zeilen(rows), fest: anweisung + kopf, antwort: 2000,
    });
    const antwort = await ai.json<{
      title?: string;
      topics?: { heading: string; points: string[] }[];
      decisions?: string[];
      open_questions?: string[];
      action_items?: { text: string; assignee_id?: string | null }[];
    }>([
      { role: 'system', content: anweisung },
      { role: 'user', content: kopf + verlauf.text },
    ], { temperature: 0.2, maxTokens: 2000, reasoning: 'low' });
    /* Steht im Protokoll des Servers und nicht im Ereignis: das Feld dafür
       gehört in packages/shared/src/types.ts (MeetingProtocol), und das ist
       fremdes Revier. Wer es dort ergänzt, kann es hier durchreichen — dann
       sieht auch der Leser, dass sein Protokoll aus Auszügen entstand. */
    if (verlauf.verdichtet) {
      console.log(`[ai] Protokoll für ${input.channelId}: Verlauf über ${verlauf.verdichtet} Abschnitte verdichtet.`);
    }
    return { data: antwort, verdichtet: verlauf.verdichtet };
  }));

  const bekannt = new Set(rows.map((r) => r.user_id));
  const text = (x: unknown) => (typeof x === 'string' ? x.trim() : '');

  return {
    channelId: input.channelId,
    language: input.language,
    title: text(data.title) || `#${input.channelName}`,
    topics: (data.topics ?? [])
      .filter((t) => t && text(t.heading))
      .slice(0, 10)
      .map((t) => ({
        heading: text(t.heading),
        points: (t.points ?? []).map(text).filter(Boolean).slice(0, 8),
      })),
    decisions: (data.decisions ?? []).map(text).filter(Boolean).slice(0, 12),
    openQuestions: (data.open_questions ?? []).map(text).filter(Boolean).slice(0, 12),
    actionItems: (data.action_items ?? [])
      .filter((a) => a && text(a.text))
      .slice(0, 15)
      .map((a) => ({
        text: text(a.text),
        assigneeId: a.assignee_id && bekannt.has(a.assignee_id) ? a.assignee_id : null,
      })),
    messageCount: rows.length,
    generatedAt: Date.now(),
  };
}

/* ── Vorschläge: Aufgaben und Ideen in einem Durchgang ────────

   Steht hier neben extractTasks(), weil es dasselbe tut und denselben
   Verlauf liest. Ein zweiter Modellaufruf für Ideen wäre auf einem
   Raspberry Pi mit einem 8k-Modell die doppelte Wartezeit für dieselbe
   Nachrichtenmenge — deshalb kommen beide aus einem Durchgang. */

/** Wie viele Marken die Antwort der Vorschlagserkennung bekommen soll. */
const ANTWORT_MARKEN = 900;

/** Wie viele Nachrichten überhaupt in Betracht kommen, bevor gekürzt wird. */
const NACHRICHTEN_HOECHSTENS = 120;

/** Wie viele Vorschläge je Durchgang höchstens herauskommen. */
export const VORSCHLAEGE_JE_LAUF = 8;

export interface KiVorschlag {
  art: VorschlagArt;
  titel: string;
  /** Nachricht, aus der er stammt — geprüft gegen den gelesenen Ausschnitt. */
  quelleMessageId: string | null;
  /** Von der KI genannte zuständige Person, oder null. */
  genanntUserId: string | null;
  faelligAm: number | null;
  /** Nur bei "termin": wann es losgeht. Ohne Beginn wird daraus eine Aufgabe. */
  beginntAm: number | null;
  /** Nur bei "termin": wie lange es dauert. Vorgabe eine Stunde. */
  dauerMinuten: number;
}

/** Die KI ist nicht eingerichtet — dann entsteht gar kein Vorschlag. */
export class KiNichtVerfuegbar extends Error {
  constructor() { super('KI ist nicht konfiguriert.'); }
}


function systemAnweisung(sprache: string, personen: string): string {
  const lang = languageInfo(sprache);
  return [
    `Du liest einen Firmen-Chat und schlägst vor, was daraus festgehalten gehört.`,
    `Schreibe die Titel auf ${lang.name} (${lang.native}).`,
    '',
    'Drei Arten, und der Unterschied ist wichtig:',
    '  "aufgabe" — jemand muss konkret etwas tun, und es ist noch offen.',
    '  "idee"    — ein Vorschlag, über den erst noch entschieden werden muss.',
    '  "termin"  — etwas findet zu einer genannten Zeit statt: Besprechung,',
    '              Abgabe, Abwesenheit. Nur mit erkennbarem Zeitpunkt.',
    '',
    'Keine Aufgabe ist: was schon erledigt gemeldet wurde, eine Meinung, eine',
    'Frage, eine Absichtserklärung ohne Gegenstand ("wir sollten mal reden").',
    'Keine Idee ist: eine Wiederholung dessen, was ohnehin schon läuft.',
    'Kein Termin ist: "demnächst", "bald", "irgendwann nächste Woche mal" —',
    'ohne Tag und möglichst Uhrzeit ist es höchstens eine Aufgabe.',
    '',
    'Jeder Titel ist eine Handlung, höchstens 90 Zeichen, ohne Namen am Anfang.',
    'Nenne zu jedem Vorschlag die Kennung der Nachricht, aus der er stammt —',
    'das ist der Wert in eckigen Klammern am Zeilenanfang. Ohne sie kann',
    'niemand nachsehen, ob der Vorschlag stimmt.',
    '',
    'Findest du nichts Konkretes, gib leere Listen zurück. Lieber nichts als',
    'Erfundenes: hier entscheidet danach ein Mensch, und er soll das Ja meinen.',
    `Höchstens ${VORSCHLAEGE_JE_LAUF} Vorschläge insgesamt.`,
    '',
    `Bekannte Personen: ${personen}`,
    'JSON: {"vorschlaege": [{"art": "aufgabe"|"idee"|"termin", "titel": "...",',
    '  "quelle": "<Nachrichtenkennung>", "zustaendig_id": "<id oder null>",',
    '  "faellig_in_tagen": <Zahl oder null>,',
    '  "beginnt_in_stunden": <Zahl oder null, nur bei "termin">,',
    '  "dauer_minuten": <Zahl oder null, nur bei "termin">}]}',
  ].join('\n');
}

export interface LaufErgebnis {
  vorschlaege: KiVorschlag[];
  /** Wie viele Zeilen nicht mehr ins Fenster passten. */
  weggelassen: number;
  /** Wie viele Nachrichten tatsächlich gelesen wurden. */
  gelesen: number;
}

/**
 * Ein Durchgang über einen Kanalausschnitt.
 *
 * Der Aufrufer hat vorher zu prüfen, ob der Kanal vertraulich ist — diese
 * Funktion liest Nachrichtentext und darf deshalb dort nie ankommen. Sie
 * verlässt sich nicht darauf (siehe `zeilenBauen`), aber die Reihenfolge ist
 * so gedacht: erst am Kanal abweisen, dann am Inhalt sichern.
 */
export async function vorschlaegeAusVerlauf(input: {
  channelId: string;
  channelName: string;
  sprache: string;
  sinceMessageId: string | null;
  /** Konten, deren Nachrichten nicht gelesen werden (der Assistent selbst). */
  ohneUserIds?: string[];
}): Promise<LaufErgebnis> {
  const ai = assistant();
  if (!ai) throw new KiNichtVerfuegbar();

  const rows = fetchMessages(
    input.channelId, input.sinceMessageId, NACHRICHTEN_HOECHSTENS, input.ohneUserIds ?? [],
  );
  /* Dieselbe Zeilenform wie überall hier — und derselbe Chiffrat-Rückhalt.
     Vorher stand dafür eine eigene Kopie in ki-vorschlaege.ts; die beiden
     hätten eines Tages verschieden entschieden, was in eine Zeile gehört. */
  const verlaufszeilen = zeilen(rows);
  if (!verlaufszeilen.length) return { vorschlaege: [], weggelassen: 0, gelesen: 0 };

  const personen = [...new Map(rows.map((r) => [r.user_id, r])).values()]
    .map((r) => `${r.display_name} = ${r.user_id}`).join('; ');
  const system = systemAnweisung(input.sprache, personen);
  const kopf = `Kanal: #${input.channelName}\n\n`;

  /* Das Fenster gehört dem Modell, nicht uns — aber die Angabe des Modells
     gehört dem Dienst davor. Ollama bedient ein 32k-Modell nach Belieben mit
     4096 Marken; unsere Rechnung stimmte damit auf dem Papier, und die
     Anfrage kam trotzdem alle fünf Minuten zurück. Deshalb: rechnen, und bei
     einer Absage halbieren und das Maß merken. */
  const modell = ai.kennung;
  let fenster = fensterFuer(modell, ai.kontextfenster());
  let zugeschnitten = { zeilen: [] as string[], weggelassen: 0 };
  let data: {
    vorschlaege?: {
      art?: string; titel?: string; quelle?: string | null;
      zustaendig_id?: string | null; faellig_in_tagen?: number | null;
      beginnt_in_stunden?: number | null; dauer_minuten?: number | null;
    }[];
  } | null = null;

  while (data === null) {
    const budget = verlaufsBudget({ fenster, fest: `${system}\n${kopf}`, antwort: ANTWORT_MARKEN });
    if (budget <= 0) {
      throw new Error(
        `Das Kontextfenster des Modells (${fenster} Marken) reicht für die Anweisung nicht aus.`,
      );
    }

    zugeschnitten = juengsteZeilen(verlaufszeilen, budget);
    if (!zugeschnitten.zeilen.length) {
      return { vorschlaege: [], weggelassen: verlaufszeilen.length, gelesen: 0 };
    }

    const hinweis = zugeschnitten.weggelassen > 0
      ? `\n\n(Nur der jüngste Ausschnitt — ${zugeschnitten.weggelassen} ältere Nachrichten stehen nicht dabei.)`
      : '';

    try {
      data = await ai.json([
        { role: 'system', content: system },
        { role: 'user', content: `${kopf}${zugeschnitten.zeilen.join('\n')}${hinweis}` },
      ], { temperature: 0.2, maxTokens: ANTWORT_MARKEN, reasoning: 'low' });
    } catch (err) {
      /* Nur die Absage wegen Länge wird kleiner versucht. Ein Netzfehler
         bleibt ein Netzfehler — den kleiner zu wiederholen hilft niemandem. */
      if ((err as { art?: string }).art !== 'zuLang') throw err;
      const kleiner = fensterVerkleinern(modell, fenster);
      if (!kleiner) throw err;
      fenster = kleiner;
    }
  }

  const bekannteIds = new Set(rows.map((r) => r.id));
  const bekanntePersonen = new Set(rows.map((r) => r.user_id));

  const vorschlaege = (data.vorschlaege ?? [])
    .filter((v) => v && typeof v.titel === 'string' && v.titel.trim().length > 3)
    .slice(0, VORSCHLAEGE_JE_LAUF)
    .map((v): KiVorschlag => ({
      /* Alles, was nicht ausdrücklich "idee" oder "termin" heißt, ist eine
         Aufgabe. Eine falsch einsortierte Aufgabe kostet einen Klick, eine
         erfundene Art einen Absturz.
         Ein "termin" ohne Beginn bleibt Aufgabe: ein Kalendereintrag ohne
         Zeitpunkt ist keiner, und geraten wird hier nichts. */
      art: v.art === 'idee' ? 'idee'
        : (v.art === 'termin' && typeof v.beginnt_in_stunden === 'number') ? 'termin'
          : 'aufgabe',
      titel: v.titel!.trim().slice(0, 300),
      // Eine erfundene Kennung ist schlimmer als keine: der Sprung dorthin
      // ginge ins Leere, und der Vorschlag sähe belegt aus, ohne es zu sein.
      quelleMessageId: v.quelle && bekannteIds.has(v.quelle) ? v.quelle : null,
      genanntUserId: v.zustaendig_id && bekanntePersonen.has(v.zustaendig_id)
        ? v.zustaendig_id : null,
      faelligAm: typeof v.faellig_in_tagen === 'number' && v.faellig_in_tagen > 0
        ? Date.now() + v.faellig_in_tagen * 86_400_000
        : null,
      /* Termine: Beginn relativ zu jetzt, Dauer in Minuten. Relativ, weil
         das Modell keine verlässliche Vorstellung vom heutigen Datum hat —
         "in 18 Stunden" trifft es, "2026-08-22T09:00" rät es.
         Grenzen: höchstens ein Jahr voraus, Dauer zwischen 15 Minuten und
         einem Tag. Was darüber liegt, ist verrechnet und nicht gemeint. */
      beginntAm: typeof v.beginnt_in_stunden === 'number'
        && v.beginnt_in_stunden > -24 && v.beginnt_in_stunden < 24 * 366
        ? Date.now() + v.beginnt_in_stunden * 3_600_000
        : null,
      dauerMinuten: typeof v.dauer_minuten === 'number'
        && v.dauer_minuten >= 15 && v.dauer_minuten <= 1440
        ? Math.round(v.dauer_minuten)
        : 60,
    }));

  return {
    vorschlaege,
    weggelassen: zugeschnitten.weggelassen,
    gelesen: zugeschnitten.zeilen.length,
  };
}

/**
 * Nur die Schätzung, ohne abzuschicken — für Prüfläufe.
 *
 * Ein Prüflauf, der behauptet "passt ins Fenster", ohne nachzurechnen, prüft
 * nichts. Diese Funktion gibt die Zahlen heraus, die sonst nur intern gelten.
 */
export function budgetProbe(input: {
  sprache: string; personen: string; channelName: string; fenster: number;
}): { budget: number; anweisungMarken: number } {
  const system = systemAnweisung(input.sprache, input.personen);
  const kopf = `Kanal: #${input.channelName}\n\n`;
  return {
    budget: verlaufsBudget({ fenster: input.fenster, fest: `${system}\n${kopf}`, antwort: ANTWORT_MARKEN }),
    anweisungMarken: markenSchaetzung(`${system}\n${kopf}`),
  };
}
