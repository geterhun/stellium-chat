import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, Download, File as FileIcon, FileText, FolderOpen, Hash, Image as ImageIcon,
  Loader2, Lock, Music, Pencil, Search, Trash2, Unlock, Upload, Video, X,
} from 'lucide-react';
import type { StoredFile } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { currentUiLanguage, useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { dateiUrl } from '../net/api.js';
import { dateiAnzeigen } from '../lib/vertraulich.js';
import { clsx, relativeTime, restzeit } from '../lib/format.js';

function groesse(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const einheiten = ['KB', 'MB', 'GB', 'TB'];
  let wert = bytes / 1024;
  let i = 0;
  while (wert >= 1024 && i < einheiten.length - 1) { wert /= 1024; i += 1; }
  return `${wert < 10 ? wert.toFixed(1) : Math.round(wert)} ${einheiten[i]}`;
}

function symbol(mime: string) {
  if (mime.startsWith('image/')) return <ImageIcon size={17} />;
  if (mime.startsWith('video/')) return <Video size={17} />;
  if (mime.startsWith('audio/')) return <Music size={17} />;
  if (mime === 'application/pdf' || mime.startsWith('text/')) return <FileText size={17} />;
  return <FileIcon size={17} />;
}

export function FilesPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const files = useStore((s) => s.files);
  const usage = useStore((s) => s.storageUsage);
  const self = useStore((s) => s.self);
  /* Der Fortschritt lebt im Zustand, nicht in einem lokalen useState: schließt
     jemand diese Ansicht, während eine Datei noch hochlädt, läuft der Upload
     unbeeindruckt weiter (siehe uploadLibraryFiles in state/store.ts) — und
     wer die Ablage wieder öffnet, sieht genau da weiter, wo er stand. */
  const libraryUploads = useStore((s) => s.libraryUploads);
  const { loadFiles, uploadLibraryFiles, dismissLibraryUpload } = useStore.getState();

  const [suche, setSuche] = useState('');
  const [ordner, setOrdner] = useState('');
  /* Bewusst „öffentlich" als Vorgabe. Privat ist die stärkere Zusage, aber
     auch die folgenreichere: an eine private Datei kommt außer der eigenen
     Person niemand mehr, auch keine Vertretung im Urlaub. Wer sie will, soll
     sie wählen. */
  const [privat, setPrivat] = useState(false);
  const [ueberZone, setUeberZone] = useState(false);
  const dateiFeld = useRef<HTMLInputElement>(null);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const laedt = libraryUploads.some((u) => u.status === 'laeuft');

  const ordnerListe = useMemo(
    () => [...new Set(files.map((f) => f.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, currentUiLanguage())),
    [files],
  );

  const sichtbar = useMemo(() => {
    const q = suche.trim().toLowerCase();
    return files.filter((f) => {
      if (ordner === '__root' ? f.folder !== '' : ordner && f.folder !== ordner) return false;
      if (!q) return true;
      return f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q);
    });
  }, [files, suche, ordner]);

  const hochladen = (liste: FileList | null) => {
    if (!liste?.length) return;
    void uploadLibraryFiles(liste, { folder: ordner && ordner !== '__root' ? ordner : undefined, privat });
  };

  const anteil = usage && usage.quota > 0 ? Math.min(1, usage.used / usage.quota) : 0;

  return (
    <Shell
      title={t('files.title')}
      subtitle={usage ? t('files.usage', { used: groesse(usage.used), quota: groesse(usage.quota) }) : t('files.subtitle')}
      icon={<FolderOpen size={18} />}
      onClose={onClose}
      width={980}
      actions={
        <button
          className="pill pill--accent"
          onClick={() => dateiFeld.current?.click()}
          disabled={laedt || !self?.permissions['file.upload']}
        >
          {laedt ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
          {laedt ? t('files.uploading') : t('files.upload')}
        </button>

      }
    >
      <input
        ref={dateiFeld}
        type="file"
        multiple
        hidden
        onChange={(e) => { void hochladen(e.target.files); e.target.value = ''; }}
      />

      {libraryUploads.map((u) => (
        <div key={u.id} className="upload-stand">
          {u.status === 'fehler' ? (
            <div className="upload-stand__kopf">
              <span className="truncate" style={{ color: 'var(--red)' }}>
                <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                {u.name}
              </span>
              <span className="muted truncate" style={{ maxWidth: 260 }} title={u.fehler}>
                {t('toast.uploadFailed')}
              </span>
              <button
                className="icon-btn icon-btn--sm"
                title={t('toast.uploadFailed')}
                aria-label={t('toast.uploadFailed')}
                onClick={() => dismissLibraryUpload(u.id)}
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <>
              <div className="upload-stand__kopf">
                <span className="truncate">{u.name}</span>
                <span className="muted">
                  {[
                    `${Math.round(u.anteil * 100)} %`,
                    u.tempo ? `${(u.tempo / 1048576).toFixed(1)} MB/s` : null,
                    u.rest && u.rest > 1 ? restzeit(u.rest) : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </div>
              <span className="upload-stand__balken">
                <span style={{ width: `${Math.round(u.anteil * 100)}%` }} />
              </span>
            </>
          )}
        </div>
      ))}

      {usage && (
        <div className="quota">
          <motion.span
            className="quota__fill"
            style={{ background: anteil > 0.9 ? 'var(--red)' : 'var(--violet)' }}
            initial={{ width: 0 }}
            animate={{ width: `${anteil * 100}%` }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>
      )}

      <div className="files-bar">
        <div className="files-search">
          <Search size={14} className="muted" />
          <input
            className="input input--bare"
            value={suche}
            placeholder={t('files.searchPlaceholder')}
            onChange={(e) => setSuche(e.target.value)}
          />
        </div>
        <select className="select" value={ordner} onChange={(e) => setOrdner(e.target.value)}>
          <option value="">{t('files.allFolders')}</option>
          <option value="__root">{t('files.rootFolder')}</option>
          {ordnerListe.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>

      {/* Die Wahl steht neben dem Hochladen und nicht in einer Rückfrage
          danach: sie entscheidet, was den Rechner verlässt, und das lässt
          sich hinterher nicht mehr ändern. */}
      <div className="hstack gap-2" style={{ flexWrap: 'wrap', marginBottom: 'var(--sp-2)' }}>
        <button
          className={clsx('pill', !privat && 'pill--accent')}
          onClick={() => setPrivat(false)}
          disabled={laedt}
        >
          <Unlock size={13} /> {t('files.oeffentlich')}
        </button>
        <button
          className={clsx('pill', privat && 'pill--accent')}
          onClick={() => setPrivat(true)}
          disabled={laedt}
        >
          <Lock size={13} /> {t('files.privat')}
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          {privat ? t('files.privatHinweis') : t('files.oeffentlichHinweis')}
        </span>
      </div>

      <div
        className={clsx('dropzone', ueberZone && 'dropzone--over')}
        onDragOver={(e) => { e.preventDefault(); setUeberZone(true); }}
        onDragLeave={() => setUeberZone(false)}
        onDrop={(e) => { e.preventDefault(); setUeberZone(false); void hochladen(e.dataTransfer.files); }}
      >
        {!sichtbar.length ? (
          <div className="empty-state">
            <Upload size={28} className="muted" />
            <p>{files.length ? t('files.empty') : t('files.dropHint')}</p>
          </div>
        ) : (
          <div className="file-list">
            <AnimatePresence initial={false}>
              {sichtbar.map((f) => (
                <FileRow key={f.id} file={f} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </Shell>
  );
}

/**
 * Eine Zeile der Ablage.
 *
 * Steht auf Modulebene und nicht in FilesPanel: dort war sie bei jedem
 * Zeichnen ein neuer Komponententyp, und React baute jede Zeile neu auf —
 * bei jedem Fortschrittsschritt eines Uploads, bei jeder Statusänderung
 * irgendeiner Person. Mit ihr ging `holt` verloren: der Knopf einer gerade
 * entschlüsselten Datei wurde mitten im Herunterladen wieder klickbar.
 */
function FileRow({ file }: { file: StoredFile }) {
  const t = useT();
  const wer = useStore((s) => s.users[file.uploadedBy]);
  const kanal = useStore((s) => (file.channelId ? s.channels[file.channelId] : null));
  const self = useStore((s) => s.self);
  const { deleteFile, updateFile } = useStore.getState();
  const eigene = file.uploadedBy === self?.id;
  const darf = eigene || self?.permissions['file.manage'];
  const [holt, setHolt] = useState(false);

  /**
   * Eine private Datei herunterladen.
   *
   * Der Umweg über den Arbeitsspeicher ist unvermeidlich: entschlüsseln kann
   * nur diese App, und der Browser speichert nur, was er in der Hand hat.
   * Der echte Name kommt dabei aus dem Umschlag der Datei zurück und nicht
   * aus der Liste — in der Liste steht, was der Server kennt.
   */
  const herunterladen = async (datei: StoredFile) => {
    setHolt(true);
    try {
      const { kopf, url } = await dateiAnzeigen(datei.id, datei.url);
      const a = document.createElement('a');
      a.href = url;
      a.download = kopf.name || datei.name;
      /* Erst ins Dokument, dann klicken. Ein Klick auf einen Verweis, der
         nirgends hängt, führt in manchen Browsern zu gar nichts — und dann
         passiert beim Herunterladen scheinbar nichts. */
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      useStore.getState().toast({
        kind: 'error', title: t('files.downloadFehler'), body: (err as Error).message,
      });
    } finally {
      setHolt(false);
    }
  };

  return (
    <motion.div
      layout
      className="file-row"
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.16 }}
    >
      <span className="file-row__icon">{symbol(file.mime)}</span>

      <span className="file-row__main">
        <span className="file-row__name">
          {file.privat && <Lock size={11} style={{ verticalAlign: -1, marginRight: 4, color: 'var(--violet-soft)' }} />}
          {file.name}
        </span>
        <span className="file-row__meta">
          {groesse(file.size)}
          {file.privat && <> · {t('files.privat')}</>}
          {file.folder && <> · <FolderOpen size={10} /> {file.folder}</>}
          {kanal && <> · <Hash size={10} />{kanal.name}</>}
          {' · '}{t('files.uploadedBy', { name: wer?.displayName ?? '—' })}
          {' · '}{relativeTime(file.createdAt)}
        </span>
      </span>

      {wer && <Avatar user={wer} size={22} />}

      {/* Eine private Datei kann der Server nicht herausgeben — bei ihm liegt
          Chiffrat. Ein <a href> lieferte deshalb einen unbrauchbaren Klumpen.
          Also holt die App sie, schließt sie auf und reicht sie erst dann
          weiter. */}
      {file.privat ? (
        <button
          className="icon-btn"
          title={t('files.download')}
          aria-label={t('files.download')}
          disabled={holt}
          onClick={() => void herunterladen(file)}
        >
          {holt ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
        </button>
      ) : (
        <a
          className="icon-btn"
          href={dateiUrl(file.url)}
          target="_blank"
          rel="noreferrer"
          title={t('files.download')}
        >
          <Download size={15} />
        </a>
      )}

      {darf && (
        <button
          className="icon-btn"
          title={t('files.rename')}
          aria-label={t('files.rename')}
          onClick={() => {
            const name = prompt(t('files.rename'), file.name);
            if (name && name.trim() && name !== file.name) updateFile(file.id, { name: name.trim() });
          }}
        >
          <Pencil size={15} />
        </button>
      )}

      {darf && (
        <button
          className="icon-btn icon-btn--danger"
          title={t('files.delete')}
          aria-label={t('files.delete')}
          onClick={() => { if (confirm(t('files.deleteConfirm'))) deleteFile(file.id); }}
        >
          <Trash2 size={15} />
        </button>
      )}
    </motion.div>
  );
}
