#!/usr/bin/env bash
# Legt die grafische Konsole an: als Fenster zum Öffnen und als lebenden
# Schreibtischgrund, der mit dem Rechner startet.
#
# Der Hintergrundbetrieb braucht Hilfe vom Fenstermanager — ein Programm kann
# nicht selbst bestimmen, wie tief es liegt. Unter labwc (so läuft es auf dem
# Pi) geschieht das über eine Fensterregel in /etc/xdg/labwc/rc.xml; sie wird
# hier eingetragen, und daneben liegt eine Sicherung des Urzustands.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIEL=/usr/local/lib/stellium

python3 -c "import tkinter" 2>/dev/null || { apt-get update -qq; apt-get install -y python3-tk; }

echo "→ Dateien"
install -d -m 755 "$ZIEL"
install -m 755 "$HIER/konsole.py" "$ZIEL/konsole-gui.py"

# Die Mitschrift des Fernzugriffs steht unten in der Konsole. Liegt sie noch
# nicht am Platz, aber im Quelltext nebenan, kommt sie gleich mit — sonst
# bliebe der Bereich leer, obwohl alles da wäre.
if [ ! -f "$ZIEL/ssh-wache.py" ] && [ -f "$HIER/../ssh-wache/wache.py" ]; then
  install -m 755 "$HIER/../ssh-wache/wache.py" "$ZIEL/ssh-wache.py"
  echo "  Mitschrift des Fernzugriffs mitinstalliert"
fi

cat > /usr/local/bin/stellium-konsole-gui <<'ENDE'
#!/bin/bash
exec /usr/bin/python3 /usr/local/lib/stellium/konsole-gui.py "$@"
ENDE
chmod 755 /usr/local/bin/stellium-konsole-gui

# Hält den Hintergrund am Leben: stürzt er ab, kommt er nach drei Sekunden
# wieder. Ein Schreibtischgrund, der einmal verschwindet und dann wegbleibt,
# fällt erst auf, wenn man ihn braucht.
cat > /usr/local/bin/stellium-konsole-hintergrund <<'ENDE'
#!/bin/bash
# Nur einer. Startet der Schreibtisch den Hintergrund und ruft ihn jemand
# zusätzlich von Hand auf, entstünden sonst zwei übereinander — man sähe es
# kaum und wunderte sich nur über die Last.
if pgrep -f "^/usr/bin/python3 /usr/local/lib/stellium/konsole-gui.py --hintergrund" >/dev/null; then
  exit 0
fi

# Ein Absturz nach Stunden ist etwas anderes als einer nach einer halben
# Sekunde. Das erste ist ein Aussetzer und gehört sofort behoben; das zweite
# heißt fast immer, dass gar keine Anzeige da ist — dann startet hier sonst
# alle drei Sekunden für immer ein Python, das nur wieder aufgibt. Auf einem
# Pi, der nebenbei den Firmenchat trägt, ist das keine Kleinigkeit, und weil
# alles nach /dev/null geht, sieht es auch niemand.
#
# Deshalb: schnelle Fehlstarts zählen, die Wartezeit verdoppeln und nach zehn
# in Folge aufhören — mit einer Zeile im Journal, die sagt warum.
FEHLSTARTS=0
WARTE=3
while true; do
  BEGINN=$(date +%s)
  /usr/bin/python3 /usr/local/lib/stellium/konsole-gui.py --hintergrund
  DAUER=$(( $(date +%s) - BEGINN ))

  if [ "$DAUER" -ge 60 ]; then
    # Lief lange genug, um echt gewesen zu sein: von vorn zählen.
    FEHLSTARTS=0
    WARTE=3
  else
    FEHLSTARTS=$(( FEHLSTARTS + 1 ))
    if [ "$FEHLSTARTS" -ge 10 ]; then
      logger -t stellium-konsole "Hintergrund gibt auf: zehnmal in Folge sofort beendet (Anzeige da? WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-nicht gesetzt})"
      exit 1
    fi
  fi
  sleep "$WARTE"
  # Erst nach dem Warten verdoppeln, damit der erste Versuch die vollen drei
  # Sekunden behält — und nie über eine Minute hinaus.
  if [ "$FEHLSTARTS" -gt 0 ]; then
    WARTE=$(( WARTE * 2 ))
    [ "$WARTE" -gt 60 ] && WARTE=60
  fi
done
ENDE
chmod 755 /usr/local/bin/stellium-konsole-hintergrund

echo "→ Eintrag im Startmenü"
cat > /usr/share/applications/stellium-konsole.desktop <<'ENDE'
[Desktop Entry]
Type=Application
Name=Stellium Konsole
Comment=Zustand des Stellium-Servers auf einen Blick
Exec=/usr/local/bin/stellium-konsole-gui
Icon=utilities-system-monitor
Terminal=false
Categories=System;Monitor;
StartupNotify=true
ENDE

echo "→ Schreibtischsymbole ausräumen"
# Die Konsole nimmt den ganzen Schreibtisch ein und liegt über dem
# Hintergrundbild — Symbole darauf wären verdeckt und nicht mehr anklickbar.
# Also weg damit: unsere eigenen Verknüpfungen kommen fort, und der
# Dateimanager bekommt gesagt, dass er gar keine Symbole mehr zeichnen soll.
# Gelöscht wird nur, was wir selbst angelegt haben; alles andere bleibt liegen
# und ist über den Dateimanager weiter erreichbar.
for heim in /home/*; do
  [ -d "$heim/Desktop" ] || continue
  rm -f "$heim/Desktop/stellium-konsole.desktop" \
        "$heim/Desktop/stellium-fernzugriff.desktop"
done
for stelle in /home/*/.config/pcmanfm/*/desktop-items-*.conf; do
  [ -f "$stelle" ] || continue
  cp -n "$stelle" "$stelle.vor-stellium"
  # show_documents deckt die Verknüpfungen im Ordner „Desktop" ab, die
  # anderen beiden Papierkorb und eingehängte Datenträger.
  for schalter in show_documents show_trash show_mounts; do
    if grep -q "^$schalter=" "$stelle"; then
      sed -i "s/^$schalter=.*/$schalter=0/" "$stelle"
    else
      sed -i "0,/^\[\*\]/s//[*]\n$schalter=0/" "$stelle"
    fi
  done
  echo "  Symbole abgeschaltet in $stelle"
done

echo "→ Fensterregel für den Hintergrund"
COMPOSITOR="$(ps -eo comm= | grep -Eix "labwc|wayfire|mutter|weston" | head -1 || true)"
case "$COMPOSITOR" in
  labwc|"")
    [ -z "$COMPOSITOR" ] && echo "  (gerade läuft kein Schreibtisch — die Regel wird trotzdem gelegt)"
# "|| true": ohne labwc-Einstellungen beendet sich das Python mit einer
# Meldung — unter set -e brach dann die ganze Einrichtung ab, und der
# Hintergrund wurde nie zum Start eingetragen.
python3 - <<'ENDE' || true
# Trägt Regel und Bereich in die labwc-Einstellungen ein, ohne den Rest
# anzurühren und ohne sich beim zweiten Lauf zu verdoppeln: die eigenen Zeilen
# stehen zwischen Merkzeichen und werden vorher immer erst herausgenommen.
import os
import re
import shutil

PFAD = "/etc/xdg/labwc/rc.xml"

REGION = ('    <region name="stellium-hintergrund"'
          ' x="0%" y="0%" width="100%" height="100%" />')

REGEL = """
    <!-- stellium -->
    <!-- Der lebende Schreibtischgrund: ohne Rahmen, ganz unten, auf allen
         Arbeitsflächen, weder in der Fensterleiste noch im Umschalter — und
         über die ganze nutzbare Fläche.
         Nur dieses eine Fenster heißt so: die kleinen Fenster der Ablage
         gehören zum selben Programm, tragen aber die Klasse
         „stellium-fenster" und bleiben deshalb gewöhnliche Fenster. -->
    <windowRule identifier="stellium-hintergrund" serverDecoration="no" skipTaskbar="yes" skipWindowSwitcher="yes" fixedPosition="yes">
      <action name="ToggleAlwaysOnBottom" />
      <action name="ToggleOmnipresent" />
      <action name="SnapToRegion" region="stellium-hintergrund" />
    </windowRule>
    <!-- /stellium -->"""

BEREICH = """
  <!-- stellium-flaeche -->
  <!-- Prozente der nutzbaren Fläche — die Leiste am oberen Rand ist darin
       schon abgezogen, ihr Platz bleibt also frei. -->
  <regions>
""" + REGION + """
  </regions>
  <!-- /stellium-flaeche -->
"""

if not os.path.exists(PFAD):
    raise SystemExit("  keine labwc-Einstellungen gefunden — Regel nicht eingetragen")
if not os.path.exists(PFAD + ".vor-stellium"):
    shutil.copy2(PFAD, PFAD + ".vor-stellium")

text = open(PFAD).read()
text = re.sub(r"\n *<!-- stellium -->.*?<!-- /stellium -->", "", text, flags=re.S)
text = re.sub(r"\n *<!-- stellium-flaeche -->.*?<!-- /stellium-flaeche -->", "", text, flags=re.S)
text = re.sub(r"\n *<region name=\"stellium-hintergrund\".*?/>", "", text)

if "</windowRules>" in text:
    text = text.replace("  </windowRules>", REGEL + "\n  </windowRules>", 1)
else:
    text = text.replace("</openbox_config>",
                        "  <windowRules>" + REGEL + "\n  </windowRules>\n\n</openbox_config>")

# Zwei <regions>-Blöcke verträgt labwc nicht: gibt es schon einen, wird unser
# Bereich hineingehängt statt danebengestellt.
if "</regions>" in text:
    text = text.replace("  </regions>", REGION + "\n  </regions>", 1)
else:
    text = text.replace("</openbox_config>", BEREICH + "\n</openbox_config>")

open(PFAD, "w").write(text)
print("  Regel eingetragen in " + PFAD + "  (Sicherung: " + PFAD + ".vor-stellium)")
ENDE
    # Läuft labwc schon, soll die Regel sofort gelten.
    pkill -HUP labwc 2>/dev/null || true
    ;;
  *)
    echo "  Hier läuft $COMPOSITOR, nicht labwc."
    echo "  Die Konsole stellt sich dann selbst hin und lässt Leiste und Symbole frei,"
    echo "  liegt aber nicht zwingend hinter allen anderen Fenstern. Bei wayfire gehört"
    echo "  dafür eine Regel auf „stellium-hintergrund“ in ~/.config/wayfire.ini."
    ;;
esac

echo "→ Hintergrund startet mit dem Schreibtisch"
cat > /etc/xdg/autostart/stellium-konsole-hintergrund.desktop <<'ENDE'
[Desktop Entry]
Type=Application
Name=Stellium — Schreibtischgrund
Comment=Die Stellium-Konsole als lebender Hintergrund
Exec=/usr/local/bin/stellium-konsole-hintergrund
Icon=utilities-system-monitor
Terminal=false
X-GNOME-Autostart-enabled=true
ENDE

# Der Wächter im Hintergrund wird nicht mehr gebraucht: dieselbe Mitschrift
# steht jetzt unten in der Konsole, und ein Fenster, das bei jeder Verbindung
# aufspringt, stört nur. Zum Nachlesen gibt es weiter „Fernzugriff-Protokoll"
# im Startmenü.
rm -f /etc/xdg/autostart/stellium-ssh-wache.desktop
for heim in /home/*; do
  rm -f "$heim/.config/autostart/stellium-ssh-wache.desktop" 2>/dev/null || true
done
pkill -f "^/bin/bash /usr/local/bin/stellium-ssh-wache" 2>/dev/null || true
pkill -f "^/usr/bin/python3 /usr/local/lib/stellium/ssh-wache.py" 2>/dev/null || true

# Läuft schon ein Schreibtisch, gleich anfangen — sonst beim nächsten Start.
NUTZER="$(who 2>/dev/null | awk '{print $1; exit}')"
[ -z "$NUTZER" ] && NUTZER="$(logname 2>/dev/null || echo '')"
if [ -n "$NUTZER" ]; then
  pkill -f "^/bin/bash /usr/local/bin/stellium-konsole-hintergrund" 2>/dev/null || true
  pkill -f "^/usr/bin/python3 /usr/local/lib/stellium/konsole-gui.py --hintergrund" 2>/dev/null || true
  su - "$NUTZER" -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) DISPLAY=:0 \
      setsid nohup /usr/local/bin/stellium-konsole-hintergrund >/dev/null 2>&1 < /dev/null &' || true
fi

echo
echo "Fertig."
echo "  · Der Hintergrund füllt den Schreibtisch und startet mit dem Rechner."
echo "  · Im Startmenü liegen „Stellium Konsole“ (als Fenster) und"
echo "    „Fernzugriff-Protokoll“ (zum Nachlesen alter Tage)."
echo "  · Schreibtischsymbole sind abgeschaltet — sie lägen sonst unter dem"
echo "    Hintergrund und wären nicht mehr anklickbar."
echo "  · Zurücknehmen: rm /etc/xdg/autostart/stellium-konsole-hintergrund.desktop,"
echo "    /etc/xdg/labwc/rc.xml.vor-stellium und die desktop-items-*.conf.vor-stellium"
echo "    wieder an ihren Platz kopieren."
