<!--
  ProfilePicker — Dropdown der StreamProfile-Liste aus `gsr_list_profiles`.

  Zeigt Name + Kurzbeschreibung (Codec/Bitrate/FPS) für jedes Profil. Bei der
  speziellen "Custom"-Option schalten wir automatisch `use_overrides` ein —
  der OverridesEditor wird dadurch sichtbar.

  T3c: Persistenz nach Änderung; AV1-Warnung wenn das gewählte Profil AV1
  nutzt, aber `gpu_info.video_codecs` kein AV1-Encode enthält (nicht
  hardware-beschleunigt → CPU-Encode wäre zu langsam für 60fps-Streaming).

  Quelle der Wahrheit: `streamSettings.profile_name`.
-->
<script lang="ts">
  import { Label } from '$lib/components/ui/label/index.js';
  import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
  import {
    streamSettings,
    isCustomProfile,
    av1Mismatch,
    persistSettings,
  } from '../settings.svelte';
  import type { GsrProfile } from '../gsr';

  function summary(p: GsrProfile): string {
    const parts: string[] = [];
    parts.push(p.codec.toUpperCase());
    parts.push(`${p.bitrate_kbps} kbps`);
    parts.push(`${p.fps} fps`);
    if (p.audio_codec) parts.push(p.audio_codec);
    return parts.join(' · ');
  }

  function onChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    streamSettings.profile_name = v;
    if (v === 'Custom') {
      streamSettings.use_overrides = true;
    }
    persistSettings();
  }

  let current = $derived(
    streamSettings.available_profiles.find((p) => p.name === streamSettings.profile_name),
  );
  let notes = $derived(current?.notes ?? '');
  let av1Warn = $derived(av1Mismatch());
</script>

<div class="flex flex-col gap-1.5" data-testid="stream-profile-picker">
  <Label for="stream-profile-select">Profil</Label>
  <select
    id="stream-profile-select"
    class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
    value={streamSettings.profile_name}
    onchange={onChange}
    disabled={streamSettings.available_profiles.length === 0}
    data-testid="stream-profile-select"
  >
    {#if streamSettings.available_profiles.length === 0}
      <option value="">Lade Profile…</option>
    {/if}
    {#each streamSettings.available_profiles as p (p.name)}
      <option value={p.name}>{p.name} · {summary(p)}</option>
    {/each}
  </select>
  {#if notes}
    <p class="text-text-muted text-xs">{notes}</p>
  {/if}
  {#if isCustomProfile()}
    <p class="text-xs text-amber-400/80">
      Werte in „Overrides" gelten — sonst kommen die Standardwerte des Custom-Profils.
    </p>
  {/if}
  {#if av1Warn}
    <div
      class="flex items-start gap-2 rounded-md border border-amber-700/60 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-200"
      role="alert"
      data-testid="stream-profile-av1-warning"
    >
      <AlertTriangleIcon class="mt-0.5 size-3.5 shrink-0" />
      <span>AV1 wird von deiner GPU nicht hardware-beschleunigt unterstützt.</span>
    </div>
  {/if}
</div>
