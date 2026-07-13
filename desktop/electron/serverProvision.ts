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
import { classifyMintStatus, redeemBootstrap, type BootstrapCreds } from './localBackend/pairing';

interface InstanceOut { id: string; status: string; origin?: string }

async function sessionCookie(cloudOrigin: string): Promise<string> {
  const cookies = await session.defaultSession.cookies.get({ name: 'pulse_session', url: cloudOrigin });
  return cookies.length ? `pulse_session=${cookies[0].value}` : '';
}

function netJsonOnce(
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wie `netJsonOnce`, wiederholt aber Transport-Fehler (Status 0 — kein HTTP
 *  gesprochen). Der erste HTTPS-Request der Flatpak-App scheitert reproduzierbar
 *  am TLS-Handshake (`ERR_SSL_PROTOCOL_ERROR`) und klappt beim Retry — sonst
 *  müsste der User "Server einrichten" zweimal klicken. Ein Retry des Mints ist
 *  unbedenklich: ein evtl. doch entstandener, uneingelöster Token wird vom
 *  nächsten Mint ohnehin gelöscht. */
async function netJson(
  method: string,
  url: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  let last = { status: 0, json: null as unknown };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(300 * attempt);
    last = await netJsonOnce(method, url, cookie, body);
    if (last.status !== 0) return last;
  }
  return last;
}

export type ProvisionResult =
  | { ok: true; creds: BootstrapCreds }
  | { ok: false; error: string; needsTakeoverConfirm?: boolean };

/** Findet die aktive Self-Host-Instanz des eingeloggten Users, mintet einen
 *  Bootstrap-Token und löst ihn ein. Setzt einen gültigen `pulse_session`-Cookie
 *  voraus (User muss in der Electron-Session eingeloggt sein).
 *
 *  Übernahme-Warnung: der Mint läuft zuerst OHNE reset — 403 heißt "Bootstrap
 *  wurde schon einmal eingelöst", also läuft vermutlich ein eingerichteter
 *  Server auf einem anderen Gerät. Statt ihn still zu entwerten (reset rotiert
 *  client_secret sofort) pausiert die Provisionierung mit
 *  `needsTakeoverConfirm` — erst der zweite Aufruf mit `confirmTakeover: true`
 *  mintet mit reset. */
export async function provision(
  cloudOrigin: string,
  opts: { confirmTakeover?: boolean } = {},
): Promise<ProvisionResult> {
  try {
    const cookie = await sessionCookie(cloudOrigin);
    if (!cookie) return { ok: false, error: 'Nicht eingeloggt — bitte zuerst einloggen.' };

    // 1. Aktive App-Host-Instanz des Users finden. NUR origin=app_host — das
    //    Pairing rotiert client_secret + Tunnel-Token und darf eine laufende
    //    VPS-Instanz desselben Users nie treffen.
    const list = await netJson('GET', `${cloudOrigin}/api/auth/me/instances`, cookie);
    if (list.status === 0) return { ok: false, error: 'Cloud nicht erreichbar — Internetverbindung?' };
    if (list.status !== 200 || !Array.isArray(list.json)) {
      return { ok: false, error: `Instanzen nicht ladbar (HTTP ${list.status}). Eingeloggt + freigegeben?` };
    }
    const inst = (list.json as InstanceOut[]).find((i) => i.status === 'active' && i.origin === 'app_host');
    if (!inst) {
      return { ok: false, error: 'Keine aktive App-Host-Instanz. Beantrage App-Hosting-Freigabe in der Pulse-App.' };
    }

    // 2. Bootstrap-Token minten (Endpoint antwortet 201) + redeemen. reset nur
    //    nach bestätigter Übernahme (s. Docstring) — der frühere Immer-reset-Pfad
    //    ließ ein bestehendes Gerät kommentarlos sterben.
    const reset = opts.confirmTakeover === true;
    const mint = await netJson(
      'POST',
      `${cloudOrigin}/api/auth/me/instances/${inst.id}/bootstrap-token`,
      cookie,
      { reset },
    );
    const verdict = classifyMintStatus(mint.status);
    if (verdict === 'consumed' && !reset) {
      return {
        ok: false,
        needsTakeoverConfirm: true,
        error: 'Instanz bereits eingerichtet — Übernahme muss bestätigt werden.',
      };
    }
    if (verdict !== 'ok' || !mint.json) {
      return { ok: false, error: `Bootstrap-Mint fehlgeschlagen (HTTP ${mint.status}).` };
    }
    const token = (mint.json as { token?: string }).token;
    if (!token) return { ok: false, error: 'Mint-Antwort ohne Token.' };

    return { ok: true, creds: await redeemBootstrap(token, cloudOrigin) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
