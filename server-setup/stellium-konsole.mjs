#!/usr/bin/env node
/**
 * Statuskonsole des Stellium-Servers.
 *
 *   stellium          fortlaufend, aktualisiert sich alle drei Sekunden
 *   stellium einmal   einmal ausgeben und beenden
 *
 * Gezeigt wird nur, was dieser Rechner wirklich hat. Eine Zeile für eine
 * Grafikeinheit, die es nicht gibt, oder für einen Lüfter, der nicht verbaut
 * ist, wäre nur Rauschen — deshalb fällt sie ganz weg statt "n/a" zu sagen.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const EINMAL = process.argv.includes('einmal');
const ALS_JSON = process.argv.includes('json');
const PORT = Number(process.env.STELLIUM_PORT ?? 8787);
const DATEN = process.env.STELLIUM_DATA ?? '/var/lib/stellium';
const ZIEL = '/opt/stellium';

const F = {
  aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m',
  gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', gelb: '\x1b[38;5;221m',
  blau: '\x1b[38;5;111m', violett: '\x1b[38;5;141m', tuerkis: '\x1b[38;5;80m',
};

const BREITE = Math.max(64, Math.min(process.stdout.columns || 92, 110));

function ruf(befehl, args, zeit = 3500) {
  try {
    return execFileSync(befehl, args, { encoding: 'utf8', timeout: zeit, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/** Wie `ruf`, gibt aber auch dann aus, was auf stdout stand, wenn der Befehl
    mit einem Fehlerwert endet — `systemctl is-active` tut das, sobald einer
    der abgefragten Dienste nicht läuft. */
function rufRoh(befehl, args, zeit = 3500) {
  try {
    return execFileSync(befehl, args, { encoding: 'utf8', timeout: zeit, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (f) { return typeof f?.stdout === 'string' ? f.stdout : null; }
}

/* ── Ein Aufruf statt zwölf ────────────────────────────────────
 *
 * `systemctl is-active a b c` nimmt mehrere Namen und antwortet zeilenweise
 * in derselben Reihenfolge. Einzeln gefragt kosteten die Dienstabfragen auf
 * dem Pi 112 ms je Durchgang — bei einer Anzeige, die alle zwei Sekunden
 * läuft, ist das Geld, das ohne Gegenwert ausgegeben wird. */
const DIENSTE_BEKANNT = ['stellium', 'nginx', 'caddy', 'cloudflared', 'tailscaled',
  'stellium-tunnel', 'ollama', 'libretranslate', 'fail2ban', 'ssh'];
let dienstStandAktiv = null;
let dienstStandAn = null;

function diensteFragen(art) {
  const zeilen = (rufRoh('systemctl', [art, ...DIENSTE_BEKANNT]) ?? '').split('\n');
  const karte = new Map();
  DIENSTE_BEKANNT.forEach((d, i) => karte.set(d, (zeilen[i] ?? '').trim()));
  return karte;
}

function dienstAktiv(name) {
  dienstStandAktiv ??= diensteFragen('is-active');
  if (!dienstStandAktiv.has(name)) {
    dienstStandAktiv.set(name, ruf('systemctl', ['is-active', name]) ?? '');
  }
  return dienstStandAktiv.get(name) === 'active';
}

function dienstAn(name) {
  dienstStandAn ??= diensteFragen('is-enabled');
  if (!dienstStandAn.has(name)) {
    dienstStandAn.set(name, ruf('systemctl', ['is-enabled', name]) ?? '');
  }
  return dienstStandAn.get(name) === 'enabled';
}

/* ── Werte, die sich kaum ändern ───────────────────────────────
 *
 * Manches wird alle zwei Sekunden neu erfragt, ändert sich aber im Monat
 * einmal. Gemessen auf diesem Pi: `certbot --version` allein braucht
 * **672 ms** — mehr als die Hälfte des gesamten Laufs, für eine Zahl, die
 * seit Wochen dieselbe ist. `fail2ban-server --version` kostet weitere 83 ms,
 * `fail2ban-client status sshd` 139 ms.
 *
 * Solche Werte kommen deshalb aus einer kleinen Datei und werden nur
 * nachgeholt, wenn sie alt genug sind. */
const TRAEGE_DATEI = process.env.STELLIUM_TRAEGE
  ?? `${process.env.XDG_CACHE_HOME ?? `${os.homedir()}/.cache`}/stellium/traege.json`;
let traegeStand = null;
let traegeGeaendert = false;

function traege(name, frist, holen) {
  if (!traegeStand) {
    try { traegeStand = JSON.parse(fs.readFileSync(TRAEGE_DATEI, 'utf8')); } catch { traegeStand = {}; }
  }
  const e = traegeStand[name];
  if (e && Date.now() - (e.wann ?? 0) < frist) return e.wert;
  const wert = holen();
  traegeStand[name] = { wann: Date.now(), wert };
  traegeGeaendert = true;
  return wert;
}

function traegeSichern() {
  if (!traegeGeaendert || !traegeStand) return;
  try {
    fs.mkdirSync(TRAEGE_DATEI.slice(0, TRAEGE_DATEI.lastIndexOf('/')), { recursive: true, mode: 0o700 });
    const vorlaeufig = `${TRAEGE_DATEI}.${process.pid}`;
    fs.writeFileSync(vorlaeufig, JSON.stringify(traegeStand), { mode: 0o600 });
    fs.renameSync(vorlaeufig, TRAEGE_DATEI);
    traegeGeaendert = false;
  } catch { /* nicht schlimm, dann eben beim nächsten Mal */ }
}

function groesse(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const e = ['B', 'KB', 'MB', 'GB', 'TB'];
  let w = bytes, i = 0;
  while (w >= 1024 && i < e.length - 1) { w /= 1024; i += 1; }
  return `${w < 10 && i > 0 ? w.toFixed(1) : Math.round(w)} ${e[i]}`;
}

function dauer(sek) {
  const t = Math.floor(sek / 86400);
  const s = Math.floor((sek % 86400) / 3600);
  const m = Math.floor((sek % 3600) / 60);
  if (t) return `${t} ${t === 1 ? 'Tag' : 'Tage'}, ${s} Std`;
  if (s) return `${s} Std, ${m} Min`;
  return `${m} Min`;
}

/* ── Was der Rechner hergibt ─────────────────────────────────── */

/** Auslastung der Prozessorkerne über einen kurzen Zeitraum. */
let letzteCpu = null;
function cpuAuslastung() {
  const jetzt = os.cpus().reduce((a, c) => {
    const gesamt = Object.values(c.times).reduce((x, y) => x + y, 0);
    return { gesamt: a.gesamt + gesamt, leerlauf: a.leerlauf + c.times.idle };
  }, { gesamt: 0, leerlauf: 0 });

  if (!letzteCpu) { letzteCpu = jetzt; return os.loadavg()[0] / os.cpus().length; }
  const dg = jetzt.gesamt - letzteCpu.gesamt;
  const dl = jetzt.leerlauf - letzteCpu.leerlauf;
  letzteCpu = jetzt;
  return dg > 0 ? Math.min(1, Math.max(0, 1 - dl / dg)) : 0;
}

/** Temperaturen — jede gefundene Zone mit brauchbarem Namen. */
function temperaturen() {
  const werte = [];
  try {
    for (const eintrag of fs.readdirSync('/sys/class/thermal')) {
      if (!eintrag.startsWith('thermal_zone')) continue;
      const roh = Number(fs.readFileSync(`/sys/class/thermal/${eintrag}/temp`, 'utf8'));
      if (!Number.isFinite(roh) || roh <= 0) continue;
      let name = 'CPU';
      try { name = fs.readFileSync(`/sys/class/thermal/${eintrag}/type`, 'utf8').trim(); } catch { /* egal */ }
      werte.push({ name: name.replace(/_thermal|-thermal|_zone\d*/g, '') || 'CPU', grad: Math.round(roh / 1000) });
    }
  } catch { /* kein thermal-Verzeichnis */ }
  return werte;
}

/** Taktrate des Prozessors, falls ablesbar. */
function takt() {
  const vc = ruf('vcgencmd', ['measure_clock', 'arm']);
  if (vc) {
    const hz = Number(vc.split('=')[1]);
    if (Number.isFinite(hz) && hz > 0) return Math.round(hz / 1e6);
  }
  try {
    const khz = Number(fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8'));
    if (Number.isFinite(khz) && khz > 0) return Math.round(khz / 1000);
  } catch { /* nicht vorhanden */ }
  return null;
}

/** Grafikeinheit: beim Pi über vcgencmd, sonst gar nicht. */
function grafik() {
  const speicher = ruf('vcgencmd', ['get_mem', 'gpu']);
  const frequenz = ruf('vcgencmd', ['measure_clock', 'core']);
  if (!speicher && !frequenz) return null;
  const mb = speicher ? Number(speicher.split('=')[1]?.replace('M', '')) : null;
  const mhz = frequenz ? Math.round(Number(frequenz.split('=')[1]) / 1e6) : null;
  return { mb, mhz };
}

/** Drosselt der Pi gerade? Das erklärt langsame Antworten. */
function drosselung() {
  const roh = ruf('vcgencmd', ['get_throttled']);
  if (!roh) return null;
  const wert = Number.parseInt(roh.split('=')[1], 16);
  if (!Number.isFinite(wert) || wert === 0) return { jetzt: [], frueher: [] };
  const jetzt = [];
  const frueher = [];
  if (wert & 0x1) jetzt.push('Unterspannung');
  if (wert & 0x2) jetzt.push('Takt begrenzt');
  if (wert & 0x4) jetzt.push('gedrosselt');
  if (wert & 0x8) jetzt.push('Temperaturgrenze');
  if (wert & 0x10000) frueher.push('Unterspannung');
  if (wert & 0x40000) frueher.push('gedrosselt');
  return { jetzt, frueher };
}

function platte(pfad = '/') {
  const aus = ruf('df', ['-B1', '--output=used,size,target', pfad]);
  if (!aus) return null;
  const zeile = aus.split('\n')[1]?.trim().split(/\s+/);
  if (!zeile) return null;
  return { belegt: Number(zeile[0]), gesamt: Number(zeile[1]) };
}

/** Auslagerungsspeicher, falls eingerichtet. */
function swap() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const gesamt = Number(/SwapTotal:\s+(\d+)/.exec(text)?.[1] ?? 0) * 1024;
    const frei = Number(/SwapFree:\s+(\d+)/.exec(text)?.[1] ?? 0) * 1024;
    if (!gesamt) return null;
    return { belegt: gesamt - frei, gesamt };
  } catch { return null; }
}

/** Netzverkehr seit dem Start, über alle echten Karten. */
function netz() {
  try {
    let rein = 0, raus = 0;
    for (const karte of fs.readdirSync('/sys/class/net')) {
      if (karte === 'lo') continue;
      rein += Number(fs.readFileSync(`/sys/class/net/${karte}/statistics/rx_bytes`, 'utf8'));
      raus += Number(fs.readFileSync(`/sys/class/net/${karte}/statistics/tx_bytes`, 'utf8'));
    }
    return { rein, raus };
  } catch { return null; }
}

function modell() {
  try { return fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim(); }
  catch { return `${os.type()} ${os.arch()}`; }
}

/* ── Was Stellium hergibt ────────────────────────────────────── */

async function gesundheit() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Wie viel Platz die Dateiablage belegt — und was ihr noch bleibt. */
/** Einen Wert aus den Einstellungen des Dienstes lesen. */
function env(name) {
  for (const datei of ['/etc/stellium.env', `${ZIEL}/packages/server/.env`, `${ZIEL}/.env`]) {
    try {
      const treffer = fs.readFileSync(datei, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
      if (treffer) return treffer[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* gibt es nicht — nächste probieren */ }
  }
  return null;
}

function ablage() {
  const ordner = [`${DATEN}/uploads`, `${DATEN}/storage`];
  let belegt = 0;
  let dateien = 0;
  const zaehlen = (pfad) => {
    let eintraege;
    try { eintraege = fs.readdirSync(pfad, { withFileTypes: true }); }
    catch { return; }                    // gibt es nicht oder kein Zugriff
    for (const e of eintraege) {
      const voll = `${pfad}/${e.name}`;
      if (e.isDirectory()) { zaehlen(voll); continue; }
      try { belegt += fs.statSync(voll).size; dateien += 1; } catch { /* eben weg */ }
    }
  };
  for (const o of ordner) zaehlen(o);

  /* Gemeint ist das Kontingent der Chat-App, nicht die Systemplatte: die
     Ablage darf nur bis zu einer festgelegten Größe wachsen, und genau die
     Grenze interessiert. Reicht die Platte darunter nicht mehr aus, gilt
     natürlich der kleinere der beiden Werte. */
  const kontingent = Number(env('STORAGE_QUOTA_GB') ?? 50) * 1024 ** 3;
  const RESERVE = 15 * 1024 ** 3;   // wie im Server: so viel bleibt der Platte
  const pl = platte(DATEN);
  const plattenrest = pl ? pl.gesamt - pl.belegt : null;
  // Dieselbe Grenze wie in packages/server/src/services/files.ts, sonst zeigte
  // die Konsole mehr Platz an, als die App tatsächlich vergibt.
  const grenze = plattenrest === null
    ? kontingent
    : Math.min(kontingent, Math.max(0, plattenrest + belegt - RESERVE));

  return { belegt, dateien, frei: Math.max(0, grenze - belegt), gesamt: grenze, plattenrest };
}

/**
 * Welche Rollen als „technisches Konto" gelten — für `kontenBedingung()`
 * unten und für nichts sonst.
 *
 * Ruft der Server dieses Skript (systemwerte.ts, execFile), reicht er die
 * echte Liste aus `ROLES`/`technical` (@stellium/shared, siehe TeamAdmin.tsx
 * ZUWEISBARE_ROLLEN für dieselbe Quelle) als Umgebungsvariable durch — genau
 * wie den Gumroad-Token oben in dieser Datei, aus demselben Grund: ein
 * eigenständiges .mjs-Skript, per `node` gestartet, kennt das TypeScript-Paket
 * zur Laufzeit nicht. Wer die Konsole von Hand per SSH aufruft, ohne dass der
 * Server die Variable gesetzt hat, bekommt die Vorgabe 'bot' — heute die
 * einzige technische Rolle im Katalog.
 */
function technischeRollen() {
  const gesetzt = process.env.STELLIUM_TECHNISCHE_ROLLEN;
  const liste = (gesetzt ?? 'bot').split(',').map((r) => r.trim()).filter((r) => /^[a-z_]+$/.test(r));
  // Vom Server ausdrücklich gesetzt (auch als leere Liste) gilt immer —
  // nur ohne jede Angabe (SSH von Hand) greift die Vorgabe unten.
  if (gesetzt !== undefined) return liste;
  return liste.length ? liste : ['bot'];
}

/**
 * Nur Konten, die wirklich zum Team gehören: kein technisches Konto (Bot,
 * KI-Assistent, künftige Integrationen), keins, das gesperrt oder gelöscht
 * ist. Speist „Konten" in der Konsole *und*, über systemwerte.ts, den
 * Nenner des „Team online"-Bogens in der App (SystemPanel.tsx liest
 * `inhalt.users` für beides — ein Feld, zwei Anzeigen).
 *
 * Dieselbe Regel wie toUser() (packages/server/src/services/store.ts, Feld
 * `technisch`): eine gewählte Kategorie schlägt die Vermutung aus der Rolle.
 */
function kontenBedingung() {
  const rollen = technischeRollen().map((r) => `'${r}'`).join(',');
  const rollenBedingung = rollen.length ? `role IN (${rollen})` : '0';
  return ` WHERE deleted_at IS NULL AND disabled = 0
    AND NOT (
      (kategorie IS NOT NULL AND kategorie = 'technisch')
      OR (kategorie IS NULL AND ${rollenBedingung})
    )`;
}

function zahlen() {
  const datei = `${DATEN}/stellium.db`;
  if (!fs.existsSync(datei)) return null;
  const felder = ['users', 'channels', 'messages', 'tasks', 'events', 'files', 'ideas'];
  const ergebnis = {};
  for (const t of felder) {
    const sql = t === 'users' ? `SELECT COUNT(*) FROM users${kontenBedingung()};` : `SELECT COUNT(*) FROM ${t};`;
    let aus = ruf('sqlite3', ['-readonly', datei, sql]);
    /* Sehr alte Datenbank, disabled/deleted_at/kategorie fehlen noch (siehe
       migrate.ts, Nachrüstung, "Nachrüstung" in CLAUDE.md) — dann lieber die
       rohe Zahl als gar keine. */
    if (aus === null && t === 'users') aus = ruf('sqlite3', ['-readonly', datei, 'SELECT COUNT(*) FROM users;']);
    if (aus !== null && aus !== '') ergebnis[t] = Number(aus);
  }
  try { ergebnis.groesse = fs.statSync(datei).size; } catch { /* egal */ }
  return Object.keys(ergebnis).length ? ergebnis : null;
}

function version() {
  try { return JSON.parse(fs.readFileSync(`${ZIEL}/packages/desktop/package.json`, 'utf8')).version; }
  catch { return null; }
}

function adressen() {
  const liste = [];
  try {
    // sites-enabled, nicht sites-available: eine Datei, die zwar dasteht, aber
    // nicht verlinkt ist, bedient niemanden. Zieht der Zugang auf einen Tunnel
    // um, bleibt die alte Datei liegen — die Konsole nannte dann weiter die
    // tote DuckDNS-Adresse, und weil dort „listen … ssl" steht, sogar als
    // gesicherte Verbindung. Eine falsche Adresse ist schlechter als keine.
    const conf = fs.readFileSync('/etc/nginx/sites-enabled/stellium', 'utf8');
    // Auch 'listen 192.168.1.66:443 ssl;' oder 'listen 9443 ssl;' zählen.
    const tls = /listen[^;]*\bssl\b/.test(conf);
    const namen = [...conf.matchAll(/server_name\s+([^;]+);/g)]
      .flatMap((m) => m[1].trim().split(/\s+/))
      .filter((n) => n !== '_' && n !== 'localhost');
    for (const n of [...new Set(namen)]) {
      liste.push({ art: tls ? 'sicher' : 'offen', url: `${tls ? 'https' : 'http'}://${n}` });
    }
  } catch { /* nginx noch nicht eingerichtet */ }

  // Ein Tunnel hat keine eigene nginx-Zeile — seine Adresse steht in einer Datei.
  try {
    const tunnel = fs.readFileSync(`${DATEN}/tunnel-adresse`, 'utf8').trim();
    if (tunnel) liste.push({ art: 'tunnel', url: tunnel });
  } catch { /* kein Tunnel eingerichtet */ }

  /*
   * `os.networkInterfaces()` darf scheitern, und es tut es.
   *
   * Unter dem Dienstbenutzer scheitert es mit ERR_SYSTEM_ERROR 97
   * (EAFNOSUPPORT): die systemd-Einheit schränkt die Adressfamilien ein, und
   * uv_interface_addresses braucht eine, die dort fehlt. Von Hand als
   * angemeldeter Benutzer läuft dieselbe Zeile durch — deshalb fiel es
   * monatelang nicht auf und erst dann, als die Chat-App diese Werte über
   * den Server holte.
   *
   * Eine Überwachungsanzeige darf an einer einzelnen Messung nicht sterben.
   * Ohne den Fang riss dieser Aufruf die GESAMTE Ausgabe mit: keine
   * Auslastung, keine Temperatur, keine Dienste — wegen einer Liste von
   * Netzadressen, die nur zur Bequemlichkeit dabeisteht.
   */
  try {
    for (const [, karten] of Object.entries(os.networkInterfaces())) {
      for (const a of karten ?? []) {
        if (a.family === 'IPv4' && !a.internal) liste.push({ art: 'lokal', url: `http://${a.address}` });
      }
    }
  } catch { /* dann eben ohne die lokalen Adressen */ }
  return liste;
}

function zertifikat() {
  // Erst der direkte Weg — der klappt nur als root, denn /etc/letsencrypt/live
  // gehört root allein.
  try {
    for (const name of fs.readdirSync('/etc/letsencrypt/live', { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const ende = ruf('openssl', ['x509', '-enddate', '-noout', '-in', `/etc/letsencrypt/live/${name.name}/fullchain.pem`]);
      if (!ende) continue;
      return {
        art: 'lokal',
        name: name.name,
        tage: Math.round((new Date(ende.split('=')[1]) - Date.now()) / 86400000),
      };
    }
  } catch { /* kein Zugriff oder keines vorhanden — unten weiter */ }

  /* Ohne Root wird nachgefragt statt nachgelesen: nginx zeigt sein Zertifikat
     jedem, der anklopft. Vorher stand hier deshalb „kein Zertifikat", obwohl
     eines da war — die Konsole läuft nun einmal nicht als root. */
  try {
    // Auch hier der verlinkte Stand: an einer nicht eingeschalteten Seite ist
    // kein Zertifikat abzuholen, und das Nachfragen liefe ins Leere.
    const conf = fs.readFileSync('/etc/nginx/sites-enabled/stellium', 'utf8');
    const name = (conf.match(/server_name\s+([^;\s]+)/) ?? [])[1];
    /* Wohin nginx wirklich lauscht, steht in der Zeile selbst — auf einer
       festen Adresse ist unter 127.0.0.1 nichts zu holen. Deshalb wird jede
       ssl-Zeile ausprobiert, bis eine antwortet. */
    const stellen = [...conf.matchAll(/listen\s+([^;]*?\bssl\b[^;]*);/g)].map((m) => {
      const teil = m[1].trim().split(/\s+/)[0];
      const treffer = teil.match(/^(?:\[([^\]]+)\]|([\d.]+)):(\d+)$/);
      if (treffer) return { wirt: treffer[1] ?? treffer[2], port: treffer[3] };
      return { wirt: '127.0.0.1', port: teil.replace(/\D/g, '') };
    }).filter((a) => a.port);

    for (const { wirt, port } of stellen) {
      const roh = ruf('bash', ['-c',
        `echo | openssl s_client -connect ${wirt}:${port}`
        + `${name ? ` -servername ${name}` : ''} 2>/dev/null | openssl x509 -noout -enddate -subject 2>/dev/null`],
      6000);
      const ende = (roh.match(/notAfter=(.+)/) ?? [])[1];
      if (!ende) continue;
      const cn = (roh.match(/CN\s*=\s*([^,\n]+)/) ?? [])[1];
      return {
        art: 'lokal',
        name: (cn ?? name ?? 'Zertifikat').trim(),
        tage: Math.round((new Date(ende) - Date.now()) / 86400000),
      };
    }
  } catch { /* keine Datei, kein Zugriff — unten weiter */ }

  /* Kein lokales Zertifikat gefunden — das heißt noch nicht "offen". Seit dem
     Umzug auf den Cloudflare-Tunnel (server-setup/FREMDE-DIENSTE.md) läuft
     chat.stellium.club direkt auf den Node-Dienst dieses Rechners, an nginx
     vorbei; dort nachzusehen findet folgerichtig nichts mehr. TLS endet
     stattdessen bei Cloudflare selbst — /etc/cloudflared/config.yml sagt das
     wörtlich: "kein Zertifikat zum Erneuern. Cloudflare beendet TLS." Am
     22.08. nachgemessen: chat.stellium.club zeigt ein gültiges
     Cloudflare-Zertifikat (Google Trust Services, SAN *.stellium.club),
     während dieser Pi weder Port 80 noch 443 belegt — dort ist niemand, der
     eine offene Verbindung anbieten könnte. Nur mitgelesen, nichts verändert:
     /etc/cloudflared/** gehört zum Teil auch dem Kollegen, siehe
     FREMDE-DIENSTE.md. */
  return tunnelZertifikat();
}

/** Läuft unser eigener Dienst durch den Cloudflare-Tunnel — und übernimmt
 *  Cloudflare damit die TLS-Beendigung, statt dass hier ein Zertifikat fehlt?
 *
 *  Geprüft wird die eingerichtete ingress-Regel in /etc/cloudflared/config.yml
 *  (weltweit lesbar, 644 — kein sudo nötig, die Konsole bleibt ohne Root):
 *  ein Tunnelname, dessen Ziel auf unseren eigenen Port zeigt (denselben, den
 *  auch `gesundheit()` weiter oben abfragt), zählt. Alles, was auf Port 8080
 *  zeigt — die Seite des Kollegen, siehe FREMDE-DIENSTE.md — ausdrücklich
 *  nicht: dessen Zertifikatsfrage ist nicht unsere. */
function tunnelZertifikat() {
  if (!dienstAktiv('cloudflared')) return null;
  try {
    const conf = fs.readFileSync('/etc/cloudflared/config.yml', 'utf8');
    for (const block of conf.split(/\n(?=\s*-\s*hostname:)/)) {
      const hostname = (block.match(/hostname:\s*(\S+)/) ?? [])[1];
      const port = (block.match(/service:\s*https?:\/\/127\.0\.0\.1:(\d+)/) ?? [])[1];
      if (hostname && port && Number(port) === PORT) {
        return { art: 'tunnel', anbieter: 'Cloudflare', name: hostname };
      }
    }
  } catch { /* kein Zugriff oder kein Tunnel eingerichtet — dann wirklich keines */ }
  return null;
}

/** Fassung der beteiligten Programme — nur die, die es gibt. */
/* Einmal je Stunde genügt: Programmfassungen ändern sich beim Aktualisieren,
   nicht zwischen zwei Auffrischungen. */
const bestandteile = () => traege('bestandteile', 3600000, bestandteileMessen);

function bestandteileMessen() {
  const liste = [];
  const nimm = (name, befehl, args, muster) => {
    const aus = ruf(befehl, args);
    if (!aus) return;
    const treffer = muster.exec(aus);
    liste.push({ name, fassung: treffer ? treffer[1] : aus.split('\n')[0].slice(0, 24) });
  };
  liste.push({ name: 'Node', fassung: process.versions.node });
  nimm('nginx', 'nginx', ['-v'], /nginx\/([\d.]+)/);
  nimm('certbot', 'certbot', ['--version'], /certbot ([\d.]+)/);
  nimm('SQLite', 'sqlite3', ['--version'], /^([\d.]+)/);
  nimm('fail2ban', 'fail2ban-server', ['--version'], /v([\d.]+)/);
  nimm('ufw', 'ufw', ['version'], /ufw ([\d.]+)/);
  return liste;
}

/** Wie viele Sperren hat fail2ban gerade?
 *
 * `fail2ban-client` braucht 139 ms für die Auskunft. Eine halbe Minute alt
 * darf sie sein — wer aussperrt wird, bleibt ausgesperrt. */
const gesperrt = () => traege('gesperrt', 30000, gesperrtMessen);

function gesperrtMessen() {
  const aus = ruf('fail2ban-client', ['status', 'sshd']);
  if (!aus) return null;
  const n = /Currently banned:\s+(\d+)/.exec(aus);
  return n ? Number(n[1]) : null;
}

/* ── Website des Kollegen ──────────────────────────────────────
 *
 * Auf demselben Pi liefert `caddy` die Website eines Kollegen aus (Port
 * 8080, aus /srv/stellium). Sie gehört uns nicht — siehe
 * server-setup/FREMDE-DIENSTE.md. Hier wird ausschließlich mitgelesen:
 *
 *   · Kein Zugriff auf /srv, /etc/caddy, Port 8080 oder Port 2019.
 *   · Die Konsole ruft die Seite auch selbst nicht auf. Ein Aufruf alle
 *     zwei Sekunden wären 43 000 Zeilen am Tag in seinem Protokoll und in
 *     seiner Statistik — fremde Zahlen verfälscht man nicht. Ob die Seite
 *     antwortet, verrät das Protokoll ohnehin: echte Besucher bekommen
 *     dort echte Antwortcodes.
 *   · Gelesen wird das Journal, denn der Caddyfile endet auf ein blankes
 *     `log`. Eine Datei gibt es nicht, und der Kommentar dort erklärt auch
 *     warum: die mitgelieferte Einheit ist sandkastenbeschränkt und käme
 *     an /var/log/caddy nicht heran.
 *
 * Datenschutz — es sind die Besucher eines anderen, und diese Anzeige ist
 * der Schreibtischgrund, den jeder im Raum sieht. Von einer Adresse bleibt
 * nur sha256(Salz + Adresse), auf zwölf Zeichen gekürzt; das Salz wechselt
 * wöchentlich, wird neu gewürfelt und liegt mit der Datei unter 0600. Aus
 * einer Kennung wird nur gezählt, nie etwas angezeigt. Was Tailscale an
 * `Tailscale-User-Login`, `-User-Name` und `-User-Profile-Pic` mitschickt —
 * echte Namen von Leuten im Tailnet — wird nicht einmal gelesen. Von
 * Verweisen bleibt der Name des Rechners, nie die volle Adresse.
 *
 * Aufwand — die Anzeige frischt alle zwei Sekunden auf. Das Journal jedes
 * Mal ganz zu lesen kostet auf diesem Pi 0,31 s und 75 MB; das wäre Unfug.
 * Stattdessen merkt sich die Datei den Journal-Zeiger, und ein Lauf faltet
 * nur ein, was seither hinzugekommen ist (`--after-cursor`, gemessen
 * 0,00 s). Der Antwortkopf wird vor dem Auswerten abgeschnitten: allein die
 * Inhaltsrichtlinie darin ist gut ein Kilobyte und macht den Großteil jeder
 * Zeile aus.
 */

const WEBSTAT_FASSUNG = 3;

/* Die Fassung steht im Dateinamen, nicht nur in der Datei.
 *
 * Am 20.08. live beobachtet: zwei Stände der Konsole liefen nebeneinander —
 * der laufende Hintergrund mit einer älteren Abschrift und dieser hier. Beide
 * teilten sich eine Datei, jeder hielt die Fassung des anderen für ungültig
 * und trug **bei jedem einzelnen Lauf** die ganze Woche neu aus dem Journal
 * nach: 0,35 s obendrauf, alle zwei Sekunden, unbemerkt. Mit der Fassung im
 * Namen gehen sich zwei Stände aus dem Weg, und ein Rückschritt wirft den
 * neuen Stand nicht weg. */
const WEBSTAT_DATEI = process.env.STELLIUM_WEBSTAT
  ?? `${process.env.XDG_CACHE_HOME ?? `${os.homedir()}/.cache`}/stellium/webstatistik-${WEBSTAT_FASSUNG}.json`;

/* Fassung 2: seit dem 20.08. stehen je Tag auch `neu` und `wieder` in der
   Datei. Ein Zustand aus Fassung 1 hätte für heute schon alle Kennungen
   gesammelt, aber keine Einteilung dazu — die Anzeige zeigte dann tagelang
   „0 neu, 0 wiederkehrend", ohne dass etwas kaputt aussähe. Die höhere
   Fassung wirft den alten Stand weg und trägt einmal aus dem Journal nach. */
const JETZT_FENSTER = 300;        // „gerade da" — fünf Minuten
const JETZT_HALTEN = 1800;        // so lange bleibt eine Kennung überhaupt liegen
const TAGE_HALTEN = 8;            // ein Tag mehr als die Woche, die gezeigt wird
const LISTE_MAX = 40;             // je Tag so viele Pfade, Quellen, Fehlstellen
const BESUCHER_MAX = 20000;       // Notbremse gegen unbegrenztes Wachsen
const MINDESTABSTAND = 4000;      // ms zwischen zwei Faltungen

const ASSET_ENDUNG = new Set(['css', 'js', 'mjs', 'map', 'svg', 'png', 'jpg', 'jpeg',
  'gif', 'webp', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4',
  'webm', 'ogg', 'mp3', 'wav', 'json', 'xml', 'txt', 'pdf', 'zip', 'gz', 'wasm']);

/* Maschinen, die sich zu erkennen geben. Sie zählen getrennt: eine
   Besucherzahl, in der Googlebot und ein Schwachstellenscanner stecken,
   ist keine Besucherzahl. */
const MASCHINE = /bot[\s/)]|bot$|crawl|spider|scrap|scan|curl\/|wget|python-|okhttp|java\/|go-http|libwww|headless|lighthouse|monitor|dashboard|uptime|pingdom|facebookexternalhit|slurp|yandex|baidu|petal|semrush|ahrefs|mj12|dotbot|gptbot|ccbot|claude|perplexity|applebot/i;

/* Pfade, die Browser und Suchmaschinen von sich aus holen. Fehlen sie, ist
   das ein echter Mangel an der Seite — kein Einbruchsversuch. */
const ERWARTET = new Set(['/favicon.ico', '/robots.txt', '/sitemap.xml', '/humans.txt',
  '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/browserconfig.xml',
  '/manifest.json', '/site.webmanifest', '/.well-known/security.txt']);

/* ── Wiedererkennung über Wochen und Monate ────────────────────
 *
 * Don hat das ausdrücklich so entschieden: „neu" und „wiederkehrend" sollen
 * auch dann stimmen, wenn jemand nach vier Wochen wiederkommt.
 *
 * Dafür reicht das wöchentlich wechselnde Salz nicht — es war ja gerade die
 * Maßnahme, die eine dauerhafte Wiedererkennung verhindert. Deshalb **zwei
 * Salze nebeneinander**, und das ist eine Abwägung, keine Nachlässigkeit:
 *
 *   · `stand.salz` wechselt weiterhin **wöchentlich** und trägt alles
 *     Kurzfristige — wer gerade da ist, wie viele verschiedene heute. Aus
 *     diesen Kennungen ist nach einer Woche nichts mehr rückzurechnen.
 *   · `buch.salz` bleibt **stehen**. Nur damit lässt sich sagen: den kenne
 *     ich schon. Das ist ein dauerhaftes Wiedererkennungsmerkmal und damit
 *     etwas anderes als ein Zähler, der vergisst.
 *
 * Die Seite hat Sprachordner für Deutsch, Polnisch und Russisch, hat also
 * europäische Besucher — und es sind die Besucher eines anderen. Deshalb
 * steht in der Datei selbst im Klartext, was dort liegt, wie lange und
 * wozu, damit jemand das später bewusst ändern kann. Adressen stehen dort
 * nicht, nur Streuwerte.
 */
const GESEHEN_ORDNER = process.env.STELLIUM_GESEHEN
  ?? `${process.env.XDG_CACHE_HOME ?? `${os.homedir()}/.cache`}/stellium/webbesucher`;
const GESEHEN_HALTEN = 730;        // Tage — danach wird ein Eintrag gelöscht
const GESEHEN_MAX = 20000;         // je Fach; Notbremse, falls das Ausmisten ausfällt

/* Aufgeteilt auf 256 Fächer nach den ersten beiden Zeichen der Kennung.
 *
 * Erst in einer Datei gebaut und gemessen: bei 100 000 Besuchern kostete ein
 * Faltvorgang, der neue Besucher einträgt, **220 ms** — 1,8 MB lesen, ändern,
 * zurückschreiben. Das Nachschlagen selbst war dabei umsonst (1,1 µs), die
 * ganze Zeit ging für die Datei drauf, und sie wächst weiter: in drei Jahren
 * wären es über eine halbe Sekunde. Für eine Anzeige, deren gesamte
 * Auswertung sonst 35 ms braucht, ist das zu viel.
 *
 * Mit Fächern werden nur die paar angefasst, in denen wirklich jemand Neues
 * steht — meist ein bis drei von 256. Der Aufwand hängt damit an der Zahl der
 * neuen Besucher, nicht mehr an der Größe der Sammlung. */
const GESEHEN_FAECHER = 256;

const GESEHEN_HINWEIS = [
  'Wiedererkennung von Besuchern der Website eines Dritten (Triton, /srv/stellium),',
  'damit die Stellium-Konsole „neu" von „wiederkehrend" unterscheiden kann.',
  'ENTHÄLT KEINE IP-ADRESSEN: je Besucher steht in den Fächern nur',
  'sha256(salz + Adresse), auf 12 Zeichen gekürzt, und die Nummer des Tages',
  `seines letzten Besuchs — sonst nichts. Aufbewahrung: ${GESEHEN_HALTEN} Tage ab dem`,
  'letzten Besuch, danach wird der Eintrag beim nächsten Anfassen gelöscht.',
  'Das Salz bleibt stehen; ohne ein festes Salz gäbe es keine Wiedererkennung',
  'über Wochen — das ist der bewusste Unterschied zu den übrigen Zählern der',
  'Konsole, deren Salz wöchentlich wechselt. Wer das nicht möchte, löscht',
  'diesen Ordner: die Konsole legt ihn neu an und zählt danach wieder alle',
  'als neu. Angelegt auf Wunsch von Don, 20.08.2026.',
].join(' ');

const tagNummer = (tag) => Math.floor(Date.parse(`${tag}T12:00:00Z`) / 86400000);

/* ── Zahlen seit Zählbeginn ────────────────────────────────────
 *
 * Don wollte „wieviele Besucher und Views es jemals gab". „Jemals" gibt das
 * Journal nicht her — es reicht fünf Tage zurück. Was es gibt, ist **seit
 * Zählbeginn**, und der Zählbeginn ist der älteste Tag, den wir je gesehen
 * haben: beim ersten Lauf also der älteste Journaleintrag, nicht der Tag, an
 * dem diese Zeilen entstanden sind. Das Datum steht in `gesamt.seit` und
 * gehört in die Anzeige — „insgesamt" ohne Bezug behauptete mehr, als die
 * Daten hergeben.
 *
 * Die Datei trägt **keine Fassungsnummer im Namen**, und das mit Absicht:
 * genau daran wäre sie heute schon einmal gestorben, als zwei Stände der
 * Konsole sich eine Datei teilten und gegenseitig für ungültig erklärten. Ein
 * Gesamtzähler, der beim Fassungswechsel bei null anfängt, ist schlimmer als
 * keiner.
 *
 * Rückwärts laufen kann er nicht, weil nicht aufaddiert, sondern **je Tag
 * abgelegt** wird: ein erneutes Einlesen desselben Tages überschreibt seinen
 * Eintrag, statt ihn ein zweites Mal dazuzuzählen. Und überschrieben wird nur
 * nach oben — wenn das Journal inzwischen rotiert ist und für einen alten Tag
 * weniger hergibt, bleibt der höhere Wert stehen. Ein Tag kostet rund 50
 * Bytes; auch nach Jahren ist das eine Datei von wenigen Zehntel-Megabyte.
 */
const GESAMT_DATEI = process.env.STELLIUM_GESAMT
  ?? `${process.env.XDG_CACHE_HOME ?? `${os.homedir()}/.cache`}/stellium/gesamt.json`;
const GESAMT_TAGE_MAX = 4000;      // gut zehn Jahre

function gesamtLesen() {
  const da = jsonLesen(GESAMT_DATEI);
  if (da?.tage) return da;
  return { fassung: 1, seit: null, besucher: 0, buchAngelegt: null, tage: {} };
}

/** Die Tageswerte spiegeln und die Gesamtzahlen fortschreiben.
 *
 * `dazu` ist die Zahl der Besucher, die in diesem Durchgang zum ersten Mal
 * überhaupt aufgetaucht sind — die kommt aus der Wiedererkennung und ist
 * schon dort gezählt worden. Die Fächer noch einmal durchzuzählen wäre bei
 * über 150 000 Besuchern im Jahr Unfug. */
function gesamtFortschreiben(stand, dazu, buchAngelegt) {
  const g = gesamtLesen();
  for (const [tag, e] of Object.entries(stand.tage)) {
    const alt = g.tage[tag];
    const neu = { treffer: e.treffer, seiten: e.seiten, bytes: e.bytes };
    /* Nur nach oben. Ein rotiertes Journal liefert für einen alten Tag
       weniger — der höhere Wert von damals bleibt der richtige. */
    if (!alt || neu.treffer >= (alt.treffer ?? 0)) g.tage[tag] = neu;
  }
  const namen = Object.keys(g.tage).sort();
  if (namen.length > GESAMT_TAGE_MAX) {
    for (const t of namen.slice(0, namen.length - GESAMT_TAGE_MAX)) delete g.tage[t];
  }
  const aeltester = Object.keys(g.tage).sort()[0] ?? null;
  /* Der Zählbeginn kann nur früher werden, nie später. */
  g.seit = g.seit && aeltester ? (g.seit < aeltester ? g.seit : aeltester) : (aeltester ?? g.seit);

  if (buchAngelegt !== null && g.buchAngelegt !== buchAngelegt) {
    /* Das Wiedererkennungsbuch wurde neu angelegt — jemand hat den Ordner
       gelöscht. Dann fängt auch diese Zahl von vorn an, sonst zählte sie
       dieselben Leute ein zweites Mal. */
    g.besucher = 0;
    g.buchAngelegt = buchAngelegt;
  }
  g.besucher = Math.max(0, (g.besucher ?? 0) + (dazu ?? 0));
  g.stand = Date.now();
  try {
    fs.mkdirSync(GESAMT_DATEI.slice(0, GESAMT_DATEI.lastIndexOf('/')), { recursive: true, mode: 0o700 });
    jsonSchreiben(GESAMT_DATEI, g);
  } catch { /* dann eben beim nächsten Mal */ }
  return g;
}

/** Die Gesamtzahlen für die Anzeige — Summe über die abgelegten Tage. */
function gesamtLesenFuerAnzeige() {
  const g = gesamtLesen();
  const tage = Object.keys(g.tage).sort();
  let treffer = 0; let seiten = 0; let bytes = 0;
  for (const t of tage) {
    treffer += g.tage[t].treffer ?? 0;
    seiten += g.tage[t].seiten ?? 0;
    bytes += g.tage[t].bytes ?? 0;
  }
  return {
    seit: g.seit ?? tage[0] ?? null,
    tage: tage.length,
    besucher: g.besucher ?? 0,
    seiten,
    treffer,
    bytes,
  };
}
const GESEHEN_KOPF = () => `${GESEHEN_ORDNER}/_hinweis.json`;
const gesehenFach = (kennzeichen) => `${GESEHEN_ORDNER}/${kennzeichen.slice(0, 2)}.json`;

function jsonSchreiben(pfad, wert) {
  const vorlaeufig = `${pfad}.${process.pid}`;
  fs.writeFileSync(vorlaeufig, JSON.stringify(wert), { mode: 0o600 });
  fs.renameSync(vorlaeufig, pfad);
}

const jsonLesen = (pfad) => {
  try { return JSON.parse(fs.readFileSync(pfad, 'utf8')); } catch { return null; }
};

/** Der Kopf: Salz, Anlagedatum, Aufbewahrung, wie viele bekannt sind. */
function gesehenKopf() {
  const da = jsonLesen(GESEHEN_KOPF());
  if (da?.salz) return da;
  try {
    fs.mkdirSync(GESEHEN_ORDNER, { recursive: true, mode: 0o700 });
    const kopf = {
      hinweis: GESEHEN_HINWEIS,
      fassung: 1,
      salz: crypto.randomBytes(16).toString('hex'),
      angelegt: Date.now(),
      haltenTage: GESEHEN_HALTEN,
      faecher: GESEHEN_FAECHER,
      bekannt: 0,
    };
    jsonSchreiben(GESEHEN_KOPF(), kopf);
    return kopf;
  } catch { return null; }
}

/** Die vorgemerkten Erstbesucher eintragen — fachweise, nur die betroffenen. */
function gesehenAnwenden(kopf, liste, abTag = null) {
  const heuteNr = Math.floor(Date.now() / 86400000);
  const grenze = heuteNr - GESEHEN_HALTEN;
  /* Beim Nachtragen aus dem Journal werden Tage noch einmal gelesen, die im
     Buch längst stehen — etwa nach einem Fassungswechsel. Ohne diese Schranke
     erschiene dann **jeder** Besucher als wiederkehrend, weil er sich selbst
     von vorhin begegnet. Einträge, die in den neu gelesenen Zeitraum fallen,
     gelten deshalb als noch nicht bekannt; der Durchgang stellt sie ohnehin
     gleich wieder her. Live beobachtet am 20.08.: 47 von 47 Besuchern
     standen als „wiederkehrend, zuletzt vor 0 Tagen". */
  const abNr = abTag === null ? null : tagNummer(abTag);
  const nachFach = new Map();
  for (const e of liste) {
    const k = kennung(e.adresse, kopf.salz);
    const fach = k.slice(0, 2);
    if (!nachFach.has(fach)) nachFach.set(fach, []);
    nachFach.get(fach).push({ ...e, voll: k, schluessel: k.slice(2) });
  }

  let dazu = 0;
  let weniger = 0;
  /* Was dieser Durchgang selbst eingetragen hat, zählt sehr wohl: wer am
     16. und noch einmal am 20. da war, ist am 20. wiederkehrend — auch
     mitten im Nachtragen. Nur Einträge aus früheren Läufen werden für den
     nachgelesenen Zeitraum ausgeblendet. */
  const beruehrt = new Set();
  for (const [fach, eintraege] of nachFach) {
    const pfad = `${GESEHEN_ORDNER}/${fach}.json`;
    const inhalt = jsonLesen(pfad) ?? {};
    /* Ausgemistet wird beim Anfassen: ein Fach, in dem nichts mehr passiert,
       wird auch nicht angefasst — und trägt dann eben alte Einträge, bis
       wieder jemand hineinfällt. Das kostet Platz, aber keine Zeit. */
    for (const [k, t] of Object.entries(inhalt)) {
      if (t < grenze) { delete inhalt[k]; weniger += 1; }
    }
    for (const e of eintraege) {
      const roh = inhalt[e.schluessel];
      const ausDiesemLauf = beruehrt.has(e.voll);
      const zuletzt = (roh !== undefined && !ausDiesemLauf && abNr !== null && roh >= abNr)
        ? undefined : roh;
      beruehrt.add(e.voll);
      if (zuletzt === undefined) {
        e.d.neu += 1;
        if (roh === undefined) dazu += 1;
      } else {
        e.d.wieder += 1;
        e.d.wiederTageSumme += Math.max(0, tagNummer(e.tag) - zuletzt);
      }
      inhalt[e.schluessel] = tagNummer(e.tag);
    }
    const namen = Object.keys(inhalt);
    if (namen.length > GESEHEN_MAX) {
      for (const k of namen.sort((x, y) => inhalt[x] - inhalt[y])
        .slice(0, namen.length - GESEHEN_MAX)) { delete inhalt[k]; weniger += 1; }
    }
    try { jsonSchreiben(pfad, inhalt); } catch { /* dann eben beim nächsten Mal */ }
  }

  kopf.bekannt = Math.max(0, (kopf.bekannt ?? 0) + dazu - weniger);
  kopf.dazu = dazu;                  // nur für den Rückweg, nicht gespeichert
  kopf.hinweis = GESEHEN_HINWEIS;
  kopf.haltenTage = GESEHEN_HALTEN;
  const { dazu: _weg, ...zumSchreiben } = kopf;
  try { jsonSchreiben(GESEHEN_KOPF(), zumSchreiben); } catch { /* nicht schlimm */ }
  return kopf;
}

const leererTag = () => ({
  treffer: 0, seiten: 0, maschinen: 0, klopfen: 0, bytes: 0, f404: 0, f5xx: 0,
  spitze: 0, neu: 0, wieder: 0, wiederTageSumme: 0,
  besucher: {}, pfade: {}, quellen: {}, fehlpfade: {}, serverpfade: {},
  stunden: new Array(24).fill(0),
});

/* Rückfallweg: war die Kennung an einem der gespeicherten Tage schon da?
 *
 * Greift nur, wenn sich das Wiedererkennungsbuch nicht öffnen lässt. Dann
 * reicht die Aussage bloß über die gespeicherten Tage — immer noch besser,
 * als alle als neu auszugeben. */
function schonDagewesen(stand, tag, kennung) {
  for (const [t, e] of Object.entries(stand.tage)) {
    if (t >= tag) continue;
    if (e.besucher && e.besucher[kennung] !== undefined) return true;
  }
  return false;
}

function tagName(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Aus einer Kennung lässt sich keine Adresse zurückrechnen, solange das
    Salz geheim bleibt — deshalb liegt die Datei unter 0600. */
const kennung = (adresse, salz) =>
  crypto.createHash('sha256').update(`${salz}|${adresse}`).digest('hex').slice(0, 12);

/** Von einem Verweis bleibt der Rechnername. Die volle Adresse trüge
    Suchbegriffe und Werbekennungen mit sich; für „woher kommen sie" ist
    der Name genug. */
function wirtName(url) {
  if (!url) return null;
  const ohne = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const ende = ohne.search(/[/?#]/);
  const roh = (ende < 0 ? ohne : ohne.slice(0, ende)).toLowerCase();
  if (roh.startsWith('[')) return roh.slice(0, roh.indexOf(']') + 1) || null;
  return roh.split(':')[0] || null;
}

/** Eine Seite oder nur ein Bestandteil davon? Ein Stylesheet ist kein
    Seitenaufruf, sonst zählte ein einziger Besuch als sieben. */
function istSeite(pfad) {
  const letzte = pfad.slice(pfad.lastIndexOf('/') + 1);
  const punkt = letzte.lastIndexOf('.');
  return punkt < 0 || !ASSET_ENDUNG.has(letzte.slice(punkt + 1).toLowerCase());
}

/** Eine Zählliste auf die größten Einträge kürzen. */
function stutzen(karte, max) {
  const namen = Object.keys(karte);
  if (namen.length <= max) return karte;
  const neu = {};
  for (const n of namen.sort((a, b) => karte[b] - karte[a]).slice(0, max)) neu[n] = karte[n];
  return neu;
}

const obenAuf = (karte, n) => Object.entries(karte).sort((a, b) => b[1] - a[1]).slice(0, n);

/* Warum der letzte Journalabruf scheiterte — für die Anzeige, nicht fürs
   Protokoll. Ohne das war "kein Zugriff" von "keine Besucher" nicht zu
   unterscheiden: beides kam als lauter Nullen heraus. Genau so stand in der
   Chat-App 0 Aufrufe, während auf dem Schreibtisch über tausend standen —
   der Chat-Server läuft als `stellium` und darf das Journal von `caddy`
   nicht lesen, der Schreibtisch läuft als Benutzer mit Journalrecht.
   Eine Zahl, die falsch ist, aber richtig aussieht, ist schlimmer als eine
   fehlende. */
let journalFehler = null;

function journal(args, puffer, zeit) {
  try {
    const aus = execFileSync('journalctl', args, {
      encoding: 'utf8', timeout: zeit, maxBuffer: puffer, stdio: ['ignore', 'pipe', 'ignore'],
    });
    journalFehler = null;
    return aus;
  } catch (f) {
    journalFehler = String(f?.message ?? f).slice(0, 120);
    return null;
  }
}

/** Aus den Journalzeilen die wenigen Angaben herausholen, die gebraucht werden. */
function zeilenLesen(text) {
  const heraus = [];
  if (!text) return heraus;
  for (const roh of text.split('\n')) {
    if (roh.length < 40 || !roh.includes('http.log.access')) continue;
    /* `status` steht unmittelbar vor `resp_headers`; abschneiden und wieder
       zumachen ergibt gültiges JSON und spart rund zwei Drittel der Zeile. */
    const schnitt = roh.indexOf(',"resp_headers"');
    let d = null;
    if (schnitt > 0) { try { d = JSON.parse(`${roh.slice(0, schnitt)}}`); } catch { /* dann eben ganz */ } }
    if (!d) { try { d = JSON.parse(roh); } catch { continue; } }
    if (d.logger !== 'http.log.access' || !d.request) continue;
    const a = d.request;
    const k = a.headers ?? {};
    /* Der Weg von außen endet auf diesem Pi, deshalb steht in `client_ip`
       immer 127.0.0.1. Die wirkliche Adresse reicht der Tunnel im Kopf
       weiter — sie wird hier sofort zur Kennung und nirgends abgelegt. */
    const adresse = (k['X-Forwarded-For']?.[0] ?? k['Cf-Connecting-Ip']?.[0]
      ?? a.client_ip ?? '').split(',')[0].trim();
    heraus.push({
      t: Math.round((d.ts ?? 0) * 1000),
      s: Number(d.status) || 0,
      bytes: Number(d.size) || 0,
      pfad: String(a.uri ?? '/').split('?')[0].slice(0, 120) || '/',
      wirt: String(a.host ?? '').toLowerCase().split(':')[0],
      adresse,
      verweis: wirtName(k.Referer?.[0]),
      maschine: MASCHINE.test(k['User-Agent']?.[0] ?? ''),
    });
  }
  return heraus;
}

/** Die vorgemerkten Erstbesucher des Tages einteilen — in einem Zug. */
function wiedererkennen(stand, liste, abTag = null) {
  const kopf = gesehenKopf();
  if (!kopf) {
    /* Ohne das Wiedererkennungsbuch bleibt der Blick auf die gespeicherten
       Tage — immer noch besser, als alle als neu auszugeben. */
    for (const e of liste) {
      if (schonDagewesen(stand, e.tag, e.kurz)) e.d.wieder += 1; else e.d.neu += 1;
    }
    return;
  }
  const neuerKopf = gesehenAnwenden(kopf, liste, abTag);
  stand.neuDazu = (stand.neuDazu ?? 0) + (neuerKopf.dazu ?? 0);
  stand.buchAngelegt = neuerKopf.angelegt ?? null;
  /* Eine kleine Zusammenfassung wandert in den Hauptzustand, damit die
     Anzeige die Fächer bei jeder Auffrischung gar nicht erst anfassen muss. */
  stand.erkennung = {
    bekannt: neuerKopf.bekannt ?? 0,
    seit: neuerKopf.angelegt ?? null,
    haltenTage: neuerKopf.haltenTage ?? GESEHEN_HALTEN,
  };
}

function falten(stand, saetze, kalt = false) {
  const erstmalsHeute = [];
  /* Zuerst die eigenen Namen: ein Verweis von einem davon ist kein Fund von
     außen, sondern ein Klick auf der Seite selbst. */
  for (const w of saetze) if (w.wirt) stand.wirte[w.wirt] = (stand.wirte[w.wirt] ?? 0) + 1;
  stand.wirte = stutzen(stand.wirte, 20);

  for (const w of saetze) {
    if (!w.t) continue;
    const tag = tagName(w.t);
    const d = (stand.tage[tag] ??= leererTag());
    d.treffer += 1;
    d.bytes += w.bytes;
    d.stunden[new Date(w.t).getHours()] += 1;
    if (w.t > (stand.letzte?.t ?? 0)) stand.letzte = { t: w.t, s: w.s };

    if (w.s === 404) {
      d.f404 += 1;
      /* Ein Verweis von der Seite selbst — oder eine Datei, die Browser von
         sich aus holen: dann fehlt wirklich etwas, und genau das fällt sonst
         niemandem auf. Alles andere ist die übliche Klopferei an fremden
         Türen und gehört nicht in eine Mängelliste. */
      if ((w.verweis && stand.wirte[w.verweis]) || ERWARTET.has(w.pfad)) {
        d.fehlpfade[w.pfad] = (d.fehlpfade[w.pfad] ?? 0) + 1;
      } else d.klopfen += 1;
    } else if (w.s >= 500) {
      d.f5xx += 1;
      d.serverpfade[w.pfad] = (d.serverpfade[w.pfad] ?? 0) + 1;
    }

    if (w.maschine) { d.maschinen += 1; continue; }

    if (w.adresse) {
      const k = kennung(w.adresse, stand.salz.wert);
      if (d.besucher[k] === undefined && Object.keys(d.besucher).length < BESUCHER_MAX) {
        d.besucher[k] = 0;
        /* Nur vormerken. Nachgeschlagen wird gleich, in einem Zug — und nur
           dann, wenn überhaupt jemand zum ersten Mal an diesem Tag auftaucht.
           Bei rund vierzig neuen Besuchern am Tag ist das in den allermeisten
           Faltvorgängen gar nicht der Fall, und das Buch bleibt zu. */
        erstmalsHeute.push({ tag, adresse: w.adresse, kurz: k, d });
      }
      if (d.besucher[k] !== undefined) d.besucher[k] += 1;
      const sek = Math.round(w.t / 1000);
      if (sek > (stand.jetzt[k] ?? 0)) stand.jetzt[k] = sek;
    }
    if (w.s < 400 && istSeite(w.pfad)) {
      d.seiten += 1;
      d.pfade[w.pfad] = (d.pfade[w.pfad] ?? 0) + 1;
      const q = !w.verweis ? '(direkt)' : (stand.wirte[w.verweis] ? '(intern)' : w.verweis);
      d.quellen[q] = (d.quellen[q] ?? 0) + 1;
    }
  }

  if (erstmalsHeute.length) {
    /* Nur beim Nachtragen greift die Schranke — im laufenden Betrieb wäre
       sie falsch: dort hieße „heute schon eingetragen" zu Recht, dass der
       Besucher heute schon einmal da war. */
    const abTag = kalt ? erstmalsHeute.reduce((a, e) => (e.tag < a ? e.tag : a), erstmalsHeute[0].tag) : null;
    wiedererkennen(stand, erstmalsHeute, abTag);
  }

  /* Aufräumen: alte Tage weg, Listen kürzen, abgelaufene Kennungen fallen
     lassen. Ohne das wüchse die Datei ohne Ende. */
  const grenze = tagName(Date.now() - TAGE_HALTEN * 86400000);
  for (const tag of Object.keys(stand.tage)) {
    if (tag < grenze) { delete stand.tage[tag]; continue; }
    const d = stand.tage[tag];
    d.pfade = stutzen(d.pfade, LISTE_MAX);
    d.quellen = stutzen(d.quellen, LISTE_MAX);
    d.fehlpfade = stutzen(d.fehlpfade, LISTE_MAX);
    d.serverpfade = stutzen(d.serverpfade, LISTE_MAX);
  }
  const alt = Math.round(Date.now() / 1000) - JETZT_HALTEN;
  for (const [k, t] of Object.entries(stand.jetzt)) if (t < alt) delete stand.jetzt[k];

  /* Zum Schluss die Zahlen seit Zählbeginn nachziehen — sie liegen in einer
     eigenen Datei ohne Fassung im Namen und überleben deshalb alles, was
     diesen Zustand hier zurücksetzt. */
  gesamtFortschreiben(stand, stand.neuDazu ?? 0, stand.buchAngelegt ?? null);
  stand.neuDazu = 0;
}

/** Ein neues Salz macht alte Kennungen unvergleichbar. Die Tageszahlen
    bleiben, die Kennungen selbst fallen weg — mehr als ihre Anzahl war
    daran ohnehin nie interessant. */
function salzPruefen(stand, jetztMs) {
  const woche = Math.floor(jetztMs / 604800000);
  if (stand.salz?.woche === woche) return;
  for (const d of Object.values(stand.tage)) {
    if (d.besucher && !('besucherFest' in d)) {
      d.besucherFest = Object.keys(d.besucher).length;
      d.besucher = {};
    }
  }
  stand.jetzt = {};
  stand.salz = { woche, wert: crypto.randomBytes(16).toString('hex') };
}

function standSchreiben(stand) {
  try {
    fs.mkdirSync(WEBSTAT_DATEI.slice(0, WEBSTAT_DATEI.lastIndexOf('/')),
                 { recursive: true, mode: 0o700 });
    /* Zwei Anzeigen können nebeneinander laufen — der Schreibtisch und ein
       Terminal. Wer weiter ist, behält recht: sonst liefe der Zeiger zurück
       und dieselben Zeilen würden ein zweites Mal gezählt. */
    try {
      const da = JSON.parse(fs.readFileSync(WEBSTAT_DATEI, 'utf8'));
      if ((da.gefaltet ?? 0) > (stand.gefaltet ?? 0)) return;
    } catch { /* noch keine da */ }
    const vorlaeufig = `${WEBSTAT_DATEI}.${process.pid}`;
    fs.writeFileSync(vorlaeufig, JSON.stringify(stand), { mode: 0o600 });
    fs.renameSync(vorlaeufig, WEBSTAT_DATEI);
  } catch { /* eine Statistik ist es nicht wert, die Konsole aufzuhalten */ }
}

const tagBesucher = (d) => (d ? Object.keys(d.besucher ?? {}).length || d.besucherFest || 0 : 0);

function webstatistikRechnen() {
  const laeuft = dienstAktiv('caddy');
  let stand = null;
  try { stand = JSON.parse(fs.readFileSync(WEBSTAT_DATEI, 'utf8')); } catch { /* noch keine */ }
  if (!stand || stand.fassung !== WEBSTAT_FASSUNG) {
    stand = { fassung: WEBSTAT_FASSUNG, cursor: null, gefaltet: 0, wirte: {}, jetzt: {}, tage: {} };
  }
  stand.wirte ??= {}; stand.jetzt ??= {}; stand.tage ??= {};

  const jetztMs = Date.now();
  salzPruefen(stand, jetztMs);

  /* Zwischen zwei Faltungen liegen mindestens vier Sekunden. Die Anzeige
     frischt alle zwei auf; jedes Mal am Journal zu ziehen brächte keine neue
     Erkenntnis und kostete auf einem Pi unnötig Zeit. */
  if (!stand.cursor || jetztMs - (stand.gefaltet ?? 0) >= MINDESTABSTAND) {
    const args = ['-u', 'caddy', '-o', 'cat', '--no-pager', '--show-cursor'];
    const erstes = !stand.cursor;
    if (erstes) args.push('--since', `-${TAGE_HALTEN}days`);
    else args.push(`--after-cursor=${stand.cursor}`);
    const roh = journal(args, erstes ? 512 * 1024 * 1024 : 64 * 1024 * 1024,
                        erstes ? 60000 : 5000);
    /* Nur beim ersten Versuch aussagekräftig: danach steht im Zählstand
       schon etwas, und ein einzelner Fehlschlag heißt nicht, dass der
       Zugriff fehlt. */
    stand.zugriff = roh !== null || Boolean(stand.cursor);
    stand.zugriffGrund = roh === null ? journalFehler : null;
    if (roh !== null) {
      let text = roh;
      const marke = text.lastIndexOf('\n-- cursor: ');
      if (marke >= 0) { stand.cursor = text.slice(marke + 12).trim(); text = text.slice(0, marke); }
      else if (text.startsWith('-- cursor: ')) { stand.cursor = text.slice(11).trim(); text = ''; }
      falten(stand, zeilenLesen(text), erstes);
      stand.gefaltet = jetztMs;
      const heute = stand.tage[tagName(jetztMs)];
      if (heute) {
        const sek = Math.round(jetztMs / 1000);
        const nun = Object.values(stand.jetzt).filter((t) => sek - t <= JETZT_FENSTER).length;
        if (nun > heute.spitze) heute.spitze = nun;
      }
      standSchreiben(stand);
    }
  }

  const sek = Math.round(jetztMs / 1000);
  const heute = stand.tage[tagName(jetztMs)] ?? leererTag();
  const tage = Object.keys(stand.tage).sort();
  const letzte7 = tage.slice(-7);

  const woche = { aufrufe: 0, seiten: 0, f404: 0, f5xx: 0, maschinen: 0,
    neu: 0, wieder: 0, ungefaehr: false };
  const wochenBesucher = new Set();
  let festeBesucher = 0;
  for (const t of letzte7) {
    const d = stand.tage[t];
    woche.aufrufe += d.treffer; woche.seiten += d.seiten;
    woche.f404 += d.f404; woche.f5xx += d.f5xx; woche.maschinen += d.maschinen;
    woche.neu += d.neu ?? 0; woche.wieder += d.wieder ?? 0;
    /* Nach einem Salzwechsel gibt es von älteren Tagen nur noch die Anzahl,
       keine Kennungen mehr — dann lässt sich nicht mehr sagen, wer an zwei
       Tagen derselbe war. Das steht dann als „ungefähr" an der Zahl. */
    const kennungen = Object.keys(d.besucher ?? {});
    if (kennungen.length) { for (const k of kennungen) wochenBesucher.add(k); }
    else if (d.besucherFest) {
      /* Nach einem Salzwechsel bleibt von älteren Tagen nur die Anzahl. Wer
         an zwei solchen Tagen derselbe war, lässt sich dann nicht mehr
         sagen — die Summe fällt zu hoch aus, und genau das steht als
         „ungefähr" an der Zahl. */
      festeBesucher += d.besucherFest;
      woche.ungefaehr = true;
    }
  }
  woche.besucher = wochenBesucher.size + festeBesucher;
  woche.tage = letzte7.length;

  /* Verlauf über die letzten 24 Stunden, aus gestern und heute
     zusammengesetzt — sonst bräche die Kurve um Mitternacht ab. */
  const stundeJetzt = new Date(jetztMs).getHours();
  const gestern = stand.tage[tagName(jetztMs - 86400000)];
  const verlauf = [];
  for (let i = 23; i >= 0; i -= 1) {
    const h = (stundeJetzt - i + 24) % 24;
    verlauf.push((h > stundeJetzt ? (gestern?.stunden?.[h] ?? 0) : (heute.stunden?.[h] ?? 0)));
  }

  const nun = Object.values(stand.jetzt);
  return {
    da: laeuft,
    /* `da` sagt, ob Caddy läuft. Ob wir seine Zahlen auch LESEN durften,
       ist eine zweite Frage — und ohne sie liest sich eine leere Statistik
       wie eine Seite ohne Besucher. */
    zugriff: stand.zugriff !== false,
    zugriffGrund: stand.zugriffGrund ?? null,
    seit: tage[0] ?? null,
    /* Seit wann überhaupt wiedererkannt wird, wie viele Besucher das Buch
       kennt und wie lange ein Eintrag dort liegt. „Wiederkehrend" kann nie
       weiter zurückreichen als `erkennung.seit` — am ersten Tag ist alles
       neu, und die Anzeige soll das sagen dürfen. */
    erkennung: stand.erkennung ?? null,
    /* Seit Zählbeginn. `seit` ist der älteste je gesehene Tag und gehört in
       die Anzeige — ohne ihn behauptete „insgesamt" mehr, als dahintersteht. */
    gesamt: gesamtLesenFuerAnzeige(),
    jetzt: nun.filter((t) => sek - t <= JETZT_FENSTER).length,
    jetzt30: nun.filter((t) => sek - t <= JETZT_HALTEN).length,
    spitze: heute.spitze ?? 0,
    besteTag: Math.max(0, ...tage.map((t) => tagBesucher(stand.tage[t]))),
    letzte: stand.letzte ?? null,
    heute: {
      aufrufe: heute.treffer, seiten: heute.seiten, besucher: tagBesucher(heute),
      f404: heute.f404, f5xx: heute.f5xx, maschinen: heute.maschinen, klopfen: heute.klopfen,
      bytes: heute.bytes,
      /* Von den Besuchern heute: wie viele waren an einem der vorigen
         gespeicherten Tage schon einmal da? */
      neu: heute.neu ?? 0, wieder: heute.wieder ?? 0,
      /* Im Schnitt so viele Tage lag der vorige Besuch zurück. */
      wiederTage: heute.wieder
        ? Math.round((heute.wiederTageSumme ?? 0) / heute.wieder) : null,
    },
    woche,
    verlauf,
    beliebt: obenAuf(heute.pfade, 4),
    herkunft: obenAuf(heute.quellen, 4),
    kaputt: obenAuf(heute.fehlpfade, 4),
    serverfehler: obenAuf(heute.serverpfade, 3),
  };
}

/*
 * Die fertigen Summen für Läufe weitergeben, die das Journal nicht lesen
 * dürfen.
 *
 * Der Schreibtisch läuft als `aryan` (Gruppe `adm`) und darf das Journal von
 * Caddy lesen. Der Chat-Server läuft als `stellium` und darf es nicht — er
 * bekam deshalb überall Nullen, und die sahen aus wie eine Seite ohne
 * Besucher. In der App stand 0, auf dem Schreibtisch daneben über tausend.
 *
 * Naheliegend wäre gewesen, beide auf dieselbe `STELLIUM_WEBSTAT`-Datei zu
 * zeigen und sie gruppenlesbar zu machen. Das geht NICHT: in dieser Datei
 * liegt neben den gehashten Besucherkennungen auch das Salz, mit dem sie
 * gebildet wurden. Wer beides hat, probiert den IPv4-Raum durch und hat die
 * Adressen zurück — genau das, was der Kopf dieser Datei ausschließt.
 *
 * Weitergegeben wird deshalb nur, was ohnehin angezeigt wird: Summen,
 * Ranglisten von Pfaden und Rechnernamen. Keine Kennung, kein Salz.
 */
/* Fester Ort statt einer Umgebungsvariablen: sonst müsste er an drei Stellen
   gesetzt werden — Schreibtisch, Hintergrundlauf und Dienst —, und wo eine
   davon vergessen wird, stehen wieder Nullen da. Wer in das Verzeichnis
   schreiben darf, teilt; wer nicht, liest. Das entscheiden die Rechte, nicht
   eine Einstellung, die auseinanderlaufen kann.
   Gibt es das Verzeichnis nicht, scheitern beide Wege still und es bleibt
   beim bisherigen Verhalten. */
const WEBSTAT_TEILEN = process.env.STELLIUM_WEBSTAT_TEILEN
  ?? '/var/lib/stellium-webstat/summen.json';

function webstatistik() {
  const eigen = webstatistikRechnen();
  if (!WEBSTAT_TEILEN) return eigen;

  if (eigen.zugriff) {
    try {
      fs.mkdirSync(WEBSTAT_TEILEN.slice(0, WEBSTAT_TEILEN.lastIndexOf('/')),
                   { recursive: true, mode: 0o750 });
      const vorlaeufig = `${WEBSTAT_TEILEN}.${process.pid}`;
      fs.writeFileSync(vorlaeufig, JSON.stringify({ zeit: Date.now(), werte: eigen }),
                       { mode: 0o640 });
      fs.renameSync(vorlaeufig, WEBSTAT_TEILEN);
    } catch { /* Weitergeben ist eine Freundlichkeit, kein Auftrag */ }
    return eigen;
  }

  /* Selbst nicht drangekommen — nehmen, was ein berechtigter Lauf hinterlegt
     hat. `geteilt` steht dabei mit drin, damit die Anzeige sagen kann, woher
     die Zahlen stammen, statt sie als eigene Messung auszugeben. */
  try {
    const d = JSON.parse(fs.readFileSync(WEBSTAT_TEILEN, 'utf8'));
    if (d?.werte) return { ...d.werte, geteilt: true, geteiltZeit: d.zeit ?? null };
  } catch { /* noch nichts hinterlegt */ }
  return eigen;
}

/* ── Triton: das Abo bei Gumroad ───────────────────────────────
 *
 * Auf der Website des Kollegen kann man ein Abo abschließen; es läuft über
 * Gumroad (`stellium6.gumroad.com/l/zigluo`, verlinkt in /srv/stellium).
 *
 * Woher die Zahlen kommen:
 *
 *   · **Mitgliederzahl** — öffentlich, ohne Zugangsschlüssel. Die Seite
 *     rendert zwar per JavaScript, aber sie lädt ihre Angaben selbst als
 *     JSON: `…/l/zigluo.json` liefert 1,9 KB in einer Viertelsekunde und
 *     enthält `sales_count`. Einen Browser auf dem Pi zu starten, nur um
 *     eine Zahl abzulesen, wäre um Größenordnungen teurer.
 *   · **Einnahmen** — nur mit einem Gumroad-Token aus
 *     `/etc/stellium-triton.env` (`GUMROAD_TOKEN=…`). Ohne Token sagt die
 *     Anzeige das und rechnet **nicht**. „Mitglieder × 25 $" sähe aus wie
 *     eine gemessene Zahl, wäre aber geraten: es gibt fünf Laufzeiten, eine
 *     Woche Probezeit, Kündigungen, Rückerstattungen — und Gumroad behält
 *     eine Gebühr ein. Eine falsche Zahl, die nach Buchhaltung aussieht,
 *     ist schlimmer als gar keine.
 *
 * Höflichkeit gegenüber einem fremden Dienst: die Anzeige frischt alle zwei
 * Sekunden auf, abgefragt wird aber nur alle zehn Minuten (mit Token alle
 * fünfzehn). Dazwischen steht der Wert aus dem Zwischenspeicher.
 *
 * Und der Abruf blockiert die Anzeige nie: er läuft in einem abgekoppelten
 * Kindprozess (`stellium-konsole.mjs abo-holen`), der allein die Datei
 * fortschreibt. Ein hängendes Gumroad hielte sonst jede zehnte Auffrischung
 * sekundenlang an. Antwortet Gumroad nicht, bleibt der letzte bekannte
 * Stand stehen — mit seinem Alter dabei, damit niemand ihn für aktuell
 * hält. Behauptet wird nie eine Null.
 */

const ABO_DATEI = process.env.STELLIUM_ABO
  ?? `${process.env.XDG_CACHE_HOME ?? `${os.homedir()}/.cache`}/stellium/triton-abo.json`;
const ABO_ENV = process.env.STELLIUM_TRITON_ENV ?? '/etc/stellium-triton.env';
const ABO_QUELLE = process.env.STELLIUM_ABO_URL ?? 'https://stellium6.gumroad.com/l/zigluo.json';

const ABO_FRIST = 10 * 60 * 1000;        // Mitgliederzahl: alle zehn Minuten
const ABO_FRIST_TOKEN = 15 * 60 * 1000;  // Einnahmen: alle fünfzehn
const ABO_SPERRE = 90 * 1000;            // so oft höchstens ein Kindprozess
const ABO_FRISCH = 30 * 60 * 1000;       // bis dahin gilt ein Stand als frisch

/* Der Wechselkurs. Echte Sekundenkurse gibt es nur gegen Geld; kostenlos und
   verlässlich ist der Referenzkurs der Europäischen Zentralbank, und der wird
   einmal je Werktag gesetzt. Für ein Dashboard reicht das vollkommen — die
   Anzeige soll nur dazuschreiben, von wann er ist, statt „live" zu behaupten.
   Geholt wird er höchstens einmal am Tag. */
const KURS_QUELLE = process.env.STELLIUM_KURS_URL
  ?? 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR';
const KURS_FRIST = 20 * 60 * 60 * 1000;

/* Wie viele Monate eine Laufzeit umfasst — damit sich die Preise
   vergleichen lassen, ohne sie hochzurechnen. */
const LAUFZEIT_MONATE = {
  monthly: 1, quarterly: 3, biannually: 6, yearly: 12, every_two_years: 24,
};

/** Ist das eine wirkliche Zahl?
 *
 * `Number(null)` ist 0, und `Number.isFinite(0)` ist wahr — wer damit auf
 * „ist ein Wert da?" prüft, macht aus „unbekannt" stillschweigend eine Null.
 * Genau das ist hier zweimal passiert: ein Abo ohne bekannten Preis fiel auf
 * 0 $ statt auf die Preisliste zurück, und eine fehlende Mitgliederzahl wäre
 * als „0 Mitglieder" durchgegangen.
 */
function zahl(wert) {
  if (wert === null || wert === undefined || wert === '') return null;
  const n = Number(wert);
  return Number.isFinite(n) ? n : null;
}

/** Centbeträge lesbar machen. */
function geld(cent, waehrung = 'USD') {
  if (zahl(cent) === null) return '—';
  const zeichen = { USD: '$', EUR: '€', GBP: '£' }[waehrung] ?? '';
  const wert = (Number(cent) / 100).toLocaleString('de-DE',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return zeichen ? `${zeichen}${wert}` : `${wert} ${waehrung}`;
}

function aboLesen() {
  try { return JSON.parse(fs.readFileSync(ABO_DATEI, 'utf8')); } catch { return null; }
}

function aboSchreiben(stand) {
  try {
    fs.mkdirSync(ABO_DATEI.slice(0, ABO_DATEI.lastIndexOf('/')), { recursive: true, mode: 0o700 });
    const vorlaeufig = `${ABO_DATEI}.${process.pid}`;
    /* 0600: mit Token stehen hier Einnahmen drin, und die gehen niemanden
       an, der zufällig auf dem Rechner angemeldet ist. */
    fs.writeFileSync(vorlaeufig, JSON.stringify(stand), { mode: 0o600 });
    fs.renameSync(vorlaeufig, ABO_DATEI);
  } catch { /* eine Anzeige ist es nicht wert, die Konsole aufzuhalten */ }
}

/** Der Zugangsschlüssel, falls einer hinterlegt ist. */
function gumroadToken() {
  if (process.env.GUMROAD_TOKEN) return process.env.GUMROAD_TOKEN.trim() || null;
  try {
    const roh = fs.readFileSync(ABO_ENV, 'utf8');
    const t = /^\s*(?:export\s+)?GUMROAD_TOKEN\s*=\s*["']?([^"'\n#]+)/m.exec(roh);
    return t ? t[1].trim() : null;
  } catch { return null; }
}

/** Liegt die Datei da, ist aber unlesbar? Das ist etwas anderes als „kein
    Token hinterlegt" und soll auch anders dastehen. */
function envUnlesbar() {
  try { fs.readFileSync(ABO_ENV, 'utf8'); return false; } catch (f) {
    return f?.code === 'EACCES' || f?.code === 'EPERM';
  }
}

async function abruf(adresse, kopf = {}, zeit = 9000) {
  const antwort = await fetch(adresse, {
    headers: { 'User-Agent': 'stellium-konsole/1.0 (Statusanzeige)', Accept: 'application/json', ...kopf },
    signal: AbortSignal.timeout(zeit),
  });
  if (!antwort.ok) {
    const fehler = new Error(`HTTP ${antwort.status}`);
    fehler.status = antwort.status;
    throw fehler;
  }
  return antwort.json();
}

/** Die Preise je Laufzeit — als Angabe, nicht als Rechengrundlage. */
function preiseLesen(p) {
  const werte = p?.options?.[0]?.recurrence_price_values;
  if (!werte || typeof werte !== 'object') return [];
  const liste = [];
  for (const [laufzeit, w] of Object.entries(werte)) {
    const cent = zahl(w?.price_cents);
    if (cent === null) continue;
    const monate = LAUFZEIT_MONATE[laufzeit] ?? null;
    liste.push({ laufzeit, monate, cent, jeMonatCent: monate ? Math.round(cent / monate) : null });
  }
  return liste.sort((a, b) => (a.monate ?? 99) - (b.monate ?? 99));
}

/** Aus Gumroads Verkaufsliste die Einnahmen — und nebenbei, was für jedes
    einzelne Abo tatsächlich gezahlt wurde. */
export function verkaeufeAuswerten(verkaeufe, preisJeAbo = new Map()) {
  let brutto = 0; let gebuehr = 0; let anzahl = 0;
  for (const k of verkaeufe ?? []) {
    if (k.subscription_id) {
      const cent = zahl(k.price);
      if (cent !== null && cent > 0) {
        preisJeAbo.set(k.subscription_id, { cent, laufzeit: k.recurrence ?? null });
      }
    }
    /* Zurückerstattet, angefochten, rückgebucht: das Geld ist wieder weg und
       gehört nicht in die Einnahmen.
       Zwei Schreibweisen, weil Gumroad selbst zwei benutzt: `/v2/sales`
       (und alles, was von dort kommt) nennt das Feld `chargedback`,
       `/v2/licenses/*` dagegen `chargebacked` — nachgelesen in der
       offiziellen Doku (archive.org, Snapshot 4.12.2025, Abschnitte „Sales"
       und „Licenses"). Nur `chargebacked` zu prüfen hieße: das Feld, das
       diese Funktion hier tatsächlich bekommt, nie zu sehen — eine
       Rückbuchung zählte dann still als Umsatz weiter. */
    if (k.refunded || k.disputed || k.chargedback || k.chargebacked) continue;
    brutto += zahl(k.price) ?? 0;
    gebuehr += zahl(k.gumroad_fee) ?? 0;
    anzahl += 1;
  }
  return { brutto, gebuehr, anzahl, preisJeAbo };
}

/** Aus Gumroads Abonnentenliste: die Zähler und die Abos, die Geld bringen. */
export function abonnentenAuswerten(liste, preisJeAbo = new Map(), jetzt = Date.now()) {
  const zaehler = { aktiv: 0, probe: 0, zahlend: 0, gekuendigt: 0, gescheitert: 0 };
  const abos = [];
  /* Wann ein Abo entstanden ist — nur der Tag, keine Kennung. Damit lässt
     sich die Kaufquote auf denselben Zeitraum bringen wie die Besucherzahl,
     statt einen Gesamtstand gegen fünf Tage zu rechnen. */
  const neuJeTag = {};
  for (const t of liste ?? []) {
    const lage = String(t.status ?? '');
    /* `pending_cancellation` heißt: gekündigt, läuft aber bis zum Ende der
       bezahlten Periode weiter — das Geld ist da und zählt bis dahin mit.
       `cancelled` heißt: vorbei, zählt nicht mehr. */
    const laeuft = lage === 'alive' || lage === 'pending_cancellation';
    if (lage === 'pending_cancellation' || lage === 'cancelled') zaehler.gekuendigt += 1;
    if (lage === 'failed_payment' || lage === 'pending_failure') zaehler.gescheitert += 1;
    if (!laeuft) continue;
    zaehler.aktiv += 1;
    const probe = !!(t.free_trial_ends_at && Date.parse(t.free_trial_ends_at) > jetzt);
    /* „Wirklich Käufer" heißt: die Probewoche ist vorbei und es wird gezahlt. */
    if (probe) zaehler.probe += 1; else zaehler.zahlend += 1;
    const seit = Date.parse(t.created_at ?? '');
    if (Number.isFinite(seit)) {
      const tag = new Date(seit).toISOString().slice(0, 10);
      neuJeTag[tag] = (neuJeTag[tag] ?? 0) + 1;
    }
    const bekannt = preisJeAbo.get(t.id);
    abos.push({
      laufzeit: t.recurrence ?? bekannt?.laufzeit ?? null,
      cent: bekannt?.cent ?? null,
      probe,
    });
  }
  return { zaehler, abos, neuJeTag };
}

/** Kosten alle Laufzeiten aufs Monat gerechnet dasselbe?
 *
 * Stand 20.08.2026 auf der Seite nachgelesen und von Don bestätigt: ja —
 * $25 im Monat, $75 im Quartal, $150 im Halbjahr, $300 im Jahr, $600 auf
 * zwei Jahre. Kein Rabatt auf längere Laufzeiten, also sind
 * „Mitglieder × 25 $" nicht geschätzt, sondern richtig.
 *
 * Der Preis wird trotzdem **aus der Seite gelesen** und nicht hier
 * festgeschrieben: führt Don eines Tages einen Jahresrabatt ein, stimmt die
 * Annahme nicht mehr. Dann meldet das hier `false`, und aus der Zahl wird
 * wieder eine gekennzeichnete Schätzung, statt still falsch zu werden.
 */
export function preiseEinheitlich(preise) {
  const werte = (preise ?? []).map((p) => p.jeMonatCent).filter((c) => zahl(c) !== null);
  if (werte.length < 2) return werte.length === 1;
  return werte.every((c) => c === werte[0]);
}

/** Monatlich wiederkehrender Umsatz.
 *
 * Jede Laufzeit wird auf den Monat umgelegt: ein Jahresabo zu 300 $ zählt
 * mit 25 $, nicht mit 300. Kündigt ein Monatszahler, fällt nur sein Anteil
 * weg — genau die Rechnung, die Don beschrieben hat.
 *
 * Wer noch in der kostenlosen Probewoche ist, zahlt gerade nichts und zählt
 * deshalb nicht mit; die Zahl steht als `inProbe` daneben.
 */
export function umsatzRechnen(stand) {
  const preise = stand.preise ?? [];
  const waehrung = stand.waehrung ?? 'USD';
  const einheitlich = preiseEinheitlich(preise);
  const einheitspreis = einheitlich ? (zahl(preise[0]?.jeMonatCent) ?? null) : null;

  /* Mit Token: die wirklichen Abos, jedes mit seiner eigenen Laufzeit. Das
     ist unabhängig davon richtig, ob die Preise einheitlich sind. */
  if (Array.isArray(stand.abos)) {
    const nach = new Map();
    let summe = 0;
    let inProbe = 0;
    for (const a of stand.abos) {
      if (a.probe) { inProbe += 1; continue; }
      const monate = LAUFZEIT_MONATE[a.laufzeit] ?? null;
      /* Was wirklich gezahlt wurde, schlägt die Preisliste — wer früher zu
         einem anderen Preis abgeschlossen hat, zahlt weiter seinen. */
      const cent = zahl(a.cent) ?? preise.find((p) => p.laufzeit === a.laufzeit)?.cent ?? null;
      if (!monate || cent === null) continue;
      const jeMonat = cent / monate;
      summe += jeMonat;
      const e = nach.get(a.laufzeit) ?? { laufzeit: a.laufzeit, monate, anzahl: 0, monatCent: 0 };
      e.anzahl += 1;
      e.monatCent += jeMonat;
      nach.set(a.laufzeit, e);
    }
    return {
      monatCent: Math.round(summe),
      waehrung,
      grundlage: 'abos',
      genau: true,
      vorbehalt: null,
      einheitspreisCent: einheitspreis,
      preiseEinheitlich: einheitlich,
      inProbe,
      probeMoeglich: !!stand.probe,
      aufteilung: [...nach.values()]
        .map((e) => ({ ...e, monatCent: Math.round(e.monatCent) }))
        .sort((a, b) => a.monate - b.monate),
    };
  }

  /* Ohne Token nennt Gumroad öffentlich nur eine Gesamtzahl. Solange jede
     Laufzeit aufs Monat gerechnet dasselbe kostet, genügt das vollkommen:
     wer welche Laufzeit gewählt hat, ändert an der Summe nichts. */
  const wieviele = zahl(stand.mitglieder);
  if (wieviele === null) return null;

  if (!einheitlich) {
    /* Der Riegel. Kosten die Laufzeiten unterschiedlich viel, hängt die
       Summe daran, wer welche hat — und das steht öffentlich nirgends. Dann
       ist die Zahl wieder eine Schätzung und muss auch so dastehen. */
    const guenstigster = Math.min(...preise.map((p) => zahl(p.jeMonatCent) ?? Infinity));
    const teuerster = Math.max(...preise.map((p) => zahl(p.jeMonatCent) ?? 0));
    if (!Number.isFinite(guenstigster) || !teuerster) return null;
    return {
      monatCent: wieviele * teuerster,
      waehrung,
      grundlage: 'mitgliederzahl',
      genau: false,
      vorbehalt: 'laufzeiten-uneinheitlich',
      spanneCent: [wieviele * guenstigster, wieviele * teuerster],
      einheitspreisCent: null,
      preiseEinheitlich: false,
      inProbe: null,
      probeMoeglich: !!stand.probe,
      aufteilung: null,
    };
  }

  if (einheitspreis === null) return null;
  return {
    monatCent: wieviele * einheitspreis,
    waehrung,
    grundlage: 'mitgliederzahl',
    genau: true,
    vorbehalt: null,
    einheitspreisCent: einheitspreis,
    preiseEinheitlich: true,
    /* Ohne Token lässt sich nicht sehen, wer noch in der Probewoche ist —
       die zahlen noch nichts. `probeMoeglich` sagt, dass es sie geben kann. */
    inProbe: null,
    probeMoeglich: !!stand.probe,
    aufteilung: null,
  };
}

/** Wie viele der Besucher haben wirklich gekauft?
 *
 * Zwei Fallen stecken darin, und beide machen die Zahl still falsch:
 *
 *  1. **Verschiedene Zeiträume.** Die Besucherzahl deckt die Tage, die im
 *     Journal stehen — heute fünf. Die Mitgliederzahl von der öffentlichen
 *     Seite ist ein **Gesamtstand seit Produktstart**. „0 von 2096" sähe aus
 *     wie eine Quote, verglichen würden aber Äpfel mit Birnen. Ohne Token
 *     wird deshalb **keine** Quote gerechnet; es stehen beide Zahlen mit
 *     ihrem Zeitraum da, und `vergleichbar` sagt, dass sie nicht
 *     zusammengehören. Mit Token zählt Gumroad, wie viele Abos in genau
 *     diesen Tagen entstanden sind — dann passen Zähler und Nenner.
 *  2. **Probeabos.** In der öffentlichen Zahl stecken die, die noch in der
 *     kostenlosen Woche sind und nie einen Cent gezahlt haben. Mit Token
 *     steht daneben, wie viele davon wirklich zahlen.
 */
export function kaufquote(web, ab) {
  const besucher = web?.woche?.besucher ?? null;
  const tage = web?.woche?.tage ?? null;
  const mitglieder = ab?.mitglieder ?? null;
  if (besucher === null && mitglieder === null) return null;

  const ergebnis = {
    besucher,
    tage,
    mitglieder,
    /* Ohne Token stecken Probeabos in der Mitgliederzahl mit drin. */
    probeEnthalten: !ab?.abonnenten,
    zahlend: ab?.abonnenten?.zahlend ?? null,
    inProbe: ab?.abonnenten?.probe ?? null,
    imZeitraum: null,
    quote: null,
    vergleichbar: false,
    grund: 'zeitraeume-verschieden',
  };

  if (ab?.neuJeTag && web?.seit && tage) {
    /* Nur die Abos zählen, die in denselben Tagen entstanden sind wie die
       Besucher. Damit steht eine Quote da, die wirklich eine ist. */
    let imZeitraum = 0;
    for (const [tag, n] of Object.entries(ab.neuJeTag)) {
      if (tag >= web.seit) imZeitraum += n;
    }
    ergebnis.imZeitraum = imZeitraum;
    ergebnis.vergleichbar = true;
    ergebnis.grund = null;
    ergebnis.quote = besucher > 0 ? imZeitraum / besucher : 0;
  }
  return ergebnis;
}

/** Der Abruf selbst. Läuft nur im abgekoppelten Kindprozess. */
async function aboHolen() {
  const stand = aboLesen() ?? {};
  const jetzt = Date.now();
  stand.holt = 0;

  /* ── öffentlich: Mitglieder, Preise, Probezeit ── */
  try {
    const p = await abruf(ABO_QUELLE);
    stand.name = p.name ?? null;
    stand.anbieter = p.seller?.name ?? null;
    stand.adresse = p.url ?? null;
    stand.produktId = p.id ?? null;
    stand.veroeffentlicht = p.is_published !== false;
    stand.mitglieder = zahl(p.sales_count);
    stand.waehrung = String(p.currency_code ?? 'usd').toUpperCase();
    stand.preisText = p.price_formatted ?? null;
    stand.preise = preiseLesen(p);
    stand.probe = p.free_trial?.duration
      ? { einheit: p.free_trial.duration.unit, anzahl: p.free_trial.duration.amount } : null;
    stand.stand = jetzt;
    stand.fehler = null;
  } catch (f) {
    /* Der alte Stand bleibt stehen. Nur der Fehler kommt dazu. */
    stand.fehler = String(f?.message ?? f).slice(0, 80);
  }

  /* ── Wechselkurs, höchstens einmal am Tag ── */
  if (jetzt - (stand.kurs?.geholt ?? 0) >= KURS_FRIST) {
    try {
      const k = await abruf(KURS_QUELLE, {}, 9000);
      const wert = zahl(k?.rates?.EUR);
      if (wert !== null && wert > 0) {
        stand.kurs = {
          von: 'USD', nach: 'EUR', wert, datum: k.date ?? null, geholt: jetzt,
          quelle: 'EZB-Referenzkurs · frankfurter.dev', fehler: null,
        };
      }
    } catch (f) {
      /* Der letzte bekannte Kurs bleibt stehen. Auf 1:1 zurückzufallen wäre
         schlimmer als gar kein Kurs: daraus würde stillschweigend eine
         falsche Zahl, der man nichts ansieht. */
      if (stand.kurs) stand.kurs.fehler = String(f?.message ?? f).slice(0, 60);
    }
  }

  /* ── mit Token: genaue Abonnentenzahl und wirkliche Einnahmen ── */
  const token = gumroadToken();
  if (!token) {
    stand.abonnenten = null;
    stand.abos = null;                 // ohne Token gibt es keine Aufteilung
    stand.neuJeTag = null;
    stand.einnahmen = null;
    stand.einnahmenGrund = envUnlesbar() ? 'kein-zugriff' : 'kein-token';
  } else if (jetzt - (stand.tokenStand ?? 0) >= ABO_FRIST_TOKEN) {
    const kopf = { Authorization: `Bearer ${token}` };
    const id = stand.produktId;
    let gelungen = false;

    /* Zuerst die Verkäufe. Sie liefern die Einnahmen — und nebenbei, was für
       jedes einzelne Abo tatsächlich gezahlt wurde. Damit rechnet der
       Monatsumsatz weiter unten mit wirklichen Beträgen statt mit der
       heutigen Preisliste. */
    const preisJeAbo = new Map();
    try {
      const ab = new Date(jetzt - 30 * 86400000).toISOString().slice(0, 10);
      let adresse = `https://api.gumroad.com/v2/sales?after=${ab}`
        + (id ? `&product_id=${encodeURIComponent(id)}` : '');
      let brutto = 0; let gebuehr = 0; let anzahl = 0; let seiten = 0;
      /* Seitenweise, aber gedeckelt: ein Abo mit sehr vielen Verkäufen soll
         den Pi nicht minutenlang beschäftigen. */
      while (adresse && seiten < 10) {
        const v = await abruf(adresse, kopf, 12000);
        const teil = verkaeufeAuswerten(v.sales, preisJeAbo);
        brutto += teil.brutto; gebuehr += teil.gebuehr; anzahl += teil.anzahl;
        seiten += 1;
        adresse = v.next_page_url ? `https://api.gumroad.com${v.next_page_url}` : null;
      }
      stand.einnahmen = {
        tage: 30,
        bruttoCent: brutto,
        gebuehrCent: gebuehr,
        /* „netto" heißt hier: nach Gumroads Gebühr. Nicht nach Steuern, nicht
           nach Serverkosten — das wäre Gewinn, und den kennt diese Anzeige
           nicht. */
        nettoCent: brutto - gebuehr,
        anzahl,
        waehrung: stand.waehrung ?? 'USD',
        vollstaendig: seiten < 10,
      };
      stand.einnahmenGrund = null;
      gelungen = true;
    } catch (f) {
      stand.einnahmenGrund = f?.status === 401 ? 'abgelehnt' : String(f?.message ?? f).slice(0, 60);
    }

    /* Dann die Abos selbst: Stand und Laufzeit je Abonnent. Erst daraus wird
       aus „5 Mitglieder" ein Monatsumsatz, der stimmt. */
    if (id) {
      try {
        const a = await abruf(`https://api.gumroad.com/v2/products/${encodeURIComponent(id)}/subscribers`,
                              kopf, 12000);
        const { zaehler: z, abos, neuJeTag } = abonnentenAuswerten(a.subscribers, preisJeAbo, jetzt);
        stand.neuJeTag = neuJeTag;
        stand.abonnenten = z;
        stand.abos = abos;
        gelungen = true;
      } catch (f) {
        stand.abonnentenGrund = f?.status === 401 ? 'abgelehnt' : String(f?.message ?? f).slice(0, 60);
      }
    }
    if (gelungen) stand.tokenStand = jetzt;
  }

  aboSchreiben(stand);
}

/* ── Diagnose: was gibt die Schnittstelle wirklich her? ──────────
 *
 * Beantwortet zwei Fragen, ohne je einen Kundendatensatz oder den
 * Zugangsschlüssel preiszugeben:
 *
 *   1. Klappt der Aufruf — mit genau dem Schlüssel, den `gumroadToken()`
 *      auch sonst benutzt (Umgebungsvariable zuerst, danach die Datei)?
 *   2. Welche Felder liefert Gumroad für DIESEN Zugang tatsächlich, und wie
 *      oft sind sie gefüllt? Das entscheidet, welche Kennzahlen sich bauen
 *      lassen — nicht die offizielle Doku, die zeigt nur, was möglich WÄRE.
 *
 * Die Auskunft bleibt strikt auf Struktur beschränkt: Feldnamen und
 * Trefferzahlen, nie der Inhalt. Ein Name, eine E-Mail-Adresse, ein
 * Lizenzschlüssel — keins davon verlässt diese Funktion. Wo eine Zahl
 * aussagekräftig UND unverfänglich ist (Cent-Beträge in Summe, Status- und
 * Laufzeit-Verteilungen, gesehene Währungen), wird sie zusammengefasst
 * zurückgegeben; einzelne Datensätze verlassen `listePruefen` nie.
 */

/** Für jedes Feld: in wie vielen der Datensätze steckt ein echter Wert?
 *  Zählt nur — der Wert selbst wird nirgends gespeichert oder ausgegeben. */
function feldStatistik(datensaetze) {
  const felder = new Map();
  for (const d of datensaetze ?? []) {
    if (!d || typeof d !== 'object') continue;
    for (const [name, wert] of Object.entries(d)) {
      const leer = wert === null || wert === undefined || wert === ''
        || (Array.isArray(wert) && wert.length === 0)
        || (typeof wert === 'object' && !Array.isArray(wert) && Object.keys(wert).length === 0);
      felder.set(name, (felder.get(name) ?? 0) + (leer ? 0 : 1));
    }
  }
  const gesamt = (datensaetze ?? []).length;
  return [...felder.entries()]
    .map(([name, gefuellt]) => ({ name, gefuellt, von: gesamt }))
    .sort((a, b) => b.gefuellt - a.gefuellt || a.name.localeCompare(b.name));
}

/** Verkäufe zusammenfassen: Summen und Verteilungen, nie ein einzelner
 *  Datensatz. `subscription_duration` steht hier für „bei diesem Verkauf
 *  bezahlte Laufzeit"; `einmalig` heißt: kein Abo. */
function verkaeufeZusammenfassen(liste) {
  let bruttoCent = 0; let gebuehrCent = 0;
  let erstattet = 0; let angefochten = 0; let rueckgebucht = 0;
  const waehrungen = new Set();
  const abos = new Set();
  const laufzeiten = new Map();
  for (const k of liste ?? []) {
    if (k.currency_symbol) waehrungen.add(k.currency_symbol);
    if (k.refunded) erstattet += 1;
    if (k.disputed) angefochten += 1;
    if (k.chargedback || k.chargebacked) rueckgebucht += 1;
    if (k.subscription_id) abos.add(k.subscription_id);
    const lz = k.subscription_duration ?? (k.subscription_id ? 'unbekannt' : 'einmalig');
    laufzeiten.set(lz, (laufzeiten.get(lz) ?? 0) + 1);
    if (!k.refunded && !k.disputed && !(k.chargedback || k.chargebacked)) {
      bruttoCent += zahl(k.price) ?? 0;
      gebuehrCent += zahl(k.gumroad_fee) ?? 0;
    }
  }
  return {
    anzahl: (liste ?? []).length,
    bruttoCent, gebuehrCent, nettoCent: bruttoCent - gebuehrCent,
    erstattet, angefochten, rueckgebucht,
    waehrungenGesehen: [...waehrungen],
    verschiedeneAbos: abos.size,
    laufzeitVerteilung: Object.fromEntries(laufzeiten),
  };
}

/** Abonnenten zusammenfassen: Status- und Laufzeitverteilung, Probezeit. */
function abonnentenZusammenfassen(liste, jetzt = Date.now()) {
  const status = new Map();
  const laufzeiten = new Map();
  let inProbe = 0;
  for (const t of liste ?? []) {
    const s = String(t.status ?? 'unbekannt');
    status.set(s, (status.get(s) ?? 0) + 1);
    const lz = t.recurrence ?? 'unbekannt';
    laufzeiten.set(lz, (laufzeiten.get(lz) ?? 0) + 1);
    if (t.free_trial_ends_at && Date.parse(t.free_trial_ends_at) > jetzt) inProbe += 1;
  }
  return {
    anzahl: (liste ?? []).length,
    statusVerteilung: Object.fromEntries(status),
    laufzeitVerteilung: Object.fromEntries(laufzeiten),
    inProbe,
  };
}

/** Auszahlungen zusammenfassen: Währungen, Status, Summe je Währung.
 *  Die Auszahlungswährung ist der einzige Ort, an dem eine andere Währung
 *  als beim Verkauf auftauchen kann — deshalb eigens erfasst. */
function auszahlungenZusammenfassen(liste) {
  const waehrungen = new Set();
  const status = new Map();
  const summeJeWaehrung = new Map();
  for (const p of liste ?? []) {
    if (p.currency) waehrungen.add(p.currency);
    const s = String(p.status ?? 'unbekannt');
    status.set(s, (status.get(s) ?? 0) + 1);
    const betrag = Number(p.amount);
    if (Number.isFinite(betrag)) {
      const w = p.currency ?? '?';
      summeJeWaehrung.set(w, (summeJeWaehrung.get(w) ?? 0) + betrag);
    }
  }
  return {
    anzahl: (liste ?? []).length,
    waehrungenGesehen: [...waehrungen],
    statusVerteilung: Object.fromEntries(status),
    summeJeWaehrung: Object.fromEntries(summeJeWaehrung),
  };
}

/** Eine Listen-Ressource abrufen (mit Seitenblättern) und nur ihre Struktur
 *  zurückgeben. `datensaetzeRoh` ist absichtlich dabei — für die
 *  Zusammenfassungen oben —, aber der Aufrufer entfernt es wieder, bevor das
 *  Ergebnis nach außen geht. So bleibt der Rohinhalt auf diese Funktion
 *  begrenzt, ganz gleich, was später noch mit dem Ergebnis passiert. */
async function listePruefen(name, ersteAdresse, kopf, listenSchluessel, maxSeiten = 8) {
  try {
    let adresse = ersteAdresse;
    let seiten = 0;
    let datensaetze = [];
    let antwortSchluessel = [];
    while (adresse && seiten < maxSeiten) {
      const antwort = await abruf(adresse, kopf, 15000);
      antwortSchluessel = Object.keys(antwort ?? {});
      const teil = antwort?.[listenSchluessel];
      if (Array.isArray(teil)) datensaetze = datensaetze.concat(teil);
      seiten += 1;
      adresse = antwort?.next_page_url ? `https://api.gumroad.com${antwort.next_page_url}` : null;
    }
    return {
      name, ok: true, anzahl: datensaetze.length, seiten,
      unvollstaendig: !!adresse, antwortSchluessel,
      felder: feldStatistik(datensaetze),
      datensaetzeRoh: datensaetze,
    };
  } catch (f) {
    return { name, ok: false, status: f?.status ?? null, fehler: String(f?.message ?? f).slice(0, 160) };
  }
}

/** Eine Einzelobjekt-Ressource (z. B. `/user`) abrufen und nur ihre Struktur
 *  zurückgeben. */
async function einzelobjektPruefen(name, adresse, kopf, objektSchluessel) {
  try {
    const antwort = await abruf(adresse, kopf, 15000);
    const objekt = antwort?.[objektSchluessel] ?? null;
    return {
      name, ok: true, vorhanden: !!objekt,
      antwortSchluessel: Object.keys(antwort ?? {}),
      felder: objekt ? feldStatistik([objekt]) : [],
    };
  } catch (f) {
    return { name, ok: false, status: f?.status ?? null, fehler: String(f?.message ?? f).slice(0, 160) };
  }
}

/** Die eigentliche Diagnose. Ruft an, was für Verkaufsstatistiken gebraucht
 *  würde (`user`, `products`, `sales`, `subscribers`, `payouts`) und meldet
 *  je Endpunkt: geklappt oder nicht, wie viele Datensätze, welche Felder
 *  gefüllt waren. `sales` läuft bewusst seit einem weit zurückliegenden
 *  Datum, nicht nur die 30-Tage-Ansicht der laufenden Anzeige — die Diagnose
 *  soll die ganze Historie sehen, einmalig, nicht im Zehn-Minuten-Takt. */
export async function gumroadDiagnose() {
  const zeit = new Date().toISOString();
  const token = gumroadToken();
  if (!token) {
    return {
      zeit, tokenVorhanden: false,
      grund: envUnlesbar() ? 'kein-zugriff' : 'kein-token',
      pruefungen: [],
    };
  }
  const tokenQuelle = process.env.GUMROAD_TOKEN ? 'umgebungsvariable' : ABO_ENV;
  const kopf = { Authorization: `Bearer ${token}` };

  let produktId = null; let produktFehler = null;
  try {
    const p = await abruf(ABO_QUELLE);
    produktId = p?.id ?? null;
  } catch (f) {
    produktFehler = String(f?.message ?? f).slice(0, 120);
  }

  const pruefungen = [];
  pruefungen.push(await einzelobjektPruefen('user', 'https://api.gumroad.com/v2/user', kopf, 'user'));

  /* Katalog des Kontos — eigene Produkte des Verkäufers, keine Kundendaten.
     Nur eine handverlesene, unverfängliche Auswahl an Feldern kommt mit raus;
     der Rest bleibt auf die Feldstatistik beschränkt wie überall sonst. */
  const produkte = await listePruefen('products', 'https://api.gumroad.com/v2/products', kopf, 'products');
  let alleProduktIds = [];
  if (produkte.ok) {
    alleProduktIds = (produkte.datensaetzeRoh ?? []).map((p) => p.id).filter(Boolean);
    produkte.katalog = (produkte.datensaetzeRoh ?? []).map((p) => ({
      id: p.id ?? null, name: p.name ?? null, veroeffentlicht: p.published ?? null,
      waehrung: p.currency ?? null, verkaufsanzahl: zahl(p.sales_count),
      istZielprodukt: p.id === produktId,
    }));
  }
  pruefungen.push(entrohen(produkte));

  /* Verkäufe des Zielprodukts (Triton) — dieselbe Abfrage, die auch die
     laufende Anzeige nutzt, nur seit 2020 statt nur 30 Tage. */
  const salesAdresse = 'https://api.gumroad.com/v2/sales?after=2020-01-01'
    + (produktId ? `&product_id=${encodeURIComponent(produktId)}` : '');
  const sales = await listePruefen('sales', salesAdresse, kopf, 'sales');
  if (sales.ok) sales.zusammenfassung = verkaeufeZusammenfassen(sales.datensaetzeRoh);
  pruefungen.push(entrohen(sales));

  /* Verkäufe über das GANZE Konto, ohne product_id-Filter — nur um zu sehen,
     ob es überhaupt irgendwo reale Verkaufsdatensätze gibt (und damit deren
     Feldform), falls das Zielprodukt selbst noch keine hat. */
  const salesKonto = await listePruefen('sales_konto', 'https://api.gumroad.com/v2/sales?after=2020-01-01', kopf, 'sales');
  if (salesKonto.ok) salesKonto.zusammenfassung = verkaeufeZusammenfassen(salesKonto.datensaetzeRoh);
  pruefungen.push(entrohen(salesKonto));

  if (produktId) {
    const subs = await listePruefen(
      'subscribers',
      `https://api.gumroad.com/v2/products/${encodeURIComponent(produktId)}/subscribers?paginated=true`,
      kopf, 'subscribers',
    );
    if (subs.ok) subs.zusammenfassung = abonnentenZusammenfassen(subs.datensaetzeRoh);
    pruefungen.push(entrohen(subs));
  }

  /* Abonnenten über ALLE Produkte des Kontos, aus demselben Grund wie oben
     bei den Verkäufen: die Feldform sehen, auch wenn das Zielprodukt selbst
     leer ausgeht. */
  if (alleProduktIds.length) {
    let kombiniert = [];
    const proProdukt = [];
    for (const id of alleProduktIds) {
      const s = await listePruefen(
        `subscribers_${id}`,
        `https://api.gumroad.com/v2/products/${encodeURIComponent(id)}/subscribers?paginated=true`,
        kopf, 'subscribers',
      );
      if (s.ok) {
        kombiniert = kombiniert.concat(s.datensaetzeRoh ?? []);
        proProdukt.push({ produktId: id, anzahl: s.anzahl });
      } else {
        proProdukt.push({ produktId: id, ok: false, status: s.status, fehler: s.fehler });
      }
    }
    pruefungen.push({
      name: 'subscribers_konto', ok: true, anzahl: kombiniert.length, proProdukt,
      felder: feldStatistik(kombiniert),
      zusammenfassung: abonnentenZusammenfassen(kombiniert),
    });
  }

  const payouts = await listePruefen('payouts', 'https://api.gumroad.com/v2/payouts', kopf, 'payouts');
  if (payouts.ok) payouts.zusammenfassung = auszahlungenZusammenfassen(payouts.datensaetzeRoh);
  pruefungen.push(entrohen(payouts));

  return { zeit, tokenVorhanden: true, tokenQuelle, produktId, produktFehler, pruefungen };
}

/** Entfernt `datensaetzeRoh` wieder, nachdem eine Zusammenfassung daraus
 *  gezogen wurde — der Rohinhalt soll `gumroadDiagnose` nie verlassen. */
function entrohen(pruefung) {
  const { datensaetzeRoh, ...rest } = pruefung;
  return rest;
}

/** Einen abgekoppelten Abruf anstoßen — und sofort zurückkehren. */
function aboKindStarten() {
  try {
    const kind = spawn(process.execPath, [fileURLToPath(import.meta.url), 'abo-holen'],
                       { detached: true, stdio: 'ignore' });
    kind.unref();
  } catch { /* dann eben beim nächsten Mal */ }
}

function abo() {
  const stand = aboLesen();
  const jetzt = Date.now();
  const token = gumroadToken();
  const faellig = !stand?.stand
    || jetzt - stand.stand >= ABO_FRIST
    || (token && jetzt - (stand.tokenStand ?? 0) >= ABO_FRIST_TOKEN);

  if (faellig && jetzt - (stand?.holt ?? 0) >= ABO_SPERRE) {
    /* Vormerken, dass ein Abruf läuft — sonst startete alle zwei Sekunden
       ein weiterer, und aus Höflichkeit würde Zudringlichkeit. */
    aboSchreiben({ ...(stand ?? {}), holt: jetzt });
    aboKindStarten();
  }

  if (!stand?.stand) {
    return {
      da: false,
      mitglieder: null,
      einnahmen: null,
      einnahmenGrund: token ? null : (envUnlesbar() ? 'kein-zugriff' : 'kein-token'),
      umsatz: null,
      kurs: stand?.kurs ?? null,
      fehler: stand?.fehler ?? null,
    };
  }

  return {
    da: true,
    name: stand.name ?? null,
    anbieter: stand.anbieter ?? null,
    adresse: stand.adresse ?? null,
    veroeffentlicht: stand.veroeffentlicht ?? null,
    mitglieder: stand.mitglieder ?? null,
    waehrung: stand.waehrung ?? 'USD',
    preisText: stand.preisText ?? null,
    preise: stand.preise ?? [],
    probe: stand.probe ?? null,
    stand: stand.stand,
    alter: Math.max(0, Math.round((jetzt - stand.stand) / 1000)),
    frisch: jetzt - stand.stand < ABO_FRISCH,
    fehler: stand.fehler ?? null,
    abonnenten: stand.abonnenten ?? null,
    neuJeTag: stand.neuJeTag ?? null,
    einnahmen: stand.einnahmen ?? null,
    einnahmenGrund: stand.einnahmen ? null
      : (stand.einnahmenGrund ?? (token ? null : 'kein-token')),
    /* Die abgeleitete Zahl: monatlich wiederkehrender Umsatz. Mit Token aus
       den wirklichen Abos gerechnet, ohne Token aus der Mitgliederzahl
       geschätzt — `geschaetzt` sagt, was von beidem. */
    umsatz: umsatzRechnen(stand),
    /* Für den Umschaltknopf auf Euro. Der Betrag bleibt in Dollar; wer
       umrechnen will, nimmt `kurs.wert` und schreibt `kurs.datum` dazu. */
    kurs: stand.kurs ? {
      ...stand.kurs,
      alterTage: stand.kurs.datum
        ? Math.max(0, Math.round((jetzt - Date.parse(`${stand.kurs.datum}T12:00:00Z`)) / 86400000))
        : null,
    } : null,
  };
}

/* ── Darstellung ─────────────────────────────────────────────── */

function balken(anteil, breite = 20) {
  const a = Math.min(1, Math.max(0, anteil || 0));
  const voll = Math.round(a * breite);
  const farbe = a > 0.9 ? F.rot : a > 0.75 ? F.gelb : F.gruen;
  return `${farbe}${'█'.repeat(voll)}${F.grau}${'░'.repeat(breite - voll)}${F.aus}`;
}

const z = [];
const schreib = (t = '') => z.push(t);
const feld = (name, wert, farbe = '') => schreib(`  ${F.grau}${name.padEnd(16)}${F.aus}${farbe}${wert}${F.aus}`);
const messwert = (name, anteil, rechts) =>
  schreib(`  ${F.grau}${name.padEnd(16)}${F.aus}${balken(anteil)} ${F.grau}${rechts}${F.aus}`);

function ueberschrift(text, farbe = F.violett) {
  schreib();
  schreib(`  ${farbe}${F.fett}${text}${F.aus}  ${F.grau}${'─'.repeat(Math.max(0, BREITE - text.length - 6))}${F.aus}`);
}

/**
 * Dieselben Angaben, nur als Daten statt als Bild.
 *
 * Die grafische Oberfläche soll nichts doppelt ermitteln — sonst driften die
 * beiden Anzeigen irgendwann auseinander und niemand weiß, welche stimmt.
 */

/**
 * Sitzt gerade jemand per Fernsteuerung am Schirm?
 *
 * Ausdrücklich nur **dass** — nie, was dabei zu sehen ist. Der Dienst legt
 * dafür eine winzige Datei ab und schreibt sie atomar um, damit hier nie eine
 * halb geschriebene gelesen wird.
 *
 * Seit Kurzem steht dort auch **wer** — als Behauptung der Gegenstelle, nicht
 * als geprüfte Identität (siehe `fernsteuerung/dienst/fern-dienst.mjs`).
 * Ältere Gegenstellen kennen dieses Feld nicht; dann bleibt `konto` null, und
 * die Oberfläche zeigt „unbekannt" statt eines Namens.
 *
 * Liegt keine Datei vor, läuft die Fernsteuerung schlicht nicht. Das ist kein
 * Fehler und soll auch nicht wie einer aussehen.
 */
function fernsteuerung() {
  try {
    const z = JSON.parse(fs.readFileSync('/var/lib/stellium/fern/zustand.json', 'utf8'));
    return {
      da: true,
      verbunden: Boolean(z.verbunden),
      seit: z.seit ?? null,
      konto: z.konto ?? null,
      id: z.id ?? null,
      /* Es dürfen mehrere gleichzeitig zusehen (siehe fern-dienst.mjs). `konto`
         nennt weiter den Ersten — das ist der, der am längsten dabei ist —,
         und `zuschauer` sagt, wie viele es insgesamt sind. Ein älterer Dienst
         schreibt das Feld nicht; dann steht hier 1, solange überhaupt jemand
         verbunden ist, denn mehr konnte es dort gar nicht sein. */
      zuschauer: Number.isFinite(z.zuschauer) ? z.zuschauer : (z.verbunden ? 1 : 0),
      /* Wer die Maus hat. Kann auch bei niemandem liegen — dann sieht man nur
         zu. Wie jeder Name hier eine Behauptung der Gegenstelle. */
      steuerung: z.steuerung ?? null,
    };
  } catch {
    return { da: false, verbunden: false, seit: null, konto: null, id: null, zuschauer: 0, steuerung: null };
  }
}

async function daten() {
  /* Zwei Messungen kurz hintereinander: der Vergleichswert entsteht erst im
     Lauf. Für die grafische Anzeige startet jedes Mal ein eigener Prozess —
     ohne das hier bekäme sie immer nur den Minutendurchschnitt zu sehen, und
     der bewegt sich kaum. */
  cpuAuslastung();
  await new Promise((r) => setTimeout(r, 250));

  const g = await gesundheit();
  const pl = platte('/');
  const sw = swap();
  const n = netz();
  const feuer = ruf('ufw', ['status']);
  let sicherung = null;
  try {
    const staende = fs.readdirSync(`${DATEN}/sicherungen`).filter((d) => /\.db(\.gz)?$/.test(d)).sort();
    if (staende.length) {
      const letzte = `${DATEN}/sicherungen/${staende[staende.length - 1]}`;
      sicherung = { anzahl: staende.length, wann: fs.statSync(letzte).mtime.toISOString() };
    }
  } catch { /* noch keine */ }

  /* Was der nächtliche Lauf über die Abhängigkeiten herausgefunden hat. Die
     Datei entsteht dort; fehlt sie, hat noch kein Lauf stattgefunden. */
  let abhaengigkeiten = null;
  try {
    abhaengigkeiten = JSON.parse(fs.readFileSync(`${DATEN}/abhaengigkeiten.json`, 'utf8'));
  } catch { /* noch kein Lauf */ }

  const webStand = webstatistik();
  const aboStand = abo();
  const ergebnis = {
    zeit: Date.now(),
    abhaengigkeiten,
    version: version(),
    modell: modell(),
    adressen: adressen(),
    dienste: {
      chat: { an: dienstAktiv('stellium'), auto: dienstAn('stellium') },
      web: { an: dienstAktiv('nginx'), auto: dienstAn('nginx') },
      tunnel: dienstAktiv('stellium-tunnel') || dienstAktiv('cloudflared'),
    },
    ki: g?.ai ?? null,
    verbunden: g?.verbunden ?? null,
    inhalt: zahlen(),
    ablage: ablage(),
    zertifikat: zertifikat(),
    firewall: feuer ? /Status: active/.test(feuer) : null,
    gesperrt: gesperrt(),
    leistung: {
      kerne: os.cpus().length,
      mhz: takt(),
      cpu: cpuAuslastung(),
      ramAnteil: 1 - os.freemem() / os.totalmem(),
      ramBelegt: os.totalmem() - os.freemem(),
      ramGesamt: os.totalmem(),
      swap: sw,
      platte: pl,
      grafik: grafik(),
      temperaturen: temperaturen(),
      drosselung: drosselung(),
      netz: n,
      laufzeit: os.uptime(),
    },
    bestandteile: bestandteile(),
    sicherung,
    webseite: webStand,
    abo: aboStand,
    kaufquote: kaufquote(webStand, aboStand),
    fern: fernsteuerung(),
  };
  /* Was neu erfragt werden musste, liegt jetzt für den nächsten Lauf bereit. */
  traegeSichern();
  return ergebnis;
}

async function zeichnen() {
  z.length = 0;
  const g = await gesundheit();
  const chat = dienstAktiv('stellium');
  const web = dienstAktiv('nginx');
  const zert = zertifikat();
  const db = zahlen();
  const v = version();

  schreib();
  schreib(`  ${F.violett}${F.fett}✦  Stellium${F.aus}${v ? `  ${F.grau}${v}${F.aus}` : ''}   ${F.grau}${modell()} · ${new Date().toLocaleString('de-DE')}${F.aus}`);

  /* ── Verbinden ───────────────────────────────────────────── */
  ueberschrift('Verbinden', F.blau);
  const adr = adressen();
  const sicher = adr.filter((a) => a.art === 'sicher');
  const offen = adr.filter((a) => a.art === 'offen');
  const lokal = adr.filter((a) => a.art === 'lokal');

  const tunnel = adr.filter((a) => a.art === 'tunnel');
  for (const a of sicher) schreib(`    ${F.gruen}🔒${F.aus}  ${F.fett}${F.blau}${a.url}${F.aus}`);
  for (const a of tunnel) {
    schreib(`    ${F.gruen}🔒${F.aus}  ${F.fett}${F.blau}${a.url}${F.aus}  ${F.grau}durch den Tunnel${F.aus}`);
  }
  for (const a of offen) schreib(`    ${F.gelb}⚠${F.aus}   ${a.url}  ${F.grau}unverschlüsselt${F.aus}`);
  for (const a of lokal.slice(0, 2)) schreib(`    ${F.grau}·   ${a.url}   im eigenen Netz${F.aus}`);
  if (!adr.length) schreib(`    ${F.rot}keine Adresse gefunden${F.aus}`);
  if (tunnel.length && /trycloudflare\.com/.test(tunnel[0].url)) {
    schreib(`    ${F.gelb}Diese Adresse wechselt bei jedem Neustart des Tunnels.${F.aus}`);
  }
  schreib(`    ${F.grau}In der App unter Einstellungen → Server eintragen.${F.aus}`);

  /* ── Chat ────────────────────────────────────────────────── */
  ueberschrift('Chat-Server', F.tuerkis);
  feld('Dienst', chat ? (dienstAn('stellium') ? 'läuft · startet automatisch' : 'läuft · KEIN Autostart') : 'AUS',
    chat ? (dienstAn('stellium') ? F.gruen : F.gelb) : F.rot);

  if (g?.ai) {
    const an = g.ai.provider && g.ai.provider !== 'demo';
    feld('Übersetzung', an ? `an · ${g.ai.provider}` : 'aus — kein Schlüssel hinterlegt', an ? F.gruen : F.gelb);
    if (an && g.ai.model) feld('Modell', g.ai.model);
    if (an && g.ai.fastModel) feld('Schnellmodell', g.ai.fastModel);
    if (g.ai.modelsAvailable) feld('Modelle', `${g.ai.modelsAvailable} verfügbar${g.ai.modelSource === 'auto' ? ', automatisch gewählt' : ''}`);
    /* Nicht nur "möglich", sondern wo. Solange hier nur "Umschrift möglich"
       stand, konnte daneben "Übersetzung an · ollama" stehen und die Aufnahme
       trotzdem an Groq gehen — genau das ist eine Weile unbemerkt passiert. */
    feld('Sprachnachricht', g.ai.transcription
      ? `Umschrift ${g.ai.transcriptionLokal ? 'auf diesem Rechner' : 'bei Groq'} · ${g.ai.transcriptionModel}`
      : 'keine Umschrift — Sprachnachrichten bleiben ohne Text',
    g.ai.transcription ? (g.ai.transcriptionLokal ? F.gruen : F.gelb) : F.gelb);
  } else if (chat) {
    feld('Übersetzung', 'Server antwortet noch nicht', F.gelb);
  }

  if (g?.verbunden) {
    const { clients, benutzer } = g.verbunden;
    feld('Verbunden', clients
      ? `${clients} ${clients === 1 ? 'Verbindung' : 'Verbindungen'} · ${benutzer} ${benutzer === 1 ? 'Person' : 'Personen'}`
      : 'niemand', clients ? F.gruen : F.grau);
  }

  if (db) {
    const teile = [];
    if (db.users !== undefined) teile.push(`${db.users} Konten`);
    if (db.channels !== undefined) teile.push(`${db.channels} Kanäle`);
    if (db.messages !== undefined) teile.push(`${db.messages} Nachrichten`);
    feld('Inhalt', teile.join(' · '));
    const weiter = [];
    if (db.tasks) weiter.push(`${db.tasks} Aufgaben`);
    if (db.events) weiter.push(`${db.events} Termine`);
    if (db.files) weiter.push(`${db.files} Dateien`);
    if (db.ideas) weiter.push(`${db.ideas} Ideen`);
    if (weiter.length) feld('', weiter.join(' · '));
    if (db.groesse) feld('Datenbank', groesse(db.groesse));
  }

  const abl = ablage();
  if (abl.dateien) {
    feld('Dateiablage', `${groesse(abl.belegt)} von ${groesse(abl.gesamt)}`
      + `  ·  ${abl.dateien} Dateien  ·  ${groesse(abl.frei)} frei`);
  }

  /* ── Weg nach außen ──────────────────────────────────────── */
  ueberschrift('Weg nach außen', F.blau);
  feld('nginx', web ? (dienstAn('nginx') ? 'läuft · startet automatisch' : 'läuft') : 'AUS', web ? F.gruen : F.rot);
  if (zert?.art === 'tunnel') {
    // TLS endet bei Cloudflare, nicht auf diesem Pi — siehe zertifikat()
    // weiter oben. "Verbindung offen" wäre hier schlicht falsch.
    feld('Zertifikat', `${zert.name} · TLS endet bei ${zert.anbieter}`, F.gruen);
  } else if (zert) {
    const farbe = zert.tage < 10 ? F.rot : zert.tage < 25 ? F.gelb : F.gruen;
    feld('Zertifikat', `${zert.name} · noch ${zert.tage} Tage`, farbe);
  } else if (sicher.length) {
    feld('Zertifikat', 'vorhanden', F.gruen);
  } else {
    feld('Zertifikat', 'keines — Verbindung offen', F.gelb);
  }
  for (const [dienst, name] of [['stellium-tunnel', 'Tunnel'], ['cloudflared', 'Tunnel']]) {
    if (dienstAktiv(dienst)) { feld(name, 'läuft', F.gruen); break; }
  }
  const feuer = ruf('ufw', ['status']);
  if (feuer) feld('Firewall', /Status: active/.test(feuer) ? 'aktiv' : 'AUS', /Status: active/.test(feuer) ? F.gruen : F.rot);
  const sperren = gesperrt();
  if (sperren !== null) feld('fail2ban', sperren ? `${sperren} gesperrt` : 'wacht, nichts gesperrt', sperren ? F.gelb : F.gruen);

  /* ── Leistung ────────────────────────────────────────────── */
  ueberschrift('Leistung', F.violett);
  const kerne = os.cpus().length;
  const mhz = takt();
  messwert('Prozessor', cpuAuslastung(), `${kerne} Kerne${mhz ? ` · ${mhz} MHz` : ''}`);

  const ramAnteil = 1 - os.freemem() / os.totalmem();
  messwert('Arbeitsspeicher', ramAnteil, `${groesse(os.totalmem() - os.freemem())} von ${groesse(os.totalmem())}`);

  const sw = swap();
  if (sw) messwert('Auslagerung', sw.belegt / sw.gesamt, `${groesse(sw.belegt)} von ${groesse(sw.gesamt)}`);

  const pl = platte('/');
  if (pl) messwert('Speicherplatz', pl.belegt / pl.gesamt, `${groesse(pl.gesamt - pl.belegt)} frei`);

  const gpu = grafik();
  if (gpu) {
    const rechts = [gpu.mb ? `${gpu.mb} MB` : null, gpu.mhz ? `${gpu.mhz} MHz` : null].filter(Boolean).join(' · ');
    if (rechts) feld('Grafik', rechts);
  }

  for (const t of temperaturen()) {
    const farbe = t.grad > 78 ? F.rot : t.grad > 65 ? F.gelb : F.gruen;
    feld(t.name.length > 14 ? 'Temperatur' : t.name, `${t.grad} °C`, farbe);
  }

  const dr = drosselung();
  if (dr && (dr.jetzt.length || dr.frueher.length)) {
    if (dr.jetzt.length) feld('Achtung', dr.jetzt.join(', '), F.rot);
    else feld('Früher mal', dr.frueher.join(', '), F.gelb);
  }

  const n = netz();
  if (n) feld('Netz', `${groesse(n.rein)} empfangen · ${groesse(n.raus)} gesendet`);
  feld('Läuft seit', dauer(os.uptime()));

  /* ── Bestandteile ────────────────────────────────────────── */
  const teile = bestandteile();
  if (teile.length) {
    ueberschrift('Bestandteile', F.grau);
    schreib(`  ${teile.map((t) => `${F.grau}${t.name}${F.aus} ${t.fassung}`).join(`${F.grau}  ·  ${F.aus}`)}`);
  }

  /* ── Sicherung ───────────────────────────────────────────── */
  let sicherung = null;
  try {
    const liste = fs.readdirSync(`${DATEN}/sicherungen`).filter((x) => x.endsWith('.gz'));
    if (liste.length) {
      const neueste = liste.map((x) => fs.statSync(`${DATEN}/sicherungen/${x}`).mtimeMs).sort((a, b) => b - a)[0];
      sicherung = { anzahl: liste.length, stunden: Math.round((Date.now() - neueste) / 3600000) };
    }
  } catch { /* noch keine */ }

  ueberschrift('Sicherung', F.grau);
  if (sicherung) {
    feld('Stände', `${sicherung.anzahl} · letzter vor ${sicherung.stunden} Std`,
      sicherung.stunden > 30 ? F.gelb : F.gruen);
  } else {
    feld('Stände', 'noch keiner — der erste kommt heute Nacht um 3:30');
  }

  /* ── Triton Website ──────────────────────────────────────── */
  /* Die Seite eines Kollegen auf demselben Pi. Nur mitgelesen, nie
     angefasst — siehe server-setup/FREMDE-DIENSTE.md. */
  const tw = webstatistik();
  ueberschrift('Triton Website', F.rosa ?? F.violett);
  if (!tw.da) {
    feld('Auslieferung', 'caddy läuft nicht', F.rot);
  } else {
    const her = tw.letzte ? Math.max(0, Math.round((Date.now() - tw.letzte.t) / 1000)) : null;
    const wann = her === null ? ''
      : ` · letzter Zugriff vor ${her < 90 ? `${her} s` : `${Math.round(her / 60)} Min`} · HTTP ${tw.letzte.s}`;
    feld('Auslieferung', `läuft${wann}`, F.gruen);
  }
  feld('Gerade da', `${tw.jetzt} ${tw.jetzt === 1 ? 'Besucher' : 'Besucher'}  ·  ${tw.jetzt30} in 30 Min`,
    tw.jetzt ? F.gruen : F.grau);
  feld('Heute', `${tw.heute.seiten} Seitenaufrufe  ·  ${tw.heute.besucher} Besucher`);
  /* Kommen die Leute wieder, oder sieht jeder einmal hin? Die Einteilung
     reicht nur so weit zurück, wie das Salz alt ist — deshalb steht die
     Grundlage dabei. */
  feld('Davon', `${tw.heute.neu} neu  ·  ${tw.heute.wieder} wiederkehrend`
    + (tw.heute.wiederTage !== null ? `, zuletzt vor ${tw.heute.wiederTage} Tagen` : '')
    + (tw.erkennung ? `  ${F.grau}(kennt ${tw.erkennung.bekannt} Besucher seit `
      + `${new Date(tw.erkennung.seit).toLocaleDateString('de-DE')})${F.aus}` : ''));
  feld(`${tw.woche.tage} Tage`, `${tw.woche.seiten} Seitenaufrufe  ·  ${tw.woche.ungefaehr ? '≈' : ''}${tw.woche.besucher} Besucher`);
  feld('Verkehr', `${tw.heute.aufrufe} Anfragen  ·  ${groesse(tw.heute.bytes)}`);
  if (tw.gesamt?.seit) {
    /* „Seit Zählbeginn", nicht „insgesamt": das Journal reichte beim ersten
       Lauf fünf Tage zurück, und was davor war, hat nie jemand gesehen. Das
       Datum gehört deshalb in dieselbe Zeile. */
    const [j, m, t] = tw.gesamt.seit.split('-');
    feld('Seit Zählbeginn', `${tw.gesamt.seiten} Seitenaufrufe  ·  `
      + `${tw.gesamt.besucher} Besucher  ·  ${tw.gesamt.treffer} Anfragen`
      + `  ${F.grau}(seit ${t}.${m}.${j}, ${tw.gesamt.tage} Tage)${F.aus}`);
  }
  if (tw.beliebt.length) feld('Beliebt', tw.beliebt.slice(0, 3).map(([p, n]) => `${p} ${n}`).join('  ·  '));
  if (tw.herkunft.length) {
    feld('Herkunft', tw.herkunft.slice(0, 3)
      .map(([p, n]) => `${p === '(direkt)' ? 'direkt' : p === '(intern)' ? 'von der Seite' : p} ${n}`).join('  ·  '));
  }
  const fehl = [];
  if (tw.heute.f404) fehl.push(`${tw.heute.f404} × 404`);
  if (tw.heute.f5xx) fehl.push(`${tw.heute.f5xx} × 5xx`);
  feld('Fehler', fehl.length ? fehl.join('  ·  ') : 'keine',
    tw.heute.f5xx ? F.rot : fehl.length ? F.gelb : F.gruen);
  /* Nur Pfade, auf die von der Seite selbst verwiesen wird oder die Browser
     von sich aus holen. Das Klopfen an /wp-login.php ist kein Mangel. */
  const mangel = tw.serverfehler.length ? tw.serverfehler : tw.kaputt;
  if (mangel.length) {
    feld('Fehlt', mangel.slice(0, 3).map(([p, n]) => `${p} ${n}`).join('  ·  '),
      tw.serverfehler.length ? F.rot : F.gelb);
  }
  if (tw.heute.maschinen || tw.heute.klopfen) {
    feld('Maschinen', `${tw.heute.maschinen} Anfragen`
      + (tw.heute.klopfen ? `  ·  ${tw.heute.klopfen} Klopfversuche` : ''));
  }

  /* ── Triton Abo ──────────────────────────────────────────── */
  const ab = abo();
  ueberschrift('Triton Abo', F.tuerkis);
  if (!ab.da) {
    feld('Mitglieder', ab.fehler ? `noch nicht abgerufen — ${ab.fehler}` : 'wird geholt …', F.grau);
  } else {
    const her = ab.alter < 90 ? `${ab.alter} s`
      : ab.alter < 5400 ? `${Math.round(ab.alter / 60)} Min`
        : `${Math.round(ab.alter / 3600)} Std`;
    /* Null ist hier eine richtige Auskunft, kein Fehler — sie steht deshalb
       ausgeschrieben da und nicht als Strich. */
    feld('Mitglieder', ab.mitglieder === null ? 'unbekannt'
      : ab.mitglieder === 0 ? '0  ·  noch keine' : String(ab.mitglieder),
    ab.mitglieder ? F.gruen : F.grau);
    if (ab.abonnenten) {
      const z = ab.abonnenten;
      feld('Davon', `${z.zahlend} zahlend  ·  ${z.probe} in Probe  ·  ${z.gekuendigt} gekündigt`
        + (z.gescheitert ? `  ·  ${z.gescheitert} Zahlung offen` : ''),
      z.zahlend ? F.gruen : F.grau);
    }
    const kq = kaufquote(tw, ab);
    if (kq) {
      if (kq.vergleichbar) {
        feld('Kaufquote', `${kq.imZeitraum} von ${kq.besucher} Besuchern in ${kq.tage} Tagen`
          + `  ·  ${(kq.quote * 100).toFixed(2)} %`);
      } else {
        /* Zwei Zahlen, zwei Zeiträume — nebeneinandergestellt, nicht
           geteilt. Eine Quote daraus wäre erfunden. */
        feld('Kaufquote', `${kq.besucher} Besucher in ${kq.tage} Tagen  ·  `
          + `${kq.mitglieder} Mitglieder insgesamt (Gesamtstand, nicht derselbe Zeitraum)`
          + (kq.probeEnthalten ? '  ·  Probeabos enthalten' : ''), F.gelb);
      }
    }
    const monat = (ab.preise ?? []).find((p) => p.monate === 1);
    if (monat || ab.preisText) {
      feld('Preis', (monat ? `${geld(monat.cent, ab.waehrung)} im Monat` : ab.preisText)
        + (ab.preise?.length ? `  ·  ${ab.preise.length} Laufzeiten` : '')
        + (ab.probe ? `  ·  ${ab.probe.anzahl} ${ab.probe.einheit === 'week' ? 'Woche' : ab.probe.einheit} Probe` : ''));
    }
    /* Dons Rechnung: jede Laufzeit auf den Monat umgelegt. */
    if (ab.umsatz) {
      const u = ab.umsatz;
      const eur = ab.kurs?.wert
        ? `  ·  ${geld(Math.round(u.monatCent * ab.kurs.wert), 'EUR')} (EZB ${ab.kurs.datum})` : '';
      feld('Umsatz/Monat', `${geld(u.monatCent, u.waehrung)}${eur}`
        + (u.geschaetzt ? '  ·  GESCHÄTZT, bei Monatsabo' : '')
        + (u.inProbe ? `  ·  ${u.inProbe} noch in Probe` : ''),
      u.geschaetzt ? F.gelb : F.gruen);
      if (u.aufteilung?.length) {
        feld('Aufteilung', u.aufteilung
          .map((t) => `${t.anzahl}× ${t.laufzeit} = ${geld(t.monatCent, u.waehrung)}`).join('  ·  '));
      } else if (u.geschaetzt) {
        /* Der Grund gehört danebengeschrieben, nicht nur die Warnung. */
        feld('', 'Gumroad nennt öffentlich nur die Gesamtzahl, nicht die Laufzeiten —'
          + ' mit Token wird daraus die wirkliche Summe.', F.grau);
      }
    }
    if (ab.einnahmen) {
      const e = ab.einnahmen;
      feld('Einnahmen', `${geld(e.nettoCent, e.waehrung)} in ${e.tage} Tagen`
        + `  ·  brutto ${geld(e.bruttoCent, e.waehrung)}, Gumroad-Gebühr ${geld(e.gebuehrCent, e.waehrung)}`
        + `  ·  ${e.anzahl} Zahlungen`, F.gruen);
    } else {
      /* Lieber sagen, warum nichts dasteht, als eine Zahl erfinden. */
      const grund = {
        'kein-token': `kein Gumroad-Token in ${ABO_ENV} — wird nicht geschätzt`,
        'kein-zugriff': `${ABO_ENV} liegt da, ist aber nicht lesbar`,
        abgelehnt: 'Gumroad hat den Token abgelehnt',
      }[ab.einnahmenGrund] ?? (ab.einnahmenGrund ? `nicht abrufbar — ${ab.einnahmenGrund}` : 'nicht abrufbar');
      feld('Einnahmen', grund, F.gelb);
    }
    if (ab.kurs) {
      feld('Kurs', `1 USD = ${ab.kurs.wert.toFixed(4)} EUR  ·  ${ab.kurs.quelle}`
        + `  ·  vom ${ab.kurs.datum}${ab.kurs.fehler ? `  ·  zuletzt nicht erreichbar` : ''}`,
      ab.kurs.fehler ? F.gelb : F.grau);
    }
    feld('Stand', `vor ${her}${ab.fehler ? `  ·  Gumroad antwortet nicht: ${ab.fehler}` : ''}`,
      ab.frisch && !ab.fehler ? F.grau : F.gelb);
  }

  /* ── Hinweise ────────────────────────────────────────────── */
  if (!chat) {
    schreib();
    schreib(`  ${F.rot}${F.fett}Der Chat-Dienst läuft nicht.${F.aus}`);
    schreib(`  ${F.grau}sudo journalctl -u stellium -n 50   ·   sudo systemctl start stellium${F.aus}`);
  }

  schreib();
  schreib(`  ${F.grau}sudo systemctl restart stellium  ·  sudo journalctl -u stellium -f  ·  sudo stellium-sichern${F.aus}`);
  if (!EINMAL) schreib(`  ${F.grau}Beenden mit Strg+C${F.aus}`);
  schreib();

  traegeSichern();
  return z.join('\n');
}

/* Wird die Datei nur eingebunden — etwa vom Prüflauf in scripts/ —, dann
   soll sie ihre Funktionen hergeben und sonst nichts tun. Ohne diesen Riegel
   liefe beim Import die Dauerschleife der Terminalanzeige an. */
const ALS_HAUPT = (() => {
  try {
    return !!process.argv[1]
      && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();

if (!ALS_HAUPT) {
  /* eingebunden — nichts ausführen */
} else if (process.argv.includes('abo-holen')) {
  /* Der abgekoppelte Abruf. Er schreibt nur die Zwischenspeicherdatei und
     endet; die Anzeige selbst wartet nie auf ihn. */
  await aboHolen();
  process.exit(0);
} else if (process.argv.includes('gumroad-diagnose')) {
  /* Prüfläufer: ruft die Schnittstelle einmalig vollständig ab und gibt nur
     Struktur zurück (siehe Kommentar bei `gumroadDiagnose`). Schreibt nichts
     auf die Platte, rührt die Zwischenspeicherdatei der Anzeige nicht an. */
  process.stdout.write(JSON.stringify(await gumroadDiagnose(), null, 2));
  process.exit(0);
} else if (ALS_JSON) {
  process.stdout.write(JSON.stringify(await daten()));
} else if (EINMAL) {
  process.stdout.write(await zeichnen());
} else {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  const aufraeumen = () => { process.stdout.write('\x1b[?25h\x1b[?1049l'); process.exit(0); };
  process.on('SIGINT', aufraeumen);
  process.on('SIGTERM', aufraeumen);
  for (;;) {
    process.stdout.write(`\x1b[H\x1b[2J${await zeichnen()}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
