#!/usr/bin/env node
/**
 * Dev-Testdaten: User `dev` mit vier Freunden und echten DM-Verläufen.
 *
 * Läuft gegen den LOKALEN Stack (auth 8001, chat-gateway 8002 — gleiche
 * Dienste wie der Vite-Proxy), damit jede Zeile durch die echte Server-Logik
 * geht: Registrierung, Freundschaftsanfrage/-annahme, DM-Kanal, Nachrichten,
 * Lesezeichen. Kein DB-Schreiben von Hand, kein Schema-Wissen hier.
 *
 * Idempotent: vorhandene Accounts werden nur angemeldet, Freundschaften und
 * DM-Kanäle werden per create-or-get wiederverwendet. NUR die Nachrichten
 * wachsen mit jedem Lauf — wer sauber starten will, löscht die Test-User.
 *
 * Nutzung:  node scripts/dev-testdaten.mjs
 * Andere Ziele: PULSE_TESTDATEN_AUTH / PULSE_TESTDATEN_CHAT überschreiben.
 */
const AUTH = process.env.PULSE_TESTDATEN_AUTH || 'http://127.0.0.1:8001';
const CHAT = process.env.PULSE_TESTDATEN_CHAT || 'http://127.0.0.1:8002';
const PW = 'test1234';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kleiner API-Helfer mit 429-Nachsicht (Message-Ratelimit des Gateways). */
async function api(base, path, { method = 'GET', token, body, ok = [] } = {}) {
  for (let versuch = 0; ; versuch++) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token && { authorization: `Bearer ${token}` })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 429 && versuch < 7) {
      // Register ist auf 5/Minute pro IP gedrosselt (auch 409-Anfragen zählen
      // mit) — das Schema übersteigt irgendwann das 60s-Fenster.
      await sleep([2000, 5000, 15000, 30000, 60000, 65000, 65000][versuch]);
      continue;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok && !ok.includes(res.status)) {
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return { status: res.status, data };
  }
}

async function account(username) {
  await api(AUTH, '/register', {
    method: 'POST',
    body: { username, email: `${username}@dcc-test.example.com`, password: PW },
    ok: [409]
  });
  const login = await api(AUTH, '/login', {
    method: 'POST',
    body: { email_or_username: username, password: PW }
  });
  const me = await api(AUTH, '/me', { token: login.data.access_token });
  return { username, token: login.data.access_token, id: String(me.data.id) };
}

async function befreunden(dev, freund) {
  const freunde = (await api(CHAT, '/friends', { token: dev.token })).data.map((f) => String(f.user_id));
  if (freunde.includes(freund.id)) return;
  // Anfrage vom Freund, Annahme durch dev — der realistische Weg.
  await api(CHAT, '/friend-requests', {
    method: 'POST',
    token: freund.token,
    body: { target_user_id: dev.id },
    ok: [409]
  });
  const offen = (await api(CHAT, '/friend-requests', { token: dev.token })).data;
  const anfrage = (offen.incoming ?? []).find((r) => String(r.sender_id) === freund.id);
  if (anfrage) {
    await api(CHAT, `/friend-requests/${anfrage.id}/accept`, {
      method: 'POST',
      token: dev.token,
      ok: [409, 400]
    });
  }
}

async function dmKanal(dev, freund) {
  const kanal = await api(CHAT, '/dm-channels', {
    method: 'POST',
    token: dev.token,
    body: { target_user_id: freund.id }
  });
  return String(kanal.data.id);
}

async function fuelen(dev, freund, kanalId, verlauf) {
  // Idempotent: Kanäle mit vorhandenem Verlauf überspringen — der Skriptkopf
  // verspricht „jeder Lauf ist gefahrlos wiederholbar".
  const vorhanden = await api(CHAT, `/channels/${kanalId}/messages?limit=1`, { token: dev.token });
  if ((vorhanden.data ?? []).length > 0) return 0;
  let n = 0;
  for (const [sender, text] of verlauf) {
    await api(CHAT, `/channels/${kanalId}/messages`, {
      method: 'POST',
      token: sender === 'dev' ? dev.token : freund.token,
      body: { content: text }
    });
    n++;
    await sleep(150);
  }
  return n;
}

/** Vier Freunde, vier Stimmungen — kurze Zeilen, lange Absätze, Listen, Links. */
const FREUNDE = [
  {
    name: 'max',
    verlauf: [
      ['max', 'He haste am Wochenende vor?'],
      ['dev', 'Nix festes, warum?'],
      ['max', 'Klettern in der Sächsischen Schweiz, Samstag früh los'],
      ['dev', 'Ohh ja. Wer fährt alles?'],
      ['max', 'Ich, Jonas und evtl. Lisa'],
      ['dev', 'Lisa vom Bootcamp?'],
      ['max', 'Ja genau die'],
      ['max', 'Gebiet: Schrammsteine, da sind ein paar 6er die ich noch offen habe'],
      ['dev', 'Sehr. Ich bin bei 5c aktuell'],
      ['max', 'Passt, da gibt’s genug für beide'],
      ['dev', 'Was soll ich mitbringen?'],
      ['max', 'Gurt + Chalk reichen, Seile hab ich zwei'],
      ['max', 'Abfahrt 7:00 Hauptbahnhof, oder?'],
      ['dev', 'Machen wir. Ich reservier mir schon mal den Kaffee'],
      ['max', '😄 leg dich nicht wieder um'],
      ['dev', 'Ich? Niemals.'],
      ['max', 'Wetter sieht gut aus, 18 Grad und trocken'],
      ['dev', 'Perfekt. Bis Samstag.']
    ]
  },
  {
    name: 'lina',
    verlauf: [
      ['lina', 'Hast du kurz Zeit für die Architektur-Frage?'],
      ['dev', 'Immer. Schieß los.'],
      ['lina', 'Es geht um die Synchronisation zwischen den Services. Aktuell pollen wir alle 30 Sekunden und ich frage mich, ob wir das nicht ereignisbasiert lösen sollten, bevor wir noch mehr Consumers draufsetzen. Das Problem ist ja nicht das Polling selbst, sondern dass jeder neue Service wieder einen eigenen Timer mitbringt, und irgendwann wissen wir nicht mehr, wer eigentlich wann welchen Stand sieht. Wenn wir das auf einen Push umstellen, hätten wir eine Stelle, die die Wahrheit besitzt, und alle anderen reagieren nur noch.'],
      ['dev', 'Ja, das Polling-Gewächs kenne ich. Was spricht gegen Push?'],
      ['lina', 'Aufwand und die Frage, was bei Verbindungsabbruch passiert'],
      ['dev', 'Letzteres ist der eigentliche Punkt. Ich würde beides bauen: Push als schnellster Pfad, Polling als Fallback mit langem Intervall.'],
      ['lina', 'Also Hybrid. Ja, das klingt vernünftig.'],
      ['dev', 'Und die Timer bleiben als Selbstheilung, nicht als Hauptpfad.'],
      ['lina', 'Schreib ich ins Ticket. Danke dir!'],
      ['dev', 'Gern. Zeig mir den Entwurf, bevor er ins Review geht.'],
      ['lina', 'Mach ich. Freitag vielleicht?'],
      ['dev', 'Passt.'],
      ['lina', 'Übrigens: das Onboarding-Doc hat mir heute schon zwei Fragen erspart 🎉'],
      ['dev', 'Das hört man gern.']
    ]
  },
  {
    name: 'tim',
    verlauf: [
      ['tim', 'bruder'],
      ['tim', 'BRUDER'],
      ['dev', 'was'],
      ['tim', 'schau dir das video an'],
      ['tim', 'https://youtu.be/dQw4w9WgXcQ'],
      ['dev', 'nein'],
      ['tim', 'lmao'],
      ['tim', 'du hast draufgeklickt ich hab es gesehen'],
      ['dev', 'ich habe NICHT'],
      ['tim', 'dein status war grün für 3 sekunden'],
      ['dev', 'das war der kühlschrank'],
      ['tim', '☠️'],
      ['tim', 'naja, zocken heute abend?'],
      ['dev', 'ja klar, 21u?'],
      ['tim', 'bing'],
      ['dev', 'bing bong'],
      ['tim', ' 😂😂 bis dann']
    ]
  },
  {
    name: 'sara',
    verlauf: [
      ['sara', 'Hey! Kommen Sie Donnerstag zum Abendessen? — verkatert formal, ne? 😅 Also: Du, Donnerstag, Essen?'],
      ['dev', 'Sehr formell. Ich bin dabei, was kochst du?'],
      ['sara', 'Ratatouille, das Rezept von Oma'],
      ['dev', 'Die Legende. Soll ich was mitbringen?'],
      ['sara', 'Nur dich und Appetit. Vielleicht Brot?'],
      ['dev', 'Brot kann ich. Vom Bäcker Eck?'],
      ['sara', 'Perfekt. 19 Uhr passt?'],
      ['dev', 'Passt. Ich nehme mir frei vom Zocken mit Tim'],
      ['sara', 'Tim kann auch kommen, es ist genug da'],
      ['dev', 'Ich frage ihn. Er wird trotzdem um 21 Uhr zocken wollen'],
      ['sara', 'Typisch 😄'],
      ['dev', 'Bis Donnerstag dann!'],
      ['sara', 'Freut mich! Bis dann 🥖']
    ]
  }
];

const dev = await account('dev');
console.log(`dev (id ${dev.id})`);
const konten = [dev];
let gesamt = 0;
for (const freund of FREUNDE) {
  const konto = await account(freund.name);
  await befreunden(dev, konto);
  const kanal = await dmKanal(dev, konto);
  const n = await fuelen(dev, konto, kanal, freund.verlauf);
  gesamt += n;
  konten.push(konto);
  console.log(`  ${freund.name.padEnd(5)} (id ${konto.id}) — Kanal ${kanal}, ${n} Nachrichten`);
}

// Alle untereinander befreunden (Gruppen-DMs & Freundesansichten testbar):
// jedes Paar einmal, dev-Verbindungen existieren schon — befreunden() springt
// bestehende Friendschaften über die Freundesliste selbst an.
for (let i = 1; i < konten.length; i++) {
  for (let j = i + 1; j < konten.length; j++) {
    await befreunden(konten[i], konten[j]);
  }
}
console.log(`Paare untereinander befreundet.`);
console.log(`Fertig: ${FREUNDE.length} Freunde, ${gesamt} neue Nachrichten.`);
