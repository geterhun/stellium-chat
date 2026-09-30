/*
 * stellium-fern-host — der Teil, der auf dem Pi am Bildschirm sitzt.
 *
 * Warum überhaupt selbst gebaut, wo es TeamViewer gibt: TeamViewer belegt auf
 * diesem Pi **798 MB** Arbeitsspeicher (gemessen: teamviewerd 104 MB +
 * TeamViewer_Desktop 713 MB) und rechnet durchgehend, auch wenn sich auf dem
 * Schirm nichts rührt.
 *
 * ── Was gemessen wurde, bevor eine Zeile davon entstand ──────────
 *
 * Der Pi 5 hat **keinen** Hardware-Kodierer für H.264. Nachgesehen, nicht
 * vermutet: unter /dev/video* liegen nur `rpi-hevc-dec` (ein *De*kodierer) und
 * die Kamera-Pipeline `pispbe`. Die Zeile `h264_v4l2m2m` in ffmpeg ist eine
 * leere Hülle ohne Gerät dahinter. Also x264 in Software — gemessen 1080p mit
 * 34 Bildern/s bei 1,2 von 4 Kernen.
 *
 * Die drei Stufen kosten je Bild in 1920x1080:
 *
 *     rücklesen   32 ms      (Minimum; wächst genau mit der Fläche —
 *                             bei 960x540 sind es 8 ms. Das sind ~260 MB/s
 *                             aus dem Grafikspeicher und damit eine
 *                             Eigenschaft des Geräts, nicht des Programms.)
 *     Farbe        8 ms
 *     kodieren    20 ms
 *
 * Hintereinander sind das 60 ms — 16 Bilder/s. Die Stufen wollen aber nichts
 * voneinander: während der Compositor das nächste Bild herüberschreibt, kann
 * x264 längst am vorigen rechnen. Deshalb laufen sie hier auf **zwei Fäden**
 * mit zwei Puffern im Wechsel. Aus 32+8+20 wird max(32, 28) = 32 ms.
 *
 * ── Die zwei Entscheidungen, die den Rest tragen ────────────────
 *
 * KODIERT WIRD IM SELBEN PROZESS. Ein rohes Bild in 1080p ist 8,3 MB; bei
 * 30 Bildern/s wären das 249 MB/s durch eine Pipe an einen zweiten Prozess —
 * mehr Aufwand als das Kodieren selbst. Fertiges H.264 sind ein paar hundert
 * KB/s.
 *
 * ES WIRD NICHT AUFGESTAUT. Ist der Kodierer noch beschäftigt, wenn ein neues
 * Bild fertig ist, wird das **ältere weggeworfen**. Eine Warteschlange würde
 * die Bilder zwar alle liefern, aber jedes einzelne käme später an — und bei
 * Fernsteuerung ist ein verlorenes Bild harmlos, ein spätes nicht.
 *
 * Nach außen geht ein Strom aus Rahmen:  [Art:1][Länge:4 LE][Inhalt]
 */
#define _GNU_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <wayland-client.h>
#include <x264.h>
#include <libswscale/swscale.h>
#include <libavutil/opt.h>
#include <libavutil/pixfmt.h>

#include <poll.h>

#include "wlr-screencopy-unstable-v1-client-protocol.h"
#include "eingabe.h"

#define ART_BILD    1   /* H.264, Annex-B */
#define ART_ABLAGE  2   /* Text aus der Zwischenablage des Pi */
#define ART_MELDUNG 3   /* Klartext fürs Protokoll */

#define PUFFER_ANZAHL 3
/* So viele Streifen darf die Farbwandlung höchstens teilen — mehr als Kerne
   bringt nichts, und der Pi 5 hat vier. */
#define FARB_FAEDEN 4

/* Ein Puffer, in den der Compositor malt. Zwei davon im Wechsel: einer wird
   beschrieben, während der andere kodiert wird. */
struct Puffer {
  struct wl_buffer *wl;
  void             *speicher;
  size_t            groesse;
  uint32_t          breite, hoehe, zeilenlaenge, format;
  bool              voll;        /* enthält ein fertiges Bild */
  bool              in_arbeit;   /* der Kodierer liest gerade daraus */
  bool              reserviert;  /* ein laufender Auftrag malt hinein */
  bool              gedreht;
};

/* Eine laufende Bildanforderung. Es sind immer mehrere gleichzeitig
   unterwegs — siehe Hauptschleife. */
struct Auftrag {
  struct zwlr_screencopy_frame_v1 *rahmen;
  int   puffer;          /* Index in L.puffer */
  bool  fertig, versagt, benutzt;
  int64_t gestellt_ns;
};

#define AUFTRAEGE 3

static struct {
  struct wl_display  *anzeige;
  struct wl_shm      *shm;
  struct wl_output   *ausgang;
  struct zwlr_screencopy_manager_v1 *schirm;
  struct Eingabe    *eingabe;

  struct Puffer   puffer[PUFFER_ANZAHL];
  pthread_mutex_t schloss;
  pthread_cond_t  wecker;

  x264_t            *x264;
  x264_picture_t     bild_ein, bild_aus;
  struct SwsContext *farbe;
  struct SwsContext *farbe_je[FARB_FAEDEN];
  int   farb_y[FARB_FAEDEN], farb_h[FARB_FAEDEN];
  int   farb_streifen;
  int64_t            zaehler;

  int   ziel_bilder, rate_kbit, n_auftraege, x_faeden;
  /* Wie viele Streifen die Farbwandlung teilt. Getrennt von x_faeden,
     weil beide um dieselben vier Kerne streiten: mehr Streifen nehmen
     dem Kodierer und dem Compositor Zeit weg. 0 heisst: so viele wie
     Kodierfaeden. */
  int   n_streifen;
  bool  zeiger, nur_bei_aenderung, nur_lesen;
  int   aus_breite, aus_hoehe;      /* Ausschnitt beim Abgreifen */
  int   ziel_breite, ziel_hoehe;    /* Größe, in der gesendet wird */

  volatile bool lauf;
  /* Naechstes Bild bitte vollstaendig — gesetzt vom Hauptfaden (Befehl 's'),
     gelesen und zurueckgesetzt vom Kodierfaden. Ohne Schloss: das Schlimmste,
     was ein verlorenes Rennen kostet, ist ein Schluesselbild zu viel oder
     eines, das erst beim naechsten Bild kommt. Ein Schloss dafuer stuende im
     Bildpfad und koennte den Abgriff bremsen — das waere der teurere Fehler.

     Gebraucht wird es, sobald jemand mitten in einen laufenden Strom
     dazukommt: bis `i_keyint_max` von allein ein vollstaendiges Bild liefert,
     vergehen vier Sekunden, und so lange sieht der Dazugekommene schwarz
     (die App wartet zu Recht auf ein Schluesselbild, siehe Fernsteuerung.tsx). */
  volatile bool schluesselbild_bitte;
  struct Auftrag auftrag[AUFTRAEGE];

  /* Messung */
  int64_t letzte_meldung_ns;
  uint64_t bilder, bytes, verworfen;
  int64_t t_lesen, t_farbe, t_kodieren;
  uint64_t n_lesen, n_kodiert;
} L = {0};

static int64_t jetzt_ns(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000000000LL + t.tv_nsec;
}

/* ── Ausgang ─────────────────────────────────────────────────── */

/* Nur der Kodierfaden schreibt Bilder, aber Meldungen kommen aus beiden
   Fäden — ohne Schloss würden sich zwei Rahmen ineinanderschieben und der
   Empfänger verlöre die Ausrichtung. */
static pthread_mutex_t ausgang_schloss = PTHREAD_MUTEX_INITIALIZER;

static bool alles_schreiben(const void *daten, size_t laenge) {
  const uint8_t *p = daten;
  while (laenge) {
    ssize_t n = write(STDOUT_FILENO, p, laenge);
    if (n > 0) { p += n; laenge -= (size_t)n; continue; }
    if (n < 0 && errno == EINTR) continue;
    return false;
  }
  return true;
}

static bool rahmen_schreiben(uint8_t art, const void *daten, uint32_t laenge) {
  uint8_t kopf[5] = { art, (uint8_t)laenge, (uint8_t)(laenge >> 8),
                      (uint8_t)(laenge >> 16), (uint8_t)(laenge >> 24) };
  pthread_mutex_lock(&ausgang_schloss);
  bool ok = alles_schreiben(kopf, 5) && (laenge == 0 || alles_schreiben(daten, laenge));
  pthread_mutex_unlock(&ausgang_schloss);
  if (!ok) L.lauf = false;          /* Gegenseite ist weg */
  return ok;
}

static void melden(const char *text) {
  rahmen_schreiben(ART_MELDUNG, text, (uint32_t)strlen(text));
}

/* ── Speicher ────────────────────────────────────────────────── */

static bool puffer_richten(struct Puffer *b, uint32_t format, uint32_t breite,
                           uint32_t hoehe, uint32_t zeilenlaenge) {
  if (b->wl && b->breite == breite && b->hoehe == hoehe &&
      b->zeilenlaenge == zeilenlaenge && b->format == format) return true;

  if (b->wl) { wl_buffer_destroy(b->wl); b->wl = NULL; }
  if (b->speicher) { munmap(b->speicher, b->groesse); b->speicher = NULL; }

  size_t groesse = (size_t)zeilenlaenge * hoehe;
  int fd = memfd_create("stellium-fern", MFD_CLOEXEC);
  if (fd < 0) return false;
  if (ftruncate(fd, (off_t)groesse) < 0) { close(fd); return false; }
  b->speicher = mmap(NULL, groesse, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (b->speicher == MAP_FAILED) { b->speicher = NULL; close(fd); return false; }
  b->groesse = groesse;

  struct wl_shm_pool *becken = wl_shm_create_pool(L.shm, fd, (int32_t)groesse);
  b->wl = wl_shm_pool_create_buffer(becken, 0, (int32_t)breite, (int32_t)hoehe,
                                    (int32_t)zeilenlaenge, format);
  wl_shm_pool_destroy(becken);
  close(fd);
  b->breite = breite; b->hoehe = hoehe;
  b->zeilenlaenge = zeilenlaenge; b->format = format;
  return b->wl != NULL;
}

/* Wayland benennt Formate als 32-Bit-Wort, ffmpeg als Bytefolge — und auf
   ARM wie x86 ist das umgekehrt. XRGB8888 liegt im Speicher als B,G,R,X. */
static enum AVPixelFormat nach_ffmpeg(uint32_t f) {
  switch (f) {
    case WL_SHM_FORMAT_XRGB8888: return AV_PIX_FMT_BGR0;
    case WL_SHM_FORMAT_ARGB8888: return AV_PIX_FMT_BGRA;
    case WL_SHM_FORMAT_XBGR8888: return AV_PIX_FMT_RGB0;
    case WL_SHM_FORMAT_ABGR8888: return AV_PIX_FMT_RGBA;
    default: return AV_PIX_FMT_NONE;
  }
}

/* ── Kodierer (eigener Faden) ────────────────────────────────── */

static bool kodierer_starten(int breite, int hoehe) {
  /* Gesendet wird in der Zielgröße, nicht in der des Schirms. Verkleinert
     wird beim Farbwandeln, also im selben Durchgang und damit gratis.

     Hier stand, der Abgriff koste immer die vollen 32 ms und daran sei nichts
     zu ändern. Das stimmt nicht: er wächst mit der Fläche. Am 21.08.2026
     nachgemessen, reines Lesen ohne Farbe und Kodierung:
         1920x917 (1,76 MP)  →  58,9 ms
         1280x720 (0,92 MP)  →  24,1 ms
          960x540 (0,52 MP)  →  22,7 ms
     Unter etwa einem Megapixel bleibt ein fester Rest von rund 22 ms stehen —
     das ist Wartezeit auf den Compositor, keine Speicherbandbreite, und genau
     die lässt sich mit zwei gleichzeitigen Anforderungen überlappen.
     Praktisch heißt das: wer den Schirm selbst kleiner macht, spart doppelt —
     beim Lesen und beim Wandeln. Bei einem headless-Ausgang kostet das nichts
     als eine Zeile in wlr-randr. */
  x264_param_t p;
  /* ultrafast + zerolatency: keine B-Bilder, keine Vorausschau, kein Puffern.
     Jedes eingegebene Bild kommt sofort wieder heraus. Bei Fernsteuerung ist
     Verzögerung schlimmer als Dateigröße — 100 ms merkt man sofort, 20 % mehr
     Bandbreite nie. */
  if (x264_param_default_preset(&p, "ultrafast", "zerolatency") < 0) return false;
  p.i_csp = X264_CSP_I420;
  p.i_width = breite; p.i_height = hoehe;
  p.i_fps_num = (uint32_t)L.ziel_bilder; p.i_fps_den = 1;
  p.i_threads = L.x_faeden;
  /* Ein Bild aufteilen, statt mehrere zu stapeln: Stapeln bringt zwar mehr
     Durchsatz, kostet aber genau die Verzögerung, die wir vermeiden wollen. */
  p.b_sliced_threads = 1;
  p.i_keyint_max = L.ziel_bilder * 4;
  p.rc.i_rc_method = X264_RC_ABR;
  p.rc.i_bitrate = L.rate_kbit;
  p.rc.i_vbv_max_bitrate = L.rate_kbit * 2;
  p.rc.i_vbv_buffer_size = L.rate_kbit;
  /* SPS/PPS vor jedes Schlüsselbild, damit ein später dazukommender Zuschauer
     sofort anfangen kann, statt auf den nächsten Kopf zu warten. */
  p.b_repeat_headers = 1;
  p.b_annexb = 1;
  if (x264_param_apply_profile(&p, "baseline") < 0) return false;
  L.x264 = x264_encoder_open(&p);
  if (!L.x264) return false;
  return x264_picture_alloc(&L.bild_ein, X264_CSP_I420, breite, hoehe) >= 0;
}

/* ── Farbwandlung in Streifen ─────────────────────────────────
 *
 * Warum überhaupt: Von den drei Stufen lief diese als einzige einfädrig.
 * Auf dem Gerät gemessen (native 1920x917) kostete sie 10,9 ms, während
 * Abgriff und Kodierer nebeneinander arbeiteten — und da die Decke der
 * Kette bei max(Lesen, Farbe+Kodieren) liegt, zählte jede dieser
 * Millisekunden doppelt: sie verlängerte die zweite Stufe UND nahm dem
 * Abgriff einen Kern weg.
 *
 * libswscale kann Fäden, nutzt sie bei unskalierter Wandlung aber nicht:
 * dort greift ein Sonderweg, der einfädrig bleibt. Nachgeprüft mit
 * `threads` über av_opt — die Zeit blieb bei 10,7 ms. Also von Hand
 * geteilt: jeder Faden bekommt einen eigenen Wandler für seinen Streifen
 * und schreibt in seinen eigenen Bereich des Zielbildes. Sie berühren
 * einander nirgends, deshalb braucht es zwischen ihnen kein Schloss —
 * nur eines für das Verteilen und das Warten am Ende.
 */
static struct {
  pthread_t       faden[FARB_FAEDEN];
  pthread_mutex_t schloss;
  pthread_cond_t  los, fertig;
  const uint8_t  *ein[4];
  int             schritt[4];
  uint64_t        runde;          /* zählt je Bild hoch */
  int             offen;          /* wie viele Streifen noch rechnen */
  int             gestartet;
  bool            ende;
} FS;

/* Einen Streifen wandeln. Quelle und Ziel werden auf den Anfang des
   Streifens gerückt; der Wandler selbst kennt nur dessen Höhe.
   Die Verschiebung der Quelle funktioniert auch bei negativer
   Zeilenlänge (Bild auf dem Kopf) — dann läuft sie eben rückwärts. */
static void streifen(int i) {
  const int y = L.farb_y[i];
  const uint8_t *ein[4] = {0};
  int schritt[4] = {0};
  for (int k = 0; k < 4; k++) {
    schritt[k] = FS.schritt[k];
    ein[k] = FS.ein[k] ? FS.ein[k] + (ptrdiff_t)y * FS.schritt[k] : NULL;
  }
  uint8_t *aus[4] = {
    L.bild_ein.img.plane[0] + (ptrdiff_t)y * L.bild_ein.img.i_stride[0],
    L.bild_ein.img.plane[1] + (ptrdiff_t)(y / 2) * L.bild_ein.img.i_stride[1],
    L.bild_ein.img.plane[2] + (ptrdiff_t)(y / 2) * L.bild_ein.img.i_stride[2],
    NULL,
  };
  sws_scale(L.farbe_je[i], ein, schritt, 0, L.farb_h[i], aus, L.bild_ein.img.i_stride);
}

static void *farb_faden(void *arg) {
  const int i = (int)(intptr_t)arg;
  uint64_t gesehen = 0;
  for (;;) {
    pthread_mutex_lock(&FS.schloss);
    while (!FS.ende && FS.runde == gesehen) pthread_cond_wait(&FS.los, &FS.schloss);
    if (FS.ende) { pthread_mutex_unlock(&FS.schloss); break; }
    gesehen = FS.runde;
    pthread_mutex_unlock(&FS.schloss);

    if (i < L.farb_streifen) streifen(i);

    pthread_mutex_lock(&FS.schloss);
    if (--FS.offen == 0) pthread_cond_signal(&FS.fertig);
    pthread_mutex_unlock(&FS.schloss);
  }
  return NULL;
}

static void streifen_wandeln(const uint8_t *const ein[4], const int schritt[4], int hoehe) {
  (void)hoehe;
  if (L.farb_streifen <= 1) {
    /* Ein Streifen heißt: kein Verteilen, kein Warten. Genau der Fall beim
       Skalieren — und der soll nichts von der Maschinerie bezahlen. */
    uint8_t *aus[4] = { L.bild_ein.img.plane[0], L.bild_ein.img.plane[1],
                        L.bild_ein.img.plane[2], NULL };
    sws_scale(L.farbe_je[0], ein, schritt, 0, L.farb_h[0], aus, L.bild_ein.img.i_stride);
    return;
  }

  /* Helfer erst beim ersten Bild starten: vorher steht nicht fest, in wie
     viele Streifen geteilt wird. */
  if (FS.gestartet == 0) {
    pthread_mutex_init(&FS.schloss, NULL);
    pthread_cond_init(&FS.los, NULL);
    pthread_cond_init(&FS.fertig, NULL);
    for (int i = 1; i < L.farb_streifen; i++) {
      if (pthread_create(&FS.faden[i], NULL, farb_faden, (void *)(intptr_t)i) == 0)
        FS.gestartet++;
    }
    /* Konnte kein Helfer starten, macht der aufrufende Faden alles allein —
       langsamer, aber richtig. */
    if (FS.gestartet == 0) L.farb_streifen = 1;
  }

  pthread_mutex_lock(&FS.schloss);
  for (int k = 0; k < 4; k++) { FS.ein[k] = ein[k]; FS.schritt[k] = schritt[k]; }
  FS.offen = FS.gestartet;
  FS.runde++;
  pthread_cond_broadcast(&FS.los);
  pthread_mutex_unlock(&FS.schloss);

  /* Der aufrufende Faden nimmt den ersten Streifen — sonst stünde er nur
     herum, während vier andere rechnen. */
  streifen(0);

  pthread_mutex_lock(&FS.schloss);
  while (FS.offen > 0) pthread_cond_wait(&FS.fertig, &FS.schloss);
  pthread_mutex_unlock(&FS.schloss);
}

static void *kodier_faden(void *arg) {
  (void)arg;
  while (L.lauf) {
    /* Auf ein volles Bild warten. */
    pthread_mutex_lock(&L.schloss);
    int nehmen = -1;
    while (L.lauf && nehmen < 0) {
      for (int i = 0; i < PUFFER_ANZAHL; i++)
        if (L.puffer[i].voll && !L.puffer[i].in_arbeit) { nehmen = i; break; }
      if (nehmen < 0) pthread_cond_wait(&L.wecker, &L.schloss);
    }
    if (nehmen < 0) { pthread_mutex_unlock(&L.schloss); break; }
    struct Puffer *b = &L.puffer[nehmen];
    b->in_arbeit = true; b->voll = false;
    pthread_mutex_unlock(&L.schloss);

    enum AVPixelFormat quelle = nach_ffmpeg(b->format);
    if (L.nur_lesen) { L.bilder++; L.n_kodiert++; quelle = AV_PIX_FMT_NONE; }
    if (quelle != AV_PIX_FMT_NONE) {
      if (!L.ziel_breite) {
        L.ziel_breite = (int)b->breite; L.ziel_hoehe = (int)b->hoehe;
      } else if (L.ziel_hoehe * (int)b->breite != L.ziel_breite * (int)b->hoehe) {
        /* Seitenverhältnis der Quelle erzwingen. Der Schirm des Pi misst
           1920x917 — das sind 2,09 und nicht die 1,78, die man beim Tippen
           einer Zielgröße gewohnheitsmäßig hinschreibt. Wer 960x540 angibt,
           bekommt sonst ein gestauchtes Bild, und das fällt am Schreibtisch
           erst auf, wenn Kreise zu Ellipsen werden.
           Die Breite gilt, die Höhe wird nachgezogen — gerade, weil 4:2:0
           die Farbebenen halbiert. */
        int passend = (int)((long long)L.ziel_breite * b->hoehe / b->breite) & ~1;
        if (passend > 0 && passend != L.ziel_hoehe) {
          char h[120];
          snprintf(h, sizeof h, "Zielhöhe %d statt %d — Seitenverhältnis der Quelle %ux%u",
                   passend, L.ziel_hoehe, b->breite, b->hoehe);
          melden(h);
          L.ziel_hoehe = passend;
        }
      }
      /* H.264 mag gerade Kantenlängen (4:2:0 halbiert die Farbebenen). */
      L.ziel_breite &= ~1; L.ziel_hoehe &= ~1;
      if (!L.x264 && !kodierer_starten(L.ziel_breite, L.ziel_hoehe)) {
        melden("Kodierer ließ sich nicht öffnen"); L.lauf = false;
      }
      if (L.lauf && !L.farbe) {
        /* Ein Wandler je Streifen — siehe streifen_wandeln(). Bei gleicher
           Größe wird nicht skaliert, dann genügt SWS_POINT. */
        const int flaggen = L.ziel_breite == (int)b->breite ? SWS_POINT
                                                            : SWS_FAST_BILINEAR;
        /* In Streifen NUR, wenn nicht skaliert wird. Beim Skalieren hängen
           die Ausgabezeilen nicht mehr eins zu eins an den Eingabezeilen —
           ein Streifen wüsste dann nicht, wohin er schreiben darf. */
        const int wunsch = L.n_streifen > 0 ? L.n_streifen : L.x_faeden;
        L.farb_streifen = (L.ziel_breite == (int)b->breite &&
                           L.ziel_hoehe == (int)b->hoehe) ? wunsch : 1;
        if (L.farb_streifen > FARB_FAEDEN) L.farb_streifen = FARB_FAEDEN;

        /* Streifengrenzen auf GERADE Zeilen legen: 4:2:0 fasst je zwei
           Zeilen zu einer Farbzeile zusammen. Läge eine Grenze dazwischen,
           schrieben zwei Streifen dieselbe Farbzeile — und je nachdem, wer
           zuerst fertig ist, käme etwas anderes heraus. */
        {
          int rest = (int)b->hoehe, y = 0;
          for (int i = 0; i < L.farb_streifen; i++) {
            int h = (i == L.farb_streifen - 1)
                  ? rest
                  : ((rest / (L.farb_streifen - i)) + 1) & ~1;
            if (h <= 0) h = rest;
            L.farb_y[i] = y; L.farb_h[i] = h;
            y += h; rest -= h;
          }
        }
        for (int i = 0; i < L.farb_streifen; i++) {
          /* Jeder Wandler kennt nur SEINEN Streifen — dadurch sind sie
             voneinander unabhängig und dürfen gleichzeitig laufen. */
          L.farbe_je[i] = sws_getContext((int)b->breite, L.farb_h[i], quelle,
                                         L.ziel_breite, L.farb_h[i],
                                         AV_PIX_FMT_YUV420P, flaggen, NULL, NULL, NULL);
          if (!L.farbe_je[i]) { melden("Farbwandler fehlt"); L.lauf = false; break; }
        }
        L.farbe = L.farbe_je[0];
      }
      if (L.lauf) {
        /* Auf dem Kopf geliefert? Von unten nach oben lesen — mit negativer
           Zeilenlänge, das kostet nichts extra. */
        const uint8_t *ein[4] = {0}; int schritt[4] = {0};
        if (b->gedreht) {
          ein[0] = (const uint8_t *)b->speicher + (size_t)b->zeilenlaenge * (b->hoehe - 1);
          schritt[0] = -(int)b->zeilenlaenge;
        } else {
          ein[0] = b->speicher; schritt[0] = (int)b->zeilenlaenge;
        }
        int64_t t0 = jetzt_ns();
        streifen_wandeln(ein, schritt, (int)b->hoehe);
        int64_t t1 = jetzt_ns();

        L.bild_ein.i_pts = L.zaehler++;
        /* Ausdruecklich beide Faelle setzen: x264 laesst `i_type` unberuehrt,
           ein einmal gesetztes IDR wuerde also jedes weitere Bild zum
           Schluesselbild machen — und damit die Bitrate vervielfachen. */
        if (L.schluesselbild_bitte) {
          L.schluesselbild_bitte = false;
          L.bild_ein.i_type = X264_TYPE_IDR;
        } else {
          L.bild_ein.i_type = X264_TYPE_AUTO;
        }
        x264_nal_t *nals = NULL; int anzahl = 0;
        int laenge = x264_encoder_encode(L.x264, &nals, &anzahl, &L.bild_ein, &L.bild_aus);
        int64_t t2 = jetzt_ns();
        L.t_farbe += t1 - t0; L.t_kodieren += t2 - t1; L.n_kodiert++;

        if (laenge < 0) { melden("Kodieren fehlgeschlagen"); L.lauf = false; }
        else if (laenge > 0) {
          rahmen_schreiben(ART_BILD, nals[0].p_payload, (uint32_t)laenge);
          L.bilder++; L.bytes += (uint64_t)laenge;
        }
      }
    }

    pthread_mutex_lock(&L.schloss);
    b->in_arbeit = false;
    pthread_cond_broadcast(&L.wecker);
    pthread_mutex_unlock(&L.schloss);
  }
  pthread_mutex_lock(&L.schloss);
  pthread_cond_broadcast(&L.wecker);
  pthread_mutex_unlock(&L.schloss);
  return NULL;
}

/* ── Bild abholen (Hauptfaden) ───────────────────────────────── */

static void f_buffer(void *d, struct zwlr_screencopy_frame_v1 *f,
                     uint32_t format, uint32_t breite, uint32_t hoehe,
                     uint32_t zeilenlaenge) {
  (void)f;
  struct Auftrag *a = d;
  if (nach_ffmpeg(format) == AV_PIX_FMT_NONE) return;
  puffer_richten(&L.puffer[a->puffer], format, breite, hoehe, zeilenlaenge);
}

static void f_buffer_done(void *d, struct zwlr_screencopy_frame_v1 *f) {
  struct Auftrag *a = d;
  struct Puffer *b = &L.puffer[a->puffer];
  if (!b->wl) { a->versagt = true; return; }
  if (L.nur_bei_aenderung) zwlr_screencopy_frame_v1_copy_with_damage(f, b->wl);
  else                     zwlr_screencopy_frame_v1_copy(f, b->wl);
}

static void f_flags(void *d, struct zwlr_screencopy_frame_v1 *f, uint32_t flags) {
  (void)f;
  struct Auftrag *a = d;
  L.puffer[a->puffer].gedreht =
    (flags & ZWLR_SCREENCOPY_FRAME_V1_FLAGS_Y_INVERT) != 0;
}

static void f_damage(void *d, struct zwlr_screencopy_frame_v1 *f,
                     uint32_t x, uint32_t y, uint32_t b, uint32_t h) {
  (void)d; (void)f; (void)x; (void)y; (void)b; (void)h;
  /* Die Rechtecke selbst brauchen wir nicht — x264 erkennt unveränderte
     Blöcke von allein. Wichtig ist allein, DASS dieses Ereignis kommt:
     `copy_with_damage` meldet sich erst bei echter Änderung, und genau das
     spart im Leerlauf die gesamte Rechenzeit. */
}

static void f_ready(void *d, struct zwlr_screencopy_frame_v1 *f,
                    uint32_t sh, uint32_t sl, uint32_t ns) {
  (void)f; (void)sh; (void)sl; (void)ns;
  ((struct Auftrag *)d)->fertig = true;
}

static void f_failed(void *d, struct zwlr_screencopy_frame_v1 *f) {
  (void)f; ((struct Auftrag *)d)->versagt = true;
}

/* Muss dastehen, auch wenn wir nichts damit tun: libwayland bricht das
   Programm ab, sobald ein Ereignis eintrifft, dessen Eintrag NULL ist — und
   labwc schickt `linux_dmabuf` bei jedem Bild. Genau daran ist der erste
   Versuch gestorben ("listener function for opcode 5 is NULL"). Wir bleiben
   bei geteiltem Speicher: der Weg über dmabuf spart eine Kopie, verlangt aber
   das Auslesen per GPU — und die kann auf diesem Pi kein H.264. */
static void f_dmabuf(void *d, struct zwlr_screencopy_frame_v1 *f,
                     uint32_t format, uint32_t breite, uint32_t hoehe) {
  (void)d; (void)f; (void)format; (void)breite; (void)hoehe;
}

static const struct zwlr_screencopy_frame_v1_listener bild_hoerer = {
  .buffer = f_buffer, .flags = f_flags, .ready = f_ready, .failed = f_failed,
  .damage = f_damage, .linux_dmabuf = f_dmabuf, .buffer_done = f_buffer_done,
};

/* ── Anmeldung ───────────────────────────────────────────────── */

static void reg_global(void *d, struct wl_registry *r, uint32_t name,
                       const char *iface, uint32_t version) {
  (void)d;
  if (L.eingabe) eingabe_global(L.eingabe, r, name, iface, version);
  if (!strcmp(iface, wl_shm_interface.name))
    L.shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
  else if (!strcmp(iface, wl_output_interface.name) && !L.ausgang)
    L.ausgang = wl_registry_bind(r, name, &wl_output_interface, version < 4 ? version : 4);
  else if (!strcmp(iface, zwlr_screencopy_manager_v1_interface.name))
    L.schirm = wl_registry_bind(r, name, &zwlr_screencopy_manager_v1_interface,
                                version < 3 ? version : 3);
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d; (void)r; (void)n; }
static const struct wl_registry_listener reg_hoerer = { reg_global, reg_remove };

/* ── Befehle von außen ───────────────────────────────────────── */

static int base64_wert(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

static size_t base64_lesen(const char *ein, char *aus, size_t platz) {
  size_t n = 0; int teil = 0, bits = 0;
  for (const char *p = ein; *p && *p != '\n'; p++) {
    int w = base64_wert(*p);
    if (w < 0) continue;                     /* '=' und Leerzeichen */
    teil = (teil << 6) | w; bits += 6;
    if (bits >= 8) { bits -= 8; if (n < platz) aus[n++] = (char)((teil >> bits) & 0xff); }
  }
  return n;
}

/* Ein Befehl je Zeile. Bewusst Text: so lässt sich der Strom mitlesen und
   von Hand nachstellen, wenn etwas nicht ankommt. */
/*
 * Die Bitrate im laufenden Betrieb nachziehen.
 *
 * Der Grund dafuer steht nicht im Kodierer, sondern in der Leitung: die
 * Bandbreite zum Zuschauer ist keine feste Groesse. Auf dem Geraet gemessen
 * schwankte sie zwischen 1,56 und 2,48 Mbit/s, waehrend fest 6000 eingestellt
 * waren. Was zuviel erzeugt wird, verschwindet nicht — es sammelt sich im
 * Sendepuffer des Kerns und laeuft dem Betrachter als Verzoegerung davon.
 *
 * `x264_encoder_reconfig` aendert die Rate, ohne den Kodierer neu
 * aufzusetzen. Das ist der springende Punkt: ein Neustart wuerde ein
 * Schluesselbild und eine sichtbare Unterbrechung kosten, und bei einer
 * Anpassung alle paar Sekunden waere das schlimmer als das Problem.
 */
static void rate_setzen(int kbit) {
  if (!L.x264 || kbit == L.rate_kbit) return;
  x264_param_t p;
  x264_encoder_parameters(L.x264, &p);
  p.rc.i_bitrate = kbit;
  p.rc.i_vbv_max_bitrate = kbit;
  /* Der VBV-Puffer bestimmt, wie weit der Kodierer ueber die Rate hinausgehen
     darf, bevor er gegensteuert. Eine halbe Sekunde: kuerzer wuerde jede
     Bildaenderung hart abwuergen, laenger baut genau den Rueckstau auf, den
     die ganze Anpassung vermeiden soll. */
  p.rc.i_vbv_buffer_size = kbit / 2;
  if (x264_encoder_reconfig(L.x264, &p) == 0) L.rate_kbit = kbit;
}

static void befehl_ausfuehren(char *zeile) {
  if (!*zeile) return;
  /* Zeiger, Tastatur und Zwischenablage brauchen die Eingabeseite. Bitrate
     ('b') und Schluesselbild ('s') betreffen allein den Kodierer und gehen
     auch dann, wenn keine Eingabe eingerichtet ist (--nur-lesen). Vorher
     stand die Pruefung vor allem und verschluckte auch diese zwei. */
  char art = zeile[0];
  if (!L.eingabe && art != 'b' && art != 's') return;
  char *rest = zeile + 1;
  switch (art) {
    case 'z': {                              /* Zeiger, 0..65535 */
      unsigned x, y;
      if (sscanf(rest, "%u %u", &x, &y) == 2) eingabe_zeiger(L.eingabe, x, y);
      break;
    }
    case 't': {                              /* Maustaste */
      unsigned knopf, ab;
      if (sscanf(rest, "%u %u", &knopf, &ab) == 2)
        eingabe_taste(L.eingabe, knopf, ab != 0);
      break;
    }
    case 'r': {                              /* Rollen */
      unsigned achse; double wert;
      if (sscanf(rest, "%u %lf", &achse, &wert) == 2)
        eingabe_rollen(L.eingabe, achse, wert);
      break;
    }
    case 'k': {                              /* Taste */
      unsigned code, ab;
      if (sscanf(rest, "%u %u", &code, &ab) == 2)
        eingabe_tastatur(L.eingabe, code, ab != 0);
      break;
    }
    case 'm': {                              /* Umschalter */
      unsigned a, b, c, g;
      if (sscanf(rest, "%u %u %u %u", &a, &b, &c, &g) == 4)
        eingabe_umschalter(L.eingabe, a, b, c, g);
      break;
    }
    case 'a': {                              /* Zwischenablage setzen */
      while (*rest == ' ') rest++;
      size_t platz = strlen(rest) + 1;
      char *text = malloc(platz);
      if (text) {
        size_t n = base64_lesen(rest, text, platz);
        if (n) eingabe_ablage_setzen(L.eingabe, text, n);
        free(text);
      }
      break;
    }
    case 'b': {                              /* Bitrate im Betrieb aendern */
      int kbit = atoi(rest);
      if (kbit >= 200 && kbit <= 20000) rate_setzen(kbit);
      break;
    }
    case 's':                                /* naechstes Bild vollstaendig */
      L.schluesselbild_bitte = true;
      break;
    default: break;
  }
}

/* stdin kommt als Strom, nicht als Zeilen — also selbst zusammensetzen. */
static void befehle_lesen(void) {
  static char rest[8192];
  static size_t belegt = 0;
  ssize_t n = read(STDIN_FILENO, rest + belegt, sizeof rest - belegt - 1);
  if (n <= 0) {
    if (n == 0) L.lauf = false;              /* Gegenseite hat aufgelegt */
    return;
  }
  belegt += (size_t)n;
  rest[belegt] = 0;
  char *anfang = rest;
  for (;;) {
    char *ende = strchr(anfang, '\n');
    if (!ende) break;
    *ende = 0;
    befehl_ausfuehren(anfang);
    anfang = ende + 1;
  }
  belegt = strlen(anfang);
  memmove(rest, anfang, belegt + 1);
  /* Eine Zeile, die den Puffer sprengt, ist kaputt — wegwerfen statt
     endlos anwachsen zu lassen. */
  if (belegt >= sizeof rest - 1) belegt = 0;
}

/* Die Zwischenablage des Pi hat sich geändert — nach draußen melden. */
static void ablage_geaendert(const char *text, size_t laenge, void *nutzer) {
  (void)nutzer;
  if (laenge) rahmen_schreiben(ART_ABLAGE, text, (uint32_t)laenge);
}

/* ── Hauptschleife ───────────────────────────────────────────── */

int main(int argc, char **argv) {
  /* `nur_bei_aenderung` ist AUS, und das kehrt die frühere Entscheidung um.
     Der Gedanke dahinter war richtig: nur zu kopieren, wenn sich etwas
     geändert hat, spart im Stillstand alles. Gemessen kostet er aber mehr,
     als er spart. Am 21.08.2026 ohne Zuschauer, native 1920x917, je zwei
     Durchgänge direkt hintereinander:
         bei Änderung   34,0 · 27,5 B/s     abgriff 29,4 · 36,3 ms
         jedes Bild     41,4 · 40,2 B/s     abgriff 24,1 · 24,9 ms
     `copy_with_damage` wartet auf das nächste Änderungsereignis, und das
     kommt im Takt des Ausgangs — die Wartezeit rastet damit auf Bildgrenzen
     ein. Direktes Kopieren hat diese Rasterung nicht.
     Der Preis ist Bandbreite: 5,0 statt 2,6 Mbit/s. Den fängt die Regelung
     im Dienst ab, die die Rate an die Leitung anpasst — und ein
     unveränderter Schirm kodiert ohnehin fast zu nichts.
     Der Abgriff läuft nur, solange jemand zusieht; Rechenzeit im Leerlauf
     kostet er also niemandem. `--nur-bei-aenderung` schaltet zurück. */
  L.ziel_bilder = 30; L.rate_kbit = 6000; L.zeiger = true; L.nur_bei_aenderung = false;
  /* Erste Messreihe (1280x720, Bilder/s), als Kodieren noch 20 ms kostete:
       Aufträge 1 · Fäden 1 → 12,6      Aufträge 2 · Fäden 1 → 13,4
       Aufträge 1 · Fäden 2 → 14,8      Aufträge 2 · Fäden 2 → 18,5
       Aufträge 1 · Fäden 3 → 20,3      Aufträge 2 · Fäden 3 → 17,9
     Daraus stand hier lange: "Mehrere Anforderungen bringen nichts." Das galt,
     solange der Kodierer der Engpass war. Er ist es nicht mehr — mit drei
     Fäden kostet er 3,6 ms statt 20. Am 21.08.2026 neu gemessen, reines Lesen
     bei 1280x720:
       Aufträge 1 → 43,2 B/s bei 22,8 ms      Aufträge 3 → 54,8 B/s bei 47,5 ms
       Aufträge 2 → 51,1 B/s bei 36,5 ms
     Diese zweite Reihe war jedoch VERFÄLSCHT: sie lief, während ein Zuschauer
     verbunden war, und beide Abgriffe stritten sich um denselben Compositor.
     Ohne Konkurrenz nachgemessen, ganzer Schirm 1920x917:
       Aufträge 1 → 59,4 B/s bei 16,6 ms, nichts verworfen
       Aufträge 2 → 50,2 B/s bei 38,6 ms, 26 verworfen
       Aufträge 3 → 60,1 B/s bei 35,6 ms, 48 verworfen
     Damit gilt wieder der erste Befund, und er gilt deutlich: EINE
     Anforderung ist die schnellste UND die mit der geringsten Verzögerung.
     Der Compositor arbeitet sie ohnehin nacheinander ab; mehrere reihen sich
     nur ein und altern in der Schlange.
     Vier Fäden statt drei sind dagegen belegt: 34,3 gegen 27,9 B/s in der
     vollen Kette. */
  L.n_auftraege = 1; L.x_faeden = 4; L.n_streifen = 0;
  /*
   * ZUR MESSMETHODE, damit hier niemand dieselbe Runde dreht.
   *
   * Ein Lauf von 7 Sekunden liefert zwei bis drei Meldungen, und zwischen
   * ihnen ändert sich der Bildschirminhalt. Die Streuung liegt dann bei
   * rund 5,5 Bildern je Sekunde — größer als fast jeder Unterschied, den
   * man messen will. Auf solchen Zahlen sind in dieser Datei schon zwei
   * Entscheidungen getroffen worden, die sich später als Rauschen
   * herausstellten.
   *
   * Läufe von 30 Sekunden, gemittelt über alle 15 Meldungen, drücken die
   * Streuung auf etwa 1,0. Erst damit lässt sich etwas unterscheiden.
   *
   * So gemessen ergab sich am 22.08.2026, native 1920x917:
   *     Streifen 2 / Fäden 3   →  37,1   Streuung 1,0
   *     Streifen 4 / Fäden 4   →  36,6   Streuung 0,7
   * Also kein Unterschied. Wer hier weiter dreht, dreht an der falschen
   * Schraube: der Abgriff braucht allein 16,6 ms, in der Kette aber 27 —
   * die Differenz ist der Compositor, der sich dieselben vier Kerne teilt,
   * und die holt keine Fadenzahl zurück.
   */
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--bilder") && i + 1 < argc)     L.ziel_bilder = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--rate") && i + 1 < argc)  L.rate_kbit   = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--ohne-zeiger"))           L.zeiger = false;
    else if (!strcmp(argv[i], "--immer"))                 L.nur_bei_aenderung = false;
    else if (!strcmp(argv[i], "--nur-bei-aenderung"))    L.nur_bei_aenderung = true;
    else if (!strcmp(argv[i], "--nur-lesen"))             L.nur_lesen = true;
    else if (!strcmp(argv[i], "--ausgabe") && i + 1 < argc)
      sscanf(argv[++i], "%dx%d", &L.ziel_breite, &L.ziel_hoehe);
    else if (!strcmp(argv[i], "--auftraege") && i + 1 < argc) L.n_auftraege = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--faeden") && i + 1 < argc)    L.x_faeden    = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--streifen") && i + 1 < argc)  L.n_streifen  = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--ausschnitt") && i + 1 < argc)
      sscanf(argv[++i], "%dx%d", &L.aus_breite, &L.aus_hoehe);
  }
  if (L.ziel_bilder < 1)  L.ziel_bilder = 1;
  if (L.ziel_bilder > 60) L.ziel_bilder = 60;
  if (L.rate_kbit < 300)  L.rate_kbit = 300;
  if (L.n_auftraege < 1) L.n_auftraege = 1;
  if (L.n_auftraege > AUFTRAEGE) L.n_auftraege = AUFTRAEGE;
  if (L.x_faeden < 1) L.x_faeden = 1;
  if (L.x_faeden > 4) L.x_faeden = 4;

  signal(SIGPIPE, SIG_IGN);
  pthread_mutex_init(&L.schloss, NULL);
  pthread_cond_init(&L.wecker, NULL);

  L.anzeige = wl_display_connect(NULL);
  if (!L.anzeige) { fprintf(stderr, "kein Compositor erreichbar\n"); return 1; }
  struct wl_registry *reg = wl_display_get_registry(L.anzeige);
  L.eingabe = eingabe_anlegen(L.anzeige, reg);   /* muss stehen, bevor die
                                                    Globals hereinkommen */
  wl_registry_add_listener(reg, &reg_hoerer, NULL);
  wl_display_roundtrip(L.anzeige);
  if (!L.shm || !L.ausgang || !L.schirm) {
    fprintf(stderr, "Compositor bietet screencopy/shm/output nicht an\n"); return 1;
  }
  if (!eingabe_starten(L.eingabe, ablage_geaendert, NULL))
    melden("Achtung: Zeiger oder Tastatur ließen sich nicht einrichten — "
           "das Bild kommt, Eingaben nicht");
  wl_display_roundtrip(L.anzeige);

  L.lauf = true;
  L.letzte_meldung_ns = jetzt_ns();
  pthread_t kodierer;
  pthread_create(&kodierer, NULL, kodier_faden, NULL);

  const int64_t abstand_ns = 1000000000LL / L.ziel_bilder;
  int64_t naechstes = jetzt_ns();

  /*
   * Warum mehrere Anforderungen gleichzeitig unterwegs sind:
   *
   * Eine einzelne Anforderung besteht aus zwei ganz verschiedenen Wartezeiten.
   * Erst liegt sie beim Compositor, bis der überhaupt wieder etwas zeichnet —
   * gemessen 41 ms, weil das Dashboard mit 24 Bildern/s läuft. Danach kommt
   * das eigentliche Rücklesen aus dem Grafikspeicher, gemessen 32 ms. Nach-
   * einander sind das 73 ms, und genau 13 Bilder/s kamen dabei heraus.
   *
   * Die beiden Wartezeiten haben aber nichts miteinander zu tun. Steht die
   * nächste Anforderung schon in der Schlange, während die vorige noch gelesen
   * wird, kostet ein Bild nur noch das Längere von beidem statt der Summe.
   */
  while (L.lauf) {
    /* 1. Freie Auftragsplätze mit neuen Anforderungen füllen. */
    for (int k = 0; k < L.n_auftraege && L.lauf; k++) {
      struct Auftrag *a = &L.auftrag[k];
      if (a->benutzt) continue;
      if (jetzt_ns() < naechstes) break;        /* Takt einhalten */

      pthread_mutex_lock(&L.schloss);
      int frei = -1;
      for (int i = 0; i < PUFFER_ANZAHL; i++)
        if (!L.puffer[i].in_arbeit && !L.puffer[i].voll && !L.puffer[i].reserviert) {
          frei = i; break;
        }
      if (frei < 0) {
        /* Kein Puffer übrig: der Kodierer hängt hinterher. Dann lieber das
           älteste noch ungelesene Bild opfern als Verzögerung aufzubauen —
           ein verlorenes Bild merkt niemand, ein spätes jeder. */
        for (int i = 0; i < PUFFER_ANZAHL; i++)
          if (!L.puffer[i].in_arbeit && !L.puffer[i].reserviert) {
            frei = i; L.verworfen++; break;
          }
      }
      if (frei >= 0) L.puffer[frei].reserviert = true;
      pthread_mutex_unlock(&L.schloss);
      if (frei < 0) break;

      a->puffer = frei; a->fertig = a->versagt = false;
      a->benutzt = true; a->gestellt_ns = jetzt_ns();
      a->rahmen = L.aus_breite
        ? zwlr_screencopy_manager_v1_capture_output_region(
            L.schirm, L.zeiger ? 1 : 0, L.ausgang, 0, 0, L.aus_breite, L.aus_hoehe)
        : zwlr_screencopy_manager_v1_capture_output(L.schirm, L.zeiger ? 1 : 0, L.ausgang);
      zwlr_screencopy_frame_v1_add_listener(a->rahmen, &bild_hoerer, a);

      naechstes += abstand_ns;
      if (naechstes < jetzt_ns() - abstand_ns * 4) naechstes = jetzt_ns();
    }

    int unterwegs = 0;
    for (int k = 0; k < L.n_auftraege; k++) if (L.auftrag[k].benutzt) unterwegs++;

    /*
     * Auf zwei Dinge gleichzeitig horchen: auf den Compositor (fertige Bilder)
     * und auf stdin (deine Eingaben). Der erste Entwurf hing in
     * `wl_display_dispatch` fest und hätte einen Mausklick erst bemerkt,
     * wenn das nächste Bild fertig war — bei 13 Bildern/s also bis zu 77 ms
     * zu spät. Deshalb hier das übliche Wayland-Muster mit poll(): erst
     * anmelden, dass gelesen werden soll, dann warten, dann lesen.
     */
    while (wl_display_prepare_read(L.anzeige) != 0)
      wl_display_dispatch_pending(L.anzeige);
    wl_display_flush(L.anzeige);

    struct pollfd horchen[2] = {
      { .fd = wl_display_get_fd(L.anzeige), .events = POLLIN },
      { .fd = STDIN_FILENO,                 .events = POLLIN },
    };
    /* Wartet nie länger als 5 ms, wenn nichts unterwegs ist — dann muss die
       Schleife oben ohnehin bald eine neue Anforderung stellen. */
    int wartezeit = unterwegs ? 200 : 5;
    int los = poll(horchen, 2, wartezeit);

    if (los > 0 && (horchen[0].revents & POLLIN)) {
      if (wl_display_read_events(L.anzeige) < 0) { L.lauf = false; break; }
    } else {
      wl_display_cancel_read(L.anzeige);
    }
    if (wl_display_dispatch_pending(L.anzeige) < 0) { L.lauf = false; break; }

    if (los > 0 && (horchen[1].revents & (POLLIN | POLLHUP))) befehle_lesen();

    /* 2. Fertige Anforderungen einsammeln. */
    for (int k = 0; k < L.n_auftraege; k++) {
      struct Auftrag *a = &L.auftrag[k];
      if (!a->benutzt || (!a->fertig && !a->versagt)) continue;

      /* EINE Zahl, und das ist keine Bequemlichkeit.
         Versucht wurde, Warten und Herüberholen zu trennen: Zeitpunkt der
         Änderungsmeldung gegen Zeitpunkt des fertigen Bildes. Heraus kam
         "warten 52,2 ms · lesen 0,1 ms" — der Compositor schickt beide
         Ereignisse im selben Zug, und libwayland reicht sie in einem
         Durchgang weiter. Von außen ist da nichts zu trennen; die 0,1 ms
         waren der Abstand zweier Zeilen in derselben Zustellung, nicht die
         Dauer des Kopierens. Wer es erneut versucht, braucht eine Quelle im
         Compositor, nicht hier. */
      L.t_lesen += jetzt_ns() - a->gestellt_ns; L.n_lesen++;
      pthread_mutex_lock(&L.schloss);
      L.puffer[a->puffer].reserviert = false;
      if (a->fertig) L.puffer[a->puffer].voll = true;
      pthread_cond_broadcast(&L.wecker);
      pthread_mutex_unlock(&L.schloss);

      zwlr_screencopy_frame_v1_destroy(a->rahmen);
      a->rahmen = NULL; a->benutzt = false;
    }

    int64_t n = jetzt_ns();
    if (n - L.letzte_meldung_ns > 2000000000LL) {
      double s = (double)(n - L.letzte_meldung_ns) / 1e9;
      double nl = L.n_lesen ? (double)L.n_lesen : 1.0;
      double nk = L.n_kodiert ? (double)L.n_kodiert : 1.0;
      char zeile[200];
      snprintf(zeile, sizeof zeile,
               /* "abgriff" statt "lesen": die Zahl enthält die Wartezeit auf
                  eine Änderung am Schirm und ist im Leerlauf fast nur das.
                  Sie als Lesezeit zu lesen führt in die Irre — genau das ist
                  hier zweimal passiert. */
               "takt %.1f B/s  %.0f kbit/s   abgriff %.1f ms  "
               "Farbe %.1f ms  kodieren %.1f ms  verworfen %llu",
               (double)L.bilder / s, (double)L.bytes * 8.0 / s / 1000.0,
               (double)L.t_lesen / nl / 1e6, (double)L.t_farbe / nk / 1e6,
               (double)L.t_kodieren / nk / 1e6, (unsigned long long)L.verworfen);
      melden(zeile);
      L.bilder = L.bytes = L.verworfen = 0;
      L.t_lesen = L.t_farbe = L.t_kodieren = 0;
      L.n_lesen = L.n_kodiert = 0;
      L.letzte_meldung_ns = n;
    }
  }

  L.lauf = false;
  pthread_mutex_lock(&L.schloss);
  pthread_cond_broadcast(&L.wecker);
  pthread_mutex_unlock(&L.schloss);
  pthread_join(kodierer, NULL);

  if (L.x264) { x264_picture_clean(&L.bild_ein); x264_encoder_close(L.x264); }
  if (L.farbe) sws_freeContext(L.farbe);
  for (int i = 0; i < PUFFER_ANZAHL; i++) {
    if (L.puffer[i].wl) wl_buffer_destroy(L.puffer[i].wl);
    if (L.puffer[i].speicher) munmap(L.puffer[i].speicher, L.puffer[i].groesse);
  }
  eingabe_freigeben(L.eingabe);
  wl_display_disconnect(L.anzeige);
  return 0;
}
