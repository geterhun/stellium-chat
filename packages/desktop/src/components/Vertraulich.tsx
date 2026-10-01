import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle, Check, Copy, KeyRound, Loader2, Lock, ShieldAlert, X,
} from 'lucide-react';
import {
  FREIGABE_TAGE_HOECHSTENS, FREIGABE_TAGE_VORGABE,
  istWiederherstellungscode, wiederherstellungNormalisieren,
  type Attachment,
} from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { currentUiLanguage, useT } from '../i18n/index.js';
import {
  dateiAnzeigen, freigabeOeffnen, istE2EChiffrat, kanalVertraulichStellen, meinAbdruck,
  mitCodeWiederherstellen, nachrichtEntschluesseln, vorfallMelden,
  wiederherstellungscodeErzeugen,
} from '../lib/vertraulich.js';

/**
 * Die Oberfläche zu den vertraulichen Kanälen.
 *
 * Alles, was mit Schlüsseln zu tun hat, steht hier zusammen statt verstreut in
 * den sechs Komponenten, die es zeigen. Der Grund ist nicht Ordnungsliebe: die
 * Zusagen, die diese Oberfläche macht — „der Server sieht nichts", „ohne Code
 * ist nach dem Gerätewechsel Schluss", „die Freigabe ist im Kanal sichtbar" —
 * müssen an jeder Stelle dieselben sein. Stehen sie an einem Ort, fällt es
 * auf, wenn eine davon nicht mehr stimmt.
 *
 * Was hier bewusst NICHT vorkommt: ein Weg zurück. Ein Kanal, der einmal
 * vertraulich war, bleibt es. Der Server könnte ihn zwar wieder öffnen, aber
 * der bisherige Verlauf bliebe verschlüsselt — und ein Kanal, in dem die
 * Hälfte lesbar ist und die andere nicht, ist schlimmer als beides einzeln.
 */

/* ── Merkzettel auf dem Gerät ─────────────────────────────────── */

/**
 * Ob dieses Gerät den Wiederherstellungscode schon einmal ausgegeben hat.
 *
 * Nur ein Merkzettel für die Oberfläche, kein Sicherheitsmerkmal — er
 * entscheidet allein darüber, ob der Hinweis noch angeboten wird. Wer ihn
 * wegräumt, verliert nichts als den Hinweis.
 */
const SCHL_GESICHERT = 'stellium.vertraulich.gesichert';

export function codeGesichert(): boolean {
  try { return localStorage.getItem(SCHL_GESICHERT) === 'ja'; } catch { return false; }
}

function codeGesichertMerken(): void {
  try { localStorage.setItem(SCHL_GESICHERT, 'ja'); } catch { /* voll oder gesperrt */ }
}

/* ── Einstellungen an der richtigen Stelle öffnen ─────────────── */

/**
 * Welcher Reiter der Einstellungen als nächstes gemeint ist.
 *
 * Der Hinweis im Kanal soll nicht irgendwo in den Einstellungen landen,
 * sondern beim Wiederherstellungscode. Eine Modulvariable statt eines
 * Zustandsfelds, weil der Wunsch genau einen Wimpernschlag lang gilt: bis die
 * Einstellungen ihn abgeholt haben.
 */
let reiterWunsch = false;

export function vertraulichEinstellungenOeffnen(): void {
  reiterWunsch = true;
  useStore.getState().setOverlay('settings');
}

export function reiterWunschAbholen(): boolean {
  const wunsch = reiterWunsch;
  reiterWunsch = false;
  return wunsch;
}

/* ── Entschlüsseln für die Anzeige ────────────────────────────── */

/**
 * Klartext einer Nachricht — oder der ehrliche Hinweis, dass er fehlt.
 *
 * Entschlüsselt wird beim Anzeigen und nicht beim Empfangen. Das kostet einen
 * Rendervorgang mehr, hat aber einen Vorteil, der ihn aufwiegt: der Zustand
 * trägt weiter das, was der Server geschickt hat. Käme dort schon Klartext an,
 * ließe sich nie wieder nachvollziehen, ob eine Nachricht verschlüsselt war.
 *
 * Der Takt aus dem Zustand steht in den Abhängigkeiten, weil ein Schlüssel
 * später eintreffen kann als die Nachricht — direkt nach einem Gerätewechsel
 * ist genau das der Normalfall. Ohne ihn bliebe „nicht lesbar" stehen, bis
 * jemand den Kanal neu öffnet.
 */
export function useKlartext(channelId: string, roh: string): {
  text: string; unlesbar: boolean; laeuft: boolean;
} {
  const chiffrat = istE2EChiffrat(roh);
  const takt = useStore((s) => s.vertraulichTakt);
  const [klar, setKlar] = useState<string | null>(chiffrat ? null : roh);
  const [unlesbar, setUnlesbar] = useState(false);

  useEffect(() => {
    if (!chiffrat) { setKlar(roh); setUnlesbar(false); return; }
    let gilt = true;
    void nachrichtEntschluesseln(channelId, roh).then((text) => {
      if (!gilt) return;
      setUnlesbar(text === null);
      setKlar(text ?? '');
    });
    return () => { gilt = false; };
  }, [channelId, roh, chiffrat, takt]);

  return { text: klar ?? '', unlesbar, laeuft: chiffrat && klar === null };
}

/* ── Verschlossene Anhänge anzeigen ───────────────────────────── */

/**
 * Eine verschlüsselte Datei so weit bringen, dass die Oberfläche sie zeigen
 * kann — oder der ehrliche Hinweis, dass der Schlüssel fehlt.
 *
 * Der Server kann diese Datei nicht ausliefern wie ein Bild: was bei ihm liegt,
 * ist Chiffrat, und ein `<img src>` darauf ergäbe ein kaputtes Bild. Also holt
 * die App sie, schließt sie auf und macht daraus eine Adresse, die der Browser
 * versteht.
 *
 * Denselben Takt wie useKlartext im Auge: ein Kanalschlüssel kann nach dem
 * Anhang eintreffen, und dann soll das Bild erscheinen, statt „nicht lesbar"
 * stehen zu bleiben.
 */
export function useVerschlosseneDatei(anhang: Attachment): {
  url: string | null; name: string; mime: string; unlesbar: boolean; laeuft: boolean;
} {
  const takt = useStore((s) => s.vertraulichTakt);
  const verschlossen = Boolean(anhang.huelle);
  const [stand, setStand] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [unlesbar, setUnlesbar] = useState(false);

  useEffect(() => {
    if (!verschlossen) return;
    let gilt = true;
    setUnlesbar(false);
    void dateiAnzeigen(anhang.id, anhang.url)
      .then(({ kopf, url }) => {
        if (!gilt) return;
        setStand({ url, name: kopf.name, mime: kopf.mime });
      })
      .catch(() => { if (gilt) setUnlesbar(true); });
    return () => { gilt = false; };
    /* Die Adresse wird hier bewusst nicht wieder freigegeben. Sie gehört dem
       Merkzettel in lib/vertraulich.ts, der sie über die ganze Sitzung hält —
       eine Nachrichtenliste baut ihre Zeilen beim Scrollen dauernd neu auf,
       und beim Aufräumen hier wäre das Bild nach dem ersten Wegscrollen weg. */
  }, [anhang.id, anhang.url, verschlossen, takt]);

  if (!verschlossen) {
    return { url: null, name: anhang.name, mime: anhang.mime, unlesbar: false, laeuft: false };
  }
  return {
    url: stand?.url ?? null,
    name: stand?.name ?? anhang.name,
    mime: stand?.mime ?? anhang.mime,
    unlesbar,
    laeuft: !stand && !unlesbar,
  };
}

/* ── Kanal vertraulich stellen ────────────────────────────────── */

/**
 * Der Abschnitt in den Kanaleinstellungen.
 *
 * Der Preis steht oben und nicht in der Rückfrage: wer erst nach dem Klick
 * erfährt, dass Übersetzung und KI wegfallen, hat die Entscheidung schon
 * getroffen. Die Rückfrage wiederholt ihn nur.
 */
export function VertraulichAbschnitt({ channelId }: { channelId: string }) {
  const t = useT();
  const channel = useStore((s) => s.channels[channelId]);
  const self = useStore((s) => s.self);
  const [fragen, setFragen] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const rueckfrage = useRef<HTMLDivElement>(null);

  /* Auf dem Telefon steht der Schalter am unteren Rand des sichtbaren
     Bereichs — die Rückfrage öffnet sich darunter und wäre unsichtbar. Ein
     Klick, der nichts zu bewirken scheint, ist hier der schlechteste
     Ausgang. */
  useEffect(() => {
    if (fragen) rueckfrage.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [fragen]);

  if (!channel || channel.kind === 'dm') return null;

  const darf = Boolean(self?.permissions['vertraulich.kanal']);

  const titel = (
    <div className="ai-section__title" style={{ marginTop: 'var(--sp-5)' }}>
      <Lock size={12} style={{ verticalAlign: -2, marginRight: 6 }} />
      {t('vertraulich.titel')}
    </div>
  );

  if (channel.vertraulich) {
    return (
      <>
        {titel}
        <div className="row">
          <div className="row__main">
            <div className="row__title" style={{ color: 'var(--violet-soft)' }}>{t('vertraulich.abzeichen')}</div>
            <div className="row__sub">{t('vertraulich.hinweis')}</div>
          </div>
          <Lock size={16} style={{ color: 'var(--violet-soft)' }} />
        </div>
        <p className="field__hint" style={{ marginTop: 'var(--sp-3)' }}>{t('vertraulich.kosten')}</p>
        <p className="field__hint">{t('vertraulich.endgueltig')}</p>
        <div className="hstack gap-2" style={{ marginTop: 'var(--sp-3)', flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => useStore.getState().setOverlay('vorfall')}>
            <ShieldAlert size={15} /> {t('vorfall.melden')}
          </button>
          <button className="btn" onClick={() => useStore.getState().setOverlay('freigaben')}>
            <KeyRound size={15} /> {t('freigabe.titel')}
          </button>
        </div>
      </>
    );
  }

  /* Offene Kanäle nimmt der Server nicht an — ein Kanal, den jede:r betreten
     darf, und einer, der ohne Schlüssel niemanden hereinlässt, sind zwei
     verschiedene Dinge. Den Schalter dort anzubieten hieße, ihn ins Leere
     laufen zu lassen. */
  if (!darf || channel.kind !== 'private') return null;

  return (
    <>
      {titel}
      <div className="row">
        <div className="row__main">
          <div className="row__title">{t('vertraulich.ein')}</div>
          <div className="row__sub">{t('vertraulich.hinweis')}</div>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={false}
          aria-label={t('vertraulich.ein')}
          disabled={laeuft}
          onClick={() => setFragen(true)}
        />
      </div>

      {/* Vor dem Klick sichtbar, nicht erst danach. */}
      <div
        className="hinweis"
        style={{ marginTop: 'var(--sp-3)', alignItems: 'flex-start' }}
      >
        <AlertTriangle size={14} style={{ flex: 'none', marginTop: 2 }} />
        <div>
          <div>{t('vertraulich.kosten')}</div>
          <div style={{ marginTop: 5, opacity: 0.9 }}>{t('vertraulich.endgueltig')}</div>
        </div>
      </div>

      {fragen && (
        <motion.div
          ref={rueckfrage}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="hinweis"
          style={{
            alignItems: 'flex-start',
            borderColor: 'rgba(124,92,255,.4)', background: 'rgba(124,92,255,.12)',
            color: 'var(--violet-soft)',
          }}
        >
          <Lock size={14} style={{ flex: 'none', marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('vertraulich.bestaetigen')}</div>
            <div style={{ fontSize: 12.5, opacity: 0.9 }}>{t('vertraulich.endgueltig')}</div>
            <div className="hstack gap-2" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <button
                className="btn btn--primary"
                disabled={laeuft}
                onClick={async () => {
                  setLaeuft(true);
                  try {
                    await kanalVertraulichStellen(channelId, channel.memberIds);
                    setFragen(false);
                  } catch (fehler) {
                    useStore.getState().toast({
                      kind: 'error', title: t('vertraulich.titel'), body: (fehler as Error).message,
                    });
                  } finally {
                    setLaeuft(false);
                  }
                }}
              >
                {laeuft ? <Loader2 size={15} className="spin" /> : <Lock size={15} />}
                {t('vertraulich.bestaetigen')}
              </button>
              <button className="btn btn--ghost" onClick={() => setFragen(false)}>{t('common.cancel')}</button>
            </div>
          </div>
        </motion.div>
      )}
    </>
  );
}

/* ── Der Hinweis auf den Wiederherstellungscode ───────────────── */

/**
 * Steht im Kanal, nicht im Untermenü.
 *
 * Der Wiederherstellungscode ist genau einmal wirklich wichtig: beim ersten
 * vertraulichen Kanal. Danach denkt niemand mehr daran — bis das Gerät weg ist
 * und mit ihm jeder vertrauliche Kanal. Deshalb steht das Angebot dort, wo die
 * Entscheidung gerade gefallen ist.
 */
export function WiederherstellungHinweis({ channelId }: { channelId: string }) {
  const t = useT();
  const vertraulich = useStore((s) => s.channels[channelId]?.vertraulich);
  const [weg, setWeg] = useState(() => codeGesichert());

  if (!vertraulich || weg) return null;

  return (
    <motion.div
      className="hinweis"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ margin: 'var(--sp-3) var(--sp-4) 0', alignItems: 'flex-start' }}
    >
      <KeyRound size={14} style={{ flex: 'none', marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{t('wieder.jetztSichern')}</div>
        <div className="hstack gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => vertraulichEinstellungenOeffnen()}>
            <KeyRound size={14} /> {t('wieder.erzeugen')}
          </button>
          <button className="btn btn--ghost" onClick={() => setWeg(true)}>{t('common.close')}</button>
        </div>
      </div>
    </motion.div>
  );
}

/* ── Einstellungen: Abdruck, Code, Freigaben ──────────────────── */

export function VertraulichEinstellungen() {
  const t = useT();
  const self = useStore((s) => s.self);
  const takt = useStore((s) => s.vertraulichTakt);
  const [abdruck, setAbdruck] = useState('');

  useEffect(() => { void meinAbdruck().then(setAbdruck); }, [takt]);

  return (
    <>
      <div className="field">
        <label className="field__label">{t('vertraulich.abdruck')}</label>
        <div className="zugang">
          <div className="zugang__zeile">
            <span className="zugang__label">{self?.displayName ?? ''}</span>
            <span className="zugang__wert zugang__wert--gross mono">{abdruck || '····'}</span>
          </div>
        </div>
        <p className="field__hint">{t('vertraulich.abdruckHinweis')}</p>
      </div>

      <WiederherstellungKarte />

      {self?.permissions['vertraulich.freigabe_lesen'] && <FreigabenListe channelId={null} />}
    </>
  );
}

/** Code erzeugen und Code einlösen — beide Richtungen an einer Stelle. */
function WiederherstellungKarte() {
  const t = useT();
  const [code, setCode] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [kopiert, setKopiert] = useState(false);
  const [eingabe, setEingabe] = useState('');
  const [einloesen, setEinloesen] = useState(false);

  const erzeugen = async () => {
    setLaeuft(true);
    try {
      setCode(await wiederherstellungscodeErzeugen());
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('wieder.titel'), body: (fehler as Error).message });
    } finally {
      setLaeuft(false);
    }
  };

  const kopieren = () => {
    if (!code) return;
    void navigator.clipboard.writeText(code);
    setKopiert(true);
    window.setTimeout(() => setKopiert(false), 2200);
  };

  return (
    <>
      <div className="ai-section__title" style={{ marginTop: 'var(--sp-5)' }}>
        <KeyRound size={12} style={{ verticalAlign: -2, marginRight: 6 }} />
        {t('wieder.titel')}
      </div>

      <div className="hinweis" style={{ alignItems: 'flex-start' }}>
        <AlertTriangle size={14} style={{ flex: 'none', marginTop: 2 }} />
        <div>{t('wieder.hinweis')}</div>
      </div>

      {code ? (
        <>
          <div className="zugang">
            {/* Sechs Vierergruppen, zwei Zeilen auf dem Telefon, eine auf dem
                Schirm — abgeschrieben wird er in jedem Fall von Hand. */}
            <div
              className="zugang__zeile"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: 8 }}
            >
              {code.split('-').map((gruppe, i) => (
                <span
                  key={`${gruppe}-${i}`}
                  className="zugang__wert zugang__wert--gross mono"
                  style={{ textAlign: 'center' }}
                >{gruppe}</span>
              ))}
            </div>
          </div>

          <button className="btn btn--primary btn--block" onClick={kopieren}>
            {kopiert ? <Check size={16} /> : <Copy size={16} />}
            {kopiert ? t('team.copied') : t('protocol.copy')}
          </button>

          <p className="field__hint" style={{ marginTop: 'var(--sp-3)' }}>{t('wieder.einmalig')}</p>

          <button
            className="btn btn--block"
            style={{ marginTop: 'var(--sp-3)' }}
            onClick={() => { codeGesichertMerken(); setCode(null); }}
          >
            <Check size={15} /> {t('wieder.notiert')}
          </button>
        </>
      ) : (
        <button className="btn btn--primary" disabled={laeuft} onClick={() => void erzeugen()}>
          {laeuft ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
          {t('wieder.erzeugen')}
        </button>
      )}

      <div className="field" style={{ marginTop: 'var(--sp-5)' }}>
        <label className="field__label">{t('wieder.einloesen')}</label>
        <div className="hstack gap-2" style={{ flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: '1 1 220px' }}
            value={eingabe}
            placeholder={t('wieder.eingabe')}
            onChange={(e) => setEingabe(wiederherstellungNormalisieren(e.target.value))}
          />
          <button
            className="btn"
            disabled={einloesen || !istWiederherstellungscode(eingabe)}
            onClick={async () => {
              setEinloesen(true);
              const gelungen = await mitCodeWiederherstellen(eingabe);
              setEinloesen(false);
              useStore.getState().toast({
                kind: gelungen ? 'ok' : 'error',
                title: t('wieder.titel'),
                body: gelungen ? t('wieder.gelungen') : t('wieder.misslungen'),
              });
              if (gelungen) { setEingabe(''); useStore.getState().vertraulichNeuLesen(); }
            }}
          >
            {einloesen ? <Loader2 size={15} className="spin" /> : null}
            {t('wieder.einloesen')}
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Vorfall melden ───────────────────────────────────────────── */

/**
 * Den Kanal für die Verwaltung öffnen.
 *
 * Der Code entsteht auf diesem Gerät und wird genau einmal gezeigt. Deshalb
 * schließt der Dialog nach dem Melden nicht von selbst — wer ihn wegklickt,
 * hat den Code verloren, und das muss dabeistehen, bevor jemand klickt.
 */
export function VorfallDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const [grund, setGrund] = useState('');
  const [tage, setTage] = useState(FREIGABE_TAGE_VORGABE);
  const [laeuft, setLaeuft] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [kopiert, setKopiert] = useState(false);

  // Wer zur Verwaltung gehört, weiß der Server genau; die App kennt nur die
  // Rollen. Sie packt für alle, die in Frage kommen — der Server wirft weg,
  // was nicht passt, und niemand bekommt dadurch mehr, als ihm zusteht.
  const verwaltungIds = Object.values(users)
    .filter((u) => !u.disabled && (u.role === 'owner' || u.role === 'admin'))
    .map((u) => u.id);

  const melden = async () => {
    setLaeuft(true);
    try {
      setCode(await vorfallMelden({ channelId, grund: grund.trim(), verwaltungIds, tage }));
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('vorfall.melden'), body: (fehler as Error).message });
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <Rahmen titel={t('vorfall.melden')} symbol={<ShieldAlert size={18} />} onClose={onClose}>
      {code ? (
        <>
          <div className="zugang">
            <div className="zugang__zeile">
              <span className="zugang__label">{t('vorfall.code')}</span>
              <span className="zugang__wert zugang__wert--gross mono">{code}</span>
            </div>
          </div>

          <button
            className="btn btn--primary btn--block"
            onClick={() => {
              void navigator.clipboard.writeText(code);
              setKopiert(true);
              window.setTimeout(() => setKopiert(false), 2200);
            }}
          >
            {kopiert ? <Check size={16} /> : <Copy size={16} />}
            {kopiert ? t('team.copied') : t('protocol.copy')}
          </button>

          <div className="hinweis" style={{ marginTop: 'var(--sp-4)', alignItems: 'flex-start' }}>
            <AlertTriangle size={14} style={{ flex: 'none', marginTop: 2 }} />
            <div>
              <div>{t('vorfall.codeEinmalig')}</div>
              <div style={{ marginTop: 5, opacity: 0.9 }}>{t('vorfall.codeHinweis')}</div>
            </div>
          </div>

          <button className="btn btn--block" style={{ marginTop: 'var(--sp-3)' }} onClick={onClose}>
            <Check size={15} /> {t('wieder.notiert')}
          </button>
        </>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>{t('vorfall.hinweis')}</p>

          <div className="field">
            <label className="field__label">{t('vorfall.grund')}</label>
            <textarea
              className="textarea"
              style={{ minHeight: 84 }}
              value={grund}
              autoFocus
              maxLength={500}
              onChange={(e) => setGrund(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label">{t('vorfall.dauer')}</label>
            <select className="select" value={tage} onChange={(e) => setTage(Number(e.target.value))}>
              {[7, FREIGABE_TAGE_VORGABE, 30, FREIGABE_TAGE_HOECHSTENS].map((n) => (
                <option key={n} value={n}>{t('vorfall.tage', { n })}</option>
              ))}
            </select>
          </div>

          <button
            className="btn btn--danger btn--block"
            disabled={laeuft || grund.trim().length < 3}
            onClick={() => void melden()}
          >
            {laeuft ? <Loader2 size={15} className="spin" /> : <ShieldAlert size={15} />}
            {t('vorfall.absenden')}
          </button>
        </>
      )}
    </Rahmen>
  );
}

/* ── Freigaben ────────────────────────────────────────────────── */

export function FreigabenDialog({ channelId, onClose }: { channelId: string | null; onClose: () => void }) {
  const t = useT();
  return (
    <Rahmen titel={t('freigabe.titel')} symbol={<KeyRound size={18} />} onClose={onClose}>
      <FreigabenListe channelId={channelId} />
    </Rahmen>
  );
}

/**
 * Die Liste der Freigaben — und der Weg, eine davon einzulösen.
 *
 * Der Code wird nie zum Server geschickt, nur sein Abdruck. Das steht in
 * lib/vertraulich.ts; hier steht nur, dass ein falscher Code eine Antwort
 * bekommt und keine stumme Ablehnung: acht Fehlversuche verbrennen die
 * Freigabe, und wer nicht weiß, dass er sich vertippt hat, verbraucht sie.
 */
function FreigabenListe({ channelId }: { channelId: string | null }) {
  const t = useT();
  const freigaben = useStore((s) => s.freigaben);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const self = useStore((s) => s.self);
  const [offen, setOffen] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => { useStore.getState().ladeFreigaben(channelId); }, [channelId]);

  const liste = channelId ? freigaben.filter((f) => f.channelId === channelId) : freigaben;
  const darfLesen = Boolean(self?.permissions['vertraulich.freigabe_lesen']);

  if (!liste.length) {
    return <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>{t('freigabe.keine')}</p>;
  }

  return (
    <>
      {liste.map((f) => {
        const abgelaufen = f.laeuftAb < Date.now();
        const zurueck = Boolean(f.zurueckgenommenAm);
        const melder = users[f.melderId]?.displayName ?? '';
        const kanal = channels[f.channelId];
        return (
          <div key={f.id} className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div className="row__main" style={{ flex: '1 1 200px' }}>
              <div className="row__title">
                {kanal ? `#${kanal.name}` : ''} {melder && <span className="muted" style={{ fontWeight: 400 }}>· {melder}</span>}
              </div>
              <div className="row__sub" style={{ whiteSpace: 'normal' }}>{f.grund}</div>
              <div className="row__sub">
                {zurueck ? t('freigabe.zurueckgenommen')
                  : abgelaufen ? t('freigabe.abgelaufen')
                  : t('freigabe.laeuftAb', {
                    datum: new Date(f.laeuftAb).toLocaleDateString(currentUiLanguage(), {
                      day: 'numeric', month: 'short', year: 'numeric',
                    }),
                  })}
              </div>
            </div>

            <div className="hstack gap-2" style={{ flexWrap: 'wrap' }}>
              {darfLesen && !zurueck && !abgelaufen && (
                <button className="btn" onClick={() => {
                  /* Der Code gehört zu genau einer Freigabe: stehen geblieben,
                     ginge er beim nächsten Klick gegen eine andere hinaus und
                     verbrauchte dort einen der acht Versuche. */
                  setOffen(offen === f.id ? null : f.id); setFehler(null); setCode('');
                }}>
                  <KeyRound size={14} /> {t('freigabe.oeffnen')}
                </button>
              )}
              {!zurueck && (f.melderId === self?.id || darfLesen) && (
                <button className="btn btn--ghost" onClick={() => useStore.getState().freigabeZuruecknehmen(f.id)}>
                  {t('freigabe.zuruecknehmen')}
                </button>
              )}
            </div>

            {offen === f.id && (
              <div className="field" style={{ flex: '1 1 100%', marginTop: 'var(--sp-3)', marginBottom: 0 }}>
                <label className="field__label">{t('freigabe.code')}</label>
                <div className="hstack gap-2" style={{ flexWrap: 'wrap' }}>
                  <input
                    className="input"
                    style={{ flex: '1 1 180px' }}
                    value={code}
                    autoFocus
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                  />
                  <button
                    className="btn btn--primary"
                    disabled={laeuft || code.replace(/[^A-Z0-9]/g, '').length !== 6}
                    onClick={async () => {
                      setLaeuft(true);
                      setFehler(null);
                      const antwort = await freigabeOeffnen({ freigabeId: f.id, code });
                      setLaeuft(false);
                      if (antwort.ok) {
                        setOffen(null);
                        setCode('');
                        useStore.getState().vertraulichNeuLesen();
                        useStore.getState().openChannel(antwort.channelId);
                        useStore.getState().setOverlay(null);
                      } else {
                        setFehler(antwort.grund || t('freigabe.falscherCode'));
                      }
                    }}
                  >
                    {laeuft ? <Loader2 size={15} className="spin" /> : null}
                    {t('freigabe.oeffnen')}
                  </button>
                </div>
                {fehler && <p className="field__hint" style={{ color: 'var(--rose)' }}>{fehler}</p>}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/* ── Gemeinsamer Rahmen ───────────────────────────────────────── */

function Rahmen({ titel, symbol, onClose, children }: {
  titel: string; symbol: React.ReactNode; onClose: () => void; children: React.ReactNode;
}) {
  const t = useT();
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, onClose);
  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        ref={kasten}
        role="dialog"
        aria-modal="true"
        aria-label={titel}
        className="panel"
        style={{ width: 'min(520px, 100%)', maxHeight: '84vh' }}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ duration: 0.19, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          {symbol}
          <h2>{titel}</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label={t('common.close')}><X size={17} /></button>
        </div>
        <div className="panel__body">{children}</div>
      </motion.div>
    </div>
  );
}
