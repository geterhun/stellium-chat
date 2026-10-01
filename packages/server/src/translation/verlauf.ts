import { istE2EChiffrat } from '@stellium/shared';

/**
 * Gesprächsverlauf als Kontext für translate() — der eigentliche Auftrag
 * hinter dieser Datei.
 *
 * DER FEHLER, DEN DAS BEHEBT
 *
 * Gemeldet vom Auftraggeber: "mache ich kein problem" (Antwort auf eine
 * Bitte) kam als "I'm not making a problem" an. Gemeint war eine Zusage
 * ("Will do, no problem."). Ohne Komma liest sich der Satz tatsächlich
 * doppelt — mit der vorherigen Nachricht ("kannst du das machen?") ist er
 * eindeutig. Reproduziert an qwen3-8b, deterministisch bei temperature 0:
 * OHNE jeden Verlauf immer "I'm not making a problem", MIT der vorherigen
 * Nachricht als Kontext eine erkennbare Zusage statt einer Verneinung.
 *
 * Vor dieser Änderung erreichte translateMessage() (siehe index.ts) das
 * Modell mit `context` = channelContext() aus ws/gateway.ts — Kanalname,
 * Thema, Zweck. Nie eine vorherige Nachricht. Der Übersetzer sah also nie
 * das Gespräch, in dem eine Nachricht steht — nur, in welchem Kanal.
 *
 * WARUM EINE EIGENE DATEI
 *
 * Reine Formatierung, ohne Datenbankzugriff — genau wie echo.ts. Das macht
 * die Funktion unten aus scripts/uebersetzung-messen.mjs heraus direkt
 * aufrufbar, mit erfundenen Verlaufszeilen statt echten Datenbankzeilen: die
 * Messung prüft dieselbe Formatierung, die im Betrieb hinausgeht, ohne einen
 * Kanal in der Datenbank anzulegen. Das Nachladen der ECHTEN Zeilen (mit
 * Entschlüsselung und der vertraulich-Prüfung am Inhalt) bleibt in index.ts,
 * das ohnehin schon jede Datenbank- und Entschlüsselungsarbeit dieses Moduls
 * erledigt — hier wird nur noch mit bereits entschlüsseltem Klartext
 * gearbeitet.
 *
 * ZWEITE PRÜFUNG GEGEN CHIFFRAT
 *
 * index.ts liest nie aus einem vertraulichen Kanal vor (siehe dortiger
 * Aufrufer) — das hier ist Rückhalt, kein Ersatz, genau wie bei
 * services/ai.ts (zeile()): eine Zeile, die trotzdem wie E2E-Chiffrat
 * aussieht, fliegt hier ein zweites Mal raus, statt als Base64 beim
 * Sprachmodell zu landen.
 */

export interface VerlaufZeile {
  /** Anzeigename der schreibenden Person — leer ist erlaubt, dann ohne Namen. */
  wer: string;
  /** Bereits entschlüsselter Klartext. */
  text: string;
}

/* Kappung, nicht Verdichtung — anders als bei den Antwortvorschlägen
   (services/ai.ts, smartReplies) gibt es hier keine Fensterrechnung
   (translation/fenster.ts) unter der Übersetzung: eine zu lange Anfrage
   endet direkt als Fehler ("Anfrage größer als das Kontextfenster",
   providers/types.ts). Ein einzelner hineinkopierter Fehlerbericht in einer
   der letzten Nachrichten darf darum nicht die eigentliche Übersetzung zu
   Fall bringen — er wird gekürzt, nicht die ganze Anfrage verworfen. Werte
   klein gehalten: Kontext soll orientieren, nicht das Gespräch nacherzählen,
   und jedes zusätzliche Zeichen kostet Marken auf einem Modell mit 8k
   Kontextfenster (gemessen am Pi, siehe Auftrag). */
const ZEICHEN_JE_ZEILE = 160;
const ZEICHEN_GESAMT = 700;

/**
 * Verlaufszeilen zu einem Kontext-Absatz zusammensetzen, wie ihn
 * uebersetzungsRegeln() (prompt.ts) unter `req.context` erwartet — oder
 * `null`, wenn nichts Brauchbares übrig bleibt.
 *
 * Reihenfolge: älteste zuerst, wie ein Mitlesender das Gespräch sähe. Der
 * Aufrufer liefert sie schon so sortiert (index.ts: ORDER BY created_at DESC
 * … .reverse()) — hier wird nicht neu sortiert, nur formatiert.
 */
export function verlaufAlsKontext(zeilen: VerlaufZeile[]): string | null {
  const gebaut: string[] = [];
  let laenge = 0;
  /* Von hinten gefüllt: reicht das Gesamtmaß nicht für alle Zeilen, fällt
     die älteste weg und nicht die unmittelbar vorangehende — gerade die
     entscheidet, ob eine kurze Antwort Zusage oder Absage ist. */
  for (let i = zeilen.length - 1; i >= 0; i -= 1) {
    const z = zeilen[i];
    const text = z.text.replace(/\s+/g, ' ').trim();
    if (!text || istE2EChiffrat(text)) continue;
    const gekuerzterText = text.length > ZEICHEN_JE_ZEILE ? `${text.slice(0, ZEICHEN_JE_ZEILE)}…` : text;
    const zeile = z.wer ? `${z.wer}: ${gekuerzterText}` : gekuerzterText;
    if (laenge + zeile.length + 1 > ZEICHEN_GESAMT) break;
    gebaut.unshift(zeile);
    laenge += zeile.length + 1;
  }
  if (!gebaut.length) return null;
  return `Vorherige Nachrichten in diesem Gespräch (nur zur Orientierung, nicht übersetzen):\n${gebaut.join('\n')}`;
}

/**
 * Kanal-Metadaten (channelContext() aus ws/gateway.ts, bloß Name/Thema/
 * Zweck) und echten Gesprächsverlauf zu EINEM `context`-Wert zusammenlegen.
 *
 * Beides bleibt erhalten: ws/gateway.ts ist für die Kanal-Metadaten-Zeile
 * gerade gesperrt (siehe Auftrag), also wird hier ergänzt statt ersetzt —
 * der Aufrufer verliert dadurch kein bestehendes Signal.
 */
export function kontextZusammenfuehren(kanalKontext: string | null | undefined, verlauf: string | null): string | null {
  const teile = [kanalKontext?.trim(), verlauf?.trim()].filter((t): t is string => Boolean(t));
  return teile.length ? teile.join('\n') : null;
}
