<!--
  Reiter „Prüfen" — die Frage, die man wirklich hat: „darf anna hier streamen?"

  Der Reiter „Rechte" beantwortet sie nur indirekt: dort steht, was für eine
  ROLLE gilt, während eine Person mehrere Rollen trägt und obendrein eine eigene
  Abweichung haben kann. Hier wird für einen konkreten Menschen gerechnet — mit
  demselben Resolver, nur mit dessen echten Rollen.

  **Gezeigt wird der gespeicherte Stand.** Ein ungespeicherter Entwurf aus dem
  anderen Reiter fließt NICHT ein: „Prüfen" soll sagen, was gerade gilt, nicht
  was gälte, wenn man speicherte — sonst prüft man seinen eigenen Wunsch.

  **Und es ist eine Untergrenze.** Ob jemand Instanz-Administrator ist, steht
  nur in dessen eigener Sitzung; solche Nutzer dürfen serverseitig alles. Die
  Ansicht sagt deshalb „mindestens", wie `remote/berechtigte.ts` auch.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Label } from '$lib/components/ui/label/index.js';
  import Select from '$lib/components/form/Select.svelte';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import type { Member } from '$lib/api/types';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { roles as rollenStore } from '$lib/stores/roles.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import type { Permission } from '../bitfield';
  import { rechtsstaende, type Rechtsstand } from '../herkunft';
  import { mitgliederUndRollen } from '../kanalansicht';
  import { kanalrechte } from '../kanalrechte';
  import { benannteOverwrites, benannteRollen, zielSchluessel } from '../schnappschuesse';
  import { ergebnisFarbe, ergebnisText } from '../texte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    guildId,
    channelId,
    kanalName
  }: { guildId: string; channelId: string; kanalName: string } = $props();

  let mitglieder = $state<Member[]>([]);
  let rollenIdsJeMitglied = $state<Record<string, string[]>>({});
  let personId = $state('');

  let rechte = $derived(kanalrechte());
  let alleRollen = $derived(rollenStore.byGuild[guildId] ?? []);
  let overwrites = $derived(channelPermissions.byChannel[channelId] ?? []);
  let besitzerId = $derived(
    guilds.byId[guildId]?.owner_id ?? serverGuilds.findGuild(guildId)?.owner_id ?? null
  );

  function nameFuer(key: string): string {
    const [art, id] = key.split(':');
    if (art === '0') return alleRollen.find((r) => r.id === id)?.name ?? id;
    const mem = mitglieder.find((x) => x.user_id === id);
    return mem?.nickname ?? userCache.displayName(id);
  }

  let staende = $derived.by<Map<Permission, Rechtsstand>>(() => {
    if (!personId) return new Map();
    return rechtsstaende(
      {
        userId: personId,
        isMember: true,
        isOwner: besitzerId === personId,
        rollen: benannteRollen(guildId, new Set(rollenIdsJeMitglied[personId] ?? [])),
        overwrites: benannteOverwrites(overwrites, (ow) => nameFuer(zielSchluessel(ow))),
        // Die eigene Abweichung der Person liest sich als „hier verboten",
        // nicht als „hier verboten über Anna".
        eigenerSchluessel: `1:${personId}`
      },
      rechte.map((r) => r.perm)
    );
  });

  onMount(async () => {
    const geladen = await mitgliederUndRollen(guildId);
    mitglieder = geladen.mitglieder;
    rollenIdsJeMitglied = geladen.rollenIdsJeMitglied;
  });

  // Der Leerwert ist der Platzhalter („niemand gewählt"), kein Eintrag: die
  // Ansicht zeigt darunter bewusst den Leerzustand statt einer Rechnung.
  const personOptionen = $derived(
    mitglieder.map((mem) => ({
      value: mem.user_id,
      label: mem.nickname ?? userCache.displayName(mem.user_id),
    })),
  );
</script>

<div class="space-y-4" data-testid="perm-check">
  <header>
    <h2 class="text-text-bright text-base font-semibold">
      {m.kanalrechte_pruefen_titel({ kanal: kanalName })}
    </h2>
    <p class="text-text-muted text-xs">{m.kanalrechte_pruefen_hinweis()}</p>
  </header>

  <div class="max-w-sm">
    <Label for="perm-check-person">{m.kanalrechte_pruefen_person()}</Label>
    <Select
      id="perm-check-person"
      value={personId}
      options={personOptionen}
      placeholder={m.kanalrechte_pruefen_platzhalter()}
      onchange={(v) => (personId = v)}
      data-testid="perm-check-select"
    />
  </div>

  {#if !personId}
    <EmptyState message={m.kanalrechte_pruefen_leer()} />
  {:else}
    <ul class="divide-border divide-y">
      {#each rechte as recht (recht.perm)}
        {@const stand = staende.get(recht.perm)}
        {#if stand}
          <li
            class="flex items-center justify-between gap-4 py-2"
            data-testid={`perm-check-row-${recht.perm}`}
          >
            <div class="min-w-0">
              <p class="text-text-bright truncate text-sm font-medium">{recht.name}</p>
              <p class="text-text-muted truncate text-xs">{recht.satz}</p>
            </div>
            <p class={`shrink-0 text-xs ${ergebnisFarbe(stand)}`}>
              {ergebnisText(stand)}
            </p>
          </li>
        {/if}
      {/each}
    </ul>
    <p class="text-text-muted text-xs">{m.kanalrechte_pruefen_mindestens()}</p>
  {/if}
</div>
