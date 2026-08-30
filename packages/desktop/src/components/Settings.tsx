import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bell, Cpu, Globe, KeyRound, Loader2, Lock, LogOut, Mail, Palette, RefreshCw, Server, Sparkles, User, Volume2, Wallet, X } from 'lucide-react';
import { LANGUAGES, type AiCapabilities, type AiModelInfo } from '@stellium/shared';
import { pushSynchronisieren, useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { api, serverUrl, setServerUrl, type AnbieterSchluesselStand } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { Profilbild } from './Profilbild.jsx';
import { languageInfo } from '../lib/format.js';
import { coverage, spracheName, UI_LANGUAGES, useT, t, type TranslationKey } from '../i18n/index.js';
import { useReiterleiste } from '../lib/reiterleiste.js';
import { erlaubnisHolen, erlaubnisStand, zeigen, type Erlaubnis } from '../lib/benachrichtigung.js';
import { tourZuruecksetzen } from './Tour.jsx';
import { UpdatePanel } from './UpdatePanel.jsx';
import { reiterWunschAbholen, VertraulichEinstellungen } from './Vertraulich.jsx';
import { spracheDesSystems } from '../i18n/index.js';
import { hintergrundBeobachten, hintergrundLesen, hintergrundSetzen, type Hintergrund } from '../lib/hintergrund.js';

type Tab = 'profil' | 'sprache' | 'modelle' | 'benachrichtigungen' | 'darstellung'
  | 'vertraulich' | 'post' | 'schluessel' | 'aktualisierung' | 'server';

/**
 * Der Hinweis zum Stand der KI kommt als Kennung vom Server, mit deutschem
 * Text daneben. Kennt das Wörterbuch die Kennung, gilt der eigene Satz in der
 * eingestellten Sprache; sonst bleibt der Text des Servers stehen — so ist
 * eine neuere Serverfassung nie stumm gegenüber einer älteren App.
 */
function kiHinweis(ai: AiCapabilities | null | undefined): string | null {
  if (!ai) return null;
  if (!ai.noteCode) return ai.note;
  const eigener = t(ai.noteCode as TranslationKey, ai.noteWerte ?? undefined);
  return eigener && eigener !== ai.noteCode ? eigener : ai.note;
}

/* Die drei Stufen des Hintergrunds (kosmos/still/aus). Eigene Komponente,
   weil die Wahl am Gerät hängt und nicht im Kontozustand liegt — so bleibt
   Settings.tsx von localStorage unberührt und die Wahl neu gezeichnet nur
   hier, nicht das ganze Fenster. */
function HintergrundWahl() {
  const t = useT();
  const [stufe, setStufe] = useState<Hintergrund>(hintergrundLesen);
  useEffect(() => hintergrundBeobachten(setStufe), []);
  const optionen: { wert: Hintergrund; text: string }[] = [
    { wert: 'kosmos', text: t('settings.bgKosmos') },
    { wert: 'still', text: t('settings.bgStill') },
    { wert: 'aus', text: t('settings.bgAus') },
  ];
  return (
    <div className="field">
      <label className="field__label">{t('settings.background')}</label>
      <div className="hstack gap-2">
        {optionen.map((o) => (
          <button
            key={o.wert}
            className={`btn${stufe === o.wert ? ' btn--primary' : ''}`}
            onClick={() => { setStufe(o.wert); hintergrundSetzen(o.wert); }}
          >
            {o.text}
          </button>
        ))}
      </div>
      <p className="field__hint">{t('settings.backgroundHint')}</p>
    </div>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, onClose);
  const t = useT();
  const self = useStore((s) => s.self);
  const ai = useStore((s) => s.ai);
  const { updatePrefs, logout } = useStore.getState();
  /* Der Hinweis im Kanal führt hierher und meint den Wiederherstellungscode.
     Ohne diesen Umweg landete er auf dem ersten Reiter, und der Code wäre
     genau das, was er nicht sein soll: irgendwo unter „auch noch da". */
  const [tab, setTab] = useState<Tab>(() => (reiterWunschAbholen() ? 'vertraulich' : 'sprache'));
  /* Rollen, Mausrad und der gewaehlte Reiter kommt ins Bild —
     siehe lib/reiterleiste.ts. */
  const reiter = useRef<HTMLDivElement>(null);
  useReiterleiste(reiter, tab);
  const [erlaubnis, setErlaubnis] = useState<Erlaubnis>(() => erlaubnisStand());
  const [server, setServer] = useState(serverUrl());
  const eigenerStatus = useStore((s) => (s.self ? s.users[s.self.id]?.status : undefined));

  if (!self) return null;
  const lebenderStatus = eigenerStatus ?? self.status;

  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        ref={kasten}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.settings')}
        className="panel panel--wide"
        style={{ maxHeight: '82vh' }}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          {/* `self` wird von presence-Ereignissen nicht fortgeschrieben — hier
              stand deshalb „offline", während der Mensch abwesend war. Der
              lebende Stand liegt in `users`; StatusMenu macht es genauso. */}
          <Avatar user={{ ...self, status: lebenderStatus }} size={36} showPresence />
          <div>
            <h2>{self.displayName}</h2>
            <div className="muted" style={{ fontSize: 12.5 }}>@{self.handle} · {self.title ?? t('settings.defaultTitle')}</div>
          </div>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label={t('common.close')}><X size={17} /></button>
        </div>

        <div className="tabs" ref={reiter}>
          <Tabs tab={tab} setTab={setTab} />
        </div>

        <div className="panel__body">
          {tab === 'sprache' && (
            <>
              <div className="field">
                <label className="field__label">{t('settings.uiLanguage')}</label>
                <select
                  className="select"
                  value={self.uiLanguage || ''}
                  onChange={(e) => updatePrefs({ uiLanguage: e.target.value })}
                >
                  {/* Leerer Wert heißt: der Sprache des Rechners folgen. */}
                  <option value="">
                    {t('settings.uiLanguageSystem', { sprache: nameDerSprache(spracheDesSystems()) })}
                  </option>
                  {UI_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.flag} {l.native}
                      {coverage(l.code) < 100 ? ` (${coverage(l.code)} %)` : ''}
                    </option>
                  ))}
                </select>
                <p className="field__hint">{t('settings.uiLanguageHint')}</p>
              </div>

              <div className="field">
                <label className="field__label">{t('settings.myLanguage')}</label>
                <select
                  className="select"
                  value={self.language}
                  onChange={(e) => updatePrefs({ language: e.target.value })}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.flag} {l.native} ({l.name})</option>
                  ))}
                </select>
                <p className="field__hint">
                  {t('settings.myLanguageHint', { language: spracheName(self.language) })}
                </p>
              </div>

              <Row
                title={t('settings.liveTranslation')}
                sub={t('settings.liveTranslationHint')}
                checked={self.autoTranslate}
                onChange={(v) => updatePrefs({ autoTranslate: v })}
              />
              <Row
                title={t('settings.composePreview')}
                sub={t('settings.composePreviewHint')}
                checked={self.composeTargetPreview}
                onChange={(v) => updatePrefs({ composeTargetPreview: v })}
              />

              <div className="field" style={{ marginTop: 'var(--sp-4)' }}>
                <label className="field__label">{t('settings.translationSpeed')}</label>
                <div className="hstack gap-2">
                  {([
                    ['fast', t('settings.speedFast'), t('settings.speedFastHint')],
                    ['balanced', t('settings.speedBalanced'), t('settings.speedBalancedHint')],
                    ['accurate', t('settings.speedAccurate'), t('settings.alwaysBig')],
                  ] as const).map(([value, label, hint]) => (
                    <button
                      key={value}
                      className={`btn${self.translationSpeed === value ? ' btn--primary' : ''}`}
                      title={hint}
                      onClick={() => updatePrefs({ translationSpeed: value })}
                    >{label}</button>
                  ))}
                </div>
              </div>

              <div className="ai-card" style={{ marginTop: 'var(--sp-4)' }}>
                <div className="ai-card__head"><Sparkles size={12} /> {t('settings.aiService')}</div>
                <div style={{ fontSize: 14, marginBottom: ai?.model ? 8 : 0 }}>
                  <b>{ai?.provider ?? t('common.unknown')}</b>
                </div>

                {ai?.model && (
                  <div className="stack gap-1" style={{ fontSize: 13 }}>
                    <div className="hstack gap-2">
                      <span className="muted" style={{ minWidth: 148 }}>{t('settings.forTranslation')}</span>
                      <span className="mono">{ai.model}</span>
                    </div>
                    {ai.fastModel && ai.fastModel !== ai.model && (
                      <div className="hstack gap-2">
                        <span className="muted" style={{ minWidth: 148 }}>{t('settings.forSuggestions')}</span>
                        <span className="mono">{ai.fastModel}</span>
                      </div>
                    )}
                  </div>
                )}

                {ai?.modelSource && (
                  <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
                    {ai.modelSource === 'auto'
                      ? t('settings.modelAutoHint', { n: ai.modelsAvailable ?? '?', anbieter: ai.provider })
                      : ai.modelSource === 'pinned'
                        ? t('settings.modelPinnedHint')
                        : t('settings.modelFallback')}
                  </p>
                )}

                {/* Springt gerade jemand ein, gehört das an die erste Stelle:
                    sonst sucht man den Fehler bei den Antworten statt beim
                    ausgeschalteten Rechner. */}
                {ai?.vertretung && (
                  <p style={{ fontSize: 12.5, margin: '8px 0 0', color: 'var(--amber)' }}>
                    {t('settings.vertretung', { dienst: ai.vertretung })}
                  </p>
                )}
                {kiHinweis(ai) && <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>{kiHinweis(ai)}</p>}
              </div>

              {/* Trägt die KI selbst ein? Eine Entscheidung für den ganzen
                  Arbeitsbereich — deshalb nur für die, die auch das Modell
                  wählen dürfen, und mit dem ganzen Satz dazu, was sie
                  bedeutet. */}
              {/* Auch ohne eingerichtete KI sichtbar: die Einstellung sagt, was
                  passieren SOLL, wenn die KI läuft — sie erst dann anzuzeigen,
                  wenn sie schon läuft, versteckt genau die Entscheidung, die
                  man vorher trifft. */}
              {self.permissions['ai.model_select'] && (
                <div style={{ marginTop: 'var(--sp-3)' }}>
                  <Row
                    title={t('ki.selbstEintragen')}
                    sub={t('ki.selbstEintragenHint')}
                    checked={Boolean(ai?.selbstEintragen)}
                    onChange={(v) => useStore.getState().kiSelbstEintragen(v)}
                  />
                </div>
              )}
            </>
          )}

          {tab === 'profil' && (
            <>
              <Profilbild />
              <div className="field">
                <label className="field__label">{t('settings.displayName')}</label>
                <input
                  className="input"
                  defaultValue={self.displayName}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== self.displayName) updatePrefs({ displayName: v }); }}
                />
              </div>
              <div className="field">
                <label className="field__label">{t('settings.role')}</label>
                <input
                  className="input"
                  defaultValue={self.title ?? ''}
                  placeholder={t('settings.rolePlaceholder')}
                  onBlur={(e) => updatePrefs({ title: e.target.value.trim() || null })}
                />
              </div>
              <div className="field">
                <label className="field__label">{t('settings.timezone')}</label>
                <select className="select" value={self.timezone} onChange={(e) => updatePrefs({ timezone: e.target.value })}>
                  {/* TIMEZONES ist eine von Hand kuratierte Auswahl, keine
                      vollständige IANA-Liste — America/Anchorage fehlt dort
                      zum Beispiel. Steht in self.timezone (sei es durch
                      zeitzoneNachtragen() automatisch erkannt oder von einer
                      früheren Fassung dieser Liste her) ein Wert, der hier
                      unten nicht auftaucht, würde ein <select> ihn sonst
                      still gegen die erste Option vertauschen — dieselbe Art
                      Fehler wie die stille Rechnerzeit in localTimeFor(),
                      nur in der eigenen Einstellung statt im fremden Profil.
                      Deshalb wird der tatsächliche Wert notfalls vorangestellt,
                      statt ihn unsichtbar zu ersetzen. */}
                  {(TIMEZONES.includes(self.timezone) ? TIMEZONES : [self.timezone, ...TIMEZONES])
                    .map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
                <p className="field__hint">{t('settings.timezoneHint')}</p>
              </div>
              <button className="btn btn--danger" onClick={() => { logout(); onClose(); }}>
                <LogOut size={15} /> {t('settings.logout')}
              </button>
            </>
          )}

          {tab === 'modelle' && <><AnbieterWahl /><ModelPicker /></>}

          {tab === 'benachrichtigungen' && (
            <>
              {/* Der Status gehört fachlich hierher: es ist dieselbe Frage —
                  wann merkt Stellium, dass ich da bin, und wann nicht. */}
              <Row
                title={t('settings.autoStatus')}
                sub={t('settings.autoStatusHint')}
                checked={self.autoStatus}
                onChange={(v) => updatePrefs({ autoStatus: v })}
              />

              <div className="field" style={{ marginTop: 'var(--sp-4)' }}>
                <label className="field__label">{t('settings.notifyOn')}</label>
                <select
                  className="select"
                  value={self.notifyOn}
                  onChange={(e) => updatePrefs({ notifyOn: e.target.value as typeof self.notifyOn })}
                >
                  <option value="all">{t('settings.notifyAll')}</option>
                  <option value="mentions">{t('settings.notifyMentions')}</option>
                  <option value="none">{t('settings.notifyNone')}</option>
                </select>
              </div>
              {/* Nur im Browser: die App fragt das System selbst. */}
              {!window.stellium && (
                <div className="field">
                  <label className="field__label">{t('settings.browserNotify')}</label>
                  <p className="field__hint" style={{ marginBottom: 8 }}>{t('settings.browserNotifyHint')}</p>
                  <div className="hstack gap-2">
                    {erlaubnis === 'gefragt-werden' && (
                      <button
                        className="btn btn--primary"
                        onClick={async () => {
                          const stand = await erlaubnisHolen();
                          setErlaubnis(stand);
                          // Direkt aus derselben Bedienhandlung heraus anmelden — sonst
                          // greift erst das nächste 'ready' beim übernächsten Verbindungsaufbau.
                          if (stand === 'erlaubt') pushSynchronisieren();
                        }}
                      >
                        <Bell size={14} /> {t('settings.browserNotifyAsk')}
                      </button>
                    )}
                    {erlaubnis === 'erlaubt' && (
                      <>
                        <span className="muted" style={{ fontSize: 13 }}>{t('settings.browserNotifyOn')}</span>
                        <button
                          className="btn"
                          onClick={() => zeigen({
                            titel: t('settings.browserNotifyTestTitle'),
                            text: t('settings.browserNotifyTestBody'),
                          })}
                        >
                          {t('settings.browserNotifyTest')}
                        </button>
                      </>
                    )}
                    {erlaubnis === 'abgelehnt' && (
                      <span className="muted" style={{ fontSize: 13 }}>{t('settings.browserNotifyOff')}</span>
                    )}
                    {erlaubnis === 'geht-nicht' && (
                      <span className="muted" style={{ fontSize: 13 }}>{t('settings.browserNotifyNone')}</span>
                    )}
                  </div>
                </div>
              )}

              <div className="field">
                <label className="field__label">{t('settings.sound')}</label>
                <select
                  className="select"
                  value={self.notificationSound}
                  onChange={(e) => updatePrefs({ notificationSound: e.target.value })}
                >
                  <option value="ping">Ping</option>
                  <option value="blip">Blip</option>
                  <option value="chime">{t('settings.soundChime')}</option>
                  <option value="aus">{t('settings.soundOff')}</option>
                </select>
              </div>

              <div className="field">
                <label className="field__label">{t('settings.quietHours')}</label>
                <div className="hstack gap-2">
                  <input
                    className="input" type="time" style={{ maxWidth: 150 }}
                    value={minutesToTime(self.quietHoursStart)}
                    onChange={(e) => updatePrefs({ quietHoursStart: timeToMinutes(e.target.value) })}
                  />
                  <span className="muted">{t('settings.until')}</span>
                  <input
                    className="input" type="time" style={{ maxWidth: 150 }}
                    value={minutesToTime(self.quietHoursEnd)}
                    onChange={(e) => updatePrefs({ quietHoursEnd: timeToMinutes(e.target.value) })}
                  />
                  <button
                    className="btn btn--ghost"
                    onClick={() => updatePrefs({ quietHoursStart: null, quietHoursEnd: null })}
                  >{t('settings.off')}</button>
                </div>
                <p className="field__hint">{t('settings.quietHint')}</p>
              </div>

              {/* Serverseitig durchgesetzt (readReceiptsBatch in
                  services/messages.ts): wer das abschaltet, taucht in keiner
                  Leserliste mehr auf, ganz gleich, wer fragt. Die eigene
                  Lesemarke läuft unverändert weiter — daran hängt der eigene
                  Ungelesen-Zähler, nicht die Ausgabe an andere. */}
              <Row
                title={t('settings.lesebestaetigungAus')}
                sub={t('settings.lesebestaetigungAusHint')}
                checked={self.lesebestaetigungAus}
                onChange={(v) => updatePrefs({ lesebestaetigungAus: v })}
              />
            </>
          )}

          {tab === 'darstellung' && (
            <>
              <div className="field">
                <label className="field__label">{t('settings.theme')}</label>
                <div className="hstack gap-2">
                  {(['dark', 'light', 'system'] as const).map((opt) => (
                    <button
                      key={opt}
                      className={`btn${self.theme === opt ? ' btn--primary' : ''}`}
                      onClick={() => updatePrefs({ theme: opt })}
                    >
                      {opt === 'dark' ? t('settings.dark') : opt === 'light' ? t('settings.light') : t('settings.system')}
                    </button>
                  ))}
                </div>
              </div>
              {/* Der Hintergrundstil lebt bewusst nur auf diesem Gerät
                  (lib/hintergrund.ts) — deshalb hier ein eigener kleiner
                  Zustand statt der Kontoeinstellungen. */}
              <HintergrundWahl />
              <div className="row">
                <div className="row__main">
                  <div className="row__title">{t('settings.restartTour')}</div>
                  <div className="row__sub">{t('settings.restartTourHint')}</div>
                </div>
                <button className="btn" onClick={() => {
                  tourZuruecksetzen();
                  useStore.getState().setOverlay('tour');
                }}>{t('settings.restartTour')}</button>
              </div>

              <div className="field">
                <label className="field__label">{t('settings.density')}</label>
                <div className="hstack gap-2">
                  {(['comfortable', 'compact'] as const).map((d) => (
                    <button
                      key={d}
                      className={`btn${self.density === d ? ' btn--primary' : ''}`}
                      onClick={() => updatePrefs({ density: d })}
                    >{d === 'comfortable' ? t('settings.roomy') : t('settings.compact')}</button>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'vertraulich' && <VertraulichEinstellungen />}

          {tab === 'post' && <PostEinstellungen />}

          {tab === 'schluessel' && <SchluesselEinstellungen />}

          {tab === 'aktualisierung' && <UpdatePanel />}

          {tab === 'server' && (
            <>
              <div className="field">
                <label className="field__label">{t('settings.serverAddress')}</label>
                <input className="input" value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://localhost:8787" />
                <p className="field__hint">{t('settings.serverHint')}</p>
              </div>
              <button
                className="btn btn--primary"
                onClick={() => { setServerUrl(server); logout(); onClose(); }}
              >
                <Server size={15} /> {t('settings.saveAndRelogin')}
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

/**
 * Die Zugangsdaten des Postfachs.
 *
 * Zwei Geheimnisse, zwei Richtungen: der Schlüssel des Versanddienstes für
 * den Weg nach draußen, das Eingangsgeheimnis für den Weg herein. Beide
 * werden verschlüsselt abgelegt und sind danach NICHT mehr anzeigbar —
 * auch nicht dem, der sie eingetragen hat. Zurück kommt nur, DASS etwas
 * hinterlegt ist. Ein Schlüssel, den man versehentlich weiterreichen kann,
 * ist keiner mehr.
 *
 * Hier steht nur noch die DOMÄNE, keine vollständige Adresse mehr — den
 * lokalen Teil (`support`, `info`, …) bestimmt beim tatsächlichen Versand
 * immer das gewählte Fach (services/post.ts, `senden()`), nie eine globale
 * Vorgabe. Vorher stand hier ein einzelnes Adressfeld, aus dem JEDE Antwort
 * hinausging, unabhängig davon, an welches Fach die ursprüngliche Mail
 * ankam — genau das ist mit der Fach-Auswahl beim Antworten/Weiterleiten/
 * Freigeben (siehe PostPanel.tsx) nicht mehr vereinbar.
 */
function PostEinstellungen() {
  const t = useT();
  const [stand, setStand] = useState<{
    versandBereit: boolean; eingangBereit: boolean; domaene: string | null; name: string | null;
  } | null>(null);
  const [domaene, setDomaene] = useState('');
  const [name, setName] = useState('');
  const [laeuft, setLaeuft] = useState(false);

  useEffect(() => {
    void api.postZugang().then((z) => {
      setStand(z);
      setDomaene(z.domaene ?? '');
      setName(z.name ?? 'Stellium');
    }).catch(() => setStand(null));
  }, []);

  const speichern = async () => {
    setLaeuft(true);
    try {
      const z = await api.postZugangSetzen({
        domaene: domaene.trim() || undefined,
        name: name.trim(),
      });
      setStand((s) => (s ? { ...s, ...z } : s));
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <>
      <div className="field">
        <label className="field__label">{t('post.domaene')}</label>
        <input className="input" value={domaene} onChange={(e) => setDomaene(e.target.value)}
               placeholder="stellium.club" />
        <p className="field__hint">{t('post.domaeneHint')}</p>
      </div>

      <div className="field">
        <label className="field__label">{t('post.name')}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)}
               placeholder="Stellium" />
        <p className="field__hint">{t('post.nameHint')}</p>
      </div>

      <button className="btn btn--primary" disabled={laeuft} onClick={() => void speichern()}>
        <Mail size={15} /> {t('common.save')}
      </button>
    </>
  );
}

/**
 * Der Gumroad-Schlüssel.
 *
 * Er lag bis hierher im Klartext in `/etc/stellium-triton.env` auf dem Pi —
 * wer ihn wechseln wollte, brauchte eine SSH-Sitzung. Hier liegt er
 * verschlüsselt in der Datenbank, und der Server reicht ihn beim Aufruf der
 * Konsole durch. Angezeigt wird er danach nie wieder.
 */
function GeheimFeld({ label, stand, wert, setWert, platzhalter }: {
  label: string; stand?: boolean; wert: string; setWert: (v: string) => void; platzhalter?: string;
}) {
  const t = useT();
  return (
    <div className="field">
      <label className="field__label">
        {label} · {stand ? t('post.bereit') : t('post.fehlt')}
      </label>
      <input className="input" type="password" autoComplete="off" placeholder={platzhalter}
             value={wert} onChange={(e) => setWert(e.target.value)} />
    </div>
  );
}

/**
 * Alle Geheimnisse an einer Stelle.
 *
 * Vorher lagen sie verstreut — der Gumroad-Schlüssel unter „Verkauf", die
 * Postfach-Schlüssel unter „Postfach", der Fernzugang nirgends (den setzte
 * man über die Kommandozeile). Verstreute Geheimnisse sind eine Einladung,
 * eines zu vergessen: beim Übergeben, beim Wechseln, beim Aufräumen nach
 * einem Verdacht.
 *
 * Angezeigt wird keines davon. Zurück kommt nur, DASS etwas hinterlegt ist.
 */
function SchluesselEinstellungen() {
  const t = useT();
  const { toast } = useStore.getState();
  const [postStand, setPostStand] = useState<{ versandBereit: boolean; eingangBereit: boolean } | null>(null);
  const [verkaufStand, setVerkaufStand] = useState<{ hinterlegt: boolean } | null>(null);
  /* Vier Werte statt einem, siehe verkaufzugang.ts auf dem Server: Patreons
     OAuth-Modell trennt App (Client-ID/-Secret) von Kontozugriff
     (Access-/Refresh-Token). `ablaufAm` bleibt vorerst leer, bis die
     Erneuerung steht — siehe patreonAblauf weiter unten. */
  const [patreonStand, setPatreonStand] = useState<{
    hinterlegt: boolean; clientId: string | null; clientSecretHinterlegt: boolean;
    refreshTokenHinterlegt: boolean; ablaufAm: number | null;
  } | null>(null);
  /* Getrennt von patreonStand, weil es von einer eigenen Route kommt (siehe
     api.patreonErneuerungsStand) — die automatische Erneuerung soll sichtbar
     sein, ohne den Block oben anzufassen. */
  const [patreonErneuerung, setPatreonErneuerung] = useState<{
    letzterFehler: string | null;
  } | null>(null);
  const [fernStand, setFernStand] = useState<{ hinterlegt: boolean } | null>(null);
  /* Der Groq-Schlüssel steht nicht im selben Speicher wie alles andere hier:
     er liegt im Tresor neben der Datenbank und nicht in ihr, weil der Server
     ihn schon beim Start braucht — vor der ersten Anmeldung. Deshalb eine
     eigene Route und ein eigener Stand. */
  const [groqStand, setGroqStand] = useState<AnbieterSchluesselStand | null>(null);

  const [versand, setVersand] = useState('');
  const [eingang, setEingang] = useState('');
  const [gumroad, setGumroad] = useState('');
  /* Die Client-ID ist kein Geheimnis (siehe GeheimFeld-Vergleich unten) und
     startet darum mit dem hinterlegten Wert statt leer. */
  const [patreonClientId, setPatreonClientId] = useState('');
  const [patreonClientSecret, setPatreonClientSecret] = useState('');
  const [patreonAccessToken, setPatreonAccessToken] = useState('');
  const [patreonRefreshToken, setPatreonRefreshToken] = useState('');
  const [fernAdresse, setFernAdresse] = useState('');
  const [fernPasswort, setFernPasswort] = useState('');
  const [groq, setGroq] = useState('');
  const [laeuft, setLaeuft] = useState(false);

  useEffect(() => {
    void api.postZugang().then(setPostStand).catch(() => {});
    void api.verkaufZugang().then(setVerkaufStand).catch(() => {});
    void api.patreonZugang().then((stand) => {
      setPatreonStand(stand);
      setPatreonClientId(stand.clientId ?? '');
    }).catch(() => {});
    void api.patreonErneuerungsStand().then(setPatreonErneuerung).catch(() => {});
    void api.fernStand().then(setFernStand).catch(() => {});
    /* Nur die Leitung darf das sehen; für alle anderen antwortet der Server
       mit 403, und der Abschnitt bleibt bei seinem bisherigen Hinweis. */
    void api.anbieterSchluessel().then((s) => setGroqStand(s.groq)).catch(() => {});
  }, []);

  /* Im Browser gewürfelt statt getippt: ein selbst ausgedachtes Wort ist
     kürzer und einfacher, als es aussieht. */
  const wuerfeln = () => {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    setEingang(btoa(String.fromCharCode(...b)).replace(/[+/=]/g, '').slice(0, 43));
  };

  const speichern = async () => {
    setLaeuft(true);
    /* Nur wenn wirklich etwas geschickt wurde, lohnt hinterher ein
       "Gespeichert" — ein Klick auf lauter leere Felder soll nicht so tun,
       als hätte er etwas bewirkt. */
    let gespeichert = false;
    try {
      /* Nur schicken, was ausgefüllt wurde. Leere Felder lassen den
         bisherigen Wert stehen — sonst löschte ein Speichern alles, was man
         gerade nicht eingetippt hat. */
      if (versand || eingang) {
        await api.postZugangSetzen({
          versandSchluessel: versand.trim() || undefined,
          eingangGeheimnis: eingang.trim() || undefined,
        });
        /* Nicht die Antwort des Setzens selbst übernehmen, sondern wie beim
           Öffnen erneut fragen — nur der Server weiß, was jetzt wirklich
           gilt. Sonst zeigt das Etikett den Stand vom Öffnen des Reiters
           weiter, auch nachdem längst neu gespeichert wurde. */
        setPostStand(await api.postZugang());
        setVersand(''); setEingang('');
        gespeichert = true;
      }
      if (gumroad.trim()) {
        await api.verkaufZugangSetzen(gumroad.trim());
        setVerkaufStand(await api.verkaufZugang());
        setGumroad('');
        gespeichert = true;
      }
      /* Die Client-ID ist kein Geheimnis und steht darum, anders als die
         drei echten Geheimnisse, dauerhaft im Feld. Mitgeschickt wird sie
         deshalb nur, wenn sie sich wirklich geändert hat — sonst schriebe
         jedes Speichern in diesem Reiter, auch für ein ganz anderes Feld,
         sie stumm erneut fest. */
      const patreonClientIdBisher = patreonStand?.clientId ?? '';
      const patreonClientIdWert = patreonClientId.trim();
      if (patreonClientIdWert !== patreonClientIdBisher || patreonClientSecret.trim()
          || patreonAccessToken.trim() || patreonRefreshToken.trim()) {
        await api.patreonZugangSetzen({
          clientId: patreonClientIdWert !== patreonClientIdBisher ? patreonClientIdWert : undefined,
          clientSecret: patreonClientSecret.trim() || undefined,
          accessToken: patreonAccessToken.trim() || undefined,
          refreshToken: patreonRefreshToken.trim() || undefined,
        });
        const neuerPatreonStand = await api.patreonZugang();
        setPatreonStand(neuerPatreonStand);
        setPatreonClientId(neuerPatreonStand.clientId ?? '');
        setPatreonClientSecret(''); setPatreonAccessToken(''); setPatreonRefreshToken('');
        gespeichert = true;
      }
      if (fernAdresse.trim() || fernPasswort.trim()) {
        await api.fernZugangSetzen({
          adresse: fernAdresse.trim() || undefined,
          passwort: fernPasswort.trim() || undefined,
        });
        setFernStand(await api.fernStand());
        setFernAdresse(''); setFernPasswort('');
        gespeichert = true;
      }
      if (groq.trim()) {
        const antwort = await api.anbieterSchluesselSetzen(groq.trim());
        setGroqStand(antwort.groq);
        setGroq('');
        gespeichert = true;
      }
      if (gespeichert) toast({ kind: 'ok', title: t('schluessel.gespeichert') });
    } catch (err) {
      /* Ohne das hier verschwand ein Fehlschlag lautlos in einer verworfenen
         Zusage: die Oberfläche zeigte nichts, wer gespeichert hatte, musste
         raten, ob es geklappt hat — genau wie an dem Tag, als der Server
         diese Route noch gar nicht kannte. Die Meldung des Servers geht
         unverändert mit, statt hinter einem allgemeinen Satz zu verschwinden. */
      toast({ kind: 'error', title: t('schluessel.speichernFehlgeschlagen'), body: (err as Error).message });
    } finally {
      setLaeuft(false);
    }
  };

  /* Ein abgelaufener oder bald ablaufender Patreon-Token soll auffallen,
     nicht erst dann, wenn die Verkaufszahlen ohne Erklärung verschwinden.
     Ohne Ablaufdatum — heute immer, solange niemand die Erneuerung gebaut
     hat — bleibt das ausdrücklich als Lücke sichtbar statt verschwiegen. */
  const patreonAblauf = (() => {
    const bis = patreonStand?.ablaufAm;
    if (bis == null) return { text: t('verkauf.patreonAblaufUnbekannt'), warnung: true };
    const datum = new Date(bis).toLocaleDateString();
    if (bis < Date.now()) return { text: t('verkauf.patreonAbgelaufen', { datum }), warnung: true };
    if (bis - Date.now() < 7 * 24 * 60 * 60 * 1000) {
      return { text: t('verkauf.patreonLaeuftBald', { datum }), warnung: true };
    }
    return { text: t('verkauf.patreonGueltigBis', { datum }), warnung: false };
  })();

  return (
    <>
      <p className="field__hint">{t('schluessel.hinweis')}</p>

      <h3 className="ai-section__title">{t('schluessel.postfach')}</h3>
      <GeheimFeld label={t('post.versand')} stand={postStand?.versandBereit}
                  wert={versand} setWert={setVersand} platzhalter="re_..." />
      <div className="field">
        <label className="field__label">
          {t('post.eingang')} · {postStand?.eingangBereit ? t('post.bereit') : t('post.fehlt')}
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" type="password" autoComplete="off" style={{ flex: 1 }}
                 value={eingang} onChange={(e) => setEingang(e.target.value)} />
          <button className="btn" type="button" onClick={wuerfeln}>{t('post.erzeugen')}</button>
        </div>
        <p className="field__hint">{t('post.eingangHint')}</p>
      </div>

      <h3 className="ai-section__title">{t('schluessel.verkauf')}</h3>
      <GeheimFeld label={t('verkauf.token')} stand={verkaufStand?.hinterlegt}
                  wert={gumroad} setWert={setGumroad} />
      <p className="field__hint">{t('verkauf.tokenHint')}</p>

      <h3 className="ai-section__title">{t('verkauf.patreonUeberschrift')}</h3>
      <div className="field">
        <label className="field__label">{t('verkauf.patreonClientId')}</label>
        <input className="input" autoComplete="off" value={patreonClientId}
               onChange={(e) => setPatreonClientId(e.target.value)} />
        <p className="field__hint">{t('verkauf.patreonClientIdHint')}</p>
      </div>
      <GeheimFeld label={t('verkauf.patreonClientSecret')} stand={patreonStand?.clientSecretHinterlegt}
                  wert={patreonClientSecret} setWert={setPatreonClientSecret} />
      <GeheimFeld label={t('verkauf.patreonAccessToken')} stand={patreonStand?.hinterlegt}
                  wert={patreonAccessToken} setWert={setPatreonAccessToken} />
      <GeheimFeld label={t('verkauf.patreonRefreshToken')} stand={patreonStand?.refreshTokenHinterlegt}
                  wert={patreonRefreshToken} setWert={setPatreonRefreshToken} />
      <p className="field__hint">{t('verkauf.patreonHint')}</p>
      {patreonStand?.hinterlegt && (
        <p className="field__hint" style={patreonAblauf.warnung ? { color: 'var(--amber)' } : undefined}>
          {patreonAblauf.text}
        </p>
      )}
      {/* Ohne das bliebe ein scheiternder Erneuerungslauf unsichtbar, bis der
          Token wirklich abläuft — siehe Dateikopf von services/patreon.ts
          auf dem Server. patreonErneuerung.letzterFehler steht nur, solange
          der jüngste Versuch fehlschlug; ein Erfolg löscht ihn dort wieder. */}
      {patreonStand?.hinterlegt && patreonErneuerung?.letzterFehler && (
        <p className="field__hint" style={{ color: 'var(--amber)' }}>
          {t('verkauf.patreonErneuerungFehler', { fehler: patreonErneuerung.letzterFehler })}
        </p>
      )}

      <h3 className="ai-section__title">{t('schluessel.fern')}</h3>
      <div className="field">
        <label className="field__label">
          {t('fern.adresseLabel')} · {fernStand?.hinterlegt ? t('post.bereit') : t('post.fehlt')}
        </label>
        <input className="input" value={fernAdresse} onChange={(e) => setFernAdresse(e.target.value)}
               placeholder="ws://..." />
      </div>
      <GeheimFeld label={t('fern.passwortLabel')} stand={fernStand?.hinterlegt}
                  wert={fernPasswort} setWert={setFernPasswort} />

      <h3 className="ai-section__title">{t('schluessel.anbieter')}</h3>
      <p className="field__hint">{t('schluessel.anbieterHinweis')}</p>
      {groqStand && (
        <>
          <GeheimFeld label={t('schluessel.groq')} stand={groqStand.hinterlegt}
                      wert={groq} setWert={setGroq} platzhalter="gsk_..." />
          {/* Ein Schlüssel aus der .env schlägt den Tresor (siehe secret() in
              config.ts). Ohne diesen Hinweis trüge man hier einen neuen ein,
              läse „Gespeichert" und suchte danach lange, warum weiter der
              alte benutzt wird. */}
          {groqStand.ausUmgebung && (
            <p className="field__hint" style={{ color: 'var(--amber)' }}>
              {t('schluessel.groqAusUmgebung')}
            </p>
          )}
          {!groqStand.aenderbar && (
            <p className="field__hint" style={{ color: 'var(--amber)' }}>
              {t('schluessel.groqKeinMasterpasswort')}
            </p>
          )}
          <p className="field__hint">{t('schluessel.groqHint')}</p>
        </>
      )}

      <button className="btn btn--primary" disabled={laeuft} onClick={() => void speichern()}>
        <KeyRound size={15} /> {t('common.save')}
      </button>
    </>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const t = useT();
  const items: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'sprache', label: t('settings.language'), icon: <Globe size={14} /> },
    { id: 'modelle', label: t('settings.model'), icon: <Cpu size={14} /> },
    { id: 'profil', label: t('settings.profile'), icon: <User size={14} /> },
    { id: 'benachrichtigungen', label: t('settings.notifications'), icon: <Bell size={14} /> },
    { id: 'darstellung', label: t('settings.appearance'), icon: <Palette size={14} /> },
    { id: 'vertraulich', label: t('vertraulich.tab'), icon: <Lock size={14} /> },
    { id: 'post', label: t('settings.post'), icon: <Mail size={14} /> },
    { id: 'schluessel', label: t('settings.schluessel'), icon: <KeyRound size={14} /> },
    { id: 'aktualisierung', label: t('update.tab'), icon: <RefreshCw size={14} /> },
    { id: 'server', label: t('settings.server'), icon: <Server size={14} /> },
  ];
  return (
    <>
      {items.map((it) => (
        <button key={it.id} className="tab" aria-selected={tab === it.id} onClick={() => setTab(it.id)}>
          <span className="hstack gap-2">{it.icon}{it.label}</span>
        </button>
      ))}
    </>
  );
}

function Row({ title, sub, checked, onChange }: { title: string; sub: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row">
      <div className="row__main">
        <div className="row__title">{title}</div>
        <div className="row__sub">{sub}</div>
      </div>
      <button className="switch" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} />
    </div>
  );
}

function minutesToTime(minutes: number | null): string {
  if (minutes == null) return '';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function timeToMinutes(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const TIMEZONES = [
  'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'Europe/Madrid', 'Europe/Warsaw',
  'Europe/Lisbon', 'Europe/Athens', 'Europe/Istanbul', 'Europe/Kyiv', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];


/* ── Modellauswahl ────────────────────────────────────────────── */

/**
 * Woher die KI kommt: ein Dienst im Netz oder ein Modell auf der eigenen
 * Maschine.
 *
 * Steht bewusst vor der Modellwahl und außerhalb ihrer Sperre: wer keinen
 * Schlüssel hat, will genau hier auf ein lokales Modell umstellen können.
 */
function AnbieterWahl() {
  const t = useT();
  const self = useStore((s) => s.self);
  const ai = useStore((s) => s.ai);
  const { selectProvider, toast } = useStore.getState();

  const [anbieter, setAnbieter] = useState(ai?.provider ?? 'groq');

  /* Beim ersten Rendern steht die Serverantwort oft noch aus — useState merkt
     sich dann den Ersatzwert "groq" für immer. Der Kasten zeigte danach Groq,
     obwohl längst das lokale Modell lief. Also nachziehen, sobald der Server
     sagt, was wirklich eingestellt ist. */
  useEffect(() => {
    if (ai?.provider) setAnbieter(ai.provider);
  }, [ai?.provider]);
  useEffect(() => {
    if (ai?.lokaleAdresse) setAdresse(ai.lokaleAdresse);
  }, [ai?.lokaleAdresse]);
  useEffect(() => {
    if (ai?.model) setModell(ai.model);
  }, [ai?.model]);
  const [adresse, setAdresse] = useState(ai?.lokaleAdresse ?? '');
  const [modelle, setModelle] = useState<string[]>([]);
  const [modell, setModell] = useState(ai?.model ?? '');
  const [pruefend, setPruefend] = useState(false);
  const [umstellend, setUmstellend] = useState(false);

  const darf = self?.role === 'owner' || self?.role === 'admin';
  const lokal = anbieter === 'ollama' || anbieter === 'llamacpp';
  // Beide Dienste hören auf verschiedenen Ports — die Vorgabe zeigt, welcher.
  const vorgabe = anbieter === 'llamacpp' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:11434/v1';

  const pruefen = async () => {
    setPruefend(true);
    try {
      const r = await api.checkLocal(adresse.trim() || vorgabe);
      setModelle(r.modelle);
      if (r.erreichbar && r.modelle.length) {
        if (!modell || !r.modelle.includes(modell)) setModell(r.modelle[0]);
        toast({ kind: 'ok', title: t('settings.localFound', { n: r.modelle.length }), body: r.modelle.slice(0, 4).join(', ') });
      } else {
        toast({ kind: 'error', title: t('settings.localNothing'), body: r.fehler ?? undefined });
      }
    } catch (err) {
      toast({ kind: 'error', title: t('settings.localNothing'), body: (err as Error).message });
    } finally {
      setPruefend(false);
    }
  };

  const uebernehmen = async () => {
    setUmstellend(true);
    const ok = await selectProvider({
      anbieter,
      baseUrl: lokal ? (adresse.trim() || vorgabe) : undefined,
      model: lokal ? (modell || undefined) : undefined,
      fastModel: lokal ? (modell || undefined) : undefined,
    });
    setUmstellend(false);
    if (ok) toast({ kind: 'ok', title: t('settings.providerChanged'), body: modell || anbieter });
  };

  if (!darf) {
    return (
      <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
        {t('settings.providerOnlyLead', { anbieter: ai?.provider ?? '—' })}
      </p>
    );
  }

  return (
    <div className="field">
      <label className="field__label">{t('settings.providerTitle')}</label>
      <p className="field__hint" style={{ marginBottom: 9 }}>{t('settings.providerHint')}</p>

      <select className="select" value={anbieter} onChange={(e) => { setAnbieter(e.target.value); setModelle([]); }}>
        <option value="groq">Groq {t('settings.providerCloud')}</option>
        <option value="openai">OpenAI {t('settings.providerCloud')}</option>
        <option value="ollama">Ollama {t('settings.providerLocal')}</option>
        <option value="llamacpp">llama.cpp {t('settings.providerLocal')}</option>
      </select>

      {lokal && (
        <div className="stack gap-2" style={{ marginTop: 10 }}>
          <div>
            <label className="field__label">{t('settings.localAddress')}</label>
            <div className="hstack gap-2">
              <input
                className="input"
                value={adresse}
                placeholder={vorgabe}
                onChange={(e) => setAdresse(e.target.value)}
              />
              <button className="btn" onClick={pruefen} disabled={pruefend}>
                {pruefend ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                {t('settings.localCheck')}
              </button>
            </div>
            <p className="field__hint">{t('settings.localAddressHint')}</p>
          </div>

          {modelle.length > 0 && (
            <div>
              <label className="field__label">{t('settings.localModel')}</label>
              <select className="select" value={modell} onChange={(e) => setModell(e.target.value)}>
                {modelle.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <p className="field__hint">{t('settings.localModelHint')}</p>
            </div>
          )}

          {!ai?.transcription && (
            <p className="field__hint">{t('settings.localNoVoice')}</p>
          )}
        </div>
      )}

      <div className="hstack gap-2" style={{ marginTop: 10 }}>
        <button
          className="btn btn--primary"
          onClick={uebernehmen}
          disabled={umstellend || (anbieter === ai?.provider && !lokal)}
        >
          {umstellend ? <Loader2 size={14} className="spin" /> : null}
          {t('settings.providerApply')}
        </button>
        {ai?.lokal && <span className="muted" style={{ fontSize: 12.5 }}>{t('settings.localActive', { adresse: ai.lokaleAdresse ?? '' })}</span>}
      </div>
    </div>
  );
}

function ModelPicker() {
  const self = useStore((s) => s.self);
  const ai = useStore((s) => s.ai);
  const { selectModels } = useStore.getState();

  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.models()
      .then((r) => setModels(r.models))
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, []);

  const mayChange = self?.role === 'owner' || self?.role === 'admin';
  const usable = models.filter((m) => m.usable);
  const rejected = models.filter((m) => !m.usable);

  const apply = async (input: { quality?: string | null; fast?: string | null; auto?: boolean }) => {
    setBusy(true);
    await selectModels(input);
    setBusy(false);
  };

  if (!ai?.assistant) {
    return (
      <p className="muted" style={{ fontSize: 13.5 }}>
        {t('settings.modelNeedsKey')}
        {kiHinweis(ai) ? ` ${kiHinweis(ai)}` : ''}
      </p>
    );
  }

  return (
    <>
      <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>{t('settings.modelLead')}</p>

      <div className="ai-card">
        <div className="ai-card__head"><Sparkles size={12} /> {t('settings.inUse')}</div>
        <div className="stack gap-1" style={{ fontSize: 13 }}>
          <div className="hstack gap-2">
            <span className="muted" style={{ minWidth: 152 }}>{t('settings.forTranslation')}</span>
            <span className="mono">{ai.model ?? '—'}</span>
          </div>
          <div className="hstack gap-2">
            <span className="muted" style={{ minWidth: 152 }}>{t('settings.forSuggestions')}</span>
            <span className="mono">{ai.fastModel ?? '—'}</span>
          </div>
          {ai.transcription && (
            <div className="hstack gap-2">
              <span className="muted" style={{ minWidth: 152 }}>{t('settings.forVoice')}</span>
              <span className="mono">{ai.transcriptionModel}</span>
            </div>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          {ai.modelSource === 'manual' ? t('settings.modelManual')
            : ai.modelSource === 'pinned' ? t('settings.fixedInEnv')
            : ai.modelSource === 'auto' ? t('settings.autoFrom', { n: ai.modelsAvailable ?? '?' })
            : t('settings.modelFallback')}
        </p>
      </div>

      {!mayChange && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          {t('settings.modelOnlyLead2')}
        </p>
      )}

      {mayChange && (
        <>
          <div className="field">
            <label className="field__label">{t('settings.modelForTranslation')}</label>
            <select
              className="select"
              value={ai.modelSource === 'manual' ? ai.model ?? '' : ''}
              disabled={busy || loading}
              onChange={(e) => void apply(e.target.value ? { quality: e.target.value } : { auto: true })}
            >
              <option value="">{t('settings.modelAuto')}</option>
              {usable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.params ? ` — ${t('settings.params', { n: m.params })}` : ''} · {t('settings.context', { n: Math.round(m.contextWindow / 1024) })}
                </option>
              ))}
            </select>
            <p className="field__hint">
              {t('settings.modelSizeHint2')}
            </p>
          </div>

          <div className="hstack gap-2">
            <button className="btn" disabled={busy} onClick={() => void apply({ auto: true })}>
              {busy && <Loader2 size={14} className="spin" />} {t('settings.backToAuto')}
            </button>
          </div>
        </>
      )}

      {loading && <div className="hstack gap-2 muted" style={{ marginTop: 'var(--sp-4)' }}><Loader2 size={14} className="spin" /> {t('settings.modelsLoading')}</div>}

      {usable.length > 0 && (
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <div className="ai-section__title">{t('settings.modelAvailable', { anbieter: ai.provider, n: usable.length })}</div>
          {usable.map((m) => (
            <div key={m.id} className="row">
              <div className="row__main">
                <div className="row__title mono" style={{ fontSize: 13 }}>{m.id}</div>
                <div className="row__sub">
                  {m.ownedBy}
                  {m.params ? ` · ${t('settings.paramsFull', { n: m.params })}` : ''}
                  {` · ${t('settings.context', { n: Math.round(m.contextWindow / 1024) })}`}
                </div>
              </div>
              {ai.model === m.id && <span className="msg__tag">{t('common.active')}</span>}
            </div>
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <div className="ai-section__title">{t('settings.modelUnsuited', { n: rejected.length })}</div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            {rejected.map((m) => (
              <div key={m.id}>
                <span className="mono">{m.id}</span> — {m.rejected}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Anzeigename einer Sprache, für den Hinweis "der Systemsprache folgen". */
function nameDerSprache(code: string): string {
  return UI_LANGUAGES.find((l) => l.code === code)?.native ?? code.toUpperCase();
}
