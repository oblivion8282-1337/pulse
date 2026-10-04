/**
 * Senden in eine private Gruppe, mit der Rueckmeldung an den Nutzer (Etappe G).
 *
 * Steht neben `senden.ts` und nicht darin: jene Datei ist der reine Sendeweg
 * (Krypto, Postfach, lokale Ablage) und kennt weder Speicher noch Oberflaeche.
 * Und sie steht nicht in der Seite, weil die dort schon ueber der
 * Groessen-Policy waere.
 *
 * **Kein Klartext-Rueckfall, und deshalb kein stiller Fehlschlag.** Eine DM
 * darf bei fehlendem Geraet der Gegenseite unverschluesselt weiterlaufen
 * (`../senden.ts`, Koexistenz-Regel); eine Gruppe hat diesen Weg nicht
 * (Spec §9). Jeder Ausgang ausser „gesendet" muss deshalb sichtbar werden —
 * sonst verschwaende die Nachricht spurlos aus der Sicht des Absenders.
 *
 * Der dynamische Import haelt den Krypto-Kern (WASM) aus dem Start heraus,
 * wie an den anderen Aufrufstellen auch.
 */
import { toast } from 'svelte-sonner';

import type { AnhangAngabe } from '../nachrichtNutzlast';
import { messages } from '../../stores/messages.svelte';
import { m } from '../../paraglide/messages.js';

export async function gruppeSendenMitAnzeige(
  kanalId: string,
  text: string,
  replyToId: string | null,
  anhaenge: AnhangAngabe[] = []
): Promise<boolean> {  let ergebnis;
  try {
    const { sendeInGruppe } = await import('./senden');
    ergebnis = await sendeInGruppe(kanalId, text, replyToId, anhaenge);
  } catch (err) {
    // Menschen lesen diese Meldung, keine Schlüsselprotokolle: ein
    // unsigniertes Bündel ist ein „App dort einmal neu öffnen"-Fall und
    // bekommt NIE einen Geräte-Hash vorgesetzt (Befund 05.10.).
    const { BuendelUnsigniertFehler } = await import('../buendelSignatur');
    if (err instanceof BuendelUnsigniertFehler) {
      toast.error(m.gruppe_senden_altgeraet());
      return false;
    }
    toast.error(m.gruppe_senden_fehlgeschlagen(), {
      description: (err as Error).message
    });
    return false;
  }
  if (ergebnis.art === 'gesendet') {
    messages.upsert(ergebnis.nachricht);
    return true;
  }
  if (ergebnis.art === 'lokal_ohne_zustellung') {
    // Die Nachricht des Absenders bleibt stehen (der Store zeigt sie) —
    // ehrlich benannt: sie ist LOKAL da, aber kein Mitglied konnte sie
    // empfangen. Sobald ein Mitglied seine App neu veröffentlicht, holt
    // die nächste Nachricht alles nach.
    messages.upsert(ergebnis.nachricht);
    toast.warning(m.gruppe_senden_lokal_erfasst());
    return false;
  }
  // „nicht moeglich" heisst, es wurde NICHTS unternommen (Schalter aus,
  // kein Geraeteschluessel, Gruppe weg).
  toast.error(m.gruppe_senden_nicht_moeglich());
  return false;
}
