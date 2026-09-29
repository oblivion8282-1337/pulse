// WS-Live-Chat-E2E für den Heim-Server (Linux-Lauf, 2026-09-30) — pure Node.
//
// Beweist den WS-Pfad über den Relay-Hostnamen: dev2 verbindet das Gateway
// (wss://<relay>/ws?token=…), abonniert einen Kanal (Abo-Modell!), dev3 postet
// per REST — die Nachricht kommt live als op=message. Alles über
// Cloud-TLS → frps-Tunnel → Container (derselbe Weg wie im Browser ohne
// Direktpfad).
//
// Aus web/ starten (nur wegen playwright-freiem Node? Nein: pure Node —
//   node ../infra/self-host/tests/heim-ws-cloud-e2e.mjs  — braucht kein Vite!)
//
// Fallen: Login setzt ZWEI Cookies (pulse_rt zuerst, pulse_session danach) —
// gezielt pulse_session filtern. Der Ready-Frame kommt ggf. ZWEIMAL und hello
// separat — nicht beim ersten Frame abbrechen.
const CLOUD = 'https://pulse.unicutmedia.com';
const RELAY = 'https://merry-meadow-adbe.relay.unicutmedia.com';
const HOSTNAME = 'merry-meadow-adbe.relay.unicutmedia.com';

async function loginCookie(user, pass) {
  const r = await fetch(`${CLOUD}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_or_username: user, password: pass }),
  });
  if (r.status !== 200) throw new Error(`login ${user} → ${r.status}`);
  // ZWEI Set-Cookie-Zeilen — nur pulse_session wollen wir.
  const session = r.headers.getSetCookie().map((c) => c.split(';')[0])
    .find((c) => c.startsWith('pulse_session='));
  if (!session) throw new Error('kein pulse_session-Cookie');
  return session;
}

async function ticket(cookie, extra = {}) {
  const r = await fetch(`${CLOUD}/api/auth/me/server-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ hostname: HOSTNAME, ...extra }),
  });
  if (!r.ok) throw new Error(`ticket → ${r.status}: ${await r.text()}`);
  return (await r.json()).ticket;
}

async function relaySitzung(tkt, extra = {}) {
  const r = await fetch(`${RELAY}/api/chat/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: tkt, ...extra }),
  });
  if (!r.ok) throw new Error(`session → ${r.status}: ${await r.text()}`);
  return (await r.json()).session_token;
}

const ownerCookie = await loginCookie('dev2', 'test1234');
const ownerSess = await relaySitzung(await ticket(ownerCookie));
console.log('owner: Ticket + Session über Relay-TLS ok');

const g = await (await fetch(`${RELAY}/api/chat/guilds`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${ownerSess}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Ws-E2E-' + (Date.now() % 100000) }),
})).json();
const chan = await (await fetch(`${RELAY}/api/chat/guilds/${g.id}/channels`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${ownerSess}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'general', type: 0, position: 0 }),
})).json();
const inv = await (await fetch(`${RELAY}/api/chat/guilds/${g.id}/invites`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${ownerSess}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ max_uses: 5, expires_in_seconds: 86400 }),
})).json();
console.log('owner: guild + Textkanal + Invite ok');

const iid = (await (await fetch(`${CLOUD}/api/auth/me/instances`, { headers: { Cookie: ownerCookie } })).json())[0].id;
await fetch(`${CLOUD}/api/auth/me/instances/${iid}/membership`, {
  method: 'POST', headers: { Cookie: ownerCookie },
});

const bobCookie = await loginCookie('dev3', 'test1234');
const bobSess = await relaySitzung(
  await ticket(bobCookie, { community_grant_code: inv.code }),
  { community_grant_code: inv.code },
);
const acc = await fetch(`${RELAY}/api/chat/invites/${inv.code}/accept`, {
  method: 'POST', headers: { Authorization: `Bearer ${bobSess}` },
});
console.log('dev3: Session + Beitritt über Relay-TLS ok,', acc.status);

// ── Owner-WS: verbinden, (mind. einen) ready abwarten, Kanal abonnieren ──
const ws = new WebSocket(`wss://${HOSTNAME}/ws?token=${encodeURIComponent(ownerSess)}`);
const empfangen = [];
let abonniert = false;

await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('WS öffnet nicht')), 15000);
  ws.onopen = () => { clearTimeout(t); res(); };
  ws.onerror = (e) => rej(new Error('WS-Fehler'));
});
ws.onmessage = (e) => {
  try { empfangen.push(JSON.parse(e.data)); } catch { /* egal */ }
};

// hello + ready (ggf. zweimal) abwarten, DANN abonnieren (Abo-Modell).
await new Promise((res) => {
  const t0 = Date.now();
  const poll = setInterval(() => {
    const readyDa = empfangen.some((m) => m.op === 'ready');
    if ((readyDa && Date.now() - t0 > 2000) || Date.now() - t0 > 8000) {
      clearInterval(poll); res();
    }
  }, 300);
});
ws.send(JSON.stringify({ op: 'subscribe', channel_id: chan.id }));
abonniert = true;
console.log('owner: WS offen (', empfangen.length, 'Frames bislang ), Kanal abonniert');

// ── dev3 postet — die Nachricht muss live als op:message ankommen ──
const inhalt = `ws-live-${Date.now()}`;
const post = await fetch(`${RELAY}/api/chat/channels/${chan.id}/messages`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${bobSess}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: inhalt }),
});
console.log('dev3-Nachricht gepostet:', post.status);

const kamAn = await new Promise((res) => {
  const t0 = Date.now();
  const poll = setInterval(() => {
    const treffer = empfangen.find((m) => m.op === 'message'
      && JSON.stringify(m).includes(inhalt));
    if (treffer) { clearInterval(poll); res(true); }
    if (Date.now() - t0 > 10000) { clearInterval(poll); res(false); }
  }, 250);
});
const ops = empfangen.map((m) => m.op).join(',');
console.log('empfangene Ops:', ops);
console.log('>>> WS-E2E:', kamAn
  ? 'GRÜN — Live-Nachricht über Relay-WS angekommen (Abo-Modell)'
  : 'ROT — keine op=message');
ws.close();
process.exit(kamAn ? 0 : 1);
