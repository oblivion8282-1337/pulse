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
  import { dropboxApi } from '$lib/api/dropbox';

  let {
    open = false,
    guildId = '',
    dropboxAllowed = false,
    onClose,
    onCreate
  }: {
    open?: boolean;
    /** Aktive Community — für das Nachladen des Community-Master-Schalters. */
    guildId?: string;
    /** Hat der Server-Betreiber die Ablage für DIESE Community freigegeben?
     *  Gesperrt ist der Normalfall — anders als die Instanz-Policy unten wird
     *  hier nicht ins Blaue gezeigt, weil ein Nein hier eine bewusste
     *  Einzelentscheidung ist und nicht ein noch nicht geladener Wert. */
    dropboxAllowed?: boolean;
    onClose: () => void;
    onCreate: (name: string, type: number) => void;
  } = $props();

  // Drei Ebenen, alle müssen zustimmen:
  //   1. Instanz-Policy des aktiven Servers (die Cloud kann die Ablage ganz
  //      abschalten — sie nimmt beliebige Dateitypen, die kein Hash-Matching
  //      sehen kann). Fehlt der Capability-Eintrag noch, zeigen wir die
  //      Option: der Server 404't sie notfalls selbst.
  //   2. Freigabe für diese Community durch den Betreiber (Server-
  //      Einstellungen → Communitys). Die Community-Leitung kann das nicht
  //      selbst umlegen.
  //   3. Der eigene Master-Schalter der Community (Community-Einstellungen →
  //      Ablage). Hat die Leitung ihre Ablage abgeschaltet, soll man auch
  //      keinen neuen Kanal anlegen können. Der wird beim Öffnen frisch
  //      geladen (unten), damit er nie veraltet ist.
  let communityDropboxEnabled = $state(true);
  const dropboxAvailable = $derived(
    (serverCapabilities.get(activeServer.serverId)?.dropboxEnabled ?? true) &&
      dropboxAllowed &&
      communityDropboxEnabled
  );
  // Instanz-Modus „Nur Ablage" (Konzept §2a): Klartext-Textkanäle sind
  // gesperrt — der Server verwirft deren Anlage und Posten. Der
  // verschlüsselte Ablage-Kanal (mit Verbindungs-Assistent) kommt mit der
  // Krypto-Etappe; bis dahin bleibt der Text-Weg hier bewusst tot.
  const nurAblage = $derived(
    serverCapabilities.get(activeServer.serverId)?.channelCreationPolicy === 'ablage_only'
  );

  $effect(() => {
    // Nur laden, wenn Instanz + Betreiber die Ablage überhaupt zulassen —
    // sonst zeigt der Dialog die Option ohnehin nicht. Optimistischer Default
    // true: der deaktivierte Fall ist selten, so flackert nichts im Normalfall.
    if (!open || !dropboxAllowed || !guildId) {
      communityDropboxEnabled = true;
      return;
    }
    let cancelled = false;
    dropboxApi
      .getQuota(guildId)
      .then((cfg) => {
        if (!cancelled) communityDropboxEnabled = cfg.enabled;
      })
      .catch(() => {
        // 404 = noch keine Config = Ablage verfügbar (Default beim Erstanlegen).
        if (!cancelled) communityDropboxEnabled = true;
      });
    return () => {
      cancelled = true;
    };
  });

  let name = $state('');
  // 0 = text, 1 = voice, 2 = dropbox (per-guild file storage).
  // The route page handles type=2 by routing to /dropbox/channel
  // instead of POST /channels.
  let type = $state<number>(0);

  // Fällt die Ablage weg, während sie ausgewählt war → zurück auf Text.
  $effect(() => {
    if (!dropboxAvailable && type === 2) type = 0;
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
        <div class={dropboxAvailable ? 'grid grid-cols-3 gap-2' : 'grid grid-cols-2 gap-2'}>
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
          {#if dropboxAvailable}
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
