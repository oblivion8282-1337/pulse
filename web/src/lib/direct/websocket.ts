/**
 * WebSocket-Fassade über einen DataChannel.
 *
 * `gateway-connection.ts` spricht nur `addEventListener`/`send`/`close`/
 * `readyState` — genau das bildet diese Klasse nach, damit der Gateway-Code
 * nichts vom Direktpfad wissen muss. Der Adapter öffnet gegenüber ein echtes
 * Backend-WebSocket (`ws:<pfad>`) und reicht Frames 1:1 durch.
 *
 * Bewusst KEIN vollständiger WebSocket-Klon: Binary-Frames werden als
 * `ArrayBuffer` geliefert (`binaryType` ist fix), Extensions/Protocol sind leer.
 */

import type { DirectConnection } from './connection';

type Listener = (ev: never) => void;
type AnyListener = (ev: Event) => void;

export class DirectWebSocket implements Pick<WebSocket, 'send' | 'close' | 'readyState'> {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = DirectWebSocket.CONNECTING;
  private dc: RTCDataChannel;
  private listeners = new Map<string, Set<AnyListener>>();

  constructor(conn: DirectConnection, pathWithQuery: string) {
    this.dc = conn.openWebSocket(pathWithQuery);
    this.dc.binaryType = 'arraybuffer';

    this.dc.onopen = () => {
      this.readyState = DirectWebSocket.OPEN;
      this.emit(new Event('open'));
    };
    this.dc.onmessage = (e) => {
      this.emit(new MessageEvent('message', { data: e.data }));
    };
    this.dc.onerror = () => this.emit(new Event('error'));
    this.dc.onclose = () => {
      this.readyState = DirectWebSocket.CLOSED;
      // `wasClean` bleibt false: der DataChannel kennt keinen Close-Grund des
      // Backend-Sockets. Der Gateway reconnectet ohnehin bei jedem Close.
      this.emit(new CloseEvent('close', { code: 1006 }));
    };
  }

  // Überladungen wie beim echten WebSocket — der Gateway erwartet typisierte
  // `message`/`close`-Events (MessageEvent.data, CloseEvent.code).
  addEventListener(type: 'open', fn: (ev: Event) => void): void;
  addEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
  addEventListener(type: 'close', fn: (ev: CloseEvent) => void): void;
  addEventListener(type: 'error', fn: (ev: Event) => void): void;
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn as AnyListener);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn as AnyListener);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== DirectWebSocket.OPEN) return;
    this.dc.send(data as string);
  }

  /** `code`/`reason` nimmt der DataChannel nicht entgegen — Signatur nur der
   *  WebSocket-Kompatibilität wegen (Aufrufer schließen mit Close-Codes). */
  close(_code?: number, _reason?: string): void {
    if (this.readyState === DirectWebSocket.CLOSED) return;
    this.readyState = DirectWebSocket.CLOSING;
    try {
      this.dc.close();
    } catch {
      /* schon zu */
    }
  }

  private emit(ev: Event): void {
    for (const fn of this.listeners.get(ev.type) ?? []) fn(ev);
  }
}
