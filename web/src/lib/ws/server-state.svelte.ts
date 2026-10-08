/**
 * Reactive Bridge für GatewayConnection.state — Phase 4.3.
 *
 * `gateway-connection.ts` hält `state` als plain Property (kein $state) damit
 * der Konstruktor nicht an Svelte-Runes gekoppelt ist (Tests, evtl. Worker-
 * Re-Use). Diese Brücke pollt 1×/Sekunde alle bekannten Pool-Connections und
 * exposed das als `$state`-Map für UI-Banner & Status-Dots.
 *
 * Poll statt Abonnement: die State-Transitions sind selten (open ↔
 * incompatible ↔ updating ↔ ...), und 1 Hz reicht für Banner und Punkte. Der
 * Poll deckt dabei beiläufig mit ab, dass eine Verbindung LAZY entsteht — er
 * läuft über `serversStore.servers`, nicht über den Pool-Inhalt.
 *
 * **Das bleibt die EINZIGE Spiegelung.** Beim Bau des Offline-Streifens
 * (2026-10-08, iOS-Punkt 37) entstand daneben kurz eine zweite, mit einem
 * eigenen Melder-Mechanismus in `gateway-connection.ts` — weil der Streifen
 * den Augenblick eines Wechsels braucht, um seine Geduldsfrist zu messen.
 * Beides ist wieder weg: der Poll liefert den Augenblick auf 1 s genau, und
 * eine Geduld von 4 s ist eine Höflichkeitsfrist, kein Vertrag. Der Satz
 * „wer eine dritte Spiegelung braucht, nimmt eine der beiden" stand hier
 * vorher schon — er hatte recht.
 *
 * Dafür trägt der Schnappschuss seit 2026-10-08 zwei Felder mehr:
 *  - `gewollt` (= `wantConnected`), damit ein GEWOLLTER Abbau (Server-Wechsel,
 *    Abmelden) nicht als Verlust erscheint;
 *  - `seit`, der Beginn der aktuellen Strecke — **nicht** der letzte
 *    Zustandswechsel. Eine Strecke ist ein zusammenhängender Abschnitt mit
 *    gleicher Offenheit: entweder durchgehend `open` oder durchgehend nicht.
 *    Innerhalb eines Abrisses darf der Zustand also von `closed` auf
 *    `connecting` und zurück wandern, ohne die Uhr zu stellen. Genau daran
 *    hing ein Flackern des Offline-Streifens (rot → nichts → gelb), und es
 *    liess sich hier an der Wurzel beheben statt in der Regel mit einem
 *    Gedächtnis. **`helloMeta` zählt nicht mit**: es kommt kurz nach `open`
 *    nach, und ein Zurücksetzen dabei hätte die Geduld bei jedem Verbinden
 *    neu gestartet.
 */
import { gatewayPool } from './gateway-pool.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import type { ConnectionState, HelloMeta } from './gateway-connection';

type Snapshot = {
  state: ConnectionState;
  helloMeta: HelloMeta | null;
  /** `wantConnected` der Verbindung; ohne Verbindung `false`. */
  gewollt: boolean;
  /** Beginn der aktuellen Strecke: seit wann ist die Verbindung
   *  durchgehend offen beziehungsweise durchgehend nicht offen? */
  seit: number;
};

const POLL_MS = 1000;

class ServerStateMirror {
  /** serverId → snapshot. Reactive via $state. */
  byId = $state<Record<string, Snapshot>>({});
  /** Non-reactive shadow of the last published `byId`, used purely for change
   *  detection. Diffing against the reactive `byId` proxy would compare a
   *  proxied `helloMeta` against the raw `conn.helloMeta` (different
   *  identities) → state_proxy_equality_mismatch warning every poll *and* a
   *  false "changed", which reassigned `byId` 1×/s in steady state. Compare
   *  raw-vs-raw here instead. */
  #last: Record<string, Snapshot> = {};
  #timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.#timer) return;
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), POLL_MS);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Manuell triggern (z.B. unmittelbar nach connect/disconnect). */
  refresh(): void {
    const next: Record<string, Snapshot> = {};
    let changed = false;
    for (const entry of serversStore.servers) {
      const conn = gatewayPool.peek(entry.id);
      const prev = this.#last[entry.id];
      const zustand: ConnectionState = conn ? conn.state : 'idle';
      const snapshot: Snapshot = {
        state: zustand,
        helloMeta: conn ? conn.helloMeta : null,
        gewollt: conn ? conn.gewollt : false,
        // Die Uhr stellt nur ein Wechsel der OFFENHEIT — nicht jeder
        // Zustandswechsel, nicht ein nachkommendes `helloMeta`, nicht
        // `gewollt`. Begründung im Kopf dieser Datei.
        seit:
          prev && (prev.state === 'open') === (zustand === 'open')
            ? prev.seit
            : Date.now()
      };
      next[entry.id] = snapshot;

      if (
        !prev ||
        prev.state !== snapshot.state ||
        prev.helloMeta !== snapshot.helloMeta ||
        prev.gewollt !== snapshot.gewollt
      ) {
        changed = true;
      }
    }
    // Server removed since last poll? Key count shrank → publish the new set.
    if (!changed && Object.keys(next).length !== Object.keys(this.#last).length) {
      changed = true;
    }

    // Only reassign if something actually changed, avoiding reactive diffing on steady-state.
    if (changed) {
      this.#last = next;
      this.byId = next;
    }
  }

  /** Snapshot für eine einzelne Connection. */
  get(serverId: string): Snapshot {
    return (
      this.byId[serverId] ?? { state: 'idle', helloMeta: null, gewollt: false, seit: 0 }
    );
  }
}

export const serverState = new ServerStateMirror();
