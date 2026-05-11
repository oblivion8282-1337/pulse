/**
 * Authenticated WebSocket singleton for the chat gateway.
 *
 * - Reconnects with backoff [1s, 2s, 5s, 10s, 30s, 30s...]
 * - Re-subscribes to remembered channels after reconnect
 * - Refreshes the access token before each connect attempt
 */

import { currentAccessToken } from '$lib/api/client';
import { isAccessExpired, loadTokens } from '$lib/api/storage';
import { messages } from '$lib/stores/messages.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { voicePresence, type VoiceChannelState } from '$lib/stores/voicePresence.svelte';
import type { Message } from '$lib/api/types';

export type ChannelPayload = {
  id: string;
  guild_id: string;
  name: string;
  type: number;
  position: number;
  topic: string | null;
  created_at: string;
};

type ServerEvent =
  | { op: 'ready'; user_id: string; guilds: { id: string; name: string }[]; voice_states?: VoiceChannelState[] }
  | { op: 'message'; data: Message }
  | { op: 'message_ack'; nonce: string | null; id: string }
  | { op: 'channel_deleted'; channel_id: string }
  | { op: 'channel_updated'; channel: ChannelPayload }
  | { op: 'voice_state'; channel_id: string; user_ids: string[] }
  | { op: 'error'; code: number; msg: string };

type ClientEvent =
  | { op: 'subscribe'; channel_id: string }
  | { op: 'unsubscribe'; channel_id: string }
  | { op: 'send'; channel_id: string; content: string; nonce: string };

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export type WsListener = (evt: ServerEvent) => void;

export class GatewayConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private subs = new Set<string>();
  private listeners = new Set<WsListener>();
  private wantConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsPath = '/api/ws/ws';
  private connectPromise: Promise<void> | null = null;

  on(listener: WsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.wantConnected = true;
    if (this.ws && this.ws.readyState <= 1) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._dial();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async _dial(): Promise<void> {
    if (!loadTokens()) return;
    // Force a refresh if expired.
    if (isAccessExpired(currentAccessToken() ?? '')) {
      // Trigger a refresh via the api client. Re-loading the token will
      // pick the new one up.
      const { request } = await import('$lib/api/client');
      try {
        await request<{ id: string }>('/me', { endpoint: 'auth' });
      } catch {
        return;
      }
    }
    const token = currentAccessToken();
    if (!token) return;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}${this.wsPath}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
        this.attempt = 0;
        // Restore subscriptions on reconnect.
        for (const cid of this.subs) {
          this._sendRaw({ op: 'subscribe', channel_id: cid });
        }
        resolve();
      });
      ws.addEventListener('message', (event) => {
        let evt: ServerEvent;
        try {
          evt = JSON.parse(event.data) as ServerEvent;
        } catch {
          return;
        }
        if (evt.op === 'ready') {
          if (evt.voice_states) voicePresence.seed(evt.voice_states);
        } else if (evt.op === 'message') {
          messages.upsert(evt.data);
        } else if (evt.op === 'channel_deleted') {
          guilds.removeChannel(evt.channel_id);
        } else if (evt.op === 'channel_updated') {
          guilds.updateChannel(evt.channel);
        } else if (evt.op === 'voice_state') {
          voicePresence.apply(evt.channel_id, evt.user_ids);
        }
        for (const l of this.listeners) l(evt);
      });
      ws.addEventListener('close', () => {
        this.ws = null;
        if (!opened) reject(new Error('ws closed before open'));
        if (this.wantConnected) this._scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        // Surface as close — browsers fire close right after.
      });
    });
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, wait);
  }

  disconnect(): void {
    this.wantConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subs.clear();
  }

  subscribe(channelId: string): void {
    this.subs.add(channelId);
    this._sendRaw({ op: 'subscribe', channel_id: channelId });
  }

  unsubscribe(channelId: string): void {
    this.subs.delete(channelId);
    this._sendRaw({ op: 'unsubscribe', channel_id: channelId });
  }

  /** Returns true when the frame was queued, false when the socket was not open. */
  send(channelId: string, content: string, nonce: string): boolean {
    return this._sendRaw({ op: 'send', channel_id: channelId, content, nonce });
  }

  private _sendRaw(evt: ClientEvent): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(evt));
      return true;
    }
    return false;
  }
}

export const gateway = new GatewayConnection();
