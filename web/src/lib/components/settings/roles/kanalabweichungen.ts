/**
 * „Wie viele Kanaele verlieren ihre Abweichung, wenn diese Rolle faellt?"
 *
 * Die Loeschrueckfrage soll benennen, was sie kostet. Der Mitgliederteil
 * steht in `traeger.svelte.ts`; hier der Kanalteil.
 *
 * Ermittelt wird er aus den vorhandenen Wegen: Kanalliste ueber den
 * Gilden-Store, Abweichungen ueber den Kanalrechte-Store (der zwischen-
 * speichert, ein zweites Oeffnen kostet also nichts). Faellt IRGENDEIN
 * Teilschritt aus, gibt die Funktion `null` — dann nennt die Rueckfrage
 * gar keine Zahl. Eine zu niedrige Zahl waere hier das Schlimmste: sie
 * liest sich wie eine Entwarnung.
 */

import { guilds } from '$lib/stores/guilds.svelte';
import { channelPermissions } from '$lib/stores/channelPermissions.svelte';

export async function kanaeleMitAbweichung(
  guildId: string,
  roleId: string
): Promise<number | null> {
  try {
    const kanaele = await guilds.ensureChannels(guildId);
    const listen = await Promise.all(kanaele.map((k) => channelPermissions.ensure(k.id)));
    let n = 0;
    for (const overwrites of listen) {
      // target_type 0 = Rolle (1 = einzelnes Mitglied).
      if (overwrites.some((ow) => ow.target_type === 0 && ow.target_id === roleId)) n++;
    }
    return n;
  } catch {
    return null;
  }
}
