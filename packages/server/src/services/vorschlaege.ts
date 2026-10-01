import {
  istE2EChiffrat,
  type PermissionKey, type Vorschlag, type VorschlagAenderung,
  type VorschlagArt, type VorschlagZustand,
} from '@stellium/shared';
import { db, nurSichtbareKanaele } from '../db/index.js';
import { newId } from '../util/id.js';
import { abdruck as fingerabdruck, entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { getSetting, setSetting } from './settings.js';
import { may } from './users.js';
import * as store from './store.js';
import * as tasks from './tasks.js';
import * as ideas from './ideas.js';
import * as events from './events.js';
import * as vertraulich from './vertraulich.js';
import { assistantUserId } from './assistant.js';
import { vorschlaegeAusVerlauf, type KiVorschlag } from './ai.js';

/**
 * Vorschläge — die Zwischenstufe zwischen "die KI hat etwas erkannt" und
 * "es steht auf dem Brett".
 *
 * DIE HALTUNG
 *
 * Die KI schlägt vor, der Mensch entscheidet. Bisher legte die Erkennung die
 * Aufgaben selbst an; wer den Knopf drückte, fand hinterher fünf Karten auf
 * dem Brett, von denen zwei stimmten. Zwei Treffer und drei Aufräumarbeiten
 * sind unterm Strich keine Hilfe. Ein Vorschlag, den man mit einem Griff
 * annimmt, ist eine.
 *
 * EIN EINGANG, ZWEI TÜREN
 *
 * Aufgaben und Ideen liegen in **einer** Liste, nicht in je einem Reiter am
 * eigenen Brett. Drei Gründe:
 *
 *   1. Der Morgen. Zwei Reiter mit je zwei Vorschlägen sind zwei Orte, an die
 *      man denken muss. Einer mit vier ist eine Gewohnheit.
 *   2. Die Art ist selbst geraten. Ob etwas Aufgabe oder Idee ist, entscheidet
 *      das Modell — und liegt manchmal daneben. In getrennten Reitern landet
 *      ein falsch einsortierter Vorschlag dort, wo niemand ihn sucht, und ist
 *      verloren. In einer Liste ist die Art ein Schalter auf der Karte: aus
 *      einem Fehlgriff wird ein Klick.
 *   3. Die Handlung ist dieselbe. Annehmen, ablehnen, ändern — das
 *      unterscheidet sich nicht danach, was hinterher daraus wird.
 *
 * Dons "jeweils" bleibt trotzdem wahr: beide Bretter bekommen eine Tür in
 * diesen Eingang, vorgefiltert auf ihre Art.
 *
 * WER EINEN VORSCHLAG SIEHT
 *
 * Genau eine Person. Ein Vorschlag, den fünf Leute sehen und keiner annimmt,
 * weil jeder den anderen meint, ist schlechter als gar keiner. Hat die KI
 * jemanden genannt, ist es diese Person; sonst die, die die Nachricht
 * geschrieben hat — sie weiß am ehesten, ob daraus Arbeit wird und für wen.
 *
 * DUBLETTEN
 *
 * Zwei Sperren, beide in der Datenbank und nicht im Arbeitsspeicher:
 * die UNIQUE-Bedingung über (Kanal, Art, Abdruck) und die Marke, bis zu
 * welcher Nachricht ein Kanal schon gelesen wurde. Ein Neustart darf nicht
 * dazu führen, dass morgen noch einmal ankommt, was gestern abgelehnt wurde.
 *
 * VERTRAULICHE KANÄLE
 *
 * Dort entsteht kein Vorschlag. Siehe `NIE_IN_VERTRAULICHEN_KANAELEN` weiter
 * unten — die Prüfung steht an sechs Stellen einzeln, aus demselben Grund, aus
 * dem `klartextNoetig()` im Gateway an jeder Stelle einzeln steht: eine
 * Prüfung, die man beim Hinzufügen einer Funktion vergessen kann, ist keine.
 */

/* ── Was hier alles nicht in einen vertraulichen Kanal darf ───── */

/**
 * Die sechs Wege, auf denen ein Vorschlag mit dem Klartext eines
 * vertraulichen Kanals in Berührung käme — und wo jeder davon zugemacht ist.
 *
 * Die Liste steht als Text da, damit sie sich beim Lesen prüfen lässt und
 * damit ein Prüflauf sie zählen kann. Wer hier einen Weg ergänzt, ohne ihn
 * zuzumachen, sieht es an der fehlenden Fundstelle.
 */
export const NIE_IN_VERTRAULICHEN_KANAELEN = [
  'lauf-kanalwahl',      // faelligeKanaele(): c.vertraulich = 0 steht in der Abfrage
  'lauf-eingang',        // laufFuerKanal(): weist ab, bevor eine Nachricht gelesen wird
  'eintragen',           // kandidatenEintragen(): weist ab, egal woher die Kandidaten kommen
  'lauf-inhalt',         // zeilenBauen(): jede Zeile mit Chiffrat fliegt heraus
  'quelle',              // quelleLesbar(): ein Chiffrat geht nie als Wortlaut hinaus
  'annehmen',            // annehmen(): weist ab, wenn der Kanal inzwischen vertraulich ist
  'lesen',               // listeFuer(): Kanäle, die vertraulich wurden, fallen heraus
  'aufraeumen',          // kanalGeschlossen(): löscht alles, was zu dem Kanal gehört
] as const;

/* ── Stellschrauben ───────────────────────────────────────────── */

/** Wie oft der Hintergrundlauf überhaupt nachsieht. */
const TAKT_MS = 5 * 60_000;
/**
 * Wie viele neue Nachrichten ein Kanal braucht, bevor gelesen wird.
 *
 * Nicht bei jeder Nachricht: das Modell läuft womöglich auf einem Raspberry
 * Pi, und drei Zeilen Smalltalk ergeben ohnehin keine Aufgabe.
 */
const MINDEST_NEU = 6;
/**
 * Wie lange ein Kanal still sein muss, bevor gelesen wird.
 *
 * Mitten im Gespräch gelesen entstehen halbfertige Aufgaben: "Preis klären"
 * steht dann als Vorschlag, während zwei Zeilen weiter schon der Preis steht.
 */
const RUHE_MS = 3 * 60_000;
/** Wie oft ein und derselbe Kanal höchstens gelesen wird. */
const ABSTAND_JE_KANAL_MS = 30 * 60_000;
/** Wie viele Kanäle je Takt — einer, damit ein kleines Modell nachkommt. */
const KANAELE_JE_TAKT = 1;
/**
 * Wann ein unbeachteter Vorschlag verfällt.
 *
 * Ein Eingang, in dem Vorschläge von vor drei Wochen liegen, ist kein
 * Eingang mehr, sondern ein Friedhof — und die Zahl daneben wird zu Rauschen.
 * Verfallen heißt nicht abgelehnt: die Zeile bleibt stehen (sonst käme
 * derselbe Vorschlag wieder), aber sie zählt nicht und wird nicht gezeigt.
 */
const VERFALL_MS = 14 * 86_400_000;

/** Marke je Kanal: bis hierher wurde gelesen. Überlebt den Neustart. */
function markeSchluessel(channelId: string): string { return `vorschlaege_ab:${channelId}`; }
/** Wann der Kanal zuletzt gelesen wurde. Ebenfalls in den Einstellungen. */
function laufSchluessel(channelId: string): string { return `vorschlaege_lauf:${channelId}`; }

/* ── Form nach außen ──────────────────────────────────────────── */

/** Wie viel vom Wortlaut der Quelle mitgeschickt wird. */
const QUELLE_ZEICHEN = 400;

/**
 * Der Wortlaut der Quelle — oder nichts.
 *
 * Sieht hier ein Chiffrat heraus, geht es nicht hinaus. Der Kanal wird an
 * anderer Stelle geprüft; diese Prüfung greift am Inhalt und fängt damit auch
 * den Fall, dass eine Nachricht nach dem Vorschlag verschlüsselt wurde.
 */
function quelleLesbar(gespeichert: string | null | undefined): string | null {
  if (!gespeichert) return null;
  if (istE2EChiffrat(gespeichert)) return null;
  const klar = entschluesseln(gespeichert);
  if (istE2EChiffrat(klar)) return null;
  return klar.slice(0, QUELLE_ZEICHEN);
}

function zuVorschlag(r: any): Vorschlag {
  return {
    id: r.id,
    art: r.art as VorschlagArt,
    zustand: r.zustand as VorschlagZustand,
    titel: entschluesseln(r.titel),
    channelId: r.channel_id,
    channelName: r.channel_name ?? '',
    quelleMessageId: r.quelle_message_id ?? null,
    quelleText: quelleLesbar(r.quelle_text),
    quelleUserId: r.quelle_user_id ?? null,
    quelleAm: r.quelle_am ?? null,
    fuerUserId: r.fuer_user_id,
    genanntUserId: r.genannt_user_id ?? null,
    faelligAm: r.faellig_am ?? null,
    beginntAm: r.beginnt_am ?? null,
    dauerMinuten: r.dauer_minuten ?? null,
    erstelltAm: r.erstellt_am,
    ergebnisId: r.ergebnis_id ?? null,
  };
}

/**
 * Der Titel, auf den die Dublettensperre schaut.
 *
 * Groß-/Kleinschreibung, Satzzeichen und doppelte Leerzeichen fallen weg,
 * damit "Angebot an Meier schicken." und "angebot an meier schicken" nicht
 * zweimal ankommen. Diakritika bleiben — "prüfen" und "prufen" sind zwei
 * verschiedene Wörter, und ein zu grober Abgleich verschluckt echte
 * Vorschläge.
 */
export function vereinheitlichen(titel: string): string {
  return titel.toLowerCase().replace(/[^\p{L}\p{Nd}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/* ── Lesen ────────────────────────────────────────────────────── */

const AUSWAHL = `
  SELECT v.*, c.name AS channel_name,
         m.text AS quelle_text, m.user_id AS quelle_user_id, m.created_at AS quelle_am
  FROM vorschlaege v
  JOIN channels c ON c.id = v.channel_id
  LEFT JOIN messages m ON m.id = v.quelle_message_id AND m.deleted_at IS NULL
`;

/**
 * Die offenen Vorschläge einer Person.
 *
 * `c.vertraulich = 0` ist die fünfte der sechs Sperren: wird ein Kanal
 * nachträglich vertraulich gestellt, verschwinden seine Vorschläge sofort aus
 * jeder Ansicht — auch wenn das Aufräumen aus irgendeinem Grund nicht lief.
 *
 * `nurSichtbareKanaele()` ist dieselbe Bedingung, die Aufgaben, Termine und
 * Ideen benutzen. Sie steht hier nicht zur Zierde: Adressat zu sein heißt
 * nicht, den Kanal noch sehen zu dürfen. Wer aus einem privaten Kanal
 * entfernt wird, hat seine Vorschläge weiter unter `fuer_user_id` stehen —
 * und in ihren Titeln steht, worüber dort geredet wurde.
 */
export function listeFuer(userId: string, jetzt = Date.now()): Vorschlag[] {
  const rows = db.all<any>(
    `${AUSWAHL}
     WHERE v.fuer_user_id = ? AND v.zustand = 'offen'
       AND c.vertraulich = 0
       AND ${nurSichtbareKanaele('v.channel_id')}
       AND v.erstellt_am > ?
     ORDER BY v.erstellt_am DESC LIMIT 200`,
    userId, userId, jetzt - VERFALL_MS,
  );
  return rows.map(zuVorschlag);
}

export function getVorschlag(id: string): Vorschlag | null {
  const r = db.get<any>(`${AUSWAHL} WHERE v.id = ?`, id);
  return r ? zuVorschlag(r) : null;
}

/** Wie viele offene Vorschläge jemand hat — für die Zahl an der Leiste. */
export function anzahlFuer(userId: string, jetzt = Date.now()): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM vorschlaege v JOIN channels c ON c.id = v.channel_id
     WHERE v.fuer_user_id = ? AND v.zustand = 'offen' AND c.vertraulich = 0
       AND ${nurSichtbareKanaele('v.channel_id')}
       AND v.erstellt_am > ?`,
    userId, userId, jetzt - VERFALL_MS,
  )?.n ?? 0;
}

/* ── Entscheiden ──────────────────────────────────────────────── */

export class VorschlagFehler extends Error {
  constructor(readonly kennung: string, nachricht: string) { super(nachricht); }
}

function nurEigener(id: string, userId: string): Vorschlag {
  const v = getVorschlag(id);
  if (!v) throw new VorschlagFehler('fehler.vorschlagWeg', 'Diesen Vorschlag gibt es nicht mehr.');
  /* Ohne diese Prüfung könnte jede:r mit einer bekannten Kennung fremde
     Vorschläge annehmen oder ablehnen — und damit in fremdem Namen Aufgaben
     anlegen. Die Oberfläche zeigt ohnehin nur die eigenen; darauf verlassen
     darf man sich nicht. */
  if (v.fuerUserId !== userId) {
    throw new VorschlagFehler('fehler.vorschlagFremd', 'Dieser Vorschlag gehört jemand anderem.');
  }
  if (v.zustand !== 'offen') {
    throw new VorschlagFehler('fehler.vorschlagEntschieden', 'Über diesen Vorschlag ist schon entschieden.');
  }
  return v;
}

/**
 * Annehmen — daraus wird eine echte Aufgabe oder Idee.
 *
 * Was sich hier noch ändern lässt: Titel, Art, zuständige Person, Frist. Genau
 * die vier entscheiden darüber, ob man Ja sagen kann, und genau die vier trifft
 * das Modell am ehesten knapp daneben. Alles andere — Beschreibung, Wichtigkeit,
 * Schlagwort, Status — gehört dem fertigen Ding und wird auf dem Brett
 * bearbeitet. Ein zweiter, schlechterer Aufgaben-Editor im Eingang hilft
 * niemandem.
 */
export function annehmen(id: string, userId: string, aenderung: VorschlagAenderung = {}): {
  vorschlag: Vorschlag; aufgabe: ReturnType<typeof tasks.getTask>; idee: ReturnType<typeof ideas.getIdea>;
} {
  const v = nurEigener(id, userId);

  /* Vierte Sperre. Zwischen Vorschlag und Annahme kann der Kanal vertraulich
     geworden sein. Der Titel hier stammt aus der Zeit davor — er als Aufgabe
     angelegt trüge den Klartext eines Kanals weiter, in dem längst nichts
     Lesbares mehr stehen darf. Also nicht annehmen, sondern wegräumen. */
  if (vertraulich.istVertraulich(v.channelId)) {
    kanalGeschlossen(v.channelId);
    throw new VorschlagFehler('fehler.vertraulich',
      'Der Kanal ist inzwischen vertraulich — der Vorschlag wurde verworfen.');
  }

  const art = aenderung.art ?? v.art;
  const titel = (aenderung.titel ?? v.titel).trim();
  if (titel.length < 3) {
    throw new VorschlagFehler('fehler.vorschlagTitel', 'Der Vorschlag braucht einen Titel.');
  }
  const zustaendig = aenderung.zustaendigId !== undefined
    ? aenderung.zustaendigId
    : (v.genanntUserId ?? userId);
  const faellig = aenderung.faelligAm !== undefined ? aenderung.faelligAm : v.faelligAm;

  let aufgabe: ReturnType<typeof tasks.getTask> = null;
  let idee: ReturnType<typeof ideas.getIdea> = null;

  if (art === 'aufgabe') {
    if (!may(userId, 'task.create')) {
      throw new VorschlagFehler('fehler.keinRechtName', 'Dafür fehlt dir das Recht "Aufgaben anlegen".');
    }
    // Ohne das Recht zum Übergeben landet sie bei einem selbst — dieselbe
    // Regel wie beim Anlegen von Hand.
    const anWen = may(userId, 'task.assign') ? zustaendig : userId;
    aufgabe = tasks.createTask({
      title: titel,
      assigneeId: anWen,
      channelId: v.channelId,
      messageId: v.quelleMessageId,
      dueAt: faellig,
      createdBy: userId,
    });
  } else {
    if (!may(userId, 'idea.create')) {
      throw new VorschlagFehler('fehler.keinRechtName', 'Dafür fehlt dir das Recht "Ideen einbringen".');
    }
    idee = ideas.createIdea({ title: titel, channelId: v.channelId, createdBy: userId });
  }

  const ergebnisId = aufgabe?.id ?? idee?.id ?? null;
  db.run(
    `UPDATE vorschlaege SET zustand = 'angenommen', titel = ?, abdruck = ?, art = ?,
            entschieden_am = ?, entschieden_von = ?, ergebnis_id = ?
     WHERE id = ?`,
    verschluesseln(titel), fingerabdruck(vereinheitlichen(titel)), art,
    Date.now(), userId, ergebnisId, id,
  );

  return { vorschlag: getVorschlag(id)!, aufgabe, idee };
}

/**
 * Ablehnen — und das Nein bleibt stehen.
 *
 * Die Zeile wird nicht gelöscht, sondern auf "abgelehnt" gesetzt. Sie belegt
 * damit weiter ihren Platz in der UNIQUE-Bedingung, und derselbe Vorschlag
 * kommt in diesem Kanal nie wieder. Ohne das käme er beim nächsten Lauf erneut
 * — und nach drei Tagen sieht niemand mehr hin.
 */
export function ablehnen(id: string, userId: string): Vorschlag {
  nurEigener(id, userId);
  db.run(
    "UPDATE vorschlaege SET zustand = 'abgelehnt', entschieden_am = ?, entschieden_von = ? WHERE id = ?",
    Date.now(), userId, id,
  );
  return getVorschlag(id)!;
}

/**
 * Rückgängig: die angelegte Aufgabe wieder weg, der Vorschlag wieder offen.
 *
 * Kein eigenes Gedächtnis nötig — `ergebnis_id` steht ja an der Zeile.
 */
export function zuruecknehmen(id: string, userId: string): Vorschlag {
  const v = getVorschlag(id);
  if (!v) throw new VorschlagFehler('fehler.vorschlagWeg', 'Diesen Vorschlag gibt es nicht mehr.');
  if (v.fuerUserId !== userId) {
    throw new VorschlagFehler('fehler.vorschlagFremd', 'Dieser Vorschlag gehört jemand anderem.');
  }
  if (v.zustand === 'angenommen' && v.ergebnisId) {
    if (v.art === 'aufgabe') tasks.deleteTask(v.ergebnisId);
    /* Einen Termin legt nur sofortEintragen() als echten Kalendereintrag an;
       annehmen() macht aus einem Termin-Vorschlag (noch) eine Idee. Deshalb
       am Ergebnis selbst nachsehen, nicht nur an der Art — sonst bliebe der
       Kalendereintrag nach dem Zurücknehmen stehen, und ein zweites
       Annehmen legte ihn doppelt an. */
    else if (v.art === 'termin' && events.getEvent(v.ergebnisId)) events.deleteEvent(v.ergebnisId);
    else ideas.deleteIdea(v.ergebnisId);
  }
  db.run(
    `UPDATE vorschlaege SET zustand = 'offen', entschieden_am = NULL,
            entschieden_von = NULL, ergebnis_id = NULL WHERE id = ?`, id,
  );
  return getVorschlag(id)!;
}

/* ── Aufräumen ────────────────────────────────────────────────── */

/**
 * Alles wegräumen, was zu einem Kanal gehört.
 *
 * Aufgerufen, wenn ein Kanal vertraulich wird: die Titel darin sind Klartext
 * aus der Zeit davor, und die hat in der Datenbank eines vertraulichen Kanals
 * nichts mehr verloren. Hier wird wirklich gelöscht und nicht auf "abgelehnt"
 * gesetzt — ein Gedächtnis, das den Klartext aufhebt, wäre genau das Leck.
 */
export function kanalGeschlossen(channelId: string): number {
  const weg = db.run('DELETE FROM vorschlaege WHERE channel_id = ?', channelId).changes;
  setSetting(markeSchluessel(channelId), null, 'system');
  setSetting(laufSchluessel(channelId), null, 'system');
  return weg;
}

/* ── Der Lauf ─────────────────────────────────────────────────── */

/**
 * Kanäle, in denen sich ein Lauf lohnt.
 *
 * Erste der sechs Sperren: `c.vertraulich = 0` steht in der Abfrage selbst.
 * Ein vertraulicher Kanal kommt gar nicht erst in die Auswahl — nicht "wird
 * später abgewiesen", sondern taucht nie auf.
 */
export function faelligeKanaele(jetzt = Date.now()): string[] {
  const kandidaten = db.all<{ id: string; letzte: number; neu: number }>(
    `SELECT c.id AS id, MAX(m.created_at) AS letzte, COUNT(m.id) AS neu
     FROM channels c JOIN messages m ON m.channel_id = c.id
     WHERE c.vertraulich = 0 AND c.archived = 0
       AND m.deleted_at IS NULL AND m.system_kind IS NULL
     GROUP BY c.id
     HAVING neu >= ?
     ORDER BY letzte DESC LIMIT 50`,
    MINDEST_NEU,
  );

  const dran: string[] = [];
  for (const k of kandidaten) {
    if (jetzt - k.letzte < RUHE_MS) continue;                       // noch im Gespräch
    const zuletzt = Number(getSetting(laufSchluessel(k.id)) ?? 0);
    if (jetzt - zuletzt < ABSTAND_JE_KANAL_MS) continue;            // eben erst gelesen

    const marke = getSetting(markeSchluessel(k.id));
    const neu = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages
       WHERE channel_id = ? AND deleted_at IS NULL AND system_kind IS NULL
         ${marke ? 'AND id > ?' : ''}`,
      ...(marke ? [k.id, marke] : [k.id]),
    )?.n ?? 0;
    if (neu < MINDEST_NEU) continue;

    dran.push(k.id);
    if (dran.length >= KANAELE_JE_TAKT) break;
  }
  return dran;
}

export interface LaufBericht {
  channelId: string;
  angelegt: Vorschlag[];
  /** Wie viele Vorschläge es schon gab oder gibt. */
  dubletten: number;
  /** Wie viele niemandem zugeordnet werden konnten. */
  ohneAdressat: number;
  /** Warum nichts passiert ist, falls nichts passiert ist. */
  grund?: 'vertraulich' | 'nichts-neues' | 'keine-ki';
}

/**
 * Ein Lauf über einen Kanal.
 *
 * Zweite der sechs Sperren, und die wichtigste: die Prüfung steht **vor** dem
 * ersten Lesen einer Nachricht. Nicht danach, nicht im Modell, nicht in der
 * Oberfläche — hier, bevor überhaupt eine Zeile aus der Datenbank kommt.
 */
/**
 * Ein Lauf je Kanal — nicht zwei gleichzeitig.
 *
 * Der Hintergrundtakt schützt sich selbst (`laeuft` unten), aber diese
 * Funktion ist exportiert: ein künftiger Aufrufer — ein Knopf, ein Import,
 * ein Prüflauf — könnte mitten in einem Modelllauf einen zweiten für
 * DENSSELBEN Kanal starten. Beide schnappten denselben Wasserstand, beide
 * lasen denselben Abschnitt, und der LANGSAMERE schriebe seine Marke zuletzt:
 * eine ältere Grenze über einer neueren — der nächste Lauf läse dieselben
 * Nachrichten noch einmal. Die Dublettenprüfung fängt das meiste auf, aber
 * "meistens" ist hier keine Antwort; ein zweiter Modelllauf kostet ohnehin
 * Geld für dasselbe Ergebnis.
 *
 * Deshalb: läuft für den Kanal schon einer, bekommt der zweite Aufrufer
 * DENSELBEN Bericht zurück statt eines zweiten Laufs.
 */
const laufend = new Map<string, Promise<LaufBericht>>();

export function laufFuerKanal(channelId: string): Promise<LaufBericht> {
  const schon = laufend.get(channelId);
  if (schon) return schon;
  const versprechen = laufFuerKanalEinmalig(channelId).finally(() => {
    // Nur wegräumen, wenn nicht inzwischen ein NEUER Lauf eingetragen wurde —
    // sonst löschte ein spät endender alter Lauf die Sperre des neuen.
    if (laufend.get(channelId) === versprechen) laufend.delete(channelId);
  });
  laufend.set(channelId, versprechen);
  return versprechen;
}

async function laufFuerKanalEinmalig(channelId: string): Promise<LaufBericht> {
  const leer: LaufBericht = { channelId, angelegt: [], dubletten: 0, ohneAdressat: 0 };

  if (vertraulich.istVertraulich(channelId)) {
    return { ...leer, grund: 'vertraulich' };
  }

  const kanal = store.getChannel(channelId);
  if (!kanal) return { ...leer, grund: 'nichts-neues' };

  const botId = assistantUserId();
  const marke = getSetting(markeSchluessel(channelId));

  /* Wasserstands-Schnappschuss VOR dem Lesen, nicht danach: Während der
     Modelllauf läuft (Sekunden bis Minuten), kommen weiter Nachrichten an.
     Stünde die Marke auf dem Stand von NACH dem Lauf, wären genau diese
     Nachrichten übersprungen — sie waren beim Lesen noch nicht da, gelten
     aber schon als gelesen. Der Schnappschuss vor dem Lauf markiert die
     Grenze dessen, was der Lauf überhaupt sehen konnte; alles Spätere bleibt
     neu und kommt in den nächsten Lauf. */
  const neuste = db.get<{ id: string }>(
    `SELECT id FROM messages WHERE channel_id = ?
       AND deleted_at IS NULL AND system_kind IS NULL
     ORDER BY id DESC LIMIT 1`, channelId,
  )?.id;

  const ergebnis = await vorschlaegeAusVerlauf({
    channelId,
    channelName: kanal.name,
    // Der Kanal hat eine Hauptsprache, sonst nimmt der Lauf Deutsch. Die
    // Sprache der lesenden Person kennt er nicht — es liest ja noch niemand.
    sprache: kanal.primaryLanguage ?? 'de',
    sinceMessageId: marke,
    ohneUserIds: botId ? [botId] : [],
  });

  const bericht = { ...kandidatenEintragen(channelId, ergebnis.vorschlaege), channelId };

  /* Erst nach dem Anlegen merken. Bricht etwas ab, wird derselbe Abschnitt
     noch einmal gelesen statt stillschweigend übersprungen. */
  if (neuste) setSetting(markeSchluessel(channelId), neuste, 'system');
  setSetting(laufSchluessel(channelId), String(Date.now()), 'system');

  return bericht;
}

/**
 * Kandidaten eintragen — ohne das Modell.
 *
 * Getrennt von `laufFuerKanal`, weil hier zwei ganz verschiedene Dinge
 * zusammenkämen: das Fragen eines Modells und die Buchhaltung darüber, was
 * daraus wird. Getrennt lässt sich die Buchhaltung prüfen, ohne dass ein
 * Modell laufen muss — und eine Prüfung, die von der Tagesform eines Modells
 * abhängt, prüft nichts.
 *
 * Dritte der Sperren: auch hier steht die Prüfung noch einmal. Wer diese
 * Funktion künftig von woanders aufruft — aus einem Knopf, aus einem Import,
 * aus einem Nachtlauf —, bekommt sie mit, ohne daran denken zu müssen.
 */
/** Welches Recht jemand braucht, damit aus der Art etwas werden kann. */
function rechtFuer(art: VorschlagArt): PermissionKey {
  if (art === 'aufgabe') return 'task.create';
  if (art === 'termin') return 'event.create';
  return 'idea.create';
}

/** Schlüssel der Einstellung: trägt die KI selbst ein, statt nur vorzuschlagen? */
export const SCHLUESSEL_SELBST_EINTRAGEN = 'ki_traegt_ein';

/**
 * Trägt die KI selbst ein?
 *
 * Aus: Jeder Fund wird ein Vorschlag, den ein Mensch annimmt — der bisherige
 * Weg, und die Vorgabe. Ein Brett bleibt so garantiert frei von Erfundenem.
 *
 * An: Der Fund wird sofort zu Aufgabe, Idee oder Termin — aber als „von der KI
 * angelegt, ungeprüft" gekennzeichnet und im Reiter „Prüfen" gesammelt. Das
 * ist der Handel: man muss nichts mehr annehmen, sieht aber jederzeit, was
 * ungelesen durchgerutscht ist.
 *
 * Der Vorschlag entsteht in beiden Fällen — er ist das Gedächtnis gegen
 * Dubletten. Im Selbsteintrag wird er nur sofort als angenommen verbucht.
 */
export function traegtSelbstEin(): boolean {
  return getSetting(SCHLUESSEL_SELBST_EINTRAGEN) === 'an';
}

export function selbstEintragenSetzen(an: boolean, userId: string): void {
  setSetting(SCHLUESSEL_SELBST_EINTRAGEN, an ? 'an' : null, userId);
}

/**
 * Aus einem eben angelegten Vorschlag sofort den echten Eintrag machen.
 *
 * Läuft nur im Selbsteintrag-Betrieb. Scheitert es (fehlendes Recht, ungültige
 * Zeit), bleibt der Vorschlag einfach offen stehen — dann entscheidet doch ein
 * Mensch, und nichts geht verloren.
 */
function sofortEintragen(v: Vorschlag): void {
  const wer = v.fuerUserId;
  try {
    let ergebnisId: string | null = null;
    if (v.art === 'aufgabe') {
      ergebnisId = tasks.createTask({
        title: v.titel,
        assigneeId: v.genanntUserId ?? wer,
        channelId: v.channelId,
        messageId: v.quelleMessageId,
        dueAt: v.faelligAm,
        createdBy: wer,
        vonKi: true,
      }).id;
    } else if (v.art === 'termin') {
      /* Ohne Beginn kein Termin — die Prüfung steht schon in ai.ts, hier
         noch einmal: ein Kalendereintrag auf "jetzt" wäre schlimmer als
         gar keiner. */
      if (!v.beginntAm) return;
      ergebnisId = events.createEvent({
        title: v.titel,
        startsAt: v.beginntAm,
        endsAt: v.beginntAm + (v.dauerMinuten ?? 60) * 60_000,
        channelId: v.channelId,
        attendeeIds: v.genanntUserId ? [v.genanntUserId] : [],
        createdBy: wer,
        vonKi: true,
      }).id;
    } else {
      ergebnisId = ideas.createIdea({
        title: v.titel, channelId: v.channelId, createdBy: wer, vonKi: true,
      }).id;
    }
    db.run(
      `UPDATE vorschlaege SET zustand = 'angenommen', entschieden_am = ?,
              entschieden_von = ?, ergebnis_id = ? WHERE id = ?`,
      Date.now(), wer, ergebnisId, v.id,
    );
  } catch {
    /* Kein Recht, keine gültige Zeit — dann bleibt es beim Vorschlag. */
  }
}

export function kandidatenEintragen(channelId: string, kandidaten: KiVorschlag[]): LaufBericht {
  const bericht: LaufBericht = { channelId, angelegt: [], dubletten: 0, ohneAdressat: 0 };
  if (vertraulich.istVertraulich(channelId)) return { ...bericht, grund: 'vertraulich' };

  const selbst = traegtSelbstEin();
  for (const kandidat of kandidaten) {
    const gebaut = anlegen(channelId, kandidat);
    if (gebaut === 'dublette') bericht.dubletten += 1;
    else if (gebaut === 'niemand') bericht.ohneAdressat += 1;
    else {
      if (selbst) sofortEintragen(gebaut);
      bericht.angelegt.push(gebaut);
    }
  }
  return bericht;
}

/**
 * Einen einzelnen Kandidaten zu einem Vorschlag machen.
 *
 * Gibt 'dublette' zurück, wenn es ihn schon gibt — als Vorschlag, als offene
 * Aufgabe oder als Idee. Und 'niemand', wenn sich kein Adressat findet, der
 * ihn überhaupt annehmen dürfte; ein Vorschlag, den der Empfänger nicht
 * annehmen kann, ist eine Sackgasse.
 */
function anlegen(channelId: string, k: KiVorschlag): Vorschlag | 'dublette' | 'niemand' {
  const rein = vereinheitlichen(k.titel);
  if (rein.length < 3) return 'dublette';
  const ab = fingerabdruck(rein);

  // Was in diesem Kanal schon als offene Aufgabe oder Idee steht, wird nicht
  // noch einmal vorgeschlagen.
  if (k.art === 'aufgabe') {
    const offen = tasks.listTasks({ channelId, includeFinished: false });
    if (offen.some((a) => vereinheitlichen(a.title) === rein)) return 'dublette';
  } else if (k.art === 'termin') {
    const kommend = db.all<{ title: string }>(
      'SELECT title FROM events WHERE channel_id = ? AND ends_at > ? LIMIT 200',
      channelId, Date.now(),
    );
    if (kommend.some((e) => vereinheitlichen(e.title) === rein)) return 'dublette';
  } else {
    const vorhanden = db.all<{ title: string }>(
      "SELECT title FROM ideas WHERE channel_id = ? AND status <> 'rejected' LIMIT 200", channelId,
    );
    if (vorhanden.some((i) => vereinheitlichen(i.title) === rein)) return 'dublette';
  }

  const adressat = adressatFuer(channelId, k);
  if (!adressat) return 'niemand';

  const id = newId('vs_');
  try {
    db.run(
      `INSERT INTO vorschlaege
         (id, art, zustand, titel, abdruck, channel_id, quelle_message_id,
          fuer_user_id, genannt_user_id, faellig_am, erstellt_am, beginnt_am, dauer_minuten)
       VALUES (?,?,'offen',?,?,?,?,?,?,?,?,?,?)`,
      id, k.art, verschluesseln(k.titel), ab, channelId, k.quelleMessageId,
      adressat, k.genanntUserId, k.faelligAm, Date.now(),
      k.beginntAm ?? null, k.art === 'termin' ? k.dauerMinuten : null,
    );
  } catch {
    /* Die UNIQUE-Bedingung hat zugeschlagen — genau dafür ist sie da. Sie
       greift auch dann, wenn der Vorschlag vor Wochen abgelehnt wurde und der
       Server seither dreimal neu gestartet ist. */
    return 'dublette';
  }
  return getVorschlag(id)!;
}

/**
 * Wem der Vorschlag gehört.
 *
 * Der Reihe nach: wen die KI genannt hat, sonst wer die Nachricht geschrieben
 * hat, sonst niemand. In jedem Fall muss die Person im Kanal sein, kein Bot
 * sein und das Recht haben, aus dem Vorschlag etwas zu machen.
 */
function adressatFuer(channelId: string, k: KiVorschlag): string | null {
  const recht = rechtFuer(k.art);
  const mitglieder = new Set(store.memberIds(channelId));
  const botId = assistantUserId();

  const taugt = (uid: string | null | undefined): uid is string => Boolean(
    uid && uid !== botId && mitglieder.has(uid) && may(uid, recht),
  );

  if (taugt(k.genanntUserId)) return k.genanntUserId;

  const schreiber = k.quelleMessageId
    ? db.get<{ user_id: string }>('SELECT user_id FROM messages WHERE id = ?', k.quelleMessageId)?.user_id
    : null;
  if (taugt(schreiber)) return schreiber;

  return null;
}

/* ── Zustellung ───────────────────────────────────────────────── */

type Zusteller = (userId: string, vorschlaege: Vorschlag[]) => void;
let zusteller: Zusteller | null = null;

/**
 * Wie ein neuer Vorschlag zu seiner Person kommt.
 *
 * Der Dienst kennt das Gateway nicht und soll es nicht kennen — sonst ließe er
 * sich in einem Prüflauf nicht ohne WebSocket starten. Das Gateway meldet sich
 * beim Start einmal hier an.
 */
export function zustellerSetzen(fn: Zusteller | null): void { zusteller = fn; }

function zustellen(neue: Vorschlag[]): void {
  if (!zusteller || !neue.length) return;
  const nachPerson = new Map<string, Vorschlag[]>();
  for (const v of neue) nachPerson.set(v.fuerUserId, [...(nachPerson.get(v.fuerUserId) ?? []), v]);
  for (const [uid, liste] of nachPerson) zusteller(uid, liste);
}

/**
 * Der Hintergrundlauf.
 *
 * Gibt eine Funktion zum Anhalten zurück — dieselbe Form wie
 * `startBackgroundJobs()` im Gateway, damit er sich dort in einer Zeile
 * einhängen lässt.
 */
export function startVorschlagJob(): () => void {
  let laeuft = false;

  const takt = setInterval(() => {
    if (laeuft) return;                 // ein langsames Modell soll sich nicht stauen
    laeuft = true;
    void (async () => {
      try {
        for (const channelId of faelligeKanaele()) {
          const bericht = await laufFuerKanal(channelId);
          zustellen(bericht.angelegt);
          if (bericht.angelegt.length) {
            console.log(`[vorschlaege] ${bericht.angelegt.length} neu aus #${channelId}`
              + (bericht.dubletten ? `, ${bericht.dubletten} schon bekannt` : ''));
          }
        }
      } catch (err) {
        // Ein Modell, das nicht antwortet, darf den Server nicht mitnehmen.
        console.warn('[vorschlaege]', (err as Error).message);
      } finally {
        laeuft = false;
      }
    })();
  }, TAKT_MS);

  return () => clearInterval(takt);
}

/* ── Für Prüfläufe ────────────────────────────────────────────── */

/**
 * Hat dieser Kanal Vorschläge — ohne Rücksicht auf Zustand und Adressat?
 *
 * Nur für Prüfläufe: die Frage "ist in einem vertraulichen Kanal wirklich
 * nichts entstanden?" lässt sich über `listeFuer` nicht ehrlich beantworten,
 * weil die Ansicht ohnehin filtert. Hier wird die Tabelle selbst gefragt.
 */
/**
 * Offene Vorschläge eines Kanals — zum Zurücknehmen von fremden Schirmen.
 *
 * Gleiche Form wie tasks.idsImKanal(): der Gateway räumt damit die Bretter
 * derer auf, die den Kanal gerade verloren haben.
 */
export function idsImKanal(channelId: string): string[] {
  return db.all<{ id: string }>(
    "SELECT id FROM vorschlaege WHERE channel_id = ? AND zustand = 'offen' LIMIT 500",
    channelId,
  ).map((r) => r.id);
}

export function zaehlenImKanal(channelId: string): number {
  return db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM vorschlaege WHERE channel_id = ?', channelId,
  )?.n ?? 0;
}

/** Steht in der Tabelle irgendwo dieser Klartext? Ebenfalls nur für Prüfläufe. */
export function klartextGefunden(text: string): boolean {
  const rein = text.toLowerCase();
  return db.all<{ titel: string }>('SELECT titel FROM vorschlaege').some((r) => {
    if (istE2EChiffrat(r.titel)) return false;
    return entschluesseln(r.titel).toLowerCase().includes(rein);
  });
}
