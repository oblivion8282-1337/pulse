<!--
  Der Neu-Knopf, der aufklappt.

  Ein blanker „+"-Knopf erzeugt eine leere Rolle, und eine leere Rolle ist
  der Anfang des haeufigsten Fehlers: man klickt sich nicht 27 Bits
  zusammen, man nimmt die naechstbeste vorhandene Rolle als Vorlage — und
  die naechstbeste ist oft die maechtigste. Deshalb bietet dieses Menue
  drei benannte Startpunkte mit SICHTBAREM Rechtesatz und das Duplizieren
  der gerade gewaehlten Rolle an. „Wie diese, aber ohne das eine Recht"
  ist ohnehin der haeufigste Wunsch.
-->
<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import FilePlusIcon from '@lucide/svelte/icons/file-plus';
  import type { Role, RoleCreatePayload } from '$lib/api/roles';
  import { m } from '$lib/paraglide/messages.js';
  import { beschnitten, bitsAlsString, namenDerBits, vorlagen, wirdBeschnitten } from './vorlagen';

  let {
    editorPermissions,
    auswahl,
    oncreate
  }: {
    editorPermissions: string;
    /** Die gerade gewaehlte Rolle — Ziel des „duplizieren"-Eintrags. */
    auswahl: Role | undefined;
    oncreate: (payload: RoleCreatePayload) => void;
  } = $props();

  let offen = $state(false);
  let liste = $derived(vorlagen());
  // @everyone laesst sich nicht sinnvoll duplizieren: sie ist keine
  // vergebene Rolle, sondern der Boden. Ein Duplikat davon waere eine
  // gewoehnliche Rolle mit demselben Namen — verwirrend statt nuetzlich.
  let duplizierbar = $derived(auswahl && !auswahl.is_everyone ? auswahl : undefined);
  let irgendwasBeschnitten = $derived(
    liste.some((v) => wirdBeschnitten(v.bits, editorPermissions))
  );

  function waehlen(payload: RoleCreatePayload): void {
    offen = false;
    oncreate(payload);
  }
</script>

<DropdownMenu.Root bind:open={offen}>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} size="icon-sm" variant="ghost" data-testid="role-create"
        aria-label={m.rollen_anlegen_knopf()}>
        <PlusIcon />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class="w-72" align="start">
    <DropdownMenu.Item
      onSelect={() =>
        waehlen({ name: m.roles_editor_new_role_default_name(), permissions: '0' })}
      data-testid="role-create-empty"
    >
      <FilePlusIcon class="size-4" />
      <span>{m.rollen_anlegen_leer()}</span>
    </DropdownMenu.Item>

    <DropdownMenu.Separator />
    <DropdownMenu.GroupHeading>{m.rollen_anlegen_vorlagen()}</DropdownMenu.GroupHeading>
    {#each liste as v (v.id)}
      <DropdownMenu.Item
        class="flex-col items-start gap-0.5"
        onSelect={() =>
          waehlen({ name: v.name, permissions: bitsAlsString(v.bits, editorPermissions) })}
        data-testid={`role-create-template-${v.id}`}
      >
        <span class="text-text-bright text-sm font-medium">{v.name}</span>
        <span class="text-text-muted text-xs leading-snug whitespace-normal">
          {namenDerBits(v.bits).join(' · ')}
        </span>
      </DropdownMenu.Item>
    {/each}

    {#if duplizierbar}
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        onSelect={() =>
          waehlen({
            name: m.rollen_anlegen_kopie_name({ name: duplizierbar.name }),
            // Auch beim Duplizieren auf die eigenen Rechte beschnitten:
            // der Server laesst nichts durch, was der Bearbeiter selbst
            // nicht haelt, und eine abgelehnte Anlage saehe nach einem
            // Fehler der Anwendung aus statt nach einer Grenze.
            permissions: beschnitten(duplizierbar.permissions, editorPermissions),
            color: duplizierbar.color,
            hoist: duplizierbar.hoist,
            mentionable: duplizierbar.mentionable
          })}
        data-testid="role-create-duplicate"
      >
        <CopyIcon class="size-4" />
        <span class="truncate">{m.rollen_anlegen_duplizieren({ name: duplizierbar.name })}</span>
      </DropdownMenu.Item>
    {/if}

    {#if irgendwasBeschnitten}
      <p class="text-text-muted px-2 py-1.5 text-xs leading-snug">
        {m.rollen_anlegen_beschnitten_hinweis()}
      </p>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
