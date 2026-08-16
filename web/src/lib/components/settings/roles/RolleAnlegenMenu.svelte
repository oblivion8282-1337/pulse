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

  let liste = $derived(vorlagen());
  // @everyone laesst sich nicht sinnvoll duplizieren: sie ist keine
  // vergebene Rolle, sondern der Boden. Ein Duplikat davon waere eine
  // gewoehnliche Rolle mit demselben Namen — verwirrend statt nuetzlich.
  let duplizierbar = $derived(auswahl && !auswahl.is_everyone ? auswahl : undefined);
  let irgendwasBeschnitten = $derived(
    liste.some((v) => wirdBeschnitten(v.bits, editorPermissions))
  );

  /**
   * **Ein eigenes Klappfeld statt `DropdownMenu`** (2026-08-16).
   *
   * Der Vendor-Weg klappte in diesem Dialog nicht auf: der Knopf meldete
   * `aria-expanded`, der Inhalt wurde aber nie eingehängt — weder mit noch ohne
   * Portal, weder mit noch ohne eigenen `open`-Zustand. Im E2E-Lauf sichtbar
   * als „`role-create-empty` nie gefunden". Statt weiter an fremder Mechanik zu
   * raten: ein `<div>`, ein `$state`, fertig. Es ist ein Knopf mit vier
   * Einträgen; das trägt keine Bibliothek.
   */
  let offen = $state(false);

  function waehlen(payload: RoleCreatePayload): void {
    offen = false;
    oncreate(payload);
  }

  // Klick daneben und Escape schliessen — das Einzige, was ein Menü sonst noch
  // mitbringt und das man hier tatsächlich erwartet.
  function beiTaste(e: KeyboardEvent): void {
    if (e.key === 'Escape') offen = false;
  }
</script>

<svelte:window onkeydown={beiTaste} />

<div class="relative">
  <Button
    size="icon-sm"
    variant="ghost"
    onclick={() => (offen = !offen)}
    aria-expanded={offen}
    aria-haspopup="menu"
    data-testid="role-create"
    aria-label={m.rollen_anlegen_knopf()}
  >
    <PlusIcon />
  </Button>

  {#if offen}
    <!-- Der Klickfänger liegt UNTER dem Feld und schliesst es; ohne ihn bliebe
         das Feld beim Klick daneben stehen. -->
    <button
      type="button"
      class="fixed inset-0 z-40 cursor-default"
      tabindex="-1"
      aria-label={m.rollen_anlegen_schliessen()}
      onclick={() => (offen = false)}
    ></button>

    <div
      class="border-border bg-bg-panel absolute left-0 z-50 mt-1 flex w-72 flex-col gap-0.5
        rounded-xl border p-1.5 shadow-lg"
      role="menu"
      data-testid="role-create-menu"
    >
      <button
        type="button"
        role="menuitem"
        class="hover:bg-bg-hover flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
        onclick={() =>
          waehlen({ name: m.roles_editor_new_role_default_name(), permissions: '0' })}
        data-testid="role-create-empty"
      >
        <FilePlusIcon class="size-4 shrink-0" />
        <span>{m.rollen_anlegen_leer()}</span>
      </button>

      <div class="border-border/60 mt-1 border-t pt-1">
        <span class="text-text-muted px-2 text-xs">{m.rollen_anlegen_vorlagen()}</span>
      </div>
      {#each liste as v (v.id)}
        <button
          type="button"
          role="menuitem"
          class="hover:bg-bg-hover flex flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left"
          onclick={() =>
            waehlen({ name: v.name, permissions: bitsAlsString(v.bits, editorPermissions) })}
          data-testid={`role-create-template-${v.id}`}
        >
          <span class="text-text-bright text-sm font-medium">{v.name}</span>
          <span class="text-text-muted text-xs leading-snug">{namenDerBits(v.bits).join(' · ')}</span>
        </button>
      {/each}

      {#if duplizierbar}
        <button
          type="button"
          role="menuitem"
          class="hover:bg-bg-hover border-border/60 mt-1 flex items-center gap-2 rounded-lg border-t
            px-2 py-1.5 text-left text-sm"
          onclick={() =>
            waehlen({
              name: m.rollen_anlegen_kopie_name({ name: duplizierbar.name }),
              // Auch beim Duplizieren auf die eigenen Rechte beschnitten: der
              // Server laesst nichts durch, was der Bearbeiter selbst nicht
              // haelt, und eine abgelehnte Anlage saehe nach einem Fehler der
              // Anwendung aus statt nach einer Grenze.
              permissions: beschnitten(duplizierbar.permissions, editorPermissions),
              color: duplizierbar.color,
              hoist: duplizierbar.hoist,
              mentionable: duplizierbar.mentionable
            })}
          data-testid="role-create-duplicate"
        >
          <CopyIcon class="size-4 shrink-0" />
          <span class="truncate">{m.rollen_anlegen_duplizieren({ name: duplizierbar.name })}</span>
        </button>
      {/if}

      {#if irgendwasBeschnitten}
        <p class="text-text-muted px-2 py-1.5 text-xs leading-snug">
          {m.rollen_anlegen_beschnitten_hinweis()}
        </p>
      {/if}
    </div>
  {/if}
</div>
