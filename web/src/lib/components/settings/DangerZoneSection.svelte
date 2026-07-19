<script lang="ts">
  /**
   * "Gefahrenzone"-Section am Ende vom Sicherheits-Tab.
   *
   * Triggert das `DeleteAccountDialog` (AlertDialog mit zwei Steps:
   * Warnung+Username-Confirm → Credentials → Submit). Wenn der Auth-Store
   * keinen User hat (Race beim Schließen / nicht eingeloggt) rendern wir
   * die Section gar nicht — der Dialog würde sonst den Username nicht
   * kennen für die Confirm-Match-Logik.
   */
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { Button } from '$lib/components/ui/button/index.js';
  import { auth } from '$lib/stores/auth.svelte';
  import DeleteAccountDialog from './DeleteAccountDialog.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let deleteOpen = $state(false);
</script>

{#if auth.user}
  <section
    class="border-destructive/40 bg-destructive/5 flex flex-col gap-3 rounded-2xl border p-4"
    data-testid="danger-zone-section"
  >
    <div class="flex items-start gap-3">
      <span
        class="bg-destructive/15 text-destructive flex size-9 shrink-0 items-center justify-center rounded-full"
      >
        <TriangleAlertIcon class="size-5" />
      </span>
      <div class="flex flex-col gap-0.5">
        <h3 class="text-destructive text-sm font-semibold">{m.danger_zone_section_title()}</h3>
        <p class="text-text-muted text-xs">
          {m.danger_zone_section_description()}
        </p>
      </div>
    </div>

    <Button
      variant="destructive-solid"
      size="sm"
      onclick={() => (deleteOpen = true)}
      class="self-start"
      data-testid="danger-zone-delete-account"
    >
      {m.danger_zone_section_delete_button()}
    </Button>
  </section>

  <DeleteAccountDialog bind:open={deleteOpen} />
{/if}
