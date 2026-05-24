/**
 * Tamagotchi-Plugin frontend entry — Pulse Plugin-System Schritt-7 reference.
 *
 * Bindet drei Plugin-Punkte zusammen:
 *
 * 1. **Settings-Section** ``'tamagotchi'`` (Schritt 3) — hält den Pet-State
 *    pro User in `localStorage` + serverseitig in `user_preferences`
 *    (Schritt 3b, Cross-Device). `onSignOut: 'reset'` setzt den Pet
 *    zurück, sobald ein anderer User auf dem Gerät einloggt.
 *
 *    Hinweis zur Aktivierung: Seit dem Plugin-Admin-Aktivierungs-PR ist
 *    die **Aktivierung** von Tamagotchi pro Guild (Server-Admin mit
 *    `MANAGE_GUILD`). Der **State** (das Haustier selbst) bleibt aber
 *    weiterhin per-User — ein User hat ein Tamagotchi, egal auf wie
 *    vielen Servern es freigeschaltet ist. Pro-Guild-Pets (separate Pets
 *    pro Server) wären eine spätere PR.
 *
 * 2. **WS-Handler** für `tamagotchi:ack` (Schritt 2c) — empfängt die
 *    Server-Bestätigung jeder Aktion und loggt sie.
 *
 * 3. **WS-Outbound** über `gateway.sendPluginOp` — die Aktion läuft dem
 *    optimistischen Client-Update *parallel* hinterher. Seit dem
 *    Plugin-Admin-Aktivierungs-PR muss jede Plugin-Op ein `guild_id`-
 *    Feld im Payload führen; der Backend-Op-Gate lehnt fehlende
 *    `guild_id` mit Close-Code 4041 ab. Wenn der WS gerade offline ist,
 *    schluckt `sendPluginOp` die Frame; das ist OK, weil der State
 *    client-seitig schon angewendet wurde.
 *
 * Lazy-loaded vom Plugin-Loader; die `default export`-Funktion ist der
 * `register()`-Hook im Plugin-Entry-Contract (manifest-types.ts).
 *
 * Die exportierte `petStore` + Action-Funktionen werden vom Widget
 * importiert. Im Widget passiert das *direkt* (relativer Pfad), weil die
 * Plugin-Module außerhalb von `$lib` leben.
 */
import { registerSettingsSection } from '../../web/src/lib/settings-registry';
import {
  registerWsHandler,
  unregisterWsHandler
} from '../../web/src/lib/ws/handler-registry';
import { gateway } from '../../web/src/lib/ws/connection';
import type { SectionStore } from '../../web/src/lib/settings-registry/types';

import {
  DEFAULT_PET,
  applyDecay,
  feed as feedTx,
  parsePet,
  play as playTx,
  reset as resetTx,
  sleep as sleepTx,
  type PetState
} from './store';

/** Modul-Singleton: nach `register()` zeigt das hier auf den Section-Store
 *  des Pet-States. Vor `register()` ist es `null`. Das Widget importiert
 *  `getPetStore()` und resolved erst zum Render-Zeitpunkt → Order-of-Init
 *  zwischen Plugin-Loader und Widget-Mount ist egal. */
let petStore: SectionStore<PetState> | null = null;

interface TamagotchiAckPayload {
  op: 'tamagotchi:ack';
  action: 'feed' | 'play' | 'sleep' | 'reset';
  echo?: unknown;
}

/** Resolver für den Section-Store — null wenn das Plugin noch nicht
 *  registriert wurde (z.B. inaktiv). Das Widget rendert in dem Fall einen
 *  "nicht aktiv"-Hinweis statt zu crashen. */
export function getPetStore(): SectionStore<PetState> | null {
  return petStore;
}

/** Wendet eine Aktion sofort lokal an + sendet sie ans Backend.
 *
 *  Optimistic-update first → Server-Ack zweitrangig. Wir senden trotzdem
 *  die Op, damit der Backend-Permission-Gate-Test eine echte Last sieht
 *  und Server-side-Logging die Aktion erfasst.
 *
 *  `guildId` ist seit dem Plugin-Admin-Aktivierungs-PR Pflichtfeld. Bei
 *  leerer `guildId` (DM-Kontext) senden wir nichts — das Backend würde
 *  den Op eh mit 4041 ablehnen, und das Widget rendert in DMs sowieso
 *  nicht (`SidebarFooter.svelte`). */
function applyLocalAction(
  guildId: string,
  action: 'feed' | 'play' | 'sleep' | 'reset',
  transform: (s: PetState) => PetState
): void {
  if (!petStore) {
    console.warn('[tamagotchi] action without registered store:', action);
    return;
  }
  petStore.replace(transform(petStore.value));
  if (!guildId) {
    console.warn('[tamagotchi] action without guild context, skipping send:', action);
    return;
  }
  gateway.sendPluginOp(`tamagotchi:${action}`, { guild_id: guildId });
}

export function feed(guildId: string): void {
  applyLocalAction(guildId, 'feed', feedTx);
}

export function play(guildId: string): void {
  applyLocalAction(guildId, 'play', playTx);
}

export function sleep(guildId: string): void {
  applyLocalAction(guildId, 'sleep', sleepTx);
}

export function reset(guildId: string): void {
  applyLocalAction(guildId, 'reset', () => resetTx());
}

/** Rename in der Settings-Section persistieren — der Server interessiert
 *  sich (noch) nicht für den Namen. */
export function rename(next: string): void {
  if (!petStore) return;
  const trimmed = next.trim().slice(0, 32);
  if (!trimmed) return;
  petStore.set('name', trimmed);
}

/** Lade den frischen Decay-applizierten State und persistiere ihn —
 *  das Widget ruft das beim Mount auf, sodass die Stats sofort die
 *  Wirklichkeit reflektieren statt den letzten gespeicherten Snapshot. */
export function refreshDecay(): void {
  if (!petStore) return;
  petStore.replace(applyDecay(petStore.value));
}

/** Plugin-Entry. Idempotent — re-registriert dieselbe Section + denselben
 *  Handler. Wird vom Frontend-Loader (`web/src/lib/plugins/loader.ts`)
 *  beim App-Boot aufgerufen. Die Pro-Guild-UI-Sichtbarkeit (Widget
 *  rendert nur wenn Plugin für die aktuelle Guild aktiviert) wird vom
 *  `SidebarFooter`-Container geprüft, nicht hier. */
export default function register(): void {
  petStore = registerSettingsSection<PetState>('tamagotchi', {
    defaults: { ...DEFAULT_PET, lastUpdatedAt: Date.now() },
    // User-spezifisch: bei Sign-Out wird das Haustier zurückgesetzt, sonst
    // bekäme der nächste User auf dem Gerät einen "vererbten" Pipsi.
    onSignOut: 'reset',
    version: 1,
    // Defensives Parsen — schützt vor korrumpiertem persistierten Blob
    // (lokal oder von /preferences geliefert).
    parse: parsePet,
    // Schritt 3b: Pet-State wird beim Login pro User vom Backend
    // gezogen — der Pipsi auf dem Handy ist derselbe wie auf dem
    // Desktop. Mutations gehen debounced (~2.5s) als
    // PUT /preferences/tamagotchi raus, sodass z.B. ein "Füttern"-
    // Spam nicht jede Sekunde eine HTTP-Request löst.
    persistence: 'server'
  });

  registerWsHandler('tamagotchi:ack' as never, ((evt: TamagotchiAckPayload) => {
    // Heute nur Log — eine spätere PR würde hier z.B. den Server-State
    // appliyen (`petStore?.replace(evt.state)`).
    console.debug('[tamagotchi] ack', evt.action);
  }) as never);
}

/** Deactivate-Hook — der Plugin-Manager räumt die Ops automatisch ab
 *  (`unregisterWsHandler` läuft im Registry-Rollback), aber das Modul-
 *  Singleton räumen wir explizit, damit ein späterer Re-Activate frisch
 *  durch `register()` läuft. Die Section selbst bleibt erhalten — die
 *  Settings-Registry hat absichtlich kein `unregister`, weil das den
 *  User-State zerstören würde. */
export function deactivate(): void {
  unregisterWsHandler('tamagotchi:ack');
  petStore = null;
}
