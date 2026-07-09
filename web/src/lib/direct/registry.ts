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

const AUTH_BASE = '/api/auth';
const RETRY_AFTER_MS = 60_000;
const PIN_PREFIX = 'pulse.direct.pin.';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

interface DirectoryEntry {
  candidates: { ip: string; port: number; protocol: string }[];
  fingerprint: string;
  online: boolean;
}

type State =
  | { kind: 'idle' }
  | { kind: 'connecting'; promise: Promise<DirectConnection | null> }
  | { kind: 'open'; conn: DirectConnection }
  | { kind: 'failed'; until: number };

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
  const r = await fetch(`${AUTH_BASE}/me/instances/${instanceId}/direct-endpoint`, {
    credentials: 'include',
  });
  if (!r.ok) return null;
  const entry = (await r.json()) as DirectoryEntry;
  return entry.online ? entry : null;
}

async function postOffer(instanceId: string, sdp: string): Promise<string> {
  const r = await fetch(`${AUTH_BASE}/me/instances/${instanceId}/direct-offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ sdp }),
  });
  if (!r.ok) throw new Error(`offer rejected (HTTP ${r.status})`);
  return ((await r.json()) as { sdp: string }).sdp;
}

async function dial(instanceId: string): Promise<DirectConnection | null> {
  const entry = await lookup(instanceId);
  if (!entry) return null;

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
  return conn;
}

/**
 * Liefert die offene Direktverbindung — oder `null`, wenn es (noch) keine gibt.
 * Nie werfend: Aufrufer fallen auf den Relay zurück. Ausnahme ist der
 * Fingerprint-Konflikt, der bewusst als Fehlschlag gemerkt wird.
 */
export async function getDirectConnection(
  instanceId: string | null,
): Promise<DirectConnection | null> {
  if (!instanceId || typeof RTCPeerConnection === 'undefined') return null;

  const state = states.get(instanceId) ?? { kind: 'idle' };
  if (state.kind === 'open') {
    if (state.conn.isOpen) return state.conn;
    states.delete(instanceId);
  } else if (state.kind === 'connecting') {
    return state.promise;
  } else if (state.kind === 'failed' && Date.now() < state.until) {
    return null;
  }

  const promise = dial(instanceId)
    .then((conn) => {
      if (!conn) {
        states.set(instanceId, { kind: 'failed', until: Date.now() + RETRY_AFTER_MS });
        return null;
      }
      conn.onClose(() => states.delete(instanceId));
      states.set(instanceId, { kind: 'open', conn });
      return conn;
    })
    .catch((e) => {
      states.set(instanceId, { kind: 'failed', until: Date.now() + RETRY_AFTER_MS });
      if (e instanceof DirectFingerprintMismatch) console.warn('[direct] Fingerprint-Konflikt');
      return null;
    });

  states.set(instanceId, { kind: 'connecting', promise });
  return promise;
}

/** Test-/Logout-Hilfe: alle Verbindungen schließen. */
export function closeAllDirect(): void {
  for (const state of states.values()) {
    if (state.kind === 'open') state.conn.close();
  }
  states.clear();
}
