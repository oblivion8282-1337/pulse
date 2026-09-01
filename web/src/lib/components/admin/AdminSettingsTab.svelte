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
  import AdminStreamLimits, { type StreamLimitMsgs } from './AdminStreamLimits.svelte';
  import { RESOLUTION_VALUES } from '$lib/stream/settingsCatalog';
  import { m } from '$lib/paraglide/messages.js';
  import AdminVoiceLimits from './AdminVoiceLimits.svelte';
  import AdminPlugins from './AdminPlugins.svelte';

  let { isCloud }: { isCloud: boolean } = $props();

  // Beide Wertesätze derselben Komponente (Audit: ~95 % identischer Code) —
  // nur Feldpräfix, Optionsliste und Beschriftungen (paraglide-Keys) unterscheiden sich.
  // Screen-share resolution ceiling (descending; 'native' = no cap).
  const NS_RESOLUTIONS = ['native', '1080p', '720p', '480p'];

  const HQ_MSG: StreamLimitMsgs = {
    title: m.admin_stream_limits_title,
    description: m.admin_stream_limits_description,
    error: m.admin_stream_limits_error,
    bitrateLabel: m.admin_stream_limits_bitrate_label,
    bitrateHint: m.admin_stream_limits_bitrate_hint,
    bitrateMinAria: m.admin_stream_limits_bitrate_min_aria,
    bitrateMaxAria: m.admin_stream_limits_bitrate_max_aria,
    to: m.admin_stream_limits_to,
    mbitUnit: m.admin_stream_limits_mbit_unit,
    fpsLabel: m.admin_stream_limits_fps_label,
    fpsHint: m.admin_stream_limits_fps_hint,
    fpsMinAria: m.admin_stream_limits_fps_min_aria,
    fpsMaxAria: m.admin_stream_limits_fps_max_aria,
    fpsUnit: m.admin_stream_limits_fps_unit,
    resolutionLabel: m.admin_stream_limits_resolution_label,
    resolutionHint: m.admin_stream_limits_resolution_hint,
    resolutionAria: m.admin_stream_limits_resolution_aria,
    save: m.admin_stream_limits_save,
    saving: m.admin_stream_limits_saving,
    loading: m.admin_stream_limits_loading,
    toastBitrateInvalid: m.admin_stream_limits_toast_bitrate_invalid,
    toastBitrateInvalidDesc: m.admin_stream_limits_toast_bitrate_invalid_desc,
    toastBitrateTitle: m.admin_stream_limits_toast_bitrate_label,
    toastMinOverMax: m.admin_stream_limits_toast_min_over_max,
    toastFpsInvalid: m.admin_stream_limits_toast_fps_invalid,
    toastFpsInvalidDesc: m.admin_stream_limits_toast_fps_invalid_desc,
    toastFpsTitle: m.admin_stream_limits_toast_fps_label,
    toastSaved: m.admin_stream_limits_toast_saved,
    toastSaveFailed: m.admin_stream_limits_toast_save_failed
  };

  const NS_MSG: StreamLimitMsgs = {
    title: m.admin_normal_stream_limits_title,
    description: m.admin_normal_stream_limits_description,
    error: m.admin_normal_stream_limits_error,
    bitrateLabel: m.admin_normal_stream_limits_bitrate,
    bitrateHint: m.admin_normal_stream_limits_bitrate_range,
    bitrateMinAria: m.admin_normal_stream_limits_bitrate_min_label,
    bitrateMaxAria: m.admin_normal_stream_limits_bitrate_max_label,
    to: m.admin_normal_stream_limits_to,
    mbitUnit: m.admin_normal_stream_limits_mbitps,
    fpsLabel: m.admin_normal_stream_limits_fps,
    fpsHint: m.admin_normal_stream_limits_fps_range,
    fpsMinAria: m.admin_normal_stream_limits_fps_min_label,
    fpsMaxAria: m.admin_normal_stream_limits_fps_max_label,
    fpsUnit: m.admin_normal_stream_limits_fps_unit,
    resolutionLabel: m.admin_normal_stream_limits_max_resolution,
    resolutionHint: m.admin_normal_stream_limits_max_resolution_desc,
    resolutionAria: m.admin_normal_stream_limits_max_resolution,
    save: m.admin_normal_stream_limits_save,
    saving: m.admin_normal_stream_limits_saving,
    loading: m.admin_normal_stream_limits_loading,
    toastBitrateInvalid: m.admin_normal_stream_limits_invalid_bitrate,
    toastBitrateInvalidDesc: m.admin_normal_stream_limits_invalid_bitrate_desc,
    toastBitrateTitle: m.admin_normal_stream_limits_bitrate,
    toastMinOverMax: m.admin_normal_stream_limits_min_above_max,
    toastFpsInvalid: m.admin_normal_stream_limits_invalid_fps,
    toastFpsInvalidDesc: m.admin_normal_stream_limits_invalid_fps_desc,
    toastFpsTitle: m.admin_normal_stream_limits_fps,
    toastSaved: m.admin_normal_stream_limits_saved,
    toastSaveFailed: m.admin_normal_stream_limits_save_failed
  };
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
  <AdminStreamLimits
    prefix="hq"
    resolutions={RESOLUTION_VALUES}
    nativeValue="Native"
    nativeLabel={m.admin_stream_limits_resolution_native}
    msg={HQ_MSG}
    testId="admin-stream-limits"
  />
  <AdminStreamLimits
    prefix="ns"
    resolutions={NS_RESOLUTIONS}
    nativeValue="native"
    nativeLabel={m.admin_normal_stream_limits_native_no_limit}
    msg={NS_MSG}
    testId="admin-normal-stream-limits"
  />
  <AdminVoiceLimits />
  <AdminPlugins />
</div>
