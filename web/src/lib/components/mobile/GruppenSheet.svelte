<script lang="ts">
  /**
   * Gruppen-Blatt — Mitglieder sehen, hinzufügen, entfernen, gehen.
   *
   * Der zweite fehlende Bildschirm von P0.4 (s. Übergabe §5): Die
   * Verwaltungs-API (`mitgliedHinzufuegen`, `mitgliedEntfernen`, `verlassen`)
   * hatte keinen Aufrufer. Jede Mutation schreibt die Server-Antwort in den
   * `privateGruppen`-Store — die Antwort ist die neue Gruppen-Wahrheit, ein
   * lokales Umflicken wäre nur eine zweite, schlechtere Kopie.
   *
   * **Hinzufügen nur aus den Freunden:** Es gibt keinen Einladungs-Link-Flow
   * (bewusst zurückgestellt) — Mitglieder werden direkt per `user_id`
   * hinzugefügt, und die einzige Quelle für passende `user_id`s sind die
   * eigenen Freunde. **Entfernen nur der Ersteller** (so begrenzt es das
   * Backend) und nie auf sich selbst.
   */
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import XIcon from '@lucide/svelte/icons/x';
  import PhoneIcon from '@lucide/svelte/icons/phone';
  import { friends } from '$lib/stores/friends.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { gruppenApi, type PrivateGruppe } from '$lib/api/gruppen';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { toast } from 'svelte-sonner';

  let {
    gruppe,
    open = $bindable(false),
    onVerlassen,
    onAnrufen
  }: {
    gruppe: PrivateGruppe;
    open?: boolean;
    /** Nach dem Verlassen — der Aufrufer navigiert weg (Kanal existiert dann nicht mehr). */
    onVerlassen?: () => void;
    /** Gruppenanruf starten (Anrufe-Epic D). */
    onAnrufen?: () => void;
  } = $props();

  let freundeZumHinzufuegen = $derived(
    friends.list.filter((f) => !gruppe.members.some((mm) => mm.user_id === f.user_id))
  );
  /** Entfernen-X: nur der Ersteller, nur andere — so begrenzt es das Backend. */
  let darfEntfernen = $derived(gruppe.ersteller_id === currentServerUserId());
  let verlassenBestaetigt = $state(false);
  let amArbeiten = $state(false);

  $effect(() => {
    if (open) {
      verlassenBestaetigt = false;
      for (const mm of gruppe.members) userCache.queue(mm.user_id);
      for (const f of freundeZumHinzufuegen) userCache.queue(f.user_id);
    }
  });

  async function hinzufuegen(userId: string) {
    if (amArbeiten) return;
    amArbeiten = true;
    try {
      const neu = await gruppenApi.mitgliedHinzufuegen(gruppe.id, userId);
      if (neu) privateGruppen.upsert(neu);
    } catch (e) {
      aktionFehlgeschlagen(e);
    } finally {
      amArbeiten = false;
    }
  }

  async function entfernen(userId: string) {
    if (amArbeiten) return;
    amArbeiten = true;
    try {
      const neu = await gruppenApi.mitgliedEntfernen(gruppe.id, userId);
      // `null` = Gruppe damit aufgelöst — dann ist hier auch Schluss.
      if (neu) privateGruppen.upsert(neu);
      else privateGruppen.entfernen(gruppe.id);
    } catch (e) {
      aktionFehlgeschlagen(e);
    } finally {
      amArbeiten = false;
    }
  }

  async function verlassen() {
    if (!verlassenBestaetigt) {
      verlassenBestaetigt = true;
      return;
    }
    if (amArbeiten) return;
    amArbeiten = true;
    try {
      const neu = await gruppenApi.verlassen(gruppe.id);
      if (neu) privateGruppen.upsert(neu);
      else privateGruppen.entfernen(gruppe.id);
      open = false;
      onVerlassen?.();
    } catch (e) {
      aktionFehlgeschlagen(e);
    } finally {
      amArbeiten = false;
    }
  }

  function aktionFehlgeschlagen(e: unknown) {
    toast.error(m.gruppen_aktion_fehlgeschlagen(), {
      description: e instanceof Error ? e.message : undefined
    });
  }

  function initialen(anzName: string): string {
    return anzName.slice(0, 1).toUpperCase();
  }
</script>

<BottomSheet
  {open}
  testid="group-sheet"
  closeLabel={m.gruppen_blatt_schliessen()}
  panelClass="bg-popover text-popover-foreground border-border relative flex max-h-[80dvh] flex-col overflow-y-auto rounded-t-[22px] border-t pb-[var(--safe-bottom)] shadow-2xl"
  onClose={() => (open = false)}
>
  <div class="bg-border mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-full"></div>
  <div class="px-4 pb-2">
    <p class="text-text-bright truncate text-base font-bold">{gruppe.name}</p>
    <p class="text-text-muted text-xs">
      {m.gruppen_blatt_mitglieder({ count: gruppe.members.length })}
    </p>
    {#if onAnrufen}
      <button
        type="button"
        class="text-primary hover:bg-bg-hover mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-border py-2 text-sm font-semibold"
        onclick={() => {
          open = false;
          onAnrufen();
        }}
        data-testid="group-call-button"
      >
        <PhoneIcon class="size-4" />
        {m.anruf_starten()}
      </button>
    {/if}
  </div>

  <ul class="flex flex-col gap-0.5 px-2">
    {#each gruppe.members as mm (mm.user_id)}
      {@const anzName = userCache.displayName(mm.user_id)}
      {@const bild = safeAvatarUrl(userCache.get(mm.user_id)?.avatar_url ?? null)}
      <li class="flex items-center gap-3 rounded-xl p-2" data-testid={`group-member-${mm.user_id}`}>
        {#if bild}
          <img src={bild} alt="" class="size-9 shrink-0 rounded-full object-cover" />
        {:else}
          <span
            class="accent-gradient flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
            >{initialen(anzName)}</span
          >
        {/if}
        <span class="truncate text-sm font-semibold" style={nameStyle(mm.user_id)}>{anzName}</span>
        {#if darfEntfernen && mm.user_id !== currentServerUserId()}
          <button
            type="button"
            class="text-text-muted hover:text-error ml-auto flex size-9 items-center justify-center rounded-full"
            onclick={() => entfernen(mm.user_id)}
            aria-label={m.gruppen_mitglied_entfernen()}
            data-testid={`group-member-remove-${mm.user_id}`}
          >
            <XIcon class="size-4" />
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if freundeZumHinzufuegen.length > 0}
    <p class="text-text-muted mt-3 px-4 pb-1 text-xs font-bold uppercase">
      {m.gruppen_blatt_hinzufuegen_kopf()}
    </p>
    <ul class="flex flex-col gap-0.5 px-2">
      {#each freundeZumHinzufuegen as f (f.user_id)}
        {@const anzName = userCache.displayName(f.user_id)}
        <li class="flex items-center gap-3 rounded-xl p-2">
          <span
            class="accent-gradient flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
            >{initialen(anzName)}</span
          >
          <span class="truncate text-sm font-semibold" style={nameStyle(f.user_id)}>{anzName}</span>
          <button
            type="button"
            class="text-primary hover:bg-bg-hover ml-auto flex size-9 items-center justify-center rounded-full"
            onclick={() => hinzufuegen(f.user_id)}
            aria-label={m.gruppen_mitglied_hinzufuegen()}
            data-testid={`group-member-add-${f.user_id}`}
          >
            <UserPlusIcon class="size-4" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="mt-4 px-4 pb-2">
    <button
      type="button"
      class="flex min-h-11 w-full items-center justify-center rounded-xl border border-red-500/40 py-2.5 text-sm font-bold text-red-500"
      onclick={verlassen}
      data-testid="group-leave"
    >
      {verlassenBestaetigt
        ? m.gruppen_blatt_verlassen_bestaetigen()
        : m.gruppen_blatt_verlassen()}
    </button>
  </div>
</BottomSheet>
