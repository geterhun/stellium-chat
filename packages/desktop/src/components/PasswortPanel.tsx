/**
 * Der Passwort-Tresor.
 *
 * Verschlüsselt wie eine Notiz (siehe lib/passwoerter.ts), aber über HTTP
 * geladen statt per WebSocket-Push — begründet dort. Diese Tafel selbst
 * folgt sonst genau dem Vorbild von NotizenPanel.tsx: eine Liste links, ein
 * Formular rechts, Teilen als eigener Abschnitt darunter.
 *
 * WAS DIESE TAFEL NIE TUT
 *   · Die Suche links läuft ausschließlich über `schaufenster`, das dieses
 *     Gerät selbst entschlüsselt hat — nie über eine Anfrage an den Server
 *     (der könnte mit einer Suchanfrage ohnehin nichts anfangen, er hat
 *     keinen Schlüssel).
 *   · Sie holt kein Passwort, bevor jemand danach fragt. Das Öffnen der
 *     Tafel entschlüsselt nur Schaufenster (Etikett, Benutzername, Notiz,
 *     Adresse); das Passwortfeld ist bis zum Aufdecken LEER, nicht
 *     verdeckt-aber-gefüllt. Der Unterschied ist der ganze Punkt: ein
 *     verdecktes Feld mit echtem Wert dahinter ist für die
 *     Entwicklerwerkzeuge, ein Vorleseprogramm und jedes Skript in der Seite
 *     ein offenes Feld.
 *   · Aufdecken und Kopieren holen das Geheimnis JEWEILS einzeln beim
 *     Server, und der schreibt dabei die Zeile (WER, WANN — nie der Wert).
 *     Kopieren holt auch dann neu, wenn gerade aufgedeckt ist: es ist ein
 *     zweiter Weg an den Wert und wird wie der erste vermerkt.
 *   · Ist ein Eintrag einmal aufgedeckt, bleibt sein Wert für die Dauer
 *     DIESER Auswahl im Formular stehen — anders ließe er sich nicht
 *     bearbeiten. Beim Wechsel auf einen anderen Eintrag ist er weg (die
 *     Bearbeitungsansicht hängt an `key={id}` und wird neu aufgebaut).
 *   · Kopieren löscht die Zwischenablage nach 20 Sekunden von selbst wieder —
 *     in der App. Im Browser geht das nicht (Begründung in
 *     lib/passwoerter.ts, kopierenUndLoeschen()), und dann sagt die Tafel es
 *     auch: der Hinweis unter dem Feld wechselt, und beim Kopieren kommt eine
 *     Meldung dazu. Verschwiegen wird es nirgends.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, Copy, ExternalLink, Eye, EyeOff, History, KeyRound,
  Loader2, Lock, Plus, Search, Trash2, UserMinus, UserPlus, Users,
} from 'lucide-react';
import type { Passworteintrag, PasswortOffenlegung } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { clsx, relativeTime } from '../lib/format.js';
import { usePasswortUi } from '../state/passwort.js';
import { useEinmalcodeUi } from '../state/einmalcode.js';
import { api, serverUrl, token } from '../net/api.js';
import {
  ablageLoeschbar,
  kopierenUndLoeschen, leeresSchaufenster, passwortErstellen, passwortGeheimnisHolen,
  passwortLoeschen, passwortMitgliedEntfernen, passwortSpeichern, passwortTeilen,
  passwortUmstellen, passwoerterLaden,
  type PasswortSchaufenster,
} from '../lib/passwoerter.js';
import '../styles/passwort.css';

function istHttpUrl(wert: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(wert).protocol); } catch { return false; }
}

export function PasswortPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const self = useStore((s) => s.self);
  const users = useStore((s) => s.users);
  const hervorhebenEintragId = usePasswortUi((s) => s.hervorhebenEintragId);

  const [eintraege, setEintraege] = useState<Passworteintrag[]>([]);
  const [schaufenster, setSchaufenster] = useState<Record<string, PasswortSchaufenster | null>>({});
  const [laedt, setLaedt] = useState(true);
  const [ladenFehler, setLadenFehler] = useState('');
  const [ausgewaehlteId, setAusgewaehlteId] = useState<string | null>(null);
  const [suche, setSuche] = useState('');
  const [legtAn, setLegtAn] = useState(false);
  /* Ein gerade selbst angelegter Eintrag hat ein LEERES Passwort, und dieses
     Gerät weiß das aus erster Hand — es hat die Hülle eben selbst gepackt.
     Ohne diesen Vermerk müsste die Person auf einem frischen Eintrag erst
     auf "aufdecken" drücken, um überhaupt tippen zu dürfen, und der Verlauf
     füllte sich mit Aushändigungen leerer Passwörter. Gilt nur für DIESE
     Sitzung und nur für DIESEN einen Eintrag. */
  const [frischAngelegtId, setFrischAngelegtId] = useState<string | null>(null);
  const [loeschenLaeuft, setLoeschenLaeuft] = useState<string | null>(null);
  const hervorhebenAngewandt = useRef(false);

  const laden = useCallback(async () => {
    setLaedt(true);
    try {
      const ergebnis = await passwoerterLaden();
      setEintraege(ergebnis.eintraege);
      setSchaufenster(ergebnis.schaufenster);
      setLadenFehler('');
    } catch (fehler) {
      setLadenFehler(fehler instanceof Error ? fehler.message : String(fehler));
    } finally {
      setLaedt(false);
    }
  }, []);

  useEffect(() => { void laden(); }, [laden]);

  // Aus dem Einmalcode-Reiter zurückgesprungen (oder direkt mit einer
  // Kennung geöffnet) — einmal anwenden, danach der Auswahl der Person
  // überlassen, sonst ließe sich der Eintrag nie wieder abwählen.
  useEffect(() => {
    if (hervorhebenAngewandt.current || !hervorhebenEintragId || laedt) return;
    if (eintraege.some((e) => e.id === hervorhebenEintragId)) {
      hervorhebenAngewandt.current = true;
      setAusgewaehlteId(hervorhebenEintragId);
    }
  }, [hervorhebenEintragId, eintraege, laedt]);

  const liste = useMemo(() => {
    const q = suche.trim().toLowerCase();
    return eintraege
      .filter((e) => {
        if (!q) return true;
        const klar = schaufenster[e.id];
        // Ungeöffnete Einträge — und solche aus dem Altbestand, deren
        // Schaufenster es noch nicht gibt — fallen aus der Suche heraus statt
        // falsch positiv zu treffen. Gesucht wird ausschließlich über das,
        // was dieses Gerät schon selbst entschlüsselt hat, nie über den
        // Server. Über den Passwortwert wurde hier nie gesucht; seit der
        // Trennung liegt er dafür auch gar nicht mehr vor.
        if (!klar) return false;
        return klar.label.toLowerCase().includes(q)
          || klar.benutzername.toLowerCase().includes(q)
          || klar.url.toLowerCase().includes(q)
          || klar.notiz.toLowerCase().includes(q);
      })
      .sort((a, b) => b.geaendertAm - a.geaendertAm);
  }, [eintraege, schaufenster, suche]);

  useEffect(() => {
    if (ausgewaehlteId && !eintraege.some((e) => e.id === ausgewaehlteId)) setAusgewaehlteId(null);
  }, [ausgewaehlteId, eintraege]);

  const anlegen = async () => {
    setLegtAn(true);
    try {
      const eintrag = await passwortErstellen(leeresSchaufenster());
      setEintraege((s) => [eintrag, ...s]);
      setSchaufenster((s) => ({ ...s, [eintrag.id]: leeresSchaufenster() }));
      setFrischAngelegtId(eintrag.id);
      setAusgewaehlteId(eintrag.id);
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerAnlegen'), body: (fehler as Error).message });
    } finally {
      setLegtAn(false);
    }
  };

  /* Aus der Liste fliegt der Eintrag NUR, wenn der Server ihn wirklich
     gelöscht hat. Vorher stand das Entfernen hinter dem try/catch und lief
     auch nach einer Abweisung: ein geteiltes Mitglied drückte auf den
     Papierkorb, bekam die Meldung "Nur die besitzende Person löscht einen
     Tresoreintrag" — und der Eintrag verschwand trotzdem aus seiner Ansicht,
     bis zum nächsten Laden. Eine Oberfläche, die etwas anderes zeigt als der
     Server hat, ist in einem Tresor besonders teuer: sie lässt jemanden
     glauben, ein Zugang sei weg. */
  const loeschen = async (eintragId: string) => {
    try {
      await passwortLoeschen(eintragId);
      setEintraege((s) => s.filter((e) => e.id !== eintragId));
      setSchaufenster((s) => { const n = { ...s }; delete n[eintragId]; return n; });
      if (ausgewaehlteId === eintragId) setAusgewaehlteId(null);
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerLoeschen'), body: (fehler as Error).message });
    } finally {
      setLoeschenLaeuft(null);
    }
  };

  const aufAktualisiert = (eintrag: Passworteintrag, sicht?: PasswortSchaufenster) => {
    setEintraege((s) => s.map((e) => (e.id === eintrag.id ? eintrag : e)));
    if (sicht) setSchaufenster((s) => ({ ...s, [eintrag.id]: sicht }));
  };

  const ausgewaehlt = ausgewaehlteId ? eintraege.find((e) => e.id === ausgewaehlteId) ?? null : null;

  return (
    <Shell
      title={t('passwort.titel')}
      subtitle={t('passwort.untertitel')}
      icon={<Lock size={18} />}
      onClose={onClose}
      width={1040}
      actions={
        <button className="pill pill--accent" onClick={() => void anlegen()} disabled={legtAn}>
          {legtAn ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
          {t('passwort.neu')}
        </button>
      }
    >
      <div className="passwort">
        <div className="passwort__liste">
          <div className="files-search" style={{ marginBottom: 'var(--sp-2)' }}>
            <Search size={14} className="muted" />
            <input
              className="input input--bare"
              value={suche}
              placeholder={t('passwort.suchePlatzhalter')}
              onChange={(e) => setSuche(e.target.value)}
            />
          </div>

          {laedt && (
            <div className="hstack gap-2" style={{ padding: 'var(--sp-4) 0', justifyContent: 'center' }}>
              <Loader2 size={16} className="spin muted" />
            </div>
          )}

          {ladenFehler && !laedt && (
            <div className="empty-state">
              <AlertTriangle size={22} />
              <p>{ladenFehler}</p>
              <button className="btn" onClick={() => void laden()}>{t('common.retry')}</button>
            </div>
          )}

          {!laedt && !ladenFehler && !liste.length && (
            <div className="empty-state">
              <Lock size={26} className="muted" />
              <p>{t(suche ? 'passwort.keineTreffer' : 'passwort.leer')}</p>
            </div>
          )}

          {liste.map((e) => {
            const klar = schaufenster[e.id];
            const eigene = e.ownerId === self?.id;
            return (
              <button
                key={e.id}
                className="result"
                data-active={e.id === ausgewaehlteId}
                onClick={() => setAusgewaehlteId(e.id)}
              >
                <div className="result__main">
                  <div className="passwort-row__titel">
                    <span className="result__title truncate">
                      {/* Beim Altbestand steht hier bis zur Umstellung kein
                          Etikett: es liegt in derselben alten Hülle wie das
                          Passwort, und die reicht der Server nicht ohne
                          Vermerk heraus. Ein Klick stellt den Eintrag um. */}
                      {klar
                        ? (klar.label.trim() || t('passwort.ohneEtikett'))
                        : t(e.altbestand ? 'passwort.altbestand' : 'passwort.wirdEntschluesselt')}
                    </span>
                  </div>
                  <div className="result__sub truncate">
                    {!eigene && users[e.ownerId] && `${users[e.ownerId].displayName} · `}
                    {relativeTime(e.geaendertAm)}
                    {e.memberIds.length > 0 && ` · ${t('passwort.geteiltMitN', { n: e.memberIds.length })}`}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="passwort__editor">
          {!ausgewaehlt && (
            <div className="empty-state" style={{ height: '100%' }}>
              <Lock size={32} className="muted" />
              <p>{t('passwort.keineAusgewaehlt')}</p>
            </div>
          )}
          {ausgewaehlt && (
            <PasswortEditor
              key={ausgewaehlt.id}
              eintrag={ausgewaehlt}
              klartext={schaufenster[ausgewaehlt.id] ?? null}
              frischAngelegt={ausgewaehlt.id === frischAngelegtId}
              onAktualisiert={aufAktualisiert}
              onNeuLaden={laden}
              onLoeschenAnfragen={() => setLoeschenLaeuft(ausgewaehlt.id)}
            />
          )}
        </div>
      </div>

      {loeschenLaeuft && (
        <div className="scrim scrim--center" onClick={() => setLoeschenLaeuft(null)}>
          <div className="panel" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="panel__head">
              <AlertTriangle size={18} style={{ color: 'var(--rose)' }} />
              <h2>{t('passwort.loeschenTitel')}</h2>
            </div>
            <div className="panel__body">
              <p className="muted" style={{ marginTop: 0 }}>{t('passwort.loeschenText')}</p>
              <div className="hstack gap-2" style={{ marginTop: 'var(--sp-3)' }}>
                <button className="btn btn--danger" onClick={() => void loeschen(loeschenLaeuft)}>
                  <Trash2 size={15} /> {t('passwort.loeschenJa')}
                </button>
                <button className="btn btn--ghost" onClick={() => setLoeschenLaeuft(null)}>{t('common.cancel')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

/* ── Der Editor für einen einzelnen Eintrag ───────────────────── */

function PasswortEditor({ eintrag, klartext, frischAngelegt, onAktualisiert, onNeuLaden, onLoeschenAnfragen }: {
  eintrag: Passworteintrag;
  klartext: PasswortSchaufenster | null;
  /** Gerade in dieser Sitzung selbst angelegt — das Passwort ist bekannt
   *  leer, es muss dafür nichts geholt (und nichts vermerkt) werden. */
  frischAngelegt: boolean;
  onAktualisiert: (eintrag: Passworteintrag, sicht?: PasswortSchaufenster) => void;
  onNeuLaden: () => Promise<void>;
  onLoeschenAnfragen: () => void;
}) {
  const t = useT();
  const self = useStore((s) => s.self);
  const users = useStore((s) => s.users);

  const [inhalt, setInhalt] = useState<PasswortSchaufenster>(klartext ?? leeresSchaufenster());
  /**
   * Das Passwort — `null` heißt: NOCH NICHT GEHOLT, und dann steht im Feld
   * unten auch wirklich nichts. Nicht '' als Platzhalter für "haben wir
   * schon, zeigen wir nur nicht": genau diese Unterscheidung entscheidet, ob
   * ein automatisches Speichern das echte Passwort überschreibt (siehe
   * speichereJetzt() und lib/passwoerter.ts, passwortSpeichern()).
   */
  const [geheim, setGeheim] = useState<string | null>(frischAngelegt ? '' : null);
  const [geheimLaeuft, setGeheimLaeuft] = useState(false);
  const [sichtbar, setSichtbar] = useState(false);
  const [kopiert, setKopiert] = useState<'benutzername' | 'passwort' | null>(null);
  const [speichert, setSpeichert] = useState(false);
  const [konflikt, setKonflikt] = useState(false);
  const [mitgliedOffen, setMitgliedOffen] = useState(false);
  const [mitgliedSuche, setMitgliedSuche] = useState('');
  const [entfernenLaeuft, setEntfernenLaeuft] = useState<string | null>(null);
  const [verlaufOffen, setVerlaufOffen] = useState(false);
  const [verlauf, setVerlauf] = useState<PasswortOffenlegung[] | null>(null);
  const [totpKonten, setTotpKonten] = useState<{ id: string; bezeichnung: string }[] | null>(null);

  const eigenerPuffer = useRef(inhalt);
  eigenerPuffer.current = inhalt;
  const versionRef = useRef(eintrag.version);
  versionRef.current = eintrag.version;
  const timerRef = useRef<number | null>(null);
  const befuellt = useRef(Boolean(klartext));
  const geheimRef = useRef(geheim);
  geheimRef.current = geheim;
  const umstellenLaeuft = useRef(false);
  /* Gesetzt von „Übernehmen" im Konflikthinweis: der nächste frisch geladene
     Klartext ersetzt das Formular. Ohne das blieb der eigene, überholte Stand
     stehen, und das nächste automatische Speichern schrieb ihn mit der neuen
     Fassungsnummer still über den fremden — genau das Gegenteil von
     „Übernehmen". */
  const fremdenStandUebernehmen = useRef(false);

  useEffect(() => {
    if (!klartext) return;
    if (fremdenStandUebernehmen.current) {
      fremdenStandUebernehmen.current = false;
      befuellt.current = true;
      setInhalt(klartext);
      return;
    }
    if (befuellt.current) return;
    befuellt.current = true;
    setInhalt(klartext);
  }, [klartext]);

  /**
   * ALTBESTAND UMSTELLEN — einmal je Eintrag, beim ersten Auswählen.
   *
   * Ein Eintrag von vor der Trennung hat noch kein Schaufenster; sein
   * Etikett steckt in derselben Hülle wie das Passwort, und die reicht der
   * Server nicht über die Liste heraus. Er bleibt in der Liste deshalb ohne
   * Etikett, bis jemand ihn anklickt — dann wird die alte Hülle EINMAL
   * geholt (was vermerkt wird, weil ein Passwort dabei über die Leitung
   * geht), in zwei zerlegt und zurückgeschrieben. Danach nie wieder.
   *
   * Das Passwort landet dabei NICHT im Formular: `passwortUmstellen()` gibt
   * es gar nicht erst heraus. Wer einen Eintrag anklickt, hat nicht auf
   * "aufdecken" gedrückt.
   */
  useEffect(() => {
    if (!eintrag.altbestand || klartext || umstellenLaeuft.current) return;
    umstellenLaeuft.current = true;
    void (async () => {
      try {
        const umgestellt = await passwortUmstellen(eintrag);
        if (umgestellt) onAktualisiert(umgestellt.eintrag, umgestellt.schaufenster);
        else await onNeuLaden(); // ein zweites Gerät war schneller
      } catch (fehler) {
        umstellenLaeuft.current = false; // beim nächsten Auswählen neu versuchen
        useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerGeheimnis'), body: (fehler as Error).message });
      }
    })();
  }, [eintrag, klartext]);

  const speichereJetzt = (force = false) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!befuellt.current) return;
    setSpeichert(true);
    /* `geheimRef.current ?? undefined` und nicht `?? ''`: wurde das Passwort
       auf diesem Schirm nie geholt, darf dieser Aufruf das gespeicherte
       Geheimnis nicht anfassen. Mit '' schriebe jedes Ändern des Etiketts
       das Passwort weg — still, und erst beim nächsten Anmelden bemerkt. */
    void passwortSpeichern(
      eintrag.id, eigenerPuffer.current, versionRef.current, force, geheimRef.current ?? undefined,
    )
      .then((ergebnis) => {
        if (ergebnis.ok) {
          setKonflikt(false);
          versionRef.current = ergebnis.eintrag.version;
          onAktualisiert(ergebnis.eintrag);
        } else {
          setKonflikt(true);
        }
      })
      .catch((fehler) => {
        useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerSpeichern'), body: (fehler as Error).message });
      })
      .finally(() => setSpeichert(false));
  };

  useEffect(() => () => { if (timerRef.current) speichereJetzt(); }, [eintrag.id]);

  const geaendert = (teil: Partial<PasswortSchaufenster>) => {
    setInhalt((s) => ({ ...s, ...teil }));
    /* Sofort auch in den Puffer, nicht erst beim nächsten Rendern: die
       Einmalcode-Auswahl speichert gleich im selben Aufruf, und
       speichereJetzt() läse sonst noch den alten Stand — die neue
       Verknüpfung ginge nie hinaus. */
    eigenerPuffer.current = { ...eigenerPuffer.current, ...teil };
    spaeterSpeichern();
  };

  /** Getrennt vom Schaufenster, weil das Passwort in einer eigenen Hülle
   *  liegt — sonst nichts anders. */
  const geheimGeaendert = (wert: string) => {
    setGeheim(wert);
    geheimRef.current = wert;
    spaeterSpeichern();
  };

  function spaeterSpeichern() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => speichereJetzt(), 900);
  }

  const darfVerwalten = eintrag.ownerId === self?.id;

  const kandidaten = Object.values(users)
    .filter((u) => !u.disabled && !u.technisch && u.id !== eintrag.ownerId && !eintrag.memberIds.includes(u.id))
    .filter((u) => !mitgliedSuche
      || u.displayName.toLowerCase().includes(mitgliedSuche.toLowerCase())
      || u.handle.toLowerCase().includes(mitgliedSuche.toLowerCase()))
    .slice(0, 8);

  const hinzufuegen = async (userId: string) => {
    try {
      const eintragNeu = await passwortTeilen(eintrag.id, userId);
      onAktualisiert(eintragNeu);
      setMitgliedSuche('');
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerHinzufuegen'), body: (fehler as Error).message });
    }
  };

  const entfernen = async (userId: string) => {
    setEntfernenLaeuft(userId);
    try {
      const eintragNeu = await passwortMitgliedEntfernen(eintrag, userId, eigenerPuffer.current);
      onAktualisiert(eintragNeu);
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerEntfernen'), body: (fehler as Error).message });
    } finally {
      setEntfernenLaeuft(null);
    }
  };

  /**
   * Das Geheimnis holen. JEDER Aufruf ist eine Aushändigung und steht danach
   * im Verlauf — der Server schreibt die Zeile beim Ausliefern, nicht diese
   * Tafel hinterher. Ein unterdrückter Aufruf liefert deshalb kein Passwort
   * mehr, statt eines ohne Spur zu liefern.
   */
  const geheimnisHolen = async (): Promise<string> => {
    setGeheimLaeuft(true);
    try {
      const { passwort, umgestellt } = await passwortGeheimnisHolen(eintrag);
      if (umgestellt) onAktualisiert(umgestellt.eintrag, umgestellt.schaufenster);
      return passwort;
    } finally {
      setGeheimLaeuft(false);
    }
  };

  /**
   * Aufdecken holt, Verdecken nicht.
   *
   * Scheitert das Holen, bleibt das Feld verdeckt UND leer, und es gibt eine
   * Meldung. Vorher lief der Fehlschlag in ein leeres `catch` und die
   * Anzeige klappte trotzdem — das ging nur, solange der Klartext ohnehin
   * schon dalag. Er liegt nicht mehr da, und ein aufgedecktes leeres Feld
   * wäre die schlechteste aller Antworten: es sähe aus wie ein Eintrag ohne
   * Passwort.
   */
  const aufdecken = async () => {
    if (sichtbar) { setSichtbar(false); return; }
    try {
      const passwort = await geheimnisHolen();
      setGeheim(passwort);
      geheimRef.current = passwort;
      setSichtbar(true);
    } catch (fehler) {
      setSichtbar(false);
      useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerGeheimnis'), body: (fehler as Error).message });
    }
  };

  const kopierenBenutzername = async () => {
    try {
      await navigator.clipboard.writeText(inhalt.benutzername);
      setKopiert('benutzername');
      setTimeout(() => setKopiert((v) => (v === 'benutzername' ? null : v)), 1500);
    } catch { /* keine Zwischenablage-Erlaubnis — kein Absturz */ }
  };

  /* KOPIEREN HOLT IMMER NEU, auch wenn gerade aufgedeckt ist. Es ist ein
     zweiter Weg an den Wert — in die Zwischenablage, auf einem Mac über die
     geräteübergreifende Ablage bis aufs Telefon — und er wird wie der erste
     vermerkt. Ihn nur deshalb nicht zu vermerken, weil der Wert schon auf dem
     Schirm steht, hieße das Protokoll wieder von der Anzeige abhängig zu
     machen; genau das war der Defekt.

     Der geholte Wert wird ABSICHTLICH nicht in `geheim` abgelegt: wer nur
     kopiert, hat nicht aufgedeckt, und dann soll auch nichts im Formular
     stehen.

     Dasselbe try/catch wie bei kopierenBenutzername darüber — es fehlte hier,
     und der Aufruf steht als `void kopierenPasswort()` am Knopf: ein
     Fehlschlag beim Schreiben wurde damit zu einer unbehandelten Zusage, das
     Häkchen erschien nicht, und die Person stand vor einem Knopf, der
     scheinbar nichts tat.

     Und die zweite Ehrlichkeit: kann diese Ansicht die Zwischenablage nicht
     selbst wieder leeren (Browser, ältere App-Fassung), wird das gesagt statt
     verschwiegen — vorher am Feld unten, hier noch einmal beim Kopieren.
     Genauso, wenn das Aufräumen zwanzig Sekunden später doch scheitert. */
  const kopierenPasswort = async () => {
    let passwort: string;
    try {
      passwort = await geheimnisHolen();
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerGeheimnis'), body: (fehler as Error).message });
      return;
    }
    try {
      const selbstloeschend = await kopierenUndLoeschen(passwort, () => {
        useStore.getState().toast({
          kind: 'error',
          title: t('passwort.ablageNichtGeleertTitel'),
          body: t('passwort.ablageNichtGeleertText'),
        });
      });
      setKopiert('passwort');
      setTimeout(() => setKopiert((v) => (v === 'passwort' ? null : v)), 1500);
      if (!selbstloeschend) {
        useStore.getState().toast({
          kind: 'info',
          title: t('passwort.ablageBleibtTitel'),
          body: t('passwort.ablageBleibtText'),
        });
      }
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerKopieren'), body: (fehler as Error).message });
    }
  };

  const geaendertVonName = users[eintrag.geaendertVon]?.displayName ?? '—';

  const verlaufLaden = async () => {
    setVerlaufOffen((v) => !v);
    if (verlauf) return;
    try {
      const { offenlegungen } = await api.passwortOffenlegungen(eintrag.id);
      setVerlauf(offenlegungen);
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('passwort.fehlerVerlauf'), body: (fehler as Error).message });
    }
  };

  // Nur, wenn diese Person auch den Einmalcode-Reiter benutzen darf — sonst
  // führte die Verknüpfung nur gegen eine 403-Antwort.
  const darfEinmalcode = Boolean(self?.permissions['einmalcode.nutzen']);
  useEffect(() => {
    if (!darfEinmalcode) return;
    let abgebrochen = false;
    (async () => {
      try {
        const nachweis = token();
        const res = await fetch(`${serverUrl()}/api/einmalcode`, {
          headers: nachweis ? { authorization: `Bearer ${nachweis}` } : {},
        });
        if (!res.ok) return;
        const daten = await res.json() as { konten: { id: string; bezeichnung: string }[] };
        if (!abgebrochen) setTotpKonten(daten.konten.map((k) => ({ id: k.id, bezeichnung: k.bezeichnung })));
      } catch { /* Reiter bleibt einfach ohne Vorschlagsliste */ }
    })();
    return () => { abgebrochen = true; };
  }, [darfEinmalcode]);

  if (!klartext) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Loader2 size={22} className="spin muted" />
        {/* Beim Altbestand läuft hier gerade die einmalige Umstellung. */}
        <p>{t('passwort.wirdEntschluesselt')}</p>
      </div>
    );
  }

  const totpName = inhalt.totpKontoId ? totpKonten?.find((k) => k.id === inhalt.totpKontoId)?.bezeichnung : null;

  return (
    <>
      <input
        className="passwort__label-feld"
        value={inhalt.label}
        placeholder={t('passwort.etikettPlatzhalter')}
        onChange={(e) => geaendert({ label: e.target.value })}
        onBlur={() => speichereJetzt()}
      />

      {konflikt && (
        <div className="hinweis" style={{ marginBottom: 'var(--sp-3)', alignItems: 'flex-start', borderColor: 'rgba(251,191,36,.4)', background: 'rgba(251,191,36,.12)' }}>
          <AlertTriangle size={14} style={{ flex: 'none', marginTop: 2, color: 'var(--amber)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('passwort.konfliktTitel')}</div>
            <div style={{ fontSize: 12.5, opacity: 0.9 }}>{t('passwort.konfliktText')}</div>
            <div className="hstack gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <button
                className="btn"
                onClick={() => {
                  if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
                  /* Auch das Passwort zurück auf „nicht geholt": ein hier
                     aufgedeckter, alter Wert schriebe sonst beim nächsten
                     Speichern ein inzwischen geändertes Passwort weg. */
                  setGeheim(null);
                  geheimRef.current = null;
                  setSichtbar(false);
                  fremdenStandUebernehmen.current = true;
                  setKonflikt(false);
                  void onNeuLaden();
                }}
              >
                {t('passwort.konfliktUebernehmen')}
              </button>
              <button className="btn btn--danger" onClick={() => speichereJetzt(true)}>
                {t('passwort.konfliktUeberschreiben')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="field">
        <label className="field__label">{t('passwort.benutzername')}</label>
        <div className="passwort__feld-zeile">
          <input
            className="input"
            value={inhalt.benutzername}
            placeholder={t('passwort.benutzernamePlatzhalter')}
            autoComplete="off"
            onChange={(e) => geaendert({ benutzername: e.target.value })}
            onBlur={() => speichereJetzt()}
          />
          <button className="icon-btn" aria-label={t('passwort.kopieren')} onClick={() => void kopierenBenutzername()}>
            {kopiert === 'benutzername' ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </div>
      </div>

      <div className="field">
        <label className="field__label">{t('passwort.passwort')}</label>
        <div className="passwort__feld-zeile">
          {/* `geheim ?? ''` — solange nichts geholt wurde, steht hier
              wirklich nichts. Ein verdecktes Feld mit echtem Wert dahinter
              war der eigentliche Defekt: die Punkte täuschen eine Schranke
              vor, die es im Seiteninhalt nicht gibt.

              `readOnly`, bis geholt wurde: sonst tippte jemand in ein leeres
              Feld, das nächste automatische Speichern nähme das für den
              neuen Wert und das echte Passwort wäre weg. Wer es ändern will,
              deckt vorher auf — und genau das ist die Handlung, die vermerkt
              gehört. */}
          <input
            className="input passwort__geheim"
            type={sichtbar ? 'text' : 'password'}
            value={geheim ?? ''}
            readOnly={geheim === null}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(e) => geheimGeaendert(e.target.value)}
            onBlur={() => speichereJetzt()}
          />
          <button
            className="icon-btn"
            aria-label={t(sichtbar ? 'passwort.verdecken' : 'passwort.aufdecken')}
            disabled={geheimLaeuft}
            onClick={() => void aufdecken()}
          >
            {geheimLaeuft ? <Loader2 size={15} className="spin" /> : sichtbar ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <button
            className="icon-btn"
            aria-label={t('passwort.kopieren')}
            disabled={geheimLaeuft}
            onClick={() => void kopierenPasswort()}
          >
            {kopiert === 'passwort' ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </div>
        {geheim === null && <p className="field__hint">{t('passwort.geheimVerborgen')}</p>}
        <p className="field__hint">
          {ablageLoeschbar() ? t('passwort.kopierenHinweis') : t('passwort.kopierenHinweisOhneLoeschung')}
        </p>
      </div>

      <div className="field">
        <label className="field__label">{t('passwort.url')}</label>
        <div className="passwort__feld-zeile">
          <input
            className="input"
            value={inhalt.url}
            placeholder={t('passwort.urlPlatzhalter')}
            autoComplete="off"
            onChange={(e) => geaendert({ url: e.target.value })}
            onBlur={() => speichereJetzt()}
          />
          {inhalt.url.trim() && istHttpUrl(inhalt.url.trim()) && (
            <a className="icon-btn" aria-label={t('passwort.oeffnen')} href={inhalt.url.trim()} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={15} />
            </a>
          )}
        </div>
      </div>

      <div className="field">
        <label className="field__label">{t('passwort.notiz')}</label>
        <textarea
          className="textarea"
          value={inhalt.notiz}
          placeholder={t('passwort.notizPlatzhalter')}
          rows={3}
          onChange={(e) => geaendert({ notiz: e.target.value })}
          onBlur={() => speichereJetzt()}
        />
      </div>

      {darfEinmalcode && (
        <div className="field">
          <label className="field__label">{t('passwort.totpVerknuepfung')}</label>
          <div className="passwort__feld-zeile">
            <select
              className="input"
              value={inhalt.totpKontoId ?? ''}
              onChange={(e) => { geaendert({ totpKontoId: e.target.value || null }); speichereJetzt(); }}
            >
              <option value="">{t('passwort.totpKeine')}</option>
              {totpKonten?.map((k) => (
                <option key={k.id} value={k.id}>{k.bezeichnung}</option>
              ))}
            </select>
            {inhalt.totpKontoId && (
              <button
                className="icon-btn"
                aria-label={t('passwort.totpOeffnen')}
                onClick={() => useEinmalcodeUi.getState().oeffnen(inhalt.totpKontoId ?? undefined)}
              >
                <KeyRound size={15} />
              </button>
            )}
          </div>
          {totpName && <p className="field__hint">{t('passwort.totpVerknuepftMit', { name: totpName })}</p>}
        </div>
      )}

      <div className="passwort__werkzeuge">
        <span className="muted" style={{ fontSize: 11.5 }}>
          {speichert
            ? <><Loader2 size={11} className="spin" style={{ verticalAlign: -1, marginInlineEnd: 4 }} />{t('passwort.speichertGerade')}</>
            : t('passwort.geaendertVon', { name: geaendertVonName, zeit: relativeTime(eintrag.geaendertAm) })}
        </span>

        <button className={clsx('pill', mitgliedOffen && 'pill--accent')} onClick={() => setMitgliedOffen((v) => !v)} style={{ marginInlineStart: 'auto' }}>
          <Users size={13} />
          {t('passwort.zugriff')}{eintrag.memberIds.length > 0 ? ` · ${eintrag.memberIds.length + 1}` : ''}
        </button>
        {darfVerwalten && (
          <button className={clsx('pill', verlaufOffen && 'pill--accent')} onClick={() => void verlaufLaden()}>
            <History size={13} /> {t('passwort.verlauf')}
          </button>
        )}
        {/* Nur der besitzenden Person: der Server weist jeden anderen ab
            (fehler.passwortNurBesitzerLoescht), und ein Knopf, der
            zuverlässig in eine Fehlermeldung führt, ist kein Angebot,
            sondern eine Falle. Dieselbe Bedingung wie beim Verlauf und beim
            Verwalten der Mitglieder darüber. Die Prüfung im Server bleibt
            trotzdem die maßgebliche — hier verschwindet nur der Knopf. */}
        {darfVerwalten && (
          <button className="icon-btn icon-btn--danger" title={t('passwort.loeschen')} aria-label={t('passwort.loeschen')} onClick={onLoeschenAnfragen}>
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {verlaufOffen && darfVerwalten && (
        <div style={{ marginTop: 'var(--sp-3)', paddingTop: 'var(--sp-3)', borderTop: '1px solid var(--line)' }}>
          <div className="ai-section__title">{t('passwort.verlauf')}</div>
          {/* Der Hinweis sagt jetzt, was die Zeilen wirklich belegen: das
              HOLEN, nicht das Wissen. Was danach mit einem Passwort geschah,
              steht hier nicht und kann hier nicht stehen. */}
          <p className="field__hint" style={{ marginTop: 0 }}>{t('passwort.verlaufHinweis')}</p>
          {verlauf === null && <Loader2 size={14} className="spin muted" />}
          {verlauf?.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>{t('passwort.verlaufLeer')}</p>}
          <div className="passwort__offenlegungen">
            {verlauf?.map((o) => (
              <div key={o.id}>
                {t('passwort.verlaufZeile', { name: users[o.userId]?.displayName ?? '—', zeit: relativeTime(o.am) })}
              </div>
            ))}
          </div>
        </div>
      )}

      {mitgliedOffen && (
        <div style={{ marginTop: 'var(--sp-3)', paddingTop: 'var(--sp-3)', borderTop: '1px solid var(--line)' }}>
          <div className="ai-section__title">{t('passwort.zugriff')}</div>

          <div className="row">
            <Avatar user={users[eintrag.ownerId]} size={26} />
            <div className="row__main" style={{ marginLeft: 10 }}>
              <div className="row__title">{users[eintrag.ownerId]?.displayName ?? '—'}</div>
              <div className="row__sub">{t('passwort.besitzt')}</div>
            </div>
          </div>

          {eintrag.memberIds.map((uid) => (
            <div className="row" key={uid}>
              <Avatar user={users[uid]} size={26} />
              <div className="row__main" style={{ marginLeft: 10 }}>
                <div className="row__title">{users[uid]?.displayName ?? '—'}</div>
              </div>
              {darfVerwalten && (
                <button
                  className="icon-btn"
                  title={t('passwort.entfernen')}
                  aria-label={t('passwort.entfernen')}
                  disabled={entfernenLaeuft === uid}
                  onClick={() => {
                    if (confirm(t('passwort.entfernenBestaetigen', { name: users[uid]?.displayName ?? '—' }))) {
                      void entfernen(uid);
                    }
                  }}
                >
                  {entfernenLaeuft === uid ? <Loader2 size={14} className="spin" /> : <UserMinus size={15} />}
                </button>
              )}
            </div>
          ))}

          {eintrag.ehemaligeMitglieder.length > 0 && (
            <div className="passwort__ehemalige">
              {t('passwort.ehemalige', {
                namen: eintrag.ehemaligeMitglieder.map((m) => users[m.userId]?.displayName ?? '—').join(', '),
              })}
            </div>
          )}

          {darfVerwalten && (
            <div className="field" style={{ marginTop: 'var(--sp-3)' }}>
              <input
                className="input"
                value={mitgliedSuche}
                placeholder={t('passwort.personSuchen')}
                onChange={(e) => setMitgliedSuche(e.target.value)}
              />
              {mitgliedSuche && kandidaten.map((u) => (
                <button key={u.id} className="result" style={{ marginTop: 4 }} onClick={() => void hinzufuegen(u.id)}>
                  <Avatar user={u} size={24} />
                  <div className="result__main">
                    <div className="result__title">{u.displayName}</div>
                    <div className="result__sub">@{u.handle}</div>
                  </div>
                  <UserPlus size={15} className="muted" />
                </button>
              ))}
            </div>
          )}

          <p className="field__hint" style={{ marginTop: 'var(--sp-3)' }}>{t('passwort.entfernenHinweis')}</p>
        </div>
      )}
    </>
  );
}
