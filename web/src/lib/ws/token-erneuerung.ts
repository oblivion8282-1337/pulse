/**
 * Wann ein offener Socket sein Token austauscht — die reine Rechnung.
 *
 * Hintergrund: der Gateway bindet die Lebensdauer eines Sockets an das ``exp``
 * seines Tokens und schliesst beim Ablauf mit 4001. Der Klient verband dann
 * neu — und weil der Abbau des letzten Sockets sofort ``presence_update
 * (online=False)`` meldet, verschwand dabei **jeder Nutzer im Token-Takt** für
 * ein bis zwei Sekunden aus den Listen der anderen (Cloud 15 min, Self-Host
 * 5 min). Statt neu zu verbinden schiebt der Klient jetzt vor Ablauf ein
 * frisches Token nach (``token_refresh``), der Server verschiebt nur seinen
 * Wecker.
 *
 * **Diese Datei ist bewusst importfrei** — sie läuft so unter Nodes eingebautem
 * Testläufer (`pnpm test:unit`), der erweiterungslose Laufzeit-Importe nicht
 * auflösen kann (s. CLAUDE.md). Alles, was Tokens, Sockets oder Stores
 * anfasst, bleibt in `gateway-connection.ts`.
 */

/** Vorlauf vor dem Ablauf. Muss den Refresh-Roundtrip zum auth-svc UND einen
 *  Fehlversuch samt Wiederholung tragen — deshalb eine Minute und nicht ein
 *  paar Sekunden. Gleicher Wert wie der proaktive Self-Host-Refresh in
 *  `api/self-host-reauth.ts`, aus demselben Grund. */
export const RENEW_LEAD_MS = 60_000;

/** Untergrenze: ein Token, das schon im Vorlauf-Fenster steht (Reconnect mit
 *  fast abgelaufenem Token), wird sofort erneuert — aber nie synchron im
 *  selben Tick, damit die Verbindung erst fertig aufgebaut ist. */
export const RENEW_MIN_DELAY_MS = 1_000;

/** Nach einem fehlgeschlagenen Refresh (Netz weg) noch einmal versuchen,
 *  solange Zeit bleibt. Schlägt auch das fehl, läuft der Socket wie früher in
 *  den 4001-Ablauf und der gewöhnliche Reconnect heilt. */
export const RENEW_RETRY_MS = 15_000;

/**
 * Verzögerung bis zur nächsten Erneuerung, in Millisekunden.
 *
 * `null` heisst „nie erneuern": kein `exp` im Token — dann stellt der Server
 * auch keinen Wecker, es gibt nichts zu verschieben.
 */
export function erneuerungsAbstandMs(
  expSekunden: number | null | undefined,
  jetztMs: number
): number | null {
  if (typeof expSekunden !== 'number' || !Number.isFinite(expSekunden)) return null;
  const zielMs = expSekunden * 1000 - RENEW_LEAD_MS;
  return Math.max(RENEW_MIN_DELAY_MS, zielMs - jetztMs);
}

/**
 * Lohnt ein Wiederholversuch nach einem gescheiterten Refresh?
 *
 * Nur wenn das alte Token danach noch gilt — sonst ist der Socket ohnehin weg,
 * bevor die Wiederholung ankommt, und ein Versuch ins Leere kostet nur einen
 * weiteren Refresh-Sturm gegen einen gerade nicht erreichbaren auth-svc.
 */
export function wiederholungLohnt(
  expSekunden: number | null | undefined,
  jetztMs: number
): boolean {
  if (typeof expSekunden !== 'number' || !Number.isFinite(expSekunden)) return false;
  return expSekunden * 1000 - jetztMs > RENEW_RETRY_MS;
}
