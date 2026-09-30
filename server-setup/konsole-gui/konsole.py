#!/usr/bin/env python3
"""
Die Stellium-Konsole als Fenster.

Zeigt denselben Stand wie `stellium-konsole` im Terminal — nur eben zum
Anschauen statt zum Lesen. Die Zahlen kommen aus genau derselben Quelle
(`stellium-konsole json`), damit beide Anzeigen nie auseinanderlaufen.

Zwei Betriebsarten:

  ohne Zusatz     ein gewöhnliches Fenster, das man öffnet und schließt.
  --hintergrund   der lebende Schreibtischgrund: randlos, ganz hinten, auf
                  allen Arbeitsflächen, ohne Eintrag in der Fensterleiste.
                  Wie das genau geht, steht bei `hintergrund_einrichten`.

Unten sitzt der Fernzugriff: derselbe Bereich, den auch das eigenständige
Wächterfenster zeigt (ssh-wache/wache.py) — hier fest eingebaut, statt
aufzuspringen.

Braucht nichts außer python3-tk.
"""
import glob
import importlib.util
import json
import math
import os
import re
import shlex
import subprocess
import sys
import threading
import calendar
import time
import tkinter as tk
from tkinter import font as tkfont

KONSOLE = ["/usr/bin/node", "/opt/stellium/server-setup/stellium-konsole.mjs", "json"]
TAKT = 2.0
SPRACHDATEI = os.path.expanduser("~/.config/stellium-konsole-sprache")

# Aufruf mit „--hintergrund" macht aus dem Fenster den Schreibtischgrund.
HINTERGRUND = "--hintergrund" in sys.argv[1:]

# Woran der Fenstermanager seine Regel festmacht: der Klassenname des Fensters
# (bei labwc <windowRule identifier="…">). Nur im Hintergrundbetrieb heißt das
# Fenster so — eine von Hand geöffnete Konsole soll ein gewöhnliches Fenster
# bleiben und nicht ebenfalls nach ganz hinten rutschen.
FENSTERKLASSE = "stellium-hintergrund" if HINTERGRUND else "stellium-konsole"

# Wo die Mitschrift des Fernzugriffs zu finden ist. Sie bleibt ein eigenes
# Programm; hier wird nur ihr Anzeigeteil geholt und als Bereich eingesetzt,
# damit beide Fassungen dasselbe zeigen und niemand zwei pflegen muss.
WACHE_ORTE = (
    "/usr/local/lib/stellium/ssh-wache.py",                  # so liegt sie auf dem Pi
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "ssh-wache.py"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 os.pardir, "ssh-wache", "wache.py"),        # so liegt sie im Quelltext
)


def wache_holen():
    """Den Anzeigeteil der SSH-Wache nachladen, wenn es ihn gibt.

    Bewusst über den Dateipfad statt über `import`: die Datei heißt auf dem Pi
    anders als im Quelltext und liegt in keinem Modulpfad. Findet sie sich
    nicht oder lässt sie sich nicht laden, läuft die Konsole ohne diesen
    Bereich weiter — sie ist nicht darauf angewiesen.
    """
    for ort in WACHE_ORTE:
        if not os.path.isfile(ort):
            continue
        try:
            angabe = importlib.util.spec_from_file_location("stellium_wache", ort)
            teil = importlib.util.module_from_spec(angabe)
            angabe.loader.exec_module(teil)
            return teil
        except Exception:                              # noqa: BLE001
            return None                                # lieber ohne als halb
    return None


WACHE = wache_holen()

TEXTE = {
    "de": {
        "schirm_frei": "Bildschirm  ·  niemand verbunden",
        "schirm_da": "Bildschirm  ·  {wer}  ·  verbunden seit {zeit}",
        # Seit mehrere gleichzeitig zusehen dürfen: {wer} ist der Erste (der am
        # längsten dabei ist), {n} sind die anderen.
        "schirm_mehr": "Bildschirm  ·  {wer} und {n} weitere  ·  seit {zeit}",
        "schirm_aus": "Bildschirm  ·  Fernsteuerung läuft nicht",
        # Steht anstelle eines Namens, wenn die Gegenstelle keinen mitschickt
        # (ältere App-Fassung) oder keinen angegeben hat.
        "schirm_unbekannt": "unbekannt",
        "verbinden": "Verbinden", "chat": "Chat-Server", "aussen": "Weg nach außen",
        "leistung": "Leistung", "teile": "Bestandteile",
        "dienst": "Dienst", "uebersetzung": "Übersetzung", "modell": "Modell",
        "inhalt": "Inhalt", "datenbank": "Datenbank", "zertifikat": "Zertifikat",
        "sicherung": "Sicherung", "firewall": "Firewall", "netz": "Netz",
        "laeuft_seit": "Läuft seit", "auslagerung": "Auslagerung",
        "prozessor": "Prozessor", "speicher": "Speicher", "platte": "Platte",
        "temperatur": "Temperatur", "kerne": "Kerne", "frei": "frei",
        "laeuft_auto": "läuft · startet automatisch", "laeuft": "läuft",
        "aus": "AUS", "an": "an", "uebersetzung_aus": "aus",
        "stumm": "antwortet nicht", "ohne_modell": "kein Modell geladen",
        "seit": "seit", "nie_erreicht": "noch nie erreicht",
        # TLS endet nicht auf diesem Pi, sondern beim Tunnel-Anbieter (siehe
        # zertifikat()/tunnelZertifikat() in stellium-konsole.mjs). "{anbieter}"
        # ist z.B. "Cloudflare".
        "zert_tunnel": "{anbieter} · TLS endet dort, nicht auf dem Pi",
        "kein_zert": "keines — Verbindung offen", "noch_keine": "noch keine",
        "stand": "Stand", "staende": "Stände", "tage": "noch {n} Tage",
        "eigenes_netz": "im eigenen Netz", "offen": "unverschlüsselt",
        "tunnel": "durch den Tunnel", "aktiv": "aktiv",
        "gesperrt": "{n} gesperrt", "wacht": "wacht, nichts gesperrt",
        "konten": "Konten", "kanaele": "Kanäle", "nachrichten": "Nachrichten",
        "ablage": "Dateiablage", "dateien": "Dateien", "belegt": "belegt",
        "verbunden": "Verbunden", "verbindung": "Verbindung", "verbindungen": "Verbindungen",
        "person": "Person", "personen": "Personen", "niemand": "niemand",
        "empfangen": "empfangen", "gesendet": "gesendet",
        "fuss": "Aktualisiert sich alle zwei Sekunden  ·  im Terminal:  stellium-konsole",
        "verbinde": "verbinde …", "keine_verbindung": "Keine Verbindung zur Konsole: {f}",
        "tage_kurz": "Tage", "std": "Std", "min": "Min",
        # ── Ablage: die Leiste mit den Plätzen
        "ablage_titel": "Schnellzugriff",
        # ── Sprechblase über einem Platz der Schnellzugriff-Leiste
        "blase_anwendung": "Anwendung", "blase_ordner": "Ordner",
        "blase_datei": "Datei", "blase_ziel": "Pfad",
        "blase_laeuft": "läuft", "blase_laeuft_nicht": "läuft gerade nicht",
        "blase_vorgang": "Vorgang", "blase_vorgaenge": "Vorgänge",
        "blase_speicher": "Speicher", "blase_eintraege": "{n} Einträge",
        "blase_leer": "leer", "blase_geaendert": "geändert",
        "blase_weg": "Das Ziel gibt es nicht mehr",
        "blase_weg_grund": "Umschalt und Klick, um den Platz neu zu belegen",
        "blase_unlesbar": "nicht lesbar",
        "blase_frei": "Freier Platz",
        "blase_frei_wie": "Klicken, um etwas abzulegen",
        "ablage_hinweis": "Klicken zum Ablegen  ·  Umschalt und Klick zum Ändern",
        "was_ablegen": "Was soll hier liegen?",
        "art_anwendung": "Anwendung", "art_ordner": "Ordner", "art_datei": "Datei",
        "abbrechen": "Abbrechen", "ablegen": "Ablegen", "oeffnen": "Öffnen",
        "entfernen": "Entfernen", "austauschen": "Austauschen",
        "eintrag_aendern": "Diesen Platz ändern",
        "hoeher": "⟵  eine Ebene höher",
        "nichts_hier": "Hier ist nichts.",
        "fehlt": "nicht mehr da",
        "fehlt_lang": "„{name}“ gibt es nicht mehr. Entfernen oder austauschen?",
        "geht_nicht": "Ließ sich nicht öffnen.",
        "ordner_hier": "diesen Ordner nehmen",
        # ── Website des Kollegen (läuft auf demselben Pi, gehört uns nicht)
        "web": "Triton Website",
        # ── Verkauf (Abo bei Gumroad, siehe stellium-konsole.mjs)
        "verkauf": "Verkauf",
        "vk_produkt": "Produkt", "vk_mitglieder": "Mitglieder",
        "vk_umsatz": "Umsatz je Monat", "vk_preis": "Preis",
        "vk_probe": "Probezeit", "vk_einnahmen": "Einnahmen",
        "vk_kein_token": "kein Gumroad-Token", "vk_geschaetzt": "aus der Mitgliederzahl",
        "vk_tage": "{n} Tage", "vk_unvollstaendig": "unvollständig",
        "vk_noch_keine": "noch keine",
        "web_jetzt": "gerade da", "web_heute_t": "heute",
        "web_zustand": "Auslieferung", "web_heute": "Heute", "web_woche_n": "{n} Tage",
        "web_verlauf": "24 Stunden", "web_beliebt": "Beliebt",
        "web_herkunft": "Herkunft", "web_fehler": "Fehler",
        "web_kaputt": "Fehlt", "web_maschinen": "Maschinen",
        "web_aufrufe": "Seitenaufrufe", "web_besucher": "Besucher",
        "web_verkehr": "Verkehr", "web_anfragen": "Anfragen",
        "web_spitze": "Spitze heute {n}", "web_beste": "bester Tag {n}",
        "web_direkt": "direkt", "web_intern": "von der Seite",
        "web_klopfen": "{n} Klopfversuche", "web_ruht": "caddy läuft nicht",
        "web_still": "noch keine Zugriffe", "web_letzter": "zuletzt vor {t}",
        "web_in30": "{n} in 30 Min",
        "web_keine_fehler": "keine",
    },
    "en": {
        "schirm_frei": "Screen  ·  nobody connected",
        "schirm_da": "Screen  ·  {wer}  ·  connected since {zeit}",
        # Since several people may watch at once: {wer} is the first one (the
        # one who has been there longest), {n} are the others.
        "schirm_mehr": "Screen  ·  {wer} and {n} more  ·  since {zeit}",
        "schirm_aus": "Screen  ·  remote control not running",
        # Shown instead of a name when the other side doesn't send one
        # (older app version) or didn't provide one.
        "schirm_unbekannt": "unknown",
        "verbinden": "Connect", "chat": "Chat server", "aussen": "Public access",
        "leistung": "Performance", "teile": "Components",
        "dienst": "Service", "uebersetzung": "Translation", "modell": "Model",
        "inhalt": "Content", "datenbank": "Database", "zertifikat": "Certificate",
        "sicherung": "Backups", "firewall": "Firewall", "netz": "Network",
        "laeuft_seit": "Uptime", "auslagerung": "Swap",
        "prozessor": "CPU", "speicher": "Memory", "platte": "Disk",
        "temperatur": "Temperature", "kerne": "cores", "frei": "free",
        "laeuft_auto": "running · starts automatically", "laeuft": "running",
        "aus": "OFF", "an": "on", "uebersetzung_aus": "off",
        "stumm": "not responding", "ohne_modell": "no model loaded",
        "seit": "since", "nie_erreicht": "never reached",
        # TLS terminates at the tunnel provider, not on this Pi — see
        # zertifikat()/tunnelZertifikat() in stellium-konsole.mjs.
        "zert_tunnel": "{anbieter} · TLS terminates there, not on this Pi",
        "kein_zert": "none — connection is open", "noch_keine": "none yet",
        "stand": "backup", "staende": "backups", "tage": "{n} days left",
        "eigenes_netz": "on this network", "offen": "unencrypted",
        "tunnel": "through the tunnel", "aktiv": "active",
        "gesperrt": "{n} blocked", "wacht": "watching, nothing blocked",
        "konten": "accounts", "kanaele": "channels", "nachrichten": "messages",
        "ablage": "File storage", "dateien": "files", "belegt": "used",
        "verbunden": "Connected", "verbindung": "connection", "verbindungen": "connections",
        "person": "person", "personen": "people", "niemand": "nobody",
        "empfangen": "received", "gesendet": "sent",
        "fuss": "Refreshes every two seconds  ·  in the terminal:  stellium-konsole",
        "verbinde": "connecting …", "keine_verbindung": "No connection to the console: {f}",
        "tage_kurz": "days", "std": "h", "min": "min",
        # ── Ablage: die Leiste mit den Plätzen
        "ablage_titel": "Quick access",
        # ── tooltip over a quick-access slot
        "blase_anwendung": "Application", "blase_ordner": "Folder",
        "blase_datei": "File", "blase_ziel": "Path",
        "blase_laeuft": "running", "blase_laeuft_nicht": "not running",
        "blase_vorgang": "process", "blase_vorgaenge": "processes",
        "blase_speicher": "Memory", "blase_eintraege": "{n} items",
        "blase_leer": "empty", "blase_geaendert": "changed",
        "blase_weg": "The target no longer exists",
        "blase_weg_grund": "shift-click to fill the slot again",
        "blase_unlesbar": "not readable",
        "blase_frei": "Empty slot",
        "blase_frei_wie": "Click to place something here",
        "ablage_hinweis": "Click to place  ·  shift-click to change",
        "was_ablegen": "What goes here?",
        "art_anwendung": "Application", "art_ordner": "Folder", "art_datei": "File",
        "abbrechen": "Cancel", "ablegen": "Place", "oeffnen": "Open",
        "entfernen": "Remove", "austauschen": "Replace",
        "eintrag_aendern": "Change this slot",
        "hoeher": "⟵  one level up",
        "nichts_hier": "Nothing here.",
        "fehlt": "gone",
        "fehlt_lang": "“{name}” is no longer there. Remove or replace?",
        "geht_nicht": "Could not open it.",
        "ordner_hier": "take this folder",
        # ── Colleague's website (same Pi, not ours)
        "web": "Triton Website",
        # ── Sales (Gumroad subscription, see stellium-konsole.mjs)
        "verkauf": "Sales",
        "vk_produkt": "Product", "vk_mitglieder": "Members",
        "vk_umsatz": "Monthly revenue", "vk_preis": "Price",
        "vk_probe": "Trial", "vk_einnahmen": "Earnings",
        "vk_kein_token": "no Gumroad token", "vk_geschaetzt": "from the member count",
        "vk_tage": "{n} days", "vk_unvollstaendig": "incomplete",
        "vk_noch_keine": "none yet",
        "web_jetzt": "here now", "web_heute_t": "today",
        "web_zustand": "Serving", "web_heute": "Today", "web_woche_n": "{n} days",
        "web_verlauf": "24 hours", "web_beliebt": "Most visited",
        "web_herkunft": "Came from", "web_fehler": "Errors",
        "web_kaputt": "Missing", "web_maschinen": "Bots",
        "web_aufrufe": "page views", "web_besucher": "visitors",
        "web_verkehr": "Traffic", "web_anfragen": "requests",
        "web_spitze": "peak today {n}", "web_beste": "best day {n}",
        "web_direkt": "direct", "web_intern": "on-site",
        "web_klopfen": "{n} probes", "web_ruht": "caddy is not running",
        "web_still": "no requests yet", "web_letzter": "last seen {t} ago",
        "web_in30": "{n} in 30 min",
        "web_keine_fehler": "none",
    },
}

SPRACHE = "de"


def T(schluessel, **werte):
    text = TEXTE.get(SPRACHE, TEXTE["de"]).get(schluessel, schluessel)
    return text.format(**werte) if werte else text


def sprache_laden():
    global SPRACHE
    try:
        with open(SPRACHDATEI) as f:
            wahl = f.read().strip()
        if wahl in TEXTE:
            SPRACHE = wahl
    except OSError:
        pass


def sprache_sichern():
    try:
        os.makedirs(os.path.dirname(SPRACHDATEI), exist_ok=True)
        with open(SPRACHDATEI, "w") as f:
            f.write(SPRACHE)
    except OSError:
        pass

# Dieselben Farben wie die Chat-App (packages/desktop/src/styles/tokens.css).
# Tk kennt keine Transparenz, deshalb sind die halbdurchsichtigen Werte der App
# hier auf den Grundton heruntergerechnet — das Ergebnis sieht gleich aus.
F = {
    "grund": "#05060f",      # --bg-void
    "tief": "#080b16",       # --bg-deep
    "karte": "#0e0f18",      # --bg-panel über dem Grund
    "karte2": "#111320",     # --bg-panel-2
    "erhoben": "#121526",    # --bg-elevated
    "linie": "#191a22",      # --line
    "linie_stark": "#232430",
    "tinte": "#eef1fb",      # --tx-hi
    "leise": "#a3a7bb",      # --tx-mid
    "zeit": "#6b6e80",       # --tx-lo
    "rand": "#7c5cff",       # --violet
    "rand_weich": "#9d86ff",
    "blau": "#22d3ee",       # --cyan
    "gut": "#34d399",        # --mint
    "warn": "#fbbf24",       # --amber
    "schlecht": "#fb7185",   # --rose
    "rosa": "#f472b6",
    # ── Töne der Messwerk-Schicht ───────────────────────────────
    # Keine neuen Farben, nur eine andere Gewichtung derselben Familie: die
    # technischen Elemente — Raster, Skalenstriche, Ringe, Eckklammern —
    # sitzen auf Cyan, weil das in der App ohnehin schon die Farbe für
    # „Verbindung, Technik, Maschine" ist. Violett bleibt die Hausfarbe des
    # Kopfes, Bernstein ist ausschließlich Warnung. Alle Werte sind
    # abgedunkelte Mischungen aus --cyan und --bg-void der App
    # (packages/desktop/src/styles/tokens.css), damit die beiden Oberflächen
    # als eine Familie zu erkennen bleiben.
    "gitter": "#0b1220",        # das driftende Raster, sehr leise
    "gitter_hell": "#122033",   # jede vierte Linie
    "marke": "#1d3347",         # Skalenstriche, ruhende Ringe
    "marke_hell": "#2b5570",    # betonte Striche, Eckklammern
    "marke_klar": "#3d7f9e",    # was gerade Aufmerksamkeit haben soll
    "strahl": "#2a6f8a",        # der Kopf des Abtaststrahls
}

BREIT, HOCH, KOPFHOCH = 1020, 720, 84

# Notmaß für den Hintergrundbetrieb ohne Fensterregel: so hoch ist die Leiste
# am oberen Rand ungefähr. Mit Regel rechnet labwc das selbst und genauer.
RAND_OBEN = 40

# Der Fernzugriff unten bekommt gut ein Viertel der Höhe, aber nie weniger als
# nötig, um Kopf, Tagesauswahl und ein paar Zeilen Verlauf zu zeigen — und nie
# so viel, dass er den Karten darüber die Luft nimmt.
BAND_MIN, BAND_MAX = 210, 340
# Und so flach, solange niemand verbunden ist: Überschrift, eine Zeile
# Zustand, die Tagesauswahl und ein paar Zeilen Rückblick. Mehr braucht der
# Normalfall nicht — und der Normalfall ist, dass niemand da ist.
BAND_RUHE = 172


def mischen(von, nach, anteil):
    a = [int(von[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(nach[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(int(x + (y - x) * anteil) for x, y in zip(a, b))


def groesse(bytes_):
    if not bytes_:
        return "0 B"
    for einheit in ("B", "KB", "MB", "GB", "TB"):
        if abs(bytes_) < 1024 or einheit == "TB":
            return f"{bytes_:.0f} {einheit}" if einheit == "B" else f"{bytes_:.1f} {einheit}"
        bytes_ /= 1024
    return ""


# ── Ablage: Anwendungen, Ordner und Dateien griffbereit ─────────
# Was dort liegt, steht in einer kleinen Datei neben der Spracheinstellung —
# so ist es nach dem Neustart noch da.
ABLAGEDATEI = os.path.expanduser("~/.config/stellium-konsole-ablage.json")
ANWENDUNGSORTE = ("/usr/share/applications", "/usr/local/share/applications",
                  os.path.expanduser("~/.local/share/applications"))
SYMBOLORTE = ("/usr/share/icons", "/usr/local/share/icons",
              os.path.expanduser("~/.local/share/icons"))
# Von groß nach klein gesucht: lieber ein Symbol herunterrechnen als ein
# kleines aufblasen — Tk kann nur ganzzahlig verkleinern, nicht schärfen.
SYMBOLGROESSEN = ("64x64", "48x48", "96x96", "128x128", "32x32", "256x256", "24x24")


def ablage_laden():
    """Die abgelegten Einträge holen — und Unsinn in der Datei überstehen."""
    try:
        with open(ABLAGEDATEI) as f:
            daten = json.load(f)
        eintraege = daten.get("eintraege")
    except (OSError, ValueError, AttributeError):
        return []
    if not isinstance(eintraege, list):
        return []
    return [e for e in eintraege if isinstance(e, dict) and e.get("pfad")]


def ablage_sichern(eintraege):
    try:
        os.makedirs(os.path.dirname(ABLAGEDATEI), exist_ok=True)
        with open(ABLAGEDATEI, "w") as f:
            json.dump({"eintraege": eintraege}, f, ensure_ascii=False, indent=1)
    except OSError:
        pass


def desktop_lesen(pfad):
    """Die Angaben aus einer .desktop-Datei holen.

    Gelesen wird nur der Abschnitt [Desktop Entry]; alles danach sind
    Zusatzaktionen, die hier nichts zu suchen haben.
    """
    angaben = {}
    drin = False
    try:
        with open(pfad, encoding="utf-8", errors="replace") as f:
            for zeile in f:
                zeile = zeile.strip()
                if zeile.startswith("["):
                    drin = zeile == "[Desktop Entry]"
                    continue
                if drin and "=" in zeile and not zeile.startswith("#"):
                    schluessel, wert = zeile.split("=", 1)
                    angaben.setdefault(schluessel.strip(), wert.strip())
    except OSError:
        return {}
    return angaben


def desktop_name(angaben, ersatz=""):
    """Der Name in der eingestellten Sprache, wenn die Datei einen anbietet."""
    return (angaben.get(f"Name[{SPRACHE}]") or angaben.get("Name") or ersatz)


def anwendungen_finden():
    """Alle Anwendungen, die auch im Startmenü stehen — Name, Datei, Symbol."""
    gefunden = {}
    for ort in ANWENDUNGSORTE:
        for pfad in sorted(glob.glob(os.path.join(ort, "*.desktop"))):
            angaben = desktop_lesen(pfad)
            if angaben.get("Type", "Application") != "Application":
                continue
            if angaben.get("NoDisplay", "").lower() == "true":
                continue
            name = desktop_name(angaben)
            if not name:
                continue
            # Spätere Orte überschreiben frühere: was im Heimordner liegt,
            # gilt vor dem, was das System mitbringt.
            gefunden[os.path.basename(pfad)] = (name, pfad, angaben.get("Icon", ""))
    return sorted(gefunden.values(), key=lambda e: e[0].lower())


def symboldatei(name):
    """Zu einem Symbolnamen die passende Bilddatei suchen.

    Tk liest PNG und GIF, kein SVG und kein XPM — deshalb wird auch nur danach
    gesucht. Findet sich nichts, malt die Ablage selbst ein Zeichen.
    """
    if not name:
        return None
    if os.path.isabs(name):
        return name if os.path.isfile(name) and name.endswith((".png", ".gif")) else None
    for groesse in SYMBOLGROESSEN:
        for ort in SYMBOLORTE:
            treffer = glob.glob(os.path.join(ort, "*", groesse, "*", name + ".png"))
            if treffer:
                return treffer[0]
    for ort in ("/usr/share/pixmaps", "/usr/share/icons"):
        treffer = glob.glob(os.path.join(ort, name + ".png"))
        if treffer:
            return treffer[0]
    return None


def eintrag_da(eintrag):
    """Gibt es noch, was da abgelegt wurde?"""
    return bool(eintrag.get("pfad")) and os.path.exists(eintrag["pfad"])


def eintrag_oeffnen(eintrag):
    """Das Abgelegte starten. Gibt zurück, ob es geklappt hat."""
    pfad = eintrag.get("pfad", "")
    try:
        if eintrag.get("art") == "anwendung":
            angaben = desktop_lesen(pfad)
            # Die Platzhalter in Exec stehen für Dateien, die wir nicht
            # mitgeben — sie müssen raus, sonst startet nichts oder das
            # Programm bekommt "%U" als Dateinamen untergeschoben.
            befehl = re.sub(r"%[a-zA-Z]", "", angaben.get("Exec", "")).strip()
            if not befehl:
                return False
            teile = shlex.split(befehl)
            if angaben.get("Terminal", "").lower() == "true":
                teile = ["x-terminal-emulator", "-e"] + teile
            subprocess.Popen(teile, start_new_session=True)
        else:
            # Ordner und Dateien überlässt man am besten dem System: es weiß,
            # welcher Dateimanager und welches Programm zuständig sind.
            subprocess.Popen(["xdg-open", pfad], start_new_session=True)
        return True
    except Exception:                                   # noqa: BLE001
        return False


def prozent(anteil):
    """Ein Anteil als Prozentzahl — kleine Werte mit einer Stelle hinter dem Komma.

    109 MB auf einer 50-GB-Platte sind 0,2 %. Auf null gerundet sähe die
    Anzeige aus, als wäre sie kaputt — eine Stelle mehr sagt genau das, was
    los ist.
    """
    wert = (anteil or 0.0) * 100
    if 0 < wert < 0.05:
        # Noch feiner aufzuschlüsseln bringt nichts — „fast nichts" ist die
        # Aussage, und die steht so am kürzesten da.
        return "<0,1%" if SPRACHE == "de" else "<0.1%"
    if 0 < wert < 9.5:
        text = f"{wert:.1f}"
        return (text.replace(".", ",") if SPRACHE == "de" else text) + "%"
    return f"{round(wert)}%"


def menge(n):
    """Eine ganze Zahl mit Tausenderpunkten — im Englischen mit Komma.


# Währungszeichen statt Kürzel: „$25.00" liest sich, „2500 USD" rechnet man
# erst. Die Beträge kommen aus Gumroad in Cent.
WAEHRUNGSZEICHEN = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"}


def geld(cent, waehrung="USD"):
    if cent is None:
        return "—"
    z = WAEHRUNGSZEICHEN.get((waehrung or "USD").upper())
    betrag = f"{cent / 100:,.2f}"
    return f"{z}{betrag}" if z else f"{betrag} {waehrung}"

    Heißt nicht `zahl`: so heißt schon das Schlüsselwort, mit dem ein Tacho
    seine große Ziffer bekommt, und beides in derselben Zeile zu lesen wäre
    eine Falle.
    """
    text = f"{int(n or 0):,}"
    return text.replace(",", ".") if SPRACHE == "de" else text


BLOECKE = "▁▂▃▄▅▆▇█"


def kurve(werte):
    """Ein Verlauf als eine Zeile Blockzeichen.

    Der Maßstab ist immer der höchste Wert der Reihe selbst — es geht um die
    Form des Tages, nicht um absolute Höhen; die stehen als Zahl daneben.
    Eine Stunde ganz ohne Zugriffe bekommt einen Punkt statt des flachsten
    Blocks, sonst sähe „nichts los" aus wie „ein bisschen was los".
    """
    if not werte:
        return ""
    hoch = max(werte)
    if hoch <= 0:
        return "·" * len(werte)
    # Wurzelmaßstab, nicht linear: bei einem Werbeschub ist die Spitzenstunde
    # hundertmal so hoch wie eine ruhige. Linear gerechnet lägen alle ruhigen
    # Stunden auf dem flachsten Block, und der Tag sähe aus wie ein Strich.
    return "".join("·" if w <= 0 else BLOECKE[min(7, int((w / hoch) ** 0.5 * 8 - 1e-9))]
                   for w in werte)


def dauer(sekunden):
    tage, rest = divmod(int(sekunden), 86400)
    stunden, rest = divmod(rest, 3600)
    minuten = rest // 60
    if tage:
        return f"{tage} {T('tage_kurz')}, {stunden} {T('std')}"
    if stunden:
        return f"{stunden} {T('std')}, {minuten} {T('min')}"
    return f"{minuten} {T('min')}"


def seit_wann(zeitpunkt):
    """Wie lange ist das her — knapp, in Worten.

    Nur der grobe Abstand: bei einem stummen Modell will man wissen, ob es
    seit Minuten oder seit Stunden schweigt. Die genaue Uhrzeit hilft dabei
    nicht, und sie stünde in einer Zeile, in der ohnehin wenig Platz ist.
    """
    if not zeitpunkt:
        return None
    sekunden = max(0, int(time.time() - zeitpunkt / 1000))
    if sekunden < 90:
        return f"{sekunden}s"
    if sekunden < 5400:
        return f"{sekunden // 60} min"
    if sekunden < 172800:
        return f"{sekunden // 3600} h"
    return f"{sekunden // 86400} d"


# Eine einzige Uhr für alles, was sich bewegt. Sie steht hier oben, weil auch
# `Karte.tacho` sie braucht, um neu entstandene Tachos anzumelden.
HERZ = None


class Herzschlag:
    """Eine einzige Uhr für jede Bewegung im Fenster.

    Vorher hatte jeder Tacho seine eigene `after`-Schleife, der Stern eine und
    die Ablage noch eine — neun Wecker, die unabhängig voneinander klingelten.
    Einer genügt: er ruft der Reihe nach alle auf, die sich bewegen wollen.
    Das spart nicht nur Weckrufe, es gibt vor allem *eine* Stelle, an der sich
    alles drosseln lässt.

    Auf dem Pi nachgemessen, sieben Tachos, alles in Bewegung:

        alte Fassung, jeder für sich    21,5 % — und schaffte 18 statt 25 Bilder
        diese Fassung, 30 Bilder je s    1,6 %

    Der Unterschied liegt nicht am Takt, sondern daran, was je Bild geschieht:
    früher wurde jeder Tacho weggeworfen und neu gezeichnet (11,7 ms), jetzt
    werden nur Koordinaten verschoben (0,8 ms). Daraus die Regel, die in dieser
    Datei überall gilt: **einmal anlegen, danach nur noch verstellen — und
    Text nur dann, wenn er wirklich anders lautet.** Ein `itemconfigure`
    kostet 0,024 ms, ob sich etwas ändert oder nicht; bei dreißig Zeilen und
    fünfundzwanzig Bildern je Sekunde ist das der Unterschied zwischen 0,3 %
    und 18 %.

    Nicht drin, obwohl es naheliegt: aufhören zu rechnen, wenn ein Fenster
    darüber liegt. X11 meldet das über `<Visibility>`, und beim
    Schreibtischgrund wäre es der Normalfall — nachgemessen kommt unter labwc
    aber nur `VisibilityUnobscured` an, nie `VisibilityFullyObscured`. Unter
    Wayland wird jedes Fenster für sich zusammengesetzt; verdeckt sein heißt
    dort nicht, nicht gezeichnet zu werden. Der Zweig wäre also nie gelaufen,
    hätte aber ausgesehen, als spare er etwas. Deshalb steht er nicht da.
    """

    BILDER = 30               # Bilder je Sekunde

    def __init__(self, wurzel):
        self.wurzel = wurzel
        self.gaeste = []
        self.n = 0
        self.abstand = 1.0 / self.BILDER
        self.ziel = time.monotonic() + self.abstand
        wurzel.after(1000 // self.BILDER, self._schlag)

    def dazu(self, ruf):
        """Einen Mitläufer anmelden. Er bekommt bei jedem Schlag die Nummer."""
        self.gaeste.append(ruf)

    def _schlag(self):
        self.n += 1
        for ruf in self.gaeste:
            try:
                ruf(self.n)
            except tk.TclError:
                pass              # ein geschlossenes Fenster ist kein Fehler
        # Auf den nächsten festen Zeitpunkt zielen, nicht „von jetzt an
        # nochmal 33 ms". Sonst kommt die Dauer eines jeden Bildes oben
        # drauf und der Abstand schwankt — und ein ungleichmäßiger Takt
        # fällt stärker auf als ein gleichmäßig etwas langsamerer.
        self.ziel += self.abstand
        rest = self.ziel - time.monotonic()
        if rest < 0.003:
            # So weit zurückgefallen, dass Aufholen nur Ruckeln erzeugte:
            # das Raster neu ansetzen statt Bilder nachzuholen.
            self.ziel = time.monotonic() + self.abstand
            rest = self.abstand
        self.wurzel.after(max(1, int(rest * 1000)), self._schlag)


class Tacho(tk.Canvas):
    """Ein Messwert als Instrument: Skalenring, zwei gegenläufige Ringe,
    Zeiger, mitzählende Zahl.

    Was ihn von einem Balken unterscheidet, ist nicht die runde Form, sondern
    dass er nie stillsteht. Der äußere Ring ist gestrichelt und dreht im
    Uhrzeigersinn, der innere besteht aus zwei Segmenten und läuft dagegen —
    beide messen nichts. Sie sind da, damit man aus sechs Metern Abstand
    sieht, dass die Anzeige lebt und nicht eingefroren ist. Ein Schreibtisch-
    grund, der stillsteht, ist von einem abgestürzten nicht zu unterscheiden.

    Das ist erlaubt, weil Drehen fast nichts kostet: ein gestrichelter Bogen
    wird gedreht, indem sich sein Startwinkel ändert — ein `itemconfigure`,
    keine neue Geometrie. Auf dem Pi gemessen: 28 solcher Ringe gleichzeitig
    kosten 1,9 %. Die frühere Fassung warf bei jedem Bild alles weg und legte
    es neu an: 11,7 ms je Bild, 21,5 % — und schaffte trotzdem nur 18 der
    angepeilten 25 Bilder.

    Daraus die Regel für alles hier drin: **einmal anlegen, danach nur noch
    verstellen — und Text nur, wenn er wirklich anders lautet.** Ein
    Schreibvorgang kostet 0,024 ms, ob sich etwas ändert oder nicht.
    """

    GROESSE = 138
    DICKE = 8             # dünner als früher (11): mehr Linie, weniger Fläche
    ANFANG = 210          # oben links …
    WEITE = -240          # … im Uhrzeigersinn bis unten rechts
    MARKEN = 20           # so viele Skalenstriche, jeder fünfte ist lang

    def __init__(self, eltern, titel, stelle=0):
        # Höher als breit, und zwar um genau die Zeile, die unten steht:
        # Platte, Ablage und Temperatur geben eine mit ("103,8 GB frei"), und
        # sie muss *unter* den Ringen liegen. Bei voller Quadrathöhe fiel sie
        # mitten in den äußeren Ring hinein und war schwer zu lesen.
        super().__init__(eltern, width=self.GROESSE, height=self.GROESSE + 15,
                         bd=0, highlightthickness=0, bg=F["karte"])
        self.anteil = 0.0
        self.ziel = 0.0
        self.titel = titel
        self.unten = ""
        # Ein fester Ton für Messwerte, bei denen „viel" nicht „schlecht"
        # heißt: eine hohe Besucherzahl rot zu färben wäre schlicht falsch.
        self.ton = None
        self.zahl_fest = None      # fertiger Text; zählt dann nicht mit
        self.wert = None           # Zahl zum Mitzählen
        self.form = None           # wie sie geschrieben wird
        self.wert_jetzt = 0.0
        # Beim Start baut sich jeder Tacho auf, und zwar nacheinander statt
        # alle auf einmal — versetzt um `stelle`. Mehr ist der ganze Aufbau
        # nicht: ein Zähler, der einmal hochläuft und danach nie wieder etwas
        # kostet.
        self.warten = 5 + stelle * 4
        self.aufbau = 0.0
        self._gezeigt = None       # zuletzt geschriebener Text
        self._letzte_farbe = None
        self._bauen()

    # ── einmaliges Anlegen ──────────────────────────────────────
    def _bauen(self):
        g = self.GROESSE
        m = g / 2
        rand = self.DICKE / 2 + 15
        self.mitte = m
        self.halb = (g - 2 * rand) / 2
        kasten = (rand, rand, g - rand, g - rand)

        # ── Ring 1, ganz außen: gestrichelt, dreht im Uhrzeigersinn.
        a = 2
        self.ring = self.create_arc(a, a, g - a, g - a, start=0, extent=359,
                                    style="arc", width=1, outline=F["marke"],
                                    dash=(2, 7))
        # ── Ring 2: zwei kurze Segmente, gegenläufig und schneller. Zwei
        # Bögen statt eines, weil sie sich gegenüberstehen sollen — das liest
        # sich als ein Ring mit zwei Marken, nicht als zwei Sicheln.
        a = 8
        self.ring2 = self.create_arc(a, a, g - a, g - a, start=0, extent=54,
                                     style="arc", width=1, outline=F["marke_hell"])
        self.ring3 = self.create_arc(a, a, g - a, g - a, start=180, extent=54,
                                     style="arc", width=1, outline=F["marke_hell"])

        # ── Skala: zwanzig Striche, jeder fünfte lang und hell. Das ist der
        # Unterschied zwischen einem Fortschrittsring und einem Instrument.
        # Fest gezeichnet — kostet nur hier, nie wieder.
        for i in range(self.MARKEN + 1):
            w = math.radians(self.ANFANG + self.WEITE * i / self.MARKEN)
            gross = i % 5 == 0
            r1 = self.halb + 6
            r2 = self.halb + (12 if gross else 8)
            self.create_line(m + r1 * math.cos(w), m - r1 * math.sin(w),
                             m + r2 * math.cos(w), m - r2 * math.sin(w),
                             fill=F["marke_hell"] if gross else F["marke"])

        # ── Der Messbogen selbst.
        self.create_arc(*kasten, start=self.ANFANG, extent=self.WEITE,
                        style="arc", width=self.DICKE, outline=F["linie"])
        self.bogen = self.create_arc(*kasten, start=self.ANFANG, extent=-0.1,
                                     style="arc", width=self.DICKE,
                                     outline=F["gut"])
        # Ein Speichen-Strich vom Mittelpunkt zum Zeiger: er macht aus dem
        # Punkt einen Zeiger, der auf etwas deutet.
        self.speiche = self.create_line(m, m, m, m, fill=F["marke_hell"], width=1)
        self.punkt = self.create_oval(0, 0, 0, 0, fill=F["gut"],
                                      outline=F["karte"], width=2)

        # ── Zahl in gleicher Zeichenbreite. Sonst wandert sie beim Zählen hin
        # und her, weil eine 1 schmaler ist als eine 8 — und genau dieses
        # Zappeln ist der Unterschied zwischen „zählt hoch" und „flackert".
        self.zahl = self.create_text(m, m - 4, text="—", fill=F["tinte"],
                                     font=tkfont.Font(family="DejaVu Sans Mono",
                                                      size=16, weight="bold"))
        self.beschriftung = self.create_text(
            m, m + 17, text=self.titel.upper(), fill=F["marke_klar"],
            font=tkfont.Font(family="DejaVu Sans Mono", size=7))
        self.fuss = self.create_text(m, g + 7, text="", fill=F["leise"],
                                     font=tkfont.Font(family="DejaVu Sans", size=8))

    # ── von außen ───────────────────────────────────────────────
    def setzen(self, anteil, zahl=None, unten="", ton=None, wert=None, form=None):
        """Einen neuen Stand melden.

        `zahl` ist wie bisher ein fertiger Text; der zählt dann nicht mit.
        Wer zählen lassen will, gibt `wert` (die Zahl) und `form` (wie sie
        geschrieben wird) — dann läuft die Anzeige gemeinsam mit dem Bogen
        dorthin. Ohne beides zeigt der Tacho den Anteil in Prozent, und der
        zählt von selbst mit, weil er aus dem laufenden Wert entsteht.
        """
        self.ziel = max(0.0, min(1.0, anteil or 0.0))
        self.ton = ton
        self.zahl_fest = zahl if wert is None else None
        if wert is not None:
            if self.wert is None:
                self.wert_jetzt = float(wert)   # beim ersten Mal nicht bei null anfangen
            self.wert = float(wert)
            self.form = form
        if unten != self.unten:
            self.unten = unten
            self.itemconfig(self.fuss, text=unten)

    def sprache_neu(self):
        self.itemconfig(self.beschriftung, text=self.titel.upper())

    # ── je Bild ─────────────────────────────────────────────────
    def farbe(self):
        if self.ton:
            return self.ton
        if self.anteil > 0.88:
            return F["schlecht"]
        if self.anteil > 0.72:
            return F["warn"]
        return F["gut"]

    def schlag(self, n):
        """Ein Bild. Alles hier muss billig sein — es läuft 25 Mal je Sekunde."""
        if self.warten > 0:
            self.warten -= 1
            return

        # Die Ringe laufen immer, gegenläufig und mit verschiedenem Tempo.
        # Drei `itemconfigure` je Bild; für alle sieben Tachos zusammen unter
        # einer halben Millisekunde.
        self.itemconfig(self.ring, start=(n * 0.7) % 360)
        zwei = (-n * 2.1) % 360
        self.itemconfig(self.ring2, start=zwei)
        self.itemconfig(self.ring3, start=(zwei + 180) % 360)

        if self.aufbau < 1.0:
            # Der Aufbau: der Bogen wächst einmal aus dem Nichts auf seinen
            # Wert. Danach ist dieser Zweig für immer erledigt.
            self.aufbau = min(1.0, self.aufbau + 0.04)
            bewegt = True
        else:
            bewegt = False

        if abs(self.anteil - self.ziel) > 0.0015:
            # Weiche Annäherung: große Sprünge schnell, das letzte Stück ruhig.
            self.anteil += (self.ziel - self.anteil) * 0.16
            bewegt = True
        elif self.anteil != self.ziel:
            # Den Rest auf einmal. Ohne das bliebe ein winziger Wert — 0,2 %
            # der Platte etwa — für immer knapp neben dem Ziel stehen.
            self.anteil = self.ziel
            bewegt = True

        if self.wert is not None and abs(self.wert_jetzt - self.wert) > 1e-9:
            weiter = (self.wert - self.wert_jetzt) * 0.16
            self.wert_jetzt = (self.wert if abs(weiter) < 0.5
                               else self.wert_jetzt + weiter)
            bewegt = True

        if not bewegt:
            return              # nichts zu tun — und das ist der Normalfall

        gezeigt = self.anteil * self.aufbau
        weite = self.WEITE * gezeigt
        if 0 < gezeigt < 0.011:
            # Ein sehr kleiner Anteil bekommt trotzdem einen sichtbaren Anfang:
            # unter zweieinhalb Grad bliebe vom Bogen nichts übrig.
            weite = math.copysign(2.5, self.WEITE)
        self.itemconfig(self.bogen, extent=weite if abs(weite) > 0.1 else -0.1)

        w = math.radians(self.ANFANG + weite)
        kx, ky = math.cos(w), math.sin(w)
        px = self.mitte + self.halb * kx
        py = self.mitte - self.halb * ky
        self.coords(self.punkt, px - 4, py - 4, px + 4, py + 4)
        self.coords(self.speiche,
                    self.mitte + (self.halb - 22) * kx,
                    self.mitte - (self.halb - 22) * ky, px, py)

        # Bei null tritt der Tacho zurück: ein ruhender grauer Punkt am Anfang
        # des Bogens statt eines leeren Rings, und auch die Ziffer wird leiser.
        # „Gerade niemand da" ist eine Auskunft wie jede andere — ein leerer
        # Ring dagegen sieht aus, als sei die Anzeige nicht fertig geworden.
        # Dann liegt die Auskunft in der Zeile darunter, und dorthin soll das
        # Auge gehen.
        leer = self.ziel <= 0
        farbe = F["zeit"] if leer else self.farbe()
        if farbe != self._letzte_farbe:
            self.itemconfig(self.bogen, outline=farbe)
            self.itemconfig(self.punkt, fill=farbe)
            self.itemconfig(self.speiche, fill=F["karte"] if leer else F["marke_hell"])
            self.itemconfig(self.zahl, fill=F["leise"] if leer else F["tinte"])
            self._letzte_farbe = farbe

        # Der Text kommt zuletzt und nur, wenn er wirklich anders lautet. Er
        # ist der teuerste Teil eines Bildes, und bei einem ruhenden Wert wäre
        # jeder Schreibvorgang vergeudet.
        if self.zahl_fest is not None:
            text = self.zahl_fest
        elif self.wert is not None:
            text = (self.form or (lambda v: f"{v:.0f}"))(self.wert_jetzt)
        else:
            text = prozent(self.anteil)
        if text != self._gezeigt:
            self.itemconfig(self.zahl, text=text)
            self._gezeigt = text


class Karte(tk.Frame):
    """Ein abgesetzter Block mit Überschrift, Eckwinkeln und Kopflinie.

    Statt eines geschlossenen Rahmens vier Winkel in den Ecken und ein Strich
    unter der Überschrift. Das liest sich als Messgerät statt als Formular —
    und weil die Winkel in den 16 Pixeln Rand liegen, die der Inhalt ohnehin
    frei lässt, kostet es keinen Platz.

    Der Rahmen liegt auf einer eigenen Leinwand *hinter* dem Inhalt: mit
    `place` statt `pack`, sonst nähme er Raum weg. Gezeichnet wird er nur bei
    Größenänderung.
    """

    def __init__(self, eltern, titel_key, farbe=None, kennung=None):
        # Der Rahmen selbst trägt den Ton der Bühne, nicht den der Karte: die
        # runde Fläche malt gleich die Leinwand darauf. Wäre er in Kartenfarbe,
        # blitzten an den vier Ecken rechteckige Zipfel hervor.
        super().__init__(eltern, bg=F["grund"], highlightthickness=0, bd=0)
        self.titel_key = titel_key
        self.ton = farbe or F["rand"]
        self.kennung = kennung or ""
        self._masse = None

        # Die Leinwand deckt die ganze Karte ab und liegt ganz unten, weil sie
        # als erstes Kind entsteht — Tk stapelt in der Reihenfolge des
        # Anlegens. Der Inhalt darüber ist deckend; sichtbar bleibt der Rand.
        self.grund = tk.Canvas(self, bg=F["grund"], bd=0, highlightthickness=0)
        self.grund.place(x=0, y=0, relwidth=1, relheight=1)
        self.bind("<Configure>", self._rahmen_richten)

        self.kopf = kopf = tk.Frame(self, bg=F["karte"])
        kopf.pack(fill="x", padx=16, pady=(11, 8))
        self.titel_label = tk.Label(kopf, text=self._titel(), bg=F["karte"],
                                    fg=F["karte"], anchor="w",
                                    font=tkfont.Font(family="DejaVu Sans", size=11,
                                                     weight="bold"))
        self.titel_label.pack(side="left")
        if self.kennung:
            # Eine kleine technische Beschriftung, die nichts erklärt, sondern
            # nur ordnet — wie die Nummer an einem Schaltschrank.
            tk.Label(kopf, text=self.kennung, bg=F["karte"], fg=F["marke_hell"],
                     anchor="e", font=tkfont.Font(family="DejaVu Sans Mono", size=8)
                     ).pack(side="right")

        self.inhalt = tk.Frame(self, bg=F["karte"])
        self.inhalt.pack(fill="both", expand=True, padx=16, pady=(0, 12))
        self.zeilen = {}
        self.beschriftungen = {}
        self.tachos = {}
        self.stand = {}          # was zuletzt in einer Zeile stand, mit Farbe
        self.festen = {}         # feste Beschriftungen, die wechseln können
        self._blinken = {}       # Zeilen, die gerade nachleuchten
        self.punkt = self.hof = self.punkt_leinwand = None
        # Beim Start zeichnet sich die Karte selbst: die Fläche blendet auf,
        # die Eckklammern wachsen aus den Ecken heraus, der Strich unter der
        # Überschrift läuft nach rechts aus. Kostet nur die erste Sekunde.
        self.aufbau = 0.0
        self.aufbau_warten = 0

    # ── Überschrift und Ton ─────────────────────────────────────
    def _titel(self):
        """Die Überschrift holen.

        Normalerweise ein Schlüssel aus `TEXTE`. Der Fernzugriff bringt seine
        Beschriftungen aber selbst mit — er ist ein eigenes Programm — und
        übergibt deshalb eine Funktion. So steht dort in beiden Sprachen
        dasselbe wie in seinem eigenen Fenster, ohne dass ein Text doppelt
        gepflegt werden muss.
        """
        return self.titel_key() if callable(self.titel_key) else T(self.titel_key)

    def ton_setzen(self, farbe):
        """Den Ton der Karte wechseln — Überschrift und Eckwinkel folgen mit.

        Kommt selten vor und kostet deshalb nichts: beim Fernzugriff genau
        dann, wenn sich jemand verbindet oder wieder geht. Dass die Winkel
        aufleuchten, ist die eigentliche Meldung — man sieht sie quer durch
        den Raum, ohne ein Wort zu lesen.
        """
        if farbe == self.ton:
            return
        self.ton = farbe
        self.titel_label.config(fg=farbe)
        self._masse = None                  # erzwingt das Neuzeichnen
        self._rahmen_richten()
        if self.punkt is not None:
            self.punkt_leinwand.itemconfig(self.punkt, fill=farbe)
            self.punkt_leinwand.itemconfig(self.hof, outline=F["linie"])

    def punkt_zeigen(self):
        """Einen kleinen Punkt neben die Überschrift setzen, der atmen kann."""
        if self.punkt is not None:
            return
        c = tk.Canvas(self.kopf, width=15, height=15, bd=0, highlightthickness=0,
                      bg=F["karte"])
        c.pack(side="left", padx=(9, 0))
        self.punkt_leinwand = c
        self.hof = c.create_oval(1, 1, 14, 14, outline=F["linie"], fill="")
        self.punkt = c.create_oval(5, 5, 10, 10, fill=self.ton, outline="")

    # ── Rahmen ──────────────────────────────────────────────────
    def _rahmen_richten(self, _e=None):
        b, h = self.winfo_width(), self.winfo_height()
        if b < 20 or h < 20:
            return
        if (b, h) == self._masse and self.aufbau >= 1.0:
            return
        self._masse = (b, h)
        self._rahmen_malen(b, h)

    def _rahmen_malen(self, b, h):
        """Fläche, Umriss und Eckklammern zeichnen.

        Die Fläche ist rund wie in der App (13 px, --r-md), damit man beiden
        Oberflächen ansieht, dass sie zusammengehören. Darüber kommt die neue
        Schicht: kurze Winkel in den vier Ecken in Cyan — das liest sich
        sofort als Zielerfassung statt als Formular. Ein geschlossener Rahmen
        wäre der brave, aber falsche Weg.

        `aufbau` läuft beim Start einmal von 0 auf 1. Solange er unterwegs
        ist, wird hier bei jedem Bild neu gezeichnet; danach nie wieder, außer
        die Karte ändert ihre Größe.
        """
        c = self.grund
        c.delete("rahmen")
        auf = self.aufbau
        if auf <= 0.01:
            return
        # Die Fläche blendet aus dem Bühnenton in den Kartenton auf.
        rundes_rechteck(c, 1, 1, b - 1, h - 1, 13, tags="rahmen",
                        fill=mischen(F["grund"], F["karte"], min(1.0, auf * 1.6)),
                        outline=F["linie"])
        # Vier Eckklammern, die aus den Ecken herauswachsen.
        e = 20 * auf
        r = 13
        for x, y, dx, dy in ((2, 2, 1, 1), (b - 2, 2, -1, 1),
                             (2, h - 2, 1, -1), (b - 2, h - 2, -1, -1)):
            c.create_line(x + dx * r, y, x + dx * (r + e), y,
                          fill=self.ton, tags="rahmen")
            c.create_line(x, y + dy * r, x, y + dy * (r + e),
                          fill=self.ton, tags="rahmen")
        # Der Strich unter der Überschrift läuft nach rechts aus.
        breit = (b - 32) * auf
        c.create_line(16, 36, 16 + breit, 36, fill=F["linie"], tags="rahmen")
        c.create_line(16, 36, 16 + min(breit, 54), 36, fill=self.ton, tags="rahmen")
        # Zwei winzige Striche am rechten Ende — eine Skala, die nichts misst,
        # aber die Kante technisch abschließt statt sie auslaufen zu lassen.
        for versatz in (0, 5, 10):
            x = 16 + breit - versatz * 2
            if x > 16 + 60:
                c.create_line(x, 33, x, 39, fill=F["marke"], tags="rahmen")

    def schlag(self, n):
        """Aufbau und Nachleuchten. Wird vom Herzschlag gerufen.

        Im eingeschwungenen Zustand fallen beide Zweige sofort durch — eine
        Karte, an der sich nichts ändert, kostet je Bild einen Vergleich.
        """
        if self.aufbau < 1.0:
            if self.aufbau_warten > 0:
                self.aufbau_warten -= 1
            else:
                self.aufbau = min(1.0, self.aufbau + 0.06)
                b, h = self.winfo_width(), self.winfo_height()
                if b > 20 and h > 20:
                    self._rahmen_malen(b, h)
                self.titel_label.config(
                    fg=mischen(F["karte"], self.ton, min(1.0, self.aufbau * 1.4)))
        if self._blinken:
            self.blinken_schlag()

    # ── Inhalt ──────────────────────────────────────────────────
    def feld(self, name, wert, farbe=None, roh=None):
        """Eine Zeile setzen. `name` ist ein Schlüssel, `roh` eine feste Beschriftung."""
        if name not in self.zeilen:
            reihe = tk.Frame(self.inhalt, bg=F["karte"])
            reihe.pack(fill="x", pady=1)
            links = tk.Label(reihe, text=roh or T(name), bg=F["karte"], fg=F["zeit"], anchor="w",
                             width=16, font=tkfont.Font(family="DejaVu Sans", size=10))
            links.pack(side="left")
            if roh is None:
                self.beschriftungen[name] = links
            else:
                # Auch eine feste Beschriftung kann wechseln — „5 Tage" wird
                # morgen zu „6 Tage", und beim Sprachwechsel zu „6 days".
                self.festen[name] = links
            # Umbrechen statt abschneiden: lange Werte wie "8 Konten · 16 Kanäle
            # · 132 Nachrichten" passten sonst nicht in die Spalte.
            rechts = tk.Label(reihe, text="", bg=F["karte"], fg=F["tinte"], anchor="w",
                              justify="left", wraplength=1,
                              font=tkfont.Font(family="DejaVu Sans Mono", size=10))
            rechts.pack(side="left", fill="x", expand=True)
            reihe.bind("<Configure>",
                       lambda e, w=rechts: w.config(wraplength=max(e.width - 130, 120)))
            self.zeilen[name] = rechts
        # Nur schreiben, was sich wirklich geändert hat. Ein `config` auf ein
        # Label zieht bei Tk Neuvermessung und Neuzeichnung nach sich — und
        # das Meiste hier steht zwei Sekunden später unverändert da. Bei
        # vierzig Zeilen alle zwei Sekunden ist das der teuerste Teil der
        # ganzen Anzeige, obwohl fast nichts passiert. Gemessen: von 1566
        # Aufrufen in 40 Sekunden bleiben 29 echte Schreibvorgänge übrig.
        #
        # Genau diese Ersparnis ist das Budget, aus dem die Bewegung bezahlt
        # wird: Zeichnen kostet auf dem Pi fast nichts, Schreiben viel.
        ton = farbe or F["tinte"]
        if self.stand.get(name) == (wert, ton):
            return
        neu = name in self.stand
        self.stand[name] = (wert, ton)
        self.zeilen[name].config(text=wert, fg=ton)
        if neu:
            # Was sich gerade geändert hat, leuchtet kurz auf und verlischt
            # wieder. Das ist die einzige Bewegung hier, die etwas *meldet*
            # statt zu schmücken — und sie läuft nur bei echter Änderung, beim
            # ersten Füllen also nicht.
            self._blinken[name] = [10, ton]

    def beschriftung_setzen(self, name, roh):
        """Eine feste Beschriftung nachziehen, wenn sie sich geändert hat."""
        label = self.festen.get(name)
        if label is not None and label.cget("text") != roh:
            label.config(text=roh)

    def blinken_schlag(self):
        """Das Nachleuchten weiterführen — von `schlag` aus."""
        for name in list(self._blinken):
            rest, ziel = self._blinken[name]
            rest -= 1
            if rest <= 0:
                self.zeilen[name].config(fg=ziel)
                del self._blinken[name]
            else:
                self._blinken[name][0] = rest
                self.zeilen[name].config(
                    fg=mischen(ziel, "#ffffff", rest / 10 * 0.55))

    def tacho(self, name, anteil, zahl=None, unten="", ton=None, wert=None, form=None):
        """Einen Messwert als Bogen zeigen.

        Zwei nebeneinander, dann Umbruch: eine Reihe aus vier braucht über
        550 Pixel und fiel bei schmalem Fenster hinten heraus.
        """
        if not hasattr(self, "tacho_raster"):
            self.tacho_raster = tk.Frame(self.inhalt, bg=F["karte"])
            self.tacho_raster.pack(fill="x", pady=(2, 8))
            self.tacho_raster.columnconfigure(0, weight=1)
            self.tacho_raster.columnconfigure(1, weight=1)
        if name not in self.tachos:
            stelle = len(self.tachos)
            t = Tacho(self.tacho_raster, T(name), stelle)
            t.grid(row=stelle // 2, column=stelle % 2, padx=6, pady=3)
            self.tachos[name] = t
            if HERZ is not None:
                HERZ.dazu(t.schlag)
        self.tachos[name].setzen(anteil, zahl, unten, ton, wert, form)

    def sprache_anwenden(self):
        # Der gemerkte Stand gilt für die alte Sprache — er muss weg, sonst
        # hielte die Ersparnis oben die neuen Beschriftungen zurück.
        self.stand.clear()
        self.titel_label.config(text=self._titel())
        for schluessel, label in self.beschriftungen.items():
            label.config(text=T(schluessel))
        for schluessel, t in self.tachos.items():
            t.titel = T(schluessel)
            t.sprache_neu()


def prozesse_suchen(name):
    """Wie viele Prozesse dieses Namens laufen — und wieviel Speicher sie belegen.

    Gelesen wird `/proc` unmittelbar, statt `pgrep` aufzurufen. Das ist ein
    Verzeichnislauf über ein paar hundert Einträge und dauert wenige
    Millisekunden, während jeder Aufruf nach außen auf diesem Pi allein für
    den Start siebzig Millisekunden kostet. Genau dieser Posten — ein
    Unterprozess für eine Kleinigkeit, und das immer wieder — ist bei
    `stellium-konsole.mjs` der teuerste der ganzen Konsole; hier soll er gar
    nicht erst entstehen.

    `comm` im Kern ist auf fünfzehn Zeichen gekürzt, deshalb wird auch der
    gesuchte Name gekürzt: sonst fände „libreoffice-writer" nie sich selbst.
    """
    name = (name or "")[:15]
    if not name:
        return 0, 0
    anzahl, belegt = 0, 0
    try:
        eintraege = os.listdir("/proc")
    except OSError:
        return 0, 0
    for eintrag in eintraege:
        if not eintrag.isdigit():
            continue
        try:
            with open(f"/proc/{eintrag}/comm") as f:
                if f.read().strip() != name:
                    continue
            anzahl += 1
            with open(f"/proc/{eintrag}/status") as f:
                for zeile in f:
                    if zeile.startswith("VmRSS:"):
                        belegt += int(zeile.split()[1]) * 1024
                        break
        except (OSError, ValueError):
            continue          # der Prozess war schneller weg als wir da
    return anzahl, belegt


def befehl_von(eintrag):
    """Der nackte Programmname hinter einem Ablage-Eintrag, oder \"\"."""
    if eintrag.get("art") != "anwendung":
        return ""
    angaben = desktop_lesen(eintrag.get("pfad", ""))
    befehl = re.sub(r"%[a-zA-Z]", "", angaben.get("Exec", "")).strip()
    if not befehl:
        return ""
    try:
        return os.path.basename(shlex.split(befehl)[0])
    except (ValueError, IndexError):
        return ""


class Sprechblase:
    """Was hinter einem Platz der Schnellzugriff-Leiste steckt.

    Die Kacheln tragen keine Beschriftung mehr — abgeschnittene Namen wie
    „Chromium Web ..." waren weder schön noch nützlich, und die Leiste wurde
    davon unruhig. Der volle Name steht jetzt hier, zusammen mit dem, was man
    der Kachel gerade *nicht* ansieht: ob das Programm in diesem Moment läuft,
    wie viel Speicher es belegt, wohin der Platz zeigt.

    Drei Dinge, an denen so etwas üblicherweise scheitert, und wie sie hier
    gelöst sind:

    **Flackern.** Sie geht erst nach einer kurzen Weile auf (`WARTEN`), sonst
    zuckt es beim bloßen Vorbeifahren über die Leiste. Beim Verlassen
    verschwindet sie weich statt sofort.

    **Aus dem Bild laufen.** Sie legt sich rechts neben den Platz und darüber;
    passt sie dort nicht, klappt sie auf die andere Seite. Am Rand
    abgeschnitten wird sie nie.

    **Kosten.** „Läuft der Prozess?" ist eine Frage an das System und hat in
    einer Zeichenschleife nichts verloren. Sie wird genau einmal beim Aufgehen
    gestellt und danach `HALTBAR` Sekunden lang nicht wieder — und sie läuft
    über `/proc` statt über einen Unterprozess.
    """

    WARTEN = 10           # Bilder bis zum Aufgehen: 400 ms bei 25 Bildern
    HALTBAR = 5.0         # so lange gilt eine einmal geholte Auskunft
    RAND = 11             # Luft zwischen Text und Umriss

    def __init__(self, ablage):
        self.a = ablage
        self.buehne = ablage.buehne
        self.stelle = None            # worüber der Zeiger steht
        self.gezeigt = None           # was gerade offen ist
        self.zaehler = 0              # Bilder, seit der Zeiger dort steht
        self.auf = 0.0                # 0 = zu, 1 = ganz offen
        self.wissen = {}              # Platz → (wann, Zeilen)
        self.fett = tkfont.Font(family="DejaVu Sans", size=10, weight="bold")
        self.schrift = tkfont.Font(family="DejaVu Sans", size=9)
        self.eng = tkfont.Font(family="DejaVu Sans Mono", size=8)

    # ── von außen ───────────────────────────────────────────────
    def ueber(self, stelle):
        """Der Zeiger steht über diesem Platz — oder über keinem (None)."""
        if stelle == self.stelle:
            return
        self.stelle = stelle
        self.zaehler = 0

    def zumachen(self):
        """Sofort schließen — etwa, wenn geklickt wird."""
        self.stelle = None
        self.zaehler = 0
        if self.gezeigt is not None:
            self.auf = 0.0
            self.gezeigt = None
            self.buehne.delete("blase")

    # ── je Bild ─────────────────────────────────────────────────
    def schlag(self, _n=0):
        """Aufgehen, Aufbauen, Zugehen. Steht der Zeiger nirgends, bricht das
        hier in der ersten Zeile ab — und das ist der Normalfall."""
        if self.stelle is None and self.gezeigt is None:
            return
        if self.stelle is not None:
            if self.gezeigt != self.stelle:
                self.zaehler += 1
                if self.zaehler >= self.WARTEN:
                    self.oeffnen(self.stelle)
            elif self.auf < 1.0:
                self.auf = min(1.0, self.auf + 0.18)
                self.malen()
            return
        # Der Zeiger ist weg: weich schließen.
        self.auf -= 0.22
        if self.auf <= 0:
            self.zumachen()
        else:
            self.malen()

    def oeffnen(self, stelle):
        self.gezeigt = stelle
        self.auf = 0.12
        self.malen()

    # ── Auskunft holen ──────────────────────────────────────────
    def zeilen(self, stelle):
        """Was über diesen Platz zu sagen ist — höchstens alle paar Sekunden neu."""
        jetzt = time.time()
        gemerkt = self.wissen.get(stelle)
        if gemerkt and jetzt - gemerkt[0] < self.HALTBAR:
            return gemerkt[1]
        zeilen = self.holen(stelle)
        self.wissen[stelle] = (jetzt, zeilen)
        return zeilen

    def holen(self, stelle):
        """Die eigentliche Nachschau. Läuft nur beim Aufgehen, nie im Takt."""
        eintrag = (self.a.eintraege[stelle]
                   if stelle < len(self.a.eintraege) else None)
        if eintrag is None:
            # Nicht die Überschrift des Abschnitts wiederholen — die steht
            # zwei Zentimeter darüber. Hier gehört hin, was dieser eine Platz
            # ist und was man mit ihm tun kann.
            return [(T("blase_frei"), self.fett, F["tinte"]),
                    (T("blase_frei_wie"), self.schrift, F["leise"])]

        pfad = eintrag.get("pfad", "")
        name = eintrag.get("name") or os.path.basename(pfad)
        art = eintrag.get("art")
        zeilen = [(name, self.fett, F["tinte"])]

        if not eintrag_da(eintrag):
            # Das Wichtigste zuerst: der Platz zeigt ins Leere.
            zeilen.append((T("blase_weg"), self.schrift, F["schlecht"]))
            zeilen.append((T("blase_weg_grund"), self.schrift, F["zeit"]))
            zeilen.append((pfad, self.eng, F["zeit"]))
            return zeilen

        if art == "anwendung":
            zeilen.append((T("blase_anwendung"), self.schrift, F["marke_klar"]))
            programm = befehl_von(eintrag)
            anzahl, belegt = prozesse_suchen(programm)
            if anzahl:
                wort = T("blase_vorgang") if anzahl == 1 else T("blase_vorgaenge")
                text = f"{T('blase_laeuft')}  ·  {anzahl} {wort}"
                if belegt:
                    text += f"  ·  {groesse(belegt)}"
                zeilen.append((text, self.schrift, F["gut"]))
            else:
                zeilen.append((T("blase_laeuft_nicht"), self.schrift, F["zeit"]))
            if programm:
                zeilen.append((programm, self.eng, F["leise"]))
        elif art == "ordner":
            zeilen.append((T("blase_ordner"), self.schrift, F["marke_klar"]))
            try:
                n = len(os.listdir(pfad))
                zeilen.append((T("blase_eintraege", n=n) if n else T("blase_leer"),
                               self.schrift, F["leise"]))
            except OSError:
                zeilen.append((T("blase_unlesbar"), self.schrift, F["warn"]))
        else:
            zeilen.append((T("blase_datei"), self.schrift, F["marke_klar"]))
            try:
                st = os.stat(pfad)
                wann = time.strftime("%d.%m.%Y, %H:%M", time.localtime(st.st_mtime))
                zeilen.append((f"{groesse(st.st_size)}  ·  {T('blase_geaendert')} {wann}",
                               self.schrift, F["leise"]))
            except OSError:
                zeilen.append((T("blase_unlesbar"), self.schrift, F["warn"]))

        zeilen.append((pfad, self.eng, F["zeit"]))
        return zeilen

    # ── Zeichnen ────────────────────────────────────────────────
    def malen(self):
        self.buehne.delete("blase")
        if self.gezeigt is None or self.auf <= 0:
            return
        platz = next((p for p in self.a.plaetze if p[0] == self.gezeigt), None)
        if platz is None:
            return
        _stelle, kx, ky, kb, kh = platz
        zeilen = self.zeilen(self.gezeigt)

        breit = max(f.measure(text) for text, f, _ton in zeilen) + 2 * self.RAND
        hoch = sum(f.metrics("linespace") + 3 for _t, f, _ton in zeilen) + 2 * self.RAND - 3

        # Sie bleibt auf blanker Leinwand. Das ist strenger als „im Bild
        # bleiben", und der Grund ist erst am Abzug zu sehen: Karten sind
        # eingebettete Fenster und liegen *immer* über allem, was auf der
        # Leinwand gezeichnet ist. Eine Sprechblase, die nach rechts in die
        # Nachbarspalte ragte, war zwar im Bild — aber zur Hälfte unter der
        # Karte daneben verschwunden („Click to place somet…").
        #
        # Frei ist der Streifen von der Oberkante der Leiste bis zum Ende
        # der nutzbaren Fläche; darunter beginnt die Karte des
        # Fernzugriffs. Waagerecht bleibt sie in der Breite der Leiste —
        # rechts daneben steht die nächste Spalte.
        flaeche = self.a.flaeche or (8, 8, max(self.buehne.winfo_width(), 1), 0)
        fx, fy, fb, _fh = flaeche
        grenze = getattr(self.a.k, "nutz_unten", 0) or self.buehne.winfo_height()
        x = min(max(kx, fx), max(fx, fx + fb - breit))
        # Zuerst unter den Platz. Passt sie dort nicht mehr, darüber — und
        # notfalls so weit hoch, wie die Leiste reicht, aber keinen Pixel
        # höher.
        y = ky + kh + 8
        if y + hoch > grenze - 4:
            y = min(ky - hoch - 8, grenze - 4 - hoch)
        y = max(fy, y)

        # Das Aufbauen: sie schiebt sich ein Stück heran und die Farben kommen
        # nach. Der Kasten hat dabei von Anfang an seine volle Größe — als er
        # noch wuchs, stand der Text bereits vollständig darin und ragte über
        # den Rand hinaus ("shift-click to chan…"). Ein Kasten, der kleiner
        # ist als sein Inhalt, ist kein Aufbau, sondern ein Fehler.
        auf = self.auf
        x1 = x + (1 - auf) * 9
        y1, x2, y2 = y, x1 + breit, y + hoch

        rundes_rechteck(self.buehne, x1, y1, x2, y2, 9, tags="blase",
                        fill=mischen(F["grund"], F["karte2"], auf),
                        outline=mischen(F["grund"], F["linie"], auf))
        # Eckklammern in Cyan — dieselbe Sprache wie die Karten.
        e = 13 * auf
        for ex, ey, dx, dy in ((x1 + 9, y1, 1, 1), (x2 - 9, y1, -1, 1),
                               (x1 + 9, y2, 1, -1), (x2 - 9, y2, -1, -1)):
            ton = mischen(F["grund"], F["marke_klar"], auf)
            self.buehne.create_line(ex, ey, ex + dx * e, ey, fill=ton, tags="blase")
            self.buehne.create_line(ex - dx * 9, ey + dy * 9, ex - dx * 9,
                                    ey + dy * (9 + e), fill=ton, tags="blase")

        if auf < 0.55:
            return                    # der Text kommt erst, wenn der Kasten steht
        klar = (auf - 0.55) / 0.45
        ty = y1 + self.RAND
        for text, f, ton in zeilen:
            self.buehne.create_text(x1 + self.RAND, ty, text=text, anchor="nw",
                                    fill=mischen(F["karte2"], ton, klar),
                                    font=f, tags="blase")
            ty += f.metrics("linespace") + 3


class Ablage:
    """Die Leiste mit Plätzen für Anwendungen, Ordner und Dateien.

    Sie wird nicht aus Widgets gebaut, sondern direkt auf die Leinwand
    gezeichnet — dorthin, wo unter der linken Spalte Platz frei bleibt. Das
    hält sie leicht und beweglich: Sie teilt sich bei jeder Größenänderung neu
    auf, und wie viele Plätze nebeneinander passen, ergibt sich aus der
    Fläche statt aus einer festen Zahl.

    Die Einträge stehen als Liste in einer Datei. Sie füllen die Plätze von
    links oben nach rechts unten; wird die Fläche kleiner, rücken sie
    zusammen, statt verlorenzugehen.
    """

    BREIT_MIN = 108        # schmaler wird ein Platz nicht
    # Seit der Name in der Sprechblase steht und nicht mehr in der Kachel,
    # braucht ein Platz nur noch Höhe fürs Symbol. Vorher waren es 58 —
    # bei knapper Höhe fiel deshalb die zweite Reihe ganz weg.
    HOCH_MIN = 46          # darunter wird das Symbol zu klein
    HOCH_MAX = 96
    LUECKE = 10
    REIHEN = 2

    def __init__(self, konsole):
        self.k = konsole
        self.buehne = konsole.buehne
        self.eintraege = ablage_laden()
        self.bilder = {}                # Tk hält Bilder nur, solange man sie festhält
        self.flaeche = None             # (x, y, breite, hoehe)
        self.stand = None               # woraus das letzte Bild entstand
        self.plaetze = []               # (index, x, y, breite, hoehe)
        self.warm = {}                  # Platz → wohin die Helligkeit will
        self.helligkeit = {}            # Platz → wo sie gerade steht
        self.blase = Sprechblase(self)
        if HERZ is not None:
            HERZ.dazu(self.laufen)
            HERZ.dazu(self.blase.schlag)
        # Die Plätze fangen ihre Ereignisse nicht mehr selbst: sie haben keine
        # Füllung mehr, und ein Rechteck ohne Füllung wird von Tk nur auf
        # seinem Umriss getroffen — mitten in der Kachel geschähe nichts. Also
        # hört die Leinwand zu, und hier wird nachgerechnet, welcher Platz
        # gemeint war. Das ist zugleich die Stelle, an der die Sprechblase
        # erfährt, worüber der Zeiger steht.
        self.buehne.bind("<Motion>", self.zeiger_bewegt, add="+")
        self.buehne.bind("<Button-1>", self.zeiger_klick, add="+")
        self.buehne.bind("<Shift-Button-1>", self.zeiger_um, add="+")
        self.buehne.bind("<Leave>", lambda _e: self.zeiger_weg(), add="+")

    # ── Zeiger ──────────────────────────────────────────────────
    def treffer(self, x, y):
        """Welcher Platz liegt unter diesem Punkt? Keiner → None."""
        for stelle, kx, ky, kb, kh in self.plaetze:
            if kx <= x <= kx + kb and ky <= y <= ky + kh:
                return stelle
        return None

    def zeiger_bewegt(self, ereignis):
        stelle = self.treffer(ereignis.x, ereignis.y)
        for s in self.warm:
            self.warm[s] = 1.0 if s == stelle else 0.0
        self.blase.ueber(stelle)

    def zeiger_weg(self):
        for s in self.warm:
            self.warm[s] = 0.0
        self.blase.ueber(None)

    def zeiger_klick(self, ereignis):
        stelle = self.treffer(ereignis.x, ereignis.y)
        if stelle is None:
            return
        self.blase.zumachen()       # sie soll dem Auswahlfenster nicht im Weg stehen
        self.klick(stelle)

    def zeiger_um(self, ereignis):
        stelle = self.treffer(ereignis.x, ereignis.y)
        if stelle is None:
            return
        self.blase.zumachen()
        self.aendern(stelle)

    # ── Platz einteilen ─────────────────────────────────────────
    def setzen(self, x, y, breite, hoehe):
        """Sagen, wo Platz ist. Gezeichnet wird nur, wenn sich etwas ändert."""
        self.flaeche = (x, y, breite, hoehe)
        self.pruefen()

    def pruefen(self):
        if self.flaeche is None:
            return
        x, y, breite, hoehe = self.flaeche
        stand = (x, y, breite, hoehe, len(self.eintraege), SPRACHE,
                 tuple(e.get("pfad", "") for e in self.eintraege))
        if stand == self.stand:
            return
        self.stand = stand
        self.zeichnen()

    def zeichnen(self):
        self.buehne.delete("ablage")
        # Die Plätze rücken gleich woandershin — was gerade aufgeht, gälte
        # dann für eine Kachel, die es so nicht mehr gibt.
        if getattr(self, "blase", None) is not None:
            self.blase.zumachen()
        self.plaetze = []
        self.warm = {}
        self.helligkeit = {}
        if self.flaeche is None:
            return
        x, y, breite, hoehe = self.flaeche
        for ex, ey, dx, dy in ((x, y, 1, 1), (x + breite, y, -1, 1),
                               (x, y + hoehe, 1, -1),
                               (x + breite, y + hoehe, -1, -1)):
            self.buehne.create_line(ex, ey, ex + dx * 16, ey,
                                    fill=F["marke_hell"], tags="ablage")
            self.buehne.create_line(ex, ey, ex, ey + dy * 16,
                                    fill=F["marke_hell"], tags="ablage")
        klein = tkfont.Font(family="DejaVu Sans", size=8)
        kopf = tkfont.Font(family="DejaVu Sans", size=9, weight="bold")

        # Überschrift und Hinweis kosten Höhe — nur wenn sie übrig ist.
        kopfhoch = 0
        # Die Überschrift zuerst: ohne sie steht dort eine Reihe Kacheln ohne
        # Erklärung. Vorher wich sie, sobald zwei volle Reihen nicht mehr
        # hineinpassten — dann lieber eine Reihe weniger als keine Beschriftung.
        if hoehe >= self.HOCH_MIN + 22:
            self.buehne.create_text(x, y, text=T("ablage_titel"), anchor="nw",
                                    fill=F["zeit"], font=kopf, tags="ablage")
            self.buehne.create_text(x + breite, y + 1, text=T("ablage_hinweis"), anchor="ne",
                                    fill=F["linie_stark"], font=klein, tags="ablage")
            self.buehne.create_line(x, y + 16, x + breite, y + 16,
                                    fill=F["linie"], tags="ablage")
            self.buehne.create_line(x, y + 16, x + 46, y + 16,
                                    fill=F["rand_weich"], tags="ablage")
            kopfhoch = 22
        y += kopfhoch
        hoehe -= kopfhoch

        reihen = self.REIHEN
        kachel_h = (hoehe - self.LUECKE * (reihen - 1)) / reihen
        if kachel_h < self.HOCH_MIN:
            reihen = 1
            kachel_h = hoehe
        if kachel_h < self.HOCH_MIN:
            return                      # zu wenig Luft — dann lieber gar nichts
        kachel_h = min(kachel_h, self.HOCH_MAX)

        spalten = max(1, int((breite + self.LUECKE) // (self.BREIT_MIN + self.LUECKE)))
        kachel_b = (breite - self.LUECKE * (spalten - 1)) / spalten

        for stelle in range(spalten * reihen):
            spalte, reihe = stelle % spalten, stelle // spalten
            kx = x + spalte * (kachel_b + self.LUECKE)
            ky = y + reihe * (kachel_h + self.LUECKE)
            self.platz_malen(stelle, kx, ky, kachel_b, kachel_h)
            self.plaetze.append((stelle, kx, ky, kachel_b, kachel_h))

    def platz_malen(self, stelle, x, y, breite, hoehe):
        """Einen einzelnen Platz zeichnen — leer oder belegt.

        Ohne Füllung, damit der Grund durchläuft: Gitter, Aurora und der
        Abtaststrahl sollen unter der Leiste weiterlaufen, statt von einer
        Reihe grauer Kästen unterbrochen zu werden. Ein leerer Platz zeigt
        seine gestrichelte Umrandung, ein belegter nur sein Symbol. Beim
        Überfahren treten an beiden vier Eckwinkel hervor — sonst fehlte die
        Auskunft, dass dort überhaupt etwas anzuklicken ist."""
        marke = f"platz{stelle}"
        eintrag = self.eintraege[stelle] if stelle < len(self.eintraege) else None
        da = eintrag is None or eintrag_da(eintrag)

        if eintrag is None:
            # Ein leerer Platz soll einladen, nicht wie ein Loch wirken:
            # gestrichelter Rand, ein leises Plus, sonst nichts.
            self.buehne.create_rectangle(x, y, x + breite, y + hoehe, fill="",
                                         outline=F["linie"], dash=(3, 4),
                                         tags=("ablage", marke, marke + "rand"))
            self.buehne.create_text(x + breite / 2, y + hoehe / 2, text="+",
                                    fill=F["linie_stark"],
                                    font=tkfont.Font(family="DejaVu Sans", size=15),
                                    tags=("ablage", marke, marke + "text"))
        else:
            # Kein Kasten und kein Rahmen — nur das Symbol. Der volle Name
            # steht in der Sprechblase; abgeschnitten in der Kachel war er
            # weder schön noch nützlich.
            self.symbol_malen(eintrag, stelle, x + breite / 2, y + hoehe / 2, da)
            if not da:
                # Ein Platz, der ins Leere zeigt, sagt das auch ohne Zeiger.
                self.buehne.create_text(x + breite / 2, y + hoehe - 8, text=T("fehlt"),
                                        fill=F["schlecht"], font=tkfont.Font(
                                            family="DejaVu Sans", size=7),
                                        tags=("ablage", marke))

        # Vier Eckwinkel liegen bereit und bleiben verborgen, bis der Zeiger
        # kommt — dieselbe Sprache wie bei den Karten und leiser als jede
        # Füllung.
        e = 9
        for ex, ey, dx, dy in ((x, y, 1, 1), (x + breite, y, -1, 1),
                               (x, y + hoehe, 1, -1), (x + breite, y + hoehe, -1, -1)):
            for zx, zy in ((ex + dx * e, ey), (ex, ey + dy * e)):
                # Bei belegten Plätzen bleiben sie leise stehen: ohne Füllung
                # und ohne Rahmen schwebte das Symbol sonst im Nichts, und
                # niemand sah mehr, wo eine Kachel anfängt und aufhört. Bei
                # leeren Plätzen genügt die gestrichelte Umrandung, dort
                # treten sie erst beim Überfahren hervor.
                self.buehne.create_line(ex, ey, zx, zy,
                                        fill=F["marke"] if eintrag else F["marke_klar"],
                                        state="normal" if eintrag else "hidden",
                                        tags=("ablage", marke, marke + "ecke"))
        self.warm[stelle] = 0.0
        self.helligkeit[stelle] = 0.0

    def symbol_malen(self, eintrag, stelle, mx, my, da=True):
        """Das Zeichen eines Eintrags setzen — Bild, wenn es eines gibt."""
        marke = f"platz{stelle}"
        if da and eintrag.get("art") == "anwendung":
            bild = self.bild_holen(eintrag.get("symbol", ""))
            if bild is not None:
                self.buehne.create_image(mx, my, image=bild, tags=("ablage", marke))
                return
        # Ohne Bilddatei ein gezeichnetes Zeichen: ein Ordner, ein Blatt oder
        # ein Fenster. Das braucht keine Schriftart und sieht überall gleich aus.
        farbe = F["schlecht"] if not da else {
            "ordner": F["warn"], "datei": F["blau"]}.get(eintrag.get("art"), F["rand_weich"])
        b, h = 15, 11
        if eintrag.get("art") == "ordner":
            self.buehne.create_polygon(
                mx - b, my + h, mx - b, my - h + 3, mx - 2, my - h + 3, mx + 1, my - h + 6,
                mx + b, my - h + 6, mx + b, my + h,
                fill="", outline=farbe, width=2, tags=("ablage", marke))
        elif eintrag.get("art") == "datei":
            self.buehne.create_polygon(
                mx - 9, my + h, mx - 9, my - h, mx + 3, my - h, mx + 9, my - h + 6,
                mx + 9, my + h,
                fill="", outline=farbe, width=2, tags=("ablage", marke))
        else:
            self.buehne.create_rectangle(mx - b + 3, my - h, mx + b - 3, my + h,
                                         outline=farbe, width=2, tags=("ablage", marke))

    def bild_holen(self, name):
        """Ein Symbolbild laden und auf Kachelmaß bringen — einmal je Name."""
        if name in self.bilder:
            return self.bilder[name]
        self.bilder[name] = None
        datei = symboldatei(name)
        if datei:
            try:
                bild = tk.PhotoImage(file=datei)
                # Tk kann nur ganzzahlig verkleinern; 32 Pixel sind das Maß,
                # das in einer Kachel neben dem Namen noch Luft lässt.
                faktor = max(1, round(bild.width() / 32))
                self.bilder[name] = bild.subsample(faktor) if faktor > 1 else bild
            except tk.TclError:
                self.bilder[name] = None
        return self.bilder[name]

    @staticmethod
    def kuerzen(text, schrift, breite):
        """Zu lange Namen abschneiden, aber sichtbar — mit Auslassung."""
        if schrift.measure(text) <= breite:
            return text
        while text and schrift.measure(text + "…") > breite:
            text = text[:-1]
        return text + "…"

    # ── Leben ───────────────────────────────────────────────────
    def laufen(self, _n=0):
        """Das Aufleuchten unter dem Zeiger — weich, wie die Bogenanzeigen."""
        for stelle, ziel in list(self.warm.items()):
            jetzt = self.helligkeit.get(stelle, 0.0)
            if abs(jetzt - ziel) < 0.02:
                continue
            jetzt += (ziel - jetzt) * 0.30
            self.helligkeit[stelle] = jetzt
            marke = f"platz{stelle}"
            # Die Eckwinkel treten hervor. Unter vier Prozent bleiben sie ganz
            # weg: eine kaum sichtbare Linie sieht nach Schmutz aus.
            belegt = stelle < len(self.eintraege)
            self.buehne.itemconfig(
                marke + "ecke",
                fill=mischen(F["marke"] if belegt else F["grund"],
                             F["marke_klar"], jetzt),
                state="normal" if (belegt or jetzt > 0.04) else "hidden")
            if not belegt:
                self.buehne.itemconfig(marke + "rand",
                                       outline=mischen(F["linie"], F["marke_klar"], jetzt))
                self.buehne.itemconfig(marke + "text",
                                       fill=mischen(F["linie_stark"], F["marke_klar"], jetzt))

    # ── Klicken ─────────────────────────────────────────────────
    def klick(self, stelle):
        """Belegter Platz: öffnen. Leerer Platz: etwas aussuchen."""
        if stelle >= len(self.eintraege):
            self.aussuchen(stelle)
            return
        eintrag = self.eintraege[stelle]
        if not eintrag_da(eintrag):
            # Ins Leere klicken lassen wäre gemein — lieber gleich anbieten,
            # den Platz in Ordnung zu bringen.
            self.aendern(stelle)
            return
        if not eintrag_oeffnen(eintrag):
            self.aendern(stelle)

    def aendern(self, stelle):
        if stelle >= len(self.eintraege):
            self.aussuchen(stelle)
            return
        eintrag = self.eintraege[stelle]
        Eintragsfenster(self.k.wurzel, eintrag,
                        entfernen=lambda s=stelle: self.entfernen(s),
                        austauschen=lambda s=stelle: self.aussuchen(s, tauschen=True),
                        fehlt=not eintrag_da(eintrag))

    def aussuchen(self, stelle, tauschen=False):
        art = self.eintraege[stelle]["art"] if tauschen and stelle < len(self.eintraege) \
            else "anwendung"
        Waehler(self.k.wurzel,
                fertig=lambda e, s=stelle, t=tauschen: self.ablegen(s, e, t),
                art=art if art in ("anwendung", "ordner", "datei") else "anwendung")

    def ablegen(self, stelle, eintrag, tauschen=False):
        if stelle < len(self.eintraege):
            self.eintraege[stelle] = eintrag    # austauschen
        else:
            self.eintraege.append(eintrag)      # der erste freie Platz ist der nächste
        ablage_sichern(self.eintraege)
        self.stand = None
        self.pruefen()

    def entfernen(self, stelle):
        if stelle < len(self.eintraege):
            del self.eintraege[stelle]
            ablage_sichern(self.eintraege)
            self.stand = None
            self.pruefen()


class Kleinfenster(tk.Toplevel):
    """Grundgerüst für die kleinen Fenster der Ablage.

    Sie tragen dieselben Farben wie die Konsole, stehen in der Mitte des
    Schirms und nehmen die Eingabe an sich, solange sie offen sind — ein
    Klick daneben soll nicht aus Versehen etwas starten.

    Die eigene Fensterklasse ist wichtiger, als sie aussieht: die Regel, die
    den Hintergrund ganz nach hinten schiebt, greift alles mit der Klasse des
    Hauptfensters. Diese Fenster tragen eine eigene und bleiben deshalb
    gewöhnliche Fenster — vorne, sichtbar, mit Rahmen.
    """

    def __init__(self, eltern, titel, breite, hoehe):
        super().__init__(eltern, bg=F["tief"], class_="stellium-fenster")
        self.title(f"Stellium — {titel}")
        self.configure(highlightbackground=F["rand"], highlightthickness=1)
        self.transient(eltern)
        self.resizable(False, False)
        x = (self.winfo_screenwidth() - breite) // 2
        y = (self.winfo_screenheight() - hoehe) // 2
        self.geometry(f"{breite}x{hoehe}+{max(x, 0)}+{max(y, 0)}")
        self.attributes("-topmost", True)

        self.kopfzeile = tk.Label(self, text=titel, bg=F["tief"], fg=F["tinte"],
                                  anchor="w", padx=18, pady=12,
                                  font=tkfont.Font(family="DejaVu Sans", size=12,
                                                   weight="bold"))
        self.kopfzeile.pack(fill="x")
        tk.Frame(self, bg=F["rand"], height=1).pack(fill="x", padx=18)

        self.bind("<Escape>", lambda _e: self.destroy())
        self.protocol("WM_DELETE_WINDOW", self.destroy)
        self.after(50, self._greifen)

    def _greifen(self):
        # Erst wenn das Fenster wirklich auf dem Schirm ist, lässt sich die
        # Eingabe an sich ziehen — vorher antwortet X mit „noch nicht sichtbar".
        try:
            self.grab_set()
            self.focus_force()
        except tk.TclError:
            self.after(50, self._greifen)

    def knopf(self, eltern, text, ruf, betont=False):
        """Ein Knopf im Stil der Konsole — flach, mit ruhiger Rückmeldung."""
        k = tk.Label(eltern, text=text, bg=F["rand"] if betont else F["erhoben"],
                     fg="#ffffff" if betont else F["leise"], padx=16, pady=7,
                     cursor="hand2", font=tkfont.Font(family="DejaVu Sans", size=10))
        ruhe, wach = (F["rand"], F["rand_weich"]) if betont else (F["erhoben"], F["linie_stark"])
        k.bind("<Button-1>", lambda _e: ruf())
        k.bind("<Enter>", lambda _e: k.config(bg=wach, fg=F["tinte"] if not betont else "#ffffff"))
        k.bind("<Leave>", lambda _e: k.config(bg=ruhe, fg=F["leise"] if not betont else "#ffffff"))
        return k


class Waehler(Kleinfenster):
    """Das Fenster, in dem man aussucht, was auf einen Platz gelegt wird.

    Drei Arten, ein Fenster: Anwendungen kommen aus den .desktop-Dateien,
    Ordner und Dateien aus dem Dateibaum. Der Weg ist derselbe, nur die Liste
    darunter wechselt — das erspart drei Fenster, die fast gleich aussehen.
    """

    def __init__(self, eltern, fertig, art="anwendung"):
        super().__init__(eltern, T("was_ablegen"), 620, 520)
        self.fertig = fertig
        self.art = art
        self.ordner = os.path.expanduser("~")
        self.zeilen = []                       # was in der Liste steht

        klein = tkfont.Font(family="DejaVu Sans", size=10)
        # ── Die drei Arten als Reiter
        self.reiter = {}
        leiste = tk.Frame(self, bg=F["tief"])
        leiste.pack(fill="x", padx=18, pady=(14, 8))
        for schluessel, marke in (("anwendung", "art_anwendung"),
                                  ("ordner", "art_ordner"), ("datei", "art_datei")):
            r = tk.Label(leiste, text=T(marke), bg=F["erhoben"], fg=F["leise"],
                         padx=18, pady=6, cursor="hand2", font=klein)
            r.pack(side="left", padx=(0, 8))
            r.bind("<Button-1>", lambda _e, s=schluessel: self.art_waehlen(s))
            self.reiter[schluessel] = r

        self.pfadzeile = tk.Label(self, text="", bg=F["tief"], fg=F["zeit"], anchor="w",
                                  font=tkfont.Font(family="DejaVu Sans Mono", size=9))
        self.pfadzeile.pack(fill="x", padx=20, pady=(0, 6))

        kasten = tk.Frame(self, bg=F["linie"])
        kasten.pack(fill="both", expand=True, padx=18)
        self.liste = tk.Listbox(kasten, bg=F["karte"], fg=F["tinte"], bd=0,
                                highlightthickness=0, activestyle="none",
                                selectbackground=F["rand"], selectforeground="#ffffff",
                                font=klein)
        self.liste.pack(side="left", fill="both", expand=True, padx=1, pady=1)
        rolle = tk.Scrollbar(kasten, command=self.liste.yview, bd=0,
                             highlightthickness=0, troughcolor=F["karte"], bg=F["erhoben"])
        rolle.pack(side="right", fill="y", padx=(0, 1), pady=1)
        self.liste.config(yscrollcommand=rolle.set)
        self.liste.bind("<Double-Button-1>", lambda _e: self.eintreten())
        self.liste.bind("<Return>", lambda _e: self.eintreten())

        fuss = tk.Frame(self, bg=F["tief"])
        fuss.pack(fill="x", padx=18, pady=14)
        self.knopf(fuss, T("ablegen"), self.nehmen, betont=True).pack(side="right")
        self.knopf(fuss, T("abbrechen"), self.destroy).pack(side="right", padx=(0, 10))

        self.art_waehlen(art)

    # ── Liste füllen ────────────────────────────────────────────
    def art_waehlen(self, art):
        self.art = art
        for schluessel, r in self.reiter.items():
            gewaehlt = schluessel == art
            r.config(bg=F["rand"] if gewaehlt else F["erhoben"],
                     fg="#ffffff" if gewaehlt else F["leise"])
        self.fuellen()

    def fuellen(self):
        self.liste.delete(0, "end")
        self.zeilen = []
        if self.art == "anwendung":
            self.pfadzeile.config(text="")
            for name, pfad, symbol in anwendungen_finden():
                self.zeilen.append({"art": "anwendung", "name": name,
                                    "pfad": pfad, "symbol": symbol})
                self.liste.insert("end", "   " + name)
            return

        self.pfadzeile.config(text=self.ordner)
        eltern = os.path.dirname(self.ordner.rstrip("/")) or "/"
        if eltern != self.ordner:
            self.zeilen.append({"art": "hoeher", "pfad": eltern})
            self.liste.insert("end", "   " + T("hoeher"))
        try:
            namen = sorted(os.listdir(self.ordner), key=str.lower)
        except OSError:
            namen = []
        for name in namen:
            if name.startswith("."):
                continue                       # Verstecktes bleibt versteckt
            voll = os.path.join(self.ordner, name)
            if os.path.isdir(voll):
                self.zeilen.append({"art": "ordner", "name": name, "pfad": voll})
                self.liste.insert("end", "   ▸  " + name)
            elif self.art == "datei":
                self.zeilen.append({"art": "datei", "name": name, "pfad": voll})
                self.liste.insert("end", "   ·  " + name)
        if len(self.zeilen) <= 1:
            self.liste.insert("end", "   " + T("nichts_hier"))

    def gewaehlt(self):
        wahl = self.liste.curselection()
        if not wahl or wahl[0] >= len(self.zeilen):
            return None
        return self.zeilen[wahl[0]]

    def eintreten(self):
        """Doppelklick: in einen Ordner hinein — oder gleich übernehmen."""
        zeile = self.gewaehlt()
        if not zeile:
            return
        if zeile["art"] in ("hoeher", "ordner") and self.art != "anwendung":
            if zeile["art"] == "hoeher" or self.art == "datei":
                self.ordner = zeile["pfad"]
                self.fuellen()
                return
        self.nehmen()

    def nehmen(self):
        zeile = self.gewaehlt()
        if self.art == "ordner" and (zeile is None or zeile["art"] == "hoeher"):
            # Nichts ausgesucht heißt: der Ordner, in dem man gerade steht.
            zeile = {"art": "ordner", "name": os.path.basename(self.ordner.rstrip("/")) or "/",
                     "pfad": self.ordner}
        if zeile is None or zeile["art"] == "hoeher":
            return
        if self.art == "datei" and zeile["art"] != "datei":
            self.ordner = zeile["pfad"]         # ein Ordner: erst hineingehen
            self.fuellen()
            return
        eintrag = {"art": zeile["art"], "name": zeile.get("name", ""),
                   "pfad": zeile["pfad"], "symbol": zeile.get("symbol", "")}
        self.destroy()
        self.fertig(eintrag)


class Eintragsfenster(Kleinfenster):
    """Das kleine Fenster hinter Umschalt und Klick: entfernen oder tauschen."""

    def __init__(self, eltern, eintrag, entfernen, austauschen, fehlt=False):
        super().__init__(eltern, T("eintrag_aendern"), 460, 230)
        klein = tkfont.Font(family="DejaVu Sans", size=10)

        tk.Label(self, text=eintrag.get("name") or eintrag.get("pfad", ""),
                 bg=F["tief"], fg=F["tinte"], anchor="w", padx=20,
                 font=tkfont.Font(family="DejaVu Sans", size=11, weight="bold")
                 ).pack(fill="x", pady=(16, 2))
        tk.Label(self, text=eintrag.get("pfad", ""), bg=F["tief"], fg=F["zeit"], anchor="w",
                 padx=20, wraplength=410, justify="left",
                 font=tkfont.Font(family="DejaVu Sans Mono", size=9)).pack(fill="x")
        if fehlt:
            tk.Label(self, text=T("fehlt_lang", name=eintrag.get("name", "")),
                     bg=F["tief"], fg=F["schlecht"], anchor="w", padx=20,
                     wraplength=410, justify="left", font=klein).pack(fill="x", pady=(10, 0))

        fuss = tk.Frame(self, bg=F["tief"])
        fuss.pack(side="bottom", fill="x", padx=18, pady=16)
        self.knopf(fuss, T("austauschen"),
                   lambda: (self.destroy(), austauschen()), betont=True).pack(side="right")
        self.knopf(fuss, T("entfernen"),
                   lambda: (self.destroy(), entfernen())).pack(side="right", padx=(0, 10))
        self.knopf(fuss, T("abbrechen"), self.destroy).pack(side="left")


def rundes_rechteck(leinwand, x1, y1, x2, y2, r, **kw):
    """Ein Rechteck mit runden Ecken — Tk kennt so etwas nicht von Haus aus.

    Der Umriss entsteht als geglättetes Vieleck: an jeder Ecke liegen drei
    Punkte dicht beieinander, und `smooth` zieht daraus eine Rundung. Der
    Radius ist derselbe wie in der App (--r-md, 13px) — daran erkennt man auf
    den ersten Blick, dass beide Oberflächen zusammengehören.
    """
    p = [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r,
         x2, y2 - r, x2, y2, x2 - r, y2, x1 + r, y2,
         x1, y2, x1, y2 - r, x1, y1 + r, x1, y1]
    return leinwand.create_polygon(p, smooth=True, **kw)


def aurora(leinwand, breite, hoehe):
    """Der weiche Farbschimmer aus der App, mit den Mitteln von Tk.

    Das ist das stärkste gemeinsame Merkmal beider Oberflächen und bleibt
    deshalb unangetastet. Die App legt drei große Farbverläufe über den Grund;
    Tk kann keine Transparenz, also entstehen sie hier aus ineinander
    liegenden Ovalen, die Ring für Ring zum Grundton hin verblassen. Nur bei
    Größenänderung gezeichnet — dazwischen kostet es nichts.

    Nachgemessen, weil die Vermutung nahelag, 68 sehr große Ovale müssten
    jede Bewegung darüber teuer machen: sie tun es nicht. Tk zeichnet nur den
    beschädigten Ausschnitt neu, und der ist bei einer wandernden Linie ein
    paar Pixel hoch. Derselbe Strahl über den leeren Grund und über die volle
    Aurora kostet beide Male 1,2 %. Der Schimmer musste für die Bewegung also
    nicht weichen — im Gegenteil, das driftende Raster liegt jetzt darüber und
    verbindet beides.
    """
    leinwand.delete("aurora")
    blasen = [
        (breite * 0.80, -hoehe * 0.10, max(breite, hoehe) * 0.75, F["rand"], 0.30),
        (breite * 0.08, hoehe * 1.05, max(breite, hoehe) * 0.62, F["blau"], 0.20),
        (breite * 0.98, hoehe * 0.80, max(breite, hoehe) * 0.52, F["rosa"], 0.17),
    ]
    ringe = 26
    for mx, my, r, farbe, staerke in blasen:
        for i in range(ringe, 0, -1):
            anteil = i / ringe
            gr = r * anteil
            # Die Mitten der Blasen liegen absichtlich außerhalb des Bildes.
            # Von den kleinen, hellen Ringen dort ragt sonst nur eine Spitze
            # herein — und die sieht aus wie ein Keil, der da nicht hingehört.
            # Deshalb kommen nur Ringe aufs Bild, die auch ein Stück weit
            # hereinreichen; der Verlauf endet dadurch weich statt spitz.
            if (my + gr < hoehe * 0.12 or my - gr > hoehe * 0.88
                    or mx + gr < breite * 0.12 or mx - gr > breite * 0.88):
                continue
            ton = mischen(F["grund"], farbe, staerke * (1 - anteil) ** 2)
            leinwand.create_oval(mx - gr, my - gr, mx + gr, my + gr,
                                 fill=ton, outline="", tags="aurora")
    leinwand.tag_lower("aurora")


GITTER = 58          # Maschenweite des Rasters in Pixeln


def gitter(leinwand, breite, hoehe):
    """Das Raster über der Aurora — es driftet langsam schräg davon.

    Über den Rand hinaus gezeichnet, eine Masche in jede Richtung mehr als
    nötig: so kann es wandern, ohne dass am Rand eine Lücke aufreißt. Sobald
    es um genau eine Masche gewandert ist, springt es zurück — das Muster
    wiederholt sich, der Sprung ist unsichtbar, und der Drift läuft endlos
    weiter, ohne dass etwas neu entsteht.

    Bewegt wird es mit einem einzigen `move` auf das Etikett, nicht mit 62
    einzelnen `coords`. Gemessen: 1,4 % gegen 2,3 % — dieselbe Bewegung, ein
    Drittel billiger, weil Tk die ganze Gruppe in einem Zug verschiebt.
    """
    leinwand.delete("gitter")
    for x in range(-GITTER, breite + 2 * GITTER, GITTER):
        gross = (x // GITTER) % 4 == 0
        leinwand.create_line(x, -GITTER, x, hoehe + GITTER, tags="gitter",
                             fill=F["gitter_hell"] if gross else F["gitter"])
    for y in range(-GITTER, hoehe + 2 * GITTER, GITTER):
        gross = (y // GITTER) % 4 == 0
        leinwand.create_line(-GITTER, y, breite + 2 * GITTER, y, tags="gitter",
                             fill=F["gitter_hell"] if gross else F["gitter"])
    leinwand.tag_lower("gitter")
    leinwand.tag_lower("aurora")     # der Schimmer bleibt ganz unten


def eckmarken(leinwand, breite, hoehe, unten=None):
    """Eckklammern und Fadenkreuze am Rand des ganzen Bildes.

    Fest gezeichnet. Vier Winkel, die den Schirm einfassen, und an den beiden
    oberen Ecken je eine winzige Beschriftung — sie erklärt nichts, sie ordnet
    nur ein, wie die Nummer an einem Schaltschrank.
    """
    leinwand.delete("eckmarke")
    e, i = 54, 12
    # Die unteren Winkel sitzen am Ende der *nutzbaren* Fläche, nicht am
    # Blechrand: unter ihnen liegt der Fernzugriff, und dort verschwänden sie
    # dahinter.
    unten = (unten if unten else hoehe) - i
    for x, y, dx, dy in ((i, i, 1, 1), (breite - i, i, -1, 1),
                         (i, unten, 1, -1), (breite - i, unten, -1, -1)):
        leinwand.create_line(x, y, x + dx * e, y, fill=F["marke_hell"], tags="eckmarke")
        leinwand.create_line(x, y, x, y + dy * e, fill=F["marke_hell"], tags="eckmarke")
        # Ein kurzer zweiter Strich innen macht aus dem Winkel eine Zielmarke.
        leinwand.create_line(x + dx * 8, y + dy * 14, x + dx * 8, y + dy * 26,
                             fill=F["marke"], tags="eckmarke")

    klein = tkfont.Font(family="DejaVu Sans Mono", size=7)
    # Die Beschriftungen sitzen unten, wo sonst nichts steht — oben links
    # stuende sie dem Namen im Weg.
    # Nur rechts eine Beschriftung. Links stand einmal „STELLIUM ·
    # MASCHINENRAUM" — sie lag genau unter der Fußzeile, und zwei Texte
    # übereinander sind schlechter als einer, zumal der eine nichts sagte, was
    # nicht schon oben am Namen steht.
    leinwand.create_text(breite - i - 62, unten - 4, text=f"{breite}×{hoehe}",
                         anchor="e", fill=F["marke"], font=klein, tags="eckmarke")


def instrument(leinwand, mx, my, r):
    """Der große Ringsatz im freien Grund — das Schaustück der Anzeige.

    Vier ineinander liegende Ringe, die sich verschieden schnell und
    abwechselnd gegenläufig drehen, dazu eine feste Skala und ein Fadenkreuz.
    Er misst nichts. Er ist da, weil ein Schreibtischgrund, auf dem sich
    nichts bewegt, tot aussieht — und weil genau diese Bewegung fast nichts
    kostet: gedreht wird ausschließlich über den Startwinkel vorhandener
    Bögen, also vier `itemconfigure` je Bild.

    Er sitzt bewusst dort, wo keine Karte liegt. Über Zahlen zu wischen, die
    man lesen will, wäre der eine Fehler, den diese ganze Schicht nicht machen
    darf.

    Zurück kommen die Ringe, die sich drehen sollen, mitsamt ihrem Tempo.
    """
    leinwand.delete("instrument")
    dreher = []
    # Von außen nach innen. Das Vorzeichen kehrt die Richtung um.
    for i, (anteil, weite, tempo, strich, ton) in enumerate((
            (1.00, 359, 0.30, (2, 9), F["marke"]),
            (0.86, 110, -0.75, None, F["marke_hell"]),
            (0.72, 359, 0.55, (1, 5), F["marke"]),
            (0.52, 76, -1.20, None, F["marke_klar"]))):
        rr = r * anteil
        k = leinwand.create_arc(mx - rr, my - rr, mx + rr, my + rr, start=i * 47,
                                extent=weite, style="arc", width=1, outline=ton,
                                dash=strich, tags="instrument")
        dreher.append((k, tempo))
        if weite < 359:
            # Ein zweites Segment gegenüber: das liest sich als ein Ring mit
            # zwei Marken statt als eine einzelne Sichel.
            k2 = leinwand.create_arc(mx - rr, my - rr, mx + rr, my + rr,
                                     start=i * 47 + 180, extent=weite, style="arc",
                                     width=1, outline=ton, tags="instrument")
            dreher.append((k2, tempo))

    # Feste Skala am äußersten Ring: 72 Striche, jeder fünfte lang.
    for i in range(72):
        w = math.radians(i * 5)
        gross = i % 5 == 0
        r1 = r * 1.04
        r2 = r * (1.11 if gross else 1.07)
        leinwand.create_line(mx + r1 * math.cos(w), my - r1 * math.sin(w),
                             mx + r2 * math.cos(w), my - r2 * math.sin(w),
                             fill=F["marke_hell"] if gross else F["marke"],
                             tags="instrument")

    # Fadenkreuz in der Mitte, mit einer Lücke, damit es nicht zum Vollkreuz wird.
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        leinwand.create_line(mx + dx * r * 0.10, my + dy * r * 0.10,
                             mx + dx * r * 0.34, my + dy * r * 0.34,
                             fill=F["marke_hell"], tags="instrument")
    leinwand.create_oval(mx - 3, my - 3, mx + 3, my + 3, outline=F["marke_klar"],
                         tags="instrument")

    klein = tkfont.Font(family="DejaVu Sans Mono", size=7)
    for winkel, text in ((48, "SYS"), (138, "NET"), (228, "MEM"), (318, "I/O")):
        w = math.radians(winkel)
        leinwand.create_text(mx + r * 1.22 * math.cos(w), my - r * 1.22 * math.sin(w),
                             text=text, fill=F["marke"], font=klein, tags="instrument")
    return dreher


class Konsole:
    def __init__(self):
        self.wurzel = tk.Tk(className=FENSTERKLASSE)
        self.wurzel.title("Stellium Hintergrund" if HINTERGRUND else "Stellium — Konsole")
        self.wurzel.configure(bg=F["grund"])
        if HINTERGRUND:
            self.hintergrund_einrichten()
        else:
            self.wurzel.geometry(f"{BREIT}x{HOCH}")
            # Zwei Tachos (je 132) plus Ränder brauchen 340 je Spalte; darunter
            # klappen die Spalten untereinander, deshalb genügt eine Spaltenbreite.
            self.wurzel.minsize(380, 560)
        self.stand = None
        # Zuerst die Sprache, dann die Beschriftungen: sonst stünden die
        # Überschriften der Karten in der Sprache von vorgestern, weil sie nur
        # beim Anlegen gesetzt werden.
        sprache_laden()

        # Eine einzige Uhr für alles, was sich bewegt. Sie muss vor den Karten
        # stehen — `Karte.tacho` meldet neu entstandene Tachos bei ihr an.
        global HERZ
        HERZ = Herzschlag(self.wurzel)
        self.grund_stand = None      # Maße, für die der Grund zuletzt entstand
        self.strahl_teile = []
        self.strahl_masse = (1, 1)
        self.instrument_ringe = []
        self.nutz_unten = 0
        self.kopf_ringe = []
        self.kopf_marke = None
        self.kopf_spanne = (0, 0)
        self.karten = []

        gross = tkfont.Font(family="DejaVu Sans", size=17, weight="bold")
        klein = tkfont.Font(family="DejaVu Sans", size=9)

        # ── Fernzugriff ─────────────────────────────────────────
        # Als Bereich statt als eigenes Fenster: was aus der Ferne geschieht,
        # gehört zum Zustand des Servers wie die Zahlen darüber. Er bleibt auch
        # dann stehen, wenn niemand verbunden ist — dann zeigt er das
        # Protokoll und lässt einen darin zurückblättern.
        #
        # Er hängt direkt im Fenster, nicht auf der Leinwand: als eingebettetes
        # Leinwandfenster blieb die Tagesauswahl unsichtbar — Tk richtet sie
        # dort zwar ein, malt sie aber nicht. Unten angeschlagen ist er
        # außerdem einfacher zu bemessen.
        # Der Fernzugriff entsteht weiter unten, sobald es die Leinwand gibt:
        # er sitzt auf *derselben* Fläche wie alles andere und muss deshalb ein
        # Kind von ihr sein. Hier stehen nur die Größen, die schon gebraucht
        # werden, bevor es ihn gibt.
        self.fern = None
        self.k_fern = None
        self.fern_fenster = None
        self.fern_offen = False
        self._fern_text = None

        # Eine Leinwand trägt den Rest: darauf liegen der Aurora-Schimmer und
        # der Kopf, und darüber schweben die Karten — genau wie in der App.
        self.buehne = tk.Canvas(self.wurzel, bd=0, highlightthickness=0, bg=F["grund"])
        self.buehne.pack(fill="both", expand=True)
        self.buehne.bind("<Configure>", self.buehne_richten)
        self.wurzel.bind("<Configure>", self.band_richten)
        self.kopf = self.buehne          # Kopf-Elemente liegen auf derselben Leinwand

        self.stern = self.buehne.create_text(26, 36, text="✦", fill=F["rand"], font=gross)
        self.buehne.create_text(52, 36, text="Stellium", anchor="w", fill=F["tinte"], font=gross)
        self.version_id = self.buehne.create_text(160, 39, text="", anchor="w",
                                                  fill=F["leise"], font=klein)
        self.unterzeile = self.buehne.create_text(52, 60, text=T("verbinde"), anchor="w",
                                                  fill=F["zeit"], font=klein)

        # Sprache umschalten — ein Knopf, zwei Sprachen.
        self.sprach_knopf = self.buehne.create_text(
            0, 40, text="", anchor="e", fill=F["leise"],
            font=tkfont.Font(family="DejaVu Sans", size=10, weight="bold"))
        self.buehne.tag_bind(self.sprach_knopf, "<Button-1>", lambda _e: self.sprache_wechseln())
        self.buehne.tag_bind(self.sprach_knopf, "<Enter>",
                             lambda _e: self.buehne.itemconfig(self.sprach_knopf, fill=F["tinte"]))
        self.buehne.tag_bind(self.sprach_knopf, "<Leave>",
                             lambda _e: self.buehne.itemconfig(self.sprach_knopf, fill=F["leise"]))

        links = tk.Frame(self.buehne, bg=F["grund"])
        mitte = tk.Frame(self.buehne, bg=F["grund"])
        rechts = tk.Frame(self.buehne, bg=F["grund"])
        self.spalte_links = self.buehne.create_window(0, 0, window=links, anchor="nw")
        self.spalte_mitte = self.buehne.create_window(0, 0, window=mitte, anchor="nw")
        self.spalte_rechts = self.buehne.create_window(0, 0, window=rechts, anchor="nw")

        self.k_verbinden = Karte(links, "verbinden", F["blau"], "NET·01")
        self.k_verbinden.pack(fill="x", pady=(0, 12))
        self.adressen = tk.Frame(self.k_verbinden.inhalt, bg=F["karte"])
        self.adressen.pack(fill="x")

        self.k_chat = Karte(links, "chat", F["gut"], "SRV·02")
        self.k_chat.pack(fill="x", pady=(0, 12))
        self.k_aussen = Karte(links, "aussen", F["blau"], "EXT·03")
        self.k_aussen.pack(fill="x")

        self.k_leistung = Karte(mitte, "leistung", F["rand"], "SYS·04")
        self.k_leistung.pack(fill="x", pady=(0, 12))
        # Das Abo gehört zur Website des Kollegen, steht aber hier in der
        # Mitte: rechts hätte die Spalte sonst drei Karten und die Mitte
        # eine einzige. Grün, weil es das Einzige auf diesem Schirm ist, das
        # Geld bedeutet — und weil es sich damit von den Auslastungswerten
        # daneben unterscheidet.
        self.k_verkauf = Karte(mitte, "verkauf", F["gut"], "PAY·07")
        self.k_verkauf.pack(fill="x")
        # Triton läuft auf demselben Pi, gehört aber nicht uns: nur gelesen,
        # nie angefasst (server-setup/FREMDE-DIENSTE.md). Der eigene Ton hebt
        # die Karte von unseren ab.
        self.k_web = Karte(rechts, "web", F["rosa"], "WEB·05")
        self.k_web.pack(fill="x", pady=(0, 12))
        self.k_teile = Karte(rechts, "teile", F["zeit"], "VER·06")
        self.k_teile.pack(fill="x")

        self.fuss_id = self.buehne.create_text(20, 0, text=T("fuss"), anchor="w",
                                               fill=F["zeit"], font=klein)

        # ── Fernzugriff ─────────────────────────────────────────
        # Er sitzt als Karte auf derselben Leinwand wie alles andere. Vorher
        # hing er als eigenes Band darunter im Fenster: Gitter, Aurora und
        # Komet hörten an seiner Oberkante auf, darunter lag eine zweite Fläche
        # mit eigenem Grundton — quer über den Schirm eine Naht, die ihn wie
        # ein aufgeklebtes zweites Fenster aussehen ließ. Jetzt gibt es keine
        # zweite Fläche mehr, also auch keine Naht: der Grund läuft neben und
        # unter ihm weiter, und der Komet zieht durch.
        #
        # Entscheidend ist, dass die Karte ein *Kind der Leinwand* ist. Ein
        # früherer Versuch hängte sie ans Fenster und setzte sie nur als
        # Leinwandfenster ein — dann richtet Tk die Tagesauswahl zwar ein, malt
        # sie aber nicht, und sie war unsichtbar. Genau daran ist es damals
        # gescheitert, und genau das ist hier anders.
        if WACHE is not None:
            WACHE.sprache_setzen(SPRACHE)
            # Der Bereich bringt seine eigene Farbtafel mit — daher kam der
            # sichtbar andere Grundton. Ein einziger Eintrag stellt ihn auf
            # denselben Grund wie die Karten. Der Verlaufskasten behält seinen
            # dunkleren Ton: er soll ein Brunnen bleiben, in den man hineinsieht.
            WACHE.FARBEN["grund"] = F["karte"]

            self.k_fern = Karte(self.buehne, lambda: WACHE.T("protokoll"),
                                F["zeit"], "SSH\u00b707")
            self.k_fern.punkt_zeigen()
            self.fern_fenster = self.buehne.create_window(
                0, 0, window=self.k_fern, anchor="nw", state="hidden")

            # Eine Zeile, die sagt, wie es steht — dort, wo bei den anderen
            # Karten die erste Zeile steht. Sie ersetzt die große weiße
            # Überschrift, die der Bereich sonst selbst mitbrachte.
            self.fern_stand = tk.Label(
                self.k_fern.inhalt, text="", bg=F["karte"], fg=F["leise"],
                anchor="w", justify="left",
                font=tkfont.Font(family="DejaVu Sans", size=10))
            self.fern_stand.pack(fill="x", pady=(0, 2))

            # Bildschirm-Fernsteuerung. Bewusst getrennt von der Zeile
            # darüber: die meldet SSH, also eine Sitzung im Terminal. Hier
            # geht es um den *Schirm* — jemand sieht ihn und bewegt die Maus.
            #
            # Und ausdrücklich nur DASS, nie WAS. Eine Vorschau wäre technisch
            # einfach und war ausdrücklich nicht gewollt: Don will sehen, dass
            # er verbunden ist, nicht sich selbst beim Arbeiten zusehen.
            self.schirm_stand = tk.Label(
                self.k_fern.inhalt, text="", bg=F["karte"], fg=F["zeit"],
                anchor="w", justify="left",
                font=tkfont.Font(family="DejaVu Sans", size=10))
            self.schirm_stand.pack(fill="x", pady=(0, 4))
            self._schirm_text = None

            self.fern = WACHE.Mitschrift(self.k_fern.inhalt, sprachknopf=False,
                                         dauerhaft=True, melden=self.fern_melden)
            # Der eigene Kopf entfällt: die Karte hat schon eine Überschrift,
            # und zwei übereinander waren genau das, was den Bereich wie ein
            # zweites Fenster aussehen ließ.
            self.fern.kopf.pack_forget()
            # Sein pulsierender Punkt sitzt jetzt neben der Kartenüberschrift.
            # Die alte Schleife lief 16 Mal je Sekunde auf einer Leinwand
            # weiter, die niemand mehr sieht; sie hört nach dem nächsten Schlag
            # von selbst auf, weil sie sich über diesen Namen erneuert.
            self.fern.atmen = lambda: None
            # Die Karte bringt ihren Rand schon mit — die inneren Ränder des
            # Bereichs kämen sonst obendrauf und rückten alles nach innen.
            self.fern.rahmen.pack_configure(padx=0, pady=(4, 0))
            self.fern.fuss.pack_configure(padx=0, pady=(6, 0))
            self.fern.tag_beschriftung.pack_configure(padx=(0, 8))
            self.fern.pack(fill="both", expand=True)

        # Die Ablage füllt, was unter der linken Spalte frei bleibt.
        self.ablage = Ablage(self)

        self.band_stand = 0
        self.band_ziel = None
        self.band_richten()

        # Alles anmelden, was sich bewegt. Die Reihenfolge ist die, in der es
        # je Bild abgearbeitet wird — teuerste Sachen zuletzt, damit ein
        # überzogenes Bild lieber am Schmuck spart als an den Messwerten.
        self.karten = [self.k_verbinden, self.k_chat, self.k_aussen,
                       self.k_leistung, self.k_web, self.k_teile]
        if self.k_fern is not None:
            self.karten.append(self.k_fern)
        # Nacheinander statt alle auf einmal: die Karten fahren von oben nach
        # unten auf, je vier Bilder versetzt. Das dauert gut eine Sekunde und
        # kostet danach nichts mehr.
        for i, karte in enumerate(self.karten):
            karte.aufbau_warten = 6 + i * 5
        HERZ.dazu(self.drehen)
        HERZ.dazu(self.instrument_schlag)
        HERZ.dazu(self.kopf_ring_schlag)
        HERZ.dazu(self.strahl_schlag)
        HERZ.dazu(self.fern_schlag)
        HERZ.dazu(self.band_schlag)
        for karte in self.karten:
            HERZ.dazu(karte.schlag)

        threading.Thread(target=self.holen, daemon=True).start()
        self.auffrischen()

    # ── Hintergrundbetrieb ──────────────────────────────────────
    def hintergrund_einrichten(self):
        """Aus dem Fenster den lebenden Schreibtischgrund machen.

        Das Meiste davon kann ein Programm gar nicht selbst: wie tief ein
        Fenster liegt, entscheidet der Fenstermanager. Unter labwc — das auf
        dem Pi läuft — steht die Regel dafür in /etc/xdg/labwc/rc.xml und wird
        von `einrichten.sh` eingetragen. Sie nimmt dem Fenster den Rahmen,
        hält es ganz unten, zeigt es auf allen Arbeitsflächen, lässt es aus
        Fensterleiste und Umschalter heraus und legt es über die ganze
        nutzbare Fläche — also alles außer der Leiste am oberen Rand.

        Ganz nach hinten heißt hier: hinter alle gewöhnlichen Fenster. Noch
        weiter zurück — unter das Hintergrundbild und die Schreibtischsymbole
        — käme nur ein Wayland-eigenes Programm mit wlr-layer-shell; Tk läuft
        über XWayland und kann das nicht. Das Fenster liegt also *über* dem
        Hintergrundbild und würde Symbole verdecken; deshalb schaltet
        `einrichten.sh` die Schreibtischsymbole ab. Erreichbar bleibt alles
        über das Startmenü.

        Hier bleibt nur, für den Fall vorzusorgen, dass die Regel fehlt: dann
        stellt sich das Fenster wenigstens selbst hin — über die ganze Breite
        und unterhalb der Leiste am oberen Rand.
        """
        breit = self.wurzel.winfo_screenwidth()
        hoch = max(self.wurzel.winfo_screenheight() - RAND_OBEN, 480)
        self.wurzel.geometry(f"{breit}x{hoch}+0+{RAND_OBEN}")
        self.wurzel.minsize(380, 400)

    # ── Kopf ────────────────────────────────────────────────────
    def buehne_richten(self, _e=None):
        """Alles neu einpassen, wenn sich die Fenstergröße ändert."""
        breite = max(self.buehne.winfo_width(), 1)
        hoehe = max(self.buehne.winfo_height(), 1)
        # Bis hierher reicht der Platz für Karten, Ablage und Fußzeile: der
        # Fernzugriff sitzt darunter auf derselben Leinwand, und unter ihm darf
        # nichts mehr liegen. Aurora und Gitter dagegen bekommen die volle
        # Höhe — sie sollen ja gerade unter ihm durchlaufen.
        self.nutz_unten = hoehe - (int(self.band_stand) + 20 if self.band_stand else 0)

        # Aurora, Raster und Eckklammern nur dann neu, wenn sich die Größe
        # wirklich geändert hat. Vorher hing das an jedem Aufruf — und der
        # Sprachschalter ruft hier herein. Ein Klick auf DE/EN warf damit 68
        # große Ovale und 62 Linien weg und zeichnete sie neu: **gemessene
        # 754 ms, in denen der Schirm auf nichts reagierte.** Mit dieser
        # Abfrage sind es 40 ms. Es war nie die Animation, die im Weg stand.
        if (breite, hoehe, self.nutz_unten) != self.grund_stand:
            self.grund_stand = (breite, hoehe, self.nutz_unten)
            aurora(self.buehne, breite, hoehe)
            gitter(self.buehne, breite, hoehe)
            eckmarken(self.buehne, breite, hoehe, self.nutz_unten)
            self.strahl_richten(breite, hoehe)
        # Ein violetter Faden ganz oben — das Erkennungszeichen von Stellium.
        self.buehne.delete("faden")
        self.buehne.create_line(0, 1, breite, 1, fill=F["rand"], width=2, tags="faden")
        # Zwei kurze Marken links und rechts davon, damit der Faden anfängt
        # und aufhört, statt einfach am Bildrand abgeschnitten zu sein.
        for x in (0, breite - 54):
            self.buehne.create_line(x, 5, x + 54, 5, fill=F["marke"], tags="faden")

        self.buehne.coords(self.sprach_knopf, breite - 22, 40)
        self.buehne.itemconfig(self.sprach_knopf, text="EN" if SPRACHE == "de" else "DE")

        # Drei Spalten, bei weniger Breite zwei, ganz schmal untereinander.
        #
        # Auf dem Pi-Schirm (1920 Pixel) reichten zwei nicht mehr: die Karten
        # brauchen zusammen rund 1600 Pixel Höhe, unter dem Kopf und über der
        # Mitschrift stehen aber nur gut 650 zur Verfügung — die untersten
        # fielen heraus. In der Breite war dagegen Platz im Überfluss: eine
        # Spalte war 936 Pixel breit und nutzte davon knapp die Hälfte.
        rand, luecke = 16, 16
        spalten = (self.spalte_links, self.spalte_mitte, self.spalte_rechts)
        if breite < 780:
            spalte = breite - 2 * rand
            for sid in spalten:
                self.buehne.itemconfig(sid, width=spalte)
            oben = KOPFHOCH
            for sid in spalten:
                self.buehne.coords(sid, rand, oben)
                kasten = self.buehne.bbox(sid)
                oben += ((kasten[3] - kasten[1]) if kasten else 300) + luecke
        elif breite < 1400:
            spalte = (breite - 2 * rand - luecke) / 2
            for sid in spalten:
                self.buehne.itemconfig(sid, width=spalte)
            self.buehne.coords(self.spalte_links, rand, KOPFHOCH)
            self.buehne.coords(self.spalte_mitte, rand + spalte + luecke, KOPFHOCH)
            kasten = self.buehne.bbox(self.spalte_mitte)
            versatz = (kasten[3] - kasten[1] + luecke) if kasten else 300
            self.buehne.coords(self.spalte_rechts, rand + spalte + luecke, KOPFHOCH + versatz)
        else:
            spalte = (breite - 2 * rand - 2 * luecke) / 3
            for i, sid in enumerate(spalten):
                self.buehne.itemconfig(sid, width=spalte)
                self.buehne.coords(sid, rand + i * (spalte + luecke), KOPFHOCH)

        self.band_stellen()
        self.instrument_richten(breite, self.nutz_unten)
        self.kopf_ring_richten(breite)
        self.buehne.coords(self.fuss_id, 20, self.nutz_unten - 20)
        self.buehne.tag_raise(self.fuss_id)
        self.ablage_richten(rand, spalte, luecke)
        self.band_richten()

    def ablage_richten(self, rand=16, spalte=None, luecke=16):
        """Der Ablage sagen, wie viel unter der linken Spalte frei ist.

        Die Karten wachsen, sobald Zahlen eintreffen — deshalb wird das immer
        wieder nachgerechnet. Die Ablage selbst zeichnet nur neu, wenn sich
        wirklich etwas geändert hat.
        """
        if getattr(self, "ablage", None) is None:
            return
        # Nicht die ganze Leinwandhöhe: unten sitzt der Fernzugriff auf
        # derselben Fläche, und darunter darf nichts mehr liegen.
        hoehe = max(getattr(self, "nutz_unten", 0) or self.buehne.winfo_height(), 1)
        if spalte is None:
            kasten = self.buehne.bbox(self.spalte_links)
            spalte = (kasten[2] - kasten[0]) if kasten else 0
        kasten = self.buehne.bbox(self.spalte_links)
        oben = (kasten[3] if kasten else KOPFHOCH) + luecke
        # 34 Pixel bleiben unten frei: dort steht die Fußzeile. Mit 26 stand
        # sie mitten in der zweiten Kachelreihe; mit 46 war es umgekehrt zu
        # viel — dann reichte die Höhe nicht mehr für zwei Reihen, und die
        # Leiste verlor die Hälfte ihrer Plätze.
        frei = hoehe - 34 - oben
        if frei < Ablage.HOCH_MIN or spalte < Ablage.BREIT_MIN:
            self.ablage.setzen(0, 0, 0, 0)
        else:
            self.ablage.setzen(rand, oben, spalte, frei)

    def band_richten(self, ereignis=None):
        """Dem Fernzugriff seine Höhe geben — je nachdem, ob jemand da ist.

        Meistens ist niemand verbunden; das ist der Normalfall und darf auch
        so aussehen. Vorher stand dort in jedem Fall ein Kasten über ein
        Viertel der Höhe, in dem eine einzige Zeile lag — im Ernstfall genauso
        groß wie im Leerlauf, und damit falsch gewichtet.

        Jetzt bleibt er flach, solange niemand da ist, und wächst auf, sobald
        sich jemand verbindet. Das Wachsen ist die Meldung: man sieht am
        anderen Ende des Zimmers, dass etwas los ist, ohne ein Wort zu lesen.
        In einem kleinen Fenster tritt er ganz zurück — dort brauchen die
        Karten jeden Pixel.
        """
        if self.k_fern is None:
            return
        if ereignis is not None and ereignis.widget is not self.wurzel:
            return                      # Kindfenster ändern sich dauernd
        hoehe = max(self.wurzel.winfo_height(), 1)
        if hoehe < 620:
            ziel = 0
        elif self.fern_offen:
            ziel = max(BAND_MIN, min(BAND_MAX, int(hoehe * 0.26)))
        else:
            ziel = BAND_RUHE
        if ziel == self.band_ziel:
            return
        self.band_ziel = ziel
        if not ziel:
            self.buehne.itemconfig(self.fern_fenster, state="hidden")
            self.band_stand = 0
        elif not self.band_stand:
            # Beim ersten Erscheinen nicht hineinwachsen — sonst zuckt beim
            # Start das halbe Fenster, während sich die Karten noch setzen.
            self.band_stand = ziel
            self.buehne.itemconfig(self.fern_fenster, state="normal")
        self.band_stellen()
        # Die Fläche darüber ist jetzt anders hoch: Fußzeile, Ablage und der
        # große Ringsatz müssen nachrücken.
        self.buehne_richten()

    def band_stellen(self):
        """Die Fernzugriff-Karte an ihren Platz am unteren Rand der Leinwand setzen.

        Dieselben 16 Pixel Rand wie bei den Spalten darüber — dadurch bleibt
        links und rechts von ihr der Grund sichtbar, und der Komet läuft dort
        weiter, während er hinter ihr vorbeizieht.
        """
        if not self.band_stand or self.fern_fenster is None:
            return
        breite = max(self.buehne.winfo_width(), 1)
        hoehe = max(self.buehne.winfo_height(), 1)
        h = int(self.band_stand)
        self.buehne.itemconfig(self.fern_fenster, width=breite - 32, height=h)
        self.buehne.coords(self.fern_fenster, 16, hoehe - h - 14)

    def band_schlag(self, _n=0):
        """Die Höhe des Fernzugriffs weich nachführen.

        Läuft nur, solange sich wirklich etwas ändert — also ein paar Zehntel
        Sekunden, wenn jemand kommt oder geht. Sonst bricht der erste Vergleich
        sofort ab und kostet nichts.
        """
        if self.k_fern is None or not self.band_ziel:
            return
        abstand = self.band_ziel - self.band_stand
        if abs(abstand) < 1:
            if self.band_stand != self.band_ziel:
                self.band_stand = self.band_ziel
                self.band_stellen()
                self.buehne_richten()      # einmal am Ende nachrücken lassen
            return
        self.band_stand += abstand * 0.25
        self.band_stellen()

    def fern_melden(self, offen):
        """Wird von der Mitschrift nach jedem Nachsehen gerufen.

        Was dort steht, wird nicht noch einmal hergeleitet, sondern beim
        Bereich selbst abgelesen — er weiß es besser, und er weiß es in der
        eingestellten Sprache. Eine zweite Herleitung wäre eine zweite
        Wahrheit, die irgendwann von der ersten abweicht.
        """
        da = bool(offen)
        titel = self.fern.kopf.itemcget(self.fern.titel_id, "text")
        wer = self.fern.kopf.itemcget(self.fern.wer_id, "text")
        text = (f"{titel}   ·   {wer}" if da else wer) or titel
        if text != self._fern_text:
            self._fern_text = text
            self.fern_stand.config(text=text, fg=F["tinte"] if da else F["leise"])
        if da == self.fern_offen:
            return
        self.fern_offen = da
        # Verbunden: Bernstein. Still: der ruhige Ton, den auch die Karte mit
        # den Bestandteilen trägt. Rot wäre falsch — Fernzugriff ist nichts
        # Schlimmes, nur etwas, das man sehen soll.
        self.k_fern.ton_setzen(F["warn"] if da else F["zeit"])
        self.band_richten()

    def fern_schlag(self, n):
        """Der Punkt an der Fernzugriff-Karte atmet — nur wenn jemand da ist.

        Ist niemand verbunden, bricht das hier in der ersten Zeile ab und
        kostet nichts. Und das ist fast immer der Fall.
        """
        if not self.fern_offen or self.k_fern is None or self.k_fern.punkt is None:
            return
        welle = (math.sin(n * 0.14) + 1) / 2
        c = self.k_fern.punkt_leinwand
        c.itemconfig(self.k_fern.punkt, fill=mischen("#7a5410", F["warn"], welle))
        c.itemconfig(self.k_fern.hof, outline=mischen(F["karte"], F["warn"], welle * 0.7))

    def sprache_wechseln(self):
        """Zwischen Deutsch und Englisch umschalten — und die Wahl merken."""
        global SPRACHE
        SPRACHE = "en" if SPRACHE == "de" else "de"
        sprache_sichern()
        for karte in (self.k_verbinden, self.k_chat, self.k_aussen,
                      self.k_leistung, self.k_web, self.k_teile):
            karte.sprache_anwenden()
        self.buehne.itemconfig(self.fuss_id, text=T("fuss"))
        self.adressen_stand = None      # Hinweise an den Adressen neu setzen
        # Der Fernzugriff hat unten keinen eigenen Knopf mehr — dieser hier
        # schaltet für beide um, und die Wache merkt sich die Wahl auch für
        # ihre eigenständige Fassung.
        if self.fern is not None:
            WACHE.sprache_setzen(SPRACHE)
            self.fern.sprache_anwenden()
            self.k_fern.sprache_anwenden()
            self._fern_text = None      # die Zustandszeile neu holen
        self.ablage.stand = None        # Überschrift und Hinweise neu setzen
        self.buehne_richten()
        if self.stand and "fehler" not in self.stand:
            self.zeichnen(self.stand)

    # ── Bewegung ────────────────────────────────────────────────
    # Alles hier unten ruft der Herzschlag, fünfundzwanzig Mal je Sekunde, und
    # gibt die laufende Bildnummer mit. Eigene `after`-Schleifen gibt es nicht
    # mehr — eine Uhr für alle.
    #
    # Die Grenze, an der sich jede dieser Bewegungen messen lassen muss: auf
    # demselben Pi läuft Dons Firmen-Chat, und whisper transkribiert
    # Sprachnachrichten auf drei von vier Kernen. Alles hier zusammen kostet
    # gemessene 2,4 % eines Kerns; die frühere, unbewegte Fassung kostete
    # 8,4 %. Mehr Bewegung bei einem Drittel der Last ist kein Zufall, sondern
    # der ganze Kunstgriff: bewegt wird Geometrie, nicht Text.

    STRAHL_LAUF = 380      # Bilder für einen Durchgang: gut 15 s bei 25 Bildern
    STRAHL_RUHE = 200      # danach 8 s Ruhe, sonst wird es zum Flimmern
    STRAHL_SCHWEIF = 5     # so viele Linien hat der Nachzieher
    STRAHL_TAKT = 2        # nur jedes zweite Bild — siehe `strahl_schlag`

    def drehen(self, n):
        """Der Stern pulsiert leise — das Zeichen der App, das hier atmet."""
        welle = (math.sin(n * 0.10) + 1) / 2
        self.kopf.itemconfig(self.stern, fill=mischen("#3c2f7a", F["rand"], welle))

    # Das Raster driftete hier einmal langsam schräg davon. Es ist wieder
    # heraus, und zwar nicht aus Geschmack, sondern nach Messung:
    #
    #     alles an                     12,0 Bilder/s
    #     ohne Gitterdrift             18,1
    #     ohne Gitterdrift und Komet   23,2
    #
    # Ein `move` auf das ganze Raster verschiebt zwar billig 62 Linien — der
    # Prozessor sah davon nur 1,4 % —, aber es beschädigt bei jedem Bild die
    # *gesamte* Fläche, und Tk muss darunter alle 68 großen Aurora-Ovale neu
    # rastern. Das kostete die halbe Bildrate für eine Bewegung, die aus zwei
    # Metern niemand bemerkt. Ein ruhendes Raster ist hier das bessere
    # Geschäft: die Bewegung sitzt in den Tachos, im Kopf und im Kometen, und
    # die sieht man.

    def instrument_schlag(self, n):
        """Der große Ringsatz dreht sich — jeder Ring anders, abwechselnd gegenläufig.

        Verändert wird nur der Startwinkel vorhandener Bögen; es entsteht keine
        Geometrie. Darum kostet das Schaustück der ganzen Anzeige so wenig,
        dass es sich neben allem anderen nicht mehr messen lässt.
        """
        for kennung, tempo in self.instrument_ringe:
            self.buehne.itemconfig(kennung, start=(n * tempo) % 360)

    def instrument_richten(self, breite, hoehe):
        """Den Ringsatz dorthin setzen, wo gerade Platz ist.

        Er sucht sich den freien Grund unter der rechten Spalte. Wächst die
        Spalte, bis kein Platz mehr bleibt, verschwindet er — lieber gar kein
        Schaustück als eines, das über Zahlen liegt. Verdeckt werden kann er
        ohnehin nicht: Karten sind eigene Fenster und liegen immer obenauf.
        """
        self.instrument_ringe = []
        self.buehne.delete("instrument")
        kasten = self.buehne.bbox(self.spalte_rechts)
        oben = (kasten[3] if kasten else KOPFHOCH) + 24
        frei = hoehe - 40 - oben
        if frei < 170 or breite < 900:
            return
        links = kasten[0] if kasten else breite * 0.6
        rechts = kasten[2] if kasten else breite
        r = min(frei / 2 - 12, (rechts - links) / 2 - 12, 168)
        if r < 74:
            return
        self.instrument_ringe = instrument(
            self.buehne, (links + rechts) / 2, oben + frei / 2, r)

    def kopf_ring_richten(self, breite):
        """Die technische Leiste im Kopf — sie ist immer da.

        Der grosse Ringsatz braucht freien Grund und tritt zurueck, sobald die
        Karten den Platz fuellen; auf dem Pi-Schirm ist das der Normalfall. Die
        Leiste hier haelt deshalb die Zusage ein, dass sich auf diesem Schirm
        immer etwas dreht — egal wie voll er gerade ist. Sie sitzt in dem
        breiten Nichts zwischen dem Namen links und dem Sprachknopf rechts,
        also dort, wo ohnehin niemand etwas anderes hinstellen wuerde.

        Sie besteht aus einer Achse mit Skalenstrichen, zwei gegenlaeufigen
        Ringen und einer Marke, die langsam an der Achse entlangfaehrt.
        Bewegt werden davon je Bild zwei Bogenwinkel und eine Marke.
        """
        self.buehne.delete("kopfleiste")
        self.kopf_ringe = []
        self.kopf_marke = None
        links, rechts = 430, breite - 96
        if rechts - links < 220:
            return                      # zu schmal: dann lieber gar nichts
        self.kopf_spanne = (links, rechts)
        y = 42
        self.buehne.create_line(links, y, rechts, y, fill=F["gitter_hell"],
                                tags="kopfleiste")
        for i in range(0, int(rechts - links), 26):
            gross = (i // 26) % 4 == 0
            self.buehne.create_line(links + i, y - (6 if gross else 3),
                                    links + i, y + (6 if gross else 3),
                                    fill=F["marke_hell"] if gross else F["marke"],
                                    tags="kopfleiste")
        # Die Marke, die an der Achse entlangfaehrt.
        self.kopf_marke = self.buehne.create_polygon(
            0, 0, 0, 0, 0, 0, fill=F["marke_klar"], outline="", tags="kopfleiste")

        # Zwei kleine Ringsaetze, einer an jedem Ende der Achse.
        for mx, spiegel in ((links - 26, 1), (rechts + 30, -1)):
            for i, (anteil, weite, tempo, strich) in enumerate((
                    (1.00, 359, 0.9 * spiegel, (2, 5)),
                    (0.66, 122, -1.8 * spiegel, None))):
                r = 16 * anteil
                self.kopf_ringe.append((self.buehne.create_arc(
                    mx - r, y - r, mx + r, y + r, start=i * 60, extent=weite,
                    style="arc", width=1, outline=F["marke_hell"], dash=strich,
                    tags="kopfleiste"), tempo))
            self.buehne.create_oval(mx - 2, y - 2, mx + 2, y + 2,
                                    fill=F["marke_klar"], outline="", tags="kopfleiste")

    def kopf_ring_schlag(self, n):
        """Die Ringe drehen, die Marke wandern lassen."""
        for kennung, tempo in self.kopf_ringe:
            self.buehne.itemconfig(kennung, start=(n * tempo) % 360)
        if self.kopf_marke is None:
            return
        links, rechts = self.kopf_spanne
        # Hin und zurueck statt im Kreis: eine Marke, die am Ende verschwindet
        # und vorne wieder auftaucht, sieht nach einem Fehler aus.
        welle = (math.sin(n * 0.012) + 1) / 2
        x = links + (rechts - links) * welle
        self.buehne.coords(self.kopf_marke, x - 5, 34, x + 5, 34, x, 42)

    def strahl_richten(self, breite, hoehe):
        """Den Abtaststrahl neu aufspannen — bei jeder Größenänderung."""
        self.buehne.delete("strahl")
        self.strahl_masse = (breite, hoehe)
        # Neun Linien: eine helle Kante und ein Schweif, der dahinter
        # ausbleicht. Gemessen kostet der ganze Nachzieher 1,1 % — der
        # billigste auffällige Effekt in dieser Datei, weil eine waagerechte
        # Linie beim Verschieben nur einen sehr flachen Streifen beschädigt.
        self.strahl_teile = []
        for i in range(self.STRAHL_SCHWEIF):
            anteil = (1 - i / self.STRAHL_SCHWEIF) ** 2
            self.strahl_teile.append(self.buehne.create_line(
                0, -40, breite, -40, tags="strahl",
                fill=mischen(F["grund"], F["strahl"], anteil)))
        # Zwei kurze senkrechte Marken laufen an den Rändern mit — sie machen
        # aus der Linie einen Schlitten, der über die Fläche fährt.
        for _ in range(2):
            self.strahl_teile.append(self.buehne.create_line(
                0, -40, 0, -40, fill=F["marke_klar"], tags="strahl"))
        self.buehne.tag_raise("strahl")

    def strahl_schlag(self, n):
        """Der Strahl wandert langsam von oben nach unten und macht dann Pause.

        Er läuft *hinter* den Karten her — die sind eigene Fenster und liegen
        immer obenauf. Sichtbar ist er auf dem freien Grund und in den
        Zwischenräumen, und genau das soll er: er tastet ab, wo nichts steht,
        statt über die Zahlen zu wischen, die man lesen will.
        """
        if not self.strahl_teile or n % self.STRAHL_TAKT:
            # Nur jedes zweite Bild, dafür mit doppeltem Schritt: er sieht
            # gleich schnell aus, beschädigt aber halb so oft die volle
            # Breite. Gemessen brachte allein das gut zwei Bilder je Sekunde.
            return
        takt = n % (self.STRAHL_LAUF + self.STRAHL_RUHE)
        breite, hoehe = self.strahl_masse
        if takt >= self.STRAHL_LAUF:
            if takt == self.STRAHL_LAUF:      # einmal aus dem Bild räumen
                for kennung in self.strahl_teile:
                    self.buehne.coords(kennung, 0, -40, breite, -40)
            return
        y = takt / self.STRAHL_LAUF * (hoehe + 80) - 40
        for i in range(self.STRAHL_SCHWEIF):
            yy = y - i * 5
            self.buehne.coords(self.strahl_teile[i], 0, yy, breite, yy)
        self.buehne.coords(self.strahl_teile[-2], 13, y - 9, 13, y + 9)
        self.buehne.coords(self.strahl_teile[-1], breite - 13, y - 9, breite - 13, y + 9)

    # ── Daten ───────────────────────────────────────────────────
    def holen(self):
        while True:
            try:
                roh = subprocess.run(KONSOLE, capture_output=True, text=True, timeout=25)
                self.stand = json.loads(roh.stdout)
            except Exception as fehler:                     # noqa: BLE001
                self.stand = {"fehler": str(fehler)}
            time.sleep(TAKT)

    def auffrischen(self):
        d = self.stand
        if d and "fehler" not in d:
            self.zeichnen(d)
        elif d:
            self.kopf.itemconfig(self.unterzeile, text=T("keine_verbindung", f=d["fehler"][:70]))
        # Die Karten sind eben vielleicht gewachsen — dann rücken Ablage und
        # Fernzugriff darunter nach.
        self.ablage_richten()
        self.band_richten()
        self.wurzel.after(600, self.auffrischen)

    def schirm_zeigen(self, d):
        """Sitzt gerade jemand per Fernsteuerung am Schirm?

        Gelesen wird, was `stellium-konsole json` liefert — dieselbe Quelle wie
        für alles andere, damit Terminal und Oberfläche nie auseinanderlaufen.
        """
        marke = getattr(self, "schirm_stand", None)
        if marke is None:
            return
        f = d.get("fern") or {}
        if not f.get("da"):
            text, farbe = T("schirm_aus"), F["zeit"]
        elif f.get("verbunden"):
            seit = f.get("seit")
            wann = "?"
            if seit:
                try:
                    wann = time.strftime("%H:%M", time.localtime(
                        calendar.timegm(time.strptime(seit[:19], "%Y-%m-%dT%H:%M:%S"))))
                except Exception:
                    wann = "?"
            # `konto` ist eine Behauptung der Gegenstelle, keine geprüfte
            # Identität — wer das Passwort hat, kann jeden Namen angeben
            # (siehe fernsteuerung/dienst/fern-dienst.mjs). Für den Alltag
            # reicht das: es geht darum zu sehen, wer üblicherweise
            # dransitzt, nicht um einen Beweis. Fehlt der Name (ältere
            # App-Fassung), steht dort „unbekannt" statt gar nichts.
            konto = f.get("konto")
            wer = konto.strip() if isinstance(konto, str) and konto.strip() else T("schirm_unbekannt")
            # Mehrere dürfen gleichzeitig zusehen. Genannt wird der Erste, dazu
            # wie viele noch — Namen aller aufzuzählen würde die Zeile sprengen
            # und stünde im Widerspruch zu dem, was diese Karte soll: zeigen,
            # DASS jemand zusieht, nicht ein Verzeichnis führen.
            wie_viele = f.get("zuschauer") or 1
            vorlage = "schirm_mehr" if wie_viele > 1 else "schirm_da"
            text = T(vorlage).format(zeit=wann, wer=wer, n=wie_viele - 1)
            farbe = F["warn"]
        else:
            text, farbe = T("schirm_frei"), F["leise"]
        if text != getattr(self, "_schirm_text", None):
            self._schirm_text = text
            marke.config(text=text, fg=farbe)

    def zeichnen(self, d):
        self.schirm_zeigen(d)
        self.kopf.itemconfig(self.version_id, text=d.get("version") or "")
        self.kopf.itemconfig(self.unterzeile, text=(
            f"{d.get('modell') or ''}  ·  {time.strftime('%d.%m.%Y, %H:%M:%S')}"))

        # ── Adressen
        # Nur neu aufbauen, wenn sich wirklich etwas geändert hat. Vorher wurden die
        # Zeilen bei jedem Takt weggeworfen und neu gesetzt — das sah aus wie
        # Flackern, obwohl sich nichts tat.
        kennung = tuple((a["art"], a["url"]) for a in d.get("adressen", []))
        if kennung == getattr(self, "adressen_stand", None):
            self.rest_zeichnen(d)
            return
        self.adressen_stand = kennung
        for kind in self.adressen.winfo_children():
            kind.destroy()
        art_farbe = {"sicher": (F["gut"], "🔒"), "tunnel": (F["gut"], "🔒"),
                     "offen": (F["warn"], "⚠"), "lokal": (F["zeit"], "·")}
        gezeigt = 0
        for a in d.get("adressen", []):
            if a["art"] == "lokal" and gezeigt >= 4:
                continue
            farbe, zeichen = art_farbe.get(a["art"], (F["leise"], "·"))
            reihe = tk.Frame(self.adressen, bg=F["karte"])
            reihe.pack(fill="x", pady=1)
            tk.Label(reihe, text=zeichen, bg=F["karte"], fg=farbe, width=3,
                     font=tkfont.Font(family="DejaVu Sans", size=10)).pack(side="left")
            tk.Label(reihe, text=a["url"], bg=F["karte"],
                     fg=F["blau"] if a["art"] in ("sicher", "tunnel") else F["tinte"],
                     anchor="w", font=tkfont.Font(family="DejaVu Sans Mono", size=10)
                     ).pack(side="left")
            hinweis = {"offen": T("offen"), "lokal": T("eigenes_netz"),
                       "tunnel": T("tunnel")}.get(a["art"], "")
            if hinweis:
                tk.Label(reihe, text=f"   {hinweis}", bg=F["karte"], fg=F["zeit"], anchor="w",
                         font=tkfont.Font(family="DejaVu Sans", size=9)).pack(side="left")
            gezeigt += 1

        self.rest_zeichnen(d)

    def rest_zeichnen(self, d):
        # ── Chat-Server
        dienste = d.get("dienste", {})
        chat = dienste.get("chat", {})
        self.k_chat.feld("dienst",
                         T("laeuft_auto") if chat.get("an") and chat.get("auto")
                         else T("laeuft") if chat.get("an") else T("aus"),
                         F["gut"] if chat.get("an") and chat.get("auto")
                         else F["warn"] if chat.get("an") else F["schlecht"])
        ki = d.get("ki")
        if ki:
            # „an" hing früher allein am gewählten Anbieter — bei einem lokalen
            # Modell also immer, auch wenn dort niemand antwortete. Der Server
            # liefert jetzt einen tatsächlich gemessenen Zustand; steht der zur
            # Verfügung, entscheidet er. Eine Anzeige, die grün leuchtet, ohne
            # nachgesehen zu haben, ist schlimmer als gar keine.
            zustand = ki.get("lokalerZustand")
            if zustand == "antwortet-nicht":
                text = T("stumm")
                seit = seit_wann(ki.get("lokalErfolgAm"))
                text += "  ·  " + (T("seit") + " " + seit if seit else T("nie_erreicht"))
                self.k_chat.feld("uebersetzung", text, F["schlecht"])
            elif zustand == "kein-modell":
                self.k_chat.feld("uebersetzung", T("ohne_modell"), F["schlecht"])
            else:
                an = bool(ki.get("translation")) and ki.get("provider") != "demo"
                self.k_chat.feld("uebersetzung", f"{T('an')} · {ki['provider']}" if an
                                 else T("uebersetzung_aus"),
                                 F["gut"] if an else F["warn"])
            if ki.get("model"):
                self.k_chat.feld("modell", ki["model"])
        verbunden = d.get("verbunden") or {}
        clients = verbunden.get("clients", 0)
        leute = verbunden.get("benutzer", 0)
        self.k_chat.feld("verbunden",
                         f"{clients} {T('verbindung') if clients == 1 else T('verbindungen')}"
                         f"  ·  {leute} {T('person') if leute == 1 else T('personen')}"
                         if clients else T("niemand"),
                         F["gut"] if clients else F["zeit"])

        inhalt = d.get("inhalt") or {}
        teile = [f"{inhalt[k]} {T(n)}" for k, n in
                 (("users", "konten"), ("channels", "kanaele"), ("messages", "nachrichten"))
                 if inhalt.get(k) is not None]
        if teile:
            self.k_chat.feld("inhalt", "  ·  ".join(teile))
        if inhalt.get("groesse"):
            self.k_chat.feld("datenbank", groesse(inhalt["groesse"]))

        abl = d.get("ablage") or {}
        if abl.get("dateien"):
            teil = f"{groesse(abl['belegt'])} {T('belegt')}  ·  {abl['dateien']} {T('dateien')}"
            if abl.get("frei") is not None:
                teil += f"  ·  {groesse(abl['frei'])} {T('frei')}"
            self.k_chat.feld("ablage", teil)

        # ── Weg nach außen
        web = dienste.get("web", {})
        self.k_aussen.feld("nginx",
                           T("laeuft_auto") if web.get("an") and web.get("auto")
                           else T("laeuft") if web.get("an") else T("aus"),
                           F["gut"] if web.get("an") else F["schlecht"], roh="nginx")
        zert = d.get("zertifikat")
        if zert and zert.get("art") == "tunnel":
            # TLS endet bei Cloudflare (oder wer sonst den Tunnel betreibt),
            # nicht auf diesem Pi -- "kein Zertifikat" wäre hier schlicht
            # falsch. Siehe tunnelZertifikat() in stellium-konsole.mjs.
            self.k_aussen.feld("zertifikat",
                               T("zert_tunnel", anbieter=zert.get("anbieter", "Tunnel")),
                               F["gut"])
        elif zert:
            tage = zert.get("tage", 0)
            self.k_aussen.feld("zertifikat", f"{zert['name']} · {T('tage', n=tage)}",
                               F["schlecht"] if tage < 10 else F["warn"] if tage < 25 else F["gut"])
        else:
            self.k_aussen.feld("zertifikat", T("kein_zert"), F["warn"])
        if d.get("firewall") is not None:
            self.k_aussen.feld("firewall", T("aktiv") if d["firewall"] else T("aus"),
                               F["gut"] if d["firewall"] else F["schlecht"])
        if d.get("gesperrt") is not None:
            n = d["gesperrt"]
            self.k_aussen.feld("fail2ban", T("gesperrt", n=n) if n else T("wacht"),
                               F["warn"] if n else F["gut"], roh="fail2ban")
        sicherung = d.get("sicherung")
        anzahl = sicherung["anzahl"] if sicherung else 0
        self.k_aussen.feld("sicherung",
                           f"{anzahl} {T('stand')}" if anzahl == 1
                           else f"{anzahl} {T('staende')}" if anzahl else T("noch_keine"),
                           F["gut"] if sicherung else F["warn"])

        # ── Leistung
        L = d.get("leistung", {})
        self.k_leistung.tacho("prozessor", L.get("cpu"),
                              unten=f"{L.get('kerne', '?')} {T('kerne')}"
                                    + (f" · {round(L['mhz'] / 1000, 1)} GHz" if L.get("mhz") else ""))
        self.k_leistung.tacho("speicher", L.get("ramAnteil"),
                              unten=f"{groesse(L.get('ramBelegt'))} / {groesse(L.get('ramGesamt'))}")
        if L.get("platte"):
            pl = L["platte"]
            self.k_leistung.tacho("platte", pl["belegt"] / max(pl["gesamt"], 1),
                                  # Immer „belegt / gesamt", wie beim Speicher
                                  # darüber. Der freie Platz stand hier allein
                                  # und zwang zum Kopfrechnen, um zu wissen,
                                  # wovon die Prozentzahl ein Anteil ist.
                                  unten=f"{groesse(pl['belegt'])} / {groesse(pl['gesamt'])}")
        abl = d.get("ablage") or {}
        if abl.get("gesamt"):
            # Nicht der Anteil der Ablage an der Platte, sondern wie voll die
            # Platte ist, auf der sie liegt — das ist die Zahl, die zählt.
            self.k_leistung.tacho("ablage",
                                  1 - (abl["frei"] or 0) / max(abl["gesamt"], 1),
                                  unten=f"{groesse(abl['belegt'])} / {groesse(abl['gesamt'])}")

        temperaturen = L.get("temperaturen", [])
        if temperaturen:
            grad = temperaturen[0]["grad"]
            # 40 °C ist kühl, 85 °C die Grenze — dazwischen wird der Bogen voll.
            # `wert` statt `zahl`: so läuft die Zahl gemeinsam mit dem Bogen
            # dorthin, statt am Ende umzuklappen.
            self.k_leistung.tacho("temperatur", max(0.0, min(1.0, (grad - 40) / 45)),
                                  wert=grad, form=lambda v: f"{v:.0f}°",
                                  unten=T("prozessor"))

        if L.get("swap") and L["swap"]["belegt"] > 0:
            sw = L["swap"]
            self.k_leistung.feld("auslagerung",
                                 # Schrägstrich wie überall sonst: „von" gäbe es
                                 # im Englischen als „of", und dann stünden zwei
                                 # Schreibweisen für dieselbe Aussage auf einem Schirm.
                                 f"{groesse(sw['belegt'])} / {groesse(sw['gesamt'])}", F["warn"])
        if L.get("netz"):
            self.k_leistung.feld("netz", f"{groesse(L['netz']['rein'])} {T('empfangen')}"
                                         f"  ·  {groesse(L['netz']['raus'])} {T('gesendet')}")
        self.k_leistung.feld("laeuft_seit", dauer(L.get("laufzeit", 0)))

        # ── Website des Kollegen
        # Sie läuft auf demselben Pi, gehört aber nicht uns. Gelesen wird
        # allein ihr Zugriffsprotokoll aus dem Journal — die Seite selbst
        # wird nicht angefasst und auch nicht aufgerufen (siehe
        # server-setup/FREMDE-DIENSTE.md). Hier stehen ausschließlich
        # Summen: keine Adressen, keine Kennungen, keine Namen. Dieser
        # Bildschirm ist der Hintergrund, den jeder im Raum sieht.
        w = d.get("webseite") or {}
        if w:
            hw = w.get("heute") or {}
            ww = w.get("woche") or {}
            jetzt, jetzt30 = w.get("jetzt") or 0, w.get("jetzt30") or 0
            # Der Bogen zeigt, welcher Teil der letzten halben Stunde noch da
            # ist: voll heißt, es füllt sich gerade, schmal heißt, es leert
            # sich. Die Beschriftung darunter nennt genau diesen Nenner.
            self.k_web.tacho("web_jetzt", jetzt / max(jetzt30, jetzt, 1), menge(jetzt),
                             T("web_in30", n=menge(jetzt30)), ton=F["blau"])
            bes, beste = hw.get("besucher") or 0, w.get("besteTag") or 0
            self.k_web.tacho("web_heute_t", bes / max(beste, bes, 1), menge(bes),
                             T("web_beste", n=menge(beste)), ton=F["rosa"])

            if not w.get("da"):
                self.k_web.feld("web_zustand", T("web_ruht"), F["schlecht"])
            else:
                letzte = w.get("letzte") or {}
                text, farbe = T("laeuft"), F["gut"]
                if letzte.get("t"):
                    # Dass die Seite antwortet, sagt ihr eigener Verkehr. Sie
                    # dafür alle zwei Sekunden selbst aufzurufen wären 43 000
                    # erfundene Zeilen am Tag in seiner Statistik.
                    text += f"  ·  {T('web_letzter', t=seit_wann(letzte['t']))}"
                    text += f"  ·  HTTP {letzte.get('s')}"
                    if (letzte.get("s") or 0) >= 500:
                        farbe = F["schlecht"]
                self.k_web.feld("web_zustand", text, farbe)

            # Seitenaufrufe, nicht rohe Anfragen: ein einziger Besuch holt
            # Stylesheet, Skript und ein Dutzend Bilder mit. „313 Aufrufe" für
            # 60 wirkliche Seitenaufrufe wäre eine geschmeichelte Zahl.
            self.k_web.feld("web_heute",
                            f"{menge(hw.get('seiten'))} {T('web_aufrufe')}"
                            f"  ·  {menge(bes)} {T('web_besucher')}")

            # Der Zeitraum steht in der Beschriftung, nicht im Wert: das
            # Journal reicht nicht beliebig weit zurück, und „7 Tage" über
            # fünf Tagen Daten macht jede Zahl daneben falsch. So bleibt die
            # Zeile außerdem kurz genug für die Spalte.
            tage_n = ww.get("tage") or 0
            self.k_web.feld("web_woche",
                            f"{menge(ww.get('seiten'))} {T('web_aufrufe')}  ·  "
                            f"{'≈' if ww.get('ungefaehr') else ''}"
                            f"{menge(ww.get('besucher'))} {T('web_besucher')}",
                            roh=T("web_woche_n", n=tage_n))
            self.k_web.beschriftung_setzen("web_woche", T("web_woche_n", n=tage_n))

            self.k_web.feld("web_verkehr",
                            f"{menge(hw.get('aufrufe'))} {T('web_anfragen')}"
                            f"  ·  {groesse(hw.get('bytes') or 0)}", F["leise"])

            if w.get("verlauf"):
                self.k_web.feld("web_verlauf", kurve(w["verlauf"]), F["leise"])

            def paare(liste, namen=None):
                return "  ·  ".join(f"{(namen or {}).get(p, p)} {menge(n)}"
                                    for p, n in (liste or [])[:3])

            if w.get("beliebt"):
                self.k_web.feld("web_beliebt", paare(w["beliebt"]))
            if w.get("herkunft"):
                self.k_web.feld("web_herkunft", paare(w["herkunft"], {
                    "(direkt)": T("web_direkt"), "(intern)": T("web_intern")}))

            f404, f5xx = hw.get("f404") or 0, hw.get("f5xx") or 0
            if f404 or f5xx:
                teile = ([f"{menge(f404)} × 404"] if f404 else []) + \
                        ([f"{menge(f5xx)} × 5xx"] if f5xx else [])
                self.k_web.feld("web_fehler", "  ·  ".join(teile),
                                F["schlecht"] if f5xx else F["warn"])
            else:
                self.k_web.feld("web_fehler", T("web_keine_fehler"), F["gut"])

            # Nur Pfade, die von der Seite selbst verlinkt sind oder die
            # Browser von sich aus holen. Das Klopfen an /wp-login.php ist
            # kein Mangel an der Seite und stünde hier nur im Weg.
            if w.get("serverfehler"):
                self.k_web.feld("web_kaputt", paare(w["serverfehler"]), F["schlecht"])
            elif w.get("kaputt"):
                self.k_web.feld("web_kaputt", paare(w["kaputt"]), F["warn"])

            maschinen, klopfen = hw.get("maschinen") or 0, hw.get("klopfen") or 0
            if maschinen or klopfen:
                # Anfragen, nicht Seitenaufrufe: ein Scanner klappert Pfade
                # ab, er „besucht" nichts.
                text = f"{menge(maschinen)} {T('web_anfragen')}"
                if klopfen:
                    text += f"  ·  {T('web_klopfen', n=menge(klopfen))}"
                self.k_web.feld("web_maschinen", text, F["zeit"])

        for t in d.get("bestandteile", []):
            self.k_teile.feld(t["name"], t["fassung"], roh=t["name"])

        # ── Verkauf
        # Die Zahlen stehen längst in `stellium-konsole.mjs` — Mitglieder und
        # Preise öffentlich, Einnahmen nur mit Gumroad-Token. Angezeigt wurden
        # sie bisher nirgends.
        ab = d.get("abo") or {}
        if ab.get("da"):
            waehrung = ab.get("waehrung") or "USD"
            self.k_verkauf.feld("vk_produkt", ab.get("name") or "—")

            mitglieder = ab.get("mitglieder")
            self.k_verkauf.feld(
                "vk_mitglieder",
                "—" if mitglieder is None
                else (f"0  ·  {T('vk_noch_keine')}" if mitglieder == 0 else menge(mitglieder)),
                F["gut"] if mitglieder else F["zeit"])

            # Der Monatsumsatz kann auf zwei Wegen entstehen. Ohne Token ist er
            # aus der Mitgliederzahl gerechnet — das gehört danebengeschrieben,
            # sonst liest sich eine Schätzung wie eine Abrechnung.
            u = ab.get("umsatz") or {}
            text = geld(u.get("monatCent"), u.get("waehrung") or waehrung)
            if u.get("grundlage") == "mitgliederzahl":
                text += f"  ·  {T('vk_geschaetzt')}"
            self.k_verkauf.feld("vk_umsatz", text,
                                F["gut"] if (u.get("monatCent") or 0) > 0 else F["zeit"])

            self.k_verkauf.feld("vk_preis", ab.get("preisText") or "—")

            pr = ab.get("probe") or {}
            self.k_verkauf.feld(
                "vk_probe",
                f"{pr.get('anzahl')} {pr.get('einheit')}" if pr.get("anzahl") else "—",
                F["zeit"])

            # Ohne Token gibt es keine echten Einnahmen. Das steht als Grund da
            # und nicht als Strich: „—" hieße „nichts eingenommen".
            ein = ab.get("einnahmen")
            if not ein:
                self.k_verkauf.feld("vk_einnahmen", T("vk_kein_token"), F["zeit"])
            else:
                text = (f"{geld(ein.get('nettoCent'), ein.get('waehrung') or waehrung)}"
                        f"  ·  {T('vk_tage', n=ein.get('tage', 30))}")
                if ein.get("vollstaendig") is False:
                    text += f"  ·  {T('vk_unvollstaendig')}"
                self.k_verkauf.feld("vk_einnahmen", text,
                                    F["warn"] if ein.get("vollstaendig") is False else F["gut"])


if __name__ == "__main__":
    Konsole().wurzel.mainloop()
