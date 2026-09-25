// Browser-side AIS client.
//
// aisstream.io explicitly forbids connecting directly from a browser (no
// CORS/browser support — see https://aisstream.io/documentation: "you cannot
// connect directly from a browser due to CORS restrictions—you must connect
// through a backend server", and API keys must stay server-side). So this
// client never talks to wss://stream.aisstream.io itself; instead it opens a
// WebSocket to OUR proxy (see proxy/, a Cloudflare Worker) which holds the
// API key as a secret, subscribes to a bounding box around the Dannegracht,
// and relays the raw aisstream.io JSON messages through unmodified.
//
// The proxy URL is read from `import.meta.env.VITE_AIS_PROXY_URL`. When it
// is not configured, the client is intentionally inert and reports status
// 'disabled' — this is normal for local dev / anyone who hasn't deployed the
// proxy, not an error condition.
import type { Boat } from '../types';
import {
  applyAisMessage,
  parseAisRawMessage,
  pruneStaleTracks,
  trackToBoat,
  type AisTrack,
  STALE_AFTER_MS,
} from './aisMessages';

export type AisStatus = 'disabled' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export type AisListener = (boats: Boat[]) => void;
export type AisStatusListener = (status: AisStatus) => void;

export interface AisClientOptions {
  /** Proxy WebSocket URL, e.g. wss://ais-proxy.example.workers.dev/ais. Defaults to `import.meta.env.VITE_AIS_PROXY_URL`. */
  proxyUrl?: string;
  /** Drop boats not heard from for this long. Default 10 minutes. */
  staleAfterMs?: number;
  /** How often to re-derive and emit the boat list, ms. Default 2000. */
  emitIntervalMs?: number;
  /** Initial reconnect backoff, ms. Default 1000. */
  initialBackoffMs?: number;
  /** Maximum reconnect backoff, ms. Default 30000. */
  maxBackoffMs?: number;
  /** WebSocket constructor to use (for tests). Defaults to `globalThis.WebSocket`. */
  webSocketImpl?: typeof WebSocket;
  /** Clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

function readDefaultProxyUrl(): string | undefined {
  try {
    // import.meta.env is a Vite build-time construct; guarded for non-Vite
    // (e.g. plain Node/Vitest) environments where import.meta.env may be
    // absent or lack this key.
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return env?.VITE_AIS_PROXY_URL;
  } catch {
    return undefined;
  }
}

/**
 * Merges aisstream PositionReport/ShipStaticData (class A) and
 * StandardClassBPositionReport/StaticDataReport (class B) messages per MMSI
 * into `Boat` objects, drops boats not heard from in a while, and
 * reconnects with exponential backoff on drop/error.
 */
export class AisClient {
  private readonly proxyUrl: string | undefined;
  private readonly staleAfterMs: number;
  private readonly emitIntervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly WebSocketImpl: typeof WebSocket | undefined;
  private readonly now: () => number;

  private tracks = new Map<number, AisTrack>();
  private listeners = new Set<AisListener>();
  private statusListeners = new Set<AisStatusListener>();
  private socket: WebSocket | null = null;
  private status: AisStatus = 'disabled';
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private emitTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;

  constructor(options: AisClientOptions = {}) {
    this.proxyUrl = options.proxyUrl ?? readDefaultProxyUrl();
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
    this.emitIntervalMs = options.emitIntervalMs ?? 2000;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.backoffMs = this.initialBackoffMs;
    this.WebSocketImpl =
      options.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    this.now = options.now ?? (() => Date.now());
  }

  /** Start connecting (a no-op, staying 'disabled', if no proxy URL is configured). */
  start(): void {
    if (!this.proxyUrl) {
      this.setStatus('disabled');
      return;
    }
    this.closedByUser = false;
    this.connect();
    if (!this.emitTimer) {
      this.emitTimer = setInterval(() => this.emit(), this.emitIntervalMs);
    }
  }

  /** Stop and release resources. Safe to call multiple times. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.emitTimer) {
      clearInterval(this.emitTimer);
      this.emitTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus('closed');
  }

  subscribe(listener: AisListener): () => void {
    this.listeners.add(listener);
    listener(this.currentBoats());
    return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: AisStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): AisStatus {
    return this.status;
  }

  private connect(): void {
    if (!this.proxyUrl || !this.WebSocketImpl) {
      this.setStatus('disabled');
      return;
    }
    this.setStatus(
      this.status === 'closed' || this.status === 'disabled' ? 'connecting' : 'reconnecting',
    );
    let ws: WebSocket;
    try {
      ws = new this.WebSocketImpl(this.proxyUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      this.backoffMs = this.initialBackoffMs;
      this.setStatus('open');
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
    ws.onerror = () => {
      // onclose fires next; reconnect handled there.
    };
    ws.onclose = () => {
      this.socket = null;
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.setStatus('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const msg = parseAisRawMessage(parsed);
    if (!msg) return;
    const now = this.now();
    const mmsi = msg.MetaData.MMSI;
    const existing = this.tracks.get(mmsi);
    this.tracks.set(mmsi, applyAisMessage(existing, msg, now));
  }

  private currentBoats(): Boat[] {
    const now = this.now();
    this.tracks = pruneStaleTracks(this.tracks, now, this.staleAfterMs);
    const boats: Boat[] = [];
    for (const track of this.tracks.values()) {
      const boat = trackToBoat(track);
      if (boat) boats.push(boat);
    }
    return boats;
  }

  private emit(): void {
    const boats = this.currentBoats();
    for (const listener of this.listeners) listener(boats);
  }

  private setStatus(status: AisStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
