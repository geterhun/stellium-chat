/** Prüft die neuen Bereiche: KI-Reiter, Aufgaben, Kalender, Dateien, Tour. */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';

/* Fest verdrahtet stand hier localhost:8787 — damit lief dieser eine Lauf
   immer gegen den Entwicklungsserver, egal was STELLIUM_SERVER sagt, während
   alle anderen Prüfläufe der Umgebung folgen. */
const SERVER = S;
/* Hier stand der Kratzordner einer einzelnen Sitzung fest im Quelltext —
   ein Pfad unter /private/tmp/claude-501/…, den es auf keinem zweiten Rechner
   gibt und der nach einem Neustart auch auf diesem weg ist. Die Bilder gehen
   jetzt dorthin, wo alle anderen Läufe ihre ablegen. */
const SHOTS = process.env.STELLIUM_BILDER ?? 'schirmbilder/e2e-neu';
fs.mkdirSync(SHOTS, { recursive: true });

/* Ein Einmal-Passwort aus einem früheren Lauf gehört nicht in den Quelltext:
   das Repository ist öffentlich, und ein Zugang, der irgendwann einmal gültig
   war, ist genau die Art Fund, nach der automatisierte Sucher greifen. Wer den
   Weg über die Ersteinrichtung prüfen will, gibt ihn über die Umgebung mit. */
const EINMAL = process.env.STELLIUM_OTP ?? '';
const PASSWORT = PW;

const ergebnisse = [];
let seite;

async function pruefe(name, fn) {
  try { await fn(); ergebnisse.push(['ok', name]); console.log('  ✓', name); }
  catch (e) {
    ergebnisse.push(['fehler', name, e.message]);
    console.log('  ✗', name, '—', e.message.split('\n')[0]);
    await seite?.screenshot({ path: `${SHOTS}/${name.replace(/[^a-z0-9]+/gi, '-')}.png` }).catch(() => {});
  }
}

async function zu() {
  for (let i = 0; i < 5; i++) {
    if (!(await seite.locator('.scrim, .tour').count())) break;
    await seite.keyboard.press('Escape');
    await seite.waitForTimeout(250);
  }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
seite = await ctx.newPage();
seite.on('pageerror', (e) => console.log('  ⚠ Seitenfehler:', e.message));

await seite.goto(APP);
await seite.evaluate((s) => localStorage.setItem('stellium.serverUrl', s), SERVER);
await seite.reload();
await seite.waitForSelector('.auth, .app', { timeout: 15000 });

// Anmelden — je nach Zustand Ersteinrichtung oder normaler Login
if (await seite.locator('.auth').count()) {
  const anmelden = async (pw) => {
    await seite.locator('.auth input').first().fill(LOGIN);
    await seite.locator('.auth input[type="password"]').first().fill(pw);
    await seite.locator('.auth button[type="submit"], .auth .btn--primary').first().click();
  };
  await anmelden(PASSWORT);
  await seite.waitForTimeout(1800);
  if (await seite.locator('.auth').count()) {
    if (!EINMAL) {
      throw new Error(
        'Anmeldung mit dem Testpasswort fehlgeschlagen, und es liegt kein '
        + 'Einmal-Passwort vor. Entweder .stellium-test richtigstellen oder '
        + 'STELLIUM_OTP setzen.',
      );
    }
    await anmelden(EINMAL);
    await seite.waitForTimeout(2000);
    await seite.waitForTimeout(2500);
    // Ersteinrichtung: eigene Zugangsdaten festlegen
    if (await seite.locator('.auth__title').count()
        && (await seite.locator('.auth__title').innerText()).includes('Willkommen')) {
      const felder = seite.locator('.auth__card input');
      await felder.nth(0).fill('Don Calvin Kuhn');
      await felder.nth(1).fill(LOGIN);
      await felder.nth(2).fill('don@stellium.local');
      await felder.nth(3).fill(PASSWORT);
      await felder.nth(4).fill(PASSWORT);
      await seite.locator('.auth__card button[type="submit"], .auth__card .btn--primary').last().click();
      await seite.waitForTimeout(3000);
    }
  }
}
await seite.waitForSelector('.app', { timeout: 20000 });
console.log('\nAngemeldet.\n');

/* ── Tour ────────────────────────────────────────────────── */
await pruefe('Tour startet beim ersten Login', async () => {
  await seite.evaluate(() => localStorage.removeItem('stellium.tourGesehen'));
  await seite.reload();
  await seite.waitForSelector('.tour__card', { timeout: 15000 });
});

await pruefe('Tour hebt echte Bedienelemente hervor', async () => {
  // Schritt 1 ist die Begrüßung ohne Ziel, ab Schritt 2 muss ein Ring da sein.
  await seite.click('.tour__foot .btn--primary');
  await seite.waitForTimeout(500);
  const ringe = await seite.locator('.tour__ring').count();
  if (!ringe) throw new Error('kein Hervorhebungsring');
  const box = await seite.locator('.tour__ring').boundingBox();
  if (!box || box.width < 10) throw new Error('Ring hat keine Fläche');
});

await pruefe('Tour bleibt im Fenster', async () => {
  /* Der Ausstieg beim ersten Durchgang war ein bestandener Lauf ohne eine
     einzige Messung: startete die Tour gar nicht, brach die Schleife sofort ab
     und niemand sah es. Mindestens eine Karte muss dagewesen sein. */
  let gemessen = 0;
  for (let i = 0; i < 16; i++) {
    if (!(await seite.locator('.tour__card').count())) break;
    const karte = await seite.locator('.tour__card').boundingBox();
    if (!karte) break;
    gemessen += 1;
    if (karte.x < 0 || karte.y < 0 || karte.x + karte.width > 1441 || karte.y + karte.height > 901) {
      throw new Error(`Karte ragt heraus: ${JSON.stringify(karte)}`);
    }
    await seite.click('.tour__foot .btn--primary');
    await seite.waitForTimeout(320);
  }
  if (!gemessen) throw new Error('die Tour zeigte keine einzige Karte — es wurde nichts gemessen');
  return `${gemessen} Karten`;
});

await pruefe('Tour lässt sich überspringen', async () => {
  await seite.evaluate(() => localStorage.removeItem('stellium.tourGesehen'));
  await seite.reload();
  await seite.waitForSelector('.tour__card');
  await seite.click('.tour__close');
  await seite.waitForTimeout(400);
  if (await seite.locator('.tour__card').count()) throw new Error('Tour noch offen');
  const gemerkt = await seite.evaluate(() => localStorage.getItem('stellium.tourGesehen'));
  if (gemerkt !== 'ja') throw new Error('nicht gemerkt');
});

await zu();

/* ── KI-Reiter ───────────────────────────────────────────── */
await pruefe('KI hat einen eigenen Reiter in der Leiste', async () => {
  if (!(await seite.locator('[data-tour="ai"]').count())) throw new Error('KI-Knopf fehlt');
});

/* ── Aufgaben ────────────────────────────────────────────── */
await pruefe('Aufgabenbrett öffnet sich', async () => {
  await seite.click('[data-tour="tasks"]');
  await seite.waitForSelector('.panel', { timeout: 6000 });
  await seite.waitForTimeout(400);
});

// Eigener Titel je Lauf — sonst greift der Test auf Aufgaben früherer Läufe.
const AUFGABE = `Angebot für Nordwind prüfen ${Date.now().toString(36).slice(-5)}`;

await pruefe('Aufgabe anlegen', async () => {
  await seite.locator('.panel__head .pill--accent').click();
  await seite.waitForTimeout(400);
  await seite.locator('.panel input.input').first().fill(AUFGABE);
  await seite.locator('.panel__foot .btn--primary').last().click();
  await seite.waitForTimeout(900);
  const text = await seite.locator('.board').innerText();
  if (!text.includes(AUFGABE)) throw new Error('Aufgabe nicht auf dem Brett');
});

/** Genau die eben angelegte Aufgabe. */
const meineAufgabe = () => seite.locator('.task-card').filter({ hasText: AUFGABE }).first();

await pruefe('Aufgabe hat fünf Spalten', async () => {
  const n = await seite.locator('.board__col').count();
  if (n !== 5) throw new Error(`${n} Spalten statt 5`);
});

await pruefe('Aufgabe öffnen und Status ändern', async () => {
  await meineAufgabe().click();
  await seite.waitForTimeout(500);
  // Der zweite .panel ist die Einzelansicht über dem Brett.
  const auswahl = seite.locator('.panel').last().locator('select').first();
  await auswahl.selectOption('working');
  await seite.waitForTimeout(800);
  await seite.keyboard.press('Escape');
  await seite.waitForTimeout(500);
  if (!(await seite.locator('.board').count())) throw new Error('Escape hat auch das Brett geschlossen');
  const spalte = seite.locator('.board__col').nth(1);
  if (!(await spalte.innerText()).includes(AUFGABE)) throw new Error('nicht verschoben');
});

await zu();

/* ── Kalender ────────────────────────────────────────────── */
await pruefe('Kalender öffnet sich mit sieben Tagen', async () => {
  await seite.click('[data-tour="calendar"]');
  await seite.waitForSelector('.week', { timeout: 6000 });
  const n = await seite.locator('.week__day').count();
  if (n !== 7) throw new Error(`${n} Tage statt 7`);
});

await pruefe('Termin anlegen', async () => {
  await seite.locator('.panel__head .pill--accent').click();
  await seite.waitForTimeout(400);
  await seite.locator('.panel input.input').first().fill('Wochenrunde');
  await seite.locator('.panel__foot .btn--primary').last().click();
  await seite.waitForTimeout(1000);
  const text = await seite.locator('.week').innerText();
  if (!text.includes('Wochenrunde')) throw new Error('Termin fehlt');
});

await pruefe('Wochenwechsel funktioniert', async () => {
  const vorher = await seite.locator('.week__num').first().innerText();
  await seite.locator('.panel__head .icon-btn').first().click();
  await seite.waitForTimeout(600);
  const nachher = await seite.locator('.week__num').first().innerText();
  if (vorher === nachher) throw new Error('Woche unverändert');
});

await zu();

/* ── Dateien ─────────────────────────────────────────────── */
await pruefe('Dateiablage öffnet sich', async () => {
  await seite.click('[data-tour="files"]');
  await seite.waitForSelector('.dropzone', { timeout: 6000 });
});

await pruefe('Datei hochladen', async () => {
  const pfad = `${SHOTS}/probe.txt`;
  fs.writeFileSync(pfad, 'Stellium Testdatei\n');
  await seite.setInputFiles('.panel input[type="file"]', pfad);
  await seite.waitForTimeout(2000);
  const text = await seite.locator('.dropzone').innerText();
  if (!text.includes('probe.txt')) throw new Error('Datei nicht in der Liste');
});

await pruefe('Speicherbelegung wird angezeigt', async () => {
  const sub = await seite.locator('.panel__sub').innerText();
  if (!/\d/.test(sub)) throw new Error(`keine Belegung: "${sub}"`);
});

await zu();

/* ── Nichts kaputt ───────────────────────────────────────── */
await pruefe('Chat funktioniert weiterhin', async () => {
  /* Nicht „erster Kanal der letzten Gruppe": auf einer frischen Datenbank
     ist die letzte Gruppe leer (noch keine Direktnachrichten), und der Klick
     wartete vergebens. Der letzte Kanal überhaupt erfüllt denselben Zweck. */
  await seite.locator('.sidebar__scroll .chan').last().click();
  await seite.waitForTimeout(600);
  await seite.locator('.composer__input').fill('Test nach dem Umbau');
  await seite.keyboard.press('Enter');
  await seite.waitForTimeout(1200);
  const text = await seite.locator('.app').innerText();
  if (!text.includes('Test nach dem Umbau')) throw new Error('Nachricht fehlt');
});

await zu();

/* ── Kontextmenü ─────────────────────────────────────────── */
await pruefe('Kontextmenü wird nicht abgeschnitten', async () => {
  const kanal = seite.locator('.chan').filter({ hasText: 'allgemein' }).first();
  await kanal.click({ button: 'right' });
  await seite.waitForSelector('.kontextmenue', { timeout: 6000 });
  const menue = await seite.locator('.kontextmenue').boundingBox();
  if (!menue) throw new Error('Menü ohne Fläche');
  // Ein abgeschnittenes Menü war nur so breit wie die Seitenleiste.
  if (menue.width < 180) throw new Error(`nur ${Math.round(menue.width)} px breit`);
  const leiste = await seite.locator('.sidebar').boundingBox();
  if (menue.x + menue.width <= leiste.x + leiste.width + 1) {
    throw new Error('Menü endet am Rand der Seitenleiste — vermutlich beschnitten');
  }
  // Und jeder Eintrag muss seinen Text ganz zeigen.
  const beschnitten = await seite.evaluate(() =>
    [...document.querySelectorAll('.kontextmenue__eintrag')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1).length);
  if (beschnitten) throw new Error(`${beschnitten} Einträge mit abgeschnittenem Text`);
  await seite.keyboard.press('Escape');
  await seite.waitForTimeout(300);
  return `${Math.round(menue.width)} px breit, vollständig`;
});

await zu();

/* ── Ideenboard ──────────────────────────────────────────── */
await pruefe('Ideenboard öffnet sich', async () => {
  await seite.click('[data-tour="ideas"]');
  await seite.waitForSelector('.idea-bar', { timeout: 6000 });
});

// Eigener Titel je Lauf: sonst hängt der Test an Ideen aus früheren Läufen.
const IDEE = `Freitags früher Schluss ${Date.now().toString(36).slice(-5)}`;

await pruefe('Idee einbringen', async () => {
  await seite.locator('.panel__head .pill--accent').click();
  await seite.waitForTimeout(400);
  await seite.locator('.panel input.input').first().fill(IDEE);
  await seite.locator('.panel__foot .btn--primary').last().click();
  await seite.waitForTimeout(1000);
  if (!(await seite.locator('.idea-list').innerText()).includes(IDEE)) throw new Error('Idee fehlt');
});

/** Genau die eben eingebrachte Idee, nicht irgendeine aus einem früheren Lauf. */
const meineIdee = () => seite.locator('.idea-row').filter({ hasText: IDEE }).first();

await pruefe('Eigene Idee zählt als Zustimmung', async () => {
  const wert = await meineIdee().locator('.idea-vote__zahl').innerText();
  if (wert.trim() !== '+1') throw new Error(`Stand ${wert} statt +1`);
});

await pruefe('Daumen runter kehrt die Stimme um', async () => {
  await meineIdee().locator('.idea-vote__btn').nth(1).click();
  await seite.waitForTimeout(900);
  const wert = await meineIdee().locator('.idea-vote__zahl').innerText();
  if (wert.trim() !== '-1') throw new Error(`Stand ${wert} statt -1`);
});

await pruefe('Nochmal derselbe Daumen nimmt die Stimme zurück', async () => {
  await meineIdee().locator('.idea-vote__btn').nth(1).click();
  await seite.waitForTimeout(900);
  const wert = await meineIdee().locator('.idea-vote__zahl').innerText();
  if (wert.trim() !== '0') throw new Error(`Stand ${wert} statt 0`);
});

await pruefe('Kommentieren und Stand ändern', async () => {
  await meineIdee().locator('.idea-row__main').click();
  await seite.waitForTimeout(600);
  const dialog = seite.locator('.panel').last();
  await dialog.locator('input.input').last().fill('Gute Idee, machen wir.');
  await seite.keyboard.press('Enter');
  await seite.waitForTimeout(900);
  if (!(await dialog.locator('.idea-comments').innerText()).includes('Gute Idee')) throw new Error('Kommentar fehlt');

  // Stand auf "in Bearbeitung" setzen
  await dialog.locator('.idea-filter .idea-tab').nth(1).click();
  await seite.waitForTimeout(900);
  await seite.keyboard.press('Escape');
  await seite.waitForTimeout(500);
  const text = await seite.locator('.idea-list').innerText();
  if (!/Bearbeitung|progress/i.test(text)) throw new Error('Stand nicht übernommen');
});

await zu();

/* ── Der Groq-Schlüssel in den Einstellungen ──────────────────────
   Geprüft wird, dass das Feld da ist, verdeckt eingibt und dass der Server
   Unsinn abweist. NICHT geprüft wird das erfolgreiche Speichern: das legte
   einen erfundenen Schlüssel im Tresor ab und überschriebe damit den echten,
   der sich hinterher nicht zurückholen lässt — angezeigt wird er ja nie
   wieder. Ein Prüflauf darf die Übersetzung nicht stillegen. */
await pruefe('Groq-Schlüssel steht in den Einstellungen unter „Schlüssel"', async () => {
  await seite.locator('.rail [data-tour="settings"]').click();
  await seite.waitForSelector('.panel');
  await seite.locator('.tab:has-text("Schlüssel")').first().click();
  await seite.waitForTimeout(1200);

  const feld = seite.locator('.field:has(.field__label:has-text("Groq")) input');
  if (await feld.count() !== 1) throw new Error(`${await feld.count()} Groq-Felder statt einem`);
  if (await feld.getAttribute('type') !== 'password') throw new Error('Der Schlüssel stünde im Klartext da');

  await feld.fill('das ist kein schluessel');
  await seite.locator('.btn--primary:has-text("Speichern")').first().click();
  await seite.waitForTimeout(1500);
  const text = await seite.locator('body').innerText();
  if (!/API-Schlüssel aus|zu kurz/i.test(text)) throw new Error('Unsinn wurde nicht abgewiesen');
  await feld.fill('');
});

await zu();

await seite.screenshot({ path: `${SHOTS}/final.png`, fullPage: false });

const fehler = ergebnisse.filter((r) => r[0] === 'fehler');
console.log(`\n${ergebnisse.length - fehler.length}/${ergebnisse.length} bestanden`);
for (const f of fehler) console.log('  FEHLER:', f[1], '—', f[2]);
await browser.close();
process.exit(fehler.length ? 1 : 0);
