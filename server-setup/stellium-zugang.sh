#!/usr/bin/env bash
#
# Versucht, den Pi von außen erreichbar zu machen — ohne dass du an den Router
# musst. Zwei Wege, in dieser Reihenfolge:
#
#   1. Den Router selbst darum bitten (UPnP, sonst NAT-PMP). Viele Router
#      haben das ab Werk an; dann geht es ohne Anmeldung an der Oberfläche.
#   2. Feststellen, ob es überhaupt gehen kann — hinter einem Anschluss ohne
#      eigene öffentliche Adresse (CGNAT) hilft auch keine Freigabe.
#
#   sudo stellium-zugang
#
set -Eeuo pipefail

if [[ -t 1 ]]; then
  ROT=$'\e[31m'; GRUEN=$'\e[32m'; GELB=$'\e[33m'; BLAU=$'\e[38;5;99m'
  FETT=$'\e[1m'; AUS=$'\e[0m'
else
  ROT=''; GRUEN=''; GELB=''; BLAU=''; FETT=''; AUS=''
fi
schritt() { printf '\n%s▸ %s%s\n' "$BLAU$FETT" "$*" "$AUS"; }
info()    { printf '  %s\n' "$*"; }
ok()      { printf '  %s✓%s %s\n' "$GRUEN" "$AUS" "$*"; }
warn()    { printf '  %s!%s %s\n' "$GELB" "$AUS" "$*"; }

[[ $EUID -eq 0 ]] || { printf '%sBitte mit sudo starten.%s\n' "$ROT" "$AUS"; exit 1; }

GEMERKT="/etc/stellium-einrichtung.conf"
# shellcheck source=/dev/null
[[ -r "$GEMERKT" ]] && . "$GEMERKT"
PORT_HTTP="${STELLIUM_PORT_HTTP:-80}"
PORT_HTTPS="${STELLIUM_PORT_HTTPS:-443}"
DOMAIN="${STELLIUM_DOMAIN:-}"

# Der SSH-Port kommt dazu, sobald er eingerichtet ist. Ohne Einrichtung wird
# er auch nicht freigegeben — ein offener Port ohne Dienst dahinter nützt
# niemandem und ist nur eine weitere Tür.
PORT_SSH=""
if systemctl is-active --quiet ssh 2>/dev/null || systemctl is-active --quiet sshd 2>/dev/null; then
  # Einmal abfragen und dann aus dem Text lesen. Direkt in `awk … exit` bzw.
  # `grep -q` geleitet, kann sshd beim Weiterschreiben an SIGPIPE sterben —
  # mit pipefail brach dann das ganze Skript still ab (Zuweisung), oder der
  # Schlüsselzwang galt als nicht gesetzt und der SSH-Port fiel weg.
  SSHD_T="$(sshd -T 2>/dev/null || true)"
  PORT_SSH="$(awk '/^port /{print $2; exit}' <<<"$SSHD_T")"
  # Nur mit Schlüsselzwang nach draußen. Ein Port mit Passwort-Anmeldung
  # wäre binnen Stunden im Visier jedes Scanners.
  if [[ -n "$PORT_SSH" ]] && ! grep -qi '^passwordauthentication no' <<<"$SSHD_T"; then
    PORT_SSH=""
  fi
fi

lokale_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  [[ -z "$ip" ]] && ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')" || true
  printf '%s' "${ip:-}"
}

IP="$(lokale_ip)"
[[ -n "$IP" ]] || { warn "Keine Adresse im Heimnetz gefunden."; exit 1; }

schritt "Werkzeuge"
if ! command -v upnpc >/dev/null || ! command -v natpmpc >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq miniupnpc natpmpc >/dev/null 2>&1 \
    || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq miniupnpc >/dev/null 2>&1 || true
fi
command -v upnpc >/dev/null && ok "miniupnpc" || warn "miniupnpc fehlt"
command -v natpmpc >/dev/null && ok "natpmpc" || info "natpmpc nicht verfügbar — kein Beinbruch"

# ── Wie sieht die Welt den Anschluss? ──────────────────────────
schritt "Anschluss prüfen"
OEFFENTLICH="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
[[ -n "$OEFFENTLICH" ]] && info "Von außen seid ihr ${FETT}$OEFFENTLICH${AUS}"

ROUTER_AUSSEN="$(upnpc -s 2>/dev/null | sed -n 's/.*ExternalIPAddress = //p' | head -1 || true)"
if [[ -n "$ROUTER_AUSSEN" ]]; then
  info "Dein Router hält sich für $ROUTER_AUSSEN"
  if [[ -n "$OEFFENTLICH" && "$ROUTER_AUSSEN" != "$OEFFENTLICH" ]]; then
    warn "Die beiden stimmen nicht überein."
    cat <<HINWEIS_CGNAT

  ${GELB}${FETT}Dein Anschluss hat keine eigene öffentliche Adresse.${AUS}

  Dein Provider teilt eine Adresse unter vielen Kunden auf — das heißt
  CGNAT oder DS-Lite. Eine Portfreigabe im Router würde daran nichts
  ändern: die Anfragen kommen gar nicht erst bei euch an.

  ${FETT}Was hilft:${AUS}
    · Beim Provider eine öffentliche IPv4-Adresse beantragen. Bei den
      meisten ist das kostenlos, dauert aber ein paar Tage.
    · Oder einen Tunnel benutzen — dabei baut der Pi die Verbindung
      nach außen auf, statt auf Anfragen zu warten. Dann ist keine
      Freigabe nötig und auch kein Router-Zugang.
      Sag Bescheid, dann richte ich das ein.

HINWEIS_CGNAT
    exit 2
  fi
  ok "Der Router hat eine echte öffentliche Adresse"
fi

# ── Freigabe erbitten ──────────────────────────────────────────
schritt "Router um die Freigabe bitten"
GELUNGEN=0

if command -v upnpc >/dev/null; then
  for PORT in "$PORT_HTTP" "$PORT_HTTPS" ${PORT_SSH:+$PORT_SSH}; do
    if upnpc -e "Stellium" -a "$IP" "$PORT" "$PORT" TCP 86400 >/dev/null 2>&1 \
       || upnpc -e "Stellium" -a "$IP" "$PORT" "$PORT" TCP >/dev/null 2>&1; then
      ok "Port $PORT über UPnP freigegeben"
      GELUNGEN=1
    else
      info "Port $PORT über UPnP: abgelehnt"
    fi
  done
fi

if [[ $GELUNGEN -eq 0 ]] && command -v natpmpc >/dev/null; then
  for PORT in "$PORT_HTTP" "$PORT_HTTPS" ${PORT_SSH:+$PORT_SSH}; do
    if natpmpc -a "$PORT" "$PORT" tcp 86400 >/dev/null 2>&1; then
      ok "Port $PORT über NAT-PMP freigegeben"
      GELUNGEN=1
    fi
  done
fi

if [[ $GELUNGEN -eq 0 ]]; then
  cat <<KEINE

  ${GELB}${FETT}Der Router lässt nicht mit sich reden.${AUS}

  Fast immer ist UPnP darin abgeschaltet. Ohne Zugang zur Oberfläche
  bleibt dann nur ein Tunnel: der Pi baut die Verbindung nach außen
  auf, statt auf Anfragen zu warten. Keine Freigabe, kein Router.

  Sag Bescheid, dann richte ich das ein.

KEINE
  exit 3
fi

# ── Hat es gewirkt? ────────────────────────────────────────────
schritt "Nachsehen, ob es angekommen ist"
sleep 8
ERREICHT=0
if [[ -n "$DOMAIN" ]]; then
  ZIEL="https://$DOMAIN"
  [[ "$PORT_HTTPS" != "443" ]] && ZIEL="https://$DOMAIN:$PORT_HTTPS"
  for _ in 1 2 3; do
    if curl -fsS --max-time 10 -o /dev/null "$ZIEL/api/health" 2>/dev/null; then ERREICHT=1; break; fi
    sleep 6
  done
fi

if [[ $ERREICHT -eq 1 ]]; then
  ok "$ZIEL ist von außen erreichbar"

  # UPnP-Freigaben laufen ab — stündlich erneuern.
  cat > /etc/systemd/system/stellium-zugang.service <<'D1'
[Unit]
Description=Portfreigabe im Router erneuern
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-zugang
D1
  cat > /etc/systemd/system/stellium-zugang.timer <<'D2'
[Unit]
Description=Portfreigabe stündlich erneuern
[Timer]
OnBootSec=90
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
D2
  systemctl daemon-reload
  systemctl enable --quiet stellium-zugang.timer
  systemctl start stellium-zugang.timer
  ok "Die Freigabe wird stündlich erneuert, damit sie nicht abläuft"
  printf '\n   %sFertig. Euer Team erreicht Stellium unter %s%s%s\n\n' "$GRUEN" "$FETT" "$ZIEL" "$AUS"
else
  warn "Der Router meldet Vollzug, aber von außen kommt trotzdem nichts an."
  info "Möglich ist beides: die Freigabe wirkt noch nicht, oder eine zweite"
  info "Stelle blockiert — etwa eine Firewall beim Provider."
  info "Probier es in ein paar Minuten noch einmal:  sudo stellium-zugang"
  exit 4
fi
