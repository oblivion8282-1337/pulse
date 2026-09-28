import { chromium } from './node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';

const voice = JSON.parse(fs.readFileSync('/tmp/heim-voice.json', 'utf8'));

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
         '--autoplay-policy=no-user-gesture-required']
});

async function voiceTeilnehmer(name, token) {
  const ctx = await browser.newContext({ locale: 'de-DE', ignoreHTTPSErrors: true });
  await ctx.grantPermissions(['microphone'], { origin: 'http://127.0.0.1:5273' });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:5273/login', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  // Verbindet und hält den Raum offen; Rückgabe: Handle mit Status.
  return page.evaluate(async ({ token, ws }) => {
    const LK = await import('/node_modules/.vite/deps/livekit-client.js');
    const room = new LK.Room({ adaptiveStream: false, dynacast: false });
    await room.connect(ws, token);
    console.log('[voice] signal connected');
    await room.localParticipant.setMicrophoneEnabled(true)
      .then(() => undefined)
      .catch((e) => console.log('[voice] mikro-fehler', String(e).slice(0, 80)));
    // 12 s im Raum bleiben — der Gegenpart braucht Zeit zum Verbinden.
    for (let s = 0; s < 12; s++) {
      await new Promise((r) => setTimeout(r, 1000));
      const n = room.remoteParticipants.size;
      if (n > 0) {
        console.log(`[${name}] Gegner nach ${s + 1}s:`, n,
          '| raum:', room.name, '| ich:', room.localParticipant.identity);
      }
    }
    const gegner = [...room.remoteParticipants.values()].map((p) => p.identity);
    let audio = false;
    for (const rp of room.remoteParticipants.values()) {
      rp.trackPublications.forEach((tp) => {
        if (tp.kind === 'audio' && tp.isSubscribed) audio = true;
      });
    }
    room.disconnect();
    return { gegner, audio };
  }, { token, ws: voice.owner_token.ws_url });
}

// Beide NAHEZU GLEICHZEITIG verbinden (Promise.all) — sonst wartet der erste
// in sein eigenes Timeout hinein.
const [a, b] = await Promise.all([
  voiceTeilnehmer('owner', voice.owner_token.token),
  voiceTeilnehmer('bob', voice.bob_token.token),
]);
console.log('owner sieht bob:', JSON.stringify(a));
console.log('bob sieht owner:', JSON.stringify(b));
await browser.close();
const ok = a.gegner.length > 0 && b.gegner.length > 0 && a.audio && b.audio;
if (!ok) {
  console.log('VOICE FEHLGESCHLAGEN');
  process.exit(1);
}
console.log('');
console.log('=== VOICE ERFOLGREICH: beide Teilnehmer hören sich über den');
console.log('=== Heim-Server (LiveKit im Container) ===');
