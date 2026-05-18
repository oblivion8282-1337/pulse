<script lang="ts">
  /**
   * "Sicherheit"-Tab in den Settings.
   *
   * Enthält 2FA / TOTP-Management + Active-Sessions-Liste. Email-Verifikation
   * läuft über den Banner im Layout, Passwort-Reset über die unauthenticated-
   * Routes. Wenn weitere Bausteine dazukommen (Connected-Apps etc.), als
   * eigene Section unter den bestehenden einreihen.
   *
   * Der Tab liest `auth.user.totp_enabled` — Backend liefert das im
   * `/me`-Response; bei Legacy-Usern (Feld fehlt) interpretieren wir das
   * als `false` (= "not enabled").
   */
  import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import { auth } from '$lib/stores/auth.svelte';
  import TotpEnableDialog from './TotpEnableDialog.svelte';
  import TotpDisableDialog from './TotpDisableDialog.svelte';
  import TotpBackupRegenerateDialog from './TotpBackupRegenerateDialog.svelte';
  import SessionsSection from './SessionsSection.svelte';

  let enableOpen = $state(false);
  let disableOpen = $state(false);
  let regenOpen = $state(false);

  const totpEnabled = $derived(auth.user?.totp_enabled === true);
</script>

<div class="flex flex-col gap-5" data-testid="settings-security-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">Sicherheit</h2>
    <p class="text-text-muted text-sm">Schütze deinen Account mit Zwei-Faktor-Authentifizierung.</p>
  </div>

  <section class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4">
    <div class="flex items-start gap-3">
      {#if totpEnabled}
        <span class="bg-emerald-500/15 text-emerald-500 flex size-9 items-center justify-center rounded-full">
          <ShieldCheckIcon class="size-5" />
        </span>
      {:else}
        <span class="bg-bg-input text-text-muted flex size-9 items-center justify-center rounded-full">
          <ShieldIcon class="size-5" />
        </span>
      {/if}
      <div class="flex flex-col gap-0.5">
        <span class="text-text-bright text-sm font-medium">
          Zwei-Faktor-Authentifizierung (TOTP)
        </span>
        <span class="text-text-muted text-xs">
          {#if totpEnabled}
            Aktiv — beim Login wird ein 6-stelliger Code aus deiner App verlangt.
          {:else}
            Inaktiv — empfohlen, damit ein gestohlenes Passwort allein nicht reicht.
          {/if}
        </span>
      </div>
    </div>

    {#if !totpEnabled}
      <button
        type="button"
        onclick={() => (enableOpen = true)}
        class="accent-gradient self-start rounded-md px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
        data-testid="security-enable-2fa"
      >
        2FA aktivieren
      </button>
    {:else}
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          onclick={() => (regenOpen = true)}
          class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          data-testid="security-regen-backup"
        >
          Backup-Codes neu generieren
        </button>
        <button
          type="button"
          onclick={() => (disableOpen = true)}
          class="text-destructive bg-destructive/10 hover:bg-destructive/20 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          data-testid="security-disable-2fa"
        >
          2FA deaktivieren
        </button>
      </div>
    {/if}
  </section>

  <SessionsSection />
</div>

<TotpEnableDialog bind:open={enableOpen} />
<TotpDisableDialog bind:open={disableOpen} />
<TotpBackupRegenerateDialog bind:open={regenOpen} />
