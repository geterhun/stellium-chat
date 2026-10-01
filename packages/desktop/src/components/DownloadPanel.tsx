import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle, Apple, Check, Copy, Download, Loader2, Monitor, RefreshCw, Smartphone, Terminal,
} from 'lucide-react';
import type { ReleaseInfo, ReleasePlatform } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { currentUiLanguage, useT } from '../i18n/index.js';
import { api, dateiUrl } from '../net/api.js';
import { Shell } from './Panels.jsx';
import { clsx, fileSize } from '../lib/format.js';
import '../styles/download.css';

/**
 * Der Bereich zum Herunterladen der Installationsdateien.
 *
 * Es gibt die Seite `/download` des Servers bereits — die richtet sich aber an
 * alle, die noch gar keine App haben, und liegt außerhalb der Oberfläche. Wer
 * schon im Browser angemeldet ist, will nicht in einem neuen Reiter landen und
 * dort noch einmal denselben Nachweis mitschleppen. Deshalb dieselbe Sache
 * noch einmal drinnen: erkannt, übersetzt und in der Gestaltung der App.
 *
 * Bewusst nur im Browser. In der installierten App wäre der Bereich sinnlos —
 * sie hält sich über die Aktualisierung selbst auf dem neuesten Stand, und
 * eine zweite Installationsdatei danebenzulegen würde nur verwirren.
 */

/**
 * Läuft die Oberfläche im Browser statt in der installierten App?
 *
 * `window.stellium` legt allein die Brücke von Electron an. Ist sie da, ist es
 * die App. Diese Frage wird auch außerhalb gebraucht — die Leiste soll den
 * Knopf gar nicht erst zeigen —, deshalb liegt sie hier als eigene Funktion
 * und nicht als Bedingung mitten im Baum.
 */
export function imBrowser(): boolean {
  return typeof window !== 'undefined' && !window.stellium;
}

/**
 * Wie das System heißt und woran man es erkennt.
 *
 * Die Namen bleiben unübersetzt: „macOS" heißt in jeder Sprache so. Der
 * Zusatz kommt später aus dem Dateinamen der Fassung — die Endung ist
 * ehrlicher als eine gepflegte Liste, die beim Wechsel des Bauwerkzeugs
 * stillschweigend falsch wird.
 */
const SYSTEME: Record<ReleasePlatform, { name: string; symbol: React.ReactNode }> = {
  darwin: { name: 'macOS', symbol: <Apple size={20} /> },
  win32: { name: 'Windows', symbol: <Monitor size={20} /> },
  linux: { name: 'Linux', symbol: <Terminal size={20} /> },
  // Das Serverpaket taucht hier nie auf — es enthält keine App, sondern den
  // Dienst selbst. Der Eintrag steht nur da, damit der Typ vollständig ist.
  server: { name: 'Server', symbol: <Download size={20} /> },
};

/**
 * Auf welchem System sitzt die Person gerade?
 *
 * Dieselbe Überlegung wie in `systemErkennen` auf dem Server, nur diesseits:
 * dort liest sie die Kennung aus der Anfrage, hier steht sie direkt zur
 * Verfügung. Zwei Fassungen sind einer zu viel, aber der Weg über den Server
 * hieße, für eine Zeile eine Anfrage zu stellen.
 */
function systemErkennen(): ReleasePlatform | null {
  if (typeof navigator === 'undefined') return null;
  const kennung = navigator.userAgent.toLowerCase();

  // Telefone und Tablets zuerst: in ihrer Kennung steht ebenfalls „mac os x"
  // beziehungsweise „linux", und ohne diese Zeile bekäme ein iPhone eine
  // .dmg-Datei angeboten, mit der es nichts anfangen kann.
  if (/iphone|ipad|ipod|android/.test(kennung)) return null;
  // Ein iPad im Schreibtisch-Modus gibt sich seit iPadOS 13 als Macintosh aus.
  // Was es verrät, ist der Bildschirm: ein Mac meldet keine Berührungspunkte.
  if (/macintosh/.test(kennung) && navigator.maxTouchPoints > 2) return null;

  if (/mac os x|macintosh/.test(kennung)) return 'darwin';
  if (/windows/.test(kennung)) return 'win32';
  if (/linux|x11|cros/.test(kennung)) return 'linux';
  return null;
}

/** Handelt es sich um ein Telefon oder Tablet? Dafür gibt es einen eigenen Hinweis. */
function istMobil(): boolean {
  if (typeof navigator === 'undefined') return false;
  const kennung = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod|android/.test(kennung)) return true;
  return /macintosh/.test(kennung) && navigator.maxTouchPoints > 2;
}

/** Die Endung der Datei — „.dmg", „.exe", „.AppImage". Ohne Punkt nichts. */
function endung(dateiname: string): string {
  const treffer = /(\.[A-Za-z0-9]+)$/.exec(dateiname);
  return treffer ? treffer[1] : '';
}

export function DownloadPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { toast } = useStore.getState();

  const [fassungen, setFassungen] = useState<ReleaseInfo[] | null>(null);
  const [fehler, setFehler] = useState(false);
  const [kopiert, setKopiert] = useState<ReleasePlatform | null>(null);

  // Einmal berechnet und dann festgehalten: die Kennung des Browsers ändert
  // sich innerhalb einer Sitzung nicht, und bei jedem Neuzeichnen dieselben
  // Ausdrücke laufen zu lassen wäre Arbeit ohne Ertrag.
  const erkannt = useMemo(systemErkennen, []);
  const mobil = useMemo(istMobil, []);

  const laden = () => {
    setFehler(false);
    /* Zurück auf „lädt": sonst stand nach „Erneut versuchen" bis zur Antwort
       „Noch keine Fassung veröffentlicht" da, und der Kreisel am Knopf, der
       an genau diesem Wert hängt, drehte sich nie. */
    setFassungen(null);
    api.releases()
      .then((r) => setFassungen(r.releases))
      .catch(() => { setFassungen([]); setFehler(true); });
  };

  // Nur im Browser überhaupt fragen: in der App bleibt der Bereich leer, und
  // eine Anfrage, deren Antwort niemand sieht, gehört nicht gestellt.
  useEffect(() => { if (imBrowser()) laden(); }, []);

  /* Doppelt gesichert: die Leiste zeigt den Knopf ohnehin nur im Browser, aber
     die Regel soll nicht allein an einer fremden Datei hängen. Die Prüfung
     steht bewusst hinter allen Haken — vor ihnen brächte sie die Reihenfolge
     durcheinander, sobald der Bereich doch einmal gezeigt würde. */
  if (!imBrowser()) return null;

  /* Der Server hält je System genau eine Zeile vor und ersetzt sie beim
     Veröffentlichen. Was hier ankommt, ist damit von sich aus die neueste
     Fassung — es gibt nichts zu sortieren oder auszuwählen. */
  const apps = (fassungen ?? []).filter((r) => r.platform !== 'server');
  const empfohlen = apps.find((r) => r.platform === erkannt) ?? null;
  const rest = apps.filter((r) => r !== empfohlen);

  // Was neu ist, gilt für alle Systeme gleich — die Fassungen werden zusammen
  // veröffentlicht. Deshalb steht der Text einmal oben und nicht auf jeder
  // Karte noch einmal.
  const neuerungen = (empfohlen ?? apps[0])?.notes?.trim();

  const datum = (ts: number) =>
    new Intl.DateTimeFormat(currentUiLanguage(), { dateStyle: 'long' }).format(ts);

  const pruefsummeKopieren = async (r: ReleaseInfo) => {
    try {
      await navigator.clipboard.writeText(r.sha256);
      setKopiert(r.platform);
      // Nach kurzer Zeit zurück zum Symbol: ein dauerhaftes Häkchen sähe aus,
      // als gehöre es zur Karte, und nicht als Antwort auf einen Klick.
      window.setTimeout(() => setKopiert((jetzt) => (jetzt === r.platform ? null : jetzt)), 1600);
    } catch {
      // Ohne Erlaubnis zur Zwischenablage bleibt der Wert wenigstens lesbar.
      toast({ kind: 'error', title: t('download.checksum'), body: r.sha256 });
    }
  };

  const karte = (r: ReleaseInfo, gross: boolean) => {
    const system = SYSTEME[r.platform] ?? { name: r.platform, symbol: <Download size={20} /> };
    return (
      <motion.div
        key={r.platform}
        className={clsx('dl-karte', gross && 'dl-karte--gross')}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <span className="dl-karte__symbol">{system.symbol}</span>

        <span className="dl-karte__text">
          <span className="dl-karte__name">
            {system.name}
            {gross && <span className="dl-marke">{t('download.recommended')}</span>}
          </span>
          <span className="dl-karte__meta">
            {[
              t('download.version', { version: r.version }),
              fileSize(r.size),
              endung(r.fileName),
              t('download.published', { datum: datum(r.publishedAt) }),
            ].filter(Boolean).join(' · ')}
          </span>
          <button
            className="dl-pruef"
            title={t('download.checksumCopy')}
            onClick={() => { void pruefsummeKopieren(r); }}
          >
            {kopiert === r.platform ? <Check size={11} /> : <Copy size={11} />}
            <span className="dl-pruef__wert">
              {kopiert === r.platform ? t('download.checksumCopied') : `${t('download.checksum')} ${r.sha256.slice(0, 16)}…`}
            </span>
          </button>
        </span>

        {/* Der Nachweis geht in der Adresse mit: ein Klick auf einen Link
            trägt keine Kopfzeile, und ohne ihn antwortet der Server mit 401.
            `download` greift nur bei gleicher Herkunft — der Normalfall, weil
            die Seite meist von genau diesem Server kommt. Bei fremder Herkunft
            sorgt die Kopfzeile des Servers dafür, dass gespeichert statt
            angezeigt wird. */}
        <a
          className={clsx('btn', gross && 'btn--primary', 'dl-knopf')}
          href={dateiUrl(r.url)}
          download={r.fileName}
          target="_blank"
          rel="noreferrer"
        >
          <Download size={14} /> {t('download.get')}
        </a>
      </motion.div>
    );
  };

  return (
    <Shell
      title={t('download.title')}
      subtitle={t('download.subtitle')}
      icon={<Download size={18} />}
      onClose={onClose}
      width={720}
      actions={
        /* Derselbe Text wie bei der Aktualisierung: gemeint ist dasselbe —
           jetzt beim Server nachfragen, statt auf das nächste Öffnen zu warten.
           Ein zweiter Satz für dieselbe Handlung wäre in zweiundzwanzig
           Sprachen zweiundzwanzigmal Gelegenheit, auseinanderzulaufen. */
        <button className="pill" onClick={laden} disabled={fassungen === null}>
          <RefreshCw size={13} className={fassungen === null ? 'spin' : undefined} />
          {t('update.check')}
        </button>
      }
    >
      {fassungen === null ? (
        <div className="empty-state">
          <Loader2 size={26} className="spin muted" />
          <p>{t('download.loading')}</p>
        </div>
      ) : fehler ? (
        <div className="empty-state">
          <AlertTriangle size={26} className="muted" />
          <p>{t('download.loadFailed')}</p>
          <button className="btn btn--primary" onClick={laden}>{t('download.retry')}</button>
        </div>
      ) : !apps.length ? (
        <div className="empty-state">
          <Download size={26} className="muted" />
          <p>{t('download.empty')}</p>
          <p className="field__hint">{t('download.emptyHint')}</p>
        </div>
      ) : (
        <>
          {/* Zuerst das eigene System, groß und mit Namen. Wer hier ist, will
              in aller Regel genau diese eine Datei — alles andere ist Beiwerk. */}
          {empfohlen && karte(empfohlen, true)}

          {/* Kein Treffer heißt zweierlei: entweder ein Telefon, für das es
              nichts zu installieren gibt, oder ein System, das die Kennung
              nicht verrät. Beides braucht einen anderen Satz. */}
          {!empfohlen && (
            <div className="dl-hinweis">
              {mobil ? <Smartphone size={16} /> : <AlertTriangle size={16} />}
              <span>{mobil ? t('download.mobileHint') : t('download.unknownSystem')}</span>
            </div>
          )}

          {neuerungen && (
            <div className="field">
              <label className="field__label">{t('download.whatsNew')}</label>
              <p className="dl-neu">{neuerungen}</p>
            </div>
          )}

          {rest.length > 0 && (
            <div className="field">
              <label className="field__label">
                {empfohlen ? t('download.otherSystems') : t('download.title')}
              </label>
              <div className="dl-liste">{rest.map((r) => karte(r, false))}</div>
            </div>
          )}

          <p className="field__hint">{t('download.checksumHint')}</p>
        </>
      )}
    </Shell>
  );
}
