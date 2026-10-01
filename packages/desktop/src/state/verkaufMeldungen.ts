import { create } from 'zustand';
import { useStore } from './store.js';
import { t as tStatisch, type TranslationKey } from '../i18n/index.js';
import { ApiError, serverUrl, token } from '../net/api.js';
import { geld } from '../lib/format.js';

/**
 * "Ein Kauf ist passiert" — offen/geschlossen UND der Inhalt, anders als bei
 * state/paypal.ts (dort nur `offen`, siehe Kopf dort).
 *
 * EIGENER, WINZIGER LADEN STATT state/store.ts, DIESELBE BEGRÜNDUNG WIE BEI
 * state/paypal.ts/partnergruppen.ts/vorschlaege.ts: store.ts wird gerade an
 * anderer Stelle bearbeitet, und Rail.tsx (öffnet die Tafel, zeigt das
 * Abzeichen) sowie components/VerkaufMeldungen.tsx (zeigt den Inhalt) müssen
 * sich irgendwo treffen, ohne beide denselben, gerade gesperrten Baustein
 * anfassen zu müssen.
 *
 * WARUM DIESER LADEN AUCH DEN INHALT HÄLT (nicht nur `offen` wie bei Paypal)
 * Ein Kontostand (Paypal) muss niemandem aufploppen — dort genügt "beim
 * Öffnen einmal nachfragen". Eine VerkaufsMELDUNG soll aber genau das:
 * melden, auch während die Tafel geschlossen ist. Ohne einen Laden, der
 * unabhängig von der Tafel lebt, gäbe es dafür keinen Ort — Rail.tsx ist
 * dauerhaft eingehängt (nie unmounted, solange die App läuft), die Tafel
 * selbst nur, solange sie offen ist.
 *
 * WARUM ABFRAGE STATT WEBSOCKET/PUSH
 * ws/gateway.ts und services/push.ts werden gerade von einer anderen Stelle
 * umgebaut (Push-Weg) — dieser Laden fragt darum selbständig beim eigenen,
 * längst vorhandenen Server nach (GET /api/verkauf/meldungen), in einem
 * eigenen Takt. Das ist bewusst NICHT dasselbe wie "in Echtzeit": zwischen
 * einem echten Verkauf und der Anzeige hier liegt bis zu VERKAUF_TAKT_MS,
 * plus die bis zu fünfzehn Minuten, die gumroad.ts/patreon.ts selbst
 * zwischen zwei Abrufen bei der fremden Schnittstelle warten (siehe dort).
 * Ein Push zum Sperrbildschirm braucht das Gateway — server/services/
 * verkaufBenachrichtigung.ts hat dafür schon eine Einhängestelle
 * (`melderSetzen`, dieselbe Bauart wie bei post-sichtung.ts), nur eben noch
 * nicht angeschlossen; siehe Bericht am Auftragsende.
 *
 * WARUM DER ERSTE ABRUF NIE EINEN TOAST AUSLÖST
 * Beim allerersten Abruf in einer neuen Sitzung (App gerade geöffnet) ist
 * JEDE Zeile "neu" im Sinne von "kennt dieser Laden noch nicht" — ohne diese
 * Ausnahme würde jedes Öffnen der App einen ganzen Rückstand an Toasts
 * abfeuern, auch für Verkäufe von vor Tagen. Der erste Abruf füllt darum nur
 * `bekannteIds`, ganz ohne Toast — die Liste selbst zeigt den Rückstand
 * trotzdem vollständig, sobald die Tafel geöffnet wird. Erst ein
 * NACHFOLGENDER Abruf, der eine Kennung sieht, die beim vorigen Mal noch
 * nicht dabei war, gilt als "gerade eben passiert".
 */
const VERKAUF_TAKT_MS = 3 * 60_000;
const SEITENGROESSE_ABZEICHEN = 20;

export interface VerkaufMeldung {
  id: string;
  anbieter: 'gumroad' | 'patreon';
  art: 'einmalig' | 'neu' | 'verlaengerung';
  produktName: string | null;
  betragCent: number | null;
  waehrung: string | null;
  inProbe: boolean | null;
  erkanntAm: number;
}

interface VerkaufMeldungenState {
  offen: boolean;
  oeffnen: () => void;
  schliessen: () => void;
  /** Die zuletzt abgefragten Zeilen — für das Abzeichen im Stern-Menü. Die
   *  volle, blätterbare Liste holt sich components/VerkaufMeldungen.tsx beim
   *  Öffnen selbst, unabhängig davon (dieselbe Aufteilung wie bei den
   *  anderen Reitern: der Laden hier ist nur "was zeigt das Abzeichen",
   *  nicht "der ganze Bestand"). */
  juengste: VerkaufMeldung[];
  gestartet: boolean;
  starten: () => void;
  /** Für den Wechsel des Kontos auf demselben Fenster (state/store.ts,
   *  `logout`) — anders als `schliessen()` klappt das hier nicht nur die
   *  Tafel zu, sondern wirft auch den Takt und die zwischengespeicherten
   *  Zeilen weg, die sonst der nächsten Person gehörten. */
  zuruecksetzen: () => void;
}

/* ── Abruf — eigener, kleiner Ersatz für request() aus net/api.ts ────
   Dieselbe Begründung wie in PostMeldungen.tsx/PaypalPanel.tsx: net/api.ts
   wird an anderer Stelle bearbeitet. */
async function verkaufFetch<T>(pfad: string): Promise<T> {
  const headers = new Headers();
  const nachweis = token();
  if (nachweis) headers.set('authorization', `Bearer ${nachweis}`);
  let antwort: Response;
  try {
    antwort = await fetch(`${serverUrl()}${pfad}`, { headers });
  } catch {
    throw new ApiError(tStatisch('api.serverUnreachable', { adresse: serverUrl() }), 0);
  }
  if (!antwort.ok) {
    let message = tStatisch('api.error', { status: antwort.status });
    try {
      const rumpf = await antwort.json() as { error?: string; code?: string };
      message = rumpf.error ?? message;
      if (rumpf.code) {
        const uebersetzt = tStatisch(rumpf.code as TranslationKey);
        if (uebersetzt && uebersetzt !== rumpf.code) message = uebersetzt;
      }
    } catch { /* keine JSON-Antwort */ }
    throw new ApiError(message, antwort.status);
  }
  return antwort.status === 204 ? (undefined as T) : ((await antwort.json()) as T);
}

/** Eine Zeile in EINE Zeile Text — dieselbe Zusammensetzung für die Karte in
 *  der Tafel und für den Toast, siehe components/VerkaufMeldungen.tsx. */
export function verkaufMeldungZeile(m: VerkaufMeldung): string {
  const art = tStatisch(`verkaufMeldung.art.${m.art}` as TranslationKey);
  const betrag = m.betragCent !== null && m.waehrung
    ? geld(m.betragCent, m.waehrung)
    : tStatisch('verkaufMeldung.ohneBetrag' as TranslationKey);
  const teile = [art, betrag];
  if (m.inProbe) teile.push(tStatisch('verkaufMeldung.inProbeKurz' as TranslationKey));
  return teile.join(' · ');
}

function meldungsName(m: VerkaufMeldung): string {
  return m.produktName ?? tStatisch(`verkaufMeldung.anbieter.${m.anbieter}` as TranslationKey);
}

let bekannteIds = new Set<string>();
let ersterAbruf = true;
let takt: number | null = null;
/* Zählt jedes Zurücksetzen mit. Ein Abruf, der vor der Abmeldung losging und
   erst danach zurückkommt, trüge sonst die Zeilen des vorigen Kontos in den
   frisch geleerten Laden — samt Abzeichen für die nächste Person. */
let generation = 0;

export const useVerkaufMeldungenUi = create<VerkaufMeldungenState>((set, get) => ({
  offen: false,
  oeffnen: () => set({ offen: true }),
  schliessen: () => set({ offen: false }),
  juengste: [],
  gestartet: false,

  /**
   * Einmal aus Rail.tsx aufgerufen (dauerhaft eingehängt, siehe Dateikopf) —
   * `gestartet` verhindert einen zweiten Takt, falls Rail aus irgendeinem
   * Grund neu rendert.
   */
  starten: () => {
    if (get().gestartet) return;
    set({ gestartet: true });

    const abrufen = async () => {
      const meine = generation;
      let seite: VerkaufMeldung[];
      try {
        const antwort = await verkaufFetch<{ meldungen: VerkaufMeldung[] }>(
          `/api/verkauf/meldungen?anzahl=${SEITENGROESSE_ABZEICHEN}`,
        );
        if (meine !== generation) return;
        seite = antwort.meldungen;
      } catch {
        // Kein Recht, kein Netz, Server gerade nicht erreichbar — dieselbe
        // Zurückhaltung wie beim Sync selbst (siehe gumroadSyncLauf): ein
        // Fehlschlag hier bleibt still und versucht es beim nächsten Takt
        // wieder, statt die App mit einem Fehlertoast zu stören.
        return;
      }
      set({ juengste: seite });

      if (ersterAbruf) {
        // Siehe Dateikopf, "WARUM DER ERSTE ABRUF NIE EINEN TOAST AUSLÖST".
        bekannteIds = new Set(seite.map((m) => m.id));
        ersterAbruf = false;
        return;
      }

      const neu = seite.filter((m) => !bekannteIds.has(m.id));
      for (const m of seite) bekannteIds.add(m.id);
      if (!neu.length) return;

      if (neu.length === 1) {
        const m = neu[0];
        useStore.getState().toast({
          kind: 'info',
          title: tStatisch('verkaufMeldung.toastTitelEinzeln' as TranslationKey, { name: meldungsName(m) }),
          body: verkaufMeldungZeile(m),
        });
      } else {
        const gesamtCent = neu.reduce((summe, m) => summe + (m.betragCent ?? 0), 0);
        /* Eine Summe nur bei EINER Währung: 10 € und 10 $ ergaben vorher
           „20 €". Gemischt bleibt es bei der Anzahl im Titel. */
        const waehrungen = new Set(neu.map((m) => m.waehrung).filter(Boolean));
        const waehrung = waehrungen.size === 1 ? [...waehrungen][0] : null;
        useStore.getState().toast({
          kind: 'info',
          title: tStatisch('verkaufMeldung.toastTitelSammel' as TranslationKey, { anzahl: neu.length }),
          body: waehrung
            ? tStatisch('verkaufMeldung.toastKoerperSammel' as TranslationKey, { betrag: geld(gesamtCent, waehrung) })
            : undefined,
        });
      }
    };

    void abrufen();
    takt = window.setInterval(() => void abrufen(), VERKAUF_TAKT_MS);
  },

  zuruecksetzen: () => {
    generation += 1;
    verkaufMeldungenTaktAnhalten();
    bekannteIds = new Set();
    ersterAbruf = true;
    set({ offen: false, juengste: [], gestartet: false });
  },
}));

/** Nur für e2e-Aufräumarbeiten/Hot-Reload während der Entwicklung — der Takt
 *  aus `starten()` überlebt sonst einen Modul-Neuladen als Geisterintervall. */
export function verkaufMeldungenTaktAnhalten(): void {
  if (takt !== null) { window.clearInterval(takt); takt = null; }
}
