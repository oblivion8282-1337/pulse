/**
 * Kennt der lokale Verlauf diese Nachricht schon — gleich, unter welcher
 * ihrer beiden Kennungen?
 *
 * Der Anlass ist ein belegter Doppel-Befund (2026-09-02): dieselbe Nachricht
 * erreicht ein Geraet auf zwei Wegen, und die beiden Wege nennen sie
 * verschieden. Ueber das Postfach traegt die Zustellung ihre
 * ZUSTELLUNGS-ID; die Datei im Kanal-Ordner traegt dagegen die NUTZLAST-ID
 * (`ablage_kanal_ordner.py::datei_name` heisst `<nutzlastId>.puls`).
 * `verlaufSchonAbgelegt` schaut nur unter der einen nach und meldet bei der
 * anderen „neu" — der Nutzer sah die Nachricht danach zweimal.
 *
 * Was beide Wege teilen, ist die kanonische ID aus der Nutzlast selbst
 * (`krypto/nachrichtNutzlast.ts`). Sie liegt im Satz an einer von zwei
 * Stellen: als `nachrichtId`, wenn dieses Geraet die Nachricht selbst
 * gesendet hat, und als `kryptoId`, wenn es sie empfangen hat. Deshalb
 * beide Fragen.
 *
 * **Eigene Datei, nicht in `index.ts`**: die stand bereits ueber der
 * Groessen-Grenze (357 Z., PLAN.md §12.1) — und diese Rechnung braucht von
 * dort ohnehin nur die zwei fertigen Lesefunktionen. Ueber sie statt ueber
 * `db.ts` direkt, damit Kanal-Gate, Konto-Filter und das „wirft nie" nur an
 * EINER Stelle stehen.
 */
import { verlaufSchonAbgelegt, verlaufLokaleIdFuerKryptoId } from './index';

/** `true`, wenn `kanalId` einen Satz unter dieser kanonischen ID fuehrt —
 *  als eigene Nachrichten-ID ODER als Absender-Kennung eines empfangenen
 *  Satzes. Wirft nie: ein Lesefehler heisst „sicherheitshalber wie neu
 *  behandeln" (dieselbe Regel wie bei den beiden benutzten Funktionen). */
export async function verlaufKenntKanonischeId(kanalId: string, id: string): Promise<boolean> {
  if (await verlaufSchonAbgelegt(kanalId, id)) return true;
  return (await verlaufLokaleIdFuerKryptoId(kanalId, id)) !== null;
}
