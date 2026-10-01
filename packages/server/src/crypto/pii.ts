import crypto from 'node:crypto';
import { resolvePassphrase } from '../secrets.js';

/**
 * Verschlüsselung personenbezogener Felder (E-Mail, Benutzername).
 *
 * Zwei Werte werden je Feld gespeichert:
 *
 *   Chiffrat     AES-256-GCM, mit Zufalls-IV. Zweimal derselbe Klartext ergibt
 *                zwei verschiedene Chiffrate — man kann also nicht erkennen,
 *                ob zwei Konten dieselbe Adresse haben.
 *
 *   Blind-Index  HMAC-SHA256 über den normalisierten Klartext, mit einem
 *                eigenen Schlüssel. Deterministisch, damit "WHERE handle = ?"
 *                und die Eindeutigkeitsprüfung weiter funktionieren — aber
 *                nicht umkehrbar.
 *
 * Warum nicht auch Passwörter? Weil Verschlüsselung umkehrbar ist. Passwörter
 * bleiben mit scrypt gehasht: dann kann sie niemand auslesen, auch nicht mit
 * dem Schlüssel in der Hand. Zurücksetzen geht trotzdem — dafür braucht es
 * das alte Passwort nicht.
 */

const PREFIX = 'v1:';

let keys: { field: Buffer; index: Buffer } | null = null;
let warned = false;

/** Feldschlüssel und Indexschlüssel aus dem Masterpasswort ableiten. */
function ensureKeys(): { field: Buffer; index: Buffer } | null {
  if (keys) return keys;
  const master = resolvePassphrase();
  if (!master) {
    if (!warned) {
      warned = true;
      console.warn(
        '[pii] Kein Masterpasswort — E-Mails und Benutzernamen liegen im Klartext.\n'
        + '      Einrichten mit: npm run secret -w @stellium/server -- setzen groq',
      );
    }
    return null;
  }
  // Fester Salt: die Schlüssel müssen über Neustarts hinweg gleich bleiben,
  // sonst wäre kein einziger Datensatz mehr lesbar. Die Geheimhaltung steckt
  // im Masterpasswort, nicht im Salt.
  const salt = Buffer.from('stellium/pii/v1');
  keys = {
    field: Buffer.from(crypto.hkdfSync('sha256', master.passphrase, salt, Buffer.from('feld'), 32)),
    index: Buffer.from(crypto.hkdfSync('sha256', master.passphrase, salt, Buffer.from('index'), 32)),
  };
  return keys;
}

export function encryptionActive(): boolean {
  return ensureKeys() !== null;
}

/** Klartext → "v1:<iv>:<tag>:<chiffrat>" (base64url). Ohne Schlüssel unverändert. */
export function encryptField(plain: string): string {
  const k = ensureKeys();
  if (!k || !plain) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k.field, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
}

/** Umkehrung. Alte Klartextwerte werden unverändert durchgereicht. */
export function decryptField(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored;   // noch nicht verschlüsselt
  const k = ensureKeys();
  if (!k) return '';                                // ohne Schlüssel nicht lesbar
  try {
    const [, ivB64, tagB64, dataB64] = stored.split(':');
    // Taglänge fest: ohne die Angabe nimmt Node auch ein auf vier Byte
    // gekürztes Tag an, und eine Fälschung bräuchte dann nur 2^32 Versuche.
    const d = crypto.createDecipheriv('aes-256-gcm', k.field, Buffer.from(ivB64, 'base64url'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(dataB64, 'base64url')), d.final()]).toString('utf8');
  } catch {
    console.error('[pii] Ein Feld ließ sich nicht entschlüsseln — falsches Masterpasswort?');
    return '';
  }
}

/**
 * Suchbarer Fingerabdruck. Gleicher Klartext ergibt immer denselben Wert,
 * daraus lässt sich der Klartext aber nicht zurückrechnen.
 */
export function blindIndex(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  const k = ensureKeys();
  // Ohne Schlüssel taugt der Index trotzdem als eindeutiger Suchwert —
  // dann eben ohne Geheimnis, was zur Klartextablage passt.
  const key = k ? k.index : Buffer.from('stellium/kein-schluessel');
  return crypto.createHmac('sha256', key).update(normalized).digest('base64url');
}

/** Für Anzeige in Verwaltungsansichten: nur andeuten, nie ganz zeigen. */
export function maskEmail(email: string): string {
  const [lokal, domain] = email.split('@');
  if (!domain) return '•••';
  const sichtbar = lokal.slice(0, Math.min(2, lokal.length));
  return `${sichtbar}${'•'.repeat(Math.max(3, lokal.length - 2))}@${domain}`;
}
