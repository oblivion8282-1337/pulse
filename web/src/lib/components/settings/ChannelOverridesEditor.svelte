<!--
  Kanalrechte — Abweichungen je Rolle und je Mitglied, mit dem Ergebnis daneben.

  **Warum umgebaut.** Zwei Ebenen bestimmen, was jemand darf: die Rollen der
  Community als Grundlage und die Abweichungen je Kanal darüber. Die alte
  Ansicht zeigte nur die Abweichungen — man setzte Häkchen und wusste hinterher
  nicht, was gilt. Jetzt steht neben jeder Zeile, was am Ende herauskommt und
  woher es kommt („ja · aus Moderation", „nein · hier verboten"), und die
  revoke-all-Invariante des Servers (ohne „Kanal ansehen" fällt alles weg) ist
  sichtbar statt geraten.

  Die Rechnung selbst passiert nicht hier, sondern in `lib/permissions/`:
  `herkunft.ts` (Ergebnis + Herkunft), `entwurf.svelte.ts` (was noch nicht
  gespeichert ist), `kanalansicht.ts` (Entwurf über den Serverstand legen).
  Der Server prüft Anti-Eskalation unabhängig; die Sperren hier sind
  Rückmeldung, keine Sicherung.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import TrashIcon from '@lucide/svelte/icons/trash-2';
  import LockIcon from '@lucide/svelte/icons/lock';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import type { Member } from '$lib/api/types';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { roles as rollenStore } from '$lib/stores/roles.svelte';
  import { Perm, has, toBitfield, type Permission } from '$lib/permissions/bitfield';
  import { KanalEntwurf, type Zustand } from '$lib/permissions/entwurf.svelte';
  import { rechtsstaende, type Rechtsstand } from '$lib/permissions/herkunft';
  import { kanalrechte } from '$lib/permissions/kanalrechte';
  import {
    mitgliederUndRollen,
    wirkendeAbweichungen,
    zielAufloesung
  } from '$lib/permissions/kanalansicht';
  import { zielSchluessel } from '$lib/permissions/schnappschuesse';
  import { baueZiele } from '$lib/permissions/ziele';
  import ZielListe from '$lib/permissions/ui/ZielListe.svelte';
  import ZielAnsicht from '$lib/permissions/ui/ZielAnsicht.svelte';
  import SpeicherLeiste from '$lib/permissions/ui/SpeicherLeiste.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channelId,
    guildId,
    kanalName,
    editorPermissions
  }: { channelId: string; guildId: string; kanalName: string; editorPermissions: string } =
    $props();

  const entwurf = new KanalEntwurf(() => channelId);

  let mitglieder = $state<Member[]>([]);
  let rollenIdsJeMitglied = $state<Record<string, string[]>>({});
  let ausgewaehlt = $state<string | null>(null);
  let loeschFrage = $state(false);
  let loescht = $state(false);

  let rechte = $derived(kanalrechte());
  let perms = $derived(rechte.map((r) => r.perm));
  let alleRollen = $derived(rollenStore.byGuild[guildId] ?? []);
  let overwrites = $derived(channelPermissions.byChannel[channelId] ?? []);
  let ziele = $derived(baueZiele(alleRollen, mitglieder, (k) => entwurf.gesetzte(k, perms)));
  let namen = $derived(new Map(ziele.map((z) => [z.key, z.name])));
  let gewaehlt = $derived(ziele.find((z) => z.key === ausgewaehlt) ?? null);
  let besitzerId = $derived(
    guilds.byId[guildId]?.owner_id ?? serverGuilds.findGuild(guildId)?.owner_id ?? null
  );
  let abweichungen = $derived(
    wirkendeAbweichungen(overwrites, entwurf, (k) => namen.get(k) ?? k)
  );
  let staende = $derived.by<Map<Permission, Rechtsstand>>(() => {
    if (!gewaehlt) return new Map();
    return rechtsstaende(
      zielAufloesung({
        key: gewaehlt.key,
        guildId,
        rollen: alleRollen,
        rollenIdsJeMitglied,
        besitzerId,
        abweichungen
      }),
      perms
    );
  });
  let offen = $derived(entwurf.offenGesamt(perms));
  let editorBits = $derived(toBitfield(editorPermissions));
  let everyone = $derived(alleRollen.find((r) => r.is_everyone));
  let hatZeile = $derived(
    !!gewaehlt && overwrites.some((ow) => zielSchluessel(ow) === gewaehlt.key)
  );
  // „Nur für diese Rolle" ergibt nur Sinn, solange @everyone den Kanal noch
  // sehen darf — sonst ist er längst geschlossen.
  let everyoneSiehtNoch = $derived(
    !everyone || !has(entwurf.stand(`0:${everyone.id}`).deny, Perm.VIEW_CHANNEL)
  );
  let kannExklusiv = $derived(
    !!gewaehlt && gewaehlt.art === 0 && !gewaehlt.istEveryone && !!everyone && everyoneSiehtNoch
  );

  // Vorauswahl: das erste Ziel mit Abweichung, sonst @everyone. Ein leerer
  // rechter Bereich beim Öffnen sähe aus, als gäbe es nichts einzustellen.
  let letzterKanal = $state('');
  $effect(() => {
    if (letzterKanal !== channelId) {
      letzterKanal = channelId;
      ausgewaehlt = null;
      entwurf.verwirf();
      return;
    }
    if (ausgewaehlt || ziele.length === 0) return;
    ausgewaehlt = (ziele.find((z) => z.gesetzte > 0) ?? ziele[0]).key;
  });

  onMount(async () => {
    const geladen = await mitgliederUndRollen(guildId);
    mitglieder = geladen.mitglieder;
    rollenIdsJeMitglied = geladen.rollenIdsJeMitglied;
  });

  function setze(perm: Permission, zu: Zustand): void {
    if (ausgewaehlt) entwurf.setze(ausgewaehlt, perm, zu);
  }

  async function speichern(): Promise<void> {
    try {
      await entwurf.speichern(perms);
      toast.success(m.kanalrechte_toast_gespeichert());
    } catch (err) {
      toast.error(m.kanalrechte_toast_speichern_fehler(), {
        description: (err as Error).message
      });
    }
  }

  async function loeschen(): Promise<void> {
    const key = ausgewaehlt;
    // bits-ui schliesst den Dialog beim Bestätigen nicht selbst — ein zweiter
    // Klick im Flug schickte dasselbe DELETE erneut und holte sich einen 404.
    if (!key || loescht) return;
    loescht = true;
    try {
      await entwurf.loesche(key);
      toast.success(m.kanalrechte_toast_geloescht());
    } catch (err) {
      toast.error(m.kanalrechte_toast_loeschen_fehler(), {
        description: (err as Error).message
      });
    } finally {
      loescht = false;
      loeschFrage = false;
    }
  }

  function exklusiv(): void {
    if (!gewaehlt || !everyone) return;
    entwurf.exklusiv(gewaehlt.id, everyone.id);
    toast.info(m.kanalrechte_toast_exklusiv());
  }
</script>

<div class="flex h-full min-h-0 flex-col gap-4 md:flex-row" data-testid="channel-overrides">
  <aside class="w-full shrink-0 md:w-64">
    <ZielListe {ziele} {ausgewaehlt} onwaehle={(k) => (ausgewaehlt = k)} />
  </aside>

  <section class="flex min-w-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if gewaehlt}
        <!-- Festhalten, damit die Rückrufe unten kein `gewaehlt` schliessen,
             das TypeScript ausserhalb des Blocks wieder für leer hält. -->
        {@const ziel = gewaehlt}
        <ZielAnsicht
          {ziel}
          {kanalName}
          {rechte}
          {staende}
          zustandFuer={(perm) => entwurf.zustand(ziel.key, perm)}
          gesperrt={(perm) => !has(editorBits, perm)}
          onsetze={setze}
        >
          {#snippet kopfAktionen()}
            {#if kannExklusiv}
              <Button
                size="sm"
                variant="ghost"
                onclick={exklusiv}
                title={m.kanalrechte_exklusiv_hinweis()}
                data-testid="perm-exclusive-btn"
              >
                <LockIcon /> {m.kanalrechte_btn_exklusiv()}
              </Button>
            {/if}
            {#if hatZeile}
              <Button
                size="sm"
                variant="ghost"
                onclick={() => (loeschFrage = true)}
                data-testid="perm-delete-btn"
              >
                <TrashIcon /> {m.kanalrechte_btn_abweichung_loeschen()}
              </Button>
            {/if}
          {/snippet}
        </ZielAnsicht>
      {:else}
        <EmptyState message={m.kanalrechte_kein_ziel()} />
      {/if}
    </div>

    <SpeicherLeiste
      {offen}
      speichert={entwurf.speichert}
      onverwerfen={() => entwurf.verwirf()}
      onspeichern={speichern}
    />
  </section>
</div>

<!-- Rückfrage vor dem Löschen: eine ganze Abweichung fällt damit weg, und das
     Löschen einer Rolle fragt seit jeher nach — hier fehlte die Frage. -->
<AlertDialog.Root bind:open={loeschFrage}>
  <AlertDialog.Content data-testid="perm-delete-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.kanalrechte_loeschen_titel()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.kanalrechte_loeschen_text({ ziel: gewaehlt?.name ?? '' })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={loescht}>{m.kanalrechte_loeschen_abbrechen()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={loeschen} disabled={loescht} data-testid="perm-delete-confirm-btn">
        {m.kanalrechte_btn_abweichung_loeschen()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
