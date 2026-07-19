<!--
  Privacy settings pane: friend-request policy, discoverability.

  The DM-policy control was removed: direct messages are governed by the
  friend-gate (you can only open a DM with a friend), which supersedes the
  old per-user dm_policy ladder — three of its four values were no-ops under
  the gate, so the setting only looked like it did something. The backend
  column stays (inert) to avoid a destructive migration.

  Pattern matches SettingsNotifications: optimistic store update, REST
  call fire-and-forget with toast on failure. The store.update() call is
  the canonical single-source-of-truth; the server echo on next reconnect
  re-seeds if anything diverges.
-->
<script lang="ts">
  import { privacy, FRIEND_REQ_POLICY } from '$lib/stores/privacy.svelte';
  import { friendsApi } from '$lib/api/friends';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import Checkbox from '$lib/components/form/Checkbox.svelte';

  const FR_OPTIONS = [
    {
      value: FRIEND_REQ_POLICY.EVERYONE,
      label: m.settings_privacy_fr_everyone_label(),
      description: m.settings_privacy_fr_everyone_desc()
    },
    {
      value: FRIEND_REQ_POLICY.SERVER_MEMBERS,
      label: m.settings_privacy_fr_server_members_label(),
      description: m.settings_privacy_fr_server_members_desc()
    },
    {
      value: FRIEND_REQ_POLICY.NOBODY,
      label: m.settings_privacy_fr_nobody_label(),
      description: m.settings_privacy_fr_nobody_desc()
    }
  ];

  async function savePatch(patch: Parameters<typeof privacy.update>[0]) {
    // Vorherige Werte der gepatchten Felder sichern, um bei Fehlschlag
    // zurückzurollen: ein optimistisches "aus Suche ausblenden", das der Server
    // NICHT übernommen hat, würde dem User sonst Verborgenheit vorgaukeln, obwohl
    // er bis zum nächsten reconnect-Re-Seed weiter auffindbar bleibt (Privacy-
    // Fail-Open). Erfolgsfall unverändert.
    const revert: Parameters<typeof privacy.update>[0] = {};
    if ('friend_request_policy' in patch) revert.friend_request_policy = privacy.current.friend_request_policy;
    if ('show_in_search' in patch) revert.show_in_search = privacy.current.show_in_search;
    if ('dm_policy' in patch) revert.dm_policy = privacy.current.dm_policy;
    privacy.update(patch);
    try {
      await friendsApi.updatePrivacy(patch);
    } catch (e) {
      privacy.update(revert);
      toast.error(m.settings_privacy_save_failed(), {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  function setFrPolicy(v: number) {
    void savePatch({ friend_request_policy: v });
  }

  function setShowInSearch(v: boolean) {
    void savePatch({ show_in_search: v });
  }
</script>

<div class="flex flex-col gap-5" data-testid="settings-privacy-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">{m.settings_privacy_title()}</h2>
    <p class="text-text-muted text-sm">
      {m.settings_privacy_subtitle()}
    </p>
  </div>

  <!-- Friend-Request-Policy -->
  <section class="flex flex-col gap-3 rounded-2xl border border-border bg-bg-input/40 p-4">
    <span class="text-text-bright text-sm font-medium">{m.settings_privacy_fr_section_title()}</span>
    {#each FR_OPTIONS as opt (opt.value)}
      <label class="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="radio"
          name="fr_policy"
          value={opt.value}
          class="accent-[var(--brand)] mt-0.5"
          checked={privacy.current.friend_request_policy === opt.value}
          onchange={() => setFrPolicy(opt.value)}
          data-testid="privacy-fr-{opt.value}"
        />
        <span class="flex flex-col gap-0.5">
          <span class="text-text-bright">{opt.label}</span>
          <span class="text-text-muted text-xs">{opt.description}</span>
        </span>
      </label>
    {/each}
  </section>

  <!-- Show in search -->
  <section class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4">
    <label class="flex items-start justify-between gap-3 text-sm">
      <span class="flex flex-col gap-0.5">
        <span class="text-text-bright">{m.settings_privacy_show_in_search_label()}</span>
        <span class="text-text-muted text-xs">
          {m.settings_privacy_show_in_search_desc()}
        </span>
      </span>
      <Checkbox
        class="mt-0.5"
        checked={privacy.current.show_in_search}
        onchange={(e) => setShowInSearch((e.currentTarget as HTMLInputElement).checked)}
        data-testid="privacy-show-in-search"
      />
    </label>
  </section>
</div>
