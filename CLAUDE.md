# Stellium — für die Arbeit an diesem Projekt

Firmen-Chat mit Live-Übersetzung. Server auf einem Raspberry Pi, Apps für
macOS, Windows und Linux, dazu die Oberfläche im Browser.

## Eine Änderung ausliefern

Sagt Don sinngemäß **„lade das Update hoch"**, dann führe ohne Rückfrage aus:

```bash
node scripts/ausliefern.mjs
```

Dasselbe gilt für: „veröffentliche das", „mach ein Update", „schick das raus",
„update alles", „lade das auf den Server", „push das", „installier das neue".
Er will das Ergebnis, nicht den Befehl — frage nicht nach der Versionsnummer
und nicht nach der Änderungsliste.

Das Werkzeug erledigt in einem Durchgang: prüfen, Version hochzählen, für alle
drei Systeme bauen, auf den Stellium-Server laden (damit laufen die OTA-Updates
für Apps **und** Server an), Release auf GitHub, committen und schieben, und die
neue Fassung auf Dons Mac installieren und starten.

**Die Änderungsliste** entsteht ohne Zutun aus den Commit-Betreffen seit der
letzten Fassung — deshalb ist jeder Commit-Betreff ein vollständiger Satz, der
erklärt, was sich für die Benutzer ändert. Willst du sie stattdessen selbst
formulieren, gib sie als Argument mit:

```bash
node scripts/ausliefern.mjs "Erste Zeile
Zweite Zeile"
```

**Vor dem Ausliefern committen.** Was nicht committet ist, fehlt in der Liste.

Einzelheiten und Schalter (`--nur-mac`, `--ohne-github`, `--probe` …):
[AUSLIEFERN.md](AUSLIEFERN.md).

## Aufbau

```
packages/shared    Typen, WS-Protokoll, Sprachlisten
packages/server    Fastify + node:sqlite, WebSocket-Gateway, Übersetzung, KI
packages/desktop   Electron + React; src/ ist auch die Browser-Oberfläche
server-setup       Ein-Klick-Installer und Werkzeuge für den Raspberry Pi
scripts            Prüfläufe (e2e-*), Wörterbücher, Ausliefern
```

## Zwei Dinge, die man leicht übersieht

**Alle Texte kommen aus dem Wörterbuch.** Nichts Lesbares gehört fest in den
Code — die Oberfläche liegt in 22 Sprachen vor. Prüfen mit:

```bash
node scripts/deutsch-finden.mjs      # findet fest verdrahtete Texte
node scripts/woerterbuecher-erzeugen.mjs --neue   # fehlende Einträge ergänzen
```

Englisch ist Vorlage wie Deutsch und wird vom Generator **nicht** gefüllt —
neue Schlüssel dort von Hand nachtragen.

**Nachrichten liegen verschlüsselt in der Datenbank.** Wer eine neue Spalte
mit lesbarem Inhalt anlegt, muss sie durch `crypto/nachrichten.ts` schicken
und in `db/migrate.ts` in die Nachrüstung aufnehmen. Der Volltextindex trägt
Fingerabdrücke, keine Wörter.

## Prüfläufe

Brauchen `npm run dev` in einem zweiten Fenster (Server auf 8787, Oberfläche
auf 5173) und ein Konto `don`. Für Prüfungen, die Rechte brauchen
(Nutzerverwaltung, Ideen-Status, Anbieterwahl), muss das Konto owner oder
admin sein — sonst kommen 403er, die keine echten Fehler sind.

```bash
node scripts/e2e-neu.mjs             # Grundfunktionen
node scripts/e2e-dialoge.mjs         # jedes Fenster in drei Fenstergrößen
node scripts/e2e-handy.mjs           # Telefonansicht
node scripts/e2e-thread.mjs          # Thread-Layout über alle Breiten
node scripts/e2e-verschluesselung.mjs
node scripts/e2e-upload.mjs
node scripts/e2e-nachruesten.mjs   # Server auf einer ALTEN Datenbank
node scripts/schluesselwechsel-pruefen.mjs   # falsches Masterpasswort
node scripts/notzugang-pruefen.mjs           # „3 von 5" — Notzugang
node scripts/fern-mehrere-pruefen.mjs        # mehrere sehen dem Pi zu
```

Die letzten vier brauchen keinen laufenden Server. `e2e-nachruesten` baut
eine Datenbank nach dem Schema der letzten Fassung und startet den heutigen
Server darauf. Alle anderen Läufe legen ihre Datenbank frisch an — dort bringt
`CREATE TABLE` jede neue Spalte gleich mit, und ein Fehler in `db/migrate.ts`
fällt erst auf dem Server auf. Wer eine Spalte ergänzt, prüft damit.

`schluesselwechsel-pruefen` startet gegen Wegwerf-Datenbanken einmal mit dem
richtigen und einmal mit einem anderen Masterpasswort: der zweite Start muss
abbrechen. Wer an `crypto/pii.ts`, `crypto/nachrichten.ts` oder der
Schlüsselableitung dreht, prüft damit.

`fern-mehrere-pruefen` startet den Fernsteuerungs-Dienst des Pi gegen einen
nachgemachten Abgreifer und lässt mehrere Zuschauer darauf los: verteilt er das
Bild an alle, nimmt er Eingaben nur von einem, und wird ein Platz wieder frei,
wenn eine Verbindung abreißt, ohne sich abzumelden? Wer an
`server-setup/fernsteuerung/dienst/` dreht, prüft damit.

`notzugang-pruefen` misst zuerst die Geheimnisteilung
(`shared/geheimnisteilung.ts`) gegen die AES-S-Box, die Rundenkonstanten und
gegen OpenSSL — eine falsche Multiplikation in GF(2^8) sieht sonst aus wie
eine richtige. Danach den ganzen Weg gegen eine Wegwerf-Datenbank: drei von
fünf Anteilen holen den Kontoschlüssel zurück, zwei nie, und `fassung` bewegt
sich dabei nicht. Wer an `services/kontoschluessel.ts`, `services/notzugang.ts`
oder `lib/notzugang.ts` dreht, prüft damit.

## Sprache im Code

Deutsch: Bezeichner, Kommentare, Commit-Nachrichten. Kommentare erklären das
**Warum** — was der Code tut, steht im Code.
