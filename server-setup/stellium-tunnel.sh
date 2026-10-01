#!/usr/bin/env bash
#
# Stellium von außen erreichbar machen, ohne einen Port zu öffnen.
#
# Der Pi baut die Verbindung selbst nach außen auf, statt auf Anfragen zu
# warten. Damit braucht es weder eine Portfreigabe noch Zugang zum Router —
# und es funktioniert auch hinter einem Anschluss ohne eigene öffentliche
# Adresse (CGNAT, DS-Lite).
#
#   sudo stellium-tunnel            fragt, welche Art
#   sudo stellium-tunnel schnell    ohne Konto, Adresse wechselt bei Neustart
#   sudo stellium-tunnel fest       feste Adresse, braucht ein Cloudflare-Konto
#   sudo stellium-tunnel aus        Tunnel wieder abschalten
#   sudo stellium-tunnel adresse    aktuelle Adresse anzeigen
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

[[ $EUID -eq 0 ]] || fehler "Bitte mit sudo starten."

BEFEHL="${1:-}"
DATEN="/var/lib/stellium"
ADRESSDATEI="$DATEN/tunnel-adresse"

# Die Adresse als Besitzer von $DATEN schreiben, nicht als root. Der Ordner
# gehört dem Dienstkonto stellium; ein Verweis, den der Chat-Server dort unter
# "tunnel-adresse" anlegt, lenkte sonst das Schreiben von root auf eine
# beliebige Datei um.
adresse_ablegen() {
  printf '%s\n' "$1" | runuser -u "$(stat -c %U "$DATEN")" -- \
    sh -c 'umask 022 && cat > "$1"' adresse_ablegen "$ADRESSDATEI"
}
GEMERKT="/etc/stellium-einrichtung.conf"
# shellcheck source=/dev/null
[[ -r "$GEMERKT" ]] && . "$GEMERKT"
PORT_HTTP="${STELLIUM_PORT_HTTP:-80}"

TERMINAL=""
if { : < /dev/tty; } 2>/dev/null; then TERMINAL="/dev/tty"; fi
frage() {
  local text="$1" vorgabe="${2:-}" antwort=""
  if [[ -n "$TERMINAL" ]]; then read -rp "  $text" antwort < "$TERMINAL"
  elif [[ -t 0 ]]; then read -rp "  $text" antwort
  else antwort="$vorgabe"; fi
  printf '%s' "$antwort"
}

# ── cloudflared besorgen ────────────────────────────────────────
cloudflared_holen() {
  command -v cloudflared >/dev/null && return 0

  schritt "cloudflared installieren"
  local arch paket
  case "$(dpkg --print-architecture)" in
    arm64) arch="arm64" ;;
    amd64) arch="amd64" ;;
    armhf) arch="arm" ;;
    *) fehler "Für diese Architektur gibt es kein cloudflared." ;;
  esac
  paket="$(mktemp /tmp/cloudflared-XXXX.deb)"
  curl -fsSL -o "$paket" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb" \
    || fehler "Konnte cloudflared nicht laden. Besteht eine Internetverbindung?"
  DEBIAN_FRONTEND=noninteractive dpkg -i "$paket" >/dev/null 2>&1 \
    || fehler "cloudflared ließ sich nicht installieren."
  rm -f "$paket"
  ok "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}')"
}

# nginx so einstellen, dass es den Tunnel bedient: nur auf dem Pi selbst
# erreichbar, ohne Weiterleitung auf HTTPS — die käme vom Tunnel zurück und
# liefe im Kreis. Verschlüsselt wird ohnehin außen, von Cloudflare.
nginx_fuer_tunnel() {
  [[ -d /etc/nginx ]] || return 0
  cat > /etc/nginx/sites-available/stellium <<NGINX
server {
  listen 127.0.0.1:$PORT_HTTP;
  server_name _;

  include snippets/stellium-sicherheit.conf;

  location / {
    include snippets/stellium-proxy.conf;
  }
}
NGINX
  ln -sf /etc/nginx/sites-available/stellium /etc/nginx/sites-enabled/stellium
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
    ok "nginx bedient jetzt den Tunnel"
  else
    warn "nginx-Konfiguration wurde nicht übernommen — der Tunnel geht direkt an den Chat"
  fi
}

# ── Fremde Mitfahrer im Tunnel ──────────────────────────────────
#
# cloudflared ist nicht mehr allein unser Dienst. Auf diesem Pi trägt derselbe
# Tunnel auch stellium.club und www.stellium.club — die Seite eines Kollegen,
# die auf caddy an :8080 läuft. Wer cloudflared abschaltet oder mit
# "cloudflared service install <token>" neu aufsetzt, nimmt ihre öffentliche
# Adresse mit weg, ohne es zu merken: der Dienst läuft danach zwar, aber die
# ingress-Regeln aus /etc/cloudflared/config.yml sind nicht mehr in Gebrauch.
#
# Genau dieselbe Falle stand einmal in dienste/pi-beschleunigen.sh, dort für
# caddy selbst. Siehe FREMDE-DIENSTE.md.
#
# Diese Prüfung zählt die Namen in der Tunnelkonfiguration, die nicht auf
# unseren Chat-Port zeigen. Ist einer dabei, wird nichts angefasst.
CF_KONFIG="/etc/cloudflared/config.yml"

fremde_im_tunnel() {
  [[ -r "$CF_KONFIG" ]] || return 1
  # Jede hostname-Zeile mit dem service, der in der nächsten Zeile steht.
  # Alles, was nicht auf 127.0.0.1:$PORT_HTTP oder :8787 zeigt, ist nicht unseres.
  awk '
    /^[[:space:]]*-[[:space:]]*hostname:/ { name=$NF; next }
    /^[[:space:]]*service:/ && name != "" {
      if ($NF !~ /127\.0\.0\.1:(8787|'"$PORT_HTTP"')$/) print name
      name=""
    }
  ' "$CF_KONFIG"
}

# Bricht ab, wenn cloudflared noch für jemand anderen arbeitet.
cloudflared_ist_unser_allein() {
  local fremde
  fremde="$(fremde_im_tunnel || true)"
  [[ -z "$fremde" ]] && return 0
  warn "cloudflared trägt hier nicht nur den Chat:"
  printf '      %s\n' $fremde
  warn "Diese Namen zeigen auf einen anderen Dienst — laut $CF_KONFIG."
  fehler "Abgebrochen: cloudflared bleibt unangetastet, sonst geht eine fremde Seite vom Netz.
   Nur den Chat aus dem Tunnel nehmen: den Eintrag chat.* aus $CF_KONFIG
   entfernen und  sudo systemctl reload cloudflared."
}

tunnel_aus() {
  # Unser eigener Schnelltunnel darf immer weg — den hat niemand sonst.
  systemctl disable --now stellium-tunnel >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/stellium-tunnel.service "$ADRESSDATEI"
  systemctl daemon-reload

  # cloudflared dagegen nur, wenn wirklich nichts Fremdes daran hängt.
  if systemctl list-unit-files --no-legend 2>/dev/null | grep -q '^cloudflared\.service'; then
    cloudflared_ist_unser_allein
    systemctl disable --now cloudflared >/dev/null 2>&1 || true
  fi
  ok "Tunnel abgeschaltet"
}

# ── Schnelltunnel: ohne Konto, Adresse wechselt ─────────────────
tunnel_schnell() {
  cloudflared_holen
  nginx_fuer_tunnel
  mkdir -p "$DATEN"

  schritt "Schnelltunnel einrichten"
  cat > /etc/systemd/system/stellium-tunnel.service <<DIENST
[Unit]
Description=Stellium — Tunnel nach außen (ohne Konto)
After=network-online.target stellium.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT_HTTP
Restart=always
RestartSec=8
StandardOutput=journal
StandardError=journal
SyslogIdentifier=stellium-tunnel

[Install]
WantedBy=multi-user.target
DIENST

  systemctl daemon-reload
  systemctl enable --quiet stellium-tunnel
  systemctl restart stellium-tunnel

  info "warte auf die Adresse"
  local adresse=""
  for _ in $(seq 1 20); do
    sleep 3
    adresse="$(journalctl -u stellium-tunnel --since '-2min' --no-pager 2>/dev/null \
      | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    [[ -n "$adresse" ]] && break
  done

  [[ -n "$adresse" ]] || fehler "Der Tunnel meldet keine Adresse. Nachsehen: journalctl -u stellium-tunnel -n 40"
  adresse_ablegen "$adresse"

  # Nach jedem Neustart eine neue Adresse — deshalb nachhalten.
  cat > /usr/local/bin/stellium-tunnel-adresse <<'MERK'
#!/usr/bin/env bash
# Schreibt die aktuelle Tunneladresse mit, sie ändert sich bei jedem Neustart.
set -Eeuo pipefail
A="$(journalctl -u stellium-tunnel --since '-10min' --no-pager 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
# Als Besitzer des Ordners geschrieben, nicht als root — siehe
# adresse_ablegen in stellium-tunnel.
[[ -n "$A" ]] || exit 0
printf '%s\n' "$A" | runuser -u "$(stat -c %U /var/lib/stellium)" -- \
  sh -c 'umask 022 && cat > /var/lib/stellium/tunnel-adresse'
MERK
  chmod 755 /usr/local/bin/stellium-tunnel-adresse

  cat > /etc/systemd/system/stellium-tunnel-adresse.timer <<'T'
[Unit]
Description=Tunneladresse nachhalten
[Timer]
OnBootSec=90
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
T
  cat > /etc/systemd/system/stellium-tunnel-adresse.service <<'T2'
[Unit]
Description=Tunneladresse nachhalten
[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-tunnel-adresse
T2
  systemctl daemon-reload
  systemctl enable --quiet stellium-tunnel-adresse.timer
  systemctl start stellium-tunnel-adresse.timer

  ok "Tunnel läuft"
  cat <<FERTIG

   ${GRUEN}${FETT}Erreichbar unter${AUS}

       ${FETT}${BLAU}$adresse${AUS}

   In der App unter ${FETT}Einstellungen → Server${AUS} eintragen.

   ${GELB}Wichtig:${AUS} Diese Adresse ${FETT}ändert sich bei jedem Neustart${AUS} des
   Tunnels. Zum Ausprobieren ist das in Ordnung, für den Dauerbetrieb
   nimm die feste Variante:  ${FETT}sudo stellium-tunnel fest${AUS}

   ${GRAU}Aktuelle Adresse jederzeit:  sudo stellium-tunnel adresse${AUS}

FERTIG
}

# ── Fester Tunnel: eigene Adresse, bleibt ───────────────────────
tunnel_fest() {
  cat <<ANLEITUNG

  ${FETT}Was du bei Cloudflare einmal einrichtest${AUS}  ${GRAU}(kostenlos)${AUS}

    1. Auf ${FETT}one.dash.cloudflare.com${AUS} anmelden oder ein Konto anlegen
    2. Links auf ${FETT}Networks → Tunnels${AUS}, dann ${FETT}Create a tunnel${AUS}
    3. ${FETT}Cloudflared${AUS} wählen, einen Namen vergeben, z.B. stellium
    4. Im nächsten Schritt zeigt Cloudflare einen langen ${FETT}Token${AUS} —
       er steht im angebotenen Befehl hinter ${GRAU}--token${AUS}. Den kopieren.
    5. Danach unter ${FETT}Public Hostname${AUS} eintragen:
         Subdomain   z.B. ${FETT}chat${AUS}
         Domain      deine bei Cloudflare geführte Domain
         Service     ${FETT}HTTP${AUS}  →  ${FETT}127.0.0.1:$PORT_HTTP${AUS}

  ${GRAU}Punkt 5 braucht eine Domain, die bei Cloudflare liegt. Hast du
  keine, nimm vorerst  sudo stellium-tunnel schnell  — das geht ohne
  alles, nur wechselt die Adresse bei jedem Neustart.${AUS}

ANLEITUNG

  local token
  token="$(frage "Token (oder leer zum Abbrechen): ")"
  [[ -n "$token" ]] || fehler "Kein Token — nichts geändert."

  cloudflared_holen
  nginx_fuer_tunnel

  schritt "Tunnel einrichten"
  # "cloudflared service install <token>" schreibt die Einheit neu und stellt
  # den Dienst auf den Token um. Eine vorhandene /etc/cloudflared/config.yml
  # ist danach wirkungslos — samt aller Namen, die dort für andere stehen.
  # Deshalb vorher nachsehen, wer sonst noch mitfährt.
  cloudflared_ist_unser_allein

  systemctl disable --now stellium-tunnel >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/stellium-tunnel.service
  cloudflared service uninstall >/dev/null 2>&1 || true
  cloudflared service install "$token" >/dev/null 2>&1 \
    || fehler "Cloudflare hat den Token nicht angenommen. Stimmt er vollständig?"

  systemctl enable --quiet cloudflared
  systemctl restart cloudflared
  sleep 6

  if systemctl is-active --quiet cloudflared; then
    ok "Tunnel läuft und startet bei jedem Neustart mit"
    local name
    name="$(frage "Unter welcher Adresse hast du ihn veröffentlicht? (z.B. chat.meinefirma.de): ")"
    if [[ -n "$name" ]]; then
      adresse_ablegen "https://${name#https://}"
      cat <<FERTIG

   ${GRUEN}${FETT}Erreichbar unter${AUS}

       ${FETT}${BLAU}https://${name#https://}${AUS}

   In der App unter ${FETT}Einstellungen → Server${AUS} eintragen.
   Die Adresse bleibt, auch nach einem Neustart.

FERTIG
    fi
  else
    fehler "Der Tunneldienst startet nicht. Nachsehen: journalctl -u cloudflared -n 40"
  fi
}

case "$BEFEHL" in
  schnell) tunnel_schnell ;;
  fest)    tunnel_fest ;;
  aus)     tunnel_aus ;;
  adresse)
    [[ -r "$ADRESSDATEI" ]] && cat "$ADRESSDATEI" || { echo "Kein Tunnel eingerichtet."; exit 1; }
    ;;
  *)
    cat <<WAHL

  ${FETT}Ein Tunnel macht Stellium von außen erreichbar, ohne einen Port
  zu öffnen und ohne Zugang zum Router.${AUS}

    ${FETT}1)${AUS} Schnell — ${GRAU}sofort, ohne Konto${AUS}
       Eine Adresse wie ${GRAU}zufall-wort-name.trycloudflare.com${AUS}.
       ${GELB}Sie wechselt bei jedem Neustart des Tunnels.${AUS}
       Gut zum Ausprobieren.

    ${FETT}2)${AUS} Fest — ${GRUEN}für den Dauerbetrieb${AUS}
       Eine eigene Adresse, die bleibt. Kostenlos, braucht aber ein
       Cloudflare-Konto und eine dort geführte Domain.

WAHL
    case "$(frage "Deine Wahl [1/2]: ")" in
      1) tunnel_schnell ;;
      2) tunnel_fest ;;
      *) fehler "Nichts geändert." ;;
    esac
    ;;
esac
