import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { verschluesselungAktiv } from '../crypto/nachrichten.js';
import { config } from '../config.js';
import { aiCapabilities } from '../translation/index.js';
import { anstehend } from '../services/wartung.js';
import { KONSOLE_SEITE } from './konsole/seite.js';

const ausfuehren = promisify(execFile);

/**
 * Auskunft und Bedienung für die Person, die vor dem Server sitzt.
 *
 * Erreichbar nur vom Gerät selbst. Auf dem Pi läuft der Dienst ohnehin auf
 * 127.0.0.1, und nginx blendet diese Pfade aus — von außen kommt hier niemand
 * an. Deshalb braucht es keine Anmeldung: wer am Gerät sitzt, kann es ohnehin
 * neu starten.
 */

function nurVonHier(req: FastifyRequest): boolean {
  // Hinter nginx kommt jede Anfrage von 127.0.0.1 — auch die aus dem Internet.
  // Die Adresse allein genügt deshalb nicht: kämen wir durch einen Vermittler,
  // stünde das in diesen Kopfzeilen. Sind sie da, war es nicht das Gerät selbst.
  //
  // Der Cloudflare-Tunnel führt chat.* NICHT über nginx, sondern direkt auf
  // 127.0.0.1:8787 (server-setup/FREMDE-DIENSTE.md) — nginx blendet hier also
  // nichts aus. X-Forwarded-For und CF-Connecting-IP lassen sich in Cloudflare
  // abschalten („Remove visitor IP headers"); CF-Ray und CDN-Loop setzt der
  // Rand dagegen immer. Ohne sie stünden Neustart und Protokoll offen im Netz.
  for (const kopf of [
    'x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host',
    'cf-connecting-ip', 'cf-ray', 'cdn-loop',
  ]) {
    if (req.headers[kopf]) return false;
  }
  const ip = req.ip;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

async function ruf(befehl: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await ausfuehren(befehl, args, { timeout: 4000 });
    return stdout.trim();
  } catch { return null; }
}

const dienstLaeuft = async (name: string) => (await ruf('systemctl', ['is-active', name])) === 'active';

function lesen(pfad: string): string | null {
  try { return fs.readFileSync(pfad, 'utf8').trim(); } catch { return null; }
}

/** Auslastung der Kerne über einen kurzen Abstand. */
let letzteCpu: { gesamt: number; leerlauf: number } | null = null;
function cpuAnteil(): number {
  const jetzt = os.cpus().reduce((a, c) => {
    const gesamt = Object.values(c.times).reduce((x, y) => x + y, 0);
    return { gesamt: a.gesamt + gesamt, leerlauf: a.leerlauf + c.times.idle };
  }, { gesamt: 0, leerlauf: 0 });
  const vorher = letzteCpu;
  letzteCpu = jetzt;
  if (!vorher) return Math.min(1, os.loadavg()[0] / os.cpus().length);
  const dg = jetzt.gesamt - vorher.gesamt;
  const dl = jetzt.leerlauf - vorher.leerlauf;
  return dg > 0 ? Math.min(1, Math.max(0, 1 - dl / dg)) : 0;
}

function temperaturen(): { name: string; grad: number }[] {
  const werte: { name: string; grad: number }[] = [];
  try {
    for (const eintrag of fs.readdirSync('/sys/class/thermal')) {
      if (!eintrag.startsWith('thermal_zone')) continue;
      const roh = Number(lesen(`/sys/class/thermal/${eintrag}/temp`));
      if (!Number.isFinite(roh) || roh <= 0) continue;
      const art = lesen(`/sys/class/thermal/${eintrag}/type`) ?? 'CPU';
      werte.push({ name: art.replace(/[_-]?thermal|_zone\d*/g, '') || 'CPU', grad: Math.round(roh / 1000) });
    }
  } catch { /* nicht vorhanden */ }
  return werte;
}

function zahlen(): Record<string, number | boolean> {
  const ergebnis: Record<string, number | boolean> = {};
  for (const tabelle of ['users', 'channels', 'messages', 'tasks', 'events', 'files', 'ideas']) {
    try {
      const r = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabelle}`);
      if (r) ergebnis[tabelle] = r.n;
    } catch { /* Tabelle fehlt */ }
  }
  try {
    const heute = Date.now() - 86_400_000;
    ergebnis.nachrichtenHeute = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM messages WHERE created_at > ?', heute,
    )?.n ?? 0;
    ergebnis.uebersetzungen = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM message_translations')?.n ?? 0;
    // Wie viele Nachrichten wirklich verschlüsselt liegen — die Zahl zeigt
    // sofort, ob das Masterpasswort greift oder ob im Klartext geschrieben wird.
    const offen = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE text <> '' AND substr(text, 1, 3) <> 'm1:'",
    )?.n ?? 0;
    ergebnis.verschluesselt = verschluesselungAktiv() && offen === 0;
    ergebnis.imKlartext = offen;
  } catch { /* egal */ }
  return ergebnis;
}

export async function registerKonsole(app: FastifyInstance): Promise<void> {
  /** Die Ansicht selbst. */
  app.get('/konsole', async (req, reply) => {
    if (!nurVonHier(req)) return reply.code(404).send({ error: 'Nicht gefunden' });
    return reply.type('text/html; charset=utf-8').send(KONSOLE_SEITE);
  });

  app.get('/api/system', async (req, reply) => {
    if (!nurVonHier(req)) return reply.code(404).send({ error: 'Nicht gefunden' });

    const platte = await ruf('df', ['-B1', '--output=used,size', '/']);
    const [belegt, gesamt] = platte
      ? platte.split('\n')[1].trim().split(/\s+/).map(Number)
      : [0, 0];

    let zertifikat: { name: string; tage: number } | null = null;
    try {
      for (const name of fs.readdirSync('/etc/letsencrypt/live', { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        const ende = await ruf('openssl', ['x509', '-enddate', '-noout', '-in', `/etc/letsencrypt/live/${name.name}/fullchain.pem`]);
        if (!ende) continue;
        zertifikat = { name: name.name, tage: Math.round((new Date(ende.split('=')[1]).getTime() - Date.now()) / 86_400_000) };
        break;
      }
    } catch { /* keines */ }

    let adressen: string[] = [];
    try {
      const conf = fs.readFileSync('/etc/nginx/sites-available/stellium', 'utf8');
      const tls = /listen\s+\d*\s*443|ssl/.test(conf);
      const port = /listen\s+(\d+)\s+ssl/.exec(conf)?.[1];
      adressen = [...new Set([...conf.matchAll(/server_name\s+([^;]+);/g)]
        .flatMap((m) => m[1].trim().split(/\s+/))
        .filter((n) => n !== '_' && n !== 'localhost'))]
        .map((n) => `${tls ? 'https' : 'http'}://${n}${port && port !== '443' ? `:${port}` : ''}`);
    } catch { /* nginx fehlt */ }

    const tunnel = lesen(`${config.dataDir}/tunnel-adresse`);
    if (tunnel) adressen.push(tunnel);

    let sicherung: { anzahl: number; alter: number } | null = null;
    try {
      const liste = fs.readdirSync(`${config.dataDir}/sicherungen`).filter((n) => n.endsWith('.gz'));
      if (liste.length) {
        const neueste = Math.max(...liste.map((n) => fs.statSync(`${config.dataDir}/sicherungen/${n}`).mtimeMs));
        sicherung = { anzahl: liste.length, alter: Date.now() - neueste };
      }
    } catch { /* noch keine */ }

    let datenbank = 0;
    try { datenbank = fs.statSync(`${config.dataDir}/stellium.db`).size; } catch { /* egal */ }

    return {
      modell: lesen('/proc/device-tree/model')?.replace(/\0/g, '') ?? `${os.type()} ${os.arch()}`,
      version: process.env.npm_package_version ?? null,
      laeuftSeit: os.uptime(),
      dienste: {
        chat: await dienstLaeuft('stellium'),
        nginx: await dienstLaeuft('nginx'),
        tunnel: (await dienstLaeuft('cloudflared')) || (await dienstLaeuft('stellium-tunnel')),
      },
      leistung: {
        cpu: cpuAnteil(),
        kerne: os.cpus().length,
        takt: Number(lesen('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq')) / 1000 || null,
        ramBelegt: os.totalmem() - os.freemem(),
        ramGesamt: os.totalmem(),
        platteBelegt: belegt,
        platteGesamt: gesamt,
        temperaturen: temperaturen(),
      },
      adressen,
      zertifikat,
      ai: aiCapabilities(),
      zahlen: zahlen(),
      datenbank,
      sicherung,
      wartung: anstehend(),
      zeit: Date.now(),
    };
  });

  /** Knöpfe. Bewusst wenige, und jeder tut genau eine Sache. */
  app.post('/api/system/:aktion', async (req, reply) => {
    if (!nurVonHier(req)) return reply.code(404).send({ error: 'Nicht gefunden' });
    const { aktion } = req.params as { aktion: string };

    switch (aktion) {
      case 'sichern':
        await ruf('sudo', ['-n', '/usr/local/bin/stellium-sichern']);
        return { ok: true };
      case 'update-pruefen': {
        const aus = await ruf('sudo', ['-n', '/usr/local/bin/stellium-selbstupdate', 'pruefen']);
        return { ok: true, ausgabe: aus ?? 'Keine Auskunft — läuft der Dienst mit den nötigen Rechten?' };
      }
      case 'neustarten':
        // Antwort zuerst, Neustart gleich danach — sonst kommt sie nie an.
        void reply.send({ ok: true });
        setTimeout(() => { void ruf('sudo', ['-n', 'systemctl', 'restart', 'stellium']); }, 400);
        return reply;
      case 'protokoll': {
        const aus = await ruf('journalctl', ['-u', 'stellium', '--no-pager', '-n', '80']);
        return { ok: true, ausgabe: aus ?? 'Kein Protokoll verfügbar.' };
      }
      default:
        return reply.code(404).send({ error: 'Unbekannt' });
    }
  });
}
