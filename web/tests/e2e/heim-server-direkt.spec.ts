import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Heim-Server: die ECHTE WebRTC-Direktverbindung, Komplettlauf.
 *
 * Der Spec fährt ALLES selbst: Owner registriert sich in der Cloud, legt per
 * Selbstbedienung seine Instanz an, mintet + löst den Bootstrap-Token, startet
 * den All-in-One-Container mit genau diesen Creds (docker), gründet Community
 * + Invite — dann kommt Bob über den echten Client-Stack (`/src/lib/direct/*`:
 * RTCPeerConnection, Offer-Signaling, TOFU-Fingerprint-Pinning, HTTP über den
 * DataChannel) auf den Heim-Server und liest den Kanal. Kein HTTP-Fallback.
 *
 * Voraussetzungen: docker + gebautes Image `pulse-allinone:heim-test`
 * (docker build -f infra/self-host/Dockerfile …). Der Adapter bekommt
 * PULSE_DIRECT_EXTRA_HOST_IPS=127.0.0.1, damit die ICE-Strecke über Loopback
 * läuft — auf echten Zwei-Maschinen-Strecken stehen dort STUN-/LAN-IPs.
 */

const ts = Date.now();
const OWNER = {
  username: `hd_owner_${ts}`,
  email: `hd_owner_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `hd_bob_${ts}`,
  email: `hd_bob_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const CONTAINER = 'pulse-heim-e2e';

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' });
}

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  for (let versuch = 0; versuch < 2; versuch++) {
    await page.getByTestId('reg-submit').click();
    try {
      await page.waitForURL(/\/app/, { timeout: 20_000 });
      break;
    } catch {
      if (versuch === 1) throw new Error('register blieb hängen');
    }
  }
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

/** Container-API via curl (self-signed Cert → Browser ausgeschlossen). */
function containerApi(
  hostname: string,
  path: string,
  method: string,
  token: string | null,
  body?: unknown
): { status: number; json: any } {
  const auth = token ? `-H "Authorization: Bearer ${token}"` : '';
  const data = body !== undefined ? `-d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : '';
  const raw = sh(
    `curl -sk -w "\\n%{http_code}" --resolve "${hostname}:443:127.0.0.1" ` +
      `-X ${method} ${auth} ${data} "https://${hostname}${path}"`
  );
  const idx = raw.lastIndexOf('\n');
  const status = Number(raw.slice(idx + 1));
  const text = raw.slice(0, idx);
  return { status, json: text ? JSON.parse(text) : {} };
}

test('Direktpfad-Komplettlauf: Selbstbedienung → Container → Bob über DataChannel', async ({
  browser
}) => {
  test.setTimeout(420_000);

  // ── 1. Owner: Konto + Selbstbedienung + Bootstrap (Cloud) ──
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await register(owner, OWNER);

  const { iid, hostname, clientSecret, clientId, ownerUserId, adminEmail } =
    await owner.evaluate(async () => {
    const token = localStorage.getItem('dcc.tokens.access');
    const kopf = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    let r = await fetch('/api/auth/me/instances', {
      method: 'POST',
      headers: kopf,
      body: JSON.stringify({})
    });
    let secret = '';
    let clientIdOut = '';
    const me = (await (await fetch('/api/auth/me', { headers: kopf })).json()) as {
      id: number;
      email: string;
    };
    if (r.status === 409) {
      const liste = (await (
        await fetch('/api/auth/me/instances', { headers: kopf })
      ).json()) as { id: string; hostname: string; status: string; origin: string }[];
      const alt = liste.find((i) => i.status === 'active' && i.origin === 'app_host')!;
      // Secret ist unbekannt (nur beim ersten Mal gezeigt) → Reset-Mint + Redeem.
      const mint = (await (
        await fetch(`/api/auth/me/instances/${alt.id}/bootstrap-token`, {
          method: 'POST',
          headers: kopf,
          body: JSON.stringify({ reset: true })
        })
      ).json()) as { token: string };
      const creds = (await (
        await fetch('/api/auth/selfhost/bootstrap', {
          method: 'POST',
          headers: { Authorization: `Bearer ${mint.token}` }
        })
      ).json()) as { client_id: string; client_secret: string };
      secret = creds.client_secret;
      clientIdOut = creds.client_id;
      return {
        iid: alt.id,
        hostname: alt.hostname,
        clientSecret: secret,
        clientId: clientIdOut,
        ownerUserId: String(me.id),
        adminEmail: me.email
      };
    }
    if (r.status !== 201) throw new Error(`Selbstbedienung → ${r.status}`);
    const body = (await r.json()) as { instance: { id: string; hostname: string } };
    const mint = (await (
      await fetch(`/api/auth/me/instances/${body.instance.id}/bootstrap-token`, {
        method: 'POST',
        headers: kopf,
        body: JSON.stringify({})
      })
    ).json()) as { token: string };
    const creds = (await (
      await fetch('/api/auth/selfhost/bootstrap', {
        method: 'POST',
        headers: { Authorization: `Bearer ${mint.token}` }
      })
    ).json()) as { client_id: string; client_secret: string };
    secret = creds.client_secret;
    return {
      iid: body.instance.id,
      hostname: body.instance.hostname,
      clientSecret: secret,
      clientId: creds.client_id,
      ownerUserId: String(me.id),
      adminEmail: me.email
    };
  });
  expect(iid).toMatch(/^\d+$/);
  expect(hostname).toContain('app-');

  // ── 2. Container mit den Selbstbedienungs-Creds starten ──
  // Eigener Ordner je Lauf: der Container chowned das Cert-Dir auf seinen
  // pulse-User — Wiederverwendung würde das rmSync des Playwright-Users
  // mit EACCES bestrafen.
  const certDir = `/tmp/heim-e2e-certs-${ts}`;
  fs.mkdirSync(certDir, { recursive: true });
  sh(
    `openssl req -x509 -newkey rsa:2048 -keyout ${certDir}/key.pem ` +
      `-out ${certDir}/cert.pem -days 2 -nodes -subj "/CN=${hostname}" ` +
      `-addext "subjectAltName=DNS:${hostname},DNS:localhost" 2>/dev/null`
  );
  try {
    sh(`docker rm -f ${CONTAINER} >/dev/null 2>&1`);
  } catch {
    /* kein alter Container */
  }
  sh(
    `docker run -d --name ${CONTAINER} --network host ` +
      `-v ${certDir}:/data/certs -v pulse-heim-e2e-data:/data ` +
      `-e PULSE_HOSTNAME=${hostname} ` +
      `-e PULSE_INSTANCE_ID=${iid} ` +
      `-e PULSE_INSTANCE_OWNER_ID=${ownerUserId} ` +
      `-e PULSE_CLOUD_CLIENT_ID=${clientId} ` +
      `-e PULSE_CLOUD_CLIENT_SECRET=${clientSecret} ` +
      `-e PULSE_ADMIN_EMAIL=${adminEmail} ` +
      `-e PULSE_CLOUD_ORIGIN=http://127.0.0.1:8101 ` +
      `-e PULSE_CLOUD_API_PREFIX= ` +
      `-e PULSE_TLS_MODE=provided ` +
      `-e PULSE_DIRECT_EXTRA_HOST_IPS=127.0.0.1 ` +
      `pulse-allinone:heim-test`
  );

  // Auf Container-Health über TLS warten.
  let healthy = false;
  for (let i = 0; i < 50; i++) {
    try {
      const code = sh(
        `curl -sk -o /dev/null -w "%{http_code}" --resolve "${hostname}:443:127.0.0.1" ` +
          `https://${hostname}/api/chat/health`
      ).trim();
      if (code === '200') {
        healthy = true;
        break;
      }
    } catch {
      /* noch nicht bereit */
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  expect(healthy, 'Container-Health über TLS').toBe(true);

  // ── 3. Owner-Session am Container + Community/Kanal/Invite + Nachricht ──
  const ownerTicket = await owner.evaluate(async (hn) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch('/api/auth/me/server-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostname: hn })
    });
    if (!r.ok) throw new Error(`ticket → ${r.status}`);
    return (await r.json()) as { ticket: string };
  }, hostname);
  const ownerSess = (await (async () => {
    const raw = sh(
      `curl -sk --resolve "${hostname}:443:127.0.0.1" -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-d '${JSON.stringify({ ticket: ownerTicket.ticket }).replace(/'/g, "'\\''")}' ` +
        `"https://${hostname}/api/chat/session"`
    );
    const body = JSON.parse(raw) as { session_token: string };
    return body.session_token;
  })());
  expect(ownerSess).toBeTruthy();

  const guild = containerApi(hostname, '/api/chat/guilds', 'POST', ownerSess, {
    name: 'Direkt-Lounge'
  });
  expect(guild.status).toBe(201);
  const chan = containerApi(hostname, `/api/chat/guilds/${guild.json.id}/channels`, 'POST', ownerSess, {
    name: 'general',
    type: 0,
    position: 0
  });
  expect(chan.status).toBe(201);
  const invite = containerApi(hostname, `/api/chat/guilds/${guild.json.id}/invites`, 'POST', ownerSess, {
    max_uses: 5,
    expires_in_seconds: 86400
  });
  expect(invite.status).toBe(201);
  const code = invite.json.code as string;
  const nachricht = `direkt-test-${ts}`;
  expect(
    containerApi(hostname, `/api/chat/channels/${chan.json.id}/messages`, 'POST', ownerSess, {
      content: nachricht
    }).status
  ).toBe(201);

  // ── 4. Bob: Cloud-Konto, Ticket mit Invite-Code, Container-Session ──
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await register(bob, BOB);
  await bob.evaluate(async (iid) => {
    const token = localStorage.getItem('dcc.tokens.access');
    await fetch(`/api/auth/me/instances/${iid}/membership`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
  }, iid);
  const bobTicket = await bob.evaluate(
    async ({ iid, hostname, code }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/auth/me/server-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ hostname, community_grant_code: code })
      });
      if (!r.ok) throw new Error(`bob ticket → ${r.status}`);
      return (await r.json()) as { ticket: string };
    },
    { iid, hostname, code }
  );
  const bobSessRaw = sh(
    `curl -sk --resolve "${hostname}:443:127.0.0.1" -X POST ` +
      `-H "Content-Type: application/json" ` +
      `-d '${JSON.stringify({ ticket: bobTicket.ticket, community_grant_code: code }).replace(/'/g, "'\\''")}' ` +
      `"https://${hostname}/api/chat/session"`
  );
  const bobSess = (JSON.parse(bobSessRaw) as { session_token: string }).session_token;
  expect(bobSess).toBeTruthy();

  // ── 5. Bob verbindet über den ECHTEN Client-Stack und liest den Kanal ──
  const ergebnis = await bob.evaluate(
    async ({ iid, hostname, chan, bobSess, nachricht }) => {
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const direct = await import('/src/lib/direct/connection.ts');
      const tb = await (
        await fetch(`/api/auth/me/instances/${iid}/direct-endpoint`)
      ).json();
      const conn = await direct.DirectConnection.open({
        postOffer: async (sdp: string) => {
          const r = await fetch(`/api/auth/me/instances/${iid}/direct-offer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp })
          });
          if (!r.ok) throw new Error(`offer rejected ${r.status}`);
          return ((await r.json()) as { sdp: string }).sdp;
        },
        expectedFingerprint: tb.fingerprint,
        iceServers: []
      });
      const antwort = await conn.fetch(`/api/chat/channels/${chan}/messages`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bobSess}` }
      } as RequestInit);
      const text = await antwort.text();
      conn.close();
      return { status: antwort.status, text: text.slice(0, 400) };
    },
    { iid, hostname, chan: chan.json.id, bobSess, nachricht }
  );

  console.log('[direkt]', JSON.stringify(ergebnis).slice(0, 300));
  expect(ergebnis.status).toBe(200);
  expect(ergebnis.text).toContain(nachricht);

  await bobCtx.close();
  await ownerCtx.close();
});

test.afterAll(() => {
  try {
    sh(`docker rm -f ${CONTAINER} >/dev/null 2>&1`);
  } catch {
    /* Container war schon weg */
  }
});
