<!--
  ProfilePicker — Dropdown der StreamProfile-Liste aus `gsr_list_profiles`.

  Zeigt Name + Kurzbeschreibung (Codec/Bitrate/FPS) für jedes Profil. Bei der
  speziellen "Custom"-Option schalten wir automatisch `use_overrides` ein —
  der OverridesEditor wird dadurch sichtbar.

  Quelle der Wahrheit: `streamSettings.profile_name`. Wir benutzen ein DOM-
  natives `<select>` (gleicher Stil wie `SettingsAudioVideo.svelte` im
  Rest der App — shadcn-svelte hat keinen `Select` als Primitive).
-->
<script lang="ts">
  import { Label } from '$lib/components/ui/label/index.js';
  import { streamSettings, isCustomProfile } from '../settings.svelte';
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
    // The synthetic "Custom" entry expects user-defined overrides — flip the
    // toggle automatically so the editor appears.
    if (v === 'Custom') {
      streamSettings.use_overrides = true;
    }
  }

  let current = $derived(
    streamSettings.available_profiles.find((p) => p.name === streamSettings.profile_name),
  );
  let notes = $derived(current?.notes ?? '');
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
</div>
