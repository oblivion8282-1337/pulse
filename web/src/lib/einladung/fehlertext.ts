// Ordnet eine Server-Antwort einer Fehlerart zu — importfrei (Node-Tests).
//
// Nur ein 404 heißt „Diese Einladung gilt nicht mehr“. Der Prototyp machte
// aus jedem Fehler „ungültig“ — auch aus einem Netzaussetzer und aus der
// E-Mail-Sperre, die den GANZEN chat-gateway für unbestätigte Konten mit 403
// schließt (dcc_shared/token_verify.py).

export type EinladungFehler =
  | 'ungueltig'
  | 'email'
  | 'ausgeschlossen'
  | 'gesperrt'
  | 'voll'
  | 'bremse'
  | 'abgelehnt'
  | 'netz';

export function einladungFehler(status: number | null, detail: unknown): EinladungFehler {
  const d = typeof detail === 'string' ? detail : '';
  if (status === 404) return 'ungueltig';
  if (status === 429) return 'bremse';
  if (status === 403) {
    if (d === 'email verification required') return 'email';
    if (d === 'you are banned from this server') return 'ausgeschlossen';
    if (d === 'community is suspended') return 'gesperrt';
    if (/^community \S+ limit reached/.test(d)) return 'voll';
    return 'abgelehnt';
  }
  return 'netz';
}
