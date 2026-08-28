<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { VList, type VListHandle } from 'virtua/svelte';
  import MessageItem from './MessageItem.svelte';
  import { plainifyMentions } from './messageRender';
  import { chatApi } from '$lib/api/chat';
  import { messages as messageStore } from '$lib/stores/messages.svelte';
  import { verlaufSpeichern } from '$lib/verlauf';
  import type { Channel, Message } from '$lib/api/types';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { m as pm } from '$lib/paraglide/messages.js';

  type ChatItem =
    | { kind: 'divider'; label: string; key: string }
    | {
        kind: 'message';
        message: Message;
        isContinuation: boolean;
        /** Letzte Nachricht ihrer Gruppe. Nur die Sprechblasen-Huelle nutzt es
         *  (dort steht dann die Uhrzeit); wird beim Anhaengen nachgezogen. */
        isGroupEnd: boolean;
        key: string;
      };

  // Infinite-Scroll-Up: ab diesem Abstand zum oberen Rand ältere nachladen.
  const LOAD_THRESHOLD = 600;
  const OLDER_PAGE = 100; // Backend-Routen-Max für /messages

  let {
    channel,
    messages,
    myId,
    namePrefix = '#',
    isOwner = false,
    /** Huelle der Nachrichten. Sprechblasen nur in privaten Gespraechen —
     *  im Kanal tragen Autorname und -farbe die Orientierung. */
    layout = 'row',
    onSetReplyTarget,
    onEditMessage,
    onDeleteMessage,
    onToggleReaction
  }: {
    channel: Channel | null;
    messages: Message[];
    layout?: 'row' | 'bubble';
    /** Server-local id (DMs → Cloud-id) for "is this mine?" checks. */
    myId: string | null;
    namePrefix?: string;
    isOwner?: boolean;
    onSetReplyTarget: (m: Message) => void;
    onEditMessage: (m: Message, newContent: string) => void;
    onDeleteMessage: (m: Message) => void;
    onToggleReaction: (m: Message, emoji: string, currentlyMine: boolean) => void;
  } = $props();

  // Nur Guild-Channel paginieren — DMs haben selten tiefe Historie und laufen
  // cloud-scoped (default route reicht für Guild; DM bräuchte Cloud-route).
  const canPaginate = $derived(!!channel?.guild_id);

  let vlist = $state<VListHandle>();
  // Wrapper um <VList> — Viewport-Resize (Fenster/Mobile/Memberlist-Toggle)
  // und async Content-Load (Bilder/Embeds) werden hierüber beobachtet.
  let wrapperEl = $state<HTMLDivElement | null>(null);
  let lastCount = $state(0);
  // Ob der User aktuell ganz unten an der Liste klebt. Wird LAUFEND beim
  // Scrollen aktualisiert — also BEVOR eine neue Nachricht die Liste höher
  // macht. Neue Nachrichten wachsen den Container nach unten, ohne ein
  // scroll-Event auszulösen, d.h. dieser Wert bleibt korrekt erhalten.
  let pinnedToBottom = $state(true);
  // Kurzzeitig zu highlightende Nachricht (z.B. nach jumpToReply).
  let highlightId = $state<string | null>(null);
  // Infinite-Scroll-Up-State.
  let hasMore = $state(true); // es könnte ältere Historie geben
  let loadingOlder = $state(false);
  // VList `shift` MUSS pro Update stimmen, nicht statisch sein: true weist virtua
  // an, die Längenänderung als *Prepend am Anfang* zu behandeln (Scroll-Position
  // bleibt auf der aktuellen Nachricht). Für JEDE andere Änderung — neue
  // Nachricht am Ende, Löschen — MUSS es false sein, sonst deutet virtua sie als
  // Start-Mutation: der index-basierte Size-Cache verrutscht (Nachrichten
  // überlappen) und falsche Items gelten als „unmeasured" → `visibility:hidden`,
  // wodurch Inhalt/Bilder unsichtbar bleiben. Nur `loadOlder()` (der einzige
  // Prepend-Pfad) schaltet es kurzzeitig true.
  let prependShift = $state(false);

  function handleVirtuaScroll(offset: number) {
    if (!vlist) return;
    const size = vlist.getScrollSize();
    // Vor dem ersten echten Inhalt ist die Größe 0 → nicht auswerten.
    if (size === 0) return;
    pinnedToBottom = offset + vlist.getViewportSize() >= size - 80;
    if (
      canPaginate &&
      hasMore &&
      !loadingOlder &&
      messages.length > 0 &&
      offset < LOAD_THRESHOLD
    ) {
      void loadOlder();
    }
  }

  function pinToEnd() {
    if (items.length > 0) vlist?.scrollToIndex(items.length - 1, { align: 'end' });
  }

  // Zwei Frames warten, nicht nur `tick()`: nach dem tick steht die neue Zeile
  // zwar im DOM, ist aber noch UNGEMESSEN — virtua kennt nur die Schätzung, und
  // ein Scroll darauf verschiebt den Verlauf darüber um die Differenz, bis der
  // ResizeObserver einen Frame später korrigiert (sichtbares Zucken, bei
  // Bildnachrichten dreistellig). Nach zwei Frames ist gemessen und das Ziel
  // exakt; die Zeile ist solange ohnehin `visibility:hidden`.
  function pinToEndWhenMeasured() {
    const forChannel = channel?.id;
    void tick().then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (channel?.id === forChannel) pinToEnd();
        })
      )
    );
  }

  // Ältere Historie via ?before=<älteste-id> nachladen und vorne einfügen.
  // VList `shift` hält die Scroll-Position (User bleibt auf seiner Nachricht).
  async function loadOlder() {
    if (!channel) return;
    const oldest = messages[0]?.id;
    if (!oldest) return;
    loadingOlder = true;
    try {
      const older = await chatApi.listMessages(channel.id, { before: oldest, limit: OLDER_PAGE });
      // shift NUR für diese eine Prepend-Längenänderung aktivieren, dann sofort
      // wieder deaktivieren — virtua liest den Wert im Moment, in dem `items`
      // (und damit data.length) wächst, also innerhalb des tick()-Flushes.
      prependShift = true;
      const added = messageStore.prepend(channel.id, older);
      void verlaufSpeichern(channel.id, older);
      await tick();
      prependShift = false;
      // Historie-Ende: nichts Neues kam dazu, oder die Seite war unvollständig.
      if (!added || older.length < OLDER_PAGE) hasMore = false;
    } catch {
      // Netzwerkfehler → still,Retry beim nächsten Scroll.
    } finally {
      loadingOlder = false;
    }
  }

  // Avatare/Namen fremder Autoren vorab in den Cache laden. Die Autor-IDs
  // MÜSSEN außerhalb von untrack() gelesen werden — sonst hat der Effekt keine
  // Dependency, läuft genau einmal (oft vor dem History-Load) und Autoren aus
  // WS-Pushes/Scroll-Up-Historie bekommen nie einen Namen (Regression 2f4664d5).
  $effect(() => {
    const toQueue = messages
      .filter((m) => !myId || m.author_id !== myId)
      .map((m) => m.author_id);
    untrack(() => {
      for (const id of toQueue) userCache.queue(id);
    });
  });

  // Reset beim Kanalwechsel — sonst sieht der erste WS-Push in einen frisch
  // gewechselten Channel nicht wie ein "initial load" aus → kein scroll-to-bottom.
  // VList behält den internen Offset beim data-Tausch → explizit auf 0 setzen.
  $effect(() => {
    void channel?.id;
    untrack(() => {
      lastCount = 0;
      pinnedToBottom = true;
      hasMore = true;
      loadingOlder = false;
      vlist?.scrollToIndex(0);
    });
  });

  $effect(() => {
    const count = messages.length;
    if (count !== lastCount) {
      const isInitialLoad = lastCount === 0;
      // "Klebt der User unten?" wird VOR dem DOM-Wachstum bestimmt (über den
      // laufenden Scroll-Handler) — nicht erst nach tick(), wenn die neue,
      // u.U. >80px hohe Nachricht die Messung schon verfälscht hätte.
      const shouldScroll = isInitialLoad || pinnedToBottom;
      lastCount = count;
      if (shouldScroll) pinToEndWhenMeasured();
    }
  });

  // Async-Inhalt (Avatare, Bilder, Link-Vorschauen, Embeds) lädt NACH dem
  // ersten Scroll und wächst die gemessenen Item-Höhen — sonst rutscht man
  // "nach oben weg". Solange der User unten klebt, bei Viewport-Resize
  // (ResizeObserver) UND bei nachgeladenem Content (capture-'load' für
  // img/iframe) erneut ans Ende ziehen.
  $effect(() => {
    const el = wrapperEl;
    if (!el) return;
    const onGrow = () => { if (pinnedToBottom) pinToEnd(); };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onGrow);
    ro?.observe(el);
    el.addEventListener('load', onGrow, true);
    // Scroll-Absicht des Users schlägt das automatische Ans-Ende-Ziehen — und
    // zwar SOFORT, nicht erst wenn das daraus folgende scroll-Event
    // `pinnedToBottom` neu berechnet. Ohne das kann ein Bild, das genau in
    // diesem Fenster fertig lädt, `pinToEnd()` auslösen und den gerade
    // begonnenen Hochroll-Versuch wieder nach unten reißen. Die Korrektur ist
    // selbstheilend: bleibt der User doch unten, setzt der Scroll-Handler
    // `pinnedToBottom` im selben Zug wieder auf true.
    const unpin = () => { pinnedToBottom = false; };
    // Nur nach oben: ein Rad-Tick nach unten führt ohnehin ans Ende.
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) unpin(); };
    // Touch braucht denselben Richtungsfilter wie das Rad. Ein richtungsloses
    // `touchmove`-unpin würde auch am unteren Anschlag (Rubber-Band, Long-Press,
    // Text-Drag) entpinnen — ohne folgendes Scroll-Delta greift der Self-Heal
    // nicht und die nächste Nachricht scrollt nicht mehr automatisch nach.
    // Finger nach unten (= ältere Nachrichten) entspricht `deltaY < 0`.
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? touchStartY;
      if (y - touchStartY > 8) unpin();
    };
    el.addEventListener('wheel', onWheel, { passive: true, capture: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener('load', onGrow, true);
      el.removeEventListener('wheel', onWheel, true);
      el.removeEventListener('touchstart', onTouchStart, true);
      el.removeEventListener('touchmove', onTouchMove, true);
    };
  });

  function formatDividerLabel(date: Date, today: Date, yesterday: Date): string {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (d.getTime() === today.getTime()) return pm.chat_view_today();
    if (d.getTime() === yesterday.getTime()) return pm.chat_view_yesterday();
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  const getKey = (item: ChatItem): string => item.key;

  let messageMap = $derived(new Map(messages.map((m) => [m.id, m])));

  // Append-Cache: vermeidet vollen Rebuild bei einfachen Appends. Plain (nicht
  // `$state`) — würden sie in einem `$derived` geschrieben, wirft Svelte
  // state_unsafe_mutation und leert die Liste. `_lastItemsDayKey` erzwingt bei
  // Tageswechsel (Tab über Mitternacht offen) einen Rebuild, da sonst die
  // "Heute"/"Gestern"-Labels auf bestehenden Dividern veralten. Ein Prepend
  // (Infinite-Scroll-Up) verändert den Tail → löst sicher den Full-Rebuild aus.
  let _cachedItems: ChatItem[] | null = null;
  let _lastItemsMessageCount = 0;
  let _lastItemsLastMessageId = '';
  let _lastItemsDayKey = 0;

  let items = $derived.by(() => {
    const len = messages.length;
    const lastId = len > 0 ? messages[len - 1].id : '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const dayKey = today.getTime();

    // Append-Optimierung: wenn nur Nachrichten ans Ende kamen (Tail unverändert),
    // nur die neuen Items bauen statt die ganze Liste neu aufzubauen.
    const canAppend =
      _cachedItems !== null &&
      dayKey === _lastItemsDayKey &&
      len > _lastItemsMessageCount &&
      _lastItemsLastMessageId === (messages[_lastItemsMessageCount - 1]?.id ?? '');

    if (canAppend) {
      const newItems: ChatItem[] = [];
      for (let i = _lastItemsMessageCount; i < len; i++) {
        newItems.push(...buildItem(messages[i], messages[i - 1], today, yesterday));
      }
      const ab = _cachedItems!.length;
      _cachedItems = [..._cachedItems!, ...newItems];
      gruppenEndenNachziehen(_cachedItems, ab);
    } else {
      _cachedItems = buildItems(messages, today, yesterday);
    }

    _lastItemsMessageCount = len;
    _lastItemsLastMessageId = lastId;
    _lastItemsDayKey = dayKey;
    return _cachedItems;
  });


  /**
   * Zieht die Gruppenenden ab ``ab`` nach.
   *
   * **Warum nachtraeglich und nicht beim Bauen:** ob eine Nachricht die letzte
   * ihrer Gruppe ist, entscheidet die NAECHSTE — beim Bauen kennt man die noch
   * nicht. Der Anhaenge-Pfad oben haengt neue Elemente an, ohne die Liste neu
   * zu bauen; genau dann verliert die bis dahin letzte Nachricht ihr
   * Gruppenende, und ohne diesen Durchlauf stuenden zwei Uhrzeiten
   * untereinander.
   */
  function gruppenEndenNachziehen(items: ChatItem[], ab: number): void {
    // Eine Stelle zurueck: die letzte Nachricht VOR dem neuen Stueck kann ihr
    // Gruppenende gerade verloren haben.
    let vorherige: Extract<ChatItem, { kind: 'message' }> | null = null;
    for (let i = ab - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'message') {
        vorherige = it;
        break;
      }
    }
    for (let i = ab; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== 'message') continue;
      if (vorherige && it.isContinuation) vorherige.isGroupEnd = false;
      it.isGroupEnd = true;
      vorherige = it;
    }
  }

  function buildItems(msgs: Message[], today: Date, yesterday: Date): ChatItem[] {
    const result: ChatItem[] = [];
    for (let i = 0; i < msgs.length; i++) {
      result.push(...buildItem(msgs[i], msgs[i - 1], today, yesterday));
    }
    gruppenEndenNachziehen(result, 0);
    return result;
  }

  /** Baut Divider (falls Tageswechsel) + Message-Item für eine einzelne Nachricht. */
  function buildItem(m: Message, prev: Message | undefined, today: Date, yesterday: Date): ChatItem[] {
    const mDate = new Date(m.created_at);
    const mDateStr = mDate.toDateString();
    const prevDate = prev ? new Date(prev.created_at) : null;
    const prevDateStr = prevDate ? prevDate.toDateString() : null;

    const out: ChatItem[] = [];
    if (!prevDate || mDateStr !== prevDateStr) {
      out.push({ kind: 'divider', label: formatDividerLabel(mDate, today, yesterday), key: `div-${m.id}` });
    }

    const isContinuation =
      !!prev &&
      m.author_id === prev.author_id &&
      mDate.getTime() - prevDate!.getTime() < 7 * 60 * 1000 &&
      mDateStr === prevDateStr;

    out.push({ kind: 'message', message: m, isContinuation, isGroupEnd: true, key: m.id });
    return out;
  }

  function authorName(m: Message): string {
    if (auth.user && m.author_id === myId) {
      return auth.user.display_name ?? auth.user.username;
    }
    return userCache.displayName(m.author_id);
  }

  function authorStyle(m: Message): string {
    return nameStyle(m.author_id, channel?.guild_id ?? null);
  }

  function avatarUrl(m: Message): string | null {
    const raw =
      auth.user && m.author_id === myId
        ? auth.user.avatar_url
        : (userCache.get(m.author_id)?.avatar_url ?? null);
    return safeAvatarUrl(raw);
  }

  function snippet(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }

  function replyMetaFor(m: Message): { id: string; author: string; snippet: string } | null {
    if (!m.reply_to_id) return null;
    const parent = messageMap.get(m.reply_to_id);
    if (!parent) {
      return { id: m.reply_to_id, author: '…', snippet: pm.chat_view_older_message() };
    }
    return { id: parent.id, author: authorName(parent), snippet: snippet(plainifyMentions(parent.content)) };
  }

  // Virtualisierungssicher: index-basiert statt querySelector (das Ziel ist
  // evtl. gar nicht gemountet). Highlight läuft reaktiv über `highlightId`,
  // greift also automatisch sobald VList das Ziel nach dem Scroll mountet.
  function jumpToReply(parentId: string) {
    const idx = items.findIndex((it) => it.kind === 'message' && it.message.id === parentId);
    if (idx < 0 || !vlist) return;
    vlist.scrollToIndex(idx, { align: 'center' });
    highlightId = parentId;
    setTimeout(() => { if (highlightId === parentId) highlightId = null; }, 1500);
  }

  function canEditMessage(m: Message): boolean {
    return !!myId && m.author_id === myId && !m.id.startsWith('tmp-') && !m.deleted_at;
  }
  function canDeleteMessage(m: Message): boolean {
    if (!myId) return false;
    if (m.id.startsWith('tmp-')) return false;
    return m.author_id === myId || isOwner;
  }
  function canReportMessage(m: Message): boolean {
    if (!myId) return false;
    return m.author_id !== myId;
  }
</script>

<!-- **Ein kurzes Gespraech klebt oben statt unten am Eingabefeld**, anders als
     in den ueblichen Messengern. Am 2026-08-23 versucht und wieder
     zurueckgenommen: `justify-end` am Rahmen wirkt nur, wenn die VList ihre
     Hoehe aus dem Inhalt nimmt — virtua setzt sich aber selbst `height:100%`,
     und mit `height:auto` dagegen verliert es seinen begrenzten Ausschnitt und
     rendert GAR KEINE Nachricht mehr (nachgemessen, leerer Bildschirm). Die
     Version hier (virtua 0.49) kennt keinen Umkehr-Schalter. Ein Umbau waere
     einer an der Virtualisierung selbst — mit Rueckwirkung auf das Nachladen
     nach oben und die Sprungmarken. Fuer einen kosmetischen Randfall, der nur
     bei ganz neuen Gespraechen sichtbar ist, ist das der falsche Preis. -->
<div class="flex-1 min-h-0" bind:this={wrapperEl} data-testid="message-list">
  {#if channel}
    {#if messages.length === 0}
      <!-- `{' '}` statt eines Leerzeichens am Ende des Textbausteins: dort wäre es
           bei der Durchsicht unsichtbar, fiele Formatierern zum Opfer und ginge
           Übersetzern verloren. Genau so entstand „…Nachrichten in#general". -->
      <p class="text-text-muted px-4 py-8 text-center text-sm">
        {pm.chat_view_no_messages_prefix()}{' '}<strong class="text-text-bright"
          >{namePrefix}{channel.name}</strong
        >{pm.chat_view_no_messages_suffix()}
      </p>
    {:else}
      <!-- `itemSize` = Höhen-Schätzung für ungemessene Zeilen (~eine kurze
           Textnachricht). Ohne den Wert leitet virtua sie aus dem ab, was beim
           Öffnen zufällig sichtbar ist — unten in einer Bilderstrecke z.B.
           332px, und JEDE neue Nachricht belegt dann für einen Frame diese
           332px, bevor sie auf ihre echte Höhe schrumpft: der sichtbare Sprung
           beim Absenden. Fest gesetzt bleibt der Fehler unter einer Textzeile.

           `bufferSize` = wie viele Pixel über/unter dem Sichtfenster schon
           gerendert werden. Der Standard (200px) liegt knapp unter zwei
           Mausrad-Rastungen: eine Zeile wird dann erst gemessen, wenn sie oben
           schon halb sichtbar ist — und weil virtua nur für VOLLSTÄNDIG
           oberhalb liegende Zeilen gegenkorrigiert, ruckt sie sichtbar. Mit
           ~800px ist sie vermessen, lange bevor sie den Rand erreicht. -->
      <VList
        data={items}
        {getKey}
        bind:this={vlist}
        onscroll={handleVirtuaScroll}
        shift={prependShift}
        itemSize={48}
        bufferSize={800}
        style="height:100%"
      >
        {#snippet children(item)}
          {#if item.kind === 'divider'}
            <div class="mx-5 py-4 flex items-center gap-3" data-testid="date-divider">
              <div class="hairline flex-1 bg-border"></div>
              <span class="bg-bg-input text-text-muted rounded-full px-3 py-0.5 text-xs font-semibold">{item.label}</span>
              <div class="hairline flex-1 bg-border"></div>
            </div>
          {:else}
            <MessageItem
              message={item.message}
              authorName={authorName(item.message)}
              authorStyle={authorStyle(item.message)}
              replyTo={replyMetaFor(item.message)}
              avatarUrl={avatarUrl}
              isContinuation={item.isContinuation}
              isGroupEnd={item.isGroupEnd}
              {layout}
              istEigene={item.message.author_id === myId}
              highlight={highlightId === item.message.id}
              canEdit={canEditMessage(item.message)}
              canDelete={canDeleteMessage(item.message)}
              canReport={canReportMessage(item.message)}
              isDirect={!channel?.guild_id}
              guildId={channel?.guild_id ?? undefined}
              onReply={onSetReplyTarget}
              onEditSubmit={onEditMessage}
              onDelete={onDeleteMessage}
              onToggleReaction={onToggleReaction}
              onJumpToReply={jumpToReply}
            />
          {/if}
        {/snippet}
      </VList>
    {/if}
  {/if}
</div>
