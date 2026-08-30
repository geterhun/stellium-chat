import {
  detectLanguage, dezimaltrennzeichenFuerSprache, findMeasurements, istE2EChiffrat, maskText, messwertPlatzhalter,
  messwerteInTextEinsetzen, normalizeLang, placeholdersIntact, PLACEHOLDER, translatableLength, unmaskText,
  type AiCapabilities, type Massregion, type Messwert, type TranslationView,
} from '@stellium/shared';
import {
  config, aiConfigured, aktiverAnbieter, istLokal, laufzeitSetzen, lokaleEinstellung, type AiProvider,
} from '../config.js';
import {
  getSetting, setSetting, SETTING_AI_PROVIDER, SETTING_LOCAL_FAST, SETTING_LOCAL_MODEL,
  SETTING_LOCAL_URL, SETTING_MODEL_FAST, SETTING_MODEL_QUALITY,
} from '../services/settings.js';
import { db, reindexMessage } from '../db/index.js';
import { newId, sha1 } from '../util/id.js';
import { abdruck, entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { DeepLProvider } from './providers/deepl.js';
import { DemoProvider } from './providers/demo.js';
import { LibreProvider } from './providers/libre.js';
import {
  createGroqProvider, createLokalProvider, createOpenAIProvider, OpenAICompatibleProvider,
} from './providers/openai-compatible.js';
import { ProviderError, type AssistantProvider, type TranslationProvider } from './providers/types.js';
import {
  ECHO_MIN_WOERTER, istEcho, woerter, wortAehnlichkeit,
} from './echo.js';
import {
  ausfallMelden, erfolgMelden, lageVergessen, lokaleLage, lokaleLageJetzt, modelleAbfragen,
  type LokaleLage,
} from './erreichbarkeit.js';
import { kontextZusammenfuehren, verlaufAlsKontext, type VerlaufZeile } from './verlauf.js';
import { polaritaetsWiderspruch } from './polaritaet.js';
import * as stimme from '../services/stimme.js';

/* ── Provider-Auswahl ─────────────────────────────────────────── */

function build(): TranslationProvider {
  if (!aiConfigured()) {
    console.warn(`[ai] Kein Schlüssel für "${aktiverAnbieter()}" gefunden — Demo-Provider aktiv (keine echte Übersetzung).`);
    return new DemoProvider();
  }
  switch (aktiverAnbieter()) {
    case 'groq': return createGroqProvider();
    case 'openai': return createOpenAIProvider();
    case 'ollama':
    case 'llamacpp':
    case 'local': return createLokalProvider();
    case 'deepl': return new DeepLProvider();
    case 'libre': return new LibreProvider();
    default: return new DemoProvider();
  }
}

let aktiv: TranslationProvider = build();

/* ── Ausweichen, wenn das eigene Modell schweigt ─────────────────
   Ein Modell im eigenen Netz ist genau so lange verfügbar wie der Rechner,
   auf dem es läuft. Steht der still, fällt bisher die ganze KI aus:
   keine Übersetzung, kein Protokoll, kein Assistent — genau so ist Dons
   Protokoll heute zweimal ins Leere gelaufen, während ein brauchbarer
   Groq-Schlüssel im Tresor lag.

   Deshalb ein Ersatz auf Zeit: Meldet die Erreichbarkeitsprüfung einen
   Ausfall, übernimmt der erste eingerichtete Dienst im Netz. Meldet sie
   wieder Erfolg, tritt er zurück — die Einstellung bleibt unangetastet, es
   ist eine Vertretung und kein Wechsel. */
let ersatz: TranslationProvider | null = null;

/** Welcher Dienst im Netz einspringen könnte — der erste mit Schlüssel. */
function ersatzBauen(): TranslationProvider | null {
  if (config.ai.groq.apiKey) return createGroqProvider();
  if (config.ai.openai.apiKey) return createOpenAIProvider();
  return null;
}

/**
 * Das eigene Modell antwortet nicht — jemanden anderen ranlassen.
 *
 * Tut nichts, wenn ohnehin kein lokales Modell eingestellt ist, wenn die
 * Vertretung schon läuft oder wenn es niemanden gibt, der einspringen könnte.
 */
export function ersatzUebernimmt(grund: string): void {
  if (!istLokal() || ersatz) return;
  const vertretung = ersatzBauen();
  if (!vertretung) return;
  ersatz = vertretung;
  console.warn(`[ai] ${aktiv.name} antwortet nicht (${grund}) — `
    + `"${vertretung.name}" übernimmt, bis es wieder da ist.`);
}

/** Das eigene Modell ist zurück — die Vertretung tritt ab. */
export function ersatzTrittAb(): void {
  if (!ersatz) return;
  console.log(`[ai] ${aktiv.name} antwortet wieder — "${ersatz.name}" tritt ab.`);
  ersatz = null;
}

/** Springt gerade jemand ein? Für die Auskunft in den Einstellungen. */
export function ersatzLaeuft(): string | null {
  return ersatz?.name ?? null;
}

/** Wer gerade wirklich arbeitet: die Vertretung, sonst der eingestellte. */
function derzeit(): TranslationProvider {
  return ersatz ?? aktiv;
}

/**
 * Der Anbieter lässt sich im Betrieb wechseln.
 *
 * Alles im Server greift auf `provider` zu; wäre das eine feste Bindung, wäre
 * ein Wechsel erst nach einem Neustart sichtbar. Der Stellvertreter hier leitet
 * jeden Zugriff an den gerade gültigen Anbieter weiter — so bleibt jede
 * bestehende Verwendung gültig und die Umschaltung wirkt sofort.
 */
export const provider: TranslationProvider = new Proxy({} as TranslationProvider, {
  get(_ziel, name) {
    const wer = derzeit();
    const wert = (wer as unknown as Record<string | symbol, unknown>)[name];
    return typeof wert === 'function' ? wert.bind(wer) : wert;
  },
  // instanceof muss weiter funktionieren — daran hängt, ob der Assistent kann.
  getPrototypeOf() { return Object.getPrototypeOf(derzeit()); },
  has(_ziel, name) { return name in (derzeit() as object); },
});

/** Nach einer Änderung in den Einstellungen neu aufbauen. */
export async function providerNeuAufbauen(): Promise<void> {
  aktiv = build();
  /* Wer von Hand umstellt, meint es so — eine Vertretung von vorhin hat sich
     damit erledigt. */
  ersatz = null;
  lageVergessen();
  await warmUpModels();
  console.log(`[ai] Anbieter gewechselt auf "${aktiv.name}"${aktiv.model ? ` (${aktiv.model})` : ''}.`);
}

export function assistant(): AssistantProvider | null {
  return provider instanceof OpenAICompatibleProvider ? provider : null;
}

/**
 * Übersetzungen wegwerfen, die ein anderer Provider erzeugt hat.
 * Typischer Fall: Die App lief erst ohne Schlüssel mit dem Demo-Provider,
 * dann wurde ein Groq-Schlüssel eingetragen. Ohne das hier bliebe der
 * unübersetzte Demo-Text für immer stehen.
 */
export function dropForeignTranslations(): void {
  const veraltet = db.run('DELETE FROM message_translations WHERE provider <> ?', provider.name);
  const phrasen = db.run('DELETE FROM translation_memory WHERE provider <> ?', provider.name);
  if (veraltet.changes || phrasen.changes) {
    console.log(
      `[translate] ${veraltet.changes} Nachrichten- und ${phrasen.changes} Phrasen-Übersetzungen`
      + ` von einem anderen Anbieter verworfen — sie werden mit "${provider.name}" neu erzeugt.`,
    );
  }
}

/** Modell-Liste beim Anbieter holen, damit die Auswahl aktuell ist. */
/**
 * Die gespeicherte Anbieterwahl übernehmen — beim Start, bevor gebaut wird.
 *
 * Ohne diesen Schritt gälte nach jedem Neustart wieder das, was in der
 * Umgebung steht, und die Einstellung wäre nur bis zum Neustart wirksam.
 */
export async function anbieterAusEinstellungen(): Promise<void> {
  const gewaehlt = getSetting(SETTING_AI_PROVIDER) as AiProvider | null;
  laufzeitSetzen({
    anbieter: gewaehlt,
    baseUrl: getSetting(SETTING_LOCAL_URL) ?? '',
    model: getSetting(SETTING_LOCAL_MODEL) ?? '',
    fastModel: getSetting(SETTING_LOCAL_FAST) ?? '',
  });
  if (gewaehlt && gewaehlt !== config.ai.provider) await providerNeuAufbauen();
}

/**
 * Anbieter umstellen und dauerhaft merken.
 * Ein leerer Wert heißt: wieder das nehmen, was in der Umgebung steht.
 */
export async function anbieterWaehlen(input: {
  anbieter: AiProvider | null; baseUrl?: string; model?: string; fastModel?: string; userId: string;
}): Promise<void> {
  setSetting(SETTING_AI_PROVIDER, input.anbieter, input.userId);
  if (input.baseUrl !== undefined) setSetting(SETTING_LOCAL_URL, input.baseUrl || null, input.userId);
  if (input.model !== undefined) setSetting(SETTING_LOCAL_MODEL, input.model || null, input.userId);
  if (input.fastModel !== undefined) setSetting(SETTING_LOCAL_FAST, input.fastModel || null, input.userId);

  laufzeitSetzen({
    anbieter: input.anbieter,
    baseUrl: input.baseUrl ?? '',
    model: input.model ?? '',
    fastModel: input.fastModel ?? '',
  });
  await providerNeuAufbauen();
}

/**
 * Erreichbarkeit eines lokalen Dienstes prüfen, ohne etwas umzustellen.
 * Damit man in den Einstellungen sieht, ob die Adresse stimmt und welche
 * Modelle dort geladen sind — vor dem Umschalten, nicht danach.
 */
export async function lokalePruefung(baseUrl: string): Promise<{
  erreichbar: boolean; modelle: string[]; fehler: string | null;
}> {
  return modelleAbfragen(baseUrl);
}

export async function warmUpModels(): Promise<void> {
  // Damit die Konsole gleich nach dem Start sagen kann, ob jemand antwortet.
  void lokaleLage();
  if (!(provider instanceof OpenAICompatibleProvider)) return;
  await provider.registry.refresh();
  // Von Hand gewählte Modelle haben Vorrang vor der automatischen Auswahl.
  provider.registry.applyManualChoice(getSetting(SETTING_MODEL_QUALITY), getSetting(SETTING_MODEL_FAST));
  provider.registry.startAutoRefresh();
}

/**
 * Modell von Hand festlegen. null für beide Werte schaltet zurück auf
 * automatische Auswahl. Wird dauerhaft gespeichert.
 */
export function chooseModels(quality: string | null, fast: string | null, userId: string): void {
  setSetting(SETTING_MODEL_QUALITY, quality, userId);
  setSetting(SETTING_MODEL_FAST, fast, userId);
  modelRegistry()?.applyManualChoice(quality, fast);
}

/**
 * Kann jemand Sprachnachrichten abtippen, und auf welchem Weg?
 *
 * Das hängt nicht am gewählten Textmodell: Ollama und llama.cpp können kein
 * Whisper, und das lokale Textmodell darf auf einer ganz anderen Maschine
 * liegen. Gefragt sind deshalb zwei andere Dinge — läuft nebenan ein
 * Sprachdienst, und liegt ein Groq-Schlüssel vor.
 *
 * Der lokale Weg hat Vorrang. Die Begründung steht in services/voice.ts.
 */
export function transcriptionWeg(): 'lokal' | 'groq' | null {
  if (stimme.bekanntErreichbar()) return 'lokal';
  if (config.ai.groq.apiKey) return 'groq';
  return null;
}

export function transcriptionAvailable(): boolean {
  return transcriptionWeg() !== null;
}

/** Womit abgetippt wird — der lokale Dienst oder das beste Whisper bei Groq. */
export function transcriptionModel(): string | null {
  if (transcriptionWeg() === 'lokal') return config.ai.stimme.modell || 'whisper';
  if (transcriptionWeg() !== 'groq') return null;
  const whisper = modelRegistry()?.discovered.filter((m) => /whisper/i.test(m.id)) ?? [];
  if (!whisper.length) return 'whisper-large-v3-turbo';
  // "turbo" ist deutlich schneller und für Chat-Länge genau genug.
  return whisper.find((m) => /turbo/i.test(m.id))?.id ?? whisper[0].id;
}

export function modelRegistry() {
  return provider instanceof OpenAICompatibleProvider ? provider.registry : null;
}

export function aiCapabilities() {
  const a = assistant();
  const registry = modelRegistry();
  const selection = registry?.current ?? null;

  /* null heißt: kein lokales Modell, also nichts zu prüfen. Steht noch kein
     Ergebnis, wird im Hintergrund nachgesehen und bis dahin nichts
     behauptet — ein „aus" beim Hochfahren wäre genauso falsch wie das
     dauerhafte „an" von vorher. */
  const lage = lokaleLage();
  const lokalAntwortet = !lage || lage.zustand === 'erreichbar';
  /* Ob Übersetzen gerade tatsächlich funktioniert, ist eine andere Frage als
     ob DAS EIGENE Modell antwortet: `lokalAntwortet` prüft nur Letzteres und
     stand deshalb auf `false`, während eine Vertretung längst erfolgreich
     übersetzte — die Vorschau im Composer verschwand mitten im Betrieb.
     Solange irgendwer antwortet (das eigene Modell oder die Vertretung),
     funktioniert Übersetzen; WER es tut, bleibt allein die Auskunft der
     `vertretung`-Zeile unten. */
  const uebersetzungFunktioniert = lokalAntwortet || ersatzLaeuft() !== null;

  return {
    provider: provider.name,
    model: provider.model,
    fastModel: provider instanceof OpenAICompatibleProvider ? provider.fastModel : null,
    modelSource: selection?.source ?? null,
    modelsAvailable: registry ? registry.usable.length || null : null,
    transcription: transcriptionAvailable(),
    transcriptionModel: transcriptionModel(),
    /* Damit in den Einstellungen nicht nur steht, *dass* abgetippt wird,
       sondern auch *wo*. Bei einem lokalen Textmodell ist das der Unterschied
       zwischen „nichts verlässt das Haus" und dem Gegenteil. */
    transcriptionLokal: transcriptionWeg() === 'lokal',
    /* Hing bisher allein am eingestellten Anbieter und war damit für ein
       lokales Modell immer wahr — auch wenn der Rechner schlief. Jetzt hängt
       es an einer tatsächlichen Antwort — vom eigenen Modell ODER von einer
       eingesprungenen Vertretung (siehe uebersetzungFunktioniert oben). */
    translation: provider.name !== 'demo' && uebersetzungFunktioniert,
    assistant: a !== null,
    /* Direkt aus den Einstellungen statt über den Vorschlagsdienst: der
       importiert die Übersetzung, und ein Ring aus zwei Modulen bricht beim
       Laden an der Stelle, an der man ihn am wenigsten erwartet. */
    selbstEintragen: getSetting('ki_traegt_ein') === 'an',
    /* Springt gerade ein anderer Dienst ein, weil das eigene Modell schweigt?
       Ohne diese Auskunft wundert man sich über plötzlich andere Antworten —
       und übersieht, dass der eigene Rechner aus ist. */
    vertretung: ersatzLaeuft(),
    lokal: istLokal(),
    lokaleAdresse: istLokal() ? lokaleEinstellung().baseUrl : null,
    lokalerZustand: lage?.zustand ?? null,
    lokaleModelle: lage?.modelle ?? null,
    lokalerFehler: lage?.fehler ?? null,
    lokalGeprueftAm: lage?.geprueftAm ?? null,
    lokalErfolgAm: lage?.letzterErfolgAm ?? null,
    ...hinweis(lage),
  };
}

/**
 * Der Hinweis unter „Übersetzungs-Dienst" in den Einstellungen.
 *
 * Er geht als Kennung hinaus, nicht als Satz: der deutsche Text daneben ist
 * nur der Rückfall für ältere Clients. Vorher stand hier fester deutscher
 * Text — und den las jede Person, egal welche Sprache sie eingestellt hatte.
 */
function hinweis(lage: LokaleLage | null): Pick<AiCapabilities, 'note' | 'noteCode' | 'noteWerte'> {
  const a = assistant();
  const leer = { note: null, noteCode: null, noteWerte: null };

  /* Zuerst, weil es alles andere aufhebt: steht das Modell nicht zur
     Verfügung, nützt der beste Schlüssel nichts. */
  if (lage && lage.zustand === 'antwortet-nicht') {
    return {
      noteCode: 'hinweis.lokalStumm',
      noteWerte: { adresse: lokaleEinstellung().baseUrl, fehler: lage.fehler ?? '—' },
      note: `Das Modell unter ${lokaleEinstellung().baseUrl} antwortet nicht `
        + `(${lage.fehler ?? 'keine Antwort'}). Nachrichten bleiben unübersetzt, bis es wieder läuft.`,
    };
  }
  if (lage && lage.zustand === 'kein-modell') {
    return {
      noteCode: 'hinweis.lokalOhneModell', noteWerte: { adresse: lokaleEinstellung().baseUrl },
      note: `Unter ${lokaleEinstellung().baseUrl} ist kein Modell geladen. `
        + 'Dort eines starten, sonst bleibt alles unübersetzt.',
    };
  }

  if (provider.name === 'demo') {
    return {
      noteCode: 'hinweis.keinSchluessel', noteWerte: null,
      note: 'Kein API-Schlüssel gesetzt. Trage ihn unter „Einstellungen → Schlüssel → Sprachmodelle" ein oder stelle auf ein lokales Modell um.',
    };
  }
  if (a === null) {
    return {
      noteCode: 'hinweis.keinAssistent', noteWerte: { anbieter: provider.name },
      note: `${provider.name} übersetzt, kann aber keine KI-Zusammenfassungen. Für alle Funktionen Groq, OpenAI oder ein lokales Modell wählen.`,
    };
  }
  if (!transcriptionAvailable()) {
    return {
      noteCode: 'hinweis.keinAbtippen', noteWerte: null,
      note: 'Sprachnachrichten werden nicht abgetippt. Dafür bräuchte es den Sprachdienst auf dem Server '
        + '(server-setup/dienste/stimme-einrichten.sh) oder einen Groq-Schlüssel.',
    };
  }
  if (istLokal() && transcriptionWeg() === 'groq') {
    return {
      noteCode: 'hinweis.stimmeBeiGroq', noteWerte: null,
      note: 'Das Textmodell läuft im eigenen Netz, Sprachnachrichten gehen aber an Groq. '
        + 'Mit server-setup/dienste/stimme-einrichten.sh bleiben auch sie hier.',
    };
  }
  return leer;
}

/* ── Glossar ──────────────────────────────────────────────────── */

interface GlossaryRow { id: string; term: string; translations: string | null; case_sensitive: number }

let glossaryCache: { rows: GlossaryRow[]; at: number } | null = null;
const GLOSSARY_TTL = 30_000;

function glossary(): GlossaryRow[] {
  if (glossaryCache && Date.now() - glossaryCache.at < GLOSSARY_TTL) return glossaryCache.rows;
  const rows = db.all<GlossaryRow>('SELECT id, term, translations, case_sensitive FROM glossary');
  glossaryCache = { rows, at: Date.now() };
  return rows;
}

export function invalidateGlossary(): void { glossaryCache = null; }

/** Begriffe ohne Zielübersetzung werden maskiert, der Rest als Vorgabe mitgegeben. */
function glossaryFor(targetLang: string): { protectedTerms: string[]; mapping: Record<string, string> } {
  const protectedTerms: string[] = [];
  const mapping: Record<string, string> = {};
  for (const row of glossary()) {
    if (!row.translations) { protectedTerms.push(row.term); continue; }
    try {
      const map = JSON.parse(row.translations) as Record<string, string>;
      const hit = map[targetLang];
      if (hit) mapping[row.term] = hit;
      else protectedTerms.push(row.term);
    } catch {
      protectedTerms.push(row.term);
    }
  }
  return { protectedTerms, mapping };
}

/* ── Caches ───────────────────────────────────────────────────── */

class Lru<T> {
  private map = new Map<string, T>();
  constructor(private limit: number) {}
  get(k: string): T | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: string, v: T): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
  }
}

/*
 * Kurzes Gedächtnis für Texte, die das Modell unverändert zurückgab.
 *
 * Ein Echo darf NICHT dauerhaft gemerkt werden — dann bekäme dieser Text nie
 * wieder eine Chance, und genau das hat bis 1.0.26 Übersetzungen dauerhaft
 * ausfallen lassen. Es darf aber auch nicht bei jeder Anfrage neu versucht
 * werden: nach dem Fix gingen dieselben sechs Texte bei JEDEM Aufruf zweimal
 * ans Modell (Anlauf und Nachfassen), im Protokoll gemessen. Aus „dauerhaft
 * falsch" war „dauerhaft teuer" geworden.
 *
 * Deshalb ein Merker mit Verfall: eine Viertelstunde nicht noch einmal
 * fragen, danach wieder. Nur im Arbeitsspeicher, nicht in der Datenbank —
 * ein Neustart soll jedem Text wieder eine Chance geben.
 */
const ECHO_FRIST_MS = 15 * 60_000;
const echoNotiz = new Map<string, number>();

function echoGemerkt(key: string): boolean {
  const seit = echoNotiz.get(key);
  if (seit === undefined) return false;
  if (Date.now() - seit < ECHO_FRIST_MS) return true;
  echoNotiz.delete(key);
  return false;
}

function echoMerken(key: string): void {
  /* Notbremse gegen unbegrenztes Wachsen: bei vielen verschiedenen Texten
     würde die Karte sonst mitwachsen, ohne dass je jemand aufräumt. */
  if (echoNotiz.size > 2000) echoNotiz.clear();
  echoNotiz.set(key, Date.now());
}

const memory = new Lru<{ text: string; provider: string; model: string | null; confidence: number | null }>(
  config.ai.memoryCacheSize,
);

/**
 * Der Provider gehört in den Schlüssel: sonst liefert der Cache nach einem
 * Wechsel von demo auf groq weiter die alten, nicht übersetzten Ergebnisse.
 */
/* Der Schlüsselwert darf den Text nicht preisgeben — siehe abdruck(). */
const tmKey = (src: string, tgt: string, text: string) =>
  abdruck(`${provider.name}|${src}|${tgt}|${text}`);

/* ── Kernfunktion ─────────────────────────────────────────────── */

export interface TranslateOptions {
  text: string;
  targetLang: string;
  sourceLang?: string | null;
  context?: string | null;
  /** Cache überspringen (z.B. für den Round-Trip-Check). */
  skipCache?: boolean;
  /**
   * Erfolgreiches Ergebnis NICHT in memory/translation_memory schreiben.
   *
   * translation_memory cacht nach (Anbieter, Sprachen, Text) — OHNE Kontext,
   * siehe tmKey. Für den kontextreichen Zweig der Polaritäts-Wache in
   * translateMessage() (siehe dort und polaritaet.ts) ist das Ergebnis aber
   * gerade NUR für dieses eine Gespräch richtig — ein anderes Gespräch mit
   * derselben kurzen Nachricht, aber ohne oder mit anderem Kontext, hat
   * keine Garantie, dieselbe Antwort zu brauchen. Ohne dieses Feld würde der
   * geteilte Speicher zum Zufallsergebnis eines Wettlaufs zwischen dem
   * kontextreichen und dem kontextlosen Aufruf (beide laufen parallel, siehe
   * dort) — mit `skipWrite` bleibt das Schreiben allein dem kontextlosen,
   * teilbaren Aufruf vorbehalten.
   */
  skipWrite?: boolean;
  /**
   * Maßangaben (25 °C, 10 kg, 5 km, …) als Sentinel im Ergebnis stehen
   * lassen, statt sie unverändert im Ausgangswortlaut zu belassen — siehe
   * messwerteMaskieren() unten und einheiten.ts. Nur von translateMessage()
   * gesetzt: Umfragen, Kanalnamen und der Rückübersetzungs-Check
   * (roundTrip()) laufen bewusst ohne, damit dort nie ein ungelöster
   * Sentinel stehen bleiben kann — es ruft dort niemand
   * messwerteFuerEmpfaenger() ab, der ihn wieder auflösen würde.
   */
  messwerte?: boolean;
}

export interface TranslateOutcome {
  text: string;
  sourceLang: string;
  provider: string;
  model: string | null;
  confidence: number | null;
  cached: boolean;
  /** true, wenn Ausgangs- und Zielsprache gleich sind — nichts zu tun. */
  noop: boolean;
  /**
   * true, wenn das Modell zwar geantwortet hat, aber mit dem Eingabetext.
   * `text` trägt dann das Original: unübersetzt, und das soll man sehen.
   */
  unuebersetzt: boolean;
  /**
   * Der Schlüssel in translation_memory, den dieses Ergebnis gerade trägt —
   * null, wenn nichts im Satz-Cache stand oder landete (noop, unübersetzt,
   * Echo). Der Aufrufer (translateMessage) verknüpft ihn mit der jeweiligen
   * message_translations-Zeile, damit tmVerweiseNachrechnen() später weiß,
   * welche Phrase noch gebraucht wird und welche nicht mehr.
   */
  memoryKey: string | null;
  /** Siehe TranslationView.measurements — nur gefüllt, wenn opts.messwerte
   *  gesetzt war UND der Text mindestens eine Maßangabe enthielt. */
  measurements?: Record<number, Messwert>;
}

/**
 * Bereits erkannte Maßangaben (siehe einheiten.ts, Positionen bezogen auf
 * `masked` — also NACH Code/Link/Mention/Glossar-Maskierung, damit eine Zahl
 * mitten in einem Codeblock nie mit angefasst wird) zusätzlich wie Code/
 * Links maskieren: genau dieselbe {{n}}-Maschinerie, damit das Sprachmodell
 * sie nie zu Gesicht bekommt. Rückwärts eingesetzt, damit die start/end-
 * Positionen der noch ausstehenden Treffer gültig bleiben.
 *
 * Die Sentinel-Nummerierung (⟦m0⟧, ⟦m1⟧, …) folgt NICHT dem {{n}}-Index
 * (der hängt auch davon ab, wie viel Code/Links/Mentions daneben stehen),
 * sondern schlicht der Position von `funde` — dieselbe Reihenfolge, die eine
 * erneute findMeasurements() auf demselben Text jederzeit reproduzieren
 * kann. Das ist der Grund, warum translateMessage() im Direkttreffer-Zweig
 * (Cache-Zeile ohne LLM-Aufruf) die Sentinel-Zuordnung einfach neu
 * berechnen darf, statt sie mitzuspeichern.
 */
function messwerteMaskieren(
  masked: string, tokens: string[], funde: Messwert[],
): { masked: string; measurementTokens: Map<number, Messwert> } {
  const measurementTokens = new Map<number, Messwert>();
  let out = masked;
  for (const m of [...funde].sort((a, b) => b.start - a.start)) {
    const idx = tokens.length;
    tokens.push(m.rohtext);
    measurementTokens.set(idx, m);
    out = out.slice(0, m.start) + PLACEHOLDER(idx) + out.slice(m.end);
  }
  return { masked: out, measurementTokens };
}

export async function translate(opts: TranslateOptions): Promise<TranslateOutcome> {
  const target = normalizeLang(opts.targetLang);
  const detected = opts.sourceLang ? normalizeLang(opts.sourceLang) : detectLanguage(opts.text).lang;
  const source = detected === 'unknown' ? 'en' : detected;

  const base = {
    sourceLang: source, provider: provider.name, model: provider.model,
    confidence: null as number | null, cached: false, noop: false, unuebersetzt: false,
  };

  const { protectedTerms, mapping } = glossaryFor(target);
  const { masked: maskedOhneMesswerte, tokens } = maskText(opts.text, { protectedTerms });

  /* Maßangaben auf dem BEREITS maskierten Text suchen (siehe Kommentar an
     messwerteMaskieren) und dieselbe Sentinel-Ersetzung schon hier bereit-
     stellen — für jeden Rückgabepfad unten, der gar nicht erst übersetzt
     (schon Zielsprache, nichts Übersetzbares, Modell nicht erreichbar,
     Fehler, Echo). Ohne das bekäme eine Empfängerin ihre eigene Einheit nur
     dann, wenn tatsächlich übersetzt wurde — bei zwei Leuten mit derselben
     Zielsprache (z. B. zwei „en"-Konten, eins in Denver, eins in London) ist
     das aber gerade der HÄUFIGE Fall: source === target, nichts zu tun außer
     der Maßangabe. */
  const gefundeneMesswerte = opts.messwerte ? findMeasurements(maskedOhneMesswerte) : [];
  const { masked, measurementTokens } = gefundeneMesswerte.length
    ? messwerteMaskieren(maskedOhneMesswerte, tokens, gefundeneMesswerte)
    : { masked: maskedOhneMesswerte, measurementTokens: new Map<number, Messwert>() };
  const messwertIndex = new Map(gefundeneMesswerte.map((m, i) => [m, i] as const));
  const messwerteRecord = gefundeneMesswerte.length
    ? Object.fromEntries(gefundeneMesswerte.map((m, i) => [i, m])) : undefined;
  /** Sentinel statt Rohtext für jede erkannte Maßangabe, alles andere unverändert. */
  const mitMesswertSentinels = (text: string) => unmaskText(text, tokens, (idx, roh) => {
    const mw = measurementTokens.get(idx);
    return mw ? messwertPlatzhalter(messwertIndex.get(mw)!) : roh;
  });
  const mitSentinels = mitMesswertSentinels(masked);

  if (source === target) {
    return { ...base, text: mitSentinels, noop: true, confidence: 1, memoryKey: null, measurements: messwerteRecord };
  }

  // Reiner Code / nur Links / nur Emojis -> nichts Übersetzbares übrig.
  if (translatableLength(masked) === 0) {
    return { ...base, text: mitSentinels, noop: true, confidence: 1, memoryKey: null, measurements: messwerteRecord };
  }

  const key = tmKey(source, target, masked);

  /**
   * Gemeinsamer Ausgang für alle Wege — frisch übersetzt wie aus dem Cache.
   *
   * Hier fällt die Entscheidung, ob am Ende wirklich eine Übersetzung steht.
   * Kommt der Eingabetext zurück, wird er als Original ausgegeben und nicht
   * als Übersetzung ausgegeben: lieber sichtbar unübersetzt als falsch
   * beschriftet.
   */
  const fertig = (
    uebersetzt: string,
    zusatz: {
      provider: string; model: string | null; confidence: number | null;
      cached: boolean; sourceLang?: string;
      /** Nur setzen, wenn dieser Aufruf wirklich einen Cache-Treffer oder
          einen frischen Eintrag in translation_memory abbildet — siehe die
          beiden Echo-Zweige unten, die absichtlich keinen mitgeben. */
      memoryKey?: string | null;
    },
  ): TranslateOutcome => {
    if (istEcho(masked, uebersetzt)) {
      /*
       * Zwei sehr verschiedene Fälle sehen hier gleich aus, und sie
       * auseinanderzuhalten ist der Sinn dieser Zeilen.
       *
       * Steht die erkannte Ausgangssprache bereits auf der Zielsprache, ist
       * ein unveränderter Text die RICHTIGE Antwort — es gibt nichts zu
       * übersetzen. Das trifft ständig zu: der Assistent antwortet auf
       * Deutsch, die Kanalsprache ist Englisch, und dann läuft eine
       * Anfrage en → de über einen Text, der schon Deutsch ist.
       *
       * Vorher stand für beide Fälle derselbe Satz im Protokoll — „gab den
       * Eingabetext zurück statt ihn zu übersetzen". Der liest sich wie ein
       * Fehlschlag des Modells und ist meistens keiner. Er hat mich am
       * 22.08.2026 durch eine halbe Fehlersuche geschickt: Endpunkt
       * geprüft, Modell geprüft, Anweisung nachgestellt — alles in Ordnung,
       * und die Meldung meinte von Anfang an etwas anderes.
       */
      const schonZiel = (zusatz.sourceLang ?? source) === target;
      console.warn(
        schonZiel
          ? `[translate] ${provider.name}: nichts zu übersetzen — Text ist bereits ${target}`
            + ` (${masked.length} Zeichen).`
          : `[translate] ${provider.name} gab den Eingabetext zurück statt ihn zu übersetzen`
            + ` (${zusatz.sourceLang ?? source} → ${target}, ${masked.length} Zeichen,`
            + ` ${Math.round(wortAehnlichkeit(masked, uebersetzt) * 100)} % Übereinstimmung)`
            + ' — wird als unübersetzt gekennzeichnet.',
      );
      // Ein Echo landet nie im Satz-Cache (siehe weiter unten) — memoryKey
      // deshalb hier zwingend null, auch falls zusatz versehentlich einen trüge.
      return {
        ...base, ...zusatz, text: mitSentinels, noop: true, unuebersetzt: true, confidence: 0,
        memoryKey: null, measurements: messwerteRecord,
      };
    }
    return {
      ...base, ...zusatz, text: mitMesswertSentinels(uebersetzt),
      measurements: messwerteRecord, memoryKey: zusatz.memoryKey ?? null,
    };
  };

  if (!opts.skipCache) {
    const hot = memory.get(key);
    if (hot) {
      return fertig(hot.text, {
        provider: hot.provider, model: hot.model, confidence: hot.confidence, cached: true, memoryKey: key,
      });
    }

    const row = db.get<{ target_text: string; provider: string }>(
      'SELECT target_text, provider FROM translation_memory WHERE key = ?', key,
    );
    if (row) {
      db.run('UPDATE translation_memory SET hits = hits + 1 WHERE key = ?', key);
      const entry = {
        text: entschluesseln(row.target_text), provider: row.provider,
        model: provider.model, confidence: 0.9,
      };
      memory.set(key, entry);
      return fertig(entry.text, {
        provider: entry.provider, model: entry.model, confidence: entry.confidence, cached: true, memoryKey: key,
      });
    }
  }

  /* Vor einer Minute schon einmal unübersetzbar gewesen? Dann nicht noch
     einmal fragen — das kostete zwei Modellaufrufe für dasselbe Ergebnis.
     `skipCache` (also eine ausdrücklich erzwungene Übersetzung) hebt den
     Merker auf: wer von Hand nachfordert, soll einen echten neuen Versuch
     bekommen. */
  if (!opts.skipCache && echoGemerkt(key)) {
    return {
      ...base, text: mitSentinels, confidence: 0, noop: true, unuebersetzt: true,
      memoryKey: null, measurements: messwerteRecord,
    };
  }

  /* Erst nachsehen, ob überhaupt jemand da ist. Ein Modell im eigenen Netz
     läuft auf einem Rechner, der auch mal aus ist — ohne diesen Test liefe
     jede Nachricht in drei Versuche à 25 Sekunden, und bei mehreren
     Zielsprachen steht der Betrieb. Der Test steht bewusst hinter den
     Zwischenspeichern: was schon übersetzt ist, soll auch dann ankommen,
     wenn gerade niemand antwortet. */
  const lage = await lokaleLageJetzt();
  if (lage && lage.zustand !== 'erreichbar') {
    /* Vor der Absage: kann eine Vertretung einspringen? ersatzUebernimmt()
       tut nichts, wenn schon eine läuft oder wenn es niemanden gibt, der
       einspringen könnte (siehe dort) — in beiden Fällen bleibt es bei der
       schnellen Absage unten, genau wie vorher.

       Der Aufruf gehört HIERHIN und nicht erst in den catch-Zweig weiter
       unten: dieser Test hier greift schon, BEVOR provider.translate()
       je gerufen wird — ohne diesen Aufruf hier hätte ein aktiver Ersatz nie
       eine Chance bekommen, weil die Absage unten jede Übersetzung beendet
       hat, bevor der eigentliche Aufruf (und mit ihm die einzige andere
       Stelle, die ausfallMelden() und damit ersatzUebernimmt() auslöst) je
       stattfand. */
    ersatzUebernimmt(lage.fehler ?? lage.zustand);
    if (!ersatzLaeuft()) {
      console.warn(
        `[translate] ${lokaleEinstellung().baseUrl}: ${lage.fehler ?? 'antwortet nicht'}`
        + ' — nicht übersetzt, wird beim nächsten Mal erneut versucht.',
      );
      return {
        ...base, text: mitSentinels, confidence: 0, noop: true, unuebersetzt: true,
        memoryKey: null, measurements: messwerteRecord,
      };
    }
    console.warn(
      `[translate] ${lokaleEinstellung().baseUrl}: ${lage.fehler ?? 'antwortet nicht'}`
      + ` — "${ersatzLaeuft()}" übersetzt, bis das eigene Modell zurück ist.`,
    );
  }

  /* Wer diese Anfrage tatsächlich beantwortet — die Vertretung oder das
     eingestellte Modell selbst. Nur im zweiten Fall darf ein Erfolg unten
     das eigene Modell als erreichbar verbuchen (erfolgMelden()): antwortet
     die Vertretung, sagt das nichts über das eigene Modell aus. Ohne diese
     Unterscheidung hätte die allererste erfolgreiche Anfrage über die
     Vertretung sie sofort wieder abtreten lassen — kaum eingesprungen,
     gleich wieder weg, weil `provider` (der Proxy) ihren Erfolg als
     "das eigene Modell antwortet wieder" gemeldet hätte.
     Absichtlich NICHT hier vor der Anfrage festgehalten: Übersetzungen
     laufen nebenläufig (ws/gateway.ts übersetzt jede Zielsprache in einem
     eigenen, nicht abgewarteten Aufruf), und withRetry() unten versucht bis
     zu dreimal — jeder einzelne Versuch löst `provider.translate` über den
     Proxy neu auf, also `derzeit()` NEU, ERST ZUM ZEITPUNKT DES VERSUCHS.
     Stünde die Zuordnung schon hier fest, könnte eine ANDERE, parallel
     laufende Übersetzung zwischen dem ersten und einem späteren Versuch
     dieses Aufrufs eine Vertretung installieren — der spätere Versuch ginge
     dann tatsächlich an die Vertretung, während hier weiter das vorher
     eingestellte Modell einträte. Ein Erfolg der Vertretung würde dann als
     Erfolg des eigenen Modells verbucht: `festhalten('erreichbar', …)`
     bekäme einen falschen Zeitstempel, während der Rechner aus ist, und die
     Vertretung träte Sekunden nach ihrem Einsatz gleich wieder ab — siehe
     Auftrag, Fund 1 (Nebenläufigkeit).
     Stattdessen berichtet jeder Versuch selbst, wer ihn ausgeführt hat:
     `wer` unten wird nicht über den Proxy gerufen, sondern als das konkrete
     Objekt festgehalten, DAS DIESEN EINEN VERSUCH tatsächlich ausführt —
     unabhängig davon, was `derzeit()` hinterher liefert. */
  const anfrage = {
    text: masked,
    targetLang: target,
    sourceLang: source,
    context: opts.context ?? null,
    glossary: mapping,
  };

  let antwortendeStelle: TranslationProvider = aktiv;
  const rufAn = (req: Parameters<TranslationProvider['translate']>[0]) => {
    const wer = derzeit();
    antwortendeStelle = wer;
    return wer.translate(req);
  };

  let result;
  try {
    result = await withRetry(() => rufAn(anfrage));
    /* Wer antwortet, ist erreichbar — billiger als jede weitere Nachfrage.
       Aber nur verbuchen, wenn wirklich das eigene Modell geantwortet hat
       (siehe antwortendeStelle oben): sonst träte eine gerade erst
       eingesprungene Vertretung mit ihrem ersten Erfolg schon wieder ab.
       `antwortendeStelle` trägt hier den Stand des Versuchs, der `result`
       geliefert hat — withRetry() kehrt beim ersten Erfolg sofort zurück,
       spätere Versuche gibt es dann nicht mehr, die Zuordnung kann also
       nicht mehr veralten. */
    if (antwortendeStelle === aktiv) erfolgMelden();

    /* Der Eingabetext kam zurück — einmal mit deutlicherer Anweisung
       nachfassen. Ein zweiter Versuch mit demselben Prompt wäre sinnlos:
       bei temperature 0 antwortet das Modell Wort für Wort dasselbe,
       dreimal von drei Läufen gemessen.

       Nicht nachgefasst wird, wenn das Modell selbst sagt, der Text stehe
       schon in der Zielsprache: dann ist die unveränderte Rückgabe richtig
       und Nachdruck würde eine Übersetzung erzwingen, die keine ist. */
    const erkannt = result.detectedSourceLang ? normalizeLang(result.detectedSourceLang) : source;
    if (erkannt !== target && istEcho(masked, result.text)) {
      const zweiter = await withRetry(() => rufAn({ ...anfrage, nachdruck: true }))
        .catch((err) => {
          console.warn('[translate] Nachfassen fehlgeschlagen:', (err as Error).message);
          return null;
        });
      if (zweiter && !istEcho(masked, zweiter.text)) result = zweiter;
    }
  } catch (err) {
    /* Bei einem Modell im eigenen Netz gehört die Adresse dazu. Sonst steht im
       Journal nur „fetch failed", und die häufigste Ursache — der Rechner mit
       dem Modell ist aus oder aus dem Tailscale-Netz gefallen — sieht genauso
       aus wie jeder andere Fehler. */
    const wo = istLokal() ? ` (${lokaleEinstellung().baseUrl})` : '';
    console.error(`[translate]${wo}`, (err as Error).message);

    /* Kam gar keine Antwort — Verbindung abgelehnt oder Zeitüberschreitung —,
       dann sofort merken. Sonst liefe die nächste Nachricht noch einmal in
       die volle Wartezeit, obwohl längst feststeht, dass niemand da ist.
       Ein 400er oder 429er sagt dagegen nichts über die Erreichbarkeit. */
    const status = err instanceof ProviderError ? err.status : undefined;
    if (status === undefined || status === 408) ausfallMelden((err as Error).message);
    // Lieber das Original zeigen als gar nichts.
    return {
      ...base, text: mitSentinels, confidence: 0, noop: true, unuebersetzt: true,
      memoryKey: null, measurements: messwerteRecord,
    };
  }

  const out = result.text;
  if (!placeholdersIntact(masked, out)) {
    // Modell hat Platzhalter verschluckt — Original zurückgeben statt Kauderwelsch.
    console.warn('[translate] Platzhalter beschädigt, nutze Original');
    return {
      ...base, text: mitSentinels, confidence: 0, noop: true, unuebersetzt: true,
      memoryKey: null, measurements: messwerteRecord,
    };
  }

  const finalSource = result.detectedSourceLang ? normalizeLang(result.detectedSourceLang) : source;
  if (finalSource === target) {
    return {
      ...base, sourceLang: finalSource, text: mitSentinels, noop: true, confidence: 1,
      memoryKey: null, measurements: messwerteRecord,
    };
  }

  const entry = { text: out, provider: provider.name, model: result.model, confidence: result.confidence };

  /*
   * Ein Echo darf NICHT in den Zwischenspeicher.
   *
   * Hier lagen `memory.set` und der Datenbank-Eintrag vor `fertig(...)` — und
   * erst dort wird geprüft, ob überhaupt übersetzt wurde. Ein Text, den das
   * Modell unverändert zurückgab, landete damit als gültige Übersetzung im
   * Speicher. Von da an war er **dauerhaft** unübersetzt: jeder spätere
   * Treffer kam aus dem Speicher, meldete die Warnung und bekam nie wieder
   * eine Chance — obwohl das Nachfassen bei Temperatur 0,4 beim nächsten
   * Anlauf sehr wahrscheinlich gelungen wäre.
   *
   * Gemessen am 22.08.2026: 356 Meldungen „gab den Eingabetext zurück" in 24
   * Stunden, dabei KEIN einziges gescheitertes Nachfassen. Am laufenden
   * Modell gemessen echot der erste Anlauf bei 10 von 27 Texten (37 %), nach
   * dem Nachfassen bei 0 von 27. Die Zahlen passten nicht zusammen — bis auf
   * diese Reihenfolge.
   *
   * Lieber jedes Mal neu fragen als einmal falsch merken: ein Fehlversuch
   * kostet eine Anfrage, ein gemerkter Fehlversuch kostet die Übersetzung
   * für immer.
   *
   * `echoMerken(key)` gehört hinter dieselbe Bedingung wie `opts.skipWrite`
   * unten, nicht davor: `key` (tmKey) ist KONTEXTFREI — Anbieter/Sprachen/
   * maskierter Text, ohne den Gesprächsverlauf, mit dem dieser eine Aufruf
   * gerade lief (siehe TranslateOptions.skipWrite). Stand der Aufruf hier
   * unbedingt vor der skipWrite-Prüfung, merkte ein kontextreicher,
   * NICHT teilbarer Aufruf (translateMessage()s mitWache-Zweig) sein Echo
   * trotzdem im GETEILTEN echoNotiz — für die nächsten 15 Minuten galt
   * dieselbe kurze Wortfolge dann auch in jedem anderen Gespräch, ohne
   * Kontext und ohne dass das Modell dafür gefragt wurde, als unübersetzbar.
   * Genau die Garantie, die skipWrite für translation_memory schon gab,
   * fehlte hier für den zweiten geteilten Speicher. */
  if (istEcho(masked, out)) {
    if (!opts.skipWrite) echoMerken(key);
    return fertig(out, {
      provider: entry.provider, model: entry.model, confidence: entry.confidence,
      cached: false, sourceLang: finalSource,
    });
  }

  if (opts.skipWrite) {
    return fertig(out, {
      provider: entry.provider, model: entry.model, confidence: entry.confidence,
      cached: false, sourceLang: finalSource,
    });
  }

  memory.set(key, entry);
  db.run(
    `INSERT INTO translation_memory (key, source_lang, target_lang, source_text, target_text, provider, hits, created_at)
     VALUES (?,?,?,?,?,?,1,?)
     ON CONFLICT(key) DO UPDATE SET hits = hits + 1`,
    /* Auch hier verschlüsselt.
       Dieser Zwischenspeicher lag als einziger Ort noch im Klartext: Quelle
       und Übersetzung jeder je übersetzten Nachricht, sauber nebeneinander.
       Wer die Datenbankdatei hat, hätte damit ganze Gespräche lesen können,
       obwohl die Nachrichtentabelle selbst verschlüsselt ist. */
    key, finalSource, target, verschluesseln(masked), verschluesseln(out), provider.name, Date.now(),
  );

  return fertig(out, {
    provider: entry.provider, model: entry.model, confidence: entry.confidence,
    cached: false, sourceLang: finalSource, memoryKey: key,
  });
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof ProviderError ? err.retryable : false;
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 350 * 2 ** i + Math.random() * 200));
    }
  }
  throw lastErr;
}

/* ── Nachrichten-Übersetzung mit persistentem Cache ───────────── */

interface MessageRow {
  id: string; channel_id: string; user_id: string; text: string; source_lang: string | null; deleted_at: number | null;
  /** Nur für verlaufVorNachricht() unten — grenzt den Verlauf auf das ein, was zu diesem Zeitpunkt schon geschrieben war. */
  created_at: number;
}

interface VerlaufRow { user_id: string; text: string; display_name: string }

/**
 * Wie viele vorherige Nachrichten verlaufVorNachricht() höchstens lädt.
 *
 * Gemessen (scratch-Vergleich mit drei Verlaufslängen, an qwen3-8b, siehe
 * Bericht): eine einzige vorangehende Zeile reicht beim direkten Fall
 * ("kannst du das machen?" -> "mache ich kein problem") aus, ist aber KEINE
 * verlässliche Untergrenze — bei einem Vorlauf aus mehreren kurzen Zeilen
 * (Bitte, Rückfrage, Klärung, dann erst die Antwort) lieferte NUR die
 * unmittelbar letzte Zeile bei einem zweiten Testfall ("geht klar") ein
 * SCHLECHTERES Ergebnis als GAR KEIN Kontext — die eine Zeile allein legt
 * dann eine falsche Lesart nahe, statt zu orientieren. Der volle Dreizeiler
 * war dort wieder so gut wie ganz ohne Kontext. Deshalb 4 statt 1: genug
 * Spielraum, um nicht an einer einzelnen irreführenden Zwischenzeile hängen
 * zu bleiben. Löst das NICHT vollständig — ein Fall, bei dem die Bitte zwei
 * Züge vor der Antwort liegt (Bitte, Rückfrage, Klärung, Antwort), blieb
 * auch mit allen drei Zeilen falsch; siehe Bericht, ausdrücklich als
 * ungelöst vermerkt. Mehr als 4 wurde nicht gemessen — auf einem 8k-
 * Kontextfenster (gemessen an qwen3-8b auf dem Pi) kostet jede zusätzliche
 * Zeile Marken, ohne dass ein Nutzen dafür belegt wäre.
 * Bewusst deutlich unter den 12 der Antwortvorschläge (services/ai.ts,
 * smartReplies): dort werden bis zu 3 neue Sätze GENERIERT und sollen zum
 * ganzen jüngeren Gesprächsfaden passen, hier wird nur EIN vorhandener Satz
 * eingeordnet.
 */
const VERLAUF_LIMIT = 4;

/**
 * Ab wie vielen Wörtern eine Nachricht nicht mehr als "kurz" gilt — siehe
 * kurzUndMitVerlauf in translateMessage() weiter unten.
 */
const KURZTEXT_WOERTER_SCHWELLE = 6;

/**
 * Zielsprachen mit einer GEPRÜFTEN Polaritäts-Wache (siehe polaritaet.ts).
 *
 * REGEL: Wache zuerst, dann Kontext — nicht umgekehrt. Der gemeldete Fehler
 * ("lass mal lieber" kippt mit Kontext zu einer Zusage) hängt nicht an der
 * Zielsprache Englisch — er entsteht, wenn eine deutsche elliptische Absage
 * auf Gesprächskontext trifft, und das Modell löst sie falsch auf. Dieser
 * Vorgang ist in jeder Zielsprache gleich; nur die Prüfbarkeit ändert sich.
 * Kontext an eine Zielsprache OHNE geprüfte Wache zu geben, hieße also
 * denselben Fehler ungeprüft auszuliefern statt ihn zu vermeiden — schlimmer
 * als der Ausgangszustand, nicht gleichwertig (Entscheidung der
 * Koordination). Für jede Zielsprache HIER NICHT gelistet bekommt eine
 * kurze Nachricht mit Verlauf deshalb GAR KEINEN Gesprächskontext, auch
 * wenn verlaufVorNachricht() welchen fände — Kanal-Metadaten (opts.context)
 * bleiben unberührt, das ist nicht der geprüfte Mechanismus.
 *
 * Erweitern: eine Zielsprache kommt erst hier hinein, NACHDEM für sie
 * dieselbe Übung gelaufen ist wie für Englisch — eigene Absage-/
 * Zusage-Wortlisten, ein eigener Korpus, eine unabhängige gehaltene
 * Stichprobe, Trefferquote und Fehlalarmquote gemessen und berichtet.
 *
 * Deutsch (EN→DE) wurde genau so geprüft — scripts/polaritaet-de-
 * entdecken.mjs, scripts/polaritaet-de-messen.mjs, Wortlisten in
 * polaritaet.ts — und bewusst NICHT geöffnet: 0 % Fehlalarm auf 84
 * Prüfungen, aber die Trefferquote auf frisch erdachten Fällen sank mit
 * jeder frischeren Stichprobenrunde (12/12 → 9/9 → 7/9 → 4/10), anders als
 * bei Englisch (100 % gegen eine bekannte echte Invertierung). Auch fand
 * sich in keinem der 44 echten EN→DE-Testläufe (inklusive acht bewusst
 * extrem elliptischer Stichproben ohne jede Verneinung) eine tatsächliche
 * Invertierung — anders als bei Englisch gibt es also keine bekannte
 * Bedrohung, an der sich die Trefferquote hätte beweisen können. Eine
 * Wache, die auf frischen Fällen nur 40 % einer erfundenen Invertierung
 * fängt, wäre selbst das Risiko, vor dem diese ganze Liste schützen soll —
 * siehe polaritaet.ts und Bericht für die vollständigen Zahlen. Diese
 * Entscheidung kann mit der dortigen Grundlage jederzeit anders getroffen
 * werden.
 */
const ZIELSPRACHEN_MIT_GEPRUEFTER_WACHE: readonly string[] = ['en'];

/**
 * Reine Kennzahlen zur kurz-mit-Verlauf-Bevölkerung — kein Nachrichtentext,
 * keine Kennung einer Person, eines Kanals oder einer Nachricht. Beantwortet
 * die Frage aus dem Auftrag ("welcher Anteil des echten Betriebs ist das
 * wirklich") über Wochen, statt bei einer einmaligen Schätzung zu bleiben.
 *
 * Eigene, einfache Zeilen in app_settings statt setSetting()/getSetting()
 * (services/settings.ts): jene sind für von Hand geänderte Einstellungen
 * gebaut und tragen eine Person als „updated_by" — hier zählt kein Mensch
 * etwas, sondern jede Übersetzung automatisch mit.
 *
 * Lesbar mit, z. B. per SSH auf dem Pi:
 *   sqlite3 <DATENBANKDATEI> \
 *     "SELECT key, value FROM app_settings WHERE key LIKE 'metrik.uebersetzung.%'"
 */
const METRIK_UEBERSETZUNGEN_GESAMT = 'metrik.uebersetzung.gesamt';
const METRIK_KURZ_MIT_VERLAUF = 'metrik.uebersetzung.kurz_mit_verlauf';

function metrikHochzaehlen(key: string): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, '1', NULL, ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`,
    key, Date.now(),
  );
}

/**
 * Die letzten paar Nachrichten VOR dieser einen, aus demselben Kanal — als
 * Gesprächskontext fürs Modell (siehe verlauf.ts für das Warum).
 *
 * `created_at < vorZeit` statt einfach "die letzten N im Kanal": eine spätere
 * erzwungene Neuübersetzung (opts.force, z. B. nach Providerwechsel) soll
 * denselben Verlauf sehen wie beim ersten Mal, nicht Nachrichten, die zum
 * Zeitpunkt des Originals noch gar nicht geschrieben waren.
 *
 * Zweimal gegen Chiffrat geprüft, genau wie services/ai.ts (zeile()): einmal
 * hier am rohen Datenbankwert (billig, bevor überhaupt entschlüsselt wird),
 * einmal in verlaufAlsKontext() am Klartext. Diese Funktion wird nie für eine
 * Nachricht aus einem vertraulichen Kanal aufgerufen (siehe Aufrufer in
 * translateMessage() — dieselbe Prüfung, die auch die zu übersetzende
 * Nachricht selbst schützt), das hier ist Rückhalt, kein Ersatz.
 */
function verlaufVorNachricht(channelId: string, vorZeit: number, ausgenommenId: string): VerlaufZeile[] {
  const rows = db.all<VerlaufRow>(
    `SELECT m.user_id, m.text, u.display_name
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = ? AND m.id <> ? AND m.created_at < ?
       AND m.deleted_at IS NULL AND m.system_kind IS NULL
     ORDER BY m.created_at DESC LIMIT ?`,
    channelId, ausgenommenId, vorZeit, VERLAUF_LIMIT,
  ).reverse();
  return rows
    .filter((r) => !istE2EChiffrat(r.text))
    .map((r) => ({ wer: r.display_name || '', text: entschluesseln(r.text) }));
}

/**
 * Ausgangssprache, mit der eine Übersetzung tatsächlich anläuft, wenn die
 * Nachricht selbst keine feststehende trägt (`source_lang` ist dann null —
 * siehe messages.ts, dieselbe 0,35-Schwelle).
 *
 * Die Heuristik allein reicht bei kurzen Antworten nicht: „ok", „vale" oder
 * „ya" fallen für sie überzeugend auf eine andere Sprache, obwohl es Wörter
 * sind, die mehrere Sprachen teilen oder die dort zufällig eindeutig
 * scheinen. Drei Wörter oder weniger ist dieselbe Grenze, unter der auch die
 * Echo-Prüfung nichts mehr beurteilt (ECHO_MIN_WOERTER in echo.ts) — darunter
 * kippt ein einziger Treffer die Konfidenz, ohne dass genug Text für einen
 * echten Anhaltspunkt da wäre.
 *
 * Unterhalb der Wort- oder der Sicherheitsgrenze zählt die Sprache, die diese
 * Person sich selbst eingestellt hat, mehr als ein einzelnes mehrdeutiges
 * Wort: Wer sein Konto auf Englisch führt, schreibt ein kurzes „ok" nicht
 * plötzlich auf Spanisch. Das Ergebnis fließt weiter in `translate()` als
 * `source` und wird bei Erfolg auch in die Nachricht zurückgeschrieben (siehe
 * unten) — ein besserer erster Wert hier verbessert also auch das, was
 * dauerhaft in der Datenbank landet.
 */
/**
 * Für jeden Ort, der eine Zeile aus message_translations OHNE Umweg über
 * translate()/translateMessage() liest — hier für den Direkttreffer unten,
 * genauso gebraucht von ws/gateway.ts: fillCachedTranslations() dort liest
 * dieselbe Tabelle über eine EIGENE SQL-Abfrage (siehe Bericht) und braucht
 * darum dieselbe Nachbildung der Sentinel-Nummerierung. Exportiert genau
 * dafür — ws/gateway.ts ist für diese Änderung gerade gesperrt, die Stelle
 * ist beschrieben statt gesetzt.
 *
 * Liefert dieselbe Sentinel-Nummerierung wie ein frischer translate()-
 * Aufruf, aber ohne dessen ganze Maschinerie — nur Erkennung, kein LLM-
 * Aufruf nötig. Funktioniert, weil findMeasurements() rein und
 * deterministisch ist: derselbe (glossar-maskierte) Text liefert immer
 * dieselben Treffer in derselben Reihenfolge, egal ob heute oder beim
 * ursprünglichen Entstehen der Cache-Zeile.
 */
export function messwerteRecordFuer(text: string, targetLang: string): Record<number, Messwert> | undefined {
  const { protectedTerms } = glossaryFor(targetLang);
  const { masked } = maskText(text, { protectedTerms });
  const funde = findMeasurements(masked);
  return funde.length ? Object.fromEntries(funde.map((m, i) => [i, m])) : undefined;
}

/**
 * Ab hier zählt eine Erkennung überhaupt — darunter ist sie ein Ratespiel.
 * languages.ts liefert für kurzen, hinweisfreien ASCII-Text unbeirrt
 * `{ lang: 'en', confidence: 0.15 }` zurück; ohne diese Schwelle wird aus
 * "keine Ahnung" ein hartes "englisch", und zwei Übersetzungswege bauen
 * darauf: schon-Zielsprache (dann NOOP, das Original bleibt stehen) und die
 * Zeile "Ausgangssprache ist X" im Prompt (dann eine Lüge ans Modell). Beide
 * Male gemeinsam mit quellspracheSchaetzen() unten und
 * erkennungOderAutorensprache() weiter unten, damit die Grenze überall
 * dieselbe ist.
 */
const SPRACH_SCHWELLE = 0.35;

function quellspracheSchaetzen(text: string, userId: string): string {
  const erkannt = detectLanguage(text);
  const genugText = woerter(text).length >= ECHO_MIN_WOERTER;
  if (erkannt.lang !== 'unknown' && erkannt.confidence >= SPRACH_SCHWELLE && genugText) {
    return erkannt.lang;
  }
  const eigene = db.get<{ language: string }>('SELECT language FROM users WHERE id = ?', userId)?.language;
  return eigene ? normalizeLang(eigene) : (erkannt.lang !== 'unknown' ? erkannt.lang : 'en');
}

/**
 * Dieselbe Schwelle wie quellspracheSchaetzen(), aber für Inhalte ohne
 * schreibende Person am anderen Ende einer laufenden Unterhaltung: Kanalname/
 * -thema, eine Umfragenfrage, eine Änderungsliste. translateChannel(),
 * translatePoll() und translateReleaseNotes() reichten bisher `sourceLang:
 * null` durch — translate() erkannte dann selbst, aber ungeprüft, siehe
 * SPRACH_SCHWELLE oben. Reicht die Erkennung nicht, gilt die Sprache, in der
 * die Autorin/der Autor des Inhalts sonst schreibt (Kontospalte `language`,
 * Vorgabe 'de', siehe db/schema.sql) — dieselbe Idee wie bei
 * quellspracheSchaetzen(), nur mit der verfassenden statt der lesenden
 * Person, weil hier niemand für sich selbst übersetzt bekommt, sondern etwas
 * veröffentlicht, das alle sehen.
 */
function erkennungOderAutorensprache(text: string, autorId: string): string {
  const erkannt = detectLanguage(text);
  if (erkannt.lang !== 'unknown' && erkannt.confidence >= SPRACH_SCHWELLE) return erkannt.lang;
  const autor = db.get<{ language: string }>('SELECT language FROM users WHERE id = ?', autorId)?.language;
  return autor ? normalizeLang(autor) : (erkannt.lang !== 'unknown' ? erkannt.lang : 'en');
}

/**
 * Wählt zwischen der kontextreichen und der kontextlosen Übersetzung, wenn
 * die Polaritäts-Wache (siehe translateMessage(), polaritaet.ts) beide
 * parallel angefordert hat. Widersprechen sich beide messbar in der
 * Polarität, gewinnt die kontextlose Fassung. Schlägt eine Seite fehl
 * (unübersetzt/noop), zählt — falls möglich — die andere; ein Widerspruch
 * lässt sich ohnehin nur beurteilen, wenn beide Seiten echten Text tragen.
 */
function waehleBeiPolaritaetswache(
  mitKontext: TranslateOutcome, ohneKontext: TranslateOutcome, zielsprache: string,
): TranslateOutcome {
  const mitBrauchbar = !mitKontext.unuebersetzt && !mitKontext.noop;
  const ohneBrauchbar = !ohneKontext.unuebersetzt && !ohneKontext.noop;
  if (mitBrauchbar && ohneBrauchbar && polaritaetsWiderspruch(ohneKontext.text, mitKontext.text, zielsprache)) {
    return ohneKontext;
  }
  if (!mitBrauchbar && ohneBrauchbar) return ohneKontext;
  return mitKontext;
}

export async function translateMessage(
  messageId: string,
  targetLang: string,
  opts: { force?: boolean; context?: string | null } = {},
): Promise<TranslationView | null> {
  const target = normalizeLang(targetLang);
  const roh = db.get<MessageRow>(
    'SELECT id, channel_id, user_id, text, source_lang, deleted_at, created_at FROM messages WHERE id = ?', messageId,
  );
  if (!roh || roh.deleted_at) return null;
  // In der Tabelle liegt nur das Chiffrat — ab hier wird mit Klartext gearbeitet.
  const msg = { ...roh, text: entschluesseln(roh.text) };
  /* Rückhalt, kein Ersatz: der Aufrufer (ws/gateway.ts) übersetzt nie aus
     einem vertraulichen Kanal (istE2EChiffrat(message.text) dort, siehe
     Auftrag). Diese Prüfung greift am Inhalt und fängt damit auch jeden
     künftigen Aufrufer, der das vergisst — genau das Muster aus
     services/ai.ts (zeile()). */
  if (istE2EChiffrat(msg.text)) return null;

  const hash = sha1(msg.text);

  if (!opts.force) {
    const cached = db.get<{ text: string; provider: string; model: string | null; confidence: number | null; source_hash: string }>(
      'SELECT text, provider, model, confidence, source_hash FROM message_translations WHERE message_id = ? AND lang = ?',
      messageId, target,
    );
    // Nur gültig, wenn Text UND Provider noch dieselben sind. Sonst zeigt die
    // App nach einem Providerwechsel ewig die alten Ergebnisse an.
    if (cached && cached.source_hash === hash && cached.provider === provider.name) {
      return {
        lang: target, text: entschluesseln(cached.text), provider: cached.provider, model: cached.model,
        confidence: cached.confidence, cached: true, measurements: messwerteRecordFuer(msg.text, target),
      };
    }
  }

  /* siehe verlauf.ts — opts.context (channelContext() aus ws/gateway.ts) ist
     bislang Kanalname/Thema/Zweck, nie eine vorherige Nachricht. Ergänzt,
     nicht ersetzt: ws/gateway.ts ist für die Kanal-Metadaten-Zeile gerade
     gesperrt (siehe Auftrag).

     NUR für eine Zielsprache mit geprüfter Polaritäts-Wache
     (ZIELSPRACHEN_MIT_GEPRUEFTER_WACHE oben) — WACHE ZUERST, DANN KONTEXT,
     NICHT UMGEKEHRT (Entscheidung der Koordination). Der gemeldete Fehler
     entsteht, wenn eine elliptische Absage auf Gesprächskontext trifft; das
     hängt an nichts, was mit der Zielsprache zu tun hat, nur die Prüfbarkeit
     ändert sich von Sprache zu Sprache. Kontext an eine Zielsprache OHNE
     geprüfte Wache zu geben, hieße also denselben Fehler ungeprüft
     auszuliefern statt ihn zu vermeiden.

     Für jede andere Zielsprache bleibt `verlauf` deshalb null, und ALLES
     Folgende in dieser Funktion — kurzUndMitVerlauf, die Wache selbst —
     kommt dann gar nicht zum Tragen: ein einzelner Aufruf mit den
     Kanal-Metadaten als einzigem Kontext, exakt der Stand vor jeder
     Kontext-Änderung. Kein Vorteil, aber auch kein neues Risiko. */
  const verlauf = ZIELSPRACHEN_MIT_GEPRUEFTER_WACHE.includes(target)
    ? verlaufAlsKontext(verlaufVorNachricht(msg.channel_id, msg.created_at, msg.id))
    : null;
  const kontext = kontextZusammenfuehren(opts.context, verlauf);

  /* translation_memory cacht nach (Anbieter, Sprachen, maskierter Text) —
     Kontext ist NICHT Teil des Schlüssels (tmKey oben, unverändert: ein
     Schlüssel je Kontext zerschlagen hätte den Speicher genau für die
     kurzen, oft wiederholten Phrasen, für die er am meisten spart — "ok",
     "danke", "np" brauchen ihn nicht neu, egal in welchem Gespräch).
     Für eine KURZE Nachricht MIT echtem Gesprächsverlauf gilt die Abwägung
     umgekehrt: "kein Problem", "geht klar", "passt" wiederholen sich
     wortgleich quer durch viele verschiedene Gespräche, und gerade dort
     hängt die richtige Übersetzung am Kontext (siehe Auftrag, Beispiel
     "mache ich kein problem"). Ein Treffer aus einem ANDEREN Gespräch —
     ohne oder mit anderem Kontext entstanden — würde die Kontext-Ergänzung
     oben für genau die Fälle wirkungslos machen, für die sie gebaut wurde.
     Deshalb hier derselbe Weg wie bei einer erzwungenen Neuübersetzung
     (skipCache) — nur für diese enge Randbedingung: kurz UND Verlauf
     vorhanden. Für alles andere (die weit überwiegende Mehrheit: längere
     Nachrichten oder keine vorherige Nachricht im Kanal) bleibt der
     Modellaufruf so selten wie vorher. */
  const kurzUndMitVerlauf = Boolean(verlauf) && woerter(msg.text).length <= KURZTEXT_WOERTER_SCHWELLE;
  const sourceLang = msg.source_lang ?? quellspracheSchaetzen(msg.text, msg.user_id);

  /* Reine Kennzahl — siehe METRIK_* oben. METRIK_UEBERSETZUNGEN_GESAMT zählt
     jede frische Übersetzungs-Entscheidung (nach dem Cache-Treffer weiter
     oben), in jeder Zielsprache. METRIK_KURZ_MIT_VERLAUF zählt, wie oft
     kurzUndMitVerlauf zutrifft — und misst damit den tatsächlichen Anteil
     der HEUTE AKTIVEN (also: Englisch-)Bevölkerung, NICHT, wie groß sie
     wäre, gäbe es die Wache schon für jede Sprache: `verlauf` ist für jede
     andere Zielsprache absichtlich null (siehe oben), also ist
     kurzUndMitVerlauf dort ebenfalls immer falsch, ganz unabhängig davon,
     ob echter Gesprächsverlauf vorläge. Der Quotient beider Zahlen
     beantwortet also "wie oft zahlen wir heute die zweite Anfrage", nicht
     "wie groß wäre die Bevölkerung über alle Sprachen hinweg". */
  metrikHochzaehlen(METRIK_UEBERSETZUNGEN_GESAMT);
  if (kurzUndMitVerlauf) metrikHochzaehlen(METRIK_KURZ_MIT_VERLAUF);

  /* Polaritäts-Wache (siehe polaritaet.ts, Auftrag der Koordination).
     Gemessen (scripts/polaritaet-messen.mjs, 216 Läufe + Rückfall-Kontrolle):
     "lass mal lieber" nach einem Vorschlag kippt mit Kontext zuverlässig von
     einer Absage zu "Let's just do it live" — flüssig, plausibel, falsch
     herum. Eine Anweisungszeile ("Polarität hat Vorrang") schloss das NICHT
     und kostete stattdessen den einen sauber belegten Gewinn der
     Kontext-Ergänzung (den "geht klar"-Fall). Deshalb: nicht verhindern,
     erkennen. Nur für Englisch (polaritaetsWiderspruch() ist nur dafür
     geprüft — für jede andere Zielsprache bleibt es beim einfachen Aufruf).

     Zwei Aufrufe GLEICHZEITIG (Promise.all — auf dem Pi gemessen rund
     1,1 s statt 1,5 s nacheinander, gegenüber rund 0,7-1,0 s für einen
     einzelnen Aufruf; siehe Bericht). Widersprechen sich die beiden
     Ergebnisse in der Polarität, gewinnt die kontextlose Fassung — ihr
     Fehlerbild ist eine Übersetzung, die eine lesende Person hinterfragt
     ("I'm not making a problem" klingt komisch), nicht eine flüssige
     Anweisung, die falsch herum ist.

     skipWrite bei der kontextreichen Fassung: ihr Ergebnis gilt nur für
     DIESES Gespräch, aber translation_memory cacht ohne Kontext im
     Schlüssel (tmKey oben) — ohne skipWrite würde ein Wettlauf zwischen
     den beiden PARALLELEN Aufrufen hier entscheiden, welche der beiden
     Fassungen ein ganz ANDERES Gespräch später aus dem geteilten Speicher
     bekäme. Die kontextlose Fassung bleibt dagegen teilbar — genau der
     Aufruf, den es vor der ersten Kontext-Änderung gab.

     Frühere Fassung gab denselben `kontext` (mit echtem Gesprächsverlauf
     drin) auch unten im else-Zweig weiter — für jede LANGE Nachricht mit
     Verlauf, für die kurzUndMitVerlauf() nicht gilt — und schaltete
     folgerichtig auch dort skipWrite scharf. Das drehte translation_memory
     für JEDE englische Nachricht mit Verlauf ab, unabhängig von der Länge
     (siehe Auftrag, Fund 7): Der Gewinn der Kontext-Ergänzung ist aber nur
     für die enge Randbedingung oben gemessen (kurz UND Verlauf, 216 Läufe,
     scripts/polaritaet-messen.mjs) — für lange Nachrichten liegt dazu keine
     Messung vor, und eine lange, in sich abgeschlossene Nachricht ist
     ohnehin nicht die elliptische Absage, an der Kontext hier etwas dreht.
     Der else-Zweig bekommt deshalb wieder nur die Kanal-Metadaten
     (`opts.context`) als Kontext — der Stand vor der Verlauf-Ergänzung,
     ungemessen blieb ungeändert. Ohne echten Gesprächsverlauf im Kontext
     ist die Übersetzung dort wieder teilbar, also kein skipWrite nötig:
     die Korrektheitsgarantie (eine mit Kontext erzeugte Übersetzung darf
     nie ohne diesen Kontext wieder ausgeliefert werden) bleibt gewahrt,
     weil dort schlicht kein Kontext mehr hineingerät, der sie verletzen
     könnte. */
  const mitWache = kurzUndMitVerlauf && ZIELSPRACHEN_MIT_GEPRUEFTER_WACHE.includes(target);

  let outcome: TranslateOutcome;
  if (mitWache) {
    const [mitKontext, ohneKontext] = await Promise.all([
      translate({
        text: msg.text, targetLang: target, sourceLang, context: kontext,
        skipCache: true, skipWrite: true, messwerte: true,
      }),
      translate({
        text: msg.text, targetLang: target, sourceLang, context: opts.context ?? null,
        skipCache: opts.force, messwerte: true,
      }),
    ]);
    outcome = waehleBeiPolaritaetswache(mitKontext, ohneKontext, target);
  } else {
    // kurzUndMitVerlauf ist hier immer falsch (sonst wäre mitWache wahr,
    // siehe oben) — Verlauf im Kontext bleibt also auf den if-Zweig
    // beschränkt, siehe Begründung oben. Deshalb hier bewusst
    // `opts.context` statt `kontext`, und kein skipWrite.
    outcome = await translate({
      text: msg.text,
      targetLang: target,
      sourceLang,
      context: opts.context ?? null,
      skipCache: opts.force,
      messwerte: true,
    });
  }

  /* Zwischen dem deleted_at-Check ganz oben und hier liegt ein `await` — bei
     einem Cache-Fehlschlag geht der zum Übersetzungsanbieter und zurück,
     keine Kleinigkeit. In dieser Lücke kann deleteMessage() (services/
     messages.ts) durchlaufen: es setzt deleted_at synchron und ruft dabei
     dropMessageTranslations(messageId) auf — die findet HIER, in diesem
     Moment, noch keine Zeile (die INSERT unten ist ja noch nicht passiert)
     und ist darum ein No-op. Ohne diese zweite Prüfung würde der Rest der
     Funktion die Löschung schlicht nicht bemerken: erst schriebe sie die
     erkannte Ausgangssprache auf die gelöschte Zeile, dann — das eigentliche
     Problem — den vollen Klartext der gelöschten Nachricht per INSERT zurück
     in message_translations UND translation_memory, obwohl deleted_at längst
     gesetzt ist. Per Reproduktion bestätigt (siehe Auftrag): ohne diese
     Prüfung bleibt genau das stehen.
     Deshalb hier noch einmal denselben Zustand nachsehen, nicht dem
     msg-Snapshot von vor dem Warten vertrauen — und bei Treffer derselbe
     frühe Ausstieg wie ganz oben, denn ab hier lohnt sich kein Schreiben
     mehr. outcome.memoryKey (falls translate() dabei einen neuen
     Satz-Cache-Eintrag in translation_memory angelegt oder einen
     bestehenden getroffen hat) bleibt dabei unangetastet: ein frischer
     Eintrag steht mit verweise=0 da, weil ihn keine message_translations-
     Zeile referenziert — derselbe, dokumentiert normale Zustand wie bei
     Umfragen/Kanalangaben, kein Aufruf von tmVerweiseNachrechnen() nötig,
     um das nachzuziehen. Ein bereits bestehender Treffer bleibt exakt bei
     dem Verweiszähler, den die ANDEREN, weiter existierenden Nachrichten
     ihm zurecht geben — auch den fasst dieser Ausstieg nicht an. */
  const rohJetzt = db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM messages WHERE id = ?', messageId);
  if (!rohJetzt || rohJetzt.deleted_at) return null;

  // Hat das Modell die Ausgangssprache bestimmt, wo wir unsicher waren?
  // Dann festhalten — davon profitieren alle weiteren Empfänger und die Suche.
  if (!msg.source_lang && outcome.sourceLang && outcome.sourceLang !== 'unknown') {
    db.run('UPDATE messages SET source_lang = ? WHERE id = ?', outcome.sourceLang, messageId);
  }

  /* Es kam eine Antwort, aber keine Übersetzung — der Eingabetext, ein
     zerschossener Platzhalter oder ein Fehler beim Anbieter. Nichts
     speichern: die Nachricht bleibt unübersetzt stehen. Der Vermerk geht
     trotzdem hinaus, damit die Oberfläche „Original in Englisch" schreiben
     kann statt „Übersetzt aus Englisch". */
  if (outcome.unuebersetzt) {
    return {
      lang: target, text: outcome.text, provider: outcome.provider, model: outcome.model,
      confidence: 0, cached: outcome.cached, unuebersetzt: true, measurements: outcome.measurements,
    };
  }

  /* "noop" hieß bisher immer: nichts weiterzugeben, der Client zeigt ohnehin
     schon message.text. Das stimmt nicht mehr uneingeschränkt — Ausgangs-
     und Zielsprache können gleich sein (zwei „en"-Konten, eine Nachricht auf
     Englisch) und TROTZDEM eine Maßangabe enthalten, die für genau diese
     Empfängerin noch in ihre Einheit übersetzt werden muss (25 °C bleibt
     Englisch -> Englisch, aber für Denver trotzdem 77 °F). Ohne diese
     Ausnahme bekäme so ein Fall nie eine TranslationView — und der Sentinel
     aus messwerteMaskieren() hätte nie eine Chance, aufgelöst zu werden. */
  if (outcome.noop) {
    if (!outcome.measurements) return null;
    return {
      lang: target, text: outcome.text, provider: outcome.provider, model: outcome.model,
      confidence: outcome.confidence, cached: outcome.cached, measurements: outcome.measurements,
    };
  }

  /* Ersetzt diese Übersetzung eine frühere (Provider gewechselt, erzwungener
     Neuversuch), hing die alte Zeile an einem eigenen Schlüssel in
     translation_memory — den holt niemand mehr, wenn die neue Zeile ihn
     überschreibt. Deshalb vorher lesen, nicht raten. */
  const vorherigerSchluessel = db.get<{ tm_key: string | null }>(
    'SELECT tm_key FROM message_translations WHERE message_id = ? AND lang = ?', messageId, target,
  )?.tm_key ?? null;

  db.run(
    `INSERT INTO message_translations (message_id, lang, text, provider, model, confidence, source_hash, tm_key, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(message_id, lang) DO UPDATE SET
       text = excluded.text, provider = excluded.provider, model = excluded.model,
       confidence = excluded.confidence, source_hash = excluded.source_hash,
       tm_key = excluded.tm_key, created_at = excluded.created_at`,
    messageId, target, verschluesseln(outcome.text), outcome.provider, outcome.model, outcome.confidence,
    hash, outcome.memoryKey, Date.now(),
  );
  reindexMessage(messageId);
  // Alter und neuer Schlüssel können sich dadurch geändert haben, wie viele
  // Nachrichten sie noch halten — siehe tmVerweiseNachrechnen().
  tmVerweiseNachrechnen([vorherigerSchluessel, outcome.memoryKey]);

  return {
    lang: target, text: outcome.text, provider: outcome.provider,
    model: outcome.model, confidence: outcome.confidence, cached: outcome.cached,
    measurements: outcome.measurements,
  };
}

/**
 * DER KNACKPUNKT (siehe Auftrag): message_translations/translation_memory
 * sind pro (Nachricht, Zielsprache) zwischengespeichert — bewusst geteilt
 * zwischen allen Empfänger:innen dieser Sprache, siehe translate()/
 * translateMessage() oben. Zwei Personen mit target=lang="en", eine in
 * Denver, eine in London, bekommen deshalb GENAU dieselbe TranslationView
 * aus dem Cache — mit ⟦m0⟧-Sentinels statt fertiger Zahlen an der Stelle
 * jeder Maßangabe (siehe messwerteMaskieren, einheiten.ts).
 *
 * Diese Funktion ist der einzige Ort, an dem ein Sentinel durch eine
 * fertige, für EINE bestimmte Person passende Zahl ersetzt wird — reine,
 * synchrone Zeichenkettenarbeit, kein Netz- oder Datenbankzugriff, beliebig
 * oft wiederholbar für beliebig viele Empfänger:innen derselben gecachten
 * Übersetzung. `region` kommt aus regionFuerZeitzone(user.timezone), `sprache`
 * aus DEMSELBEN `target`/`lang`, das an dieser Stelle ohnehin schon für
 * translateMessage() gilt (User.language — die Sprache, IN DIE übersetzt
 * wird — NICHT SelfUser.uiLanguage, das nur Menüs/Knöpfe betrifft und mit der
 * Übersetzungssprache auseinanderfallen kann).
 *
 * WICHTIG: das muss an JEDER Stelle laufen, die eine TranslationView über die
 * Leitung an genau eine Person schickt. Stand bei der Untersuchung für dieses
 * Modul (ws/gateway.ts ist gesperrt, eine andere Änderung läuft dort gerade —
 * hier nur beschrieben, nicht gesetzt):
 *   - jeder der sechs Orte, die ein `{ t: 'translation', … }`-Ereignis
 *     verschicken (sendToUser bzw. send(session, …), aktuell in etwa bei den
 *     Zeilen 431, 564, 1217, 1485, 1526, 2812 — Zeilennummern verschieben
 *     sich, der Text `{ t: 'translation'` findet sie zuverlässiger);
 *   - fillCachedTranslations() (aktuell ~Zeile 397): liest message_
 *     translations über eine EIGENE SQL-Abfrage, ohne über translateMessage()
 *     zu gehen, und setzt `m.translation` von Hand — dieselbe Stelle braucht
 *     zusätzlich `measurements: messwerteRecordFuer(m.text, target)` (jetzt
 *     exportiert, siehe oben), SONST bleibt für jede Nachricht, die NUR über
 *     den Verlauf geladen wird (nicht frisch über translateInBackground),
 *     ein ungelöster ⟦m0⟧-Sentinel im Text stehen;
 *   - jede Stelle, die `m.translation` unverändert weiterreicht (z. B. das
 *     `if (m.translation) send(session, { t: 'translation', … })` beim
 *     Öffnen eines Threads).
 *
 * Das zurückgegebene Objekt trägt `measurements` NICHT mehr — es ist bereits
 * aufgelöst und muss (und soll) nicht über die Leitung gehen.
 */
export function messwerteFuerEmpfaenger(
  view: TranslationView, region: Massregion, sprache: string,
): TranslationView {
  if (!view.measurements) return view;
  const text = messwerteInTextEinsetzen(
    view.text, view.measurements, region, dezimaltrennzeichenFuerSprache(sprache),
  );
  const { measurements: _messwerte, ...ohneMesswerte } = view;
  return { ...ohneMesswerte, text };
}

/**
 * Alle Übersetzungen einer Nachricht wegwerfen — bei einem Edit (der Text
 * passt nicht mehr) und beim Löschen (siehe services/messages.ts).
 *
 * Nimmt dabei den Übersetzungsspeicher mit: jede betroffene Zeile trug einen
 * tm_key, und der Schlüssel in translation_memory dahinter darf nur bestehen
 * bleiben, wenn ihn noch eine ANDERE Nachricht hält. Ohne diesen Schritt
 * überlebte der Inhalt einer gelöschten Nachricht — Quelle UND Übersetzung —
 * unter einem anderen Namen im Übersetzungsspeicher weiter, obwohl die
 * Nachricht selbst als gelöscht gilt.
 */
export function dropMessageTranslations(messageId: string): void {
  const schluessel = db.all<{ tm_key: string | null }>(
    'SELECT tm_key FROM message_translations WHERE message_id = ?', messageId,
  ).map((r) => r.tm_key);
  db.run('DELETE FROM message_translations WHERE message_id = ?', messageId);
  tmVerweiseNachrechnen(schluessel);
}

/**
 * Den Verweiszähler dieser Schlüssel aus der Wahrheit neu bestimmen — und
 * freigeben, was keine bestehende Nachricht mehr braucht.
 *
 * Dieselbe Machart wie verweiseNachrechnen()/freigeben() für den
 * Blockspeicher (services/bloecke.ts): nicht hoch- und runterzählen, sondern
 * nachsehen, wie viele Zeilen in message_translations gerade noch auf den
 * Schlüssel zeigen (message_translations.tm_key). Ein Zähler, den man
 * einzeln fortschreibt, läuft irgendwann auseinander — hier genügt ein Weg,
 * auf dem eine Übersetzung verschwindet, ohne dass diese Funktion gerufen
 * wird, und schon zählt es nicht mehr. Nachsehen kann sich nicht verzählen.
 *
 * Aufgeräumt wird ausdrücklich nur unter den übergebenen Schlüsseln, nicht
 * mit einem Rundumschlag über die ganze Tabelle: Zeilen, die eine Umfrage
 * oder eine Kanalangabe im selben Übersetzungsspeicher angelegt hat, tragen
 * `verweise = 0` und werden von dieser Funktion nie angefasst, wenn niemand
 * ihren Schlüssel hier übergibt — sie sind nicht Gegenstand dieser Zählung.
 *
 * Erreicht ein übergebener Schlüssel 0, heißt das: keine bestehende Nachricht
 * hält ihn mehr. Dann wird die Zeile GELÖSCHT, nicht nur auf 0 gesetzt — der
 * Übersetzungsspeicher wäre sonst der einzige Ort, an dem Quelle und
 * Übersetzung einer gelöschten Nachricht überleben.
 */
export function tmVerweiseNachrechnen(keys: Iterable<string | null | undefined>): void {
  const eindeutig = new Set<string>();
  for (const k of keys) if (k) eindeutig.add(k);
  for (const key of eindeutig) {
    db.run(
      `UPDATE translation_memory SET verweise =
         (SELECT COUNT(*) FROM message_translations WHERE tm_key = translation_memory.key)
       WHERE key = ?`,
      key,
    );
    db.run('DELETE FROM translation_memory WHERE key = ? AND verweise <= 0', key);
  }
}

/* ── Round-Trip-Prüfung ───────────────────────────────────────── */

/**
 * Übersetzt die Übersetzung zurück in die Ausgangssprache. Weicht das Ergebnis
 * stark vom Original ab, ist die Übersetzung vermutlich schief — der Nutzer
 * sieht das als Warnhinweis.
 */
export async function roundTrip(messageId: string, targetLang: string): Promise<{ backTranslation: string; similarity: number } | null> {
  const roh = db.get<MessageRow>('SELECT id, channel_id, user_id, text, source_lang, deleted_at, created_at FROM messages WHERE id = ?', messageId);
  if (!roh || roh.deleted_at) return null;
  const msg = { ...roh, text: entschluesseln(roh.text) };
  // Rückhalt, kein Ersatz — siehe derselbe Zeilenkommentar in translateMessage() oben.
  if (istE2EChiffrat(msg.text)) return null;
  const gespeichert = db.get<{ text: string }>(
    'SELECT text FROM message_translations WHERE message_id = ? AND lang = ?', messageId, normalizeLang(targetLang),
  );
  if (!gespeichert) return null;
  const translated = { text: entschluesseln(gespeichert.text) };

  // Dieselbe Schätzung wie oben — sonst schlägt der Rückweg für dieselben
  // kurzen, mehrdeutigen Nachrichten dieselbe Kapriole wie die Hinübersetzung.
  const sourceLang = msg.source_lang ?? quellspracheSchaetzen(msg.text, msg.user_id);
  const back = await translate({
    text: translated.text,
    targetLang: sourceLang,
    sourceLang: normalizeLang(targetLang),
    skipCache: true,
  });

  /* Dieselbe Lücke wie oben in translateMessage() (siehe dortiger
     Kommentar), nur ohne eigenen Schreibzugriff: roundTrip() legt selbst
     nichts in message_translations/translation_memory ab, gibt sein
     Ergebnis aber direkt an ws/gateway.ts zurück, das es 1:1 über die
     Leitung schickt (t: 'roundtrip'). Fällt deleteMessage() in dieses
     `await`, wäre der zurückgegebene Klartext sonst das Letzte, was noch
     verschickt würde, nachdem deleted_at längst gesetzt ist. Darum hier,
     symmetrisch zum Guard ganz oben, noch ein Blick, bevor überhaupt ein
     Ergebnis entsteht — ein null hier ist für den Aufrufer kein
     Sonderfall, roundTrip() lieferte den ohnehin schon (siehe oben:
     „keine Übersetzung vorhanden"). */
  const rohJetzt = db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM messages WHERE id = ?', messageId);
  if (!rohJetzt || rohJetzt.deleted_at) return null;

  // Dieselbe Messlatte wie bei der Echo-Erkennung — eine Ähnlichkeit, ein Maß.
  return { backTranslation: back.text, similarity: wortAehnlichkeit(msg.text, back.text) };
}

/* ── Glossar-Verwaltung ───────────────────────────────────────── */

export function addGlossaryEntry(input: {
  term: string; translations: Record<string, string> | null; caseSensitive?: boolean; note?: string | null; userId: string;
}) {
  const id = newId('gl_');
  db.run(
    `INSERT INTO glossary (id, term, translations, case_sensitive, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(lower(term)) DO UPDATE SET
       translations = excluded.translations, case_sensitive = excluded.case_sensitive, note = excluded.note`,
    id, input.term, input.translations ? JSON.stringify(input.translations) : null,
    input.caseSensitive ? 1 : 0, input.note ?? null, input.userId, Date.now(),
  );
  invalidateGlossary();
  return id;
}

export function removeGlossaryEntry(id: string): void {
  db.run('DELETE FROM glossary WHERE id = ?', id);
  invalidateGlossary();
}

export function listGlossary() {
  return db.all<{ id: string; term: string; translations: string | null; case_sensitive: number; note: string | null; created_by: string; created_at: number }>(
    'SELECT * FROM glossary ORDER BY term COLLATE NOCASE',
  ).map((r) => ({
    id: r.id,
    term: r.term,
    translations: r.translations ? JSON.parse(r.translations) as Record<string, string> : null,
    caseSensitive: Boolean(r.case_sensitive),
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

/* ── Umfragen übersetzen ──────────────────────────────────────── */

/** Frage und Antwortmöglichkeiten in einer Zielsprache. */
export interface PollView {
  lang: string;
  question: string;
  /** Nach Optionskennung, damit die Reihenfolge egal ist. */
  options: Record<string, string>;
  provider: string;
}

/**
 * Bereits übersetzte Umfrage aus dem Zwischenspeicher — ohne Netzzugriff.
 * Für den Verlauf: dort muss die Antwort sofort stehen.
 */
export function cachedPollView(pollId: string, targetLang: string): PollView | null {
  const target = normalizeLang(targetLang);
  const row = db.get<{ payload: string; provider: string }>(
    'SELECT payload, provider FROM poll_translations WHERE poll_id = ? AND lang = ?', pollId, target,
  );
  if (!row) return null;
  try {
    const daten = JSON.parse(entschluesseln(row.payload)) as { question: string; options: Record<string, string> };
    return { lang: target, ...daten, provider: row.provider };
  } catch { return null; }
}

/**
 * Eine Umfrage ist mehr als ihr Nachrichtentext: Frage und Antworten stehen in
 * eigenen Zeilen und blieben deshalb bisher in der Ausgangssprache stehen —
 * mitten in einem sonst übersetzten Gespräch.
 *
 * Übersetzt wird jede Zeichenkette einzeln. Zusammengefasst in einen Aufruf
 * wäre billiger, aber dann müsste man die Antwort wieder auseinandernehmen,
 * und genau daran gehen solche Verfahren zugrunde, sobald ein Modell die
 * Nummerierung anders setzt als erwartet.
 */
export async function translatePoll(
  pollId: string,
  targetLang: string,
  opts: { force?: boolean; sourceLang?: string | null } = {},
): Promise<PollView | null> {
  const target = normalizeLang(targetLang);

  const pollRoh = db.get<{ question: string; created_by: string }>(
    'SELECT question, created_by FROM polls WHERE id = ?', pollId,
  );
  if (!pollRoh) return null;
  const poll = { question: entschluesseln(pollRoh.question) };
  const optionen = db.all<{ id: string; text: string }>(
    'SELECT id, text FROM poll_options WHERE poll_id = ? ORDER BY position', pollId,
  ).map((o) => ({ ...o, text: entschluesseln(o.text) }));

  const quelle = JSON.stringify([poll.question, ...optionen.map((o) => o.text)]);
  const hash = sha1(quelle);

  if (!opts.force) {
    const cached = db.get<{ payload: string; source_hash: string; provider: string }>(
      'SELECT payload, source_hash, provider FROM poll_translations WHERE poll_id = ? AND lang = ?',
      pollId, target,
    );
    if (cached && cached.source_hash === hash && cached.provider === provider.name) {
      const daten = JSON.parse(entschluesseln(cached.payload)) as { question: string; options: Record<string, string> };
      return { lang: target, ...daten, provider: cached.provider };
    }
  }

  /* Die Ausgangssprache einmal an der Frage bestimmen und für alle Antworten
     übernehmen. Einzeln betrachtet ist "Ja, sehr" zu kurz, um erkannt zu
     werden — die Antwort bliebe dann als Einzige stehen.

     Ohne ausdrückliche Angabe ging das bisher als `sourceLang: null` an
     translate() durch, das intern ungeprüft rät (siehe SPRACH_SCHWELLE) —
     bei einer knappen Frage ohne Anhaltspunkte reichte das für ein falsches
     "englisch", stumm über das ganze Ergebnis: dieselbe (falsche) Sprache
     galt dann für jede Antwortmöglichkeit. Reicht die Erkennung nicht, gilt
     jetzt die Sprache der Person, die die Umfrage angelegt hat. */
  const quellSprache = opts.sourceLang ?? erkennungOderAutorensprache(poll.question, pollRoh.created_by);
  const frageErgebnis = await translate({
    text: poll.question, targetLang: target, sourceLang: quellSprache, skipCache: opts.force,
  });

  const uebersetze = async (text: string): Promise<string | null> => {
    const ergebnis = await translate({
      text, targetLang: target, sourceLang: quellSprache, skipCache: opts.force,
    });
    return ergebnis.noop ? null : ergebnis.text;
  };

  const frage = frageErgebnis.noop ? null : frageErgebnis.text;
  const antworten = await Promise.all(optionen.map((o) => uebersetze(o.text)));

  // Ist gar nichts zu tun — die Umfrage steht schon in der Zielsprache —,
  // hat der Aufrufer nichts anzuzeigen.
  if (frage === null && antworten.every((a) => a === null)) return null;

  const daten = {
    question: frage ?? poll.question,
    options: Object.fromEntries(
      optionen.map((o, i) => [o.id, antworten[i] ?? o.text]),
    ),
  };

  db.run(
    `INSERT INTO poll_translations (poll_id, lang, payload, source_hash, provider, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(poll_id, lang) DO UPDATE SET
       payload = excluded.payload, source_hash = excluded.source_hash,
       provider = excluded.provider, created_at = excluded.created_at`,
    pollId, target, verschluesseln(JSON.stringify(daten)), hash, provider.name, Date.now(),
  );

  return { lang: target, ...daten, provider: provider.name };
}

/* ── Kanäle übersetzen ────────────────────────────────────────── */

export interface ChannelView {
  lang: string;
  name: string | null;
  topic: string | null;
  purpose: string | null;
  provider: string;
}

/** Bereits übersetzter Kanal aus dem Zwischenspeicher — ohne Netzzugriff. */
export function cachedChannelView(channelId: string, targetLang: string): ChannelView | null {
  const target = normalizeLang(targetLang);
  const row = db.get<{ payload: string; provider: string }>(
    'SELECT payload, provider FROM channel_translations WHERE channel_id = ? AND lang = ?',
    channelId, target,
  );
  if (!row) return null;
  try {
    // entschluesseln reicht Klartext unverändert durch — Altbestand bleibt lesbar.
    const daten = JSON.parse(entschluesseln(row.payload)) as Omit<ChannelView, 'lang' | 'provider'>;
    return { lang: target, ...daten, provider: row.provider };
  } catch { return null; }
}

/**
 * Name, Thema und Zweck eines Kanals in einer Zielsprache.
 *
 * Der Name bleibt technisch, wie er ist — Erwähnungen wie #vertrieb müssen
 * für alle dieselben bleiben, sonst zeigt ein Link ins Leere. Übersetzt wird
 * nur, was angezeigt wird. Ein Name aus einem einzigen Wort wird dabei
 * mitgenommen, ein Kürzel wie "q3-2026" bleibt stehen.
 */
export async function translateChannel(
  channelId: string,
  targetLang: string,
  opts: { force?: boolean } = {},
): Promise<ChannelView | null> {
  const target = normalizeLang(targetLang);
  const kanal = db.get<{
    name: string; topic: string | null; purpose: string | null; kind: string;
    primary_language: string | null; created_by: string;
  }>(
    'SELECT name, topic, purpose, kind, primary_language, created_by FROM channels WHERE id = ?', channelId,
  );
  if (!kanal || kanal.kind === 'dm') return null;

  const quelle = JSON.stringify([kanal.name, kanal.topic, kanal.purpose]);
  const hash = sha1(quelle);

  if (!opts.force) {
    const cached = db.get<{ payload: string; source_hash: string; provider: string }>(
      'SELECT payload, source_hash, provider FROM channel_translations WHERE channel_id = ? AND lang = ?',
      channelId, target,
    );
    if (cached && cached.source_hash === hash && cached.provider === provider.name) {
      const daten = JSON.parse(cached.payload) as Omit<ChannelView, 'lang' | 'provider'>;
      return { lang: target, ...daten, provider: cached.provider };
    }
  }

  /* Name/Thema/Zweck gingen bisher mit `sourceLang: null` an translate() —
     die interne Erkennung dort prüft ihre eigene Zuversicht nicht (siehe
     SPRACH_SCHWELLE): ein kurzes, hinweisfreies Thema landete als "englisch"
     und blieb bei Zielsprache Englisch fälschlich unübersetzt stehen, oder
     bekam bei jeder anderen Zielsprache eine falsche Ausgangssprache
     vorgesetzt. Ist eine Sprache für den Kanal ausdrücklich eingetragen
     (primary_language, in den Kanaleinstellungen wählbar), gilt die immer —
     sie ist eine bewusste Angabe, keine Vermutung. Sonst zählt die Sprache
     der Person, die den Kanal angelegt hat, wenn die Erkennung selbst nicht
     reicht. */
  const quellSprache = kanal.primary_language ? normalizeLang(kanal.primary_language) : null;
  const uebersetze = async (text: string | null): Promise<string | null> => {
    if (!text?.trim()) return null;
    const sourceLang = quellSprache ?? erkennungOderAutorensprache(text, kanal.created_by);
    const ergebnis = await translate({ text, targetLang: target, sourceLang });
    return ergebnis.noop ? null : ergebnis.text;
  };

  // Namen mit Ziffern, Bindestrichen oder Punkten sind Kürzel und bleiben.
  const nameUebersetzbar = /^[\p{L}][\p{L}\s-]{2,}$/u.test(kanal.name) && !/\d/.test(kanal.name);

  const [name, topic, purpose] = await Promise.all([
    nameUebersetzbar ? uebersetze(kanal.name) : Promise.resolve(null),
    uebersetze(kanal.topic),
    uebersetze(kanal.purpose),
  ]);

  if (!name && !topic && !purpose) return null;

  const daten = { name, topic, purpose };
  db.run(
    `INSERT INTO channel_translations (channel_id, lang, payload, source_hash, provider, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(channel_id, lang) DO UPDATE SET
       payload = excluded.payload, source_hash = excluded.source_hash,
       provider = excluded.provider, created_at = excluded.created_at`,
    // Thema und Zweck eines Kanals sind Inhalt, kein Beiwerk — sie gehören
    // genauso verschlüsselt wie jede Nachricht.
    channelId, target, verschluesseln(JSON.stringify(daten)), hash, provider.name, Date.now(),
  );
  return { lang: target, ...daten, provider: provider.name };
}

/* ── Änderungslisten von Fassungen übersetzen ────────────────────
   Was neu ist ("release notes"), tippt frei ein, wer veröffentlicht — bisher
   ging der deutsche Wortlaut unverändert an jede Person, egal welche Sprache
   ihre Oberfläche zeigt (UpdatePanel.tsx, UpdateBanner.tsx, die
   Serverauszeit-Ankündigung in ws/gateway.ts und die Download-Seite lesen
   alle denselben `notes`-Text). Derselbe Aufbau wie bei Kanälen: ein
   Zwischenspeicher je (Fassung, Zielsprache) für den schnellen, synchronen
   Weg — und eine Funktion, die bei einer Lücke wirklich übersetzt und
   ablegt. Anders als beim Kanalnamen ist hier nichts technisch daran
   gebunden: der ganze Text darf übersetzt werden. */

/** Bereits übersetzte Änderungsliste aus dem Zwischenspeicher — ohne Netzzugriff. */
export function cachedReleaseNotes(platform: string, targetLang: string): string | null {
  const target = normalizeLang(targetLang);
  const row = db.get<{ payload: string }>(
    'SELECT payload FROM release_translations WHERE platform = ? AND lang = ?',
    platform, target,
  );
  if (!row) return null;
  try { return entschluesseln(row.payload); } catch { return null; }
}

/**
 * Änderungsliste einer Fassung in eine Zielsprache bringen und ablegen.
 *
 * Läuft im Hintergrund, nie im Antwortpfad einer Anfrage: wer gerade prüft,
 * ob es ein Update gibt, soll darauf nicht warten müssen — siehe die
 * Aufrufer in http/routes.ts und ws/gateway.ts, die alle sofort mit dem
 * Original antworten und diese Funktion nur zum Nachfüllen des
 * Zwischenspeichers anstoßen, ohne auf sie zu warten.
 *
 * Liefert null, wenn nichts zu übersetzen war (keine Notizen), der Text
 * schon in der Zielsprache steht, oder die Übersetzung gerade nicht
 * gelingt (Pi nicht erreichbar, Anbieter ausgetauscht, …) — in jedem dieser
 * Fälle bleibt der Zwischenspeicher unangetastet und der Aufrufer zeigt das
 * Original, statt eine leere oder falsche Übersetzung abzulegen. Ein
 * Fehlschlag wird also NIE dauerhaft gemerkt: der nächste Aufruf (nächste
 * Prüfung, nächster Seitenaufruf) versucht es einfach wieder — genau wie
 * translateChannel() es für Kanalangaben schon tut.
 */
export async function translateReleaseNotes(
  platform: string,
  targetLang: string,
  opts: { force?: boolean } = {},
): Promise<string | null> {
  const target = normalizeLang(targetLang);
  const zeile = db.get<{ notes: string | null; published_by: string }>(
    'SELECT notes, published_by FROM releases WHERE platform = ?', platform,
  );
  if (!zeile?.notes?.trim()) return null;

  const hash = sha1(zeile.notes);
  if (!opts.force) {
    const cached = db.get<{ payload: string; source_hash: string; provider: string }>(
      'SELECT payload, source_hash, provider FROM release_translations WHERE platform = ? AND lang = ?',
      platform, target,
    );
    if (cached && cached.source_hash === hash && cached.provider === provider.name) {
      try { return entschluesseln(cached.payload); } catch { /* fällt durch, wird neu übersetzt */ }
    }
  }

  /* Die Quellsprache ist nicht garantiert Deutsch — wer veröffentlicht tippt
     frei. Vorher ging deshalb `sourceLang: null` an translate() durch, dessen
     eigene Erkennung ihre Zuversicht nicht prüft (SPRACH_SCHWELLE): genau der
     Fall, für den diese Funktion heute (22.08.2026) angelegt wurde — eine
     kurze, deutsche Änderungsliste ("Fehler beim Login behoben") hat kaum
     hinweisträchtige Wörter und wäre als "englisch" erkannt worden, damit bei
     Zielsprache Englisch fälschlich NOOP geblieben und bei jeder anderen
     Sprache mit einer falschen Ausgangssprache im Prompt gelandet — beides
     zeigt Kolleg*innen wieder den deutschen Text, den diese Funktion gerade
     verhindern soll. Reicht die Erkennung nicht, gilt die Sprache der Person,
     die veröffentlicht hat. */
  const sourceLang = erkennungOderAutorensprache(zeile.notes, zeile.published_by);
  const ergebnis = await translate({ text: zeile.notes, targetLang: target, sourceLang });
  // noop heißt entweder "steht schon in der Zielsprache" oder "gerade nicht
  // übersetzbar" (Pi offline, Modell schweigt, Echo) — in beiden Fällen ist
  // das Original die richtige Anzeige, und es gibt nichts abzulegen.
  if (ergebnis.noop) return null;

  db.run(
    `INSERT INTO release_translations (platform, lang, payload, source_hash, provider, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(platform, lang) DO UPDATE SET
       payload = excluded.payload, source_hash = excluded.source_hash,
       provider = excluded.provider, created_at = excluded.created_at`,
    // Verschlüsselt wie jeder andere gespeicherte Text auch.
    platform, target, verschluesseln(ergebnis.text), hash, provider.name, Date.now(),
  );
  return ergebnis.text;
}
