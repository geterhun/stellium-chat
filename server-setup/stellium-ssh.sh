#!/usr/bin/env bash
#
# SSH auf dem Pi sicher für den Zugriff von außen einrichten.
#
#   sudo bash stellium-ssh.sh 'ssh-ed25519 AAAA... kommentar'
#
# Legt den Schlüssel ab, schaltet Passwörter ab, verlegt SSH auf einen
# unauffälligen Port und stellt eine Bremse gegen Durchprobieren auf.
#
# Wichtig: das Skript trennt die laufende Sitzung nicht. Prüfe die neue
# Verbindung in einem zweiten Fenster, bevor du dieses hier schließt.
#
set -Eeuo pipefail

if [[ -t 1 ]]; then
  ROT=$'\e[31m'; GRUEN=$'\e[32m'; GELB=$'\e[33m'; BLAU=$'\e[38;5;99m'
  GRAU=$'\e[90m'; FETT=$'\e[1m'; AUS=$'\e[0m'
else
  ROT=''; GRUEN=''; GELB=''; BLAU=''; GRAU=''; FETT=''; AUS=''
fi
schritt() { printf '\n%s▸ %s%s\n' "$BLAU$FETT" "$*" "$AUS"; }
ok()      { printf '  %s✓%s %s\n' "$GRUEN" "$AUS" "$*"; }
info()    { printf '  %s%s%s\n' "$GRAU" "$*" "$AUS"; }
warn()    { printf '  %s!%s %s\n' "$GELB" "$AUS" "$*"; }
fehler()  { printf '\n%s✗ %s%s\n\n' "$ROT$FETT" "$*" "$AUS" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fehler "Bitte mit sudo starten."

SCHLUESSEL="${1:-}"
PORT="${STELLIUM_SSH_PORT:-2222}"
KONTO="${SUDO_USER:-$(logname 2>/dev/null || echo pi)}"
HEIM="$(getent passwd "$KONTO" | cut -d: -f6)"
[[ -d "$HEIM" ]] || fehler "Kein Heimatverzeichnis für $KONTO gefunden."

printf '\n%s✦  SSH einrichten für %s%s\n' "$BLAU$FETT" "$KONTO" "$AUS"

# ── Schlüssel ablegen ───────────────────────────────────────────
schritt "Schlüssel"
if [[ -z "$SCHLUESSEL" ]]; then
  if [[ -s "$HEIM/.ssh/authorized_keys" ]]; then
    info "Kein Schlüssel übergeben — die vorhandenen bleiben."
  else
    fehler "Kein Schlüssel übergeben und keiner hinterlegt.
    So geht es:  sudo bash $0 'ssh-ed25519 AAAA... dein-kommentar'"
  fi
else
  [[ "$SCHLUESSEL" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-) ]] \
    || fehler "Das sieht nicht nach einem öffentlichen Schlüssel aus."
  install -d -m 700 -o "$KONTO" -g "$KONTO" "$HEIM/.ssh"
  touch "$HEIM/.ssh/authorized_keys"
  if grep -qF "$SCHLUESSEL" "$HEIM/.ssh/authorized_keys"; then
    info "Der Schlüssel war schon eingetragen."
  else
    printf '%s\n' "$SCHLUESSEL" >> "$HEIM/.ssh/authorized_keys"
    ok "eingetragen"
  fi
  chown "$KONTO:$KONTO" "$HEIM/.ssh/authorized_keys"
  chmod 600 "$HEIM/.ssh/authorized_keys"
fi

# ── Dienst einschalten ──────────────────────────────────────────
schritt "Dienst"
systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1
ok "läuft"

# ── Absichern ───────────────────────────────────────────────────
schritt "Absichern"
EINSTELLUNGEN=/etc/ssh/sshd_config.d/stellium.conf
install -d -m 755 /etc/ssh/sshd_config.d
cat > "$EINSTELLUNGEN" <<CONF
# Von stellium-ssh.sh angelegt.
#
# Ein Port im Internet wird rund um die Uhr durchprobiert. Deshalb: keine
# Passwörter (nur Schlüssel), kein root, und ein Port abseits der 22 — das
# hält schon den größten Teil des Grundrauschens fern.
Port $PORT
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 20
AllowUsers $KONTO
CONF
ok "nur Schlüssel, kein root, Port $PORT"

if sshd -t 2>/dev/null; then
  # Den neuen Port in der Firewall freigeben, BEVOR SSH umzieht. Der
  # Installer schaltet ufw scharf und lässt nur die Ports durch, auf denen
  # sshd damals hörte — ohne diese Zeile wäre nach dem Neustart jede neue
  # Verbindung ausgesperrt.
  if command -v ufw >/dev/null 2>&1; then
    ufw allow "$PORT/tcp" >/dev/null 2>&1 || warn "ufw: Port $PORT ließ sich nicht freigeben"
  fi
  systemctl restart ssh 2>/dev/null || systemctl restart sshd
  ok "übernommen — die laufende Sitzung bleibt bestehen"
else
  rm -f "$EINSTELLUNGEN"
  fehler "Die Einstellungen sind fehlerhaft und wurden verworfen."
fi

# ── Bremse gegen Durchprobieren ─────────────────────────────────
schritt "Bremse"
if ! command -v fail2ban-server >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban >/dev/null 2>&1 \
    && ok "fail2ban installiert" || warn "fail2ban ließ sich nicht installieren"
fi
if command -v fail2ban-server >/dev/null 2>&1; then
  cat > /etc/fail2ban/jail.d/stellium-ssh.conf <<JAIL
[sshd]
enabled = true
port    = $PORT
maxretry = 4
findtime = 600
bantime  = 3600
JAIL
  systemctl enable --now fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban >/dev/null 2>&1 || true
  ok "vier Fehlversuche, dann eine Stunde Pause"
fi

# ── Was jetzt noch fehlt ────────────────────────────────────────
LOKAL="$(hostname -I | awk '{print $1}')"
cat <<ENDE

${GRUEN}${FETT}   SSH ist bereit.${AUS}

   ${FETT}Im Router noch eine Weiterleitung eintragen:${AUS}
     ${GRAU}extern${AUS}  TCP $PORT
     ${GRAU}intern${AUS}  $LOKAL Port $PORT

   ${FETT}Danach vom Mac:${AUS}
     ${BLAU}ssh -p $PORT $KONTO@deine-adresse.duckdns.org${AUS}

   ${GELB}Prüfe das in einem zweiten Fenster, bevor du dieses schließt.${AUS}
   Klappt es nicht, hilft:  ${GRAU}sudo rm $EINSTELLUNGEN && sudo systemctl restart ssh${AUS}

ENDE
