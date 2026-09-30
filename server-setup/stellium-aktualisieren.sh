#!/usr/bin/env bash
#
# Stellium auf dem Server aktualisieren — ohne alles neu einzurichten.
#
#   tar xzf stellium-server.tar.gz && cd stellium-server
#   sudo bash server-setup/stellium-aktualisieren.sh
#
# Angefasst wird nur der Programmcode. Datenbank, Konten, Schlüssel, Zertifikat,
# nginx, Firewall und alle Einstellungen bleiben, wie sie sind.
#
set -Eeuo pipefail

if [[ -t 1 ]]; then
  ROT=$'\e[31m'; GRUEN=$'\e[32m'; GELB=$'\e[33m'; BLAU=$'\e[38;5;99m'
  GRAU=$'\e[90m'; FETT=$'\e[1m'; AUS=$'\e[0m'
else
  ROT=''; GRUEN=''; GELB=''; BLAU=''; GRAU=''; FETT=''; AUS=''
fi
schritt() { printf '\n%s▸ %s%s\n' "$BLAU$FETT" "$*" "$AUS"; }
info()    { printf '  %s\n' "$*"; }
ok()      { printf '  %s✓%s %s\n' "$GRUEN" "$AUS" "$*"; }
warn()    { printf '  %s!%s %s\n' "$GELB" "$AUS" "$*"; }
fehler()  { printf '\n%s✗ %s%s\n\n' "$ROT$FETT" "$*" "$AUS" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fehler "Bitte mit sudo starten:  sudo bash $0"

# Beim Bauen darf nicht bloß "etwas ist schiefgegangen" herauskommen — die
# letzten Zeilen sagen fast immer sofort, woran es lag.
bau_fehlgeschlagen() {
  printf '\n%s✗ Das Bauen ist fehlgeschlagen. Die letzten Zeilen:%s\n\n' "$ROT$FETT" "$AUS" >&2
  tail -25 "${BAULOG:-/tmp/stellium-bau.log}" 2>/dev/null | sed 's/^/    /' >&2
  printf '\n    %sVollständig:  %s%s\n\n' "$GRAU" "${BAULOG:-/tmp/stellium-bau.log}" "$AUS" >&2
  return 1
}

BENUTZER="stellium"
ZIEL="/opt/stellium"
SICHERUNG="/var/lib/stellium/quelltext-vorher"

# Woher kommt der neue Stand? Aus dem Paket, in dem dieses Skript liegt.
QUELLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$QUELLE/package.json" && -d "$QUELLE/packages/server" ]] \
  || fehler "Dieser Teil arbeitet im entpackten Paket und wird von dort aufgerufen.
    Zum Aktualisieren von Hand:  ${FETT}sudo stellium-update${AUS}"
[[ "$QUELLE" != "$ZIEL" ]] || fehler "Quelle und Ziel sind dasselbe Verzeichnis."

[[ -d "$ZIEL" ]] || fehler "$ZIEL gibt es nicht. Für die Ersteinrichtung: server-setup/stellium-installieren.sh"

VORHER="$(cd "$ZIEL" && node -p "require('./packages/desktop/package.json').version" 2>/dev/null || echo '?')"
NACHHER="$(node -p "require('$QUELLE/packages/desktop/package.json').version" 2>/dev/null || echo '?')"

printf '\n%s✦  Stellium aktualisieren%s\n   %s%s → %s%s\n' "$BLAU$FETT" "$AUS" "$GRAU" "$VORHER" "$NACHHER" "$AUS"

# ── Zurücklegen können ──────────────────────────────────────────
schritt "Bisherigen Stand sichern"
rm -rf "$SICHERUNG"
mkdir -p "$(dirname "$SICHERUNG")"
# Nur der Quelltext; node_modules wird ohnehin neu aufgebaut.
tar -C "$ZIEL" --exclude=node_modules -cf - . | (mkdir -p "$SICHERUNG" && tar -C "$SICHERUNG" -xf -)
ok "liegt unter $SICHERUNG"

# Auch die Datenbank, bevor eine Umstellung sie anfasst. Ein Update kann
# Spalten ergänzen oder Inhalte umschreiben — dann will man einen Stand von
# vorher haben, nicht nur den alten Quelltext.
if [[ -x /usr/local/bin/stellium-sichern ]]; then
  if sudo -u "$BENUTZER" /usr/local/bin/stellium-sichern 2>/dev/null; then
    ok "Datenbank gesichert"
  else
    warn "Datenbank ließ sich nicht sichern — weiter mit dem Quelltextstand"
  fi
fi

zurueck() {
  # Ohne diese Zeile löst ein Fehler im Rückfall den Rückfall erneut aus.
  trap - ERR INT TERM
  warn "Etwas ist schiefgegangen — ich lege den alten Stand zurück."
  # Erst heraus aus dem Verzeichnis: beim Bauen steht die Sitzung darin, und
  # nach dem Löschen wüsste die Shell nicht mehr, wo sie ist.
  cd / || true
  mkdir -p "$ZIEL"
  # node_modules stehen lassen! Die Sicherung enthält sie nicht, und der
  # Dienst startet mit blankem node — ohne fastify käme er nie wieder hoch.
  find "$ZIEL" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null || true
  tar -C "$SICHERUNG" -cf - . | tar -C "$ZIEL" -xf -
  einstellungen_zurueck
  # Ein abgebrochenes "npm ci" kann die Abhängigkeiten halb abgeräumt haben.
  if [[ ! -d "$ZIEL/node_modules/fastify" ]]; then
    warn "Abhängigkeiten fehlen — ich lege sie für den alten Stand neu an"
    ( cd "$ZIEL" && sudo -u "$BENUTZER" npm ci --no-audit --no-fund ) \
      >>"${BAULOG:-/tmp/stellium-bau.log}" 2>&1 \
      || ( cd "$ZIEL" && sudo -u "$BENUTZER" npm install --no-audit --no-fund ) \
      >>"${BAULOG:-/tmp/stellium-bau.log}" 2>&1 || true
  fi
  chown -R "$BENUTZER:$BENUTZER" "$ZIEL"
  systemctl restart stellium || true
  sleep 3
  if systemctl is-active --quiet stellium; then
    fehler "Der alte Stand läuft wieder. Nichts ist verloren."
  else
    fehler "Der alte Stand ist zurückgelegt, der Dienst startet aber nicht. Log: journalctl -u stellium -n 50"
  fi
}

# ── Einstellungen überleben jedes Update ────────────────────────
# .env trägt Schlüssel und Masterpasswort und liegt bewusst nicht im Paket.
# Das Einspielen räumt das Verzeichnis aber leer — also vorher beiseitelegen.
EIGENES="$(mktemp -d)"
einstellungen_retten() {
  local d
  for d in .env packages/server/.env; do
    if [[ -f "$ZIEL/$d" ]]; then
      mkdir -p "$EIGENES/$(dirname "$d")"
      cp -a "$ZIEL/$d" "$EIGENES/$d"
    fi
  done
}
einstellungen_zurueck() {
  local d
  for d in .env packages/server/.env; do
    if [[ -f "$EIGENES/$d" && ! -f "$ZIEL/$d" ]]; then
      mkdir -p "$ZIEL/$(dirname "$d")"
      cp -a "$EIGENES/$d" "$ZIEL/$d"
      chown "$BENUTZER:$BENUTZER" "$ZIEL/$d"
      chmod 600 "$ZIEL/$d"
    fi
  done
}
einstellungen_retten
trap zurueck ERR
# Ein Abbruch von Hand darf nicht mitten im Austausch enden.
trap 'zurueck' INT TERM

# ── Neuen Stand einspielen ──────────────────────────────────────
schritt "Neuen Stand einspielen"
# node_modules stehen lassen: das spart auf einem Pi mehrere Minuten.
find "$ZIEL" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -C "$QUELLE" \
    --exclude=node_modules --exclude=.git --exclude=release \
    --exclude=downloads --exclude=data --exclude=dist \
    -cf - . | tar -C "$ZIEL" -xf -
einstellungen_zurueck
chown -R "$BENUTZER:$BENUTZER" "$ZIEL"
ok "Quelltext ersetzt"

schritt "Bauen"
cd "$ZIEL"
info "Abhängigkeiten — auf einem Pi kann das ein paar Minuten dauern"
# Ohne Electron: sein Binärpaket ist über 100 MB groß und braucht der Server nie.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export npm_config_electron_skip_binary_download=1

BAULOG="/tmp/stellium-bau.log"
# Optionale Abhängigkeiten müssen mit. Rollup — das Werkzeug hinter dem Bau
# der Oberfläche — liefert seine Maschinencode-Datei je Architektur genau als
# solche aus. Ohne sie bricht "vite build" mit einem MODULE_NOT_FOUND ab, das
# nach einem kaputten Paket aussieht und keines ist.
if ! npm ci --no-audit --no-fund > "$BAULOG" 2>&1; then
  npm install --no-audit --no-fund >> "$BAULOG" 2>&1 || bau_fehlgeschlagen
fi
npm run build:server >> "$BAULOG" 2>&1 || bau_fehlgeschlagen
chown -R "$BENUTZER:$BENUTZER" "$ZIEL"
ok "gebaut — Server und Oberfläche"

# ── Helfer auffrischen ──────────────────────────────────────────
schritt "Werkzeuge auffrischen"
for werkzeug in stellium-zugang stellium-tunnel stellium-selbstupdate; do
  [[ -f "$ZIEL/server-setup/$werkzeug.sh" ]] \
    && install -m 755 "$ZIEL/server-setup/$werkzeug.sh" "/usr/local/bin/$werkzeug"
done
[[ -f "$ZIEL/server-setup/stellium-konsole.mjs" ]] \
  && install -m 755 "$ZIEL/server-setup/stellium-konsole.mjs" /usr/local/lib/stellium/konsole.mjs
# Die Oberfläche des Schreibtischs gehört mit aufgefrischt. Sie wurde bisher
# NUR von konsole-gui/einrichten.sh installiert — also einmal beim
# Einrichten und danach nie wieder. Änderungen daran erreichten den Pi
# damit gar nicht, ohne dass etwas fehlschlug: die alte Fassung lief
# einfach weiter.
# Die laufende Anzeige merkt davon nichts; sie liest die Datei beim Start.
# Absichtlich kein Neustart von hier aus: das ist der Schirm, auf den
# jemand gerade schaut, und ein Aktualisierungslauf soll ihn nicht ohne
# Vorwarnung schwarz machen.
[[ -f "$ZIEL/server-setup/konsole-gui/konsole.py" && -f /usr/local/lib/stellium/konsole-gui.py ]] \
  && install -m 755 "$ZIEL/server-setup/konsole-gui/konsole.py" /usr/local/lib/stellium/konsole-gui.py
# "stellium-update" ist der Befehl, den man von Hand aufruft: er holt den
# neuen Stand vom Server. Der Teil, der im entpackten Paket arbeitet, liegt
# daneben und wird von dort aufgerufen — von Hand war er nur verwirrend.
install -m 755 "$ZIEL/server-setup/stellium-selbstupdate.sh" /usr/local/bin/stellium-update
install -m 755 "$ZIEL/server-setup/stellium-aktualisieren.sh" /usr/local/bin/stellium-einspielen
ok "stellium, stellium-zugang, stellium-tunnel, stellium-update"

# ── Fernsteuerung auffrischen ───────────────────────────────────
#
# Dieselbe Lücke wie eine Ebene höher bei der Serveransicht, und sie hat Geld
# gekostet: der Fernsteuerungs-Dienst wurde EINMAL von Hand eingerichtet, und
# Änderungen an fern-dienst.mjs erreichten den Pi danach nie. Nichts schlug
# dabei fehl — die alte Fassung lief einfach weiter. Wochenlang stand deshalb
# auf jedem zweiten Rechner "Es ist schon jemand verbunden", während die
# Behebung längst im Paket lag.
#
# Wo der Dienst liegt, wird nicht geraten, sondern seiner eigenen
# systemd-Einheit entnommen — je Pi kann das ein anderer Pfad sein.
# Ist gar keine Einheit eingerichtet, passiert hier nichts: dieser Pi hat keine
# Fernsteuerung, und das ist in Ordnung.
schritt "Fernsteuerung"
FERN_DIENST="$(systemctl cat stellium-fern.service 2>/dev/null \
  | grep -oE '/[^[:space:]]*fern-dienst\.mjs' | head -1 || true)"
if [[ -z "${FERN_DIENST:-}" || ! -f "$FERN_DIENST" ]]; then
  info "nicht eingerichtet — übersprungen"
else
  FERN_ORT="$(dirname "$FERN_DIENST")"
  FERN_NEU=0
  for datei in fern-dienst.mjs anmeldung.mjs passwort.mjs; do
    FERN_QUELLE="$ZIEL/server-setup/fernsteuerung/dienst/$datei"
    [[ -f "$FERN_QUELLE" ]] || continue
    cmp -s "$FERN_QUELLE" "$FERN_ORT/$datei" && continue
    install -m 755 "$FERN_QUELLE" "$FERN_ORT/$datei"
    FERN_NEU=1
  done

  # Der Abgreifer ist ein C-Programm und muss übersetzt werden. Gebaut wird in
  # einem Wegwerf-Verzeichnis, nicht im Quellbaum: `make` legt erzeugte Dateien
  # neben die Quellen, und die haben in $ZIEL nichts zu suchen.
  # Schlägt der Bau fehl, bleibt der bisherige Abgreifer stehen und arbeitet
  # weiter — er ist der einzige Teil, den ein Update nicht ersetzen MUSS: neue
  # Befehle, die er nicht kennt, überliest er stillschweigend.
  FERN_HOST_BIN="$(systemctl cat stellium-fern.service 2>/dev/null \
    | grep -oE '/[^[:space:]]*fern-host' | head -1 || true)"
  [[ -n "${FERN_HOST_BIN:-}" ]] || FERN_HOST_BIN="/usr/local/lib/stellium/fern-host"
  FERN_HOST_QUELLE="$ZIEL/server-setup/fernsteuerung/host"
  if [[ -f "$FERN_HOST_BIN" && -f "$FERN_HOST_QUELLE/fern-host.c" ]] \
     && [[ "$FERN_HOST_QUELLE/fern-host.c" -nt "$FERN_HOST_BIN" ]] \
     && command -v wayland-scanner >/dev/null 2>&1 \
     && pkg-config --exists wayland-client x264 libswscale libavutil xkbcommon 2>/dev/null; then
    FERN_BAU="$(mktemp -d)"
    cp -a "$FERN_HOST_QUELLE/." "$FERN_BAU/"
    if make -C "$FERN_BAU" >> "$BAULOG" 2>&1 && [[ -x "$FERN_BAU/fern-host" ]]; then
      install -m 755 "$FERN_BAU/fern-host" "$FERN_HOST_BIN"
      FERN_NEU=1
      ok "Abgreifer neu gebaut"
    else
      warn "Der Abgreifer ließ sich nicht bauen — der bisherige läuft weiter ($BAULOG)"
    fi
    rm -rf "$FERN_BAU"
  fi

  if (( FERN_NEU )); then
    # Neu starten heißt: eine laufende Fernsitzung bricht ab. Das ist bei einem
    # Update hinnehmbar — es ist eine Viertelstunde vorher angekündigt (siehe
    # stellium-selbstupdate.sh) und der Chat-Server geht ohnehin kurz weg.
    # Ohne Neustart läuft weiter die alte Fassung, und das ist genau der
    # Fehler, den dieser Abschnitt behebt.
    systemctl restart stellium-fern || warn "stellium-fern startete nicht — sudo systemctl status stellium-fern"
    ok "aufgefrischt und neu gestartet"
  else
    ok "war schon aktuell"
  fi
fi

# ── Serveransicht als Fenster ───────────────────────────────────
# Wer vor dieser Fassung eingerichtet hat, bekam nur die Textkonsole. Das
# Fenster kam später dazu — ohne diesen Schritt käme es nie an, weil das
# Update bisher nur den Quelltext erneuert hat.
schritt "Serveransicht"
KPORT="$(grep -oP '(?<=^PORT=)\d+' /etc/stellium.env 2>/dev/null || echo 8787)"
BROWSER=""
for kandidat in chromium-browser chromium google-chrome firefox; do
  command -v "$kandidat" >/dev/null 2>&1 && { BROWSER="$kandidat"; break; }
done

if [[ -d /etc/xdg/autostart && -n "$BROWSER" ]]; then
  if [[ "$BROWSER" == firefox ]]; then
    START="$BROWSER --new-window http://127.0.0.1:$KPORT/konsole"
  else
    START="$BROWSER --app=http://127.0.0.1:$KPORT/konsole --window-size=1240,860 --disable-features=TranslateUI"
  fi
  for ort in /etc/xdg/autostart /usr/share/applications; do
    install -d "$ort"
    cat > "$ort/stellium-konsole.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Stellium — Server
Comment=Übersicht und Bedienung des Chat-Servers
Exec=$START
Icon=utilities-system-monitor
Terminal=false
X-GNOME-Autostart-Delay=12
Categories=System;Monitor;
DESKTOP
  done
  ok "öffnet sich beim Anmelden als eigenes Fenster ($BROWSER)"
elif [[ -d /etc/xdg/autostart ]]; then
  warn "kein Browser gefunden — die Ansicht gibt es unter http://127.0.0.1:$KPORT/konsole"
else
  info "kein Desktop — es bleibt bei der Textübersicht (stellium)"
fi

# ── Starten ─────────────────────────────────────────────────────
schritt "Neu starten"
# Die Ankündigung hat ihren Zweck erfüllt.
rm -f /var/lib/stellium/wartung.json
systemctl restart stellium
sleep 5

if ! systemctl is-active --quiet stellium; then
  journalctl -u stellium --no-pager -n 20 | sed 's/^/    /'
  zurueck
fi

# Antwortet er auch wirklich?
PORT="$(grep -oP '(?<=^PORT=)\d+' /etc/stellium.env 2>/dev/null || echo 8787)"
ERREICHBAR=0
for _ in 1 2 3 4 5; do
  if curl -fsS --max-time 4 -o /dev/null "http://127.0.0.1:$PORT/api/health"; then ERREICHBAR=1; break; fi
  sleep 2
done
[[ $ERREICHBAR -eq 1 ]] || zurueck

trap - ERR
ok "läuft und antwortet"

cat <<FERTIG

${GRUEN}${FETT}   ✓  Aktualisiert auf ${NACHHER}.${AUS}

   ${GRAU}Der vorherige Stand liegt unter $SICHERUNG,
   falls du ihn je brauchst.${AUS}

   ${FETT}stellium${AUS}  zeigt, wie es dem Server geht.

FERTIG
