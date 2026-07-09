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

function netJson(
  method: string,
  url: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = net.request({ method, url, headers });
    const chunks: Buffer[] = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    if (body !== undefined) req.write(JSON.stringify(body));
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

    // 1. Aktive App-Host-Instanz des Users finden. NUR origin=app_host — das
    //    Pairing rotiert client_secret + Tunnel-Token und darf eine laufende
    //    VPS-Instanz desselben Users nie treffen.
    const list = await netJson('GET', `${cloudOrigin}/api/auth/me/instances`, cookie);
    if (list.status !== 200 || !Array.isArray(list.json)) {
      return { ok: false, error: `Instanzen nicht ladbar (HTTP ${list.status}). Eingeloggt + freigegeben?` };
    }
    const inst = (list.json as InstanceOut[]).find((i) => i.status === 'active' && i.origin === 'app_host');
    if (!inst) {
      return { ok: false, error: 'Keine aktive App-Host-Instanz. Beantrage App-Hosting-Freigabe in der Pulse-App.' };
    }

    // 2. Bootstrap-Token minten (Endpoint antwortet 201) + redeemen. reset=true
    //    ist der bewusste Recovery-Pfad des Backends: "Server einrichten" auf
    //    einem neuen/neu installierten Gerät übernimmt die Instanz und entwertet
    //    die Creds eines früheren Setups sofort — sonst 403 nach jedem ersten
    //    erfolgreichen Redeem.
    const mint = await netJson(
      'POST',
      `${cloudOrigin}/api/auth/me/instances/${inst.id}/bootstrap-token`,
      cookie,
      { reset: true },
    );
    if (mint.status !== 201 || !mint.json) {
      return { ok: false, error: `Bootstrap-Mint fehlgeschlagen (HTTP ${mint.status}).` };
    }
    const token = (mint.json as { token?: string }).token;
    if (!token) return { ok: false, error: 'Mint-Antwort ohne Token.' };

    return { ok: true, creds: await redeemBootstrap(token, cloudOrigin) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
