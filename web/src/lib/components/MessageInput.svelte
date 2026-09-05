<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import PaperclipIcon from '@lucide/svelte/icons/paperclip';
  import CameraIcon from '@lucide/svelte/icons/camera';
  import ComposerReplyBanner from './composer/ComposerReplyBanner.svelte';
  import ComposerEmojiButton from './composer/ComposerEmojiButton.svelte';
  import ComposerSendButton from './composer/ComposerSendButton.svelte';
  import AttachmentPreviewStrip from './AttachmentPreviewStrip.svelte';
  import MentionTriggerOverlay from './MentionTriggerOverlay.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { expandShortcodes } from '$lib/emoji';
  import { VerfasserAnhaenge } from '$lib/attachments/verfasserZeilen.svelte';
  import { dateienAusEinfuegen } from '$lib/attachments/eingefuegteDateien';
  import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { lookupComposer } from '$lib/shortcuts/engine.svelte';
  import { applyComposerAction } from '$lib/shortcuts/composerActions';
  import { isElectron } from '$lib/platform/runtime';
  import { canRecoverDroppedFiles, recoverDroppedFiles } from '$lib/platform/electronFiles';
  import { drafts } from '$lib/stores/drafts.svelte';
  import { untrack } from 'svelte';

  // `channelId` null → watch-party / stream-chat composer: attachments
  // (paperclip / paste / drop) are wired off, mention popup still works.
  let {
    channelId = null,
    placeholder = m.message_input_placeholder(),
    onSend,
    onTyping,
    replyTo = null,
    onCancelReply,
    disabled = false,
    disabledReason = '',
    handleDrop = true,
    attachmentsAllowed = true,
    attachmentAccept = '',
    verschluesselt = false
  }: {
    channelId?: string | null;
    placeholder?: string;
    onSend: (text: string, attachmentIds: string[], anhaenge: AnhangAngabe[]) => void;
    /** Fired (cheaply, on every keystroke with non-empty content) so the
     *  parent can broadcast a debounced "typing" signal. Optional — the
     *  stream/watch-party chat composer doesn't wire it. */
    onTyping?: () => void;
    replyTo?: { id: string; author: string; snippet: string } | null;
    onCancelReply?: () => void;
    /** When false, this composer skips its own drag-drop (overlay + handlers)
     *  because a parent owns a wider drop zone (ChatView makes the whole
     *  channel droppable and forwards files via `addExternalFiles`). Default
     *  true keeps the standalone stream/watch-party chat composer droppable. */
    handleDrop?: boolean;
    /** When true the input, attachment button and submit are inert. Used
     *  by the DM hard-cut foundation (Etappe 4): DMs without a confirmed
     *  friendship freeze the composer until friendship resumes. The
     *  banner UI lives in Etappe 5 — this prop only locks the form. */
    disabled?: boolean;
    /** Optional explanatory text shown in the input's placeholder when
     *  ``disabled`` is true (otherwise unused). */
    disabledReason?: string;
    /** False → this instance forbids attachments here (Cloud DMs). Removes the
     *  paperclip AND the paste/drop paths — hiding only the button would leave
     *  two working back doors into an endpoint the server 403s anyway. */
    attachmentsAllowed?: boolean;
    /** `accept` list for the file dialog (e.g. `image/*`); empty = anything.
     *  Cosmetic pre-filter only — the server enforces the same allowlist. */
    attachmentAccept?: string;
    /** Ende-zu-Ende-verschluesselter Verfasser (Etappe E): jede Datei wird auf
     *  dem Geraet verschluesselt und ueber die Postfach-Route hochgeladen,
     *  ihr Dateischluessel faehrt in der Nachricht mit. Aendert NUR den
     *  Upload-Weg — Auswahl, Vorschau und Abbruch bleiben identisch. */
    verschluesselt?: boolean;
  } = $props();

  const attachmentsEnabled = $derived(channelId !== null && attachmentsAllowed);

  let text = $state('');

  // Entwurf je Channel (auch DMs): beim Mount/Channel-Wechsel wiederherstellen …
  // (untrack: der Effect soll nur auf channelId reagieren, nicht auf spätere
  // Draft-Schreibvorgänge — sonst würde jeder Tastendruck ihn re-triggern.)
  $effect(() => {
    const id = channelId;
    text = id ? untrack(() => drafts.get(id)) : '';
  });
  // … und laufend sichern. Leerer Text löscht den Entwurf — damit räumt auch
  // das `text = ''` nach dem Senden den Entwurf automatisch weg. Deklaration
  // NACH dem Restore-Effect: beim Channel-Wechsel läuft erst der Restore,
  // dann sichert dieser Effect den frisch geladenen (unveränderten) Text.
  $effect(() => {
    const id = channelId;
    const t = text;
    if (id) untrack(() => drafts.set(id, t));
  });
  let textarea: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let cameraInput: HTMLInputElement | undefined = $state();

  // Anhang-Zeilen samt Upload-Buchfuehrung — inklusive der Weiche zwischen
  // Klartext- und verschluesseltem Weg (`verfasserZeilen.svelte.ts`).
  const anhaenge = new VerfasserAnhaenge();

  // Leaving the channel (switch or unmount) abandons any in-flight uploads of
  // the previous channel: abort them and revoke their preview object-URLs so a
  // half-finished upload neither lands in a channel we left nor leaks memory.
  //
  // **Der Effekt folgt der KENNUNG, nicht dem Kanal-Objekt** — und das ist
  // keine Feinheit, sondern die Ursache eines stillen Datenverlusts
  // (2026-09-01, gemessen im Hetzner-Nachweis). Bei einer Direktnachricht
  // baut `berechneSynthChannel` bei JEDER Neuberechnung ein frisches
  // `Channel`-Objekt; sie laeuft unter anderem, sobald ein Anzeigename im
  // `userCache` nachgeladen wird — was waehrend eines Uploads regelmaessig
  // passiert. Las dieser Effekt `channelId` direkt, haengte er damit am
  // Objekt und nicht an der Zeichenkette darin: jede Neuberechnung riss ihn
  // ab, sein Aufraeumer brach den laufenden Upload ab, und die Kachel
  // verschwand kommentarlos aus der Leiste — ohne Fehler, ohne Nachricht,
  // mit einer verwaisten Anhang-Zeile beim Server.
  //
  // Ein `$derived` auf denselben Wert bricht die Kette: es rechnet zwar
  // erneut, meldet seine Aenderung aber nur weiter, wenn die Zeichenkette
  // sich wirklich unterscheidet.
  const kanalSchluessel = $derived(channelId);
  $effect(() => {
    void kanalSchluessel; // track so the cleanup runs whenever the channel changes
    return () => anhaenge.alleAbbrechen();
  });

  let isDragging = $state(false);
  let dragDepth = 0; // dragenter/leave fire on every child — count to stay sane

  // Drag&drop file upload. In the Electron desktop app the sandboxed renderer
  // can't read OS-dropped file bytes directly (size 0 → upload 422) — but a
  // current shell exposes a native bridge that recovers them, so drop is enabled
  // when that bridge is present. Older shells (no bridge) stay disabled.
  // `handleDrop` still lets a parent own the zone (ChatView). Browsers: always on.
  const dropEnabled = $derived(
    handleDrop && attachmentsAllowed && (!isElectron() || canRecoverDroppedFiles())
  );

  // Mention overlay owns the popup state; we just forward textarea events.
  let mentionOverlay: MentionTriggerOverlay | undefined = $state();

  // DM channels aren't in the store → guildId stays null → autocomplete
  // suppresses role + everyone suggestions.
  const guildId = $derived(channelId ? guilds.guildIdForChannel(channelId) : null);

  const sendDisabled = $derived(
    disabled || (text.trim().length === 0 && anhaenge.zeilen.length === 0) || anhaenge.laeuftNoch
  );
  const effectivePlaceholder = $derived(
    disabled && disabledReason ? disabledReason : placeholder
  );

  function addFiles(files: FileList | File[]): void {
    // Single choke point for every entry path (picker, paste, drop, and the
    // parent's `addExternalFiles`) — guarding here rather than at each call
    // site is what keeps paste/drop from staying live once the button is gone.
    if (!channelId || !attachmentsAllowed) return;
    anhaenge.hinzufuegen(channelId, Array.from(files), verschluesselt);
  }

  /** Entry point for files dropped *outside* the composer — the whole
   *  ChatView is a drop zone (Discord-style), and it forwards the files here
   *  so they land in this composer's pending-upload strip. No-op when
   *  attachments are off (watch-party / stream chat). */
  export function addExternalFiles(files: FileList | File[]): void {
    addFiles(files);
  }

  const removeAttachment = (localId: string) => anhaenge.entfernen(localId);
  const onFilePick = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) addFiles(input.files);
    input.value = ''; // allow re-selecting the same file later
  };
  const onPaste = (e: ClipboardEvent) => {
    const dt = e.clipboardData;
    if (!dt) return;
    // Welche Dateien wirklich drinstecken, rechnet `eingefuegteDateien.ts`
    // (importfrei und dort unit-geprueft) — inklusive der Falle mit der
    // 0-Byte-Datei-Referenz im abgeschotteten Electron-Renderer.
    const collected = dateienAusEinfuegen(Array.from(dt.items), Array.from(dt.files));
    if (!collected.length) return; // nothing usable → leave default paste alone
    e.preventDefault(); // don't also drop a path/text into the textarea
    addFiles(collected);
  };

  function fire() {
    if (sendDisabled) return;
    const value = expandShortcodes(text).trim();
    // Convert `@DisplayName` placeholders back to `<@id>` wire format before
    // sending. The overlay tracked each autocomplete insertion; manually typed
    // @-patterns are left as-is (they won't match the tracked display texts).
    const markupValue = mentionOverlay?.toMarkup(value) ?? value;
    const ids = anhaenge.ids;
    if (!markupValue && ids.length === 0) return;
    onSend(markupValue, ids, anhaenge.anhaenge);
    text = '';
    anhaenge.nachDemSenden();
    mentionOverlay?.clear();
  }

  function onKeydown(e: KeyboardEvent) {
    if (mentionOverlay?.handleKey(e)) return; // popup gets first dibs on ↑/↓/Enter/Tab/Esc
    const composerAction = lookupComposer(e);
    if (composerAction && textarea && applyComposerAction(composerAction, textarea, text, (v) => (text = v))) {
      e.preventDefault();
      mentionOverlay?.update();
      return;
    }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); onCancelReply?.(); return; }
    // !e.isComposing: während einer IME-Komposition (CJK) bestätigt Enter den
    // Kandidaten — NICHT senden, sonst ginge der noch nicht committete Text
    // verloren (compositionend feuert erst nach diesem keydown).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); fire(); }
  }

  function onDragEnter(e: DragEvent) {
    if (!dropEnabled || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); dragDepth++; isDragging = true;
  }
  const onDragOver = (e: DragEvent) =>
    dropEnabled && e.dataTransfer?.types.includes('Files') && e.preventDefault();
  const onDragLeave = () => {
    if (!dropEnabled) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) isDragging = false;
  };
  async function onDrop(e: DragEvent) {
    // When a parent owns the drop zone (handleDrop=false) — or an older Electron
    // shell without the file bridge (dropEnabled=false) — we don't touch the
    // event so it can bubble to the ChatView section handler.
    if (!dropEnabled) return;
    e.preventDefault(); e.stopPropagation(); dragDepth = 0; isDragging = false;
    const list = e.dataTransfer?.files;
    if (!list?.length) return;
    // In Electron the dropped files arrive with 0 bytes — recover them through
    // the native bridge before uploading.
    const files = isElectron() ? await recoverDroppedFiles(list) : list;
    if (files.length) addFiles(files);
  }

  const onMentionSync = () => mentionOverlay?.update();

  function insertEmoji(emoji: string) {
    const ta = textarea;
    if (!ta) { text = text + emoji; return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    text = text.slice(0, start) + emoji + text.slice(end);
    queueMicrotask(() => { ta.focus(); ta.setSelectionRange(start + emoji.length, start + emoji.length); });
  }

  // Auto-Grow (Discord-Stil): das Eingabefeld wächst mit dem Inhalt mit, statt
  // ihn auf eine Zeile abzuschneiden. `text` als Abhängigkeit deckt JEDEN
  // Änderungspfad ab — Tippen, Einfügen, Emoji, Composer-Aktionen und das
  // Leeren nach dem Senden (dann schrumpft es wieder). Die Höhe wird auf
  // `scrollHeight` gesetzt; das CSS `max-h-40` deckelt sie und lässt darüber
  // scrollen. `height='auto'` zuerst, damit es beim Löschen auch wieder kleiner
  // wird (sonst bliebe der einmal erreichte Maximalwert stehen).
  $effect(() => {
    void text;
    const ta = textarea;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  });
</script>

<form
  class="px-2 pt-2 pb-[calc(1.25rem+var(--safe-bottom))] md:px-2 md:pb-2"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  onsubmit={(e) => { e.preventDefault(); fire(); }}
>
  {#if replyTo}
    <ComposerReplyBanner {replyTo} onCancel={onCancelReply} />
  {/if}

  <AttachmentPreviewStrip pending={anhaenge.zeilen} onRemove={removeAttachment} />

  <!-- `items-end` ohne Breakpoint: die Knöpfe sollen bei der Schreibmarke stehen,
       sobald der Text mehrzeilig wird. Bei einer Zeile ist es einerlei, weil der
       Textkasten genauso hoch ist wie die Knöpfe (siehe unten). -->
  <div
    class="bg-bg-input relative flex items-end gap-1.5 border border-border px-3 py-2 shadow-[var(--panel-shadow)] backdrop-blur-sm md:gap-2 md:px-4 md:py-3 dark:shadow-none
           {replyTo || anhaenge.zeilen.length > 0 ? 'rounded-b-2xl rounded-t-none' : 'rounded-2xl'}"
  >
    {#if isDragging}
      <div
        class="bg-primary/15 border-primary text-primary pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed text-sm font-medium"
        data-testid="drop-overlay"
      >
        {m.message_input_drop_files_hint()}
      </div>
    {/if}
    {#if attachmentsEnabled}
      <input
        type="file"
        multiple
        accept={attachmentAccept || undefined}
        bind:this={fileInput}
        onchange={onFilePick}
        class="sr-only"
        data-testid="attachment-file-input"
      />
      <!-- Kamera-Aufnahme (mobil): `capture` öffnet auf Android/iOS direkt die
           Kamera-App statt des Datei-Pickers; das geschossene Foto läuft durch
           dieselbe Upload-Pipeline wie ein gewähltes. Nur auf dem Handy — am
           Rechner wäre der Knopf nur ein zweiter Datei-Dialog. -->
      {#if viewport.istHandy}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          bind:this={cameraInput}
          onchange={onFilePick}
          class="sr-only"
          data-testid="attachment-camera-input"
        />
        <Button
          variant="ghost"
          size="icon"
          class="size-10 md:size-9"
          aria-label={m.message_input_take_photo()}
          onclick={() => cameraInput?.click()}
          data-testid="attachment-camera-button"
        >
          <CameraIcon class="size-5" />
        </Button>
      {/if}
      <Button
        variant="ghost"
        size="icon"
        class="size-10 md:size-9"
        aria-label={m.message_input_attach_file()}
        onclick={() => fileInput?.click()}
        data-testid="attachment-button"
      >
        <PaperclipIcon class="size-5" />
      </Button>
    {/if}
    <!-- `min-h-*` + `py-*` in zwei Grössen: Der Kasten ist damit jeweils so hoch
         wie die Knöpfe daneben und führt seine Zeile selbst mittig — 44px auf dem
         Handy (`size-10`-Knöpfe: 24px Zeilenhöhe + 2x8px Abstand), 36px ab
         Tablet (`md:size-9`: 24px + 2x6px). Weil die Reihe mit `items-end`
         unten ausrichtet, würde ein niederer Kasten mit seiner Unterkante an
         den Knöpfen kleben und die Textzeile unter die Feldmitte rutschen
         (auf dem Handy um gut 4px, gemessen).

         `leading-6` macht es exakt statt nur ungefähr: die Zeile füllt den
         Kasten vollständig aus und sitzt zwangsläufig mittig. -->
    <textarea
      bind:this={textarea}
      rows="1"
      bind:value={text}
      onkeydown={onKeydown}
      oninput={() => { mentionOverlay?.update(); if (text.trim()) onTyping?.(); }}
      onkeyup={onMentionSync}
      onclick={onMentionSync}
      onpaste={onPaste}
      onblur={() => mentionOverlay?.close()}
      placeholder={effectivePlaceholder}
      {disabled}
      class="text-text-bright placeholder:text-text-muted max-h-40 min-h-10 flex-1 resize-none overflow-y-auto border-0 bg-transparent py-2 text-[15px] leading-6 outline-none disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9 md:py-1.5"
      data-testid="message-input"
    ></textarea>
    <MentionTriggerOverlay
      bind:this={mentionOverlay}
      value={text}
      textareaEl={textarea}
      {guildId}
      onChange={(t) => (text = t)}
    />
    <ComposerEmojiButton onPick={insertEmoji} />
    <ComposerSendButton disabled={sendDisabled} />
  </div>
</form>
