<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
  import { registerPlugin } from '@capacitor/core';
  import VideoIcon from '@lucide/svelte/icons/video';
  import PaperclipIcon from '@lucide/svelte/icons/paperclip';
  import CameraIcon from '@lucide/svelte/icons/camera';
  import MicIcon from '@lucide/svelte/icons/mic';
  import ComposerReplyBanner from './composer/ComposerReplyBanner.svelte';
  import ComposerEmojiButton from './composer/ComposerEmojiButton.svelte';
  import ComposerSendButton from './composer/ComposerSendButton.svelte';
  import AttachmentPreviewStrip from './AttachmentPreviewStrip.svelte';
  import MentionTriggerOverlay from './MentionTriggerOverlay.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { expandShortcodes } from '$lib/emoji';
  import { VerfasserAnhaenge } from '$lib/attachments/verfasserZeilen.svelte';
  import { dateienAusEinfuegen } from '$lib/attachments/eingefuegteDateien';
  import {
    beendeAufnahme,
    brichAufnahmeAb,
    starteAufnahme,
    type LaufendeAufnahme
  } from '$lib/attachments/aufnahme';
  import { AUFGABE_MAX_SEKUNDEN, formatiereDauer } from '$lib/attachments/aufnahmeKern';
  import SquareIcon from '@lucide/svelte/icons/square';
  import XIcon from '@lucide/svelte/icons/x';
  import ImageIcon from '@lucide/svelte/icons/image';
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { toast } from 'svelte-sonner';
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
  /** Ist die Nachrichtenzeile im Fokus? Entscheidet über Mikro- vs.
   *  Senden-Symbol rechts (WhatsApp-Prinzip, Testrunde 2026-09-11). */
  let eingabeFokus = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  let cameraInput: HTMLInputElement | undefined = $state();
  let galleryInput: HTMLInputElement | undefined = $state();
  /** Anhang-Auswahl am Handy (Foto/Galerie/Dokument) — WhatsApp-Prinzip,
   *  drei verborgene Datei-Eingaben dahinter. */
  let anhangSheet = $state(false);

  /** Native Video-Aufnahme (Java-Plugin VideoCapturePlugin) — nur Android. */
  const VideoCapture = registerPlugin<{
    aufnehmen(): Promise<{ base64: string; mime: string; pfad: string; groesse: number }>;
  }>('VideoCapture');

  /** Foto über die NATIVE Kamera (Capacitor-Plugin): eigene Android-
   *  Kameraansicht statt WebView-Video-Element — das graue Kästchen des
   *  WebView ist damit im Foto-Weg komplett verschwunden (Testrunde
   *  2026-09-11). Abbruch durch den Nutzer still schlucken. */
  async function fotoAufnehmen(): Promise<void> {
    try {
      const foto = await Camera.getPhoto({
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
        quality: 90
      });
      if (!foto.webPath) return;
      const antwort = await fetch(foto.webPath);
      const blob = await antwort.blob();
      addFiles([new File([blob], `kamera-${Date.now()}.jpg`, { type: 'image/jpeg' })]);
    } catch {
      // Nutzer hat abgebrochen oder Kamera verweigert — nichts tun.
    }
  }

  /** Video über die NATIVE System-Kamera (eigenes VideoCapturePlugin):
   *  ACTION_VIDEO_CAPTURE liefert eine mp4, das Plugin kopiert sie in den
   *  Cache und gibt Base64 zurück → Datei → normale Anhang-Pipeline. */
  async function videoAufnehmen(): Promise<void> {
    try {
      const ergebnis = await VideoCapture.aufnehmen();
      if (!ergebnis?.base64) return;
      const bytes = Uint8Array.from(atob(ergebnis.base64), (z) => z.charCodeAt(0));
      addFiles([
        new File([bytes], `kamera-video-${Date.now()}.mp4`, { type: ergebnis.mime })
      ]);
    } catch {
      // Abbruch in der Kamera-App — nichts tun.
    }
  }

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

  // ---- Geteilter Inhalt (Übergabe P1.8, Share-Target) -----------------
  // Ein Share aus einer anderen App wird im NÄCHSTEN offenen Composer
  // angewendet: Text vorbefüllt, Bild landet im Anhang-Streifen (und läuft
  // damit durch dieselbe Upload-Pipeline). Verbrauchen = leeren, sonst
  // klebt der Share an jedem später geöffneten Chat.
  async function freigabeUebernehmen(): Promise<void> {
    // Kontext PRÜFEN, dann konsumieren — sonst wäre der Share weg, wenn der
    // Composer ihn gar nicht aufnehmen kann (Kanal ohne Anhänge, kein Chat).
    if (!channelId || !attachmentsAllowed) return;
    const { freigabeHolen, freigabeLeeren } = await import('$lib/freigabe/freigabeStore');
    const paket = freigabeHolen();
    if (!paket) return;
    freigabeLeeren();
    if (paket.text) text = paket.text;
    if (paket.bild) {
      const bytes = Uint8Array.from(atob(paket.bild.base64), (c) => c.charCodeAt(0));
      const datei = new File([bytes], 'geteilt.' + (paket.bild.mime.split('/')[1] ?? 'png'), {
        type: paket.bild.mime
      });
      addFiles([datei]);
    }
  }

  $effect(() => {
    void freigabeUebernehmen();
    // visibilitychange feuert beim Vordergrund-Wechsel (Share-intent kommt
    // über onNewIntent, kein Seiten-Reload) — dann ist das Paket frisch.
    const beiSichtbar = () => {
      if (document.visibilityState === 'visible') void freigabeUebernehmen();
    };
    document.addEventListener('visibilitychange', beiSichtbar);
    window.addEventListener('pulse-freigabe', beiSichtbar);
    return () => {
      document.removeEventListener('visibilitychange', beiSichtbar);
      window.removeEventListener('pulse-freigabe', beiSichtbar);
    };
  });

  const removeAttachment = (localId: string) => anhaenge.entfernen(localId);
  const onFilePick = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) addFiles(input.files);
    input.value = ''; // allow re-selecting the same file later
  };

  // ---- Sprachnachricht (P0.3, UI 2026-09-11 überarbeitet): TIPPEN statt
  // halten. Ein Tap auf das Mikrofon startet; die Aufnahme-Leiste über dem
  // Eingabekasten bietet „Fertig" und „Verwerfen" (✕ rechts). Keine
  // Halte-Geste mehr: Der Layout-Shift- und Pointercancel-Zirkus aus der
  // ersten Fassung entfiel mit ihr (Testrunde 2026-09-11).
  let aufnahme: LaufendeAufnahme | undefined = $state();
  let aufnahmeSekunden = $state(0);
  let aufnahmeTimer: ReturnType<typeof setInterval> | undefined;

  function aufnahmeTickerStarten(): void {
    aufnahmeSekunden = 0;
    aufnahmeTimer = setInterval(() => {
      if (!aufnahme) return;
      aufnahmeSekunden = Math.floor((Date.now() - aufnahme.gestartetAm) / 1000);
      // Der 300-s-Rahmen endet hier, im UI sichtbar als fertiger Entwurf.
      if (aufnahmeSekunden >= AUFGABE_MAX_SEKUNDEN) void aufnahmeEnde();
    }, 500);
  }

  async function aufnahmeStart(): Promise<void> {
    if (aufnahme || !channelId || !attachmentsAllowed) return;
    try {
      aufnahme = await starteAufnahme();
    } catch {
      toast.error(m.message_input_mikrofon_fehler());
      return;
    }
    aufnahmeTickerStarten();
  }

  async function aufnahmeEnde(): Promise<void> {
    const lauf = aufnahme;
    if (!lauf) return;
    aufnahme = undefined;
    clearInterval(aufnahmeTimer);
    const datei = await beendeAufnahme(lauf);
    if (datei) addFiles([datei]);
  }

  function aufnahmeVerwerfen(): void {
    const lauf = aufnahme;
    if (!lauf) return;
    aufnahme = undefined;
    clearInterval(aufnahmeTimer);
    brichAufnahmeAb(lauf);
  }

  const aufnahmeDauer = $derived(formatiereDauer(aufnahmeSekunden));

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
        <!-- Zwei verborgene Eingaben hinter dem EINEN Büroklammer-Knopf:
             Galerie (Bilder) und Dokumente. Die Kamera läuft über das
             NATIVE Kamera (VideoCapturePlugin) — das <input capture> wurde von
             Android-16-Systempickern geschluckt (Testrunde 2026-09-11). -->
        <input
          type="file"
          accept="image/*"
          bind:this={galleryInput}
          onchange={onFilePick}
          class="sr-only"
          data-testid="attachment-gallery-input"
        />
      {/if}
      <!-- Sprachnachricht (mobil): TIPPEN startet die Aufnahme; die Leiste
           über dem Eingabekasten bietet Fertig und Verwerfen. -->
      {#if viewport.istHandy && attachmentsEnabled}
        {#if aufnahme}
          <!-- Bewusst ABSOLUT über dem Eingabekasten, nicht in der Knopf-
               Reihe: als Flex-Geschwister würde die Leiste die Knöpfe der
               Reihe verschieben (Befund Testrunde 2026-09-11). -->
          <div
            class="bg-bg-input/70 absolute bottom-full left-0 right-0 z-30 mb-2 flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 shadow-lg backdrop-blur-lg"
            data-testid="recording-indicator"
          >
            <span class="bg-error size-2.5 animate-pulse rounded-full"></span>
            <span class="text-error text-sm font-semibold tabular-nums">
              {aufnahmeDauer}
            </span>
            <span class="flex-1"></span>
            <button
              type="button"
              class="accent-gradient text-primary-foreground flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold shadow-sm"
              onclick={aufnahmeEnde}
              data-testid="recording-stop"
            >
              <SquareIcon class="size-3.5" />
              {m.message_input_recording_stop()}
            </button>
            <button
              type="button"
              class="bg-bg-panel text-text-muted hover:text-error ml-1 rounded-full border border-border p-1.5 transition-colors"
              onclick={aufnahmeVerwerfen}
              aria-label={m.message_input_recording_discard()}
              data-testid="recording-discard"
            >
              <XIcon class="size-4" />
            </button>
          </div>
        {/if}
      {/if}
      <Button
        variant="ghost"
        size="icon"
        class="size-10 md:size-9"
        aria-label={m.message_input_attach_file()}
        onclick={() => {
          // Am Handy: Auswahl-Blatt (Foto / Galerie / Dokument). Am Rechner
          // bleibt der direkte Datei-Dialog — dort gibt es keine Kamera-App
          // und eine Galerie-Trennung wäre nur Umwege.
          if (viewport.istHandy) anhangSheet = true;
          else fileInput?.click();
        }}
        data-testid="attachment-button"
      >
        <PaperclipIcon class="size-5" />
      </Button>
    {/if}
    {#if viewport.istHandy}
      <BottomSheet
        open={anhangSheet}
        testid="attachment-source-sheet"
        closeLabel={m.message_input_attach_file()}
        panelClass="bg-popover text-popover-foreground relative rounded-t-2xl border-t border-border px-3 pt-2 pb-[calc(1rem+var(--safe-bottom))] shadow-2xl"
        onClose={() => (anhangSheet = false)}
      >
        <div class="mx-auto mb-3 mt-1 h-1 w-9 shrink-0 rounded-full bg-border"></div>
        <!-- Drei Kacheln nebeneinander, WhatsApp-Prinzip in Pulse-Farben:
             runder Farbkreis je Quelle, kein Text-Wust. -->
        <div
          class="flex items-stretch justify-center gap-3"
          data-testid="attachment-source-options"
        >
          <button
            type="button"
            class="bg-bg-input hover:bg-bg-hover flex w-24 flex-col items-center gap-2 rounded-2xl border border-border px-2 py-4 transition-colors"
            onclick={() => {
              anhangSheet = false;
              void fotoAufnehmen();
            }}
            data-testid="attachment-source-camera"
          >
            <span
              class="accent-gradient text-primary-foreground flex size-12 items-center justify-center rounded-full"
            >
              <CameraIcon class="size-6" />
            </span>
            <span class="text-xs font-semibold">{m.message_input_anhang_foto()}</span>
          </button>
          <button
            type="button"
            class="bg-bg-input hover:bg-bg-hover flex w-24 flex-col items-center gap-2 rounded-2xl border border-border px-2 py-4 transition-colors"
            onclick={() => {
              anhangSheet = false;
              void videoAufnehmen();
            }}
            data-testid="attachment-source-video"
          >
            <span
              class="bg-rose-500/20 text-rose-400 flex size-12 items-center justify-center rounded-full"
            >
              <VideoIcon class="size-6" />
            </span>
            <span class="text-xs font-semibold">{m.message_input_anhang_video()}</span>
          </button>
          <button
            type="button"
            class="bg-bg-input hover:bg-bg-hover flex w-24 flex-col items-center gap-2 rounded-2xl border border-border px-2 py-4 transition-colors"
            onclick={() => {
              anhangSheet = false;
              galleryInput?.click();
            }}
            data-testid="attachment-source-gallery"
          >
            <span
              class="bg-violet-500/20 text-violet-400 flex size-12 items-center justify-center rounded-full"
            >
              <ImageIcon class="size-6" />
            </span>
            <span class="text-xs font-semibold">{m.message_input_anhang_galerie()}</span>
          </button>
          <button
            type="button"
            class="bg-bg-input hover:bg-bg-hover flex w-24 flex-col items-center gap-2 rounded-2xl border border-border px-2 py-4 transition-colors"
            onclick={() => {
              anhangSheet = false;
              fileInput?.click();
            }}
            data-testid="attachment-source-document"
          >
            <span
              class="bg-sky-500/20 text-sky-400 flex size-12 items-center justify-center rounded-full"
            >
              <FileTextIcon class="size-6" />
            </span>
            <span class="text-xs font-semibold">{m.message_input_anhang_dokument()}</span>
          </button>
        </div>
      </BottomSheet>
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
      onblur={() => {
        mentionOverlay?.close();
        eingabeFokus = false;
      }}
      onfocus={() => (eingabeFokus = true)}
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
    <ComposerSendButton
      disabled={sendDisabled}
      mikro={!eingabeFokus && !aufnahme && text.trim().length === 0 && anhaenge.zeilen.length === 0}
      onMikrofon={aufnahmeStart}
    />
  </div>
</form>
