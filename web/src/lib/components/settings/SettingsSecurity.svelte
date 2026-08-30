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
  import { Button } from '$lib/components/ui/button/index.js';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import { auth } from '$lib/stores/auth.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import TotpEnableDialog from './TotpEnableDialog.svelte';
  import TotpDisableDialog from './TotpDisableDialog.svelte';
  import TotpBackupRegenerateDialog from './TotpBackupRegenerateDialog.svelte';
  import ChangeEmailSection from './ChangeEmailSection.svelte';
  import ChangePasswordSection from './ChangePasswordSection.svelte';
  import PasskeysSection from './PasskeysSection.svelte';
  import SessionsSection from './SessionsSection.svelte';
  import DangerZoneSection from './DangerZoneSection.svelte';
  import GeraeteKopplungSection from './GeraeteKopplungSection.svelte';
  import GeraeteListeSection from './GeraeteListeSection.svelte';
=======
>>>>>>> main
  import PublicComputerSafety from './PublicComputerSafety.svelte';

  let enableOpen = $state(false);
  let disableOpen = $state(false);
  let regenOpen = $state(false);

  const totpEnabled = $derived(auth.user?.totp_enabled === true);
</script>

<div class="flex flex-col gap-5" data-testid="settings-security-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-base font-semibold">{m.settings_security_title()}</h2>
    <p class="text-text-muted text-xs">{m.settings_security_subtitle()}</p>
  </div>

  <section class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4">
    <div class="flex items-start gap-3">
      {#if totpEnabled}
        <span class="bg-success/15 text-success flex size-9 items-center justify-center rounded-full">
          <ShieldCheckIcon class="size-5" />
        </span>
      {:else}
        <span class="bg-bg-input text-text-muted flex size-9 items-center justify-center rounded-full">
          <ShieldIcon class="size-5" />
        </span>
      {/if}
      <div class="flex flex-col gap-0.5">
        <span class="text-text-bright text-sm font-medium">
          {m.settings_security_totp_label()}
        </span>
        <span class="text-text-muted text-xs">
          {#if totpEnabled}
            {m.settings_security_totp_active()}
          {:else}
            {m.settings_security_totp_inactive()}
          {/if}
        </span>
      </div>
    </div>

    {#if !totpEnabled}
      <Button
        size="sm"
        onclick={() => (enableOpen = true)}
        class="self-start"
        data-testid="security-enable-2fa"
      >
        {m.settings_security_enable_2fa()}
      </Button>
    {:else}
      <div class="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="xs"
          onclick={() => (regenOpen = true)}
          data-testid="security-regen-backup"
        >
          {m.settings_security_regen_backup_codes()}
        </Button>
        <Button
          variant="destructive"
          size="xs"
          onclick={() => (disableOpen = true)}
          data-testid="security-disable-2fa"
        >
          {m.settings_security_disable_2fa()}
        </Button>
      </div>
    {/if}
  </section>

  <ChangeEmailSection />

  <ChangePasswordSection />

  <PasskeysSection />

  <GeraeteKopplungSection />

  <GeraeteListeSection />

  <SessionsSection />

  <PublicComputerSafety />

  <DangerZoneSection />
</div>

<TotpEnableDialog bind:open={enableOpen} />
<TotpDisableDialog bind:open={disableOpen} />
<TotpBackupRegenerateDialog bind:open={regenOpen} />
