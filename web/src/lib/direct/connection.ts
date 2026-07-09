/**
 * Eine direkte WebRTC-Verbindung zu einer Server-App.
 *
 * Ablauf: Offer bauen → über die Cloud durchreichen (`POST
 * /me/instances/{id}/direct-offer`) → Answer setzen → DataChannel `http` steht.
 * Ab da läuft **jeder** Request und WebSocket durch diesen Kanal; die Cloud ist
 * raus. Fingerprint der Answer wird gegen den Telefonbuch-Wert geprüft und
 * dann gepinnt (TOFU) — eine spätere Abweichung bricht die Verbindung ab.
 *
 * Plan: docs/plans/2026-07-09-direct-path-webrtc.md
 */

import {
  b64ToBytes,
  bytesToB64,
  sdpFingerprint,
  type FrameFromAdapter,
  type ReqFrame,
} from './protocol';

const CONNECT_TIMEOUT_MS = 8000;
/** Kandidaten trudeln manchmal ewig ein (TURN-Timeouts) — nach dieser Frist
 *  brechen wir das ICE-Gathering ab und schicken das Offer mit dem Bisherigen. */
const ICE_GATHERING_TIMEOUT_MS = 3000;
/** Base64 bläht ~4/3 auf; 48 KiB roh bleibt sicher unter dem SCTP-Limit. */
const BODY_CHUNK_BYTES = 48 * 1024;

export class DirectFingerprintMismatch extends Error {
  constructor() {
    super('direct-path fingerprint mismatch');
    this.name = 'DirectFingerprintMismatch';
  }
}

interface PendingResponse {
  status: number;
  headers: [string, string][];
  chunks: Uint8Array[];
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
}

export class DirectConnection {
  private pc: RTCPeerConnection;
  private http: RTCDataChannel;
  private pending = new Map<number, PendingResponse>();
  private nextId = 1;
  private closed = false;
  private onClosed?: () => void;

  private constructor(pc: RTCPeerConnection, http: RTCDataChannel) {
    this.pc = pc;
    this.http = http;
    this.http.onmessage = (e) => this.onFrame(e.data as string);
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') this.close();
    };
  }

  /** Baut die Verbindung auf. `postOffer` reicht das SDP über die Cloud durch. */
  static async open(args: {
    postOffer: (sdp: string) => Promise<string>;
    expectedFingerprint: string;
    iceServers: RTCIceServer[];
  }): Promise<DirectConnection> {
    const pc = new RTCPeerConnection({ iceServers: args.iceServers });
    const http = pc.createDataChannel('http');
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await gatheringComplete(pc);

      const answerSdp = await args.postOffer(pc.localDescription!.sdp);
      const fp = sdpFingerprint(answerSdp);
      if (!fp || fp !== args.expectedFingerprint.toUpperCase()) {
        throw new DirectFingerprintMismatch();
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      await channelOpen(http);
      return new DirectConnection(pc, http);
    } catch (e) {
      pc.close();
      throw e;
    }
  }

  get isOpen(): boolean {
    return !this.closed && this.http.readyState === 'open';
  }

  onClose(fn: () => void): void {
    this.onClosed = fn;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('direct connection closed'));
    this.pending.clear();
    try {
      this.pc.close();
    } catch {
      /* schon zu */
    }
    this.onClosed?.();
  }

  /** Ein HTTP-Request durch den DataChannel. Antwort als echtes `Response`. */
  async fetch(path: string, init: RequestInit): Promise<Response> {
    if (!this.isOpen) throw new Error('direct connection not open');
    const id = this.nextId++;
    const body = await bodyBytes(init.body);
    const headers = headerPairs(init.headers);

    const req: ReqFrame = {
      t: 'req',
      id,
      method: (init.method ?? 'GET').toUpperCase(),
      path,
      headers,
      fin: body.length === 0,
    };
    const done = new Promise<Response>((resolve, reject) => {
      this.pending.set(id, { status: 0, headers: [], chunks: [], resolve, reject });
    });
    this.http.send(JSON.stringify(req));
    for (let sent = 0; sent < body.length; sent += BODY_CHUNK_BYTES) {
      const end = Math.min(sent + BODY_CHUNK_BYTES, body.length);
      this.http.send(
        JSON.stringify({
          t: 'body',
          id,
          b64: bytesToB64(body.subarray(sent, end)),
          fin: end === body.length,
        }),
      );
    }
    return done;
  }

  /** Öffnet einen Backend-WebSocket über einen eigenen DataChannel. */
  openWebSocket(pathWithQuery: string): RTCDataChannel {
    return this.pc.createDataChannel(`ws:${pathWithQuery}`);
  }

  private onFrame(raw: string): void {
    let frame: FrameFromAdapter;
    try {
      frame = JSON.parse(raw) as FrameFromAdapter;
    } catch {
      return;
    }
    const p = this.pending.get(frame.id);
    if (!p) return;

    if (frame.t === 'err') {
      this.pending.delete(frame.id);
      p.reject(new Error(frame.message));
      return;
    }
    if (frame.t === 'res') {
      p.status = frame.status;
      p.headers = frame.headers;
      if (frame.fin) this.finish(frame.id, p);
      return;
    }
    p.chunks.push(b64ToBytes(frame.b64));
    if (frame.fin) this.finish(frame.id, p);
  }

  private finish(id: number, p: PendingResponse): void {
    this.pending.delete(id);
    // 204/304 dürfen keinen Body tragen — `new Response(body)` wirft sonst.
    const empty = p.status === 204 || p.status === 304;
    const blob = empty ? null : new Blob(p.chunks as BlobPart[]);
    p.resolve(new Response(blob, { status: p.status, headers: p.headers }));
  }
}

function gatheringComplete(pc: RTCPeerConnection): Promise<void> {
  // Non-Trickle: der Adapter antwortet ebenfalls erst nach vollem Gathering.
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') done();
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
  });
}

function channelOpen(dc: RTCDataChannel): Promise<void> {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('data channel timeout')), CONNECT_TIMEOUT_MS);
    dc.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    dc.onerror = () => {
      clearTimeout(timer);
      reject(new Error('data channel error'));
    };
  });
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  // FormData/URLSearchParams/ReadableStream → über Request normalisieren.
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function headerPairs(headers: HeadersInit | undefined): [string, string][] {
  if (!headers) return [];
  const h = new Headers(headers);
  return [...h.entries()] as [string, string][];
}
