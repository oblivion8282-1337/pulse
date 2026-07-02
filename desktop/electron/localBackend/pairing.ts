/**
 * Cloud-Bootstrap-Redeem + Creds-Mapper + Store-I/O.
 *
 * Redeems a one-time bootstrap token issued by the cloud (POST /api/auth/selfhost/bootstrap)
 * and maps the snake_case response into typed camelCase BootstrapCreds.
 * Provides sanitized status (no secrets) and a simple Store-I/O interface;
 * der ContainerBackendManager konsumiert die Creds direkt.
 *
 * No Electron imports — safe for node:test.
 * Never logs. Secrets (clientSecret, relayTunnelToken) never appear in sanitize().
 */

export interface BootstrapCreds {
  instanceId: string;
  ownerId: string;
  hostname: string;
  clientId: string;
  clientSecret: string;
  cloudOrigin: string;
  relaySubdomain: string | null;
  relayServerAddr: string | null;
  relayTunnelToken: string | null;
}

export interface PairingStatus {
  paired: boolean;
  hostname?: string;
  instanceId?: string;
  relaySubdomain?: string | null;
}

export interface PairResult {
  paired: boolean;
  error?: string;
  status?: PairingStatus;
}

export interface StoreLike {
  get(k: string): unknown;
  set(k: string, v: unknown): void;
}

export const HOST_CREDS_KEY = 'pulse.host.creds';

export async function redeemBootstrap(
  token: string,
  cloudOrigin: string,
  fetchImpl?: typeof fetch,
): Promise<BootstrapCreds> {
  const fn = fetchImpl ?? fetch;
  const resp = await fn(`${cloudOrigin}/api/auth/selfhost/bootstrap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  if (!resp.ok) {
    let detail: string | undefined;
    try {
      detail = (JSON.parse(text) as { detail?: string }).detail;
    } catch {
      // ignore parse errors
    }
    throw new Error(detail ?? String(resp.status));
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  return {
    instanceId: String(body.instance_id ?? ''),
    ownerId: String(body.owner_user_id ?? ''),
    hostname: String(body.hostname ?? ''),
    clientId: String(body.client_id ?? ''),
    clientSecret: String(body.client_secret ?? ''),
    cloudOrigin,
    relaySubdomain: body.relay_subdomain != null ? String(body.relay_subdomain) : null,
    relayServerAddr: body.relay_server_addr != null ? String(body.relay_server_addr) : null,
    relayTunnelToken: body.relay_tunnel_token != null ? String(body.relay_tunnel_token) : null,
  };
}

export function probeUrl(c: BootstrapCreds): string {
  return `${c.cloudOrigin}/api/auth/selfhost/reachability/probe`;
}

export function sanitize(c: BootstrapCreds | null): PairingStatus {
  if (c === null) return { paired: false };
  return { paired: true, hostname: c.hostname, instanceId: c.instanceId, relaySubdomain: c.relaySubdomain };
}

export function loadCreds(store: StoreLike): BootstrapCreds | null {
  const raw = store.get(HOST_CREDS_KEY);
  if (raw == null || typeof raw !== 'object') return null;
  return raw as BootstrapCreds;
}

export function saveCreds(store: StoreLike, c: BootstrapCreds): void {
  store.set(HOST_CREDS_KEY, c);
}

export function clearCreds(store: StoreLike): void {
  store.set(HOST_CREDS_KEY, undefined);
}
