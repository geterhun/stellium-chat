import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Apple, CheckCircle2, Clock, Download, Loader2, Monitor, RefreshCw, Server, Terminal, Trash2, Upload,
} from 'lucide-react';
import type { ReleaseInfo, ReleasePlatform } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { api, serverUrl, token } from '../net/api.js';
import { relativeTime } from '../lib/format.js';

const PLATTFORMEN: { id: ReleasePlatform; name: string; icon: React.ReactNode; hinweis: string }[] = [
  { id: 'darwin', name: 'macOS', icon: <Apple size={15} />, hinweis: '.dmg' },
  { id: 'win32', name: 'Windows', icon: <Monitor size={15} />, hinweis: '.exe' },
  { id: 'linux', name: 'Linux', icon: <Terminal size={15} />, hinweis: '.AppImage / .deb' },
  // Der Server gehört dazu: er wurde hochgeladen, tauchte hier aber nie auf.
  { id: 'server', name: 'Server', icon: <Server size={15} />, hinweis: '.tar.gz' },
];

/** 1.10.0 ist neuer als 1.9.0 — ein Textvergleich sähe das andersherum. */
function istNeuer(a: string, b: string): boolean {
  const teile = (v: string) => v.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [teile(a), teile(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

function groesse(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

/**
 * Aktualisierung — beides an einer Stelle: was auf diesem Rechner ansteht und
 * (für die Verwaltung) was für die anderen bereitliegt.
 */
export function UpdatePanel() {
  const t = useT();
  const self = useStore((s) => s.self);
  const update = useStore((s) => s.update);
  const { checkForUpdate, installUpdate, toast } = useStore.getState();

  const [releases, setReleases] = useState<ReleaseInfo[]>([]);
  const [laedtHoch, setLaedtHoch] = useState<ReleasePlatform | null>(null);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const dateiFelder = useRef<Record<string, HTMLInputElement | null>>({});

  const darfVeroeffentlichen = Boolean(self?.permissions['user.manage']);
  const inDerApp = Boolean(window.stellium);
  const serverVersion = useStore((s) => s.serverVersion);
  // Kommt vom Server selbst, nicht aus der Verwaltungsliste: sonst sähe nur
  // die Verwaltung, dass gleich ein Neustart ansteht.
  const gemeldet = useStore((s) => s.serverBereitVersion);
  const ausListe = releases.find((r) => r.platform === 'server') ?? null;
  const serverNeu = gemeldet
    ?? (ausListe && serverVersion && istNeuer(ausListe.version, serverVersion) ? ausListe.version : null);
  const serverVeraltet = Boolean(serverVersion && serverNeu);

  useEffect(() => {
    if (!darfVeroeffentlichen) return;
    api.releases().then((r) => setReleases(r.releases)).catch(() => {});
  }, [darfVeroeffentlichen]);

  const hochladen = async (platform: ReleasePlatform, datei: File) => {
    if (!/^\d+\.\d+\.\d+/.test(version.trim())) {
      toast({ kind: 'error', title: t('update.versionNeeded'), body: t('update.versionHint') });
      return;
    }
    setLaedtHoch(platform);
    try {
      const form = new FormData();
      form.append('version', version.trim());
      if (notes.trim()) form.append('notes', notes.trim());
      form.append('file', datei);
      const antwort = await api.publishRelease(platform, form);
      setReleases(antwort.releases);
      toast({ kind: 'ok', title: t('update.published', { platform }), body: version.trim() });
    } catch (err) {
      toast({ kind: 'error', title: t('update.failed'), body: (err as Error).message });
    } finally {
      setLaedtHoch(null);
    }
  };

  return (
    <>
      {/* Eigener Rechner */}
      <div className="field">
        <label className="field__label">{t('update.thisComputer')}</label>

        {!inDerApp ? (
          <p className="field__hint">{t('update.browserOnly')}</p>
        ) : (
          <div className="update-card">
            {update.zustand === 'laedt' ? (
              <>
                <Download size={16} className="muted" />
                <div className="update-card__main">
                  <span>{t('update.downloading', { version: update.version ?? '' })}</span>
                  <div className="quota" style={{ marginBottom: 0 }}>
                    <motion.span
                      className="quota__fill"
                      style={{ background: 'var(--violet)' }}
                      animate={{ width: `${(update.anteil ?? 0) * 100}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                </div>
                <span className="muted">{Math.round((update.anteil ?? 0) * 100)} %</span>
              </>
            ) : update.zustand === 'bereit' ? (
              <>
                <CheckCircle2 size={16} style={{ color: 'var(--green)' }} />
                <div className="update-card__main">
                  <span>{t('update.ready', { version: update.version ?? '' })}</span>
                  {update.notes && <span className="muted">{update.notes}</span>}
                </div>
                <button className="btn btn--primary" onClick={installUpdate}>
                  {t('update.install')}
                </button>
              </>
            ) : (
              <>
                {update.zustand === 'suche' || update.zustand === 'gefunden'
                  ? <Loader2 size={16} className="spin" />
                  : <RefreshCw size={16} className="muted" />}
                <div className="update-card__main">
                  <span>
                    {update.zustand === 'suche' ? t('update.checking')
                      : update.zustand === 'aktuell' ? t('update.upToDate', { version: update.version ?? '' })
                        : update.zustand === 'fehler' ? (update.fehler ?? t('update.failed'))
                          : t('update.idle')}
                  </span>
                </div>
                <button className="btn" onClick={checkForUpdate} disabled={update.zustand === 'suche'}>
                  {t('update.check')}
                </button>
              </>
            )}
          </div>
        )}
        <p className="field__hint">{t('update.installHint')}</p>

        {/* Für weitere Geräte: die Seite trägt den Nachweis in der Adresse,
            weil ein Klick im Browser keinen Kopf mitschickt. */}
        <a
          className="btn btn--ghost"
          style={{ marginTop: 8, textDecoration: 'none', fontSize: 12.5 }}
          href={`${serverUrl().replace(/\/+$/, '')}/download?token=${encodeURIComponent(token() ?? '')}`}
          target="_blank"
          rel="noreferrer"
        >
          <Download size={13} /> {t('update.forOtherDevices')}
        </a>
      </div>

      {/* Der Server — bisher stand hier "alles aktuell", während er noch auf
          dem alten Stand lief. Ohne diese Zeile sah man das nirgends. */}
      {serverVersion && (
        <div className="field">
          <label className="field__label">{t('update.serverTitle')}</label>
          <div className="update-card">
            {serverVeraltet
              ? <Clock size={16} style={{ color: 'var(--amber)' }} />
              : <CheckCircle2 size={16} style={{ color: 'var(--green)' }} />}
            <div className="update-card__main">
              <span>
                {serverVeraltet
                  ? t('update.serverPending', { laeuft: serverVersion, neu: serverNeu! })
                  : t('update.serverCurrent', { version: serverVersion })}
              </span>
              {serverVeraltet && <span className="muted">{t('update.serverWhen')}</span>}
            </div>
          </div>
        </div>
      )}

      {/* Verteilung — nur für die Verwaltung */}
      {darfVeroeffentlichen && (
        <>
          <div className="field">
            <label className="field__label">{t('update.publishTitle')}</label>
            <p className="field__hint" style={{ marginBottom: 9 }}>{t('update.publishHint')}</p>

            <div className="grid-2">
              <div className="field">
                <label className="field__label">{t('update.version')}</label>
                <input
                  className="input" value={version} placeholder="1.2.0"
                  onChange={(e) => setVersion(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field__label">{t('update.notes')}</label>
                <input
                  className="input" value={notes} placeholder={t('update.notesPlaceholder')}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="release-list">
            {PLATTFORMEN.map((p) => {
              const vorhanden = releases.find((r) => r.platform === p.id);
              return (
                <div key={p.id} className="release-row">
                  <span className="release-row__icon">{p.icon}</span>
                  <div className="release-row__main">
                    <span className="release-row__name">{p.name}</span>
                    <span className="release-row__meta">
                      {vorhanden
                        ? `${vorhanden.version} · ${groesse(vorhanden.size)} · ${relativeTime(vorhanden.publishedAt)}`
                        : t('update.nothingYet', { hinweis: p.hinweis })}
                    </span>
                  </div>

                  <input
                    type="file"
                    hidden
                    ref={(el) => { dateiFelder.current[p.id] = el; }}
                    onChange={(e) => {
                      const datei = e.target.files?.[0];
                      if (datei) void hochladen(p.id, datei);
                      e.target.value = '';
                    }}
                  />
                  <button
                    className="btn"
                    disabled={laedtHoch !== null}
                    onClick={() => dateiFelder.current[p.id]?.click()}
                  >
                    {laedtHoch === p.id
                      ? <Loader2 size={14} className="spin" />
                      : <Upload size={14} />}
                    {t('update.upload')}
                  </button>

                  {vorhanden && (
                    <button
                      className="icon-btn icon-btn--danger"
                      title={t('update.remove')}
                      aria-label={t('update.remove')}
                      onClick={async () => {
                        if (!confirm(t('update.removeConfirm', { platform: p.name }))) return;
                        /* Ohne Abfangen verschwand ein Fehlschlag lautlos, und der
                           Eintrag stand weiter da, als hätte der Klick nichts getan. */
                        try {
                          setReleases((await api.removeRelease(p.id)).releases);
                        } catch (err) {
                          toast({ kind: 'error', title: t('update.failed'), body: (err as Error).message });
                        }
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
