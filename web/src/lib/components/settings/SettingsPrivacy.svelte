<!--
  Privacy settings pane: DM-policy, friend-request policy, discoverability.

  Pattern matches SettingsNotifications: optimistic store update, REST
  call fire-and-forget with toast on failure. The store.update() call is
  the canonical single-source-of-truth; the server echo on next reconnect
  re-seeds if anything diverges.
-->
<script lang="ts">
  import { privacy, DM_POLICY, FRIEND_REQ_POLICY } from '$lib/stores/privacy.svelte';
  import { friendsApi } from '$lib/api/friends';
  import { toast } from 'svelte-sonner';

  const DM_OPTIONS = [
    { value: DM_POLICY.EVERYONE, label: 'Alle', description: 'Jeder kann dir schreiben' },
    {
      value: DM_POLICY.SERVER_MEMBERS,
      label: 'Server-Mitglieder',
      description: 'Nur Mitglieder gemeinsamer Server'
    },
    { value: DM_POLICY.FRIENDS_ONLY, label: 'Freunde', description: 'Nur deine Freunde' },
    { value: DM_POLICY.NOBODY, label: 'Niemand', description: 'DMs komplett deaktivieren' }
  ];

  const FR_OPTIONS = [
    {
      value: FRIEND_REQ_POLICY.EVERYONE,
      label: 'Alle',
      description: 'Jeder kann dir eine Anfrage schicken'
    },
    {
      value: FRIEND_REQ_POLICY.SERVER_MEMBERS,
      label: 'Server-Mitglieder',
      description: 'Nur Mitglieder gemeinsamer Server'
    },
    {
      value: FRIEND_REQ_POLICY.NOBODY,
      label: 'Niemand',
      description: 'Keine Anfragen annehmen'
    }
  ];

  async function savePatch(patch: Parameters<typeof privacy.update>[0]) {
    privacy.update(patch);
    try {
      await friendsApi.updatePrivacy(patch);
    } catch (e) {
      toast.error('Einstellung konnte nicht gespeichert werden', {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  function setDmPolicy(v: number) {
    void savePatch({ dm_policy: v });
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
    <h2 class="text-text-bright text-lg font-semibold">Privatsphäre</h2>
    <p class="text-text-muted text-sm">
      Wer dich kontaktieren und finden kann.
    </p>
  </div>

  <!-- DM-Policy -->
  <section class="flex flex-col gap-3 rounded-2xl border border-border bg-bg-input/40 p-4">
    <span class="text-text-bright text-sm font-medium">Direktnachrichten empfangen von</span>
    {#each DM_OPTIONS as opt (opt.value)}
      <label class="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="radio"
          name="dm_policy"
          value={opt.value}
          class="accent-[var(--brand)] mt-0.5"
          checked={privacy.current.dm_policy === opt.value}
          onchange={() => setDmPolicy(opt.value)}
          data-testid="privacy-dm-{opt.value}"
        />
        <span class="flex flex-col gap-0.5">
          <span class="text-text-bright">{opt.label}</span>
          <span class="text-text-muted text-xs">{opt.description}</span>
        </span>
      </label>
    {/each}
  </section>

  <!-- Friend-Request-Policy -->
  <section class="flex flex-col gap-3 rounded-2xl border border-border bg-bg-input/40 p-4">
    <span class="text-text-bright text-sm font-medium">Freundschaftsanfragen von</span>
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
        <span class="text-text-bright">In der Nutzersuche erscheinen</span>
        <span class="text-text-muted text-xs">
          Andere können deinen Account über deinen Nutzernamen finden.
        </span>
      </span>
      <input
        type="checkbox"
        class="mt-0.5 size-5 accent-[var(--brand)] md:size-4"
        checked={privacy.current.show_in_search}
        onchange={(e) => setShowInSearch((e.currentTarget as HTMLInputElement).checked)}
        data-testid="privacy-show-in-search"
      />
    </label>
  </section>
</div>
