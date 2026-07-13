/**
 * Anschluss-Check (Stufe 1, beratend) für den App-Host-Antragsweg.
 *
 * Browser-STUN-Probe: EINE RTCPeerConnection fragt aus DEMSELBEN lokalen
 * Quell-Port bei ZWEI verschiedenen öffentlichen STUN-Servern die eigene
 * öffentliche Adresse ab (srflx-Kandidaten). Aus den Ergebnissen wird
 * klassifiziert, ob der Anschluss fürs Hosting von zuhause taugt:
 *
 *  - 'blocked'   — kein srflx: das Netzwerk lässt keine Direktverbindungen zu
 *                  (Firmen-Firewall, UDP geblockt).
 *  - 'cgnat'     — die öffentliche IP liegt im CGNAT-Bereich 100.64.0.0/10
 *                  (DS-Lite): eingehende Verbindungen sind unmöglich, nur
 *                  der Provider kann das ändern (Dual-Stack beantragen).
 *  - 'symmetric' — vom SELBEN lokalen Port sehen die zwei STUN-Server deutlich
 *                  VERSCHIEDENE öffentliche Ports: destination-abhängiges
 *                  Mapping = symmetrisches NAT, WebRTC-Lochung scheitert meist.
 *  - 'ok'        — vom selben lokalen Port sehen beide Server denselben (oder
 *                  einen nahen) Port: endpoint-unabhängiges Cone-NAT, die
 *                  Server-App kann sich selbst durchlochen.
 *  - 'unknown'   — Fehler/Timeout/nur IPv6: keine Aussage möglich (beratend —
 *                  der Antrag bleibt erlaubt).
 *
 * WICHTIG (Fix 2026-07-13): Symmetrisches NAT ist ein DESTINATION-abhängiges
 * Mapping — es lässt sich NUR erkennen, wenn beide STUN-Anfragen vom GLEICHEN
 * lokalen Quell-Port ausgehen. Die frühere Variante öffnete pro STUN-Server
 * eine eigene RTCPeerConnection (= eigener lokaler Port); der Router vergibt
 * dann auch bei Full-Cone-NAT zwei verschiedene öffentliche Ports — die Probe
 * stempelte damit JEDEN Anschluss fälschlich als 'symmetric' ab (inkl. der
 * bewiesenen Full-Cone-Fritz!Box). Deshalb: eine PC, gruppiert nach lokalem
 * Quell-Port (``base`` = relatedPort), Ports nur INNERHALB einer Gruppe
 * vergleichen.
 *
 * Die Klassifikation ist pur (testbar); die eigentliche RTC-Probe ist dünn
 * gehalten. Ergebnis wird als `network_check` mit dem Antrag gespeichert —
 * reine Info für den Admin, keine Server-Logik.
 */

export type NetworkCheckResult = 'ok' | 'cgnat' | 'symmetric' | 'blocked' | 'unknown';

export interface SrflxCandidate {
  ip: string;
  port: number;
  /** relatedPort — der lokale Quell-Port, aus dem dieser srflx entstand.
   *  Nur srflx MIT GLEICHEM base sind für die Symmetrie-Frage vergleichbar. */
  base: number;
}

/** Zwei unabhängige Betreiber: ein einzelner Ausfall täuscht kein 'blocked'
 *  vor, und vom selben lokalen Port wird destination-abhängiges Port-Mapping
 *  (symmetrisches NAT) sichtbar. */
const STUN_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

const PROBE_TIMEOUT_MS = 5000;

/** Ports gelten als „nah", wenn sie ≤2 auseinanderliegen (Toleranz gegen
 *  minimale Port-Verschiebung mancher Cone-NATs). */
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
 * Pure Klassifikation aus den srflx-Kandidaten EINER Probe (eine PC, beide
 * STUN-Server). Vergleicht öffentliche Ports nur zwischen srflx mit gleichem
 * lokalen Quell-Port (``base``) — nur dort beweist ein Port-Unterschied
 * destination-abhängiges (symmetrisches) NAT.
 */
export function classifySrflx(cands: SrflxCandidate[]): NetworkCheckResult {
  if (cands.length === 0) return 'blocked';
  if (cands.some((c) => isCgnatIp(c.ip))) return 'cgnat';

  // Nur IPv4 bewerten — die Server-App locht über IPv4 (Fritz!Box blockt
  // eingehendes IPv6). Nur-IPv6-srflx → keine belastbare Aussage.
  const v4 = cands.filter((c) => c.ip.split('.').length === 4);
  if (v4.length === 0) return 'unknown';

  // Nach lokalem Quell-Port gruppieren (multi-homed / mehrere Interfaces
  // liefern je eigene base — die dürfen NICHT gegeneinander verglichen werden).
  const portsByBase = new Map<number, number[]>();
  for (const c of v4) {
    const arr = portsByBase.get(c.base) ?? [];
    arr.push(c.port);
    portsByBase.set(c.base, arr);
  }

  for (const ports of portsByBase.values()) {
    const spread = Math.max(...ports) - Math.min(...ports);
    if (spread > PORT_NEAR_DELTA) return 'symmetric';
  }
  return 'ok';
}

/** Sammelt srflx-Kandidaten aus EINER RTCPeerConnection gegen BEIDE
 *  STUN-Server (gleicher lokaler Quell-Port → symmetrie-tauglich). Dünn
 *  gehalten — die Logik steckt in classifySrflx. */
async function gatherSrflx(urls: string[], timeoutMs: number): Promise<SrflxCandidate[]> {
  const pc = new RTCPeerConnection({ iceServers: urls.map((u) => ({ urls: u })) });
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
          // relatedPort = der lokale Quell-Port (base). Fehlt er (selten),
          // 0 als gemeinsamer Bucket — auf Single-Interface-Geräten korrekt.
          found.push({ ip: c.address, port: c.port, base: c.relatedPort ?? 0 });
        }
      };
    });
    pc.createDataChannel('probe');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await done;
  } catch {
    // Fehler → leere Liste; classifySrflx bewertet das.
  } finally {
    pc.close();
  }
  return found;
}

/** Führt die Probe aus und klassifiziert. */
export async function runConnectivityCheck(
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<NetworkCheckResult> {
  try {
    const cands = await gatherSrflx(STUN_SERVERS, timeoutMs);
    return classifySrflx(cands);
  } catch {
    return 'unknown';
  }
}
