# Mobile Voice/Text Card-Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auf Mobil den Text-Kanal als Karte über dem verbundenen Voice-Kanal stapeln (Tiefe + Zurück-Geste), ohne Desktop-Verhalten zu ändern.

**Architecture:** Neue Komponente `MobileVoiceStack.svelte` rendert den verbundenen Voice-Kanal (`VoiceChannelView`) als untere Karte und ein durchgereichtes Chat-Snippet als obere Karte mit Swipe-down-/Tap-Zurück-Geste. `+page.svelte` schaltet via abgeleitetem `showVoiceStack` zwischen Stapel und heutigem Verhalten. Layout im normalen Flex-Fluss, damit das Eingabefeld über dem `VoiceControlBar`-Dock bleibt.

**Tech Stack:** Svelte 5 Runes, Tailwind 4, Pointer-Events (keine neue Dependency). Spec: `docs/superpowers/specs/2026-06-03-mobile-voice-text-card-stack-design.md`.

---

### Task 1: `MobileVoiceStack.svelte` erstellen

**Files:**
- Create: `web/src/lib/components/MobileVoiceStack.svelte`

- [ ] **Step 1: Komponente schreiben**

```svelte
<script lang="ts">
  import VoiceChannelView from './VoiceChannelView.svelte';
  import type { Channel } from '$lib/api/types';
  import type { Snippet } from 'svelte';

  let {
    voiceChannel,
    onReturnToVoice,
    chat
  }: {
    /** Der Voice-Kanal, mit dem wir verbunden sind (untere Karte). */
    voiceChannel: Channel;
    /** Zurück zum vollen Voice-Kanal (= goto auf dessen URL). */
    onReturnToVoice: () => void;
    /** Inhalt der oberen Karte (vom Aufrufer gerenderte ChatView). */
    chat: Snippet;
  } = $props();

  // Wie weit der Voice-Kanal oben aus dem Stapel herausschaut.
  const PEEK = 96;
  // Wisch-Distanz nach unten, ab der zum Voice-Kanal zurückgekehrt wird.
  const DISMISS_THRESHOLD = 80;

  let dragY = $state(0);
  let dragging = $state(false);
  let startY = 0;

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    startY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    dragY = Math.max(0, e.clientY - startY);
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    const dismiss = dragY > DISMISS_THRESHOLD;
    dragY = 0;
    if (dismiss) onReturnToVoice();
  }
</script>

<div class="relative flex h-full min-h-0 flex-1 flex-col" data-testid="mobile-voice-stack">
  <!-- Untere Karte: der verbundene Voice-Kanal, oben rausschauend. -->
  <div
    class="absolute inset-2 overflow-hidden rounded-2xl shadow-[0_8px_26px_rgba(0,0,0,0.5)]"
    data-testid="voice-stack-back"
  >
    <VoiceChannelView channel={voiceChannel} />
  </div>

  <!-- Tap-Fläche über dem sichtbaren Voice-Peek → zurück zum Voice-Kanal. -->
  <button
    type="button"
    class="absolute inset-x-2 top-2 z-[1]"
    style="height: {PEEK - 8}px;"
    onclick={onReturnToVoice}
    aria-label="Zurück zum Voice-Kanal"
    data-testid="voice-stack-peek"
  ></button>

  <!-- Obere Karte: der Text-Kanal, gestapelt. Endet via Flex-Fluss über dem
       VoiceControlBar-Dock → MessageInput bleibt sichtbar. Kein h-full-Zwang. -->
  <div
    class="bg-bg-chat absolute inset-x-1 bottom-0 overflow-hidden rounded-t-[22px] shadow-[0_-12px_34px_rgba(0,0,0,0.6)]"
    style="top: {PEEK}px; transform: translateY({dragY}px); transition: {dragging
      ? 'none'
      : 'transform 0.2s ease'};"
    data-testid="voice-stack-front"
  >
    <!-- Griff-Leiste: nach unten wischen → zurück zum Voice-Kanal. -->
    <div
      class="absolute inset-x-0 top-0 z-10 flex h-7 touch-none items-center justify-center"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      role="button"
      tabindex="-1"
      aria-label="Nach unten wischen für den Voice-Kanal"
    >
      <span class="h-1 w-10 rounded-full bg-white/25"></span>
    </div>
    {@render chat()}
  </div>
</div>
```

- [ ] **Step 2: Type-Check (Komponente kompiliert)**

Run: `cd web && pnpm check`
Expected: 0 Errors / 0 Warnings (FILES_WITH_PROBLEMS 0).

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/components/MobileVoiceStack.svelte
git commit -m "feat(mobile-voice): MobileVoiceStack component (voice-card backdrop + chat-card + swipe-down)"
```

---

### Task 2: In `+page.svelte` verdrahten

**Files:**
- Modify: `web/src/routes/app/guilds/[guildId]/channels/[channelId]/+page.svelte`

- [ ] **Step 1: Import ergänzen**

In den Import-Block (bei den anderen `$lib/components`-Imports, ~Zeile 8) einfügen:

```svelte
  import MobileVoiceStack from '$lib/components/MobileVoiceStack.svelte';
```

- [ ] **Step 2: Abgeleitete Stapel-Bedingung ergänzen**

Direkt nach `let isVoiceChannel = $derived(activeChannel?.type === 1);` (Zeile 43) einfügen:

```svelte
  // Mobil + im Voice + Text-Kanal derselben Community angesehen → Karten-Stapel.
  let connectedVoiceChannel = $derived<Channel | null>(
    voice.connected && voice.channelId
      ? (channelsForGuild.find((c: Channel) => c.id === voice.channelId) ?? null)
      : null
  );
  let showVoiceStack = $derived(
    viewport.isMobile &&
      !!connectedVoiceChannel &&
      connectedVoiceChannel.id !== channelId &&
      activeChannel?.type === 0
  );
```

- [ ] **Step 3: Wiederverwendbares Chat-Snippet definieren + Inhalts-Block umbauen**

Den heutigen Inhalts-Block (Zeile 418–443):

```svelte
<!-- Chat/Voice: Desktop dauerhaft; Mobil nur solange der Drawer zu ist. -->
{#if !viewport.isMobile || !navDrawer.open}
  {#if isVoiceChannel && activeChannel}
    {#key activeChannel.id}
      <VoiceChannelView channel={activeChannel} />
    {/key}
  {:else if loadError}
    <section class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 md:rounded-2xl">
      <p class="text-sm text-red-400" data-testid="load-error">{loadError}</p>
      <Button
        onclick={() => { loadError = null; prevGuild = ''; prevChannel = ''; void switchTo(guildId, channelId); }}
        data-testid="load-retry"
      >{pm.channel_page_retry()}</Button>
    </section>
  {:else}
    <ChatView
      channel={activeChannel}
      messages={visibleMessages}
      onSend={sendMessage}
      isOwner={!!activeGuild && roles.hasGuildPermission(activeGuild.id, Perm.MANAGE_MESSAGES)}
      onEditMessage={editMessage}
      onDeleteMessage={deleteMessage}
      onToggleReaction={toggleReaction}
    />
  {/if}
{/if}
```

ersetzen durch (Chat-Markup in ein Snippet ausgelagert → DRY zwischen Stapel und Normalfall):

```svelte
{#snippet chatBody()}
  <ChatView
    channel={activeChannel}
    messages={visibleMessages}
    onSend={sendMessage}
    isOwner={!!activeGuild && roles.hasGuildPermission(activeGuild.id, Perm.MANAGE_MESSAGES)}
    onEditMessage={editMessage}
    onDeleteMessage={deleteMessage}
    onToggleReaction={toggleReaction}
  />
{/snippet}

<!-- Chat/Voice: Desktop dauerhaft; Mobil nur solange der Drawer zu ist. -->
{#if !viewport.isMobile || !navDrawer.open}
  {#if showVoiceStack && connectedVoiceChannel}
    {@const vc = connectedVoiceChannel}
    <MobileVoiceStack
      voiceChannel={vc}
      onReturnToVoice={() => goto(`/app/guilds/${guildId}/channels/${vc.id}`)}
      chat={chatBody}
    />
  {:else if isVoiceChannel && activeChannel}
    {#key activeChannel.id}
      <VoiceChannelView channel={activeChannel} />
    {/key}
  {:else if loadError}
    <section class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 md:rounded-2xl">
      <p class="text-sm text-red-400" data-testid="load-error">{loadError}</p>
      <Button
        onclick={() => { loadError = null; prevGuild = ''; prevChannel = ''; void switchTo(guildId, channelId); }}
        data-testid="load-retry"
      >{pm.channel_page_retry()}</Button>
    </section>
  {:else}
    {@render chatBody()}
  {/if}
{/if}
```

- [ ] **Step 4: Type-Check + Build**

Run: `cd web && pnpm check && pnpm build`
Expected: `pnpm check` 0 Errors / 0 Warnings; `pnpm build` „✓ built".

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/app/guilds/\[guildId\]/channels/\[channelId\]/+page.svelte
git commit -m "feat(mobile-voice): stack text channel over connected voice channel on mobile"
```

---

### Task 3: Live-Verifikation im laufenden Dev-Stack

**Voraussetzung:** Dev-Stack läuft (`scripts/dev-up.fish`), Chromium per CDP mit Handy-Emulation (`390x844x3,mobile,touch`), eingeloggt als `bob` (Passwort dev-gesetzt).

- [ ] **Step 1: Voice-Kanal in der Test-Gilde anlegen**

bob hat ggf. kein `MANAGE_CHANNELS`. Falls der „+"-Button in der Kanal-Liste fehlt: bob temporär `MANAGE_CHANNELS` geben oder den Kanal direkt anlegen — Voice-Kanal = `type: 1`. Per chat-API mit einem Admin oder via DB-Insert + Reload (Client refetcht Kanäle beim Guild-Switch). Danach Seite neu laden.

- [ ] **Step 2: Voice beitreten + Text-Kanal öffnen**

Voice-Kanal antippen → „Beitreten" (getUserMedia kann im Headless fehlschlagen — egal, `setMicEnabled`-Fehler wird gefangen, der Connect läuft). Dann über die Kanal-Liste `#general` (Text) öffnen.

- [ ] **Step 3: Stapel visuell prüfen (Screenshot)**

Erwartet: untere Voice-Karte schaut oben raus (Header + Teilnehmer), Chat-Karte mit Griff-Leiste darüber, **Eingabefeld sichtbar über dem `VoiceControlBar`-Dock**.
DOM-Check via `evaluate_script`: `document.querySelector('[data-testid="mobile-voice-stack"]')`, `[data-testid="voice-stack-front"]`, `[data-testid="voice-stack-back"]` existieren.

- [ ] **Step 4: Tap-Zurück prüfen**

Tipp auf `[data-testid="voice-stack-peek"]` → URL wechselt zum Voice-Kanal, volle `VoiceChannelView` (kein Stapel mehr).

- [ ] **Step 5: Manueller Geräte-Test dokumentieren**

Die **Wisch-Geste** (Pointer-Drag der Griff-Leiste) + die Optik auf echtem Touch-Gerät sind manuell zu prüfen (im automatisierten Pfad nicht zuverlässig reproduzierbar). Als manuellen Testschritt in der PR/Commit-Notiz festhalten.

---

## Self-Review (durchgeführt)

- **Spec-Abdeckung:** Auslöser (4 Bedingungen) → Task 2 Step 2. Layer/Optik + Eingabe-über-Dock → Task 1 + Task 2. Zurück (Tap + Wisch) → Task 1 (`voice-stack-peek`, Pointer-Handler) + `onReturnToVoice`. Cross-Community-Ausschluss → `connectedVoiceChannel` nutzt `channelsForGuild` (nur aktuelle Community). Same-channel-Ausschluss → `connectedVoiceChannel.id !== channelId`. Tests → Task 2 Step 4 + Task 3.
- **Platzhalter:** keine.
- **Typ-Konsistenz:** `connectedVoiceChannel`/`showVoiceStack`/`chatBody`/`vc` konsistent; `MobileVoiceStack`-Props (`voiceChannel`/`onReturnToVoice`/`chat`) matchen Aufrufstelle.
