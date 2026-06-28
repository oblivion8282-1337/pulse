<!--
  Formular + Status-Liste für Self-Hoster-Anträge im Einstellungs-Dialog.
  Endpoint: POST /me/instance-applications + GET /me/instance-applications
  Cookie-Auth via instancesApi (credentials:'include').
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { auth } from '$lib/stores/auth.svelte';
  import { myInstanceApplications } from '$lib/stores/myInstanceApplications.svelte';
  import {
    instancesApi,
    type InstanceApplication,
    type ApplicationPurpose
  } from '$lib/api/instances';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { m } from '$lib/paraglide/messages.js';

  // Form state
  let hostname = $state('');
  let purpose = $state<ApplicationPurpose>('privat');
  let expected_users = $state(10);
  let contact_email = $state(auth.user?.email ?? '');
  let notes = $state('');
  let submitting = $state(false);
  let formError = $state<string | null>(null);

  // List state
  let applications = $state<InstanceApplication[]>([]);
  let listLoading = $state(true);

  onMount(async () => {
    await reload();
  });

  async function reload() {
    listLoading = true;
    try {
      // Genehmigte Anträge ausblenden: sie leben als Server unter „Meine
      // Instanzen" weiter und würden hier sonst dauerhaft als erledigte Einträge
      // herumstehen. Nur offene + abgelehnte (mit Begründung) sind hier relevant.
      const all = await instancesApi.listMyApplications('all');
      applications = all.filter((a) => a.status !== 'approved');
    } catch {
      // Nicht kritisch — Liste bleibt leer
    } finally {
      listLoading = false;
    }
  }

  async function submit() {
    formError = null;
    if (!hostname.trim()) { formError = m.self_host_application_hostname_required(); return; }
    submitting = true;
    try {
      const created = await instancesApi.submitApplication({
        hostname: hostname.trim(),
        purpose,
        expected_users,
        contact_email: contact_email.trim(),
        notes: notes.trim() || null
      });
      // Antrag beobachten → Owner-Toast, sobald genehmigt/abgelehnt wird.
      myInstanceApplications.register(created.id);
      toast.success(m.self_host_application_submitted_toast());
      hostname = '';
      notes = '';
      await reload();
    } catch (e) {
      formError = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  function statusLabel(s: string): string {
    if (s === 'pending') return m.self_host_application_status_pending();
    if (s === 'approved') return m.self_host_application_status_approved();
    return m.self_host_application_status_rejected();
  }

  function statusClass(s: string): string {
    if (s === 'approved') return 'bg-emerald-500/20 text-emerald-300';
    if (s === 'rejected') return 'bg-red-500/20 text-red-300';
    return 'bg-amber-500/20 text-amber-300';
  }
</script>

<div class="flex flex-col gap-5" data-testid="self-host-application">
  <div class="flex items-start gap-3">
    <span class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full">
      <ServerIcon class="size-5" />
    </span>
    <div>
      <h3 class="text-text-bright text-sm font-semibold">{m.self_host_application_heading()}</h3>
      <p class="text-text-muted text-xs mt-0.5">
        {m.self_host_application_intro()}
      </p>
    </div>
  </div>

  <!-- Form -->
  <form onsubmit={(e) => { e.preventDefault(); void submit(); }}
        class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4">
    <div class="flex flex-col gap-1">
      <label class="text-text-bright text-xs font-medium" for="sha-hostname">
        {m.self_host_application_hostname_label()} <span class="text-text-muted font-normal">{m.self_host_application_hostname_hint()}</span>
      </label>
      <input
        id="sha-hostname"
        type="text"
        bind:value={hostname}
        placeholder="pulse.example.org"
        class="bg-bg-input border-border text-text-bright placeholder:text-text-muted rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-text-bright text-xs font-medium" for="sha-purpose">{m.self_host_application_purpose_label()}</label>
        <select
          id="sha-purpose"
          bind:value={purpose}
          class="bg-bg-input border-border text-text-bright rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="privat">{m.self_host_application_purpose_privat()}</option>
          <option value="verein">{m.self_host_application_purpose_verein()}</option>
          <option value="firma">{m.self_host_application_purpose_firma()}</option>
          <option value="sonst">{m.self_host_application_purpose_sonst()}</option>
        </select>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-text-bright text-xs font-medium" for="sha-users">{m.self_host_application_expected_users_label()}</label>
        <input
          id="sha-users"
          type="number"
          min="1"
          max="10000"
          bind:value={expected_users}
          class="bg-bg-input border-border text-text-bright rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-text-bright text-xs font-medium" for="sha-email">{m.self_host_application_email_label()}</label>
      <input
        id="sha-email"
        type="email"
        bind:value={contact_email}
        class="bg-bg-input border-border text-text-bright rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-text-bright text-xs font-medium" for="sha-notes">
        {m.self_host_application_notes_label()} <span class="text-text-muted font-normal">{m.self_host_application_optional()}</span>
      </label>
      <textarea
        id="sha-notes"
        bind:value={notes}
        rows="2"
        maxlength="2000"
        placeholder={m.self_host_application_notes_placeholder()}
        class="bg-bg-input border-border text-text-bright placeholder:text-text-muted resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      ></textarea>
    </div>

    {#if formError}
      <p class="text-red-400 text-xs">{formError}</p>
    {/if}

    <button
      type="submit"
      disabled={submitting}
      class="bg-primary hover:bg-primary/90 text-white rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60 self-end"
    >
      {submitting ? m.self_host_application_submitting() : m.self_host_application_submit()}
    </button>
  </form>

  <!-- Application list -->
  {#if !listLoading && applications.length > 0}
    <div class="flex flex-col gap-2">
      <h4 class="text-text-muted text-xs font-semibold uppercase tracking-wide">{m.self_host_application_my_applications()}</h4>
      {#each applications as app (app.id)}
        <div class="border-border bg-bg-input/30 flex items-start justify-between gap-3 rounded-xl border p-3">
          <div class="min-w-0">
            <p class="text-text-bright text-sm font-medium truncate">{app.hostname}</p>
            <p class="text-text-muted text-xs mt-0.5">
              {new Date(app.created_at).toLocaleDateString('de-DE')}
              · {app.purpose}
            </p>
          </div>
          <div class="flex flex-col items-end gap-1 shrink-0">
            <span class="rounded-full px-2 py-0.5 text-xs font-medium {statusClass(app.status)}">
              {statusLabel(app.status)}
            </span>
            {#if app.status === 'rejected' && app.rejection_reason}
              <span class="text-text-muted text-xs max-w-40 text-right" title={app.rejection_reason}>
                {app.rejection_reason.length > 60
                  ? app.rejection_reason.slice(0, 60) + '…'
                  : app.rejection_reason}
              </span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
