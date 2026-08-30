/**
 * Öffnet jeden Dialog und jedes Aufklappmenü und misst, ob es vollständig im
 * Fenster liegt. Abgeschnittene Fenster sind der Fehler, der in dieser App am
 * häufigsten aufgetreten ist — meist, weil ein Weichzeichner darüber alles
 * darin einsperrt.
 */
import { chromium } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';


const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true });

/** Bei mehreren Fenstergrößen prüfen — auf einem kleinen fällt mehr auf.
    Die Einträge mit drittem Wert sind Tablets: gleiche Messungen, aber mit
    Fingereingabe (pointer: coarse), hoch wie quer — diese Zone lag vorher
    komplett außerhalb jedes Prüflaufs. */
for (const [breite, hoehe, beruehrung] of [
  [1440, 900], [1180, 720], [900, 620],
  [1280, 800, true], [1024, 768, true], [820, 1180, true], [768, 1024, true],
]) {
  console.log(`\n${breite}×${hoehe}${beruehrung ? ' (Touch)' : ''}`);
  const p = await (await b.newContext({
    viewport: { width: breite, height: hoehe },
    hasTouch: Boolean(beruehrung),
    locale: 'de-DE',
  })).newPage();
  await p.goto(APP);
  await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
  await p.reload(); await p.waitForTimeout(1000);
  if (await p.locator('.auth').count()) {
    await p.locator('.auth input').first().fill(LOGIN);
    await p.locator('.auth input[type="password"]').first().fill(PW);
    await p.locator('.auth button[type="submit"]').first().click();
  }
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1200);

  /**
   * Liegt alles Sichtbare im Fenster?
   *
   * Die Zahl der betrachteten Kästen wird mitgeliefert, und das ist kein
   * Beiwerk: die Schleife unten fand nichts, wenn sich gar kein Fenster
   * geöffnet hatte — und eine Schleife über nichts wirft auch nichts. Sieben
   * Prüfungen in dieser Datei drücken eine Taste und messen danach; ging die
   * Taste ins Leere, meldeten sie ein Häkchen für einen Bildschirm, auf dem
   * nichts passiert war. Deshalb muss jede Messung sagen, WAS sie gemessen
   * hat, und der Aufrufer prüft, dass es überhaupt etwas war.
   */
  const misst = async (was) => {
    const { schlecht: mangel, gesehen } = await p.evaluate(({ b, h }) => {
      const schlecht = [];
      let gesehen = 0;
      for (const el of document.querySelectorAll('.panel, .kontextmenue, .profile, .neu, [style*="position: fixed"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) continue;
        gesehen += 1;
        if (r.top < -1 || r.left < -1 || r.bottom > h + 1 || r.right > b + 1) {
          schlecht.push({
            teil: el.className || el.tagName,
            oben: Math.round(r.top), unten: Math.round(r.bottom),
            links: Math.round(r.left), rechts: Math.round(r.right),
          });
        }
      }
      return { schlecht, gesehen };
    }, { b: breite, h: hoehe });
    if (!gesehen) {
      throw new Error('kein einziges Fenster offen — es wurde nichts gemessen');
    }
    if (mangel.length) {
      throw new Error(`ragt heraus: ${mangel.map((m) => `${m.teil} (${m.oben}…${m.unten})`).join(', ')}`);
    }
    return was;
  };

  const zu = async () => {
    for (let i = 0; i < 5; i++) {
      if (!(await p.locator('.scrim, .kontextmenue').count())) break;
      await p.keyboard.press('Escape');
      await p.waitForTimeout(260);
    }
    /* Die Kanal-Schublade hört nicht auf Escape, und ihr Schleier heißt
       schublade-schleier, nicht scrim — er blieb nach dem Kontextmenü-Test
       liegen und fing alle weiteren Klicks ab (gemessen bei 820×1180).
       Er schließt per Klick; rechts außen trifft der Klick sicher den
       Schleier, nicht die Schublade (links). Scrims sind hier immer schon
       weg — die Escape-Schleife oben läuft, bis keiner mehr da ist. */
    if (await p.locator('.app--schublade .schublade-schleier').count()) {
      await p.mouse.click(breite - 24, Math.floor(hoehe / 2));
      await p.waitForTimeout(300);
    }
  };

  /* ── Die Fenster aus der linken Leiste ─────────────────────── */
  for (const [reiter, name] of [
    ['tasks', 'Aufgaben'], ['calendar', 'Kalender'], ['files', 'Dateien'],
    ['ideas', 'Ideenboard'], ['reminders', 'Erinnerungen'], ['settings', 'Einstellungen'],
    /* Die Teamverwaltung steht nicht mehr in der Leiste, sondern hinter dem
       Stern (siehe Rail.tsx). Der Eintrag dort trägt denselben Griff mit dem
       Vorsatz "stern-"; erst muss also das Menü auf. Vorher suchte die
       Prüfung weiter in der Leiste und war rot, ohne dass etwas kaputt war. */
    ['stern-team', 'Teamverwaltung'],
  ]) {
    if (reiter.startsWith('stern-')) {
      await p.locator('.rail [data-tour="stern"]').click();
      await p.waitForTimeout(400);
    }
    const knopf = p.locator(reiter.startsWith('stern-')
      ? `[data-tour="${reiter}"]` : `.rail [data-tour="${reiter}"]`);
    /* Ein fehlender Knopf war bisher ein stiller Übersprung: die Prüfung
       verschwand aus der Liste, statt rot zu werden, und „7/7 bestanden"
       wurde eben zu „3/3 bestanden". Fehlt die Leiste ganz, blieb von diesem
       Abschnitt gar nichts übrig. */
    await pruefe(name, async () => {
      muss(await knopf.count(), `in der Leiste gibt es keinen Knopf "${reiter}"`);
      await knopf.click();
      await p.waitForSelector('.panel', { timeout: 8000 });
      await p.waitForTimeout(700);
      return misst(await p.locator('.panel__head h2').first().innerText().catch(() => name));
    });
    await zu();
  }

  /* ── Fenster über Fenstern ─────────────────────────────────── */
  await pruefe('Aufgabe anlegen (im Brett)', async () => {
    await p.locator('.rail [data-tour="tasks"]').click();
    await p.waitForSelector('.panel');
    await p.locator('.panel__head .pill--accent').click();
    await p.waitForTimeout(700);
    return misst(`${await p.locator('.panel').count()} Ebenen`);
  });
  await zu();

  await pruefe('Aufgabe bearbeiten (Ansicht über dem Brett)', async () => {
    await p.locator('.rail [data-tour="tasks"]').click();
    await p.waitForSelector('.panel');
    await p.waitForTimeout(600);
    if (!(await p.locator('.task-card').count())) {
      await p.locator('.panel__head .pill--accent').click();
      await p.waitForTimeout(400);
      await p.locator('.panel input.input').first().fill(`Prüfaufgabe ${Date.now().toString(36).slice(-4)}`);
      await p.locator('.panel__foot .btn--primary').last().click();
      await p.waitForTimeout(1000);
    }
    await p.locator('.task-card').first().click();
    await p.waitForTimeout(800);
    return misst(`${await p.locator('.panel').count()} Ebenen`);
  });
  await zu();

  await pruefe('Termin anlegen (über dem Kalender)', async () => {
    await p.locator('.rail [data-tour="calendar"]').click();
    await p.waitForSelector('.week', { timeout: 8000 });
    await p.locator('.panel__head .pill--accent').click();
    await p.waitForTimeout(700);
    return misst(`${await p.locator('.panel').count()} Ebenen`);
  });
  await zu();

  await pruefe('Idee einbringen (über dem Board)', async () => {
    await p.locator('.rail [data-tour="ideas"]').click();
    await p.waitForSelector('.idea-bar', { timeout: 8000 });
    await p.locator('.panel__head .pill--accent').click();
    await p.waitForTimeout(700);
    return misst(`${await p.locator('.panel').count()} Ebenen`);
  });
  await zu();

  /* ── Aus dem Chat heraus ───────────────────────────────────── */
  await pruefe('Schnellsuche', async () => {
    await p.keyboard.press('Meta+k');
    await p.waitForTimeout(700);
    return misst();
  });
  await zu();

  await pruefe('Volltextsuche', async () => {
    await p.keyboard.press('Meta+f');
    await p.waitForTimeout(700);
    return misst();
  });
  await zu();

  await pruefe('Neuer Kanal', async () => {
    await p.keyboard.press('Meta+Shift+n');
    await p.waitForTimeout(700);
    return misst();
  });
  await zu();

  /* Unter 880 px (auch Tablet hochkant) steckt die Kanalliste in der
     Schublade — für Prüfungen, die einen Kanal anfassen, erst öffnen. */
  const kanalListeOeffnen = async () => {
    if (!(await p.locator('.chan').first().isVisible())) {
      await p.locator('.header__menue').click();
      await p.waitForTimeout(400);
    }
  };

  await pruefe('Emoji-Auswahl', async () => {
    await kanalListeOeffnen();
    await p.locator('.chan').filter({ hasText: 'allgemein' }).first().click();
    await p.waitForTimeout(700);
    await p.locator('.composer__bar button').nth(1).click();
    await p.waitForTimeout(700);
    return misst();
  });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);

  await pruefe('Umfrage anlegen', async () => {
    await p.locator('.composer__bar button').nth(5).click();
    await p.waitForTimeout(800);
    return misst();
  });
  await zu();

  await pruefe('Kontextmenü am Kanal', async () => {
    await kanalListeOeffnen();
    await p.locator('.chan').filter({ hasText: 'allgemein' }).first().click({ button: 'right' });
    await p.waitForSelector('.kontextmenue', { timeout: 6000 });
    await p.waitForTimeout(400);
    return misst();
  });
  await zu();

  await pruefe('Kanaleinstellungen', async () => {
    await p.locator('.header__actions button').last().click();
    await p.waitForTimeout(800);
    return misst();
  });
  await zu();

  await pruefe('Profilkarte', async () => {
    await p.locator('.rail [data-tour="settings"]').click();
    await p.waitForTimeout(700);
    const r = await misst();
    await p.keyboard.press('Escape');
    return r;
  });
  await zu();

  await p.context().close();
}

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
