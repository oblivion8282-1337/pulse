<!--
  Einladungskarte in einer Nachricht (`/invite/<code>`): lädt die Vorschau beim
  Einhängen. ``host`` (bare FQDN) ist gesetzt, wenn der Link auf einen Self-Host
  zeigt; dann gibt es nur eine schlanke Karte (der Empfänger ist meist noch
  kein Mitglied) und der Beitritt läuft direkt über `joinGuildByInvite`.
-->
<script module lang="ts">
  import { ApiError } from '$lib/api/client';
  import type { InvitePreview } from '$lib/api/types';
  import { erzeugeVorschauCache } from '$lib/einladung/vorschauCache';

  // Modulweit geteilt: überlebt das Ab- und Wiederauftauchen der Karte in der
  // virtualisierten Nachrichtenliste. Nur 404 gilt als dauerhaft.
  const vorschaeuen = erzeugeVorschauCache<InvitePreview>(
    (e) => e instanceof ApiError && e.status === 404
  );
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { anfangsBuchstabe } from '$lib/utils/anfangsBuchstabe';
  import { chatApi } from '$lib/api/chat';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { joinedInvites } from '$lib/stores/joinedInvites.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import { guildIconSrc } from '$lib/guildIcon';
  import {
    SelfHostContactConfirmRequired,
    getInvitePreviewOn
  } from '$lib/api/add-server-flow';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let { code, host = null }: { code: string; host?: string | null } = $props();

  let preview = $state<InvitePreview | null>(null);
  let invalid = $state(false);
  // Vorschau nicht ladbar, Code nicht als ungültig belegt (429, Netzfehler).
  let previewUnavailable = $state(false);
  let loading = $state(true);
  let joining = $state(false);

  // „Beigetreten": Beitritt über genau diesen Code erinnert (überlebt Reload)
  // ODER Mitgliedschaft live sichtbar.
  let alreadyMember = $derived(
    !!joinedInvites.guildIdFor(code) || (!!preview && !!guilds.byId[preview.guild.id])
  );

  // icon_url durch guildIconSrc() (nur https:// oder /-relativ, sonst
  // Initialen) — wie GuildRail. Page-Origin statt CLOUD_HOSTNAME: die Preview
  // kommt vom Page-Origin, im Dev bleibt so der Vite-Proxy das Ziel.
  let previewIconSrc = $derived(
    preview ? guildIconSrc(preview.guild.icon_url, window.location.origin) : null
  );

  // Self-Host-Karte: Sind wir auf dem Ziel-Server schon Mitglied, laden wir
  // die Preview DORT und der Button wird zu „Beigetreten" (reaktiv, auch nach
  // einem Beitritt über genau diese Karte).
  let selfHostServer = $derived(host ? serversStore.findByHostname(host) : undefined);
  let selfHostPreview = $state<InvitePreview | null>(null);
  // Der Ziel-Server hat den Code abgewiesen (404: ungültig, abgelaufen oder
  // verbraucht). Nur das macht die Karte tot; fehlende Session und Netzfehler
  // lassen sie klickbar, der Beitritt kann noch gelingen.
  let selfHostInvalid = $state(false);
  // Dedupe pro Server-Zustand (NICHT reaktiv): Schlüssel enthält die Kennung,
  // die erst nach erfolgreichem Login gesetzt wird — ein Fehlversuch davor
  // blockiert den Retry nach dem Beitritt nicht, fremde Store-Writes feuern
  // aber keine Wiederholungen.
  const previewAttempted = new Set<string>();

  $effect(() => {
    const srv = selfHostServer;
    if (!host || !srv || selfHostPreview) return;
    const key = srv.id;
    if (previewAttempted.has(key)) return;
    previewAttempted.add(key);
    void serverGuilds.ensureLoaded(srv.id);
    getInvitePreviewOn(code, { serverId: srv.id })
      .then((p) => (selfHostPreview = p))
      .catch((e: unknown) => {
        // Keine Session → Karte bleibt im schlanken Modus, der Beitritt
        // klärt das. Ein 404 vom Ziel-Server ist dagegen endgültig.
        if (e instanceof ApiError && e.status === 404) selfHostInvalid = true;
      });
  });

  let alreadyMemberSelfHost = $derived(
    !!joinedInvites.guildIdFor(code) ||
      (!!selfHostServer &&
        !!selfHostPreview &&
        serverGuilds.get(selfHostServer.id).some((g) => g.id === selfHostPreview!.guild.id))
  );

  onMount(async () => {
    if (host) {
      loading = false;
      return;
    }
    try {
      // Host-loser Link = Cloud-Einladung → ausdrücklich die Cloud fragen,
      // nicht den aktiven Server (sonst „ungültig“ in einem Self-Host-Kanal).
      const cloudId = serversStore.cloudId();
      preview = await vorschaeuen.holen(code, () =>
        cloudId ? getInvitePreviewOn(code, { serverId: cloudId }) : chatApi.getInvitePreview(code)
      );
    } catch (e) {
      // Nur 404 belegt „ungültig“; eine Bremse (429) oder ein Netzfehler nicht.
      if (e instanceof ApiError && e.status === 404) invalid = true;
      else previewUnavailable = true;
    } finally {
      loading = false;
    }
  });

  // Erstkontakt-Bestätigung für neue, unbekannte Self-Hosts.
  let confirmOpen = $state(false);
  let confirmHost = $state('');
  let pendingInput = $state('');

  // Harte Reentrancy-Sperre (NICHT reaktiv): nie zwei ``doJoin``-Flows
  // gleichzeitig. ``joining`` steuert nur die Button-Optik und fällt im
  // Cancel-Fall früh zurück; ohne die Sperre könnte ein Klick im Schließ-
  // Animationsfenster des Confirm-Dialogs einen zweiten Login-Flow anstoßen.
  let busy = false;

  async function doJoin(input: string, confirmed: boolean) {
    if (busy) return;
    busy = true;
    joining = true;
    try {
      await joinGuildByInvite(input, confirmed);
    } catch (e) {
      // Neuer, unbekannter Self-Host → Erstkontakt-Dialog zeigen, dann mit
      // confirmed=true erneut beitreten (sonst bleibt der Beitritt still hängen).
      if (e instanceof SelfHostContactConfirmRequired) {
        confirmHost = e.hostname;
        pendingInput = input;
        confirmOpen = true;
        return;
      }
      toast.error(m.invite_embed_invalid(), {
        description: e instanceof Error ? e.message : undefined
      });
    } finally {
      busy = false;
      if (!confirmOpen) joining = false;
    }
  }

  function handleJoin() {
    if (joining) return;
    const input = host ? `https://app/invite/${code}?host=${encodeURIComponent(host)}` : code;
    void doJoin(input, false);
  }

  function onConfirmContact() {
    confirmOpen = false;
    void doJoin(pendingInput, true);
  }

  function onCancelContact() {
    confirmOpen = false;
    joining = false;
  }
</script>

{#snippet avatar(src: string | null, alt: string, fallback: string)}
  <Avatar.Root class="size-10 shrink-0">
    {#if src}
      <Avatar.Image {src} {alt} />
    {/if}
    <Avatar.Fallback class="accent-gradient text-primary-foreground text-sm font-semibold">
      {fallback}
    </Avatar.Fallback>
  </Avatar.Root>
{/snippet}

{#snippet beitreten(mitglied: boolean)}
  <Button
    size="sm"
    onclick={handleJoin}
    disabled={mitglied || joining}
    data-testid="invite-embed-join-btn"
  >
    {mitglied ? m.invite_embed_joined() : joining ? '…' : m.invite_embed_join()}
  </Button>
{/snippet}

<div
  class="mt-1 flex items-center gap-3 rounded-xl border border-border bg-bg-input px-4 py-3 max-w-sm"
  data-testid="invite-embed"
>
  {#if loading}
    <div class="flex flex-1 items-center gap-3">
      <div class="size-10 shrink-0 rounded-full bg-bg-hover animate-pulse"></div>
      <div class="space-y-1.5 flex-1">
        <div class="h-3.5 w-32 rounded bg-bg-hover animate-pulse"></div>
        <div class="h-3 w-20 rounded bg-bg-hover animate-pulse"></div>
      </div>
    </div>
    <div class="h-8 w-20 rounded-md bg-bg-hover animate-pulse shrink-0"></div>
  {:else if host && !selfHostInvalid}
    {@render avatar(null, host, anfangsBuchstabe(host))}
    <div class="min-w-0 flex-1">
      <p class="text-text-bright truncate text-sm font-semibold">
        {selfHostPreview?.guild.name ?? m.invite_embed_self_host_title()}
      </p>
      <p class="text-text-muted truncate text-xs" data-testid="invite-embed-host">{host}</p>
    </div>
    {@render beitreten(alreadyMemberSelfHost)}
  {:else if previewUnavailable && !invalid && !preview}
    {@render avatar('/pulse-mark.svg', 'Pulse', 'P')}
    <div class="min-w-0 flex-1">
      <p class="text-text-bright truncate text-sm font-semibold">
        {m.invite_embed_unavailable_title()}
      </p>
    </div>
    {@render beitreten(alreadyMember)}
  {:else if invalid || selfHostInvalid || !preview}
    <div class="text-text-muted flex-1 text-sm">{m.invite_embed_invalid()}</div>
    <Button variant="outline" size="sm" disabled>{m.invite_embed_join()}</Button>
  {:else}
    {@render avatar(previewIconSrc, preview.guild.name, anfangsBuchstabe(preview.guild.name))}
    <div class="min-w-0 flex-1">
      <p class="text-text-bright truncate text-sm font-semibold" data-testid="invite-embed-guild-name">
        {preview.guild.name}
      </p>
      <p class="text-text-muted text-xs" data-testid="invite-embed-member-count">
        {preview.member_count === 1
          ? m.invite_embed_member_count_one({ count: 1 })
          : m.invite_embed_member_count({ count: preview.member_count })}
      </p>
    </div>
    {@render beitreten(alreadyMember)}
  {/if}
</div>

<SelfHostContactConfirmDialog
  open={confirmOpen}
  hostname={confirmHost}
  onConfirm={onConfirmContact}
  onCancel={onCancelContact}
/>
