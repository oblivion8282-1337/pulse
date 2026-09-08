<script lang="ts">
  /**
   * „Neue Gruppe" — Name wählen, Freunde anhaken, anlegen.
   *
   * Der letzte fehlende Bildschirm des Gruppen-Unterspiels (Backend, Krypto
   * und API-Client standen schon, s. Übergabe §5 P0.4): Angelegt wird über
   * `gruppenApi.erstellen` + `mitgliedHinzufuegen` je Freund, der Bestand
   * landet im `privateGruppen`-Store, und die Ansicht springt direkt in den
   * frischen Gruppen-Chat — dieselbe Adresse wie eine DM (`/app/@me/<id>`).
   *
   * Freunde haken AN, nicht AB: Wer fehlen soll, lässt man aus. Das
   * Einzelspielen einer leeren Gruppe ist erlaubt (man kann später über das
   * Gruppen-Blatt noch jemanden hinzufügen), der Name ist Pflicht.
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { friends } from '$lib/stores/friends.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { gruppenApi } from '$lib/api/gruppen';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { toast } from 'svelte-sonner';

  let {
    open = $bindable(false),
    onErstellt
  }: {
    open?: boolean;
    onErstellt: (gruppeId: string) => void;
  } = $props();

  let name = $state('');
  let ausgewaehlt = $state<Set<string>>(new Set());
  let amAnlegen = $state(false);

  $effect(() => {
    if (open) {
      name = '';
      ausgewaehlt = new Set();
      for (const f of friends.list) userCache.queue(f.user_id);
    }
  });

  function umschalten(userId: string) {
    const next = new Set(ausgewaehlt);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    ausgewaehlt = next;
  }

  async function anlegen() {
    const gekuerzt = name.trim();
    if (!gekuerzt || amAnlegen) return;
    amAnlegen = true;
    try {
      let gruppe = await gruppenApi.erstellen(gekuerzt);
      if (!gruppe) return;
      for (const userId of ausgewaehlt) {
        const nachMitglied = await gruppenApi.mitgliedHinzufuegen(gruppe.id, userId);
        if (nachMitglied) gruppe = nachMitglied;
      }
      privateGruppen.upsert(gruppe);
      open = false;
      // Die Aufrufer navigieren selbst (onSelectGruppe springt in den Chat) —
      // hier ein zweites goto wäre nur Rennen um dieselbe Adresse.
      onErstellt(gruppe.id);
    } catch (e) {
      toast.error(m.chats_new_group_create_failed(), {
        description: e instanceof Error ? e.message : undefined
      });
    } finally {
      amAnlegen = false;
    }
  }

  function initialen(anzName: string): string {
    return anzName.slice(0, 1).toUpperCase();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-sm" data-testid="chats-new-group-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.chats_new_group()}</Dialog.Title>
      <Dialog.Description>{m.chats_new_group_hint()}</Dialog.Description>
    </Dialog.Header>
    <input
      type="text"
      bind:value={name}
      placeholder={m.chats_new_group_name_placeholder()}
      class="border-border bg-bg-input focus:border-primary w-full rounded-xl border px-3 py-2.5 text-sm outline-none"
      data-testid="new-group-name"
      aria-label={m.chats_new_group_name_placeholder()}
    />
    <div class="flex max-h-[45vh] flex-col gap-1 overflow-y-auto">
      {#each friends.list as f (f.user_id)}
        {@const anzName = userCache.displayName(f.user_id)}
        {@const bild = safeAvatarUrl(userCache.get(f.user_id)?.avatar_url ?? null)}
        <button
          type="button"
          class="hover:bg-bg-hover flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors"
          onclick={() => umschalten(f.user_id)}
          data-testid={`new-group-friend-${f.user_id}`}
          data-selected={ausgewaehlt.has(f.user_id)}
        >
          {#if bild}
            <img src={bild} alt="" class="size-10 shrink-0 rounded-full object-cover" />
          {:else}
            <span
              class="accent-gradient flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
              >{initialen(anzName)}</span
            >
          {/if}
          <span class="truncate text-sm font-semibold" style={nameStyle(f.user_id)}>{anzName}</span>
          <input
            type="checkbox"
            checked={ausgewaehlt.has(f.user_id)}
            class="accent-primary pointer-events-none ml-auto size-4"
            tabindex={-1}
          />
        </button>
      {/each}
    </div>
    <button
      type="button"
      disabled={!name.trim() || amAnlegen}
      class="accent-gradient text-primary-foreground min-h-11 w-full rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
      onclick={anlegen}
      data-testid="new-group-create"
    >
      {m.chats_new_group_create()}
    </button>
  </Dialog.Content>
</Dialog.Root>
