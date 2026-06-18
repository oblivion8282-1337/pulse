// Host-Lifecycle: verkettet ① + ②b zu einer menschlichen Phasen-Sequenz.
// classifyHostOutcome ist die reine Entscheidung nach der Diagnose — voll testbar.

export type HostPhase =
  | 'idle' | 'checking-network' | 'opening-door' | 'preparing'
  | 'going-live' | 'live' | 'needs-your-help' | 'not-possible-here' | 'something-paused';

export interface HostPhaseEvent {
  phase: HostPhase;
  detail?: { relayUrl?: string; ports?: number[] };
}

export type ReachVerdict = 'reachable' | 'needs-forwarding' | 'cgnat' | 'unknown';
export type MapVerdict = 'mapped' | 'partial' | 'cgnat' | 'unsupported';

export function classifyHostOutcome(
  reach: ReachVerdict, map: MapVerdict | null,
): { outcome: 'go' | 'needs-your-help' | 'not-possible-here' | 'something-paused' } {
  if (reach === 'cgnat' || map === 'cgnat') return { outcome: 'not-possible-here' };
  if (reach === 'unknown') return { outcome: 'something-paused' };
  if (reach === 'reachable') return { outcome: 'go' };
  // reach === 'needs-forwarding': only a working port-mapping lets us host.
  if (map === 'mapped') return { outcome: 'go' };
  return { outcome: 'needs-your-help' };
}
