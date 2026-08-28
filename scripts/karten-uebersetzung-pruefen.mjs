/**
 * Übersetzung der Karten prüfen: Aufgaben, Termine, Ideen, Vorschläge.
 *
 * Übersetzt wurde lange nur der Chat — Nachricht, Kanal, Umfrage. Alles
 * daneben ging unübersetzt hinaus, und zwar lautlos: wer die Oberfläche auf
 * Spanisch stellte, bekam jede Nachricht übersetzt und las das Ideenbrett
 * trotzdem auf Deutsch. Kein Fehler, keine Warnung, nur deutscher Text an
 * einer Stelle, an der jemand Spanisch erwartet.
 *
 * Genau das kann beim Erweitern jederzeit zurückkommen: eine neue Kartenart
 * oder ein neues Textfeld, das in der `felder`-Liste der `*:list`-Verzweigung
 * fehlt, fällt in keinem Typprüflauf auf. Dieser Lauf hält die Regeln fest,
 * nach denen eine Karte übersetzt wird.
 *
 * Braucht keinen laufenden Server und keinen Schlüssel — ohne Anbieter
 * übersetzt der DemoProvider aus einem kleinen Wörterbuch.
 *
 * Aufruf:  node scripts/karten-uebersetzung-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-karten-'));

/* Unter Windows heißt `npx` in Wirklichkeit `npx.cmd`, und seit der
   Absicherung von CVE-2024-27980 weigert sich Node, eine .cmd-Datei ohne
   Shell zu starten: der Aufruf endet mit EINVAL. Mit `shell` läuft er.
   Die Argumente sind hier fest verdrahtet und ohne Leerzeichen, der Pfad
   kommt getrennt über `cwd` — an dieser Stelle ist die Shell ungefährlich. */
const windows = process.platform === 'win32';

let fehler = 0;
try {
  execFileSync(windows ? 'npx.cmd' : 'npx', ['tsx', 'src/pruefungen/karten-uebersetzung.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
    shell: windows,
  });
} catch (e) {
  fehler = 1;
  /* Ein stiller Abbruch ist schlimmer als ein lauter: ohne diese Zeile
     endet der Lauf mit Rückgabewert 1 und ohne ein Wort dazu. */
  if (e?.code) console.error(`\n\x1b[31mDer Prüflauf konnte nicht starten: ${e.code}\x1b[0m`);
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}

process.exit(fehler);
