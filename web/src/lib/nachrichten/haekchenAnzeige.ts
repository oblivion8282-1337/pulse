/**
 * Die Hülle um `haekchen.ts`: liest die Stores und reicht der reinen Rechnung
 * nur Zahlen. Keine Rune hier — die Lesezugriffe auf die `$state`-Felder der
 * Stores werden trotzdem verfolgt, sobald ein `$derived` diese Funktionen
 * aufruft (`MessageItem.svelte`, `chat/NachrichtInfoDialog.svelte`).
 *
 * Wer Empfänger ist, entscheidet sich hier an EINER Stelle: in einer DM die
 * Gegenstelle, in einer Gruppe die Mitglieder zur Sendezeit. Community-
 * Kanäle haben keine Haken.
 */
import type { Message } from '$lib/api/types';
import { quittungen } from '$lib/stores/quittungen.svelte';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { privacy } from '$lib/stores/privacy.svelte';
import { lesestandAnker } from '$lib/stores/lesestandKern';
import {
  empfaengerZurSendezeit,
  haekchenStufe,
  infoJeEmpfaenger,
  type HaekchenStufe,
  type InfoStatus
} from './haekchen';

interface Treppe {
  anker: string;
  empfaenger: string[];
  gelesen: (konto: string) => string | undefined;
  zugestellt: (konto: string) => string | undefined;
  istGruppe: boolean;
}

function treppe(nachricht: Message, ich: string | undefined): Treppe | null {
  if (!ich || nachricht.author_id !== ich) return null;
  const kanal = nachricht.channel_id;
  const gruppe = privateGruppen.byId[kanal];
  const dm = gruppe ? undefined : directMessages.byId[kanal];
  if (!gruppe && !dm) return null;
  return {
    anker: lesestandAnker(nachricht),
    empfaenger: gruppe
      ? empfaengerZurSendezeit(gruppe.members, ich, nachricht.created_at)
      : [dm!.other_user_id],
    gelesen: (k) => quittungen.gelesenVon(kanal, k),
    zugestellt: (k) => quittungen.zugestelltBei(kanal, k),
    istGruppe: !!gruppe
  };
}

/** Die Stufe einer Nachricht; null, wo es keine Haken gibt (fremde
 *  Nachricht, Community-Kanal). */
export function haekchenFuer(nachricht: Message, ich: string | undefined): HaekchenStufe | null {
  const t = treppe(nachricht, ich);
  if (!t) return null;
  return haekchenStufe({
    ...t,
    vorlaeufig: nachricht.id.startsWith('tmp-'),
    nichtZugestellt: nachricht.nicht_zugestellt === true,
    // WhatsApp-Regel: wer seine Lesebestätigungen abschaltet, sieht in DMs
    // auch fremde nicht (der Server liefert sie dann ohnehin nicht);
    // Gruppen sind ausgenommen.
    blauErlaubt: t.istGruppe || privacy.current.lesebestaetigungen !== false
  });
}

/** Hat diese eigene Gruppennachricht eine Info-Ansicht? */
export function hatInfo(nachricht: Message, ich: string | undefined): boolean {
  return !nachricht.id.startsWith('tmp-') && treppe(nachricht, ich)?.istGruppe === true;
}

/** Je Empfänger der Stand, für die Info-Ansicht. */
export function infoFuer(
  nachricht: Message,
  ich: string | undefined
): { konto: string; status: InfoStatus }[] {
  const t = treppe(nachricht, ich);
  return t ? infoJeEmpfaenger(t) : [];
}
