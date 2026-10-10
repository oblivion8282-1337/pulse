<!--
  /c/<handle>[?host=<fqdn>] — öffentliche Community-Adresse.

  Dieselbe Karte und derselbe Rückweg wie /invite/<code> (Spec 2026-10-10,
  Etappe 4). Bis dahin trat diese Seite nach dem Login automatisch bei
  (/login?pendingAddress=…); jetzt merkt sie die Adresse
  (lib/einladung/gemerkt.ts), und der Dialog im App-Layout fragt nach dem
  Login — Beitreten ist immer ein eigener Klick.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
  import AuthBuehne from '$lib/components/AuthBuehne.svelte';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import EinladungKarte, {
    type EinladungCommunity,
    type EinladungZustand
  } from '$lib/einladung/EinladungKarte.svelte';
  import { istGueltigerHandle, zielHost, type Ziel } from '$lib/einladung/einladungsLink';
  import {
    browserSpeicher,
    einladungMerken,
    gemerkteEinladungVerwerfen
  } from '$lib/einladung/gemerkt';
  import {
    einladungAnnehmen,
    fehlerMeldung,
    ladeEinladung,
    ladeEinladungAbgemeldet
  } from '$lib/einladung/laden';
  import { m } from '$lib/paraglide/messages.js';

  const ziel = $derived.by((): Ziel | null => {
    const handle = (page.params.handle ?? '').toLowerCase();
    const host = zielHost(page.url.searchParams.get('host'), CLOUD_HOSTNAME);
    return istGueltigerHandle(handle) && host !== undefined ? { handle, host } : null;
  });

  let zustand = $state<EinladungZustand>('laden');
  let community = $state<EinladungCommunity | null>(null);
  let guildId = $state<string | null>(null);
  let hinweis = $state<string | null>(null);
  let busy = $state(false);
  let rueckfrage = $state(false);
  // Gegen überholte Antworten, wenn die Adresse wechselt.
  let lauf = 0;

  async function laden(z: Ziel | null) {
    const meiner = ++lauf;
    zustand = 'laden';
    community = null;
    guildId = null;
    hinweis = null;
    // Auth wird nur im /app-Layout hydriert; diese Route liegt außerhalb.
    await auth.hydrate().catch(() => {});
    if (meiner !== lauf) return;
    if (!z) {
      zustand = 'ungueltig';
      // Ein abgewiesener ?host= ist keine unbekannte Adresse.
      hinweis =
        zielHost(page.url.searchParams.get('host'), CLOUD_HOSTNAME) === undefined
          ? m.einladung_host_ungueltig()
          : null;
      return;
    }
    if (auth.user?.email_verification_pending) {
      zustand = 'email';
      return;
    }
    const r = auth.user ? await ladeEinladung(z) : await ladeEinladungAbgemeldet(z);
    if (meiner !== lauf) return;
    zustand = r.zustand;
    community = r.community;
    guildId = r.guildId;
    hinweis = r.zustand === 'fehler' && r.fehler ? fehlerMeldung(r.fehler, z.host) : null;
  }

  $effect(() => {
    const z = ziel;
    untrack(() => void laden(z));
  });

  function merkenUndWeiter(pfad: string) {
    if (ziel) einladungMerken(browserSpeicher(), ziel, Date.now());
    void goto(pfad);
  }

  async function beitreten(bestaetigt = false) {
    if (busy || !ziel) return;
    busy = true;
    hinweis = null;
    const r = await einladungAnnehmen(ziel, bestaetigt);
    busy = false;
    if (r.art === 'ok') gemerkteEinladungVerwerfen(browserSpeicher());
    else if (r.art === 'rueckfrage') rueckfrage = true;
    else hinweis = fehlerMeldung(r.fehler, ziel.host);
  }
</script>

<svelte:head>
  <title>
    {community ? m.einladung_seitentitel_name({ name: community.name }) : m.einladung_seitentitel()}
  </title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
  <AuthBuehne />
  <EinladungKarte
    {zustand}
    {community}
    host={ziel?.host ?? null}
    {hinweis}
    {busy}
    onBeitreten={() => beitreten()}
    onOeffnen={() => guildId && goto(`/app/guilds/${guildId}/channels/_`)}
    onAnmelden={() => merkenUndWeiter('/login')}
    onRegistrieren={() => merkenUndWeiter('/register')}
    onEmail={() => merkenUndWeiter('/verify-email-required')}
    onErneut={() => laden(ziel)}
    onZuPulse={() => goto('/app')}
  />
</div>

<SelfHostContactConfirmDialog
  open={rueckfrage}
  hostname={ziel?.host ?? ''}
  onConfirm={() => {
    rueckfrage = false;
    void beitreten(true);
  }}
  onCancel={() => (rueckfrage = false)}
/>
