import { WS_PROTOCOL_VERSION, type ClientEvent, type ServerEvent } from '@stellium/shared';
import { token, wsUrl } from './api.js';
/* i18n/kern.js und nicht i18n/index.js: index.js hängt am Zustand
   (`useStore`), der Zustand bindet diesen Socket ein (state/store.ts:14) —
   ein Import von index.js liefe hier im Kreis. kern.js kennt den Zustand
   nicht und übersetzt trotzdem, nur ohne Anbindung an die eingestellte
   Oberflächensprache; siehe Kommentar bei `scheduleReconnect`. */
import { spracheDesSystems, translate } from '../i18n/kern.js';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';

type Listener = (ev: ServerEvent) => void;
type StateListener = (state: ConnectionState, detail?: string) => void;

/**
 * WebSocket mit automatischem Wiederverbinden. Nachrichten, die während einer
 * Unterbrechung entstehen, wandern in eine Warteschlange und gehen raus,
 * sobald die Verbindung wieder steht.
 */
/**
 * Kennungen, nach denen die Leitung nicht wieder aufgebaut wird.
 *
 * Der Server schickt Kennungen aus dem Wörterbuch der Oberfläche — dieselben,
 * die auch den übersetzten Text auswählen. Wer hier eine ändert, muss sie in
 * packages/server/src/ws/gateway.ts mitändern; scripts/e2e-fehlertexte.mjs
 * vergleicht beide Seiten und schlägt an, wenn eine Kennung ins Leere zeigt.
 */
const ABBRUCH_KENNUNGEN = new Set([
  'fehler.anmeldungAbgelaufen',   // Token abgelaufen oder gefälscht
  'fehler.protokollVeraltet',     // App zu alt für diesen Server
  'fehler.kontoInaktiv',          // Konto gesperrt oder gelöscht
  'fehler.kontoWeg',
]);

/**
 * Die eigene App-Fassung, einmal ermittelt und für jede (Wieder-)Verbindung
 * wiederverwendet — sie ändert sich ja nicht, während die App läuft, ein
 * zweiter IPC-Ruf bei jedem Reconnect wäre nur Ballast.
 *
 * In der App kommt sie von Electron selbst, über die vorhandene Brücke
 * window.stellium.info() (electron/main.ts, 'app:info' -> app.getVersion())
 * — dieselbe Fassung, mit der electron/updater.ts schon heute seine eigene
 * Prüfung fährt, keine zweite eigene Quelle. Im bloßen Browser gibt es diese
 * Brücke nicht; dort steht die Fassung stattdessen zur Bauzeit fest
 * (__APP_VERSION__, siehe vite.config.ts) — aus derselben
 * packages/desktop/package.json, aus der auch electron-builder die
 * App-Version zieht, kann also nicht auseinanderlaufen. Derselbe Rückfall
 * greift, falls die Brücke aus irgendeinem Grund nicht antwortet.
 */
let eigeneVersion: Promise<string> | null = null;
function appVersion(): Promise<string> {
  if (!eigeneVersion) {
    /* Nicht nur prüfen, OB eine Brücke da ist, sondern ob sie info() auch
       WIRKLICH kann: ein Prüfstand (oder ein altes Installationsstand) stellt
       window.stellium bereit, aber ohne jede Methode — der Aufruf würde SYNCHRON
       werfen, und das .catch() darunter fängt synchronen Unfall nicht. */
    const bruecke = window.stellium as { info?: () => Promise<{ version: string }> } | undefined;
    /* typeof statt bloßem Zugriff: außerhalb eines echten Baus (in
       Prüfständen) existiert die Bauzeit-Konstante gar nicht — ein direkter
       Zugriff wäre dort ein ReferenceError. */
    const bauzeit = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
    eigeneVersion = typeof bruecke?.info === 'function'
      ? bruecke.info().then((i) => i.version).catch(() => bauzeit)
      : Promise.resolve(bauzeit);
  }
  return eigeneVersion;
}

class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private outbox: ClientEvent[] = [];
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;
  /** Warum die Verbindung endgültig scheiterte — entscheidet über das Abmelden. */
  failCode: string | null = null;
  private authed = false;

  state: ConnectionState = 'idle';

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    for (const fn of this.stateListeners) fn(state, detail);
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const t = token();
    if (!t) return;

    this.closedByUs = false;
    this.authed = false;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      /* platform ist sofort da (window.stellium?.platform, siehe preload.ts
         — dieselbe Stelle, die main.tsx schon für dataset.platform nutzt),
         appVersion erst nach einem IPC-Ruf (memoisiert, siehe oben) — beides
         optional, ein alter Server kennt die Felder ohnehin nicht (siehe
         protocol.ts). */
      const platform = window.stellium?.platform ?? 'browser';
      void appVersion().then((version) => {
        // Die Leitung kann in der Zwischenzeit schon wieder zu sein (sehr
        // kurzes Fenster, aber ws.send() auf einer geschlossenen Leitung
        // wirft) — dann übernimmt ohnehin der nächste Verbindungsversuch.
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          t: 'auth', token: t, protocol: WS_PROTOCOL_VERSION, appVersion: version, platform,
        } satisfies ClientEvent));
      });
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let ev: ServerEvent;
      try { ev = JSON.parse(e.data as string); } catch { return; }

      if (ev.t === 'ready' && !this.authed) {
        this.authed = true;
        this.attempt = 0;
        this.setState('open');
        this.flush();
        this.startPing();
      }
      if (ev.t === 'error' && ev.code !== undefined && ABBRUCH_KENNUNGEN.has(ev.code)) {
        this.closedByUs = true;   // kein Reconnect-Sturm bei kaputtem Token
        // Der Grund muss mit: bei 'protocol_mismatch' ist das Token in Ordnung,
        // nur die App zu alt. Wer dabei abmeldet, schickt in eine Schleife —
        // die neue Anmeldung scheitert am selben Protokoll.
        this.failCode = ev.code;
        this.setState('failed', ev.message);
      }
      for (const fn of this.listeners) fn(ev);
    };

    ws.onclose = () => {
      /* Eine abgelöste Leitung meldet ihr `close` erst, wenn der Abbau durch
         ist — nach disconnect() und einem schnellen connect() (Abmelden,
         gleich wieder Anmelden) steht in this.ws dann schon die NEUE. Ohne
         diese Abfrage nullte das späte `close` sie aus, hielte ihren Ping an
         und plante einen Wiederaufbau, der neben der noch offenen neuen eine
         zweite Leitung aufmacht — jedes Ereignis käme danach doppelt. */
      if (this.ws !== ws) return;
      this.stopPing();
      this.ws = null;
      if (this.closedByUs) { this.setState('idle'); return; }
      this.scheduleReconnect();
    };

    ws.onerror = () => { /* onclose folgt und übernimmt */ };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.attempt++;
    // 0.8s, 1.6s, 3.2s … maximal 20s, plus Jitter gegen Thundering Herd
    const wait = Math.min(20_000, 800 * 2 ** Math.min(this.attempt - 1, 5)) + Math.random() * 400;
    // Übersetzt statt Rohtext: sonst stand hier "Neuer Versuch in 3s" auch in
    // englischer, japanischer, arabischer … Oberfläche — App.tsx:190 hängt
    // dieses Stück nur unverändert hinter t('conn.connecting') an. Sprache
    // kommt aus spracheDesSystems() statt der eingestellten Oberflächensprache
    // (siehe Importkommentar oben); das teilt sich diese Stelle mit
    // net/api.ts und lib/vertraulich.ts.
    const sekunden = Math.round(wait / 1000);
    this.setState('reconnecting', translate(spracheDesSystems(), 'conn.retryIn', { sekunden }));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ t: 'ping', ts: Date.now() });
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private flush(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const ev of queued) this.send(ev);
  }

  /** true = sofort gesendet, false = zwischengespeichert. */
  send(ev: ClientEvent): boolean {
    if (this.ws?.readyState === WebSocket.OPEN && this.authed) {
      this.ws.send(JSON.stringify(ev));
      return true;
    }
    // Nur Dinge puffern, die später noch Sinn ergeben.
    const queueable = new Set([
      'message:send', 'message:edit', 'message:delete', 'message:react', 'read', 'prefs:update',
      /* Beide hängen an einer schon verschickten Nachricht: bricht die Leitung
         genau in dem Moment ab, in dem ein fertiger (oder gescheiterter)
         Bildupload das melden will, ist die Nachricht trotzdem längst da —
         nur der Nachtrag fehlt noch. Ohne die Warteschlange bliebe der Anhang
         für immer unangehängt, oder der Platzhalter für immer stehen. */
      'message:attach', 'message:attachGiveUp',
    ]);
    if (queueable.has(ev.t)) {
      this.outbox.push(ev);
      if (this.outbox.length > 200) this.outbox.shift();
    }
    return false;
  }

  get queuedCount(): number { return this.outbox.length; }

  /**
   * Eine noch nicht verschickte `message:send` in der Warteschlange
   * nachträglich ändern.
   *
   * Ein Anhang kann fertig werden — oder endgültig aufgeben werden —,
   * während seine Nachricht offline noch in der Warteschlange steht (siehe
   * Composer.tsx, `aufgeben()` und `einzeln()`). Ohne diese Stelle ginge
   * beim nächsten `flush()` ein Platzhalter für eine Datei hinaus, die es
   * entweder nie geben wird oder die längst eine echte Kennung hat — und
   * niemand könnte das je nachtragen, denn das Zeitfenster dafür
   * (`kennungAbwarten`, 60 s) ist zu dem Zeitpunkt schon abgelaufen.
   *
   * Gibt zurück, ob die Nachricht überhaupt noch in der Warteschlange stand
   * — war sie längst hinaus, gibt es hier nichts mehr zu tun, und der
   * Aufrufer muss den regulären Weg über eine Nachricht-Kennung gehen.
   */
  patchQueuedMessage(
    clientId: string,
    patch: (ev: Extract<ClientEvent, { t: 'message:send' }>) => void,
  ): boolean {
    const ev = this.outbox.find(
      (e): e is Extract<ClientEvent, { t: 'message:send' }> => e.t === 'message:send' && e.clientId === clientId,
    );
    if (!ev) return false;
    patch(ev);
    return true;
  }

  /** Nach dem Aufwachen aus dem Ruhezustand sofort neu verbinden. */
  wake(): void {
    if (this.state === 'open' || this.closedByUs) return;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.attempt = 0;
    this.connect();
  }

  disconnect(): void {
    this.closedByUs = true;
    this.stopPing();
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.outbox = [];
    this.attempt = 0;
    this.ws?.close();
    this.ws = null;
    this.authed = false;
    this.setState('idle');
  }
}

export const socket = new Socket();

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => socket.wake());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') socket.wake();
  });
}
