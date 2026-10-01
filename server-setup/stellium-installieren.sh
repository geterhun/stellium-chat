#!/usr/bin/env bash
#
# Stellium-Server auf Raspberry Pi OS einrichten — ein Aufruf, sonst nichts.
#
# Aus dem entpackten Paket heraus (der übliche Weg):
#
#   tar xzf stellium-server.tar.gz && cd stellium-server
#   sudo bash server-setup/stellium-installieren.sh
#
# Aus einem öffentlichen Repository heraus:
#
#   curl -fsSL https://raw.githubusercontent.com/.../stellium-installieren.sh | sudo bash
#
# Bei einem privaten Repository einen Zugriffstoken mitgeben:
#
#   sudo STELLIUM_TOKEN=ghp_… bash stellium-installieren.sh
#
# Was danach läuft:
#   • Node 22, nginx, Stellium als systemd-Dienst — startet bei jedem Neustart
#   • HTTPS mit echtem Zertifikat von Let's Encrypt, automatisch verlängert
#   • Firewall, fail2ban, automatische Sicherheitsaktualisierungen
#   • Eine Statuskonsole, die sich beim Anmelden von selbst öffnet
#
# Der Server selbst hört nur auf 127.0.0.1. Von außen kommt man ausschließlich
# durch nginx und damit ausschließlich verschlüsselt.

set -Eeuo pipefail

# ── Aussehen ────────────────────────────────────────────────────
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

trap 'fehler "Abgebrochen in Zeile $LINENO. Nichts ist halb kaputt — der Aufruf lässt sich einfach wiederholen."' ERR

# ── Vorbedingungen ──────────────────────────────────────────────
[[ $EUID -eq 0 ]] || fehler "Bitte mit sudo starten:  sudo bash $0"
command -v apt-get >/dev/null || fehler "Das hier ist für Raspberry Pi OS und Debian gedacht."

ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  arm64|armhf|amd64) ;;
  *) fehler "Architektur $ARCH wird nicht unterstützt." ;;
esac

# 32-Bit-Pi: Node 22 gibt es dort nicht mehr von NodeSource.
if [[ "$ARCH" == "armhf" ]]; then
  warn "Du läufst auf einem 32-Bit-System. Stellium braucht Node 22 (für die"
  warn "eingebaute SQLite-Unterstützung), und das gibt es für armhf nicht."
  fehler "Bitte das 64-Bit-Raspberry-Pi-OS aufsetzen."
fi

# ── Eingaben ────────────────────────────────────────────────────
#
# Gefragt wird am Terminal. Läuft das Skript ohne eines — in einer
# Automatisierung etwa —, zählen stattdessen diese Umgebungsvariablen:
#
#   STELLIUM_MODE    1 | 2 | 3
#   STELLIUM_DOMAIN  chat.meinefirma.de       (bei 1)
#   STELLIUM_DUCK    name:token               (bei 2)
#   STELLIUM_MAIL    du@meinefirma.de         (bei 1 und 2)
#   STELLIUM_GROQ    gsk_…                    (leer erlaubt)

# Gibt es ein Terminal, das wirklich antwortet? Ein Test auf die Datei genügt
# nicht — /dev/tty existiert auch dort, wo sich nichts daran öffnen lässt.
TERMINAL=""
if { : < /dev/tty; } 2>/dev/null; then TERMINAL="/dev/tty"; fi

# Alle Antworten landen hier und gelten beim nächsten Lauf als Vorgabe —
# damit man beim Nachbessern nicht alles noch einmal eintippen muss.
GEMERKT="/etc/stellium-einrichtung.conf"
if [[ -r "$GEMERKT" ]]; then
  # shellcheck source=/dev/null
  . "$GEMERKT"
fi

# Die gemerkten Ports gleich unter eigenem Namen sichern. merken() greift später
# darauf zurück, wenn es ohne Portangaben aufgerufen wird — sonst überschriebe
# ein früher Abbruch, etwa beim Bauen, die einmal gewählten Ports mit 80/443.
# Eigene Namen deshalb, weil STELLIUM_PORT_HTTP sonst auch aus der Umgebung
# stammen könnte; als Eingabe ist die Variable nirgends vorgesehen.
GEMERKT_PORT_HTTP="${STELLIUM_PORT_HTTP:-}"
GEMERKT_PORT_HTTPS="${STELLIUM_PORT_HTTPS:-}"

merken() {
  umask 077
  {
    echo "# Von stellium-installieren.sh gemerkt. Enthält Zugangsdaten."
    echo "STELLIUM_MODE=${1:-}"
    echo "STELLIUM_DOMAIN=${2:-}"
    echo "STELLIUM_MAIL=${3:-}"
    echo "STELLIUM_DUCK=${4:-}"
    echo "STELLIUM_PORT_HTTP=${5:-${GEMERKT_PORT_HTTP:-80}}"
    echo "STELLIUM_PORT_HTTPS=${6:-${GEMERKT_PORT_HTTPS:-443}}"
  } > "$GEMERKT"
  chmod 600 "$GEMERKT"
}

frage() {
  local text="$1" vorgabe="${2:-}" antwort=""
  if [[ -n "$TERMINAL" ]]; then
    read -rp "  $text" antwort < "$TERMINAL"
  elif [[ -t 0 ]]; then
    read -rp "  $text" antwort
  else
    antwort="$vorgabe"
  fi
  printf '%s' "$antwort"
}

frage_still() {
  local text="$1" vorgabe="${2:-}" antwort=""
  if [[ -n "$TERMINAL" ]]; then
    read -rsp "  $text" antwort < "$TERMINAL"; echo
  elif [[ -t 0 ]]; then
    read -rsp "  $text" antwort; echo
  else
    antwort="$vorgabe"
  fi
  printf '%s' "$antwort"
}

# Die eigene Adresse im Heimnetz. Mehrere Wege, weil keiner überall geht.
lokale_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  [[ -z "$ip" ]] && ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')" || true
  [[ -z "$ip" ]] && ip="$(hostname 2>/dev/null)" || true
  printf '%s' "${ip:-dieser-rechner}"
}

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
DATEN="/var/lib/stellium"
REPO="${STELLIUM_REPO:-https://github.com/chackrahunter/stellium-chat.git}"
PORT="8787"

# Bildschirm leeren, aber nur wenn das Terminal das kann. Über eine Pipe oder
# ohne gesetztes TERM scheitert clear — und ohne diese Absicherung bräche das
# ganze Skript an dieser Stelle ab, noch bevor es irgendetwas getan hat.
clear 2>/dev/null || printf '\n\n'

cat <<KOPF

${BLAU}${FETT}   ✦  Stellium${AUS}
   ${GRAU}Team-Chat mit Live-Übersetzung — Servereinrichtung${AUS}

   Dieser Aufruf richtet alles ein. Du wirst zweimal etwas gefragt,
   danach läuft es allein.

KOPF

# ── Fragen: erst alles einsammeln, dann arbeiten ────────────────
schritt "Wie soll der Server erreichbar sein?"

cat <<ERKLAERUNG
  In allen Fällen läuft die Verbindung über nginx mit HTTPS. Auf den
  Geräten im Team ist nichts zu installieren außer der Stellium-App.

  ${FETT}1)${AUS} Eigene Domain — ${GRUEN}empfohlen${AUS}
     z.B. chat.meinefirma.de. Echtes Zertifikat von Let's Encrypt,
     automatisch verlängert.

  ${FETT}2)${AUS} Kostenlose Adresse über DuckDNS
     Wenn du keine Domain hast: du bekommst so etwas wie
     meinefirma.duckdns.org, ebenfalls mit echtem Zertifikat.
     Kostet nichts, dauert zwei Minuten.

  ${FETT}3)${AUS} Nur im Heimnetz
     Ohne Verschlüsselung, nur im eigenen WLAN erreichbar.
     ${GELB}Zum Ausprobieren, nicht für echte Gespräche.${AUS}

  ${FETT}4)${AUS} Über einen Tunnel
     Der Pi baut die Verbindung selbst nach außen auf. Kein Port,
     kein Router-Zugang, geht auch hinter CGNAT. Verschlüsselt wird
     außen von Cloudflare. Auf den Geräten im Team ist nichts zu
     installieren.

  ${GRAU}Bei ${AUS}${FETT}2${AUS}${GRAU} läuft die Prüfung von Let's Encrypt über einen
  DNS-Eintrag — dafür muss im Router nichts freigegeben sein.
  Damit euer Team den Pi auch erreicht, sollte trotzdem ein Port
  durchgereicht werden; das Skript sagt dir am Ende welcher.

  Bei ${AUS}${FETT}1${AUS}${GRAU} ruft Let's Encrypt den Pi direkt auf Port 80 auf,
  der muss dafür von außen ankommen.${AUS}

ERKLAERUNG

WAHL=""
DOMAIN=""
MAIL=""
DUCK_NAME=""
DUCK_TOKEN=""
DUCK_VORGABE=""
while [[ -z "$WAHL" ]]; do
  WAHL="$(frage "Deine Wahl [1/2/3/4]: " "${STELLIUM_MODE:-}")"
  case "$WAHL" in
    1)
      while [[ -z "$DOMAIN" ]]; do
        DOMAIN="$(frage "Domain (z.B. chat.meinefirma.de): " "${STELLIUM_DOMAIN:-}")"
        [[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$ ]] || {
          warn "Das sieht nicht nach einer Domain aus."; DOMAIN=""; }
      done
      cat <<MAILHINWEIS

  ${GRAU}Let's Encrypt möchte eine Kontaktadresse. Sie steht nicht im
  Zertifikat und ist für niemanden sichtbar — sie dient nur dazu,
  dich zu warnen, falls das Zertifikat abzulaufen droht und die
  automatische Verlängerung einmal nicht geklappt hat.

  Leer lassen geht; dann bekommst du diese Warnung nicht.${AUS}

MAILHINWEIS
      MAIL="$(frage "E-Mail (oder leer): " "${STELLIUM_MAIL:-}")"
      while [[ -n "$MAIL" && "$MAIL" != *@*.* ]]; do
        warn "Das sieht nicht nach einer E-Mail aus. Leer lassen ist auch in Ordnung."
        MAIL="$(frage "E-Mail (oder leer): " "")"
      done
      ;;
    2)
      cat <<DUCK

  ${FETT}So bekommst du die Adresse:${AUS}
    1. duckdns.org öffnen und mit Google oder GitHub anmelden
    2. einen Namen eintragen, z.B. ${FETT}meinefirma${AUS}  →  meinefirma.duckdns.org
    3. oben auf der Seite steht dein ${FETT}token${AUS} — den brauche ich gleich

DUCK
      # Erst in eine eigene Variable holen: mit set -u bricht jede Kürzung an
      # einer nie gesetzten Variablen das ganze Skript ab.
      DUCK_VORGABE="${STELLIUM_DUCK:-}"
      while [[ -z "$DUCK_NAME" ]]; do
        DUCK_NAME="$(frage "Dein DuckDNS-Name (ohne .duckdns.org): " "${DUCK_VORGABE%%:*}")"
        DUCK_NAME="${DUCK_NAME%%.duckdns.org}"
        [[ "$DUCK_NAME" =~ ^[a-z0-9-]+$ ]] || { warn "Nur Kleinbuchstaben, Ziffern und Bindestriche."; DUCK_NAME=""; }
      done
      while [[ -z "$DUCK_TOKEN" ]]; do
        DUCK_TOKEN="$(frage "Dein DuckDNS-Token: " "${DUCK_VORGABE#*:}")"
        [[ ${#DUCK_TOKEN} -ge 20 ]] || { warn "Das sieht zu kurz aus."; DUCK_TOKEN=""; }
      done
      DOMAIN="$DUCK_NAME.duckdns.org"
      cat <<MAILHINWEIS

  ${GRAU}Let's Encrypt möchte eine Kontaktadresse. Sie steht nicht im
  Zertifikat und ist für niemanden sichtbar — sie dient nur dazu,
  dich zu warnen, falls das Zertifikat abzulaufen droht und die
  automatische Verlängerung einmal nicht geklappt hat.

  Leer lassen geht; dann bekommst du diese Warnung nicht.${AUS}

MAILHINWEIS
      MAIL="$(frage "E-Mail (oder leer): " "${STELLIUM_MAIL:-}")"
      while [[ -n "$MAIL" && "$MAIL" != *@*.* ]]; do
        warn "Das sieht nicht nach einer E-Mail aus. Leer lassen ist auch in Ordnung."
        MAIL="$(frage "E-Mail (oder leer): " "")"
      done
      ;;
    4) ;;
    3)
      warn "Ohne Verschlüsselung kann jeder im selben Netz mitlesen."
      SICHER="$(frage "Wirklich? [ja/nein]: " "ja")"
      [[ "$SICHER" == "ja" ]] || WAHL=""
      ;;
    *) warn "Bitte 1, 2, 3 oder 4."; WAHL="" ;;
  esac
done

schritt "Groq-Schlüssel"
cat <<ERKLAERUNG
  Für Übersetzung und StelliumAI. Der Schlüssel wird verschlüsselt
  auf diesem Pi abgelegt — kein Gerät im Team trägt ihn je ein.
  Holen kannst du ihn auf console.groq.com/keys.

  Leer lassen geht auch; Chat, Aufgaben, Kalender, Dateien und das
  Ideenboard laufen dann ganz normal, nur ohne KI.

ERKLAERUNG
GROQ="$(frage_still "Schlüssel (bleibt unsichtbar): " "${STELLIUM_GROQ:-}")"

# Die Antworten festhalten, bevor irgendetwas schiefgehen kann.
merken "$WAHL" "$DOMAIN" "$MAIL" "${DUCK_NAME:+$DUCK_NAME:$DUCK_TOKEN}"

# ── Ab hier ohne Rückfragen ─────────────────────────────────────
schritt "System aktualisieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
ok "Paketliste und Aktualisierungen"

schritt "Grundlagen installieren"
apt-get install -y -qq \
  curl ca-certificates gnupg git build-essential \
  nginx ufw fail2ban unattended-upgrades apt-listchanges \
  jq bc iproute2 >/dev/null
ok "nginx, Firewall, fail2ban, Werkzeuge"

schritt "Node 22"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v)"

schritt "Benutzerkonto für den Dienst"
# Ein eigenes Konto ohne Anmeldemöglichkeit: fällt der Dienst je aus der Rolle,
# kommt er an nichts heran, was ihn nichts angeht.
id -u "$BENUTZER" >/dev/null 2>&1 || useradd --system --home "$DATEN" --shell /usr/sbin/nologin "$BENUTZER"
mkdir -p "$DATEN" "$ZIEL"
chown -R "$BENUTZER:$BENUTZER" "$DATEN"
chmod 750 "$DATEN"
ok "Konto $BENUTZER, Daten in $DATEN"

schritt "Stellium holen und bauen"

# Drei Wege, in dieser Reihenfolge:
#   1. Das Skript liegt in einem entpackten Paket — dann von dort kopieren.
#      Das braucht kein Netz und funktioniert auch bei privatem Repository.
#   2. Es gibt schon eine Installation — dann aktualisieren.
#   3. Sonst klonen, notfalls mit Token.
QUELLE=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  MOEGLICH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
  if [[ -n "$MOEGLICH" && -f "$MOEGLICH/package.json" && -d "$MOEGLICH/packages/server" ]]; then
    QUELLE="$MOEGLICH"
  fi
fi

if [[ -n "$QUELLE" && "$QUELLE" != "$ZIEL" ]]; then
  info "aus dem mitgelieferten Paket: $QUELLE"
  mkdir -p "$ZIEL"
  # node_modules und fertige Pakete bleiben draußen — die entstehen hier neu.
  tar -C "$QUELLE" \
      --exclude=node_modules --exclude=.git --exclude=release \
      --exclude=downloads --exclude=data --exclude=dist \
      -cf - . | tar -C "$ZIEL" -xf -
elif [[ -d "$ZIEL/.git" ]]; then
  info "vorhandene Installation aktualisieren"
  # Das Verzeichnis gehört seit der Erstinstallation dem Konto stellium, git
  # läuft hier aber als root und verweigert seit 2.35.2 fremde Repositories.
  # Auf der Kommandozeile zählt safe.directory als geschützte Einstellung und
  # wird deshalb auch aus einem fremden Verzeichnis heraus anerkannt. Damit
  # liest root allerdings wieder .git/config und .git/hooks aus einem
  # Verzeichnis, das dem Dienstkonto gehört — genau die Schranke, die git dort
  # zieht. Vertretbar ist das hier, weil der Installer dieses Verzeichnis selbst
  # angelegt hat; ein sudo -u stellium scheitert dagegen, sobald /opt/stellium
  # nach einer abgebrochenen Erstinstallation noch root gehört.
  #
  # Die Fehlermeldung wandert in die Warnung, statt nach /dev/null zu gehen:
  # sonst sieht jede künftige echte Ursache aus wie ein Netzproblem.
  if MELDUNG="$(git -c safe.directory="$ZIEL" -C "$ZIEL" fetch --quiet origin 2>&1 \
      && git -c safe.directory="$ZIEL" -C "$ZIEL" reset --hard --quiet origin/HEAD 2>&1)"; then :
  else
    warn "Konnte nicht aktualisieren (${MELDUNG:-kein Grund genannt}) — der bestehende Stand wird neu gebaut"
  fi
elif [[ -n "$QUELLE" ]]; then
  info "aus der bestehenden Installation"
else
  ADR="$REPO"
  [[ -n "${STELLIUM_TOKEN:-}" ]] && ADR="${REPO/https:\/\//https:\/\/$STELLIUM_TOKEN@}"
  rm -rf "$ZIEL"
  if ! git clone --quiet --depth 1 "$ADR" "$ZIEL" 2>/dev/null; then
    fehler "$(cat <<HINWEIS
Konnte das Repository nicht holen.

Bei einem privaten Repository gibt es zwei Wege:

  ${FETT}a)${AUS} Das Paket auf den Pi kopieren und von dort starten:
       ${GRAU}scp stellium-server.tar.gz pi@$(hostname):~${AUS}
       ${GRAU}tar xzf stellium-server.tar.gz && cd stellium-server${AUS}
       ${GRAU}sudo bash server-setup/stellium-installieren.sh${AUS}

  ${FETT}b)${AUS} Mit einem Zugriffstoken starten:
       ${GRAU}sudo STELLIUM_TOKEN=ghp_… bash stellium-installieren.sh${AUS}
HINWEIS
)"
  fi
fi

# Wenn hier nichts liegt, ging beim Holen etwas schief. Ein nacktes
# "cd: no such file or directory" hilft niemandem weiter.
[[ -f "$ZIEL/package.json" ]] || fehler "In $ZIEL liegt kein Quelltext. Das Holen ist fehlgeschlagen."

cd "$ZIEL"
info "Abhängigkeiten — das dauert auf einem Pi ein paar Minuten"
# Der Server braucht kein Electron. Dessen Binärpaket ist über 100 MB groß und
# bringt die Einrichtung auf einem Pi regelmäßig zu Fall.
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
ok "gebaut"

schritt "Schlüssel sicher ablegen"
# Auf dem Pi gibt es keine Keychain. Das Masterpasswort landet in einer Datei,
# die nur root schreiben und nur der Dienst lesen darf.
UMGEBUNG="/etc/stellium.env"
if [[ -f "$UMGEBUNG" ]] && grep -q STELLIUM_MASTER_PASSPHRASE "$UMGEBUNG"; then
  info "Masterpasswort besteht bereits — bleibt unverändert"
else
  MASTER="$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | head -c 43)"
  # Mit umask 077 angelegt: sonst stand das Masterpasswort bis zum chmod
  # weiter unten für jedes Konto lesbar da (0644).
  ( umask 077; cat > "$UMGEBUNG" ) <<ENV
# Von stellium-installieren.sh erzeugt. Nicht ins Netz stellen.
STELLIUM_MASTER_PASSPHRASE=$MASTER
DATA_DIR=$DATEN
PORT=$PORT
HOST=127.0.0.1
ENV
fi
chown root:"$BENUTZER" "$UMGEBUNG"
chmod 640 "$UMGEBUNG"
ok "Masterpasswort in $UMGEBUNG (nur root und $BENUTZER)"

if [[ -n "${GROQ:-}" ]]; then
  # Über das mitgelieferte Werkzeug, damit der Schlüssel verschlüsselt im
  # Tresor landet und nicht im Klartext irgendwo herumliegt.
  set -a
  # shellcheck source=/dev/null
  . "$UMGEBUNG"
  set +a

  # Gegen das gebaute dist/, nicht über tsx: auf dem Pi soll dafür nichts
  # nachgeladen werden. Der Wert geht über die Standardeingabe und taucht
  # damit nie in der Prozessliste auf.
  if AUSGABE="$(printf '%s' "$GROQ" | sudo -u "$BENUTZER" \
       env STELLIUM_MASTER_PASSPHRASE="$STELLIUM_MASTER_PASSPHRASE" DATA_DIR="$DATEN" \
       node "$ZIEL/server-setup/schluessel-ablegen.mjs" groq 2>&1)"; then
    ok "Groq-Schlüssel verschlüsselt abgelegt"
  else
    warn "Groq-Schlüssel konnte nicht abgelegt werden:"
    printf '    %s\n' "$AUSGABE" | head -4
    warn "Nachholbar mit:  sudo bash $0"
  fi
  unset GROQ
else
  info "Kein Groq-Schlüssel — KI bleibt aus, alles andere läuft"
fi

schritt "Dienst einrichten"
cat > /etc/systemd/system/stellium.service <<DIENST
[Unit]
Description=Stellium — Team-Chat mit Live-Übersetzung
Documentation=https://github.com/chackrahunter/stellium-chat
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$BENUTZER
Group=$BENUTZER
WorkingDirectory=$ZIEL/packages/server
EnvironmentFile=$UMGEBUNG
ExecStart=/usr/bin/node $ZIEL/packages/server/dist/index.js
Restart=always
RestartSec=5

# Der Dienst braucht nichts vom übrigen System.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
ReadWritePaths=$DATEN

StandardOutput=journal
StandardError=journal
SyslogIdentifier=stellium

[Install]
WantedBy=multi-user.target
DIENST

systemctl daemon-reload
systemctl enable --quiet stellium
systemctl restart stellium
sleep 4
systemctl is-active --quiet stellium && ok "Dienst läuft und startet bei jedem Neustart mit" \
  || fehler "Der Dienst startet nicht. Sieh nach mit: journalctl -u stellium -n 50"

# ── nginx ───────────────────────────────────────────────────────
schritt "nginx einrichten"

# Bausteine, die beide Varianten teilen.
cat > /etc/nginx/conf.d/stellium-upgrade.conf <<'MAP'
# "Connection: upgrade" nur dann, wenn der Aufrufer das auch will.
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}
MAP

# Die Serveransicht gehört nicht ins Netz. Der Dienst selbst weist Fremde
# schon ab; das hier ist die zweite Tür davor.
cat > /etc/nginx/snippets/stellium-nurhier.conf <<'NURHIER'
location /konsole    { return 404; }
location /api/system { return 404; }
NURHIER

cat > /etc/nginx/snippets/stellium-proxy.conf <<'PROXY'
proxy_pass http://127.0.0.1:8787;

proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

# Der Chat hängt an einer WebSocket-Verbindung. Ohne diese beiden Zeilen
# lädt die Oberfläche und bleibt danach still.
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;

# Eine offene Verbindung darf lange still sein, ohne gekappt zu werden.
proxy_read_timeout  7d;
proxy_send_timeout  7d;

client_max_body_size 200m;
proxy_request_buffering off;
PROXY

cat > /etc/nginx/snippets/stellium-sicherheit.conf <<'SICHER'
# Der Browser soll nichts zulassen, was die App nicht braucht.
add_header X-Content-Type-Options     "nosniff"     always;
add_header X-Frame-Options            "DENY"        always;
add_header Referrer-Policy            "no-referrer" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Permissions-Policy         "geolocation=(), camera=(), microphone=(self), payment=()" always;

# Versionsnummer verrät nur Angreifern etwas. Bewusst hier im Server-Block:
# Debian setzt server_tokens bereits im http-Block, und zweimal im selben
# Zusammenhang lehnt nginx rundheraus ab.
server_tokens off;
SICHER

cat > /etc/nginx/snippets/stellium-tls.conf <<'TLS'
# Nur noch das, was als sicher gilt. TLS 1.0 und 1.1 sind seit Jahren gebrochen.
ssl_protocols             TLSv1.2 TLSv1.3;
ssl_ciphers               ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_prefer_server_ciphers off;
ssl_session_timeout       1d;
ssl_session_cache         shared:StelliumTLS:10m;
ssl_session_tickets       off;
ssl_stapling              on;
ssl_stapling_verify       on;
TLS

# Aus einer früheren Fassung: die Datei setzte server_tokens ein zweites Mal
# im http-Block, was nginx als Duplikat ablehnt.
rm -f /etc/nginx/conf.d/stellium-tokens.conf

mkdir -p /var/www/html/.well-known/acme-challenge
rm -f /etc/nginx/sites-enabled/default

# Bei einem Fehler nicht auf nginx -t verweisen, sondern gleich zeigen, was
# es sagt — sonst muss man den Befehl selbst noch einmal von Hand tippen.
pruefe_nginx() {
  local ausgabe
  if ! ausgabe="$(nginx -t 2>&1)"; then
    # Die eben geschriebene Site ist schon verlinkt. Bliebe sie liegen, käme
    # nginx nach dem nächsten Neustart des Pi gar nicht mehr hoch — der Server
    # wäre dann weder über HTTPS noch über HTTP erreichbar.
    #
    # Mit einem Namen als Angabe gibt es einen Stand, auf den sich zurückgehen
    # lässt: die Fassung ohne TLS lief vorhin schon. Ohne Namen bleibt nur, die
    # abgelehnte Site wieder auszuhängen.
    if [[ -n "${1:-}" ]] && schreibe_nur_http "$1" && nginx -t >/dev/null 2>&1; then
      systemctl reload nginx >/dev/null 2>&1 || true
    else
      rm -f /etc/nginx/sites-enabled/stellium
    fi
    fehler "$(printf 'nginx lehnt die Konfiguration ab:\n\n%s' "$ausgabe")"
  fi
}

schreibe_nur_http() {
  cat > /etc/nginx/sites-available/stellium <<NGINX
server {
  listen $PORT_HTTP default_server;
  listen [::]:$PORT_HTTP default_server;
  server_name ${1:-_};

  include snippets/stellium-sicherheit.conf;
  include snippets/stellium-nurhier.conf;

  location / {
    include snippets/stellium-proxy.conf;
  }
}
NGINX
}

schreibe_mit_tls() {
  local NAME="$1"
  # Nur wenn HTTPS woanders läuft, gehört der Port in die Weiterleitung.
  local SUFFIX=""
  [[ "$PORT_HTTPS" != "443" ]] && SUFFIX=":$PORT_HTTPS"
  # "http2 on;" gibt es erst ab nginx 1.25.1. Bookworm liefert 1.22.1 und lehnt
  # die Zeile rundheraus ab, deshalb darf sie nur hinein, wenn dieses nginx sie
  # auch kennt. Ohne sie läuft HTTPS über HTTP/1.1 — vollständig, nur ohne
  # Multiplexing.
  local NGINX_VERSION HTTP2=""
  NGINX_VERSION="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  [[ -n "$NGINX_VERSION" ]] && dpkg --compare-versions "$NGINX_VERSION" ge 1.25.1 2>/dev/null && HTTP2="  http2 on;"
  cat > /etc/nginx/sites-available/stellium <<NGINX
# Alles Unverschlüsselte geht nach oben — außer der Prüfung von Let's Encrypt,
# die muss über Port 80 laufen.
server {
  listen $PORT_HTTP;
  listen [::]:$PORT_HTTP;
  server_name $NAME;

  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://\$host$SUFFIX\$request_uri; }
}

server {
  listen $PORT_HTTPS ssl;
  listen [::]:$PORT_HTTPS ssl;
$HTTP2
  server_name $NAME;

  ssl_certificate     /etc/letsencrypt/live/$NAME/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$NAME/privkey.pem;
  ssl_trusted_certificate /etc/letsencrypt/live/$NAME/chain.pem;
  include snippets/stellium-tls.conf;

  include snippets/stellium-sicherheit.conf;
  # Zwei Jahre. Ein Browser, der Stellium einmal gesehen hat, fragt danach
  # nie wieder unverschlüsselt — auch nicht, wenn jemand ihn dazu überredet.
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

  location /.well-known/acme-challenge/ { root /var/www/html; }
  include snippets/stellium-nurhier.conf;

  location / {
    include snippets/stellium-proxy.conf;
  }
}
NGINX
}

# ── Ports wählen ────────────────────────────────────────────────
#
# 80 und 443 sind die Wunschports: nur dort steht die Adresse ohne Anhängsel.
# Sind sie belegt, weicht die Einrichtung auf die nächsten freien aus, statt an
# einem besetzten Port zu scheitern. Ob von außen überhaupt etwas ankommt, kann
# die Portsuche nicht wissen — das prüft von_aussen_erreichbar erst kurz vor dem
# Zertifikat, wo es zum ersten Mal darauf ankommt.

port_frei() {
  # Belegt heißt nicht nur "lauscht gerade". Ein Port, der einem fremden Dienst
  # gehört, ist auch dann tabu, wenn der Dienst zufällig gerade nicht läuft —
  # sonst nimmt nginx ihn weg und der andere kommt nach seinem nächsten Start
  # nicht mehr hoch. Genau so wäre caddy (:8080, die Seite eines Kollegen)
  # beinahe verlorengegangen. Siehe FREMDE-DIENSTE.md.
  case "$1" in
    8080|2019) return 1 ;;
  esac
  ! ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
}

waehle_port() {
  local wunsch="$1"; shift
  for kandidat in "$wunsch" "$@"; do
    port_frei "$kandidat" && { printf '%s' "$kandidat"; return 0; }
  done
  printf '%s' "$wunsch"
}

# Eine frühere Einrichtung kann die SSH-Weiche hinterlassen haben. Sie hängt an
# der nginx-Konfiguration, die dieser Lauf gleich überschreibt, und belegt dabei
# selbst Port 443. Bliebe sie liegen, scheiterte der reload weiter unten lautlos.
if [[ -f /etc/nginx/modules-enabled/60-stellium-weiche.conf ]]; then
  rm -f /etc/nginx/modules-enabled/60-stellium-weiche.conf
  warn "Die SSH-Weiche wurde entfernt — richte sie nach der Einrichtung mit stellium-ssh-durch-https erneut ein"
fi

# Das eigene nginx läuft seit der Installation und hält Port 80 — beim zweiten
# Lauf zusätzlich 443. Solange es lauscht, hält die Portsuche die eigene
# Belegung für eine fremde und weicht ohne Not auf 8080/8443 aus.
systemctl stop nginx >/dev/null 2>&1 || true

# 8080 steht bewusst nicht mehr in der Liste: dort liegt die Seite eines
# Kollegen (caddy). 8880/8008 tun denselben Dienst und gehören niemandem.
PORT_HTTP="$(waehle_port 80 8880 8008)"
PORT_HTTPS="$(waehle_port 443 8443 9443 4443)"

# Sofort wieder an: bricht die Einrichtung später ab — etwa am DuckDNS-Test —,
# soll der Pi nicht mit angehaltenem nginx zurückbleiben. Die endgültige
# Konfiguration schreibt und lädt jeder Zweig weiter unten ohnehin neu.
systemctl start nginx >/dev/null 2>&1 || warn "nginx läuft gerade nicht — die Einrichtung setzt ihn gleich neu auf"

if [[ "$PORT_HTTP" != "80" || "$PORT_HTTPS" != "443" ]]; then
  schritt "Ports"
  [[ "$PORT_HTTP"  != "80"  ]] && info "Port 80 ist belegt — nehme $PORT_HTTP"
  [[ "$PORT_HTTPS" != "443" ]] && info "Port 443 ist belegt — nehme $PORT_HTTPS"
fi

# Die Ports stehen jetzt fest und gehören sofort in die gemerkte Datei:
# stellium-zugang und stellium-tunnel lesen sie von dort, und die Varianten ohne
# TLS kommen an dem zweiten merken-Aufruf weiter unten nie vorbei.
merken "$WAHL" "$DOMAIN" "$MAIL" "${DUCK_NAME:+$DUCK_NAME:$DUCK_TOKEN}" "$PORT_HTTP" "$PORT_HTTPS"

ADRESSE=""

if [[ "$WAHL" == "4" ]]; then
  # Der Tunnel spricht nginx auf dem Pi selbst an; nach außen geht nichts
  # direkt. Eingerichtet wird er gleich, nach dem Rest.
  schreibe_nur_http
  ln -sf /etc/nginx/sites-available/stellium /etc/nginx/sites-enabled/stellium
  pruefe_nginx
  systemctl enable --quiet nginx
  systemctl restart nginx
  ADRESSE="(wird beim Tunnel vergeben)"
  ok "nginx bereit für den Tunnel"

elif [[ "$WAHL" == "3" ]]; then
  schreibe_nur_http
  ln -sf /etc/nginx/sites-available/stellium /etc/nginx/sites-enabled/stellium
  pruefe_nginx
  systemctl enable --quiet nginx
  systemctl restart nginx
  if [[ "$PORT_HTTP" == "80" ]]; then ADRESSE="http://$(lokale_ip)"
  else ADRESSE="http://$(lokale_ip):$PORT_HTTP"; fi
  warn "Unverschlüsselt. Nur im Heimnetz benutzen."

elif [[ "$WAHL" == "4" ]]; then
  : # nichts weiter — der Tunnel bringt die Verschlüsselung mit

else
  # ── DuckDNS: Adresse aktuell halten ─────────────────────────
  if [[ "$WAHL" == "2" ]]; then
    schritt "DuckDNS"
    ( umask 077; cat > /etc/stellium-duckdns ) <<DUCK
DUCK_NAME=$DUCK_NAME
DUCK_TOKEN=$DUCK_TOKEN
DUCK
    chmod 600 /etc/stellium-duckdns

    cat > /usr/local/bin/stellium-duckdns <<'DUCKSKRIPT'
#!/usr/bin/env bash
# Sagt DuckDNS, welche Adresse dieser Anschluss gerade hat.
set -Eeuo pipefail
. /etc/stellium-duckdns
ANTWORT="$(curl -fsS "https://www.duckdns.org/update?domains=$DUCK_NAME&token=$DUCK_TOKEN&ip=")"
[[ "$ANTWORT" == "OK" ]] || { echo "DuckDNS antwortet: $ANTWORT" >&2; exit 1; }
DUCKSKRIPT
    chmod 755 /usr/local/bin/stellium-duckdns

    cat > /etc/systemd/system/stellium-duckdns.service <<'D1'
[Unit]
Description=DuckDNS-Adresse aktualisieren
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-duckdns
D1
    cat > /etc/systemd/system/stellium-duckdns.timer <<'D2'
[Unit]
Description=DuckDNS alle fünf Minuten aktualisieren
[Timer]
OnBootSec=45
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
D2
    systemctl daemon-reload
    systemctl enable --quiet stellium-duckdns.timer
    systemctl start stellium-duckdns.timer

    if /usr/local/bin/stellium-duckdns; then
      ok "$DOMAIN zeigt auf diesen Anschluss und bleibt aktuell"
    else
      fehler "DuckDNS hat den Namen abgelehnt. Stimmen Name und Token?"
    fi
    # Der Name braucht einen Moment, bis ihn alle kennen.
    info "kurz warten, damit die Adresse überall bekannt ist"
    sleep 20
  fi

  # ── Zertifikat ──────────────────────────────────────────────
  schritt "Zertifikat von Let's Encrypt"
  apt-get install -y -qq certbot >/dev/null

  # Zuerst nur Port 80 — sonst verweist die Konfiguration auf ein Zertifikat,
  # das es noch gar nicht gibt, und nginx startet nicht.
  schreibe_nur_http "$DOMAIN"
  ln -sf /etc/nginx/sites-available/stellium /etc/nginx/sites-enabled/stellium
  pruefe_nginx
  systemctl enable --quiet nginx
  systemctl restart nginx

  # ── Zertifikat besorgen ─────────────────────────────────────
  #
  # Zwei Wege, und der erste braucht keinen offenen Port:
  #
  #   DuckDNS  → Let's Encrypt fragt einen DNS-Eintrag ab, den wir setzen.
  #              Der Router muss dafür gar nichts durchlassen.
  #   Domain   → Let's Encrypt ruft Port 80 auf. Der muss erreichbar sein.

  von_aussen_erreichbar() {
    local probe="stellium-$RANDOM$RANDOM"
    echo "$probe" > "/var/www/html/.well-known/acme-challenge/$probe"
    local antwort
    antwort="$(curl -fsS --max-time 12 "http://$DOMAIN:$PORT_HTTP/.well-known/acme-challenge/$probe" 2>/dev/null || true)"
    rm -f "/var/www/html/.well-known/acme-challenge/$probe"
    [[ "$antwort" == "$probe" ]]
  }

  if [[ "$WAHL" == "2" ]]; then
    # DuckDNS beantwortet die Prüfung über einen TXT-Eintrag. Zwei kleine
    # Skripte setzen und räumen ihn wieder weg; certbot ruft sie selbst auf.
    cat > /usr/local/bin/stellium-duckdns-txt <<'TXT'
#!/usr/bin/env bash
# Setzt oder löscht den Prüfeintrag bei DuckDNS.
set -Eeuo pipefail
. /etc/stellium-duckdns
if [[ "${1:-setzen}" == "loeschen" ]]; then
  curl -fsS "https://www.duckdns.org/update?domains=$DUCK_NAME&token=$DUCK_TOKEN&txt=geloescht&clear=true" >/dev/null
else
  [[ -n "${CERTBOT_VALIDATION:-}" ]] || { echo "CERTBOT_VALIDATION fehlt — certbot ruft dieses Skript selbst auf." >&2; exit 1; }
  curl -fsS "https://www.duckdns.org/update?domains=$DUCK_NAME&token=$DUCK_TOKEN&txt=$CERTBOT_VALIDATION" >/dev/null
  # Der Eintrag braucht einen Moment, bis Let's Encrypt ihn sieht.
  sleep 35
fi
TXT
    chmod 755 /usr/local/bin/stellium-duckdns-txt
  fi

  # certbot verlangt im nicht-interaktiven Betrieb entweder eine Kontaktadresse
  # oder den ausdrücklichen Verzicht darauf. Beide Zweige unten brauchen das,
  # deshalb steht die Entscheidung vor der Fallunterscheidung: stand sie nur im
  # DuckDNS-Zweig, lief certbot bei eigener Domain ganz ohne Anmeldeangabe.
  if [[ -n "$MAIL" ]]; then MAIL_ARG=(-m "$MAIL" --no-eff-email)
  else MAIL_ARG=(--register-unsafely-without-email); fi

  if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
    info "Zertifikat besteht bereits"
  elif [[ "$WAHL" == "2" ]]; then
    info "über einen DNS-Eintrag bei DuckDNS — dafür muss kein Port offen sein"

    certbot certonly --manual --preferred-challenges dns \
      --manual-auth-hook "/usr/local/bin/stellium-duckdns-txt setzen" \
      --manual-cleanup-hook "/usr/local/bin/stellium-duckdns-txt loeschen" \
      -d "$DOMAIN" --non-interactive --agree-tos "${MAIL_ARG[@]}" >/dev/null 2>&1 \
      || fehler "$(printf 'Let'"'"'s Encrypt hat kein Zertifikat ausgestellt.\n\nGenauer nachsehen:\n  sudo certbot certonly --manual --preferred-challenges dns \\\n    --manual-auth-hook "/usr/local/bin/stellium-duckdns-txt setzen" \\\n    --manual-cleanup-hook "/usr/local/bin/stellium-duckdns-txt loeschen" -d %s' "$DOMAIN")"
  else
    # Let's Encrypt klopft gleich selbst von außen an Port 80. Kommt hier schon
    # nichts an, liegt es am Router oder am DNS-Eintrag und nicht an certbot —
    # dann steht wenigstens die Ursache auf dem Schirm statt nur der Fehlschlag.
    von_aussen_erreichbar \
      || warn "Von außen kommt auf Port $PORT_HTTP nichts an — das Zertifikat wird so vermutlich nicht ausgestellt. Im Router weiterleiten und den Installer erneut starten."
    certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
      --non-interactive --agree-tos "${MAIL_ARG[@]}" >/dev/null 2>&1 \
      || fehler "Let's Encrypt hat kein Zertifikat ausgestellt. Genauer:  certbot certonly --webroot -w /var/www/html -d $DOMAIN"
  fi
  ok "Zertifikat für $DOMAIN"

  merken "$WAHL" "$DOMAIN" "$MAIL" "${DUCK_NAME:+$DUCK_NAME:$DUCK_TOKEN}" "$PORT_HTTP" "$PORT_HTTPS"

  # Jetzt die vollständige Konfiguration mit TLS.
  schreibe_mit_tls "$DOMAIN"
  # Mit dem Namen als Angabe: lehnt nginx die TLS-Fassung ab, kommt hier die
  # Fassung ohne TLS zurück, die vorhin schon lief. Der Server ist dann
  # wenigstens über Port 80 erreichbar statt gar nicht.
  pruefe_nginx "$DOMAIN"
  # Neustart statt reload: "nginx -t" öffnet keine Sockets und merkt deshalb
  # nichts davon, wenn der HTTPS-Port schon jemand anderem gehört. Ein reload
  # schluckt so einen Bindefehler still, ein restart läuft in die ERR-Falle.
  systemctl restart nginx
  ok "nginx nimmt HTTPS entgegen und reicht nach innen weiter"

  # Verlängerung läuft automatisch; nginx muss danach neu laden.
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/stellium-nginx.sh <<'HOOK'
#!/usr/bin/env bash
systemctl reload nginx
HOOK
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/stellium-nginx.sh
  systemctl enable --quiet certbot.timer 2>/dev/null || true
  systemctl start certbot.timer 2>/dev/null || true
  ok "Verlängerung läuft automatisch"

  if [[ "$PORT_HTTPS" == "443" ]]; then ADRESSE="https://$DOMAIN"
  else ADRESSE="https://$DOMAIN:$PORT_HTTPS"; fi
fi

# ── Absichern ───────────────────────────────────────────────────
schritt "Firewall und Einbruchsschutz"

# Welche Ports hört sshd wirklich ab? "ufw allow OpenSSH" öffnet nur 22. Läuft
# SSH längst woanders — auf diesem Pi etwa auf 2222, von ssh-zugang.sh dorthin
# gelegt —, dann räumt der reset die einzige Regel weg, über die noch jemand
# hereinkommt. Beim nächsten Lauf wäre der Pi zu, und niemand käme mehr dran.
# Deshalb die tatsächlichen Ports erfragen, statt 22 anzunehmen.
# Das "|| true" trägt die Rückfallebene darunter: ohne laufenden SSH-Dienst
# (auf Raspberry Pi OS ab Werk aus) bricht `sshd -T` ab, weil /run/sshd fehlt,
# und mit pipefail riss das die ERR-Falle mit — die Einrichtung endete hier,
# kurz vor der Firewall, statt auf 22 zurückzufallen.
SSH_PORTS="$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | sort -un || true)"
[[ -z "$SSH_PORTS" ]] && SSH_PORTS=22

ufw --force reset >/dev/null 2>&1
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for P in $SSH_PORTS; do
  ufw allow "$P/tcp" >/dev/null
done
ufw allow "$PORT_HTTP/tcp"  >/dev/null
ufw allow "$PORT_HTTPS/tcp" >/dev/null
info "Offen: SSH ($(echo $SSH_PORTS | tr ' ' ',')), $PORT_HTTP, $PORT_HTTPS — sonst nichts"
ufw --force enable >/dev/null
ok "Firewall aktiv"

# Nachsehen statt vertrauen: steht für jeden SSH-Port wirklich eine Regel?
# Ein reset, der die eigene Rückfahrkarte einzieht, fällt sonst erst auf,
# wenn die Verbindung schon weg ist.
for P in $SSH_PORTS; do
  ufw status | grep -qE "^$P/tcp" \
    || warn "ACHTUNG: für SSH-Port $P steht keine Regel — Zugang prüfen, bevor du die Sitzung schließt!"
done

# Der Chat-Port selbst ist von außen ohnehin nicht erreichbar: der Dienst
# hört auf 127.0.0.1. Die Firewall ist die zweite Linie, nicht die erste.

cat > /etc/fail2ban/jail.d/stellium.conf <<'JAIL'
[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true

[sshd]
enabled  = true
maxretry = 4
bantime  = 1h
JAIL
systemctl enable --quiet fail2ban
systemctl restart fail2ban
ok "fail2ban wacht über SSH und nginx"

# Sicherheitsaktualisierungen von selbst, inklusive Neustart nachts um vier
# falls einer nötig wird.
cat > /etc/apt/apt.conf.d/51stellium-unattended <<'AUTO'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
AUTO
systemctl enable --quiet unattended-upgrades
systemctl restart unattended-upgrades
ok "Sicherheitsaktualisierungen laufen automatisch"

# ── Statuskonsole ───────────────────────────────────────────────
schritt "Statuskonsole"

install -o "$BENUTZER" -g "$BENUTZER" -m 755 -d /usr/local/lib/stellium
cp "$ZIEL/server-setup/stellium-konsole.mjs" /usr/local/lib/stellium/konsole.mjs
chmod 755 /usr/local/lib/stellium/konsole.mjs

install -m 755 "$ZIEL/server-setup/stellium-zugang.sh" /usr/local/bin/stellium-zugang
install -m 755 "$ZIEL/server-setup/stellium-tunnel.sh" /usr/local/bin/stellium-tunnel
# "stellium-update" ist der Befehl, den man von Hand aufruft: er holt den
# neuen Stand vom Server. Der Teil, der im entpackten Paket arbeitet, liegt
# daneben und wird von dort aufgerufen — von Hand war er nur verwirrend.
install -m 755 "$ZIEL/server-setup/stellium-selbstupdate.sh" /usr/local/bin/stellium-update
install -m 755 "$ZIEL/server-setup/stellium-aktualisieren.sh" /usr/local/bin/stellium-einspielen
install -m 755 "$ZIEL/server-setup/stellium-selbstupdate.sh" /usr/local/bin/stellium-selbstupdate

# Die Knöpfe der Serveransicht brauchen genau drei Dinge — sonst nichts.
cat > /etc/sudoers.d/stellium-konsole <<SUDO
$BENUTZER ALL=(root) NOPASSWD: /usr/bin/systemctl restart stellium, /usr/local/bin/stellium-sichern, /usr/local/bin/stellium-selbstupdate pruefen
SUDO
chmod 440 /etc/sudoers.d/stellium-konsole
ok "stellium-zugang, stellium-tunnel, stellium-update, stellium-einspielen"

# Alle dreißig Minuten nach einem neuen Serverstand sehen. Ohne hinterlegten
# Zugang meldet das Skript sich mit einem Hinweis und tut sonst nichts.
cat > /etc/systemd/system/stellium-selbstupdate.service <<'SU1'
[Unit]
Description=Stellium: nach einem neuen Serverstand sehen
After=network-online.target stellium.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-selbstupdate
SU1
cat > /etc/systemd/system/stellium-selbstupdate.timer <<'SU2'
[Unit]
Description=Alle 30 Minuten nach einem neuen Serverstand sehen
[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
RandomizedDelaySec=3min
[Install]
WantedBy=timers.target
SU2
systemctl daemon-reload
systemctl enable --quiet stellium-selbstupdate.timer
systemctl start stellium-selbstupdate.timer
ok "sieht alle 30 Minuten nach neuen Serverständen"

cat > /usr/local/bin/stellium <<KONSOLE
#!/usr/bin/env bash
# Statuskonsole. Ohne Argument läuft sie fortlaufend, mit "einmal" nur einmal.
exec /usr/bin/node /usr/local/lib/stellium/konsole.mjs "\$@"
KONSOLE
chmod 755 /usr/local/bin/stellium

# Beim Anmelden von selbst öffnen.
BROWSER=""
for kandidat in chromium-browser chromium google-chrome firefox; do
  command -v "$kandidat" >/dev/null 2>&1 && { BROWSER="$kandidat"; break; }
done

if [[ -d /etc/xdg/autostart && -n "$BROWSER" ]]; then
  # Mit Desktop: ein eigenes Fenster mit der Serveransicht. Kein Terminal —
  # eine Übersicht mit Knöpfen liest sich schlicht besser als Textausgabe.
  if [[ "$BROWSER" == firefox ]]; then
    START="$BROWSER --new-window http://127.0.0.1:$PORT/konsole"
  else
    START="$BROWSER --app=http://127.0.0.1:$PORT/konsole --window-size=1240,860 --disable-features=TranslateUI"
  fi

  # Bewusst KEIN Eintrag in /etc/xdg/autostart: die grafische Konsole ist
  # inzwischen der Schreibtischhintergrund selbst (siehe konsole-gui/). Ein
  # zusätzliches Browserfenster bei jeder Anmeldung legte sich genau darüber
  # und verdeckte das, was es zeigen sollte. Wer die Ansicht im Browser will,
  # findet sie weiterhin im Startmenü.
  rm -f /etc/xdg/autostart/stellium-konsole.desktop

  # Im Startmenü, damit man sie bei Bedarf von Hand öffnen kann.
  install -d /usr/share/applications
  cat > /usr/share/applications/stellium-konsole.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=Stellium — Server
Comment=Übersicht und Bedienung des Chat-Servers
Exec=$START
Icon=utilities-system-monitor
Terminal=false
Categories=System;Monitor;
DESKTOP

  ok "Öffnet sich beim Anmelden als eigenes Fenster ($BROWSER)"
elif [[ -d /etc/xdg/autostart ]]; then
  warn "Kein Browser gefunden — die Ansicht gibt es unter http://127.0.0.1:$PORT/konsole"
else
  # Ohne Desktop: einmalige Übersicht bei jeder Anmeldung an der Konsole.
  cat > /etc/profile.d/zz-stellium.sh <<'PROFIL'
# Beim Anmelden kurz zeigen, wie es dem Server geht.
# Nur bei einer echten Sitzung am Terminal, nicht bei jedem Skript.
if [[ $- == *i* ]] && [[ -z "${STELLIUM_STILL:-}" ]] && command -v stellium >/dev/null; then
  stellium einmal
fi
PROFIL
  chmod 644 /etc/profile.d/zz-stellium.sh
  ok "Zeigt sich bei jeder Anmeldung an der Konsole"
fi

# ── Sicherung ───────────────────────────────────────────────────
schritt "Nächtliche Sicherung"

cat > /usr/local/bin/stellium-sichern <<'SICHERUNG'
#!/usr/bin/env bash
# Kopie der Datenbank, ohne den Dienst anzuhalten — und ein Spiegel des
# Blockspeichers, ohne den die Datenbank die halbe Wahrheit wäre.
set -Eeuo pipefail
# Überschreibbar, damit sich der Lauf an einer Kopie erproben lässt, ohne den
# echten Datenbestand anzufassen.
DATEN="${STELLIUM_DATA:-/var/lib/stellium}"
ZIEL="$DATEN/sicherungen"
BLOECKE="$DATEN/storage/bloecke"
SPIEGEL="$ZIEL/bloecke"
mkdir -p "$ZIEL"
STAND="$(date +%Y%m%d-%H%M)"
# .backup statt cp: eine laufende Datenbank lässt sich nicht einfach kopieren.
sqlite3 "$DATEN/stellium.db" ".backup '$ZIEL/stellium-$STAND.db'" 2>/dev/null \
  || cp "$DATEN/stellium.db" "$ZIEL/stellium-$STAND.db"
gzip -f "$ZIEL/stellium-$STAND.db"

# Der Tresor gehört dazu: ohne ihn fehlt nach einer Wiederherstellung der
# Groq-Schlüssel. Er ist selbst verschlüsselt und darf hier liegen.
[[ -f "$DATEN/secrets.enc" ]] && cp -f "$DATEN/secrets.enc" "$ZIEL/secrets.enc"

# Drei Stände genügen — der älteste weicht, sobald ein vierter entsteht.
# Bewusst vor dem Blockspeicher: der räumt gleich danach anhand genau dieser
# Stände auf und soll dabei die endgültige Liste vor sich haben.
ls -1t "$ZIEL"/stellium-*.db.gz 2>/dev/null | tail -n +4 | xargs -r rm -f

# ── Blockspeicher ───────────────────────────────────────────────
#
# In der Datenbank steht zu jeder Datei nur die Liste ihrer Blöcke. Die Bytes
# selbst liegen unter storage/bloecke/. Ohne sie ist ein zurückgespielter
# Datenbankstand wertlos: die Listen zeigen ins Leere, und jede hochgeladene
# Datei ist weg.
#
# Ein tägliches Vollpaket verbietet sich — der Speicher darf viele Gigabyte
# groß werden. Es ist aber auch gar nicht nötig, und zwar aus einem Grund, der
# in diesem Speicher steckt: **jeder Block heißt so, wie sein Inhalt lautet**
# (SHA-256). Ein Block wird einmal geschrieben und danach nie wieder
# angefasst — er kann nur noch entstehen oder verschwinden. Was gestern
# gesichert wurde, ist heute Byte für Byte dasselbe.
#
# Deshalb Hardlinks: der Spiegel bekommt für jeden neuen Block einen zweiten
# Namen auf dieselben Bytes. Das kostet einen Verzeichniseintrag und sonst
# nichts, und der Lauf dauert so lange, wie es NEUE Blöcke gibt — nicht so
# lange, wie der Speicher groß ist.
#
# Wogegen das schützt: der Server gibt Blöcke frei, sobald keine Datei sie mehr
# braucht. Ein aufgehobener Datenbankstand von vorgestern zählt sie aber
# vielleicht noch auf. Der Hardlink hält die Bytes am Leben, auch wenn der
# Server seinen eigenen Namen dafür gelöscht hat — genau die Lücke, um die es
# hier geht.
#
# Wogegen es NICHT schützt: gegen den Ausfall der Platte. Dagegen hilft nur,
# sicherungen/ regelmäßig vom Pi herunterzuholen — für die Datenbankstände
# gilt dasselbe, die liegen auch hier.
if [[ -d "$BLOECKE" ]]; then
  mkdir -p "$SPIEGEL"
  # -l Hardlink statt Kopie, -n vorhandene nicht anfassen, -a Aufbau und
  # Zeitstempel mitnehmen. Liegen Spiegel und Speicher wider Erwarten auf
  # verschiedenen Dateisystemen, gehen Hardlinks nicht — dann eben doch
  # kopieren, langsam ist besser als gar nicht.
  cp -aln "$BLOECKE/." "$SPIEGEL/" 2>/dev/null \
    || cp -an "$BLOECKE/." "$SPIEGEL/" 2>/dev/null || true

  # Aufräumen: ein gespiegelter Block darf erst weg, wenn ihn weder der
  # laufende Speicher noch einer der aufgehobenen Datenbankstände noch nennt.
  # Über das Alter der Datei ließe sich das nicht entscheiden — ein Hardlink
  # teilt sich den Zeitstempel mit dem Original und verrät nichts darüber,
  # wann gespiegelt wurde. Die Datenbankstände dagegen sagen es genau.
  ARBEIT="$(mktemp -d)"
  trap 'rm -rf "$ARBEIT"' EXIT
  {
    find "$BLOECKE" -type f -printf '%f\n' 2>/dev/null || true
    for GESICHERT in "$ZIEL"/stellium-*.db.gz; do
      [[ -e "$GESICHERT" ]] || continue
      gunzip -c "$GESICHERT" > "$ARBEIT/stand.db" 2>/dev/null || continue
      sqlite3 "$ARBEIT/stand.db" 'SELECT summe FROM bloecke' 2>/dev/null || true
    done
  } | sort -u > "$ARBEIT/behalten"

  # Das || true ist kein Schmuck: find meldet auch dann einen Fehler, wenn es
  # die Dateien längst gefunden hat — etwa weil es sein Arbeitsverzeichnis
  # nicht zurückstellen konnte oder ein Block-Unterverzeichnis mitten im Lauf
  # verschwand (der Server gibt Blöcke frei, während wir zählen). Mit pipefail
  # bräche das Skript hier ab: die Sicherung wäre geschrieben, aber der
  # Spiegel nie aufgeräumt und LIESMICH.txt nie erneuert — und der Dienst
  # stünde auf "failed", ohne dass etwas fehlte. Das Gegenstück oben ist aus
  # demselben Grund abgesichert.
  find "$SPIEGEL" -type f -printf '%f\n' 2>/dev/null | sort -u > "$ARBEIT/gespiegelt" || true
  comm -23 "$ARBEIT/gespiegelt" "$ARBEIT/behalten" | while read -r SUMME; do
    [[ ${#SUMME} -ge 4 ]] || continue
    rm -f "$SPIEGEL/${SUMME:0:2}/${SUMME:2:2}/$SUMME"
  done
  find "$SPIEGEL" -mindepth 1 -type d -empty -delete 2>/dev/null || true
fi

# Der Hinweis, ohne den eine Sicherung wertlos wäre.
cat > "$ZIEL/LIESMICH.txt" <<'HINWEIS'
Diese Sicherungen enthalten die Datenbank — die Nachrichten darin sind
verschlüsselt.

Zum Wiederherstellen braucht es zusätzlich das Masterpasswort aus

    /etc/stellium.env      (Zeile STELLIUM_MASTER_PASSPHRASE=...)

Ohne dieses Passwort lässt sich keine Nachricht mehr lesen — auch nicht
mit Zugriff auf die Datenbankdatei. Bewahre es getrennt von den
Sicherungen auf, zum Beispiel im Passwortmanager der Firma.

Wiederherstellen:
    sudo systemctl stop stellium
    gunzip -c stellium-JJJJMMTT-HHMM.db.gz > /var/lib/stellium/stellium.db
    sudo chown stellium:stellium /var/lib/stellium/stellium.db
    sudo systemctl start stellium

Hochgeladene Dateien liegen NICHT in der Datenbank, sondern im Ordner
bloecke/ daneben. In der Datenbank steht nur, aus welchen Blöcken eine
Datei besteht. Wer einen alten Datenbankstand zurückspielt, muss die
fehlenden Blöcke mit zurückholen — sonst zeigen die Listen ins Leere:

    sudo systemctl stop stellium
    sudo -u stellium cp -aln bloecke/. /var/lib/stellium/storage/bloecke/
    sudo systemctl start stellium

Das -n ist wichtig: vorhandene Blöcke bleiben, wie sie sind. Sie können
gar nicht falsch sein — der Name eines Blocks ist die Prüfsumme seines
Inhalts.
HINWEIS
SICHERUNG
chmod 755 /usr/local/bin/stellium-sichern

# Die Konsole läuft unter dem Konto der Person am Gerät und muss die Stände
# zählen können — sonst behauptet sie "noch keine", obwohl welche da sind.
# Die Datenbank darin ist verschlüsselt; Lesen genügt und schadet nicht.
install -d -m 750 -o "$BENUTZER" -g "$BENUTZER" /var/lib/stellium/sicherungen
chmod g+rx /var/lib/stellium /var/lib/stellium/sicherungen
[[ -n "${SUDO_USER:-}" ]] && usermod -aG "$BENUTZER" "$SUDO_USER" 2>/dev/null || true

# Besucherzahlen der Website weiterreichen.
#
# Caddy protokolliert ins Journal. Lesen darf das nur, wer in `adm` oder
# `systemd-journal` ist — der Schreibtisch (Konto der Person am Gerät) darf
# es, der Chat-Server läuft als "$BENUTZER" und darf es nicht. Ohne diesen
# Ordner bekommt er überall Nullen, und die sehen aus wie eine Seite ohne
# Besucher statt wie eine Messung, die nicht stattgefunden hat.
#
# Hier landen nur die FERTIGEN SUMMEN — keine Besucherkennung, kein Salz.
# Den rohen Zählstand zu teilen wäre falsch: dort liegen Kennungen und das
# Salz beieinander, und wer beides hat, rechnet die Adressen zurück.
#
# 2750, nicht 750: das setgid-Bit sorgt dafür, dass neue Dateien die Gruppe
# des Ordners erben. Ohne das bekommen sie die Gruppe dessen, der sie
# anlegt, und der Chat-Server kommt trotz passender Ordnerrechte nicht
# heran — gemessen und genau so erlebt.
if [[ -n "${SUDO_USER:-}" ]]; then
  install -d -m 2750 -o "$SUDO_USER" -g "$BENUTZER" /var/lib/stellium-webstat
fi
apt-get install -y -qq sqlite3 >/dev/null

cat > /etc/systemd/system/stellium-sicherung.service <<'DIENST'
[Unit]
Description=Stellium sichern
[Service]
Type=oneshot
User=stellium
ExecStart=/usr/local/bin/stellium-sichern
DIENST

cat > /etc/systemd/system/stellium-sicherung.timer <<'TIMER'
[Unit]
Description=Stellium jede Nacht sichern
[Timer]
OnCalendar=*-*-* 23:00:00
Persistent=true
[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --quiet stellium-sicherung.timer
systemctl start stellium-sicherung.timer
ok "Jede Nacht um 23:00, drei Stände samt Blockspeicher werden aufgehoben"

# ── Fertig ──────────────────────────────────────────────────────
sleep 2
EINMAL="$(journalctl -u stellium --no-pager -n 200 2>/dev/null | grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}' | tail -1 || true)"
KONTO="$(journalctl -u stellium --no-pager -n 200 2>/dev/null | grep -A1 'Benutzername' | tail -1 | awk '{print $NF}' || true)"
if [[ "$PORT_HTTP" == "80" ]]; then LOKAL="http://$(lokale_ip)"
else LOKAL="http://$(lokale_ip):$PORT_HTTP"; fi

if [[ "$WAHL" == "4" ]]; then
  schritt "Tunnel einrichten"
  /usr/local/bin/stellium-tunnel || warn "Der Tunnel wurde nicht fertig eingerichtet — nachholbar mit: sudo stellium-tunnel"
  [[ -r "$DATEN/tunnel-adresse" ]] && ADRESSE="$(cat "$DATEN/tunnel-adresse")"
fi

# Erreicht euch das Team wirklich? Das Zertifikat allein genügt nicht — die
# Verbindung muss auch durch den Router kommen.
VON_AUSSEN_DA=0
if [[ "$WAHL" != "3" && "$WAHL" != "4" ]]; then
  if curl -fsS --max-time 10 -o /dev/null "$ADRESSE/api/health" 2>/dev/null; then
    VON_AUSSEN_DA=1
  fi
fi

cat <<ENDE

${GRUEN}${FETT}   ✓  Fertig.${AUS}

   ${FETT}Verbinden${AUS}
     Von außen   ${BLAU}${ADRESSE}${AUS}
     Im Heimnetz ${GRAU}${LOKAL}${AUS}

     In der App unter ${FETT}Einstellungen → Server${AUS} eintragen.

ENDE

if [[ "$WAHL" != "3" && "$WAHL" != "4" && "$VON_AUSSEN_DA" == "0" ]]; then
  # Erst selbst versuchen, den Router zu überreden — dafür braucht es keinen
  # Zugang zu seiner Oberfläche, sofern UPnP dort nicht abgeschaltet ist.
  schritt "Von außen erreichbar machen"
  if /usr/local/bin/stellium-zugang; then
    VON_AUSSEN_DA=1
  else
    cat <<OFFEN

   ${GELB}${FETT}Von außen kommt noch nichts an.${AUS}

   Das Zertifikat steht und im Heimnetz läuft alles. Es fehlt nur der
   Weg durch den Router — ${FETT}ein${AUS} Port genügt:

       Port ${FETT}${PORT_HTTPS}${AUS}  →  ${FETT}$(lokale_ip)${AUS}   Port ${PORT_HTTPS}   (TCP)

   Bei einer FRITZ!Box: Internet → Freigaben → Portfreigaben →
   Gerät für Freigaben hinzufügen. Sonst heißt es meist
   "Portweiterleitung" oder "Port Forwarding".

   ${GRAU}Kommst du an den Router nicht heran, versuch es später noch
   einmal mit  sudo stellium-zugang  — oder frag nach einem Tunnel,
   dann baut der Pi die Verbindung selbst nach außen auf.

   Im Heimnetz funktioniert Stellium schon jetzt über ${LOKAL}.${AUS}

OFFEN
  fi
fi

if [[ -n "$EINMAL" ]]; then
cat <<ZUGANG
   ${FETT}Erster Zugang${AUS}
     Benutzername    ${FETT}${KONTO:-siehe unten}${AUS}
     Einmal-Passwort ${FETT}${EINMAL}${AUS}

     Beim ersten Anmelden legst du eigenes Passwort, Benutzernamen
     und E-Mail fest. Danach ist dieses Passwort ungültig.

ZUGANG
else
cat <<ZUGANG
   ${FETT}Erster Zugang${AUS}
     ${GRAU}sudo journalctl -u stellium | grep -A6 Einmal${AUS}

ZUGANG
fi

cat <<BEFEHLE
   ${FETT}Befehle${AUS}
     ${BLAU}stellium${AUS}                        Statuskonsole
     ${GRAU}sudo stellium-zugang${AUS}            Ports ohne Router-Zugang öffnen
     ${GRAU}sudo stellium-tunnel${AUS}            Weg nach außen ohne Portfreigabe
     ${GRAU}sudo stellium-update${AUS}            neuen Stand holen und einspielen
     ${GRAU}sudo systemctl restart stellium${AUS} neu starten
     ${GRAU}sudo journalctl -u stellium -f${AUS}  mitlesen
     ${GRAU}sudo stellium-sichern${AUS}           sofort sichern

   Der Server startet bei jedem Neustart von selbst mit.

BEFEHLE

cat <<SCHLUESSEL
   ${FETT}Masterpasswort${AUS}
     Nachrichten liegen verschlüsselt in der Datenbank. Der Schlüssel
     dazu steht in ${FETT}/etc/stellium.env${AUS}.

     ${GELB}Schreibe ihn dir weg — ohne ihn ist keine Sicherung lesbar.${AUS}
     ${GRAU}sudo grep MASTER /etc/stellium.env${AUS}

SCHLUESSEL

if [[ "$WAHL" == "3" ]]; then
  printf '   %s! Diese Einrichtung ist unverschlüsselt. Für den Firmenbetrieb%s\n' "$GELB" "$AUS"
  printf '   %s  später auf Variante 1 oder 2 wechseln — einfach dieses Skript%s\n' "$GELB" "$AUS"
  printf '   %s  noch einmal ausführen.%s\n\n' "$GELB" "$AUS"
fi
