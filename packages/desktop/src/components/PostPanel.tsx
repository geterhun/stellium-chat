/**
 * Das Unternehmenspostfach — Fächer, ihre Liste und der Verlauf einer Post.
 *
 * Baut ausschließlich auf dem, was `packages/server/src/services/post.ts`
 * tatsächlich liefert: `faecher()`, `liste()`, `nachricht()`, `verlauf()` und
 * `senden()`. Die Strecke dorthin (`/api/post/*`) gibt es beim Schreiben
 * dieser Datei noch nicht — sie wird an anderer Stelle verdrahtet. Angenommen
 * ist deshalb nur die naheliegende Hülle je Route (siehe die `*Holen`-
 * Funktionen weiter unten, an der Kante zum Server benannt); weicht die
 * echte Antwort davon ab, genügt eine Zeile Anpassung dort.
 *
 * Zum HTML-Teil: `nachricht.html` kommt von außerhalb der Firma — von wem
 * auch immer an `support@` & Co. geschrieben hat. Standardmäßig zeigt diese
 * Tafel deshalb nur den Textteil. Wer HTML sehen will, muss das je Eintrag im
 * Verlauf ausdrücklich anklicken, und selbst dann läuft es durch ein
 * `<iframe sandbox="">` mit eigener, strenger Inhaltsrichtlinie statt durch
 * `dangerouslySetInnerHTML` — die Begründung steht bei `htmlDokument()`.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Archive, ArchiveRestore, ArrowDownLeft, ArrowUpRight, AtSign, CalendarClock,
  Clock, Forward, Inbox, Loader2, Mail, Paperclip, RefreshCw, RotateCcw, Search, Send, Sparkles,
  Trash2, X,
} from 'lucide-react';
import type { Absenderart, Dringlichkeit, MailAnhang, PostMeldungAbweichung } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { t as tStatisch, useT, type TranslationKey } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { PostSchreiben } from './PostSchreiben.jsx';
import { PostAnhaenge } from './PostAnhaenge.jsx';
import { PostFristAnzeige } from './PostFristAnzeige.jsx';
import { ApiError, serverUrl, token } from '../net/api.js';
import { clsx, dateTime, fileSize, relativeTime } from '../lib/format.js';
import { dringlichkeitFarbe } from '../lib/post-farben.js';

/* ── Die Daten, wie post.ts sie liefert ────────────────────────────
   Lokal noch einmal erklärt statt aus dem Serverpaket importiert: das
   Postfach ist neu, und einen Import über die Paketgrenze zum Server gibt es
   in der Oberfläche sonst nirgends — das wäre eine eigene, hier nicht
   gewollte Abhängigkeit. */

interface PostNachricht {
  id: string;
  fach: string;
  richtung: 'ein' | 'aus';
  von: string;
  an: string;
  betreff: string;
  text: string;
  html: string | null;
  messageId: string | null;
  referenzen: string | null;
  threadId: string | null;
  am: number;
  gelesen: boolean;
  /* MailAnhang statt einer eigenen, lokalen Hülle: anders als bei
     PostNachricht selbst ist das kein Import über die Paketgrenze zum
     SERVER — @stellium/shared ist hier schon für Absenderart/Dringlichkeit
     im Einsatz (siehe oben) und genau der Ort, an dem Server und Oberfläche
     dieselbe Anhang-Form teilen sollen: Anzeige (PostAnhaenge.tsx) und
     Ablieferung (services/post.ts) müssen wortgleich meinen, was `id: null`
     bedeutet. */
  anhaenge: MailAnhang[];
  /** Aus dem Blickfeld genommen, ohne gelöscht zu sein — Zeitpunkt oder null.
      Umkehrbar, siehe archivSetzen() weiter unten. */
  archiviertAm: number | null;
  /** „Aus dem Weg geräumt", umkehrbar, ohne Zeitfenster — Zeitpunkt oder
      null. Siehe entfernenSetzen()/wiederherstellenSetzen() weiter unten. */
  entferntAm: number | null;
  /** Wann die Aufbewahrungsfrist des FACHS dieser Mail ablaufen würde — null,
      solange für dieses Fach keine Frist gesetzt ist. Muss sichtbar sein,
      BEVOR sie zuschlägt — siehe VerlaufEintrag weiter unten. */
  verfaelltAm: number | null;
}

interface PostFach {
  fach: string;
  gesamt: number;
  ungelesen: number;
}

/** Welcher Ausschnitt der Liste: der Alltag, das Archiv, oder der
    Papierkorb — dieselben drei Werte wie post.PostAnsicht auf dem Server. */
type PostAnsicht = 'aktiv' | 'archiviert' | 'papierkorb';

/** Die Aufbewahrungsfrist eines einzelnen Fachs, wie `GET /api/post/fristen`
    sie liefert — dieselbe Hülle wie post.FristStand auf dem Server. */
interface PostFristStand {
  fach: string;
  tage: number | null;
  gesetztVon: string | null;
  gesetztAm: number | null;
}

/**
 * Zustand und Einordnung der KI-Sichtung zu einer Mail — die kleine Hülle
 * für `GET /api/post/sichtungen`, gebraucht für die Färbung und die
 * Sortierung nach Dringlichkeit weiter unten. Nur die Felder, die dafür
 * zählen; die volle Form (Anliegen, Begründung, Sprache, Modell) trägt
 * `PostMeldung` aus `@stellium/shared` und gehört dem Reiter
 * „Post-Sichtung" (PostMeldungen.tsx), nicht dieser Tafel hier.
 */
interface SichtungKurz {
  zustand: 'laeuft' | 'gemeldet' | 'entwurf' | 'gesendet' | 'abgelehnt' | 'fehler';
  einordnung: { absenderart: Absenderart; dringlichkeit: Dringlichkeit } | null;
}

/**
 * Ein KI-Antwortentwurf, so wie `GET /api/post/entwuerfe` ihn liefert — lokal
 * gespiegelt wie `PostNachricht` oben, aus demselben Grund: kein Import aus
 * dem Server-Paket (`PostEntwurf` dort trägt zusätzliche, unverschlüsselte
 * Felder wie `abweichung`, die post-sichtung.ts erst beim Auspacken
 * berechnet — hier steht nur die Hülle, wie sie über HTTP ankommt). Den
 * rohen KI-Wortlaut (`text_ki`) bekommt diese Tafel bewusst nie zu sehen —
 * er bleibt am Entwurf in der Datenbank, `post.senden()` liest ihn dort
 * selbst nach, siehe die Route `/api/post/entwuerfe/:id/senden`.
 *
 * `abweichung` ist derselbe Werte-Typ wie `PostMeldung.abweichung` — beide
 * füllen denselben Wörterbucheintrag `postSichtung.abweichung`, deshalb aus
 * `@stellium/shared` importiert statt noch einmal lokal nachgebaut.
 */
interface PostEntwurf {
  id: string;
  mailId: string;
  threadId: string;
  an: string;
  /** Das Fach der Ursprungsmail — Vorgabe für den Absender beim Freigeben,
      änderbar (siehe EntwurfKarte weiter unten). `null` nur in Randfällen,
      siehe post-sichtung.ts, PostEntwurf.fach. */
  fach: string | null;
  betreff: string;
  text: string;
  begruendung: string | null;
  zustand: string;
  abweichung: PostMeldungAbweichung | null;
}

const SEITENGROESSE = 50;

/* ── Abruf ───────────────────────────────────────────────────────
   Ein eigener, kleiner Ersatz für `request()` aus net/api.ts: an api.ts wird
   gerade an anderer Stelle gearbeitet, diese Tafel darf die Datei nicht
   anfassen, und `request()` ist dort ohnehin nicht exportiert. Diese Fassung
   spiegelt nur, was das Postfach braucht — Basisadresse, Anmeldenachweis und
   das Lesen von `code`/`error` aus einer Fehlerantwort —, damit vorhandene
   Übersetzungen für Fehlerkennungen (etwa 'post.keineVerbindung' aus
   post.ts) auch hier greifen, genau wie beim großen Vorbild. */
async function postFetch<T>(pfad: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null) headers.set('content-type', 'application/json');
  const nachweis = token();
  if (nachweis) headers.set('authorization', `Bearer ${nachweis}`);

  let antwort: Response;
  try {
    antwort = await fetch(`${serverUrl()}${pfad}`, { ...init, headers });
  } catch {
    throw new ApiError(tStatisch('api.serverUnreachable', { adresse: serverUrl() }), 0);
  }

  if (!antwort.ok) {
    let message = tStatisch('api.error', { status: antwort.status });
    let code: string | undefined;
    let werte: Record<string, string> | undefined;
    try {
      const rumpf = await antwort.json() as { error?: string; code?: string; werte?: Record<string, string> };
      message = rumpf.error ?? message;
      code = rumpf.code;
      werte = rumpf.werte;
    } catch { /* keine JSON-Antwort */ }
    if (code) {
      const uebersetzt = tStatisch(code as TranslationKey, werte);
      if (uebersetzt && uebersetzt !== code) message = uebersetzt;
    }
    throw new ApiError(message, antwort.status, code);
  }
  return antwort.status === 204 ? (undefined as T) : ((await antwort.json()) as T);
}

/** Die Fächer mit ihren Zählständen. Angenommene Hülle: `{ faecher: [...] }`. */
async function faecherHolen(): Promise<PostFach[]> {
  const r = await postFetch<{ faecher: PostFach[] }>('/api/post/faecher');
  return r.faecher;
}

/** Eine Seite der Liste eines Fachs — oder aller Fächer, wenn `fach` null ist. */
async function listeHolen(fach: string | null, ansicht: PostAnsicht, vor?: number): Promise<PostNachricht[]> {
  const qs = new URLSearchParams({ anzahl: String(SEITENGROESSE), ansicht });
  if (fach) qs.set('fach', fach);
  if (vor) qs.set('vor', String(vor));
  const r = await postFetch<{ nachrichten: PostNachricht[] }>(`/api/post/liste?${qs}`);
  return r.nachrichten;
}

/* ── Suche ───────────────────────────────────────────────────────
   Serverseitig über den Fingerabdruck-Index (siehe services/post-suche.ts,
   Dateikopf) — findet deshalb auch Post, die (noch) nicht in der geladenen
   Seite steht, und ausdrücklich auch Archiviertes und Entferntes: wer sich an
   eine längst archivierte Rechnung erinnert, soll sie wiederfinden, ohne sie
   zuerst im Archiv zu suchen. */
async function sucheHolen(q: string, fach: string | null): Promise<PostNachricht[]> {
  const qs = new URLSearchParams({ q });
  if (fach) qs.set('fach', fach);
  const r = await postFetch<{ treffer: PostNachricht[] }>(`/api/post/suche?${qs}`);
  return r.treffer;
}

/* ── Archivieren, aus dem Weg räumen, endgültig löschen ─────────────
   Die Türen zu services/post.ts — Begründung der drei verschiedenen
   Schwellen dort, im Dateikopf des gleichnamigen Abschnitts. */

async function archivSetzenApi(id: string, archiviert: boolean): Promise<void> {
  await postFetch(`/api/post/nachricht/${encodeURIComponent(id)}/archivieren`, {
    method: 'POST', body: JSON.stringify({ archiviert }),
  });
}
async function entfernenSetzenApi(id: string): Promise<void> {
  await postFetch(`/api/post/nachricht/${encodeURIComponent(id)}/entfernen`, { method: 'POST' });
}
async function wiederherstellenApi(id: string): Promise<void> {
  await postFetch(`/api/post/nachricht/${encodeURIComponent(id)}/wiederherstellen`, { method: 'POST' });
}
async function endgueltigLoeschenApi(id: string): Promise<void> {
  await postFetch(`/api/post/nachricht/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* ── Weiterleiten ────────────────────────────────────────────────
   Text und Anhänge übernimmt der Server selbst aus der Ursprungsmail (siehe
   services/post.ts, weiterleiten()) — hier geht nur mit, was NICHT aus der
   Mail selbst stammt: aus welchem Fach und an wen. */
async function weiterleitenApi(id: string, eingabe: { fach: string; an: string }): Promise<{ id: string }> {
  return postFetch(`/api/post/nachricht/${encodeURIComponent(id)}/weiterleiten`, {
    method: 'POST', body: JSON.stringify(eingabe),
  });
}

/** Ein Fach zur Auswahl: `fach` ist die Kennung, die tatsächlich gesendet
    wird (etwa `"support"`), `adresse` die vollständige Adresse nur für die
    Anzeige (etwa `"support@stellium.club"`) — dieselbe Hülle, die
    `services/post.ts::absenderFaecher()` liefert. Wortgleich mit
    `SchreibFach` in PostSchreiben.tsx, hier noch einmal aus demselben Grund
    wie postFetch() selbst (siehe dort). */
interface AbsenderFach { fach: string; adresse: string }

/** Dieselbe Route wie im Schreibfenster (PostSchreiben.tsx) — eigenständig
    hier aus demselben Grund wie postFetch() selbst (siehe dort). */
async function schreibfaecherHolen(): Promise<AbsenderFach[]> {
  const r = await postFetch<{ faecher: AbsenderFach[] }>('/api/post/schreibfaecher');
  return r.faecher;
}

/* ── Aufbewahrungsfrist je Fach ──────────────────────────────────── */

async function fristenHolen(): Promise<PostFristStand[]> {
  const r = await postFetch<{ fristen: PostFristStand[] }>('/api/post/fristen');
  return r.fristen;
}
async function fristSetzenApi(fach: string, tage: number): Promise<PostFristStand> {
  const r = await postFetch<{ frist: PostFristStand }>('/api/post/fristen', {
    method: 'POST', body: JSON.stringify({ fach, tage }),
  });
  return r.frist;
}
async function fristLoeschenApi(fach: string): Promise<void> {
  await postFetch(`/api/post/fristen/${encodeURIComponent(fach)}`, { method: 'DELETE' });
}

/** Zustand/Dringlichkeit für eine Handvoll Mails — für Färbung und Sortierung
    nach Dringlichkeit, siehe SichtungKurz weiter oben. Leer rein, leer
    raus: eine Seite ohne eingegangene Mail (nur Gesendetes) braucht keinen
    Netzwerkumweg. */
async function sichtungenHolen(mailIds: string[]): Promise<Record<string, SichtungKurz>> {
  if (!mailIds.length) return {};
  const qs = new URLSearchParams({ ids: mailIds.join(',') });
  const r = await postFetch<{ sichtungen: Record<string, SichtungKurz> }>(`/api/post/sichtungen?${qs}`);
  return r.sichtungen;
}

/** Eine einzelne Nachricht. */
async function nachrichtHolen(id: string): Promise<PostNachricht | null> {
  const r = await postFetch<{ nachricht: PostNachricht | null }>(`/api/post/nachricht/${encodeURIComponent(id)}`);
  return r.nachricht;
}

/** Der ganze Verlauf zu einer Nachricht, älteste zuerst. */
async function verlaufHolen(threadId: string): Promise<PostNachricht[]> {
  const r = await postFetch<{ verlauf: PostNachricht[] }>(`/api/post/verlauf/${encodeURIComponent(threadId)}`);
  return r.verlauf;
}

interface AntwortEingabe {
  fach: string;
  an: string;
  betreff: string;
  text: string;
  antwortAuf: { messageId: string | null; referenzen: string | null; threadId: string | null };
  anhaenge?: string[];
}

async function antwortSenden(eingabe: AntwortEingabe): Promise<{ id: string }> {
  return postFetch<{ id: string }>('/api/post/senden', { method: 'POST', body: JSON.stringify(eingabe) });
}

/* ── Anhänge fürs Antworten und für den KI-Entwurf-Freigabe-Kasten ──────
   Dieselben drei Routen wie im Schreibfenster (PostSchreiben.tsx,
   `POST`/`DELETE /api/post/anhang`), hier noch einmal — aus demselben Grund
   wie postFetch() selbst (siehe dort): kein Import über die
   Komponentengrenze für modul-lokale Funktionen, beide Tafeln bleiben für
   sich lesbar. `mail_id` bleibt beim Server so lange NULL, bis wirklich
   gesendet wird (services/post.ts, ausgehenderAnhangAnlegen()). */

interface AusgehenderAnhang { id: string; name: string; mime: string; size: number }

/** Eigener `fetch()` statt `postFetch()`: eine Datei geht als `FormData`
    hinaus, `postFetch()` setzt bei jedem gesetzten Rumpf ausnahmslos
    `content-type: application/json` — das zerstört die Mehrteil-Grenze. */
async function anhangHochladen(datei: File): Promise<AusgehenderAnhang> {
  const form = new FormData();
  form.append('file', datei);
  const headers = new Headers();
  const nachweis = token();
  if (nachweis) headers.set('authorization', `Bearer ${nachweis}`);

  let antwort: Response;
  try {
    antwort = await fetch(`${serverUrl()}/api/post/anhang`, { method: 'POST', body: form, headers });
  } catch {
    throw new ApiError(tStatisch('api.serverUnreachable', { adresse: serverUrl() }), 0);
  }
  if (!antwort.ok) {
    let message = tStatisch('api.error', { status: antwort.status });
    let code: string | undefined;
    try {
      const rumpf = await antwort.json() as { error?: string; code?: string };
      message = rumpf.error ?? message;
      code = rumpf.code;
    } catch { /* keine JSON-Antwort */ }
    if (code) {
      const uebersetzt = tStatisch(code as TranslationKey);
      if (uebersetzt && uebersetzt !== code) message = uebersetzt;
    }
    throw new ApiError(message, antwort.status, code);
  }
  return (await antwort.json() as { anhang: AusgehenderAnhang }).anhang;
}

/** Ohne Rumpf — `postFetch()` setzt hier keinen Kopf, der stören könnte. */
async function anhangVerwerfen(id: string): Promise<void> {
  await postFetch(`/api/post/anhang/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Höchstens so viele auf einmal — reine Übersichtsgrenze für DIESES
    Fenster, keine Sicherheitsgrenze (die sitzt serverseitig in post.ts,
    AUSGANG_ANHANG_MAX/AUSGANG_ANHAENGE_MAX_GESAMT). Wortgleich mit
    PostSchreiben.tsx. */
const ANHAENGE_MAX_UI = 10;

/* ── KI-Antwortentwürfe ─────────────────────────────────────────────
   Dieselben drei Routen wie im Reiter „Post-Sichtung" (siehe dort für die
   Herkunft), aber hier gebraucht, um die offenen Entwürfe je Mail zuzuordnen
   (siehe entwuerfeLaden() in PostPanel weiter unten) und um einen Entwurf
   direkt beim Verlaufseintrag der Mail freizugeben oder abzulehnen, auf die
   er antwortet — siehe EntwurfKarte weiter unten für die Begründung, warum
   hier und nicht im Reiter „Post-Sichtung" selbst. */

/** Alle offenen Entwürfe auf einen Schlag — die Liste ist naturgemäß klein
    (nur, was gerade auf Freigabe wartet), ein einzelner Abruf beim Öffnen
    des Postfachs genügt (siehe entwuerfeLaden()). */
async function entwuerfeHolen(): Promise<PostEntwurf[]> {
  const r = await postFetch<{ entwuerfe: PostEntwurf[] }>('/api/post/entwuerfe?anzahl=200');
  return r.entwuerfe;
}

/** Freigeben und senden — mit dem (womöglich bearbeiteten) Text aus dem
    Feld. `an` fehlt hier bewusst: die Route nimmt die Empfängeradresse
    ausschließlich aus dem gespeicherten Entwurf, siehe routes.ts. `fach`
    dagegen darf mit — bestimmt nur den eigenen Absender, kein Ziel (siehe
    Dateikopf der Route `/api/post/entwuerfe/:id/senden`). */
async function entwurfFreigeben(
  id: string, eingabe: { betreff: string; text: string; anhaenge?: string[]; fach?: string },
): Promise<{ ok: true; gesendetId: string }> {
  return postFetch(`/api/post/entwuerfe/${encodeURIComponent(id)}/senden`, {
    method: 'POST', body: JSON.stringify(eingabe),
  });
}

async function entwurfAblehnen(id: string): Promise<{ ok: true }> {
  return postFetch(`/api/post/entwuerfe/${encodeURIComponent(id)}/ablehnen`, { method: 'POST' });
}

/* ── Kleinigkeiten ─────────────────────────────────────────────── */

/** Ein einzeiliger Ausschnitt aus dem Text — Zeilenumbrüche raus, sonst
    reißt die erste Zeile eines Briefs die Vorschau in Fetzen. */
function auszug(text: string, laenge = 140): string {
  const einzeilig = text.replace(/\s+/g, ' ').trim();
  return einzeilig.length > laenge ? `${einzeilig.slice(0, laenge)}…` : einzeilig;
}

/** Der Teil vor dem @ — „support" statt „support@firma.de" in der Fächerliste. */
function fachName(fach: string): string {
  const [lokal] = fach.split('@');
  return lokal || fach;
}

/**
 * Ein eigenständiges Dokument für die HTML-Vorschau.
 *
 * Kein `dangerouslySetInnerHTML`: der Inhalt kommt von Fremden und geht nie
 * in den React-Baum dieser App. Stattdessen bekommt ein `<iframe
 * sandbox="">` ein vollständig eigenes Dokument über `srcDoc` — ganz ohne
 * `allow-scripts` und `allow-same-origin` kann darin nichts laufen und
 * nichts auf diese App zugreifen. Das erzwingt der Browser selbst, keine
 * selbstgebaute Prüfung.
 *
 * Die Inhaltsrichtlinie im `<meta>` ist ein zweiter Riegel: `default-src
 * 'none'` unterbindet auch das bloße NACHLADEN von Inhalten — zum Beispiel
 * ein unsichtbares Zählpixel, das sonst schon beim Öffnen verriete, dass die
 * Post gelesen wurde. Verweise in der Vorschau funktionieren dadurch nicht;
 * das ist Absicht und kein Fehler — ein klickbarer Verweis bräuchte genau
 * die Erlaubnis, die hier fehlt, und könnte sonst zu einer gefälschten Seite
 * führen, ohne dass die App das verhindern könnte.
 */
function htmlDokument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" `
    + `content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;">`
    + `<style>body{font:14px/1.55 -apple-system,Helvetica,Arial,sans-serif;`
    + `color:#1a1a1a;background:#fff;padding:14px;overflow-wrap:anywhere}</style>`
    + `</head><body>${html}</body></html>`;
}

/* ── Die Tafel ─────────────────────────────────────────────────── */

export function PostPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const self = useStore((s) => s.self);
  /* Fristen einrichten ist Sache des Postfach-Zugangs selbst (`mail.verwalten`,
     ownerOnly, siehe packages/shared/src/permissions.ts) — die Oberfläche
     blendet den Knopf für alle anderen nur ZUSÄTZLICH aus, durchgesetzt wird
     ohnehin auf dem Server (GET/POST/DELETE /api/post/fristen). */
  const darfVerwalten = Boolean(self?.permissions['mail.verwalten']);

  const [faecher, setFaecher] = useState<PostFach[] | null>(null);
  const [faecherLaedt, setFaecherLaedt] = useState(true);
  const [faecherFehler, setFaecherFehler] = useState<string | null>(null);

  const [aktivesFach, setAktivesFach] = useState<string | null>(null);
  /* Der Alltag, das Archiv, oder der Papierkorb — unabhängig vom Fach: wer
     im Papierkorb ist und das Fach wechselt, bleibt im Papierkorb des neuen
     Fachs, genau wie ein Ordner in einem gewöhnlichen Mailprogramm. */
  const [ansicht, setAnsicht] = useState<PostAnsicht>('aktiv');
  const [eintraege, setEintraege] = useState<PostNachricht[]>([]);
  const [listeLaedt, setListeLaedt] = useState(true);
  const [listeFehler, setListeFehler] = useState<string | null>(null);
  const [kannWeiterladen, setKannWeiterladen] = useState(false);
  const [weitereLaedt, setWeitereLaedt] = useState(false);
  /* Zustand/Dringlichkeit je Mail, für Rand-Farbe und Sortierung — sammelt
     sich über mehrere Seiten hinweg an (siehe sichtungenNachladen), damit
     „Ältere laden" nicht die Einordnung der schon gezeigten Zeilen verliert. */
  const [sichtungen, setSichtungen] = useState<Record<string, SichtungKurz>>({});
  /* Vorgabe „Dringlichkeit": das ist eine Einschätzung der KI, keine
     Tatsache (siehe sortierteEintraege weiter unten) — deshalb bleibt „Nach
     Zeit" jederzeit ein Klick entfernt, nicht nur beim ersten Laden. */
  const [sortierung, setSortierung] = useState<'dringlichkeit' | 'zeit'>('dringlichkeit');
  /* Offene KI-Antwortentwürfe, nach der Mail geordnet, auf die sie antworten
     — für die EntwurfKarte im Verlauf weiter unten (siehe entwuerfeLaden). */
  const [entwuerfe, setEntwuerfe] = useState<Record<string, PostEntwurf>>({});
  const [entwuerfeFehler, setEntwuerfeFehler] = useState<string | null>(null);

  /* ── Suche ─────────────────────────────────────────────────────
     Ersetzt, solange ein brauchbarer Suchtext steht, die normale Liste
     (siehe suchAktiv weiter unten) — dieselben Zeilen, derselbe Klick zum
     Öffnen, nur eine andere Herkunft. */
  const [suchtext, setSuchtext] = useState('');
  const [sucheLaedt, setSucheLaedt] = useState(false);
  const [sucheFehler, setSucheFehler] = useState<string | null>(null);
  const [sucheTreffer, setSucheTreffer] = useState<PostNachricht[]>([]);
  const suchAktiv = suchtext.trim().length >= 2;

  const [fristenOffen, setFristenOffen] = useState(false);

  const [ausgewaehlteId, setAusgewaehlteId] = useState<string | null>(null);
  const [verlauf, setVerlauf] = useState<PostNachricht[]>([]);
  const [detailLaedt, setDetailLaedt] = useState(false);
  const [detailFehler, setDetailFehler] = useState<string | null>(null);

  const [antwortText, setAntwortText] = useState('');
  const [sendenLaedt, setSendenLaedt] = useState(false);
  const [antwortAnhaenge, setAntwortAnhaenge] = useState<AusgehenderAnhang[]>([]);
  const [antwortHochladend, setAntwortHochladend] = useState(0);
  const antwortDateiInput = useRef<HTMLInputElement>(null);
  /* Aus welchem Fach die Antwort UND ein freigegebener KI-Entwurf hinausgehen
     — vorbelegt mit dem Fach der jeweiligen Ursprungsmail, aber änderbar
     (siehe Auftrag: „das Fach ist vorbelegt … und lässt sich ändern").
     EINE Liste für beide Kästen (Antwort-Box weiter unten, EntwurfKarte als
     Prop) statt zweier unabhängiger Abrufe — dieselbe Route wie im
     Schreibfenster und beim Weiterleiten (`/api/post/schreibfaecher`),
     „nimm dieselbe Machart, erfinde keine zweite". */
  const [antwortFach, setAntwortFach] = useState<string | null>(null);
  const [sendeFaecher, setSendeFaecher] = useState<AbsenderFach[] | null>(null);
  const [sendeFaecherFehler, setSendeFaecherFehler] = useState<string | null>(null);

  useEffect(() => {
    schreibfaecherHolen().then(setSendeFaecher).catch((err) => setSendeFaecherFehler((err as Error).message));
  }, []);

  const verlaufRef = useRef<HTMLDivElement>(null);

  const faecherLaden = async () => {
    setFaecherLaedt(true); setFaecherFehler(null);
    try {
      setFaecher(await faecherHolen());
    } catch (err) {
      setFaecherFehler((err as Error).message);
    } finally {
      setFaecherLaedt(false);
    }
  };

  /* Anders als sichtungenNachladen() nicht stillschweigend: hier wartet
     tatsächlich eine Entscheidung auf einen Menschen (siehe Dateikopf
     PostMeldungen.tsx: „Ein Antwortentwurf wartet auf Freigabe" ist die
     einzige Zeile, die zum Handeln auffordert) — schlägt der Abruf fehl,
     soll das sichtbar sein, statt dass ein Entwurf kommentarlos fehlt. */
  const entwuerfeLaden = async () => {
    setEntwuerfeFehler(null);
    try {
      const liste = await entwuerfeHolen();
      setEntwuerfe(Object.fromEntries(liste.map((e) => [e.mailId, e])));
    } catch (err) {
      setEntwuerfeFehler((err as Error).message);
    }
  };

  /* Fehlschlagen darf die Liste selbst nicht mit reißen: ohne Einordnung
     bleibt eine Zeile einfach neutral gefärbt (siehe dringlichkeitRang()
     weiter unten) statt dass ein zweiter Fehlertext über der Liste steht,
     die gerade erfolgreich geladen hat. */
  const sichtungenNachladen = async (nachrichten: PostNachricht[]) => {
    const ids = nachrichten.filter((n) => n.richtung === 'ein').map((n) => n.id);
    if (!ids.length) return;
    try {
      const gefunden = await sichtungenHolen(ids);
      setSichtungen((v) => ({ ...v, ...gefunden }));
    } catch { /* siehe Begründung oben */ }
  };

  /* Laufzähler gegen überholte Antworten: Wechselt jemand schnell das Fach
     oder die Ansicht, laufen zwei Abrufe gleichzeitig — kommt die LANGSAMERE
     (die des alten Fachs) zuletzt zurück, überschriebe sie die frische Liste
     mit der Post des VORHERIGEN Fachs. Dasselbe Muster wie das `lebt`-Flag
     im Such-Effekt weiter unten, nur als Zähler, weil hier mehrere Aufrufer
     (Fachwechsel, Ansichtwechsel, Nachladen) dieselbe Liste füllen. */
  const listenLauf = useRef(0);

  const listeLaden = async (fach: string | null) => {
    // Sofort leeren statt erst nach der Antwort: sonst zeigt die Liste kurz
    // die Post des VORHERIGEN Fachs unter dem neu gewählten Namen an.
    const meineNummer = ++listenLauf.current;
    setListeLaedt(true); setListeFehler(null); setEintraege([]); setKannWeiterladen(false);
    try {
      const seite = await listeHolen(fach, ansicht);
      if (listenLauf.current !== meineNummer) return; // inzwischen überholt
      setEintraege(seite);
      setKannWeiterladen(seite.length >= SEITENGROESSE);
      void sichtungenNachladen(seite);
    } catch (err) {
      if (listenLauf.current !== meineNummer) return;
      setListeFehler((err as Error).message);
    } finally {
      if (listenLauf.current === meineNummer) setListeLaedt(false);
    }
  };

  const weitereLaden = async () => {
    if (!eintraege.length) return;
    const meineNummer = listenLauf.current;
    setWeitereLaedt(true);
    try {
      const seite = await listeHolen(aktivesFach, ansicht, eintraege[eintraege.length - 1].am);
      // Ein Fach- oder Ansichtswechsel während des Nachladens macht diese
      // Seite wertlos: sie gehört zur alten Auswahl und dürfte nicht an die
      // neue Liste angehängt werden.
      if (listenLauf.current !== meineNummer) return;
      setEintraege((v) => [...v, ...seite]);
      setKannWeiterladen(seite.length >= SEITENGROESSE);
      void sichtungenNachladen(seite);
    } catch (err) {
      if (listenLauf.current !== meineNummer) return;
      setListeFehler((err as Error).message);
    } finally {
      if (listenLauf.current === meineNummer) setWeitereLaedt(false);
    }
  };

  useEffect(() => { void faecherLaden(); }, []);
  useEffect(() => { void listeLaden(aktivesFach); }, [aktivesFach, ansicht]);
  useEffect(() => { void entwuerfeLaden(); }, []);

  /* ── Suche ─────────────────────────────────────────────────────
     Kurze Verzögerung, damit nicht bei jedem Tastendruck eine Anfrage
     hinausgeht (dieselbe Bauart wie die Sprachabfrage in PostSchreiben.tsx).
     Unter zwei Zeichen wird gar nicht erst gefragt — services/post-suche.ts
     lehnt das ohnehin ab (siehe dort), hier erspart es schon den Umweg über
     das Netz. */
  useEffect(() => {
    if (!suchAktiv) { setSucheTreffer([]); setSucheFehler(null); setSucheLaedt(false); return; }
    let lebt = true;
    const zeitgeber = setTimeout(() => {
      setSucheLaedt(true); setSucheFehler(null);
      sucheHolen(suchtext.trim(), aktivesFach)
        .then((treffer) => { if (lebt) setSucheTreffer(treffer); })
        .catch((err) => { if (lebt) setSucheFehler((err as Error).message); })
        .finally(() => { if (lebt) setSucheLaedt(false); });
    }, 300);
    return () => { lebt = false; clearTimeout(zeitgeber); };
  }, [suchtext, suchAktiv, aktivesFach]);

  /* Sprung aus dem Reiter „Post-Sichtung" (siehe jumpToPostMail() in
     state/store.ts): eine Mail auswählen, sobald von dort eine Kennung
     ankommt, und uns danach abmelden — sonst wählte ein späteres,
     unabhängiges Öffnen dieses Reiters dieselbe Mail noch einmal aus. Die
     Auswahl selbst holt sich ihren Inhalt über den Effekt weiter unten
     (nachrichtHolen), unabhängig davon, ob die Mail im aktuell geladenen
     Fach/Ausschnitt der Liste steht. */
  const postJumpMailId = useStore((s) => s.postJumpMailId);
  useEffect(() => {
    if (!postJumpMailId) return;
    setAusgewaehlteId(postJumpMailId);
    useStore.getState().postJumpConsumed();
  }, [postJumpMailId]);

  useEffect(() => {
    if (!ausgewaehlteId) { setVerlauf([]); setDetailFehler(null); return; }
    let lebt = true;
    setDetailLaedt(true); setDetailFehler(null);
    (async () => {
      try {
        const n = await nachrichtHolen(ausgewaehlteId);
        if (!n) {
          // Verschwunden oder falsche Kennung: zurück zur leeren Auswahl
          // statt eine Fehlermeldung über eine einzelne Nachricht zu zeigen.
          if (lebt) { setVerlauf([]); setAusgewaehlteId(null); }
          return;
        }
        // Ohne threadId ist die Nachricht selbst der Anfang und das Ende
        // ihres Verlaufs — dann genügt ein Eintrag statt eines Abrufs.
        const kette = n.threadId ? await verlaufHolen(n.threadId) : [n];
        if (lebt) setVerlauf(kette.length ? kette : [n]);
      } catch (err) {
        if (lebt) setDetailFehler((err as Error).message);
      } finally {
        if (lebt) setDetailLaedt(false);
      }
    })();
    return () => { lebt = false; };
  }, [ausgewaehlteId]);

  // Zur gewählten Nachricht springen, wenn sie Teil eines längeren Verlaufs
  // ist — sonst steht sie irgendwo außerhalb des sichtbaren Ausschnitts.
  useEffect(() => {
    if (!ausgewaehlteId || !verlauf.length) return;
    const ziel = verlaufRef.current
      ?.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(ausgewaehlteId)}"]`);
    ziel?.scrollIntoView({ block: 'nearest' });
  }, [ausgewaehlteId, verlauf]);

  const gesamtUngelesen = faecher?.reduce((summe, f) => summe + f.ungelesen, 0) ?? 0;

  /**
   * Stufe für die Sortierung nach Dringlichkeit — kleiner ist weiter oben.
   *
   * VIER FALLSTRICKE, VIER ENTSCHEIDUNGEN:
   *
   *   1. Ungesichtete Post darf nicht untergehen. Eine Mail ohne eigene
   *      Zeile in `sichtungen` (frisch eingegangen, `sichtungenNachladen`
   *      noch nicht durch oder die Sichtung selbst noch nicht einmal
   *      gestartet) landet in Stufe 0 — ganz oben, noch vor „hoch". Sie ist
   *      die neueste Mail und könnte alles sein; sie unten anzuhängen wäre
   *      der stille Rückfall auf „niedrig", den es hier nicht geben soll.
   *   2. Zeit zählt als zweite Ordnung — siehe sortierteEintraege() unten:
   *      innerhalb derselben Stufe bleibt die vom Server gelieferte
   *      Reihenfolge (neueste zuerst) einfach erhalten.
   *   3. Eine gescheiterte Sichtung (`fehler`) — die KI hat nichts geliefert
   *      — steht aus demselben Grund wie Punkt 1 ebenfalls in Stufe 0, nicht
   *      in „niedrig": „nichts weiß" ist kein Werturteil.
   *   4. Die Einstufung kommt von einer KI und kann falsch liegen — deshalb
   *      ist „Nach Dringlichkeit" nur die VORGABE, nicht die einzige
   *      Ordnung. Der Umschalter in der Kopfzeile wechselt jederzeit auf
   *      „Nach Zeit", der reinen, von keiner Einschätzung abhängigen Order.
   *
   * Gesendete Post (`richtung === 'aus'`) hat nie eine Sichtung und keine
   * Dringlichkeit — sie steht bewusst UNTER „niedrig": diese Sortierung ist
   * eine Triage eingehender Post, das eigene Archiv drängt sich dabei nicht
   * nach vorn.
   */
  const dringlichkeitRang = (n: PostNachricht): number => {
    if (n.richtung === 'aus') return 4;
    const s = sichtungen[n.id];
    if (!s || s.zustand === 'laeuft' || s.zustand === 'fehler') return 0;
    const d = s.einordnung?.dringlichkeit;
    if (d === 'hoch') return 1;
    if (d === 'normal') return 2;
    if (d === 'niedrig') return 3;
    return 0; // z.B. 'entwurf'/'gemeldet', dessen Einordnung noch nicht eingetroffen ist
  };

  // 'zeit' ist keine eigene Sortierung: der Server liefert `eintraege` schon
  // chronologisch (neueste zuerst, siehe post.liste()) — genau das ist die
  // reine, von keiner KI-Einschätzung abhängige Ordnung aus Fallstrick 4
  // oben. `sort()` auf einer Kopie, damit `eintraege` selbst (Grundlage für
  // `weitereLaden()`s Zeitstempel) unverändert bleibt.
  const sortierteEintraege = sortierung === 'zeit'
    ? eintraege
    : [...eintraege].sort((a, b) => dringlichkeitRang(a) - dringlichkeitRang(b));

  // Antwortziel: die jeweils ANDERE Seite des letzten Eintrags im Verlauf —
  // bei einer eingegangenen Nachricht ihr Absender, bei einer gesendeten ihr
  // Empfänger. So passt das Ziel unabhängig davon, welcher Eintrag gerade in
  // der Liste angeklickt wurde, und der Bezug (`In-Reply-To`/`References`)
  // knüpft am jüngsten Glied der Kette an, nicht am angeklickten.
  const letzte = verlauf.length ? verlauf[verlauf.length - 1] : null;
  const zielAdresse = letzte ? (letzte.richtung === 'ein' ? letzte.von : letzte.an) : null;
  const betreffVorschlag = letzte
    ? (/^re:/i.test(letzte.betreff.trim()) ? letzte.betreff : `Re: ${letzte.betreff}`)
    : '';

  /* `antwortFach` folgt dem Fach der Ursprungsmail, sobald sich ein anderer
     Verlauf öffnet (`ausgewaehlteId`) ODER dieser Verlauf fertig geladen ist
     und ein anderes Fach zeigt (`letzte?.fach`) — beide zusammen, weil der
     Verlaufsabruf async läuft: unmittelbar nach dem Wechsel von
     `ausgewaehlteId` trägt `letzte` unter Umständen noch den alten Stand,
     bis `verlauf` nachgeladen ist (siehe `letzte` oben) und `letzte?.fach`
     ein zweites Mal auslöst. `sendeFaecher` steht in der Abhängigkeit, weil
     der Vorschlag erst KORRIGIERT werden kann, sobald die Liste der
     sendbaren Fächer da ist: landete die Ursprungsmail in `sonstiges` (kein
     eigenes Postfach, siehe services/post.ts, absenderFaecher()), taugt ihr
     Fach nicht als Vorgabe — dann greift stattdessen das erste sendbare Fach,
     genau wie beim Weiterleiten (siehe WeiterleitenFenster oben). Danach
     bleibt eine von Hand getroffene Wahl stehen, bis der Verlauf wirklich
     wechselt — kein Zurückspringen bei jedem Tastendruck im Antwortfeld. */
  useEffect(() => {
    const vorschlag = letzte?.fach ?? null;
    const gueltig = sendeFaecher && sendeFaecher.length
      ? (vorschlag && sendeFaecher.some((f) => f.fach === vorschlag) ? vorschlag : sendeFaecher[0].fach)
      : vorschlag;
    setAntwortFach(gueltig);
  }, [ausgewaehlteId, letzte?.fach, sendeFaecher]);

  /* ── Anhänge für die Antwort ───────────────────────────────────
     Wortgleiches Muster wie in PostSchreiben.tsx (siehe Dateikopf dort):
     hochgeladen wird SOFORT beim Auswählen, gesendet wird nur die Kennung. */
  const antwortDateienHinzufuegen = async (dateien: FileList) => {
    const liste = Array.from(dateien).slice(0, Math.max(0, ANHAENGE_MAX_UI - antwortAnhaenge.length));
    setAntwortHochladend((v) => v + liste.length);
    await Promise.all(liste.map(async (datei) => {
      try {
        const angelegt = await anhangHochladen(datei);
        setAntwortAnhaenge((v) => [...v, angelegt]);
      } catch (err) {
        useStore.getState().toast({
          kind: 'error', title: t('post.anhangHochladenFehlgeschlagen'), body: (err as Error).message,
        });
      } finally {
        setAntwortHochladend((v) => v - 1);
      }
    }));
  };
  const antwortAnhangEntfernen = (id: string) => {
    setAntwortAnhaenge((v) => v.filter((a) => a.id !== id));
    void anhangVerwerfen(id).catch(() => { /* verwaist harmlos, siehe post.ts */ });
  };

  const senden = async () => {
    const text = antwortText.trim();
    if (!text || !letzte || !zielAdresse || !antwortFach) return;
    setSendenLaedt(true);
    try {
      await antwortSenden({
        fach: antwortFach,
        an: zielAdresse,
        betreff: betreffVorschlag,
        text,
        antwortAuf: { messageId: letzte.messageId, referenzen: letzte.referenzen, threadId: letzte.threadId },
        anhaenge: antwortAnhaenge.length ? antwortAnhaenge.map((a) => a.id) : undefined,
      });
      setAntwortText('');
      setAntwortAnhaenge([]);
      useStore.getState().toast({ kind: 'ok', title: t('post.gesendet') });
      // Die eigene Antwort steht jetzt im Verlauf und ändert die Zählstände.
      if (letzte.threadId) setVerlauf(await verlaufHolen(letzte.threadId));
      void faecherLaden();
      void listeLaden(aktivesFach);
    } catch (err) {
      useStore.getState().toast({
        kind: 'error', title: t('post.sendenFehlgeschlagen'), body: (err as Error).message,
      });
    } finally {
      setSendenLaedt(false);
    }
  };

  /**
   * Ein Entwurf ist entschieden — die EntwurfKarte selbst hat Freigeben/
   * Ablehnen schon gegen den Server durchgesetzt (siehe dort), hier geht es
   * nur noch um die Ansicht: die Karte verschwindet (kein offener Entwurf
   * mehr für diese Mail), und bei „gesendet" steht die eigene Antwort jetzt
   * im Verlauf — dieselbe Nachbereitung wie in senden() direkt oberhalb,
   * nur mit `entwurf.threadId` statt `letzte.threadId`, weil ein Entwurf
   * nicht zwingend an der zuletzt ausgewählten Nachricht hängt.
   */
  const entwurfEntschieden = (entwurf: PostEntwurf, gesendet: boolean) => {
    setEntwuerfe((v) => {
      const kopie = { ...v };
      delete kopie[entwurf.mailId];
      return kopie;
    });
    if (gesendet) {
      void verlaufHolen(entwurf.threadId).then(setVerlauf).catch(() => { /* Verlauf bleibt beim alten Stand — kein Absturz wegen einer Nachladung */ });
      void faecherLaden();
      void listeLaden(aktivesFach);
    }
  };

  /* ── Archivieren, aus dem Weg räumen, wiederherstellen, endgültig löschen
     ──────────────────────────────────────────────────────────────────
     Alle vier räumen danach gleich auf: Fächerzählung und Liste (bzw.
     Suchtreffer, falls gerade gesucht wird) neu laden, damit die betroffene
     Zeile dort verschwindet oder erscheint, wie es der neue Zustand
     verlangt. Der geöffnete Verlauf bleibt für Archivieren/Entfernen/
     Wiederherstellen stehen — die Mail ist ja weiterhin lesbar, nur
     `archiviertAm`/`entferntAm` haben sich geändert (siehe post.ts,
     Dateikopf) —, wird also neu geholt statt geschlossen. */
  const listeOderSucheAktualisieren = () => {
    void faecherLaden();
    if (suchAktiv) void sucheHolen(suchtext.trim(), aktivesFach).then(setSucheTreffer).catch(() => {});
    else void listeLaden(aktivesFach);
  };

  const archivToggle = async (n: PostNachricht) => {
    try {
      await archivSetzenApi(n.id, n.archiviertAm === null);
      listeOderSucheAktualisieren();
      if (n.threadId) void verlaufHolen(n.threadId).then(setVerlauf).catch(() => {});
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('post.aktionFehlgeschlagen'), body: (err as Error).message });
    }
  };

  const entfernenToggle = async (n: PostNachricht) => {
    try {
      if (n.entferntAm === null) await entfernenSetzenApi(n.id);
      else await wiederherstellenApi(n.id);
      listeOderSucheAktualisieren();
      if (n.threadId) void verlaufHolen(n.threadId).then(setVerlauf).catch(() => {});
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('post.aktionFehlgeschlagen'), body: (err as Error).message });
    }
  };

  /**
   * Endgültig löschen — Art. 17 DSGVO, unumkehrbar. Die Bestätigung hier ist
   * ABSICHTLICH etwas anderes als bei Archivieren/Entfernen (die kommen ganz
   * ohne Rückfrage aus, weil sie jederzeit rückgängig zu machen sind): ein
   * eigener, ausdrücklicher Satz, der sagt, dass das hier ENDGÜLTIG ist —
   * nicht dasselbe Kreuz wie beim Archivieren.
   */
  const endgueltigLoeschenHandler = async (n: PostNachricht) => {
    if (!window.confirm(t('post.endgueltigLoeschenBestaetigen'))) return;
    try {
      await endgueltigLoeschenApi(n.id);
      useStore.getState().toast({ kind: 'ok', title: t('post.endgueltigGeloescht') });
      listeOderSucheAktualisieren();
      // Die Mail selbst gibt es nicht mehr -- aus dem geöffneten Verlauf
      // nehmen, statt sie neu zu laden (das fände sie ja gerade nicht mehr).
      setVerlauf((v) => {
        const rest = v.filter((x) => x.id !== n.id);
        if (!rest.length) setAusgewaehlteId(null);
        return rest;
      });
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('post.aktionFehlgeschlagen'), body: (err as Error).message });
    }
  };

  return (
    <Shell
      title={t('post.titel')}
      subtitle={faecher ? t('post.untertitelUngelesen', { n: gesamtUngelesen }) : undefined}
      icon={<Mail size={18} />}
      onClose={onClose}
      width={1180}
      actions={
        <>
          {/* Eigene Komponente, eine Zeile eingehängt (siehe PostSchreiben.tsx) — verwaltet Knopf und Fenster vollständig selbst. */}
          <PostSchreiben onGesendet={() => { void faecherLaden(); void listeLaden(aktivesFach); }} />
          {darfVerwalten && (
            <button
              className="icon-btn"
              title={t('post.fristenKnopf')}
              aria-label={t('post.fristenKnopf')}
              onClick={() => setFristenOffen(true)}
            >
              <CalendarClock size={15} />
            </button>
          )}
          <button
            className="icon-btn"
            title={t('post.aktualisieren')}
            aria-label={t('post.aktualisieren')}
            onClick={() => { void faecherLaden(); void listeLaden(aktivesFach); void entwuerfeLaden(); }}
          >
            <RefreshCw size={15} />
          </button>
        </>
      }
    >
      {fristenOffen && <FristenFenster t={t} onClose={() => setFristenOffen(false)} />}
      <div className="post">
        <nav className="post__faecher" aria-label={t('post.faecherAria')}>
          {faecherFehler && <div className="post__fehler"><AlertTriangle size={13} /> {faecherFehler}</div>}
          {faecherLaedt && !faecher && (
            <Loader2 size={16} className="spin muted" role="status" aria-label={t('post.laedt')} />
          )}
          {faecher && (
            <>
              <button
                className={clsx('chan', gesamtUngelesen > 0 && 'chan--unread')}
                aria-current={aktivesFach === null ? 'true' : undefined}
                onClick={() => setAktivesFach(null)}
              >
                <span className="chan__icon"><Inbox size={15} /></span>
                <span className="chan__name">{t('post.alle')}</span>
                {gesamtUngelesen > 0 && <span className="chan__badge">{gesamtUngelesen}</span>}
              </button>
              {faecher.map((f) => (
                <FachZeile
                  key={f.fach}
                  fach={f}
                  aktiv={aktivesFach === f.fach}
                  onWaehlen={() => setAktivesFach(f.fach)}
                />
              ))}
            </>
          )}
        </nav>

        <section className="post__liste">
          <div className="post__suche">
            <Search size={13} className="post__suche-symbol muted" aria-hidden="true" />
            <input
              className="input post__suche-feld"
              type="search"
              value={suchtext}
              placeholder={t('post.suchePlatzhalter')}
              aria-label={t('post.sucheAria')}
              onChange={(e) => setSuchtext(e.target.value)}
            />
            {suchtext !== '' && (
              <button
                type="button"
                className="post__suche-loeschen"
                title={t('post.sucheLeeren')}
                aria-label={t('post.sucheLeeren')}
                onClick={() => setSuchtext('')}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Alltag/Archiv/Papierkorb — unabhängig vom Fach (siehe ansicht-
              Zustand oben), aber während einer Suche ohne Wirkung: gesucht
              wird immer über alle drei Zustände zusammen (siehe
              services/post-suche.ts, suchen() für die Begründung). Deshalb
              hier ausgeblendet, statt einen Umschalter zu zeigen, der gerade
              nichts umschaltet. */}
          {!suchAktiv && (
            <div className="post__ansicht" role="group" aria-label={t('post.ansichtAria')}>
              <button
                className={clsx('pill', ansicht === 'aktiv' && 'pill--sort-on')}
                aria-pressed={ansicht === 'aktiv'}
                onClick={() => setAnsicht('aktiv')}
              >
                <Inbox size={12} /> {t('post.ansichtAktiv')}
              </button>
              <button
                className={clsx('pill', ansicht === 'archiviert' && 'pill--sort-on')}
                aria-pressed={ansicht === 'archiviert'}
                onClick={() => setAnsicht('archiviert')}
              >
                <Archive size={12} /> {t('post.ansichtArchiv')}
              </button>
              <button
                className={clsx('pill', ansicht === 'papierkorb' && 'pill--sort-on')}
                aria-pressed={ansicht === 'papierkorb'}
                onClick={() => setAnsicht('papierkorb')}
              >
                <Trash2 size={12} /> {t('post.ansichtPapierkorb')}
              </button>
            </div>
          )}

          {suchAktiv ? (
            <>
              {sucheFehler && <div className="post__fehler"><AlertTriangle size={13} /> {sucheFehler}</div>}
              {sucheLaedt && (
                <Loader2 size={18} className="spin muted" role="status" aria-label={t('post.laedt')} />
              )}
              {!sucheLaedt && !sucheFehler && !sucheTreffer.length && (
                <div className="empty-state">
                  <Search size={26} className="muted" />
                  <p>{t('post.sucheLeer')}</p>
                </div>
              )}
              {!sucheLaedt && sucheTreffer.map((n) => (
                <NachrichtZeile
                  key={n.id}
                  n={n}
                  sichtung={sichtungen[n.id]}
                  aktiv={n.id === ausgewaehlteId}
                  onOeffnen={() => setAusgewaehlteId(n.id)}
                />
              ))}
            </>
          ) : (
            <>
              {listeFehler && <div className="post__fehler"><AlertTriangle size={13} /> {listeFehler}</div>}
              {listeLaedt && (
                <Loader2 size={18} className="spin muted" role="status" aria-label={t('post.laedt')} />
              )}
              {!listeLaedt && !listeFehler && !eintraege.length && (
                <div className="empty-state">
                  <Mail size={26} className="muted" />
                  <p>{t('post.listeLeer')}</p>
                </div>
              )}
              {/* Vorgabe „Nach Dringlichkeit", aber jederzeit umschaltbar: die
                  Einstufung stammt von einer KI und kann danebenliegen — siehe
                  die ausführliche Begründung bei dringlichkeitRang() weiter oben. */}
              {!listeLaedt && !!eintraege.length && (
                <div className="post__sortierung" role="group" aria-label={t('post.sortierungAria')}>
                  <button
                    className={clsx('pill pill--sort', sortierung === 'dringlichkeit' && 'pill--sort-on')}
                    aria-pressed={sortierung === 'dringlichkeit'}
                    title={t('post.sortierungHinweis')}
                    onClick={() => setSortierung('dringlichkeit')}
                  >
                    <Sparkles size={12} /> {t('post.sortierungDringlichkeit')}
                  </button>
                  <button
                    className={clsx('pill pill--sort', sortierung === 'zeit' && 'pill--sort-on')}
                    aria-pressed={sortierung === 'zeit'}
                    onClick={() => setSortierung('zeit')}
                  >
                    <Clock size={12} /> {t('post.sortierungZeit')}
                  </button>
                </div>
              )}
              {!listeLaedt && sortierteEintraege.map((n) => (
                <NachrichtZeile
                  key={n.id}
                  n={n}
                  sichtung={sichtungen[n.id]}
                  aktiv={n.id === ausgewaehlteId}
                  onOeffnen={() => setAusgewaehlteId(n.id)}
                />
              ))}
              {!listeLaedt && kannWeiterladen && (
                <button
                  className="btn btn--ghost btn--block"
                  disabled={weitereLaedt}
                  onClick={() => void weitereLaden()}
                >
                  {weitereLaedt ? <Loader2 size={14} className="spin" /> : t('post.weitereLaden')}
                </button>
              )}
            </>
          )}
        </section>

        <section className="post__detail">
          {!ausgewaehlteId && (
            <div className="empty-state">
              <Send size={26} className="muted" />
              <p>{t('post.keineAuswahl')}</p>
            </div>
          )}
          {ausgewaehlteId && detailFehler && (
            <div className="post__fehler"><AlertTriangle size={13} /> {detailFehler}</div>
          )}
          {ausgewaehlteId && detailLaedt && !verlauf.length && (
            <Loader2 size={18} className="spin muted" role="status" aria-label={t('post.laedt')} />
          )}
          {ausgewaehlteId && !!verlauf.length && (
            <>
              <h3 className="post__betreff">{letzte?.betreff || t('post.ohneBetreff')}</h3>

              <div ref={verlaufRef} className="post__verlauf">
                {entwuerfeFehler && <div className="post__fehler"><AlertTriangle size={13} /> {entwuerfeFehler}</div>}
                {verlauf.map((n) => {
                  // Der Entwurf hängt an GENAU DER eingegangenen Mail, auf die er
                  // antwortet (entwurf.mailId) — direkt darunter im Verlauf ist
                  // deshalb eindeutig, auch wenn ein Thread mehrere eingegangene
                  // Mails und damit potenziell mehrere (nacheinander offene)
                  // Entwürfe enthält.
                  const entwurf = entwuerfe[n.id];
                  return (
                    <Fragment key={n.id}>
                      <VerlaufEintrag
                        n={n}
                        aktiv={n.id === ausgewaehlteId}
                        t={t}
                        darfVerwalten={darfVerwalten}
                        onArchivToggle={archivToggle}
                        onEntfernenToggle={entfernenToggle}
                        onEndgueltigLoeschen={endgueltigLoeschenHandler}
                      />
                      {entwurf && (
                        <EntwurfKarte
                          entwurf={entwurf}
                          t={t}
                          faecher={sendeFaecher}
                          onEntschieden={(gesendet) => entwurfEntschieden(entwurf, gesendet)}
                        />
                      )}
                    </Fragment>
                  );
                })}
              </div>

              <div className="post__antwort">
                <div className="field post__antwort-fach">
                  <label className="field__label">{t('post.absenderfach')}</label>
                  {sendeFaecherFehler && (
                    <p className="field__hint post-schreiben__warnung">{sendeFaecherFehler}</p>
                  )}
                  {!sendeFaecherFehler && sendeFaecher && !!sendeFaecher.length && (
                    <select
                      className="select"
                      aria-label={t('post.absenderfach')}
                      value={antwortFach ?? ''}
                      onChange={(e) => setAntwortFach(e.target.value)}
                    >
                      {sendeFaecher.map((f) => <option key={f.fach} value={f.fach}>{f.adresse}</option>)}
                    </select>
                  )}
                  {!sendeFaecherFehler && sendeFaecher && !sendeFaecher.length && (
                    <p className="field__hint">{t('post.keineFaecher')}</p>
                  )}
                </div>
                <textarea
                  className="textarea"
                  aria-label={t('post.antwortLabel')}
                  placeholder={t('post.antwortPlatzhalter')}
                  value={antwortText}
                  onChange={(e) => setAntwortText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void senden(); }
                  }}
                  rows={3}
                />
                {/* Wortgleiches Muster wie im Schreibfenster (PostSchreiben.tsx)
                    — hochgeladen wird sofort, gesendet wird nur die Kennung
                    (siehe antwortDateienHinzufuegen() weiter oben). */}
                <input
                  ref={antwortDateiInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => { if (e.target.files?.length) void antwortDateienHinzufuegen(e.target.files); e.target.value = ''; }}
                />
                <div className="post-schreiben__anhaenge">
                  {antwortAnhaenge.map((a) => (
                    <span key={a.id} className="post-schreiben__anhang" title={a.name}>
                      <span className="post-schreiben__anhang-name truncate">{a.name}</span>
                      <span className="post-schreiben__anhang-groesse">{fileSize(a.size)}</span>
                      <button
                        type="button"
                        className="post-schreiben__anhang-entfernen"
                        title={t('common.remove')}
                        aria-label={t('common.remove')}
                        onClick={() => antwortAnhangEntfernen(a.id)}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  {antwortHochladend > 0 && (
                    <span className="post-schreiben__anhang muted">
                      <Loader2 size={11} className="spin" /> {t('post.anhangWirdHochgeladen')}
                    </span>
                  )}
                  {antwortAnhaenge.length + antwortHochladend < ANHAENGE_MAX_UI && (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => antwortDateiInput.current?.click()}
                    >
                      <Paperclip size={13} /> {t('post.anhangHinzufuegen')}
                    </button>
                  )}
                </div>
                <div className="post__antwort-fuss">
                  <span className="muted post__antwort-hinweis">{t('post.sendenHinweis')}</span>
                  <button
                    className="btn btn--primary"
                    disabled={!antwortText.trim() || !antwortFach || sendenLaedt}
                    onClick={() => void senden()}
                  >
                    {sendenLaedt ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                    {t('post.senden')}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </Shell>
  );

  // Verschachtelt statt auf Modulebene: beide halten keinen eigenen Zustand
  // und schließen einfach über das `t` von oben — ein neuer Bauplan bei
  // jedem Rendern von PostPanel kostet hier nichts, siehe VerlaufEintrag
  // weiter unten für den Fall, in dem das nicht mehr stimmt.
  function FachZeile({ fach, aktiv, onWaehlen }: { fach: PostFach; aktiv: boolean; onWaehlen: () => void }) {
    return (
      <button
        className={clsx('chan', fach.ungelesen > 0 && 'chan--unread')}
        aria-current={aktiv ? 'true' : undefined}
        title={fach.fach}
        onClick={onWaehlen}
      >
        <span className="chan__icon"><AtSign size={14} /></span>
        <span className="chan__name">{fachName(fach.fach)}</span>
        {fach.ungelesen > 0 && (
          <span className="chan__badge">
            {fach.ungelesen}
            <span className="post__sr-only"> · {t('post.ungelesenMarke')}</span>
          </span>
        )}
      </button>
    );
  }

  function NachrichtZeile({ n, sichtung, aktiv, onOeffnen }: {
    n: PostNachricht; sichtung: SichtungKurz | undefined; aktiv: boolean; onOeffnen: () => void;
  }) {
    const ungelesen = n.richtung === 'ein' && !n.gelesen;
    const adresse = n.richtung === 'aus' ? n.an : n.von;
    // Dieselbe Farbe wie im Reiter „Post-Sichtung" (siehe lib/post-farben.ts)
    // — `undefined` (noch nicht gesichtet) und `dringlichkeit` fehlend
    // (Sichtung läuft/fehlgeschlagen) ergeben beide die neutrale Randfarbe,
    // nie die Farbe von „niedrig" (siehe dringlichkeitRang() weiter oben).
    const randFarbe = n.richtung === 'ein' ? dringlichkeitFarbe(sichtung?.einordnung?.dringlichkeit) : undefined;
    return (
      <button
        className={clsx('post-row', ungelesen && 'post-row--ungelesen')}
        style={randFarbe ? { borderInlineStartColor: randFarbe } : undefined}
        aria-current={aktiv ? 'true' : undefined}
        onClick={onOeffnen}
      >
        <span className="post-row__kopf">
          <span className="post-row__von truncate">
            {n.richtung === 'aus' && <ArrowUpRight size={11} className="post-row__richtung" aria-hidden="true" />}
            {adresse || t('post.unbekannt')}
          </span>
          <span className="post-row__zeit">{relativeTime(n.am)}</span>
        </span>
        <span className="post-row__betreff truncate">{n.betreff || t('post.ohneBetreff')}</span>
        <span className="post-row__auszug truncate">{auszug(n.text)}</span>
        {/* Nur relevant, wenn Zeilen aus verschiedenen Zuständen nebeneinander
            stehen können — bei der Suche (die über aktiv/archiviert/
            Papierkorb hinweg findet, siehe services/post-suche.ts) und im
            Archiv/Papierkorb selbst wäre die Angabe doppelt zur Ansicht. */}
        {(n.archiviertAm !== null || n.entferntAm !== null) && (
          <span className="post-row__zustand">
            {n.entferntAm !== null
              ? <><Trash2 size={10} /> {t('post.ansichtPapierkorb')}</>
              : <><Archive size={10} /> {t('post.ansichtArchiv')}</>}
          </span>
        )}
        {ungelesen && <span className="post__sr-only">{t('post.ungelesenMarke')}</span>}
      </button>
    );
  }
}

/**
 * Ein Eintrag im Verlauf — mit eigenem Umschalter für die HTML-Vorschau.
 *
 * Bewusst auf Modulebene statt in PostPanel verschachtelt, mit eigenem
 * `useState`: eine in einer anderen Komponente NEU DEFINIERTE Komponente
 * bekommt bei jedem Rendern der äußeren einen neuen Bauplan (eine neue
 * Funktionsreferenz), und React sieht darin einen ANDEREN Komponententyp —
 * es baut sie neu auf, statt sie nur zu aktualisieren, und jeder eigene
 * Zustand geht dabei verloren. Das Antwortfeld daneben ändert seinen
 * Zustand bei jedem Tastendruck; verschachtelt wäre der HTML-Umschalter
 * also bei jedem Zeichen zurück auf „nur Text" gesprungen. `t` kommt deshalb
 * als Wert herein statt aus einem eigenen `useT()`.
 */
function VerlaufEintrag({
  n, aktiv, t, darfVerwalten, onArchivToggle, onEntfernenToggle, onEndgueltigLoeschen,
}: {
  n: PostNachricht; aktiv: boolean; t: (key: TranslationKey, werte?: Record<string, string | number>) => string;
  /** `mail.verwalten` — blendet nur den Knopf für „endgültig löschen" aus
      (siehe Dateikopf PostPanel: „Durchgesetzt wird auf dem Server"). */
  darfVerwalten: boolean;
  onArchivToggle: (n: PostNachricht) => void;
  onEntfernenToggle: (n: PostNachricht) => void;
  onEndgueltigLoeschen: (n: PostNachricht) => void;
}) {
  const [htmlOffen, setHtmlOffen] = useState(false);
  const [weiterleitenOffen, setWeiterleitenOffen] = useState(false);

  return (
    <div
      data-post-id={n.id}
      className={clsx(
        'post__eintrag',
        aktiv && 'post__eintrag--aktiv',
        n.richtung === 'aus' && 'post__eintrag--richtung-aus',
      )}
    >
      <div className="post__eintrag-kopf">
        {/* `title` sitzt auf der Hülle, nicht auf dem Symbol selbst: lucide-react
            reicht kein `title` an das SVG durch (LucideProps kennt es nicht),
            eine Elternspanne mit Titel-Attribut zeigt denselben Hinweis beim
            Überfahren mit der Maus. */}
        <span
          className="post__eintrag-richtung"
          title={n.richtung === 'ein' ? t('post.eingegangen') : t('post.ausgegangen')}
          aria-hidden="true"
        >
          {n.richtung === 'ein' ? <ArrowDownLeft size={13} className="muted" /> : <ArrowUpRight size={13} className="muted" />}
        </span>
        <span className="post__eintrag-adresse truncate">{n.richtung === 'ein' ? n.von : n.an}</span>
        <span className="post__eintrag-zeit">{dateTime(n.am)}</span>

        {/* Weiterleiten, Archivieren/Entfernen (umkehrbar, ohne Rückfrage)
            und endgültig löschen (unumkehrbar, mit ausdrücklicher
            Bestätigung — siehe endgueltigLoeschenHandler() in PostPanel) —
            je Eintrag im Verlauf, nicht je Thread: `archiviertAm`/
            `entferntAm` stehen an der einzelnen Nachricht (services/post.ts,
            Dateikopf). */}
        <span className="post__eintrag-aktionen">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title={t('post.weiterleiten')}
            aria-label={t('post.weiterleiten')}
            onClick={() => setWeiterleitenOffen(true)}
          >
            <Forward size={13} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title={n.archiviertAm === null ? t('post.archivieren') : t('post.ausArchivHolen')}
            aria-label={n.archiviertAm === null ? t('post.archivieren') : t('post.ausArchivHolen')}
            onClick={() => onArchivToggle(n)}
          >
            {n.archiviertAm === null ? <Archive size={13} /> : <ArchiveRestore size={13} />}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title={n.entferntAm === null ? t('post.entfernen') : t('post.wiederherstellen')}
            aria-label={n.entferntAm === null ? t('post.entfernen') : t('post.wiederherstellen')}
            onClick={() => onEntfernenToggle(n)}
          >
            {n.entferntAm === null ? <Trash2 size={13} /> : <RotateCcw size={13} />}
          </button>
          {darfVerwalten && (
            <button
              type="button"
              className="icon-btn icon-btn--sm icon-btn--gefahr"
              title={t('post.endgueltigLoeschen')}
              aria-label={t('post.endgueltigLoeschen')}
              onClick={() => onEndgueltigLoeschen(n)}
            >
              <X size={13} />
            </button>
          )}
        </span>
      </div>

      {/* Eigene Komponente (siehe PostFristAnzeige.tsx) — kennt Text
          (Einheit nach Restzeit) und Farbe (je näher, desto auffälliger)
          vollständig selbst; rendert nichts, solange keine Frist gesetzt
          ist. */}
      <PostFristAnzeige verfaelltAm={n.verfaelltAm} />

      {/* Eigene Komponente (siehe PostAnhaenge.tsx) — kennt Herunterladen,
          fehlende Bytes und den Hinweis "kein Virenschutz" vollständig
          selbst. */}
      <PostAnhaenge anhaenge={n.anhaenge} />

      {/* Reiner Text als React-Kindknoten: der Browser kann daraus keinen
          Code machen, ganz ohne Sonderbehandlung. Das ist die Vorgabe — HTML
          gibt es nur nach ausdrücklichem Klick, siehe unten. */}
      <div className="post__text">{n.text}</div>

      {n.html && (
        <div className="post__html-zeile">
          <button className="pill" onClick={() => setHtmlOffen((v) => !v)}>
            {htmlOffen ? t('post.nurText') : t('post.htmlAnzeigen')}
          </button>
        </div>
      )}

      {n.html && htmlOffen && (
        <>
          <iframe
            className="post__html-rahmen"
            title={t('post.htmlVorschau')}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={htmlDokument(n.html)}
          />
          <p className="post__html-hinweis"><AlertTriangle size={12} /> {t('post.htmlHinweis')}</p>
        </>
      )}

      {weiterleitenOffen && <WeiterleitenFenster n={n} t={t} onClose={() => setWeiterleitenOffen(false)} />}
    </div>
  );
}

/**
 * Eine bestehende Mail an eine andere Adresse weitergeben — Text und
 * Anhänge übernimmt der Server (services/post.ts, weiterleiten()), diese
 * Tafel fragt nur nach dem, was er von sich aus nicht wissen kann: aus
 * welchem Fach und an wen.
 *
 * Text und Betreff stehen NUR lesend hier (siehe Dateikopf des Auftrags:
 * „mit dem ursprünglichen Text") — kein Editierfeld, das den Eindruck weckte,
 * man könne den Inhalt vor dem Versand noch verändern.
 */
function WeiterleitenFenster({ n, t, onClose }: {
  n: PostNachricht; t: (key: TranslationKey, werte?: Record<string, string | number>) => string; onClose: () => void;
}) {
  const [faecher, setFaecher] = useState<AbsenderFach[] | null>(null);
  const [faecherFehler, setFaecherFehler] = useState<string | null>(null);
  const [fach, setFach] = useState('');
  const [an, setAn] = useState('');
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const liste = await schreibfaecherHolen();
        setFaecher(liste);
        // Vorgabe: dasselbe Fach, an das die Ursprungsmail ging — siehe
        // Auftrag: „Lass es wählen und setz eine sinnvolle Vorgabe."
        const passend = liste.find((f) => f.fach === n.fach);
        setFach(passend?.fach ?? liste[0]?.fach ?? '');
      } catch (err) {
        setFaecherFehler((err as Error).message);
      }
    })();
  }, [n.fach]);

  const adresseGueltig = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(an.trim());

  const weiterleiten = async () => {
    if (!fach || !adresseGueltig) return;
    setLaedt(true); setFehler(null);
    try {
      await weiterleitenApi(n.id, { fach, an: an.trim() });
      useStore.getState().toast({ kind: 'ok', title: t('post.weitergeleitet') });
      onClose();
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setLaedt(false);
    }
  };

  return (
    <Shell title={t('post.weiterleiten')} icon={<Forward size={18} />} onClose={onClose} width={480}>
      <div className="post-schreiben">
        {faecherFehler && <div className="post__fehler"><AlertTriangle size={13} /> {faecherFehler}</div>}

        <div className="field">
          <label className="field__label">{t('post.absenderfach')}</label>
          {!faecher && !faecherFehler && <Loader2 size={14} className="spin muted" role="status" aria-label={t('post.laedt')} />}
          {faecher && !faecher.length && <p className="field__hint">{t('post.keineFaecher')}</p>}
          {faecher && !!faecher.length && (
            <select className="select" value={fach} onChange={(e) => setFach(e.target.value)}>
              {faecher.map((f) => <option key={f.fach} value={f.fach}>{f.adresse}</option>)}
            </select>
          )}
        </div>

        <div className="field">
          <label className="field__label">{t('post.empfaenger')}</label>
          <input
            className="input"
            value={an}
            autoFocus
            placeholder={t('post.empfaengerPlatzhalter')}
            onChange={(e) => setAn(e.target.value)}
          />
          {an.trim() !== '' && !adresseGueltig && (
            <p className="field__hint post-schreiben__warnung">{t('post.empfaengerUngueltig')}</p>
          )}
        </div>

        <div className="field">
          <span className="field__label">{t('post.betreffLabel')}</span>
          <p className="post-entwurf__empfaenger truncate">{n.betreff || t('post.ohneBetreff')}</p>
          <p className="field__hint">{t('post.weiterleitenBetreffHinweis')}</p>
        </div>

        <div className="field">
          <span className="field__label">{t('post.entwurfTextLabel')}</span>
          <div className="post__weiterleiten-text muted">{n.text}</div>
        </div>

        {!!n.anhaenge.length && (
          <div className="field">
            <span className="field__label">{t('post.anhaenge')}</span>
            <PostAnhaenge anhaenge={n.anhaenge} />
          </div>
        )}

        {fehler && <div className="post__fehler"><AlertTriangle size={13} /> {fehler}</div>}

        <div className="post-schreiben__fuss">
          <span className="muted post-schreiben__hinweis">{t('post.sendenHinweis')}</span>
          <button
            className="btn btn--primary"
            disabled={!fach || !adresseGueltig || laedt}
            onClick={() => void weiterleiten()}
          >
            {laedt ? <Loader2 size={14} className="spin" /> : <Forward size={14} />} {t('post.weiterleiten')}
          </button>
        </div>
      </div>
    </Shell>
  );
}

/**
 * Aufbewahrungsfrist je Fach einrichten — `GET`/`POST`/`DELETE
 * /api/post/fristen`, alle drei hinter `mail.verwalten` (siehe dort, warum:
 * dieselbe Schwelle wie beim Postfach-Zugang selbst).
 *
 * Zeigt IMMER alle Fächer, auch die ohne gesetzte Frist — „keine Frist
 * gesetzt" ist der sichtbare Normalzustand, kein leerer Ausschnitt (siehe
 * services/post.ts, fristenStand()).
 */
function FristenFenster({ t, onClose }: {
  t: (key: TranslationKey, werte?: Record<string, string | number>) => string; onClose: () => void;
}) {
  const [fristen, setFristen] = useState<PostFristStand[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  /* Der eingetippte, noch nicht gespeicherte Tageswert je Fach — nicht zu
     verwechseln mit den KI-Antwortentwürfen (`entwuerfe` in PostPanel oben,
     eine ganz andere, hier nicht sichtbare Komponente). */
  const [tageFelder, setTageFelder] = useState<Record<string, string>>({});
  const [speichertFach, setSpeichertFach] = useState<string | null>(null);

  const laden = async () => {
    setFehler(null);
    try {
      const liste = await fristenHolen();
      setFristen(liste);
      setTageFelder(Object.fromEntries(liste.map((f) => [f.fach, f.tage === null ? '' : String(f.tage)])));
    } catch (err) {
      setFehler((err as Error).message);
    }
  };
  useEffect(() => { void laden(); }, []);

  const speichern = async (fach: string) => {
    const wert = Math.trunc(Number(tageFelder[fach]));
    if (!Number.isFinite(wert) || wert < 1) {
      useStore.getState().toast({ kind: 'error', title: t('post.ungueltigeFrist') });
      return;
    }
    setSpeichertFach(fach);
    try {
      await fristSetzenApi(fach, wert);
      useStore.getState().toast({ kind: 'ok', title: t('post.fristGespeichert') });
      await laden();
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('post.aktionFehlgeschlagen'), body: (err as Error).message });
    } finally {
      setSpeichertFach(null);
    }
  };

  const abschalten = async (fach: string) => {
    if (!window.confirm(t('post.fristAbschaltenBestaetigen'))) return;
    setSpeichertFach(fach);
    try {
      await fristLoeschenApi(fach);
      useStore.getState().toast({ kind: 'ok', title: t('post.fristAbgeschaltet') });
      await laden();
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('post.aktionFehlgeschlagen'), body: (err as Error).message });
    } finally {
      setSpeichertFach(null);
    }
  };

  return (
    <Shell title={t('post.fristenTitel')} icon={<CalendarClock size={18} />} onClose={onClose} width={520}>
      <div className="post-fristen">
        <p className="muted post-fristen__hinweis">{t('post.fristenHinweis')}</p>
        {fehler && <div className="post__fehler"><AlertTriangle size={13} /> {fehler}</div>}
        {!fristen && !fehler && <Loader2 size={18} className="spin muted" role="status" aria-label={t('post.laedt')} />}
        {fristen && fristen.map((f) => (
          <div key={f.fach} className="post-fristen__zeile">
            <span className="post-fristen__fach truncate" title={f.fach}>{fachName(f.fach)}</span>
            <input
              className="input post-fristen__tage"
              type="number"
              min={1}
              step={1}
              value={tageFelder[f.fach] ?? ''}
              placeholder={t('post.fristKeine')}
              aria-label={t('post.fristTageAria', { fach: fachName(f.fach) })}
              onChange={(e) => setTageFelder((v) => ({ ...v, [f.fach]: e.target.value }))}
            />
            <span className="muted post-fristen__einheit">{t('post.tage')}</span>
            <button
              className="btn"
              disabled={speichertFach === f.fach || !tageFelder[f.fach]?.trim()}
              onClick={() => void speichern(f.fach)}
            >
              {speichertFach === f.fach ? <Loader2 size={13} className="spin" /> : t('common.save')}
            </button>
            {f.tage !== null && (
              <button
                className="icon-btn icon-btn--sm"
                title={t('post.fristAbschalten')}
                aria-label={t('post.fristAbschalten')}
                disabled={speichertFach === f.fach}
                onClick={() => void abschalten(f.fach)}
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </Shell>
  );
}

/**
 * Der KI-Antwortentwurf zu genau einer eingegangenen Mail — direkt im
 * Verlauf, unter dem Eintrag, auf den er antwortet.
 *
 * WARUM HIER UND NICHT IM REITER „POST-SICHTUNG" (PostMeldungen.tsx)
 *
 * Der Reiter „Post-Sichtung" ist die Triage-Liste — eine Zeile pro Mail,
 * zum schnellen Überblick, mit „Ein Antwortentwurf wartet auf Freigabe" als
 * einziger Zeile, die zum Handeln auffordert (siehe der Dateikopf dort). Er
 * hat bewusst keine eigene Detailansicht: ein Klick führt über
 * `jumpToPostMail()` immer hierher, ins Postfach. Beantwortet wird eine Mail
 * am ganzen Verlauf — hier steht schon die Unterhaltung, hier sitzt schon
 * die (jetzt überflüssige) Handschreib-Antwort weiter unten, und hier gilt
 * dieselbe Rechteschwelle (`mail.senden` fürs Freigeben) wie an jedem
 * anderen Sendeknopf im Postfach. Zwei Orte für dieselbe Handlung hätten nur
 * dieselbe Frage zweimal beantwortet.
 *
 * Bewusst auf Modulebene wie VerlaufEintrag oben, mit eigenem Zustand für
 * Betreff und Text: jeder Tastendruck in diesen Feldern darf nicht das ganze
 * PostPanel neu rendern lassen (dieselbe Begründung wie beim HTML-Umschalter
 * dort).
 *
 * DIE GEÄNDERTE REGEL
 *
 * Betreff und Text sind editierbar — was im Feld steht, geht hinaus (siehe
 * die ausführliche Begründung am Kopf der Route `/api/post/entwuerfe/:id/senden`
 * in routes.ts). Der Empfänger ist es bewusst NICHT: reiner Anzeigetext, aus
 * demselben Sicherheitsgrund wie auf dem Server — die Adresse darf nie aus
 * etwas stammen, das sich von hier aus beeinflussen ließe.
 *
 * DIE KI-KENNZEICHNUNG
 *
 * Steckt nicht mehr im Text und wird hier nicht mehr geprüft — sie ist eine
 * Fußzeile, die `post.ts::senden()` server-seitig anhängt (post-fussnote.ts).
 * Die Route `/api/post/entwuerfe/:id/senden` liest dafür den nie
 * überschriebenen `text_ki` des Entwurfs selbst aus der Datenbank und
 * vergleicht ihn dort gegen den (womöglich bearbeiteten) Text aus diesem
 * Feld — diese Tafel muss dafür nichts mitschicken und nichts prüfen.
 */
function EntwurfKarte({ entwurf, t, faecher, onEntschieden }: {
  entwurf: PostEntwurf;
  t: (key: TranslationKey, werte?: Record<string, string | number>) => string;
  /** Dieselbe, einmal geladene Liste wie für die Antwort-Box (siehe
      PostPanel, `sendeFaecher`) — kann beim Erscheinen dieser Karte noch
      `null` sein, siehe der Korrektur-Effekt gleich unten. */
  faecher: AbsenderFach[] | null;
  onEntschieden: (gesendet: boolean) => void;
}) {
  const [betreff, setBetreff] = useState(entwurf.betreff);
  const [text, setText] = useState(entwurf.text);
  /* Vorbelegt mit dem Fach der Ursprungsmail, änderbar (siehe Auftrag: „das
     Fach ist … vorbelegt … und lässt sich ändern"). `faecher` kann bei
     Erststellung dieser Karte noch nicht geladen sein (async, siehe
     PostPanel) — der Effekt korrigiert auf ein wirklich sendbares Fach,
     sobald die Liste da ist (dieselbe Bauart wie bei WeiterleitenFenster:
     landete die Ursprungsmail in `sonstiges`, taugt ihr Fach nicht als
     Vorgabe, dann greift das erste sendbare). */
  const [fach, setFach] = useState<string | null>(entwurf.fach);
  useEffect(() => {
    if (!faecher || !faecher.length) return;
    setFach((bisher) => (bisher && faecher.some((f) => f.fach === bisher) ? bisher : faecher[0].fach));
  }, [faecher]);
  const [freigebenLaedt, setFreigebenLaedt] = useState(false);
  const [ablehnenLaedt, setAblehnenLaedt] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  /* Anhänge für die freizugebende Antwort — dasselbe Muster wie im
     Antwortfeld oben und im Schreibfenster (PostSchreiben.tsx): sofort beim
     Auswählen hochgeladen, erst beim tatsächlichen Freigeben verknüpft. Ein
     KI-Entwurf entsteht ohne eigene Anhänge (post-entwurf-ki.ts hängt nichts
     an) — hier lässt sich vor dem Absenden welche nachreichen. */
  const [anhaenge, setAnhaenge] = useState<AusgehenderAnhang[]>([]);
  const [hochladend, setHochladend] = useState(0);
  const dateiInput = useRef<HTMLInputElement>(null);

  const dateienHinzufuegen = async (dateien: FileList) => {
    const liste = Array.from(dateien).slice(0, Math.max(0, ANHAENGE_MAX_UI - anhaenge.length));
    setHochladend((v) => v + liste.length);
    await Promise.all(liste.map(async (datei) => {
      try {
        const angelegt = await anhangHochladen(datei);
        setAnhaenge((v) => [...v, angelegt]);
      } catch (err) {
        useStore.getState().toast({
          kind: 'error', title: t('post.anhangHochladenFehlgeschlagen'), body: (err as Error).message,
        });
      } finally {
        setHochladend((v) => v - 1);
      }
    }));
  };
  const anhangEntfernen = (id: string) => {
    setAnhaenge((v) => v.filter((a) => a.id !== id));
    void anhangVerwerfen(id).catch(() => { /* verwaist harmlos, siehe post.ts */ });
  };

  const freigeben = async () => {
    setFreigebenLaedt(true); setFehler(null);
    try {
      await entwurfFreigeben(entwurf.id, {
        betreff: betreff.trim(), text, anhaenge: anhaenge.length ? anhaenge.map((a) => a.id) : undefined,
        fach: fach ?? undefined,
      });
      useStore.getState().toast({ kind: 'ok', title: t('post.gesendet') });
      onEntschieden(true);
    } catch (err) {
      // Betreff und Text bleiben stehen: eine sorgfältig überarbeitete
      // Antwort geht bei einem Fehlschlag nicht verloren, und der Grund
      // steht direkt darunter, statt nur kurz als Meldung aufzublitzen.
      setFehler((err as Error).message);
    } finally {
      setFreigebenLaedt(false);
    }
  };

  const ablehnen = async () => {
    if (!window.confirm(t('post.entwurfAblehnenBestaetigen'))) return;
    setAblehnenLaedt(true); setFehler(null);
    try {
      await entwurfAblehnen(entwurf.id);
      useStore.getState().toast({ kind: 'ok', title: t('post.entwurfAbgelehnt') });
      onEntschieden(false);
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setAblehnenLaedt(false);
    }
  };

  const gesperrt = freigebenLaedt || ablehnenLaedt;

  return (
    <div className="post-entwurf">
      <div className="post-entwurf__kopf">
        <Sparkles size={13} />
        <span>{t('post.entwurfTitel')}</span>
      </div>

      {entwurf.begruendung && <p className="post-entwurf__begruendung">{entwurf.begruendung}</p>}

      {/* Der Warnsatz bei abweichender Reply-To-Domäne — sichtbar, bevor
          jemand auf „Freigeben" drückt: vor den Feldern, nicht danach, nicht
          ausgeklappt. Dieselbe Übersetzung wie im Reiter „Post-Sichtung"
          (postSichtung.abweichung), damit ein und dieselbe Warnung an beiden
          Stellen gleich klingt. */}
      {entwurf.abweichung && (
        <p className="post-entwurf__warnung">
          <AlertTriangle size={12} />
          {t('postSichtung.abweichung', { an: entwurf.abweichung.an, von: entwurf.abweichung.von })}
        </p>
      )}

      <div className="field">
        <label className="field__label" htmlFor={`entwurf-fach-${entwurf.id}`}>{t('post.absenderfach')}</label>
        {faecher && !!faecher.length && (
          <select
            id={`entwurf-fach-${entwurf.id}`}
            className="select"
            value={fach ?? ''}
            onChange={(e) => setFach(e.target.value)}
          >
            {faecher.map((f) => <option key={f.fach} value={f.fach}>{f.adresse}</option>)}
          </select>
        )}
        {(!faecher || !faecher.length) && <p className="field__hint">{fach ?? ''}</p>}
      </div>

      <div className="field">
        <span className="field__label">{t('post.empfaenger')}</span>
        <p className="post-entwurf__empfaenger truncate">{entwurf.an}</p>
        <p className="field__hint">{t('post.entwurfEmpfaengerHinweis')}</p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`entwurf-betreff-${entwurf.id}`}>{t('post.betreffLabel')}</label>
        <input
          id={`entwurf-betreff-${entwurf.id}`}
          className="input"
          value={betreff}
          onChange={(e) => setBetreff(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`entwurf-text-${entwurf.id}`}>{t('post.entwurfTextLabel')}</label>
        <textarea
          id={`entwurf-text-${entwurf.id}`}
          className="textarea"
          rows={9}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      <div className="field">
        <input
          ref={dateiInput}
          type="file"
          multiple
          hidden
          onChange={(e) => { if (e.target.files?.length) void dateienHinzufuegen(e.target.files); e.target.value = ''; }}
        />
        <div className="post-schreiben__anhaenge">
          {anhaenge.map((a) => (
            <span key={a.id} className="post-schreiben__anhang" title={a.name}>
              <span className="post-schreiben__anhang-name truncate">{a.name}</span>
              <span className="post-schreiben__anhang-groesse">{fileSize(a.size)}</span>
              <button
                type="button"
                className="post-schreiben__anhang-entfernen"
                title={t('common.remove')}
                aria-label={t('common.remove')}
                onClick={() => anhangEntfernen(a.id)}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {hochladend > 0 && (
            <span className="post-schreiben__anhang muted">
              <Loader2 size={11} className="spin" /> {t('post.anhangWirdHochgeladen')}
            </span>
          )}
          {anhaenge.length + hochladend < ANHAENGE_MAX_UI && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => dateiInput.current?.click()}
            >
              <Paperclip size={13} /> {t('post.anhangHinzufuegen')}
            </button>
          )}
        </div>
      </div>

      {fehler && <div className="post__fehler"><AlertTriangle size={13} /> {fehler}</div>}

      <div className="post-entwurf__fuss">
        <span className="muted post-entwurf__hinweis">{t('post.sendenHinweis')}</span>
        <div className="hstack gap-2">
          <button className="btn" disabled={gesperrt} onClick={() => void ablehnen()}>
            {ablehnenLaedt ? <Loader2 size={14} className="spin" /> : <X size={14} />}
            {t('post.entwurfAblehnen')}
          </button>
          <button
            className="btn btn--primary"
            disabled={gesperrt || !betreff.trim() || !text.trim() || !fach}
            onClick={() => void freigeben()}
          >
            {freigebenLaedt ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            {t('post.entwurfFreigeben')}
          </button>
        </div>
      </div>
    </div>
  );
}
