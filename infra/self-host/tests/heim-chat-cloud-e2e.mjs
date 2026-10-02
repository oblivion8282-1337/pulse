// Cloud-Chat-E2E für den Heim-Server (Linux-Lauf 2026-09-29).
//
// Fährt die komplette Produktkette gegen eine ECHTE Cloud + den HEIM-Container
// (hier: Dev-Cloud pulse.unicutmedia.com, Container pulse-host lokal):
//   Owner  dev2: Cloud-Ticket (Relay-Subdomain-Auflösung, Fix 3665c212) →
//          Direktpfad-ICE → Session/Guild/Kanal/Invite — alles über den
//          DataChannel (/src/lib/direct/connection.ts, der echte Client-Stack).
//   Gast   dev3: Cloud-Mitgliedschaftsvermerk → Grant-Ticket → Session mit
//          community_grant_code → Invite-Accept → Nachricht — ebenfalls alles
//          über den DataChannel. Der Owner liest sie über seinen eigenen zurück.
//
// Voraussetzungen:
//   - Heim-Container läuft (Server-App) und ist im Cloud-Telefonbuch online.
//   - Vite mit Cloud-Proxy: PULSE_WEB_PORT=5273 PULSE_API_ORIGIN=https://<cloud>
//     node node_modules/vite/bin/vite.js dev   (aus web/, s. vite.config.ts)
//   - node infra/self-host/tests/heim-chat-cloud-e2e.mjs  (aus web/ starten,
//     löst @playwright/test auf)
// WICHTIG: Jede DataChannel-Sitzung läuft in EINEM page.evaluate — das
// conn-Objekt überlebt die evaluate-Grenze nicht (structured clone).
import { chromium } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:5273';
const browser = await chromium.launch();

async function einloggen(user, pass) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' });
  const r = await page.evaluate(async ({ user, pass }) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email_or_username: user, password: pass }),
    });
    return res.status;
  }, { user, pass });
  if (r !== 200) throw new Error(`login ${user} → ${r}`);
  return page;
}

// Öffnet den Direktweg und macht ALLES darin; `schritte` bekommt (conn) und
// darf conn.fetch nutzen. Rückgabe = plain JSON.
async function mitDc(page, fn) {
  return page.evaluate(fn);
}

// ── Owner (dev2): Ticket, Session, Anlage — alles über den Direktweg ──
const owner = await einloggen('dev2', 'test1234');
const ow = await mitDc(owner, async () => {
  const liste = await (await fetch('/api/auth/me/instances', { credentials: 'include' })).json();
  const inst = Array.isArray(liste) ? liste[0] : liste.instances[0];
  const tr = await fetch('/api/auth/me/server-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ hostname: inst.hostname }),
  });
  if (!tr.ok) throw new Error(`owner-ticket → ${tr.status}`);
  const { ticket } = await tr.json();

  const direct = await import('/src/lib/direct/connection.ts');
  const tb = await (await fetch(`/api/auth/me/instances/${inst.id}/direct-endpoint`)).json();
  if (!tb.online) throw new Error('telefonbuch offline');
  const conn = await direct.DirectConnection.open({
    postOffer: async (sdp) => {
      const r = await fetch(`/api/auth/me/instances/${inst.id}/direct-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
      });
      if (!r.ok) throw new Error(`offer rejected ${r.status}`);
      return ((await r.json())).sdp;
    },
    expectedFingerprint: tb.fingerprint,
    iceServers: [],
  });
  const sess = await conn.fetch('/api/chat/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  if (!sess.ok) throw new Error(`owner-session → ${sess.status}: ${await sess.text()}`);
  const token = (await sess.json()).session_token;
  const auth = { Authorization: `Bearer ${token}` };
  const j = async (r) => { if (!r.ok) throw new Error(`anlage → ${r.status}: ${await r.text()}`); return r.json(); };
  const suffix = Date.now() % 100000;
  const guild = await j(await conn.fetch('/api/chat/guilds', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'Heim-E2E-' + suffix }),
  }));
  const chan = await j(await conn.fetch(`/api/chat/guilds/${guild.id}/channels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'general', type: 0, position: 0 }),
  }));
  const inv = await j(await conn.fetch(`/api/chat/guilds/${guild.id}/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ max_uses: 5, expires_in_seconds: 86400 }),
  }));
  return { iid: inst.id, hostname: inst.hostname, guild: guild.id, chan: chan.id, code: inv.code, token };
});
console.log('owner: ticket ok, DC offen, session ok — guild', ow.guild, 'chan', ow.chan, 'invite ok');
await owner.evaluate((d) => { window.__heim = d; }, ow);

// ── dev3: Merkhilfe, Grant-Ticket, Session + Nachricht — alles über DC ──
const bob = await einloggen('dev3', 'test1234');
await bob.evaluate((d) => { window.__heim = d; }, ow);
const mem = await bob.evaluate(async (iid) =>
  (await fetch(`/api/auth/me/instances/${iid}/membership`, { method: 'POST', credentials: 'include' })).status, ow.iid);
console.log('dev3-merkhilfe:', mem);

const ergebnis = await mitDc(bob, async () => {
  const tr = await fetch('/api/auth/me/server-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ hostname: window.__heim.hostname, community_grant_code: window.__heim.code }),
  });
  if (!tr.ok) throw new Error(`dev3-ticket → ${tr.status}: ${await tr.text()}`);
  const { ticket } = await tr.json();
  const direct = await import('/src/lib/direct/connection.ts');
  const tb = await (await fetch(`/api/auth/me/instances/${window.__heim.iid}/direct-endpoint`)).json();
  if (!tb.online) throw new Error('telefonbuch offline (dev3)');
  const conn = await direct.DirectConnection.open({
    postOffer: async (sdp) => {
      const r = await fetch(`/api/auth/me/instances/${window.__heim.iid}/direct-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
      });
      if (!r.ok) throw new Error(`offer rejected ${r.status}`);
      return ((await r.json())).sdp;
    },
    expectedFingerprint: tb.fingerprint,
    iceServers: [],
  });
  const sess = await conn.fetch('/api/chat/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket, community_grant_code: window.__heim.code }),
  });
  if (!sess.ok) throw new Error(`dev3-session → ${sess.status}: ${await sess.text()}`);
  const token = (await sess.json()).session_token;
  // Guild-Beitritt: derselbe Code ist am Server der Invite (s. joinByInvite).
  const acc = await conn.fetch(`/api/chat/invites/${window.__heim.code}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!acc.ok) throw new Error(`invite-accept → ${acc.status}: ${await acc.text()}`);
  const nachricht = `hallo-von-dev3-${Date.now()}`;
  const send = await conn.fetch(`/api/chat/channels/${window.__heim.chan}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: nachricht }),
  });
  if (!send.ok) throw new Error(`senden → ${send.status}: ${await send.text()}`);
  return { nachricht };
});
console.log('dev3: ticket ok, DC offen, session ok, invite ok, nachricht gesendet');

// ── Owner liest sie über einen frischen DC zurück ──
const gelesen = await mitDc(owner, async () => {
  const direct = await import('/src/lib/direct/connection.ts');
  const tb = await (await fetch(`/api/auth/me/instances/${window.__heim.iid}/direct-endpoint`)).json();
  const conn = await direct.DirectConnection.open({
    postOffer: async (sdp) => {
      const r = await fetch(`/api/auth/me/instances/${window.__heim.iid}/direct-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
      });
      if (!r.ok) throw new Error(`offer rejected ${r.status}`);
      return ((await r.json())).sdp;
    },
    expectedFingerprint: tb.fingerprint,
    iceServers: [],
  });
  const r = await conn.fetch(`/api/chat/channels/${window.__heim.chan}/messages`, {
    headers: { Authorization: `Bearer ${window.__heim.token}` },
  });
  return { status: r.status, text: await r.text() };
});
const hatSie = gelesen.text?.includes(ergebnis.nachricht);
console.log('owner-lesen über DC:', gelesen.status, '| enthält dev3-Nachricht:', hatSie);
console.log('>>> CHAT-E2E:', hatSie ? 'GRÜN — dev3→Container→dev2 komplett über DataChannel' : 'ROT');
if (!hatSie) console.log((gelesen.text || '').slice(0, 400));

await browser.close();
process.exit(hatSie ? 0 : 1);
