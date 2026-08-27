<script lang="ts">
  /**
   * Der Inhalt EINES Einstellungs-Reiters.
   *
   * Herausgelöst, seit der Du-Bereich des Handys (`/app/me/[section]`)
   * dieselben Bildschirme als aufgeschobene Seiten zeigt statt als Reiter im
   * Dialog. Die Zuordnung „Kennung → Komponente" stand vorher nur im Dialog;
   * ein zweites Mal hingeschrieben hätte sie beim nächsten neuen Reiter an
   * einer der beiden Stellen gefehlt — und zwar unbemerkt, weil der Fallback
   * am Ende der Kette stillschweigend die Sicherheits-Seite zeigt.
   */
  import type { SettingsTab } from '../SettingsDialog.svelte';
  import SettingsAppearance from './SettingsAppearance.svelte';
  import SettingsLayout from './SettingsLayout.svelte';
  import SettingsAudioVideo from './SettingsAudioVideo.svelte';
  import SettingsScreenShare from './SettingsScreenShare.svelte';
  import SettingsNotifications from './SettingsNotifications.svelte';
  import SettingsSounds from './SettingsSounds.svelte';
  import SettingsSecurity from './SettingsSecurity.svelte';
  import SettingsKeyboard from './SettingsKeyboard.svelte';
  import SettingsPrivacy from './SettingsPrivacy.svelte';
  import SettingsProfile from './SettingsProfile.svelte';
  import SettingsApps from './SettingsApps.svelte';
  import SettingsExperimental from './SettingsExperimental.svelte';
  import SettingsStandplatz from './SettingsStandplatz.svelte';

  let { tab }: { tab: SettingsTab } = $props();
</script>

{#if tab === 'profile'}
  <SettingsProfile />
{:else if tab === 'appearance'}
  <SettingsAppearance />
{:else if tab === 'layout'}
  <SettingsLayout />
{:else if tab === 'audio-video'}
  <SettingsAudioVideo />
{:else if tab === 'screen-share'}
  <SettingsScreenShare />
{:else if tab === 'standplatz'}
  <SettingsStandplatz />
{:else if tab === 'notifications'}
  <SettingsNotifications />
{:else if tab === 'sounds'}
  <SettingsSounds />
{:else if tab === 'keyboard'}
  <SettingsKeyboard />
{:else if tab === 'privacy'}
  <SettingsPrivacy />
{:else if tab === 'apps'}
  <SettingsApps />
{:else if tab === 'experimental'}
  <SettingsExperimental />
{:else}
  <SettingsSecurity />
{/if}
