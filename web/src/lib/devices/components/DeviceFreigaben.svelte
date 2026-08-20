<!--
  DeviceFreigaben — die Freigabeliste eines Standplatz-Geräts.

  **Nur für den Besitzer** — nicht bloss ausgeblendet, sondern gar nicht erst
  im DOM. Die Liste sagt, wer den Rechner ohne Rückfrage übernehmen darf, und
  das geht niemanden sonst etwas an (DevTools sieht ausgeblendetes Markup).
  Deshalb steht die Bedingung beim Aufrufer (`DeviceView.svelte`), nicht hier
  — dieselbe Form wie bei `DeviceVerwaltung`.

  **Drei Arten von Zeilen**: ein Nutzer (Name aus `userCache`), eine Rolle
  (Name aus dem Rollen-Store der Community des Standplatzes) und „jeder, der
  überhaupt anfragen darf" — keine Abkürzung an der Rechteprüfung vorbei, der
  Server verlangt weiterhin `REMOTE_CONTROL` am Standplatz, deshalb der
  erklärende Satz daneben.

  **Jede Änderung schickt die GANZE Liste** (`freigaben.setzen`) — es gibt
  bewusst keinen Weg, einen einzelnen Eintrag zu ändern, sonst entstünde ein
  Zwischenzustand „scharf, aber für niemanden". Das Zusammenbauen der
  nächsten Liste steckt in `freigabenBearbeitung.ts` (importfrei, eigens
  testbar), diese Datei bleibt reine Anzeige + Formular.
-->
<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import { Button } from '$lib/components/ui/button/index.js';
  import { freigaben } from '$lib/devices/freigaben.svelte';
  import { restzeit } from '$lib/devices/restzeit';
  import { mitNeuem, ohne } from '$lib/devices/freigabenBearbeitung';
  import DeviceFreigabenGeltung from '$lib/devices/components/DeviceFreigabenGeltung.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { chatApi } from '$lib/api/chat';
  import { spanneMs, type Einheit, type Geltung } from '$lib/remote/standplatz.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import type { Device, Grant } from '$lib/api/devices';
  import type { Member } from '$lib/api/types';

  let { device }: { device: Device } = $props();

  $effect(() => {
    void freigaben.laden(device.guild_id, device.id);
  });

  const liste = $derived(freigaben.fuer(device.id));

  $effect(() => {
    for (const g of liste) {
      if (g.subject_type === 'user' && g.subject_id) userCache.queue(g.subject_id);
    }
  });

  // Halbminütlich statt sekündlich — dieselbe Begründung wie in
  // `SettingsStandplatz`: Chromium drosselt Zeitgeber in verdeckten Fenstern.
  let jetzt = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (jetzt = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  let mitglieder = $state<Member[]>([]);
  $effect(() => {
    void chatApi
      .listMembers(device.guild_id)
      .then((liste_) => {
        mitglieder = liste_;
        for (const mm of liste_) userCache.queue(mm.user_id);
      })
      .catch(() => {
        mitglieder = [];
      });
  });

  const rollenListe = $derived((roles.byGuild[device.guild_id] ?? []).filter((r) => !r.is_everyone));

  const vergebeneNutzer = $derived(
    new Set(liste.filter((g) => g.subject_type === 'user').map((g) => g.subject_id)),
  );
  const vergebeneRollen = $derived(
    new Set(liste.filter((g) => g.subject_type === 'role').map((g) => g.subject_id)),
  );
  const hatJeder = $derived(liste.some((g) => g.subject_type === 'everyone'));

  const waehlbareNutzer = $derived(mitglieder.filter((mm) => !vergebeneNutzer.has(mm.user_id)));
  const waehlbareRollen = $derived(rollenListe.filter((r) => !vergebeneRollen.has(r.id)));

  let auswahlNutzer = $state('');
  let auswahlRolle = $state('');
  let geltung = $state<Geltung>('befristet');
  let menge = $state(8);
  let einheit = $state<Einheit>('stunden');
  let fehler = $state<string | null>(null);

  function ablauf(): string | null {
    if (geltung === 'dauerhaft') return null;
    // Wie im Übertragungs-Profil geklemmt, nicht erst im Speicher: ein
    // geleertes Zahlenfeld schreibt sonst einen Ablauf in der Vergangenheit.
    const zahl = Number.isFinite(Number(menge)) && Number(menge) > 0 ? Number(menge) : 1;
    return new Date(Date.now() + spanneMs(zahl, einheit)).toISOString();
  }

  async function speichern(naechste: ReturnType<typeof mitNeuem>): Promise<void> {
    fehler = null;
    try {
      await freigaben.setzen(device.guild_id, device.id, naechste);
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    }
  }

  function nutzerHinzufuegen(): void {
    if (!auswahlNutzer) return;
    const wen = auswahlNutzer;
    auswahlNutzer = '';
    void speichern(mitNeuem(liste, { subject_type: 'user', subject_id: wen, expires_at: ablauf() }));
  }

  function rolleHinzufuegen(): void {
    if (!auswahlRolle) return;
    const welche = auswahlRolle;
    auswahlRolle = '';
    void speichern(mitNeuem(liste, { subject_type: 'role', subject_id: welche, expires_at: ablauf() }));
  }

  function jederHinzufuegen(): void {
    void speichern(
      mitNeuem(liste, { subject_type: 'everyone', subject_id: null, expires_at: ablauf() }),
    );
  }

  function entfernen(grant: Grant): void {
    void speichern(ohne(liste, grant.id));
  }

  function zeilenName(g: Grant): string {
    if (g.subject_type === 'everyone') return m.device_grants_everyone_label();
    if (g.subject_type === 'role') {
      return rollenListe.find((r) => r.id === g.subject_id)?.name ?? (g.subject_id ?? '');
    }
    return g.subject_id ? userCache.displayName(g.subject_id) : '';
  }
</script>

<div
  class="border-border flex w-full max-w-sm flex-col gap-3 rounded-2xl border p-4 text-left"
  data-testid="device-grants"
>
  <span class="text-text-bright text-sm font-semibold">{m.device_grants_title()}</span>

  {#if liste.length === 0}
    <p class="text-text-muted text-xs">{m.device_grants_empty()}</p>
  {:else}
    <ul class="flex flex-col gap-1.5">
      {#each liste as grant (grant.id)}
        {@const rest = restzeit(grant.expires_at, jetzt)}
        <li class="border-border/60 flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5">
          <div class="flex min-w-0 flex-col">
            <span class="text-text-bright truncate text-sm">{zeilenName(grant)}</span>
            <span class="text-text-muted text-xs">
              {#if rest === null}
                {m.standplatz_settings_duration_permanent()}
              {:else if rest === 'abgelaufen'}
                {m.device_grants_expired()}
              {:else}
                {rest}
              {/if}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            class="size-6 shrink-0"
            onclick={() => entfernen(grant)}
            data-testid="device-grant-remove"
            aria-label={m.device_grants_remove_aria()}
          >
            <XIcon class="size-3.5" />
          </Button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="border-border/60 flex flex-col gap-2 border-t pt-3">
    <DeviceFreigabenGeltung bind:geltung bind:menge bind:einheit />

    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_grants_add_user_label()}</span>
      <select
        class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
        bind:value={auswahlNutzer}
        onchange={nutzerHinzufuegen}
        disabled={waehlbareNutzer.length === 0}
        data-testid="device-grant-add-user"
      >
        <option value="">{m.device_grants_add_user_placeholder()}</option>
        {#each waehlbareNutzer as mm (mm.user_id)}
          <option value={mm.user_id}>{userCache.displayName(mm.user_id)}</option>
        {/each}
      </select>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.device_grants_add_role_label()}</span>
      <select
        class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
        bind:value={auswahlRolle}
        onchange={rolleHinzufuegen}
        disabled={waehlbareRollen.length === 0}
        data-testid="device-grant-add-role"
      >
        <option value="">{m.device_grants_add_role_placeholder()}</option>
        {#each waehlbareRollen as r (r.id)}
          <option value={r.id}>{r.name}</option>
        {/each}
      </select>
    </label>

    {#if !hatJeder}
      <Button size="sm" variant="outline" onclick={jederHinzufuegen} data-testid="device-grant-everyone">
        {m.device_grants_add_everyone()}
      </Button>
    {/if}
    <p class="text-text-muted text-xs">{m.device_grants_everyone_hint()}</p>
    {#if fehler}
      <p class="text-xs text-red-500" data-testid="device-grants-error">
        {m.device_manage_error({ error: fehler })}
      </p>
    {/if}
  </div>
</div>
