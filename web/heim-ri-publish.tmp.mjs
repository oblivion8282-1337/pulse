import { chromium } from './node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
const push = JSON.parse(fs.readFileSync('/tmp/heim-push.json', 'utf8'));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5273/login', { waitUntil: 'load' });
await page.waitForTimeout(500);
await page.waitForTimeout(1000);
const result = await page.evaluate(async (pushUrl) => {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  setInterval(() => { ctx.fillStyle = '#333'; ctx.fillRect(0,0,640,360); ctx.fillStyle = '#f0f'; ctx.fillRect(50,50,100,100); }, 66);
  const track = canvas.captureStream(15).getVideoTracks()[0];
  const pc = new RTCPeerConnection();
  pc.addTrack(track, new MediaStream([track]));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') res(); };
    setTimeout(res, 3000);
  });
  const r = await new Promise((res) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', pushUrl);
    xhr.setRequestHeader('Content-Type', 'application/sdp');
    xhr.onload = () => res({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => res({ status: 0, text: 'net' });
    xhr.send(pc.localDescription.sdp);
  });
  if (r.status !== 201) return { fehler: `WHIP → ${r.status}: ${r.text.slice(0, 120)}` };
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  for (let i = 0; i < 20; i++) {
    if (pc.connectionState === 'connected') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 5000));
  const stats = await pc.getStats();
  let frames = 0;
  stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') frames = s.framesEncoded; });
  return { frames };
}, push.push_url);
console.log('[ri-publish]', JSON.stringify(result));
await browser.close();
if (result.fehler) process.exit(1);
