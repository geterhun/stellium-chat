import { useEffect, useState } from 'react';
import { AlertTriangle, Check, KeyRound, LifeBuoy, Loader2, Users } from 'lucide-react';
import { NOTZUGANG_ANTEILE, NOTZUGANG_SCHWELLE } from '@stellium/shared';
import type {
  NotzugangAnfrage, NotzugangAufgabe, NotzugangProtokollZeile, NotzugangStand,
} from '@stellium/shared';
import { Shell } from './Panels.jsx';
import { useT, type TranslationKey } from '../i18n/index.js';
import { useStore } from '../state/store.js';
import { api } from '../net/api.js';
import { relativeTime } from '../lib/format.js';
import * as notzugang from '../lib/notzugang.js';
import '../styles/notzugang.css';

/**
 * Die Tafel zum Notzugang — „3 von 5".
 *
 * SIE ZEIGT DREI DINGE, UND ZWEI DAVON SIND UNANGENEHM
 *
 *   1. Ob es einen Notzugang gibt und ob er noch TRÄGT. Nicht „eingerichtet
 *      ✓", sondern die Zahl, auf die es ankommt: wie viele der fünf Anteile
 *      heute noch einlösbar wären. Verlässt jemand die Firma oder wechselt
 *      sein Schlüsselpaar, sinkt sie — und darunter steht in klaren Worten,
 *      was das heißt. Eine Rettungsleine, die still gerissen ist, ist
 *      schlimmer als gar keine.
 *
 *   2. Was bisher geschah. Jede Anfrage, jeder Beitrag, jedes Einlösen, mit
 *      Namen und Zeit. Diese Liste lässt sich nicht abschalten und ist der
 *      Preis dafür, dass es den Weg überhaupt gibt.
 *
 *   3. Was auf einen selbst wartet: Anteile, die andere gerade brauchen.
 *
 * KEIN GEHEIMNIS STEHT HIER JE IM ZUSTAND — mit einer benannten Ausnahme.
 * Anteile und der Notschlüssel selbst kommen hier gar nicht vor; sie leben
 * ausschließlich innerhalb der Aufrufe in lib/notzugang.ts und werden dort
 * genullt.
 *
 * DIE AUSNAHME IST DER GESPROCHENE CODE, und sie war ein Fehler in der
 * bisherigen Form. Er lag in einem `useState`, der mit der Tafel starb. Die
 * ANFRAGE dagegen lebt beim Server weiter und läuft erst nach Stunden ab.
 * Wer die Tafel schloss, während er auf drei Kolleginnen wartete, oder wessen
 * Fenster sich neu lud, saß danach vor einer offenen Anfrage ohne Code:
 * einlösen ging nicht mehr, und der einzige Ausweg war abbrechen und alle
 * noch einmal anrufen.
 *
 * Der Code liegt deshalb zusätzlich im ARBEITSSPEICHER DES HAUPTPROZESSES
 * (electron/main.ts, `notzugangCode`) — nicht im localStorage. Dort läge
 * schon der private Teil dieses Geräts, und der Code ist ausdrücklich das
 * ZWEITE von zwei Schlössern; beide in dieselbe Schublade zu legen, hieße,
 * eines davon aufzugeben. Geschrieben wird nichts, gemerkt nur bis zum
 * Beenden des Programms, und mit dem Einlösen oder Abbrechen ist er weg.
 * Im Browser gibt es die Brücke nicht — dort bleibt es beim alten Verhalten,
 * und `notzugang.codeZeigen` sagt weiterhin genau das Richtige: der Code
 * steht nirgends geschrieben.
 */
export function NotzugangPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const self = useStore((s) => s.self);
  const users = useStore((s) => s.users);

  const [stand, setStand] = useState<NotzugangStand | null>(null);
  const [anfrage, setAnfrage] = useState<NotzugangAnfrage | null>(null);
  const [protokoll, setProtokoll] = useState<NotzugangProtokollZeile[]>([]);
  const [aufgaben, setAufgaben] = useState<NotzugangAufgabe[]>([]);
  const [gewaehlt, setGewaehlt] = useState<string[]>([]);
  const [laeuft, setLaeuft] = useState(false);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [eingabe, setEingabe] = useState('');
  /* Je Anfrage ein eigenes Feld. Vorher teilten sich alle Beitragsfelder und
     das Feld für die eigene Wiederherstellung EINEN Wert: wer für zwei
     Kolleginnen zugleich einen Code hatte, tippte ihn in beide Felder, und
     „beitragen" schickte ihn auch an die falsche Anfrage — dort hieß das
     Ergebnis dann „verfälscht". */
  const [beitragCodes, setBeitragCodes] = useState<Record<string, string>>({});
  const [passwort, setPasswort] = useState('');

  const name = (id: string) => users[id]?.displayName ?? t('common.unknown');

  const laden = async () => {
    setLaedt(true); setFehler(null);
    try {
      const [eigen, meine] = await Promise.all([api.notzugang(), api.notzugangAufgaben()]);
      setStand(eigen.stand);
      setAnfrage(eigen.anfrage);
      setProtokoll(eigen.protokoll);
      setAufgaben(meine.aufgaben);
      /* Der Code zu einer offenen Anfrage — aus dem Hauptprozess, falls er
         dort noch liegt. Nur mit DERSELBEN Anfragekennung: nach einem Abbruch
         und einer neuen Anfrage soll der alte Code nicht versehentlich wieder
         auftauchen. Gibt es keine Brücke (Browser) oder ist das Programm
         zwischendurch beendet worden, kommt `null` — dann bleibt es beim
         Eingabefeld, wie bisher. */
      setCode(eigen.anfrage
        ? (await window.stellium?.notzugangCode?.holen(eigen.anfrage.id)) ?? null
        : null);
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setLaedt(false);
    }
  };

  useEffect(() => { void laden(); }, []);

  /* Wählbar ist, wer aktiv ist, ein Schlüsselpaar hat und nicht man selbst
     ist. Den eigenen Anteil auszuschließen ist keine Förmlichkeit: er senkte
     die Schwelle für genau die Person, die ohnehin schon hineinkommt. */
  const waehlbar = Object.values(users)
    .filter((u) => u.id !== self?.id && !u.disabled && u.role !== 'bot')
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const umschalten = (id: string) => setGewaehlt((v) => (
    v.includes(id) ? v.filter((x) => x !== id) : v.length < NOTZUGANG_ANTEILE ? [...v, id] : v
  ));

  const mitFehler = async (tun: () => Promise<void>) => {
    setLaeuft(true); setFehler(null); setMeldung(null);
    try {
      await tun();
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setLaeuft(false);
    }
  };

  const einrichten = () => mitFehler(async () => {
    if (!self) return;
    await notzugang.einrichten(self.id, gewaehlt);
    setGewaehlt([]);
    setMeldung(t('notzugang.eingerichtet'));
    await laden();
  });

  const aufheben = () => mitFehler(async () => {
    /* `verbrannt` kommt vom Server (services/notzugang.ts, aufheben()) —
       nicht aus `stand?.notzugangWartet` hier oben, das nur die RÜCKFRAGE
       steuert und aus einer Momentaufnahme vom Öffnen der Tafel stammt. Ein
       Browser-Aufbau, ein direkter API-Aufruf oder eine inzwischen
       veraltete Tafel könnten die Rückfrage nie gesehen haben; die Meldung
       hier soll trotzdem stimmen. */
    const { verbrannt } = await notzugang.aufheben();
    setMeldung(verbrannt ? t('notzugang.aufgehobenVerbrannt') : t('notzugang.aufgehoben'));
    await laden();
  });

  /**
   * Der Klick auf „Notzugang aufheben" — mit einer Rückfrage GENAU DANN,
   * wenn sie den Unterschied macht.
   *
   * Wartet für dieses Konto gerade eine Wiederherstellung
   * (`stand.notzugangWartet`), dann liegt der Kontoschlüssel nur noch
   * HINTER der Hülle des Notzugangs — und `aufheben()` holt das harte
   * Verwerfen (services/notzugang.ts, aufheben()) in genau diesem Zustand
   * sofort nach, mit einem einzigen Klick, ohne Weg zurück. Das war schon
   * vorher der Fall beim nächsten GEWÖHNLICHEN Zurücksetzen — neu ist
   * SOFORT UND EIN KLICK, und neu ist, dass genau dieser Zustand aussieht
   * wie eine leere Tafel, die zum Nachsehen einlädt: das eigene Passwort
   * wurde gerade zurückgesetzt, die Notizen sind leer, und die Person
   * versucht herauszufinden, was als Nächstes zu tun ist. Also fragt der
   * Knopf hier ausdrücklich nach, WAS verloren geht — nicht „wirklich?",
   * sondern der Satz mit Notizen und Tresor drin.
   *
   * Derselbe Griff wie bei anderen Handlungen ohne Weg zurück in diesem
   * Haus (TeamAdmin.tsx `team.deleteConfirm`, PostPanel.tsx
   * `post.endgueltigLoeschenBestaetigen`): `window.confirm()` mit einem
   * eigenen, ausgeschriebenen Satz statt einer stillen Bestätigung oder
   * eines zweiten, wortgleichen Knopfs.
   *
   * Wartet gerade NICHTS, bleibt es beim einfachen Klick: `aufheben()`
   * öffnet dann nichts und zerstört nichts, sondern kappt nur die
   * Rettungsleine für ein künftiges Zurücksetzen — dieselbe Lage, die der
   * Knopf schon immer hatte, und für die eine Rückfrage nur Dekoration
   * wäre, die mit der Zeit niemand mehr liest.
   */
  const aufhebenKlick = () => {
    if (stand?.notzugangWartet && !window.confirm(t('notzugang.aufhebenWartetBestaetigen'))) return;
    void aufheben();
  };

  const starten = () => mitFehler(async () => {
    const { anfrageId, code: neu } = await notzugang.anfragen();
    /* Vor `laden()`: das lädt den Code gleich wieder aus dem Hauptprozess,
       und was dort nicht liegt, wäre schon im nächsten Atemzug weg. */
    await window.stellium?.notzugangCode?.merken(anfrageId, neu);
    setCode(neu);
    await laden();
  });

  const abbrechen = () => mitFehler(async () => {
    if (!anfrage) return;
    await api.notzugangAnfrageAbbrechen(anfrage.id);
    await window.stellium?.notzugangCode?.vergessen();
    setCode(null);
    await laden();
  });

  const einloesen = () => mitFehler(async () => {
    if (!self || !anfrage) return;
    const ergebnis = await notzugang.wiederherstellen(self.id, anfrage.id, eingabe || code || '', passwort);
    setPasswort('');
    if (ergebnis.ok) {
      /* Verbraucht: die Anfrage ist geschlossen, der Code hat keinen Zweck
         mehr — und ein Geheimnis ohne Zweck ist nur noch ein Risiko. */
      await window.stellium?.notzugangCode?.vergessen();
      setCode(null);
      setMeldung(t('notzugang.gelungen'));
      /* Der Streifen ganz oben (NotzugangHinweis.tsx) hängt am Stand des
         Servers und nicht an dieser Tafel — also hier neu nachfragen, sonst
         bliebe er stehen, obwohl die Notizen längst wieder da sind. */
      void useStore.getState().notzugangPruefen();
    } else {
      setFehler(t(`notzugang.grund.${ergebnis.grund}` as TranslationKey));
    }
    await laden();
  });

  const beitragen = (aufgabe: NotzugangAufgabe) => mitFehler(async () => {
    const ok = await notzugang.beitragen(aufgabe.anfrageId, beitragCodes[aufgabe.anfrageId] ?? '');
    setMeldung(ok ? t('notzugang.beigetragen') : null);
    if (!ok) setFehler(t('notzugang.grund.verfaelscht'));
    setBeitragCodes((v) => { const n = { ...v }; delete n[aufgabe.anfrageId]; return n; });
    await laden();
  });

  const traegt = stand ? notzugang.traegtNoch(stand) : false;
  const knapp = Boolean(stand?.eingerichtet && traegt && stand.brauchbar < stand.anteile);

  return (
    <Shell
      title={t('notzugang.nav')}
      icon={<LifeBuoy size={18} />}
      onClose={onClose}
      width={520}
      subtitle={t('notzugang.untertitel', { schwelle: NOTZUGANG_SCHWELLE, anteile: NOTZUGANG_ANTEILE })}
    >
      <p className="postsicht__hinweis">{t('notzugang.erklaerung')}</p>

      {fehler && <div className="post__fehler"><AlertTriangle size={13} /> {fehler}</div>}
      {meldung && <div className="notzugang__gut"><Check size={13} /> {meldung}</div>}
      {laedt && <Loader2 size={22} className="spin muted" role="status" aria-label={t('post.laedt')} />}

      {/* ── Der eigene Stand ─────────────────────────────────── */}
      {!laedt && stand && !stand.eingerichtet && (
        <section className="notzugang__block">
          <h3>{t('notzugang.nochNicht')}</h3>
          <p className="muted">
            {t('notzugang.waehlen', { n: gewaehlt.length, anteile: NOTZUGANG_ANTEILE })}
          </p>
          <ul className="notzugang__leute">
            {waehlbar.map((u) => (
              <li key={u.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={gewaehlt.includes(u.id)}
                    onChange={() => umschalten(u.id)}
                  />
                  <span className="truncate">{u.displayName}</span>
                  <span className="muted">
                    {t(`admin.role${u.role.charAt(0).toUpperCase()}${u.role.slice(1)}` as TranslationKey)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button
            className="btn btn--primary btn--block"
            disabled={laeuft || gewaehlt.length !== NOTZUGANG_ANTEILE}
            onClick={() => void einrichten()}
          >
            {laeuft ? <Loader2 size={14} className="spin" /> : t('notzugang.einrichten')}
          </button>
        </section>
      )}

      {!laedt && stand?.eingerichtet && (
        <section className="notzugang__block">
          <h3><Users size={14} /> {t('notzugang.halterTitel')}</h3>
          <p className={traegt ? 'muted' : 'post__fehler'}>
            {t('notzugang.brauchbar', {
              n: stand.brauchbar, anteile: stand.anteile, schwelle: stand.schwelle,
            })}
          </p>
          {!traegt && <p className="post__fehler">{t('notzugang.kaputt')}</p>}
          {knapp && <p className="muted">{t('notzugang.knapp')}</p>}
          {/* Die Zählung „höchstens zwei aus der Verwaltung" wurde beim
              Einrichten geprüft und danach nie wieder — eine Beförderung
              fragt keinen Anteil. Der Server misst sie jetzt bei jeder
              Auskunft neu (services/notzugang.ts, standFuer()); hier steht
              das Ergebnis. Abgelehnt wird deswegen nichts: weder eine
              Beförderung noch eine Wiederherstellung. Die Begründung steht
              an der Messstelle. */}
          {stand.verwaltungZuViele && (
            <p className="post__fehler">
              {t('notzugang.verwaltungZuViele', { n: stand.ausDerVerwaltung })}
            </p>
          )}
          <ul className="notzugang__leute">
            {stand.halter.map((h) => (
              <li key={h.halterId}>
                <span className="truncate">{name(h.halterId)}</span>
                <span className="muted">
                  {!h.aktiv ? t('notzugang.halterWeg')
                    : !h.schluesselPasst ? t('notzugang.halterSchluesselNeu')
                      : t('notzugang.halterOk')}
                </span>
              </li>
            ))}
          </ul>
          <button className="btn btn--ghost" disabled={laeuft} onClick={aufhebenKlick}>
            {t('notzugang.aufheben')}
          </button>
        </section>
      )}

      {/* ── Wiederherstellung ────────────────────────────────── */}
      {!laedt && stand?.eingerichtet && (
        <section className="notzugang__block">
          <h3><KeyRound size={14} /> {t('notzugang.wiederherstellenTitel')}</h3>
          {!anfrage && (
            <>
              <p className="muted">{t('notzugang.wiederherstellenHinweis')}</p>
              <button
                className="btn btn--ghost"
                disabled={laeuft || !traegt}
                onClick={() => void starten()}
              >
                {t('notzugang.wiederherstellenStarten')}
              </button>
            </>
          )}
          {anfrage && (
            <>
              {code && (
                <>
                  <p className="muted">{t('notzugang.codeZeigen')}</p>
                  <p className="notzugang__code">{code}</p>
                </>
              )}
              <p className="muted">
                {t('notzugang.beitraege', { n: anfrage.beitraege, schwelle: stand.schwelle })}
              </p>
              <div className="field">
                <label className="field__label" htmlFor="notzugang-code">{t('notzugang.codeFeld')}</label>
                <input
                  id="notzugang-code" className="input" autoComplete="off"
                  value={eingabe} onChange={(e) => setEingabe(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="notzugang-passwort">{t('notzugang.passwortFeld')}</label>
                <input
                  id="notzugang-passwort" className="input" type="password"
                  autoComplete="current-password"
                  value={passwort} onChange={(e) => setPasswort(e.target.value)}
                />
              </div>
              <p className="muted">{t('notzugang.passwortWarum')}</p>
              <button
                className="btn btn--primary btn--block"
                disabled={laeuft || anfrage.beitraege < stand.schwelle || !passwort}
                onClick={() => void einloesen()}
              >
                {laeuft ? <Loader2 size={14} className="spin" /> : t('notzugang.einloesen')}
              </button>
              <button className="btn btn--ghost" disabled={laeuft} onClick={() => void abbrechen()}>
                {t('notzugang.anfrageAbbrechen')}
              </button>
            </>
          )}
        </section>
      )}

      {/* ── Was auf mich wartet ──────────────────────────────── */}
      {!laedt && !!aufgaben.length && (
        <section className="notzugang__block">
          <h3>{t('notzugang.aufgabenTitel')}</h3>
          <p className="muted">{t('notzugang.aufgabeHinweis')}</p>
          {aufgaben.map((a) => (
            <div key={a.anfrageId} className="notzugang__aufgabe">
              <span className="truncate">{name(a.userId)}</span>
              <span className="muted">{relativeTime(a.erstelltAm)}</span>
              {a.erledigt ? (
                <span className="muted"><Check size={13} /> {t('notzugang.beigetragen')}</span>
              ) : (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor={`notzugang-beitrag-${a.anfrageId}`}>
                      {t('notzugang.codeFeld')}
                    </label>
                    <input
                      id={`notzugang-beitrag-${a.anfrageId}`} className="input" autoComplete="off"
                      value={beitragCodes[a.anfrageId] ?? ''}
                      onChange={(e) => {
                        const wert = e.target.value;
                        setBeitragCodes((v) => ({ ...v, [a.anfrageId]: wert }));
                      }}
                    />
                  </div>
                  <button
                    className="btn btn--primary"
                    disabled={laeuft || !beitragCodes[a.anfrageId]}
                    onClick={() => void beitragen(a)}
                  >
                    {t('notzugang.beitragen')}
                  </button>
                </>
              )}
            </div>
          ))}
        </section>
      )}

      {/* ── Die Spur ─────────────────────────────────────────── */}
      {!laedt && !!protokoll.length && (
        <section className="notzugang__block">
          <h3>{t('notzugang.protokollTitel')}</h3>
          <ul className="notzugang__spur">
            {protokoll.map((z) => (
              <li key={z.id}>
                <span>
                  {t(`notzugang.spur.${z.art}` as TranslationKey, {
                    name: z.halterId ? name(z.halterId) : '',
                  })}
                </span>
                <span className="muted">{relativeTime(z.am)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  );
}
