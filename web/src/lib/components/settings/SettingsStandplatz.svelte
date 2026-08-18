<!--
  SettingsStandplatz — Dauerfreigabe und Protokoll des Geräts.

  Der Schalter, mit dem aus einem gewöhnlichen Rechner ein Standplatz-Gerät
  wird: einmal freigeben, danach beantwortet dieser Client Fernsteuer-Anfragen
  selbst (`$lib/remote/standplatz.svelte.ts`). Entwurf und Begründungen:
  `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`.

  **Freigabe und Protokoll stehen absichtlich im selben Bild** (§7 des
  Entwurfs). Bei einem beaufsichtigten Rechner ist die eigentliche Sicherheit,
  dass jemand danebensitzt; hier fällt der Zeuge weg, und das Protokoll tritt an
  seine Stelle. In einem Untermenü wäre es eine Alibi-Funktion.

  **Nur in der Desktop-App.** Ferngesteuert werden kann ausschliesslich ein
  Rechner mit lokalem Sidecar; im Browser wäre der Schalter eine Zusage, die
  niemand einlöst. Der Tab ist deshalb `electronOnly` (SettingsDialog), und
  dieser Hinweis ist das Netz, falls er doch einmal woanders landet.
-->
<script lang="ts">
  import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
  import SettingsGeraeteEintragung from './SettingsGeraeteEintragung.svelte';
  import SettingsStandplatzProfil from './SettingsStandplatzProfil.svelte';
  import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import XIcon from '@lucide/svelte/icons/x';
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import {
    spanneMs,
    standplatz,
    type Einheit,
    type Freigegebener,
    type Geltung,
  } from '$lib/remote/standplatz.svelte';
  import { remoteProtokoll } from '$lib/remote/protokoll.svelte';
  import { gegenstelle } from '$lib/remote/gegenstelle';
  import { userCache } from '$lib/stores/users.svelte';
  import { chatApi } from '$lib/api/chat';
  import { goto } from '$app/navigation';
  import { anzahlBerechtigte } from '$lib/remote/berechtigte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import type { Member } from '$lib/api/types';
  import { isElectron } from '$lib/platform/runtime';
  import { darfStandplatzSein } from '$lib/remote/darfStandplatzSein';
  import { m } from '$lib/paraglide/messages.js';

  const desktop = isElectron();
  // Kann sich dieser Rechner ueberhaupt steuern lassen? Dieselbe Bedingung
  // wie beim Reiter-Gate und bei der Anmeldung (`darfStandplatzSein`).
  const kannStandplatz = darfStandplatzSein();

  // Entwurf im Formular, erst „Freigeben" schreibt ihn fest. Ohne diese
  // Trennung stünde das Gerät schon scharf, während jemand noch die
  // Geltungsdauer sucht.
  let jeder = $state(standplatz.jeder);
  let geltung = $state<Geltung>(standplatz.geltung);
  // Die Spanne für „befristet". Vorgabe acht Stunden — ein Arbeitstag, der
  // frühere Festwert; jetzt bloss der Startpunkt statt der einzigen Wahl.
  let menge = $state(8);
  let einheit = $state<Einheit>('stunden');

  // Namen der einzeln Freigegebenen nachladen — sonst steht dort die nackte
  // Kennung, und niemand erkennt, wen er da freigegeben hat.
  $effect(() => {
    for (const n of standplatz.nutzer) userCache.queue(n.userId);
  });

  /**
   * Die laufende Uhr für die Restanzeige.
   *
   * **Halbminütlich und nicht sekündlich**: Chromium drosselt Zeitgeber in
   * verdeckten Fenstern auf einen Lauf je Minute — genau die Lage eines
   * Standplatz-Rechners. Ein Sekunden-Countdown sähe dort aus wie ein Fehler,
   * weil er in Sprüngen liefe. Die Anzeige nennt deshalb das **Ende** (das wird
   * nie falsch) und dazu eine grobe Restzeit.
   */
  let jetzt = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (jetzt = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  /** Restzeit in der gröbsten Einheit, die noch etwas sagt. */
  const restText = $derived.by(() => {
    const bis = standplatz.gueltigBis;
    if (bis === null) return null;
    const ms = Math.max(0, bis - jetzt);
    const minuten = Math.round(ms / 60_000);
    if (minuten < 60) return m.standplatz_rest_minutes({ count: Math.max(1, minuten) });
    const stunden = Math.round(minuten / 60);
    if (stunden < 48) return m.standplatz_rest_hours({ count: stunden });
    return m.standplatz_rest_days({ count: Math.round(stunden / 24) });
  });

  /** Das Ende als Datum und Uhrzeit — die Angabe, die nicht altert. */
  const endeText = $derived(
    standplatz.gueltigBis === null ? null : zeitpunkt(standplatz.gueltigBis),
  );

  const restStunden = $derived.by(() => {
    const rest = standplatz.restMs();
    return rest === null || rest === 0 ? null : Math.max(1, Math.round(rest / 3_600_000));
  });

  const geltungen: { id: Geltung; label: () => string }[] = [
    { id: 'befristet', label: m.standplatz_settings_duration_limited },
    { id: 'dauerhaft', label: m.standplatz_settings_duration_permanent },
  ];

  const einheiten: { id: Einheit; label: () => string }[] = [
    { id: 'stunden', label: m.standplatz_settings_unit_hours },
    { id: 'tage', label: m.standplatz_settings_unit_days },
    { id: 'wochen', label: m.standplatz_settings_unit_weeks },
  ];

  async function freigeben(): Promise<void> {
    // Die Zahl wird hier geklemmt und nicht erst im Speicher: ein geleertes
    // Zahlenfeld schreibt über `bind:value` ein `null`, und daraus würde sonst
    // ein Ablauf in der Vergangenheit (dieselbe Falle wie im Übertragungs-Profil).
    const zahl = Number.isFinite(Number(menge)) && Number(menge) > 0 ? Number(menge) : 1;
    await standplatz.freigeben({
      nutzer: standplatz.nutzer,
      jeder,
      geltung,
      dauerMs: spanneMs(zahl, einheit),
    });
  }

  /**
   * Die Mitglieder der Community, in der dieser Rechner steht.
   *
   * Ohne Liste musste man die Freigabe über den Zustimmungsdialog wachsen
   * lassen — also warten, bis jemand anfragt. Für „diese drei dürfen, sonst
   * niemand" war das der falsche Weg herum.
   *
   * Geladen wird erst, wenn der Reiter offen ist: es ist eine REST-Abfrage je
   * Community, und auf einem Rechner, der nur dasteht, sieht sie niemand an.
   */
  const eintragung = $derived(geraeteAnmeldung.fuerServer(activeServer.serverId));
  const standplatzGeraet = $derived(
    eintragung ? deviceStore.byId(eintragung.guildId, eintragung.deviceId) : null,
  );
  let mitglieder = $state<Member[]>([]);
  let auswahl = $state('');

  $effect(() => {
    const e = eintragung;
    if (!e) return;
    void deviceStore.ensureLoaded(e.guildId);
    void chatApi
      .listMembers(e.guildId)
      .then((liste) => {
        mitglieder = liste;
        for (const mm of liste) userCache.queue(mm.user_id);
      })
      .catch(() => {
        // Ohne Liste bleibt der bisherige Weg über den Dialog — kein Grund,
        // den ganzen Reiter mit einer Fehlermeldung zu belegen.
      });
  });

  /** Wer noch nicht freigegeben ist — und nicht man selbst (den eigenen
   *  Rechner steuert man nicht fern, der Gateway lehnt es ohnehin ab). */
  const waehlbar = $derived(
    mitglieder.filter(
      (mm) =>
        mm.user_id !== currentServerUserId() &&
        !standplatz.nutzer.some(
          (n) =>
            n.userId === mm.user_id &&
            n.serverId === activeServer.serverId &&
            n.channelId === (standplatzGeraet?.channel_id ?? ''),
        ),
    ),
  );

  /**
   * Wen „jeder mit dem Recht" gerade meint — als Zahl statt als Regel.
   *
   * Erst beim Öffnen berechnet und nicht laufend: es sind zwei Abrufe (Rollen
   * aller Mitglieder, Überschreibungen des Kanals), und die Antwort ändert sich
   * nur, wenn ein Admin an den Rechten dreht.
   */
  let berechtigte = $state<number | null>(null);
  $effect(() => {
    const e = eintragung;
    const kanal = standplatzGeraet?.channel_id;
    if (!e || !kanal || mitglieder.length === 0) return;
    void anzahlBerechtigte(e.guildId, kanal, mitglieder.map((mm) => mm.user_id))
      .then((n) => (berechtigte = n))
      .catch(() => (berechtigte = null));
  });

  async function hinzufuegen(): Promise<void> {
    const kanal = standplatzGeraet?.channel_id;
    const server = activeServer.serverId;
    if (!auswahl || !kanal || !server) return;
    // Über `nutzerErgaenzen`, nicht über `freigeben`: ein Name mehr soll die
    // Freigabe nicht scharf schalten und die Geltung nicht anfassen.
    await standplatz.nutzerErgaenzen({ serverId: server, channelId: kanal, userId: auswahl });
    auswahl = '';
  }

  async function entfernen(wen: Freigegebener): Promise<void> {
    // Über `nutzerSetzen`, NICHT über `freigeben`: das würde die Freigabe
    // scharf schalten, und ein Klick auf das X soll einen Namen streichen und
    // sonst nichts (Bughunt 2026-08-16).
    //
    // Verglichen wird der GANZE Eintrag, nicht nur die Nutzerkennung: die Liste
    // ist nach Server und Standplatz aufgeschlüsselt (derselbe Mensch kann in
    // zwei Kanälen freigegeben sein, und dieselbe Kennung auf zwei Servern zwei
    // Menschen). Ein Filter auf `userId` allein löschte alle Zeilen auf einmal
    // — ein X, das drei Freigaben mitnimmt, ohne es zu sagen.
    await standplatz.nutzerSetzen(
      standplatz.nutzer.filter(
        (n) =>
          n.serverId !== wen.serverId ||
          n.channelId !== wen.channelId ||
          n.userId !== wen.userId,
      ),
    );
  }

  function dauer(beginn: number, ende: number | null): string {
    if (ende === null) return m.standplatz_settings_log_running();
    const ms = ende - beginn;
    if (ms <= 0) return m.standplatz_settings_log_unknown_duration();
    const minuten = Math.round(ms / 60_000);
    return minuten < 60 ? `${Math.max(1, minuten)} min` : `${Math.round(minuten / 60)} h`;
  }

  function zeitpunkt(ms: number): string {
    return new Date(ms).toLocaleString();
  }

</script>

<div class="flex flex-col gap-5">

  {#if !desktop}
    <p class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-sm">
      {m.standplatz_settings_desktop_only()}
    </p>
  {:else if !kannStandplatz}
    <!-- Desktop, aber ohne Gegenstelle (Linux/macOS). Hier steht bewusst NUR
         der Hinweis und die Eintragung: alles andere — Dauerfreigabe,
         Standplatz-Profil, Berechtigte — richtet etwas ein, das dieser Rechner
         nicht einloesen kann. Die Eintragung bleibt, weil sie der einzige Weg
         ist, eine unter Windows angelegte Zeile wieder loszuwerden. -->
    <p class="border-border text-text-muted rounded-2xl border border-dashed p-4 text-sm">
      {m.standplatz_settings_platform_only()}
    </p>
    <SettingsGeraeteEintragung />
  {:else}
    <!-- Zustand -->
    <div class="border-border flex items-center gap-3 rounded-2xl border p-4">
      <span class="bg-bg-input grid size-9 shrink-0 place-items-center rounded-lg">
        <MonitorCogIcon
          class={standplatz.aktiv ? 'size-5 text-emerald-500' : 'text-text-muted size-5'}
        />
      </span>
      <span class="min-w-0 flex-1">
        <span class="text-text-bright block text-sm font-semibold" data-testid="standplatz-state">
          {standplatz.aktiv ? m.standplatz_settings_state_on() : m.standplatz_settings_state_off()}
        </span>
        {#if standplatz.aktiv}
          <span class="text-text-muted block text-xs">
            {standplatz.jeder
              ? m.standplatz_banner_scope_everyone()
              : m.standplatz_banner_scope_users({ count: standplatz.nutzer.length })}
            ·
            {endeText === null
              ? m.standplatz_banner_permanent()
              : `${m.standplatz_until({ zeitpunkt: endeText })} · ${restText}`}
          </span>
        {/if}
      </span>
      <!-- **Der Zustand ist der Schalter.** Freigeben und Aufheben sind dieselbe
           Entscheidung in zwei Richtungen; sie gehören deshalb an dieselbe
           Stelle — dorthin, wo steht, wie es gerade steht. Der Freigabe-Knopf
           stand bis 2026-08-16 unten am Ende des Formulars, also weit weg von
           der Zeile, die er umschaltet. -->
      {#if standplatz.aktiv}
        <Button
          size="sm"
          variant="destructive"
          onclick={() => standplatz.zuruecknehmen()}
          data-testid="standplatz-revoke"
        >
          {m.standplatz_settings_revoke()}
        </Button>
      {:else}
        <Button
          size="sm"
          onclick={freigeben}
          disabled={!jeder && standplatz.nutzer.length === 0}
          data-testid="standplatz-grant"
        >
          {m.standplatz_settings_grant()}
        </Button>
      {/if}
    </div>

    <SettingsGeraeteEintragung />

    <!-- Wer -->
    <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
      <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
        <ShieldCheckIcon class="size-4" />
        {m.standplatz_settings_who()}
      </span>

      <label class="flex items-start gap-3">
        <Checkbox class="mt-0.5 shrink-0" bind:checked={jeder} data-testid="standplatz-everyone" />
        <span class="min-w-0 flex-1">
          <span class="text-text-bright block text-sm font-medium">
            {m.standplatz_settings_everyone()}
          </span>
          <!-- Die Regel aufgelöst: wie viele Menschen das im Standplatz-Kanal
               gerade sind, und der Weg dorthin, wo man es ändert. Ohne diese
               Zeile setzt man einen Haken über eine Regel, die woanders
               gepflegt wird, ohne ihre Wirkung zu kennen. -->
          {#if berechtigte !== null && eintragung && standplatzGeraet}
            <button
              type="button"
              class="text-text-muted hover:text-text-bright text-xs underline
                underline-offset-2"
              onclick={() =>
                goto(
                  `/app/guilds/${eintragung.guildId}/channels/${standplatzGeraet.channel_id}/permissions`,
                )}
              data-testid="standplatz-everyone-count"
            >
              {m.standplatz_settings_everyone_count({ count: berechtigte })}
            </button>
          {/if}
        </span>
      </label>

      <div class="border-border/60 flex flex-col gap-2 border-t pt-3">
        <span class="text-text-bright text-sm font-medium">
          {m.standplatz_settings_users_label()}
        </span>
        <!-- Sichtbar, sobald der Rechner eingetragen ist — nicht erst, wenn auch
             die Gerätezeile vom Server da ist. Die kommt gleich (der Effect
             oben lädt sie), und eine Auswahl, die eine Sekunde später
             erscheint, sieht aus wie eine fehlende Funktion. Der Knopf bleibt
             so lange gesperrt: ohne Standplatz gibt es keinen Kanal, für den
             die Freigabe gälte. -->
        {#if eintragung}
          <div class="flex items-center gap-2">
            <select
              class="border-border bg-bg-input text-text-bright min-w-0 flex-1 rounded-lg border
                px-2 py-1.5 text-sm"
              bind:value={auswahl}
              disabled={jeder || waehlbar.length === 0}
              data-testid="standplatz-user-select"
            >
              <option value="">{m.standplatz_settings_user_pick()}</option>
              {#each waehlbar as mm (mm.user_id)}
                {@const wer = gegenstelle(mm.user_id)}
                <option value={mm.user_id}>
                  {mm.nickname ?? wer.anzeige}{wer.benutzername ? ` · @${wer.benutzername}` : ''}
                </option>
              {/each}
            </select>
            <Button
              size="sm"
              disabled={!auswahl || !standplatzGeraet}
              onclick={() => void hinzufuegen()}
              data-testid="standplatz-user-add"
            >
              {m.standplatz_settings_user_add()}
            </Button>
          </div>
        {/if}
          {#if standplatz.nutzer.length === 0}
          <span class="text-text-muted text-xs italic">{m.standplatz_settings_users_empty()}</span>
        {:else}
          <!-- **Gedämpft, solange „jeder" gilt.** Die Liste ist dann wirkungslos:
               `darfOhneRueckfrage` gibt bei `jeder` frei, bevor sie überhaupt
               gelesen wird. Sie ist die engere Alternative, keine Verfeinerung —
               wer „jeder mit dem Recht" enger fassen will, tut das in der
               Rechtevergabe der Community, nicht hier. Sichtbar bleibt sie
               trotzdem: sie gilt wieder, sobald der Haken fällt. -->
          <ul class="flex flex-col gap-1.5" class:opacity-50={jeder}>
            {#each standplatz.nutzer as n (`${n.serverId}:${n.channelId}:${n.userId}`)}
              {@const wer = gegenstelle(n.userId)}
              <li class="flex items-center gap-2">
                <span class="text-text-base min-w-0 flex-1 truncate text-sm">
                  {wer.anzeige}{wer.benutzername ? ` · @${wer.benutzername}` : ''}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={jeder}
                  onclick={() => entfernen(n)}
                  aria-label={m.standplatz_settings_user_remove()}
                >
                  <XIcon class="size-4" />
                </Button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <!-- Wie lange -->
      <div class="border-border/60 flex flex-col gap-2 border-t pt-3">
        <span class="text-text-bright text-sm font-medium">{m.standplatz_settings_duration()}</span>
        <div class="flex flex-wrap gap-2">
          {#each geltungen as g (g.id)}
            <Button
              size="sm"
              variant={geltung === g.id ? 'default' : 'outline'}
              onclick={() => (geltung = g.id)}
              data-testid={`standplatz-duration-${g.id}`}
            >
              {g.label()}
            </Button>
          {/each}
        </div>
        {#if geltung === 'befristet'}
          <div class="flex items-center gap-2">
            <Input
              type="number"
              min="1"
              max="999"
              class="w-24"
              bind:value={menge}
              data-testid="standplatz-duration-amount"
            />
            <select
              class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
              bind:value={einheit}
              data-testid="standplatz-duration-unit"
            >
              {#each einheiten as e (e.id)}
                <option value={e.id}>{e.label()}</option>
              {/each}
            </select>
          </div>
        {/if}
      </div>

    </div>


    <SettingsStandplatzProfil />

    <!-- Protokoll -->
    <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
      <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
        <ScrollTextIcon class="size-4" />
        {m.standplatz_settings_log()}
      </span>
      {#if remoteProtokoll.eintraege.length === 0}
        <span class="text-text-muted text-xs italic">{m.standplatz_settings_log_empty()}</span>
      {:else}
        <ul class="flex flex-col gap-2" data-testid="standplatz-log">
          {#each remoteProtokoll.eintraege as e (e.id)}
            <li class="border-border/60 flex flex-col gap-0.5 border-b pb-2 last:border-b-0">
              <span class="text-text-bright truncate text-sm">{e.name}</span>
              <span class="text-text-muted text-xs">
                {zeitpunkt(e.beginn)} · {dauer(e.beginn, e.ende)} ·
                {e.selbsttaetig
                  ? m.standplatz_settings_log_auto()
                  : m.standplatz_settings_log_manual()}
              </span>
            </li>
          {/each}
        </ul>
        <div class="flex justify-end">
          <Button size="sm" variant="ghost" onclick={() => remoteProtokoll.leeren()}>
            {m.standplatz_settings_log_clear()}
          </Button>
        </div>
      {/if}
    </div>
  {/if}
</div>
