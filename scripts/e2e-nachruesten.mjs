#!/usr/bin/env node
/**
 * Kommt der Server auf einer ALTEN Datenbank hoch?
 *
 * Der Prüflauf, der gefehlt hat. Alle anderen legen ihre Datenbank frisch an —
 * dort bringt `CREATE TABLE` die neuen Spalten gleich mit, und ein Fehler in
 * der Nachrüstung fällt nie auf. Auf dem Server gibt es die Tabellen aber
 * schon, und dort zählt allein `migrate.ts`.
 *
 * Fassung 1.0.17 ist genau daran gescheitert: ein Index in schema.sql zeigte
 * auf eine Spalte, die erst die Nachrüstung anlegt — die läuft danach.
 * „no such column: projekt_id", der Server kam nicht hoch, die Rücknahme
 * legte den alten Stand zurück.
 *
 * Der Lauf baut eine Datenbank nach dem Schema der letzten Fassung, startet
 * den heutigen Server darauf und sieht nach, ob er antwortet.
 *
 *   node scripts/e2e-nachruesten.mjs            gegen die letzte Fassungsmarke
 *   node scripts/e2e-nachruesten.mjs v1.0.14    gegen eine bestimmte
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = { aus: '\x1b[0m', gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', grau: '\x1b[90m' };
const sag = (t = '') => process.stdout.write(`${t}\n`);
const lauf = (b, a, o = {}) => execFileSync(b, a, { cwd: wurzel, encoding: 'utf8', ...o });

/* Ohne Angabe die jüngste Fassungsmarke — das ist der Stand, der draußen
   läuft, und damit die Datenbank, auf die das Update trifft. */
const marke = process.argv[2] ?? lauf('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']).trim();
sag(`${F.grau}Alte Datenbank nach dem Schema von ${marke}${F.aus}`);

const altesSchema = lauf('git', ['show', `${marke}:packages/server/src/db/schema.sql`]);
const arbeit = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-nachruesten-'));
const datenordner = path.join(arbeit, 'daten');
fs.mkdirSync(datenordner, { recursive: true });

/* Die Datenbank mit dem alten Schema anlegen — ohne Server, sonst liefe schon
   die heutige Nachrüstung darüber und die Probe wäre sinnlos. */
const anlegen = path.join(arbeit, 'anlegen.mjs');
fs.writeFileSync(anlegen, `
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync(${JSON.stringify(path.join(datenordner, 'stellium.db'))});
db.exec(fs.readFileSync(${JSON.stringify(path.join(arbeit, 'schema-alt.sql'))}, 'utf8'));
db.close();
`);
fs.writeFileSync(path.join(arbeit, 'schema-alt.sql'), altesSchema);
lauf('node', [anlegen]);
sag(`${F.gruen}✓${F.aus} alte Datenbank steht`);

/* Den heutigen Server darauf loslassen. Ein eigener Port, damit ein laufender
   Entwicklungsserver nicht stört. */
const port = 5211;
/* tsx direkt, nicht über npx: npx reicht SIGTERM nicht überall an sein Kind
   weiter (nachgestellt mit npm 10 unter Linux). Der Server lief dann nach dem
   kill() weiter, hielt die Ausgabe-Rohre offen, und dieses Skript — und mit
   ihm der Prüfschritt von ausliefern.mjs — kam nie zum Ende. */
const server = spawn(path.join(wurzel, 'node_modules', '.bin', 'tsx'), ['src/index.ts'], {
  cwd: path.join(wurzel, 'packages/server'),
  env: { ...process.env, DATA_DIR: datenordner, PORT: String(port), OWNER_HANDLE: 'pruefer' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let ausgabe = '';
server.stdout.on('data', (d) => { ausgabe += d; });
server.stderr.on('data', (d) => { ausgabe += d; });

const antwortet = async () => {
  for (let i = 0; i < 40; i++) {
    if (server.exitCode !== null) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/releases`);
      /* 401 ist eine Antwort — der Server steht. Es geht hier nicht um
         Berechtigungen, sondern darum, dass er überhaupt hochkommt. */
      if (r.status === 401 || r.ok) return true;
    } catch { /* noch nicht da */ }
    await new Promise((f) => setTimeout(f, 500));
  }
  return false;
};

const gut = await antwortet();
server.kill('SIGTERM');
await new Promise((f) => setTimeout(f, 500));
fs.rmSync(arbeit, { recursive: true, force: true });

if (!gut) {
  const grund = ausgabe.match(/Start fehlgeschlagen: .*/)?.[0]
    ?? ausgabe.split('\n').filter(Boolean).slice(-4).join('\n');
  sag(`\n${F.rot}✗ Der Server kommt auf einer ${marke}-Datenbank nicht hoch.${F.aus}`);
  sag(`${F.grau}${grund}${F.aus}\n`);
  sag('  Fast immer: eine neue Spalte wird in schema.sql schon benutzt');
  sag('  (Index, View, Abfrage), angelegt wird sie aber erst in migrate.ts —');
  sag('  und die läuft danach. Solche Zeilen gehören in migrate.ts.\n');
  process.exit(1);
}

sag(`${F.gruen}✓${F.aus} Server läuft auf der nachgerüsteten Datenbank`);
sag(`\n${F.gruen}1/1 bestanden${F.aus}`);
process.exit(0);
