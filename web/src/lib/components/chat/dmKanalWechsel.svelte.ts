/**
 * Das Umschalten zwischen Gespraechen — herausgeloest aus
 * `routes/app/@me/[[dmChannelId]]/+page.svelte`, damit die Seite unter der
 * harten Groessen-Grenze bleibt. Der Umzug aendert kein Verhalten: dieselbe
 * Reihenfolge (Gruppen-/DM-Erkennung, lokaler Verlauf zuerst, dann Server,
 * dann Abonnement + Nachhol-Lese-Markierung), dieselben Stale-Checks ueber
 * einen laufenden Generation-Zaehler.
 *
 * `erstelleDmKanalWechsel()` haelt seinen eigenen `$state` — ein Aufruf pro
 * Komponenten-Instanz, wie `zustand.svelte.ts` es vormacht. Deshalb `.svelte.ts`
 * statt eines importfreien Moduls: die Rechnung IST zustandsbehaftet
 * (laufender Kanalwechsel, zuletzt gezeigter Fehler), das gehoert nicht in
 * Nodes Testlaeufer.
 */
import { untrack } from 'svelte';
import { chatApi } from '$lib/api/chat';
import { cloudGateway } from '$lib/ws/connection';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
import { alsGruppeErkennenNachWarten } from '$lib/gruppen/kanalArtWarten';
import { messages } from '$lib/stores/messages.svelte';
import { verlaufSpeichern, verlaufLesen, verlaufMergen } from '$lib/verlauf';
import { readState } from '$lib/stores/readState.svelte';
import { m } from '$lib/paraglide/messages.js';

export interface DmRoute {
  serverId?: string;
}

/**
 * Das Abonnement eines Kanals aufgeben, den wir verlassen.
 *
 * **Ausser bei einer privaten Gruppe.** Deren Abonnement ist nicht an die
 * geoeffnete Ansicht gebunden, sondern an die Verbindung: es wird beim
 * `ready` fuer JEDE Gruppe gesetzt (`ws/handlers/ready.ts`), weil der
 * `postfach_neu`-Weckruf nur an die Abonnenten des Kanals geht. Wer es hier
 * beim Wegklicken aufgibt, macht die Gruppe bis zum naechsten Verbinden
 * stumm — und das faellt kaum auf, weil die Nachricht ja nicht verloren ist,
 * sondern nur zu spaet kommt.
 */
function abonnementAufgeben(cid: string) {
  if (privateGruppen.istGruppe(cid)) return;
  cloudGateway.unsubscribe(cid);
}

export function erstelleDmKanalWechsel(cloudRoute: DmRoute) {
  let loadError = $state<string | null>(null);
  let resolving = $state(false);
  let prevDM = $state('');
  let switchGen = 0;

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
        const dm = await chatApi.getDMChannel(cid); // cloud-routed internally
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
    // Dünner lokaler Bestand: das Sicherungs-Archiv hält womöglich mehr
    // dieses Gesprächs. Die neuesten 50 fire-and-forget in den lokalen
    // Verlauf holen und die Ansicht per `prepend` auffrischen — deduped
    // über die Ids, hält die Scroll-Position, wirft nie (s.
    // `sicherungKanalSeiteLaden`). Bewusst NACH dem `setInitial` oben:
    // ein Treffer, der während des Serverabrufs einläuft, würde sonst
    // überschrieben. Nur beim Frischladen; ein wiedergeöffneter Kanal
    // deckt das Hochscrollen ab (`verlauf/nachladen.ts`). Dynamischer
    // Import wie in `verlauf/index.ts` — die Sicherung gehört nicht in
    // den Chat-Grundstack.
    // B5: das Gate zählt nur SICHTBARE Sätze — Grabstein-Zeilen
    // (`deleted_at !== null`) füllen die 50 auf, ohne etwas zu zeigen, und
    // würden ein nötiges Archiv-Nachladen stilllegen. Derselbe Filter wie
    // in `verlauf/nachladen.ts`.
    if (!alreadyLoaded && lokal.filter((n) => n.deleted_at === null).length < 50) {
      void import('$lib/sicherung/andock')
        .then(({ sicherungKanalSeiteLaden }) => sicherungKanalSeiteLaden(cid, 50))
        .then(async (angekommen) => {
          if (angekommen === 0 || isStale()) return;
          const frisch = await verlaufLesen(cid, { anzahl: 50 });
          if (isStale()) return;
          messages.prepend(cid, verlaufMergen(frisch, []));
        })
        .catch(() => {
          /* die Sicherung darf den Kanalwechsel nie stören — s. andock.ts */
        });
    }
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

  // WS reconnect: messages.clearChannel() may empty the loaded set. Re-fetch
  // if we're still parked on this DM.
  function nachladenWennNoetig(cid: string) {
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
  }

  function aufraeumen() {
    if (prevDM) abonnementAufgeben(prevDM);
  }

  return {
    get loadError() {
      return loadError;
    },
    get resolving() {
      return resolving;
    },
    switchTo,
    nachladenWennNoetig,
    aufraeumen
  };
}
