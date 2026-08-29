<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import DMChannelList from '$lib/components/DMChannelList.svelte';
  import MobileChatsList from '$lib/components/mobile/MobileChatsList.svelte';
  import ChatView from '$lib/components/ChatView.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { alsGruppeErkennenNachWarten } from '$lib/gruppen/kanalArtWarten';
  import { userCache } from '$lib/stores/users.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { verlaufSpeichern, verlaufLesen, verlaufMergen } from '$lib/verlauf';
  import { verlaufZustand } from '$lib/verlauf/zustand.svelte';
  import { chatApi } from '$lib/api/chat';
  import { cloudGateway } from '$lib/ws/connection';
  import { serversStore } from '$lib/api/servers.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { toast } from 'svelte-sonner';
  import { E2E_DMS_ENABLED, PRIVATE_GRUPPEN_ENABLED } from '$lib/krypto/schalter';
  import { kanonischeAntwortId } from '$lib/krypto/kanonischeAntwortId';
  import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';
  import type { Channel, DMChannel, Message } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import { sendeKlartextDm } from '$lib/components/chat/dmKlartextSenden';
  import {
    nachrichtBearbeiten,
    nachrichtLoeschen,
    reaktionUmschalten
  } from '$lib/components/chat/cloudNachrichtAktionen';

  // Global-Friends Stufe 1: DMs leben in der Cloud. Alle DM-REST-Calls werden
  // explizit gegen den Cloud-Server geroutet (sonst laufen sie bei aktivem
  // Self-Host gegen den falschen Server), WS-DM-Ops gehen über `cloudGateway`.
  const cloudRoute = { serverId: serversStore.cloudId() };

  let dmChannelId = $derived(page.params.dmChannelId ?? '');
  let activeDM = $derived<DMChannel | undefined>(
    dmChannelId ? directMessages.byId[dmChannelId] : undefined
  );
  // Eine private Gruppe (Etappe G) laeuft ueber DIESELBE Adresse: Kanal-IDs
  // sind Snowflakes aus EINEM Generator und ueber alle drei Kanalarten
  // eindeutig (Modell-Docstring von `DirectMessageChannel`), `/app/@me/<id>`
  // ist damit nicht mehrdeutig. Eine zweite Route daneben haette dieselbe
  // Ansicht ein zweites Mal gebraucht — und mit ihr Anhaenge, Antworten,
  // Reaktionen und das Aktionsblatt still verloren.
  let aktiveGruppe = $derived(dmChannelId ? privateGruppen.byId[dmChannelId] : undefined);

  // ChatView expects a `Channel`-shaped object. Synthesise one — `guild_id` is
  // empty, but we also pass showMemberList={false} so no member-list lookup
  // happens. Der Name ist bei einer DM der Anzeigename der Gegenstelle (aus
  // `userCache`, faellt beim Laden auf „…" zurueck), bei einer Gruppe ihr
  // eigener.
  function synthKanal(id: string, name: string, erstelltAm: string): Channel {
    return { id, guild_id: '', name, type: 0, position: 0, topic: null, created_at: erstelltAm };
  }
  let synthChannel = $derived.by<Channel | null>(() => {
    if (activeDM) {
      const name = userCache.displayName(activeDM.other_user_id);
      return synthKanal(activeDM.id, name, activeDM.created_at);
    }
    if (aktiveGruppe) return synthKanal(aktiveGruppe.id, aktiveGruppe.name, aktiveGruppe.created_at);
    return null;
  });

  let visibleMessages = $derived(dmChannelId ? messages.for(dmChannelId) : []);

  let loadError = $state<string | null>(null);
  let resolving = $state(false);

  let prevDM = $state('');
  let switchGen = 0;
  const pendingOptimisticTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // Mirrors the channel-page effect: when the DM id in the URL changes, load
  // messages + subscribe + leave the previous one. The DM record itself is
  // already in the store (seeded by ready / hydrate / dm_bump).
  $effect(() => {
    const cid = dmChannelId;
    void switchTo(cid);
  });

  // Keep the open DM at the head of the message-cache LRU so it is never
  // evicted while the user is viewing it.
  $effect(() => {
    if (dmChannelId) messages.touch(dmChannelId);
  });

  // C2: der Nutzer erfaehrt EINMAL, warum sein Verlauf nicht lokal liegt
  // (privates Fenster/voller Speicher/Fehler) — die App bleibt in jedem Fall
  // benutzbar (Rueckfall auf den Server), s. `verlaufZustand`.
  let verlaufHinweisGezeigt = false;
  $effect(() => {
    if (verlaufZustand.grund && !verlaufHinweisGezeigt) {
      verlaufHinweisGezeigt = true;
      toast.warning(verlaufZustand.grund);
    }
  });

  // WS reconnect: messages.clearChannel() may empty the loaded set. Re-fetch
  // if we're still parked on this DM.
  $effect(() => {
    const cid = dmChannelId;
    if (!cid || messages.loadedChannels[cid]) return;
    if (prevDM !== cid) return;
    // Eine Gruppe hat auf dem Server keinen Verlauf, den man nachladen
    // koennte — er liegt nur lokal (`verlauf/`). Der Nachfass-Aufruf gaebe
    // hier 403 und liesse die Ansicht leer zurueck.
    if (privateGruppen.istGruppe(cid)) return;
    if (!directMessages.byId[cid]) return;
    void chatApi
      .listMessages(cid, {}, cloudRoute)
      .then((history) => {
        if (untrack(() => prevDM) === cid) {
          messages.setInitial(cid, history);
          void verlaufSpeichern(cid, history);
        }
      })
      .catch(() => {
        /* user-driven retry via navigation */
      });
  });

  // Prime the user cache for the other user of every DM so the sidebar +
  // header name resolve without a flash of "…".
  $effect(() => {
    for (const dm of directMessages.list) userCache.queue(dm.other_user_id);
  });

  /**
   * Das Abonnement eines Kanals aufgeben, den wir verlassen.
   *
   * **Ausser bei einer privaten Gruppe.** Deren Abonnement ist nicht an die
   * geoeffnete Ansicht gebunden, sondern an die Verbindung: es wird beim
   * `ready` fuer JEDE Gruppe gesetzt (`ws/handlers/ready.ts`), weil der
   * `postfach_neu`-Weckruf nur an die Abonnenten des Kanals geht. Wer es hier
   * beim Wegklicken aufgibt, macht die Gruppe bis zum naechsten Verbinden
   * stumm — und das faellt kaum auf, weil die Nachricht ja nicht verloren
   * ist, sondern nur zu spaet kommt.
   */
  function abonnementAufgeben(cid: string) {
    if (privateGruppen.istGruppe(cid)) return;
    cloudGateway.unsubscribe(cid);
  }

  onDestroy(() => {
    for (const handle of pendingOptimisticTimeouts.values()) clearTimeout(handle);
    pendingOptimisticTimeouts.clear();
    if (prevDM) abonnementAufgeben(prevDM);
  });

  async function switchTo(cid: string) {
    const gen = untrack(() => (switchGen += 1));
    const isStale = () => untrack(() => switchGen) !== gen;
    const prev = untrack(() => prevDM);

    if (cid === prev) return;
    if (prev) abonnementAufgeben(prev);

    if (!cid) {
      untrack(() => (prevDM = ''));
      return;
    }

    // Gruppe oder DM? Einmal festhalten, danach nicht mehr nachsehen:
    // `switchTo` laeuft aus einem `$effect`, und ein Lesen des Speichers
    // mitten im Ablauf machte den Lauf von jeder Gruppen-Aenderung abhaengig.
    let istGruppe = untrack(() => privateGruppen.istGruppe(cid));

    // Direktlink/harter Reload: `cid` ist weder als Gruppe noch als DM
    // bekannt. Der Gruppen-Speicher kann in diesem Fenster noch leer sein
    // (eigenes, nicht abgewartetes `GET /gruppen`) — ohne dieses Warten
    // wuerde eine Gruppen-ID hier faelschlich als DM behandelt und
    // scheiterte unten an `chatApi.getDMChannel`. Fuer eine bekannte
    // Gruppe/DM (der ueberwiegende Fall) ist `privateGruppen.bereit` laengst
    // aufgeloest — kein zusaetzlicher Netzwerk-Umweg. Rechnung ausgelagert
    // (importfrei, s. CLAUDE.md „Die Falle"): `gruppen/kanalArtWarten.ts`.
    if (!istGruppe && !directMessages.byId[cid]) {
      istGruppe = await alsGruppeErkennenNachWarten(
        () => untrack(() => privateGruppen.istGruppe(cid)),
        () => privateGruppen.bereit
      );
      if (isStale()) return;
    }

    if (!istGruppe && !directMessages.byId[cid]) {
      // We don't know this DM yet — pull it (e.g. deep link before hydrate
      // finished, or the recipient opening a freshly-created DM).
      try {
        resolving = true;
        const dm = await chatApi.getDMChannel(cid);  // cloud-routed internally
        if (isStale()) return;
        directMessages.upsert(dm);
      } catch (err) {
        if (isStale()) return;
        loadError = err instanceof Error ? err.message : m.dm_page_dm_not_found();
        resolving = false;
        return;
      }
    }

    // Cached from an earlier visit? Then its WS subscription lapsed while we
    // were away — re-subscribe + gap-fill below instead of re-fetching.
    const alreadyLoaded = !!messages.loadedChannels[cid];
    // C2: lokal ist ein Vorrat, keine Wahrheit — der lokale Bestand deckt nur
    // ab, was DIESER Klient seit C1 selbst gesehen hat. Der Server wird
    // deshalb IMMER zusätzlich gefragt, auch wenn lokal schon etwas da war.
    let lokal: Awaited<ReturnType<typeof verlaufLesen>> = [];
    try {
      if (!alreadyLoaded) {
        lokal = await verlaufLesen(cid, { anzahl: 50 });
        if (isStale()) return;
        // Sofort zeigen, was lokal liegt — das ist der spürbare Gewinn von
        // C2 — bevor die Serverantwort überhaupt eingetroffen sein kann.
        if (lokal.length > 0) messages.setInitial(cid, verlaufMergen(lokal, []));
        if (istGruppe) {
          // **Kein Serverabruf.** Der Server sieht in einer privaten Gruppe
          // nie Klartext (Spec §9) und fuehrt dort keine `messages`-Zeile;
          // `GET /channels/<id>/messages` antwortete 403. Der lokale Bestand
          // IST der Verlauf — das ist keine Abkuerzung, sondern die einzige
          // Kopie. Auch der leere Fall wird gesetzt, damit der Kanal als
          // geladen gilt und der Nachfass-Effekt oben nicht anspringt.
          messages.setInitial(cid, verlaufMergen(lokal, []));
        } else {
          const history = await chatApi.listMessages(cid, {}, cloudRoute);
          if (isStale()) return;
          messages.setInitial(cid, verlaufMergen(lokal, history));
          void verlaufSpeichern(cid, history);
        }
      }
    } catch (err) {
      if (isStale()) return;
      if (lokal.length === 0) {
        loadError = err instanceof Error ? err.message : m.dm_page_messages_load_failed();
        resolving = false;
        return;
      }
      // Lokal ist schon sichtbar — kein blockierender Fehler; der nächste
      // Kanalwechsel oder Reconnect versucht den Server erneut.
    }

    if (isStale()) return;
    cloudGateway.subscribe(cid);
    // Backfill anything that landed while the subscription was dropped.
    // Nicht fuer Gruppen: `gapFill` holt ueber die Klartext-Route nach, die
    // eine Gruppen-ID abweist — das Nachholen dort erledigt das Postfach
    // (`ws/handlers/ready.ts`).
    if (alreadyLoaded && !istGruppe) void cloudGateway.gapFill(cid);
    const loaded = messages.for(cid);
    const latestSeen = loaded[loaded.length - 1]?.id;
    if (latestSeen) readState.recordSeen(cid, latestSeen);
    // Acknowledge up to whatever we know is the latest — including ids
    // bumped in via dm_bump while we weren't subscribed (those don't land
    // in `messages.byChannel`, so `latestSeen` can lag behind).
    readState.markRead(cid);
    untrack(() => (prevDM = cid));
    loadError = null;
    resolving = false;
  }

  async function selectGuild(g: { id: string }) {
    // Server-Icon ist der Drawer-Trigger — dort dann den Channel-Drawer auf.
    navDrawer.open = true;
    await goto(`/app/guilds/${g.id}/channels/_`);
  }

  async function selectDM(dm: DMChannel) {
    navDrawer.open = false;
    if (dm.id === dmChannelId) return;
    await goto(`/app/@me/${dm.id}`);
  }

  /** Dieselbe Adresse wie eine DM — s. `aktiveGruppe` oben. Der Rueckruf wird
   *  den Listen nur bei eingeschaltetem Schalter gegeben; ohne ihn zeigen sie
   *  keinen Gruppen-Abschnitt. */
  const selectGruppe = PRIVATE_GRUPPEN_ENABLED
    ? async (gruppeId: string) => {
        navDrawer.open = false;
        if (gruppeId === dmChannelId) return;
        await goto(`/app/@me/${gruppeId}`);
      }
    : undefined;

  function sendMessage(
    text: string,
    replyToId: string | null,
    attachmentIds: string[],
    anhaenge: AnhangAngabe[] = []
  ) {
    if (!auth.user) return;
    // Private Gruppe: eigener Weg, ohne Klartext-Rueckfall und ohne
    // Gegenstelle (es gibt viele). Antwort-Kennungen werden wie im DM-Weg
    // erst in die kanonische Form uebersetzt — Sender und Empfaenger sehen
    // dieselbe verschluesselte Nachricht unter verschiedenen lokalen IDs.
    if (aktiveGruppe) {
      const gruppenKanal = aktiveGruppe.id;
      if (attachmentIds.length > 0 || anhaenge.length > 0) {
        toast.error(m.gruppe_senden_ohne_anhaenge());
        return;
      }
      const kanonischeId = kanonischeAntwortId(replyToId, visibleMessages);
      void import('$lib/krypto/gruppe/sendenMitAnzeige').then(
        ({ gruppeSendenMitAnzeige }) => gruppeSendenMitAnzeige(gruppenKanal, text, kanonischeId)
      );
      return;
    }

    if (!activeDM) return;
    // Kanal und Gegenstelle JETZT festhalten und weiterreichen: der
    // verschluesselte Weg unten wartet auf einen dynamischen Import und
    // mehrere Netzwerk-Aufrufe, und bis dahin kann der Nutzer laengst in
    // einem anderen Gespraech sein — `activeDM` zeigte dann woanders hin.
    const cid = activeDM.id;
    const partnerId = activeDM.other_user_id;

    // Verschluesselter Weg (Etappe D2, Schalter aus per Vorgabe). Antworten
    // (Kennung in der Nutzlast, s. `nachrichtNutzlast.ts`) UND Anhaenge
    // (Etappe E, Dateischluessel ebendort) fahren mit — die frueher hier
    // stehende Bedingung `attachmentIds.length === 0` ist damit entfallen.
    if (E2E_DMS_ENABLED) {
      // `replyToId` ist bislang nur die LOKALE ID des Ziels (wie der
      // Antwortende es gerade sieht) — Sender und Empfaenger derselben
      // verschluesselten Nachricht haben dafuer verschiedene lokale IDs,
      // s. `krypto/kanonischeAntwortId.ts`. Erst uebersetzen, dann senden.
      const kanonischeId = kanonischeAntwortId(replyToId, visibleMessages);
      void import('$lib/krypto/senden').then(async ({ sendeVerschluesselt }) => {
        let ergebnis;
        try {
          ergebnis = await sendeVerschluesselt(cid, partnerId, text, kanonischeId, anhaenge);
        } catch (err) {
          // Bughunt 2026-08-28, zweiter Fund: ein pauschales `.catch(() =>
          // null)` an dieser Stelle deutete JEDEN Fehler — auch einen, bei
          // dem die verschluesselte Zustellung laengst geschehen war — als
          // "kein Geraet erreichbar" und sendete zusaetzlich im Klartext.
          // `sendeVerschluesselt` behandelt die BEKANNTEN Faelle (204 =
          // zugestellt, 404 = Route fehlt -> sicher unverschluesselt) schon
          // selbst und liefert dafuer regulaer zurueck, NICHT per Wurf. Was
          // hier ankommt, ist deshalb ein UNERWARTETER Fehler, bei dem nicht
          // feststeht, ob die Zustellung durch war — ein automatischer
          // Klartext-Rueckfall koennte ein Duplikat erzeugen. Also nur
          // sichtbar melden, der Nutzer sendet bei Bedarf erneut.
          toast.error(m.dm_page_send_failed(), { description: (err as Error).message });
          return;
        }
        if (ergebnis?.art === 'verschluesselt') {
          messages.upsert(ergebnis.nachricht);
          return;
        }
        // Ab hier gilt die Koexistenz-Regel (Spec §3): die Gegenseite hat
        // kein dauerhaftes Geraet, es wurde NICHTS eingeliefert, der
        // Klartext-Weg ist der richtige. Mit Anhaengen aber NICHT: ihre
        // Klumpen liegen schon verschluesselt am Postfach, und ihre
        // Kennungen (`attachmentIds`) gehoeren einer Route, die der
        // Klartext-Weg nicht bedient. Sie stillschweigend mitzuschicken
        // hiesse, sie unbemerkt fallenzulassen — deshalb ein sichtbarer
        // Hinweis statt eines stillen Rueckfalls.
        if (attachmentIds.length > 0 || anhaenge.length > 0) {
          toast.error(m.dm_page_attachment_needs_encryption());
          return;
        }
        sendeKlartext(cid, text, replyToId, []);
      });
      return;
    }

    sendeKlartext(cid, text, replyToId, attachmentIds);
  }

  function sendeKlartext(
    cid: string,
    text: string,
    replyToId: string | null,
    attachmentIds: string[]
  ) {
    if (!auth.user) return;
    sendeKlartextDm({
      cid,
      text,
      autorId: auth.user.id,
      replyToId,
      attachmentIds,
      route: cloudRoute,
      zeitgeber: pendingOptimisticTimeouts
    });
  }

  const editMessage = (msg: Message, content: string) =>
    nachrichtBearbeiten(msg, content, cloudRoute);
  const deleteMessage = (msg: Message) => nachrichtLoeschen(msg, cloudRoute);
  const toggleReaction = (msg: Message, emoji: string, currentlyMine: boolean) =>
    reaktionUmschalten(msg, emoji, currentlyMine, cloudRoute);
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={currentServerUserId()}
  homeActive={true}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app?add=create')}
  onJoinClick={() => goto('/app?add=join')}
  onHomeClick={async () => {
    navDrawer.open = !navDrawer.open;
    await goto('/app/friends');
  }}
/>

<!-- DM-Liste. Auf dem Handy ist sie der Chats-Bereich und fuellt den
     Bildschirm, solange kein Gespraech offen ist — kein Drawer mehr, damit der
     Bildschirmrand der System-Zurueck-Geste gehoert. Ab `md` wieder die
     schmale Seitenleiste neben dem Chat. -->
{#if viewport.isMobile}
  {#if !dmChannelId}
    <MobileChatsList onSelect={selectDM} onSelectGruppe={selectGruppe} />
  {/if}
{:else}
  <DMChannelList
    activeDMId={dmChannelId || null}
    onSelect={selectDM}
    onSelectGruppe={selectGruppe}
  />
{/if}

<!-- Chat: ab `md` dauerhaft; auf dem Handy nur mit geoeffnetem Gespraech. -->
{#if !viewport.isMobile || !!dmChannelId}
  {#if loadError}
    <section
      class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 md:rounded-2xl"
    >
      <FieldError message={loadError} testId="load-error" />
    </section>
  {:else if aktiveGruppe && synthChannel}
    <!-- Dieselbe Ansicht wie bei einer DM, nur mit anderer Huelle im Kopf und
         Zeilen- statt Sprechblasen-Darstellung. Eine eigene Gruppen-Ansicht
         daneben haette Anhaenge, Antworten, Reaktionen und das Aktionsblatt
         still verloren. -->
    <ChatView
      channel={synthChannel}
      messages={visibleMessages}
      onSend={sendMessage}
      headerKind="gruppe"
      onBack={() => goto('/app/@me')}
      cloudScoped
      showMemberList={false}
      onEditMessage={editMessage}
      onDeleteMessage={deleteMessage}
      onToggleReaction={toggleReaction}
    />
  {:else if activeDM && synthChannel}
    <ChatView
      channel={synthChannel}
      messages={visibleMessages}
      onSend={sendMessage}
      headerKind="dm"
      dmPartnerId={activeDM.other_user_id}
      onBack={() => goto('/app/@me')}
      cloudScoped
      verschluesselteAnhaenge={E2E_DMS_ENABLED}
      showMemberList={false}
      composerDisabled={activeDM.can_send === false}
      composerDisabledReason={m.dm_page_composer_disabled_reason()}
      onEditMessage={editMessage}
      onDeleteMessage={deleteMessage}
      onToggleReaction={toggleReaction}
    />
  {:else}
    <section
      class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-none p-8 md:rounded-2xl"
      data-testid="dm-empty-state"
    >
      <p class="text-text-bright text-base font-semibold">{m.dm_page_empty_title()}</p>
      <p class="text-text-muted max-w-sm text-center text-sm">
        {m.dm_page_empty_hint()}
      </p>
    </section>
  {/if}
{/if}
