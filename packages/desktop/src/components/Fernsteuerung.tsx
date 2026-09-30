/**
 * Der Pi-Schreibtisch im Fenster.
 *
 * Dekodiert wird mit `VideoDecoder` aus den WebCodecs. Auf einem Mac läuft
 * das über VideoToolbox — also in Hardware, mit fast keiner Prozessorlast.
 * Das ist der Grund, warum hier H.264 ankommt und keine fertigen Bildpunkte:
 * ein Bild in 1280x720 wäre als RGBA 3,7 MB, als H.264 sind es ein paar
 * Kilobyte.
 *
 * `optimizeForLatency` sagt dem Dekodierer, dass er jedes Bild sofort
 * herausgeben soll, statt erst ein paar zu sammeln. Ohne das kämen die
 * Bilder in Schüben, und genau das fühlt sich hakelig an — auch wenn am Ende
 * dieselbe Zahl Bilder ankommt.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { AlertTriangle, ExternalLink, Keyboard, Loader2, Monitor, Power, Users } from 'lucide-react';
import { Shell } from './Panels.jsx';
import { api } from '../net/api.js';
import { useStore } from '../state/store.js';
import { t } from '../i18n';
import '../styles/fernsteuerung.css';

/* Linux kennt Tasten als evdev-Nummern, der Browser als Namen. Diese
   Zuordnung ist der Übersetzer dazwischen. */
const TASTEN: Record<string, number> = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7,
  Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11, Minus: 12, Equal: 13,
  Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22,
  KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28,
  ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36,
  KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55,
  AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67,
  F10: 68, NumLock: 69, ScrollLock: 70, F11: 87, F12: 88,
  ControlRight: 97, NumpadDivide: 98, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
  End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  /* Die Befehlstaste des Macs wird zu Strg. Auf einem Linux-Schreibtisch
     liegt dort alles, was man auf dem Mac mit ⌘ macht — Kopieren, Einfügen,
     Suchen. Auf Super abzubilden wäre wörtlicher, aber im Alltag falsch. */
  MetaLeft: 29, MetaRight: 97,
};

const KNOPF: Record<number, number> = { 0: 272, 1: 274, 2: 273 };  /* links, mitte, rechts */

type Lage = 'getrennt' | 'verbindet' | 'meldet an' | 'offen' | 'fehler';

export function Fernsteuerung(
  { onClose, eigenstaendig = false }: { onClose: () => void; eigenstaendig?: boolean },
) {
  const leinwand = useRef<HTMLCanvasElement>(null);
  const dekoder = useRef<VideoDecoder | null>(null);
  const zeitmarke = useRef(0);
  const wartetSchluesselbild = useRef(true);
  const feldRef = useRef<HTMLDivElement>(null);

  const [lage, setLage] = useState<Lage>('getrennt');
  const [fehler, setFehler] = useState('');
  /* Adresse und Passwort stehen NICHT hier. Sie liegen verschlüsselt auf dem
     Server und werden erst im Augenblick des Verbindens geholt — siehe
     `verbinden()`. Damit gibt es kein Feld, aus dem jemand sie ablesen, und
     keinen Zustand, aus dem sie versehentlich in ein Protokoll geraten
     könnten. */
  const [stand, setStand] = useState<{ hinterlegt: boolean; kennung: string | null; darf: boolean } | null>(null);
  /*
   * Die Lagemeldung des Pi, alle zwei Sekunden. `zuschauer`, `steuert` und
   * `steuerungBei` kommen von einem Pi mit neuem Dienst; bei einem älteren
   * fehlen sie einfach, und dann bleibt alles wie vorher — deshalb überall
   * `?` und nirgends ein Vorgabewert, der eine Behauptung wäre.
   */
  const [info, setInfo] = useState<{
    takt?: string; verworfen?: number;
    zuschauer?: number; steuert?: boolean; steuerungBei?: string | null;
  } | null>(null);
  const [steuert, setSteuert] = useState(false);

  const fern = (window as any).stellium?.fern;

  /* ── Dekodieren ────────────────────────────────────────────── */

  /* Der Zeichenkontext wird einmal geholt und behalten. `getContext` ist
     zwar billig — es gibt denselben Kontext zurück —, aber bei 45 Bildern in
     der Sekunde ist "billig mal 45" trotzdem Arbeit, die niemand braucht.
     Ein Wechsel der Leinwand macht ihn ungültig, deshalb wird sie mitgeführt. */
  const malFlaeche = useRef<{ leinwand: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null);
  /* Das jüngste dekodierte Bild, das noch nicht auf dem Schirm ist. */
  const naechstes = useRef<VideoFrame | null>(null);

  /* Zeichnen im Takt des Bildschirms. Läuft, solange die Komponente lebt —
     ohne Bild kostet ein Durchgang nichts. */
  useEffect(() => {
    let laeuft = true;
    let anfrage = 0;
    const malen = () => {
      if (!laeuft) return;
      anfrage = requestAnimationFrame(malen);
      const bild = naechstes.current;
      const c = leinwand.current;
      if (!bild || !c) return;
      naechstes.current = null;
      if (c.width !== bild.displayWidth || c.height !== bild.displayHeight) {
        c.width = bild.displayWidth;
        c.height = bild.displayHeight;
      }
      if (malFlaeche.current?.leinwand !== c) {
        const neu = c.getContext('2d');
        malFlaeche.current = neu ? { leinwand: c, ctx: neu } : null;
      }
      malFlaeche.current?.ctx.drawImage(bild, 0, 0);
      bild.close();
    };
    anfrage = requestAnimationFrame(malen);
    return () => {
      laeuft = false;
      cancelAnimationFrame(anfrage);
      /* Beim Verlassen das vorgemerkte Bild freigeben — sonst bleibt sein
         Speicher hängen, bis die Seite neu lädt. */
      naechstes.current?.close();
      naechstes.current = null;
    };
  }, []);

  const dekoderRichten = useCallback(() => {
    if (dekoder.current) { try { dekoder.current.close(); } catch { /* schon zu */ } }
    const d = new VideoDecoder({
      output: (bild) => {
        if (!leinwand.current) { bild.close(); return; }
        /*
         * Nicht sofort zeichnen, sondern das jüngste Bild vormerken und im
         * Takt des Bildschirms zeichnen.
         *
         * Über eine lange Leitung kommen Bilder in Schüben: drei auf einmal,
         * dann eine Pause. Sofort gezeichnet heißt dann dreimal zeichnen
         * zwischen zwei Bildwiederholungen — zwei davon sieht niemand, und
         * die Anzeige läuft nicht im Takt des Schirms. Genau das sieht aus
         * wie Ruckeln, obwohl die Bilder ankommen.
         *
         * Ein überholtes Bild wird SOFORT geschlossen. Ein VideoFrame hält
         * Speicher außerhalb des Müllsammlers; wer das vergisst, bekommt
         * nach ein paar hundert Bildern einen Dekodierer, der stehenbleibt.
         */
        if (naechstes.current) naechstes.current.close();
        naechstes.current = bild;
      },
      error: (f) => setFehler(String(f)),
    });
    /* Constrained Baseline, Stufe 3.1 — dasselbe, was der Pi kodiert.
       Ohne `description` versteht der Dekodierer den Strom als Annex-B,
       und genau so schickt ihn x264 mit `b_annexb`. */
    d.configure({ codec: 'avc1.42E01F', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    dekoder.current = d;
    wartetSchluesselbild.current = true;
    zeitmarke.current = 0;
  }, []);

  useEffect(() => {
    if (!fern) return;
    const abBild = fern.aufBild((daten: Uint8Array) => {
      const d = dekoder.current;
      if (!d || d.state !== 'configured') return;
      const schluessel = istSchluesselbild(daten);
      /* Nach einem Neustart oder Bildaussetzer erst wieder einsteigen, wenn
         ein vollständiges Bild kommt — ein Zwischenbild ohne seinen Bezug
         ergibt nur Grün und Schlieren. */
      if (wartetSchluesselbild.current) {
        if (!schluessel) return;
        wartetSchluesselbild.current = false;
      }
      try {
        /* Zeitmarke aus der ECHTEN Ankunftszeit in Mikrosekunden.
           Vorher stand hier ein fester Schritt von 33333 — also 30 Bilder je
           Sekunde. Der Pi sendet 45; die Marken liefen damit langsamer als
           die Wirklichkeit, und ein Dekodierer, der nach ihnen ausgibt,
           staut. Sie müssen nur streng steigen, und die Uhr tut das. */
        const nun = Math.round(performance.now() * 1000);
        zeitmarke.current = nun > zeitmarke.current ? nun : zeitmarke.current + 1;
        d.decode(new EncodedVideoChunk({
          type: schluessel ? 'key' : 'delta',
          timestamp: zeitmarke.current,
          data: daten,
        }));
      } catch {
        wartetSchluesselbild.current = true;
      }
    });
    const abZustand = fern.aufZustand((z: { lage: Lage; fehler: string }) => {
      setLage(z.lage);
      setFehler(z.fehler);
      if (z.lage === 'offen') dekoderRichten();
      if (z.lage !== 'offen') { setSteuert(false); setInfo(null); }
    });
    const abInfo = fern.aufInfo((i: any) => {
      setInfo(i);
      /* Der Pi hat das letzte Wort darüber, wessen Eingaben er annimmt. Sagt
         er, dass ein anderer steuert, geht der Knopf hier aus — sonst zeigte
         er „Steuerung an", während nichts von dem ankommt, was man tippt.
         Nur bei einem ausdrücklichen `false`: ein älterer Pi schickt das Feld
         gar nicht, und aus `undefined` darf nichts folgen. */
      if (i?.steuert === false && i?.steuerungBei != null) setSteuert(false);
    });
    void fern.lage().then((z: { lage: Lage; fehler: string }) => {
      setLage(z.lage); setFehler(z.fehler);
      /* Auch bei der ERSTABFRAGE den Dekodierer aufsetzen, nicht nur bei
         einem Zustandswechsel.
         Das Hauptfenster ist offen, bevor verbunden wird — es bekommt das
         Ereignis "offen" und richtet ihn dabei ein. Ein Fenster, das erst
         WÄHREND einer laufenden Verbindung aufgeht, bekommt nie ein
         Ereignis: es fragt den Zustand ab, liest "offen" und hätte doch
         keinen Dekodierer. Jedes Bild fiele dann in `if (!d) return`, und
         das Fenster bliebe schwarz — genau so war es beim Betrachter im
         eigenen Fenster. */
      if (z.lage === 'offen') dekoderRichten();
    });
    void api.fernStand()
      .then(setStand)
      .catch(() => setStand({ hinterlegt: false, kennung: null, darf: false }));
    return () => { abBild?.(); abZustand?.(); abInfo?.(); };
  }, [fern, dekoderRichten]);

  useEffect(() => () => { try { dekoder.current?.close(); } catch { /* egal */ } }, []);

  /* ── Eingaben ──────────────────────────────────────────────── */

  /** Wo auf dem Pi-Schirm liegt dieser Mausklick? Die Leinwand ist meist
   *  kleiner als das Bild und hat Ränder — beides muss herausgerechnet
   *  werden, sonst wandert der Zeiger mit wachsendem Abstand vom Rand
   *  immer weiter weg. */
  const nachSchirm = (e: React.MouseEvent): [number, number] | null => {
    const c = leinwand.current;
    if (!c || !c.width) return null;
    const r = c.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return [Math.round(x * 65535), Math.round(y * 65535)];
  };

  const schick = (zeile: string) => { if (steuert) fern?.eingabe(zeile); };

  const beiBewegung = (e: React.MouseEvent) => {
    const p = nachSchirm(e);
    if (p) schick(`z ${p[0]} ${p[1]}\n`);
  };
  const beiKnopf = (e: React.MouseEvent, ab: boolean) => {
    const p = nachSchirm(e);
    const k = KNOPF[e.button];
    if (!p || !k) return;
    e.preventDefault();
    /* Erst hinbewegen, dann klicken — sonst klickt es dort, wo der Zeiger
       zuletzt war. */
    schick(`z ${p[0]} ${p[1]}\nt ${k} ${ab ? 1 : 0}\n`);
  };
  const beiRad = (e: React.WheelEvent) => {
    if (!steuert) return;
    /* Wayland zählt Rollen in derselben Einheit wie eine Maus mit Rasten:
       15 je Raste. Die Zeilen des Browsers werden hier darauf umgerechnet. */
    const senkrecht = e.deltaY / 100 * 15;
    const waagerecht = e.deltaX / 100 * 15;
    if (senkrecht) schick(`r 0 ${senkrecht.toFixed(2)}\n`);
    if (waagerecht) schick(`r 1 ${waagerecht.toFixed(2)}\n`);
  };

  useEffect(() => {
    if (!steuert) return;
    const runter = (e: KeyboardEvent) => {
      const code = TASTEN[e.code];
      if (code === undefined) return;
      e.preventDefault();
      fern?.eingabe(`k ${code} 1\n`);
    };
    const hoch = (e: KeyboardEvent) => {
      const code = TASTEN[e.code];
      if (code === undefined) return;
      e.preventDefault();
      fern?.eingabe(`k ${code} 0\n`);
    };
    window.addEventListener('keydown', runter, true);
    window.addEventListener('keyup', hoch, true);
    return () => {
      window.removeEventListener('keydown', runter, true);
      window.removeEventListener('keyup', hoch, true);
    };
  }, [steuert, fern]);

  /* ── Ansicht ───────────────────────────────────────────────── */

  /* Der Hauptprozess setzt den Fenstertitel beim Öffnen anhand der
     Systemsprache (siehe electron/fernsteuerung.ts, `fensterTitel()`) — das
     ist nur der allererste Augenblick, bevor diese Seite geladen ist. Sobald
     sie steht, soll die eingestellte Oberflächensprache gewinnen, nicht mehr
     die des Systems. Nur im eigenen Fenster nötig: die Tafel im Hauptfenster
     hat ohnehin keinen Fenstertitel, den man sähe. */
  useEffect(() => {
    if (!eigenstaendig) return;
    document.title = t('fern.titel');
  }, [eigenstaendig]);

  /* Holt die Zugangsdaten und reicht sie sofort weiter. Sie landen bewusst
     in keiner Zustandsvariablen: was nicht gespeichert wird, kann auch nicht
     angezeigt, protokolliert oder versehentlich weitergegeben werden. */
  const verbinden = async () => {
    setFehler('');
    try {
      const zugang = await api.fernZugang();
      /* Der Anzeigename geht fürs Protokoll auf dem Pi mit — nicht mehr und
         nicht weniger als eine Behauptung, siehe electron/fernsteuerung.ts. */
      const konto = useStore.getState().self?.displayName ?? '';
      await fern?.verbinden(zugang.adresse, zugang.passwort, konto);
    } catch (f) {
      setFehler((f as Error).message);
    }
  };

  if (!fern) {
    return (
      <Shell title={t('fern.titel')} icon={<Monitor size={16} />} onClose={onClose} width={520}>
        <div className="fern__leer">
          <Monitor size={32} />
          <p>{t('fern.nurApp')}</p>
        </div>
      </Shell>
    );
  }

  /* Unter welchem Namen die Sitzung auf dem Pi steht. Dieselbe Angabe, die
     verbinden() oben mitschickt und die dort ins Protokoll geht — sichtbar,
     solange die Verbindung offen ist, damit niemand raten muss, als wer er
     gerade auf einem fremden Schreibtisch sitzt. Der Zustand wird hier
     bewusst nicht abonniert: der Anzeigename ändert sich nicht mitten in
     einer laufenden Sitzung, und der Pi kennt ohnehin nur den Namen vom
     Verbindungsaufbau. */
  const alsName = useStore.getState().self?.displayName ?? '';

  /* Steuert gerade jemand anderes? Der Pi schickt dafür den Namen — und `null`
     genau dann, wenn niemand außer einem selbst steuert. Ein leerer Text ist
     etwas anderes als `null`: dann steuert jemand, der keinen Namen mitgegeben
     hat (älteres App-Fenster). */
  const fremdeSteuerung = info?.steuerungBei ?? null;

  const werkzeuge = lage === 'offen' ? (
    <>
      {/* „muted" statt einer eigenen Klasse: die Formatvorlage
          styles/fernsteuerung.css gehört in diesem Durchgang jemand anderem,
          und für gedämpften Beitext gibt es die Klasse längst app-weit. */}
      {alsName && <span className="muted">{t('fern.verbindetAls', { name: alsName })}</span>}
      {/* Wie viele gerade zusehen — erst ab zwei, denn „1 sieht zu" ist keine
          Auskunft, sondern der Normalfall. Fehlt die Zahl (älterer Pi), steht
          hier nichts. */}
      {(info?.zuschauer ?? 0) > 1 && (
        <span className="muted fern__zuschauer" title={t('fern.zuschauerHilfe')}>
          <Users size={13} /> {t('fern.zuschauer', { n: info!.zuschauer! })}
        </span>
      )}
      <button
        type="button"
        className={`fern__knopf ${steuert ? 'fern__knopf--an' : ''}`}
        /* Den Knopf sofort umlegen und dem Pi gleichzeitig Bescheid geben. Die
           beiden Wege sind mit Absicht getrennt: bei einem Pi mit altem Dienst
           kommt auf die Bescheid-Nachricht keine Antwort, und der Knopf muss
           trotzdem funktionieren — dort entscheidet weiter allein die App, ob
           sie Eingaben schickt. Widerspricht der Pi (jemand anderes steuert),
           geht der Knopf gleich wieder aus, siehe `aufInfo` oben. */
        onClick={() => {
          const an = !steuert;
          setSteuert(an);
          fern?.steuer({ art: 'steuerung', an });
        }}
        /* Ausdrücklich NICHT gesperrt, solange ein anderer steuert: der Pi
           gibt die Maus frei, wenn von dort eine Weile nichts kommt (siehe
           STEUER_RUHE_MS in fern-dienst.mjs), und dann ist genau dieser Knopf
           der Weg, sie zu übernehmen. Ein gesperrter Knopf hieße: warten, bis
           der andere von selbst auf „nur zusehen" klickt — und das tut
           niemand, der gerade nicht hinsieht. */
        title={fremdeSteuerung !== null
          ? t('fern.steuerungUebernehmen')
          : t('fern.steuernHilfe')}
      >
        <Keyboard size={14} />
        {fremdeSteuerung !== null
          ? (fremdeSteuerung
            ? t('fern.steuerungBei', { name: fremdeSteuerung })
            : t('fern.steuerungBeiUnbekannt'))
          : steuert ? t('fern.steuertAn') : t('fern.steuertAus')}
      </button>
      {/* Nur im Hauptfenster: im Betrachter selbst wäre der Knopf sinnlos. */}
      {!eigenstaendig && (
        <button
          type="button"
          className="fern__knopf"
          onClick={() => void fern.fenster()}
          title={t('fern.eigenesFensterHilfe')}
        >
          <ExternalLink size={14} /> {t('fern.eigenesFenster')}
        </button>
      )}
      <button type="button" className="fern__knopf" onClick={() => void fern.trennen()}>
        <Power size={14} /> {t('fern.trennen')}
      </button>
    </>
  ) : (
    <div className="fern__anmeldung">
      {stand?.kennung && <span className="fern__kennung">{stand.kennung.replace(/(\d{3})(?=\d)/g, '$1 ')}</span>}
      <button
        type="button"
        className="fern__knopf"
        onClick={() => void verbinden()}
        disabled={lage === 'verbindet' || lage === 'meldet an' || !stand?.hinterlegt || !stand?.darf}
        title={!stand?.darf ? t('fern.keinRecht') : !stand?.hinterlegt ? t('fern.nichtEingerichtet') : undefined}
      >
        {lage === 'verbindet' || lage === 'meldet an'
          ? <Loader2 size={14} className="dreht" />
          : t('fern.verbinden')}
      </button>
    </div>
  );

  const inhalt = (
      <div className="fern" ref={feldRef}>
        {fehler && (
          <div className="fern__fehler">
            <AlertTriangle size={14} /> {t(fehler as never)}
          </div>
        )}
        <div className="fern__buehne">
          <canvas
            ref={leinwand}
            className={`fern__schirm ${steuert ? 'fern__schirm--steuert' : ''}`}
            onMouseMove={beiBewegung}
            onMouseDown={(e) => beiKnopf(e, true)}
            onMouseUp={(e) => beiKnopf(e, false)}
            onWheel={beiRad}
            onContextMenu={(e) => e.preventDefault()}
          />
          {lage !== 'offen' && (
            <div className="fern__hinweis">
              {lage === 'verbindet' || lage === 'meldet an'
                ? t('fern.verbindet')
                : !stand
                  ? t('fern.verbindet')
                  : !stand.darf
                    ? t('fern.keinRecht')
                    : !stand.hinterlegt
                      ? t('fern.nichtEingerichtet')
                      : t('fern.nichtVerbunden')}
            </div>
          )}
        </div>
      </div>
  );

  /* Im eigenen Fenster ohne Tafel: der Betrachter füllt dort alles, und ein
     Rahmen mit Schließkreuz wäre neben dem Fensterrahmen der zweite. Die
     Werkzeuge bleiben, sonst käme man an Steuern und Trennen nicht heran. */
  if (eigenstaendig) {
    return (
      <div className="fern-fenster">
        <div className="fern-fenster__leiste">
          <Monitor size={15} />
          <span className="fern-fenster__titel">{t('fern.titel')}</span>
          {lage === 'offen' && info?.takt && (
            <span className="fern-fenster__takt">{info.takt}</span>
          )}
          <span className="spacer" />
          {werkzeuge}
        </div>
        {inhalt}
      </div>
    );
  }

  return (
    <Shell
      title={t('fern.titel')}
      icon={<Monitor size={16} />}
      onClose={onClose}
      width={1180}
      subtitle={lage === 'offen' ? info?.takt : undefined}
      actions={werkzeuge}
    >
      {inhalt}
    </Shell>
  );
}

/** Fängt dieses Häppchen mit einem vollständigen Bild an? In Annex-B steht
 *  vor jedem Stück ein Startzeichen; die fünf unteren Bits des Bytes danach
 *  sagen, was folgt — 7 ist der Bildkopf (SPS), 5 ein vollständiges Bild. */
function istSchluesselbild(daten: Uint8Array): boolean {
  for (let i = 0; i + 4 < daten.length && i < 64; i++) {
    if (daten[i] === 0 && daten[i + 1] === 0 && daten[i + 2] === 1) {
      const art = daten[i + 3] & 0x1f;
      if (art === 7 || art === 5) return true;
      if (art === 1) return false;
    }
  }
  return false;
}
