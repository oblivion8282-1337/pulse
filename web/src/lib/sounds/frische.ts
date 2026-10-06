/**
 * Alters-Entscheidung für Gilden-Klang-Links (presigned S3-GETs).
 *
 * Der Server signiert die Links für 30 Minuten (`s3_presigned_ttl_seconds`,
 * chat-gateway config.py); der Store erneuert die Liste je Guild aber schon
 * nach 8 Minuten. Genau in dieser Lücke hing der Stille-Fehler vom
 * 2026-10-06: „veraltet" warf den Link weg, der Ersatzklang fehlte auf
 * Maschinen ohne gebündelte Stream-Klänge — und jeder Streamstart zwischen
 * Minute 8 und der frischen Liste blieb lautlos (8-Minuten-Rhythmus).
 *
 * Die Regel jetzt: Ein Link wird gespielt, solange seine Signatur
 * nachweislich noch reicht (TTL minus Sicherheitspuffer). Ab 8 Minuten
 * läuft die Erneuerung daneben; erst kurz vor Signaturende wird wirklich
 * geschwiegen — und diesen einen Fall fängt die Sound-Engine inzwischen
 * selbst (Refresh + Fallback, siehe engine.ts onLoadFail).
 */

/** Server-Default: `s3_presigned_ttl_seconds = 1800` (config.py). */
export const PRESIGN_TTL_S = 1800;
/** Sicherheitspuffer vor dem Signaturende (Uhr-Drift, Netz-Latenz). */
export const PRESIGN_MARGIN_S = 60;
/** Ab diesem Alter holt der Store die Liste nebenbei frisch. */
export const REFRESH_AFTER_S = 480;

export type KlangLinkUrteil = { spielen: boolean; erneuern: boolean };

/** Rein funktional, damit der 8-Minuten-Rhythmus testbar bleibt — der
 *  Store selbst ist `$state`-basiert und vom Node-Testläufer nicht ladbar. */
export function klangLinkUrteil(alterS: number): KlangLinkUrteil {
  return {
    spielen: alterS <= PRESIGN_TTL_S - PRESIGN_MARGIN_S,
    erneuern: alterS > REFRESH_AFTER_S
  };
}
