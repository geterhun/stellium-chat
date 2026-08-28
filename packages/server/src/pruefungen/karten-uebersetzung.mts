/**
 * Prüft gegen eine frische Datenbank: werden die Textfelder einer KARTE —
 * Aufgabe, Termin, Idee, Vorschlag — in die Lesesprache gebracht?
 *
 * DER BEFUND
 *
 * Übersetzt wurde bis hierher nur der Chat. `fillCachedTranslations()` lief
 * an genau drei Stellen (Kanalverlauf, Direktnachricht, Thread), dazu Kanal
 * und Umfrage über eigene Wege. Alles daneben ging unübersetzt hinaus: wer
 * die Oberfläche auf Spanisch stellte, bekam jede Nachricht übersetzt, las
 * Ideenbrett, Aufgabenbrett, Kalender und Vorschlagseingang aber weiter auf
 * Deutsch — ohne jeden Hinweis darauf, dass hier etwas fehlt.
 *
 * Vier Dinge, die man dabei leicht falsch macht, und die dieser Lauf misst:
 *
 *   1. Ein leeres Feld darf keinen Modellaufruf auslösen und nicht als
 *      "übersetzt zu nichts" im Wörterbuch landen.
 *   2. Steht die Karte schon in der Lesesprache (NOOP), gehört sie NICHT ins
 *      Wörterbuch — sonst zeigte die Ansicht später ein „übersetzt aus …" an
 *      unverändertem Text, also eine Falschauskunft.
 *   3. Ein Chiffrat aus einem vertraulichen Kanal darf NIE an ein fremdes
 *      Modell gehen. Zurück käme Unsinn — hingegangen wäre es trotzdem.
 *   4. `uebersetztesFeld()` muss ein FEHLENDES Feld vom Feld mit leerem Text
 *      unterscheiden. Mit `??` allein greift der Rückfall bei '' nicht, mit
 *      `||` verschwindet eine absichtlich leere Übersetzung.
 *
 * Aufruf:  npx tsx src/pruefungen/karten-uebersetzung.mts
 */
import { uebersetztesFeld, type KartenUebersetzung } from '@stellium/shared';
import { db, initDb } from '../db/index.js';
import { translateKarte } from '../translation/index.js';

initDb();

let fehler = 0;
const pruefWahr = (name: string, bedingung: boolean, hinweis = '') => {
  if (bedingung) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); return; }
  fehler++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${hinweis ? `  — ${hinweis}` : ''}`);
};

db.run(`INSERT INTO users (id, handle, display_name, password_hash, language, created_at)
        VALUES ('autor-de', 'autor-de', 'Autorin', 'x', 'de', 0)`);

/* ── 1. Der Regelfall: deutsche Karte, englische Lesesprache ───── */

console.log('\nKarte in die Lesesprache bringen');

/* Der Wortlaut ist mit Absicht gewählt: ohne Schlüssel läuft hier der
   DemoProvider, und der übersetzt nur, was in seinem kleinen Wörterbuch
   steht (providers/demo.ts). Nimmt man einen beliebigen deutschen Satz,
   reicht er den Eingabetext unverändert zurück, translate() erkennt das
   (`unuebersetzt`) — und dann gibt translateKarte() völlig richtig `null`.
   Der Lauf misst sonst nicht die Karte, sondern das Wörterbuch des Demo-
   Anbieters. „Besprechung heute" -> „meeting today", „Fehler erledigt" ->
   „bug done". */
const TITEL = 'Besprechung heute';
const BESCHREIBUNG = 'Fehler erledigt';

const karte = await translateKarte({ title: TITEL, description: BESCHREIBUNG }, 'en', 'autor-de');

pruefWahr('eine Übersetzung kommt zurück', karte !== null,
  'translateKarte() gab null — dann bleibt die Karte im Original stehen');
pruefWahr('die Zielsprache steht dran', karte?.lang === 'en', JSON.stringify(karte?.lang));
pruefWahr('der Titel ist übersetzt', Boolean(karte?.felder.title));
pruefWahr('die Beschreibung ist übersetzt', Boolean(karte?.felder.description));
/* Nicht `!==` gegen das Original: solange `karte` null ist, ist
   `karte?.felder.title` undefined und ungleich allem — die Prüfung ginge
   durch, ohne je einen übersetzten Text gesehen zu haben. */
pruefWahr('der Titel hat sich wirklich geändert',
  typeof karte?.felder.title === 'string' && karte.felder.title !== TITEL,
  `${JSON.stringify(karte?.felder.title)} — gleicher Text wäre eine Falschauskunft`);

/* ── 2. Leere Felder ───────────────────────────────────────────── */

console.log('\nLeere Felder');

const leer = await translateKarte({ title: 'Angebot prüfen', description: null, location: '   ' }, 'en', 'autor-de');
pruefWahr('null-Feld steht nicht im Wörterbuch', !(leer && 'description' in leer.felder));
pruefWahr('Feld aus Leerzeichen steht nicht im Wörterbuch', !(leer && 'location' in leer.felder));
pruefWahr('der gefüllte Titel kommt trotzdem durch', Boolean(leer?.felder.title));

const garnichts = await translateKarte({ title: null, description: '' }, 'en', 'autor-de');
pruefWahr('Karte ohne Text gibt null (kein Modellaufruf)', garnichts === null);

/* ── 3. Schon in der Lesesprache (NOOP) ────────────────────────── */

console.log('\nSchon in der Lesesprache');

const gleich = await translateKarte({ title: TITEL }, 'de', 'autor-de');
pruefWahr('deutsche Karte, deutsche Lesesprache -> null',
  gleich === null,
  'sonst stünde später ein „übersetzt aus …" an unverändertem Text');

/* ── 4. Vertrauliches bleibt drin ──────────────────────────────── */

console.log('\nVertrauliches');

const chiffrat = 'e1:' + Buffer.from('was auch immer').toString('base64');
const verschluesselt = await translateKarte({ title: chiffrat }, 'en', 'autor-de');
pruefWahr('ein Chiffrat wird nicht übersetzt', verschluesselt === null,
  'ein E2E-Chiffrat ging an ein fremdes Übersetzungsmodell');

const gemischt = await translateKarte({ title: 'Angebot prüfen', description: chiffrat }, 'en', 'autor-de');
pruefWahr('neben dem Chiffrat kommt der Klartext durch', Boolean(gemischt?.felder.title));
pruefWahr('das Chiffrat selbst fehlt im Wörterbuch', !(gemischt && 'description' in gemischt.felder));

/* ── 5. uebersetztesFeld() ─────────────────────────────────────── */

console.log('\nRückfall auf das Original');

const mit = (felder: Record<string, string>) =>
  ({ translation: { lang: 'en', felder, provider: 'demo' } as KartenUebersetzung });

pruefWahr('fehlendes Feld -> Original',
  uebersetztesFeld(mit({}), 'title', 'Original') === 'Original');
pruefWahr('vorhandenes Feld -> Übersetzung',
  uebersetztesFeld(mit({ title: 'Translated' }), 'title', 'Original') === 'Translated');
pruefWahr('leere Übersetzung bleibt leer (kein || -Rückfall)',
  uebersetztesFeld(mit({ title: '' }), 'title', 'Original') === '');
pruefWahr('ohne jede Übersetzung -> Original',
  uebersetztesFeld({}, 'title', 'Original') === 'Original');
pruefWahr('Original null bleibt null',
  uebersetztesFeld(mit({}), 'description', null) === null);

console.log(fehler === 0
  ? '\n\x1b[32mAlle Prüfungen bestanden\x1b[0m\n'
  : `\n\x1b[31m${fehler} Prüfung(en) fehlgeschlagen\x1b[0m\n`);
process.exit(fehler === 0 ? 0 : 1);
