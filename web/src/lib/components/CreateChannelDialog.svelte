<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import HashIcon from '@lucide/svelte/icons/hash';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import { m } from '$lib/paraglide/messages.js';
  import { serverCapabilities } from '$lib/stores/serverCapabilities.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { ABLAGE_KANAL_ENABLED } from '$lib/featureFlags';

  let {
    open = false,
    guildId = '',
    onClose,
    onCreate
  }: {
    open?: boolean;
    /** Aktive Community — für das Nachladen des Community-Master-Schalters. */
    guildId?: string;
    onClose: () => void;
    onCreate: (name: string, type: number) => void;
  } = $props();

  // Instanz-Modus „Nur Ablage" (Konzept §2a): Klartext-Textkanäle sind
  // gesperrt — der Server verwirft deren Anlage und Posten. Der
  // verschlüsselte Ablage-Kanal (mit Verbindungs-Assistent) kommt mit der
  // Krypto-Etappe; bis dahin bleibt der Text-Weg hier bewusst tot.
  const nurAblage = $derived(
    serverCapabilities.get(activeServer.serverId)?.channelCreationPolicy === 'ablage_only'
  );

  // Die dritte Option („Ablage") ist seit dem 2026-09-11 das Pulse-Laufwerk:
  // verschlüsselter Community-Speicher auf dem Pulse-Server, für JEDERLEI
  // Community ohne Betreiber-Freigabe (Festlegung nach Abstimmung, Spec
  // §11). Die alte Dreifach-Gate aus Dropbox-Zeiten (Instanz-Capability,
  // ``guild.dropbox_allowed``, Community-Schalter) steuert nur noch den
  // veralteten Dropbox-Speicherweg und ist hier entfallen.
  const ablageAvailable = ABLAGE_KANAL_ENABLED;

  let name = $state('');
  // 0 = text, 1 = voice, 2 = Ablage (Community-Dateiablage, verschlüsselt
  // über das Pulse-Laufwerk). Die Kanalliste kennt genau einen solchen
  // Kanal je Community; die Route leitet den Namen an den idempotenten
  // Ablage-Endpoint weiter.
  let type = $state<number>(0);

  // Fällt die Ablage weg, während sie ausgewählt war → zurück auf Text.
  $effect(() => {
    if (!ablageAvailable && type === 2) type = 0;
  });
  $effect(() => {
    if (nurAblage && type === 0) type = 1;
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      name = '';
      type = 0;
      onClose();
    }
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    // Der Name bleibt, wie getippt: Groß-/Kleinschreibung und Leerzeichen
    // bleiben erhalten, nur Mehrfach-Leerzeichen laufen auf eins zusammen.
    // Das Backend (validate_name) erlaubt beides — Slugify war Client-Only.
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (!trimmed) return;
    onCreate(trimmed, type);
    name = '';
    type = 0;
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="create-channel-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.create_channel_dialog_title()}</Dialog.Title>
      <Dialog.Description>{m.create_channel_dialog_description()}</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">{m.create_channel_dialog_type_label()}</Label>
        <!-- Spaltenzahl folgt den sichtbaren Optionen — fixes grid-cols-3 ließe ohne
             die Ablage eine leere Zelle stehen. Klassen als Literale: Tailwind findet
             zusammengebaute Namen beim Purgen nicht. -->
        <div class={ablageAvailable ? 'grid grid-cols-3 gap-2' : 'grid grid-cols-2 gap-2'}>
          <Button
            type="button"
            variant={type === 0 ? 'default' : 'secondary'}
            class="justify-center gap-2"
            onclick={() => (type = 0)}
            disabled={nurAblage}
            title={nurAblage
              ? 'Diese Instanz erlaubt nur verschlüsselte Ablage-Kanäle'
              : undefined}
            data-testid="create-channel-type-text"
          >
            <HashIcon class="size-4" />
            {m.create_channel_dialog_type_text()}
          </Button>
          <Button
            type="button"
            variant={type === 1 ? 'default' : 'secondary'}
            class="justify-center gap-2"
            onclick={() => (type = 1)}
            data-testid="create-channel-type-voice"
          >
            <Volume2Icon class="size-4" />
            {m.create_channel_dialog_type_voice()}
          </Button>
          {#if ablageAvailable}
            <Button
              type="button"
              variant={type === 2 ? 'default' : 'secondary'}
              class="justify-center gap-2"
              onclick={() => (type = 2)}
              data-testid="create-channel-type-dropbox"
            >
              <FolderIcon class="size-4" />
              {m.create_channel_dialog_type_dropbox()}
            </Button>
          {/if}
        </div>
      </div>
      {#if nurAblage}
        <p class="text-muted-foreground text-xs leading-relaxed">
          Diese Instanz erlaubt nur verschlüsselte Ablage-Kanäle — zum Erstellen
          ist eine verbundene Cloud-Ablage nötig. Der Verbindungs-Assistent
          kommt mit der Krypto-Etappe.
        </p>
      {/if}
      <div class="space-y-1.5">
        <FieldLabel for="create-channel-name" required class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          {m.create_channel_dialog_name_label()}
        </FieldLabel>
        <Input
          id="create-channel-name"
          type="text"
          bind:value={name}
          required
          minlength={1}
          maxlength={64}
          data-testid="create-channel-name"
        />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => handleOpenChange(false)}>{m.create_channel_dialog_cancel()}</Button>
        <Button type="submit" data-testid="create-channel-submit">{m.create_channel_dialog_submit()}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
