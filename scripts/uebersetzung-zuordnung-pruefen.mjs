#!/usr/bin/env node
/**
 * Fund 1 (Auftrag): Kann eine Vertretung mit ihrem Erfolg dem EIGENEN Modell
 * gutgeschrieben werden, wenn die Vertretung erst MITTEN in einem laufenden
 * Übersetzungsversuch installiert wird?
 *
 * DER FEHLER
 *
 * translate() (translation/index.ts) hielt fest, wer gerade antwortet
 * (`antwortendeStelle = derzeit()`), BEVOR withRetry() überhaupt den ersten
 * Versuch startet. withRetry() ruft bei einem erneuerbaren Fehler bis zu
 * dreimal auf — und jeder einzelne Versuch löst `provider.translate` über
 * den Proxy NEU auf, also `derzeit()` NEU, zum Zeitpunkt DIESES Versuchs.
 * Installiert eine ANDERE, GLEICHZEITIG laufende Übersetzung zwischen
 * Versuch 1 und Versuch 2 dieses Aufrufs eine Vertretung (ersatzUebernimmt()
 * über ausfallMelden()), geht Versuch 2 tatsächlich an die Vertretung — die
 * vorab festgehaltene `antwortendeStelle` weiß davon nichts und zeigt
 * weiter auf das eigene, eingestellte Modell. Ein Erfolg der Vertretung galt
 * damit fälschlich als Erfolg des eigenen Modells: `erfolgMelden()` ->
 * `festhalten('erreichbar', …)` -> die Vertretung tritt Sekunden nach ihrer
 * Installation gleich wieder ab, während der Rechner nachweislich noch aus
 * ist.
 *
 * WIE HIER ECHTE NEBENLÄUFIGKEIT ENTSTEHT (nicht simuliert, nicht gemockt)
 *
 * Zwei WIRKLICHE translate()-Aufrufe laufen gleichzeitig gegen denselben,
 * gerade abgeschalteten lokalen Dienst:
 *
 *   · Nachricht A — normal lang. Erster Versuch scheitert an der toten
 *     Verbindung (ECONNREFUSED, "erneuerbar") und wartet die echte
 *     withRetry()-Rückstellzeit ab (mindestens 350 ms) vor Versuch 2.
 *   · Nachricht B — absichtlich zu lang für das Kontextfenster (8192
 *     Marken, MIN_CONTEXT). Das ist ein rein rechnerischer, NICHT
 *     erneuerbarer Fehler ganz ohne Netzzugriff (verlaufsBudget() in
 *     openai-compatible.ts) — B scheitert darum in einem Bruchteil einer
 *     Millisekunde, weit bevor A überhaupt in die Rückstellzeit vor Versuch
 *     2 eintritt.
 *
 * B's Fehlschlag ist KEIN Ausfall — das Modell hat ja nichts verweigert,
 * der Text passt bloß nicht hinein. Früher löste er trotzdem ausfallMelden()
 * aus, und eine einzige lange Nachricht schickte den Verkehr zur Vertretung
 * im Netz; das prüft dieser Lauf jetzt mit. Die Vertretung installiert
 * stattdessen ein direkter Aufruf von ausfallMelden() — derselbe Weg, den
 * translate() bei einer toten Verbindung nimmt —, noch während A mitten in
 * seiner Rückstellzeit vor Versuch 2 wartet. A's Versuch 2 geht
 * darum tatsächlich an die Vertretung. Genau in diesem Fenster steckte der
 * Fehler.
 *
 * ZWEI FASSUNGEN, DIE SICH UNTERSCHEIDEN MÜSSEN
 *
 * Vor der Behebung hätte A's Erfolg über die Vertretung fälschlich als
 * Erfolg des eigenen Modells gegolten (lokalerZustand -> "erreichbar",
 * lokalErfolgAm neu gesetzt, die Vertretung tritt ab). Nach der Behebung
 * bleibt der wahre Zustand stehen: das eigene Modell gilt weiter als
 * "antwortet nicht", die Vertretung bleibt im Amt.
 *
 *   node scripts/uebersetzung-zuordnung-pruefen.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HIER = fileURLToPath(import.meta.url);
const WURZEL = path.resolve(path.dirname(HIER), '..');

if (!process.env.STELLIUM_ZUORDNUNG_KIND) {
  const tsx = path.join(WURZEL, 'node_modules', '.bin', 'tsx');
  if (!fs.existsSync(tsx)) {
    console.error('tsx fehlt — einmal "npm install" laufen lassen.');
    process.exit(1);
  }
  const kind = spawn(tsx, [HIER], {
    stdio: 'inherit',
    env: { ...process.env, STELLIUM_ZUORDNUNG_KIND: '1' },
  });
  kind.on('exit', (code) => process.exit(code ?? 1));
} else {
  await pruefen();
}

async function pruefen() {
  const ergebnisse = [];
  const pruefe = (name, bedingung, hinweis = '') => {
    if (bedingung) { ergebnisse.push(1); console.log(`  ✓ ${name}`); }
    else { ergebnisse.push(0); console.log(`  ✗ ${name}${hinweis ? ` — ${hinweis}` : ''}`); }
  };

  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-zuordnung-'));

  process.env.DATA_DIR = path.join(ordner, 'daten');
  process.env.AI_PROVIDER = 'local';
  process.env.AI_TIMEOUT_MS = '2000';
  process.env.JWT_SECRET = 'pruefunglaeuftmitfestemgeheimnis';

  const freierPort = () => new Promise((fertig) => {
    const sucher = net.createServer();
    sucher.listen(0, '127.0.0.1', () => {
      const p = sucher.address().port;
      sucher.close(() => fertig(p));
    });
  });
  const lokalerPort = await freierPort();
  const groqPort = await freierPort();

  process.env.LOCAL_BASE_URL = `http://127.0.0.1:${lokalerPort}/v1`;
  process.env.LOCAL_MODEL = 'pruefmodell';
  process.env.GROQ_API_KEY = 'pruef-schluessel-kein-echter';
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${groqPort}/v1`;
  // Fest verdrahtet: die ModelRegistry fragt dann nie /models beim
  // erfundenen Groq-Dienst ab (siehe fullyPinned, model-registry.ts).
  process.env.GROQ_MODEL = 'pruefmodell-groq';
  process.env.GROQ_FAST_MODEL = 'pruefmodell-groq';

  // Antwortet zunächst normal — für den einleitenden Erfolg, der `lage` auf
  // "erreichbar" setzt (siehe unten). Wird danach ganz geschlossen: eine
  // Verbindung zu einem geschlossenen Port scheitert auf localhost in der
  // Regel binnen weniger Millisekunden (ECONNREFUSED, kein Handshake) —
  // schneller und verlässlicher als ein offener Server, der die Verbindung
  // erst nach dem Aufbau abbricht.
  const lokalerDienst = http.createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'pruefmodell' }] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      translation: 'Ich bin auf dem Weg zur Besprechung',
      detected_source_language: 'en', confidence: 0.95,
    }) } }] }));
  });
  await new Promise((r) => lokalerDienst.listen(lokalerPort, '127.0.0.1', r));

  let groqAnfragen = 0;
  const groqDienst = http.createServer((req, res) => {
    groqAnfragen += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      translation: 'Ich bin auf dem Weg zur Besprechung',
      detected_source_language: 'en', confidence: 0.95,
    }) } }] }));
  });
  await new Promise((r) => groqDienst.listen(groqPort, '127.0.0.1', r));

  try {
    const { initDb } = await import('../packages/server/src/db/index.ts');
    const { migrate } = await import('../packages/server/src/db/migrate.ts');
    initDb(); migrate();
    const { translate, aiCapabilities, ersatzLaeuft } = await import('../packages/server/src/translation/index.ts');
    const { ausfallMelden } = await import('../packages/server/src/translation/erreichbarkeit.ts');

    console.log('\nEigener Rechner an — ein einleitender Erfolg setzt "lage" auf erreichbar');
    const einleitend = await translate({ text: 'good morning everyone', targetLang: 'de', sourceLang: 'en' });
    pruefe('übersetzt', !einleitend.unuebersetzt);
    pruefe('meldet sich als erreichbar', aiCapabilities().lokalerZustand === 'erreichbar');
    const erfolgAmVorher = aiCapabilities().lokalErfolgAm;
    pruefe('ein Erfolgszeitpunkt ist festgehalten', typeof erfolgAmVorher === 'number');

    console.log('\nEigener Rechner geht aus — Port ganz geschlossen, keine Verbindung mehr möglich');
    await new Promise((r) => lokalerDienst.close(r));

    // Kleine Pause, damit der Zeitstempel des einleitenden Erfolgs sich
    // sicher von einem eventuell neu gesetzten unterscheidet.
    await new Promise((r) => setTimeout(r, 20));

    console.log('\nZwei ECHTE Übersetzungen gleichzeitig — A (normal) und B (absichtlich zu lang fürs Kontextfenster)');
    // A: normale Nachricht. Versuch 1 scheitert an der toten Verbindung
    // (erneuerbar) und wartet danach die echte withRetry()-Rückstellzeit
    // (>= 350 ms) vor Versuch 2 ab — währenddessen ist A "mid-retry".
    const TEXT_A = 'can you check the deploy logs please';
    const pA = translate({ text: TEXT_A, targetLang: 'de', sourceLang: 'en' });

    // B: künstlich über das Kontextfenster hinaus (MIN_CONTEXT = 8192
    // Marken, ~3 Zeichen/Marke bei lateinischer Schrift) — ein rein
    // rechnerischer, NICHT erneuerbarer Fehler ganz ohne Netzzugriff
    // (verlaufsBudget() in providers/openai-compatible.ts). Scheitert daher
    // in einem Bruchteil einer Millisekunde, lange bevor A überhaupt in die
    // Rückstellzeit vor Versuch 2 eintritt.
    const PHRASE_B = 'this message is intentionally far too long for the model context window right now. ';
    let TEXT_B = '';
    while (TEXT_B.length < 30000) TEXT_B += PHRASE_B;
    const ergebnisB = await translate({ text: TEXT_B, targetLang: 'de', sourceLang: 'en' });

    pruefe(
      'B scheitert rein rechnerisch (zu lang fürs Kontextfenster), nicht als Übersetzung',
      ergebnisB.unuebersetzt === true && ergebnisB.noop === true,
      `unuebersetzt=${ergebnisB.unuebersetzt}, noop=${ergebnisB.noop}`,
    );
    pruefe(
      'B allein holt KEINE Vertretung — zu lang ist kein Ausfall des eigenen Modells',
      ersatzLaeuft() === null,
      `ersatzLaeuft()="${ersatzLaeuft()}"`,
    );

    // A wartet jetzt in seiner Rückstellzeit vor Versuch 2. Genau hier fällt
    // der Rechner offiziell aus — wie bei einer toten Verbindung in translate().
    ausfallMelden('Prüflauf: eigener Rechner antwortet nicht');
    // Die Vertretung zieht über einen spät geladenen import() ein (siehe
    // erreichbarkeit.ts) — kurz warten, weit innerhalb von A's Rückstellzeit.
    await new Promise((r) => setTimeout(r, 30));
    pruefe(
      'die Vertretung ist installiert, während A noch wartet',
      ersatzLaeuft() === 'groq',
      `ersatzLaeuft()="${ersatzLaeuft()}"`,
    );

    const ergebnisA = await pA;
    pruefe(
      'A wurde tatsächlich über die Vertretung beantwortet (Versuch 2, nach dem Ausfall)',
      ergebnisA.provider === 'groq' && !ergebnisA.unuebersetzt,
      `provider="${ergebnisA.provider}", unuebersetzt=${ergebnisA.unuebersetzt}`,
    );
    pruefe('Groq wurde für A wirklich gefragt', groqAnfragen >= 1);

    console.log('\nDIE KERNFRAGE: hat A\'s Erfolg über die Vertretung dem EIGENEN Modell gegolten?');
    // Ein fälschlicher Rücktritt der Vertretung hängt am Übergang in
    // festhalten() an einem spät geladenen dynamischen import() (siehe
    // erreichbarkeit.ts) — der läuft nicht mehr synchron mit dem Ende des
    // await Promise.all() oben durch. Eine kurze Pause genügt, damit dieser
    // Übergang (falls er fälschlich ausgelöst wurde) sich zeigen kann,
    // bevor die letzte Prüfung ihn abfragt — dieselbe Technik wie in
    // scripts/modell-ausfall-pruefen.mjs (pruefenErholung).
    await new Promise((r) => setTimeout(r, 50));
    pruefe(
      'das eigene Modell gilt weiterhin als "antwortet nicht" — A\'s Erfolg über die Vertretung darf das NICHT überschreiben',
      aiCapabilities().lokalerZustand === 'antwortet-nicht',
      `lokalerZustand="${aiCapabilities().lokalerZustand}" — wäre "erreichbar", würde A's Erfolg fälschlich dem eigenen Modell gutgeschrieben`,
    );
    pruefe(
      'der Erfolgszeitpunkt des eigenen Modells bleibt unverändert (keine Verbuchung während der Rechner aus ist)',
      aiCapabilities().lokalErfolgAm === erfolgAmVorher,
      `lokalErfolgAm=${aiCapabilities().lokalErfolgAm} statt ${erfolgAmVorher}`,
    );
    pruefe(
      'die Vertretung ist NICHT abgetreten — ein Wechsel auf "erreichbar" hätte sie sofort zurückgezogen',
      ersatzLaeuft() === 'groq',
      `ersatzLaeuft()="${ersatzLaeuft()}" — wäre null, wäre die Vertretung fälschlich Sekunden nach ihrer Installation zurückgetreten`,
    );
  } finally {
    groqDienst.close();
    try { lokalerDienst.close(); } catch { /* schon zu */ }
    fs.rmSync(ordner, { recursive: true, force: true });
  }

  const gut = ergebnisse.filter(Boolean).length;
  if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
  console.log(`\n${gut === ergebnisse.length ? '✓' : '✗'} ${gut}/${ergebnisse.length} bestanden`);
  process.exit(gut === ergebnisse.length ? 0 : 1);
}
