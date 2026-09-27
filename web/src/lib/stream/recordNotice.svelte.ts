/**
 * Aufnahme-Hinweis — beide Seiten des selben Ereignisses.
 *
 * ZUSCHAUER-Seite: der einmalige Hinweis-Dialog vor der ersten Aufnahme
 * („Du nimmst auf, der Streamer wird informiert") und das Melden von
 * Start/Stopp/Clip über die Gateway-Verbindung des Servers, auf dem der
 * Kanal liegt.
 *
 * STREAMER-Seite: der Live-Zustand „wird aufgenommen" je Kanal, gespeist aus
 * dem `stream_record`-Ereignis des Servers. Der Chip in der StreamStatusBar
 * liest ihn; das Ereignis selbst landet in `handlers/stream.ts`.
 *
 * Live-only: ein Zustand verfällt mit der Verbindung des Zuschauers (der
 * Server meldet das Ende nach) — nach einem Neustart der App beginnt die
 * Welt bei null. Das ist die Entscheidung vom 2026-09-27, kein Versehen.
 */

import { gatewayForServer } from '$lib/ws/connection';

// ── Streamer-Seite: wer nimmt gerade auf welchem Kanal auf ──────────────────

/** Kanal → Nutzer-IDs mit laufender Aufnahme (nur lokal, kein Persistenzweg). */
const aktiv = $state(new Map<string, Set<string>>());

export const recordNotice = {
  /** Anzahl laufender Aufnahmen im Kanal — 0 heißt: kein Chip. */
  anzahl(channelId: string | null): number {
    if (!channelId) return 0;
    return aktiv.get(channelId)?.size ?? 0;
  },

  /** Ein `stream_record`-Ereignis anwenden (Zustand; die OS-Meldung macht der Handler). */
  apply(channelId: string, fromUserId: string, recording: boolean, clip: boolean): void {
    if (clip) return; // einmalig, kein Zustand
    const menge = aktiv.get(channelId) ?? new Set<string>();
    if (recording) menge.add(fromUserId);
    else menge.delete(fromUserId);
    if (menge.size === 0) aktiv.delete(channelId);
    else aktiv.set(channelId, menge);
  },

  /** Beim Streamende aufräumen — der Zustand gehört zum laufenden Stream. */
  clear(channelId: string): void {
    aktiv.delete(channelId);
  },
};

// ── Zuschauer-Seite: einmaliger Hinweis + Meldung nach draußen ──────────────

const HINWEIS_KEY = 'pulse.record-hint-accepted';

/** Zustand des einmaligen Hinweis-Dialogs (Zuschauer) — immer ein Objekt,
 *  `offen` entscheidet. `entscheiden` ist ein No-Op-Platzhalter, bis der
 *  Dialog offen ist (mehrfaches Oeffnen loest die alte Instanz ab). */
export const recordHinweis = $state({
  offen: false,
  merken: false,
  entscheiden: (_ok: boolean) => {},
});

/** Zeigt den Hinweis vor der ERSTEN Aufnahme — einmal, dann nie wieder.
 *  Löst `false`, wenn der Zuschauer abbricht (dann wird nicht aufgenommen). */
export function einmalHinweis(): Promise<boolean> {
  try {
    if (localStorage.getItem(HINWEIS_KEY) === '1') return Promise.resolve(true);
  } catch {
    // localStorage weg (Privacy-Modus o. ä.) — dann eben jedes Mal fragen.
  }
  return new Promise((resolve) => {
    recordHinweis.merken = false;
    recordHinweis.offen = true;
    recordHinweis.entscheiden = (ok: boolean) => {
      recordHinweis.offen = false;
      recordHinweis.entscheiden = () => {};
      if (ok && recordHinweis.merken) {
        try {
          localStorage.setItem(HINWEIS_KEY, '1');
        } catch {
          /* dann eben jedes Mal fragen */
        }
      }
      resolve(ok);
    };
  });
}

/** Start/Stopp/Clip dem Server melden — auf der Verbindung des Kanals-Servers.
 *  Best effort: geht die Meldung verloren, verfällt sie lautlos (live-only). */
export function streamRecordMelden(
  serverId: string | null,
  channelId: string,
  recording: boolean,
  clip = false,
): void {
  const conn = gatewayForServer(serverId ?? '');
  if (!conn || !conn.sendStreamRecord(channelId, recording, clip)) {
    console.warn('[record] Meldung ging nicht hinaus (Verbindung zu?)');
  }
}
