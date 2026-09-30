# Stellium Fernsteuerung

Ersatz für TeamViewer auf dem Pi: Bild in Echtzeit zum Mac, Eingaben zurück,
Zwischenablage in beide Richtungen, Anmeldung über ID und Passwort. **Mehrere
können gleichzeitig zusehen, einer steuert** — siehe „Mehrere Zuschauer" unten.

**Stand: 20.08.2026 — vollständig, vom Mac aus durchs Internet erprobt.**

    Verbindung steht nach          480 ms
    Pi hat sich ausgewiesen        ✓
    Sitzung offen nach            1208 ms
    erstes Bild nach              2119 ms
    131 Bilder · 14,7 je Sekunde · 1919 kbit/s · verworfen 0

`verworfen 0` ist die wichtigste Zahl: die Leitung Deutschland–Alaska ist
nicht der Engpass. Die 14,7 Bilder/s sind genau das, was der Abgriff auf dem
Pi hergibt.

## Warum überhaupt selbst gebaut

Auf demselben Pi, im selben Ruhezustand gemessen:

| | Speicher | CPU im Leerlauf |
|---|---|---|
| TeamViewer (`teamviewerd` + `TeamViewer_Desktop`) | **815 MB** | rechnet durchgehend |
| `stellium-fern` | **33,8 MB** | **2,5 %** |

## Was gemessen wurde, bevor etwas entstand

Der **Pi 5 hat keinen Hardware-Kodierer für H.264**. Nachgesehen, nicht
vermutet: unter `/dev/video*` liegen `rpi-hevc-dec` (ein *De*kodierer) und
16× `pispbe` (Kamera-Pipeline). Die Zeile `h264_v4l2m2m` in ffmpeg ist eine
leere Hülle ohne Gerät. Also x264 in Software — reicht: 1080p mit 34 Bildern/s
bei 1,2 von 4 Kernen.

Die drei Stufen je Bild in 1920×1080:

    rücklesen   32 ms   (Minimum. Wächst genau mit der Fläche — bei 960×540
                         sind es 8 ms. Das sind ~260 MB/s aus dem Grafik-
                         speicher: eine Eigenschaft des Geräts, nicht des
                         Programms. labwc rendert über /dev/dri/card1.)
    Farbe        8 ms
    kodieren    20 ms

Nacheinander 60 ms. Auf zwei Fäden max(32, 28) = 32 ms.

### Was nichts gebracht hat — und warum es hier steht

**Mehrere Abgriffe gleichzeitig anfordern.** Naheliegend, denn ein Abgriff
besteht aus zwei ganz verschiedenen Wartezeiten (auf den nächsten Zeichen-
vorgang, dann auf das Rücklesen). Gemessen: 13,0 → 13,0 Bilder/s. Der
Compositor arbeitet die Anforderungen ohnehin nacheinander ab und reiht sie
nur ein. Steht als `--auftraege` noch drin, Vorgabe 1.

Gemessene Stellschrauben bei 1280×720:

| Aufträge | Kodier-Fäden | Bilder/s |
|---|---|---|
| 1 | 1 | 12,6 |
| 1 | 2 | 14,8 |
| **1** | **3** | **20,3** ← Vorgabe |
| 2 | 2 | 18,5 |
| 2 | 3 | 17,9 |

### Die wichtigste Messung

Mit angehaltenem Dashboard fällt der Abgriff auf **1,0 Bilder/s**. Das ist
kein Fehler, sondern der Beweis, dass `copy_with_damage` tut, was es soll:
**ein ruhiger Schirm kostet nichts.** Die Bildrate wird nicht vom Programm
begrenzt, sondern davon, wie oft sich der Schirm überhaupt ändert — derzeit
durch die Dashboard-Animation mit ~24 Bildern/s.

**Daraus folgt eine offene Aufgabe:** Während einer Fernsitzung ist diese
Animation reine Last. Sie zu drosseln gehört in `konsole-gui/konsole.py`
(dort liegen noch nicht committete Änderungen vom Gestaltungs-Agenten).

### Die zweitwichtigste Messung: eine lange Leitung ist kein Stau

Über 236 ms Laufzeit (Deutschland → Alaska) drosselte die Regelung dauerhaft
auf 2531–3375 kbit/s, obwohl der Kern gleichzeitig `delivery_rate 4,4 Mbit/s`
meldete **und** `app_limited` setzte — er wartete auf Daten. Die Regel bremste
also nicht die Leitung aus, sondern sich selbst.

Der Grund war eine feste Byte-Grenze (`96 KB`). Für 6 Mbit/s müssen bei
236 ms rund 176 KB dauerhaft unterwegs sein; das ist die Strecke, kein
Rückstand. Wer diese Füllung für Überlastung hält, deckelt den Durchsatz auf

    96 KB × 8 / 0,236 s ≈ 3,3 Mbit/s

und zwar unabhängig davon, was die Leitung könnte. Auf dem Schreibtisch
nebenan fiel das nie auf: dort ist die Laufzeit unter einer Millisekunde und
die Rohrfüllung praktisch null.

Jetzt wird `Rate × Laufzeit` abgezogen und nur der Rest als Stau gewertet.
Zwei Fallen dabei, beide gemessen:

1. **Mit der Zielrate rechnen ist falsch.** Ein ruhiger Schirm braucht die
   Zielrate gar nicht aus — Ziel 6000, tatsächlich 2900. Rechnet man das Rohr
   mit 6000, erscheint es größer als es ist, echter Rückstand bleibt
   unsichtbar und wächst unbemerkt auf über 300 KB. Es zählt der kleinere von
   Ziel und gemessenem Durchsatz.
2. **Sich in 8-%-Schritten hochtasten dauert zu lang.** Von 2500 auf
   6000 kbit/s sind das elf Schritte, also gut zwanzig Sekunden weiches Bild
   nach jeder Störung. Der Kern kennt den tragfähigen Wert bereits.

Gemessen, jeweils 33 Sekunden über die echte Leitung:

    vorher                  1,79 Mbit/s   27,2 B/s   Stau 23–61 KB
    nur Grenze umgestellt   2,42 Mbit/s   24,5 B/s   Stau 128–334 KB, wachsend
    mit Rohr-Korrektur      2,60 Mbit/s   26,1 B/s   Stau 75–127 KB, stabil

**+45 % Bitrate bei gleicher Bildrate**, ohne dass die Verzögerung wegläuft.

### Die Größe des Pi-Schirms selbst

Der Headless-Ausgang stand auf **1920x917** — daher das leicht gedehnt
wirkende Bild (Seitenverhältnis 2,09 statt 1,78). Konfiguriert war das
nirgends: `~/.config/kanshi/config` war **0 Bytes**, und daneben lag ein
`config.init` mit genau der richtigen Zeile. Irgendwann wurde die aktive
Datei geleert, und der Ausgang fiel auf seine Vorgabe zurück.

    profile {
            output NOOP-1 enable scale 1.000000 mode 1920x1080@0.000 position 0,0 transform normal
    }

Wichtig beim Nachstellen: **keine eigene `~/.config/labwc/autostart`
anlegen.** Die systemweite unter `/etc/xdg/labwc/autostart` startet Panel,
Dateimanager und kanshi; eine Benutzerdatei ersetzt sie, statt sie zu
ergänzen — der Schreibtisch käme ohne Panel hoch.

Die Größe wird beim **Sitzungsbeginn** festgelegt, nicht beim Bildabgriff.
Nach einer Änderung muss man einmal trennen und neu verbinden, sonst läuft
der Abgriff mit der alten Größe weiter.

### Drei Nachbesserungen an der Regelung

Die Zeit-statt-Bytes-Rechnung war richtig, hatte aber drei Lücken, die alle in
dieselbe Richtung wirkten: zu großzügig.

**1. `minrtt` statt `rtt`.** Die aktuelle Laufzeit ist durch Warteschlangen
bereits verlängert. Damit verstärkte sich der Fehler selbst: mehr Stau →
höhere gemessene Laufzeit → größer gerechnete Rohrfüllung → echter Stau wird
unsichtbar → **hoch**regeln → noch mehr Stau. Das ist schlimmer als eine
verpasste Korrektur; es ist eine aktiv falsche. `minrtt` ist die kürzeste je
gesehene Laufzeit, also die Strecke ohne Warteschlange — genau das, was die
Rohrfüllung meint. Gemessen: `rtt` 236,0 ms, `minrtt` 224,5 ms; unter Last
laufen die beiden weit auseinander.

**2. Messwerte verfallen.** `leitungMessen` startet `ss` nebenläufig, und
`stauMasse` liest direkt danach immer die Werte des vorigen Laufs — jede
Entscheidung ist strukturell knapp zwei Sekunden alt. Schlug `ss` fehl,
blieben die alten Werte **unbegrenzt** stehen, ohne dass etwas sie als
veraltet kennzeichnete. Nach sechs Sekunden zählen sie jetzt nicht mehr; dann
gilt wieder die strenge Rechnung ohne Rohrfüllung.

**3. Der Rückstand wird auf Wachstum geprüft.** Das ist die ehrlichste Zahl
im ganzen Programm: `sendestau` liest sie ohnehin alle 200 ms direkt aus dem
Kern, ohne jede Schätzung. Ob sie **steigt**, beantwortet unmittelbar, ob
mehr hineinläuft als hinaus — dafür braucht es keine Ahnung von der Rohrgröße
und keine Laufzeitmessung. Sie dient als zweiter, schnellerer Weg nach unten,
neben `stau > erlaubt`. Und ausdrücklich auch im Bildpfad: dort entschied
dieselbe, gleich alte Rechnung übers Verwerfen, sodass bei einer schnellen
Verschlechterung Ratenregelung und letzte Verteidigungslinie **gleichzeitig**
ausfielen.

Gemessen nach dem Umbau, 33 Sekunden über die echte Leitung, bei 1920x1080:

    Pi erzeugt        44,3-45,4 B/s   (Abgriff 21,6-22,3 ms)
    kommt an          37,1 B/s
    unterwegs         33-68 KB        (vorher in einer Messung 316 KB)
    verworfen         0

Der Abgriff liegt damit bei rechnerisch 45,9 Bildern je Sekunde. Was beim
Betrachter fehlt, fehlt an der Leitung, nicht am Pi.

## Was drinsteckt

    host/fern-host.c      Abgriff (zwlr_screencopy v3) + x264, zwei Fäden
    host/eingabe.c/.h     Zeiger, Tastatur, Zwischenablage
    host/protokolle/      die vier Wayland-Protokolle als XML
    host/Makefile         wayland-scanner erzeugt den Rest beim Bauen
    dienst/anmeldung.mjs  ID, Passwort, Handschlag, Verschlüsselung

labwc 0.9.8 bietet alles Nötige an (mit einem eigenen Programm abgefragt,
nicht geraten): `zwlr_screencopy_manager_v1` v3, `zwlr_virtual_pointer_-
manager_v1` v2, `zwp_virtual_keyboard_manager_v1` v1, `zwlr_data_control_-
manager_v1` v2.

### Zwei Fallen, die Zeit gekostet haben

1. **`linux_dmabuf` darf im Hörer nicht `NULL` sein.** libwayland bricht das
   Programm ab, sobald ein Ereignis kommt, dessen Eintrag fehlt — und labwc
   schickt es bei *jedem* Bild. Fehlermeldung: `listener function for opcode 5
   of zwlr_screencopy_frame_v1 is NULL`.

2. **Puffer-Auswahl.** Der erste Entwurf nahm den ersten Puffer, an dem der
   Kodierer nicht arbeitet — oft einen, in dem noch ein ungelesenes Bild lag,
   während daneben ein leerer stand. 21–32 grundlos verworfene Bilder je zwei
   Sekunden, rund die halbe Ausbeute.

## Nachgewiesen

- Bild: gültiges H.264, 1920×1080, yuv420p (mit `ffprobe` geprüft)
- Zeiger: bewegt sich (Schirmbilder vorher/nachher unterschiedlich)
- Zwischenablage Mac → Pi: `wl-paste` liefert exakt den gesendeten Text
- Zwischenablage Pi → Mac: `wl-copy` auf dem Pi kommt als Rahmen an
- Tastatur: wird vom Compositor angenommen, ohne Warnung. **Dass Tasten in
  einem Programm ankommen, ist noch nicht gezeigt** — dafür braucht es ein
  Fenster mit Fokus und jemanden, der zusieht.

## Mehrere Zuschauer

**Stand: 30.09.2026.** Bis dahin durfte immer nur einer zusehen, und das war
nicht bloß eine Einschränkung, sondern ein Fehler: Dons Kollege bekam beim
Verbinden dauernd „Es ist schon jemand verbunden" zu sehen, obwohl niemand
zusah.

Zwei Dinge steckten dahinter, und das zweite ist das eigentliche.

**1. Ein Zuschauer war Absicht.** Die Begründung war richtig: ein zweiter
Abgriff halbiert auf vier Kernen die Bildrate, und zwei Leute, die gleichzeitig
die Maus bewegen, sind unbrauchbar. Sie begründet aber nur, dass es **einen
Abgriff** und **eine Maus** geben darf — nicht, dass nur einer zusehen kann.
Das Bild wird jetzt einmal erzeugt und an alle verteilt; Tastatur und Maus
gehören dem, der als Letzter etwas eingegeben hat.

**2. Niemand merkte, wenn ein Zuschauer verschwand.** Eine Verbindung, die
nicht ordentlich auflegt — Deckel zu, WLAN gewechselt, App abgeschossen,
Weiterleitung im Router abgelaufen —, schickt kein `close`. Ohne Nachfrage
blieb sie dem Pi als Zuschauer erhalten, bis TCP von selbst aufgab: über eine
Viertelstunde, und auch das nur, solange überhaupt gesendet wurde. In dieser
Zeit war der einzige Platz besetzt, und die App sagte die Wahrheit, nur eine
unbrauchbare. Deshalb fragt der Dienst jetzt alle zehn Sekunden per `ping`
nach; wer zweimal nicht antwortet, ist weg. `pong` beantwortet jede
Gegenstelle von sich aus — dafür brauchte keine App eine neue Fassung.

    Zuschauer                      bis zu 4   (FERN_ZUSCHAUER)
    Lebenszeichen                  alle 10 s  (FERN_PING_MS)
    Geisterverbindung erkannt nach      20 s  (vorher: > 15 min)
    Steuerung frei nach Ruhe            15 s  (FERN_STEUER_RUHE)

### Was geteilt wird und was nicht

| | |
|---|---|
| Bild | an alle. Ein Abgriff, ein Kodierer — mehrere Zuschauer kosten Leitung, keine Rechenzeit. |
| Bitrate | eine für alle, und es gilt die **kleinste** gewünschte. Ein Bild, das für den Langsamsten zu groß ist, erreicht ihn gar nicht; dem Schnellen kostet dieselbe Entscheidung nur Schärfe. |
| Verworfene Bilder | je Zuschauer. Der Rückstand ist eine Eigenschaft seiner Leitung, nicht des Bildes — wer nicht nachkommt, verliert einzelne Bilder, ohne dass die anderen etwas merken. |
| Zwischenablage Pi → alle | an alle, sie ist Teil dessen, was man sieht. |
| Zwischenablage → Pi | nur vom Steuernden. Die App schickt ihre Ablage von selbst, zweimal je Sekunde; vier Zuschauer würden die des Pi sonst im Sekundentakt gegenseitig überschreiben. |
| Tastatur und Maus | nur vom Steuernden. |

### Wer steuert

Wer als Erster etwas eingibt oder in der App „Steuerung an" drückt. Kommt von
dort 15 Sekunden nichts, darf der Nächste übernehmen — ohne diese Frist wäre
die Maus weg, sobald einer sie angefasst hat und dann Mittag macht.

Kein Verhandeln, keine Warteschlange, keine Rechte: wer das Passwort hat, ist
gleichberechtigt. Die Frage „darf der das?" ist beim Passwort entschieden.

Im Dashboard steht weiter der Name dessen, der am längsten dabei ist, dazu
„und N weitere". In der App zeigt eine Zeile in der Werkzeugleiste, wie viele
zusehen, und der Knopf, wer gerade steuert.

### Ein Zuschauer, der dazukommt, wartete auf ein Bild

Ein Zwischenbild ohne seinen Bezug ergibt nur Grün und Schlieren; die App
wartet deshalb zu Recht auf ein vollständiges. Von allein kommt eins erst nach
`i_keyint_max` — bei 45 Bildern vier Sekunden —, und so lange sah der
Dazugekommene ein schwarzes Fenster und hielt es für einen Fehler. `fern-host`
kennt dafür jetzt den Befehl `s`: nächstes Bild bitte vollständig. Ein älterer
Abgreifer überliest ihn stillschweigend, dann bleibt es bei der Wartezeit von
vorher.

### Nachgewiesen

`node scripts/fern-mehrere-pruefen.mjs` — gegen den echten Dienst, mit einem
nachgemachten Abgreifer (ein Compositor ist auf dem Mac nicht zu haben). Kein
Pi nötig, kein Netz, keine 30 Sekunden.

    drei verbinden gleichzeitig      alle offen, genau EIN Abgriff
    der vierte                       4010, die anderen merken nichts
    Eingabe des Zuschauers           kommt nicht durch
    Ablage des Zuschauers            kommt nicht durch
    Übergabe nach Abgeben            sofort
    Übergabe nach Ruhefrist          ohne Zutun des Vorgängers
    stiller Zuschauer                bleibt verbunden (ping wird beantwortet)
    Kabel gezogen                    Platz nach 2 Fristen frei
    letzter geht                      Abgriff endet
    nächster kommt                   Abgriff startet neu

Die Zeile „stiller Zuschauer" prüft dabei die Annahme, auf der die ganze
Erkennung beruht: dass das **eingebaute** WebSocket von Node — dasselbe, das
electron/fernsteuerung.ts benutzt — `ping` von selbst beantwortet. Täte es das
nicht, flöge in der Praxis jeder hinaus, der nur zusieht.

## Wie man es benutzt

Auf dem Pi läuft `stellium-fern.service` dauerhaft. Sie kostet nichts, solange
niemand zusieht: der Abgreifer wird **erst beim Verbinden gestartet** und beim
Trennen wieder beendet.

    sudo stellium-fern-passwort          zeigt die ID
    sudo stellium-fern-passwort --neu    würfelt ein neues Passwort
    sudo stellium-fern-passwort --setzen <wort>

**ID und Passwort bleiben dauerhaft.** Sie liegen auf der Platte und ändern
sich nur, wenn man sie ausdrücklich neu setzt — anders als bei TeamViewer, das
je Sitzung würfelt. Das ist Absicht: Don hat keinen Zugang zum Bildschirm des
Pi und könnte ein gewürfeltes Passwort gar nicht ablesen.

In der Mac-App: der Bildschirm in der linken Leiste. Adresse und Passwort
eintragen, verbinden. „Steuerung an" gibt Tastatur und Maus weiter; ohne sie
sieht man nur zu. Die Zwischenablage läuft in beide Richtungen mit. Steuert
schon jemand, steht dessen Name auf dem Knopf — ein Druck darauf übernimmt,
sobald der andere sie freigibt (siehe „Mehrere Zuschauer").

Im Dashboard des Pi steht unten in der Fernzugriffs-Karte eine Zeile
`Bildschirm · <Konto> · verbunden seit HH:MM`, bei mehreren Zuschauern
`Bildschirm · <Konto> und 2 weitere · seit HH:MM` — **dass** und **wer**, nie
**was**. Genannt wird der, der am längsten dabei ist; alle Namen aufzuzählen
würde die Zeile sprengen und aus der Karte ein Verzeichnis machen. Der Name ist eine Behauptung der Gegenstelle, keine geprüfte
Identität: angemeldet wird sich allein über das gemeinsame Passwort, wer es
kennt, kann jeden Namen eintragen. Er kommt erst über die verschlüsselte
Leitung, nie im Klartext-Handschlag davor. Ältere App-Fassungen kennen das
Feld nicht — dann steht dort „unbekannt" statt eines Namens, und der
Handschlag selbst bleibt unverändert möglich.

## Wie es hinausgeht

Port **7788**, freigegeben über NAT-PMP. In der Firewall des Pi eigens erlaubt
(`ufw allow 7788/tcp`) — ohne das ging nichts durch, obwohl der Router
weiterleitete und der Dienst lauschte.

Die Freigabe im Router gilt **nur auf Zeit** (3600 s). Läuft sie ab, ist der
Port zu und die App meldet „Keine Antwort — ist die Adresse richtig?", obwohl
am Pi alles in Ordnung aussieht: Dienst aktiv, `ufw` offen, `ss` zeigt den
Lauscher. Der Unterschied ist nur von außen sichtbar:

    nc -z <öffentliche IP> 7788

Hier stand früher, 7788 sei „in `stellium-zugang` aufgenommen, also stündlich
erneuert". Das stimmte nie — `stellium-zugang` erneuert HTTP, HTTPS und SSH,
sonst nichts. Deshalb blieb SSH erreichbar, während die Fernsteuerung nach
einer Stunde still wegfiel. Die ungeprüfte Zeile war das eigentliche Problem:
sie sah aus wie eine Zusage und war keine.

Zuständig ist jetzt `stellium-fern-port.timer` (siehe `einheiten/`), alle
20 Minuten — dreifacher Abstand zur Frist, damit ein ausgefallener Lauf
nichts ausmacht.

Kein TLS davor, und das ist kein Versäumnis: Handschlag und Strom sind
Ende-zu-Ende verschlüsselt (ECDH P-256 + scrypt, AES-256-GCM). Eine zweite
Schicht darüber brächte nichts als Verzögerung — und Verzögerung ist bei
Fernsteuerung das Einzige, was wirklich weh tut.

## Noch offen

1. Dashboard-Animation während einer Sitzung drosseln. Sie ist der Grund, warum
   der Schirm sich überhaupt 24-mal je Sekunde ändert — während man fernsteuert
   ist das reine Last.
2. `teamviewerd` läuft weiter. Es ist der Rückweg auf eine Maschine in Alaska,
   an die niemand hinfahren kann. Es fliegt raus, wenn Don das hier eine Weile
   im Alltag benutzt hat — nicht vorher.
3. Die Mac-Ansicht ist gebaut und typgeprüft, aber noch nicht von Hand bedient
   worden. Bewiesen sind: Handschlag, Bildstrom, Eingabe, Zwischenablage
   (jeweils über die echte Leitung) und die Dekodierung im Browser —
   **108 von 108 Bildern, 0 Fehler, 128 Bilder/s Dekodierleistung**.

## Bauen

    ssh stellium
    cd ~/fern-bau/host && make

Braucht: `build-essential pkg-config libwayland-dev wayland-protocols
libx264-dev libswscale-dev libavutil-dev libxkbcommon-dev wl-clipboard`
(alle bereits installiert).

## Von Hand ausprobieren

    export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0
    ./fern-host --bilder 30 --ausgabe 1280x720 | python3 entrahmen.py /tmp/x.h264

Befehle gehen zeilenweise auf stdin:

    z <x> <y>            Zeiger, 0..65535 (absolut, damit sich nichts aufsummiert)
    t <knopf> <0|1>      Maustaste (272 = links)
    r <achse> <wert>     Rollen
    k <code> <0|1>       Taste (evdev-Code, KEY_A = 30)
    m <d> <l> <s> <g>    Umschalter
    a <base64>           Zwischenablage setzen
    b <kbit>             Bitrate im Betrieb ändern
    s                    nächstes Bild vollständig (für Dazukommende)

Heraus kommen Rahmen: `[Art:1][Länge:4 LE][Inhalt]`, Art 1 = H.264,
2 = Zwischenablage, 3 = Meldung.
