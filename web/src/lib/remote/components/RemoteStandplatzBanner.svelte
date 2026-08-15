<!--
  RemoteStandplatzBanner — die sichtbare Anzeige am freigegebenen Gerät.

  Das dritte Stück des Ersatzes für den fehlenden Zeugen (§7 des Entwurfs
  `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`): wer doch
  einmal an diesen Rechner tritt, muss auf den ersten Blick sehen, dass er
  fremden Zugriff zulässt — und ihn mit einem Klick beenden können.

  **Nicht warnfarben, und das ist Absicht.** Amber gehört der laufenden
  Übernahme (`RemoteHostBanner`). Ein freigegebenes Gerät ist kein Alarm,
  sondern ein Zustand; es trägt deshalb den entsättigten Stahlton, den auch der
  Oberflächen-Entwurf den Geräten gibt. Wären beide gleich, ginge der
  Unterschied zwischen „steht bereit" und „wird gerade gesteuert" verloren —
  und der ist der wichtigste, den dieses Fenster zu machen hat.

  **Während einer Sitzung tritt es zurück.** Dann steht das Amber-Banner da,
  das mehr sagt (wer, von wo, seit wann) und dieselbe Notbremse trägt. Zwei
  Banner übereinander hiessen zweimal dasselbe halb.
-->
<script lang="ts">
  import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
  import { Button } from '$lib/components/ui/button/index.js';
  import { standplatz } from '$lib/remote/standplatz.svelte';
  import { remoteSession } from '$lib/remote/session.svelte';
  import { isElectron } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';

  const desktop = isElectron();

  let show = $derived(desktop && standplatz.aktiv && remoteSession.phase !== 'active');

  // Ganze Stunden genügen: die Zahl beantwortet „reicht das noch für heute",
  // nicht „wie viele Minuten". Eine minutengenaue Anzeige bräuchte einen
  // Zeitgeber, und Chromium drosselt den in verdeckten Fenstern ohnehin auf
  // einen Lauf je Minute (dieselbe Falle wie in `wachten.ts`).
  let restStunden = $derived.by(() => {
    const rest = standplatz.restMs();
    return rest === null || rest === 0 ? null : Math.max(1, Math.round(rest / 3_600_000));
  });
</script>

{#if show}
  <div
    class="border-border bg-bg-input/90 fixed left-1/2 top-3 z-[55] flex -translate-x-1/2
      items-center gap-3 rounded-xl border px-4 py-2 shadow-lg backdrop-blur"
    role="status"
    data-testid="remote-standplatz-banner"
  >
    <span class="text-text-muted grid size-7 place-items-center rounded-lg">
      <MonitorCogIcon class="size-4" />
    </span>
    <span class="min-w-0">
      <span class="text-text-bright block truncate text-sm font-medium">
        {m.standplatz_banner_title()}
      </span>
      <span class="text-text-muted block truncate text-xs">
        {standplatz.jeder
          ? m.standplatz_banner_scope_everyone()
          : m.standplatz_banner_scope_users({ count: standplatz.nutzer.length })}
        ·
        {restStunden === null
          ? m.standplatz_banner_permanent()
          : m.standplatz_banner_until_hours({ hours: restStunden })}
      </span>
    </span>
    <Button
      size="sm"
      variant="outline"
      onclick={() => standplatz.zuruecknehmen()}
      data-testid="remote-standplatz-banner-revoke"
    >
      {m.standplatz_banner_revoke()}
    </Button>
  </div>
{/if}
