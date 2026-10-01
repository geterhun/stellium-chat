#!/usr/bin/env bash
#
# SSH durch den Cloudflare-Tunnel — der Weg, der ohne Router auskommt.
#
# Warum das nötig ist: der bisherige Zugang hing an drei Dingen, die alle
# ausfallen können und von denen keines uns gehört — der Heimadresse des
# Anschlusses, einer Portfreigabe im Router (NAT-PMP, Pacht läuft ab) und dem
# Namen stellium-chat.duckdns.org. Seit dem Umzug auf den Tunnel pflegt
# niemand mehr den DuckDNS-Namen: wechselt die Adresse des Anschlusses, zeigt
# er ins Leere, und der einzige Weg auf den Pi ist zu. Der Chat merkt davon
# nichts, weil er längst durch den Tunnel geht. SSH ging es nicht.
#
# Der Tunnel baut die Verbindung von innen nach außen auf. Kein offener Port,
# keine feste Adresse, kein Router.
#
#   sudo bash ssh-durch-tunnel.sh            einrichten
#   sudo bash ssh-durch-tunnel.sh zurueck    rückgängig
#   sudo bash ssh-durch-tunnel.sh pruefen    nur nachsehen, nichts ändern
#
# ─────────────────────────────────────────────────────────────────────────
# DIE WICHTIGSTE AUFLAGE
#
# /etc/cloudflared/config.yml gehört nicht uns allein. Derselbe Tunnel trägt
# stellium.club und www.stellium.club — die Seite eines Kollegen, die auf
# caddy an :8080 läuft. Dieses Skript **fügt eine Regel hinzu und ersetzt
# nichts**. Es sichert vorher, prüft mit "cloudflared tunnel ingress validate",
# und spielt bei jedem Zweifel zurück. Siehe ../FREMDE-DIENSTE.md.
# ─────────────────────────────────────────────────────────────────────────
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

# Überschreibbar, damit sich der Lauf an einer Kopie erproben lässt, ohne die
# echte Tunnelkonfiguration anzufassen.
KONFIG="${STELLIUM_CF_KONFIG:-/etc/cloudflared/config.yml}"
NAME="${STELLIUM_SSH_NAME:-ssh.stellium.club}"
STAND="$(date +%Y%m%d-%H%M%S)"
SICHERUNG="$KONFIG.vor-ssh-$STAND"

# ── Anleitung für die Gegenstelle ───────────────────────────────
mac_anleitung() {
  cat <<ANLEITUNG

   ${FETT}Auf dem Mac, einmalig:${AUS}

       brew install cloudflared

   ${FETT}Dann in ~/.ssh/config eintragen:${AUS}

       Host stellium-tunnel
         HostName $NAME
         User aryan
         Port $SSH_PORT
         IdentityFile ~/.ssh/stellium
         IdentitiesOnly yes
         ProxyCommand cloudflared access ssh --hostname %h

   ${FETT}Und herein mit:${AUS}

       ${BLAU}ssh stellium-tunnel${AUS}

ANLEITUNG
}

# ── Zustand vorher festhalten ───────────────────────────────────
# Ohne Messung vorher ist "es geht noch" nach dem Eingriff eine Behauptung.
gesund() {
  local was="$1" ziel="$2" code
  code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$ziel" 2>/dev/null || echo 000)"
  printf '%s' "$code"
}

zeige_gesundheit() {
  local marke="$1"
  info "$marke:"
  info "   caddy (:8080, Kollege) ....... $(gesund caddy http://127.0.0.1:8080/)   [systemctl: $(systemctl is-active caddy 2>/dev/null || echo '?')]"
  info "   stellium.club (Kollege) ...... $(gesund seite https://stellium.club/)"
  info "   chat.stellium.club (wir) ..... $(gesund chat https://chat.stellium.club/)"
}

# Nach einem Neustart braucht cloudflared ein paar Sekunden, bis alle vier
# Verbindungen zum Rand wieder stehen. Wer einmal misst und sofort urteilt,
# hält genau dieses Fenster für einen Schaden und spielt grundlos zurück —
# beim Erproben ist mir genau das passiert. Deshalb: mehrfach nachsehen.
warte_bis_gesund() {
  local ziel="$1" versuche="${2:-12}" i code
  for ((i = 1; i <= versuche; i++)); do
    code="$(gesund x "$ziel")"
    [[ "$code" == "200" ]] && { printf '%s' "$code"; return 0; }
    sleep 5
  done
  printf '%s' "$code"
  return 1
}

# ── SSH-Port ermitteln, nicht annehmen ──────────────────────────
# "|| true": scheitert `sshd -T`, brach das Skript unter pipefail an dieser
# Zuweisung wortlos ab, und die 22 darunter kam nie zum Zug.
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | head -1 || true)"
[[ -z "$SSH_PORT" ]] && SSH_PORT=22

# ── Nur nachsehen ───────────────────────────────────────────────
if [[ "${1:-}" == "pruefen" ]]; then
  schritt "Zustand"
  info "sshd hört auf Port ......... $SSH_PORT"
  info "Tunnelkonfiguration ........ $KONFIG"
  if grep -q "$NAME" "$KONFIG" 2>/dev/null; then
    ok "SSH-Regel für $NAME ist eingetragen"
  else
    warn "SSH-Regel für $NAME fehlt noch"
  fi
  info "tailscaled ................. $(systemctl is-active tailscaled 2>/dev/null || echo '?') / $(systemctl is-enabled tailscaled 2>/dev/null || echo '?')"
  zeige_gesundheit "Erreichbarkeit"
  echo
  info "Namen im Tunnel:"
  grep -E '^\s*-\s*hostname:' "$KONFIG" 2>/dev/null | sed 's/^/     /' || true
  exit 0
fi

# ── Rückweg ─────────────────────────────────────────────────────
if [[ "${1:-}" == "zurueck" ]]; then
  schritt "SSH wieder aus dem Tunnel nehmen"
  LETZTE="$(ls -1t "$KONFIG".vor-ssh-* 2>/dev/null | head -1 || true)"
  [[ -n "$LETZTE" ]] || fehler "Keine Sicherung gefunden — von Hand die Zeilen mit $NAME entfernen."
  cp -a "$KONFIG" "$KONFIG.vor-ruecknahme-$STAND"
  cp -a "$LETZTE" "$KONFIG"
  if cloudflared tunnel --config "$KONFIG" ingress validate >/dev/null 2>&1; then
    systemctl restart cloudflared
    warte_bis_gesund https://stellium.club/ 12 >/dev/null || true
    ok "Zurückgespielt aus $LETZTE"
    zeige_gesundheit "Danach"
  else
    cp -a "$KONFIG.vor-ruecknahme-$STAND" "$KONFIG"
    fehler "Die zurückgespielte Fassung ist selbst ungültig — nichts geändert."
  fi
  exit 0
fi

# ── Voraussetzungen ─────────────────────────────────────────────
schritt "Voraussetzungen"
command -v cloudflared >/dev/null || fehler "cloudflared ist nicht installiert."
[[ -r "$KONFIG" ]] || fehler "$KONFIG gibt es nicht — dieser Pi läuft nicht über einen benannten Tunnel."
ok "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}')"
ok "sshd hört auf Port $SSH_PORT"

# Die fremden Namen benennen, damit klar ist, was hier auf dem Spiel steht.
FREMD="$(grep -E '^\s*-\s*hostname:' "$KONFIG" | awk '{print $NF}' | grep -v '^chat\.' || true)"
if [[ -n "$FREMD" ]]; then
  warn "In diesem Tunnel fahren auch fremde Namen mit:"
  printf '      %s\n' $FREMD
  info "Sie werden nicht angefasst. Diese Einrichtung fügt nur hinzu."
fi

zeige_gesundheit "Vorher"
VORHER_CADDY="$(gesund caddy http://127.0.0.1:8080/)"
VORHER_SEITE="$(gesund seite https://stellium.club/)"

# ── Schon da? ───────────────────────────────────────────────────
if grep -q "hostname: *$NAME" "$KONFIG"; then
  ok "Die Regel für $NAME steht schon da — nichts zu tun."
  schritt "So kommst du herein"
  mac_anleitung
  exit 0
fi

# ── Was das den Kollegen kostet ─────────────────────────────
schritt "Bevor es losgeht"
warn "Diese Aenderung kostet eine kurze Unterbrechung — auch fuer den Kollegen."
info "cloudflared kennt kein sanftes Nachladen (die Einheit hat kein ExecReload)."
info "Die neue Regel wird erst nach einem Neustart des Dienstes wirksam. Gemessen"
info "am 20.08.: rund sieben Sekunden, in denen stellium.club und chat.stellium.club"
info "mit 502 antworten. Danach ist alles wie vorher, plus SSH."
info ""
info "Deshalb: zu einer ruhigen Zeit ausfuehren, nicht mitten im Arbeitstag."
if [[ "${1:-}" != "jetzt" ]]; then
  if [[ -t 0 ]]; then
    read -rp "  Fortfahren? [ja/nein]: " ANTWORT
    [[ "$ANTWORT" == "ja" ]] || fehler "Abgebrochen — nichts geaendert."
  else
    fehler "Ohne Rueckfragemoeglichkeit abgebrochen. Wenn es jetzt passen soll:
   sudo bash ssh-durch-tunnel.sh jetzt"
  fi
fi

# ── Sichern ─────────────────────────────────────────────────────
schritt "Sichern"
cp -a "$KONFIG" "$SICHERUNG"
ok "Sicherung: $SICHERUNG"

# ── Regel einfügen (nur einfügen!) ──────────────────────────────
schritt "SSH-Regel einfügen"
NEU="$(mktemp)"
trap 'rm -f "$NEU"' EXIT

# Die Regel muss VOR die Auffangregel (http_status:404). Alles dahinter wird
# nie erreicht. Python fügt zeilenweise ein und lässt den Rest der Datei
# Byte für Byte, wie er ist — Kommentare der Kollegen eingeschlossen.
( python3 - "$KONFIG" "$NEU" "$NAME" "$SSH_PORT" <<'PYENDE'
import re, sys
quelle, ziel, name, port = sys.argv[1:5]
text = open(quelle, encoding="utf-8").read()
if re.search(r'hostname:\s*' + re.escape(name), text):
    sys.exit(3)
zeilen = text.splitlines(True)
stelle = None
for i, z in enumerate(zeilen):
    if re.match(r'^\s*-\s*service:\s*http_status:', z):
        stelle = i
        break
if stelle is None:
    sys.exit(4)
# Vor der Auffangregel steht ihr eigener Kommentar. Wer mittendrin einfuegt,
# haengt der neuen Regel eine Erklaerung an, die von etwas anderem handelt.
# Deshalb rueckwaerts ueber Kommentar- und Leerzeilen hinweg.
while stelle > 0 and re.match(r'^\s*(#.*)?$', zeilen[stelle - 1]):
    stelle -= 1
# [ \t] statt \s: \s schliesst den Zeilenumbruch ein, und auf einer Leerzeile
# waere der Einzug dann "\n" — die Regel bekaeme einen Umbruch vorangestellt
# statt Leerzeichen. Genau das ist beim Erproben herausgekommen.
einzug = re.match(r'^([ \t]*)', zeilen[stelle]).group(1) or "  "
block = (
    f"{einzug}# SSH auf diesen Pi, damit der Zugang nicht mehr an Router,\n"
    f"{einzug}# Heimadresse und DuckDNS haengt. Gegenstelle: cloudflared access ssh.\n"
    f"{einzug}- hostname: {name}\n"
    f"{einzug}  service: ssh://127.0.0.1:{port}\n"
    f"\n"
)
zeilen.insert(stelle, block)
open(ziel, "w", encoding="utf-8").write("".join(zeilen))
PYENDE
) && ERG=0 || ERG=$?
case "$ERG" in
  0) : ;;
  3) ok "Schon eingetragen — nichts geändert."; exit 0 ;;
  4) fehler "In $KONFIG fehlt die Auffangregel (http_status). Ohne sie ist nicht sicher zu bestimmen, wo die neue Regel hingehört. Bitte von Hand eintragen." ;;
  *) fehler "Das Einfügen schlug fehl (Code $ERG) — nichts geändert." ;;
esac

info "Neu hinzugekommen:"
# In eine Variable statt direkt in eine Pipe: mit set -e und pipefail bricht
# ein diff, das Unterschiede findet (Rueckgabewert 1), die Kette ab, und die
# Zeilen erscheinen nie — beim Erproben blieb die Anzeige genau deshalb leer.
ZUGEKOMMEN="$(diff "$KONFIG" "$NEU" | sed -n 's/^> /     /p' || true)"
printf '%s\n' "$ZUGEKOMMEN"

# ── Prüfen, BEVOR etwas in Kraft tritt ──────────────────────────
schritt "Prüfen"
if cloudflared tunnel --config "$NEU" ingress validate; then
  ok "cloudflared hält die neue Fassung für gültig"
else
  fehler "Die neue Fassung ist ungültig — $KONFIG wurde NICHT angefasst."
fi

# ── In Kraft setzen ─────────────────────────────────────────────
schritt "In Kraft setzen"
install -m 644 -o root -g root "$NEU" "$KONFIG.neu-$STAND"
mv -f "$KONFIG.neu-$STAND" "$KONFIG"
ok "Eingetragen"

# Ein sanftes Nachladen gibt es hier nicht: die Einheit hat kein ExecReload,
# und SIGHUP beendet cloudflared (systemd startet ihn dann neu). Gemessen am
# 20.08.: sieben Sekunden Lücke, in denen beide Seiten 502 liefern. Deshalb
# wird ehrlich neu gestartet, statt ein Nachladen vorzutäuschen.
systemctl restart cloudflared || fehler "cloudflared startet nicht — Sicherung liegt unter $SICHERUNG"
ok "cloudflared neu gestartet — die Verbindungen bauen sich neu auf"

# ── Nachsehen, ob es dem Kollegen weiter gut geht ───────────────
schritt "Nachsehen"
info "warte, bis der Tunnel wieder steht (bis zu einer Minute)"
NACHHER_SEITE="$(warte_bis_gesund https://stellium.club/ 12 || true)"
NACHHER_CHAT="$(warte_bis_gesund https://chat.stellium.club/ 6 || true)"
NACHHER_CADDY="$(gesund caddy http://127.0.0.1:8080/)"
zeige_gesundheit "Nachher"

SCHLECHTER=0
[[ "$VORHER_CADDY" == "200" && "$NACHHER_CADDY" != "200" ]] && SCHLECHTER=1
[[ "$VORHER_SEITE" == "200" && "$NACHHER_SEITE" != "200" ]] && SCHLECHTER=1

if [[ "$SCHLECHTER" == "1" ]]; then
  warn "Die Seite des Kollegen antwortet schlechter als vorher — ich spiele zurück."
  cp -a "$SICHERUNG" "$KONFIG"
  systemctl restart cloudflared || true
  warte_bis_gesund https://stellium.club/ 12 >/dev/null || true
  zeige_gesundheit "Nach dem Zurückspielen"
  fehler "Zurückgespielt. Der SSH-Weg wurde NICHT eingerichtet."
fi
ok "Die Seite des Kollegen antwortet wie vorher"

# ── DNS ─────────────────────────────────────────────────────────
schritt "Name im Netz"
if cloudflared tunnel route dns "$(awk '/^tunnel:/{print $2}' "$KONFIG")" "$NAME" >/dev/null 2>&1; then
  ok "DNS-Eintrag für $NAME angelegt"
  DNS_OK=1
else
  DNS_OK=0
  warn "Der DNS-Eintrag ließ sich von hier nicht anlegen."
  info "Das ist erwartbar: dafür bräuchte es /etc/cloudflared/cert.pem, und dort"
  info "liegt nur die Zugangsdatei des Tunnels. Der Eintrag muss einmal von Hand"
  info "in der Cloudflare-Oberfläche entstehen:"
  echo
  info "   ${FETT}dash.cloudflare.com → stellium.club → DNS → Record hinzufügen${AUS}"
  info "     Typ:     CNAME"
  info "     Name:    ${FETT}${NAME%%.*}${AUS}"
  info "     Ziel:    ${FETT}$(awk '/^tunnel:/{print $2}' "$KONFIG").cfargotunnel.com${AUS}"
  info "     Proxy:   ${FETT}an${AUS} (orangene Wolke)"
fi


schritt "So kommst du herein"
mac_anleitung

if [[ "$DNS_OK" == "0" ]]; then
  warn "Vorher muss der CNAME oben angelegt sein, sonst findet der Mac den Namen nicht."
fi

cat <<HINWEIS
   ${GRAU}Zur Sicherheit: sshd nimmt auf diesem Pi nur Schlüssel an
   (PasswordAuthentication no, PermitRootLogin no) — der Name allein
   nützt niemandem. Wer es enger will, legt in Cloudflare unter
   Zero Trust → Access eine Anwendung für $NAME an.

   Rückgängig:  sudo bash ssh-durch-tunnel.sh zurueck
   Nachsehen:   sudo bash ssh-durch-tunnel.sh pruefen${AUS}

HINWEIS
