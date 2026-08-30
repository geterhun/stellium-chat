# Stellium

Team-Chat für Unternehmen. Alle schreiben in ihrer eigenen Sprache und lesen
in ihrer eigenen Sprache — dazwischen übersetzt ein Sprachmodell in Echtzeit.

Desktop-App für **macOS** (Intel und Apple Silicon), **Windows** und **Linux**.

---

## In einem Satz

Du schreibst auf Deutsch, Yuki liest es auf Japanisch, Ana auf Spanisch — und
das Original ist für alle einen Klick entfernt.

---

## Schnellstart

```bash
npm install
npm run secret -w @stellium/server -- setzen groq   # Groq-Schlüssel verschlüsselt ablegen
npm run dev
```

Beim ersten Start legt der Server ein Owner-Konto an und zeigt ein
**Einmal-Passwort** im Log. Damit meldest du dich an und setzt eigene
Zugangsdaten. Weitere Konten legst du danach in der App an.

Das App-Fenster startest du in einem zweiten Terminal:

```bash
npm run dev:electron -w @stellium/desktop
```

Fertige Installationsdateien liegen unter
[Releases](https://github.com/chackrahunter/stellium-chat/releases).

---

## Was drin ist

### Übersetzung

Der Kern. Jede Nachricht wird für jede Person in ihre Sprache gebracht — 22
Sprachen.

- Das **Original ist die Wahrheit**: gespeichert wird immer der Ausgangstext,
  Übersetzungen liegen als Cache daneben und verfallen bei Änderungen
- **Maskierung**: Codeblöcke, Links, @Erwähnungen und Glossarbegriffe werden
  vor der Übersetzung ausgeklammert. Verstümmelt das Modell die Platzhalter,
  zeigt die App lieber das Original als sinnentstellten Text
- **Glossar** für Produktnamen und interne Begriffe — entweder unangetastet
  oder mit fester Übersetzung je Sprache
- **Vorschau beim Tippen**: du siehst, wie deine Nachricht in der Kanalsprache
  ankommt, bevor du sie abschickst
- **Rückübersetzung** auf Knopfdruck mit Ähnlichkeitswert — erkennt
  Übersetzungen, die die Bedeutung verdreht haben
- Zwei Cache-Ebenen: dieselbe Formulierung kostet nie zweimal einen API-Aufruf
- **Suche über Originale und Übersetzungen**: ein deutsches Suchwort findet
  auch, was auf Englisch geschrieben wurde

### KI-Assistent

Ein eigenes Konto mit der Rolle „bot". Dadurch laufen seine Antworten durch die
normale Übersetzung und landen in der Suche.

- **Privater Chat** — nur du siehst ihn
- **Gemeinsamer Kanal** `#ki-team`, in dem das ganze Team mit ihm spricht
- Pro Kanal einstellbar: schweigt, antwortet auf `@ki`, oder antwortet immer
- **Was habe ich verpasst?** — fasst Ungelesenes zusammen, mit Entscheidungen
  und Aufgaben
- **Antwortvorschläge**, **Umformulieren** (korrigieren, förmlicher, kürzen,
  Stichpunkte), **Frage an den Kanal** mit Quellenangabe

**Er erfindet nichts.** Sein gesamtes Firmenwissen stammt aus dem sichtbaren
Kanalverlauf. Fragt man nach einem Projekt, das dort nicht vorkommt, sagt er
das und fragt nach — statt eine plausible Antwort zu bauen. Das ist geprüft:
`scripts/` enthält die Testfälle.

### Sprachnachrichten

Aufnehmen, senden. **Whisper tippt ab** — auf dem Server selbst, über einen
kleinen whisper.cpp-Dienst nebenan (`server-setup/dienste/stimme-einrichten.sh`).
Die Aufnahme verlässt das Haus nicht. Ohne diesen Dienst wird über Groq
abgetippt, sofern ein Schlüssel hinterlegt ist.

Das Transkript wird zum Text der Nachricht — und ist damit automatisch
übersetzt, durchsuchbar und für die KI lesbar: Zusammenfassung,
Aufgabenerkennung und Assistent sehen eine Sprachnachricht wie getippten Text.
Eine japanische Sprachnachricht liest du auf Deutsch.

In vertraulichen Kanälen gibt es weder Sprachnachrichten noch Transkripte.

### Chat-Grundlagen

Öffentliche und private Kanäle, Direktnachrichten, Threads, Reaktionen,
@Erwähnungen, `#`-Kanalverweise (beide mit Vervollständigung), Datei-Upload per
Drag & Drop, Präsenz, Tipp-Indikatoren, Lesestände, Volltextsuche, native
Benachrichtigungen, Offline-Warteschlange.

**Bearbeiten und Löschen sind zeitlich begrenzt.** Zwei Stunden nach dem Senden
lässt sich eine Nachricht ändern oder für alle zurücknehmen. Danach bleibt das
Ausblenden für einen selbst — sonst entstünden Lücken in einem Verlauf, auf den
sich andere schon bezogen haben.

### Kanäle verwalten

Umbenennen, Thema und Zweck setzen, Kanalsprache wählen, Mitglieder hinzufügen
und entfernen, stummschalten, anheften, als **Ankündigungskanal** sperren (nur
die Verwaltung schreibt), archivieren, löschen. Direktnachrichten lassen sich
ausblenden, ohne sie für die andere Seite anzutasten.

### Konten und Rechte

Keine Selbstregistrierung. Die Team-Leitung legt Konten an und gibt ein
**Einmal-Passwort** weiter; beim ersten Login setzt die Person eigenes
Passwort, Benutzernamen und E-Mail.

**Neun Rollen** als Vorlage:

| Rolle | Rechte |
|---|---|
| Inhaber | 27 von 27 |
| Administrator | 24 |
| Moderation | 23 |
| Teamleitung | 21 |
| Mitglied | 15 |
| Mitwirkend | 11 |
| Bot | 6 |
| Gast | 5 |
| Nur lesen | 1 |

**27 einzelne Rechte** lassen sich pro Person abweichend setzen — vom Senden
über Erwähnen und Dateien bis zur Kontoverwaltung. Durchgesetzt wird alles auf
dem Server.

### Aufgaben

Ein Brett mit fünf Spalten — offen, in Arbeit, zur Prüfung, fertig, blockiert.
Karten lassen sich zwischen den Spalten ziehen. Jede Aufgabe hat jemanden, der
sie macht, eine Wichtigkeit, einen Termin, Kommentare und einen
Änderungsverlauf. Jede Person sieht die Spalten in ihrer eigenen Sprache.

StelliumAI kann aus einem Gesprächsverlauf herauslesen, was offen geblieben
ist, und daraus Aufgaben vorschlagen. Angelegt wird nur, was jemand bestätigt.

### Kalender

Wochenansicht in der eigenen Zeitzone. Beim Einladen steht an jeder Person, wie
spät es bei ihr wäre — der häufigste Grund für misslungene Termine. Zu- und
Absagen, ganztägige Einträge, Abwesenheiten, Fristen. Fünfzehn Minuten vor
Beginn meldet sich Stellium von selbst.

### Dateiablage

Gemeinsamer Speicher auf dem Server, unabhängig von einzelnen Nachrichten.
Dateien hineinziehen, in Ordner sortieren, durchsuchen, umbenennen. Die
Belegung ist sichtbar, das Kontingent über `STORAGE_QUOTA_GB` einstellbar.

### Ideenboard

Jede Person darf Vorschläge einbringen. Daumen hoch oder runter — derselbe
Daumen noch einmal nimmt die Stimme zurück. Kommentare darunter. Die Leitung
setzt den Stand: neu, in Bearbeitung, fertig oder abgelehnt, auf Wunsch mit
Begründung, die alle sehen.

### Protokoll

StelliumAI schreibt aus einem Kanal ein weitergabefähiges Protokoll: Themen,
Beschlüsse, offene Fragen, Aufgaben. Als Text kopierbar; die Aufgaben lassen
sich mit einem Klick übernehmen.

### Selbstaktualisierung

Die Verwaltung lädt unter *Einstellungen → Aktualisierung* je Plattform eine
Datei hoch. Alle Clients sehen stündlich nach, laden im Hintergrund und prüfen
die SHA-256-Summe. Installiert wird erst auf Klick — Stellium tauscht sich
nicht unbemerkt selbst aus.

### Weitere Funktionen

Umfragen (einfach, mehrfach, anonym), Link-Vorschauen, Weiterleiten mit
Kommentar, Erinnerungen an Nachrichten, Entwürfe über Neustarts hinweg,
Profilkarten mit Ortszeit, Status mit Ablaufzeit, Später-senden über Zeitzonen,
Ruhezeiten, Schnellsuche (⌘K), Slash-Befehle, helles und dunkles Thema.

**Geführte Einführung beim ersten Login.** Sie dunkelt die echte Oberfläche ab
und zeigt mit einem Ring auf das jeweilige Bedienelement — nicht auf einen
Nachbau. Überspringbar und aus den Einstellungen jederzeit neu startbar.

**Die Oberfläche startet in der Sprache des Rechners.** Deutsch und Englisch
sind vollständig übersetzt, umschaltbar und getrennt von der Sprache, in die
Nachrichten übersetzt werden. „Wie der Rechner" bleibt die Vorgabe.

---

## Sicherheit

### Was verschlüsselt ist

| Was | Wie |
|---|---|
| API-Schlüssel | AES-256-GCM + ChaCha20-Poly1305 in Kaskade, Schlüssel aus scrypt |
| E-Mails, Benutzernamen | AES-256-GCM, dazu HMAC-Blind-Index fürs Anmelden |
| Passwörter | scrypt-Hash — **absichtlich nicht** verschlüsselt |

Ein `strings` über die Datenbankdatei findet keine E-Mail und keinen
Benutzernamen im Klartext.

**Warum Passwörter gehasht statt verschlüsselt sind:** Verschlüsselung ist
umkehrbar. Wer den Schlüssel hat, hätte alle Passwörter im Klartext. Gehasht
kann sie niemand auslesen — auch die Team-Leitung nicht. Zurücksetzen
funktioniert trotzdem, es erzeugt ein neues Einmal-Passwort.

### Das Masterpasswort

Liegt in der macOS-Keychain (an dein Login gebunden) oder als
`STELLIUM_MASTER_PASSPHRASE` in der Umgebung — **nie** dauerhaft auf der Platte
neben dem Chiffrat.

```bash
npm run secret -w @stellium/server -- setzen groq      # ablegen
npm run secret -w @stellium/server -- liste            # Namen, nie Werte
npm run secret -w @stellium/server -- passwort-neu     # Masterpasswort erneuern
```

Keiner dieser Befehle schreibt einen Schlüssel oder ein Passwort auf den
Bildschirm, auch nicht gekürzt. Ein Terminal ist kein sicherer Ort: was dort
steht, steht im SSH-Rückblick, in jedem `script`-Mitschnitt und je nach Aufruf
im journald. `setzen` bestätigt nur, dass der Wert abgelegt und zur Probe
wieder entschlüsselt werden konnte.

**Zwei Verfahren, zwei sehr verschiedene Reserven.** Für den Tresor
`secrets.enc` geht das Passwort durch scrypt: ein Rateversuch kostet rund
200 ms, also etwa fünf Versuche pro Sekunde und Kern statt Millionen. Für die
Datenbank geht dasselbe Passwort durch HKDF — und HKDF hat **keinen
Arbeitsfaktor**, es läuft bei jedem Serverstart und muss schnell sein. Daraus
entstehen die Schlüssel für Nachrichtentexte, Volltextindex, Namen und
E-Mail-Adressen sowie für den Blind-Index, über den die Anmeldung läuft. Wer
`stellium.db` in die Hand bekommt, probiert Passwörter so schnell durch, wie
seine Grafikkarte rechnet. Dort schützt allein die Stärke des Passworts.

Deshalb nimmt Stellium ein von Hand eingegebenes Masterpasswort nur an, wenn es
geschätzt rund 100 Bit trägt und mindestens 20 Zeichen lang ist — und bietet von
sich aus an, eines zu erzeugen.
Nimm das Angebot an: 256 Bit, und niemand muss es sich merken.

**Wo ein erzeugtes Passwort landet.** Auf dem Mac in der Keychain. Überall
sonst — also auch auf dem Pi — in `data/neues-masterpasswort.txt`, Rechte
`0600`, nur für den eigenen Benutzer lesbar; auf dem Bildschirm erscheint es
nicht. Diese Datei ist eine Übergabe, kein Aufbewahrungsort:

1. Wert dort ablegen, wo du Passwörter aufbewahrst
2. Wert als `STELLIUM_MASTER_PASSPHRASE` in die Umgebung des Dienstes eintragen
   (systemd: `EnvironmentFile=`, nicht in die `.env` neben den Daten)
3. Dienst neu starten
4. `rm data/neues-masterpasswort.txt`

Bleibt die Datei liegen, liegt der Schlüssel zu allen Nachrichten im selben
Verzeichnis wie das Chiffrat — und in jedem Backup davon.

**`STELLIUM_SCHWACHES_MASTERPASSWORT=ja-ich-weiss-was-ich-tue` hebelt die
Stärkeprüfung aus.** Das ist kein Komfortschalter, sondern ein Notausgang für
den Fall, dass ein Passwort von außen vorgegeben ist und sich wirklich nicht
ändern lässt. Wer ihn benutzt, verschiebt nichts auf später: die
Datenbankschlüssel haben keinen Arbeitsfaktor, der eine schwache Wahl
abfedert. Ab diesem Moment sind jede Nachricht, jeder Name und jede
E-Mail-Adresse aller Beteiligten genau so gut geschützt wie dieses eine
Passwort — nicht besser. Und man merkt es nie: der Server läuft unverändert
weiter, es sieht nichts kaputt aus. Beim Anlegen erscheint eine Warnung, danach
nie wieder.

**`passwort-neu` rechnet die Datenbank nicht um.** Neu verschlüsselt wird allein
`secrets.enc`. Konten, Nachrichten, Namen und Suchindex bleiben unter dem alten
Schlüssel liegen und sind danach unlesbar — der Befehl sagt das vorher und lässt
sich den Satz `ALLE KONTEN VERLIEREN` abtippen, bevor er etwas anfasst. Sinnvoll
auf einer frischen Installation; sonst nur, wenn der Verlust gewollt ist.

### Was das schützt — und was nicht

Geschützt: gestohlene Backups, kopierte Festplatten, versehentlich geteilte
`data/`-Verzeichnisse, Kolleg:innen mit Leserechten auf dem Server.

Nicht geschützt: wer Code **als der Serverbenutzer** ausführen kann. Der Server
muss Nachrichten im Klartext an das Übersetzungsmodell schicken, hat sie also
zur Laufzeit im Speicher. Das ist keine Nachlässigkeit, sondern liegt in der
Natur einer Anwendung, die Inhalte übersetzt.

### Keine Ende-zu-Ende-Verschlüsselung

Bewusst nicht. Bei echtem E2EE könnte der Server die Nachrichten nicht lesen —
und damit fielen Übersetzung, KI-Assistent, Volltextsuche, Transkription und
Zusammenfassungen weg. Das ist praktisch der gesamte Zweck dieser Anwendung.

Wer beides braucht, müsste einzelne Unterhaltungen als „vertraulich" markieren
und dort auf all das verzichten. Siehe `docs/ende-zu-ende.md`.

### Sonstiges

Nutzertext wird nie als HTML gerendert — der Markdown-Renderer erzeugt
React-Elemente. Link-Vorschauen prüfen per DNS, dass das Ziel nicht im internen
Netz liegt. Im Renderer sind `contextIsolation` an und `nodeIntegration` aus.

---

## KI einrichten

Schlüssel holen: <https://console.groq.com/keys>, dann entweder in der App
unter **Einstellungen → Schlüssel → Sprachmodelle** eintragen — das ist der
kürzere Weg, gilt sofort und braucht keine SSH-Sitzung — oder auf dem Server:

```bash
npm run secret -w @stellium/server -- setzen groq
```

Beide Wege legen denselben verschlüsselten Wert im Tresor ab. Steht
`GROQ_API_KEY` in der `.env`, gewinnt die Umgebung; die Einstellungen sagen das
dann auch, statt den Eintrag stillschweigend wirkungslos zu lassen.

**Die Modelle sucht der Server sich selbst.** Beim Start fragt er Groqs Liste
ab, sortiert alles aus, was keine Chat-Anfragen beantwortet (Whisper, TTS,
Guard-Klassifikatoren, zu kleines Kontextfenster) und wählt das größte
brauchbare Modell zum Übersetzen sowie ein kleines für Antwortvorschläge. Alle
sechs Stunden sieht er nach, ob es etwas Neues gibt. Fällt ein Modell im
Betrieb aus, holt er die Liste nach und wechselt.

Welche Modelle laufen, steht im Server-Log und in den Einstellungen unter
*KI-Modell*, wo die Team-Leitung sie auch festlegen kann.

**Andere Anbieter:** `AI_PROVIDER=deepl` (beste reine Übersetzung, keine
KI-Funktionen), `libre` (LibreTranslate, selbst gehostet — Texte verlassen das
Haus nicht), `openai`. Ohne Schlüssel startet die App mit einem
Demo-Provider, der nur markiert, wo eine Übersetzung erschiene.

---

## Tastenkürzel

| Kürzel | Funktion |
|---|---|
| `⌘K` / `Strg+K` | Schnellsuche |
| `⌘F` / `Strg+F` | Nachrichten durchsuchen |
| `⌘,` / `Strg+,` | Einstellungen |
| `⌘⇧N` | Neuer Kanal |
| `⌘⇧T` | Aufgaben |
| `⌘⇧E` | Kalender |
| `⌘⇧D` | Dateien |
| `⌘⇧I` | Ideenboard |
| `⌘⇧U` | Was habe ich verpasst? |
| `Enter` | Senden · `Shift+Enter` neue Zeile |
| `@` / `#` | Person bzw. Kanal vervollständigen |
| `Esc` | Overlay oder Thread schließen |

---

## Bauen

```bash
npm run build              # alles kompilieren

npm run dist:mac           # arm64: .dmg und .zip
npm run dist:mac:universal # Intel + Apple Silicon in einem Paket
npm run dist:win           # NSIS-Installer für x64 und arm64
npm run dist:linux         # AppImage und .deb für x64 und arm64
```

Windows-Installer lassen sich auch auf macOS bauen — electron-builder bringt
sein eigenes Wine mit. Für `.rpm` braucht es zusätzlich `brew install rpm`.

Kein Paket ist signiert. Für die Verteilung außerhalb des eigenen Teams
solltest du signieren: macOS mit Entwicklerzertifikat und Notarisierung,
Windows mit Code-Signing-Zertifikat.

---

## Tests

```bash
npm run e2e            # 29 Prüfungen des Chat-Kerns
node scripts/e2e-sicherheit.mjs   #  8 Prüfungen der Zugangsregeln
node scripts/e2e-neu.mjs          # 22 Prüfungen: Einführung, Aufgaben, Kalender, Dateien, Ideen
node scripts/e2e-grenzfaelle.mjs  # 14 Grenzfälle
node scripts/e2e-update.mjs       #  8 Prüfungen der Versionsverteilung
node scripts/e2e-sprache.mjs      #  2 Prüfungen der Systemsprache
node scripts/e2e-admin.mjs <einmal-passwort> [benutzername]  # 9 Prüfungen der Kontoverwaltung
```

**106 Prüfungen** insgesamt. Ein echter Chromium klickt sich durch: Anmeldung,
Layout, Senden, Reaktionen, Erwähnungen, Antwortvorschläge, Umformulieren,
Live-Übersetzung, Umfragen, Suche, Profilkarten, Weiterleiten, Erinnerungen,
Threads, Einstellungen, Modellwahl, Themawechsel, Aufgabenbrett, Kalender,
Dateiablage, Ideenboard und die geführte Einführung.

Die Grenzfälle prüfen, was im Alltag schiefgeht: falsches Passwort, zweimal
anmelden, zwei Fenster gleichzeitig, Netzausfall mit Wiederverbinden,
ungültiger Token, leere und sehr lange Eingaben, Sonderzeichen und
`<script>`-Versuche, ein Kanal der gelöscht wird während jemand darin sitzt,
hastiges Mehrfachklicken beim Abstimmen, Termine über Mitternacht.

Die Sicherheitsprüfungen legen eine zweite Person an, die in nichts drin ist,
und versuchen mit ihr, was ihr nicht zusteht: eine Nachricht aus einem privaten
Kanal übersetzen lassen, deren Thread öffnen, sie merken, den Kanal betreten,
eine Datei ohne Nachweis laden, Passwörter durchprobieren, eine neue
App-Version veröffentlichen. Jeder dieser Wege muss verschlossen sein.

Fehlschläge landen als Screenshot in `scripts/screenshots/`. Die Suiten legen
sich ihre Testdaten selbst an — es gibt keine Demo-Konten.

---

## Architektur

```
packages/
├── shared/    Typen, WebSocket-Protokoll, Spracherkennung, Maskierung, Rechte
├── server/    Fastify, SQLite über node:sqlite, Übersetzung, KI, Realtime
└── desktop/   Electron + React + Vite + Zustand + Framer Motion
```

**Wie eine Nachricht ihren Weg nimmt**

1. Die Ausgangssprache wird lokal erkannt — Stoppwörter, Schriftsystem und im
   Deutschen die Großschreibung der Substantive. Bei Unsicherheit bleibt sie
   offen und das Modell entscheidet später
2. Der Server speichert **immer das Original** und verteilt es sofort. Niemand
   wartet auf die Übersetzung
3. Er sammelt die Zielsprachen aller Empfänger und übersetzt **einmal pro
   Sprache**, nicht einmal pro Person
4. Fertige Übersetzungen kommen als eigenes Ereignis nach, die Oberfläche
   tauscht den Text weich aus
5. Alles landet im Cache

**Datenhaltung.** Eine SQLite-Datei unter `packages/server/data/`. Kein
natives Modul nötig — `node:sqlite` ist in Node eingebaut, inklusive
FTS5-Volltextsuche.

---

## Server betreiben

```bash
npm run build
cd packages/server
STELLIUM_MASTER_PASSPHRASE=… PORT=8787 npm start
```

In der App unter *Einstellungen → Server* die Adresse eintragen. Für den
Zugriff von außen einen Reverse Proxy mit TLS davorsetzen und das
WebSocket-Upgrade auf `/ws` durchreichen.

## Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `8787` | Server-Port |
| `DATA_DIR` | `packages/server/data` | Datenbank, Uploads, Tresor. Die Vorgabe hängt am Serverpaket, nicht am Arbeitsverzeichnis; ein gesetzter Pfad gilt relativ zum Startverzeichnis |
| `OWNER_HANDLE` | Systembenutzer | Erstes Konto beim Erststart |
| `OWNER_NAME` | daraus abgeleitet | Anzeigename dazu |
| `AI_PROVIDER` | `groq` | `groq` · `openai` · `deepl` · `libre` · `demo` |
| `GROQ_MODEL` | leer | Leer = der Server wählt selbst |
| `STELLIUM_MASTER_PASSPHRASE` | Keychain | Masterpasswort für den Tresor |
| `STELLIUM_SCHLUESSELWECHSEL` | leer | `ja` lässt den Server trotz gewechseltem Masterpasswort starten — die alten Konten und Nachrichten bleiben dann unlesbar |
| `STELLIUM_SCHWACHES_MASTERPASSWORT` | leer | `ja-ich-weiss-was-ich-tue` lässt ein Masterpasswort zu, das die Stärkeprüfung nicht besteht. Notausgang, kein Komfortschalter — siehe [Das Masterpasswort](#das-masterpasswort) |
| `MAX_UPLOAD_MB` | `50` | Maximale Dateigröße |
| `STORAGE_QUOTA_GB` | `20` | Kontingent der Dateiablage |
| `STORAGE_DIR` | `DATA_DIR/storage` | Ablageordner |
| `RELEASE_DIR` | `DATA_DIR/releases` | Hochgeladene App-Versionen |

Die üblichen Werte stehen in `.env.example`. Die `STELLIUM_*`-Zeilen fehlen dort
mit Absicht: das Masterpasswort gehört nicht in eine Datei neben die Daten, und
die beiden Notausgänge gehören in keine Vorlage.

---

## Noch nicht fertig

Ehrlich benannt statt versteckt:

- **RPM-Paket** — `rpmbuild` läuft auf macOS nicht verlässlich für Linux-Ziele.
  Fedora, RHEL und openSUSE nutzen bis auf Weiteres das AppImage
- **Code-Signatur** für macOS und Windows. Ohne sie meldet sich beim ersten
  Start die Gatekeeper- beziehungsweise SmartScreen-Warnung
- **Ende-zu-Ende-Verschlüsselung** — siehe `docs/ende-zu-ende.md`. Sie ist mit
  serverseitiger Übersetzung nicht vereinbar; die Gründe stehen dort
- **Weitere Oberflächensprachen** — Deutsch und Englisch sind vollständig,
  alles Weitere fällt auf Englisch zurück
