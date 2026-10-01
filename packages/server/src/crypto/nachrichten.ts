import crypto from 'node:crypto';
import { resolvePassphrase } from '../secrets.js';

/**
 * Verschlüsselung der Nachrichteninhalte.
 *
 * Wer die Datenbankdatei in die Hand bekommt — ein gestohlener Raspberry Pi,
 * eine kopierte Sicherung, ein neugieriger Zugriff auf die SD-Karte — soll
 * nichts mitlesen können. Darum liegt jeder Nachrichtentext nur als Chiffrat
 * in der Tabelle.
 *
 * Der Schlüssel stammt aus demselben Masterpasswort wie die PII-Verschlüsselung,
 * aber über eine eigene Ableitung: ein Schlüssel pro Zweck. Ohne Masterpasswort
 * bleibt alles im Klartext — dann warnt der Server beim Start, statt Daten
 * anzulegen, die später niemand mehr lesen kann.
 *
 * Suchen bleibt möglich, ohne den Klartext preiszugeben: statt der Wörter
 * selbst liegen im Volltextindex nur deren Fingerabdrücke (HMAC, gekürzt).
 * Wer den Index liest, sieht Zeichenfolgen ohne Bedeutung; wer sucht, bildet
 * dieselben Fingerabdrücke und findet damit dieselben Nachrichten.
 *
 * Der Preis: Präfixsuche ("proj" findet "Projekt") geht damit nicht mehr —
 * ein Fingerabdruck hat keinen gemeinsamen Anfang mit einem anderen. Ganze
 * Wörter zu finden ist der Kompromiss, den Vertraulichkeit hier kostet.
 */

const PREFIX = 'm1:';

let keys: { text: Buffer; index: Buffer } | null = null;
let gewarnt = false;

function schluessel(): { text: Buffer; index: Buffer } | null {
  if (keys) return keys;
  const master = resolvePassphrase();
  if (!master) {
    if (!gewarnt) {
      gewarnt = true;
      console.warn(
        '[nachrichten] Kein Masterpasswort — Nachrichten liegen im Klartext in der Datenbank.\n'
        + '              Einrichten mit: npm run secret -w @stellium/server -- setzen groq',
      );
    }
    return null;
  }
  // Fester Salt, eigener Zweck: derselbe Grund wie bei den Personendaten —
  // der Schlüssel muss über Neustarts hinweg derselbe bleiben.
  const salt = Buffer.from('stellium/nachricht/v1');
  keys = {
    text: Buffer.from(crypto.hkdfSync('sha256', master.passphrase, salt, Buffer.from('text'), 32)),
    index: Buffer.from(crypto.hkdfSync('sha256', master.passphrase, salt, Buffer.from('suche'), 32)),
  };
  return keys;
}

/** Liegt ein Schlüssel bereit? Nur dann wird überhaupt verschlüsselt. */
export function verschluesselungAktiv(): boolean {
  return schluessel() !== null;
}

/** Klartext → "m1:<iv>:<tag>:<chiffrat>". Ohne Schlüssel unverändert. */
export function verschluesseln(klartext: string | null | undefined): string {
  const k = schluessel();
  const t = klartext ?? '';
  if (!k || !t) return t;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k.text, iv);
  const daten = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${daten.toString('base64url')}`;
}

/** Umkehrung. Klartext aus der Zeit vor der Verschlüsselung bleibt lesbar. */
export function entschluesseln(gespeichert: string | null | undefined): string {
  if (!gespeichert) return '';
  if (!gespeichert.startsWith(PREFIX)) return gespeichert;
  const k = schluessel();
  if (!k) return '';
  try {
    const [, ivB64, tagB64, datenB64] = gespeichert.split(':');
    // Taglänge fest: ohne die Angabe nimmt Node auch ein auf vier Byte
    // gekürztes Tag an, und eine Fälschung bräuchte dann nur 2^32 Versuche.
    const d = crypto.createDecipheriv('aes-256-gcm', k.text, Buffer.from(ivB64, 'base64url'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(datenB64, 'base64url')), d.final()]).toString('utf8');
  } catch {
    console.error('[nachrichten] Eine Nachricht ließ sich nicht entschlüsseln — falsches Masterpasswort?');
    return '';
  }
}

/** Ist der Wert schon ein Chiffrat? Für die einmalige Umstellung alter Daten. */
export function istChiffrat(wert: string | null | undefined): boolean {
  return Boolean(wert && wert.startsWith(PREFIX));
}

/**
 * Wörter eines Textes für den Volltextindex — normalisiert und
 * durch HMAC ersetzt.
 *
 * Hexadezimal, weil FTS5 (unicode61) an allem trennt, was nicht Buchstabe
 * oder Ziffer ist: base64url mit "-" und "_" würde jeden Fingerabdruck in
 * Stücke zerlegen. 16 Zeichen reichen — bei so wenigen Wörtern pro Server
 * ist eine Kollision belanglos, und der Index bleibt klein.
 */
export function suchWorte(text: string): string {
  return [...new Set(zerlegen(text))].map(fingerabdruck).join(' ');
}

/** Dieselbe Zerlegung für die Suchanfrage. */
export function suchBegriffe(anfrage: string): string[] {
  return [...new Set(zerlegen(anfrage))].map(fingerabdruck);
}

function zerlegen(text: string): string[] {
  return (text ?? '')
    .normalize('NFKD')
    // Diakritika weg, damit "Grüße" und "Grusse" denselben Abdruck ergeben —
    // FTS5 macht das sonst selbst über remove_diacritics.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && w.length < 64);
}

function fingerabdruck(wort: string): string {
  const k = schluessel();
  // Ohne Schlüssel bleibt der Index sinnvoll — dann eben ohne Geheimnis,
  // passend dazu, dass auch der Text im Klartext liegt.
  const key = k ? k.index : Buffer.from('stellium/kein-schluessel');
  return crypto.createHmac('sha256', key).update(wort).digest('hex').slice(0, 16);
}

/**
 * Ein Schlüsselwert für Zwischenspeicher, der den Klartext nicht verrät.
 *
 * sha1 über eine kurze Wendung ("Guten Morgen") ist in Sekunden durchprobiert.
 * Mit dem Hausschlüssel als Grundlage geht das nicht — und zum Nachschlagen
 * taugt der Wert genauso.
 */
export function abdruck(text: string): string {
  const k = schluessel();
  const key = k ? k.index : Buffer.from('stellium/kein-schluessel');
  return crypto.createHmac('sha256', key).update(text).digest('hex').slice(0, 40);
}
