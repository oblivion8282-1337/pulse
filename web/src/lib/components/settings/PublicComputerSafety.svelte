<!--
  Öffentlicher-Computer-Sicherheits-Abschnitt in den Sicherheits-Einstellungen.

  Ermöglicht das vollständige Löschen aller lokalen Pulse-Daten + Abmelden.
  Löscht: IndexedDB (pulse-identity), localStorage (pulse.*-Keys),
  sessionStorage, dann signOut() → /login.
-->
<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import MonitorXIcon from '@lucide/svelte/icons/monitor-x';
  import { auth } from '$lib/stores/auth.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let confirmOpen = $state(false);
  let wiping = $state(false);

  async function wipeAndSignOut() {
    wiping = true;
    try {
      // 1. IndexedDB löschen (pulse-identity + pulse-stream falls vorhanden)
      const dbNames = ['pulse-identity', 'pulse-stream'];
      await Promise.allSettled(
        dbNames.map(
          (name) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve(); // Fehler ignorieren
              req.onblocked = () => resolve();
            })
        )
      );

      // 2. localStorage — nur pulse.*-Keys (kein blind-clear fremder Daten)
      const lsKeys = Object.keys(localStorage).filter((k) => k.startsWith('pulse') || k.startsWith('dcc'));
      for (const k of lsKeys) localStorage.removeItem(k);

      // 3. sessionStorage vollständig leeren (nur Pulse-Session-Daten)
      sessionStorage.clear();

      // 4. Server-Session revoken + lokale Stores clearen + /login
      auth.signOut();
    } finally {
      wiping = false;
      confirmOpen = false;
    }
  }
</script>

<section
  class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4"
  data-testid="public-computer-safety"
>
  <div class="flex items-start gap-3">
    <span class="bg-warning/15 text-warning flex size-9 items-center justify-center rounded-full">
      <MonitorXIcon class="size-5" />
    </span>
    <div class="flex flex-col gap-0.5">
      <span class="text-text-bright text-sm font-medium">
        {m.public_computer_safety_title()}
      </span>
      <span class="text-text-muted text-xs">
        {m.public_computer_safety_description()}
      </span>
    </div>
  </div>

  <button
    type="button"
    onclick={() => (confirmOpen = true)}
    class="text-destructive bg-destructive/10 hover:bg-destructive/20 self-start rounded-md px-3 py-2 text-sm font-medium transition-colors"
    data-testid="public-computer-wipe-btn"
  >
    {m.public_computer_safety_wipe_button()}
  </button>
</section>

<AlertDialog.Root bind:open={confirmOpen}>
  <AlertDialog.Content data-testid="public-computer-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.public_computer_safety_confirm_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.public_computer_safety_confirm_description()}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.public_computer_safety_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={wipeAndSignOut}
        disabled={wiping}
        class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      >
        {wiping ? m.public_computer_safety_wiping() : m.public_computer_safety_confirm_action()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
