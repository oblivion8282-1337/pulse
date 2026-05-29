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
  import { auth } from '$lib/stores/auth.svelte';
  import DeleteAccountDialog from './DeleteAccountDialog.svelte';

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
        <h3 class="text-destructive text-sm font-semibold">Gefahrenzone</h3>
        <p class="text-text-muted text-xs">
          Account löschen — dauerhaft und unwiderruflich. Alle Nachrichten, Mitgliedschaften und
          Communitys, in denen du Owner bist, gehen verloren.
        </p>
      </div>
    </div>

    <button
      type="button"
      onclick={() => (deleteOpen = true)}
      class="bg-destructive hover:bg-destructive/90 self-start rounded-md px-3 py-2 text-sm font-medium text-white transition-colors md:py-1.5"
      data-testid="danger-zone-delete-account"
    >
      Account löschen
    </button>
  </section>

  <DeleteAccountDialog bind:open={deleteOpen} />
{/if}
