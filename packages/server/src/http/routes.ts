import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  normalizeLang, LANGUAGES,
  type AnmeldeNachweisBlob, type FluechtigesPaket, type KontoSchluesselBlob,
  type NotzugangAnteilBlob, type NotzugangHuelle,
} from '@stellium/shared';
import { signToken, verifyPassword, verifyToken, verifyTokenFrisch } from '../auth.js';
import * as users from '../services/users.js';
import * as praesenz from '../services/praesenz.js';
import * as kontoschluessel from '../services/kontoschluessel.js';
import * as anmeldenachweis from '../services/anmeldenachweis.js';
import * as notzugang from '../services/notzugang.js';
import * as push from '../services/push.js';
import * as systemwerte from '../services/systemwerte.js';
import { may } from '../services/users.js';
import { KONTO_KATEGORIEN } from '@stellium/shared';
import {
  PERMISSIONS, PERMISSION_KEYS, ROLES, ROLE_DEFAULTS, roleInfo,
  type MemberRole, type PermissionKey,
} from '@stellium/shared';
import { config } from '../config.js';
import { db, placeholders } from '../db/index.js';
import { kennungVon } from '../util/abweisung.js';
import { newId } from '../util/id.js';
import {
  addGlossaryEntry, aiCapabilities, anbieterWaehlen, cachedReleaseNotes, chooseModels, listGlossary,
  lokalePruefung, modelRegistry, removeGlossaryEntry, translateReleaseNotes,
} from '../translation/index.js';
import { search } from '../services/search.js';
import * as store from '../services/store.js';
import * as files from '../services/files.js';
import * as releases from '../services/releases.js';
import * as fernzugang from '../services/fernzugang.js';
import * as mailzugang from '../services/mailzugang.js';
import * as verkaufzugang from '../services/verkaufzugang.js';
import * as patreon from '../services/patreon.js';
import * as gumroad from '../services/gumroad.js';
import * as verkaufBenachrichtigung from '../services/verkaufBenachrichtigung.js';
import * as paypal from '../services/paypal.js';
import * as post from '../services/post.js';
import * as postSuche from '../services/post-suche.js';
import * as postSichtung from '../services/post-sichtung.js';
import * as postEntwurfKi from '../services/post-entwurf-ki.js';
import * as partnerGruppen from '../services/post-partnergruppen.js';
import { registerPostEingang } from './posteingang.js';
import { downloadSeite, systemErkennen } from './download/seite.js';

import { broadcastAll, onlineUserIds, sitzungenBeenden, verbindungen } from '../ws/gateway.js';
import * as ablage from '../services/ablage.js';
import * as avatare from '../services/avatare.js';
import { huelleSchreiben, umschlagVonDatei } from '../crypto/dateien.js';

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifyToken(header.slice(7));
}

/**
 * Anmeldung für Abrufe, die ein Browser selbst auslöst.
 *
 * Ein <a href> und ein <img src> schicken keine Kopfzeilen mit. Für
 * Downloads und Vorschaubilder muss der Nachweis deshalb in die Adresse —
 * sonst bliebe der Knopf "Herunterladen" wirkungslos, was er bis eben war.
 *
 * Nur für lesende Abrufe, nie für etwas, das etwas verändert: Adressen
 * landen in Verläufen und Protokollen.
 */
function bearerOderAdresse(req: FastifyRequest): string | null {
  const ausKopf = bearer(req);
  if (ausKopf) return ausKopf;
  const roh = (req.query as { token?: string } | undefined)?.token;
  return roh ? verifyToken(roh) : null;
}

function requireLeser(req: FastifyRequest): string {
  const id = bearerOderAdresse(req);
  if (!id) {
    const err = new Error('Nicht angemeldet') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return id;
}

function requireUser(req: FastifyRequest): string {
  const id = bearer(req);
  if (!id) {
    const err = new Error('Nicht angemeldet') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return id;
}

/**
 * Wie requireUser, verlangt aber ein FRISCHES Token (Höchstalter in ms).
 *
 * Nur für den Anmeldenachweis: der echte Aufrufer legt ihn Sekunden nach der
 * Anmeldung ab, ein gestohlenes Token ist in der Regel älter. Warum gerade
 * dieser Weg die Frische braucht, steht bei verifyTokenFrisch in auth.ts.
 * Ein zu altes Token antwortet mit demselben 401 wie ein ungültiges — die
 * App wirft den Fehlschlag weg und versucht es bei der nächsten Anmeldung
 * von selbst wieder (siehe nachweisNachtragen in lib/anmeldenachweis.ts).
 */
function requireFrischenUser(req: FastifyRequest, hoechstalterMs: number): string {
  const header = req.headers.authorization;
  const roh = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const id = roh ? verifyTokenFrisch(roh, hoechstalterMs) : null;
  if (!id) {
    const err = new Error('Nicht angemeldet') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return id;
}

/**
 * Die Änderungsliste einer Fassung in der Lesesprache der betrachtenden
 * Person — sofort, aus dem Zwischenspeicher, nie über einen Netzaufruf.
 *
 * Wer eine Version veröffentlicht, tippt die Notizen frei ein (meist
 * Deutsch, aber nicht garantiert) — ohne diese Stelle ging genau dieser
 * Wortlaut unverändert an jede Person hinaus, egal welche Sprache ihre
 * Oberfläche zeigt. Fehlt eine Übersetzung noch, kommt hier das Original
 * zurück (nie eine leere Antwort) und im Hintergrund wird nachgeholt, was
 * fehlt — ohne dass diese Anfrage darauf wartet. Der nächste Abruf (die
 * App fragt viertelstündlich nach, siehe electron/updater.ts) bekommt dann
 * die Übersetzung.
 */
function notizenFuerBetrachter(platform: string, userId: string, original: string | null): string | null {
  if (!original) return null;
  const sprache = store.uiLanguageOf(userId);
  const uebersetzt = cachedReleaseNotes(platform, sprache);
  if (uebersetzt !== null) return uebersetzt;
  void translateReleaseNotes(platform, sprache).catch((err) => {
    console.error('[releases]', (err as Error).message);
  });
  return original;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/* ── Bremse gegen das Durchprobieren von Passwörtern ───────────── */

/**
 * Gezählt wird je Herkunft *und* Benutzername. Nur nach Herkunft zu zählen
 * wäre falsch: in einer Firma teilen sich alle eine Adresse, und die
 * Tippfehler einer Person sperrten das ganze Büro aus.
 */
const versuche = new Map<string, { anzahl: number; bis: number }>();
const GRENZE = 8;
const FENSTER = 60_000;

function zuVieleVersuche(herkunft: string): boolean {
  const eintrag = versuche.get(herkunft);
  if (!eintrag) return false;
  if (Date.now() > eintrag.bis) { versuche.delete(herkunft); return false; }
  return eintrag.anzahl >= GRENZE;
}

function versuchGezaehlt(herkunft: string): void {
  const jetzt = Date.now();
  const eintrag = versuche.get(herkunft);
  if (!eintrag || jetzt > eintrag.bis) versuche.set(herkunft, { anzahl: 1, bis: jetzt + FENSTER });
  else eintrag.anzahl += 1;

  // Die Liste darf nicht unbegrenzt wachsen; abgelaufene Einträge fliegen raus.
  if (versuche.size > 5000) {
    for (const [schluessel, wert] of versuche) if (jetzt > wert.bis) versuche.delete(schluessel);
  }
}

function versucheZuruecksetzen(herkunft: string): void {
  versuche.delete(herkunft);
}

/**
 * Der Schlüssel eines Eimers — Herkunft und Benutzername.
 *
 * Der Name wird hier GENAU SO zurechtgelegt wie bei der Kontosuche:
 * `trim().toLowerCase()`, dieselbe Reihenfolge wie in blindIndex()
 * (crypto/pii.ts) und wie im Altbestands-Zweig von users.findByLogin(),
 * der mit `login.trim()` sucht. Beide Suchwege benutzen dasselbe
 * String.prototype.trim() — es gibt also nur EINE Menge von Zeichen, die
 * vorn und hinten wegfällt, und die muss die Bremse kennen.
 *
 * WARUM DAS EINE SICHERHEITSFRAGE IST: ohne das `trim()` bekamen "anna",
 * "anna " und "\tanna" je einen EIGENEN Eimer, obwohl alle drei DASSELBE
 * Konto öffnen. Wer bei jedem Versuch ein weiteres Leerzeichen anhängt,
 * zählte damit nie über eins und lief nie in die Grenze — jedes Raten wurde
 * trotzdem gegen den echten Nachweis geprüft. Die Bremse stand da und
 * bremste nur den, der sich vertippt hat.
 *
 * DAS KANN NIEMANDEN AUSSPERREN: der Schlüssel wird gröber, nie feiner. Es
 * entsteht kein neuer Eimer, es fallen nur solche zusammen, die heute
 * fälschlich getrennt sind — und zwar genau dann, wenn beide Schreibweisen
 * ohnehin dasselbe Konto treffen. Zwei verschiedene Konten können sich
 * keinen Eimer teilen: ein gespeicherter Benutzername oder eine
 * gespeicherte E-Mail enthält nie eines dieser Zeichen (die Prüfmuster in
 * services/users.ts lassen mit `[a-z0-9._-]` und `[^@\s]` keines durch),
 * es kann also gar nicht erst zwei Konten geben, die sich nur um Leerraum
 * unterscheiden. Und ein gelungener Login räumt genau diesen Schlüssel
 * wieder weg (versucheZuruecksetzen) — für jede Schreibweise auf einmal.
 *
 * Dass ein ANDERER Benutzername einen eigenen Eimer bekommt, bleibt genau
 * so: das ist Absicht, siehe der Kommentar über `versuche` oben.
 */
function bremsSchluessel(ip: string, login: string): string {
  return `${ip}|${login.trim().toLowerCase()}`;
}

/**
 * Angefangene Teil-Uploads. Bewusst nur im Speicher: bricht der Server ab,
 * fängt der Client neu an — das ist besser, als Reste in der Datenbank zu
 * führen, die niemand mehr abholt.
 */
const teilUploads = new Map<string, {
  userId: string; name: string; mime: string; size: number; parts: number;
  da: Set<number>; groessen: Map<number, number>; begonnen: number;
  /**
   * Was JEDER Teil dieses Auftrags zusammen schon belegt — fertig geschrieben
   * UND gerade im Fluss. Siehe `begrenzt()` weiter unten: ohne diese eine
   * Zahl rechnete jeder Teil für sich, und „für sich" heißt bei gleichzeitigen
   * Anfragen: gegen denselben veralteten Stand.
   */
  gesamt: number;
  /** Wie viel jeder gerade laufende Teil bisher beigetragen hat — je Teil,
      damit ein Abbruch genau seinen eigenen Beitrag wieder freigibt. */
  imFlug: Map<number, number>;
  /** Läuft für diesen Auftrag schon ein `/finish`? */
  abschluss: boolean;
}>();

/** Der Auftrag, wie ihn `begrenzt()` und die Teilroute brauchen. */
type TeilAuftrag = NonNullable<ReturnType<typeof teilUploads.get>>;

/** Wie viele angefangene Teil-Uploads ein Konto gleichzeitig haben darf. */
const TEILUPLOADS_JE_KONTO = 8;

/**
 * Einen Datenstrom durchlassen, aber nur so weit, wie der GANZE Auftrag noch
 * Platz hat.
 *
 * Ohne das nahm `PUT /api/uploads/:id/part/:index` jeden Rumpf entgegen, den
 * jemand schickte. Fastify erzwingt seine `bodyLimit` nicht, wenn ein eigener
 * Parser den Strom durchreicht — und genau so einen gibt es hier für
 * application/octet-stream. Nachgemessen: ein Upload mit angemeldeten 1024
 * Byte nahm einen Teil von 80 MB an, schrieb ihn auf die Platte und
 * antwortete mit 200. Bei zweitausend erlaubten Teilen ist das keine Zahl
 * mehr, sondern die Speicherkarte des Pi.
 *
 * Die Prüfung beim Zusammenlegen half nicht: sie vergleicht die Summe erst,
 * wenn alles längst geschrieben ist.
 *
 * WARUM DIE GRENZE JETZT AM AUFTRAG HÄNGT UND NICHT MEHR AM TEIL
 *
 * Die erste Fassung bekam eine feste Zahl mit: „dieser Teil darf noch so
 * viel". Ausgerechnet wurde sie VOR dem `await` aus `auftrag.groessen`, und
 * eingetragen wurde erst DANACH. Zwischen beidem liegt der ganze Upload —
 * und in dieser Lücke rechneten alle gleichzeitig laufenden Teile gegen
 * denselben leeren Stand. Jeder bekam das volle Budget, keiner sah die
 * anderen. Nachgemessen an einem echten Server: dreißig gleichzeitige Teile
 * bei einer Meldung von 1 MB — dreißig mal 200, kein einziges 413, 31,4 MB
 * auf der Platte. Das Kontingent stand auf 1 MB.
 *
 * Deshalb zählt jetzt nicht mehr jeder Teil für sich, sondern alle in EINE
 * Zahl am Auftrag (`gesamt`): fertig geschriebene und gerade fließende Bytes
 * zusammen. Der Anspruch entsteht Stück für Stück beim Durchfließen, nicht
 * erst am Ende — deshalb kann ihn niemand mehr überholen. Vier gleichzeitige
 * Teile, wie die echte App sie schickt (desktop/src/net/api.ts), stören
 * einander dabei nicht: ihre Summe bleibt unter der angemeldeten Größe, und
 * nur die Summe wird geprüft.
 *
 * Freigegeben wird in der Route, nicht hier — ein abgebrochener Strom darf
 * seinen Anspruch nicht behalten, sonst könnte ein Konto sich mit
 * abgebrochenen Uploads selbst aussperren.
 */
function begrenzt(auftrag: TeilAuftrag, nummer: number): Transform {
  return new Transform({
    transform(stueck, _kodierung, weiter) {
      auftrag.gesamt += stueck.length;
      auftrag.imFlug.set(nummer, (auftrag.imFlug.get(nummer) ?? 0) + stueck.length);
      if (auftrag.gesamt > auftrag.size) { weiter(new Error('zu groß')); return; }
      weiter(null, stueck);
    },
  });
}

/** Prüfsumme einer Datei, ohne sie ganz in den Speicher zu holen. */
function dateiSumme(datei: string): Promise<string> {
  return new Promise((fertig, schief) => {
    const hash = crypto.createHash('sha256');
    const strom = fs.createReadStream(datei, { highWaterMark: 1024 * 1024 });
    strom.on('data', (d) => hash.update(d));
    strom.on('end', () => fertig(hash.digest('hex')));
    strom.on('error', schief);
  });
}

/**
 * Eine Datei zur Übernahme in den Blockspeicher anmelden — außer sie ist
 * verschlüsselt.
 *
 * Angemeldet, nicht übernommen: die Zerlegung läuft im Hintergrund, der
 * Aufrufer kehrt sofort zurück. Warum das auch für die kleinen Wege gilt und
 * nicht nur für den Weg in Teilen, steht bei `spaeterUebernehmen()` — kurz:
 * die Zerlegung ist durchweg synchron, und wie lange sie dauert, entscheidet
 * nicht die Größe, sondern der Inhalt. Auf dem Raspberry Pi gemessen: 4 MB
 * packbarer CSV-Abzug 18 Sekunden, in denen kein Ping und keine Nachricht
 * durchkam, weil die Ereignisschleife stand. Bei den 50 MB, die
 * `MAX_UPLOAD_MB` erlaubt, wären das über drei Minuten Stillstand für alle.
 *
 * Der Blockspeicher lebt davon, gleiche Bytes wiederzuerkennen. Bei einer
 * verschlüsselten Datei kann er das grundsätzlich nicht: ihr Schlüssel ist
 * gewürfelt, dieselbe Datei ergibt beim zweiten Hochladen ein völlig anderes
 * Chiffrat, und gepackt wird sie auch nicht — Chiffrat sieht für jeden Packer
 * aus wie Rauschen. Ein Durchlauf fände also garantiert nichts und kostete auf
 * dem Raspberry Pi trotzdem eine volle Zerlegung samt Packversuch je Block.
 *
 * Wichtiger als die Ersparnis ist aber, dass es so bleiben **muss**. Würde der
 * Dateischlüssel aus dem Inhalt abgeleitet — der naheliegende Weg, um auch
 * verschlüsselt noch zusammenlegen zu können —, dann verriete genau dieses
 * Zusammenlegen dem Server, ob er eine bestimmte Datei schon verwahrt: er
 * müsste sie nur selbst verschlüsseln und die Blöcke vergleichen. Bei privaten
 * Dateien geht Privatsphäre vor Speicherplatz, und diese Abzweigung ist die
 * Stelle, an der das steht.
 */
function uebernehmenWennOffen(
  input: { id: string; art: ablage.Art; pfad: string; mime: string },
  umschlag: unknown | null,
): void {
  if (umschlag) return;
  ablage.spaeterUebernehmen(input);
}

async function teileAufraeumen(id: string, anzahl: number): Promise<void> {
  for (let i = 0; i < anzahl; i += 1) {
    await fs.promises.rm(path.join(config.uploadDir, `${id}.teil${i}`), { force: true }).catch(() => {});
  }
}

/* Liegengebliebenes wegräumen: wer anfängt und nicht fertig wird, soll keine
   halben Dateien hinterlassen. */
setInterval(() => {
  const grenze = Date.now() - 60 * 60 * 1000;
  for (const [id, auftrag] of teilUploads) {
    if (auftrag.begonnen > grenze) continue;
    teilUploads.delete(id);
    void teileAufraeumen(id, auftrag.parts);
  }
}, 15 * 60 * 1000).unref();

/* ── Wer welche Rolle vergeben und wessen Konto übernehmen darf ──
 *
 * ZWEI TÜREN IN DENSELBEN RAUM
 *
 * Hier stehen ZWEI Wächter, weil es zwei Wege gibt, an fremde Rechte zu
 * kommen: eine Rolle VERGEBEN (`darfRolleVergeben()`) und ein Konto
 * ÜBERNEHMEN (`fehlendesRechtZurUebernahme()`). Beide vergleichen
 * Rechtemengen, und beide rufen dafür in DIESELBE Funktion hinein
 * (`erstesFehlendesRecht()` weiter unten) — nicht aus Sparsamkeit, sondern
 * weil eine zweite Kopie desselben Vergleichs genau der Fehler ist, gegen
 * den diese ganze Regel geschrieben wurde: zwei Stellen, von denen später
 * nur eine nachgezogen wird.
 *
 * DIE REGEL, AUSGESCHRIEBEN
 *
 *   1. Der Inhaber darf jede Rolle vergeben. Er hat ohnehin jedes Recht;
 *      ihn hier zu bremsen hieße nur, ihn aus seinem eigenen Haus
 *      auszusperren.
 *   2. Alle anderen dürfen eine Rolle nur vergeben, wenn sie JEDES Recht,
 *      das diese Rolle mitbringt, selbst besitzen. Weitergeben, was man
 *      nicht hat, wäre der bequemere Weg an der Rechteverwaltung vorbei.
 *   3. Und die Rolle muss ECHT kleiner sein als die eigenen Rechte: es
 *      muss mindestens ein Recht geben, das der Vergebende hat und sie
 *      nicht. Ohne diesen dritten Punkt dürfte ein Administrator weitere
 *      Administratoren ernennen — und eine Decke, die sich selbst
 *      nachbauen kann, ist keine.
 *
 * WARUM ES DIESE REGEL BRAUCHT
 *
 * Hier stand vorher nur „ist die gewünschte Rolle 'owner' und bin ich
 * nicht der Inhaber". Gegen `'admin'` stand nichts. Und geprüft wurde die
 * Zeichenkette nirgends sonst: `users.role` in db/schema.sql hat kein
 * CHECK, es gibt kein `schema:` an der Route, keinen Validator, und
 * `MemberRole` ist ein TypeScript-Typ — zur Laufzeit nichts. In
 * `createAccount()` (services/users.ts) ging `input.role ?? 'member'`
 * ungeprüft in den INSERT.
 *
 * Der kurze Weg war nicht einmal `user.invite`, sondern `user.manage`
 * allein: fremdes Konto auf `admin` setzen (nur `owner` und man selbst
 * waren gesperrt), diesem Konto das Passwort zurücksetzen (nur ein
 * Inhaber als ZIEL war gesperrt) — das Einmal-Passwort steht in der
 * Antwort —, anmelden, fertig. `admin` ist ALLE Rechte außer
 * `user.delete`, `permission.manage` und `channel.delete` und schließt
 * damit vier Rechte ein, die `ownerOnly` tragen.
 *
 * Der Angreifer ist dabei kein Eindringling, sondern ein Mitglied oder
 * Gast, dem der Inhaber im Rechteraster bewusst `user.invite` oder
 * `user.manage` gegeben hat — beide sind nicht `ownerOnly`, das ist ein
 * vorgesehener Weg. Er überstieg damit die Decke, die die Rolle
 * `teamlead` ausdrücklich zusagt: „Vergibt keine Einzelrechte"
 * (shared/permissions.ts).
 *
 * Die Bauart ist absichtlich dieselbe wie bei `ownerOnly` für einzelne
 * Rechte (`setPermission()` in services/users.ts): dort heißt es „nur der
 * Inhaber darf dieses Recht VERGEBEN", nicht „nur der Inhaber darf es
 * haben" — der Inhaber WILL, dass Administratoren diese vier Rechte
 * tragen. Falsch war nie, was ein Administrator darf, sondern dass
 * jemand ohne Zutun des Inhabers Administrator werden konnte.
 *
 * Verglichen werden Rechte und nicht Rangstufen: eine Rangliste wäre eine
 * zweite Wahrheit neben ROLE_DEFAULTS und liefe eines Tages daneben.
 * Persönliche Ausnahmen zählen mit, weil `permissionsFor()` sie mitzählt —
 * wer ein Recht per Ausnahme hat, darf es auch weitergeben.
 *
 * ─────────────────────────────────────────────────────────────────
 * DIE ZWEITE TÜR: EIN KONTO ÜBERNEHMEN
 *
 * Die Regel oben schließt den Weg, sich SELBST einen Administrator zu
 * bauen. Sie schließt nicht den Weg über einen, den es schon gibt.
 *
 * `POST /.../reset-password` verlangte `user.manage` und sperrte als ZIEL
 * einzig den Inhaber. Ein Administrator, den der Inhaber selbst ernannt
 * hatte, stand offen: Passwort zurücksetzen, das neue Einmal-Passwort steht
 * im Antwortkörper, anmelden. Derselbe Raum, andere Tür. Nachgestellt gegen
 * einen laufenden Server: ein Konto mit Rolle `guest` und dem einzelnen
 * Recht `user.manage` meldete sich danach wirklich als Administrator an.
 *
 * DESHALB GILT FÜR DAS ÜBERNEHMEN DIESELBE REGEL WIE FÜRS VERGEBEN:
 *
 *   Ein fremdes Passwort zurücksetzen darf nur, wer JEDES Recht dieses
 *   Kontos selbst hat.
 *
 * Das ist Punkt 2 von oben, angewandt auf ein Konto statt auf eine Rolle.
 * Wer ein Passwort zurücksetzt und das Einmal-Passwort in die Hand bekommt,
 * IST danach dieses Konto — der Vorgang gibt keine Rechte weiter, er gibt
 * sie ganz. Wenn schon fürs Vergeben einer Fähigkeit gilt „du musst sie
 * selbst haben", kann fürs Ansichnehmen nicht weniger gelten. Sonst steht
 * neben der eben verschlossenen Tür eine offene.
 *
 * PUNKT 3 GILT HIER NICHT — WARUM
 *
 * Für das VERGEBEN verlangt Punkt 3 ein Recht, das der Vergebende behält
 * und die Rolle nicht hat; sonst ernennt ein Administrator Administratoren.
 * Übertragen hieße das: kein Administrator dürfte das Passwort eines
 * anderen Administrators zurücksetzen. Das ist bewusst NICHT so, und zwar
 * aus drei Gründen:
 *
 *   a) Punkt 3 wehrt eine VERMEHRUNG ab. Vergeben schafft einen NEUEN
 *      Träger: aus einem Administrator werden zwei, aus zweien vier, und
 *      die Decke baut sich ohne den Inhaber nach. Ein Zurücksetzen schafft
 *      keinen Träger — hinterher gibt es exakt dieselben Konten mit exakt
 *      denselben Rechten. Es wechselt nur, wer dahinter sitzt. Das
 *      Argument, das Punkt 3 trägt, trägt hier nicht.
 *   b) Punkt 2 deckt die Eskalation bereits vollständig ab: hinterher kann
 *      der Angreifer genau das, was das Zielkonto konnte — und Punkt 2
 *      sagt, dass er das schon vorher konnte. Die Decke steigt um keinen
 *      Millimeter. Mehr will diese Regel nicht.
 *   c) Punkt 3 würde dem Zurücksetzen seinen eigentlichen Zweck nehmen.
 *      `teamlead` verspricht wörtlich „Nimmt neue Leute auf und setzt
 *      Passwörter zurück" (shared/permissions.ts). Unter Punkt 3 könnten
 *      zwei Teamleitungen mit gleichen Rechten einander NICHT mehr
 *      heraushelfen — ausgerechnet der häufigste echte Fall, der ausgesperrte
 *      Kollege, ginge nur noch über den Inhaber. Eine Regel, die ihren
 *      meistgebrauchten Fall verbietet, wird umgangen, nicht befolgt.
 *
 * Was ohne Punkt 3 übrig bleibt, ist das Auftreten UNTER GLEICHEN — kein
 * Rechtegewinn, aber fremde Direktnachrichten und fremde Kanäle. Das ist
 * real, und es bleibt bewusst stehen, weil dieser Vorgang von sich aus laut
 * ist: `resetPassword()` (services/users.ts) kappt die Sitzungen des Ziels,
 * setzt `must_change_password` und schreibt eine Zeile nach `invites` mit
 * `created_by`. Der Bestohlene fliegt heraus, sein Passwort gilt nicht mehr,
 * und wer es war, steht in der Tabelle. Eine Übernahme, die sich selbst
 * anzeigt und das Opfer aussperrt, ist ein lauter Angriff — anders als das
 * stille Ernennen, gegen das Punkt 3 steht. Der teuerste Inhalt kommt
 * ohnehin nicht mit: `vertraulich_sicherung` (db/schema.sql) verschließt den
 * privaten Schlüssel mit einem Wiederherstellungscode, der nirgends auf dem
 * Server steht.
 *
 * FÜR BEIDE TÜREN GILT: es zählen die WIRKSAMEN Rechte, nicht die
 * Rollenvorgabe. Beim Vergeben ist die Zielmenge trotzdem `ROLE_DEFAULTS`,
 * und das ist kein Näherungswert, sondern genau richtig: `setRole()`
 * (services/users.ts) löscht beim Rollenwechsel alle persönlichen Ausnahmen
 * des Ziels, die Rollenvorgabe IST danach dessen ganze Rechtemenge. Beim
 * Übernehmen bleiben die Ausnahmen stehen, also muss dort `permissionsFor()`
 * gefragt werden — sonst käme ein Administrator, dem der Inhaber einzeln
 * `permission.manage` gegeben hat, unter seiner Rollenvorgabe durch.
 */

/**
 * Eine Rolle aus einer Anfrage — geprüft gegen die wirkliche Liste.
 *
 * `ROLES` (@stellium/shared) ist die Liste der Rollen. Alles andere ist
 * keine Rolle, auch wenn es wie eine aussieht.
 *
 * HIER STAND EINE FALSCHE ZUSAGE, und sie ist es wert, benannt zu werden:
 * „ROLES ist dieselbe Quelle, aus der die Oberfläche ihr Auswahlfeld baut."
 * Das stimmt nicht. `packages/desktop/src/components/TeamAdmin.tsx` trägt
 * ganz oben eine eigene, von Hand geschriebene Liste `ROLLEN` mit genau
 * vier Einträgen (owner, admin, member, guest) und importiert `ROLES`
 * nirgends — nachgesehen am 2026-08-23, im ganzen Ordner
 * packages/desktop/src kein einziges Vorkommen.
 *
 * Damit gab es DREI Stände derselben Liste: `ROLES` mit zehn,
 * `users.setRole()` mit vier (inzwischen behoben, Begründung dort) und die
 * Oberfläche mit vier. Zwei davon sind jetzt eine; die Oberfläche ist der
 * verbliebene dritte. Solange sie ihre vier behält, zeigt sie für ein Konto
 * mit einer der sechs übrigen Rollen bei der Rollenbeschriftung nichts an
 * (`ROLLEN.find(...)?.label` wird undefined) — erreichbar schon immer über
 * die Kontoerstellung, die alle zehn annimmt, seit der Behebung in
 * setRole() zusätzlich über /role. Wer TeamAdmin.tsx anfasst: das
 * Auswahlfeld gehört aus `ROLES` gebaut, dann ist auch dieser Stand weg.
 */
export function rolleLesen(wert: unknown): MemberRole | null {
  if (typeof wert !== 'string') return null;
  return ROLES.some((r) => r.name === wert) ? (wert as MemberRole) : null;
}

type Rechtesatz = ReadonlySet<PermissionKey>;

/**
 * DIE eine Vergleichsstelle: welches Recht aus `fremde` fehlt `eigene`?
 * `null` heißt „keins" — `eigene` deckt `fremde` vollständig ab.
 *
 * Punkt 2 der Regel oben UND die Regel für das Übernehmen laufen beide
 * hierher. Ein zweiter Vergleich daneben wäre eine zweite Wahrheit, und
 * genau daran ist die Rollenregel schon einmal auseinandergelaufen (siehe
 * den Kopfkommentar von src/pruefungen/rechte-eskalation.mts).
 *
 * Zurückgegeben wird das fehlende Recht und nicht nur ein `false`, weil der
 * Aufrufer die BEGRÜNDUNG braucht: die Route schreibt sie in die Meldung,
 * damit dort „dir fehlt das Recht X" steht und nicht „geht nicht".
 */
function erstesFehlendesRecht(eigene: Rechtesatz, fremde: Rechtesatz): PermissionKey | null {
  for (const k of fremde) if (!eigene.has(k)) return k;
  return null;
}

/** Punkt 3: hält `eigene` mindestens ein Recht, das `fremde` nicht hat? */
function haeltEinRechtMehr(eigene: Rechtesatz, fremde: Rechtesatz): boolean {
  for (const k of eigene) if (!fremde.has(k)) return true;
  return false;
}

/** Die Nachschlagetabelle aus `permissionsFor()` als Menge. */
function rechtesatzVon(tabelle: Record<PermissionKey, boolean>): Rechtesatz {
  return new Set(PERMISSION_KEYS.filter((k) => tabelle[k] === true));
}

/** Punkt 1 bis 3 der Regel oben, in dieser Reihenfolge. */
export function darfRolleVergeben(userId: string, rolle: MemberRole): boolean {
  if (store.getSelf(userId)?.role === 'owner') return true;          // (1)
  const eigene = rechtesatzVon(users.permissionsFor(userId));
  /* Zielmenge ist die Rollenvorgabe, nicht `permissionsFor()` — Begründung
     im letzten Absatz der Regel oben (setRole() räumt die Ausnahmen weg). */
  const ziel: Rechtesatz = new Set(ROLE_DEFAULTS[rolle] ?? []);
  if (erstesFehlendesRecht(eigene, ziel) !== null) return false;     // (2)
  return haeltEinRechtMehr(eigene, ziel);                            // (3)
}

/**
 * Darf `userId` das Konto `zielId` übernehmen — also dessen Passwort
 * zurücksetzen und das Einmal-Passwort ausgehändigt bekommen?
 *
 * `null` heißt ja. Sonst kommt das erste Recht zurück, das dem Aufrufenden
 * dazu fehlt; die Route macht daraus die Meldung.
 *
 * OHNE SONDERFÄLLE, UND DAS IST ABSICHT — die beiden Fälle, die sonst
 * jeder für sich hier stünden, fallen aus der Regel heraus:
 *
 *   Der Inhaber. `effectivePermissions()` (shared/permissions.ts) gibt der
 *   Rolle `owner` jedes Recht des Katalogs zurück und lässt persönliche
 *   Ausnahmen dabei ausdrücklich nicht gelten. Eine Obermenge von allem ist
 *   Obermenge auch von jedem Einzelnen — der Inhaber kommt hier immer durch,
 *   ohne dass ein `if` das eigens erlauben müsste. (Ein ZWEITER Inhaber als
 *   Ziel bleibt trotzdem gesperrt: das erledigt die ältere, unveränderte
 *   Sperre in der Route selbst.)
 *
 *   Das eigene Passwort. Jede Menge enthält sich selbst; `zielId === userId`
 *   findet nie ein fehlendes Recht. Auch dafür braucht es keine Ausnahme.
 *
 * Ein Sonderfall, den man nicht schreibt, kann später nicht falsch werden.
 */
export function fehlendesRechtZurUebernahme(userId: string, zielId: string): PermissionKey | null {
  return erstesFehlendesRecht(
    rechtesatzVon(users.permissionsFor(userId)),
    rechtesatzVon(users.permissionsFor(zielId)),
  );
}

/**
 * Wie `verbindungen()` (ws/gateway.ts), aber `benutzer` zählt nur, wer
 * wirklich zum Team gehört — kein technisches Konto (Bot, KI-Assistent,
 * künftige Integrationen), keins, das gesperrt oder gelöscht ist. Speist
 * den Nenner *und* den Zähler des „Team online"-Bogens in der App
 * (SystemPanel.tsx liest `verbunden.benutzer` gegen `inhalt.users`, siehe
 * systemwerte.ts/stellium-konsole.mjs für die andere Hälfte derselben
 * Rechnung) — und in der Zeile `system.verbunden` gleich mit, aus demselben
 * Grund: „Personen" soll Personen heißen, kein Bot.
 *
 * `clients` bleibt roh: die Zahl offener Verbindungen ist ein technischer
 * Wert, kein Team-Wert, und ein Bot, der mitzählt, ist dort einfach richtig.
 *
 * Welche Rollen als „technisch" gelten, kommt aus `ROLES`/`technical`
 * (@stellium/shared) — nicht aus einer von Hand gepflegten Liste, siehe
 * TeamAdmin.tsx (ZUWEISBARE_ROLLEN) für dieselbe Quelle. Die Bedingung
 * spiegelt bewusst `toUser()` (services/store.ts, Feld `technisch`): eine
 * gewählte Kategorie schlägt die Vermutung aus der Rolle. `disabled`/
 * `deleted_at` dürften unter den Verbundenen ohnehin nie auftauchen —
 * `setDisabled()`/`deleteAccount()` (services/users.ts) kappen laufende
 * Sitzungen aktiv (`sitzungenKappen`) —, die Prüfung bleibt trotzdem stehen,
 * weil sie nichts kostet und die Zahl auch dann noch stimmt, wenn das
 * einmal nicht gilt.
 */
function teamVerbunden(): { clients: number; benutzer: number } {
  const roh = verbindungen();
  const ids = onlineUserIds();
  if (!ids.length) return { clients: roh.clients, benutzer: 0 };

  const technischeRollen = ROLES.filter((r) => r.technical).map((r) => r.name);
  const rollenBedingung = technischeRollen.length
    ? `role IN (${placeholders(technischeRollen.length)})`
    : '0';
  const zeile = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users
     WHERE id IN (${placeholders(ids.length)})
       AND deleted_at IS NULL AND disabled = 0
       AND NOT (
         (kategorie IS NOT NULL AND kategorie = 'technisch')
         OR (kategorie IS NULL AND ${rollenBedingung})
       )`,
    ...ids, ...technischeRollen,
  );
  return { clients: roh.clients, benutzer: zeile?.n ?? 0 };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /* Was ein Absturz mitten in einer Übernahme liegengelassen hat, wird jetzt
     zu Ende gebracht. Steht hier und nicht in einem eigenen Zeitgeber, weil es
     genau einmal beim Hochfahren gehört — und die Zerlegung läuft ohnehin im
     Hintergrund weiter, hält den Start also nicht auf. */
  ablage.offeneUebernahmenFortsetzen();

  app.get('/api/health', async () => ({
    verbunden: teamVerbunden(),
    ok: true,
    /* Welche Fassung hier wirklich läuft. Ohne diese Zeile endete das
       Ausliefern mit „veröffentlicht", ohne dass jemand nachsehen konnte, ob
       der Server sie auch übernommen hat — 1.0.17 lag danach eine halbe
       Stunde unbemerkt auf dem alten Stand. */
    version: config.version,
    workspace: config.workspaceName,
    ai: aiCapabilities(),
    languages: LANGUAGES.length,
    time: Date.now(),
  }));

  app.get('/api/languages', async () => LANGUAGES);

  /**
   * Modell für Übersetzung und KI festlegen. Gilt für den ganzen
   * Arbeitsbereich, deshalb nur für Owner und Admins.
   */
  app.post('/api/ai/models', async (req, reply) => {
    const userId = requireUser(req);
    const self = store.getSelf(userId);
    if (self?.role !== 'owner' && self?.role !== 'admin') {
      return fehler(reply, 403, 'fehler.nurLeitungModell', 'Das Übersetzungsmodell darf nur die Team-Leitung ändern.');
    }

    const body = req.body as { quality?: string | null; fast?: string | null; auto?: boolean };
    const registry = modelRegistry();
    if (!registry) return fehler(reply, 400, 'fehler.keineModellwahl', 'Der aktuelle Anbieter kennt keine Modellwahl.');

    if (body.auto) {
      chooseModels(null, null, userId);
      await registry.refresh();
      return { selection: registry.current, ai: aiCapabilities() };
    }

    const known = new Set(registry.discovered.filter((m) => !m.rejected).map((m) => m.id));
    for (const id of [body.quality, body.fast]) {
      if (id && known.size && !known.has(id)) {
        return fehler(reply, 400, 'fehler.modellUnbekannt',
          `Modell "${id}" gibt es nicht oder es beantwortet keine Chat-Anfragen.`, { modell: id });
      }
    }
    chooseModels(body.quality ?? null, body.fast ?? body.quality ?? null, userId);
    return { selection: registry.current, ai: aiCapabilities() };
  });

  /**
   * Anbieter umstellen — auf ein Modell im eigenen Netz oder zurück.
   * Wie die Modellwahl eine Sache für die Team-Leitung.
   */
  app.post('/api/ai/provider', async (req, reply) => {
    const userId = requireUser(req);
    const self = store.getSelf(userId);
    if (self?.role !== 'owner' && self?.role !== 'admin') {
      return fehler(reply, 403, 'fehler.nurLeitungAnbieter', 'Den KI-Anbieter darf nur die Team-Leitung ändern.');
    }

    const body = req.body as {
      anbieter?: string | null; baseUrl?: string; model?: string; fastModel?: string;
    };
    const erlaubt = ['groq', 'openai', 'ollama', 'llamacpp', 'local', 'deepl', 'libre', 'demo'];
    const anbieter = body.anbieter ? String(body.anbieter) : null;
    if (anbieter && !erlaubt.includes(anbieter)) {
      return fehler(reply, 400, 'fehler.anbieterUnbekannt',
        `Unbekannter Anbieter "${anbieter}".`, { anbieter: String(anbieter) });
    }

    // Bei einem lokalen Dienst zuerst nachsehen, ob dort überhaupt etwas
    // antwortet. Sonst stellt man auf einen Anbieter um, der nichts kann,
    // und merkt es erst an der nächsten Nachricht.
    if (anbieter === 'ollama' || anbieter === 'llamacpp' || anbieter === 'local') {
      const adresse = (body.baseUrl || '').trim()
        || (anbieter === 'llamacpp' ? config.ai.llamacpp.baseUrl
          : anbieter === 'local' ? (config.ai.lokal.baseUrl || config.ai.ollama.baseUrl)
            : config.ai.ollama.baseUrl);
      const probe = await lokalePruefung(adresse);
      if (!probe.erreichbar) {
        return fehler(reply, 400, 'fehler.dienstStumm',
          `Unter ${adresse} antwortet nichts (${probe.fehler}).`,
          { adresse: String(adresse), grund: String(probe.fehler) });
      }
      if (body.model && probe.modelle.length && !probe.modelle.includes(body.model)) {
        return reply.code(400).send({
          error: `Dort ist "${body.model}" nicht geladen. Vorhanden: ${probe.modelle.slice(0, 6).join(', ')}.`,
          code: 'fehler.modellNichtGeladen',
          werte: { modell: String(body.model), vorhanden: probe.modelle.slice(0, 6).join(', ') },
        });
      }
    }

    await anbieterWaehlen({
      anbieter: anbieter as never,
      baseUrl: body.baseUrl,
      model: body.model,
      fastModel: body.fastModel,
      userId,
    });
    return { ai: aiCapabilities(), selection: modelRegistry()?.current ?? null };
  });

  /** Nachsehen, was ein lokaler Dienst anbietet — ohne etwas umzustellen. */
  app.post('/api/ai/local-check', async (req, reply) => {
    const userId = requireUser(req);
    const self = store.getSelf(userId);
    if (self?.role !== 'owner' && self?.role !== 'admin') {
      return fehler(reply, 403, 'fehler.keinRecht', 'Dafür fehlt dir das Recht.');
    }
    const body = req.body as { baseUrl?: string };
    const adresse = (body.baseUrl || '').trim() || config.ai.ollama.baseUrl;
    return lokalePruefung(adresse);
  });

  /** Was der Anbieter anbietet und was davon gerade benutzt wird. */
  app.get('/api/ai/models', async (req) => {
    requireUser(req);
    const registry = modelRegistry();
    if (!registry) return { selection: null, models: [] };
    return {
      selection: registry.current,
      models: registry.discovered.map((m) => ({
        id: m.id,
        contextWindow: m.contextWindow,
        params: m.params,
        ownedBy: m.ownedBy,
        usable: m.rejected === null,
        rejected: m.rejected,
      })),
    };
  });

  /* ── Registrierung & Login ─────────────────────────────────── */

  /**
   * Selbstregistrierung gibt es nicht: Konten legt die Team-Leitung an und
   * gibt ein Einmal-Passwort weiter. Der Endpunkt bleibt nur bestehen, um
   * eine verständliche Antwort zu geben.
   */
  app.post('/api/auth/register', async (_req, reply) =>
    fehler(reply, 403, 'fehler.keineSelbstanmeldung',
      'Konten legt die Team-Leitung an. Frage nach einem Einmal-Passwort.'));

  /**
   * Die Wegbeschreibung für den Anmeldenachweis — VOR der Anmeldung, also
   * ohne jeden Nachweis abrufbar.
   *
   * WAS SIE VERRÄT: NICHTS. Sie antwortet auf jeden eingetippten Namen mit
   * derselben Art von Auskunft. Gibt es kein Konto — oder gibt es eines, das
   * noch keinen Nachweis hinterlegt hat —, kommt ein Salz, das aus dem
   * Servergeheimnis und dem Namen abgeleitet ist: für denselben Namen immer
   * dasselbe, von echtem Zufall nicht zu unterscheiden. Die drei Zustände
   * (Konto mit Nachweis / Konto ohne Nachweis / kein Konto) sehen von außen
   * gleich aus. Siehe salzFuer() in services/anmeldenachweis.ts.
   *
   * POST und nicht GET, obwohl nichts geschrieben wird: bei GET stünde der
   * Benutzername in der Adresse und damit in jedem Zugriffsprotokoll, in der
   * Verlaufsliste des Browsers und in jeder Weiterleitungskopfzeile. Diese
   * Aufgabe handelt davon, dass beim Anmelden weniger beim Server landet —
   * dann nicht ausgerechnet hier den Namen ins Protokoll schreiben.
   *
   * DIE BREMSE GILT AUCH HIER, aber nur lesend: wer schon zu oft falsch
   * geraten hat, bekommt auch kein Salz mehr. GEZÄHLT wird hier bewusst
   * nicht — sonst könnte jemand ein Konto von außen aussperren, indem er
   * bloß Salz abfragt, ohne je ein Passwort zu raten.
   */
  app.post('/api/auth/anmeldesalz', async (req, reply) => {
    const { login } = (req.body ?? {}) as { login?: unknown };
    /* Auf den TYP prüfen, nicht nur auf "irgendwas Wahres": ein Rumpf wie
       {"login":{}} kam an dieser Stelle durch und lief erst im .trim()
       darunter auf einen Fehler — eine 500 statt der 400, die hier
       hingehört. Keine Lücke, aber die falsche Antwort. */
    if (typeof login !== 'string' || !login) {
      return fehler(reply, 400, 'fehler.zugangsdatenFehlen', 'Zugangsdaten fehlen');
    }
    const herkunft = bremsSchluessel(req.ip, login);
    if (zuVieleVersuche(herkunft)) {
      return fehler(reply, 429, 'fehler.zuVieleVersuche',
        'Zu viele Versuche. Bitte eine Minute warten.');
    }
    const row = users.findByLogin(login);
    return anmeldenachweis.salzFuer(row?.id ?? null, login);
  });

  /**
   * Anmeldung — auf ZWEI Wegen, und der alte bleibt unangetastet.
   *
   * `password`  Der Weg, den es immer gab. Jede ältere App, jeder Browser
   *             mit gemerktem Bündel und jede Person, die nicht
   *             aktualisiert hat, kommt hier herein — auch bei einem Konto,
   *             das den neuen Weg längst benutzt. Das ist keine
   *             Übergangsfreundlichkeit, sondern die Sicherung dieses
   *             Umbaus: der Server steht auf einem Rechner, an den niemand
   *             herankommt, und ein Ausschluss wäre dort nicht
   *             zurückzunehmen.
   *
   * `nachweis`  Der neue Weg. Das Gerät hat PBKDF2 über das Passwort
   *             gerechnet (Salz von `/api/auth/anmeldesalz`), das Passwort
   *             selbst erreicht den Server nicht mehr. Damit kann auch ein
   *             Server, der in diesem Augenblick mitschriebe, den
   *             Kontoschlüssel nicht mehr herleiten — der Grund für die
   *             ganze Übung, siehe services/anmeldenachweis.ts.
   *
   * BEIDE WEGE HÄNGEN AN DERSELBEN BREMSE, demselben `herkunft`-Schlüssel
   * und demselben zeitgleichen Nein-Weg. Sie stehen absichtlich in EINER
   * Route und nicht in zweien: eine zweite Route wäre eine zweite Tür, an
   * der jemand die Bremse hätte vergessen können — der bequeme Weg wäre
   * dann der ungebremste gewesen.
   *
   * EIN FEHLGESCHLAGENER NACHWEIS IST EIN GEWÖHNLICHES 401 — dasselbe wie
   * ein falsches Passwort, dieselbe Kennung, dieselbe scrypt-Zeit. Kein
   * eigener Text für "dieses Konto hat noch keinen Nachweis": das wäre die
   * Auskunft, dass es das Konto gibt. Die App weiß, was zu tun ist, ohne
   * gesagt zu bekommen warum — sie fällt auf den alten Weg zurück und
   * hinterlegt danach einen Nachweis.
   */
  app.post('/api/auth/login', async (req, reply) => {
    const { login, password, nachweis } = (req.body ?? {}) as
      { login?: unknown; password?: unknown; nachweis?: unknown };
    /* Der Nachweis tritt an die Stelle des Passworts, nicht daneben. Kämen
       beide, wäre der Nachweis Zierat und das Passwort läge trotzdem beim
       Server — genau der Zustand, den diese Änderung abschafft. */
    const geheim = password || nachweis;
    /* Auf den TYP prüfen, nicht nur auf "irgendwas Wahres": {"login":{}}
       kam hier durch und starb erst im .trim() darunter, {"password":{}}
       erst im scrypt — beides eine 500, wo eine 400 hingehört. */
    if (typeof login !== 'string' || !login || typeof geheim !== 'string' || !geheim) {
      return fehler(reply, 400, 'fehler.zugangsdatenFehlen', 'Zugangsdaten fehlen');
    }

    // Wer es zu oft falsch versucht, wartet. scrypt macht jeden Versuch
    // ohnehin teuer, aber eine Bremse gehört an die Tür, nicht ins Schloss.
    const herkunft = bremsSchluessel(req.ip, login);
    if (zuVieleVersuche(herkunft)) {
      return fehler(reply, 429, 'fehler.zuVieleVersuche',
        'Zu viele Versuche. Bitte eine Minute warten.');
    }

    const row = users.findByLogin(login);
    /* Wogegen geprüft wird, hängt am WEG, nicht am Konto: wer ein Passwort
       schickt, wird gegen users.password_hash geprüft (unverändert), wer
       einen Nachweis schickt, gegen den hinterlegten Nachweis. Ein Konto,
       das noch keinen hat, liefert hier `null` — und dann greift derselbe
       Platzhalter wie bei einem Konto, das es gar nicht gibt. */
    const hinterlegt = password
      ? (row?.password_hash ?? null)
      : (row ? anmeldenachweis.nachweisHash(row.id) : null);

    // Auch bei unbekanntem Konto das Passwort prüfen, damit die Antwortzeit
    // nicht verrät, ob es den Benutzernamen gibt.
    const gueltig = hinterlegt
      ? verifyPassword(geheim, hinterlegt)
      : verifyPassword(geheim, '$scrypt$16384$8$1$AAAA$AAAA');

    if (!row || !gueltig) {
      versuchGezaehlt(herkunft);
      return fehler(reply, 401, 'fehler.loginFalsch', 'Benutzername oder Passwort stimmt nicht');
    }
    versucheZuruecksetzen(herkunft);
    if (row.disabled) {
      return fehler(reply, 403, 'fehler.kontoGesperrt',
        'Dieses Konto ist gesperrt. Wende dich an die Team-Leitung.');
    }
    return { token: signToken(row.id), user: store.getSelf(row.id) };
  });

  /**
   * Einen Anmeldenachweis hinterlegen — von einem Gerät, das sich gerade
   * klassisch angemeldet hat und deshalb das Passwort im Klartext hatte.
   *
   * Braucht ein Token, also eine bestandene Anmeldung. Das ist der ganze
   * Wächter und er reicht: wer sich anmelden konnte, kannte das Passwort,
   * und ein Nachweis, den er daraus ableitet, gehört zu genau diesem Konto.
   *
   * NICHT in OHNE_EINRICHTUNG_ERLAUBT (server/src/index.ts), und das ist
   * Absicht: wer noch mit einem Einmal-Passwort dasteht, soll dafür keinen
   * Nachweis hinterlegen — das Passwort wird gleich ersetzt und der Nachweis
   * wäre schon beim Anlegen veraltet. Der Einrichtungsriegel weist diesen
   * Weg in genau diesem Zustand von selbst ab; die App fängt das ab und
   * versucht es bei der nächsten Anmeldung wieder.
   */
  app.post('/api/auth/nachweis', async (req, reply) => {
    const userId = requireFrischenUser(req, 10 * 60_000);
    const blob = req.body as AnmeldeNachweisBlob;
    try {
      anmeldenachweis.hinterlegen(userId, blob);
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
    return { ok: true };
  });

  /** Ersteinrichtung nach dem Einmal-Passwort. */
  app.post('/api/auth/setup', async (req, reply) => {
    const userId = requireUser(req);
    const body = req.body as { handle?: string; email?: string; displayName?: string; newPassword?: string };
    if (!body.newPassword) return fehler(reply, 400, 'fehler.neuesPasswortFehlt', 'Neues Passwort fehlt');
    try {
      users.completeSetup(userId, {
        handle: body.handle, email: body.email,
        displayName: body.displayName, newPassword: body.newPassword,
      });
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
    return { user: store.getSelf(userId) };
  });

  /**
   * Passwort selbst ändern — und dabei den Kontoschlüssel mitnehmen.
   *
   * `kontoSchluessel` ist der bestehende Kontoschlüssel, von der App neu
   * umschlossen. Nur sie kann das: in diesem Augenblick hat sie beide
   * Passwörter im Klartext, der Server keines von beiden dauerhaft und den
   * abgeleiteten Schlüssel nie. Fehlt das Feld (ältere App), läuft der
   * Wechsel trotzdem durch — siehe changeOwnPassword() in services/users.ts
   * für die ausführliche Begründung, warum Ablehnen hier schlechter wäre.
   */
  app.post('/api/auth/password', async (req, reply) => {
    const userId = requireUser(req);
    const { current, next, kontoSchluessel } = req.body as {
      current?: string; next?: string; kontoSchluessel?: KontoSchluesselBlob;
    };
    if (!current || !next) return fehler(reply, 400, 'fehler.beidePasswoerter', 'Beide Passwörter angeben');
    try {
      users.changeOwnPassword(userId, current, next, verifyPassword, kontoSchluessel);
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
    return { ok: true };
  });

  /* ── Der Kontoschlüssel ─────────────────────────────────────
     Über HTTP und nicht über den Draht (ws/gateway.ts), obwohl alles andere
     an den Notizen dort läuft: gebraucht wird er im Augenblick der
     Anmeldung, und da steht die Verbindung noch nicht. Der Server verwahrt
     hier nur Bytes — siehe services/kontoschluessel.ts. */

  /**
   * Den eigenen, verschlossenen Kontoschlüssel abholen.
   *
   * `notzugangWartet` ist das Feld, ohne das der Notzugang sich selbst
   * zerstörte. Nach einem schonenden Verwerfen (services/kontoschluessel.ts)
   * steht hier `schluessel: null` — die Passworthülle ist tot, der Schlüssel
   * dahinter lebt aber weiter und wartet auf drei Anteile. Eine App, die nur
   * die Null sieht, mintet nach ihrer eigenen Regel einen frischen
   * Kontoschlüssel und räumt damit alles weg, was gerade gerettet werden
   * soll. Dieses Feld sagt ihr: Finger weg, hier läuft eine
   * Wiederherstellung. (Der Server weist einen Ersatz zusätzlich ab — das
   * Feld ist die Höflichkeit, die Abweisung die Sicherung.)
   *
   * Die Auskunft kommt aus kontoschluessel.notzugangWartet() und wird hier
   * NICHT ein zweites Mal ausgerechnet. Hier stand
   * `!schluessel && notzugang.standFuer(userId).eingerichtet` — eine andere
   * Rechnung als die, mit der der Server nebenan über Annehmen oder Abweisen
   * entscheidet. Zwei Rechnungen für eine Frage widersprechen sich
   * irgendwann, und hier taten sie es in beide Richtungen: die App bekam
   * „Finger weg", während der Server einen Ersatz annahm, und umgekehrt.
   */
  app.get('/api/konto/schluessel', async (req) => {
    const userId = requireUser(req);
    return {
      schluessel: kontoschluessel.holen(userId),
      notzugangWartet: kontoschluessel.notzugangWartet(userId),
    };
  });

  /**
   * Hinterlegen — umschließen oder ersetzen, entschieden am Abdruck (siehe
   * services/kontoschluessel.ts). Die Antwort trägt die Fassung zurück: ohne
   * sie dürfte das Gerät kein einziges Notiz-Kontopaket schreiben.
   */
  app.post('/api/konto/schluessel', async (req, reply) => {
    const userId = requireUser(req);
    const blob = req.body as KontoSchluesselBlob;
    try {
      return { fassung: kontoschluessel.hinterlegen(userId, blob) };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  /* ── Der Notzugang: „3 von 5" ────────────────────────────────
     Auch hier über HTTP und nicht über den Draht, aus demselben Grund wie
     beim Kontoschlüssel darüber: gebraucht wird das rund um die Anmeldung.
     Der Server verwahrt Bytes und zählt — siehe services/notzugang.ts. */

  /**
   * Der eigene Stand: eingerichtet, wer hält, wie viele Anteile heute noch
   * brauchbar sind, und ob gerade eine Wiederherstellung läuft.
   *
   * `notzugangWartet` kommt aus `kontoschluessel.notzugangWartet(userId)` —
   * DERSELBEN Rechnung, die GET /api/konto/schluessel weiter oben schon
   * ausgibt, und nicht aus einer zweiten. `notzugang.standFuer()` kennt sie
   * bewusst nicht (siehe dort): der einzige Ort, an dem beide Dienste schon
   * zusammenkommen, ist hier.
   */
  const standMitWartet = (userId: string) => (
    { ...notzugang.standFuer(userId), notzugangWartet: kontoschluessel.notzugangWartet(userId) }
  );

  app.get('/api/konto/notzugang', async (req) => {
    const userId = requireUser(req);
    return {
      stand: standMitWartet(userId),
      huelle: notzugang.huelleHolen(userId),
      anfrage: notzugang.eigeneAnfrage(userId),
      protokoll: notzugang.protokollFuer(userId),
    };
  });

  /** Einrichten oder erneuern. Alles fertig verschlossen aus der App. */
  app.post('/api/konto/notzugang', async (req, reply) => {
    const userId = requireUser(req);
    const { huelle, anteile } = req.body as {
      huelle?: NotzugangHuelle; anteile?: NotzugangAnteilBlob[];
    };
    if (!huelle || !Array.isArray(anteile)) {
      return fehler(reply, 400, 'fehler.notzugangUngueltig', 'Der Notzugang ist unvollständig.');
    }
    try {
      notzugang.einrichten(userId, huelle, anteile);
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
    return { stand: standMitWartet(userId) };
  });

  /**
   * Den eigenen Notzugang aufheben.
   *
   * `verbrannt` geht mit zurück — vorher endete die Antwort bei `{ ok: true
   * }`, ganz gleich, ob der Klick nur die Rettungsleine kappte oder eben
   * noch Notizen und Passwort-Tresor endgültig gelöscht hat. Der Browser-
   * Aufbau, ein direkter API-Aufruf oder eine Tafel mit einem veralteten
   * `stand`-Stand (NotzugangPanel.tsx lädt ihn beim Öffnen einmal) konnten
   * die Rückfrage im Renderer umgehen; die Meldung DANACH log ehrlich sein,
   * ganz gleich, ob die Rückfrage lief.
   *
   * Kein Notzugang zum Aufheben da (schon aufgehoben, nie eingerichtet) ->
   * notzugang.aufheben() weist mit `fehler.notzugangNichtVorhanden` ab,
   * statt ein zweites Mal niederzubrennen (siehe dort).
   */
  app.delete('/api/konto/notzugang', async (req, reply) => {
    const userId = requireUser(req);
    try {
      const verbrannt = notzugang.aufheben(userId, userId);
      return { ok: true, verbrannt };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  /**
   * Den Notzugang einer ANDEREN Person aufheben — mit `user.manage`.
   *
   * Das ist der einzige Griff, den die Verwaltung an einem fremden Notzugang
   * hat, und er geht nur in eine Richtung: er ZERSTÖRT die Rettungsleine und
   * öffnet nichts. Gebraucht wird er für den Fall, für den der Notzugang
   * gerade NICHT gedacht ist — ein durchgesickertes (statt vergessenes)
   * Passwort.
   *
   * Die Reihenfolge ist dabei egal geworden, und das war sie nicht immer:
   * „erst aufheben, dann zurücksetzen" ließ kontoschluessel.verwerfen() in
   * den harten Zweig laufen, „erst zurücksetzen, dann aufheben" nicht — dort
   * schonte das Zurücksetzen die Pakete und das Aufheben sah den
   * Kontoschlüssel gar nicht an. Seither holt notzugang.aufheben() das
   * Niederbrennen selbst nach, wenn keine Passworthülle mehr dasteht.
   *
   * Zurück geht die Kontenliste, wie bei jedem anderen Griff der Verwaltung
   * daneben: `hatNotzugang` und `notzugangAufhebenVerbrennt` stehen darin
   * (services/store.ts), und TeamAdmin.tsx zeigt daran VOR dem Klick, ob ein
   * Zurücksetzen — bzw. dieser Klick selbst, siehe unten — den
   * Kontoschlüssel verbrennt. Ohne die frische Liste behauptete sie nach dem
   * Aufheben weiter das Gegenteil.
   *
   * Und `verbrannt` geht zusätzlich zurück, NEBEN der Liste: die Liste sagt
   * nur noch, wie es JETZT steht, nicht mehr, was der gerade abgeschickte
   * Klick bewirkt hat — ein Konto, dessen Kontoschlüssel gerade eben
   * verbrannt ist, sieht danach genauso aus wie eines, das nie einen hatte.
   * TeamAdmin.tsx braucht beides: die Liste für die nächste Anzeige, den
   * Rückgabewert für die Meldung ÜBER DIESEN Klick.
   */
  app.delete('/api/admin/notzugang/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const ziel = store.getUser(id);
    if (!ziel) return fehler(reply, 404, 'fehler.kontoNichtGefunden', 'Konto nicht gefunden');

    /* DIESELBEN ZWEI SPERREN WIE BEIM ZURÜCKSETZEN (weiter unten,
       /api/admin/users/:id/reset-password). Sie fehlten hier, und der
       Unterschied war nicht klein: `user.manage` allein genügte, um die
       Rettungsleine JEDER Person zu kappen — auch die des Inhabers, und auch
       die einer Person, deren Passwort dieselbe Person nicht zurücksetzen
       darf.

       Dass das Aufheben nichts ÖFFNET, trägt als Begründung nicht mehr. Es
       stimmt weiterhin (siehe services/notzugang.ts, Dateikopf), aber der
       Griff steht nicht mehr allein da: er brennt seit dieser Fassung den
       Kontoschlüssel selbst nieder, sobald keine Passworthülle mehr dasteht
       — und in jedem anderen Fall macht er aus dem nächsten, gewöhnlichen
       Zurücksetzen die vollständige Vernichtung von Notizen und Tresor. Wer
       ein Konto nicht übernehmen darf, darf es auch nicht so weit bringen. */
    if (ziel.role === 'owner' && id !== userId) {
      return fehler(reply, 403, 'fehler.ownerNotzugangSelbst',
        'Den Notzugang des Owners kann nur er selbst aufheben.');
    }
    const fehltZurUebernahme = fehlendesRechtZurUebernahme(userId, id);
    if (fehltZurUebernahme) {
      const name = PERMISSIONS.find((p) => p.key === fehltZurUebernahme)?.labelDe ?? fehltZurUebernahme;
      return fehler(reply, 403, 'fehler.keinRechtName',
        `Dafür fehlt dir das Recht "${name}".`, { recht: name });
    }

    /* Kein Notzugang zum Aufheben da (schon aufgehoben, ein Wettlauf zweier
       Klicks, ein Skript, das die Route noch einmal trifft) -> Abweisung
       statt eines zweiten, stillen Niederbrennens. Siehe
       services/notzugang.ts, aufheben(). */
    let verbrannt: boolean;
    try {
      verbrannt = notzugang.aufheben(id, userId);
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }

    /* UND DIE PERSON ERFÄHRT ES. Bisher stand das Aufheben nur in ihrer
       eigenen Tafel — sichtbar für den, der sie aufschlägt, also frühestens
       an dem Tag, an dem er die Rettungsleine braucht und sie nicht mehr
       findet. Zwei Texte, weil es zwei verschiedene Nachrichten sind: die
       Leine ist weg, oder Notizen und Tresor sind es auch. Ein Schaden, den
       die betroffene Person erst Wochen später bemerkt, ist ein Schaden, den
       niemand mehr einordnen kann. */
    const durch = store.getSelf(userId)?.displayName ?? '';
    void push.sendenAn(id, {
      titel: { text: 'Notzugang aufgehoben', code: 'notzugang.pushAufgehobenTitel' as const },
      text: verbrannt
        ? {
            text: `${durch} hat deinen Notzugang aufgehoben. Notizen und Tresor sind damit endgültig verloren.`,
            code: 'notzugang.pushAufgehobenVerbrannt',
            werte: { name: durch },
          }
        : {
            text: `${durch} hat deinen Notzugang aufgehoben. Ein vergessenes Passwort holt dich jetzt nicht mehr zurück.`,
            code: 'notzugang.pushAufgehoben',
            werte: { name: durch },
          },
      gruppe: 'notzugang',
    });

    /* `verbrannt` geht auch an die Verwaltung zurück, nicht nur an die
       betroffene Person im Push oben — siehe TeamAdmin.tsx: derselbe Knopf,
       dieselbe Beschriftung, zwei ganz verschiedene Ausgänge, und die
       Verwaltung erfuhr bisher keinen davon zuverlässig, sondern nur einen
       festen Erfolgstext. */
    return { ok: true, verbrannt, users: store.listManagedUsers() };
  });

  /** Eine Wiederherstellung anstoßen. Der Code selbst bleibt auf dem Gerät —
   *  hier kommt nur sein Abdruck an. */
  app.post('/api/konto/notzugang/anfrage', async (req, reply) => {
    const userId = requireUser(req);
    const { codeAbdruck } = req.body as { codeAbdruck?: string };
    if (!codeAbdruck) return fehler(reply, 400, 'fehler.notzugangUngueltig', 'Der Code fehlt.');
    try {
      return { anfrage: notzugang.anfragen(userId, codeAbdruck) };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  /** Die eigene Anfrage zurückziehen. */
  app.delete('/api/konto/notzugang/anfrage/:id', async (req, reply) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    try {
      notzugang.abbrechen(userId, id);
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
    return { ok: true };
  });

  /** Was auf mich als haltende Person wartet — samt meinem verschlossenen
   *  Anteil, der ohne meinen privaten Schlüssel nichts hergibt. */
  app.get('/api/konto/notzugang/aufgaben', async (req) => {
    const userId = requireUser(req);
    return { aufgaben: notzugang.aufgabenFuer(userId) };
  });

  /** Einen Anteil beisteuern — doppelt verschlossen, fertig aus der App. */
  app.post('/api/konto/notzugang/beitrag', async (req, reply) => {
    const userId = requireUser(req);
    const { anfrageId, paket, codeAbdruck } = req.body as {
      anfrageId?: string; paket?: FluechtigesPaket; codeAbdruck?: string;
    };
    if (!anfrageId || !paket || !codeAbdruck) {
      return fehler(reply, 400, 'fehler.notzugangUngueltig', 'Der Notzugang ist unvollständig.');
    }
    try {
      notzugang.beitragen(userId, anfrageId, paket, codeAbdruck);
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
    return { ok: true };
  });

  /**
   * Die gesammelten Beiträge zur eigenen Anfrage.
   *
   * UND DIE STELLE, AN DER DIE MELDUNG RAUSGEHT. Sie hing bisher allein an
   * `/einloesen`, und das ruft die App, NACHDEM sie den Kontoschlüssel schon
   * zurückhat (lib/notzugang.ts). Eine App, die diesen letzten Aufruf
   * wegließe, käme lautlos an einen fremden Kontoschlüssel. Hier dagegen
   * gehen die Anteile tatsächlich über die Leitung — ab der Schwelle ist der
   * Notschlüssel rechnerisch erreichbar, und genau das ist das Ereignis, über
   * das zu berichten ist. `herausgabeVermerken()` schreibt die Spur und gibt
   * die zu benachrichtigenden Personen genau einmal je Anfrage zurück; ein
   * zweiter Abruf löst keine zweite Meldung aus.
   */
  app.get('/api/konto/notzugang/beitraege/:id', async (req, reply) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    let beitraege;
    try {
      beitraege = notzugang.beitraegeHolen(userId, id);
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
    const zuMelden = notzugang.herausgabeVermerken(userId, id);
    if (zuMelden.length) {
      const name = store.getSelf(userId)?.displayName ?? '';
      /* Die Zahl im Text ist die GESAMTZAHL der herausgegebenen Anteile, nicht
         die der neu gemeldeten. `zuMelden` enthält seit der Meldung je Person
         (services/notzugang.ts) beim Nachzügler nur noch einen einzigen Namen
         — „1 Anteile" stünde dann auf dem Sperrbildschirm, und die Meldung
         wäre obendrein falsch: es sind vier unterwegs, nicht einer.
         `beitraege` ist genau die Liste, die der Server soeben herausgegeben
         hat, also die richtige Zahl. Sie ist nie kleiner als die Schwelle —
         darunter meldet herausgabeVermerken() gar nichts. */
      for (const ziel of [userId, ...zuMelden]) {
        void push.sendenAn(ziel, {
          titel: { text: 'Notzugang: Anteile herausgegeben', code: 'notzugang.pushHerausgegebenTitel' as const },
          text: {
            text: `Für den Notzugang von ${name} wurden ${beitraege.length} Anteile an ein Gerät herausgegeben.`,
            code: 'notzugang.pushHerausgegeben',
            werte: { name, n: String(beitraege.length) },
          },
          gruppe: 'notzugang',
        });
      }
    }
    return { beitraege };
  });

  /**
   * Die Anfrage schließen, nachdem das Gerät den Kontoschlüssel wiederhat.
   *
   * Hier entsteht die Spur und hier gehen die Meldungen raus — an die
   * besitzende Person selbst (sie soll es auch dann erfahren, wenn nicht sie
   * am Gerät saß) und an jede Person, deren Anteil verbraucht wurde. Ein
   * Vorgang, bei dem jemand für einen Augenblick einen fremden
   * Kontoschlüssel in der Hand hält, darf nicht lautlos sein.
   */
  app.post('/api/konto/notzugang/einloesen', async (req, reply) => {
    const userId = requireUser(req);
    const { anfrageId } = req.body as { anfrageId?: string };
    if (!anfrageId) return fehler(reply, 400, 'fehler.notzugangAnfrageFehlt', 'Diese Anfrage gibt es nicht.');
    let beteiligte: string[];
    try {
      beteiligte = notzugang.einloesen(userId, anfrageId);
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
    const name = store.getSelf(userId)?.displayName ?? '';
    const titel = { text: 'Notzugang eingelöst', code: 'notzugang.pushTitel' as const };
    for (const ziel of [userId, ...beteiligte]) {
      void push.sendenAn(ziel, {
        titel,
        text: {
          text: `Der Notzugang von ${name} wurde mit ${beteiligte.length} Anteilen eingelöst.`,
          code: 'notzugang.pushEingeloest',
          werte: { name, n: String(beteiligte.length) },
        },
        gruppe: 'notzugang',
      });
    }
    return { ok: true, beteiligte };
  });

  /* ── Kontenverwaltung ───────────────────────────────────────── */

  /**
   * Prüft ein Recht und wirft eine sprechende Antwort, wenn es fehlt.
   *
   * WARUM AN DIESEM WURF EINE KENNUNG HÄNGT
   *
   * Dieser Wurf bewacht sechsundfünfzig Routen, und von seinem deutschen Satz
   * kam bei niemandem je etwas an. Ein GEWORFENER Fehler geht nicht durch
   * `fehler()` weiter unten, sondern durch Fastifys eigene Ausgabe, und die
   * schreibt genau vier Felder: `statusCode`, `code`, `error`, `message`.
   * `error` ist dort NICHT der deutsche Satz, sondern der Name des
   * Statuscodes — „Forbidden". Der deutsche Satz landet in `message`, und
   * genau die liest die Oberfläche nicht: `request()` in
   * desktop/src/net/api.ts nimmt `error` und `code`. Ergebnis: in allen
   * zweiundzwanzig Sprachen, Deutsch eingeschlossen, stand als Begründung das
   * blanke englische Wort „Forbidden".
   *
   * `code` ist das einzige Feld, das Fastify von einem geworfenen Fehler
   * ungefragt durchreicht (nachgemessen), und es genügt: hinaus geht die
   * Wörterbuchadresse des fehlenden Rechts, `perm.<recht>.label`. Die gibt es
   * in allen zweiundzwanzig Wörterbüchern, und die Oberfläche schlägt eine
   * Kennung ohnehin zuerst nach (`uebersetzterFehler()` dort). Damit steht
   * ohne eine einzige Änderung am Client ab jetzt der NAME des Rechts in der
   * eingestellten Sprache, wo vorher „Forbidden" stand.
   *
   * Der deutsche Satz bleibt trotzdem stehen: er ist der Rückfall für alles,
   * was die Kennung nicht kennt — dieselbe Aufteilung wie bei `fehler()`.
   *
   * Ein `setErrorHandler` wäre der andere Weg. Der gehört nicht in diese
   * Datei; was am Client noch fehlt, damit aus dem Namen ein ganzer Satz
   * wird ('fehler.keinRechtName' steht mit Platzhalter schon in allen
   * zweiundzwanzig Wörterbüchern), steht im Bericht.
   */
  function requirePermission(userId: string, permission: PermissionKey): void {
    if (users.may(userId, permission)) return;
    const info = PERMISSIONS.find((p) => p.key === permission);
    const err = new Error(`Dafür fehlt dir das Recht "${info?.labelDe ?? permission}".`) as Error & {
      statusCode?: number; code?: string;
    };
    err.statusCode = 403;
    err.code = `perm.${permission}.label`;
    throw err;
  }

  /** Die immer gleiche Abweisung für Punkt 2 und 3. */
  function rolleAbweisen(reply: FastifyReply, rolle: MemberRole) {
    const name = roleInfo(rolle)?.labelDe ?? rolle;
    return fehler(reply, 403, 'fehler.rolleZuHoch',
      `Die Rolle „${name}" kannst du nicht vergeben — sie reicht mindestens so weit wie deine eigene.`,
      { rolle: name });
  }

  app.get('/api/permissions', async (req) => {
    requireUser(req);
    return { permissions: PERMISSIONS };
  });

  app.get('/api/admin/users', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    return { users: store.listManagedUsers() };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.invite');
    const body = req.body as {
      displayName?: string; handle?: string; email?: string;
      role?: MemberRole; language?: string; timezone?: string;
    };
    if (!body.displayName) return fehler(reply, 400, 'fehler.nameFehlt', 'Name fehlt');

    /* Die Rolle wird HIER geprüft, an der Grenze, und nicht weiter innen:
       hinter dieser Route steht mit `createAccount()` ein INSERT, der
       `input.role ?? 'member'` ungeprüft übernimmt (services/users.ts) — die
       Spalte hat kein CHECK, die Route kein `schema:`, und `MemberRole` ist
       zur Laufzeit nichts. Ohne diese Zeilen war „welche Rolle bekommt das
       neue Konto" eine freie Angabe des Aufrufers. Siehe die ausgeschriebene
       Regel bei `darfRolleVergeben()` weiter oben. */
    const rolle = body.role === undefined ? 'member' : rolleLesen(body.role);
    if (!rolle) {
      return fehler(reply, 400, 'fehler.rolleUnbekannt',
        `Unbekannte Rolle „${String(body.role)}".`, { rolle: String(body.role) });
    }
    if (rolle === 'owner' && store.getSelf(userId)?.role !== 'owner') {
      return fehler(reply, 403, 'fehler.nurOwnerErnennt', 'Nur der Owner kann einen weiteren Owner ernennen.');
    }
    if (!darfRolleVergeben(userId, rolle)) return rolleAbweisen(reply, rolle);

    try {
      /* Feld für Feld statt `...body`: was der Aufrufer sonst noch mitschickt,
         hat in einem INSERT nichts verloren — und `role` käme beim Streuen
         ungeprüft wieder herein, direkt neben der Prüfung, die es gerade
         abgefangen hat. */
      const konto = users.createAccount({
        displayName: body.displayName,
        handle: body.handle,
        email: body.email,
        role: rolle,
        language: body.language,
        timezone: body.timezone,
        createdBy: userId,
      });
      const person = store.getUser(konto.userId);
      // Ohne diese Meldung lernten die anderen Clients das neue Konto erst
      // beim nächsten Neuladen kennen — bis dahin ließe es sich nicht erwähnen.
      if (person) broadcastAll({ t: 'user:upsert', user: person });
      return {
        credential: {
          userId: konto.userId,
          handle: konto.handle,
          displayName: person?.displayName ?? body.displayName,
          oneTimePassword: konto.oneTimePassword,
          expiresAt: Date.now() + 14 * 86_400_000,
        },
        users: store.listManagedUsers(),
      };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const ziel = store.getUser(id);
    if (!ziel) return fehler(reply, 404, 'fehler.kontoNichtGefunden', 'Konto nicht gefunden');
    if (ziel.role === 'owner' && id !== userId) {
      return fehler(reply, 403, 'fehler.ownerPasswortSelbst', 'Das Passwort des Owners kann nur er selbst zurücksetzen.');
    }
    /* Die zweite Tür in denselben Raum — ausgeschriebene Begründung bei
       `fehlendesRechtZurUebernahme()` weiter oben. Kurz: das Einmal-Passwort
       geht gleich unten im Antwortkörper an genau diese Person hinaus, und
       wer es hat, IST dieses Konto. Also darf nur zurücksetzen, wer jedes
       Recht des Ziels ohnehin schon selbst hat. Die Sperre steht hier an der
       Grenze und nicht in `users.resetPassword()` — dieselbe Aufteilung wie
       bei `darfRolleVergeben()`/`users.setRole()`. */
    const fehltZurUebernahme = fehlendesRechtZurUebernahme(userId, id);
    if (fehltZurUebernahme) {
      const name = PERMISSIONS.find((p) => p.key === fehltZurUebernahme)?.labelDe ?? fehltZurUebernahme;
      return fehler(reply, 403, 'fehler.keinRechtName',
        `Dafür fehlt dir das Recht "${name}".`, { recht: name });
    }
    try {
      const passwort = users.resetPassword(id, userId);
      return {
        credential: {
          userId: id, handle: ziel.handle, displayName: ziel.displayName,
          oneTimePassword: passwort, expiresAt: Date.now() + 14 * 86_400_000,
        },
        users: store.listManagedUsers(),
      };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.post('/api/admin/users/:id/role', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const rolle = rolleLesen((req.body as { role?: unknown })?.role);
    if (!rolle) {
      const roh = (req.body as { role?: unknown })?.role;
      return fehler(reply, 400, 'fehler.rolleUnbekannt',
        `Unbekannte Rolle „${String(roh)}".`, { rolle: String(roh) });
    }
    if (rolle === 'owner' && store.getSelf(userId)?.role !== 'owner') {
      return fehler(reply, 403, 'fehler.nurOwnerRolle', 'Nur der Owner kann diese Rolle vergeben.');
    }
    /* Die eigene Rolle bleibt tabu. Sonst könnte sich jeder mit 'user.manage'
       selbst hochstufen — die Rechteverwaltung wäre dann nur noch Zierde. */
    if (id === userId) {
      return fehler(reply, 403, 'fehler.eigeneRolle', 'Die eigene Rolle lässt sich nicht ändern.');
    }
    /* Ein FREMDES Konto hochzustufen war der eigentliche Weg nach oben, und
       er war offen: gesperrt war nur `owner` und man selbst. Wer `user.manage`
       hatte, machte ein beliebiges Konto zum Administrator, setzte ihm gleich
       danach das Passwort zurück (die Antwort dort enthält das Einmal-
       Passwort im Klartext) und meldete sich als dieses Konto an. Die
       ausgeschriebene Regel steht bei `darfRolleVergeben()` weiter oben. */
    if (!darfRolleVergeben(userId, rolle)) return rolleAbweisen(reply, rolle);

    try {
      users.setRole(id, rolle, userId);
      return { users: store.listManagedUsers() };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.post('/api/admin/users/:id/permission', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'permission.manage');
    const { id } = req.params as { id: string };
    const { permission, allowed } = req.body as { permission?: PermissionKey; allowed?: boolean | null };
    if (!permission) return fehler(reply, 400, 'fehler.rechtFehlt', 'Recht fehlt');
    // Wer sich selbst Rechte zurückgeben kann, dem kann man keine nehmen.
    if (id === userId) {
      return fehler(reply, 403, 'fehler.eigeneRechte', 'Eigene Rechte lassen sich nicht ändern.');
    }
    try {
      users.setPermission(id, permission, allowed ?? null, userId);
      return { users: store.listManagedUsers() };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  /** Ein Konto in eine andere Schublade legen. */
  app.post('/api/admin/users/:id/kategorie', async (req, reply) => {
    const userId = requireUser(req);
    if (!may(userId, 'user.manage')) {
      return fehler(reply, 403, 'fehler.keinRecht', 'Dafür fehlt dir das Recht.');
    }
    const { id } = req.params as { id: string };
    const body = req.body as { kategorie?: string | null };
    const wert = body.kategorie ? String(body.kategorie) : null;
    if (wert && !KONTO_KATEGORIEN.includes(wert as never)) {
      return fehler(reply, 400, 'fehler.kategorieUnbekannt',
        `Unbekannte Kategorie "${wert}".`, { kategorie: String(wert) });
    }
    // Gelöschte bleiben gelöscht — dafür gibt es keine andere Schublade.
    const ziel = store.listManagedUsers().find((u) => u.id === id);
    if (!ziel) return fehler(reply, 404, 'fehler.kontoNichtGefunden', 'Konto nicht gefunden.');
    if (ziel.deletedAt) return fehler(reply, 400, 'fehler.geloeschtEinsortieren', 'Gelöschte Konten lassen sich nicht einsortieren.');

    db.run('UPDATE users SET kategorie = ? WHERE id = ?', wert, id);
    return { users: store.listManagedUsers() };
  });

  app.post('/api/admin/users/:id/disabled', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const { disabled } = req.body as { disabled?: boolean };
    try {
      users.setDisabled(id, Boolean(disabled));
      const person = store.getUser(id);
      if (person) broadcastAll({ t: 'user:upsert', user: person });
      return { users: store.listManagedUsers() };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.delete');
    const { id } = req.params as { id: string };
    if (id === userId) return fehler(reply, 400, 'fehler.eigenesKontoLoeschen', 'Das eigene Konto lässt sich nicht löschen.');
    try {
      users.deleteAccount(id);
      // Wer gerade verbunden ist, fliegt sofort heraus — sonst liest das
      // gelöschte Konto weiter mit, bis sein Token abläuft.
      sitzungenBeenden(id);
      // Der Eintrag bleibt als "Ehemaliges Mitglied" bestehen; alle sollen das
      // sofort sehen, statt weiter einen aktiven Kontakt anzuzeigen.
      const person = store.getUser(id);
      if (person) broadcastAll({ t: 'user:upsert', user: person });
      return { users: store.listManagedUsers() };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.get('/api/me', async (req, reply) => {
    const userId = bearer(req);
    if (!userId) return fehler(reply, 401, 'fehler.nichtAngemeldet', 'Nicht angemeldet');
    const self = store.getSelf(userId);
    if (!self) return fehler(reply, 401, 'fehler.kontoWeg', 'Konto existiert nicht mehr');
    return { user: self, ai: aiCapabilities() };
  });

  /* ── Profilbild ────────────────────────────────────────────────
     Ohne :id, gebunden an den Absender des Tokens — jeder darf so nur sein
     eigenes ändern, es gibt keine Kennung, die auf ein fremdes Konto
     zeigen könnte. Größe, Bildart und Neuaufbau prüft ausschließlich
     services/avatare.ts; hier steht nur das Entgegennehmen, das Umbiegen
     der Datenbankzeile und das Nachrichten an alle (siehe user:upsert). */

  /**
   * Wessen Profilbild gerade gespeichert wird.
   *
   * Zwischen dem Lesen der bisherigen Adresse und dem UPDATE liegen zwei
   * `await` — das Bild wird neu aufgebaut und abgelegt. Zwei Speicherungen
   * kurz hintereinander (zweimal geklickt, ein Zuschnitt gleich korrigiert)
   * überholen einander in dieser Lücke: beide lesen dieselbe alte Adresse,
   * beide legen eine Datei ab, und das zuletzt eintreffende UPDATE gewinnt —
   * nicht das zuletzt gewollte. Danach steht in der Datenbank der Zuschnitt,
   * den die Person gerade ERSETZT hat, die andere Datei liegt herrenlos im
   * Verzeichnis, und weil Profilbilder mit `cache-control: immutable`
   * ausgeliefert werden, bleibt das falsche Bild ein Jahr lang kleben.
   *
   * Deshalb: eins nach dem anderen, je Konto. Der Anspruch wird gesetzt,
   * bevor überhaupt der Rumpf gelesen wird — `requireUser()` davor ist
   * synchron, es kann sich also niemand dazwischenschieben.
   */
  const avatarLaeuft = new Set<string>();

  app.post('/api/me/avatar', async (req, reply) => {
    const userId = requireUser(req);
    if (avatarLaeuft.has(userId)) {
      return fehler(reply, 409, 'fehler.avatarLaeuft',
        'Dein Profilbild wird gerade schon gespeichert.');
    }
    avatarLaeuft.add(userId);
    try {
      const file = await req.file({ limits: { fileSize: avatare.AVATAR_MAX_BYTES } });
      if (!file) return fehler(reply, 400, 'fehler.keineDatei', 'Keine Datei im Request');

      // Klein genug für den ganzen Rutsch im Speicher — die Obergrenze oben
      // greift schon beim Empfangen, nicht erst hier.
      const roh = await file.toBuffer();
      if (file.file.truncated) {
        return fehler(reply, 413, 'fehler.dateiZuGross',
          `Datei überschreitet ${avatare.AVATAR_MAX_BYTES / 1024 / 1024} MB`,
          { mb: String(avatare.AVATAR_MAX_BYTES / 1024 / 1024) });
      }

      try {
        const bisherige = db.get<{ avatar_url: string | null }>(
          'SELECT avatar_url FROM users WHERE id = ?', userId,
        )?.avatar_url ?? null;

        const bild = await avatare.verarbeiten(roh);
        const neueUrl = await avatare.ablegen(userId, bild);
        db.run('UPDATE users SET avatar_url = ? WHERE id = ?', neueUrl, userId);
        /* Erst jetzt die alte Datei weg — die Datenbank zeigt schon auf die
           neue, ein Fehlschlag beim Löschen kann also nichts mehr zerreißen. */
        await avatare.entfernen(bisherige);

        const user = store.getUser(userId);
        // Ohne diese Meldung sähen die anderen das neue Bild erst nach einem
        // Neustart der App — derselbe Weg wie bei jeder anderen Profiländerung.
        if (user) broadcastAll({ t: 'user:upsert', user });
        return { user };
      } catch (err) {
        return weiterreichen(reply, 400, err);
      }
    } finally {
      // Auch wenn oben etwas geworfen hat: sonst könnte dieses Konto nie
      // wieder ein Profilbild setzen.
      avatarLaeuft.delete(userId);
    }
  });

  app.delete('/api/me/avatar', async (req) => {
    const userId = requireUser(req);
    const bisherige = db.get<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = ?', userId,
    )?.avatar_url ?? null;
    db.run('UPDATE users SET avatar_url = NULL WHERE id = ?', userId);
    await avatare.entfernen(bisherige);

    const user = store.getUser(userId);
    if (user) broadcastAll({ t: 'user:upsert', user });
    return { user };
  });

  /**
   * Ein unpassendes Bild entfernen — dasselbe Recht wie beim Sperren eines
   * Kontos: wer Konten verwaltet (user.manage), darf auch ihr Bild
   * entfernen. Ein eigenes Recht dafür gäbe es zu wenig zu verwalten, um
   * eine eigene Zeile in der Rechteliste zu rechtfertigen.
   */
  app.delete('/api/admin/users/:id/avatar', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const bisherige = db.get<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = ?', id,
    )?.avatar_url;
    if (bisherige === undefined) return fehler(reply, 404, 'fehler.kontoNichtGefunden', 'Konto nicht gefunden');
    db.run('UPDATE users SET avatar_url = NULL WHERE id = ?', id);
    await avatare.entfernen(bisherige);

    const user = store.getUser(id);
    if (user) broadcastAll({ t: 'user:upsert', user });
    return { users: store.listManagedUsers() };
  });

  /**
   * Profilbilder ausliefern. Dieselbe Anmeldung wie bei /files/:id
   * (bearerOderAdresse): ein <img src> schickt keine Kopfzeilen, der
   * Nachweis muss also in der Adresse stehen.
   *
   * Der Dateiname TRÄGT die Änderung — jede neue Version bekommt einen
   * neuen Namen (siehe avatare.ablegen) —, deshalb darf hier so lange und
   * unveränderlich gecacht werden, wie man will: dieselbe Adresse zeigt nie
   * auf einen anderen Inhalt. Bleibt die Adresse dagegen gleich, zeigt jeder
   * Zwischenspeicher tagelang das alte Bild — das ist der Grund, warum die
   * Adresse sich überhaupt bei jeder Änderung ändert.
   */
  app.get('/avatare/:datei', async (req, reply) => {
    if (!bearerOderAdresse(req)) return fehler(reply, 401, 'fehler.nichtAngemeldet', 'Nicht angemeldet');
    const { datei } = req.params as { datei: string };
    const strom = avatare.oeffnen(datei);
    if (!strom) return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    // Der Typ steht fest, nie aus einer hochgeladenen Datei — siehe avatare.ts.
    reply.header('content-type', 'image/webp');
    reply.header('content-disposition', 'inline');
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(strom);
  });

  /* ── Suche ─────────────────────────────────────────────────── */

  app.get('/api/search', async (req) => {
    const userId = requireUser(req);
    const q = req.query as { q?: string; channelId?: string; from?: string; files?: string; limit?: string };
    return {
      hits: search({
        userId,
        q: q.q ?? '',
        channelId: q.channelId ?? null,
        fromUserId: q.from ?? null,
        hasFiles: q.files === '1',
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });

  app.get('/api/saved', async (req) => ({ messages: store.savedMessages(requireUser(req)) }));

  /**
   * Die angehefteten Nachrichten eines Kanals.
   *
   * Hier stand `if (!store.getChannel(id, userId))` — und das beantwortet
   * nicht die Frage, die gestellt werden muss. store.getChannel() sagt, ob es
   * den Kanal gibt, nicht ob man ihn sehen darf; den zweiten Parameter nimmt
   * es nur, um die Übersetzung des Kanalnamens zu wählen. Damit genügte die
   * Kennung eines privaten Kanals oder eines fremden Direktchats, um sich
   * dessen angeheftete Nachrichten im Volltext geben zu lassen.
   *
   * Dieselbe Regel wie an der Ereignisleitung bei 'channel:open': offene
   * Kanäle für alle, alles andere nur für Mitglieder.
   */
  app.get('/api/channels/:id/pins', async (req) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    const ch = store.getChannel(id, userId);
    if (!ch) return { messages: [] };
    if (ch.kind !== 'public' && !store.isMember(id, userId)) return { messages: [] };
    return { messages: store.pinnedMessages(id) };
  });

  /* ── Glossar ───────────────────────────────────────────────── */

  app.get('/api/glossary', async (req) => {
    requireUser(req);
    return { entries: listGlossary() };
  });

  app.post('/api/glossary', async (req, reply) => {
    const userId = requireUser(req);
    /* Das Glossar steuert, wie Begriffe teamweit übersetzt werden — ein
       Eintrag wirkt auf jede Nachricht. Das Recht dafür gab es längst, geprüft
       hat es niemand. */
    requirePermission(userId, 'glossary.manage');
    const body = req.body as { term?: string; translations?: Record<string, string> | null; caseSensitive?: boolean; note?: string };
    if (!body.term?.trim()) return fehler(reply, 400, 'fehler.begriffFehlt', 'Begriff fehlt');
    const id = addGlossaryEntry({
      term: body.term.trim(),
      translations: body.translations ?? null,
      caseSensitive: body.caseSensitive,
      note: body.note ?? null,
      userId,
    });
    return { id, entries: listGlossary() };
  });

  app.delete('/api/glossary/:id', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'glossary.manage');
    removeGlossaryEntry((req.params as { id: string }).id);
    return { entries: listGlossary() };
  });

  /**
   * Eine Fehlerantwort mit Kennung.
   *
   * Der Text bleibt deutsch — er ist der Rückfall für Clients, die die Kennung
   * noch nicht kennen. Die Oberfläche sucht zuerst nach der Kennung und zeigt
   * ihren eigenen Satz in der eingestellten Sprache. So muss der Server nicht
   * wissen, welche Sprache am anderen Ende läuft.
   */
  const fehler = (
    reply: FastifyReply, status: number, code: string, text: string,
    werte?: Record<string, string>,
  ) => reply.code(status).send({ error: text, code, werte });

  /**
   * Eine Abweisung aus einem Dienst weiterreichen.
   *
   * Trägt sie eine Kennung, geht die mit hinaus und die Oberfläche setzt ihren
   * eigenen Satz ein. Trägt sie keine — etwa weil es ein unerwarteter Fehler
   * ist —, bleibt es beim deutschen Text; lesbar ist er allemal.
   */
  const weiterreichen = (reply: FastifyReply, status: number, err: unknown) => {
    const { code, werte } = kennungVon(err);
    return reply.code(status).send({ error: (err as Error).message, code, werte });
  };

  /* ── Dateien ───────────────────────────────────────────────── */

  app.post('/api/uploads', async (req, reply) => {
    const userId = requireUser(req);
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) return fehler(reply, 400, 'fehler.keineDatei', 'Keine Datei im Request');

    const id = newId('at_');
    const safeName = path.basename(file.filename || 'datei').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
    const target = path.join(config.uploadDir, id);

    try {
      await pipeline(file.file, fs.createWriteStream(target));
    } catch (err) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 500, 'fehler.uploadFehlgeschlagen',
        `Upload fehlgeschlagen: ${(err as Error).message}`, { grund: (err as Error).message });
    }
    if (file.file.truncated) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 413, 'fehler.dateiZuGross',
        `Datei überschreitet ${config.maxUploadBytes / 1024 / 1024} MB`,
        { mb: String(config.maxUploadBytes / 1024 / 1024) });
    }

    const size = (await fs.promises.stat(target)).size;
    const umschlag = umschlagVonDatei(target);
    /* Bei einer verschlüsselten Datei gibt es nichts zu vermessen: der Anfang
       ist ein Umschlag und kein Bildkopf. Ohne diese Abzweigung stünden hier
       Maße, die aus Zufallsbytes geraten wären. */
    const dims = !umschlag && file.mimetype.startsWith('image/') ? await imageSize(target) : null;
    const summe = umschlag ? null : await dateiSumme(target);

    db.run(
      `INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, width, height, sha256, huelle, created_at)
       VALUES (?, NULL, ?,?,?,?,?,?,?,?,?,?)`,
      id, userId, safeName, file.mimetype || 'application/octet-stream', size, target,
      dims?.width ?? null, dims?.height ?? null, summe, huelleSchreiben(umschlag), Date.now(),
    );

    /* Ab in den Blockspeicher — angemeldet, nicht abgewartet. Das läuft
       bewusst nach dem Eintragen: die Datei ist ab sofort benutzbar, sie wird
       bis zum Ende der Zerlegung ganz von der Platte ausgeliefert, und wenn
       die Übernahme scheitert, bleibt sie schlicht liegen. */
    uebernehmenWennOffen({ id, art: 'attachment', pfad: target, mime: file.mimetype || '' }, umschlag);

    return {
      attachment: {
        id, messageId: null, name: safeName, mime: file.mimetype, size,
        url: `/files/${id}`, width: dims?.width ?? null, height: dims?.height ?? null,
      },
    };
  });

  /**
   * Kennt der Server diese Datei schon?
   *
   * Dieselbe Datei zweimal zu übertragen ist die teuerste Art, nichts zu
   * erreichen — bei einer Hausleitung mit zweieinhalb Megabyte in der Sekunde
   * sind das Minuten für etwas, das längst dort liegt. Der Client rechnet die
   * Prüfsumme aus und fragt vorher nach; passt sie, entsteht nur ein neuer
   * Verweis auf dieselben Bytes.
   *
   * Was hier als Nachweis zählt, ist die Prüfsumme über den **ganzen** Inhalt
   * zusammen mit der Größe. Wer die hat, hat die Datei — sie lässt sich nicht
   * erraten und nicht aus Bruchstücken zusammenlegen. Das ist die Grenze, an
   * der diese Route steht und stehen bleiben muss: eine Auskunft auf weniger
   * hin — auf einen Blocknamen etwa, oder auf eine Prüfsumme ohne Größe —
   * würde aus der Ersparnis einen Weg machen, an fremde Dateien zu kommen.
   */
  app.post('/api/uploads/bekannt', async (req, reply) => {
    const userId = requireUser(req);
    const body = req.body as { sha256?: string; size?: number; name?: string; mime?: string };
    const summe = String(body.sha256 ?? '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(summe)) return fehler(reply, 400, 'fehler.pruefsummeFalsch', 'Ungültige Prüfsumme.');

    const groesse = Number(body.size ?? 0);
    // Ohne Größe kein Nachweis: die Prüfsumme allein soll hier nicht genügen.
    if (!Number.isSafeInteger(groesse) || groesse <= 0) return { bekannt: false };

    /* Denselben Inhalt können mehrere Zeilen tragen, und sie sind
       unterschiedlich brauchbar: eine liegt noch als ganze Datei da, die
       nächste ist längst in Blöcken, eine dritte ist der Rest eines
       abgebrochenen Vorgangs und hat gar nichts mehr. Deshalb nicht die
       neueste nehmen, sondern die neueste, aus der wirklich wieder eine Datei
       entsteht. */
    const kandidaten = db.all<any>(
      'SELECT * FROM attachments WHERE sha256 = ? AND size = ? ORDER BY created_at DESC LIMIT 25',
      summe, groesse,
    );
    const vorhanden = kandidaten.find((zeile) => (zeile.encoding === 'bloecke'
      ? ablage.blockListe(zeile.id, 'attachment').length > 0
      : Boolean(zeile.path) && fs.existsSync(zeile.path)));
    if (!vorhanden) return { bekannt: false };

    /* Ein neuer Eintrag auf dieselbe Datei: Name und Absender gehören zu
       diesem Vorgang, die Bytes werden geteilt. Gelöscht wird eine Datei erst,
       wenn kein Eintrag mehr auf sie zeigt. */
    const id = newId('at_');
    const name = path.basename(String(body.name ?? vorhanden.name)).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
    const inBloecken = vorhanden.encoding === 'bloecke';
    db.run(
      `INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, width, height, sha256, encoding, stored_size, created_at)
       VALUES (?, NULL, ?,?,?,?,?,?,?,?,?,?,?)`,
      id, userId, name, String(body.mime ?? vorhanden.mime), vorhanden.size, vorhanden.path,
      vorhanden.width ?? null, vorhanden.height ?? null, summe,
      /* Alles außer „liegt in Blöcken" ist für diesen Eintrag schlicht eine
         ganze Datei. Insbesondere darf ein laufender `uebernahme`-Vermerk
         nicht mitkopiert werden: er gehört zu genau einem Vorgang, und die
         zweite Zeile würde sonst beim nächsten Start als unterbrochen gelten
         und eine Übernahme starten, die niemand angestoßen hat. */
      inBloecken ? 'bloecke' : null,
      /* Was dieser zweite Eintrag zusätzlich auf der Platte kostet: nichts.
         Die Blöcke liegen schon da, und genau so rechnet der Blockspeicher
         auch bei einem zweiten Upload derselben Datei. */
      inBloecken ? 0 : null,
      Date.now(),
    );

    /* Liegt die Vorlage in Blöcken, gibt es ihren Pfad nicht mehr — geteilt
       wird dann die Blockliste. Ohne diesen Zweig meldete die Route für jede
       Datei im Blockspeicher „kenne ich nicht", und der Client übertrug eine
       Datei, die längst da war. */
    if (inBloecken && !ablage.bloeckeTeilen({ id: vorhanden.id, art: 'attachment' }, { id, art: 'attachment' })) {
      // Zwischen Nachsehen und Übernehmen ist die Vorlage verschwunden. Dann
      // lieber ehrlich "unbekannt" als ein Eintrag, der ins Leere zeigt.
      db.run('DELETE FROM attachments WHERE id = ?', id);
      return { bekannt: false };
    }

    return {
      bekannt: true,
      attachment: {
        id, messageId: null, name, mime: String(body.mime ?? vorhanden.mime), size: vorhanden.size,
        url: `/files/${id}`, width: vorhanden.width ?? null, height: vorhanden.height ?? null,
      },
    };
  });

  /* ── Große Dateien in Teilen ────────────────────────────────
   *
   * Ein einzelner Datenstrom füllt eine Leitung mit Laufzeit nicht aus: das
   * Fenster wächst langsam, und jede Bestätigung kostet eine halbe Runde.
   * Mehrere Teile gleichzeitig holen deutlich mehr heraus — dieselbe Datei
   * kommt in Stücken, die der Server am Ende wieder zusammensetzt.
   */

  /** Anfangen: legt fest, was kommt, und gibt eine Kennung zurück. */
  app.post('/api/uploads/start', async (req, reply) => {
    const userId = requireUser(req);
    const body = req.body as { name?: string; mime?: string; size?: number; parts?: number };
    const groesse = Number(body.size ?? 0);
    if (!Number.isFinite(groesse) || groesse <= 0) {
      return fehler(reply, 400, 'fehler.groesseFehlt', 'Größe fehlt.');
    }
    if (groesse > config.maxUploadBytes) {
      return fehler(reply, 413, 'fehler.dateiZuGross',
        `Datei überschreitet ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`,
        { mb: String(Math.round(config.maxUploadBytes / 1024 / 1024)) });
    }
    const teile = Number(body.parts ?? 0);
    // Obergrenze, damit niemand mit hunderttausend Teilen das Verzeichnis flutet.
    if (!Number.isInteger(teile) || teile < 1 || teile > 2000) {
      return fehler(reply, 400, 'fehler.teileAnzahl', 'Ungültige Anzahl Teile.');
    }

    /* Auch die Zahl der angefangenen Uploads gehört begrenzt: jeder hält
       einen Eintrag im Speicher und bis zu zweitausend Teildateien auf der
       Platte, und weggeräumt wird erst nach einer Stunde. */
    let offen = 0;
    for (const auftrag of teilUploads.values()) if (auftrag.userId === userId) offen += 1;
    if (offen >= TEILUPLOADS_JE_KONTO) {
      return fehler(reply, 429, 'fehler.zuVieleVersuche',
        'Zu viele angefangene Uploads. Bitte einen Augenblick warten.');
    }

    const id = newId('up_');
    teilUploads.set(id, {
      userId,
      name: path.basename(body.name || 'datei').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120),
      mime: body.mime || 'application/octet-stream',
      size: groesse,
      parts: teile,
      da: new Set(),
      groessen: new Map(),
      begonnen: Date.now(),
      gesamt: 0,
      imFlug: new Map(),
      abschluss: false,
    });
    return { uploadId: id };
  });

  /** Ein Teil. Der Rumpf ist der rohe Inhalt, ohne Umschlag. */
  app.put('/api/uploads/:id/part/:index', async (req, reply) => {
    const userId = requireUser(req);
    const { id, index } = req.params as { id: string; index: string };
    const auftrag = teilUploads.get(id);
    if (!auftrag || auftrag.userId !== userId) return fehler(reply, 404, 'fehler.uploadUnbekannt', 'Unbekannter Upload.');

    const nummer = Number.parseInt(index, 10);
    if (!Number.isInteger(nummer) || nummer < 0 || nummer >= auftrag.parts) {
      return fehler(reply, 400, 'fehler.teilnummer', 'Ungültige Teilnummer.');
    }

    const zuGross = () => fehler(reply, 413, 'fehler.dateiZuGross',
      `Datei überschreitet ${Math.round(auftrag.size / 1024 / 1024)} MB`,
      { mb: String(Math.round(auftrag.size / 1024 / 1024)) });

    /* Denselben Teil zweimal GLEICHZEITIG: dann stünden zwei Ströme unter
       einer Nummer in `imFlug`, und der zuerst fertige gäbe den Anspruch des
       anderen mit frei. Eine ehrliche App tut das nie — sie schickt jeden
       Teil einmal (desktop/src/net/api.ts). */
    if (auftrag.imFlug.has(nummer)) {
      return fehler(reply, 409, 'fehler.teilLaeuft',
        `Teil ${nummer} wird gerade schon hochgeladen.`, { nummer: String(nummer) });
    }

    /* Einen Teil neu zu schicken bleibt erlaubt: sein bisheriger Beitrag
       zählt dann nicht mehr mit und geht aus `gesamt` heraus, BEVOR der neue
       Strom anfängt zu zählen. */
    const vorher = auftrag.groessen.get(nummer);
    if (vorher !== undefined) {
      auftrag.gesamt -= vorher;
      auftrag.groessen.delete(nummer);
    }
    auftrag.da.delete(nummer);

    if (auftrag.gesamt >= auftrag.size) return zuGross();

    /* Hier wird der Anspruch angemeldet — VOR dem `await`, und ab jetzt sieht
       ihn jede andere gleichzeitige Anfrage. Genau das fehlte: die alte
       Fassung rechnete vorher und trug erst nachher ein, und in dieser Lücke
       bekamen dreißig gleichzeitige Teile dreißigmal dasselbe volle Budget.
       Siehe `begrenzt()` oben. */
    auftrag.imFlug.set(nummer, 0);
    /** Den eigenen Beitrag wieder hergeben — sonst sperrt sich ein Konto mit
        abgebrochenen Uploads selbst aus. */
    const anspruchLoesen = () => {
      auftrag.gesamt -= auftrag.imFlug.get(nummer) ?? 0;
      auftrag.imFlug.delete(nummer);
    };

    const ziel = path.join(config.uploadDir, `${id}.teil${nummer}`);
    try {
      await pipeline(req.raw, begrenzt(auftrag, nummer), fs.createWriteStream(ziel, { highWaterMark: 1024 * 1024 }));
    } catch (err) {
      anspruchLoesen();
      await fs.promises.rm(ziel, { force: true });
      if ((err as Error).message === 'zu groß') return zuGross();
      return fehler(reply, 500, 'fehler.teilFehlgeschlagen',
        `Teil ${nummer} fehlgeschlagen: ${(err as Error).message}`,
        { nummer: String(nummer), grund: (err as Error).message });
    }

    let geschrieben: number;
    try {
      geschrieben = (await fs.promises.stat(ziel)).size;
    } catch (err) {
      anspruchLoesen();
      return fehler(reply, 500, 'fehler.teilFehlgeschlagen',
        `Teil ${nummer} fehlgeschlagen: ${(err as Error).message}`,
        { nummer: String(nummer), grund: (err as Error).message });
    }
    /* Umbuchen statt neu zählen: diese Bytes stehen bereits in `gesamt` —
       sie wechseln nur von „im Fluss" zu „geschrieben". Die Differenz ist
       im Normalfall null; sie steht hier, damit `gesamt` auch dann stimmt,
       wenn auf der Platte etwas anderes ankam als durch den Strom ging. */
    auftrag.gesamt += geschrieben - (auftrag.imFlug.get(nummer) ?? 0);
    auftrag.imFlug.delete(nummer);
    auftrag.groessen.set(nummer, geschrieben);
    auftrag.da.add(nummer);
    return { ok: true, teil: nummer };
  });

  /** Fertig: Teile in der richtigen Reihenfolge zusammenlegen. */
  app.post('/api/uploads/:id/finish', async (req, reply) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    const auftrag = teilUploads.get(id);
    if (!auftrag || auftrag.userId !== userId) return fehler(reply, 404, 'fehler.uploadUnbekannt', 'Unbekannter Upload.');

    /* Ein zweites `/finish`, während das erste noch läuft, kam bis hierher
       durch jede Prüfung: der Eintrag wird erst ganz am Ende gelöscht, und
       bis dahin sieht der zweite Aufruf einen vollständigen Auftrag. Beide
       lasen dann dieselben Teildateien — der eine räumte sie unter dem
       anderen weg. Herauskam entweder ein ENOENT-500 für einen Upload, der
       in Wahrheit gelungen war, oder zwei `attachments`-Zeilen für eine
       einzige Datei.

       Der Anspruch wird gesetzt, BEVOR das erste `await` kommt; alles davor
       ist synchron, also kann sich niemand dazwischenschieben. Freigegeben
       wird er nicht: schlägt das Zusammenlegen fehl, ist der Auftrag ohnehin
       weg (siehe unten), und ein zweiter Anlauf beginnt mit `/uploads/start`
       neu. */
    if (auftrag.abschluss) {
      return fehler(reply, 409, 'fehler.uploadLaeuft',
        'Dieser Upload wird gerade schon abgeschlossen.');
    }

    const fehlend = [];
    for (let i = 0; i < auftrag.parts; i += 1) if (!auftrag.da.has(i)) fehlend.push(i);
    if (fehlend.length) {
      return fehler(reply, 400, 'fehler.teileFehlen',
        `Es fehlen Teile: ${fehlend.slice(0, 10).join(', ')}`,
        { teile: fehlend.slice(0, 10).join(', ') });
    }

    /* Erst NACH der Vollständigkeitsprüfung: wer nur nachfragt und dabei
       erfährt, dass noch Teile fehlen, soll den Auftrag nicht verbrannt
       haben — er darf die fehlenden Teile nachschicken und es erneut
       versuchen. */
    auftrag.abschluss = true;

    const anhangId = newId('at_');
    const ziel = path.join(config.uploadDir, anhangId);
    const schreiber = fs.createWriteStream(ziel, { highWaterMark: 1024 * 1024 });
    try {
      for (let i = 0; i < auftrag.parts; i += 1) {
        const teil = path.join(config.uploadDir, `${id}.teil${i}`);
        await pipeline(fs.createReadStream(teil, { highWaterMark: 1024 * 1024 }), schreiber, { end: false });
      }
      await new Promise<void>((fertig, schief) => {
        schreiber.end((err?: Error | null) => (err ? schief(err) : fertig()));
      });
    } catch (err) {
      schreiber.destroy();
      await fs.promises.rm(ziel, { force: true });
      await teileAufraeumen(id, auftrag.parts);
      teilUploads.delete(id);
      return fehler(reply, 500, 'fehler.zusammensetzen',
        `Zusammensetzen fehlgeschlagen: ${(err as Error).message}`, { grund: (err as Error).message });
    }

    await teileAufraeumen(id, auftrag.parts);
    teilUploads.delete(id);

    const size = (await fs.promises.stat(ziel)).size;
    if (size !== auftrag.size) {
      await fs.promises.rm(ziel, { force: true });
      return fehler(reply, 400, 'fehler.unvollstaendig',
        `Unvollständig: ${size} statt ${auftrag.size} Bytes.`,
        { ist: String(size), soll: String(auftrag.size) });
    }

    const umschlag = umschlagVonDatei(ziel);
    const dims = !umschlag && auftrag.mime.startsWith('image/') ? await imageSize(ziel) : null;
    const summe = umschlag ? null : await dateiSumme(ziel);
    db.run(
      `INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, width, height, sha256, huelle, created_at)
       VALUES (?, NULL, ?,?,?,?,?,?,?,?,?,?)`,
      anhangId, userId, auftrag.name, auftrag.mime, size, ziel,
      dims?.width ?? null, dims?.height ?? null, summe, huelleSchreiben(umschlag), Date.now(),
    );

    /* Ab in den Blockspeicher. Das lief hier bisher nicht, und damit ging
       ausgerechnet das an den Blöcken vorbei, wofür der Weg in Teilen
       überhaupt gebaut wurde: die großen Dateien.

       Anders als beim Upload am Stück aber erst **nach** der Antwort. Wie
       lange eine Zerlegung dauert, entscheidet der Inhalt, und die Spanne ist
       gewaltig: hier gemessen 30 MB Rauschen in 0,3 Sekunden, 8 MB packbarer
       Text in eineinhalb Minuten — jeder Block wird einzeln gepackt, und bei
       packbarem Inhalt kostet das Sekunden je Block. Diese Spanne in eine
       Antwort zu legen hieße, den Client bei ungünstigem Inhalt so lange
       warten zu lassen, dass er den Upload für gescheitert hält, obwohl
       längst alles da ist.

       Bis die Zerlegung durch ist, trägt die Zeile den Vermerk `uebernahme`:
       die Datei liegt ganz da und wird ganz ausgeliefert, niemand merkt, dass
       noch etwas läuft. Bricht der Server mittendrin ab, findet der nächste
       Start genau diesen Vermerk und fängt von vorn an.

       Verschlüsselte Dateien bleiben außen vor — der Grund steht bei
       uebernehmenWennOffen(). */
    if (!umschlag) {
      ablage.spaeterUebernehmen({
        id: anhangId, art: 'attachment', pfad: ziel, mime: auftrag.mime,
      });
    }

    return {
      attachment: {
        id: anhangId, messageId: null, name: auftrag.name, mime: auftrag.mime, size,
        url: `/files/${anhangId}`, width: dims?.width ?? null, height: dims?.height ?? null,
      },
    };
  });

  /* ── Team-Ablage ───────────────────────────────────────────── */

  app.post('/api/files', async (req, reply) => {
    const userId = requireUser(req);
    if (!may(userId, 'file.upload')) {
      return fehler(reply, 403, 'fehler.keinRechtAblage', 'Dir fehlt das Recht, Dateien abzulegen.');
    }
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) return fehler(reply, 400, 'fehler.keineDatei', 'Keine Datei im Request');

    // Die Zusatzfelder kommen als Textteile im selben Formular.
    const felder = file.fields as Record<string, { value?: string } | undefined>;
    const feld = (name: string) => {
      const w = felder?.[name];
      return typeof w?.value === 'string' ? w.value : undefined;
    };

    const id = newId('fi_');
    const target = path.join(config.storageDir, id);

    try {
      await pipeline(file.file, fs.createWriteStream(target));
    } catch (err) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 500, 'fehler.uploadFehlgeschlagen',
        `Upload fehlgeschlagen: ${(err as Error).message}`, { grund: (err as Error).message });
    }
    if (file.file.truncated) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 413, 'fehler.dateiZuGross',
        `Datei überschreitet ${config.maxUploadBytes / 1024 / 1024} MB`,
        { mb: String(config.maxUploadBytes / 1024 / 1024) });
    }

    const size = (await fs.promises.stat(target)).size;
    /* Ob eine Datei privat ist, entscheidet ihr Inhalt und nicht das Formular.
       Ein Feld "privat=1" wäre eine Behauptung, und die Zusage "nicht einmal
       der Host sieht das" darf nicht auf einer Behauptung ruhen: eine ältere
       App schickte den Klartext und bekäme trotzdem das Schloss danebengemalt.
       Umgekehrt gilt dasselbe — was verschlüsselt ankommt, ist privat, auch
       wenn das Feld fehlt. Siehe crypto/dateien.ts. */
    const umschlag = umschlagVonDatei(target);
    if (feld('privat') === '1' && !umschlag) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 400, 'fehler.privatUnverschluesselt',
        'Diese Datei sollte privat sein, kam aber unverschlüsselt an. Bitte die App aktualisieren.');
    }
    try {
      const gespeichert = files.addFile({
        id,
        name: path.basename(file.filename || 'datei'),
        mime: file.mimetype || 'application/octet-stream',
        size,
        storedPath: target,
        folder: feld('folder'),
        channelId: feld('channelId') ?? null,
        description: feld('description') ?? null,
        uploadedBy: userId,
        privat: Boolean(umschlag),
        huelle: huelleSchreiben(umschlag),
      });
      const belegung = files.usage();
      /* Alle sollen die neue Datei sofort in der Ablage sehen — aber nur die
         Dateien, die auch wirklich alle angehen. Hier stand vorher nur
         `!gespeichert.privat`, und „privat" heißt in dieser Tabelle
         ausschließlich „für ein einzelnes Konto verschlüsselt"
         (huelle.art === 'konto'). Eine Datei in einem privaten oder
         vertraulichen KANAL ist das nicht — ihr Name, ihre Beschreibung und
         ihre Kanalkennung gingen damit an jedes angemeldete Konto im Haus,
         obwohl das Lesen (`listFiles()` in services/files.ts) genau dagegen
         längst abgedichtet war.

         Die Frage stellt jetzt die Ablage selbst (`fuerAlleSichtbar()`),
         damit Lesen und Rundruf dieselbe Regel benutzen und nicht zwei.

         WARUM NICHT AN DEN KREIS DES KANALS GERUFEN WIRD: dafür bräuchte es
         einen Rundruf mit Empfängerliste. Das Gateway hat ihn (`broadcast()`
         mit `empfaengerFuer()`), gibt ihn aber nicht heraus — hierher
         exportiert ist nur `broadcastAll()`. Für die Mitglieder des Kanals
         heißt das: die Datei erscheint bei ihnen nicht in derselben Sekunde,
         sondern beim nächsten Laden der Ablage (`GET /api/files`). Das ist
         der Preis, und er ist der kleinere — die hochladende App bekommt die
         Datei ohnehin in der Antwort. Ein Dateiname aus einem vertraulichen
         Kanal, der bei Unbeteiligten aufblitzt, lässt sich nicht
         zurücknehmen. Was dabei ebenfalls wartet, ist die Belegungsanzeige
         der anderen; sie ist eine Zahl ohne Inhalt und kann warten. */
      if (files.fuerAlleSichtbar(gespeichert)) {
        broadcastAll({ t: 'file:upsert', file: gespeichert, usage: belegung });
      }
      return { file: gespeichert, usage: belegung };
    } catch (err) {
      // Kontingent überschritten: die Datei darf nicht liegen bleiben.
      await fs.promises.rm(target, { force: true });
      return weiterreichen(reply, 409, err);
    }
  });

  /**
   * Die Ablage, wie sie für dieses Konto aussieht.
   *
   * Es gibt sie auch über die Ereignisleitung (`file:list`), aber dort fehlt
   * dem Aufruf das Konto — und ohne Konto lässt sich nicht entscheiden, wessen
   * private Dateien dazugehören. Deshalb dieser Weg: er weiß, wer fragt, und
   * gibt private Dateien nur ihrem Besitzer.
   */
  app.get('/api/files', async (req) => {
    const userId = requireUser(req);
    const q = req.query as { channelId?: string; folder?: string } | undefined;
    return {
      files: files.listFiles({ channelId: q?.channelId, folder: q?.folder, fuerUserId: userId }),
      usage: files.usage(),
    };
  });

  /* ── App-Versionen ─────────────────────────────────────────── */

  /** Was liegt bereit? Braucht keine Rechte — jeder Client fragt das. */
  app.get('/api/releases', async (req) => {
    const userId = requireUser(req);
    return {
      releases: releases.listReleases().map((r) => ({
        ...r, notes: notizenFuerBetrachter(r.platform, userId, r.notes),
      })),
    };
  });

  /**
   * Gibt es etwas Neueres als die laufende Version? Die Antwort ist bewusst
   * knapp: der Client soll nicht selbst Versionen vergleichen müssen.
   */
  app.get('/api/releases/check', async (req) => {
    const userId = requireUser(req);
    const { platform, version } = req.query as { platform?: string; version?: string };
    if (!platform || !version) return { update: null };
    const vorhanden = releases.getRelease(platform);
    if (!vorhanden || !releases.istNeuer(vorhanden.version, version)) return { update: null };
    const { path: _pfad, ...oeffentlich } = vorhanden;
    return { update: { ...oeffentlich, notes: notizenFuerBetrachter(platform, userId, oeffentlich.notes) } };
  });

  /* ── Fernzugang zum Pi ─────────────────────────────────────────
     Adresse und Passwort liegen verschlüsselt in den Einstellungen und
     werden NIE zurückgegeben — außer an jemanden, der sie gerade zum
     Verbinden braucht. Die Verwaltung sieht nur, DASS etwas hinterlegt ist. */

  /* ── Systemwerte ──────────────────────────────────────────────
     Dieselben Zahlen, die die Konsole auf dem Pi zeigt. Nur Zahlen: keine
     Nachrichten, keine Namen von Besuchern, keine Adressen — die
     Besucherstatistik ist von Anfang an eine reine Zusammenfassung. */
  /* `/api/systemwerte` und nicht `/api/system`: den Namen gibt es schon —
     http/konsole.ts bedient damit die Konsolenseite, die nur von der
     Maschine selbst erreichbar ist. Fastify weist einen zweiten Eintrag
     ab, und der Server käme gar nicht mehr hoch. */
  app.get('/api/systemwerte', async (req, reply) => {
    const wer = requireUser(req);
    if (!users.may(wer, 'system.ansehen')) {
      return fehler(reply, 403, 'fehler.keinRecht',
        'Die Systemwerte sieht nur, wer das Recht dazu hat.');
    }
    if (!systemwerte.verfuegbar()) {
      /* Kein Fehler, sondern eine Aussage: auf einem Rechner ohne die
         Serverkonsole gibt es diese Zahlen schlicht nicht. Die Oberfläche
         soll das erklären können, statt ins Leere zu laufen. */
      return { da: false };
    }
    try {
      const alles = await systemwerte.werte() as Record<string, unknown>;
      /* Die Konsole liefert ALLES, was sie weiß — auch was das Geschäft
         einbringt. Hier stand vorher `werte: await systemwerte.werte()`,
         und damit ging `abo` an jeden, der `system.ansehen` hat. Solange
         kein Gumroad-Token hinterlegt war, fiel das nicht auf: die Felder
         waren null. Mit Token wären es Abonnentenzahl und Einnahmen
         gewesen — und der Hinweis zu `system.ansehen` verspricht
         ausdrücklich das Gegenteil ("nur Zahlen — Auslastung, Speicher,
         Besucher").
         Weggelassen statt geleert: ein Feld, das null ist, sieht aus wie
         "es gibt gerade nichts". Fehlt es, ist klar, dass hier jemand
         etwas nicht sehen darf. */
      if (users.may(wer, 'verkauf.sehen')) return { da: true, werte: alles };
      const { abo: _abo, kaufquote: _kaufquote, ...ohneGeld } = alles;
      return { da: true, werte: ohneGeld };
    } catch (f) {
      return fehler(reply, 503, 'fehler.systemwerte',
        `Die Systemwerte sind gerade nicht zu holen: ${(f as Error).message}`);
    }
  });

  /* ── Online-Zeit ──────────────────────────────────────────────
     Die eigene darf jeder sehen. Die von anderen nur, wer Konten verwaltet:
     wie lange jemand vor der App sitzt, ist eine Aussage über seinen
     Arbeitstag, und die geht nicht das ganze Team etwas an. */
  app.get('/api/praesenz/:userId', async (req, reply) => {
    const wer = requireUser(req);
    const { userId } = req.params as { userId: string };
    const ziel = userId === 'ich' ? wer : userId;
    if (ziel !== wer && !users.may(wer, 'user.manage')) {
      return fehler(reply, 403, 'fehler.keinRecht',
        'Die Online-Zeit anderer sieht nur, wer Konten verwaltet.');
    }
    const roh = (req.query as { zeitraum?: string }).zeitraum ?? 'woche';
    const zeitraum = (['heute', 'woche', 'monat', 'jahr'] as const)
      .find((z) => z === roh) ?? 'woche';
    return {
      zeitraum,
      summen: praesenz.summen(ziel),
      verlauf: praesenz.verlauf(ziel, zeitraum),
    };
  });

  app.get('/api/fern/stand', async (req) => {
    const userId = requireUser(req);
    /* Auch ohne Recht darf man wissen, ob es überhaupt eingerichtet ist —
       sonst steht in der App ein Knopf, der ohne Erklärung nichts tut. */
    const stand = fernzugang.zugangStand();
    return { ...stand, darf: users.may(userId, 'fern.zugriff') };
  });

  /* Der einzige Weg, an die Zugangsdaten zu kommen. Wer das Recht nicht hat,
     bekommt 403 — und wer es hat, bekommt sie zum Verbinden, nicht zum
     Ansehen: die App reicht sie direkt an den Hauptprozess weiter und
     stellt sie nirgends dar. */
  app.get('/api/fern/zugang', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'fern.zugriff');
    const z = fernzugang.zugangLesen();
    if (!z) {
      const err = new Error('Für den Pi ist noch kein Zugang hinterlegt.') as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    return z;
  });

  /* ── Postfach: lesen und antworten ───────────────────────────
     `mail.lesen` sieht die Post des Unternehmens — das ist Schriftwechsel mit
     Kunden und Fremden. `mail.senden` gibt etwas nach draußen. Zwei Rechte,
     weil es zwei sehr verschiedene Dinge sind. */
  app.get('/api/post/faecher', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    return { faecher: post.faecher() };
  });

  /** Nur diese drei Werte -- alles andere fiele sonst still auf "aktiv"
      zurück (die Vorgabe von post.liste()) und verschwiege dabei, dass die
      Anfrage selbst falsch war. */
  const POST_ANSICHTEN = ['aktiv', 'archiviert', 'papierkorb'] as const;

  app.get('/api/post/liste', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const q = req.query as { fach?: string; anzahl?: string; vor?: string; ansicht?: string };
    if (q.ansicht && !(POST_ANSICHTEN as readonly string[]).includes(q.ansicht)) {
      return fehler(reply, 400, 'fehler.unbekannteAnsicht', 'Diese Ansicht gibt es nicht.');
    }
    return {
      nachrichten: post.liste(
        q.fach && q.fach !== 'alle' ? q.fach : null,
        Number(q.anzahl) || 50,
        q.vor ? Number(q.vor) : undefined,
        (q.ansicht as (typeof POST_ANSICHTEN)[number] | undefined) ?? 'aktiv',
      ),
    };
  });

  /**
   * Volltextsuche über das Postfach — Betreff, Text, Absender, Fach und
   * Anhangnamen (siehe Dateikopf services/post-suche.ts für die Begründung,
   * warum derselbe Fingerabdruck-Index wie beim Chat und nicht ein eigenes
   * Verfahren). `mail.lesen` genügt, dieselbe Schwelle wie `/api/post/liste`:
   * die Suche zeigt nichts, was diese Person über die Liste ohnehin nicht
   * schon sehen dürfte.
   */
  app.get('/api/post/suche', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const q = req.query as { q?: string; fach?: string; limit?: string };
    return {
      treffer: postSuche.suchen({
        q: q.q ?? '',
        fach: q.fach ?? null,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });

  app.get('/api/post/nachricht/:id', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const n = post.nachricht((req.params as { id: string }).id);
    if (!n) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diese Nachricht gibt es nicht.');
    /* Gelesen setzen beim Öffnen — nicht in einer eigenen Route. Ein Zähler,
       den man von Hand zurücksetzen muss, läuft irgendwann auseinander. */
    if (!n.gelesen && n.richtung === 'ein') post.gelesenSetzen(n.id, true);
    return { nachricht: { ...n, gelesen: true } };
  });

  app.get('/api/post/verlauf/:threadId', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    /* `verlauf`, nicht `nachrichten`: es ist eine Kette, keine Liste — und
       die Oberfläche liest genau diesen Namen. */
    return { verlauf: post.verlauf((req.params as { threadId: string }).threadId) };
  });

  /* ── Postfach: weiterleiten ────────────────────────────────────
     Eine bestehende Mail mit Text und Anhängen an eine andere Adresse geben
     — siehe services/post.ts, weiterleiten() für die ausführliche
     Begründung (freie Empfängeradresse, Herkunftsfach, warum der fremde Text
     nie zu einer Kopfzeile werden kann). `mail.senden`, nicht zusätzlich
     `mail.lesen`: dieselbe Schwelle wie bei `/api/post/entwuerfe/:id/senden`
     weiter unten, das die Ursprungsmail ebenfalls allein hinter
     `mail.senden` liest — wer senden darf, darf dafür auch die Mail lesen,
     auf die sich der Versand bezieht. */
  app.post('/api/post/nachricht/:id/weiterleiten', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.senden');
    const { id } = req.params as { id: string };
    const k = req.body as { fach?: string; an?: string };
    if (!k?.an) return fehler(reply, 400, 'fehler.unvollstaendig', 'Ein Empfänger ist nötig.');
    try {
      return await post.weiterleiten(id, { fach: k.fach, an: k.an }, userId);
    } catch (f) {
      const e = f as { code?: string; status?: number; message?: string };
      return fehler(reply, e.status ?? 502, e.code ?? 'fehler.post',
        e.message ?? 'Weiterleiten fehlgeschlagen.');
    }
  });

  /* ── Postfach: Archivieren, aus dem Weg räumen, endgültig löschen ───
     Serverseitig längst da (services/post.ts: archiviertSetzen(),
     entferntSetzen(), endgueltigLoeschen()) — hier nur die Türen dazu. Drei
     verschiedene Rechte für drei verschieden schwere Handlungen:
     Archivieren/Entfernen sind jederzeit umkehrbar und laufen deshalb unter
     `mail.senden` (derselben Schwelle wie „aktiv mit dem Postfach
     arbeiten"), endgültiges Löschen ist es nicht und bleibt hinter
     `mail.verwalten` — derselben Schwelle, unter der auch der Postfach-
     Zugang selbst eingerichtet wird. */

  app.post('/api/post/nachricht/:id/archivieren', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.senden');
    const { id } = req.params as { id: string };
    const k = req.body as { archiviert?: boolean };
    const ok = post.archiviertSetzen(id, k?.archiviert !== false);
    if (!ok) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diese Nachricht gibt es nicht.');
    return { ok: true };
  });

  app.post('/api/post/nachricht/:id/entfernen', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.senden');
    const { id } = req.params as { id: string };
    const ok = post.entferntSetzen(id, true);
    if (!ok) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diese Nachricht gibt es nicht.');
    return { ok: true };
  });

  app.post('/api/post/nachricht/:id/wiederherstellen', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.senden');
    const { id } = req.params as { id: string };
    const ok = post.entferntSetzen(id, false);
    if (!ok) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diese Nachricht gibt es nicht.');
    return { ok: true };
  });

  /**
   * Endgültig löschen — Art. 17 DSGVO, unumkehrbar (siehe services/post.ts,
   * Dateikopf des Abschnitts „Archivieren, aus dem Weg räumen, endgültig
   * löschen" für den Unterschied zu den beiden Routen oben). Die
   * ausdrückliche Bestätigung dafür sitzt in der Oberfläche (PostPanel.tsx)
   * — hier nur die schärfere Rechteschwelle, `mail.verwalten` statt
   * `mail.senden`.
   */
  app.delete('/api/post/nachricht/:id', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.verwalten');
    const { id } = req.params as { id: string };
    const ok = post.endgueltigLoeschen(id);
    if (!ok) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diese Nachricht gibt es nicht.');
    return { ok: true };
  });

  /* ── Postfach: Aufbewahrungsfrist je Fach ─────────────────────
     `mail.verwalten`, dieselbe Schwelle wie beim Postfach-Zugang selbst: wie
     lange Post aufbewahrt wird, ist eine Einrichtungsentscheidung, keine
     tägliche Arbeit am Postfach (die läuft unter `mail.lesen`/`mail.senden`,
     siehe oben). */

  app.get('/api/post/fristen', async (req) => {
    requirePermission(requireUser(req), 'mail.verwalten');
    return { fristen: post.fristenStand() };
  });

  app.post('/api/post/fristen', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.verwalten');
    const k = req.body as { fach?: string; tage?: number };
    if (!k?.fach || k.tage === undefined) {
      return fehler(reply, 400, 'fehler.unvollstaendig', 'Fach und Frist sind nötig.');
    }
    try {
      return { frist: post.fristSetzen(k.fach, Number(k.tage), userId) };
    } catch (f) {
      const e = f as { code?: string; status?: number; message?: string };
      return fehler(reply, e.status ?? 400, e.code ?? 'fehler.post', e.message ?? 'Frist ließ sich nicht setzen.');
    }
  });

  app.delete('/api/post/fristen/:fach', async (req) => {
    requirePermission(requireUser(req), 'mail.verwalten');
    const { fach } = req.params as { fach: string };
    post.fristLoeschen(fach);
    return { ok: true };
  });

  /* ── Postfach: Briefpartner-Gruppen ───────────────────────────
     Kunden, Firmen, Bewerber und so weiter — siehe services/
     post-partnergruppen.ts für die Regeln (feste Gruppen, die KI schlägt nur
     EINMAL je Adresse vor). `mail.lesen` zum Ansehen und Filtern,
     `mail.senden` zum Ändern: dieselbe Schwelle wie beim Freigeben eines
     KI-Entwurfs weiter unten — beides ist aktives Arbeiten am Postfach, kein
     bloßes Lesen. Bewusst NICHT `mail.verwalten`: das bleibt dem Inhaber
     vorbehalten fürs Einrichten des Zugangs (siehe dort, ownerOnly) und
     schlösse die Teamleitung aus, die laut ihrem Rechteprofil genau diese
     tägliche Einordnung treffen soll (mail.lesen + mail.senden, siehe
     packages/shared/src/permissions.ts). */
  app.get('/api/post/partner', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const q = req.query as { gruppe?: string; nurVorschlaege?: string };
    return {
      partner: partnerGruppen.listePartner({
        gruppe: q.gruppe && q.gruppe !== 'alle' ? q.gruppe : null,
        nurVorschlaege: q.nurVorschlaege === '1',
      }),
      offen: partnerGruppen.offeneVorschlaegeAnzahl(),
    };
  });

  /**
   * Eine Gruppe von Hand setzen, ändern — oder einen Vorschlag bestätigen,
   * indem derselbe Wert noch einmal geschickt wird. Alle drei sind für
   * `gruppeSetzen()` dieselbe Operation: von jetzt an gilt der Wert als
   * Tatsache, nicht mehr als Vorschlag, und die KI rührt diese Adresse nie
   * wieder an (siehe dort).
   */
  app.post('/api/post/partner/gruppe', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.senden');
    const k = req.body as { adresse?: string; gruppe?: string | null };
    if (!k?.adresse) return fehler(reply, 400, 'fehler.unvollstaendig', 'Eine Adresse ist nötig.');
    // gruppeIstGueltig() statt eines statischen PARTNER_GRUPPEN.includes():
    // die Liste gültiger Gruppen ist seit den benutzerdefinierten Gruppen
    // keine feste Konstante mehr (siehe services/post-partnergruppen.ts,
    // Dateikopf des dortigen Abschnitts). `gruppe` bleibt deshalb bewusst
    // `string`, nicht der enge `PartnerGruppe`-Typ — ein Cast auf die
    // eingebaute Union wäre nach dieser Prüfung nicht mehr korrekt, weil sie
    // auch eine benutzerdefinierte Kennung durchlässt.
    if (k.gruppe && !partnerGruppen.gruppeIstGueltig(k.gruppe)) {
      return fehler(reply, 400, 'fehler.unbekannteGruppe', 'Diese Gruppe gibt es nicht.');
    }
    const gruppe = k.gruppe || null;
    return { partner: partnerGruppen.gruppeSetzen(post.nurAdresse(k.adresse), gruppe) };
  });

  /* ── Postfach: die Gruppen SELBST verwalten ───────────────────
     Nicht zu verwechseln mit `/api/post/partner/gruppe` oben, das die Gruppe
     EINES Briefpartners setzt — hier geht es um die Liste der Gruppen (siehe
     services/post-partnergruppen.ts, Abschnitt „BENUTZERDEFINIERTE GRUPPEN",
     für Längen-, Eindeutigkeits- und Obergrenzenprüfung; die liegt komplett
     im Dienst, hier wird nur `weiterreichen()` genutzt, nicht dupliziert).

     Lesen läuft unter `mail.lesen`, derselben Schwelle wie `/api/post/partner`
     — die Chip-Reihe zu sehen ist Teil des normalen Postfach-Blicks, nicht
     Einrichtung. Anlegen/Umbenennen/Löschen brauchen dagegen `mail.verwalten`
     — dieselbe Schwelle wie der Postfach-Zugang selbst, siehe Dateikopf oben
     bei `/api/post/partner` UND PartnerGruppenPanel.tsx (Dateikopf dort):
     eine neue oder verschwundene Gruppe sieht jede Person mit Postfach-
     Zugriff sofort in ihrer eigenen Chip-Reihe, das ist Einrichtung, kein
     Tagesgeschäft — anders als das Ändern der Gruppe EINES Briefpartners
     (`mail.senden`, oben), das nur die Zeile betrifft, an der gerade
     gearbeitet wird. */
  app.get('/api/post/partnergruppen', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    return { gruppen: partnerGruppen.alleGruppen() };
  });

  app.post('/api/post/partnergruppen', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.verwalten');
    const k = req.body as { name?: string };
    // Kein eigener „Name fehlt"-Zweig hier: gruppenNamePruefen() im Dienst
    // liefert für einen leeren Namen bereits die eigene, wörterbuchgeführte
    // Kennung (`fehler.gruppeNameFehlt`) — ein zweiter, hier erfundener
    // Fehlertext würde diesen Fall nur doppelt und uneinheitlich behandeln.
    const roh = typeof k?.name === 'string' ? k.name : '';
    try {
      return { gruppe: partnerGruppen.gruppeErstellen(roh, userId) };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.patch('/api/post/partnergruppen/:id', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.verwalten');
    const { id } = req.params as { id: string };
    const k = req.body as { name?: string };
    const roh = typeof k?.name === 'string' ? k.name : '';
    try {
      return { gruppe: partnerGruppen.gruppeUmbenennen(id, roh) };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.delete('/api/post/partnergruppen/:id', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.verwalten');
    const { id } = req.params as { id: string };
    try {
      return partnerGruppen.gruppeLoeschen(id);
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.post('/api/post/senden', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.senden');
    const k = req.body as {
      fach?: string; an?: string; betreff?: string; text?: string;
      /* Nur gesetzt, wenn der Text auf einem Vorschlag von „KI schreibt"
         (post-entwurf-ki.ts, entwurfSchreiben()) beruht — der Wortlaut, wie
         die KI ihn geliefert hat, BEVOR ein Mensch im Schreibfenster
         weiterschrieb. Fehlt es, gilt diese Mail als rein von Hand verfasst:
         `post.senden()` setzt dann keine Fußzeile (Ausgang.textKi dort). Ob
         der Text danach noch verändert wurde, entscheidet `senden()` selbst
         durch den Vergleich mit `text` — diese Route rät nicht mit. */
      textKi?: string | null;
      antwortAuf?: { messageId: string | null; referenzen: string | null; threadId: string | null };
      anhaenge?: string[];
    };
    if (!k?.an || !k?.text) {
      return fehler(reply, 400, 'fehler.unvollstaendig', 'Empfänger und Text sind nötig.');
    }
    try {
      return await post.senden({
        fach: k.fach, an: k.an, betreff: k.betreff ?? '', text: k.text, textKi: k.textKi,
        antwortAuf: k.antwortAuf,
        anhaenge: Array.isArray(k.anhaenge) ? k.anhaenge : undefined,
      }, userId);
    } catch (f) {
      const e = f as { code?: string; status?: number; message?: string };
      return fehler(reply, e.status ?? 502, e.code ?? 'fehler.post',
        e.message ?? 'Senden fehlgeschlagen.');
    }
  });

  /* ── Postfach: Anhänge ─────────────────────────────────────────
   *
   * Der Inhalt selbst liegt im Blockspeicher (services/ablage.ts, art
   * 'mail'), nicht hier — diese drei Routen sind die einzige Berührung mit
   * den Bytes: ausliefern, hochladen (für eine noch nicht gesendete Mail),
   * verwerfen (Schreibfenster ohne zu senden geschlossen).
   *
   * KEIN VIRENSCHUTZ: ein Anhang aus fremder Post wird ungeprüft
   * entgegengenommen und ungeprüft ausgeliefert. Die Oberfläche sagt das
   * ausdrücklich (siehe PostAnhaenge.tsx) — diese Route täuscht keine
   * Sicherheit vor, die es nicht gibt.
   */

  /**
   * Einen Anhang herunterladen — nur wer die Mail lesen darf (`mail.lesen`,
   * dieselbe Schwelle wie jede andere Postfach-Route), und nur, wenn er
   * wirklich an einer Mail hängt: `post.anhangFuerAuslieferung()` lässt einen
   * noch nicht verknüpften Entwurfsanhang gar nicht erst durch.
   *
   * `requireLeser` statt `requireUser`, wie bei `/storage/:id` oben: ein
   * Downloadknopf ist ein `<a href>`, kein `fetch()` mit eigenem Kopf — der
   * Nachweis muss deshalb auch in der Adresse (`?token=`) gehen dürfen.
   *
   * IMMER `application/octet-stream` und IMMER `attachment` — nie der vom
   * Absender BEHAUPTETE Typ, nie inline, ganz gleich was in der Datenbank
   * steht oder wie die Datei heißt. Das ist der Unterschied zu `/storage/:id`
   * und `/files/:id` oben, die für Bilder/PDF eine Ausnahme machen: DIESE
   * Bytes kommen von einem Fremden im Internet, nicht von einem angemeldeten
   * Kollegen, und verdienen deshalb keine. Ein als `bild.png` benannter
   * HTML-Anhang bleibt damit eine Datei, die der Browser herunterlädt — nie
   * eine, die er rendert oder ausführt.
   */
  app.get('/api/post/anhang/:id', async (req, reply) => {
    const userId = requireLeser(req);
    requirePermission(userId, 'mail.lesen');
    const { id } = req.params as { id: string };
    const anhang = post.anhangFuerAuslieferung(id);
    if (!anhang) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diesen Anhang gibt es nicht.');

    reply.header('content-type', 'application/octet-stream');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(anhang.name)}`);

    const strom = ablage.oeffnen({ id: anhang.id, art: 'mail', pfad: anhang.path, encoding: anhang.encoding });
    if (!strom) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diesen Anhang gibt es nicht.');
    return reply.send(strom);
  });

  /**
   * Einen Anhang für eine noch nicht gesendete Mail hochladen — Schreibfenster
   * (PostSchreiben.tsx) und die Antwort im Postfach-Reiter nutzen dieselbe
   * Route. `mail.senden`, nicht `mail.lesen`: nur wer senden darf, soll
   * überhaupt etwas anhängen können. Größe hier grob gedeckelt (dieselbe
   * Grenze wie /api/uploads); die scharfe Prüfung je Anhang und insgesamt
   * sitzt in post.senden() (siehe dort, AUSGANG_ANHANG_MAX).
   */
  app.post('/api/post/anhang', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.senden');
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) return fehler(reply, 400, 'fehler.keineDatei', 'Keine Datei im Request');

    const id = newId('ma_');
    const target = path.join(config.uploadDir, id);
    try {
      await pipeline(file.file, fs.createWriteStream(target));
    } catch (err) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 500, 'fehler.uploadFehlgeschlagen',
        `Upload fehlgeschlagen: ${(err as Error).message}`, { grund: (err as Error).message });
    }
    if (file.file.truncated) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 413, 'fehler.dateiZuGross',
        `Datei überschreitet ${config.maxUploadBytes / 1024 / 1024} MB`,
        { mb: String(config.maxUploadBytes / 1024 / 1024) });
    }

    const size = (await fs.promises.stat(target)).size;
    const anhang = post.ausgehenderAnhangAnlegen({
      id, name: file.filename || 'datei', mime: file.mimetype || 'application/octet-stream',
      size, storedPath: target, hochgeladenVon: userId,
    });
    return { anhang };
  });

  /** Einen noch nicht gesendeten Anhang verwerfen — z. B. beim Schließen des
      Schreibfensters ohne zu senden. */
  app.delete('/api/post/anhang/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.senden');
    const { id } = req.params as { id: string };
    const weg = post.ausgehenderAnhangVerwerfen(id, userId);
    if (!weg) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diesen Anhang gibt es nicht.');
    return { ok: true };
  });

  /* ── Postfach: frei verfassen ─────────────────────────────────
     Für das Schreibfenster: die Fächer, aus denen gesendet werden darf, und
     die gelernte Sprache einer Adresse — beide lesend, beide hinter
     `mail.senden`, weil beide nur zum Verfassen einer neuen Mail gebraucht
     werden (anders als `mail.lesen`, das die vorhandene Post zeigt). */

  app.get('/api/post/schreibfaecher', async (req) => {
    requirePermission(requireUser(req), 'mail.senden');
    return { faecher: post.absenderFaecher() };
  });

  app.get('/api/post/sprache', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.senden');
    const q = req.query as { adresse?: string };
    if (!q?.adresse) return fehler(reply, 400, 'fehler.unvollstaendig', 'Eine Adresse ist nötig.');
    return { sprache: post.spracheFuer(post.nurAdresse(q.adresse)) };
  });

  /**
   * Einen Mailentwurf von der KI schreiben lassen — nie senden.
   *
   * Dieselbe Reihenfolge wie überall im Postfach: `requirePermission` vor
   * dem Aufruf, nicht danach. Anders als bei `/api/post/senden` verlässt
   * hier zwar nichts das Haus, aber das Recht ist dasselbe (`mail.senden`)
   * wie am Sendeknopf selbst — wer keine Post verschicken darf, soll auch
   * keine Modellaufrufe für ausgehende Firmenpost auslösen.
   */
  app.post('/api/post/ki-entwurf', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.senden');
    const k = req.body as {
      modus?: string; mailId?: string; fach?: string; an?: string; thema?: string;
    };
    try {
      if (k?.modus === 'antwort') {
        if (!k.mailId) return fehler(reply, 400, 'fehler.unvollstaendig', 'Eine Nachricht ist nötig.');
        return await postEntwurfKi.entwurfSchreiben({ modus: 'antwort', mailId: k.mailId });
      }
      if (k?.modus === 'neu') {
        if (!k.fach || !k.an || !k.thema) {
          return fehler(reply, 400, 'fehler.unvollstaendig', 'Fach, Empfänger und Thema sind nötig.');
        }
        return await postEntwurfKi.entwurfSchreiben({ modus: 'neu', fach: k.fach, an: k.an, thema: k.thema });
      }
      return fehler(reply, 400, 'fehler.unvollstaendig', 'Unbekannter Modus.');
    } catch (f) {
      const e = f as { code?: string; status?: number; message?: string; werte?: Record<string, string> };
      /* Abweisung (util/abweisung.ts) trägt keinen eigenen Status — anders
         als PostFehler ist sie bewusst statuslos, die Route entscheidet.
         Eine fehlende Mail ist 404, eine unvollständige oder von der KI
         abgelehnte Angabe 400, alles andere (KI nicht eingerichtet, nicht
         erreichbar, Fenster zu klein) 502 — die Ursache liegt dann nicht
         beim Aufruf, sondern beim Modell dahinter. */
      const status = e.status ?? (
        e.code === 'fehler.nichtGefunden' ? 404
          : e.code === 'post.kiOhneThema' || e.code === 'post.kiOhneEntwurf' ? 400
            : 502
      );
      return fehler(reply, status, e.code ?? 'fehler.post',
        e.message ?? 'Die KI konnte keinen Entwurf schreiben.', e.werte);
    }
  });

  /* ── Postfach: KI-Entwürfe freigeben ─────────────────────────
     Was post-sichtung.ts an Entwürfen anlegt, muss ein Mensch freigeben — die
     KI sendet dort bewusst nie selbst (siehe Dateikopf dort: `post.senden`
     ist in diese Datei absichtlich gar nicht erst eingebunden). `an`,
     `betreff`, `text` und `begruendung` liegen verschlüsselt in
     `mail_entwuerfe`; hier wird nichts roh aus der Tabelle gelesen, nur über
     `offeneEntwuerfe()` und `entwurfLesen()`. In `begruendung` steht bei
     abweichender Reply-To-Domäne ein Warnsatz (siehe `abweichungsHinweis()`
     dort) — er hängt am normalen Feld und kommt hier ungekürzt mit. */

  app.get('/api/post/entwuerfe', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const q = req.query as { anzahl?: string };
    return { entwuerfe: postSichtung.offeneEntwuerfe(Number(q.anzahl) || 50) };
  });

  app.get('/api/post/entwuerfe/:id', async (req, reply) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const entwurf = postSichtung.entwurfLesen((req.params as { id: string }).id);
    if (!entwurf) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diesen Entwurf gibt es nicht.');
    return { entwurf };
  });

  /**
   * Genau eine Mailadresse — wortgleich mit der Prüfung in post.ts und
   * post-sichtung.ts. Duplikat statt Import, aus demselben Grund, den beide
   * Stellen für sich schon nennen: keine der beiden Dateien exportiert sie,
   * und diese Route ist gerade die dritte, unabhängige Stelle, die genau
   * diese eine Frage beantworten muss ("ist das wirklich nur EINE Adresse?"),
   * unmittelbar bevor `entwurf.an` tatsächlich verwendet wird — siehe die
   * Begründung direkt an der Prüfung unten.
   */
  const EINE_ADRESSE = /^[^\s@,;:<>"'()[\]\\]+@[^\s@,;:<>"'()[\]\\]+\.[^\s@,;:<>"'()[\]\\]{2,}$/;

  /**
   * Einen Entwurf freigeben und senden — mit dem Text, den ein Mensch gerade
   * geprüft und womöglich verändert hat.
   *
   * GEÄNDERTE REGEL: Der Entwurf kannte bis eben keine Bearbeitung — „freige-
   * geben wird genau das, was geprüft wurde". Der Auftraggeber wollte den
   * Text vor dem Senden anpassen können, zu Recht: sonst schreibt man die
   * Antwort bei jeder Kleinigkeit von Hand neu, und der Entwurf war umsonst.
   * Die neue Regel: was im Feld steht, geht hinaus. `text` und `betreff`
   * kommen deshalb jetzt aus der Anfrage, nicht mehr ausschließlich aus dem
   * gespeicherten Entwurf.
   *
   * `an` NICHT: Die Empfängeradresse bleibt, wo sie war — aus dem
   * gespeicherten Entwurf, nie aus der Anfrage. Das ist keine Regel, die sich
   * mit dem Wunsch nach Bearbeitung ändert: Sie darf weiterhin niemals aus
   * etwas stammen, das sich von außen beeinflussen ließe (siehe Dateikopf
   * post-sichtung.ts, „an kommt niemals aus dem Modell" — dieselbe Grenze,
   * jetzt zusätzlich gegen den Anfragekörper dieser Route gezogen, selbst
   * wenn ein Mensch mit `mail.senden` dahintersteht). `EINE_ADRESSE` prüft
   * sie hier trotzdem noch einmal, obwohl `entwurfAnlegen()` das beim
   * Anlegen längst tat: eine gespeicherte Adresse ist erst unmittelbar vor
   * der tatsächlichen Verwendung wirklich geprüft, nicht nur irgendwann
   * beim Entstehen.
   *
   * `fach` DAGEGEN DARF sich ändern — anders als der Empfänger bestimmt es
   * nur die eigene Absenderadresse, kein Ziel, das sich missbrauchen ließe.
   * Vorgabe ist das Fach der URSPRUNGSMAIL (`mail.fach`, siehe unten) —
   * dieselbe Vorbelegung wie im Freigabe-Kasten der Oberfläche (EntwurfKarte
   * in PostPanel.tsx). Ein aus der Anfrage mitgegebenes Fach ersetzt diese
   * Vorgabe, wird aber genau wie überall sonst NICHT hier, sondern in
   * `post.senden()` selbst gegen `FAECHER` geprüft (siehe dort) — ein
   * erfundenes Fach oder `sonstiges` kommt dort nicht durch.
   *
   * Reihenfolge weiterhin absichtlich: erst `requirePermission`, DANN der
   * bearbeitete Text FESTGEHALTEN (`entwurfBearbeiten()` — sonst stünde im
   * Verlauf hinterher etwas anderes als das, was tatsächlich hinausging),
   * DANN `post.senden()`, erst danach `entwurfAbschliessen()` als
   * Buchführung. `entwurfAbschliessen` prüft `mail.senden` zwar selbst noch
   * einmal (siehe dort — das schützt jeden künftigen zweiten Aufrufer, der
   * nicht über diese Route läuft), aber das reicht hier nicht: säße die
   * einzige Prüfung dort, würde die Mail schon verschickt, BEVOR die
   * fehlende Berechtigung überhaupt auffiele.
   */
  app.post('/api/post/entwuerfe/:id/senden', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.senden');
    const { id } = req.params as { id: string };

    const k = req.body as { text?: string; betreff?: string; anhaenge?: string[]; fach?: string };
    const text = (k?.text ?? '').trim();
    const betreff = (k?.betreff ?? '').trim();
    if (!text || !betreff) {
      return fehler(reply, 400, 'post.entwurfUnvollstaendig', 'Betreff und Text dürfen nicht leer sein.');
    }

    const entwurf = postSichtung.entwurfLesen(id);
    if (!entwurf) return fehler(reply, 404, 'fehler.nichtGefunden', 'Diesen Entwurf gibt es nicht.');
    /* Hier wird nur abgewiesen, worüber wirklich ENTSCHIEDEN ist. Über
       `sendet` entscheidet allein `entwurfBearbeiten()` weiter unten — und
       zwar mit demselben bedingten UPDATE, das auch den Anspruch vergibt.
       Zwei Stellen, die dieselbe Frage beantworten, waren hier schon einmal
       eine zu viel: stünde die Abweisung auch hier, käme ein Entwurf, dessen
       Anspruch nach einem Serverabsturz verfallen ist, nie wieder hinaus —
       `offeneEntwuerfe()` zeigt ihn nach der Frist wieder an (siehe dort),
       und der Mensch klickte dann auf einen Knopf, der immer 409 sagt. */
    if (entwurf.zustand !== 'offen' && entwurf.zustand !== 'sendet') {
      return fehler(reply, 409, 'fehler.entwurfEntschieden', 'Über diesen Entwurf ist schon entschieden.');
    }
    // Letzte Prüfung der gespeicherten Empfängeradresse, unmittelbar bevor
    // sie verwendet wird — siehe Begründung im Dateikopf dieser Route oben.
    // Sollte praktisch nie greifen (entwurfAnlegen() prüft das schon beim
    // Anlegen); greift sie doch, ist das ein Zeichen für eine beschädigte
    // Zeile und kein Fall, den ein Mensch durch erneutes Klicken löst.
    if (!EINE_ADRESSE.test(entwurf.an)) {
      console.error('[post/entwuerfe] Entwurf mit ungültiger Empfängeradresse:', id);
      return fehler(reply, 500, 'post.entwurfAdresseUngueltig',
        'Der gespeicherte Entwurf hat keine gültige Empfängeradresse.');
    }

    /* Festhalten UND BEANSPRUCHEN, beides vor dem Versand und beides in einem
       einzigen bedingten UPDATE (siehe entwurfBearbeiten() in
       post-sichtung.ts). Festhalten, damit im Verlauf hinterher nicht etwas
       anderes steht als das, was tatsächlich hinausging. Beanspruchen, weil
       die Prüfung auf `zustand === 'offen'` weiter oben allein nichts
       aufhält: von dort bis zum `await` unten ist alles synchron, zwei fast
       gleichzeitige Anfragen kamen deshalb beide hier durch und riefen beide
       den Versanddienst auf — der Kunde bekam dieselbe Antwort zweimal.

       `false` heißt jetzt zweierlei: entweder ist über den Entwurf inzwischen
       entschieden, oder ein anderer Aufruf hat ihn gerade in der Mache. Für
       den Menschen davor ist das dasselbe — er soll nicht noch einmal
       klicken. */
    if (!postSichtung.entwurfBearbeiten(id, { text, betreff })) {
      return fehler(reply, 409, 'fehler.entwurfEntschieden', 'Über diesen Entwurf ist schon entschieden.');
    }

    // Woher geschrieben wird (`fach`) kommt VORRANGIG aus der URSPRUNGSMAIL
    // — also aus dem Fach, an das der Kunde geschrieben hat, nicht aus dem
    // Entwurf: der kennt gar kein eigenes Fach (siehe entwurfAnlegen() in
    // post-sichtung.ts). Ein in der Anfrage mitgegebenes Fach (Auswahl im
    // Freigabe-Kasten) geht vor — siehe Dateikopf dieser Route für die
    // Begründung, warum das für `fach` anders gehandhabt wird als für `an`.
    const mail = post.nachricht(entwurf.mailId);
    if (!mail) {
      // Der Anspruch von eben gehört zurück — hier geht nichts hinaus, und
      // der Entwurf soll nicht fünf Minuten lang unsendbar bleiben.
      postSichtung.entwurfAnspruchLoesen(id);
      return fehler(reply, 404, 'fehler.nichtGefunden', 'Die Ursprungsmail gibt es nicht mehr.');
    }

    let versandt: { id: string };
    try {
      versandt = await post.senden({
        fach: k.fach || mail.fach,
        an: entwurf.an,
        betreff,
        text,
        // Der Wortlaut, wie die KI ihn geschrieben hat — nie überschrieben
        // (schema.sql, `mail_entwuerfe.text_ki`). `post.senden()` vergleicht
        // ihn selbst gegen `text` (den möglicherweise bearbeiteten, gerade
        // freigegebenen Wortlaut) und setzt daraus die Fußzeile der Mail.
        textKi: entwurf.textKi,
        antwortAuf: { messageId: mail.messageId, referenzen: mail.referenzen, threadId: entwurf.threadId },
        // Wie beim freien Antworten (`/api/post/senden` oben): Kennungen
        // zuvor hochgeladener, noch nicht verknüpfter Anhänge — `userId` als
        // zweites Argument von senden() ist deshalb hier NICHT optional
        // ausgelassen, sonst schlägt anhaengeZumVersandLesen() mit
        // 'post.anhangOhneKonto' fehl, sobald der Kasten in PostPanel.tsx
        // (EntwurfKarte) einen Anhang mitgibt.
        anhaenge: Array.isArray(k.anhaenge) ? k.anhaenge : undefined,
      }, userId);
    } catch (f) {
      /* Der Versand ist gescheitert, also war der Anspruch umsonst: zurück
         auf `offen`, damit derselbe Mensch es sofort noch einmal versuchen
         kann. Ohne das wäre jeder Aussetzer des Versanddienstes eine Sperre
         von fünf Minuten auf einem Entwurf, der nie hinausging.

         Nur HIER, und ausdrücklich nirgends weiter unten: was nach einem
         erfolgreichen Versand noch schiefgeht, darf den Entwurf nie wieder
         auf `offen` zurückstellen — sonst schickt ihn jemand guten Glaubens
         ein zweites Mal, und genau das soll diese ganze Änderung
         verhindern. */
      postSichtung.entwurfAnspruchLoesen(id);
      const e = f as { code?: string; status?: number; message?: string };
      return fehler(reply, e.status ?? 502, e.code ?? 'fehler.post',
        e.message ?? 'Senden fehlgeschlagen.');
    }

    /* Die Mail ist jetzt hinaus — alles Weitere ist nur noch Buchführung.
       Der Entwurf steht seit dem entwurfBearbeiten() oben auf `sendet` und
       gehört diesem Aufruf; entwurfAbschliessen() nimmt genau diesen Zustand
       ausdrücklich an (siehe dort).

       HIER STAND EINMAL, ein zweiter, fast gleichzeitiger Klick sei an
       dieser Stelle bloß eine seltene Verwicklung ohne Folgen. Das war
       falsch, und zwar genau andersherum: der zweite Klick meldete hier brav
       'nichtOffen' — nachdem seine eigene Mail beim Kunden bereits
       angekommen war. Die Meldung kam, als nichts mehr zu retten war. Ein
       zweiter Versand wird deshalb nicht mehr hier bemerkt, sondern oben
       verhindert, bevor er stattfindet.

       Was hier übrig bleibt, ist wirklich harmlos: ein 'keinRecht', weil im
       selben Sekundenbruchteil ein Recht entzogen wurde, oder ein
       'nichtOffen', weil nach fünf Minuten jemand den Anspruch übernommen
       hat. Beides ändert nichts mehr am Versand — der ist geschehen. Nur
       protokolliert, nicht dem Menschen als Fehler gezeigt: der hat gerade
       erfolgreich gesendet. */
    const ergebnis = postSichtung.entwurfAbschliessen({
      entwurfId: id, userId, ergebnis: 'gesendet', gesendetId: versandt.id,
    });
    if (ergebnis !== 'ok') {
      console.error(`[post/entwuerfe] gesendet, aber Buchführung meldet "${ergebnis}":`, id);
    }
    return { ok: true, gesendetId: versandt.id };
  });

  /**
   * Einen Entwurf ablehnen — nichts geht hinaus, nur der Zustand ändert sich.
   *
   * Kein eigener `requirePermission`-Aufruf vorab: anders als beim Senden gibt
   * es hier keine Außenwirkung, die vor der Prüfung passieren könnte.
   * `entwurfAbschliessen()` prüft `mail.lesen` selbst (siehe dort) und gibt
   * eine Kennung zurück, die diese Route in ihre eigene Meldung übersetzt.
   */
  app.post('/api/post/entwuerfe/:id/ablehnen', async (req, reply) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    const ergebnis = postSichtung.entwurfAbschliessen({ entwurfId: id, userId, ergebnis: 'abgelehnt' });
    if (ergebnis === 'unbekannt') return fehler(reply, 404, 'fehler.nichtGefunden', 'Diesen Entwurf gibt es nicht.');
    if (ergebnis === 'nichtOffen') {
      return fehler(reply, 409, 'fehler.entwurfEntschieden', 'Über diesen Entwurf ist schon entschieden.');
    }
    // Wirft mit derselben Meldung wie jede andere fehlende Berechtigung im
    // Haus — die Kennung 'keinRecht' vom Dienst und dieser Wurf meinen
    // dasselbe Recht, hier wird nur eins davon tatsächlich gebraucht.
    if (ergebnis === 'keinRecht') requirePermission(userId, 'mail.lesen');
    return { ok: true };
  });

  /**
   * Der Reiter „Post-Sichtung": strukturiert, was die KI aus eingegangener
   * Post gemacht hat — neueste zuerst, `vor` zum Nachladen (dieselbe Kennung
   * wie bei `/api/post/liste`: der `gesichtetAm`-Wert der letzten schon
   * geladenen Zeile).
   *
   * Nur `mail.lesen`, keine engere Rolle: wer die Post selbst lesen darf,
   * darf auch sehen, wie die KI sie eingeordnet hat — das ist dieselbe
   * Schwelle wie bei jeder anderen Postfach-Route oben. Die engere Runde
   * (Leitung/Administration) betrifft nur, WER live benachrichtigt wird
   * (`empfaengerkreis()` in post-sichtung.ts), nicht wer den Reiter öffnen
   * darf.
   */
  app.get('/api/post/meldungen', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const q = req.query as { anzahl?: string; vor?: string };
    return {
      meldungen: postSichtung.meldungenListe(Number(q.anzahl) || 50, q.vor ? Number(q.vor) : undefined),
    };
  });

  /**
   * Zustand und Dringlichkeit für eine Handvoll Mails auf einen Schlag —
   * für die Färbung und die Sortierung nach Dringlichkeit im Postfach-Reiter
   * selbst (PostPanel.tsx). Dieselbe Schwelle wie `/api/post/meldungen`
   * direkt darüber: `mail.lesen` genügt.
   */
  app.get('/api/post/sichtungen', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const q = req.query as { ids?: string };
    const ids = (q.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { sichtungen: postSichtung.sichtungenFuer(ids) };
  });

  /**
   * Eingehende Post vom Cloudflare Email Worker.
   *
   * Anders als die Postfach-Routen oben: kein `requireUser`. Diese Route
   * hängt öffentlich am Tunnel und weist sich stattdessen über das mit dem
   * Worker geteilte Geheimnis aus (`x-stellium-eingang`) — die ganze
   * Prüfkette (Geheimnis, Ratenbremse, zeitunabhängiger Vergleich,
   * Feldgrößen, Typen) steht gesammelt in posteingang.ts, mit der
   * Begründung aus dem Bedrohungsmodell im Dateikopf dort.
   */
  registerPostEingang(app);

  /* ── Verkauf: der Gumroad-Schlüssel ──────────────────────────
     Ohne ihn kennt die Konsole nur die öffentlichen Zahlen. Hinterlegen darf
     ihn der Inhaber; ansehen kann ihn niemand, auch er nicht. */
  app.get('/api/verkauf/zugang', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'verkauf.verwalten');
    return verkaufzugang.tokenStand();
  });

  app.post('/api/verkauf/zugang', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'verkauf.verwalten');
    const körper = req.body as { token?: string };
    verkaufzugang.tokenSetzen(körper?.token ?? '', userId);
    return verkaufzugang.tokenStand();
  });

  /* ── Verkauf: Patreon ─────────────────────────────────────────
     Vier Werte statt einem (siehe verkaufzugang.ts), aber dieselbe
     Rechteprüfung wie beim Gumroad-Schlüssel. Die Client-ID kommt in der
     Antwort mit, weil sie kein Geheimnis ist; Secret, Access- und
     Refresh-Token nie. */
  app.get('/api/verkauf/patreon', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'verkauf.verwalten');
    return verkaufzugang.patreonStand();
  });

  app.post('/api/verkauf/patreon', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'verkauf.verwalten');
    const körper = req.body as {
      clientId?: string; clientSecret?: string; accessToken?: string; refreshToken?: string;
    };
    verkaufzugang.patreonSetzen(körper ?? {}, userId);
    return verkaufzugang.patreonStand();
  });

  /* ── Verkauf: Patreon — Erneuerung, Diagnose, Kennzahlen ─────
     Rein additiv zum Block oben, damit hier niemand in dieselben Zeilen wie
     die Gumroad-Anbindung (verkaufzugang.ts, gemeinsam bearbeitet) muss.

     `erneuerung` und `diagnose` verlangen verkauf.verwalten — dieselbe
     Schwelle wie beim Eintragen der Zugangsdaten, weil beide indirekt auch
     Zugangsdaten SCHREIBEN (eine fällige Erneuerung tauscht Access- und
     Refresh-Token aus). `kennzahlen` verlangt nur verkauf.sehen — dieselbe
     Schwelle wie `abo`/`kaufquote` in /api/systemwerte, weil hier dieselbe
     Art Zahl herauskommt: was das Geschäft einbringt, nicht wie der Zugang
     eingerichtet ist. */
  app.get('/api/verkauf/patreon/erneuerung', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'verkauf.verwalten');
    return patreon.patreonErneuerungsStand();
  });

  /**
   * Prüflauf gegen die echte Patreon-Schnittstelle: erneuert den
   * Zugriffstoken (nur wenn fällig, außer ?erneuern=1 erzwingt es), liest
   * die tatsächlich gewährten Rechte aus der Token-Antwort, ruft Kampagne
   * und eine Mitgliederseite ab und bestätigt jedes Feld einzeln. Liefert
   * ausschließlich Auskünfte — Zähler, Ja/Nein, Fehlertexte — nie einen
   * Token- oder Geheimniswert (siehe diagnoseLauf() in services/patreon.ts).
   */
  app.get('/api/verkauf/patreon/diagnose', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'verkauf.verwalten');
    const q = req.query as { erneuern?: string };
    return patreon.diagnoseLauf({ erneuernErzwingen: q.erneuern === '1' });
  });

  app.get('/api/verkauf/patreon/kennzahlen', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'verkauf.sehen');
    try {
      return await patreon.patreonKennzahlen();
    } catch (f) {
      /* weiterreichen() statt fehler(): ein eigener Fehlertext bräuchte eine
         neue Kennung in ALLEN 22 Wörterbüchern (scripts/e2e-fehlertexte.mjs
         prüft das) — für einen seltenen 503 reicht der deutsche Rückfalltext,
         den weiterreichen() ohne Kennung mitschickt. */
      return weiterreichen(reply, 503, f);
    }
  });

  /* ── Verkauf: die ausführliche Ansicht ───────────────────────
   * Ein einziger Aufruf statt mehrerer — die Kachel UND ihre ausführliche
   * Ansicht (VerkaufDetailPanel.tsx) teilen sich diesen einen Weg, damit
   * beide immer denselben Stand zeigen. Gumroad und Patreon laufen dabei
   * unabhängig voneinander: fehlt eine der beiden Anbindungen oder scheitert
   * ihr Abruf gerade, bleibt das entsprechende Feld `null` und die andere
   * Hälfte der Antwort steht trotzdem. Zwei getrennte Felder statt eines
   * gemeinsamen Fehlers — sonst risse ein noch nicht eingerichtetes Patreon
   * die (funktionierende) Gumroad-Übersicht mit in einen 503.
   *
   * `gumroad.gumroadKennzahlen()` wirft praktisch nie (siehe services/
   * gumroad.ts: ein Sync-Fehlschlag wird dort selbst aufgefangen und liefert
   * den letzten bekannten Datenbankstand zurück) — der try/catch ist trotzdem
   * da, für den Fall eines unerwarteten Fehlers beim SQL-Lesen selbst.
   */
  app.get('/api/verkauf/uebersicht', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'verkauf.sehen');

    let gumroadWerte: Awaited<ReturnType<typeof gumroad.gumroadKennzahlen>> | null = null;
    try {
      gumroadWerte = await gumroad.gumroadKennzahlen();
    } catch (f) {
      console.error('[verkauf] Gumroad-Übersicht fehlgeschlagen:', (f as Error)?.message ?? f);
    }

    let patreonWerte: Awaited<ReturnType<typeof patreon.patreonKennzahlen>> | null = null;
    try {
      patreonWerte = await patreon.patreonKennzahlen();
    } catch {
      /* Nicht eingerichtet oder gerade nicht erreichbar — beides heißt hier
         schlicht "kein Patreon-Block in der Antwort", kein Fehlerfall. */
    }

    if (!gumroadWerte && !patreonWerte) {
      return weiterreichen(reply, 503, new Error('Weder Gumroad noch Patreon sind gerade erreichbar.'));
    }
    return {
      gumroad: gumroadWerte,
      patreon: patreonWerte,
      patreonVerlauf: patreonWerte ? patreon.patreonVerlauf() : [],
    };
  });

  /**
   * "Ein Kauf ist passiert" — der Verlauf für den neuen Reiter
   * (components/VerkaufMeldungen.tsx). Neueste zuerst, `vor` zum Nachladen —
   * dieselbe Kennung wie bei `/api/post/meldungen`: der `erkanntAm`-Wert der
   * letzten schon geladenen Zeile.
   *
   * `verkauf.sehen`, dieselbe Schwelle wie bei `/api/verkauf/uebersicht`
   * direkt darüber: wer die Verkaufszahlen selbst ansehen darf, darf auch
   * erfahren, dass sich daran gerade etwas geändert hat — keine engere Rolle,
   * kein zweites Recht dafür (siehe services/verkaufBenachrichtigung.ts,
   * empfaengerkreis()).
   */
  app.get('/api/verkauf/meldungen', async (req) => {
    requirePermission(requireUser(req), 'verkauf.sehen');
    const q = req.query as { anzahl?: string; vor?: string };
    return {
      meldungen: verkaufBenachrichtigung.meldungenListe(Number(q.anzahl) || 50, q.vor ? Number(q.vor) : undefined),
    };
  });

  /* ── Bank: der PayPal-Kontostand ─────────────────────────────
   * Reines Ansehen — kein Weg hier bewegt Geld (siehe services/paypal.ts,
   * Dateikopf, „DIE GRENZE, DIE NICHT VERHANDELBAR IST"). `zugang`,
   * `diagnose` und `aktualisieren` verlangen ausschließlich `bank.verwalten`
   * — dieselbe Schwelle wie bei `fern.verwalten` und `mail.verwalten`: wer
   * die Zugangsdaten selbst nicht einsehen darf (auch der Inhaber bekommt
   * `clientSecret` nie wieder zu sehen, siehe paypalZugangStand()), soll
   * auch keinen Prüflauf oder Sofortabruf gegen PayPal auslösen können.
   *
   * `uebersicht` allein verlangt `bank.sehen` ODER `bank.verwalten` — wer
   * den Zugang einrichten darf, muss auch sehen können, ob er funktioniert,
   * sonst richtet er blind ein. Derselbe Kniff wie bei `/api/releases/…`
   * weiter oben: `requirePermission()` wirft mit der Meldung des ZWEITEN
   * Rechts, wenn auch das fehlt.
   */
  app.get('/api/bank/paypal/uebersicht', async (req) => {
    const userId = requireUser(req);
    if (!users.may(userId, 'bank.sehen')) requirePermission(userId, 'bank.verwalten');
    /* paypalUebersicht() fragt PayPal NIE selbst — sie liest nur den
       Zwischenspeicher, den startPaypalJob() im Hintergrund füllt (siehe
       ws/gateway.ts). Deshalb kommt hier IMMER ein 200 zurück, auch für
       „nicht eingerichtet" und „letzter Abruf fehlgeschlagen": beides sind
       eigene, benannte Zustände (`zustand` im Antwortkörper, siehe
       PaypalUebersicht), keine Fehlerfälle. Ein 503 sähe für die Tafel
       identisch aus wie „der eigene Server ist nicht erreichbar"
       (PaypalPanel.tsx unterscheidet genau danach) — und „noch nicht
       eingerichtet" ist kein Fehlschlag, sondern ein Ausgangszustand. */
    return paypal.paypalUebersicht();
  });

  app.get('/api/bank/paypal/zugang', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'bank.verwalten');
    return paypal.paypalZugangStand();
  });

  app.post('/api/bank/paypal/zugang', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'bank.verwalten');
    const körper = req.body as { clientId?: string; clientSecret?: string; umgebung?: string };
    paypal.paypalZugangSetzen(körper ?? {}, userId);
    return paypal.paypalZugangStand();
  });

  /**
   * Prüflauf gegen die echte PayPal-Schnittstelle: Token holen, Rechte
   * auslesen, Salden und ein kurzes Bewegungsfenster abrufen. Liefert
   * ausschließlich Auskünfte zurück — Zähler, Ja/Nein, Zeitpunkte, PayPals
   * eigener Wortlaut, PayPals Korrelationskennung —, nie Client-ID, Secret
   * oder Token (siehe paypalDiagnose() in services/paypal.ts).
   */
  app.get('/api/bank/paypal/diagnose', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'bank.verwalten');
    return paypal.paypalDiagnose();
  });

  /** Ein Abrufdurchgang von Hand, außerhalb des Taktes aus startPaypalJob()
   *  — für „sofort prüfen, ob es jetzt klappt", ohne auf den nächsten
   *  Hintergrundlauf zu warten. Dieselbe Einzelspur wie im Hintergrundlauf:
   *  läuft bereits einer, wird er mitbenutzt, nicht doppelt gestartet. */
  app.post('/api/bank/paypal/aktualisieren', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'bank.verwalten');
    return paypal.paypalAktualisieren();
  });

  /* ── Postfach: Zugangsdaten ──────────────────────────────────
     Genau wie beim Fernzugang: hinterlegen darf nur der Inhaber, ANSEHEN
     kann es niemand. Zurück kommt bloß, DASS etwas hinterlegt ist. Ein
     Schlüssel, den man versehentlich weiterreichen kann, ist keiner mehr. */
  app.get('/api/post/zugang', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.verwalten');
    return mailzugang.zugangStand();
  });

  /** Eine Domäne, keine vollständige Adresse: kein "@", keine Leerzeichen,
      mindestens ein Punkt, nur die Zeichen, aus denen ein Hostname wirklich
      besteht. Geprüft hier in der Route, nicht in mailzugang.ts — dieselbe
      Aufteilung wie bei der Mindestlänge des Eingangsgeheimnisses direkt
      darunter (siehe zugangSetzen() in mailzugang.ts für die Begründung). */
  const DOMAENE_FORM = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

  app.post('/api/post/zugang', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.verwalten');
    const körper = req.body as {
      domaene?: string; name?: string; versandSchluessel?: string; eingangGeheimnis?: string;
    };
    /* Nur die Domäne, nie eine vollständige Adresse — der lokale Teil kommt
       ab jetzt ausschließlich aus dem Fach beim Versand (siehe
       services/post.ts, senden()). Eine Adresse mit "@" hier durchzulassen
       hieße, denselben Fehler nur an anderer Stelle wieder einzubauen: das
       "@" und alles davor würde beim Versand ohnehin verworfen (siehe
       fachKennung() in post.ts) — wer trotzdem eine Adresse einträgt, soll
       das lieber hier erfahren als sich später über eine Absenderadresse
       wundern, die nicht die eingetippte ist. */
    if (körper?.domaene && !DOMAENE_FORM.test(körper.domaene.trim())) {
      return fehler(reply, 400, 'post.domaeneUngueltig',
        'Das sieht nicht nach einer Domäne aus — ohne "@", ohne Leerzeichen, etwa "stellium.club".');
    }
    /* Ein zu kurzes Eingangsgeheimnis ist schlimmer als keins: es sieht nach
       Schutz aus. Der Worker legt es jeder Anfrage bei, und dieser Endpunkt
       hängt öffentlich am Tunnel. */
    if (körper?.eingangGeheimnis && körper.eingangGeheimnis.trim().length < 32) {
      return fehler(reply, 400, 'fehler.zuKurz',
        'Das Eingangsgeheimnis braucht mindestens 32 Zeichen.');
    }
    mailzugang.zugangSetzen(körper ?? {}, userId);
    return mailzugang.zugangStand();
  });

  app.delete('/api/post/zugang', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.verwalten');
    mailzugang.zugangLoeschen(userId);
    return mailzugang.zugangStand();
  });

  app.post('/api/fern/zugang', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'fern.verwalten');
    const körper = req.body as { adresse?: string; passwort?: string; kennung?: string };
    fernzugang.zugangSetzen(körper ?? {}, userId);
    /* Zurück kommt der Stand, nicht das Hinterlegte. */
    return fernzugang.zugangStand();
  });

  app.delete('/api/fern/zugang', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'fern.verwalten');
    fernzugang.zugangLoeschen(userId);
    return fernzugang.zugangStand();
  });

  app.post('/api/releases/:platform', async (req, reply) => {
    const userId = requireUser(req);
    // Neue Versionen zu verteilen heißt, auf jedem Rechner Code auszuführen.
    // Deshalb ein eigenes Recht dafür — und nicht die Kontoverwaltung.
    //
    // Vorher hing es an `user.manage`. Das war zu grob: der Bau-Zugang, der
    // Fassungen hochlädt, hätte damit auch Passwörter zurücksetzen und Rollen
    // ändern dürfen. Er soll genau eines können, und das ist dieses eine.
    // Wer Konten verwaltet, darf es weiterhin auch — sonst müsste man sich
    // das Recht erst selbst geben, um eine Fassung nachzuschieben.
    if (!users.may(userId, 'user.manage')) requirePermission(userId, 'release.publish');

    const { platform } = req.params as { platform: string };
    const datei = await req.file({ limits: { fileSize: 600 * 1024 * 1024 } });
    if (!datei) return fehler(reply, 400, 'fehler.keineDatei', 'Keine Datei im Request');

    const felder = datei.fields as Record<string, { value?: string } | undefined>;
    const version = typeof felder?.version?.value === 'string' ? felder.version.value.trim() : '';
    const notes = typeof felder?.notes?.value === 'string' ? felder.notes.value : null;

    const temp = path.join(config.releaseDir, `.upload-${newId('rl_')}`);
    try {
      await pipeline(datei.file, fs.createWriteStream(temp));
      if (datei.file.truncated) throw new Error('Die Datei ist zu groß (mehr als 600 MB).');
      const info = releases.publish({
        platform: platform as never,
        version,
        notes,
        fileName: datei.filename || 'stellium',
        tempPath: temp,
        publishedBy: userId,
      });
      // Alle laufenden Clients sollen die neue Version sofort bemerken. Roh,
      // ohne Übersetzung: dieses Ereignis stößt beim Empfänger nur eine neue
      // Prüfung an (siehe state/store.ts, 'release:available') und zeigt
      // `release` selbst nirgends an — dort holt sich jede Person die
      // Notizen anschließend über /api/releases/check in ihrer Sprache.
      broadcastAll({ t: 'release:available', release: info });
      return {
        release: { ...info, notes: notizenFuerBetrachter(platform, userId, info.notes) },
        releases: releases.listReleases().map((r) => ({
          ...r, notes: notizenFuerBetrachter(r.platform, userId, r.notes),
        })),
      };
    } catch (err) {
      await fs.promises.rm(temp, { force: true });
      return weiterreichen(reply, 400, err);
    }
  });

  app.delete('/api/releases/:platform', async (req) => {
    const userId = requireUser(req);
    if (!users.may(userId, 'user.manage')) requirePermission(userId, 'release.publish');
    releases.removeRelease((req.params as { platform: string }).platform);
    return {
      releases: releases.listReleases().map((r) => ({
        ...r, notes: notizenFuerBetrachter(r.platform, userId, r.notes),
      })),
    };
  });

  /**
   * Die Seite zum Herunterladen — nur für Angemeldete.
   *
   * Seit der Quelltext öffentlich ist, ist auch die Adresse dieses Servers
   * bekannt. Die Installationsdateien gehören trotzdem dem Team: wer keinen
   * Zugang hat, hat hier nichts zu holen. Der Nachweis darf in der Adresse
   * stehen (`?token=`), weil ein Browserfenster keinen Kopf mitschickt.
   */
  app.get('/download', async (req, reply) => {
    const userId = bearerOderAdresse(req);
    if (!userId) {
      // Zur Anmeldung schicken statt eine leere Seite zu zeigen.
      return reply.redirect('/');
    }
    const ua = String((req.headers['user-agent'] ?? ''));
    // Kein Accept-Language-Aushandeln nötig: wer hier ankommt, hat sich schon
    // ausgewiesen (Bearer oder ?token=, sonst der Redirect oben) — genau die
    // Kennung, mit der auch notizenFuerBetrachter() unten übersetzt. Dieselbe
    // Sprache, die die Person sich in den Einstellungen ausgesucht hat, ist
    // treffsicherer als eine aus Kopfzeilen geratene; siehe seite.ts für die
    // ausführliche Begründung.
    return reply.type('text/html; charset=utf-8').send(downloadSeite({
      releases: releases.listReleases().map((r) => ({
        ...r, notes: notizenFuerBetrachter(r.platform, userId, r.notes),
      })),
      erkannt: systemErkennen(ua),
      arbeitsbereich: config.workspaceName,
      token: (req.query as { token?: string } | undefined)?.token ?? '',
      sprache: store.uiLanguageOf(userId),
      zeitzone: store.timezoneOf(userId),
    }));
  });

  /** Die Datei selbst — ebenfalls nur mit Nachweis. */
  app.get('/download/:platform', async (req, reply) => {
    requireLeser(req);
    const { platform } = req.params as { platform: string };
    // Das Serverpaket gehört nicht auf die öffentliche Seite.
    if (platform === 'server') return fehler(reply, 404, 'fehler.nichtGefunden', 'Nicht gefunden');
    const vorhanden = releases.getRelease(platform);
    if (!vorhanden || !fs.existsSync(vorhanden.path)) {
      return fehler(reply, 404, 'fehler.keinBauSystem', 'Für dieses System liegt nichts bereit.');
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(vorhanden.size));
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(vorhanden.fileName)}`);
    reply.header('x-stellium-sha256', vorhanden.sha256);
    return reply.send(fs.createReadStream(vorhanden.path));
  });

  app.get('/releases/:platform/download', async (req, reply) => {
    const leser = requireLeser(req);
    const { platform } = req.params as { platform: string };
    /* Das Serverpaket ist kein Client — es enthält den kompletten Quelltext
       samt Einrichtung und gehört in die Hände derer, die den Server auch
       betreiben. Die App-Pakete darf dagegen jedes Teammitglied laden, sonst
       könnte sich niemand aktualisieren. */
    if (platform === 'server') requirePermission(leser, 'user.manage');
    const vorhanden = releases.getRelease(platform);
    if (!vorhanden || !fs.existsSync(vorhanden.path)) {
      return fehler(reply, 404, 'fehler.keinBauPlattform', 'Für diese Plattform liegt nichts bereit.');
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(vorhanden.size));
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(vorhanden.fileName)}`);
    reply.header('x-stellium-sha256', vorhanden.sha256);
    return reply.send(fs.createReadStream(vorhanden.path));
  });

  app.get('/storage/:id', async (req, reply) => {
    const userId = requireLeser(req);
    const { id } = req.params as { id: string };
    const datei = files.getFile(id);
    if (!datei) return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');

    // Hängt die Datei an einem Kanal, gilt dessen Mitgliederkreis. Sonst
    // käme jeder mit der Kennung an Anhänge aus fremden Kanälen.
    if (datei.channelId && !store.memberIds(datei.channelId).includes(userId)) {
      return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    }

    /* Eine private Datei geht nur an ihren Besitzer. Öffnen könnte sie ohnehin
       niemand sonst — aber sie herauszugeben hieße, ihre bloße Existenz und
       ihre Größe zu bestätigen, und dafür gibt es keinen Grund. Dieselbe
       Antwort wie bei "gibt es nicht": sonst verriete schon der Unterschied,
       dass es sie gibt. */
    if (datei.privat && datei.uploadedBy !== userId) {
      return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    }

    /* Private Dateien gehen nie inline hinaus. Was hier liegt, ist Chiffrat:
       als Bild angezeigt ergäbe es ein kaputtes Bild, und der Browser bekäme
       eine Angabe über den Inhalt, die nicht stimmt. Die App holt sich die
       Datei, entschlüsselt sie und zeigt sie selbst an. */
    const inline = !datei.privat && inlineTauglich(datei.mime);
    reply.header('content-type', datei.privat ? 'application/octet-stream' : datei.mime);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(datei.name)}`);

    const strom = ablage.oeffnen({
      id: datei.id, art: 'file', pfad: datei.path, encoding: datei.encoding,
    });
    if (!strom) return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    return reply.send(strom);
  });

  /**
   * Anhänge ausliefern — nur an Leute, die den Kanal auch sehen dürfen.
   *
   * Der Nachweis darf in der Adresse stehen (`?token=`), weil ein `<img src>`
   * keinen Kopf mitschicken kann. Ohne diese Prüfung genügte die Kennung einer
   * Datei, um sie zu holen — auch aus einem Kanal, in dem man nichts verloren
   * hat, und ganz ohne Anmeldung.
   */
  app.get('/files/:id', async (req, reply) => {
    const leser = bearerOderAdresse(req);
    if (!leser) return fehler(reply, 401, 'fehler.nichtAngemeldet', 'Nicht angemeldet');

    const { id } = req.params as { id: string };
    const row = db.get<{
      path: string; mime: string; name: string; message_id: string | null;
      uploader_id: string; encoding: string | null; huelle: string | null;
    }>(
      'SELECT path, mime, name, message_id, uploader_id, encoding, huelle FROM attachments WHERE id = ?', id,
    );
    if (!row) return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');

    if (row.message_id) {
      const msg = db.get<{ channel_id: string }>(
        'SELECT channel_id FROM messages WHERE id = ?', row.message_id,
      );
      // Gleiche Antwort wie bei „gibt es nicht": sonst verrät schon der
      // Unterschied, dass diese Datei existiert.
      if (!msg || !store.memberIds(msg.channel_id).includes(leser)) {
        return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
      }
    } else if (row.uploader_id !== leser) {
      // Noch an keiner Nachricht: gehört bis dahin dem, der sie hochgeladen hat.
      return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    }

    /* Ein verschlüsselter Anhang geht nie inline hinaus — genau wie eine
       private Datei in /storage/:id, und aus demselben Grund: was hier liegt,
       ist Chiffrat. Als Bild ausgeliefert ergäbe es ein kaputtes Bild, und der
       Browser bekäme eine Angabe über den Inhalt, die nicht stimmt. Die App
       holt sich die Bytes, schließt sie auf und zeigt sie selbst an. */
    const verschlossen = Boolean(row.huelle);
    const inline = !verschlossen && inlineTauglich(row.mime);
    reply.header('content-type', verschlossen ? 'application/octet-stream' : row.mime);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    reply.header('cache-control', 'private, max-age=31536000, immutable');

    const strom = ablage.oeffnen({ id, art: 'attachment', pfad: row.path, encoding: row.encoding });
    if (!strom) return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    return reply.send(strom);
  });
}

/**
 * Darf eine hochgeladene Datei im Browser direkt angezeigt werden?
 *
 * Der Typ ist eine Behauptung des Hochladenden (multipart-Kopf, bei
 * `/api/uploads/bekannt` sogar ein freies JSON-Feld). `image/svg+xml` ist
 * ein Dokument mit Skript: inline ausgeliefert läuft es unter DIESER Adresse,
 * also unter derselben Herkunft wie die Browser-Oberfläche — und der Link
 * dorthin trägt das `?token=` der Person, die ihn öffnet (FilesPanel.tsx
 * öffnet Ablage-Dateien in einem neuen Tab). Ein Kollege lädt eine SVG mit
 * Skript hoch, jemand klickt auf „Herunterladen", und das Skript liest das
 * fremde Token aus der eigenen Adresse. Als Anhang ausgeliefert lädt der
 * Browser sie nur herunter; ein <img src> zeigt sie trotzdem an, weil der
 * die Kopfzeile `content-disposition` gar nicht beachtet.
 */
function inlineTauglich(mime: string): boolean {
  if (/svg|xml/i.test(mime)) return false;
  return /^(image|video|audio)\//.test(mime) || mime === 'application/pdf';
}

/** Bildmaße aus dem Header lesen — reicht für PNG, JPEG, GIF und WebP. */
async function imageSize(file: string): Promise<{ width: number; height: number } | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);

    if (b.length > 24 && b.toString('ascii', 1, 4) === 'PNG') {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = b.toString('ascii', 12, 16);
      if (fmt === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fmt === 'VP8X') return { width: (b.readUIntLE(24, 3) & 0xffffff) + 1, height: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < b.length) {
        if (b[offset] !== 0xff) { offset++; continue; }
        const marker = b[offset + 1];
        const len = b.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
        }
        offset += 2 + len;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}
