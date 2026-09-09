<!--
  DeviceFreigaben — die Freigabeliste eines Standplatz-Geräts.

  **Nur für den Besitzer** — nicht bloss ausgeblendet, sondern gar nicht erst
  im DOM. Die Liste sagt, wer den Rechner ohne Rückfrage übernehmen darf, und
  das geht niemanden sonst etwas an (DevTools sieht ausgeblendetes Markup).
  Deshalb steht die Bedingung beim Aufrufer (`DeviceView.svelte`,
  `SettingsStandplatzRechner.svelte`), nicht hier — dieselbe Form wie bei
  `DeviceVerwaltung`.

  **Drei Arten von Zeilen**: ein Nutzer (Name aus `userCache`), eine Rolle
  (Name aus dem Rollen-Store der Community des Standplatzes) und „jeder, der
  überhaupt anfragen darf" — keine Abkürzung an der Rechteprüfung vorbei, der
  Server verlangt weiterhin `REMOTE_CONTROL` am Standplatz, deshalb der
  erklärende Satz daneben. Seit 2026-09-09 ist „jeder" ein Schalter statt einer
  Listenzeile und Nutzer und Rollen teilen sich EIN Auswahlfeld: zwei
  Auswahlfelder, ein Knopf und eine Geltungs-Radiogruppe waren für die eine
  Frage „wen noch?" dreimal so viel Oberfläche wie nötig.

  **Jede Änderung schickt die GANZE Liste** (`freigaben.setzen`) — es gibt
  bewusst keinen Weg, einen einzelnen Eintrag zu ändern, sonst entstünde ein
  Zwischenzustand „scharf, aber für niemanden". Das Zusammenbauen der
  nächsten Liste steckt in `freigabenBearbeitung.ts`, die Dauer-Stufen in
  `freigabeDauer.ts` (beide importfrei, eigens testbar); diese Datei bleibt
  reine Anzeige + Formular.
-->
<script lang="ts">
  import { errText } from '$lib/utils/errText';
  import XIcon from '@lucide/svelte/icons/x';
  import { Button } from '$lib/components/ui/button/index.js';
  import Select from '$lib/components/form/Select.svelte';
  import Switch from '$lib/components/form/Switch.svelte';
  import { freigaben } from '$lib/devices/freigaben.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import { restzeit } from '$lib/devices/restzeit';
  import { restText } from '$lib/devices/restanzeige';
  import { mitNeuem, ohne } from '$lib/devices/freigabenBearbeitung';
  import {
    ablaufAb,
    FREIGABE_DAUERN,
    FREIGABE_DAUER_VORGABE,
    type FreigabeDauer,
  } from '$lib/devices/freigabeDauer';
  import { userCache } from '$lib/stores/users.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { chatApi } from '$lib/api/chat';
  import { m } from '$lib/paraglide/messages.js';
  import type { Device, Grant } from '$lib/api/devices';
  import type { Member } from '$lib/api/types';

  /** `eingebettet`: ohne eigenen Rahmen, weil die Karte darum herum schon
   *  einer ist (`SettingsStandplatzRechner`). In der Geräteansicht steht die
   *  Liste für sich und trägt den Rahmen selbst. */
  let { device, eingebettet = false }: { device: Device; eingebettet?: boolean } = $props();

  $effect(() => {
    void freigaben.laden(device.guild_id, device.id);
  });

  const liste = $derived(freigaben.fuer(device.id));
  const einzelne = $derived(liste.filter((g) => g.subject_type !== 'everyone'));
  const jederGrant = $derived(liste.find((g) => g.subject_type === 'everyone') ?? null);

  $effect(() => {
    for (const g of liste) {
      if (g.subject_type === 'user' && g.subject_id) userCache.queue(g.subject_id);
    }
  });

  // Halbminütlich statt sekündlich — Chromium drosselt Zeitgeber in
  // verdeckten Fenstern, und genau so steht ein Standplatz-Rechner meist da.
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
  const vergeben = $derived(new Set(einzelne.map((g) => `${g.subject_type}:${g.subject_id}`)));

  // Ein Feld für beides: Nutzer zuerst, dann Rollen mit Zusatz. Der Wert trägt
  // die Art als Präfix, damit `hinzufuegen` sie nicht raten muss.
  const kandidaten = $derived([
    ...mitglieder
      .filter((mm) => !vergeben.has(`user:${mm.user_id}`))
      .map((mm) => ({ value: `user:${mm.user_id}`, label: userCache.displayName(mm.user_id) })),
    ...rollenListe
      .filter((r) => !vergeben.has(`role:${r.id}`))
      .map((r) => ({ value: `role:${r.id}`, label: `${r.name} · ${m.device_grants_role_suffix()}` })),
  ]);

  const dauerOptionen = FREIGABE_DAUERN.map((d) => ({ value: d, label: dauerText(d) }));
  function dauerText(d: FreigabeDauer): string {
    if (d === '1h') return m.device_grants_dauer_1h();
    if (d === '8h') return m.device_grants_dauer_8h();
    if (d === '1d') return m.device_grants_dauer_1d();
    if (d === '1w') return m.device_grants_dauer_1w();
    return m.standplatz_settings_duration_permanent();
  }

  let dauer = $state<FreigabeDauer>(FREIGABE_DAUER_VORGABE);
  let fehler = $state<string | null>(null);

  async function speichern(naechste: ReturnType<typeof mitNeuem>): Promise<void> {
    fehler = null;
    try {
      await freigaben.setzen(device.guild_id, device.id, naechste);
    } catch (e) {
      fehler = errText(e);
    }
  }

  function hinzufuegen(wert: string): void {
    const [art, id] = wert.split(':', 2);
    if ((art !== 'user' && art !== 'role') || !id) return;
    void speichern(
      mitNeuem(liste, { subject_type: art, subject_id: id, expires_at: ablaufAb(dauer, Date.now()) }),
    );
  }

  function jederSetzen(an: boolean): void {
    if (an) {
      void speichern(
        mitNeuem(liste, { subject_type: 'everyone', subject_id: null, expires_at: ablaufAb(dauer, Date.now()) }),
      );
    } else if (jederGrant) {
      void speichern(ohne(liste, jederGrant.id));
    }
  }

  function entfernen(grant: Grant): void {
    void speichern(ohne(liste, grant.id));
  }

  function zeilenName(g: Grant): string {
    if (g.subject_type === 'role') {
      return rollenListe.find((r) => r.id === g.subject_id)?.name ?? (g.subject_id ?? '');
    }
    return g.subject_id ? userCache.displayName(g.subject_id) : '';
  }

  function geltungText(g: Grant): string {
    const rest = restzeit(g.expires_at, jetzt);
    if (rest === null) return m.standplatz_settings_duration_permanent();
    if (rest === 'abgelaufen') return m.device_grants_expired();
    return restText(rest);
  }
</script>

<div
  class={eingebettet
    ? 'flex flex-col gap-3'
    : 'border-border flex w-full max-w-sm flex-col gap-3 rounded-2xl border p-4 text-left'}
  data-testid="device-grants"
>
  <span class="text-text-bright text-sm font-medium">{m.device_grants_title()}</span>

  {#if einzelne.length === 0}
    <p class="text-text-muted text-xs">{m.device_grants_empty()}</p>
  {:else}
    <ul class="flex flex-col gap-1.5">
      {#each einzelne as grant (grant.id)}
        <li class="border-border/60 flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5">
          <div class="flex min-w-0 flex-col">
            <span class="text-text-bright truncate text-sm">
              {zeilenName(grant)}
              {#if grant.subject_type === 'role'}
                <span class="text-text-muted text-xs">· {m.device_grants_role_suffix()}</span>
              {/if}
            </span>
            <span class="text-text-muted text-xs">{geltungText(grant)}</span>
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

  <div class="flex items-center gap-2">
    <Select
      class="min-w-0 flex-1"
      value=""
      options={kandidaten}
      placeholder={m.device_grants_add_placeholder()}
      onchange={hinzufuegen}
      disabled={kandidaten.length === 0}
      data-testid="device-grant-add"
    />
    <Select
      class="w-auto shrink-0"
      value={dauer}
      options={dauerOptionen}
      onchange={(v) => (dauer = v as FreigabeDauer)}
      data-testid="device-grant-dauer"
    />
  </div>

  <div class="flex items-center justify-between gap-3 pt-1">
    <div class="flex min-w-0 flex-col">
      <span class="text-text-bright text-sm">{m.device_grants_everyone_label()}</span>
      <span class="text-text-muted text-xs">
        {jederGrant ? geltungText(jederGrant) : m.device_grants_everyone_hint()}
      </span>
    </div>
    <Switch
      checked={jederGrant !== null}
      onCheckedChange={jederSetzen}
      aria-label={m.device_grants_everyone_label()}
      data-testid="device-grant-everyone"
    />
  </div>

  <FieldError message={fehler === null ? null : m.device_manage_error({ error: fehler })} testId="device-grants-error" />
</div>
