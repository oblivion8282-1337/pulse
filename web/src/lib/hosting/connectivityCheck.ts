/**
 * Anschluss-Check (Stufe 1, beratend) für den App-Host-Antragsweg.
 *
 * Browser-STUN-Probe: zwei RTCPeerConnections gegen zwei VERSCHIEDENE
 * öffentliche STUN-Server sammeln srflx-Kandidaten (= die öffentliche
 * Adresse, wie sie von außen aussieht). Aus den Ergebnissen wird
 * klassifiziert, ob der Anschluss fürs Hosting von zuhause taugt:
 *
 *  - 'blocked'   — kein srflx von beiden Servern: das Netzwerk lässt keine
 *                  Direktverbindungen zu (Firmen-Firewall, UDP geblockt).
 *  - 'cgnat'     — die öffentliche IP liegt im CGNAT-Bereich 100.64.0.0/10
 *                  (DS-Lite): eingehende Verbindungen sind unmöglich, nur
 *                  der Provider kann das ändern (Dual-Stack beantragen).
 *  - 'symmetric' — beide Server sehen dieselbe IP, aber deutlich
 *                  verschiedene Ports: symmetrisches NAT, WebRTC-Lochung
 *                  scheitert meist.
 *  - 'ok'        — gleiche IP, gleiche/nahe Ports: normales Cone-NAT,
 *                  die Server-App kann sich selbst durchlochen.
 *  - 'unknown'   — Fehler/Timeout: keine Aussage möglich (beratend —
 *                  der Antrag bleibt erlaubt).
 *
 * Die Klassifikation ist pur (testbar); die eigentliche RTC-Probe ist dünn
 * gehalten. Ergebnis wird als `network_check` mit dem Antrag gespeichert —
 * reine Info für den Admin, keine Server-Logik.
 */

export type NetworkCheckResult = 'ok' | 'cgnat' | 'symmetric' | 'blocked' | 'unknown';

export interface SrflxCandidate {
  ip: string;
  port: number;
}

/** Zwei unabhängige Betreiber, damit ein einzelner Ausfall nicht 'blocked'
 *  vortäuscht und symmetrisches NAT (Port pro Ziel) sichtbar wird. */
const STUN_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

const PROBE_TIMEOUT_MS = 5000;

/** Ports gelten als „nah", wenn sie ≤2 auseinanderliegen (sequentielle
 *  NAT-Port-Vergabe bei zwei kurz nacheinander geöffneten Sockets). */
const PORT_NEAR_DELTA = 2;

/** 100.64.0.0/10 (RFC 6598, Carrier-Grade NAT). */
export function isCgnatIp(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false; // IPv6-srflx → kein CGNAT-v4-Bereich
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Pure Klassifikation aus den srflx-Kandidaten beider Probes.
 * `probes[i]` = Kandidaten von STUN-Server i (leer = nichts gesehen).
 */
export function classifyProbes(probes: SrflxCandidate[][]): NetworkCheckResult {
  const flat = probes.flat();
  if (flat.length === 0) return 'blocked';
  if (flat.some((c) => isCgnatIp(c.ip))) return 'cgnat';

  const [a, b] = probes;
  // Nur ein Server hat geantwortet → keine Vergleichsbasis, aber es GIBT eine
  // öffentliche Adresse. Vorsichtig neutral bleiben statt falsch-grün.
  if (!a?.length || !b?.length) return 'unknown';

  const ipsA = new Set(a.map((c) => c.ip));
  const sameIp = b.some((c) => ipsA.has(c.ip));
  if (!sameIp) return 'unknown'; // z.B. v4/v6-Mix — keine belastbare Aussage

  // Gleiche IP: Port-Verhalten vergleichen. Deutlich verschiedene Ports pro
  // Ziel = symmetrisches NAT.
  const near = a.some((ca) =>
    b.some((cb) => cb.ip === ca.ip && Math.abs(cb.port - ca.port) <= PORT_NEAR_DELTA)
  );
  return near ? 'ok' : 'symmetric';
}

/** Eine RTCPeerConnection gegen EINEN STUN-Server; sammelt srflx-Kandidaten
 *  bis Gathering-Ende oder Timeout. Dünn gehalten — Logik steckt in
 *  classifyProbes. */
async function probeStun(url: string, timeoutMs: number): Promise<SrflxCandidate[]> {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: url }] });
  const found: SrflxCandidate[] = [];
  try {
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const c = ev.candidate;
        if (c.type === 'srflx' && c.address && c.port) {
          found.push({ ip: c.address, port: c.port });
        }
      };
    });
    pc.createDataChannel('probe');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await done;
  } catch {
    // Fehler → leere Liste; classifyProbes bewertet das.
  } finally {
    pc.close();
  }
  return found;
}

/** Führt die volle Probe gegen beide STUN-Server aus und klassifiziert. */
export async function runConnectivityCheck(
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<NetworkCheckResult> {
  try {
    const probes = await Promise.all(STUN_SERVERS.map((u) => probeStun(u, timeoutMs)));
    return classifyProbes(probes);
  } catch {
    return 'unknown';
  }
}
