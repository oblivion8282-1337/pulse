<!--
  Inhalt einer Community-Einladung — dieselbe Karte auf der Einladungsseite
  (/invite/<code>) und der öffentlichen Adresse (/c/<handle>, `art="adresse"`),
  jeweils als Einstieg von außen, und im Dialog in der App (Link im Chat,
  Deep-Link aus dem Browser). Rein darstellend: Daten und Aktionen kommen als
  Props, damit Seite und Dialog gleich aussehen, ohne die Ladelogik zu doppeln.
-->
<script lang="ts" module>
  export type EinladungZustand =
    | 'laden'
    | 'einladung'
    | 'abgemeldet'
    | 'email'
    | 'mitglied'
    | 'ungueltig'
    | 'fehler';
  export interface EinladungCommunity {
    name: string;
    iconUrl: string | null;
    mitglieder: number | null;
  }
</script>

<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ServerIcon from '@lucide/svelte/icons/server';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import LinkOffIcon from '@lucide/svelte/icons/unlink';
  import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
  import MailIcon from '@lucide/svelte/icons/mail';
  import { anfangsBuchstabe } from '$lib/utils/anfangsBuchstabe';
  import { m } from '$lib/paraglide/messages.js';

  let {
    zustand,
    community = null,
    host = null,
    rahmen = 'karte',
    art = 'einladung',
    hinweis = null,
    busy = false,
    appKnopf = false,
    appGeoeffnet = false,
    downloadUrl = null,
    onBeitreten,
    onOeffnen,
    onAnmelden,
    onRegistrieren,
    onEmail,
    onApp,
    onZuPulse,
    onErneut
  }: {
    zustand: EinladungZustand;
    community?: EinladungCommunity | null;
    /** FQDN des Self-Hosts; null = Cloud. */
    host?: string | null;
    rahmen?: 'karte' | 'dialog';
    /** Öffentliche Adresse statt Einladungscode: andere Überschrift und Texte. */
    art?: 'einladung' | 'adresse';
    /** Fehlertext (Zustand 'fehler') bzw. gescheiterter Beitritt. */
    hinweis?: string | null;
    busy?: boolean;
    /** „In der Desktop-App öffnen“ — nur im Browser am Rechner. */
    appKnopf?: boolean;
    appGeoeffnet?: boolean;
    downloadUrl?: string | null;
    onBeitreten?: () => void;
    onOeffnen?: () => void;
    onAnmelden?: () => void;
    onRegistrieren?: () => void;
    onEmail?: () => void;
    onApp?: () => void;
    onZuPulse?: () => void;
    onErneut?: () => void;
  } = $props();

  const adresse = $derived(art === 'adresse');
  const titel = $derived(
    community?.name ?? (host ? m.einladung_titel_selfhost() : m.einladung_titel_unbekannt())
  );
  const mitgliederText = $derived(
    community?.mitglieder == null
      ? null
      : community.mitglieder === 1
        ? m.invite_embed_member_count_one({ count: 1 })
        : m.invite_embed_member_count({ count: community.mitglieder })
  );
  const zuPulseText = $derived(
    rahmen === 'dialog' ? m.invite_dialog_close_btn() : m.einladung_zu_pulse()
  );
</script>

<div
  class={rahmen === 'karte'
    ? 'bg-card border-border/60 flex w-full max-w-md flex-col items-center gap-6 rounded-xl border p-8 text-center shadow-2xl'
    : 'flex flex-col items-center gap-6 text-center'}
  data-testid="einladung-karte"
  data-zustand={zustand}
>
  {#if zustand === 'laden'}
    <div class="bg-bg-hover size-20 animate-pulse rounded-full"></div>
    <div class="flex w-full flex-col items-center gap-2">
      <div class="bg-bg-hover h-6 w-40 animate-pulse rounded"></div>
      <div class="bg-bg-hover h-4 w-24 animate-pulse rounded"></div>
    </div>
    <div class="bg-bg-hover h-9 w-full animate-pulse rounded-md"></div>
  {:else if zustand === 'ungueltig' || zustand === 'fehler'}
    <div class="bg-bg-hover text-text-muted flex size-16 items-center justify-center rounded-full">
      {#if zustand === 'ungueltig'}<LinkOffIcon class="size-7" />{:else}<WifiOffIcon class="size-7" />{/if}
    </div>
    <div class="flex flex-col gap-2">
      <h1 class="text-card-foreground text-xl font-semibold">
        {zustand !== 'ungueltig'
          ? m.einladung_fehler_titel()
          : adresse
            ? m.einladung_ungueltig_titel_adresse()
            : m.einladung_ungueltig_titel()}
      </h1>
      <p class="text-muted-foreground text-sm" data-testid="einladung-hinweis">
        {zustand === 'ungueltig'
          ? (hinweis ??
            (adresse ? m.einladung_ungueltig_text_adresse() : m.einladung_ungueltig_text()))
          : hinweis}
      </p>
    </div>
    <div class="flex w-full flex-col gap-2">
      {#if zustand === 'fehler'}
        <Button class="w-full" onclick={onErneut} data-testid="einladung-erneut">
          {m.einladung_erneut()}
        </Button>
      {/if}
      <Button variant="outline" class="w-full" onclick={onZuPulse} data-testid="einladung-zu-pulse">
        {zuPulseText}
      </Button>
    </div>
  {:else if zustand === 'email'}
    <div class="bg-primary/15 text-primary flex size-16 items-center justify-center rounded-full">
      <MailIcon class="size-7" />
    </div>
    <div class="flex flex-col gap-2">
      <h1 class="text-card-foreground text-xl font-semibold">{m.einladung_email_titel()}</h1>
      <p class="text-muted-foreground text-sm">{m.einladung_email_text()}</p>
    </div>
    <Button class="w-full" onclick={onEmail} data-testid="einladung-email">
      {m.einladung_email_knopf()}
    </Button>
  {:else}
    <p class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
      {adresse ? m.einladung_eyebrow_adresse() : m.einladung_eyebrow()}
    </p>

    {#if !community && host}
      <div class="bg-primary/15 text-primary flex size-20 items-center justify-center rounded-full">
        <ServerIcon class="size-9" />
      </div>
    {:else if community}
      <Avatar.Root class="size-20">
        {#if community.iconUrl}
          <Avatar.Image src={community.iconUrl} alt="" />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-2xl font-semibold">
          {anfangsBuchstabe(community.name)}
        </Avatar.Fallback>
      </Avatar.Root>
    {:else}
      <img src="/pulse-mark.svg" alt="Pulse" width="80" height="80" class="size-20" />
    {/if}

    <div class="flex flex-col items-center gap-2">
      <h1 class="text-card-foreground text-2xl font-semibold" data-testid="einladung-name">{titel}</h1>
      {#if mitgliederText}
        <p class="text-muted-foreground text-sm">{mitgliederText}</p>
      {/if}
      {#if host}
        <span
          class="bg-primary/15 text-primary inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
          data-testid="einladung-host"
        >
          <ServerIcon class="size-3.5 shrink-0" />
          <span class="truncate">{host}</span>
        </span>
      {/if}
    </div>

    {#if host && zustand === 'einladung'}
      <p class="text-muted-foreground text-xs">{m.einladung_selfhost_hinweis()}</p>
    {/if}

    <div class="flex w-full flex-col gap-2">
      {#if zustand === 'einladung'}
        <Button class="w-full" onclick={onBeitreten} disabled={busy} data-testid="einladung-beitreten">
          {busy ? m.einladung_beitreten_laeuft() : m.einladung_beitreten()}
        </Button>
      {:else if zustand === 'mitglied'}
        <p class="text-muted-foreground pb-1 text-sm">{m.einladung_schon_mitglied()}</p>
        <Button class="w-full" onclick={onOeffnen} data-testid="einladung-oeffnen">
          {m.einladung_oeffnen()}
        </Button>
      {:else if zustand === 'abgemeldet'}
        <Button class="w-full" onclick={onAnmelden} data-testid="einladung-anmelden">
          {m.einladung_anmelden()}
        </Button>
        <Button variant="outline" class="w-full" onclick={onRegistrieren} data-testid="einladung-registrieren">
          {m.einladung_registrieren()}
        </Button>
      {/if}
      {#if appKnopf}
        <Button variant="ghost" class="w-full" onclick={onApp} data-testid="einladung-app">
          <MonitorIcon class="size-4" />
          {m.einladung_app_oeffnen()}
        </Button>
      {/if}
    </div>

    {#if hinweis}
      <p class="text-destructive text-sm" role="alert" data-testid="einladung-hinweis">{hinweis}</p>
    {/if}
    {#if appGeoeffnet}
      <p class="bg-bg-input border-border text-muted-foreground w-full rounded-lg border px-3 py-2 text-xs">
        {m.einladung_app_hinweis()}
        {#if downloadUrl}
          <a class="text-primary font-semibold underline-offset-2 hover:underline" href={downloadUrl}>
            {m.einladung_app_download()}
          </a>
        {/if}
      </p>
    {:else if zustand === 'abgemeldet'}
      <p class="text-muted-foreground text-xs">
        {adresse ? m.einladung_anmelden_hinweis_adresse() : m.einladung_anmelden_hinweis()}
      </p>
    {/if}
  {/if}
</div>
