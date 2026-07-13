/**
 * Anschluss-Check (Stufe 1) für den App-Host-Antragsweg — auf die EINZIGE
 * wertvolle Aussage eingedampft (Entscheidung 2026-07-13, Variante B):
 * Kann dieser Internetanschluss physikalisch NICHT von zuhause hosten
 * (DS-Lite/CGNAT oder gar keine Direktverbindung)? Alles andere (Cone- vs.
 * symmetrisches NAT, "geeignet", "unbekannt") ist für den User irrelevant —
 * die Server-App locht sich in diesen Fällen selbst durch.
 *
 * Browser-STUN-Probe: EINE RTCPeerConnection fragt bei ZWEI öffentlichen
 * STUN-Servern die eigene öffentliche Adresse ab (srflx-Kandidaten). Zwei
 * Server, damit ein einzelner Ausfall kein falsches 'cannot-host' vortäuscht.
 *
 *  - kein srflx (Gathering fertig) → 'cannot-host' (Netzwerk lässt keine
 *    Direktverbindung zu: Firewall, UDP geblockt).
 *  - srflx in 100.64.0.0/10        → 'cannot-host' (DS-Lite/CGNAT: eingehende
 *    Verbindungen unmöglich, nur der Provider kann das ändern).
 *  - sonst / Timeout / Fehler / kein WebRTC → 'ok' (kein Hindernis erkennbar;
 *    beim geringsten Zweifel NICHT warnen).
 *
 * Die Klassifikation ist pur (testbar); die RTC-Probe ist dünn gehalten.
 * Das Ergebnis wird als `network_check` mit dem Antrag gespeichert.
 */

export type HostingVerdict = 'cannot-host' | 'ok';

/**
 * Wire-Wert fürs Backend-`network_check`-Feld (dessen Literal-Set bleibt
 * unverändert). Der Admin-Chip rendert daraus "geeignet"/"ungeeignet";
 * 'cannot-host' geht als 'cgnat' raus — der kanonische "kann nicht von
 * zuhause hosten"-Verdict (der Chip behandelt cgnat/blocked/symmetric gleich).
 */
export function networkCheckWireValue(v: HostingVerdict): 'ok' | 'cgnat' {
  return v === 'cannot-host' ? 'cgnat' : 'ok';
}

/** Zwei unabhängige Betreiber: ein einzelner Ausfall täuscht kein
 *  'cannot-host' vor (leere srflx-Liste). */
const STUN_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

const PROBE_TIMEOUT_MS = 5000;

/** 100.64.0.0/10 (RFC 6598, Carrier-Grade NAT). */
export function isCgnatIp(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false; // IPv6-srflx → kein CGNAT-v4-Bereich
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Pure Klassifikation aus den srflx-IPs EINER (fertig gegatherten) Probe:
 * keine srflx → 'cannot-host'; eine CGNAT-IP → 'cannot-host'; sonst 'ok'.
 * Nur aufrufen, wenn das Gathering natürlich endete (kein Timeout) — sonst
 * würde eine langsame Probe fälschlich als geblockt gewertet.
 */
export function classifySrflx(ips: string[]): HostingVerdict {
  if (ips.length === 0) return 'cannot-host';
  if (ips.some((ip) => isCgnatIp(ip))) return 'cannot-host';
  return 'ok';
}

/** Sammelt srflx-IPs aus EINER RTCPeerConnection gegen BEIDE STUN-Server.
 *  ``completed`` = das ICE-Gathering endete natürlich (null-Kandidat), NICHT
 *  per Timeout — nur dann ist "keine srflx" belastbar (= geblockt). */
async function gatherSrflx(
  urls: string[],
  timeoutMs: number
): Promise<{ ips: string[]; completed: boolean }> {
  const pc = new RTCPeerConnection({ iceServers: urls.map((u) => ({ urls: u })) });
  const ips: string[] = [];
  let completed = false;
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          completed = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        const c = ev.candidate;
        if (c.type === 'srflx' && c.address) ips.push(c.address);
      };
    });
    pc.createDataChannel('probe');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  } catch {
    // Fehler → completed bleibt false → runConnectivityCheck wertet 'ok'.
  } finally {
    pc.close();
  }
  return { ips, completed };
}

/** Führt die Probe aus und klassifiziert. Timeout/Fehler/kein WebRTC → 'ok'
 *  (im Zweifel NICHT warnen). */
export async function runConnectivityCheck(
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<HostingVerdict> {
  if (typeof RTCPeerConnection === 'undefined') return 'ok';
  try {
    const { ips, completed } = await gatherSrflx(STUN_SERVERS, timeoutMs);
    if (!completed) return 'ok';
    return classifySrflx(ips);
  } catch {
    return 'ok';
  }
}
