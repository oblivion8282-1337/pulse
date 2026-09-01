<!--
  Self-Host-only: Instanzweiter Server-Anzeigename.

  Der Admin gibt seinem Server einen Namen, den ALLE verbundenen User sehen
  (statt der nackten URL). Liest/schreibt `instance_name` via
  PATCH /admin/permissions (chat-gateway); leeres Feld setzt ihn zurück.
  Nach dem Speichern wird der aktive Server lokal optimistisch aktualisiert,
  damit der Admin den Namen sofort sieht (andere Clients beim nächsten Connect).
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import SaveIcon from '@lucide/svelte/icons/save';
  import { adminApi } from '$lib/api/admin';
  import { serversStore } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let value = $state('');
  let saved = $state('');
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let dirty = $derived(loaded && value.trim() !== saved);

  onMount(async () => {
    try {
      const perms = await adminApi.getPermissions();
      saved = perms.instance_name ?? '';
      value = saved;
      loaded = true;
    } catch (e) {
      error = errText(e);
    }
  });

  async function save() {
    if (busy) return;
    busy = true;
    try {
      const updated = await adminApi.patchPermissions({ instance_name: value.trim() });
      saved = updated.instance_name ?? '';
      value = saved;
      const sid = activeServer.serverId;
      if (sid) serversStore.update(sid, { server_name: updated.instance_name ?? null });
      toast.success(m.admin_server_name_saved());
    } catch (e) {
      toast.error(m.admin_server_name_save_failed(), {
        description: errText(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-server-name">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_server_name_title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">{m.admin_server_name_description()}</p>
  </div>

  {#if error}
    <FieldError message={error} />
  {:else if !loaded}
    <LoadingState label={m.admin_server_name_loading()} />
  {:else}
    <label class="flex flex-col gap-1.5">
      <span class="text-text-base text-sm">{m.admin_server_name_label()}</span>
      <Input
        type="text"
        maxlength={60}
        bind:value
        placeholder={m.admin_server_name_placeholder()}
        data-testid="admin-server-name-input"
      />
    </label>
    <div class="mt-4 flex items-center justify-end">
      <Button onclick={save} disabled={!dirty || busy} data-testid="admin-server-name-save">
        <SaveIcon class="size-4" />
        {busy ? m.admin_server_name_saving() : m.admin_server_name_save()}
      </Button>
    </div>
  {/if}
</section>
