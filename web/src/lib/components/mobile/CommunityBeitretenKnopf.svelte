<script lang="ts">
  /**
   * „Community beitreten" für die Bereichs-Ansicht Räume (`< lg`).
   *
   * **Warum es diesen Knopf braucht.** Beitritt per bloßer Serveradresse
   * (Erstkontakt, kein Invite-Code) läuft ausschließlich über `JoinGuildStep`
   * in `CreateGuildDialog` (`/app?add=join`). Auf `< lg` gibt es dafür keinen
   * Einstieg — die `GuildRail` ist dort `hidden lg:flex`, und das Beitritts-
   * feld in `/app/discover` weist nackte Hostadressen ausdrücklich ab
   * (`joinByInvite.ts::join_input_host_use_dialog`). Anders als beim Anlegen
   * ist hier kein Server-Vorwechsel nötig — der Zielserver ist ja noch
   * unbekannt, das übernimmt `addServerWithCertLogin` im Dialog selbst.
   */
  import { goto } from '$app/navigation';
  import LogInIcon from '@lucide/svelte/icons/log-in';
  import { m } from '$lib/paraglide/messages.js';
</script>

<button
  type="button"
  onclick={() => void goto('/app?add=join')}
  class="border-border text-text-muted hover:text-text-bright inline-flex min-h-12 w-full max-w-xs items-center justify-center gap-2 rounded-xl border border-dashed px-4 text-sm font-semibold"
  data-testid="rooms-empty-join"
>
  <LogInIcon class="size-4" />
  {m.guild_rail_join_community()}
</button>
