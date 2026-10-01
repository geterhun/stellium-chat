/**
 * Renderer des Benachrichtigungsfensters — Gegenstück zu electron/mac-notify.ts.
 *
 * Bewusst ohne React/Zustand: dieses Fenster zeigt nie mehr als vier kleine
 * Karten, läuft dauerhaft im Hintergrund und soll dafür so wenig wie möglich
 * Speicher und Startzeit kosten. Reines DOM/CSS reicht dafür völlig.
 *
 * Bewusst auch OHNE Zugriff auf state/store.ts oder i18n/index.ts — dieses
 * Fenster hat keine Anmeldung, keine WebSocket-Verbindung und keine eigene
 * Sprachwahl. Für Übersetzungen kommt darum nur i18n/kern.ts infrage: das
 * ist genau der Teil des Wörterbuchs, der ohne den Zustand auskommt (siehe
 * Kommentar dort). Die Sprache selbst reist mit jeder Karte mit — der
 * Hauptprozess kennt sie nicht, nur der App-Renderer kannte sie im Moment
 * des Auftretens (siehe src/lib/mac-benachrichtigung.ts).
 */
import { istVonRechts, translate } from '../i18n/kern.js';
import type { MacNotifyKarte } from './typen.js';
import '../styles/mac-notify.css';

/** MUSS zu KARTE_HOEHE/KARTE_ABSTAND in electron/mac-notify.ts passen. */
const KARTE_HOEHE = 76;
const KARTE_ABSTAND = 8;
/** Wie lange eine Karte ohne Zutun sichtbar bleibt. */
const DAUER_MS = 5000;

const STAPEL_EL = document.getElementById('stapel');
if (!STAPEL_EL) throw new Error('#stapel fehlt in mac-notify.html');

/* Statische, von dieser Datei selbst verfasste Symbole — keine fremden Daten
   darin, deshalb hier (und nur hier) unbedenklich als Markup statt als Text.
   Alles, was aus einem Chat stammt, geht weiter unten ausschließlich über
   `.textContent`. */
const SYMBOL_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true">'
  + '<path fill="#fff" d="M50 19.1 56.2 41.5 78.5 47.7 56.2 53.8 50 76.2 43.8 53.8 21.5 47.7 43.8 41.5Z"/>'
  + '</svg>';
const SCHLIESSEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" '
  + 'stroke-linecap="round" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg>';

interface KartenZustand {
  el: HTMLElement;
  titelEl: HTMLElement;
  textEl: HTMLElement;
  zeitEl: HTMLElement;
  schliessenEl: HTMLButtonElement;
  daten: MacNotifyKarte;
  timerHandle: number | null;
  timerStart: number;
  verbleibendMs: number;
  /** Zeigt die Maus gerade darauf? Bestimmt, ob eine aufgefrischte Karte
   *  (gleiche Gruppe, neu eingetroffen) den Zeitgeber sofort weiterlaufen
   *  lassen darf oder angehalten bleiben muss. */
  schwebt: boolean;
  verlassenAusgeloest: boolean;
  /** Während des Abgangs kam dieselbe Gruppe neu herein. Der Hauptprozess
   *  behält dabei die Kennung (siehe zeigeKarte() in electron/mac-notify.ts)
   *  — ein `verwerfen` nach der Animation würfe sonst die NEUE Meldung weg,
   *  bevor sie je zu sehen war. */
  nachfolger?: MacNotifyKarte;
}

const zustaende = new Map<string, KartenZustand>();
/** Anzeigereihenfolge, oben zuerst — ohne Karten, die schon auf dem Weg
 *  hinaus sind. Bestimmt, an welcher `top`-Position jede Karte steht. */
let reihenfolge: string[] = [];

/** Während eines Wischgestus, damit `pointerleave` den Zeitgeber währenddessen
 *  nicht fälschlich neu startet. */
let ziehZustand: { id: string; pointerId: number; startX: number; dx: number } | null = null;

function neuAnordnen(): void {
  reihenfolge.forEach((id, index) => {
    const z = zustaende.get(id);
    if (!z) return;
    z.el.style.top = `${index * (KARTE_HOEHE + KARTE_ABSTAND)}px`;
    // Neuere Karten optisch über älteren -- wichtig während des kurzen
    // Moments, in dem eine eintretende Karte noch über einer verschiebenden
    // liegt.
    z.el.style.zIndex = String(100 - index);
  });
}

function timerStarten(id: string): void {
  const z = zustaende.get(id);
  if (!z) return;
  z.timerStart = Date.now();
  z.timerHandle = window.setTimeout(() => verlasseKarte(id, 'zeit'), z.verbleibendMs);
}

/** Nur den laufenden Zeitgeber abbrechen, ohne verbleibendMs anzurühren --
 *  für einen echten Neustart (siehe stapelVerarbeiten, Gruppen-Ersatz).
 *  timerAnhalten() darunter würde hier falsch rechnen: es zieht die seit
 *  timerStart verstrichene Zeit von verbleibendMs ab, und das wäre die Zeit
 *  seit dem VORHERIGEN Lauf -- nicht das, was ein Reset will. */
function timerLoeschen(id: string): void {
  const z = zustaende.get(id);
  if (!z || z.timerHandle == null) return;
  window.clearTimeout(z.timerHandle);
  z.timerHandle = null;
}

/** Hovern: den laufenden Zeitgeber pausieren und die echte Restzeit merken. */
function timerAnhalten(id: string): void {
  const z = zustaende.get(id);
  if (!z || z.timerHandle == null) return;
  window.clearTimeout(z.timerHandle);
  z.timerHandle = null;
  z.verbleibendMs = Math.max(0, z.verbleibendMs - (Date.now() - z.timerStart));
}

function inhalteSetzen(karte: MacNotifyKarte): void {
  const z = zustaende.get(karte.id);
  if (!z) return;
  z.daten = karte;
  // Fremder Text aus einem Chat -- ausschließlich als Text, nie als Markup.
  z.titelEl.textContent = karte.titel;
  z.textEl.textContent = karte.text;
  z.zeitEl.textContent = translate(karte.sprache, 'macNotify.jetzt');
  const schliessenLabel = translate(karte.sprache, 'macNotify.schliessen');
  z.schliessenEl.setAttribute('aria-label', schliessenLabel);
  z.schliessenEl.title = schliessenLabel;
}

/**
 * Eine Karte verlässt den Stapel — ob abgelaufen, weggewischt, über das
 * Schließzeichen geschlossen, angeklickt oder von einer fünften Meldung
 * verdrängt. In jedem Fall erst die eigene Abgangsanimation, danach erst
 * der Umbau des DOM und die Nachricht an den Hauptprozess.
 */
function verlasseKarte(
  id: string,
  grund: 'zeit' | 'schliessen' | 'wisch' | 'klick' | 'ausgemustert',
): void {
  const z = zustaende.get(id);
  if (!z || z.verlassenAusgeloest) return;
  z.verlassenAusgeloest = true;
  timerAnhalten(id);
  reihenfolge = reihenfolge.filter((x) => x !== id);
  neuAnordnen();

  z.el.classList.remove('mn-karte--zieht');
  z.el.style.transform = '';
  z.el.style.opacity = '';
  z.el.classList.add(grund === 'wisch' ? 'mn-karte--wisch-raus' : 'mn-karte--raus');

  let erledigt = false;
  const fertig = () => {
    if (erledigt) return;
    erledigt = true;
    z.el.removeEventListener('transitionend', fertig);
    z.el.remove();
    zustaende.delete(id);
    if (z.nachfolger && grund !== 'klick') {
      karteErzeugen(z.nachfolger);
      neuAnordnen();
      return;
    }
    if (grund === 'klick') window.stelliumMacNotify?.klicken(id);
    // 'ausgemustert': der Hauptprozess weiß es schon (er hat sie selbst aus
    // dem Stapel geworfen) -- ein weiterer Aufruf wäre nur ein Leerlauf.
    else if (grund !== 'ausgemustert') window.stelliumMacNotify?.verwerfen(id);
  };
  z.el.addEventListener('transitionend', fertig);
  // Netz: greift, falls 'transitionend' ausbleibt (z. B. wenn die Karte nie
  // sichtbar wurde) -- sonst bliebe sie für immer im Speicher hängen.
  window.setTimeout(fertig, 420);
}

function wischeVerbinden(el: HTMLElement, id: string): void {
  el.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.mn-schliessen')) return;
    ziehZustand = { id, pointerId: e.pointerId, startX: e.clientX, dx: 0 };
    el.classList.add('mn-karte--zieht');
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!ziehZustand || ziehZustand.id !== id || e.pointerId !== ziehZustand.pointerId) return;
    // Nur nach rechts, wie am Vorbild ("Nach rechts wischen … sofort weg").
    const dx = Math.max(0, e.clientX - ziehZustand.startX);
    ziehZustand.dx = dx;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.15, 1 - dx / 320));
  });

  const loslassen = (e: PointerEvent) => {
    if (!ziehZustand || ziehZustand.id !== id || e.pointerId !== ziehZustand.pointerId) return;
    const { dx } = ziehZustand;
    el.classList.remove('mn-karte--zieht');
    ziehZustand = null;

    if (dx > 120) { verlasseKarte(id, 'wisch'); return; }
    el.style.transform = '';
    el.style.opacity = '';
    // Kaum Bewegung -> als Klick werten. Dazwischen (Finger bewegt, aber
    // keinen der beiden Fälle erreicht) -> zurückschnappen, sonst nichts:
    // die Übergangsregel dafür kommt automatisch zurück, sobald
    // mn-karte--zieht (siehe oben) wieder weg ist.
    if (dx < 6) verlasseKarte(id, 'klick');
  };
  el.addEventListener('pointerup', loslassen);
  el.addEventListener('pointercancel', loslassen);
}

function karteErzeugen(karte: MacNotifyKarte): void {
  const el = document.createElement('div');
  el.className = 'mn-karte mn-karte--eintritt';
  el.dataset.id = karte.id;

  const symbol = document.createElement('div');
  symbol.className = 'mn-symbol';
  symbol.innerHTML = SYMBOL_SVG; // statisch -- siehe Dateikopf
  const punkt = document.createElement('span');
  punkt.className = 'mn-punkt';
  symbol.appendChild(punkt);

  const inhalt = document.createElement('div');
  inhalt.className = 'mn-inhalt';
  const kopf = document.createElement('div');
  kopf.className = 'mn-kopf';
  const titelEl = document.createElement('span');
  titelEl.className = 'mn-titel';
  const zeitEl = document.createElement('span');
  zeitEl.className = 'mn-zeit';
  kopf.append(titelEl, zeitEl);
  const textEl = document.createElement('div');
  textEl.className = 'mn-text';
  inhalt.append(kopf, textEl);

  const schliessenEl = document.createElement('button');
  schliessenEl.type = 'button';
  schliessenEl.className = 'mn-schliessen';
  schliessenEl.innerHTML = SCHLIESSEN_SVG; // statisch -- siehe Dateikopf

  el.append(symbol, inhalt, schliessenEl);
  STAPEL_EL!.appendChild(el);

  zustaende.set(karte.id, {
    el, titelEl, textEl, zeitEl, schliessenEl, daten: karte,
    timerHandle: null, timerStart: 0, verbleibendMs: DAUER_MS,
    schwebt: false, verlassenAusgeloest: false,
  });
  inhalteSetzen(karte);

  schliessenEl.addEventListener('click', (e) => {
    e.stopPropagation();
    verlasseKarte(karte.id, 'schliessen');
  });
  el.addEventListener('pointerenter', () => {
    const z = zustaende.get(karte.id);
    if (z) z.schwebt = true;
    timerAnhalten(karte.id);
  });
  el.addEventListener('pointerleave', () => {
    const z = zustaende.get(karte.id);
    if (z) z.schwebt = false;
    if (!ziehZustand || ziehZustand.id !== karte.id) timerStarten(karte.id);
  });
  wischeVerbinden(el, karte.id);

  // Erst einbauen, dann -- zwei Bilder später -- die Startklasse wieder
  // entfernen. Im selben Bild gesetzt und entfernt, fasst der Browser Start-
  // und Zielzustand zusammen und es gibt keinen sichtbaren Übergang.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('mn-karte--eintritt')));

  timerStarten(karte.id);
}

/** Kommt vom Hauptprozess, neueste zuerst — die einzige Wahrheit über den
 *  aktuellen Stapel. Diese Funktion gleicht das DOM einmalig darauf ab. */
function stapelVerarbeiten(karten: MacNotifyKarte[]): void {
  const neueIds = new Set(karten.map((k) => k.id));

  // Aus dem Stapel gefallen, ohne dass wir selbst darum gebeten hätten --
  // heißt: die Obergrenze hat sie verdrängt. Leise ausblenden statt
  // ersatzlos verschwinden zu lassen.
  for (const [id, z] of zustaende) {
    if (!z.verlassenAusgeloest && !neueIds.has(id)) verlasseKarte(id, 'ausgemustert');
    if (!neueIds.has(id)) z.nachfolger = undefined;
  }

  reihenfolge = [];
  for (const karte of karten) {
    const vorhanden = zustaende.get(karte.id);
    if (vorhanden && !vorhanden.verlassenAusgeloest) {
      const ersetzt = vorhanden.daten.erstelltAm !== karte.erstelltAm;
      inhalteSetzen(karte);
      if (ersetzt) {
        // Dieselbe Gruppe kam erneut -- frische Frist. timerLoeschen(), nicht
        // timerAnhalten(): Anhalten würde die Restzeit aus der Spanne seit
        // dem VORHERIGEN Start berechnen und sie damit fast vollständig
        // aufbrauchen, statt sie wirklich auf null zu setzen.
        vorhanden.verbleibendMs = DAUER_MS;
        timerLoeschen(karte.id);
        // Läuft nur an, wenn gerade niemand liest; sonst bliebe "läuft die
        // Zeit nicht weiter" beim Hovern nur die halbe Wahrheit.
        if (!vorhanden.schwebt) timerStarten(karte.id);
      }
    } else if (!vorhanden) {
      karteErzeugen(karte);
    } else if (vorhanden.daten.erstelltAm !== karte.erstelltAm) {
      vorhanden.nachfolger = karte;
    }
    reihenfolge.push(karte.id);
  }
  neuAnordnen();
}

document.documentElement.dataset.theme = 'dark'; // Vorbelegung, siehe unten

window.stelliumMacNotify?.aufTheme((stand) => {
  document.documentElement.dataset.theme = stand.dunkel ? 'dark' : 'light';
});

window.stelliumMacNotify?.aufStapel((karten) => {
  if (karten[0]) document.documentElement.dir = istVonRechts(karten[0].sprache) ? 'rtl' : 'ltr';
  stapelVerarbeiten(karten);
  /* Erst nach einem tatsächlichen Bild bestätigen -- ein einzelnes
     requestAnimationFrame heißt nur "das nächste Bild ist eingeplant", das
     zweite bestätigt, dass es auch gezeichnet wurde. Der Hauptprozess zeigt
     das Fenster erst nach dieser Bestätigung (siehe electron/mac-notify.ts,
     versucheZuZeigen) -- sonst blieb es auf diesem Rechner leer. */
  requestAnimationFrame(() => requestAnimationFrame(() => window.stelliumMacNotify?.gemalt()));
});
