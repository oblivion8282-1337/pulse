/**
 * Die Hülle, in der ein Ablage-Wert bei der eigenen Plattform ankommt.
 *
 * **Zwei Wege, eine Tür.** Hinunter an Player oder Sidecar geht sowohl ein
 * Rahmen der Gegenseite (`_signal`) als auch ein interner Anstoss des eigenen
 * Renderers (`neuBitte`, `stop`) — beides über `gsr:ablage`. Der Leitungsweg
 * reicht dabei die **rohe** Nutzlast der Gegenstelle durch: das Format lebt an
 * genau einer Stelle im Baum (`streaming/pulse-ablage`), und eine zweite
 * Prüfung hier liefe auseinander.
 *
 * **Deshalb die Hülle statt eines Filters.** Trügen die Anstösse dieselbe Form
 * wie ein Rahmen, genügte ein einziges fremdes `remote_signal`, um sie
 * auszulösen — ein `ende` schaltete die Zwischenablage für den Rest der Sitzung
 * ab, ohne Log und ohne sichtbare Ursache. Ein Filter fängt das heute; die
 * Hülle macht es strukturell unmöglich, weil fremde Nutzlast **immer** unter
 * `rahmen` liegt und ein Anstoss dort niemals hinkommt. Dieselbe Form tragen
 * Plan 1b-2 und 1c, wo die Anstösse an den Host-Sidecar gehen.
 *
 * Gegenstück: `streaming/pulse-player/src/app/ablage/lage.rs::deuten`.
 *
 * **Importfrei mit Absicht** — `pnpm test:unit` fährt Nodes eingebauten Läufer,
 * und der löst einen erweiterungslosen Laufzeit-Import nicht auf.
 */

/** Die beiden Anstösse, die nur der eigene Renderer schickt. */
export type Anstoss = 'ende' | 'neu_bitte';

/** Ein interner Anstoss an die eigene Plattform. */
export function anstossHuelle(anstoss: Anstoss): unknown {
  return { anstoss };
}

/** Ein Rahmen der Gegenseite, Nutzlast unverändert und ungedeutet. */
export function leitungsHuelle(rahmen: unknown): unknown {
  return { rahmen };
}
