/**
 * Verbindungs-Registry des Direktpfads: pro Self-Host-Server höchstens eine
 * WebRTC-Verbindung, geteilt von allen Requests und WebSockets.
 *
 * Der Aufbau läuft **einmalig** und still im Hintergrund: schlägt er fehl
 * (Instanz offline, CGNAT beidseitig, Fingerprint-Abweichung), bleibt der
 * Server über den Relay erreichbar — der Direktpfad ist eine Optimierung,
 * kein Muss. Ein Fehlschlag wird für `RETRY_AFTER_MS` gemerkt, damit nicht
 * jeder Request eine neue Verbindungszeremonie auslöst.
 *
 * **TOFU-Pinning**: Der Fingerprint aus dem Telefonbuch wird beim ersten
 * erfolgreichen Kontakt in `localStorage` festgeschrieben. Weicht die Cloud
 * später ab (böswilliges Telefonbuch), scheitert der Aufbau hart statt still
 * auf einen fremden Server zu zeigen.
 */

import { DirectConnection, DirectFingerprintMismatch } from './connection';
import type { DirectFailureReason } from './policy';
import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';

/**
 * Telefonbuch + Offer-Signaling leben ausschließlich in der Cloud (die
 * Server-Container heartbeaten dorthin), daher IMMER die Cloud-Basis — nicht
 * `/api/auth` relativ zum eigenen Ursprung: Auf einem Self-Host-Origin wäre
 * das der lokale auth-Dienst, der keinen Telefonbuch-Eintrag kennt (404 →
 * Direktpfad still tot, siehe DirectPathCorsMiddleware im auth-svc).
 */
const CLOUD_AUTH_BASE = `${CLOUD_HOSTNAME}/api/auth`;
const RETRY_AFTER_MS = 60_000;
const PIN_PREFIX = 'pulse.direct.pin.';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

interface DirectoryEntry {
  candidates: { ip: string; port: number; protocol: string }[];
  fingerprint: string;
  online: boolean;
}

export type DirectDialResult =
  | { ok: true; conn: DirectConnection }
  | { ok: false; reason: DirectFailureReason };

type State =
  | { kind: 'idle' }
  | { kind: 'connecting'; promise: Promise<DirectDialResult> }
  | { kind: 'open'; conn: DirectConnection }
  | { kind: 'failed'; until: number; reason: DirectFailureReason };

const states = new Map<string, State>();

function pinKey(instanceId: string): string {
  return `${PIN_PREFIX}${instanceId}`;
}

function readPin(instanceId: string): string | null {
  try {
    return localStorage.getItem(pinKey(instanceId));
  } catch {
    return null;
  }
}

function writePin(instanceId: string, fingerprint: string): void {
  try {
    localStorage.setItem(pinKey(instanceId), fingerprint);
  } catch {
    /* Quota/Private-Browsing: Pinning entfällt, Verbindung bleibt gültig */
  }
}

/** Vergisst das Pinning — nötig, wenn der Besitzer den Server neu einrichtet
 *  (frisches Zertifikat) und der Nutzer das bewusst bestätigt hat. */
export function forgetPin(instanceId: string): void {
  try {
    localStorage.removeItem(pinKey(instanceId));
  } catch {
    /* egal */
  }
  states.delete(instanceId);
}

async function lookup(instanceId: string): Promise<DirectoryEntry | null> {
  const r = await fetch(`${CLOUD_AUTH_BASE}/me/instances/${instanceId}/direct-endpoint`, {
    credentials: 'include',
  });
  if (!r.ok) return null;
  const entry = (await r.json()) as DirectoryEntry;
  return entry.online ? entry : null;
}

async function postOffer(instanceId: string, sdp: string): Promise<string> {
  const r = await fetch(`${CLOUD_AUTH_BASE}/me/instances/${instanceId}/direct-offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ sdp }),
  });
  if (!r.ok) throw new Error(`offer rejected (HTTP ${r.status})`);
  return ((await r.json()) as { sdp: string }).sdp;
}

async function dial(instanceId: string): Promise<DirectDialResult> {
  const entry = await lookup(instanceId);
  // Telefonbuch kennt keinen (aktuellen) Eintrag / meldet offline.
  if (!entry) return { ok: false, reason: 'offline' };

  const pinned = readPin(instanceId);
  if (pinned && pinned !== entry.fingerprint.toUpperCase()) {
    // Das Telefonbuch nennt eine andere Identität als beim letzten Mal.
    throw new DirectFingerprintMismatch();
  }

  const conn = await DirectConnection.open({
    postOffer: (sdp) => postOffer(instanceId, sdp),
    expectedFingerprint: entry.fingerprint,
    iceServers: ICE_SERVERS,
  });
  writePin(instanceId, entry.fingerprint.toUpperCase());
  return { ok: true, conn };
}

/**
 * Wie `getDirectConnection`, aber mit unterscheidbarem Fehlgrund — die
 * Direct-only-Weiche (App-Host ohne Relay-Fallback) braucht die Trennung
 * offline / ICE-Fehlschlag / Fingerprint-Konflikt für die erklärten
 * Fehlerzustände. Nie werfend.
 */
export async function getDirectConnectionDetailed(
  instanceId: string | null,
): Promise<DirectDialResult> {
  if (!instanceId || typeof RTCPeerConnection === 'undefined') {
    return { ok: false, reason: 'ice-failed' };
  }

  const state = states.get(instanceId) ?? { kind: 'idle' };
  if (state.kind === 'open') {
    if (state.conn.isOpen) return { ok: true, conn: state.conn };
    states.delete(instanceId);
  } else if (state.kind === 'connecting') {
    return state.promise;
  } else if (state.kind === 'failed' && Date.now() < state.until) {
    return { ok: false, reason: state.reason };
  }

  const promise = dial(instanceId)
    .then((result): DirectDialResult => {
      if (!result.ok) {
        states.set(instanceId, {
          kind: 'failed',
          until: Date.now() + RETRY_AFTER_MS,
          reason: result.reason,
        });
        return result;
      }
      result.conn.onClose(() => states.delete(instanceId));
      states.set(instanceId, { kind: 'open', conn: result.conn });
      return result;
    })
    .catch((e): DirectDialResult => {
      const reason: DirectFailureReason =
        e instanceof DirectFingerprintMismatch ? 'fingerprint-mismatch' : 'ice-failed';
      states.set(instanceId, { kind: 'failed', until: Date.now() + RETRY_AFTER_MS, reason });
      return { ok: false, reason };
    });

  states.set(instanceId, { kind: 'connecting', promise });
  return promise;
}

/**
 * Liefert die offene Direktverbindung — oder `null`, wenn es (noch) keine
 * gibt. Nie werfend: VPS-Aufrufer fallen auf ihren Hostname zurück.
 */
export async function getDirectConnection(
  instanceId: string | null,
): Promise<DirectConnection | null> {
  const result = await getDirectConnectionDetailed(instanceId);
  return result.ok ? result.conn : null;
}
