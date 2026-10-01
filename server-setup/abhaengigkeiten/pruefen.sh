#!/usr/bin/env bash
#
# Sieht einmal am Tag nach, ob es neue Fassungen der verwendeten Pakete gibt —
# und spielt ein, was gefahrlos ist.
#
#   sudo stellium-abhaengigkeiten            nachsehen und einspielen
#   sudo stellium-abhaengigkeiten pruefen    nur nachsehen, nichts anfassen
#
# Was "gefahrlos" heißt: alles, was innerhalb der in package.json erlaubten
# Spanne liegt. Das sind Patch- und Minor-Stände; ihre Zusage ist, dass sich
# nichts an der Schnittstelle ändert. Genau diese Spanne spielt `npm update`
# ein. `npm audit fix` kommt dazu — ohne --force, damit auch dort nichts
# einbricht, was die Spanne verlässt.
#
# Größere Sprünge (ein Hauptstand weiter) werden nur gemeldet. Sie können
# alles Mögliche umbenennen oder entfernen; das gehört vor Augen, die es
# beurteilen können, nicht in einen nächtlichen Lauf.
#
# Nach dem Einspielen wird geprüft, und zwar richtig: bauen, beide
# Typprüfungen, und der Sicherheits-Durchlauf, der den Server wirklich
# startet. Fällt irgendetwas davon um, kommt der vorherige Stand zurück —
# package-lock.json, node_modules und das gebaute gemeinsame Paket — und der
# Dienst startet damit neu. Ein Server, an dem ein ganzes Team hängt, darf an
# einer Abhängigkeit nicht sterben.
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

[[ $EUID -eq 0 ]] || { printf '%sBitte mit sudo starten.%s\n' "$ROT" "$AUS" >&2; exit 1; }

BENUTZER="stellium"
# Überschreibbar, damit sich der Rückfall an einer Kopie erproben lässt, ohne
# den laufenden Stand anzufassen — und damit eine Installation an anderer
# Stelle nicht gleich ein eigenes Skript braucht.
ZIEL="${STELLIUM_ZIEL:-/opt/stellium}"
DATEN="${STELLIUM_DATA:-/var/lib/stellium}"
BERICHT="$DATEN/abhaengigkeiten.json"
SICHERUNG="$DATEN/abhaengigkeiten-vorher"
NUR_PRUEFEN="${1:-}"
BEGINN="$(date +%s)"

[[ -d "$ZIEL/node_modules" ]] || { printf '%s%s hat keine Abhängigkeiten.%s\n' "$ROT" "$ZIEL" "$AUS" >&2; exit 1; }
cd "$ZIEL"

# Zwei Läufe gleichzeitig — etwa der nächtliche Timer und ein Aufruf von Hand —
# würden sich beim Einspielen die Abhängigkeiten gegenseitig unter den Füßen
# wegziehen, und der Rückfall des einen träfe den halben Stand des anderen. Der
# zweite wartet deshalb nicht, er geht.
exec 9>/run/stellium-abhaengigkeiten.sperre
if ! flock -n 9; then
  printf '  Ein Lauf ist bereits unterwegs — dieser hier hört auf.\n'
  exit 0
fi

# Der Server läuft hier auf dem Gerät — der kürzeste Weg zu seiner Auskunft.
PORT="$(grep -oP '(?<=^PORT=)\d+' /etc/stellium.env 2>/dev/null || echo 8787)"

# npm läuft nie als root. Es führt Skripte aus den Paketen aus, und die sollen
# nichts dürfen, was der Dienst selbst nicht darf. HOME muss dabei gesetzt
# sein, sonst legt npm seinen Zwischenspeicher in / an und scheitert.
alsBenutzer() { sudo -u "$BENUTZER" env HOME="$DATEN" "$@"; }

ARBEIT="$(mktemp -d /tmp/stellium-abhaengigkeiten-XXXX)"
trap 'rm -rf "$ARBEIT"' EXIT INT TERM

# ── Bericht ─────────────────────────────────────────────────────
#
# Die Stellium-Konsole soll später anzeigen können, wann zuletzt geprüft
# wurde, wie viel eingespielt wurde und was noch wartet. Also wird der Bericht
# in jedem Fall geschrieben — auch wenn der Lauf schiefgeht. Ein fehlender
# Bericht wäre in der Anzeige nicht von "nie gelaufen" zu unterscheiden.
berichten() {
  local ergebnis="$1" meldung="$2" eingespielt="$3"
  node -e '
    const fs = require("fs");
    const [ergebnis, meldung, eingespielt, dauer, arbeit] = process.argv.slice(1);
    const lies = (n, vorgabe) => {
      try { return JSON.parse(fs.readFileSync(`${arbeit}/${n}`, "utf8")); } catch { return vorgabe; }
    };
    const wartet = lies("wartet.json", []);
    const bericht = {
      geprueftUm: Date.now(),
      geprueft: new Date().toISOString(),
      ergebnis,
      meldung,
      eingespielt: Number(eingespielt),
      geaendert: lies("geaendert.json", []),
      wartetAnzahl: wartet.length,
      wartet,
      sicherheit: lies("sicherheit.json", null),
      dauerSek: Number(dauer),
    };
    process.stdout.write(JSON.stringify(bericht, null, 2) + "\n");
  ' "$ergebnis" "$meldung" "$eingespielt" "$(( $(date +%s) - BEGINN ))" "$ARBEIT" \
    | alsBenutzer sh -c 'umask 022 && cat > "$1.neu" && mv -f "$1.neu" "$1"' berichten "$BERICHT"
  # Als Dienstkonto geschrieben, nicht als root: $DATEN gehört stellium, und
  # ein Verweis, den der Chat-Server dort unter abhaengigkeiten.json.neu
  # anlegte, lenkte das Schreiben von root vorher auf eine beliebige Datei —
  # chown und chmod hinterher folgten ihm ebenso.
}

gesund() {
  curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}

# ── Nachsehen ───────────────────────────────────────────────────
schritt "Nachsehen"

# Beide Befehle melden mit einem Fehlercode, dass sie etwas gefunden haben.
# Das ist hier kein Fehler, sondern das erwartete Ergebnis.
alsBenutzer npm outdated --json > "$ARBEIT/outdated.json" 2>/dev/null || true
alsBenutzer npm audit --json    > "$ARBEIT/audit.json"    2>/dev/null || true
[[ -s "$ARBEIT/outdated.json" ]] || echo '{}' > "$ARBEIT/outdated.json"
[[ -s "$ARBEIT/audit.json" ]]    || echo '{}' > "$ARBEIT/audit.json"

# `npm outdated` nennt drei Stände je Paket: den installierten, den nach
# package.json erlaubten und den neuesten überhaupt. Der Unterschied zwischen
# den ersten beiden ist das, was gefahrlos hereinkommen darf; der Unterschied
# zwischen den letzten beiden ist der große Sprung, der nur gemeldet wird.
#
# Die Vorbelegung ist gegen "set -u": liefert node nichts, bricht der Lauf mit
# einer verständlichen Zahl ab statt mit einer unbelegten Variablen.
KLEIN=0; GROSS=0; LUECKEN=0
eval "$(node -e '
  const fs = require("fs");
  const arbeit = process.argv[1];
  const roh = JSON.parse(fs.readFileSync(`${arbeit}/outdated.json`, "utf8") || "{}");
  const klein = [], gross = [];
  for (const [paket, wert] of Object.entries(roh)) {
    for (const w of (Array.isArray(wert) ? wert : [wert])) {
      const eintrag = {
        paket,
        hier: w.current ?? null,
        erlaubt: w.wanted ?? null,
        neuestes: w.latest ?? null,
      };
      if (eintrag.hier && eintrag.erlaubt && eintrag.hier !== eintrag.erlaubt) klein.push(eintrag);
      if (eintrag.erlaubt && eintrag.neuestes && eintrag.erlaubt !== eintrag.neuestes) gross.push(eintrag);
    }
  }
  // In einem Arbeitsbereich nennt npm dasselbe Paket einmal je Verwender —
  // typescript stünde sonst viermal in der Liste. Für die Frage "was wartet
  // noch?" ist das eine Zeile, nicht vier.
  const einmalig = (liste) => [...new Map(
    liste.map((e) => [`${e.paket}@${e.hier}>${e.neuestes}`, e]),
  ).values()];
  fs.writeFileSync(`${arbeit}/wartet.json`, JSON.stringify(einmalig(gross), null, 2));

  let luecken = null;
  try {
    const pruef = JSON.parse(fs.readFileSync(`${arbeit}/audit.json`, "utf8") || "{}");
    const v = pruef?.metadata?.vulnerabilities;
    if (v) luecken = {
      gesamt: v.total ?? 0, kritisch: v.critical ?? 0, hoch: v.high ?? 0,
      mittel: v.moderate ?? 0, niedrig: v.low ?? 0,
    };
  } catch { /* ohne Netz gibt npm audit nichts Brauchbares zurück */ }
  fs.writeFileSync(`${arbeit}/sicherheit.json`, JSON.stringify(luecken, null, 2));

  console.log(`KLEIN=${klein.length}`);
  console.log(`GROSS=${einmalig(gross).length}`);
  console.log(`LUECKEN=${luecken ? luecken.gesamt : 0}`);
' "$ARBEIT")"

info "$KLEIN Pakete können gefahrlos nachziehen"
info "$GROSS Pakete stehen einen Hauptstand weiter — nur gemeldet"
if [[ "$LUECKEN" -gt 0 ]]; then
  warn "$LUECKEN gemeldete Sicherheitslücken"
else
  ok "keine gemeldeten Sicherheitslücken"
fi

if [[ "$GROSS" -gt 0 ]]; then
  sed -n 's/.*"paket": "\(.*\)",/  · \1/p' "$ARBEIT/wartet.json" | head -20
fi

if [[ "$NUR_PRUEFEN" == "pruefen" ]]; then
  berichten "nurGeprueft" "Nur nachgesehen, nichts eingespielt." 0
  exit 0
fi

if [[ "$KLEIN" -eq 0 && "$LUECKEN" -eq 0 ]]; then
  ok "Es gibt nichts einzuspielen."
  berichten "nichtsZuTun" "Alles auf dem erlaubten Stand." 0
  exit 0
fi

# ── Zurücklegen können ──────────────────────────────────────────
#
# Gesichert wird genau das, was das Einspielen anfasst: die Sperrdatei, der
# Abhängigkeitsbaum und das gebaute gemeinsame Paket (das gleich neu gebaut
# wird und dabei kaputtgehen kann). Der Quelltext bleibt unberührt und braucht
# keine Sicherung.
schritt "Bisherigen Stand sichern"
FREI_KB="$(df -Pk "$DATEN" | awk 'NR==2 {print $4}')"
BRAUCHT_KB="$(du -sk "$ZIEL/node_modules" | awk '{print $1}')"
if (( FREI_KB < BRAUCHT_KB + 500000 )); then
  warn "Zu wenig Platz für eine Sicherung: $((FREI_KB/1024)) MB frei, $((BRAUCHT_KB/1024)) MB nötig."
  berichten "fehler" "Zu wenig Platz für die Sicherung — nichts angefasst." 0
  exit 1
fi

rm -rf "$SICHERUNG"
mkdir -p "$SICHERUNG"
cp -a "$ZIEL/package-lock.json" "$SICHERUNG/package-lock.json"
cp -a "$ZIEL/node_modules" "$SICHERUNG/node_modules"
[[ -d "$ZIEL/packages/shared/dist" ]] && cp -a "$ZIEL/packages/shared/dist" "$SICHERUNG/shared-dist"
ok "liegt unter $SICHERUNG ($((BRAUCHT_KB/1024)) MB)"

zurueck() {
  # Ohne diese Zeile löst ein Fehler im Rückfall den Rückfall erneut aus.
  trap - ERR INT TERM
  warn "Ich lege den vorherigen Stand zurück."
  cp -a "$SICHERUNG/package-lock.json" "$ZIEL/package-lock.json"
  rm -rf "$ZIEL/node_modules"
  cp -a "$SICHERUNG/node_modules" "$ZIEL/node_modules"
  if [[ -d "$SICHERUNG/shared-dist" ]]; then
    rm -rf "$ZIEL/packages/shared/dist"
    cp -a "$SICHERUNG/shared-dist" "$ZIEL/packages/shared/dist"
  fi
  chown -R "$BENUTZER":"$BENUTZER" "$ZIEL/node_modules" "$ZIEL/package-lock.json" "$ZIEL/packages/shared" 2>/dev/null || true
  systemctl restart stellium || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do gesund && break; sleep 3; done
  if gesund; then
    warn "Der alte Stand läuft wieder. Nichts ist verloren."
    berichten "zurueckgerollt" "$1" 0
    exit 1
  fi
  printf '\n%s✗ Der alte Stand ist zurückgelegt, der Dienst antwortet aber nicht.%s\n' "$ROT$FETT" "$AUS" >&2
  printf '  journalctl -u stellium -n 50\n\n' >&2
  berichten "fehler" "Rückfall gelegt, Dienst antwortet nicht: $1" 0
  exit 2
}

# ── Einspielen ──────────────────────────────────────────────────
schritt "Einspielen"
VORHER_SUMME="$(sha256sum "$ZIEL/package-lock.json" | awk '{print $1}')"

if ! alsBenutzer npm update --no-audit --no-fund > "$ARBEIT/einspielen.log" 2>&1; then
  tail -15 "$ARBEIT/einspielen.log" | sed 's/^/    /'
  zurueck "npm update ist fehlgeschlagen."
fi
if [[ "$LUECKEN" -gt 0 ]]; then
  # Ohne --force: was nur mit einem Hauptstandssprung zu schließen wäre, bleibt
  # offen und steht im Bericht. Lieber eine gemeldete Lücke als ein Server, der
  # nicht mehr startet.
  alsBenutzer npm audit fix --no-fund >> "$ARBEIT/einspielen.log" 2>&1 || true
fi

NACHHER_SUMME="$(sha256sum "$ZIEL/package-lock.json" | awk '{print $1}')"
if [[ "$VORHER_SUMME" == "$NACHHER_SUMME" ]]; then
  ok "npm hat nichts geändert."
  rm -rf "$SICHERUNG"
  berichten "nichtsZuTun" "npm hat nichts geändert." 0
  exit 0
fi

# Was sich wirklich geändert hat, steht in der Sperrdatei — nicht in dem, was
# npm vorher angekündigt hat. Ein Paket kann mitgezogen worden sein, ohne je in
# `npm outdated` aufgetaucht zu sein.
#
# Verglichen wird dabei nach Paketnamen, nicht nach Platz im Baum. Der Grund:
# npm hängt beim Aktualisieren gern um — dieselbe Fassung wandert von ganz oben
# in einen Unterordner und eine andere rückt nach. Wer die Stellen im Baum
# vergleicht, liest daraus Dutzende von "Änderungen", bei denen sich in
# Wahrheit keine einzige Fassung geändert hat. Deshalb je Paket die Menge
# seiner Fassungen vorher und nachher; sind beide gleich, ist nichts passiert.
EINGESPIELT="$(node -e '
  const fs = require("fs");
  const [alt, neu, arbeit] = process.argv.slice(1);
  const staende = (datei) => {
    const m = new Map();
    const inhalt = JSON.parse(fs.readFileSync(datei, "utf8"));
    for (const [pfad, eintrag] of Object.entries(inhalt.packages ?? {})) {
      // Ohne Pfad ist es die Wurzel, mit "link" nur ein Verweis auf einen
      // eigenen Arbeitsbereich — und eigene Pakete sind keine Abhängigkeiten.
      if (!pfad || !eintrag.version || eintrag.link) continue;
      const schnitt = pfad.lastIndexOf("node_modules/");
      if (schnitt < 0) continue;
      const name = pfad.slice(schnitt + "node_modules/".length);
      if (!m.has(name)) m.set(name, new Set());
      m.get(name).add(eintrag.version);
    }
    return m;
  };
  const zeile = (menge) => [...menge].sort().join(", ");
  const a = staende(alt), b = staende(neu);
  const geaendert = [];
  for (const [paket, nachher] of b) {
    const vorher = a.get(paket);
    if (!vorher) { geaendert.push({ paket, vorher: null, nachher: zeile(nachher) }); continue; }
    if (zeile(vorher) !== zeile(nachher)) {
      geaendert.push({ paket, vorher: zeile(vorher), nachher: zeile(nachher) });
    }
  }
  geaendert.sort((x, y) => x.paket.localeCompare(y.paket));
  fs.writeFileSync(`${arbeit}/geaendert.json`, JSON.stringify(geaendert, null, 2));
  console.log(geaendert.length);
' "$SICHERUNG/package-lock.json" "$ZIEL/package-lock.json" "$ARBEIT")"

ok "$EINGESPIELT Pakete auf einem neuen Stand"
sed -n 's/.*"paket": "\(.*\)",/  · \1/p' "$ARBEIT/geaendert.json" | head -20

# ── Prüfen ──────────────────────────────────────────────────────
#
# Vier Prüfungen, jede aus einem anderen Blickwinkel: baut das gemeinsame
# Paket noch, passen die Typen für Server und Oberfläche noch zusammen, und
# hält der wirklich gestartete Server seine Zugangsregeln noch ein. Die letzte
# ist die wichtigste — sie fasst den neuen Abhängigkeitsbaum zur Laufzeit an,
# nicht nur beim Übersetzen.
schritt "Prüfen"
pruefung() {
  local name="$1"; shift
  printf '  %s… ' "$name"
  if "$@" > "$ARBEIT/pruefung.log" 2>&1; then
    printf '%s✓%s\n' "$GRUEN" "$AUS"
    return 0
  fi
  printf '%s✗%s\n' "$ROT" "$AUS"
  tail -20 "$ARBEIT/pruefung.log" | sed 's/^/      /'
  return 1
}

pruefung "gemeinsames Paket bauen" alsBenutzer npm run build:shared \
  || zurueck "npm run build:shared ist fehlgeschlagen."
pruefung "Typen Server"           alsBenutzer npx tsc -p packages/server --noEmit \
  || zurueck "Die Typprüfung des Servers ist fehlgeschlagen."
pruefung "Typen Oberfläche"       alsBenutzer npx tsc -p packages/desktop --noEmit \
  || zurueck "Die Typprüfung der Oberfläche ist fehlgeschlagen."
pruefung "Zugangsregeln"          alsBenutzer node scripts/e2e-sicherheit.mjs \
  || zurueck "Der Sicherheits-Durchlauf ist fehlgeschlagen."

# ── Übernehmen ──────────────────────────────────────────────────
schritt "Dienst neu starten"
chown -R "$BENUTZER":"$BENUTZER" "$ZIEL/node_modules" "$ZIEL/package-lock.json" "$ZIEL/packages/shared" 2>/dev/null || true
systemctl restart stellium
for _ in 1 2 3 4 5 6 7 8 9 10; do gesund && break; sleep 3; done
# Alle Prüfungen können bestanden sein und der Dienst trotzdem nicht antworten
# — geprüft wurde ein zweiter Server auf einer eigenen Datenbank, gestartet
# wurde der echte. Erst diese Antwort entscheidet.
gesund || zurueck "Der Dienst antwortet nach dem Neustart nicht."
ok "Stellium antwortet wieder"

berichten "ok" "$EINGESPIELT Pakete eingespielt, $GROSS warten auf eine Entscheidung." "$EINGESPIELT"

printf '\n%s✓ Fertig.%s  %sBericht: %s%s\n\n' "$GRUEN$FETT" "$AUS" "$GRAU" "$BERICHT" "$AUS"
