<!--
  "Einstellungen"-Reiter des Admin-Panels: bündelt alle Selten-Angefasst-
  Bereiche (Registrierung, SMTP, Anhänge, Rechte, Stream-Limits, Plugins,
  Backup, Server-Name/Beitritt). Die Cloud-/Self-Host-Verzweigung lebt hier,
  damit die Panel-Seite (+page.svelte) eine dünne Reiter-Schale bleibt.
-->
<script lang="ts">
  import AdminBackup from './AdminBackup.svelte';
  import AdminSelfHostBackup from './AdminSelfHostBackup.svelte';
  import AdminAttachments from './AdminAttachments.svelte';
  import AdminRegistration from './AdminRegistration.svelte';
  import AdminSmtp from './AdminSmtp.svelte';
  import AdminPermissions from './AdminPermissions.svelte';
  import AdminServerName from './AdminServerName.svelte';
  import AdminJoinControl from './AdminJoinControl.svelte';
  import AdminStreamLimits from './AdminStreamLimits.svelte';
  import AdminNormalStreamLimits from './AdminNormalStreamLimits.svelte';
  import AdminVoiceLimits from './AdminVoiceLimits.svelte';
  import AdminPlugins from './AdminPlugins.svelte';

  let { isCloud }: { isCloud: boolean } = $props();
</script>

<div class="flex flex-col gap-6">
  <!-- Server-Name ganz nach oben: das erste, was ein Self-Host-Admin einstellt
       (den Namen, den alle sehen). Nur Self-Host. -->
  {#if !isCloud}
    <AdminServerName />
  {/if}
  <!-- Registrierung, SMTP, Cloud-Backup laufen über die auth-svc-Identity-Plane
       (Cloud) und sind für einen Cert-Login-Admin auf einer Self-Host-Instanz
       weder erreichbar (403) noch sinnvoll. Auf Self-Host: eigene Varianten. -->
  {#if isCloud}
    <AdminBackup />
  {:else}
    <AdminSelfHostBackup />
  {/if}
  <AdminAttachments />
  {#if isCloud}
    <AdminRegistration />
    <AdminSmtp />
  {/if}
  <AdminPermissions />
  {#if !isCloud}
    <AdminJoinControl />
  {/if}
  <AdminStreamLimits />
  <AdminNormalStreamLimits />
  <AdminVoiceLimits />
  <AdminPlugins />
</div>
