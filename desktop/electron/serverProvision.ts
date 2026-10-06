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
import { aktiveAppHostInstanz, bewerteAnlage } from './serverAnlage';
import { classifyDeleteStatus, type CloudDeleteVerdict } from './serverGiveUp';
import { classifyCloudStatus } from './serverCloudStatus';
import { pulseSessionAusSetCookie } from './serverSession';

interface InstanceOut { id: string; status: string; origin?: string }

/** Mint-Rückruf: main setzt ihn, damit der über den pulse_rt-Cookie gemintete
 *  Access-Token dauerhaft im Store landet (cross-Modul ohne Store-Import). */
let onMintedTokens: ((origin: string, tokens: { accessToken: string; refreshToken: string }) => void) | null = null;
export function setzeMintRueckruf(cb: (typeof onMintedTokens)): void {
  onMintedTokens = cb;
}

async function sessionCookie(cloudOrigin: string): Promise<string> {
  const cookies = await session.defaultSession.cookies.get({ name: 'pulse_session', url: cloudOrigin });
  return cookies.length ? `pulse_session=${cookies[0].value}` : '';
}

// Bughunt Runde 17: Chromium timeoutet einen Socket, der annimmt und dann
// schweigt/tröpfelt, NIE — ohne Frist hing "Server einrichten" für immer
// (Spinner, kein Fehlerpfad). 30 s decken selbst zähe Cloud-Runden.
const NET_FRIST_MS = 30_000;

/** POST /session/renew mit dem durablen Bearer-Token → die Cloud mintet einen
 *  frischen 30-Min-`pulse_session`-Cookie. Die Instanz-Endpoints sind
 *  cookie-only (`_require_user` in routes_instance_applications.py — kein
 *  Bearer-Pfad), deshalb prägen wir den Cookie neu, statt den Bearer direkt zu
 *  schicken.
 *
 *  Bughunt 2026-10-03: `net` läuft mit Electron-Default
 *  `useSessionCookies: false` — es sendet also KEIN Jar-Cookie mit (gut! Der
 *  Renew muss eine dem Browser bekannte Session nie weg-rotieren: genau das
 *  passierte beim Boot-Renew der Web-App und hinterließ ein revoktes Cookie im
 *  Jar), speichert aber AUCH das Set-Cookie der Antwort nicht selbst. Deshalb
 *  wird der neue Wert aus den Response-Headern gelesen und explizit per
 *  session.cookies.set() ins Jar gelegt — der frühere Glaube, das Set-Cookie
 *  „landet automatisch im net-Cookie-Jar", galt nicht für diesen Weg. */
function renewSessionCookie(cloudOrigin: string, bearer: string): Promise<void> {
  return new Promise((resolve) => {
    const req = net.request({
      method: 'POST',
      url: `${cloudOrigin}/api/auth/session/renew`,
      useSessionCookies: false,
    });
    req.setHeader('Authorization', `Bearer ${bearer}`);
    req.on('response', (res) => {
      // Runtime ist ein Node-Readable (Body verwerfen, Socket freigeben) — die
      // Electron-d.ts typisiert IncomingMessage nur schmaler, daher der Cast.
      (res as unknown as { resume(): void }).resume();
      res.on('end', () => {
        const roh = res.headers['set-cookie'];
        const liste = Array.isArray(roh) ? roh : roh ? [roh] : undefined;
        const frisch = pulseSessionAusSetCookie(liste);
        if (!frisch) return resolve(); // Renew fehlgeschlagen → '' → "nicht eingeloggt"
        session.defaultSession.cookies
          .set({
            url: cloudOrigin,
            name: 'pulse_session',
            value: frisch.value,
            secure: true,
            httpOnly: true,
            sameSite: 'strict',
            expirationDate: Math.floor(Date.now() / 1000) + frisch.maxAgeSek,
          })
          .then(
            () => resolve(),
            () => resolve(),
          );
      });
    });
    req.on('error', () => resolve());
    req.end();
  });
}

/** Gültigen `pulse_session`-Cookie besorgen: ist einer da, direkt nutzen; sonst
 *  per durablem Bearer-Token neu prägen (renewSessionCookie). '' = nicht
 *  eingeloggt (kein Cookie + kein Token). `getBearer` kommt aus serverAuth
 *  (createTokenGetter) und refresht den Access-Token bei Bedarf. */
async function ensureSessionCookie(
  cloudOrigin: string,
  getBearer?: () => Promise<string | null>,
): Promise<string> {
  const existing = await sessionCookie(cloudOrigin);
  if (existing) return existing;
  if (!getBearer) return '';
  let bearer = await getBearer();
  // Cookie-Modus (Security-Audit 2026-09-16): refresh_token reist im HttpOnly-
  // pulse_rt-Cookie, der Store trägt keinen. net.fetch läuft durch Chromiums
  // Netzwerkstack der Default-Session — der rt-Cookie geht mit UND die
  // Rotation (Set-Cookie) landet zurück im Cookie-Store, was der Body-Refresh
  // (serverAuth.refreshTokens) nicht leisten kann.
  if (!bearer) {
    try {
      const r = await net.fetch(`${cloudOrigin}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (r.ok) {
        const j = (await r.json()) as { access_token?: unknown };
        if (typeof j.access_token === 'string' && j.access_token) {
          onMintedTokens?.(cloudOrigin, { accessToken: j.access_token, refreshToken: '' });
          bearer = j.access_token;
        }
      }
    } catch { /* Netzfehler → weiter ohne Bearer */ }
  }
  if (!bearer) return '';
  await renewSessionCookie(cloudOrigin, bearer);
  // Nach dem Set-Cookie erneut lesen; schlug der Renew fehl, ist es weiter ''
  // → der Aufrufer meldet dann "nicht eingeloggt".
  return sessionCookie(cloudOrigin);
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
    let fertig = false;
    const abschliessen = (ergebnis: { status: number; json: unknown }) => {
      if (fertig) return;
      fertig = true;
      (req as unknown as { destroy(): void }).destroy();
      resolve(ergebnis);
    };
    const frist = setTimeout(
      () => abschliessen({ status: 0, json: null }),
      NET_FRIST_MS,
    );
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        clearTimeout(frist);
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        abschliessen({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', () => {
      clearTimeout(frist);
      abschliessen({ status: 0, json: null });
    });
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
  getBearer?: () => Promise<string | null>,
): Promise<ProvisionResult> {
  try {
    const cookie = await ensureSessionCookie(cloudOrigin, getBearer);
    if (!cookie) return { ok: false, error: 'Nicht eingeloggt — bitte zuerst einloggen.' };

    // 1. Aktive App-Host-Instanz des Users finden. NUR origin=app_host — das
    //    Pairing rotiert client_secret + Tunnel-Token und darf eine laufende
    //    VPS-Instanz desselben Users nie treffen. Der Cookie kann durch die
    //    401-Heilung in holeInstanzen erneuert worden sein — weiter unten
    //    fährt list.cookie, nicht das eingangs gelesene.
    const list = await holeInstanzen(cloudOrigin, getBearer);
    if (list.status === 0) return { ok: false, error: 'Cloud nicht erreichbar — Internetverbindung?' };
    if (list.status !== 200 || !Array.isArray(list.json)) {
      return { ok: false, error: `Instanzen nicht ladbar (HTTP ${list.status}). Eingeloggt + freigegeben?` };
    }
    const { cookie: sessionCookie } = list;
    const liste = list.json as InstanceOut[];
    const gefunden = aktiveAppHostInstanz(liste);
    if (gefunden) {
      const inst = liste.find((i) => i.id === gefunden.id) as InstanceOut;
      return proceedWithInstance(inst, sessionCookie, cloudOrigin, opts);
    }

    // Selbstbedienung (Heim-Server 2026-09-27): keine Instanz da → selbst
    // eine anlegen. Kein Antrag, keine Freischaltung — der Endpoint nimmt das
    // Cloud-Konto als Identität und Owner; das client_secret aus der Antwort
    // braucht die Server-App nicht, weil der Bootstrap-Redeem unten das
    // Secret ohnehin rotiert. 409 = parallel doch eine entstanden (Race) →
    // Liste neu lesen; alles andere ist ein echter Fehler.
    const create = await netJson('POST', `${cloudOrigin}/api/auth/me/instances`, sessionCookie, {});
    const anlage = bewerteAnlage(create.status, create.json);
    if (anlage.art === 'ok') {
      return proceedWithInstance({ id: anlage.instanzId } as InstanceOut, sessionCookie, cloudOrigin, opts);
    }
    if (anlage.art === 'konflikt') {
      const relist = await netJson('GET', `${cloudOrigin}/api/auth/me/instances`, sessionCookie);
      const again = aktiveAppHostInstanz(relist.json);
      if (!again) return { ok: false, error: 'Instanz-Anlage widersprüchlich — erneut versuchen.' };
      const againFull = (relist.json as InstanceOut[]).find((i) => i.id === again!.id) as InstanceOut;
      return proceedWithInstance(againFull, sessionCookie, cloudOrigin, opts);
    }
    return { ok: false, error: `Server-Registrierung fehlgeschlagen (HTTP ${anlage.status}).` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** GET /me/instances mit 401-Heilung (Bughunt 2026-10-03): Ein Jar-Cookie kann
 *  serverseitig tot sein, obwohl die dauerhaften Tokens gesund sind — die
 *  Web-App rotierte die Session (Boot-Renew), und ihr Set-Cookie ging beim
 *  Umschalten auf server.html verloren. ensureSessionCookie vertraut dem
 *  vorhandenen Cookie blind, deshalb: bei 401 das Jar-Cookie verwerfen, per
 *  Bearer neu prägen, EINMAL erneut versuchen. Liefert Status+Liste UND den
 *  ggf. erneuerten Cookie — der Mint unten muss auf demselben Stand fahren. */
async function holeInstanzen(
  cloudOrigin: string,
  getBearer?: () => Promise<string | null>,
): Promise<{ status: number; json: unknown; cookie: string }> {
  let cookie = (await ensureSessionCookie(cloudOrigin, getBearer)) ?? '';
  let list = cookie
    ? await netJson('GET', `${cloudOrigin}/api/auth/me/instances`, cookie)
    : { status: 401 as number, json: null as unknown };
  if (list.status === 401) {
    await session.defaultSession.cookies.remove(cloudOrigin, 'pulse_session').catch(() => {});
    cookie = (await ensureSessionCookie(cloudOrigin, getBearer)) ?? '';
    list = cookie
      ? await netJson('GET', `${cloudOrigin}/api/auth/me/instances`, cookie)
      : list;
  }
  return { status: list.status, json: list.json, cookie };
}

/** Schritt 2+3 der Provisionierung für eine gefundene Instanz: Bootstrap-Token
 *  minten + einlösen. Ausgelagert, weil der Instanz-Weg (gefunden vs. gerade
 *  selbst angelegt) oben verzweigt, der Mint-Weg aber identisch ist. */
async function proceedWithInstance(
  inst: InstanceOut,
  cookie: string,
  cloudOrigin: string,
  opts: { confirmTakeover?: boolean },
): Promise<ProvisionResult> {
  try {
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

export interface MeInfo {
  /** Cloud-Kennung — treibt den Benutzer-Weltwechsel in main.ts. */
  id?: string;
  username: string;
  displayName: string | null;
}

/** Der aktuell eingeloggte Cloud-User (GET /api/auth/me über den
 *  pulse_session-Cookie) — für die "Angemeldet als …"-Zeile der Server-App.
 *  Wie provision() über die Electron-Default-Session, in der der
 *  howispulse.com-Login stattfand. null bei fehlender Session (gepairter Server
 *  ohne frischen Login / abgelaufener Cookie) oder Netz-/Serverfehler → die UI
 *  blendet die Zeile dann einfach aus. */
export async function fetchMe(
  cloudOrigin: string,
  getBearer?: () => Promise<string | null>,
): Promise<MeInfo | null> {
  try {
    const cookie = await ensureSessionCookie(cloudOrigin, getBearer);
    if (!cookie) return null;
    const r = await netJson('GET', `${cloudOrigin}/api/auth/me`, cookie);
    if (r.status !== 200 || !r.json || typeof r.json !== 'object') return null;
    const u = r.json as { id?: unknown; username?: unknown; display_name?: unknown };
    if (typeof u.username !== 'string') return null;
    return {
      ...(u.id !== undefined && u.id !== null ? { id: String(u.id) } : {}),
      username: u.username,
      displayName: typeof u.display_name === 'string' ? u.display_name : null,
    };
  } catch {
    return null;
  }
}

/** "In der Cloud registriert & auffindbar": fragt den Directory-Heartbeat der
 *  Instanz ab (GET /me/instances/{id}/direct-endpoint, online-Feld). Wie
 *  provision() über den pulse_session-Cookie. Liefert true (online), false
 *  (Endpoint da, aber Heartbeat stale) oder null (Session-/Netz-/Serverfehler
 *  bzw. noch kein Eintrag → fail-safe, UI zeigt nichts). */
export async function fetchCloudStatus(
  cloudOrigin: string,
  instanceId: string,
  getBearer?: () => Promise<string | null>,
): Promise<boolean | null> {
  try {
    const cookie = await ensureSessionCookie(cloudOrigin, getBearer);
    if (!cookie) return null;
    const r = await netJson('GET', `${cloudOrigin}/api/auth/me/instances/${instanceId}/direct-endpoint`, cookie);
    return classifyCloudStatus(r.status, r.json);
  } catch {
    return null;
  }
}

/** "Server aufgeben": Cloud-Registrierung löschen (Soft-Delete im Backend,
 *  routes_instance_delete.py). Läuft wie provision() über den
 *  pulse_session-Cookie — ohne gültige Session 'unauthorized', damit die UI
 *  auf den Client-Weg (Einstellungen → Meine Instanzen) verweisen kann. */
export async function deleteInstanceRegistration(
  cloudOrigin: string,
  instanceId: string,
  getBearer?: () => Promise<string | null>,
): Promise<CloudDeleteVerdict> {
  try {
    const cookie = await ensureSessionCookie(cloudOrigin, getBearer);
    if (!cookie) return 'unauthorized';
    const r = await netJson('DELETE', `${cloudOrigin}/api/auth/me/instances/${instanceId}`, cookie);
    return classifyDeleteStatus(r.status);
  } catch {
    return 'error';
  }
}
