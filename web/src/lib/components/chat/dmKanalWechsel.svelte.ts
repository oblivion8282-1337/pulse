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
import { gruppenApi } from '$lib/api/gruppen';
import { cloudGateway } from '$lib/ws/connection';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
import { alsGruppeErkennenNachWarten } from '$lib/gruppen/kanalArtWarten';
import { messages } from '$lib/stores/messages.svelte';
import { verlaufSpeichern, verlaufLesen, verlaufMergen } from '$lib/verlauf';
import { readState } from '$lib/stores/readState.svelte';
import { lesestandAnker } from '$lib/stores/lesestandKern';
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
      if (!istGruppe) {
        // Der Store war schon befüllt, kennt die Id aber trotzdem nicht —
        // z. B. auf einem Zweitgerät angelegt, während dieses Gerät nur den
        // älteren ready-Seed hält. Einmalig GET /gruppen nachziehen und
        // neu entscheiden, BEVOR die Id in den DM-/Kanal-Weg fällt
        // (Befund 05.10.: sonst 404 auf /channels/<id>/messages).
        await gruppenApi
          .auflisten()
          .then((gruppen) => privateGruppen.seed(gruppen))
          .catch(() => {});
        if (isStale()) return;
        istGruppe = untrack(() => privateGruppen.istGruppe(cid));
      }
    }

    if (istGruppe) {
      // Gruppen haben keinen Live-Pfad (kein WS-Ereignis, kein ready-Feld —
      // s. Store-Kopf `privateGruppen`): der einzige Weg an Membership-
      // Änderungen ist GET /gruppen, das sonst nur beim Neustart/reconnect
      // läuft. Beim Öffnen frisch nachhalten — Verlassen/Re-Add werden damit
      // ohne App-Neustart sichtbar (Testrunde 2026-09-24). Fire-and-forget:
      // der lokale Bestand zeigt sofort, der Seed korrigiert danach.
      void gruppenApi
        .auflisten()
        .then((gruppen) => privateGruppen.seed(gruppen))
        .catch(() => {});
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
        // Bughunt Runde 7: prevDM lösen — sonst blockt `cid === prev` die
        // Rückkehr zum VORGÄNGER-Gespräch (dessen Abo wir oben schon
        // abgegeben haben) und der Fehlerbildschirm bleibt für einen völlig
        // gesunden Kanal stehen, bis der Nutzer einen dritten öffnet.
        untrack(() => (prevDM = ''));
        return;
      }
    }

    // C2: lokal ist ein Vorrat, keine Wahrheit — der lokale Bestand deckt nur
    // ab, was DIESER Klient seit C1 selbst gesehen hat. Der Server wird
    // deshalb IMMER zusätzlich gefragt. Jedes Öffnen läuft daher durch
    // dieselbe Sequenz (lokal → zeigen → Server) — ein wiedergeöffneter
    // Chat sieht aus und lädt damit genauso wie der erste Besuch.
    //
    // Wiedereintritt: den Altbestand der letzten Visite vorher leeren. Startet
    // die virtuelle Liste mit ihm, laufen die setInitial unten mitten in der
    // Pin-Scroll-Phase über gemessene Items — virtuas Größenmodell verliert
    // dabei Updates und die Liste bekommt Phantom-Höhe am Ende (die
    // Scrollbar zeigt „nicht unten", obwohl die letzte Nachricht sichtbar
    // ist, und man kann in nichts weiterscrollen). Leeren macht den
    // Wiedereinstieg strukturell zum Erstbesuch: die Liste startet bei 0 und
    // misst einmalig den finalen Bestand.
    // untrack, weil das umgebende Effekt-Feuern sonst die eigene Schreiberei
    // auf `loadedChannels` als Abhängigkeit sieht und sich endlos selbst
    // stale-abortet (Kanal bliebe leer).
    untrack(() => {
      if (messages.loadedChannels[cid]) messages.setInitial(cid, []);
    });
    let lokal: Awaited<ReturnType<typeof verlaufLesen>> = [];
    try {
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
    // Sicherungs-Archiv nachziehen — BEI JEDEM Frischladen, nicht mehr nur
    // bei dünnem lokalem Bestand (bis 2026-09-10: nur wenn < 50 sichtbare
    // Sätze lokal lagen). Der Lesestand je Kanal macht den Lauf günstig:
    // bereits gelesene Rahmen kommen nicht erneut, geliefert werden nur
    // NEUE Ankünfte (z. B. von einem anderen Gerät des Kontos gesichert)
    // und, soweit das Kontingent reicht, ältere Seiten. Die alte 50er-
    // Klappe ließ genau den ersten Fall aus: lokal voll → Archiv wurde nie
    // gefragt → die fremdgesicherten Nachrichten blieben unsichtbar.
    // Fire-and-forget, deduped über die Ids, hält die Scroll-Position,
    // wirft nie (s. `sicherungKanalSeiteLaden`). Bewusst NACH dem
    // `setInitial` oben: ein Treffer, der während des Serverabrufs
    // einläuft, würde sonst überschrieben. Nur beim Frischladen; ein
    // wiedergeöffneter Kanal deckt das Hochscrollen ab
    // (`verlauf/nachladen.ts`). Dynamischer Import wie in
    // `verlauf/index.ts` — die Sicherung gehört nicht in den Chat-Grundstack.
    // In der C2-Sequenz (Wiedereinstieg = Erstbesuch) ist JEDER Öffner ein
    // Frischlader — der alte alreadyLoaded-Guard ist damit gegenstandslos.
    {
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

    // Server-Archiv nachziehen (Übergabe 2026-10-04 §5): auf einem Gerät
    // ohne lokalen Bestand füllt es den Verlauf aus der verschlüsselten
    // Server-Kopie (120 Tage, DMs wie private Gruppen — seit 2026-10-05
    // nimmt die Route beide; ein Mitglied liest eine Gruppe ab eigenem
    // Beitritt). Fire-and-forget, dedupet über die Ids im lokalen Store,
    // wirft nie (s. `archiv/lesen.ts`).
    void import('$lib/archiv/lesen')
      .then((m) => m.archivNachziehen(cid))
      .then(async (angekommen) => {
        if (angekommen === 0 || isStale()) return;
        const frisch = await verlaufLesen(cid, { anzahl: 50 });
        if (isStale()) return;
        messages.prepend(cid, verlaufMergen(frisch, []));
      });
    cloudGateway.subscribe(cid);
    // Backfill anything that landed while the subscription was dropped.
    // Nicht fuer Gruppen: `gapFill` holt ueber die Klartext-Route nach, die
    // eine Gruppen-ID abweist — das Nachholen dort erledigt das Postfach
    // (`ws/handlers/ready.ts`).
    // Bughunt Runde 5: nicht nur beim Wieder-Öffnen — der Frisch-Pfad
    // friert den REST-Snapshot ein, eine DM im Fenster bis zur Abo-
    // Registrierung erzeugt nur einen dm_bump. gapFillChannel liest
    // lastPersistedId (der frische Stand) und holt genau das Fenster.
    if (!istGruppe) void cloudGateway.gapFill(cid);
    const loaded = messages.for(cid);
    // Anker = kanonische Absender-ID bei verschlüsselten Nachrichten (B3,
    // s. `lesestandKern.lesestandAnker`) — nicht die Zustellungs-ID.
    const letzte = loaded[loaded.length - 1];
    const latestSeen = letzte ? lesestandAnker(letzte) : undefined;
    if (latestSeen) readState.recordSeen(cid, latestSeen);
    // Acknowledge up to whatever we know is the latest — including ids
    // bumped in via dm_bump while we weren't subscribed (those don't land
    // in `messages.byChannel`, so `latestSeen` can lag behind).
    readState.markRead(cid);
    // Gruppen-Lesebestätigung (Übergabe 05.10.): den eigenen Stand beim
    // Server melden — daraus rechnen die ABSENDER den blauen Haken („alle
    // haben gelesen"). Fire-and-forget; eine verpasste Meldung holt der
    // nächste Öffnen-Lauf nach.
    untrack(() => (prevDM = cid));
    if (istGruppe && latestSeen) {
      void import('$lib/api/gruppen')
        .then((m) => m.gruppenLesestandSetzen(cid, latestSeen))
        .catch(() => undefined);
    }
    loadError = null;
    resolving = false;
  }

  // WS reconnect: messages.clearChannel() may empty the loaded set. Re-fetch
  // if we're still parked on this DM.
  //
  // Security-/Bughunt-Nachtrag 2026-09-18 (live am Cross-Server-Szenario
  // reproduziert): das setInitial hier trug NUR die Server-Antwort — und die
  // kennt bei E2E-DMs die neuere Nachrichten NICHT (der Server löscht den
  // Umschlag nach der Quittung; sie leben im lokalen Verlauf). Nach einem
  // Serverwechsel (messages.clear() durch resetServerScopedStores, während
  // prevDM === cid bleibt) warf dieser Pfad die lokale Ansicht weg und
  // ersetzte sie durch den alten Klartext-Stand — „plötzlich andere PMs von
  // derselben Person", heilbar nur per Reload. Deshalb derselbe Merge wie in
  // switchTo: lokal + Server.
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
      .then(async (history) => {
        if (untrack(() => prevDM) !== cid) return;
        const lokal = await verlaufLesen(cid, { anzahl: 50 });
        if (untrack(() => prevDM) !== cid) return;
        messages.setInitial(cid, verlaufMergen(lokal, history));
        void verlaufSpeichern(cid, history);
      })
      .catch(() => {
        /* user-driven retry via navigation */
      });
  }

  function aufraeumen() {
    if (prevDM) abonnementAufgeben(prevDM);
  }

  /** Altbestand des Zielkanals vor dem ersten Rendern leeren (derselben
   *  Grund wie das Leeren in `switchTo` — s. dort). Muss SYNCHRON im Setup
   *  der Seite laufen: läuft es erst im Effekt, rendert die Liste einen Frame
   *  lang den Altbestand oben und blitzt, bevor der Sprung nach unten kommt.
   */
  function vorbereiten(cid: string) {
    untrack(() => {
      if (cid && messages.loadedChannels[cid]) messages.setInitial(cid, []);
    });
  }

  return {
    get loadError() {
      return loadError;
    },
    get resolving() {
      return resolving;
    },
    vorbereiten,
    switchTo,
    nachladenWennNoetig,
    aufraeumen
  };
}
