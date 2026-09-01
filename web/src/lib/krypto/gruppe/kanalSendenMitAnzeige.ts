/**
 * Senden in einen Ablage-Kanal, mit der Rückmeldung an den Nutzer — der
 * Zwilling zu `sendenMitAnzeige.ts` für private Gruppen, s. dort für die
 * volle Begründung „kein Klartext-Rückfall, deshalb kein stiller
 * Fehlschlag" (gilt hier genauso: der Server nimmt für Ablage-Kanäle auf
 * KEINEM Weg Klartext an, s. `kanalSenden.ts`-Modulkopf).
 *
 * Eigene Datei statt Erweiterung von `sendenMitAnzeige.ts`, weil der
 * Sendeweg selbst schon einen zusätzlichen Zustand braucht
 * (`KanalSitzungState`) — der Aufrufer (Chat-Seite) hätte sonst zwei
 * unterschiedlich geformte Einstiege für denselben Anzeige-Zweck.
 */
import { toast } from 'svelte-sonner';

import { messages } from '../../stores/messages.svelte';
import { m } from '../../paraglide/messages.js';
import { kanalSitzungState } from './kanalSitzungStore';

export async function kanalSendenMitAnzeige(
  guildId: string,
  kanalId: string,
  text: string,
  replyToId: string | null
): Promise<void> {
  const state = kanalSitzungState(guildId, kanalId);
  let ergebnis;
  try {
    const { sendeInKanal } = await import('./kanalSenden');
    ergebnis = await sendeInKanal(state, guildId, kanalId, text, replyToId);
  } catch (err) {
    toast.error(m.ablage_kanal_senden_fehlgeschlagen(), {
      description: (err as Error).message
    });
    return;
  }
  if (ergebnis.art === 'gesendet') {
    messages.upsert(ergebnis.nachricht);
    return;
  }
  // Dieselbe Zweiteilung wie bei privaten Gruppen: „nicht moeglich" = es
  // wurde NICHTS unternommen (Schalter aus, kein Geraeteschluessel) —
  // „nicht zugestellt" = verschluesselt und eingeliefert, aber niemand mit
  // veroeffentlichtem Geraet erreichbar.
  toast.error(
    ergebnis.art === 'nicht_zugestellt'
      ? m.ablage_kanal_senden_niemand_erreichbar()
      : m.ablage_kanal_senden_nicht_moeglich()
  );
}
