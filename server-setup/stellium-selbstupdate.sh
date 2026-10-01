#!/usr/bin/env bash
#
# Holt neue Serverstände vom eigenen Stellium-Server und spielt sie ein.
#
#   stellium-selbstupdate           nachsehen und, wenn etwas da ist, einspielen
#   stellium-selbstupdate pruefen   nur nachsehen
#
# Läuft alle 30 Minuten über einen Timer. Eingespielt wird mit derselben
# Rückfallebene wie von Hand: startet der neue Stand nicht, kommt der alte
# zurück.
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

ZIEL="/opt/stellium"
NUR_PRUEFEN="${1:-}"

# Der Server läuft hier auf dem Gerät — der kürzeste Weg zu seiner Auskunft.
PORT="$(grep -oP '(?<=^PORT=)\d+' /etc/stellium.env 2>/dev/null || echo 8787)"
BASIS="http://127.0.0.1:$PORT"

# Für den Abruf braucht es eine Anmeldung. Ein eigener Zugang für diese
# Aufgabe, damit kein persönliches Passwort im Dateisystem liegt.
ZUGANG="/etc/stellium-update.env"
if [[ -r "$ZUGANG" ]]; then
  # shellcheck source=/dev/null
  . "$ZUGANG"
fi

if [[ -z "${STELLIUM_UPDATE_LOGIN:-}" || -z "${STELLIUM_UPDATE_PASSWORT:-}" ]]; then
  fehler "$(cat <<HINWEIS
Für die Selbstaktualisierung fehlt ein Zugang.

Lege in der App unter ${FETT}Team verwalten${AUS} ein Konto an — etwa
${FETT}serverupdate${AUS} mit der Rolle Administrator — und trage es hier ein:

    ${GRAU}sudo tee /etc/stellium-update.env >/dev/null <<'ENDE'
STELLIUM_UPDATE_LOGIN=serverupdate
STELLIUM_UPDATE_PASSWORT=das-passwort
ENDE
    sudo chmod 600 /etc/stellium-update.env${AUS}
HINWEIS
)"
fi

anmelden() {
  # Der Körper geht über die Standardeingabe (@-), nicht als Argument: mit -d
  # stand das Passwort alle 30 Minuten in der Befehlszeile von curl, und die
  # kann jedes Konto auf dem Pi in /proc mitlesen.
  printf '{"login":%s,"password":%s}' \
      "$(printf '%s' "$STELLIUM_UPDATE_LOGIN" | jq -Rs .)" \
      "$(printf '%s' "$STELLIUM_UPDATE_PASSWORT" | jq -Rs .)" \
    | curl -fsS --max-time 15 -X POST "$BASIS/api/auth/login" \
        -H 'content-type: application/json' --data-binary @- \
    | jq -r '.token // empty'
}

schritt "Nachsehen"
TOKEN="$(anmelden)"
[[ -n "$TOKEN" ]] || fehler "Anmeldung am eigenen Server fehlgeschlagen. Stimmen die Angaben in $ZUGANG?"

HIER="$(node -p "require('$ZIEL/packages/desktop/package.json').version" 2>/dev/null || echo '0.0.0')"
ANTWORT="$(curl -fsS --max-time 15 -H "authorization: Bearer $TOKEN" \
  "$BASIS/api/releases/check?platform=server&version=$HIER" || echo '{}')"
NEU="$(printf '%s' "$ANTWORT" | jq -r '.update.version // empty')"

if [[ -z "$NEU" ]]; then
  ok "$HIER ist der neueste Stand"
  exit 0
fi

SUMME="$(printf '%s' "$ANTWORT" | jq -r '.update.sha256')"
NOTIZ="$(printf '%s' "$ANTWORT" | jq -r '.update.notes // empty')"
info "Neu verfügbar: ${FETT}$NEU${AUS}  ${GRAU}(hier: $HIER)${AUS}"
[[ -n "$NOTIZ" ]] && printf '  %s%s%s\n' "$GRAU" "$NOTIZ" "$AUS"

[[ "$NUR_PRUEFEN" == "pruefen" ]] && exit 0

schritt "Holen"
ARBEIT="$(mktemp -d /tmp/stellium-selbstupdate-XXXX)"
chmod 700 "$ARBEIT"
# Die Ankündigung gehört zum Aufräumen dazu: bricht zwischen ihr und dem
# Einspielen etwas ab, stünde sonst bei allen eine Uhr für ein Update, das nie
# kommt — bis wartung.ts sie nach der geschätzten Dauer von selbst ablaufen
# lässt. bash ersetzt EXIT-Traps, statt sie zu stapeln, deshalb beides hier.
# Die Reihenfolge ist Absicht: unter "set -e" bricht der Trap nach dem ersten
# fehlgeschlagenen Befehl ab, und "rm -rf" auf /tmp kann scheitern, "rm -f" auf
# eine fehlende Datei nie. Das Wichtigere steht deshalb vorn.
#
# INT und TERM gehören dazu, seit die Ankündigung hinter dem Auspacken steht:
# das Arbeitsverzeichnis lebt jetzt die ganze Wartezeit über. Wird der Pi in
# diesen fünfzehn Minuten neu gestartet, läuft ein EXIT-Trap allein nicht und
# das Verzeichnis bliebe in /tmp liegen.
trap 'rm -f /var/lib/stellium/wartung.json; rm -rf "$ARBEIT"' EXIT INT TERM
PAKET="$ARBEIT/stellium-server.tar.gz"

# Platz prüfen, bevor geladen wird. Ein Update, das die Platte füllt, nimmt
# nicht nur sich selbst mit, sondern auch die Datenbank. Gemessen wird das
# Dateisystem des Arbeitsverzeichnisses — dorthin wird geladen und ausgepackt,
# und auf manchen Systemen liegt /tmp auf einer eigenen Partition.
FREI_KB="$(df -Pk "$ARBEIT" 2>/dev/null | awk 'NR==2 {print $4}')"
if [[ -n "${FREI_KB:-}" ]] && (( FREI_KB < 500000 )); then
  fehler "Zu wenig Platz: $((FREI_KB / 1024)) MB frei, mindestens 500 MB nötig."
fi

curl -fsS --max-time 900 -H "authorization: Bearer $TOKEN" \
  -o "$PAKET" "$BASIS/releases/server/download" \
  || fehler "Der Stand ließ sich nicht laden."

GEMESSEN="$(sha256sum "$PAKET" | awk '{print $1}')"
[[ "$GEMESSEN" == "$SUMME" ]] \
  || fehler "Prüfsumme stimmt nicht. Der Stand wird verworfen."
ok "geladen und geprüft ($(du -h "$PAKET" | cut -f1))"

schritt "Auspacken"
# Ohne --no-xattrs beschwert sich tar über jede Datei, die von einem Mac
# kommt — hunderte Zeilen, die den eigentlichen Fehler verdecken.
# Vor dem Auspacken hineinsehen: ein Archiv mit "../" oder absoluten Pfaden
# schreibt sonst außerhalb des Arbeitsverzeichnisses. Das Paket kommt zwar vom
# eigenen Server und die Prüfsumme stimmt — aber wer Fassungen hochladen darf,
# soll damit trotzdem nicht überall hinschreiben können.
if tar -tzf "$PAKET" | grep -qE '^/|(^|/)\.\.(/|$)'; then
  fehler "Das Paket enthält Pfade außerhalb des Zielordners und wird verworfen."
fi

# --no-same-owner: sonst legt tar Dateien unter fremden Kennungen an.
tar -C "$ARBEIT" --no-same-owner --no-xattrs -xzf "$PAKET" 2>/dev/null \
  || tar -C "$ARBEIT" --no-same-owner -xzf "$PAKET"

# Im Paket liegt das Skript unter stellium-server/server-setup/ — also drei
# Ebenen tief. Mit "maxdepth 2" wurde es nie gefunden, und der Selbstupdate
# brach genau hier ab, seit das Paket diesen Aufbau hat.
QUELLE="$(find "$ARBEIT" -maxdepth 4 -name 'stellium-aktualisieren.sh' -print -quit)"
if [[ -z "$QUELLE" ]]; then
  warn "Gefunden wurde stattdessen:"
  find "$ARBEIT" -maxdepth 3 -name '*.sh' -print 2>/dev/null | sed 's/^/    /' >&2
  fehler "Im Paket fehlt das Aktualisierungsskript."
fi
ok "bereit"

# ── Trägt das Paket die Nummer, die angekündigt war? ────────────
#
# Die Versionsnummer steht an zwei voneinander unabhängigen Stellen: in der
# Release-Zeile des Servers und in packages/desktop/package.json im Paket.
# Gehen sie auseinander, liest der Pi nach dem Einspielen wieder die alte
# Nummer, hält den Stand für neu und baut ihn alle 30 Minuten erneut — mit
# Wartungsbanner und Neustart, bis jemand von Hand eingreift.
PAKETWURZEL="$(cd "$(dirname "$QUELLE")/.." && pwd)"
PAKET_VERSION="$(node -p "require('$PAKETWURZEL/packages/desktop/package.json').version" 2>/dev/null || echo '?')"
[[ "$PAKET_VERSION" == "$NEU" ]] || fehler "$(cat <<ABWEICHUNG
Das Paket trägt Version $PAKET_VERSION, angekündigt war $NEU. Es wird verworfen.

So bleibt es, bis die beiden zusammenpassen — der Timer lädt sonst alle 30
Minuten dasselbe widersprüchliche Paket. Auf dem Mac neu veröffentlichen, mit
gesetzter Versionsnummer:

    ${GRAU}npm version $NEU --workspace @stellium/desktop --no-git-tag-version${AUS}
    ${GRAU}node scripts/veroeffentlichen.mjs${AUS}
ABWEICHUNG
)"

# ── Ankündigen ──────────────────────────────────────────────────
#
# Erst Bescheid geben, dann warten, dann machen. Mitten im Gespräch
# kommentarlos zu verschwinden wäre unhöflich; eine Viertelstunde reicht, um
# einen Satz zu Ende zu schreiben. Angekündigt wird erst, wenn das Paket
# geladen, geprüft, ausgepackt und für stimmig befunden ist — sonst sieht das
# ganze Haus eine Uhr für ein Update, das gar nicht stattfinden kann.
VORLAUF="${STELLIUM_UPDATE_VORLAUF:-900}"        # Sekunden
DAUER="${STELLIUM_UPDATE_DAUER:-240}"            # geschätzte Auszeit

if [[ "$VORLAUF" -gt 0 ]]; then
  schritt "Ankündigen"
  START=$(( ($(date +%s) + VORLAUF) * 1000 ))
  jq -n --arg v "$NEU" --arg n "$NOTIZ" --argjson s "$START" --argjson d "$(( DAUER * 1000 ))" \
    '{version:$v, notes:(if $n == "" then null else $n end), startetUm:$s, dauertEtwa:$d}' \
    > /var/lib/stellium/wartung.json
  chown stellium:stellium /var/lib/stellium/wartung.json 2>/dev/null || true
  ok "Alle sehen jetzt eine Uhr: in $(( VORLAUF / 60 )) Minuten geht es los"

  info "warte"
  sleep "$VORLAUF"
fi

schritt "Einspielen"
# Von hier an übernimmt das mitgelieferte Skript — samt Sicherung und
# Rückfall, falls der neue Stand nicht startet.
if bash "$QUELLE"; then
  rm -f /var/lib/stellium/wartung.json
  ok "fertig"
else
  # Die Ankündigung muss weg, sonst steht bei allen ewig eine Uhr.
  rm -f /var/lib/stellium/wartung.json
  fehler "Das Einspielen ist fehlgeschlagen. Der alte Stand läuft weiter."
fi
