#!/usr/bin/env bash
#
# Schreibt einen Zettel, auf dem steht, wo dieser Pi gerade von außen zu
# erreichen ist.
#
# Warum es diesen Zettel braucht: die Weiterleitung im Router ist nicht fest
# eingetragen, sie wird alle 20 Minuten per NAT-PMP erbeten. Der Router darf
# dabei ausweichen — ist der gewünschte äußere Port belegt, bekommt man einen
# anderen. Nach einem Neustart des Routers passiert genau das, und ab da weiß
# niemand mehr, welcher Port es ist: der Mac verbindet ins Leere, und wer nicht
# im Heimnetz steht, kann auch nicht nachsehen.
#
# Also führt der Pi selbst Buch. Der Zettel liegt dort, wo der Server seine
# Oberfläche ausliefert, und ist damit über dieselbe HTTPS-Adresse abrufbar,
# die ohnehin jeder kennt. Aus ihm holt sich der Mac den aktuellen Port
# (siehe mac-ssh-config.sh).
#
# Darin steht nichts Geheimes: Adresse, Portnummer, Zeit. Alle drei Angaben
# erfährt ohnehin jeder, der den Port einmal anspricht. Kein Benutzername,
# kein Schlüssel, kein Fingerabdruck.
#
# Zweite Aufgabe nebenbei: hat der Router den Port verlegt, wird die
# Auffrischung (stellium-ssh-port.service) auf die neue Nummer umgeschrieben.
# Sonst frischte sie stur eine Zuordnung auf, die es nicht mehr gibt.
#
set -Eeuo pipefail

DIENST=/etc/systemd/system/stellium-ssh-port.service
DATEN="${STELLIUM_DATA:-/var/lib/stellium}"
ZETTEL="$DATEN/zugang.json"
OBERFLAECHE="${STELLIUM_WEB_DIR:-/opt/stellium/packages/desktop/dist}"

[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo starten." >&2; exit 1; }

# Meldungen gehen ins Journal, nicht auf einen Bildschirm — dieses Skript
# läuft alle zehn Minuten aus einem Timer heraus und sieht nie jemand live.
sagen() { logger -t stellium-zugang-melden "$*"; printf '  %s\n' "$*"; }

# ── Wohin zeigt die Weiterleitung nach innen? ───────────────────
#
# Die 22 ist nur die übliche Wahl, nicht die garantierte; auf diesem Pi ist es
# die 2222. Was wirklich gilt, sagt der Dienst selbst.
innen_finden() {
  local p
  p="$(ss -ltnp 2>/dev/null | awk '/sshd/ {split($4,a,":"); print a[length(a)]}' | sort -un | head -1)"
  [[ -z "$p" ]] && p="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
  printf '%s' "${p:-22}"
}
INNEN="$(innen_finden)"

# ── Welchen äußeren Port wünschen wir uns? ──────────────────────
#
# Den, der zuletzt galt. Steht er in der Auffrischung, ist er die beste
# Auskunft; sonst der Vorgabewert aus ssh-zugang.sh.
# Die Zeile lautet "ExecStart=/usr/bin/natpmpc -a <außen> <innen> tcp 3600".
# Gesucht ist die Zahl direkt hinter dem -a — nach Feldnummer zu greifen ginge
# schief, sobald jemand den Pfad ändert oder eine Angabe dazukommt.
WUNSCH="$(awk '/^ExecStart=/{for (i = 1; i < NF; i++) if ($i == "-a") { print $(i + 1); exit }}' \
  "$DIENST" 2>/dev/null | head -1)"
[[ "$WUNSCH" =~ ^[0-9]+$ ]] || WUNSCH=2222

# ── Den Router fragen ───────────────────────────────────────────
#
# natpmpc sagt in seiner Antwort, welchen äußeren Port er tatsächlich vergeben
# hat. Das ist die einzige verlässliche Quelle — was wir uns gewünscht haben,
# zählt nicht.
ANTWORT="$(natpmpc -a "$WUNSCH" "$INNEN" tcp 3600 2>&1 || true)"
AUSSEN="$(printf '%s' "$ANTWORT" | sed -n 's/.*public port \([0-9]\{1,\}\).*/\1/p' | tail -1)"

if [[ -z "$AUSSEN" ]]; then
  # Kein Grund, den alten Zettel wegzuwerfen: seine Angaben sind vermutlich
  # noch richtig, und ein leerer Zettel hilft niemandem. Dass etwas klemmt,
  # verrät die Zeitangabe darin von selbst — sie altert.
  sagen "Der Router antwortet nicht. Der bisherige Zettel bleibt stehen."
  exit 0
fi

# ── Auffrischung nachziehen, falls der Port gewandert ist ───────
if [[ -f "$DIENST" && "$AUSSEN" != "$WUNSCH" ]]; then
  sagen "Der Router hat den Port von $WUNSCH auf $AUSSEN verlegt — Auffrischung wird umgestellt."
  sed -i "s|^ExecStart=.*|ExecStart=/usr/bin/natpmpc -a $AUSSEN $INNEN tcp 3600|" "$DIENST"
  systemctl daemon-reload
  systemctl restart stellium-ssh-port.timer >/dev/null 2>&1 || true
fi

# ── Unter welchem Namen ist der Pi zu finden? ───────────────────
#
# Die DuckDNS-Adresse. ACHTUNG, Stand 20.08.2026: auf diesem Pi hält sie
# niemand mehr aktuell — beim Umzug auf den Cloudflare-Tunnel wurden
# stellium-duckdns.service und .timer entfernt. Solange sich die Adresse des
# Anschlusses nicht ändert, stimmt der Name; ändert sie sich, zeigt er ins
# Leere, und dieser Zettel weist auf einen Anschluss, der nicht mehr antwortet.
# Verlässlich ist der Weg über Tailscale (siehe mac-ssh-config.sh) oder über
# den Tunnel (fernzugang/ssh-durch-tunnel.sh).
# Ohne Einrichtung bleibt nur die öffentliche Adresse selbst.
HOST=""
if [[ -r /etc/stellium-einrichtung.conf ]]; then
  # shellcheck source=/dev/null
  HOST="$(. /etc/stellium-einrichtung.conf 2>/dev/null; printf '%s' "${STELLIUM_DOMAIN:-}")"
fi
[[ -z "$HOST" ]] && HOST="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
[[ -z "$HOST" ]] && { sagen "Weder Domain noch öffentliche Adresse bekannt — Zettel bleibt stehen."; exit 0; }

# ── Zettel schreiben ────────────────────────────────────────────
#
# Erst daneben schreiben, dann umbenennen: wer im selben Moment liest, bekommt
# entweder den alten oder den neuen Zettel, niemals einen halben.
JETZT="$(date +%s)"
INHALT="$(printf '{\n  "host": "%s",\n  "port": %s,\n  "zeit": "%s",\n  "zeitStempel": %s\n}\n' \
  "$HOST" "$AUSSEN" "$(date -u -d "@$JETZT" +%Y-%m-%dT%H:%M:%SZ)" "$((JETZT * 1000))")"

ablegen() {
  local ziel="$1" ordner besitzer
  ordner="$(dirname "$ziel")"
  [[ -d "$ordner" ]] || return 0
  # Geschrieben wird als der, dem der Ordner gehört — nicht als root. Beide
  # Ordner gehören dem Konto stellium, und darin konnte der Chat-Server vorher
  # unter "zugang.json.neu" einen Verweis auf eine beliebige Datei anlegen:
  # root schrieb dann alle zehn Minuten den Zettel hinein und übergab sie per
  # chmod/chown dem Dienstkonto — /etc/shadow etwa. Als Besitzer geschrieben
  # gehört die Datei dem Server ohnehin, und ein Verweis führt nirgends hin,
  # wo er nicht schon selbst schreiben darf.
  besitzer="$(stat -c %U "$ordner")"
  printf '%s\n' "$INHALT" | runuser -u "$besitzer" -- \
    sh -c 'umask 022 && cat > "$1.neu" && mv -f "$1.neu" "$1"' ablegen "$ziel"
}

ablegen "$ZETTEL"

# Dieselbe Datei noch einmal dort, wo die Oberfläche liegt. Ein Update baut
# dieses Verzeichnis neu und nimmt den Zettel mit — deshalb legt der Timer ihn
# alle zehn Minuten erneut hin, statt sich auf einen einmaligen Wurf zu
# verlassen.
ablegen "$OBERFLAECHE/zugang.json"

sagen "$HOST:$AUSSEN (innen $INNEN)"
