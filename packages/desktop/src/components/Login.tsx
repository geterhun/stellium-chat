import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, Star, Download } from 'lucide-react';
import { useStore } from '../state/store.js';
import { api, serverUrl, setServerUrl } from '../net/api.js';
import { useT } from '../i18n/index.js';

export function Login() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [server, setServer] = useState(serverUrl());
  /* Die Adresse, die wirklich gilt. Geprüft wird sie, nicht das Eingabefeld:
     vorher fragte jeder Tastendruck die ALTE Adresse ab, und nach „Setzen"
     — das Feld ändert sich dabei nicht — prüfte niemand die neue. */
  const [gilt, setGilt] = useState(serverUrl());
  const [showServer, setShowServer] = useState(false);

  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.health()
      .then(() => { if (!cancelled) setServerReachable(true); })
      .catch(() => { if (!cancelled) setServerReachable(false); });
    return () => { cancelled = true; };
  }, [gilt]);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await useStore.getState().login(loginId.trim(), password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <motion.div
        className="auth__card"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        <motion.div
          className="auth__logo"
          animate={{ rotate: [0, 6, -6, 0] }}
          transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
        >
          <Star size={28} color="#fff" fill="#fff" />
        </motion.div>

        <h1 className="auth__title">Stellium</h1>
        <p className="auth__sub">{t('auth.tagline')}</p>

        {error && <div className="auth__error">{error}</div>}
        {serverReachable === false && (
          <div className="auth__error">{t('auth.serverUnreachable', { url: gilt })}</div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="field">
            <label className="field__label">{t('auth.userOrEmail')}</label>
            <input className="input" value={loginId} autoFocus autoComplete="username"
              onChange={(e) => setLoginId(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">{t('auth.password')}</label>
            <input className="input" type="password" value={password} autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} />
            <p className="field__hint">{t('auth.firstTimeHint')}</p>
          </div>

          <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
            {busy && <Loader2 size={16} className="spin" />}
            {t('auth.login')}
          </button>
        </form>

        <div className="auth__demo">{t('auth.noAccount')}</div>


        <div style={{ marginTop: 'var(--sp-3)', textAlign: 'center' }}>
          <button
            className="btn btn--ghost"
            style={{ height: 'auto', padding: 4, fontSize: 12 }}
            onClick={() => setShowServer((v) => !v)}
          >
            {showServer ? t('auth.hideServer') : t('auth.otherServer')}
          </button>
          {showServer && (
            <div className="hstack gap-2" style={{ marginTop: 8 }}>
              <input className="input" value={server} onChange={(e) => setServer(e.target.value)} />
              <button className="btn" onClick={() => { setServerUrl(server); setServerReachable(null); setGilt(serverUrl()); }}>{t('auth.set')}</button>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}


