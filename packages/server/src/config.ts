import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Vault, resolvePassphrase } from './secrets.js';
import { neuesSchluesselpaar } from './crypto/ec.js';

/**
 * Die Daten hängen am Server-Paket, nicht am Arbeitsverzeichnis.
 *
 * Vorher entschied das aktuelle Verzeichnis darüber, wo Datenbank und Tresor
 * liegen: aus dem Projektwurzelverzeichnis gestartet fand der Server einen
 * anderen Datenbestand als aus packages/server heraus — mit leerer Datenbank
 * und ohne Schlüssel, ohne dass irgendetwas kaputt aussah.
 *
 * Diese Datei liegt in src/ beziehungsweise dist/; eine Ebene darüber ist das
 * Paketverzeichnis.
 */
const paketWurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

/**
 * Ein ausdrücklich gesetzter Pfad gilt relativ zum Arbeitsverzeichnis — wer ihn
 * angibt, meint das, was er gerade vor sich hat. Die Vorgabe dagegen hängt am
 * Paket und bleibt damit überall dieselbe.
 */
function ordner(name: string, vorgabe: string): string {
  const gesetzt = str(name);
  return gesetzt ? path.resolve(process.cwd(), gesetzt) : path.resolve(paketWurzel, vorgabe);
}

const dataDir = ordner('DATA_DIR', 'data');
const uploadDir = ordner('UPLOAD_DIR', path.join(dataDir, 'uploads'));
fs.mkdirSync(dataDir, { recursive: true });
const storageDir = ordner('STORAGE_DIR', path.join(dataDir, 'storage'));
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(storageDir, { recursive: true });
const releaseDir = ordner('RELEASE_DIR', path.join(dataDir, 'releases'));
fs.mkdirSync(releaseDir, { recursive: true });

/** Secret persistieren, damit Tokens einen Neustart überleben. */
function resolveSecret(): string {
  const fromEnv = str('JWT_SECRET');
  if (fromEnv && fromEnv !== 'bitte-aendern-langer-zufalls-string') return fromEnv;
  const file = path.join(dataDir, '.jwt-secret');
  /* Eine LEERE Datei zählt wie keine. Sie entsteht, wenn der Strom zwischen
     Anlegen und Schreiben wegbricht — auf der Speicherkarte des Pi kein
     exotischer Fall. Vorher kam dann '' zurück, und jedes Token wurde mit
     einem leeren HMAC-Schlüssel unterschrieben: jeder hätte sich eines für
     jede Kontokennung selbst ausstellen können, ohne dass etwas kaputt aussah. */
  try {
    const gelesen = fs.readFileSync(file, 'utf8').trim();
    if (gelesen) return gelesen;
  } catch { /* noch keine Datei — gleich unten erzeugen */ }
  const gen = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, gen, { mode: 0o600 });
  console.warn('[config] JWT_SECRET nicht gesetzt — generiertes Secret in data/.jwt-secret abgelegt.');
  return gen;
}

/**
 * Das Schlüsselpaar für Web Push (VAPID, RFC 8292).
 *
 * Anders als der Groq-Schlüssel ist das kein Zugang zu einem fremden Dienst,
 * den nur der Auftraggeber besitzen kann — es ist ein Beweis "diese Nachricht
 * stammt vom selben Server, der das Abonnement entgegengenommen hat", den
 * niemand von außen vorgeben muss. Deshalb derselbe Weg wie beim JWT_SECRET:
 * gesetzt in der Umgebung gewinnt, sonst ein einmal erzeugtes und in
 * data/.vapid-keys.json abgelegtes Paar. Niemand muss von Hand ein
 * Schlüsselpaar erzeugen, damit Benachrichtigungen ankommen.
 *
 * Wird die Datei verworfen oder auf einen anderen Rechner umgezogen, ändert
 * sich der Schlüssel — jedes bestehende Abonnement wird dann vom Push-Dienst
 * abgelehnt (403). Das ist kein Fehlerfall, den man beheben müsste: der
 * Client meldet sich beim nächsten Öffnen ohnehin neu an (siehe
 * push.ts / push:subscribe), das alte Abonnement räumt sich mit dem nächsten
 * Fehlschlag selbst weg.
 *
 * Beide Werte, falls über die Umgebung gesetzt, stehen als base64url-Text
 * ohne Auffüllzeichen da — genau die Form, in der `npx web-push
 * generate-vapid-keys` sie ausgibt, falls der Auftraggeber lieber ein
 * eigenes Paar einträgt.
 */
function resolveVapidKeys(): { publicKey: string; privateKey: string } {
  const envPub = str('VAPID_PUBLIC_KEY');
  const envPriv = str('VAPID_PRIVATE_KEY');
  if (envPub && envPriv) {
    try {
      // Nur die Länge prüfen — ob es wirklich ein gültiger Punkt ist, zeigt
      // sich beim ersten Signieren, und dann steht es klar im Protokoll.
      if (Buffer.from(envPub, 'base64url').length === 65 && Buffer.from(envPriv, 'base64url').length === 32) {
        return { publicKey: envPub, privateKey: envPriv };
      }
      console.warn('[config] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY haben nicht die erwartete Länge — ignoriert.');
    } catch {
      console.warn('[config] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY sind kein gültiges base64url — ignoriert.');
    }
  }

  const file = path.join(dataDir, '.vapid-keys.json');
  try {
    const gespeichert = JSON.parse(fs.readFileSync(file, 'utf8')) as { publicKey?: string; privateKey?: string };
    if (gespeichert.publicKey && gespeichert.privateKey) return gespeichert as { publicKey: string; privateKey: string };
  } catch { /* noch keine Datei, oder sie ist beschädigt — dann neu erzeugen */ }

  try {
    const paar = neuesSchluesselpaar();
    const werte = {
      publicKey: paar.oeffentlich.toString('base64url'),
      privateKey: paar.privat.toString('base64url'),
    };
    fs.writeFileSync(file, JSON.stringify(werte), { mode: 0o600 });
    console.warn('[config] Kein VAPID-Schlüsselpaar gesetzt — neues Paar erzeugt und in data/.vapid-keys.json abgelegt.');
    return werte;
  } catch (err) {
    // Push ist ein Zusatz, kein Grundbedürfnis — der Server soll deswegen
    // nicht scheitern. Ohne Schlüssel bleibt vapidPublicKey im 'ready'-
    // Ereignis auf null, und der Client bleibt beim alten Weg.
    console.error('[config] VAPID-Schlüsselpaar ließ sich weder lesen noch erzeugen:', (err as Error).message);
    return { publicKey: '', privateKey: '' };
  }
}

/* ── Verschlüsselte Schlüssel ─────────────────────────────────── */

/**
 * Schlüssel kommen entweder aus der Umgebung oder aus dem verschlüsselten
 * Tresor. Die Umgebung gewinnt, weil sie ausdrücklich gesetzt wurde — dann
 * gibt es aber einen deutlichen Hinweis, dass der Schlüssel im Klartext liegt.
 */
const vault = new Vault(path.join(dataDir, 'secrets.enc'));

let vaultSecrets: Record<string, string> | null = null;
export let vaultStatus: 'aus' | 'offen' | 'verschlossen' = 'aus';

function openVault(): Record<string, string> {
  if (vaultSecrets) return vaultSecrets;
  if (!vault.exists()) { vaultStatus = 'aus'; vaultSecrets = {}; return vaultSecrets; }

  const passphrase = resolvePassphrase();
  if (!passphrase) {
    vaultStatus = 'verschlossen';
    console.warn(
      '[secrets] Es gibt einen verschlüsselten Tresor, aber kein Masterpasswort.\n'
      + '          Setze STELLIUM_MASTER_PASSPHRASE oder lege es mit\n'
      + '          "npm run secret -w @stellium/server -- setzen groq" in der Keychain ab.',
    );
    vaultSecrets = {};
    return vaultSecrets;
  }

  try {
    vaultSecrets = vault.load(passphrase.passphrase);
    vaultStatus = 'offen';
  } catch (err) {
    vaultStatus = 'verschlossen';
    console.error(`[secrets] Tresor lässt sich nicht öffnen: ${(err as Error).message}`);
    vaultSecrets = {};
  }
  return vaultSecrets;
}

/** Schlüssel holen: erst Umgebung, dann Tresor. */
function secret(envName: string, vaultName: string): string {
  const fromEnv = str(envName);
  if (fromEnv) {
    if (vault.exists() && openVault()[vaultName]) {
      console.warn(
        `[secrets] ${envName} steht im Klartext in der Umgebung und überschreibt den`
        + ' verschlüsselten Wert. Entferne die Zeile aus der .env, damit der Tresor greift.',
      );
    }
    return fromEnv;
  }
  return openVault()[vaultName] ?? '';
}

export type AiProvider =
  | 'groq' | 'openai'
  /* Modell auf eigener Hardware. "local" ist der ältere Name und bleibt
     gültig: er steht bereits in Einrichtungen im Betrieb, und ein Update darf
     eine laufende KI nicht stillschweigend auf den Demo-Anbieter zurückwerfen. */
  | 'ollama' | 'llamacpp' | 'local'
  | 'deepl' | 'libre' | 'demo';

/**
 * Welcher Stand hier gerade läuft.
 *
 * Der Server kannte seine eigene Version bisher nicht — dadurch stand in der
 * Aktualisierungsansicht "alles aktuell", während der Server noch auf dem
 * alten Stand lief. Die Nummer steht in der Version der App: aus demselben
 * Quelltextstand entsteht beides, und das Serverpaket trägt sie mit.
 */
function eigeneVersion(): string {
  for (const kandidat of [
    path.resolve(paketWurzel, '../desktop/package.json'),
    path.resolve(paketWurzel, '../../packages/desktop/package.json'),
    path.resolve(paketWurzel, 'package.json'),
  ]) {
    try {
      const v = JSON.parse(fs.readFileSync(kandidat, 'utf8')).version;
      if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) return v;
    } catch { /* nächster Kandidat */ }
  }
  return '0.0.0';
}

export const config = {
  version: eigeneVersion(),
  port: int('PORT', 8787),
  host: str('HOST', '0.0.0.0'),
  jwtSecret: resolveSecret(),
  tokenTtlSeconds: int('TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30),
  dataDir,
  uploadDir,
  storageDir,
  releaseDir,
  dbFile: path.join(dataDir, 'stellium.db'),
  maxUploadBytes: int('MAX_UPLOAD_MB', 50) * 1024 * 1024,
  workspaceName: str('WORKSPACE_NAME', 'Stellium'),

  /**
   * Das erste Konto beim Erststart. Bewusst nicht "admin" oder "root" als
   * Vorgabe: das sind die ersten Namen, die bei Anmeldeversuchen durchprobiert
   * werden. Ohne Angabe wird der Name des angemeldeten Systembenutzers
   * verwendet.
   */
  owner: {
    handle: str('OWNER_HANDLE'),
    name: str('OWNER_NAME'),
  },

  ai: {
    provider: (str('AI_PROVIDER', 'groq') as AiProvider),
    groq: {
      apiKey: secret('GROQ_API_KEY', 'groq'),
      baseUrl: str('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
      // Leer = der Server holt die Modell-Liste bei Groq und wählt selbst.
      // Eine gesetzte ID nagelt das Modell fest.
      model: str('GROQ_MODEL'),
      fastModel: str('GROQ_FAST_MODEL'),
    },
    openai: {
      apiKey: secret('OPENAI_API_KEY', 'openai'),
      baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      model: str('OPENAI_MODEL'),
      fastModel: str('OPENAI_FAST_MODEL'),
    },
    deepl: {
      apiKey: secret('DEEPL_API_KEY', 'deepl'),
      get baseUrl() {
        /* Derselbe Weg wie für `apiKey` darüber — Umgebung ODER Tresor, nicht
           nur die Umgebung. Hier stand `str('DEEPL_API_KEY')`, und der las
           ausschließlich die Umgebungsvariable: bei einem Schlüssel, der im
           verschlüsselten Tresor liegt (der empfohlene Weg, siehe
           services/secrets.ts), war sie leer, der Ausdruck endete nie auf
           ":fx", und die Adresse fiel auf den Pro-Endpunkt. Ein Free-Konto
           bekam daraufhin von jeder Anfrage ein 403 — die Übersetzung stand,
           der Schlüssel war richtig, und nichts deutete auf diese eine Zeile.
           openVault() zwischenspeichert, der zweite Aufruf kostet also
           nichts. */
        const key = secret('DEEPL_API_KEY', 'deepl');
        return str('DEEPL_BASE_URL', key.endsWith(':fx')
          ? 'https://api-free.deepl.com/v2'
          : 'https://api.deepl.com/v2');
      },
    },
    libre: {
      baseUrl: str('LIBRE_URL', 'http://localhost:5000'),
      apiKey: str('LIBRE_API_KEY'),
    },

    /**
     * Ein Modell auf der eigenen Maschine — über Ollama oder llama.cpp.
     *
     * Beide sprechen dieselbe Schnittstelle wie OpenAI, deshalb genügt eine
     * andere Adresse. Ein Schlüssel gehört dazu nicht: der Dienst läuft im
     * eigenen Netz, und nichts verlässt das Haus.
     */
    ollama: {
      baseUrl: str('OLLAMA_BASE_URL', 'http://127.0.0.1:11434/v1'),
      model: str('OLLAMA_MODEL'),
      fastModel: str('OLLAMA_FAST_MODEL'),
    },

    /** llama.cpp — dasselbe Prinzip, nur ein anderer Standardport. */
    llamacpp: {
      baseUrl: str('LLAMACPP_BASE_URL', 'http://127.0.0.1:8080/v1'),
      model: str('LLAMACPP_MODEL'),
      fastModel: str('LLAMACPP_FAST_MODEL'),
    },

    /**
     * Allgemeine Namen für ein Modell im eigenen Netz.
     *
     * Bestehende Einrichtungen benutzen teils LOCAL_*, teils AI_*. Beides wird
     * gelesen, damit ein Update keine laufende Installation stilllegt.
     */
    lokal: {
      baseUrl: str('LOCAL_BASE_URL') || str('AI_BASE_URL') || str('LOCAL_URL'),
      model: str('LOCAL_MODEL') || str('AI_MODEL'),
      fastModel: str('LOCAL_FAST_MODEL') || str('AI_FAST_MODEL'),
    },
    memoryCacheSize: int('TRANSLATION_MEMORY_CACHE', 5000),
    requestTimeoutMs: int('AI_TIMEOUT_MS', 25_000),

    /**
     * Sprache zu Text auf der eigenen Maschine — whisper.cpp als kleiner
     * Dienst nebenan.
     *
     * Getrennt vom Textmodell, weil es zwei verschiedene Dinge sind: das
     * Textmodell darf auf einer anderen Maschine im Tailscale-Netz liegen und
     * acht Milliarden Gewichte haben, die Abschrift läuft auf dem Pi selbst
     * und muss dort neben dem Chat Platz finden.
     *
     * `modell` ist reine Anzeige — welche Gewichte wirklich geladen sind,
     * entscheidet der Dienst beim Start. Der Server schreibt den Namen nur
     * zum Transkript, damit später nachvollziehbar ist, womit es entstand.
     */
    stimme: {
      baseUrl: str('STIMME_URL', 'http://127.0.0.1:8788'),
      modell: str('STIMME_MODELL', 'whisper'),
      /* Großzügig: eine Minute Aufnahme braucht auf dem Pi um die halbe
         Minute, und wenn zwei Aufnahmen zugleich ankommen, wartet die zweite
         hinter der ersten. Lieber spät fertig als grundlos abgebrochen. */
      timeoutMs: int('STIMME_TIMEOUT_MS', 600_000),
      /* Wie viele Aufnahmen höchstens warten dürfen. Darüber hinaus wird
         abgewiesen statt aufgestaut: eine Abschrift, die in einer halben
         Stunde erscheint, hilft niemandem mehr, und der Pi soll die Warteschlange
         nicht im Speicher tragen. */
      warteschlange: int('STIMME_WARTESCHLANGE', 8),
    },
  },

  /** Web Push — Benachrichtigungen, während die App nicht offen ist. */
  push: {
    ...resolveVapidKeys(),
    /* Pflichtangabe des Protokolls (RFC 8292): eine Kontaktmöglichkeit, über
       die ein Push-Dienst sich meldet, falls von diesem Server Missbrauch
       ausgeht. Ohne eigene Angabe ein Platzhalter — kein Grund, deswegen
       Benachrichtigungen abzuschalten, aber sinnvoll, ihn zu ersetzen. */
    subject: str('VAPID_SUBJECT', 'mailto:admin@stellium.chat'),
  },
} as const;

/** Ist ein Schlüsselpaar da, mit dem sich überhaupt etwas verschicken lässt? */
export function pushConfigured(): boolean {
  return Boolean(config.push.publicKey && config.push.privateKey);
}

/** Ist ein echter Übersetzungs-/KI-Provider konfiguriert? */
export function aiConfigured(): boolean {
  switch (config.ai.provider) {
    case 'groq': return Boolean(config.ai.groq.apiKey);
    case 'openai': return Boolean(config.ai.openai.apiKey);
    case 'deepl': return Boolean(config.ai.deepl.apiKey);
    case 'libre': return Boolean(config.ai.libre.baseUrl);
    // Lokal braucht es keinen Schlüssel — nur eine erreichbare Adresse.
    case 'ollama':
    case 'llamacpp':
    case 'local': return Boolean(lokaleEinstellung().baseUrl);
    default: return false;
  }
}

/** Kann der Provider mehr als übersetzen (Zusammenfassungen, Smart Replies)? */
export function assistantAvailable(): boolean {
  return (aktiverAnbieter() === 'groq' && Boolean(config.ai.groq.apiKey)) ||
         (aktiverAnbieter() === 'openai' && Boolean(config.ai.openai.apiKey)) ||
         istLokal(aktiverAnbieter());
}

/** Läuft das Modell im eigenen Netz? */
export function istLokal(anbieter: AiProvider = aktiverAnbieter()): boolean {
  return anbieter === 'ollama' || anbieter === 'llamacpp' || anbieter === 'local';
}

/**
 * Was zur Laufzeit eingestellt wurde.
 *
 * Der Anbieter stand bisher nur in der Umgebung und damit bis zum nächsten
 * Neustart fest. Für die Umschaltung in den Einstellungen liegt er zusätzlich
 * hier — gesetzt wird er beim Start aus der Datenbank.
 */
const laufzeit: { anbieter: AiProvider | null; baseUrl: string; model: string; fastModel: string } = {
  anbieter: null,
  baseUrl: '',
  model: '',
  fastModel: '',
};

/** Der Anbieter, der gerade gilt: Einstellung vor Umgebung. */
export function aktiverAnbieter(): AiProvider {
  return laufzeit.anbieter ?? config.ai.provider;
}

/**
 * Adresse und Modelle des lokalen Dienstes, Einstellung vor Umgebung.
 * Welcher Standardport gilt, hängt am Anbieter: Ollama hört auf 11434,
 * llama.cpp auf 8080.
 */
export function lokaleEinstellung(): { baseUrl: string; model: string; fastModel: string } {
  const anbieter = aktiverAnbieter();
  const vorgabe = anbieter === 'llamacpp' ? config.ai.llamacpp
    : anbieter === 'local' ? config.ai.lokal
      : config.ai.ollama;

  /* Unter "local" ist keine Adresse vorgegeben — dort zählt, was eingetragen
     wurde. Fehlt auch das, greift der übliche Ollama-Port, damit eine
     halbfertige Einrichtung wenigstens irgendwo anklopft. */
  const adresse = laufzeit.baseUrl || vorgabe.baseUrl
    || (anbieter === 'local' ? config.ai.ollama.baseUrl : '');

  return {
    baseUrl: adresse.replace(/\/+$/, ''),
    model: laufzeit.model || vorgabe.model || config.ai.lokal.model,
    fastModel: laufzeit.fastModel || vorgabe.fastModel || config.ai.lokal.fastModel,
  };
}

/** Aus den Einstellungen übernehmen. Leere Werte heißen "wie in der Umgebung". */
export function laufzeitSetzen(werte: {
  anbieter?: AiProvider | null; baseUrl?: string; model?: string; fastModel?: string;
}): void {
  if (werte.anbieter !== undefined) laufzeit.anbieter = werte.anbieter;
  if (werte.baseUrl !== undefined) laufzeit.baseUrl = werte.baseUrl.trim();
  if (werte.model !== undefined) laufzeit.model = werte.model.trim();
  if (werte.fastModel !== undefined) laufzeit.fastModel = werte.fastModel.trim();
}

/* secretOrigin() ist am 22.08.2026 ersatzlos entfallen: die Funktion hatte im
   ganzen Haus keinen einzigen Aufrufer und schrieb redact(key) — die ersten
   vier und letzten zwei Zeichen des API-Schlüssels samt genauer Länge — in ein
   Feld, das wie eine HTTP-Antwort geformt war und damit nur darauf wartete,
   ausgeliefert zu werden. Ein gekürzter Schlüssel ist immer noch ein Schlüssel.
   Wer so eine Auskunft braucht: Herkunft ja, Wert nein, auch nicht in Teilen. */
