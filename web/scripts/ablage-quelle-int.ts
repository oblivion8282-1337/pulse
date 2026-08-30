/**
 * Integrationstest: REST-Quelle → Nachzieher → Schreiber → Leser gegen den
 * ECHTEN Chat-Dienst (Hetzner-Stack über den lokalen Vite-Proxy). Das ist
 * der Beweis der Phase-1-Ablage am richtigen Protokoll — nicht an Mini-
 * Servern: Anmeldung, Guild/Kanal-Anlage, fünf Nachrichten über die echte
 * REST-API, dann konsolidieren und Feld für Feld zurücklesen.
 *
 *   PULSE_INT_BASE=http://127.0.0.1:5173 node scripts/ablage-quelle-int.ts dev test1234
 *
 * Der Vite muss mit PULSE_API_ORIGIN auf den Stack zeigen (dev:remote:web).
 * Legt eine eigene Guild + Kanal an und räumt sie am Ende NICHT ab —
 * Wegwerfdaten auf einem Dev-Stack.
 */

import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { AblageSchreiber } from '../src/lib/ablage/schreiber.ts';
import { leseVerlauf } from '../src/lib/ablage/leser.ts';
import { nachziehen } from '../src/lib/ablage/nachzieher.ts';
import { restQuelle } from '../src/lib/ablage/quelle.ts';
import { leseNachricht } from '../src/lib/ablage/nutzlast.ts';
import type { Message } from '../src/lib/api/types.ts';

const BASE = process.env.PULSE_INT_BASE ?? 'http://127.0.0.1:5173';
const NUTZER = process.argv[2] ?? 'dev';
const PASSWORT = process.argv[3] ?? 'test1234';
let fehlgeschlagen = 0;

function pruefe(bezeichnung: string, bedingung: boolean, detail?: string): void {
  if (bedingung) {
    console.log(`  ✔ ${bezeichnung}`);
  } else {
    fehlgeschlagen++;
    console.error(`  ✖ ${bezeichnung}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(
  pfad: string,
  method: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; text: string }> {
  const antwort = await fetch(BASE + '/api' + pfad, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: antwort.status, text: await antwort.text() };
}

const stempel = Date.now().toString();
const guildeName = `ablage-int-${stempel}`;

// --- 1. Anmelden ---
const loginAntwort = await api('/auth/login', 'POST', {
  email_or_username: NUTZER,
  password: PASSWORT,
});
pruefe('Anmeldung', loginAntwort.status === 200, `HTTP ${loginAntwort.status}`);
const tokens = JSON.parse(loginAntwort.text) as { access_token: string };
const token = tokens.access_token;

// --- 2. Guild + Textkanal anlegen ---
const guildAntwort = await api('/chat/guilds', 'POST', { name: guildeName }, token);
pruefe('Guild angelegt', guildAntwort.status === 201 || guildAntwort.status === 200, guildAntwort.text.slice(0, 80));
const guild = JSON.parse(guildAntwort.text) as { id: string };

const kanalAntwort = await api(`/chat/guilds/${guild.id}/channels`, 'POST', {
  name: 'ablage-probe',
  type: 0,
}, token);
pruefe('Textkanal angelegt', kanalAntwort.status === 201 || kanalAntwort.status === 200, kanalAntwort.text.slice(0, 80));
const kanal = JSON.parse(kanalAntwort.text) as { id: string };

// --- 3. Fünf echte Nachrichten über die REST-API posten ---
for (let i = 1; i <= 5; i++) {
  const antwort = await api(`/chat/channels/${kanal.id}/messages`, 'POST', {
    content: `Ablage-Nachricht ${i} (${stempel})`,
    nonce: null,
    reply_to_id: null,
    attachment_ids: [],
  }, token);
  if (antwort.status !== 200 && antwort.status !== 201) {
    console.error(`  ✖ Nachricht ${i} scheiterte: HTTP ${antwort.status} ${antwort.text.slice(0, 80)}`);
    fehlgeschlagen++;
  }
}
pruefe('Fünf Nachrichten gepostet', true);

// --- 4. Konsolidieren: REST-Quelle → Nachzieher → Schreiber ---
const ablage = speicherAdapter();
const schreiber = new AblageSchreiber(ablage, kanal.id);
const bericht = await nachziehen(
  schreiber,
  restQuelle(async (nach, vor, limit) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (nach !== null) params.set('after', nach);
    if (vor !== null) params.set('before', vor);
    const antwort = await fetch(`${BASE}/api/chat/channels/${kanal.id}/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!antwort.ok) throw new Error(`listMessages HTTP ${antwort.status}`);
    return JSON.parse(await antwort.text()) as Message[];
  }),
  { limit: 2 },
);

pruefe('Nachziehen: 5 festigt', bericht.festigt === 5, `war ${bericht.festigt}`);
pruefe('Wasserzeichen am Ende', schreiber.stand()?.letzteId !== null);

// --- 5. Zurücklesen und Feld für Feld vergleichen ---
const verlauf = await leseVerlauf(ablage);
pruefe('Verlauf: 5 Rahmen', verlauf.rahmen.length === 5, `war ${verlauf.rahmen.length}`);
pruefe('Keine Lücken', verlauf.luecken.length === 0, verlauf.luecken.join('; '));
let inhaltOk = true;
for (let i = 0; i < verlauf.rahmen.length; i++) {
  const n = leseNachricht(verlauf.rahmen[i].nutzlast);
  if (n.inhalt !== `Ablage-Nachricht ${i + 1} (${stempel})`) inhaltOk = false;
}
pruefe('Inhalte stimmen Feld für Feld', inhaltOk);

console.log(fehlgeschlagen === 0 ? '\nQUELLE-INTEGRATION GRÜN' : `\n${fehlgeschlagen} PRÜFUNGEN ROT`);
process.exit(fehlgeschlagen === 0 ? 0 : 1);
