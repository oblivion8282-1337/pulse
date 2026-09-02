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

import { messages } from '../../stores/messages.svelte';
import { m } from '../../paraglide/messages.js';

export async function gruppeSendenMitAnzeige(
  kanalId: string,
  text: string,
  replyToId: string | null
): Promise<void> {
  let ergebnis;
  try {
    const { sendeInGruppe } = await import('./senden');
    ergebnis = await sendeInGruppe(kanalId, text, replyToId);
  } catch (err) {
    toast.error(m.gruppe_senden_fehlgeschlagen(), {
      description: (err as Error).message
    });
    return;
  }
  if (ergebnis.art === 'gesendet') {
    messages.upsert(ergebnis.nachricht);
    return;
  }
  // Die beiden uebrigen Ausgaenge werden getrennt benannt, weil der Nutzer
  // Verschiedenes tun muss: „nicht moeglich" heisst, es wurde NICHTS
  // unternommen (Schalter aus, kein Geraeteschluessel, Gruppe weg) —
  // „nicht zugestellt" heisst, es wurde verschluesselt und eingeliefert,
  // aber kein Mitglied hat ein veroeffentlichtes Geraet.
  toast.error(
    ergebnis.art === 'nicht_zugestellt'
      ? m.gruppe_senden_niemand_erreichbar()
      : m.gruppe_senden_nicht_moeglich()
  );
}
