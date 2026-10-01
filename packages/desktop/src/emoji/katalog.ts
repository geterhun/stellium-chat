import { useEffect, useState } from 'react';
import type { EmojiKatalog } from './typen.js';

/**
 * Der Emoji-Namensbestand — geladen, nicht mitgeschleppt.
 *
 * Woher: scripts/emoji-katalog-erzeugen.mjs aus emojibase-data (MIT, CLDR-
 * Grundlage), siehe Kopfkommentar dort. Was hier liegt, ist schon das fertige
 * Ergebnis — winzige, feste Dateien unter daten/*.ts, eine je Sprache.
 *
 * NACHLADEN STATT MITSCHLEPPEN
 *
 * `import.meta.glob` lässt Vite für jede Datei unter daten/ einen eigenen,
 * erst bei Bedarf geladenen Programmteil bauen. Beim Programmstart wandert
 * dadurch KEINE der 18 Sprachdateien ins Hauptpaket — erst wenn `katalogLaden`
 * für eine bestimmte Sprache aufgerufen wird (EmojiPicker öffnen, erste
 * Nachricht einer neuen Sprache im Kanal), kommt genau diese eine Datei
 * hinzu. Ein Wechsel der Oberflächensprache lädt nie mehr als die eine neue
 * Sprache nach; alle bisher geladenen bleiben im Speicher (geladen-Map unten)
 * und müssen nicht erneut geholt werden.
 *
 * RÜCKFALL AUF ENGLISCH
 *
 * emojibase-data deckt 18 der 22 Oberflächensprachen ab (fehlend: Tschechisch,
 * Rumänisch, Türkisch, Arabisch — siehe Erzeuger-Skript). Für die fehlenden
 * vier lädt katalogLaden() unten transparent Englisch statt einer nicht
 * vorhandenen Datei — sonst fände die Suche dort gar nichts mehr, eine
 * Verschlechterung gegenüber dem heutigen (ohnehin schon wirkungslosen)
 * Suchfeld.
 */

const MODULE = import.meta.glob('./daten/*.ts') as Record<string, () => Promise<{ default: EmojiKatalog }>>;

/** "./daten/de.ts" -> "de" */
function ausPfad(pfad: string): string {
  return pfad.replace('./daten/', '').replace(/\.ts$/, '');
}

/** Sprachen, für die tatsächlich eine erzeugte Datei existiert. */
export const SPRACHEN_MIT_KATALOG: ReadonlySet<string> = new Set(Object.keys(MODULE).map(ausPfad));

/** Echte Sprache, mit der geladen/nachgeschlagen wird — Rückfall auf Englisch. */
function aufgeloest(sprache: string): string {
  const kurz = (sprache || '').toLowerCase().split(/[-_]/)[0];
  return SPRACHEN_MIT_KATALOG.has(kurz) ? kurz : 'en';
}

const geladen = new Map<string, EmojiKatalog>();
const amLaufen = new Map<string, Promise<EmojiKatalog>>();

/** Bestand für eine Sprache laden (mit Rückfall auf Englisch) — asynchron, gecacht. */
export function katalogLaden(sprache: string): Promise<EmojiKatalog> {
  const echt = aufgeloest(sprache);
  const vorhanden = geladen.get(echt);
  if (vorhanden) return Promise.resolve(vorhanden);

  let laufend = amLaufen.get(echt);
  if (!laufend) {
    const lader = MODULE[`./daten/${echt}.ts`];
    laufend = (lader ? lader() : Promise.resolve({ default: {} as EmojiKatalog })).then((m) => {
      geladen.set(echt, m.default);
      amLaufen.delete(echt);
      return m.default;
    }, (fehler: unknown) => {
      /* Auch den Fehlschlag austragen: sonst bekäme jeder spätere Aufruf
         dieselbe abgelehnte Zusage zurück — ein einmal nicht ladbarer
         Abschnitt (Netz weg, nach einem Update umbenannt) bliebe bis zum
         Neuladen der Seite verloren, statt beim nächsten Öffnen neu
         versucht zu werden. */
      amLaufen.delete(echt);
      throw fehler;
    });
    amLaufen.set(echt, laufend);
  }
  return laufend;
}

/** Schon im Speicher? Für den ersten Zeichenaufbau, ohne auf eine Zusage zu warten. */
export function katalogWennGeladen(sprache: string): EmojiKatalog | null {
  return geladen.get(aufgeloest(sprache)) ?? null;
}

/**
 * Bestand einer Sprache in einer Komponente — lädt beim ersten Gebrauch nach
 * und rendert erneut, sobald er da ist. Von EmojiPicker.tsx und
 * MessageItem.tsx gemeinsam genutzt, damit die Ladelogik nicht zweimal
 * geschrieben steht.
 */
export function useEmojiKatalog(sprache: string): EmojiKatalog | null {
  const [katalog, setKatalog] = useState<EmojiKatalog | null>(() => katalogWennGeladen(sprache));
  useEffect(() => {
    let lebt = true;
    void katalogLaden(sprache)
      .then((k) => { if (lebt) setKatalog(k); })
      /* Ohne Namen bleibt nur die Suche nach Namen aus — die Zeichen selbst
         stehen trotzdem da. Kein Grund für eine unbehandelte Ablehnung. */
      .catch(() => {});
    return () => { lebt = false; };
  }, [sprache]);
  return katalog;
}

/* ── Abgleich ohne genaue Schreibweise ───────────────────────── */

/**
 * Groß-/Kleinschreibung, Umlaute/Akzente und "ß"/"ss" einebnen.
 *
 * "ß" wird eigens auf "ss" abgebildet, weil NFD-Zerlegung es NICHT anfasst
 * (anders als "ü" -> "u" + Kombinationszeichen): ohne diese Zeile fände wer
 * "grussen" tippt "grüßen" nicht, weil daraus nur "grußen" (mit ß) würde.
 */
export function normalizeSuche(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

interface VorbereiteterEintrag {
  char: string;
  /** Name + Stichwörter ohne Leerzeichen, normalisiert — für Wortabgleich. */
  einzelworte: string[];
  /** Name + Stichwörter MIT Leerzeichen, normalisiert — als Wortfolge gesucht. */
  phrasen: string[];
}

/**
 * Ein Bestand wird nur einmal vorbereitet (nicht bei jedem Tastendruck neu
 * normalisiert) — Schlüssel ist das Katalog-Objekt selbst, von dem
 * katalogLaden() für dieselbe Sprache immer dieselbe Instanz zurückgibt.
 */
const vorbereitetCache = new Map<EmojiKatalog, VorbereiteterEintrag[]>();

function vorbereiten(katalog: EmojiKatalog): VorbereiteterEintrag[] {
  let liste = vorbereitetCache.get(katalog);
  if (liste) return liste;
  liste = Object.entries(katalog).map(([char, eintrag]) => {
    const alle = [eintrag.name, ...eintrag.keywords].map(normalizeSuche).filter(Boolean);
    return {
      char,
      einzelworte: alle.filter((w) => !w.includes(' ')),
      phrasen: alle.filter((w) => w.includes(' ')),
    };
  });
  vorbereitetCache.set(katalog, liste);
  return liste;
}

/**
 * EmojiPicker-Suche: alle Zeichen, deren Name oder Stichwort die Anfrage
 * enthält — auch als Teilstück, nicht nur als exakter Treffer. Leere Anfrage
 * liefert den ganzen Bestand (unverändertes Bild wie ohne Eingabe).
 */
export function emojiSuchen(katalog: EmojiKatalog, anfrage: string): Set<string> {
  const q = normalizeSuche(anfrage);
  if (!q) return new Set(Object.keys(katalog));
  const treffer = new Set<string>();
  for (const eintrag of vorbereiten(katalog)) {
    if (eintrag.einzelworte.some((w) => w.includes(q)) || eintrag.phrasen.some((p) => p.includes(q))) {
      treffer.add(eintrag.char);
    }
  }
  return treffer;
}

/* ── Örtliche Reaktionsvorschläge aus einem Nachrichtentext ────── */

/** Wortliste wie packages/shared/src/languages.ts (woerterVon) — dieselbe Bauart, eigener Zweck. */
function woerterVon(text: string): string[] {
  return normalizeSuche(text)
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export interface EmojiVorschlag {
  char: string;
  punkte: number;
}

/**
 * Bis zu `anzahl` Emoji, deren Name oder Stichwörter im Text vorkommen — ganz
 * ohne Netz und ohne Modell (siehe state/emoji-vorschlaege.ts für den seltenen
 * Rückfall aufs Modell).
 *
 * PUNKTE
 *
 * +2 für ein exaktes Wort (jede Länge — "ok" zählt als eigenes Wort, aber nur
 * wenn es im Text auch wirklich als eigenes Wort steht) oder eine gefundene
 * Mehrwortphrase ("rotes herz" als zusammenhängender Abschnitt).
 * +1 für einen Teiltreffer: das Stichwort steckt irgendwo in einem Wort des
 * Texts (ab fünf Zeichen) — fängt einfache Beugungen wie "Frage" in "Fragen"
 * UND deutsche Komposita wie "party" in "Firmenparty".
 *
 * Bewusst nur EINE Richtung (Wort enthält Stichwort, nicht umgekehrt) und
 * bewusst fünf statt drei Zeichen als Schwelle: die erste Fassung prüfte
 * auch die Gegenrichtung ab drei Zeichen und fing sich damit handfeste
 * Fehltreffer ein — "con" (spanisch "mit") passte als Vorsilbe von "confeti"
 * genauso wie "all" als Vorsilbe von "alles" ("all" ist im Deutschen ein
 * eigenes Stichwort für 🚀, kurz für "das All"). Kurze Wörter sind in jeder
 * Sprache häufig und fast nie das Stichwort, das sie zufällig anschneiden.
 * Fünf Zeichen sind knapp genug, um "party"/"Frage" weiter zu fangen, aber zu
 * lang für die meisten Alltagswörter, die zufällig einen Anfang teilen.
 *
 * WAS HIER BEWUSST NICHT GEFILTERT WIRD
 *
 * Der exakte Treffer (+2) hat keine Längenschwelle — "ok"/"top"/"gut" sollen
 * zählen. Das öffnet eine andere, seltenere Lücke: der zugrunde liegende
 * Bestand (emojibase-data, aus CLDR) führt für manche Emoji auch sehr kurze,
 * für sich genommen kaum aussagekräftige Stichwörter (z.B. steht im
 * russischen Bestand von 😭 unter anderem das bloße Wort "за" — eine
 * Verhältniswortpartikel, vermutlich ein Fragment aus einer längeren
 * CLDR-Beschreibung). Ein Filter dagegen bräuchte eine Stoppwortliste je
 * Sprache, die sich seriös nur mit Sprachkenntnis prüfen lässt — für die 18
 * erzeugten Sprachen war das im Rahmen dieser Änderung nicht zu leisten.
 * Ergebnis: sehr selten taucht ein Emoji wegen eines solchen Fragments in den
 * Vorschlägen auf, ohne dass ein Mensch das beim Lesen der Rohdaten sofort
 * sähe. Es entsteht dadurch nie ein FALSCHER Vorschlag, nur gelegentlich ein
 * schwacher zusätzlicher neben einem richtigen.
 *
 * Absichtlich keine feste Mindestpunktzahl: die aufrufende Stelle entscheidet,
 * ob sie auch ein einzelnes, schwaches Ergebnis noch zeigt oder lieber auf
 * die feste Schnellauswahl zurückfällt (siehe MessageItem.tsx).
 *
 * SCHWÄCHER BEI JAPANISCH UND CHINESISCH
 *
 * `woerterVon()` zerlegt an allem, was kein Buchstabe/keine Ziffer ist —
 * bei Sprachen mit Leerzeichen zwischen Wörtern (fast alle 18 erzeugten)
 * entstehen so echte Wortgrenzen. Japanisch und Chinesisch trennen Wörter
 * aber nicht durch Leerzeichen; ein ganzer Satz wird hier zu einem einzigen
 * "Wort", in dem ein kurzes Stichwort nur noch über die Mehrwortphrasen-
 * Prüfung (`normText.includes`) auftauchen kann, nicht über den genauen
 * Wortabgleich. Gemessen (siehe Bericht): eine japanische Dankesnachricht
 * fand örtlich nichts — dort greift dann folgerichtig der KI-Rückfall, wenn
 * jemand ihn anfordert. Kein falscher Vorschlag, nur ein fehlender.
 */
export function emojiVorschlaege(text: string, katalog: EmojiKatalog, anzahl = 3): EmojiVorschlag[] {
  const normText = normalizeSuche(text);
  const worte = new Set(woerterVon(text));
  if (worte.size === 0) return [];

  const ergebnisse: EmojiVorschlag[] = [];
  for (const eintrag of vorbereiten(katalog)) {
    let summe = 0;

    for (const phrase of eintrag.phrasen) {
      if (normText.includes(phrase)) summe += 2;
    }

    for (const stichwort of eintrag.einzelworte) {
      if (worte.has(stichwort)) { summe += 2; continue; }
      if (stichwort.length < 5) continue;
      for (const wort of worte) {
        if (wort.includes(stichwort)) {
          summe += 1;
          break;
        }
      }
    }

    if (summe > 0) ergebnisse.push({ char: eintrag.char, punkte: summe });
  }

  return ergebnisse.sort((a, b) => b.punkte - a.punkte).slice(0, anzahl);
}
