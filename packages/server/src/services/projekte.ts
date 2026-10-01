import { PROJEKT_FARBEN, type Projekt } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';

/**
 * Projekte — eine Schublade für Aufgaben, mehr nicht.
 *
 * Bewusst ohne Termine, Budgets und Phasen: wer das einbaut, hat am Ende ein
 * zweites Aufgabenbrett neben dem ersten, und beide erzählen etwas anderes.
 * Ein Projekt hat einen Namen, eine Farbe und einen Satz dazu; alles Weitere
 * steht an den Aufgaben selbst.
 *
 * Wird ein Projekt gelöscht, bleiben seine Aufgaben stehen und liegen wieder
 * ohne Projekt da (ON DELETE SET NULL). Das ist die freundlichere Richtung:
 * eine gelöschte Schublade darf keine Arbeit mitnehmen.
 */

const NAME_MAX = 80;
const BESCHREIBUNG_MAX = 2000;

function toProjekt(r: any): Projekt {
  return {
    id: r.id,
    name: r.name,
    beschreibung: r.beschreibung ?? null,
    farbe: r.farbe,
    archiviert: Boolean(r.archiviert),
    createdBy: r.created_by,
    createdAt: r.created_at,
    aufgaben: r.aufgaben ?? 0,
    fertig: r.fertig ?? 0,
  };
}

/**
 * Alle Projekte mit ihren Zahlen.
 *
 * Die beiden Zählungen kommen aus derselben Abfrage wie die Projekte selbst:
 * je Projekt einzeln zu zählen wären bei zwanzig Projekten einundzwanzig
 * Abfragen, und der Fortschrittsbalken hinge dem Brett hinterher.
 */
export function listProjekte(): Projekt[] {
  return db.all(
    `SELECT p.*,
            (SELECT COUNT(*) FROM tasks t WHERE t.projekt_id = p.id) AS aufgaben,
            (SELECT COUNT(*) FROM tasks t WHERE t.projekt_id = p.id AND t.status = 'finished') AS fertig
       FROM projekte p
      ORDER BY p.archiviert, p.name COLLATE NOCASE`,
  ).map(toProjekt);
}

export function getProjekt(id: string): Projekt | null {
  const r = db.get(
    `SELECT p.*,
            (SELECT COUNT(*) FROM tasks t WHERE t.projekt_id = p.id) AS aufgaben,
            (SELECT COUNT(*) FROM tasks t WHERE t.projekt_id = p.id AND t.status = 'finished') AS fertig
       FROM projekte p WHERE p.id = ?`, id,
  );
  return r ? toProjekt(r) : null;
}

export function createProjekt(input: {
  name: string;
  beschreibung?: string | null;
  farbe?: string;
  createdBy: string;
}): Projekt {
  const name = input.name.trim().slice(0, NAME_MAX);
  if (name.length < 2) throw new Error('Das Projekt braucht einen Namen.');
  /* Nur Farben aus der Liste: eine frei gewählte könnte unlesbar auf dem
     Hintergrund stehen oder — als Zeichenkette aus dem Netz — Unfug ins
     style-Attribut tragen. */
  const farbe = input.farbe && (PROJEKT_FARBEN as readonly string[]).includes(input.farbe)
    ? input.farbe : PROJEKT_FARBEN[0];

  const id = newId('pj_');
  db.run(
    'INSERT INTO projekte (id, name, beschreibung, farbe, created_by, created_at) VALUES (?,?,?,?,?,?)',
    id, name, input.beschreibung?.trim().slice(0, BESCHREIBUNG_MAX) || null, farbe,
    input.createdBy, Date.now(),
  );
  return getProjekt(id)!;
}

export interface ProjektPatch {
  name?: string;
  beschreibung?: string | null;
  farbe?: string;
  archiviert?: boolean;
}

export function updateProjekt(id: string, patch: ProjektPatch): Projekt {
  const vorhanden = getProjekt(id);
  if (!vorhanden) throw new Error('Projekt nicht gefunden.');

  const sets: string[] = [];
  const werte: any[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, NAME_MAX);
    if (name.length < 2) throw new Error('Das Projekt braucht einen Namen.');
    sets.push('name = ?'); werte.push(name);
  }
  if (patch.beschreibung !== undefined) {
    sets.push('beschreibung = ?'); werte.push(patch.beschreibung?.trim().slice(0, BESCHREIBUNG_MAX) || null);
  }
  if (patch.farbe !== undefined && (PROJEKT_FARBEN as readonly string[]).includes(patch.farbe)) {
    sets.push('farbe = ?'); werte.push(patch.farbe);
  }
  if (patch.archiviert !== undefined) {
    sets.push('archiviert = ?'); werte.push(patch.archiviert ? 1 : 0);
  }
  if (!sets.length) return vorhanden;

  db.run(`UPDATE projekte SET ${sets.join(', ')} WHERE id = ?`, ...werte, id);
  return getProjekt(id)!;
}

/** Löscht das Projekt; seine Aufgaben bleiben und liegen danach ohne Projekt. */
export function deleteProjekt(id: string): void {
  /* Auf nachgerüsteten Datenbanken ist tasks.projekt_id nur TEXT ohne
     Fremdschlüssel (db/migrate.ts) — ON DELETE SET NULL greift dort nicht,
     und die Aufgaben behielten eine tote Projektkennung. */
  db.transaction(() => {
    db.run('UPDATE tasks SET projekt_id = NULL WHERE projekt_id = ?', id);
    db.run('DELETE FROM projekte WHERE id = ?', id);
  });
}
