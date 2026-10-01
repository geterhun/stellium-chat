/**
 * Prüft gegen eine frische Datenbank, ob JEDER admin-verändernde Endpunkt
 * eine Person mit genau EINEM, nicht-ownerOnly Recht daran hindert, sich auf
 * dem Umweg über ein ZIELKONTO ownerOnly-Fähigkeiten zu verschaffen.
 *
 * e2e-abdichtung.mjs beweist das schon für EINEN Fall (permission.manage
 * kann kein ownerOnly-Recht vergeben) — dieser Lauf deckt stattdessen die
 * ganze Fläche ab: /role, /reset-password, /permission, /kategorie,
 * /disabled und die Kontoerstellung, in einer Tabelle, damit der NÄCHSTE
 * admin-Endpunkt eine Zeile bekommt statt vergessen zu werden.
 *
 * DER FUND, DER DIESEN LAUF AUSGELÖST HAT (2026-08-22, seither behoben)
 * POST /api/admin/users/:id/role (http/routes.ts) verlangte nur `user.manage`
 * und blockte ausdrücklich NUR role==='owner'. role==='admin' lief
 * ungeprüft durch — und ADMIN (@stellium/shared, permissions.ts) ist ALLE
 * Rechte minus user.delete/permission.manage/channel.delete, also
 * inklusive mail.verwalten, verkauf.verwalten, fern.verwalten und
 * vertraulich.freigabe_lesen — alle vier als `ownerOnly` markiert. Eine
 * Person mit user.manage konnte ein fremdes Konto damit auf EINEN Aufruf mit
 * vier Rechten ausstatten, die sie selbst über /permission nie bekäme (dort
 * blockt setPermission() das ownerOnly-Recht einzeln — aber /role fragte
 * setPermission() nie, es setzte die Rolle direkt, und die Rollenvorgabe
 * bringt die Rechte gebündelt mit). Dieselbe Lücke betraf die Kontoerstellung
 * (POST /api/admin/users, Recht user.invite): role:'admin' beim ANLEGEN war
 * ebenso ungeprüft.
 *
 * DIE BEHEBUNG sitzt in http/routes.ts: `rolleLesen()` liest die Rolle nur
 * gegen die wirkliche Liste (ROLES), `darfRolleVergeben()` erlaubt eine Rolle
 * nur, wenn die vergebende Person JEDES ihrer Rechte selbst hat UND
 * mindestens ein eigenes Recht behält, das die Rolle nicht mitbringt (Regel
 * dort ausgeschrieben). users.setRole() selbst prüft weiterhin nichts — die
 * Funktion nimmt einen `setBy`-Parameter entgegen und verwirft ihn
 * ausdrücklich (`void setBy;`, letzte Zeile) —, der ganze Wächter sitzt an
 * der Grenze, in der Route.
 *
 * WOMIT DIESE DATEI SELBST EINMAL STEHENBLIEB, UND WAS SICH DESHALB ÄNDERT
 * Die erste Fassung dieser Datei (2026-08-22, derselbe Tag) konnte die echte
 * Route nicht direkt treffen — sie läuft gegen den Dienst, nicht über HTTP
 * (Begründung im nächsten Abschnitt) — und BILDETE darfRolleVergeben() darum
 * als eigene Kopie NACH. Noch am selben Tag zog die echte Route weiter (die
 * Regel oben), die Kopie hier blieb auf dem alten Stand stehen, und der Lauf
 * meldete zwei Fehlschläge, die es im Produkt gar nicht mehr gab — dieselbe
 * Krankheit, gegen die dieser ganze Prüflauf ursprünglich geschrieben wurde,
 * jetzt hier selbst, und mit derselben Zweischneidigkeit: eine Kopie, die
 * veraltet, kann in BEIDE Richtungen lügen — sie kann einen Fund melden, den
 * es nicht mehr gibt, und sie könnte grün bleiben, während die echte Route
 * kaputtgeht. Die Lehre daraus, umgesetzt: `darfRolleVergeben()` und
 * `rolleLesen()` sind jetzt aus http/routes.ts EXPORTIERT und werden HIER
 * importiert statt kopiert (siehe endpunktKontoAnlegen()/endpunktRolleSetzen()
 * unten) — Route und Prüfung rufen dieselbe Funktion, kein zweiter Stand kann
 * mehr auseinanderlaufen.
 *
 * DER ZWEITE FUND (2026-08-23, ebenfalls behoben)
 * Die Rollenregel schloss den Weg, sich SELBST einen Administrator zu
 * bauen — nicht den Weg über einen, den es schon gab.
 * POST /api/admin/users/:id/reset-password verlangte `user.manage` und
 * sperrte als ZIEL einzig den Inhaber; users.resetPassword() prüfte
 * überhaupt nichts. Ein Administrator, den der INHABER selbst ernannt
 * hatte, stand damit jedem user.manage-Inhaber offen: Passwort
 * zurücksetzen, Einmal-Passwort aus dem Antwortkörper nehmen, anmelden.
 * Nachgestellt gegen einen laufenden Server (Rolle 'guest' plus das
 * einzelne Recht user.manage) — die Anmeldung als Administratorin gelang.
 *
 * DIE BEHEBUNG sitzt wieder an der Grenze: `fehlendesRechtZurUebernahme()`
 * in http/routes.ts erlaubt ein Zurücksetzen nur, wenn der Aufrufende JEDES
 * WIRKSAME Recht des Zielkontos selbst hat — Punkt 2 der Rollenregel,
 * angewandt auf ein Konto statt auf eine Rolle. Punkt 3 gilt dort bewusst
 * NICHT (Begründung dort ausgeschrieben). Beide Wächter rufen denselben
 * Mengenvergleich, `erstesFehlendesRecht()`; einen zweiten gibt es nicht.
 *
 * Damit ist die letzte Kopie in dieser Datei weg. `endpunktPasswortZuruecks-
 * etzen()` unten war bis dahin die einzige, die ihre Entscheidung selbst
 * traf — ein Dreizeiler, dem genau die Verzweigung fehlte, die es damals
 * noch nicht gab. Jetzt bildet auch sie nur noch die REIHENFOLGE nach und
 * holt die Entscheidung aus der echten, importierten Funktion. Nachgebildet
 * bleiben allein die drei Owner-Vorbehalte (je zwei Zeilen, eigene
 * Fehlerkennung, seit Monaten unverändert).
 *
 * WARUM DIESE DATEI GEGEN DEN DIENST LÄUFT UND NICHT ÜBER HTTP
 * probeserver.mjs (genutzt von e2e-abdichtung.mjs/e2e-sicherheit.mjs) startet
 * `dist/index.js` und baut vorher neu, wenn `packages/server/src` oder
 * `packages/shared/src` jünger ist als der Bau (bauenWennNoetig()). Ein Bau
 * mitten in einer laufenden Änderung liefe gegen einen Zwischenstand und
 * könnte an einer fremden, vorübergehenden Inkonsistenz scheitern, nicht an
 * dem, was diese Datei prüfen soll. Ein Lauf gegen src/ über tsx (wie jede
 * Datei in diesem Ordner) braucht keinen Bau und ist sofort und wiederholt
 * lauffähig — das gilt auch für den Import von http/routes.ts selbst: tsx
 * transpiliert beim Lesen, dabei entsteht kein dist/, und nichts davon
 * registriert eine echte Route oder startet einen Server (`registerRoutes()`
 * wird hier nie aufgerufen, nur die zwei exportierten Funktionen — geprüft
 * beim Schreiben dieser Fassung: der Import allein läuft in unter einer
 * Sekunde durch, ohne Netz, ohne offenen Port).
 *
 * JEDE Zeile prüft ZWEI Richtungen: die größtmögliche Eskalation wird
 * abgewiesen, UND dieselbe Berechtigung bleibt für ihren eigentlichen,
 * nicht-eskalierenden Zweck nutzbar (Gegenprobe) — sonst bestünde eine
 * Lösung, die einfach alles verbietet, dieselbe Prüfung. Bei der
 * Kontoerstellung und /role kommt eine DRITTE Prüfung dazu: der Owner
 * befördert tatsächlich zu "admin", und das Zielkonto trägt danach wirklich
 * dessen ownerOnly-Rechte — sonst bestünde eine Prüfung, die auch dann grün
 * wäre, wenn darfRolleVergeben() ausnahmslos alles abwiese.
 *
 * Aufruf:  node scripts/rechte-eskalation-pruefen.mjs
 */
import fs from 'node:fs';
import { db, initDb } from '../db/index.js';
import * as notzugang from '../services/notzugang.js';
import * as users from '../services/users.js';
import { Abweisung, abweisung } from '../util/abweisung.js';
import { darfRolleVergeben, fehlendesRechtZurUebernahme, rolleLesen } from '../http/routes.js';
import {
  KONTO_KATEGORIEN, NOTZUGANG_ANTEILE, NOTZUGANG_SCHWELLE, PERMISSIONS, ROLES, ROLE_DEFAULTS,
  type MemberRoleName, type PermissionKey,
} from '@stellium/shared';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/** Jedes Recht, das PERMISSIONS als `ownerOnly` markiert — die Ziellinie jeder Eskalation hier. */
const OWNER_ONLY: PermissionKey[] = PERMISSIONS.filter((p) => p.ownerOnly).map((p) => p.key);
pruef('Sanity: es gibt mindestens die vier bekannten ownerOnly-Rechte', OWNER_ONLY.length >= 4, true);

/**
 * Welche ownerOnly-Rechte admin WIRKLICH mitbringt (siehe Kopfkommentar:
 * user.delete und permission.manage bleiben aussen vor, alles andere
 * ownerOnly-Recht gehört heute dazu). Die Owner-Gegenproben unten prüfen
 * gegen GENAU diese Menge, nicht gegen "irgendetwas Nichtleeres" — sonst
 * bestünde eine Prüfung, die zufällig durchkäme.
 *
 * Absichtlich KEINE feste Zahl in der Sanity-Zeile unten (anders als eine
 * frühere Fassung dieser Datei, die "genau vier" verlangte): PERMISSIONS
 * wächst — beim Schreiben dieser Zeile kam mitten im Lauf ein siebtes
 * ownerOnly-Recht dazu (`einmalcode.verwalten`), von einer anderen, zur
 * selben Zeit laufenden Änderung an @stellium/shared — und admin trug damit
 * plötzlich fünf statt vier. Dieselbe Krankheit wie im Kopfkommentar
 * beschrieben, nur diesmal in dieser Datei selbst: eine Zahl, die nicht aus
 * der Quelle kommt, sondern von Hand danebengeschrieben wurde. Die
 * Gegenproben brauchen die exakte Menge (sie kommt live aus ROLE_DEFAULTS,
 * nicht von hier) — die Sanity-Zeile braucht nur zwei ECHTE Invarianten,
 * dieselbe Bauart wie OWNER_ONLY oben (`>= 4`, keine feste Zahl).
 */
const ADMIN_OWNERONLY: PermissionKey[] = OWNER_ONLY.filter((k) => ROLE_DEFAULTS.admin.includes(k));
pruef('Sanity: admin trägt mindestens ein ownerOnly-Recht (sonst wären die Owner-Gegenproben unten wirkungslos)',
  ADMIN_OWNERONLY.length > 0, true);
pruef('Sanity: admin trägt WENIGER ownerOnly-Rechte als es insgesamt gibt (sonst wäre admin nicht von owner zu unterscheiden)',
  ADMIN_OWNERONLY.length < OWNER_ONLY.length, true);

/* ── Testkonten anlegen — roh per SQL, wie im ganzen Haus üblich ────── */

let zaehler = 0;
function neueId(praefix: string): string { zaehler += 1; return `${praefix}${zaehler}`; }

function kontoRoh(rolle: MemberRoleName, name: string): string {
  const id = neueId('u_');
  db.run(
    `INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`,
    id, id, name, 'x', rolle, Date.now(),
  );
  return id;
}

/**
 * Eine minimale `konto_notzugang`-Zeile für ein rohes Testkonto — kein
 * echter Notschlüssel, kein Anteil, nichts, was sich je öffnen ließe (dieser
 * Lauf prüft Rechte, nicht Kryptografie; die Rechnung selbst prüft
 * scripts/notzugang-pruefen.mjs). notzugang.aufheben() (services/
 * notzugang.ts) verlangt seit der Sperre gegen ein zweites, stilles
 * Niederbrennen (siehe dort) eine STEHENDE Zeile, sonst weist sie ab — ohne
 * diese Zeile hier bräche die Gegenprobe unten an einer Sperre, die mit der
 * eigentlichen Frage dieses Laufs (greifen die ZWEI RECHTE-Sperren?) nichts
 * zu tun hat. */
function notzugangRoh(userId: string): void {
  const zeit = Date.now();
  db.run(
    `INSERT INTO konto_notzugang (user_id, alg, iv, daten, konto_abdruck, konto_fassung, schwelle, anteile, erstellt_am, geaendert_am)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    userId, 'x', 'x', 'x', 'x', 1, NOTZUGANG_SCHWELLE, NOTZUGANG_ANTEILE, zeit, zeit,
  );
}

/**
 * GENAU das eine verlangte Recht zusätzlich zur Rolle 'guest' geben — per
 * SQL, nicht über setPermission(): hier wird die AUSGANGSLAGE hergestellt
 * ("ein Konto mit genau diesem einen Recht"), nicht das Vergeben selbst
 * geprüft. Letzteres ist Gegenstand der /permission-Zeile weiter unten.
 * 'guest' als Grundlage, weil GAST (permissions.ts) keines der sechs hier
 * verlangten Rechte von Haus aus mitbringt.
 */
function angreiferMit(recht: PermissionKey, name: string): string {
  const id = kontoRoh('guest', name);
  db.run(
    `INSERT INTO user_permissions (user_id, permission, allowed, set_by, set_at) VALUES (?,?,1,'test',?)`,
    id, recht, Date.now(),
  );
  return id;
}

/**
 * Gegenprobe zur Ausgangslage selbst: wirklich nur das eine Recht, kein
 * WEITERES ownerOnly-Recht dazu. `recht` selbst ausgenommen: permission.manage
 * ist für die /permission-Zeile GENAU das verlangte Recht und steht
 * gleichzeitig selbst in OWNER_ONLY (siehe PERMISSIONS in
 * @stellium/shared) — das ist die Ausgangslage, die diese Zeile bewusst
 * prüft, kein Zuviel.
 */
function pruefeAusgangslage(zeile: string, angreiferId: string, recht: PermissionKey): void {
  pruef(`${zeile}: das Testkonto hat GENAU das verlangte Recht (${recht})`, users.may(angreiferId, recht), true);
  const zuViel = OWNER_ONLY.filter((k) => k !== recht && users.may(angreiferId, k));
  pruef(`${zeile}: das Testkonto hat KEIN WEITERES ownerOnly-Recht`, zuViel, []);
}

/** Welche ownerOnly-Rechte trägt dieses Konto JETZT — die Eskalations-Kennzahl schlechthin. */
function ownerOnlyRechteVon(userId: string | null): PermissionKey[] {
  if (!userId) return [];
  return OWNER_ONLY.filter((k) => users.may(userId, k));
}

/**
 * routes.ts, POST /api/admin/users — nur die REIHENFOLGE der Prüfungen ist
 * hier nachgebildet (unbekannte Rolle -> Owner-Vorbehalt für role:'owner' ->
 * darfRolleVergeben()); die ESKALATIONS-Entscheidung selbst kommt aus
 * rolleLesen()/darfRolleVergeben(), importiert aus http/routes.ts, nicht
 * kopiert. Der Owner-Vorbehalt (zwei Zeilen, eigene Fehlerkennung, ändert
 * sich seit Monaten nicht) bleibt eine Nachbildung — dieselbe, bewusst kleine
 * Abweichung wie bei endpunktPasswortZuruecksetzen() weiter unten.
 */
function endpunktKontoAnlegen(byId: string, rolleRoh: unknown): string {
  const rolle = rolleRoh === undefined ? 'member' : rolleLesen(rolleRoh);
  if (!rolle) {
    throw abweisung('fehler.rolleUnbekannt', `Unbekannte Rolle „${String(rolleRoh)}".`);
  }
  const anfragend = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', byId);
  if (rolle === 'owner' && anfragend?.role !== 'owner') {
    throw abweisung('fehler.nurOwnerErnennt', 'Nur der Owner kann einen weiteren Owner ernennen.');
  }
  if (!darfRolleVergeben(byId, rolle)) {
    throw abweisung('fehler.rolleZuHoch', 'Die Rolle kannst du nicht vergeben.');
  }
  return users.createAccount({ displayName: 'Frisch Eskaliert', role: rolle, createdBy: byId }).userId;
}

/**
 * routes.ts, POST /api/admin/users/:id/reset-password — dieselbe Bauart wie
 * die beiden Nachbildungen oben: nur die REIHENFOLGE steht hier (Owner-
 * Vorbehalt -> Übernahme-Regel), die ESKALATIONS-Entscheidung kommt aus
 * `fehlendesRechtZurUebernahme()`, importiert aus http/routes.ts.
 *
 * Bis zum 2026-08-23 war das hier die LETZTE echte Kopie in dieser Datei —
 * ein Dreizeiler, der nur den Owner-Vorbehalt kannte, weil die Route auch
 * nichts anderes kannte. Mit dem Wächter, der jetzt dort steht, gilt für
 * ihn dasselbe Argument wie für die Rollenregel im Kopfkommentar: eine
 * Kopie mit Verzweigungen läuft irgendwann auseinander. Damit ruft jede
 * Zeile dieser Datei, die eine Eskalation entscheidet, die echte Funktion —
 * es gibt keinen zweiten Stand mehr, der veralten könnte. Nachgebildet
 * bleibt allein der Owner-Vorbehalt (zwei Zeilen, eigene Fehlerkennung,
 * seit Monaten unverändert), genau wie bei den beiden Rollen-Endpunkten.
 */
function endpunktPasswortZuruecksetzen(byId: string, targetId: string): string {
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', targetId);
  if (ziel?.role === 'owner' && targetId !== byId) {
    throw abweisung('fehler.ownerPasswortSelbst', 'Das Passwort des Owners kann nur er selbst zurücksetzen.');
  }
  const fehlt = fehlendesRechtZurUebernahme(byId, targetId);
  if (fehlt) {
    throw abweisung('fehler.keinRechtName', `Dafür fehlt dir das Recht "${fehlt}".`, { recht: fehlt });
  }
  return users.resetPassword(targetId, byId);
}

/**
 * routes.ts, DELETE /api/admin/notzugang/:id — die ZWEITE Tür in denselben
 * Raum, und bis eben stand sie ohne Schloss.
 *
 * WAS DER GRIFF TUT. Er zerstört die Rettungsleine eines fremden Kontos
 * („3 von 5", services/notzugang.ts) und brennt dabei — seit derselben
 * Fassung — den Kontoschlüssel gleich mit nieder, sobald keine Passworthülle
 * mehr dasteht. Er ÖFFNET nichts, und genau das war jahrelang die
 * Begründung dafür, dass `user.manage` allein genügte.
 *
 * WARUM DIE BEGRÜNDUNG NICHT TRÄGT. Der Nachbarendpunkt
 * (/reset-password) hütet dieselbe Sache mit ZWEI Sperren: der Owner setzt
 * sein Passwort nur selbst zurück, und übernehmen darf nur, wer jedes Recht
 * des Ziels ohnehin schon hat. Hier gab es keine davon. Damit konnte ein
 * Konto mit `user.manage` und sonst Gastrechten — dasselbe Konto, das die
 * Übernahme-Regel bei /reset-password ausdrücklich abweist — die
 * Rettungsleine JEDER Person kappen, auch die des Inhabers. Es kam damit an
 * keine einzige fremde Notiz; es machte aber aus dem nächsten, gewöhnlichen
 * Zurücksetzen die vollständige Vernichtung von Notizen und Tresor, und die
 * betroffene Person erfuhr davon nichts.
 *
 * Nachgebildet ist hier — wie bei den Nachbarn — nur die REIHENFOLGE
 * (Konto vorhanden -> Owner-Vorbehalt -> Übernahme-Regel). Die Entscheidung
 * kommt aus dem echten, importierten `fehlendesRechtZurUebernahme()`.
 */
function endpunktNotzugangAufheben(byId: string, targetId: string): void {
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', targetId);
  if (!ziel) throw abweisung('fehler.kontoNichtGefunden', 'Konto nicht gefunden');
  if (ziel.role === 'owner' && targetId !== byId) {
    throw abweisung('fehler.ownerNotzugangSelbst', 'Den Notzugang des Owners kann nur er selbst aufheben.');
  }
  const fehlt = fehlendesRechtZurUebernahme(byId, targetId);
  if (fehlt) {
    throw abweisung('fehler.keinRechtName', `Dafür fehlt dir das Recht "${fehlt}".`, { recht: fehlt });
  }
  notzugang.aufheben(targetId, byId);
}

/**
 * routes.ts, POST /api/admin/users/:id/role — dieselbe Nachbildung wie bei
 * endpunktKontoAnlegen() oben, mit dem zusätzlichen Vorbehalt gegen die
 * eigene Rolle. Die Entscheidung kommt aus rolleLesen()/darfRolleVergeben(),
 * importiert, nicht kopiert.
 */
function endpunktRolleSetzen(byId: string, targetId: string, rolleRoh: unknown): void {
  const rolle = rolleLesen(rolleRoh);
  if (!rolle) {
    throw abweisung('fehler.rolleUnbekannt', `Unbekannte Rolle „${String(rolleRoh)}".`);
  }
  const anfragend = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', byId);
  if (rolle === 'owner' && anfragend?.role !== 'owner') {
    throw abweisung('fehler.nurOwnerRolle', 'Nur der Owner kann diese Rolle vergeben.');
  }
  if (targetId === byId) throw abweisung('fehler.eigeneRolle', 'Die eigene Rolle lässt sich nicht ändern.');
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', targetId);
  if (ziel?.role === 'owner' && anfragend?.role !== 'owner') {
    throw abweisung('fehler.ownerRechte', 'Dem Owner lassen sich keine Rechte nehmen.');
  }
  if (!darfRolleVergeben(byId, rolle)) {
    throw abweisung('fehler.rolleZuHoch', 'Die Rolle kannst du nicht vergeben.');
  }
  users.setRole(targetId, rolle, byId);
}

/**
 * routes.ts, POST /.../kategorie — kein eigener Dienst in services/users.ts;
 * die Route schreibt direkt gegen die Tabelle. Nachgebildet inklusive der
 * geschlossenen Aufzählung (KONTO_KATEGORIEN) und der Sperre für schon
 * gelöschte Konten.
 */
function endpunktKategorieSetzen(targetId: string, wert: string | null): void {
  if (wert && !KONTO_KATEGORIEN.includes(wert as never)) {
    throw abweisung('fehler.kategorieUnbekannt', `Unbekannte Kategorie "${wert}".`);
  }
  const ziel = db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM users WHERE id = ?', targetId);
  if (ziel?.deleted_at) throw abweisung('fehler.geloeschtEinsortieren', 'Gelöschte Konten lassen sich nicht einsortieren.');
  db.run('UPDATE users SET kategorie = ? WHERE id = ?', wert, targetId);
}

const versucht = (fn: () => void): string | null => {
  try { fn(); return null; } catch (err) { return err instanceof Abweisung ? err.code : 'unbekannt'; }
};

/* ── Die sechs Zeilen ─────────────────────────────────────────────── */

function zeileKontoAnlegen(): void {
  const angreifer = angreiferMit('user.invite', 'Angreifer Einladung');
  pruefeAusgangslage('Konto anlegen', angreifer, 'user.invite');

  /* Der eigentliche Fund: role:'admin' lief früher ungeprüft durch (siehe
     Kopfkommentar). Die Entscheidung kommt jetzt aus dem echten, importierten
     darfRolleVergeben() — kein Konto darf dabei überhaupt erst entstehen. */
  let neuesKontoId: string | null = null;
  const code = versucht(() => { neuesKontoId = endpunktKontoAnlegen(angreifer, 'admin'); });
  pruef('ein role:"admin"-Konto anzulegen wird einem user.invite-Inhaber verweigert', code, 'fehler.rolleZuHoch');
  pruef('...es entsteht dabei tatsächlich gar kein Konto', neuesKontoId, null);
  pruef('...keine ownerOnly-Rechte erbeutet', ownerOnlyRechteVon(neuesKontoId), []);

  // Ein unbekannter Rollenstring darf ebenso wenig durch: rolleLesen() (echt,
  // importiert) muss ihn schon vor darfRolleVergeben() abfangen.
  const unbekanntCode = versucht(() => { endpunktKontoAnlegen(angreifer, 'erzbischof'); });
  pruef('ein unbekannter Rollenstring beim Anlegen wird abgewiesen', unbekanntCode, 'fehler.rolleUnbekannt');

  /* Gegenprobe: dieselbe Person legt ein Konto an — der eigentliche Zweck
     des Rechts. NICHT role:"member": darfRolleVergeben() verlangt JEDES
     Recht der Zielrolle selbst (Punkt 2 der Regel, Kopfkommentar), und
     dieser Angreifer trägt — mit Absicht, siehe pruefeAusgangslage() — nur
     GAST-Rechte plus user.invite. MITGLIED bräuchte u. a. file.upload,
     channel.create, dm.start, die hier fehlen (nachgemessen: 16 Rechte
     Unterschied). role:"guest" ist die reale, für DIESEN Angreifer
     erreichbare Grenze seines Rechts — und beweist genau das, was diese
     Gegenprobe zeigen soll: das Recht ist nicht wertlos, nur nicht
     grenzenlos. Ein Angreifer mit den MITGLIED-Rechten einer echten Rolle
     wie 'teamlead' KÖNNTE "member" vergeben (nachgemessen, siehe unten,
     Owner-Gegenprobe zu "admin" folgt demselben Muster) — dieser hier,
     bewusst minimal gehalten, kann es nicht, und das ist keine Lücke. */
  let gegenprobeId: string | null = null;
  const gegenprobeCode = versucht(() => { gegenprobeId = endpunktKontoAnlegen(angreifer, 'guest'); });
  pruef('Gegenprobe: dieselbe Person legt ein Konto mit role:"guest" an — das muss gelingen', gegenprobeCode, null);
  pruef('...das Konto ist wirklich entstanden', gegenprobeId !== null, true);

  /* Die dritte Prüfung aus dem Kopfkommentar: ohne sie bestünde diese Zeile
     auch dann, wenn darfRolleVergeben() ausnahmslos ALLES abwiese. Der Owner
     legt ein role:"admin"-Konto an — muss gelingen, mit genau den
     ownerOnly-Rechten, die admin zustehen (ADMIN_OWNERONLY oben — keine
     feste Zahl, siehe deren Kommentar). */
  const owner = kontoRoh('owner', 'Owner Konto Anlegen');
  let ownerKontoId: string | null = null;
  const ownerCode = versucht(() => { ownerKontoId = endpunktKontoAnlegen(owner, 'admin'); });
  pruef('Gegenprobe: der Owner legt ein role:"admin"-Konto an — muss gelingen', ownerCode, null);
  pruef('...das Konto trägt jetzt wirklich die ownerOnly-Rechte von admin',
    ownerOnlyRechteVon(ownerKontoId), ADMIN_OWNERONLY);
}

function zeilePasswortZuruecksetzen(): void {
  const angreifer = angreiferMit('user.manage', 'Angreifer Passwort');
  pruefeAusgangslage('Passwort zurücksetzen', angreifer, 'user.manage');
  const owner = kontoRoh('owner', 'Probe-Owner Passwort');

  const code = versucht(() => { void endpunktPasswortZuruecksetzen(angreifer /* byId */, owner /* targetId */); });
  pruef('das Owner-Passwort bleibt vor einem user.manage-Inhaber verschlossen', code !== null, true);
  pruef('...mit der Kennung aus routes.ts', code, 'fehler.ownerPasswortSelbst');

  /* Gegenprobe: ein Konto INNERHALB der eigenen Reichweite lässt sich
     zurücksetzen — der eigentliche Zweck des Rechts. NICHT mehr 'member',
     wie bis zum 2026-08-23: die Übernahme-Regel verlangt JEDES Recht des
     Ziels, und dieser Angreifer trägt — mit Absicht, siehe
     pruefeAusgangslage() — nur GAST-Rechte plus user.manage. Es ist
     dieselbe Verschiebung, die zeileRolleSetzen() schon hinter sich hat
     ("member" -> "guest"), aus demselben Grund und mit derselben Aussage:
     das Recht ist nicht wertlos, nur nicht grenzenlos. Eine echte Rolle wie
     'teamlead' trägt MITGLIED vollständig und könnte ein Mitglied sehr wohl
     zurücksetzen — nachgemessen unten in zeileUebernahmeGrenzen(). */
  const ziel = kontoRoh('guest', 'Ziel Passwort');
  const gegenprobeCode = versucht(() => { void endpunktPasswortZuruecksetzen(angreifer, ziel); });
  pruef('Gegenprobe: dasselbe Konto setzt das Passwort eines guest-Kontos zurück (dessen Rechte es ganz hat) — muss gelingen',
    gegenprobeCode, null);

  /* DIE ZWEITE TÜR IN DENSELBEN RAUM — und was diese Zeile früher behauptete.
   *
   * Der ursprüngliche Fund (Kopfkommentar oben) war eine KETTE aus zwei
   * Schritten: ein fremdes Konto zu admin machen, DANACH dessen Passwort
   * zurücksetzen (die Antwort trägt das neue Einmal-Passwort im Klartext),
   * anmelden. Schritt 1 ging am 2026-08-22 zu — siehe zeileRolleSetzen()/
   * zeileKontoAnlegen(), beide über das echte darfRolleVergeben().
   *
   * Schritt 2 blieb offen, und genau das stand bis zum 2026-08-23 HIER als
   * bestandene Prüfung: „ein user.manage-Inhaber kann auch das Passwort
   * eines BEREITS bestehenden admin-Kontos zurücksetzen (heutiges
   * Verhalten, keine eigene Sperre in reset-password)". Die Zeile war
   * ehrlich gemeint — sie wollte festhalten, WAS passiert, damit es sich
   * nicht unbemerkt ändert — aber sie hielt eine Lücke als Zusage fest.
   * Nachgestellt gegen einen laufenden Server: ein Konto mit Rolle 'guest'
   * und dem einzelnen Recht user.manage setzte das Passwort einer vom
   * INHABER ernannten Administratorin zurück, bekam das Einmal-Passwort und
   * meldete sich damit als sie an. Der Angreifer musste niemanden
   * befördern; er nahm einen, den es schon gab.
   *
   * Seit dem 2026-08-23 gilt für das Übernehmen dieselbe Regel wie fürs
   * Vergeben: nur wer JEDES Recht des Zielkontos selbst hat, darf dessen
   * Passwort zurücksetzen (fehlendesRechtZurUebernahme(), http/routes.ts,
   * Begründung dort ausgeschrieben). Diese Zeile prüft jetzt das Gegenteil
   * von dem, was sie vorher prüfte — mit Absicht: eine Prüfung, die eine
   * Schwachstelle als erwartetes Verhalten festschreibt, darf nicht still
   * grün bleiben, wenn die Schwachstelle geschlossen wird.
   *
   * Unverändert wahr bleibt, wohin das Einmal-Passwort ginge, WENN es
   * herausginge: nur in den synchronen Antwortkörper an genau die
   * aufrufende Person. Kein broadcastAll() begleitet diesen Aufruf (anders
   * als bei /role, /disabled und der Kontoerstellung), und selbst dort
   * trägt die `user:upsert`-Nutzlast (toUser(), services/store.ts) kein
   * Passwortfeld. Es gibt keine zweite Empfängerin — die Abwehr muss also
   * genau dort sitzen, wo sie jetzt sitzt: am Aufruf.
   */
  const bestehenderAdmin = kontoRoh('admin', 'Bestehender Admin Passwort');
  const hashVorher = db.get<{ h: string }>('SELECT password_hash AS h FROM users WHERE id = ?', bestehenderAdmin)?.h;
  let otp: string | null = null;
  const adminCode = versucht(() => { otp = endpunktPasswortZuruecksetzen(angreifer, bestehenderAdmin); });
  pruef('das Passwort eines BEREITS bestehenden admin-Kontos bleibt vor einem user.manage-Inhaber verschlossen',
    adminCode, 'fehler.keinRechtName');
  /* `typeof otp` statt `otp !== null` mit Längenprüfung: otp wird nur
     INNERHALB der Closure oben gesetzt, und TypeScript verfolgt Zuweisungen
     in Closures nicht über den Aufruf von versucht() hinweg — jede
     Prüfung, die danach noch auf otp zugreift, säbe für den Compiler wie
     der Anfangswert `null` aus (nachgewiesen: dieselbe Konstruktion mit
     `otp !== null && otp.length` scheitert genauso an `tsc --noEmit`, mit
     `never`). `typeof` selbst braucht keine Narrowing und bleibt exakt. */
  pruef('...es kommt kein Einmal-Passwort zurück', typeof otp, 'object');
  /* Und das Konto ist wirklich unangetastet — ohne diese Zeile bestünde die
     Prüfung auch dann, wenn das Passwort erst gewechselt und die Abweisung
     hinterher geworfen würde. */
  pruef('...das Passwort des Administrators steht unverändert da',
    db.get<{ h: string }>('SELECT password_hash AS h FROM users WHERE id = ?', bestehenderAdmin)?.h === hashVorher,
    true);
}

/**
 * Die vier Grenzfälle der Übernahme-Regel, die sich nicht aus der Tabelle
 * oben ergeben — jeder einzeln, weil jeder einzeln kaputtgehen kann.
 *
 * Die ersten beiden prüfen, dass die Regel OHNE Sonderfälle auskommt (siehe
 * fehlendesRechtZurUebernahme(), http/routes.ts): Owner und Selbstbedienung
 * fallen aus dem Mengenvergleich heraus, sie stehen nicht als `if` darin.
 * Ohne diese Zeilen könnte jemand die Sonderfälle nachträglich einbauen —
 * oder, schlimmer, die Regel so verschärfen, dass beide brechen, und es
 * fiele niemandem auf.
 */
function zeileUebernahmeGrenzen(): void {
  const owner = kontoRoh('owner', 'Owner Übernahme');
  const admin = kontoRoh('admin', 'Admin Übernahme');

  pruef('Der Owner darf jedes Konto übernehmen — ohne eigenen Sonderfall, allein weil er jedes Recht hat',
    fehlendesRechtZurUebernahme(owner, admin), null);

  const gastMitVerwaltung = angreiferMit('user.manage', 'Selbstbedienung');
  pruef('Das EIGENE Passwort bleibt erreichbar — jede Menge enthält sich selbst',
    fehlendesRechtZurUebernahme(gastMitVerwaltung, gastMitVerwaltung), null);
  pruef('...auch für den Owner', fehlendesRechtZurUebernahme(owner, owner), null);

  /* Punkt 3 gilt hier NICHT (Begründung in http/routes.ts): zwei
     Administratoren haben dieselben Rechte, und keiner gewinnt durch den
     anderen etwas dazu. Diese Zeile hält die Entscheidung fest — wer sie
     einmal umdreht, ändert sie bewusst und nicht im Vorbeigehen. */
  const zweiterAdmin = kontoRoh('admin', 'Zweiter Admin Übernahme');
  pruef('Ein Administrator DARF einen anderen Administrator übernehmen (Punkt 3 gilt fürs Vergeben, nicht fürs Übernehmen)',
    fehlendesRechtZurUebernahme(admin, zweiterAdmin), null);

  /* Die WIRKSAMEN Rechte zählen, nicht die Rollenvorgabe. Bekommt ein
     Administrator vom Owner einzeln ein ownerOnly-Recht dazu, ist er für
     seine Kollegen unerreichbar — sonst wäre die persönliche Ausnahme über
     das Zurücksetzen wieder einzusammeln. */
  const adminMitExtra = kontoRoh('admin', 'Admin mit Zusatzrecht');
  const extra: PermissionKey = 'permission.manage';
  db.run(
    `INSERT INTO user_permissions (user_id, permission, allowed, set_by, set_at) VALUES (?,?,1,'test',?)`,
    adminMitExtra, extra, Date.now(),
  );
  pruef(`Sanity: das Zusatzrecht sitzt wirklich (${extra})`, users.may(adminMitExtra, extra), true);
  pruef('...und der gewöhnliche Administrator hat es NICHT', users.may(admin, extra), false);
  pruef('Ein Administrator mit einzeln vergebenem ownerOnly-Recht ist für andere Administratoren unerreichbar',
    fehlendesRechtZurUebernahme(admin, adminMitExtra), extra);
  pruef('...der Owner erreicht ihn weiterhin', fehlendesRechtZurUebernahme(owner, adminMitExtra), null);

  /* Und die Gegenrichtung, damit die Zeile oben nicht bloß „irgendwas ist
     verboten" misst: nach UNTEN reicht dieselbe Person weiterhin. */
  pruef('Der Administrator mit Zusatzrecht erreicht den gewöhnlichen Administrator',
    fehlendesRechtZurUebernahme(adminMitExtra, admin), null);

  /* Eine echte Rolle, kein Kunstkonto: teamlead trägt MITGLIED vollständig
     und darf ein Mitglied zurücksetzen — genau das, was die Rolle zusagt
     ("Nimmt neue Leute auf und setzt Passwörter zurück", permissions.ts).
     Ohne diese Zeile bestünde die ganze Regel auch dann, wenn sie im Alltag
     nichts als Absagen erteilte. */
  const teamleitung = kontoRoh('teamlead', 'Teamleitung Übernahme');
  const mitglied = kontoRoh('member', 'Mitglied Übernahme');
  pruef('Eine Teamleitung darf das Passwort eines Mitglieds zurücksetzen — der zugesagte Zweck der Rolle',
    fehlendesRechtZurUebernahme(teamleitung, mitglied), null);
  pruef('...aber nicht das eines Administrators',
    fehlendesRechtZurUebernahme(teamleitung, admin) !== null, true);
}

/**
 * setRole() prüft die Rolle gegen ROLES und nicht mehr gegen eine
 * abgeschriebene Vierer-Liste (Begründung dort, services/users.ts).
 *
 * Die sechs Rollen, die dadurch neu erreichbar werden, sind genau die, die
 * darfRolleVergeben() nun mitdecken muss. Diese Zeile rechnet nach, dass
 * dabei keine Tür aufgeht: keine von ihnen bringt ein ownerOnly-Recht mit,
 * und der Wächter weist sie einem Angreifer trotzdem einzeln ab.
 */
function zeileRollenlisteVollstaendig(): void {
  const alle = ROLES.map((r) => r.name);
  pruef('ROLES kennt mehr als die vier Rollen der alten Liste', alle.length > 4, true);

  const frueherAbgewiesen: MemberRoleName[] = ['moderator', 'technik', 'teamlead', 'contributor', 'readonly', 'bot'];
  for (const rolle of frueherAbgewiesen) {
    const ziel = kontoRoh('member', `Ziel ${rolle}`);
    const code = versucht(() => users.setRole(ziel, rolle, 'test'));
    pruef(`setRole() nimmt "${rolle}" jetzt an (vorher: fehler.rolleUnbekannt)`, code, null);
    pruef(`...und die Rolle steht wirklich in der Zeile`,
      db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', ziel)?.role, rolle);
  }

  // Was keine Rolle ist, bleibt abgewiesen — sonst hätte die Öffnung alles geöffnet.
  const zielUnsinn = kontoRoh('member', 'Ziel Unsinn');
  pruef('setRole() weist einen unbekannten Rollennamen weiterhin ab',
    versucht(() => users.setRole(zielUnsinn, 'erzbischof' as MemberRoleName, 'test')), 'fehler.rolleUnbekannt');

  /* KEINE der neu erreichbaren Rollen trägt ein ownerOnly-Recht — sonst
     hätte die Öffnung dem Wächter neue Arbeit gemacht, die er nicht kennt. */
  const mitOwnerOnly = frueherAbgewiesen.filter(
    (r) => (ROLE_DEFAULTS[r] ?? []).some((k) => OWNER_ONLY.includes(k)),
  );
  pruef('keine der neu erreichbaren Rollen bringt ein ownerOnly-Recht mit', mitOwnerOnly, []);

  /* Und der Wächter greift auch bei den sechs neuen — aber NICHT indem er
     stumpf alles abweist. Genau das war der erste Anlauf dieser Zeile:
     „weist jede der sechs ab", und sie fiel durch, weil `readonly` (ein
     einziges Recht, `ai.translate`) für einen GAST-Angreifer erreichbar ist.
     Das ist keine Lücke, sondern eine HERABSTUFUNG: die Rolle liegt echt
     unter dem, was der Angreifer selbst hat, und genau solche Rollen soll
     user.manage vergeben dürfen. Eine Prüfung, die hier „alles verboten"
     verlangt hätte, hätte das Recht für wertlos erklärt — und wäre auch
     dann grün geblieben, wenn darfRolleVergeben() ausnahmslos alles
     abwiese, dieselbe Falle wie bei den Gegenproben oben.

     Gemessen wird deshalb die Zusage selbst: was durchkommt, darf dem Ziel
     KEIN Recht bringen, das der Vergebende nicht schon hat. */
  const angreifer = angreiferMit('user.manage', 'Angreifer Rollenliste');
  const eigeneRechte = users.permissionsFor(angreifer);
  const durchgelassen = frueherAbgewiesen.filter((r) => darfRolleVergeben(angreifer, r));
  const erbeutbar = durchgelassen.flatMap(
    (r) => (ROLE_DEFAULTS[r] ?? []).filter((k) => eigeneRechte[k] !== true),
  );
  pruef('keine der Rollen, die ein user.manage-Inhaber vergeben darf, bringt dem Ziel ein Recht, das er selbst nicht hat',
    erbeutbar, []);

  /* Und die Gegenrichtung, damit die Zeile oben nicht leerläuft: die fünf
     Rollen, die über die Reichweite dieses Angreifers hinausgehen, kommen
     WIRKLICH nicht durch — sonst könnte `durchgelassen` leer sein und die
     Prüfung bestünde, ohne etwas gesehen zu haben. */
  pruef('...die fünf Rollen oberhalb seiner Reichweite werden abgewiesen',
    frueherAbgewiesen.filter((r) => !darfRolleVergeben(angreifer, r)),
    ['moderator', 'technik', 'teamlead', 'contributor', 'bot']);
  pruef('...und mindestens eine der sechs ist für ihn erreichbar (sonst misst die Zeile darüber nichts)',
    durchgelassen.length > 0, true);
}

function zeileRolleSetzen(): void {
  const angreifer = angreiferMit('user.manage', 'Angreifer Rolle');
  pruefeAusgangslage('Rolle ändern', angreifer, 'user.manage');
  const ziel = kontoRoh('member', 'Ziel Rolle');

  /* Der eigentliche Fund: role:'admin' lief früher durch beide Wächter
     (routes.ts UND users.setRole()) unbehelligt hindurch — siehe
     Kopfkommentar. Die Entscheidung kommt jetzt aus dem echten, importierten
     darfRolleVergeben(). */
  const code = versucht(() => endpunktRolleSetzen(angreifer, ziel, 'admin'));
  pruef('Rolle "admin" durch einen user.manage-Inhaber wird abgewiesen', code, 'fehler.rolleZuHoch');
  const erbeutet = ownerOnlyRechteVon(ziel);
  pruef('...keine ownerOnly-Rechte erbeutet', erbeutet, []);
  if (erbeutet.length) {
    console.log(`      → das beförderte Konto trägt jetzt: ${erbeutet.join(', ')}`);
  }

  // Ein unbekannter Rollenstring darf ebenso wenig durch — rolleLesen()
  // (echt, importiert) muss ihn schon vor darfRolleVergeben() abfangen.
  const zielUnbekannt = kontoRoh('member', 'Ziel Rolle Unbekannt');
  const unbekanntCode = versucht(() => endpunktRolleSetzen(angreifer, zielUnbekannt, 'erzbischof'));
  pruef('ein unbekannter Rollenstring wird abgewiesen', unbekanntCode, 'fehler.rolleUnbekannt');
  pruef('...die Rolle des Ziels bleibt dabei unverändert',
    db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', zielUnbekannt)?.role, 'member');

  /* Gegenprobe: dieselbe Person ändert eine Rolle NICHT eskalierend — muss
     gelingen. NICHT "befördert zu member": darfRolleVergeben() verlangt
     JEDES Recht der Zielrolle selbst (Punkt 2 der Regel, Kopfkommentar), und
     dieser Angreifer trägt — mit Absicht, siehe pruefeAusgangslage() — nur
     GAST-Rechte plus user.manage. MITGLIED bräuchte u. a. file.upload,
     channel.create, dm.start, die hier fehlen (nachgemessen: 16 Rechte
     Unterschied). "member" WAR hier die Gegenprobe, solange der Wächter
     nichts außer role==='owner' kannte (siehe Kopfkommentar) — unter der
     echten Regel ist sie das nicht mehr, und das ist keine Lücke, sondern
     GENAU die Regel: user.manage ALLEIN reicht nicht, um jemanden auf ein
     Rechteniveau zu heben, das der Vergebende selbst nicht hat (eine echte
     Rolle wie 'teamlead' trägt MITGLIED komplett und KÖNNTE "member"
     vergeben — nachgemessen, aber nicht Gegenstand dieser Zeile, die bei
     einem bewusst minimalen Angreifer bleibt). Erreichbar bleibt "guest":
     das Ziel startet bewusst höher, bei 'member', damit die Änderung echt
     ist und keine Identität — und "guest" bleibt innerhalb der vier Werte,
     die users.setRole() zur Laufzeit kennt. Beiläufiger Fund beim
     Schreiben dieser Zeile, nicht Gegenstand dieser Prüfung: users.setRole()
     nimmt laut Typ jede MemberRoleName an, weist zur Laufzeit aber nur
     'owner'|'admin'|'member'|'guest' nicht ab ("fehler.rolleUnbekannt" für
     'moderator', 'teamlead' & Co.) — Typ und Laufzeit-Aufzählung sind
     auseinandergelaufen. */
  const zielGegenprobe = kontoRoh('member', 'Ziel Rolle Gegenprobe');
  const gegenprobeCode = versucht(() => endpunktRolleSetzen(angreifer, zielGegenprobe, 'guest'));
  pruef('Gegenprobe: dieselbe Person setzt "guest" (keine ownerOnly-Rechte darin, innerhalb der eigenen Reichweite) — muss gelingen',
    gegenprobeCode, null);
  pruef('...die Rolle ist wirklich angekommen',
    db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', zielGegenprobe)?.role, 'guest');

  /* Die dritte Prüfung aus dem Kopfkommentar: ohne sie bestünde diese Zeile
     auch dann, wenn darfRolleVergeben() ausnahmslos ALLES abwiese. Der Owner
     befördert zu "admin" — muss gelingen, mit genau den ownerOnly-Rechten,
     die admin zustehen (ADMIN_OWNERONLY oben — keine feste Zahl). */
  const owner = kontoRoh('owner', 'Owner Rolle');
  const zielOwnerBefoerdert = kontoRoh('member', 'Ziel Rolle Owner');
  const ownerCode = versucht(() => endpunktRolleSetzen(owner, zielOwnerBefoerdert, 'admin'));
  pruef('Gegenprobe: der Owner befördert zu "admin" — muss gelingen', ownerCode, null);
  pruef('...das Konto trägt jetzt wirklich die ownerOnly-Rechte von admin',
    ownerOnlyRechteVon(zielOwnerBefoerdert), ADMIN_OWNERONLY);
}

function zeilePermissionSetzen(): void {
  const angreifer = angreiferMit('permission.manage', 'Angreifer Recht');
  pruefeAusgangslage('Recht vergeben', angreifer, 'permission.manage');
  const ziel = kontoRoh('member', 'Ziel Recht');

  /* Hier sitzt die Bremse schon im Dienst selbst (setPermission() prüft
     permissionInfo(permission)?.ownerOnly gegen die Rolle von setBy) —
     dieselbe Zusage, die e2e-abdichtung.mjs schon über HTTP beweist, hier
     als Baustein dieser Tabelle, ohne Server. */
  const code = versucht(() => users.setPermission(ziel, 'user.delete', true, angreifer));
  pruef('ein ownerOnly-Recht ("user.delete") wird einem permission.manage-Inhaber verweigert', code !== null, true);
  pruef('...mit der Kennung aus setPermission()', code, 'fehler.nurOwnerRecht');
  pruef('...und das Zielkonto hat das Recht tatsächlich nicht erhalten', users.may(ziel, 'user.delete'), false);

  // Gegenprobe: ein gewöhnliches Recht bleibt vergebbar — der eigentliche Zweck des Rechts.
  const gegenprobeCode = versucht(() => users.setPermission(ziel, 'message.pin', false, angreifer));
  pruef('Gegenprobe: dasselbe Konto setzt das gewöhnliche Recht "message.pin" — muss gelingen', gegenprobeCode, null);
  pruef('...die Änderung ist wirklich angekommen', users.may(ziel, 'message.pin'), false);
}

function zeileKategorieSetzen(): void {
  const angreifer = angreiferMit('user.manage', 'Angreifer Kategorie');
  pruefeAusgangslage('Kategorie setzen', angreifer, 'user.manage');
  const ziel = kontoRoh('member', 'Ziel Kategorie');

  /* Sonderfall in dieser Tabelle: kategorie trägt KEIN Recht und keine
     serverseitig durchgesetzte Wirkung (toUser().technisch in
     services/store.ts ist eine reine Oberflächen-Markierung) — anders als
     die übrigen fünf Zeilen gibt es hier keine ownerOnly-Eskalation zu
     verhindern. Diese Zeile steht trotzdem in der Tabelle und bekommt
     dieselbe Prüfform wie jede andere Grenze hier: die EINE tatsächliche
     Grenze dieses Endpunkts ist seine geschlossene Aufzählung. Das ist
     Vollständigkeit um der Konstruktion willen, kein zweiter Fund — und die
     Vorlage für den Tag, an dem kategorie doch einmal an etwas Wirksames
     gekoppelt wird. */
  const code = versucht(() => endpunktKategorieSetzen(ziel, 'nicht-in-der-liste'));
  pruef('ein Wert außerhalb von KONTO_KATEGORIEN wird abgewiesen', code, 'fehler.kategorieUnbekannt');
  pruef('...die Spalte bleibt dabei unverändert (NULL)',
    db.get<{ k: string | null }>('SELECT kategorie AS k FROM users WHERE id = ?', ziel)?.k ?? null, null);

  // Gegenprobe: ein gültiger Wert aus derselben Aufzählung wird übernommen.
  const gegenprobeCode = versucht(() => endpunktKategorieSetzen(ziel, 'leitung'));
  pruef('Gegenprobe: derselbe Angreifer setzt eine GÜLTIGE Kategorie — muss gelingen', gegenprobeCode, null);
  pruef('...und die Spalte trägt jetzt den neuen Wert',
    db.get<{ k: string }>('SELECT kategorie AS k FROM users WHERE id = ?', ziel)?.k, 'leitung');
}

function zeileDisabledSetzen(): void {
  const angreifer = angreiferMit('user.manage', 'Angreifer Sperren');
  pruefeAusgangslage('Konto sperren', angreifer, 'user.manage');
  const owner = kontoRoh('owner', 'Probe-Owner Sperren');

  /* Einzige Zeile, in der der Wächter schon im Dienst selbst sitzt
     (setDisabled() prüft role==='owner' selbst) — routes.ts fügt hier
     nichts hinzu, keine Nachbildung nötig. */
  const code = versucht(() => users.setDisabled(owner, true));
  pruef('der Owner lässt sich von einem user.manage-Inhaber nicht sperren', code, 'fehler.ownerSperren');
  pruef('...der Owner ist tatsächlich weiter aktiv',
    db.get<{ d: number }>('SELECT disabled AS d FROM users WHERE id = ?', owner)?.d, 0);

  // Gegenprobe: ein gewöhnliches Konto lässt sich sperren — der eigentliche Zweck des Rechts.
  const ziel = kontoRoh('member', 'Ziel Sperren');
  const gegenprobeCode = versucht(() => users.setDisabled(ziel, true));
  pruef('Gegenprobe: dasselbe Konto sperrt ein gewöhnliches Mitglied — muss gelingen', gegenprobeCode, null);
  pruef('...das Mitglied ist jetzt wirklich gesperrt',
    db.get<{ d: number }>('SELECT disabled AS d FROM users WHERE id = ?', ziel)?.d, 1);
}

/**
 * DELETE /api/admin/notzugang/:id — dieselben zwei Sperren wie beim
 * Zurücksetzen, gemessen an denselben zwei Konten.
 *
 * Die Spur ist dabei der Beleg: `notzugang_protokoll` bekommt bei jedem
 * gelungenen Aufheben eine Zeile. Bleibt sie leer, ist wirklich nichts
 * passiert — eine Abweisung, die nur eine Ausnahme wirft und trotzdem
 * zerstört, fiele hier auf.
 */
function zeileNotzugangAufheben(): void {
  const angreifer = angreiferMit('user.manage', 'Angreifer Notzugang');
  pruefeAusgangslage('Notzugang aufheben', angreifer, 'user.manage');

  const spurZeilen = (id: string) => notzugang.protokollFuer(id).length;

  const owner = kontoRoh('owner', 'Probe-Owner Notzugang');
  const codeOwner = versucht(() => { endpunktNotzugangAufheben(angreifer, owner); });
  pruef('die Rettungsleine des Owners bleibt vor einem user.manage-Inhaber sicher', codeOwner !== null, true);
  pruef('...mit der Kennung aus routes.ts', codeOwner, 'fehler.ownerNotzugangSelbst');
  pruef('...und in der Spur des Owners steht davon nichts', spurZeilen(owner), 0);

  /* Die zweite Sperre, und der eigentliche Fund: ein Konto, dessen Passwort
     dieser Angreifer NICHT zurücksetzen darf (es trägt Rechte, die er selbst
     nicht hat), darf er auch nicht so weit bringen, dass ein späteres
     Zurücksetzen alles vernichtet. 'admin' als Ziel — dieselbe Aufstellung
     wie in zeilePasswortZuruecksetzen(). */
  const admin = kontoRoh('admin', 'Ziel Admin Notzugang');
  const codeAdmin = versucht(() => { endpunktNotzugangAufheben(angreifer, admin); });
  pruef('ein Konto ausserhalb der eigenen Reichweite bleibt ebenfalls unangetastet', codeAdmin !== null, true);
  pruef('...mit derselben Kennung wie beim Zurücksetzen', codeAdmin, 'fehler.keinRechtName');
  pruef('...und auch dort steht nichts in der Spur', spurZeilen(admin), 0);
  pruef('...die beiden Endpunkte sagen damit dasselbe',
    codeAdmin, versucht(() => { void endpunktPasswortZuruecksetzen(angreifer, admin); }));

  /* Gegenprobe: INNERHALB der eigenen Reichweite geht es — sonst wäre das
     Recht `user.manage` an dieser Stelle wertlos statt begrenzt. */
  const ziel = kontoRoh('guest', 'Ziel Gast Notzugang');
  notzugangRoh(ziel);
  const gegenprobe = versucht(() => { endpunktNotzugangAufheben(angreifer, ziel); });
  pruef('Gegenprobe: bei einem guest-Konto (dessen Rechte es ganz hat) gelingt es', gegenprobe, null);
  pruef('...und genau dieser Vorgang steht in der Spur', spurZeilen(ziel), 1);

  /* Und der Inhaber selbst kommt überall durch — die Owner-Sperre gilt nur
     gegen FREMDE, nicht gegen den Owner in eigener Sache. */
  const echterOwner = kontoRoh('owner', 'Handelnder Owner Notzugang');
  notzugangRoh(echterOwner);
  pruef('Gegenprobe: der Owner hebt seinen eigenen Notzugang auf',
    versucht(() => { endpunktNotzugangAufheben(echterOwner, echterOwner); }), null);

  /* DIE NAHT ZWISCHEN NACHBILDUNG UND ECHTER ROUTE.
     Alles darüber misst endpunktNotzugangAufheben() — eine Nachbildung. Sie
     kann grün bleiben, während in http/routes.ts jemand eine der beiden
     Sperren wieder herausnimmt; genau diese Lücke haben die Nachbarzeilen
     dieser Datei seit jeher offen. Für diese eine Route wird sie geschlossen:
     der Rumpf des Handlers wird gelesen und muss beide Sperren beim Namen
     nennen. Das ist keine Ausführung, sondern eine Naht — sie fängt das
     Löschen, nicht jede denkbare Umformulierung. Hier stand vor dieser
     Fassung KEINE der beiden. */
  const quelle = fs.readFileSync(new URL('../http/routes.ts', import.meta.url), 'utf8');
  const anfang = quelle.indexOf("app.delete('/api/admin/notzugang/:id'");
  const rumpf = anfang < 0 ? '' : quelle.slice(anfang, quelle.indexOf('\n  app.', anfang + 1));
  pruef('Der Handler in http/routes.ts ist überhaupt auffindbar', anfang >= 0, true);
  pruef('...und nennt beide Sperren beim Namen — Owner-Vorbehalt und Übernahme-Regel',
    [rumpf.includes("'fehler.ownerNotzugangSelbst'"), rumpf.includes('fehlendesRechtZurUebernahme(')],
    [true, true]);
}

/* ── Die Tabelle selbst ───────────────────────────────────────────── */

const ZEILEN: Array<{ endpunkt: string; lauf: () => void }> = [
  { endpunkt: 'POST /api/admin/users (Konto anlegen) — Recht: user.invite', lauf: zeileKontoAnlegen },
  { endpunkt: 'POST /api/admin/users/:id/reset-password — Recht: user.manage', lauf: zeilePasswortZuruecksetzen },
  { endpunkt: 'DELETE /api/admin/notzugang/:id — Recht: user.manage', lauf: zeileNotzugangAufheben },
  { endpunkt: 'POST /api/admin/users/:id/role — Recht: user.manage', lauf: zeileRolleSetzen },
  { endpunkt: 'POST /api/admin/users/:id/permission — Recht: permission.manage', lauf: zeilePermissionSetzen },
  { endpunkt: 'POST /api/admin/users/:id/kategorie — Recht: user.manage', lauf: zeileKategorieSetzen },
  { endpunkt: 'POST /api/admin/users/:id/disabled — Recht: user.manage', lauf: zeileDisabledSetzen },
  /* Keine eigenen Endpunkte, sondern die Grenzfälle der beiden Regeln —
     die Fälle, die aus einer Tabellenzeile nicht herausfallen, weil dort
     immer nur EIN Angreifer gegen EIN Ziel steht. */
  { endpunkt: 'Grenzfälle der Übernahme-Regel (fehlendesRechtZurUebernahme)', lauf: zeileUebernahmeGrenzen },
  { endpunkt: 'Vollständigkeit der Rollenliste in users.setRole()', lauf: zeileRollenlisteVollstaendig },
];

for (const zeile of ZEILEN) {
  console.log(`\n${zeile.endpunkt}`);
  zeile.lauf();
}

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mKein admin-Endpunkt lässt sich mit nur einem nicht-ownerOnly Recht zur Eskalation missbrauchen.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
