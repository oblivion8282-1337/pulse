/**
 * Medien-Glieder für den Verbindungs-Check („Verbindungen“-Abschnitt) —
 * die Teile, die von der Cloud aus nicht beweisbar sind, aber von der
 * Server-App aus sehr wohl: Signalweg zu LiveKit und der WHIP/WHEP-Strompfad
 * durch Relay-Tunnel und MediaMTX.
 *
 * Grenze (bewusst, 2026-10-01): ein Probe-Anruf ohne echten Medienfluss wird
 * von MediaMTX mit „no stream is available“ für Zuschauer beantwortet, bis
 * ICE/DTLS echte Pakete sehen. Diese Antwort zählt hier als ERFOLG für den
 * Weg — echte Frames beweist der erste echte Zuschauer (Browser), nicht die
 * App. Der Sprung übers Internet (NAT-Loch) bleibt ebenfalls beim ersten
 * echten Teilnehmer; diese Prüfungen laufen im Heimnetz.
 */

export interface ProbeSchritt {
  ok: boolean;
  befund: string;
  was_ist: string;
  was_tun: string;
  einzelheit?: string;
}

/** Plausibles Sender-SDP für den WHIP-Probe-Anruf. Wichtig: die
 *  `a=fingerprint:`-Zeile — ohne sie lehnt MediaMTX den Anruf mit
 *  „no fingerprint“ ab, bevor irgendeine Aussage über den Weg steht. */
export function baueTestSdp(richtung: 'sendrecv' | 'recvonly', sitzung: number): string {
  return (
    'v=0\r\n' +
    `o=- ${sitzung} 2 IN IP4 127.0.0.1\r\n` +
    's=PulseVerbindungsPruefung\r\n' +
    't=0 0\r\n' +
    'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' +
    'c=IN IP4 0.0.0.0\r\n' +
    'a=ice-ufrag:probeufrag\r\n' +
    'a=ice-pwd:probepwdprobepwdprobepwdprobe\r\n' +
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\n' +
    'a=setup:actpass\r\n' +
    'a=mid:0\r\n' +
    `a=${richtung}\r\n` +
    'a=rtpmap:96 H264/90000\r\n' +
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n' +
    'a=rtcp-fb:96 nack\r\n' +
    'a=rtcp-mux\r\n'
  );
}

/** Signalweg zu LiveKit: HTTPS-GET auf `/livekit/` — Caddy reicht das als
 *  `GET /` an LiveKit durch, und LiveKit antwortet dort mit 200 „OK".
 *
 *  Scan 2026-10-08: Die frühere Fassung fragte das nackte `/livekit` ab und
 *  zählte JEDE Antwort. Das matcht `handle_path /livekit/*` nicht und fiel in
 *  den Catch-all (`respond … 200`) — grün auch bei totem LiveKit; ein
 *  abgerissener Tunnel lieferte 404/502 vom Relay und war ebenso „grün". */
export async function lebtLivekitSignalweg(relayHost: string): Promise<boolean> {
  try {
    const r = await fetch(`https://${relayHost}/livekit/`, {
      signal: AbortSignal.timeout(8_000),
    });
    return istLivekitAntwort(r.status, await r.text());
  } catch {
    return false;
  }
}

/** Nur LiveKits eigene Antwort zählt: 200 mit dem Körper „OK". */
export function istLivekitAntwort(status: number, koerper: string): boolean {
  return status === 200 && koerper.trim() === 'OK';
}

export interface MedienRundtripOptionen {
  relayHost: string;
  cloudOrigin: string;
  /** pulse_session-Cookie des angemeldeten Benutzers (für den Cloud-Ticket). */
  sessionCookie: string;
  /** Textsprache des Prüfschritts (default 'de'). */
  sprache?: 'de' | 'en';
}

/** Schritttexte je Befund — (deutsch, englisch). */
const TEXTE: Record<string, { was_ist: [string, string]; was_tun: [string, string] }> = {
  'kein-ticket': {
    was_ist: ['Die Cloud hat kein Zugangsticket ausgestellt — die Anmeldung ist vermutlich abgelaufen.',
      'The cloud did not issue an access ticket — the sign-in has probably expired.'],
    was_tun: ['In der Server-App neu anmelden.', 'Sign in again in the server app.'],
  },
  'keine-sitzung': {
    was_ist: ['Der Server hat das Zugangsticket über die Relay-Adresse nicht angenommen.',
      'The server did not accept the access ticket via the relay address.'],
    was_tun: ['Server läuft? Kurz warten und erneut prüfen. Bleibt es rot: Server stoppen und starten.',
      'Server running? Wait a moment and check again. If it stays red: stop and start the server.'],
  },
  'kein-testkanal': {
    was_ist: ['Der Test-Kanal konnte auf dem Server nicht angelegt werden.',
      'The test channel could not be created on the server.'],
    was_tun: ['Erneut prüfen; bleibt es rot: Server stoppen und starten.',
      'Check again; if it stays red: stop and start the server.'],
  },
  'kein-stream-token': {
    was_ist: ['Der Server hat keinen Stream-Zugang ausgestellt.',
      'The server did not issue a stream access grant.'],
    was_tun: ['Erneut prüfen; bleibt es rot: Server stoppen und starten.',
      'Check again; if it stays red: stop and start the server.'],
  },
  'whip-abgelehnt': {
    was_ist: ['Der Stream-Server hat den Probe-Stream nicht angenommen.',
      'The stream server did not accept the probe stream.'],
    was_tun: ['Eine Minute warten und erneut prüfen; bleibt es rot: Server stoppen und starten.',
      'Wait a minute and check again; if it stays red: stop and start the server.'],
  },
  'whep-fehlt': {
    was_ist: ['Der Auslieferungsweg für Zuschauer wurde nicht ausgestellt.',
      'The playback path for viewers was not issued.'],
    was_tun: ['Erneut prüfen; bleibt es rot: Server stoppen und starten.',
      'Check again; if it stays red: stop and start the server.'],
  },
  'whep-abgelehnt': {
    was_ist: ['Der Auslieferungsweg für Zuschauer hat den Probe-Anruf abgelehnt.',
      'The playback path for viewers rejected the probe call.'],
    was_tun: ['Erneut prüfen; bleibt es rot: Server stoppen und starten.',
      'Check again; if it stays red: stop and start the server.'],
  },
  'rundtrip': {
    was_ist: ['Probe-Stream angenommen und der Auslieferungsweg geprüft.',
      'Probe stream accepted and the delivery path verified.'],
    was_tun: ['', ''],
  },
  'abgebrochen': {
    was_ist: ['Die Stream-Prüfung brach mit einem Fehler ab.',
      'The stream check aborted with an error.'],
    was_tun: ['Erneut prüfen; bleibt es rot: Server stoppen und starten.',
      'Check again; if it stays red: stop and start the server.'],
  },
}

function schritt(
  ok: boolean, befund: string, sprache: 'de' | 'en' = 'de', einzelheit?: string,
): ProbeSchritt {
  const t = TEXTE[befund];
  const i = sprache === 'de' ? 0 : 1;
  return {
    ok, befund,
    was_ist: t ? t.was_ist[i] : '',
    was_tun: t ? t.was_tun[i] : '',
    ...(einzelheit ? { einzelheit } : {}),
  };
}

/** Der ganze Strompfad im Schnelldurchlauf: Cloud-Ticket → Container-Sitzung
 *  (über die Relay-Adresse) → eigener Test-Kanal → Stream-Zugang → WHIP-Annahme
 *  → WHEP-Auslieferungsweg. Räumt den Test-Kanal selbst wieder weg.
 *  Rückgabe ist EIN Prüfschritt für die Checkliste. */
export async function medienRundtrip(opt: MedienRundtripOptionen): Promise<ProbeSchritt> {
  const sprache = opt.sprache ?? 'de';
  const basis = `https://${opt.relayHost}`;

  let ticket = '';
  try {
    const r = await fetch(`${opt.cloudOrigin}/api/auth/me/server-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: opt.sessionCookie },
      body: JSON.stringify({ hostname: opt.relayHost }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) ticket = ((await r.json()) as { ticket?: string }).ticket ?? '';
  } catch { /* Ticket-Falle unten */ }
  if (!ticket) {
    return schritt(false, 'kein-ticket', sprache,);
  }

  let sitzungsToken = '';
  try {
    const r = await fetch(`${basis}/api/chat/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) sitzungsToken = ((await r.json()) as { session_token?: string }).session_token ?? '';
  } catch { /* unten */ }
  if (!sitzungsToken) {
    return schritt(false, 'keine-sitzung', sprache);
  }
  const auth = { Authorization: `Bearer ${sitzungsToken}` };

  const anfrage = async (methode: string, pfad: string, koerper?: unknown) => {
    const r = await fetch(`${basis}${pfad}`, {
      method: methode,
      headers: { ...auth, ...(koerper !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: koerper !== undefined ? JSON.stringify(koerper) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* leer */ }
    return { status: r.status, json };
  };

  // Test-Kanal in einer Wegwerf-Community — wird am Ende komplett gelöscht.
  const g = await anfrage('POST', '/api/chat/guilds', { name: 'Verbindungs-Test' });
  const gid = (g.json as { id?: string }).id;
  if (!g.status || g.status >= 400 || !gid) {
    return schritt(false, 'kein-testkanal', sprache,);
  }
  try {
    const c = await anfrage('POST', `/api/chat/guilds/${gid}/channels`, { name: 'pruefung', type: 1, position: 0 });
    const cid = (c.json as { id?: string }).id;
    if (!cid) return schritt(false, 'kein-testkanal', sprache,);

    const t = await anfrage('POST', `/api/chat/channels/${cid}/stream-token`, { protocol: 'whip', slot: 0 });
    const pushUrl = (t.json as { push_url?: string }).push_url;
    if (t.status !== 200 || !pushUrl) {
      return schritt(false, 'kein-stream-token', sprache,);
    }

    const whip = await fetch(pushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: baueTestSdp('sendrecv', Date.now() % 1_000_000),
      signal: AbortSignal.timeout(10_000),
    });
    if (whip.status !== 201) {
      return schritt(false, 'whip-abgelehnt', sprache, `HTTP ${whip.status}`);
    }

    const wr = await anfrage('GET', `/api/chat/channels/${cid}/whep?user_id=${(g.json as { owner_id?: string }).owner_id ?? ''}`);
    const whepUrl = (wr.json as { whep_url?: string }).whep_url;
    if (wr.status !== 200 || !whepUrl) {
      return schritt(false, 'whep-fehlt', sprache,);
    }
    const whep = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: baueTestSdp('recvonly', Date.now() % 1_000_000),
      signal: AbortSignal.timeout(10_000),
    });
    // 200/201 = Auslieferung bereit; 404 „no stream" ist hier ERFOLG: der
    // Probe-Anruf enthält keine echten Medien, also meldet der Stream-Server
    // korrekt, dass noch nichts läuft — der Weg selbst steht.
    const wegSteht = whep.status === 200 || whep.status === 201 ||
      (whep.status === 404 && (await whep.text()).includes('no stream is available'));
    if (!wegSteht) {
      return schritt(false, 'whep-abgelehnt', sprache, `HTTP ${whep.status}`);
    }
    return schritt(true, 'rundtrip', sprache);
  } finally {
    // Wegwerf-Community löschen (kanalisiert MediaMTX-Reste mit ab).
    await anfrage('DELETE', `/api/chat/guilds/${gid}`).catch(() => undefined);
  }
}
