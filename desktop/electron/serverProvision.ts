// serverProvision.ts — Login-basierte Auto-Provision der Server-App.
//
// Nach dem Pulse-Login (howispulse.com in der Electron-Session) nutzt dies den
// `pulse_session`-Cookie, um die aktive Self-Host-Instanz des Users zu finden,
// einen Bootstrap-Token zu minten und ihn gegen Pairing-Creds einzulösen.
// Kein manuelles Token-Einfügen nötig — "einloggen, dann starten".
//
// Der Cookie wird explizit als Header gesetzt (SameSite=strict würde sonst bei
// `net`-Requests u.U. nicht mitgehen). `net` nutzt die Default-Session, in der
// auch der howispulse.com-Login stattfand → Cookie ist dort gespeichert.
import { net, session } from 'electron';
import { redeemBootstrap, type BootstrapCreds } from './localBackend/pairing';

interface InstanceOut { id: string; status: string; origin?: string }

async function sessionCookie(cloudOrigin: string): Promise<string> {
  const cookies = await session.defaultSession.cookies.get({ name: 'pulse_session', url: cloudOrigin });
  return cookies.length ? `pulse_session=${cookies[0].value}` : '';
}

function netJson(method: string, url: string, cookie: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve) => {
    const req = net.request({ method, url, headers: cookie ? { Cookie: cookie } : {} });
    const chunks: Buffer[] = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = body ? JSON.parse(body) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.end();
  });
}

export type ProvisionResult = { ok: true; creds: BootstrapCreds } | { ok: false; error: string };

/** Findet die aktive Self-Host-Instanz des eingeloggten Users, mintet einen
 *  Bootstrap-Token und löst ihn ein. Setzt einen gültigen `pulse_session`-Cookie
 *  voraus (User muss in der Electron-Session eingeloggt sein). */
export async function provision(cloudOrigin: string): Promise<ProvisionResult> {
  try {
    const cookie = await sessionCookie(cloudOrigin);
    if (!cookie) return { ok: false, error: 'Nicht eingeloggt — bitte zuerst einloggen.' };

    // 1. Aktive Self-Host-Instanz des Users finden (Cloud-Origin ausgeschlossen).
    const list = await netJson('GET', `${cloudOrigin}/api/auth/me/instances`, cookie);
    if (list.status !== 200 || !Array.isArray(list.json)) {
      return { ok: false, error: `Instanzen nicht ladbar (HTTP ${list.status}). Eingeloggt + freigegeben?` };
    }
    const inst = (list.json as InstanceOut[]).find((i) => i.status === 'active' && i.origin !== 'cloud');
    if (!inst) {
      return { ok: false, error: 'Keine aktive Self-Host-Instanz. Beantrage Hosting-Freigabe in der Pulse-App.' };
    }

    // 2. Einmaligen Bootstrap-Token minten + redeemen.
    const mint = await netJson('POST', `${cloudOrigin}/api/auth/me/instances/${inst.id}/bootstrap-token`, cookie);
    if (mint.status !== 200 || !mint.json) {
      return { ok: false, error: `Bootstrap-Mint fehlgeschlagen (HTTP ${mint.status}).` };
    }
    const token = (mint.json as { token?: string }).token;
    if (!token) return { ok: false, error: 'Mint-Antwort ohne Token.' };

    return { ok: true, creds: await redeemBootstrap(token, cloudOrigin) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
