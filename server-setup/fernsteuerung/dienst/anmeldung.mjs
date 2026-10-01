/**
 * Wer darf auf den Pi? — ID und Passwort, wie man es von TeamViewer kennt.
 *
 * Die ID ist nur eine Adresse und darf jeder sehen. Das Passwort ist das
 * Geheimnis, und es verlässt **nie** den Rechner, auf dem es eingegeben wurde
 * — auch nicht verschlüsselt, auch nicht abgeleitet.
 *
 * Der erste Entwurf ließ den Mac den aus dem Passwort gerechneten Schlüssel
 * mitschicken, damit der Pi ihn prüfen kann. Das war falsch: der Handschlag
 * ist zu diesem Zeitpunkt noch offen, und wer mithört, hätte den Schlüssel
 * für immer. Deshalb geht hier nie etwas hinaus, aus dem sich das Passwort
 * herstellen ließe — nur Beweise, dass man es kennt.
 *
 * Der Ablauf, und die Reihenfolge ist der Punkt:
 *
 *   1. Der Mac meldet sich mit seinem öffentlichen Schlüssel. Sonst nichts.
 *   2. Der Pi einigt sich per ECDH auf ein gemeinsames Geheimnis, mischt den
 *      gespeicherten Passwortschlüssel dazu und **beweist sich zuerst**.
 *   3. Erst wenn dieser Beweis stimmt, gibt der Mac seinen eigenen ab.
 *
 * Dass der Pi zuerst dran ist, ist kein Detail. Andersherum könnte sich
 * jemand als der Pi ausgeben, den Beweis des Macs einsammeln und damit in
 * Ruhe Passwörter durchprobieren, bis einer passt — ohne dass ihn dabei
 * jemand aufhält. So bekommt ein Fremder nie etwas, womit er rechnen könnte.
 *
 * Aus dem Passwort wird mit **scrypt** ein Schlüssel. Absichtlich langsam:
 * wer die ID kennt und Passwörter durchprobieren will, schafft damit eine
 * Handvoll pro Sekunde statt Millionen.
 *
 * Der ECDH-Anteil sorgt dafür, dass jede Sitzung ihren eigenen Schlüssel hat.
 * Wer eine Aufzeichnung mitschneidet und später das Passwort erfährt, kann
 * damit nichts mehr anfangen.
 *
 * Verglichen wird mit `timingSafeEqual`. Ein gewöhnliches `===` bricht beim
 * ersten falschen Byte ab, und aus dem Zeitunterschied lässt sich der richtige
 * Wert Byte für Byte erraten — in diesem Projekt ist genau so ein Leck schon
 * einmal gefunden worden (Anmeldung, Faktor 24,5).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KURVE = 'prime256v1';        /* P-256, dieselbe wie in der Chat-App */
const SCRYPT = { N: 16384, r: 8, p: 1 };

/* ── Kennung auf der Platte ──────────────────────────────────── */

export function kennungLaden(ordner) {
  fs.mkdirSync(ordner, { recursive: true, mode: 0o700 });
  const datei = path.join(ordner, 'kennung.json');
  if (fs.existsSync(datei)) {
    const k = JSON.parse(fs.readFileSync(datei, 'utf8'));
    if (k.id && k.salz && k.schluessel) return k;
  }
  return kennungNeu(ordner);
}

/** Neue ID und ein neues Passwort. Gibt das Passwort **im Klartext** zurück —
 *  das ist der einzige Augenblick, in dem es das je tut. */
export function kennungNeu(ordner, passwort = null) {
  fs.mkdirSync(ordner, { recursive: true, mode: 0o700 });
  const datei = path.join(ordner, 'kennung.json');
  const vorher = fs.existsSync(datei) ? JSON.parse(fs.readFileSync(datei, 'utf8')) : null;

  /* Neun Ziffern, wie man es gewohnt ist — in Dreiergruppen lesbar.
     Aus dem Zufallsgenerator des Betriebssystems, nicht aus Math.random. */
  const id = vorher?.id ?? [...crypto.randomBytes(9)]
    .map((b) => (b % 10).toString()).join('');

  /* Ein Passwort, das man vorlesen kann: keine Null/O, keine Eins/l/I. */
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const klar = passwort ?? [...crypto.randomBytes(10)]
    .map((b) => alphabet[b % alphabet.length]).join('');

  const salz = crypto.randomBytes(16);
  const schluessel = crypto.scryptSync(klar, salz, 32, SCRYPT);
  /* Der Pi muss diesen Schlüssel kennen — er soll sich ja **zuerst** ausweisen,
     und das kann nur, wer ihn hat. Ein bloßer Abdruck würde dafür nicht
     reichen. Deshalb liegt er hier, aber mit 0600 und nur für root lesbar,
     und er ist nicht das Passwort: aus ihm zurückzurechnen verlangt, scrypt
     umzukehren. */
  const k = {
    id,
    salz: salz.toString('base64'),
    schluessel: schluessel.toString('base64'),
    geaendert: new Date().toISOString(),
  };
  fs.writeFileSync(datei, JSON.stringify(k, null, 2), { mode: 0o600 });
  return { ...k, klartext: klar };
}

/* ── Der Handschlag ──────────────────────────────────────────── */

function sitzungsschluessel(gemeinsam, passSchluessel, nonce) {
  /* `hkdfSync` liefert einen ArrayBuffer, keinen Buffer. Für HMAC und AES
     ist das gleichgültig — sie nehmen beides — aber `Buffer.compare` wirft
     darauf, und genau daran ist die erste Prüfung gescheitert. Einmal hier
     umwandeln ist besser, als sich an jeder Verwendungsstelle daran zu
     erinnern. */
  return Buffer.from(crypto.hkdfSync(
    'sha256', Buffer.concat([gemeinsam, passSchluessel]),
    nonce, Buffer.from('stellium-fern-sitzung'), 32));
}

/** Schritt 1, auf dem Mac: nur den öffentlichen Schlüssel hinausgeben. */
export function hallo() {
  const paar = crypto.createECDH(KURVE);
  paar.generateKeys();
  return { paar, hinaus: { art: 'hallo', oeffentlich: paar.getPublicKey().toString('base64') } };
}

/** Schritt 2, auf dem Pi: gemeinsames Geheimnis bilden und sich ausweisen. */
export function grussBauen(kennung, hallo) {
  const paar = crypto.createECDH(KURVE);
  paar.generateKeys();
  let gemeinsam;
  try {
    gemeinsam = paar.computeSecret(Buffer.from(hallo.oeffentlich ?? '', 'base64'));
  } catch {
    return null;                       /* unbrauchbarer Schlüssel */
  }
  const nonce = crypto.randomBytes(32);
  const passSchluessel = Buffer.from(kennung.schluessel, 'base64');
  const schluessel = sitzungsschluessel(gemeinsam, passSchluessel, nonce);
  return {
    schluessel,
    nonce,
    hinaus: {
      art: 'gruss',
      id: kennung.id,
      salz: kennung.salz,
      oeffentlich: paar.getPublicKey().toString('base64'),
      nonce: nonce.toString('base64'),
      scrypt: SCRYPT,
      /* Der Pi zuerst. Wer diesen Beweis nicht bilden kann, kennt das
         Passwort nicht — und bekommt vom Mac auch nichts zu sehen. */
      beweis: crypto.createHmac('sha256', schluessel).update(nonce).update('pi').digest('base64'),
    },
  };
}

/** Schritt 3, auf dem Mac: Beweis des Pi prüfen, dann selbst beweisen. */
export function antwortBauen(passwort, gruss, paar) {
  const salz = Buffer.from(gruss.salz, 'base64');
  const nonce = Buffer.from(gruss.nonce, 'base64');
  const passSchluessel = crypto.scryptSync(passwort, salz, 32, gruss.scrypt ?? SCRYPT);
  let gemeinsam;
  try {
    gemeinsam = paar.computeSecret(Buffer.from(gruss.oeffentlich, 'base64'));
  } catch {
    return { ok: false, grund: 'Schlüssel unbrauchbar' };
  }
  const schluessel = sitzungsschluessel(gemeinsam, passSchluessel, nonce);

  const erwartet = crypto.createHmac('sha256', schluessel).update(nonce).update('pi').digest();
  const geliefert = Buffer.from(gruss.beweis ?? '', 'base64');
  if (geliefert.length !== erwartet.length || !crypto.timingSafeEqual(geliefert, erwartet)) {
    /* Entweder das Passwort stimmt nicht — oder am anderen Ende sitzt gar
       nicht der Pi. Beides endet hier, und zwar bevor wir irgendetwas
       preisgegeben haben. */
    return { ok: false, grund: 'Gegenstelle konnte sich nicht ausweisen' };
  }

  return {
    ok: true,
    schluessel,
    hinaus: {
      art: 'antwort',
      beweis: crypto.createHmac('sha256', schluessel).update(nonce).update('mac').digest('base64'),
    },
  };
}

/** Schritt 4, auf dem Pi: den Beweis des Macs prüfen. */
export function antwortPruefen(zustand, antwort) {
  const erwartet = crypto.createHmac('sha256', zustand.schluessel)
    .update(zustand.nonce).update('mac').digest();
  const geliefert = Buffer.from(antwort?.beweis ?? '', 'base64');
  if (geliefert.length !== erwartet.length || !crypto.timingSafeEqual(geliefert, erwartet)) {
    return { ok: false, grund: 'Passwort stimmt nicht' };
  }
  return { ok: true, schluessel: zustand.schluessel };
}

/* ── Verschlüsselung des Stroms ──────────────────────────────── */

/**
 * Jede Nachricht bekommt einen eigenen Zähler als Startwert. Ein Startwert
 * darf sich mit demselben Schlüssel **nie** wiederholen — bei AES-GCM ist das
 * kein Schönheitsfehler, sondern der Punkt, an dem der Schlüssel fällt.
 * Deshalb ein Zähler und kein Zufall: bei Zufall wächst die Wahrscheinlichkeit
 * einer Wiederholung mit der Zahl der Nachrichten, und ein Bildstrom schickt
 * sehr viele.
 */
export class Schatulle {
  constructor(schluessel, richtung) {
    this.schluessel = schluessel;
    this.zaehler = 0n;
    /* Beide Richtungen zählen getrennt, sonst käme derselbe Startwert
       zweimal vor — einmal hin, einmal zurück. */
    this.kennung = richtung === 'pi' ? 1 : 2;
    /* Der höchste Zähler, der bisher HEREIN kam. Siehe `auf`. */
    this.zuletzt = -1n;
  }

  startwert() {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(this.kennung, 0);
    b.writeBigUInt64BE(this.zaehler++, 4);
    return b;
  }

  zu(art, inhalt) {
    const iv = this.startwert();
    const c = crypto.createCipheriv('aes-256-gcm', this.schluessel, iv);
    c.setAAD(Buffer.from([art]));
    const geheim = Buffer.concat([c.update(inhalt), c.final()]);
    return Buffer.concat([Buffer.from([art]), iv, c.getAuthTag(), geheim]);
  }

  auf(paket) {
    if (paket.length < 1 + 12 + 16) return null;
    const art = paket[0];
    const iv = paket.subarray(1, 13);
    const marke = paket.subarray(13, 29);
    const geheim = paket.subarray(29);
    /* Die Prüfsumme sagt nur, dass ein Paket mit diesem Schlüssel gebaut
       wurde — nicht, dass es zum ersten Mal kommt. Ohne diese beiden Zeilen
       konnte, wer auf der Leitung sitzt, ein mitgeschnittenes Eingabepaket
       einfach noch einmal einspielen: der Pi hätte dieselben Tasten ein
       zweites Mal gedrückt. Ebenso ließ sich ein Paket des Pi an ihn selbst
       zurückspiegeln, weil beide Richtungen denselben Schlüssel tragen.
       Also: nur die Kennung der Gegenrichtung, und der Zähler muss steigen.
       Über TCP kommt ohnehin alles in der Reihenfolge an, in der es abging. */
    if (iv.readUInt32BE(0) !== this.kennung) return null;
    const zaehler = iv.readBigUInt64BE(4);
    if (zaehler <= this.zuletzt) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.schluessel, iv);
      d.setAAD(Buffer.from([art]));
      d.setAuthTag(marke);
      const inhalt = Buffer.concat([d.update(geheim), d.final()]);
      /* Erst nach bestandener Prüfung — sonst schöbe ein gefälschtes Paket
         den Zähler vor und sperrte die echten aus. */
      this.zuletzt = zaehler;
      return { art, inhalt };
    } catch {
      return null;                 /* verfälscht — verwerfen, nicht raten */
    }
  }
}
