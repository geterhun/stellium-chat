import crypto from 'node:crypto';
import { abweisung } from '../util/abweisung.js';
import {
  effectivePermissions, permissionInfo, PERMISSION_KEYS, ROLES,
  type MemberRoleName, type PermissionKey,
} from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { avatarColorFor, hashPassword } from '../auth.js';
import { blindIndex, decryptField, encryptField } from '../crypto/pii.js';
import { kontoBereinigen as notizenKontoBereinigen } from './notizen.js';
import { kontoBereinigen as passwoerterKontoBereinigen } from './passwoerter.js';
import { hinterlegenInTransaktion as kontoSchluesselHinterlegen, verwerfen as kontoSchluesselVerwerfen } from './kontoschluessel.js';
import { verwerfen as anmeldeNachweisVerwerfen } from './anmeldenachweis.js';
import { kontoBereinigen as notzugangKontoBereinigen } from './notzugang.js';
import type { KontoSchluesselBlob } from '@stellium/shared';

/* ── Einmal-Passwörter ────────────────────────────────────────── */

/**
 * Gut vorlesbares Einmal-Passwort. Bewusst ohne Zeichen, die man verwechselt
 * (0/O, 1/l/I) — es wird meist mündlich oder auf Papier weitergegeben.
 */
export function generateOneTimePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const gruppen: string[] = [];
  for (let g = 0; g < 4; g++) {
    let teil = '';
    for (let i = 0; i < 4; i++) {
      teil += alphabet[crypto.randomInt(alphabet.length)];
    }
    gruppen.push(teil);
  }
  return gruppen.join('-');   // z.B. K7QM-3XAF-9TRW-DP2H
}

/* ── Laufende Sitzungen beenden ───────────────────────────────── */

/**
 * Offene Leitungen dieses Kontos kappen.
 *
 * `verifyToken` weist ein entwertetes Token ab, sobald es wieder vorgezeigt
 * wird — bei jedem HTTP-Abruf und bei jedem Verbindungsaufbau. Eine schon
 * offene WebSocket-Leitung zeigt es aber nie wieder vor: sie hat sich beim
 * Verbinden ausgewiesen und trägt ihre Kennung seitdem in der Sitzung. Ohne
 * diesen Ruf läse ein gesperrtes Konto also weiter mit, solange es die
 * Leitung offen hält — stundenlang, tagelang.
 *
 * Der Gateway wird erst hier geholt und nicht oben eingebunden: er bindet
 * seinerseits diese Datei ein, und ein Ring aus zwei Modulen, die beim Laden
 * aufeinander warten, ist ein Startfehler, den niemand mehr zuordnet. So
 * entsteht die Verbindung erst, wenn sie gebraucht wird — und in den
 * Werkzeugen, die nie einen Gateway starten (Saat, Tresor), gar nicht.
 */
function sitzungenKappen(userId: string): void {
  void import('../ws/gateway.js')
    .then((gateway) => gateway.sitzungenBeenden(userId))
    .catch(() => { /* kein Gateway in diesem Prozess — dann gibt es auch keine Sitzung */ });
}

/**
 * Ab jetzt gelten nur noch neue Token.
 *
 * Wird bei jedem Passwortwechsel gerufen, der nicht die Ersteinrichtung ist.
 * Ein Passwort zu wechseln ist die übliche Antwort auf „jemand hat meinen
 * Rechner gehabt" — sie hilft nur, wenn dabei auch die Sitzungen fallen, die
 * derjenige mitgenommen hat.
 */
function sitzungenEntwerten(userId: string, ab = Date.now()): void {
  db.run('UPDATE users SET sitzungen_ab = ? WHERE id = ?', ab, userId);
  sitzungenKappen(userId);
}

const INVITE_TTL = 14 * 86_400_000;

function recordInvite(userId: string, createdBy: string): void {
  db.run(
    'INSERT INTO invites (id, user_id, created_by, created_at, expires_at, used_at) VALUES (?,?,?,?,?,NULL)',
    newId('inv_'), userId, createdBy, Date.now(), Date.now() + INVITE_TTL,
  );
}

/* ── Nachschlagen ─────────────────────────────────────────────── */

/** Login über den Blind-Index: funktioniert mit Benutzername oder E-Mail. */
export function findByLogin(login: string): { id: string; password_hash: string; disabled: number } | null {
  const idx = blindIndex(login);
  const row = db.get<{ id: string; password_hash: string; disabled: number }>(
    'SELECT id, password_hash, disabled FROM users WHERE handle_bidx = ? OR email_bidx = ?', idx, idx,
  );
  if (row) return row;

  // Konten aus der Zeit vor der Verschlüsselung
  return db.get<{ id: string; password_hash: string; disabled: number }>(
    'SELECT id, password_hash, disabled FROM users WHERE lower(handle) = lower(?) OR lower(email) = lower(?)',
    login.trim(), login.trim(),
  ) ?? null;
}

export function handleTaken(handle: string, exceptUserId?: string): boolean {
  const row = db.get<{ id: string }>('SELECT id FROM users WHERE handle_bidx = ?', blindIndex(handle));
  return Boolean(row && row.id !== exceptUserId);
}

export function emailTaken(email: string, exceptUserId?: string): boolean {
  const row = db.get<{ id: string }>('SELECT id FROM users WHERE email_bidx = ?', blindIndex(email));
  return Boolean(row && row.id !== exceptUserId);
}

/* ── Rechte ───────────────────────────────────────────────────── */

export function overridesFor(userId: string): Partial<Record<PermissionKey, boolean>> {
  const rows = db.all<{ permission: string; allowed: number }>(
    'SELECT permission, allowed FROM user_permissions WHERE user_id = ?', userId,
  );
  const out: Partial<Record<PermissionKey, boolean>> = {};
  for (const r of rows) {
    if (PERMISSION_KEYS.includes(r.permission as PermissionKey)) {
      out[r.permission as PermissionKey] = Boolean(r.allowed);
    }
  }
  return out;
}

export function permissionsFor(userId: string): Record<PermissionKey, boolean> {
  const row = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  const role = (row?.role ?? 'member') as MemberRoleName;
  return effectivePermissions(role, overridesFor(userId));
}

export function may(userId: string, permission: PermissionKey): boolean {
  return permissionsFor(userId)[permission] === true;
}

/** Recht setzen. null bedeutet: zurück zur Rollenvorgabe. */
export function setPermission(userId: string, permission: PermissionKey, allowed: boolean | null, setBy: string): void {
  if (!PERMISSION_KEYS.includes(permission)) throw abweisung('fehler.rechtUnbekannt', `Unbekanntes Recht: ${permission}`, { recht: permission });
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  if (!ziel) throw abweisung('fehler.kontoNichtGefunden', 'Konto nicht gefunden');
  if (ziel.role === 'owner') throw abweisung('fehler.ownerRechte', 'Dem Owner lassen sich keine Rechte nehmen.');

  /* Vier Rechte tragen `ownerOnly`: Konten löschen, Rechte vergeben,
     Freigaben lesen und den Fernzugang einrichten. Die Oberfläche sperrt sie für alle außer den Owner — der
     Server tat das bisher nicht. Solange nur der Owner „Rechte vergeben" hat,
     fällt das nicht auf; gibt er es einmal weiter, gilt plötzlich die
     Beschriftung und nicht mehr die Regel, und wer es hat, holt sich damit
     auch das Lesen fremder Freigaben. Durchgesetzt wird auf dem Server. */
  if (permissionInfo(permission)?.ownerOnly) {
    const setzer = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', setBy);
    if (setzer?.role !== 'owner') {
      throw abweisung('fehler.nurOwnerRecht',
        'Dieses Recht vergibt nur der Inhaber.', { recht: permission });
    }
  }

  if (allowed === null) {
    db.run('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?', userId, permission);
    return;
  }
  db.run(
    `INSERT INTO user_permissions (user_id, permission, allowed, set_by, set_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, permission) DO UPDATE SET allowed = excluded.allowed, set_by = excluded.set_by, set_at = excluded.set_at`,
    userId, permission, allowed ? 1 : 0, setBy, Date.now(),
  );
}

/**
 * Die Rolle eines Kontos setzen.
 *
 * WELCHE ROLLEN HIER DURCHKOMMEN — UND WARUM DAS EINMAL FALSCH WAR
 * Hier stand `['owner', 'admin', 'member', 'guest']`, von Hand
 * danebengeschrieben. `ROLES` (@stellium/shared) kennt aber zehn Namen. Die
 * vier stammen aus der Fassung, in der es wirklich nur vier gab (Commit
 * 1a9a867); der Commit, der auf neun erweiterte (e575de7, Betreff „neun
 * Rollen"), kam nie hierher zurück. Folge: `POST /api/admin/users/:id/role`
 * ließ `moderator`, `technik`, `teamlead`, `contributor`, `readonly` und
 * `bot` durch — `rolleLesen()` (http/routes.ts) prüft gegen `ROLES` —, und
 * hier flogen sie mit „Unbekannte Rolle" wieder heraus. Dieselben sechs
 * Rollen ließen sich beim ANLEGEN eines Kontos problemlos vergeben; nur
 * ÄNDERN ließ sich niemand auf sie. Das war kein Vorbehalt, sondern eine
 * Liste, die stehengeblieben ist.
 *
 * Geprüft wird deshalb gegen `ROLES` selbst — dieselbe Quelle, aus der
 * `rolleLesen()` und `ROLE_DEFAULTS` kommen. Eine abgeschriebene Liste kann
 * wieder veralten, `ROLES` nicht.
 *
 * WAS DAMIT NOCH NICHT ERLEDIGT IST: dieselben vier Namen stehen ein
 * DRITTES Mal in `packages/desktop/src/components/TeamAdmin.tsx` (`ROLLEN`,
 * ganz oben), und die Oberfläche importiert `ROLES` nirgends. Ihr
 * Auswahlfeld bietet weiterhin nur die vier an, und für ein Konto mit einer
 * der sechs übrigen Rollen bleibt die Rollenbeschriftung dort leer. Das ist
 * kein Rechteproblem — der Server entscheidet ohnehin allein —, aber es ist
 * derselbe Fehler an einer dritten Stelle. Ausführlicher steht das bei
 * `rolleLesen()` in http/routes.ts.
 *
 * DASS DAS KEINE TÜR AUFMACHT, während nebenan eine zugeht: die sechs neu
 * erreichbaren Rollen tragen zusammen kein einziges `ownerOnly`-Recht
 * (nachgerechnet in src/pruefungen/rechte-eskalation.mts), und der einzige
 * Aufrufer dieser Funktion ist `POST /api/admin/users/:id/role`, wo vorher
 * `darfRolleVergeben()` steht. Der Wächter dort vergleicht Rechtemengen und
 * nicht Namen — er deckt die sechs also ab, seit es sie gibt, ohne dass
 * jemand ihn dafür anfassen müsste. Genau deshalb prüft diese Funktion
 * selbst weiterhin keine Berechtigung: der ganze Wächter sitzt an der
 * Grenze, in der Route.
 */
export function setRole(userId: string, role: MemberRoleName, setBy: string): void {
  if (!ROLES.some((r) => r.name === role)) throw abweisung('fehler.rolleUnbekannt', 'Unbekannte Rolle');
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  if (!ziel) throw abweisung('fehler.kontoNichtGefunden', 'Konto nicht gefunden');
  if (ziel.role === 'owner' && role !== 'owner') {
    const andere = db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role = 'owner' AND id <> ?", userId);
    if ((andere?.n ?? 0) === 0) throw abweisung('fehler.letzterOwner', 'Der letzte Owner kann seine Rolle nicht abgeben.');
  }
  db.run('UPDATE users SET role = ? WHERE id = ?', role, userId);
  // Persönliche Ausnahmen passen selten zur neuen Rolle.
  db.run('DELETE FROM user_permissions WHERE user_id = ?', userId);
  void setBy;
}

/* ── Konten anlegen und ändern ────────────────────────────────── */

export interface CreatedAccount {
  userId: string;
  handle: string;
  oneTimePassword: string;
}

/**
 * Neues Konto mit Einmal-Passwort. Benutzername und E-Mail darf die Person
 * beim ersten Login selbst setzen — der Vorschlag hier ist nur ein Platzhalter.
 */
export function createAccount(input: {
  displayName: string;
  handle?: string;
  email?: string;
  role?: MemberRoleName;
  language?: string;
  timezone?: string;
  createdBy: string;
}): CreatedAccount {
  const displayName = input.displayName.trim();
  if (displayName.length < 2) throw abweisung('fehler.nameAngeben', 'Bitte einen Namen angeben.');

  const handle = (input.handle?.trim().toLowerCase() || vorschlagHandle(displayName));
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(handle)) {
    throw abweisung('fehler.benutzernameForm', 'Benutzername: 2–32 Zeichen, Kleinbuchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.');
  }
  if (handleTaken(handle)) throw abweisung('fehler.benutzernameVergeben', `Benutzername "${handle}" ist schon vergeben.`, { name: handle });

  const email = input.email?.trim().toLowerCase() ?? '';
  if (email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw abweisung('fehler.emailUngueltig', 'E-Mail ist ungültig.');
    if (emailTaken(email)) throw abweisung('fehler.emailVergeben', 'Diese E-Mail wird bereits verwendet.');
  }

  const passwort = generateOneTimePassword();
  const id = newId('u_');
  const jetzt = Date.now();

  db.transaction(() => {
    db.run(
      `INSERT INTO users (id, handle, handle_bidx, email, email_bidx, display_name, password_hash,
                          avatar_color, timezone, language, role, must_change_password,
                          must_complete_profile, created_by, password_set_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      id,
      encryptField(handle), blindIndex(handle),
      email ? encryptField(email) : '', email ? blindIndex(email) : null,
      displayName, hashPassword(passwort), avatarColorFor(handle),
      input.timezone || 'Europe/Berlin', input.language || 'de',
      input.role ?? 'member',
      email ? 0 : 1,            // ohne E-Mail muss das Profil noch vervollständigt werden
      input.createdBy, jetzt, jetzt,
    );

    // In alle offenen Kanäle aufnehmen, damit niemand vor leerer Liste sitzt.
    for (const ch of db.all<{ id: string }>("SELECT id FROM channels WHERE kind = 'public' AND archived = 0")) {
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', ch.id, id, jetzt);
    }
    recordInvite(id, input.createdBy);
  });

  return { userId: id, handle, oneTimePassword: passwort };
}

function vorschlagHandle(displayName: string): string {
  const basis = displayName.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '')
    .slice(0, 24) || 'kollege';
  if (!handleTaken(basis)) return basis;
  for (let i = 2; i < 100; i++) {
    if (!handleTaken(`${basis}${i}`)) return `${basis}${i}`;
  }
  return `${basis}${crypto.randomInt(1000, 9999)}`;
}

/**
 * Passwort zurücksetzen — erzeugt ein neues Einmal-Passwort.
 *
 * WER DAS DARF, ENTSCHEIDET DIESE FUNKTION NICHT. Das zurückgegebene
 * Einmal-Passwort macht den Aufrufer faktisch zum Konto `userId`; wer es
 * bekommen darf, prüft `fehlendesRechtZurUebernahme()` in http/routes.ts,
 * vor dem einzigen Aufruf dieser Funktion. Dieselbe Aufteilung wie bei
 * `setRole()`/`darfRolleVergeben()`: der Wächter steht an der Grenze, der
 * Dienst führt aus. Wer hier einen ZWEITEN Aufrufer ergänzt, muss den
 * Wächter mitnehmen — sonst steht die Tür wieder offen, die im
 * Kopfkommentar dort beschrieben ist.
 *
 * Drei Dinge geschehen dabei absichtlich zusammen, und sie sind es, die
 * eine missbräuchliche Übernahme LAUT machen (siehe dieselbe Stelle,
 * Abschnitt „Punkt 3 gilt hier nicht"): die Sitzungen des Ziels fallen, das
 * Konto muss beim nächsten Anmelden ein neues Passwort setzen, und
 * `recordInvite()` schreibt fest, WER zurückgesetzt hat.
 */
export function resetPassword(userId: string, byUserId: string): string {
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  if (!ziel) throw abweisung('fehler.kontoNichtGefunden', 'Konto nicht gefunden');

  const passwort = generateOneTimePassword();
  const jetzt = Date.now();
  db.run(
    'UPDATE users SET password_hash = ?, must_change_password = 1, password_set_at = ? WHERE id = ?',
    hashPassword(passwort), jetzt, userId,
  );
  /* Ein Zurücksetzen ist fast immer die Antwort darauf, dass jemand nicht mehr
     hereinkommt — oder dass jemand hereinkam, der nicht sollte. In beiden
     Fällen darf das alte Token nicht weiterlaufen. */
  sitzungenEntwerten(userId, jetzt);
  /* Der Kontoschlüssel steckt in einer Hülle, die nur das BISHERIGE Passwort
     öffnet — und das kennt nach einem Zurücksetzen niemand mehr, auch die
     Person selbst nicht. Ihn stehen zu lassen hieße, Notiz-Kontopakete in der
     Datenbank zu behalten, die richtig aussehen und sich nie wieder öffnen
     lassen. Der Geräteweg (notiz_schluessel_pakete) bleibt davon unberührt:
     er hängt am privaten Teil des Geräts, nicht am Passwort — genau dafür
     gibt es ihn als zweiten Weg. */
  kontoSchluesselVerwerfen(userId);
  /* Und der Anmeldenachweis. Er ist aus dem BISHERIGEN Passwort abgeleitet
     und wäre nach einem Zurücksetzen ein zweiter, weiter gültiger Zugang zu
     genau dem Konto, das man gerade zugesperrt hat. Wer sich danach mit dem
     Einmal-Passwort anmeldet, nimmt wieder den klassischen Weg; ein neuer
     Nachweis entsteht von selbst. */
  anmeldeNachweisVerwerfen(userId);
  recordInvite(userId, byUserId);
  return passwort;
}

export function setDisabled(userId: string, disabled: boolean): void {
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  if (ziel?.role === 'owner' && disabled) throw abweisung('fehler.ownerSperren', 'Der Owner lässt sich nicht sperren.');
  db.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, userId);
  /* Sperren hieß bisher nur: die Anmeldung geht nicht mehr. Wer schon ein
     Token hatte, arbeitete damit weiter — bis zu dreißig Tage lang, in jedem
     Kanal, in dem er stand. Die Prüfung in `verifyToken` schließt jeden neuen
     Abruf; hier fällt zusätzlich die Leitung, die schon offen ist. */
  if (disabled) sitzungenKappen(userId);
}

/**
 * Konto löschen. Nachrichten bleiben stehen — sonst würden Gespräche
 * unverständlich. Der Name wird durch einen Platzhalter ersetzt.
 *
 * DIE FALLE FÜR DEN NÄCHSTEN, DER HIER EINE TABELLE ERGÄNZT: `schema.sql`
 * trägt an 23 Stellen `... REFERENCES users(id) ON DELETE CASCADE`. Das
 * liest sich wie eine Garantie — ist keine. Eine Kaskade feuert nur bei
 * einem echten `DELETE FROM users WHERE id = ?`. Das UPDATE gleich unten
 * anonymisiert die Zeile in `users`, löscht sie aber nie — mit Absicht, denn
 * Nachrichten und ihr Verlauf sollen ein gelöschtes Konto überleben. Die
 * Kehrseite: JEDE der 23 Kaskaden an `users(id)` ist damit toter Text im
 * Schema, für immer. Was verschwinden soll, muss unten von Hand als eigene
 * Zeile stehen — sonst verlässt sich die nächste Tabelle mit
 * `user_id ... ON DELETE CASCADE` auf ein Aufräumen, das nie kommt, und
 * jemand findet das erst, wenn eine gelöschte Person irgendwo im Produkt
 * wieder auftaucht.
 *
 * Ein Auditor hat alle 23 durchgesehen. Sieben stehen unten als eigene
 * DELETE-Zeile (user_permissions, channel_members, drafts, reminders,
 * scheduled_messages, saved_messages, push_subscriptions). Drei sind
 * bewusst NICHT gelöscht und an der Stelle dokumentiert, an der die
 * Entscheidung hingehört: praesenz_tage (Absatz direkt darunter),
 * notiz_mitglieder und notiz_schluessel_pakete (services/notizen.ts,
 * kontoBereinigen() — das Vorbild für diese Art Begründung). Die
 * restlichen 13 werden unten einzeln entschieden, jede mit sichtbarer
 * Zeile oder sichtbarem Kommentar statt mit Schweigen.
 *
 * Und, weil es hier leicht übersehen wird: alles, was diese Funktion
 * zusätzlich ruft, darf KEINE eigene db.transaction() öffnen. Diese Hülle
 * kennt kein SAVEPOINT (db/index.ts, transaction() ist nur BEGIN/COMMIT/
 * ROLLBACK) — ein zweites BEGIN mitten in einem offenen reißt die ganze
 * Kontolöschung mit sich. notizenKontoBereinigen() weiter unten macht genau
 * deshalb keine eigene Transaktion auf und sagt das dort auch selbst so.
 *
 * praesenz_tage (Onlinezeit je Tag) bleibt aus demselben Grund wie die
 * Nachrichten stehen und wird bewusst NICHT gelöscht: die Summen können
 * betrieblich gebraucht werden (z. B. für eine Auswertung über den Monat),
 * und sie sind, genau wie alte Nachrichten, schon durch das UPDATE oben
 * anonymisiert — jede Anzeige liest den Namen zur user_id erst beim
 * Darstellen nach, und die zeigt für dieses Konto ab jetzt „Ehemaliges
 * Mitglied". Eine eigene Löschung hier brächte keinen zusätzlichen Schutz,
 * nur den Verlust echter Zahlen.
 *
 * push_subscriptions dagegen hat kein Gegenstück zu „bleibt sinnvoll
 * stehen": eine Zustell-URL zeigt auf das Gerät einer Person, die das Konto
 * gerade verlassen hat, und ohne diese Zeile bekäme es weiter Nachrichten
 * zugestellt. Der Fremdschlüssel trägt zwar ON DELETE CASCADE (schema.sql),
 * aber die Zeile in `users` wird hier nur geändert, nie gelöscht — die
 * Kaskade greift also nie von selbst.
 */
export function deleteAccount(userId: string): void {
  const ziel = db.get<{ role: string; deleted_at: number | null; avatar_url: string | null }>(
    'SELECT role, deleted_at, avatar_url FROM users WHERE id = ?', userId,
  );
  if (!ziel) throw abweisung('fehler.kontoNichtGefunden', 'Konto nicht gefunden');
  if (ziel.role === 'owner') throw abweisung('fehler.ownerLoeschen', 'Der Owner lässt sich nicht löschen. Erst die Rolle übergeben.');
  if (ziel.deleted_at) throw abweisung('fehler.kontoSchonGeloescht', 'Dieses Konto ist bereits gelöscht.');

  db.transaction(() => {
    db.run(
      `UPDATE users SET display_name = 'Ehemaliges Mitglied', handle = ?, handle_bidx = ?,
              email = '', email_bidx = NULL, avatar_url = NULL, status = 'offline',
              status_text = NULL, status_emoji = NULL, disabled = 1,
              password_hash = ?, role = 'guest', deleted_at = ?
       WHERE id = ?`,
      encryptField(`geloescht.${userId.slice(-6)}`), blindIndex(`geloescht.${userId.slice(-6)}`),
      hashPassword(crypto.randomBytes(32).toString('hex')),
      Date.now(),
      userId,
    );
    db.run('DELETE FROM user_permissions WHERE user_id = ?', userId);
    db.run('DELETE FROM channel_members WHERE user_id = ?', userId);
    /* task_watchers gehört in dieselbe Gruppe wie channel_members: eine
       Mitgliedschaft/ein Abo ohne eigenen Inhalt. Ein Watcher-Eintrag ist
       ein Versprechen an die ZUKUNFT ("melde dich, wenn sich hier etwas
       ändert") — für ein Konto, das nie wieder etwas empfängt, gibt es diese
       Zukunft nicht mehr. Anders als bei einer Reaktion oder einem Kommentar
       (weiter unten) steckt in der Zeile selbst kein Ausdruck, den später
       einmal jemand nachlesen wollte. */
    db.run('DELETE FROM task_watchers WHERE user_id = ?', userId);
    db.run('DELETE FROM drafts WHERE user_id = ?', userId);
    db.run('DELETE FROM reminders WHERE user_id = ?', userId);
    db.run('DELETE FROM scheduled_messages WHERE user_id = ?', userId);
    db.run('DELETE FROM saved_messages WHERE user_id = ?', userId);
    /* hidden_messages ist der Zwilling von saved_messages direkt darüber:
       eine rein private Sicht auf eine fremde Nachricht ("für MICH
       ausgeblendet"), die nie jemand außer der ausblendenden Person zu sehen
       bekam. Für ein Konto, das nichts mehr ansieht, ist das reines
       Totgewicht — anders als bei message_mentions/reactions weiter unten
       steckt hier kein Inhalt, den ANDERE beim Lesen der Nachricht sehen. */
    db.run('DELETE FROM hidden_messages WHERE user_id = ?', userId);
    // Geräte einer Person, die es nicht mehr gibt, sollen nichts mehr zugestellt
    // bekommen — siehe Begründung oben, warum das hier stehen muss.
    db.run('DELETE FROM push_subscriptions WHERE user_id = ?', userId);

    /* Schlüsselmaterial für vertrauliche Kanäle (services/vertraulich.ts).
       Anders als alles andere in dieser Funktion ist das kein "Inhalt, der
       ein Konto überleben soll" — es ist Schlüsselmaterial, und
       Schlüsselmaterial für ein Konto, das es absichtlich nicht mehr geben
       soll, ist kein Aufbewahren, sondern ein Versäumnis:
         - vertraulich_schluessel trägt den ÖFFENTLICHEN Teil samt Abdruck.
           Öffentlich heißt: nicht geheim, aber auch ohne jeden Nutzen mehr,
           sobald niemand mehr für dieses Konto etwas verpackt — und das tut
           niemand mehr, weil channel_members für diese Person schon oben
           geleert wurde und verwaltungIds() (vertraulich.ts) ohnehin
           `u.deleted_at IS NULL AND u.disabled = 0` verlangt.
         - vertraulich_sicherung trägt den PRIVATEN Teil, nur verschlossen
           mit einem Wiederherstellungscode, den der Server nie kennt. Wer
           diesen Code noch hat, käme über diese Zeile weiterhin an den
           vollen privaten Schlüssel — genau das darf ein gelöschtes Konto
           nicht mehr hergeben.
       Vor diesen zwei Zeilen geprüft, statt nur behauptet:
         - Ein bestehender vertraulicher Kanal bleibt für alle verbleibenden
           Mitglieder uneingeschränkt nutzbar. Kanalschlüssel und Pakete je
           Mitglied liegen in eigenen Tabellen (kanal_schluessel,
           kanal_schluessel_pakete) und führen zu user_id gar keinen
           Fremdschlüssel — sie hängen an keiner der beiden Zeilen hier.
         - Kein Aufrufer setzt zwingend eine vorhandene Zeile voraus:
           oeffentlicheSchluessel() liefert bei fehlender Zeile schlicht ein
           leeres Ergebnis, hatSchluessel() dann false.
         - Die Pakete, die dieses Konto selbst noch in FREMDEN vertraulichen
           Kanälen/Notizen hält (kanal_schluessel_pakete, notiz_schluessel_
           pakete), bleiben von diesen zwei Zeilen unberührt liegen — dieselbe
           Grenze, die services/notizen.ts (kontoBereinigen()) für
           notiz_schluessel_pakete bereits beschreibt und begründet. Diese
           Funktion zieht hier keine engere Grenze als der Rest des Hauses.
         - Ein zweites Konto kann diese Zeilen nie erben: `users.id` ist der
           Primärschlüssel, die Zeile in `users` bleibt für immer stehen
           (siehe UPDATE oben — sie wird geändert, nie gelöscht), also
           vergibt createAccount() (newId('u_')) diese Kennung nie wieder. */
    db.run('DELETE FROM vertraulich_schluessel WHERE user_id = ?', userId);
    db.run('DELETE FROM vertraulich_sicherung WHERE user_id = ?', userId);

    /* Die übrigen Fremdschlüssel mit ON DELETE CASCADE auf users(id) (Kopf
       dieser Funktion) bleiben absichtlich stehen — gruppiert nach
       demselben Grund statt einzeln elfmal wiederholt:

       message_mentions, reactions — hängen an einer Nachricht, die stehen
       bleibt, und sind selbst der Teil davon, der beim Lesen gezeigt wird
       (wer erwähnt wurde, wer reagiert hat — mentionsFor()/reactionsFor()
       in services/store.ts bauen daraus jede Nachricht mit). Sie zu löschen
       ließe eine stehende Nachricht rückwirkend anders aussehen, als sie
       war — derselbe Fehler, den ein gelöschter Nachrichtentext wäre.

       poll_votes, poll_participants, event_attendees — das protokollierte
       ERGEBNIS einer gemeinsamen Entscheidung, nicht bloß eine Beziehung.
       Bei offenen Umfragen zählt poll_votes live mit (services/polls.ts,
       hydrate()) — eine gelöschte Stimme änderte rückwirkend das Ergebnis
       einer Abstimmung, die längst gelaufen ist. Bei anonymen Umfragen zählt
       poll_participants ebenso in die ausgewiesene Teilnehmerzahl mit hinein,
       ohne preiszugeben, wer wie gestimmt hat. event_attendees.response ist
       die Antwort auf eine Einladung — bei einem vergangenen Termin derselbe
       historische Fakt wie eine Umfragestimme.

       idea_votes, idea_comments — eine Stimme (wert) bzw. ein geschriebener
       Kommentar zu einer Idee: Inhalt, den andere gelesen haben, genau wie
       eine Nachricht.

       invites — reine Beleg-Buchhaltung (wann wurde für dieses Konto ein
       Einmal-Passwort ausgestellt, von wem; das Passwort selbst steht in
       keiner Spalte hier). Einlösbar ist so ein Eintrag ohnehin nicht mehr,
       sobald das UPDATE oben gelaufen ist — password_hash steht auf einem
       Zufallswert, den niemand kennt, disabled = 1 sperrt zusätzlich jeden
       Login. Es gibt also nichts mehr zu widerrufen, nur eine Herkunftsspur
       ("wer hat dieses Konto wann eingerichtet oder zurückgesetzt"), und die
       soll eine Löschung genauso überleben wie jede andere Spur im Haus.

       vorschlaege.fuer_user_id ist ein Sonderfall und bleibt aus einem ganz
       anderen Grund stehen als die Zeilen oben: die UNIQUE-Bedingung
       idx_vorschlaege_dublette (channel_id, art, abdruck) ist das gesamte
       Gedächtnis gegen Dubletten (services/vorschlaege.ts, Kopf der Datei
       unter "DUBLETTEN", und anlegen() dort — "Sie greift auch dann, wenn
       der Vorschlag vor Wochen abgelehnt wurde"). Das gilt für JEDEN
       Zustand, auch "abgelehnt" und "verfallen", also gerade die Fälle, die
       hier am ehesten wie erledigter Papierkram aussehen. Lösche man die
       Zeilen der für diese Person offenen Vorschläge, käme derselbe, einst
       abgelehnte Vorschlag beim nächsten Lauf für eine andere Person wieder
       herein — die Kontolöschung einer Person würfe damit die Entscheidung
       einer ganz anderen um. Die noch offenen Vorschläge dieser Person
       laufen dagegen einfach ins Leere: fuer_user_id zeigt auf ein Konto,
       das sich nie wieder anmeldet, listeFuer()/anzahlFuer() zeigen sie
       folglich niemandem mehr — stilles, aber ungefährliches Liegenbleiben,
       kein Leck. */

    /* Notizen: rein persönliche fallen weg wie Entwürfe und Erinnerungen
       oben, geteilte bleiben stehen und bekommen die am längsten dabei
       stehende Person als neue besitzende Person. Siehe services/notizen.ts,
       kontoBereinigen() für die ausführliche Begründung beider Fälle. */
    notizenKontoBereinigen(userId);
    /* Der Passwort-Tresor folgt derselben Regel wie Notizen direkt darüber —
       wortgleiche Begründung in services/passwoerter.ts, kontoBereinigen(). */
    passwoerterKontoBereinigen(userId);
    /* Der Notzugang, und zwar VOR dem Kontoschlüssel darunter — die
       Reihenfolge ist hier keine Geschmacksfrage. kontoSchluesselVerwerfen()
       geht seit dem Notzugang einen SCHONENDEN Weg, solange einer auf den
       Schlüssel zeigt: es lässt die Kontopakete stehen, weil es einen Weg
       zurück gibt. Für ein gelöschtes Konto gibt es den nicht und soll es
       ihn nicht geben. Andersherum gerufen bliebe genau das Material
       liegen, dessen Löschung der Zweck dieser Funktion ist. */
    notzugangKontoBereinigen(userId);
    /* Und der Kontoschlüssel selbst. Er hängt am Passwort eines Kontos, das
       es nicht mehr gibt — stehen bliebe nur eine Hülle ohne Hand, die sie
       je wieder öffnet. */
    kontoSchluesselVerwerfen(userId);
    /* Der Anmeldenachweis ebenso — und ausdrücklich von Hand: der
       Fremdschlüssel trägt zwar ON DELETE CASCADE, aber die Zeile in `users`
       wird hier nur GEÄNDERT, nie gelöscht, die Kaskade greift also nie
       (dieselbe Falle wie bei den Zustell-URLs weiter oben). Bliebe er
       stehen, wäre er ein gültiger Zugang zu einem gelöschten Konto. */
    anmeldeNachweisVerwerfen(userId);
  });
  /* Auch hier und nicht nur in der Route: wer künftig von anderswoher löscht,
     soll die Sitzungen nicht eigens mitbedenken müssen. */
  sitzungenKappen(userId);
  /* Das Profilbild selbst. Das UPDATE oben nimmt nur den Verweis weg — die
     Datei blieb unter ihrer alten Adresse liegen, und /avatare/:datei gab das
     Gesicht einer gelöschten Person weiter an jedes angemeldete Konto heraus,
     das die Adresse noch kannte. Erst nach der Transaktion: ein Fehlschlag
     beim Löschen der Datei darf die Kontolöschung nicht zurückrollen.
     Nachgeladen statt oben eingebunden, aus demselben Grund wie bei
     sitzungenKappen(): avatare.ts zieht sharp und legt beim Laden einen
     Ordner an, was die Werkzeuge ohne Server nicht brauchen. */
  if (ziel.avatar_url) {
    const bisherige = ziel.avatar_url;
    void import('./avatare.js')
      .then((avatare) => avatare.entfernen(bisherige))
      .catch((fehler) => console.error('[users] Profilbild nicht entfernt:', (fehler as Error).message));
  }
}

/* ── Ersteinrichtung durch die Person selbst ──────────────────── */

export function completeSetup(userId: string, input: {
  handle?: string; email?: string; displayName?: string; newPassword: string;
}): void {
  if (input.newPassword.length < 10) throw abweisung('fehler.passwortZuKurz', 'Das neue Passwort braucht mindestens 10 Zeichen.');

  /* Dieser Weg setzt ein neues Passwort, ohne das bisherige zu kennen. Das ist
     nur in der Einrichtungsphase vertretbar — nach dem Anlegen des Kontos und
     nach einem Zurücksetzen. Ohne die Sperre bliebe er dauerhaft offen und
     wäre ein Umweg um changeOwnPassword(): wer einmal an ein Token käme,
     könnte das Passwort austauschen, ohne es je gekannt zu haben. Die Sperre
     hängt weiter unten an der WHERE-Bedingung des UPDATE und nicht an einer
     vorgeschalteten Abfrage — so kann zwischen Prüfen und Schreiben nichts
     dazwischenkommen.

     Und nur hier wird `sitzungen_ab` bewusst nicht mitgesetzt, obwohl ein
     Passwort geschrieben wird: dieser Weg läuft mit genau dem Token, das er
     sonst entwerten würde. Die Person steht mitten in ihrer Einrichtung, die
     App hat noch keine Anmeldung mit dem neuen Passwort — sie flöge auf halbem
     Weg heraus. Ein Verzicht ist es nicht: das Token stammt aus dem
     Einmal-Passwort, das gerade eben verbraucht wurde. */
  const felder: string[] = ['password_hash = ?', 'must_change_password = 0', 'password_set_at = ?'];
  const werte: any[] = [hashPassword(input.newPassword), Date.now()];

  if (input.handle) {
    const handle = input.handle.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(handle)) {
      throw abweisung('fehler.benutzernameForm', 'Benutzername: 2–32 Zeichen, Kleinbuchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.');
    }
    if (handleTaken(handle, userId)) throw abweisung('fehler.benutzernameVergeben', `Benutzername "${handle}" ist schon vergeben.`, { name: handle });
    felder.push('handle = ?', 'handle_bidx = ?');
    werte.push(encryptField(handle), blindIndex(handle));
  }

  if (input.email) {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw abweisung('fehler.emailUngueltig', 'E-Mail ist ungültig.');
    if (emailTaken(email, userId)) throw abweisung('fehler.emailVergeben', 'Diese E-Mail wird bereits verwendet.');
    felder.push('email = ?', 'email_bidx = ?');
    werte.push(encryptField(email), blindIndex(email));
  }

  if (input.displayName?.trim()) {
    felder.push('display_name = ?');
    werte.push(input.displayName.trim().slice(0, 80));
  }

  felder.push('must_complete_profile = 0');
  const { changes } = db.run(
    `UPDATE users SET ${felder.join(', ')}
      WHERE id = ? AND (must_change_password = 1 OR must_complete_profile = 1)`,
    ...werte, userId,
  );
  if (!changes) {
    throw abweisung('fehler.einrichtungFertig', 'Die Ersteinrichtung ist bereits abgeschlossen. Das Passwort änderst du in den Einstellungen.');
  }
  /* Derselbe Grund wie bei resetPassword(): hier wird ein Passwort gesetzt,
     OHNE dass das bisherige bekannt war. Ein Kontoschlüssel aus der Zeit
     davor wäre ab jetzt für niemanden mehr zu öffnen. */
  kontoSchluesselVerwerfen(userId);
  /* Derselbe Grund für den Anmeldenachweis: er gehört zum Einmal-Passwort,
     das hier gerade ersetzt wurde. */
  anmeldeNachweisVerwerfen(userId);
}

/**
 * Passwort selbst ändern — dafür braucht es das alte.
 *
 * `kontoSchluessel` ist der Kontoschlüssel, NEU umschlossen: die App hat in
 * genau diesem Augenblick beide Passwörter im Klartext und ist damit die
 * einzige Stelle im ganzen Haus, die den Kontoschlüssel aus der alten Hülle
 * holen und in eine neue legen kann. Der Server sieht dabei wie immer nur
 * Bytes.
 *
 * Wahlfrei, und das mit Bedacht: eine ältere App schickt nichts mit. Dann
 * bleibt die alte Hülle stehen, kein Gerät kann sie danach noch öffnen — und
 * das nächste, das sich anmeldet, legt einen NEUEN Kontoschlüssel an (siehe
 * hinterlegen() in services/kontoschluessel.ts: anderer Abdruck heißt
 * Ersatz), woraufhin die Notiz-Kontopakete weggeräumt und von einem Gerät
 * mit Geräteweg neu geschrieben werden. Umständlich, aber ehrlich und ohne
 * Verlust. Den Wechsel deswegen ABZULEHNEN wäre schlechter: dann käme jemand
 * mit einer alten App nicht mehr an sein Passwort.
 *
 * Beides in einer Transaktion: ein Passwortwechsel, der durchgeht, während
 * das Umschließen scheitert, hinterließe genau die Hülle, die niemand mehr
 * öffnen kann.
 */
export function changeOwnPassword(userId: string, altes: string, neues: string,
                                  pruefe: (klartext: string, hash: string) => boolean,
                                  kontoSchluessel?: KontoSchluesselBlob): void {
  if (neues.length < 10) throw abweisung('fehler.passwortZuKurz', 'Das neue Passwort braucht mindestens 10 Zeichen.');
  const row = db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', userId);
  if (!row || !pruefe(altes, row.password_hash)) throw abweisung('fehler.altesPasswortFalsch', 'Das bisherige Passwort stimmt nicht.');
  const jetzt = Date.now();
  db.transaction(() => {
    db.run(
      'UPDATE users SET password_hash = ?, must_change_password = 0, password_set_at = ? WHERE id = ?',
      hashPassword(neues), jetzt, userId,
    );
    if (kontoSchluessel) kontoSchluesselHinterlegen(userId, kontoSchluessel);
    /* Der Anmeldenachweis gehört zum alten Passwort und fällt mit ihm — in
       DERSELBEN Transaktion, denn ein Wechsel, der durchgeht, während der
       alte Nachweis stehen bleibt, ließe genau die Tür offen, für die man
       das Passwort gewechselt hat. Das Gerät hinterlegt bei der nächsten
       Anmeldung einen neuen; bis dahin meldet es sich klassisch an. */
    anmeldeNachweisVerwerfen(userId);
  });
  /* Auch die eigene Sitzung fällt. Das ist beabsichtigt: ein Wechsel, der
     alles Alte stehen lässt, wäre gegen genau den Fall wirkungslos, für den
     man ihn macht. Wer sein Passwort ändert, meldet sich danach neu an. */
  sitzungenEntwerten(userId, jetzt);
}

/* ── Klartext für die Anzeige ─────────────────────────────────── */

export function plainHandle(stored: string): string { return decryptField(stored); }
export function plainEmail(stored: string): string { return decryptField(stored); }
