<!--
  /invite/<code>[?host=<fqdn>] — Einstieg über einen verschickten Einladungslink.

  Bis 2026-06-08 gab es diese Route, dann fiel sie beim Umbau auf Freundes-
  Einladungen weg (be72dedf), während „Link teilen“ (inviteLink.ts) diese
  Adresse seit 2026-07-13 wieder erzeugt — jeder Klick endete auf der
  Fehlerseite. Spec: docs/superpowers/specs/2026-10-10-einladungsseite-design.md

  Steht AUSSERHALB von /app (wie /c/<handle>): wer abgemeldet ist, soll die
  Einladung sehen, statt von der Anmelde-Wache weggeschickt zu werden. Der
  Rückweg nach Anmelden/Registrieren/Bestätigen läuft über die gemerkte
  Einladung (lib/einladung/gemerkt.ts), nicht über die Adresse.
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
  import { einladungAusUrl, zielHost, type Einladung } from '$lib/einladung/einladungsLink';
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
  import { isElectron, isLinux, isMac, isMobile, isWindows } from '$lib/platform/runtime';
  import {
    LINUX_FLATPAKREF_URL,
    MAC_DMG_URL,
    WINDOWS_INSTALLER_URL
  } from '$lib/downloads/appDownloads';

  const einladung = $derived(einladungAusUrl(page.url.href, CLOUD_HOSTNAME, page.url.host));

  let zustand = $state<EinladungZustand>('laden');
  let community = $state<EinladungCommunity | null>(null);
  let guildId = $state<string | null>(null);
  let hinweis = $state<string | null>(null);
  let busy = $state(false);
  let rueckfrage = $state(false);
  // Gegen überholte Antworten, wenn die Adresse wechselt (/invite/A → /invite/B).
  let lauf = 0;

  async function laden(e: Einladung | null) {
    const meiner = ++lauf;
    zustand = 'laden';
    community = null;
    guildId = null;
    hinweis = null;
    // Auth wird nur im /app-Layout hydriert; diese Route liegt außerhalb.
    await auth.hydrate().catch(() => {});
    if (meiner !== lauf) return;
    if (!e) {
      zustand = 'ungueltig';
      // Ein abgewiesener ?host= ist kein abgelaufener Link.
      hinweis =
        zielHost(page.url.searchParams.get('host'), CLOUD_HOSTNAME) === undefined
          ? m.einladung_host_ungueltig()
          : null;
      return;
    }
    // Unbestätigte Konten sperrt der chat-gateway komplett (403) — gar nicht erst fragen.
    if (auth.user?.email_verification_pending) {
      zustand = 'email';
      return;
    }
    const r = auth.user ? await ladeEinladung(e) : await ladeEinladungAbgemeldet(e);
    if (meiner !== lauf) return;
    zustand = r.zustand;
    community = r.community;
    guildId = r.guildId;
    hinweis = r.zustand === 'fehler' && r.fehler ? fehlerMeldung(r.fehler, e.host) : null;
  }

  $effect(() => {
    const e = einladung;
    untrack(() => void laden(e));
  });

  function merkenUndWeiter(ziel: string) {
    if (einladung) einladungMerken(browserSpeicher(), einladung, Date.now());
    void goto(ziel);
  }

  // Nur im Browser am Rechner — nie in der App selbst, nie am Handy.
  const amRechnerImBrowser = !isElectron() && !isMobile();
  const appKnopf = $derived(
    amRechnerImBrowser &&
      (zustand === 'einladung' || zustand === 'abgemeldet' || zustand === 'mitglied')
  );
  const downloadUrl = isWindows()
    ? WINDOWS_INSTALLER_URL
    : isMac()
      ? MAC_DMG_URL
      : isLinux()
        ? LINUX_FLATPAKREF_URL
        : null;
  let appGeoeffnet = $state(false);

  /** Startversuch über ein verstecktes iframe statt `location.href`: ohne
   *  installierte App ersetzt ein Browser die Seite sonst ggf. durch eine
   *  Fehlerseite, und der Hinweis „hier im Browser beitreten“ wäre weg. */
  function inDerApp() {
    if (!einladung) return;
    const params = new URLSearchParams({ code: einladung.code });
    if (einladung.host) params.set('host', einladung.host);
    const rahmen = document.createElement('iframe');
    rahmen.style.display = 'none';
    rahmen.src = `pulse://invite?${params.toString()}`;
    document.body.appendChild(rahmen);
    setTimeout(() => rahmen.remove(), 2000);
    appGeoeffnet = true;
  }

  async function beitreten(bestaetigt = false) {
    if (busy || !einladung) return;
    busy = true;
    hinweis = null;
    const r = await einladungAnnehmen(einladung, bestaetigt);
    busy = false;
    if (r.art === 'ok') gemerkteEinladungVerwerfen(browserSpeicher());
    else if (r.art === 'rueckfrage') rueckfrage = true;
    else hinweis = fehlerMeldung(r.fehler, einladung.host);
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
    host={einladung?.host ?? null}
    {hinweis}
    {busy}
    {appKnopf}
    {appGeoeffnet}
    {downloadUrl}
    onApp={inDerApp}
    onBeitreten={() => beitreten()}
    onOeffnen={() => guildId && goto(`/app/guilds/${guildId}/channels/_`)}
    onAnmelden={() => merkenUndWeiter('/login')}
    onRegistrieren={() => merkenUndWeiter('/register')}
    onEmail={() => merkenUndWeiter('/verify-email-required')}
    onErneut={() => laden(einladung)}
    onZuPulse={() => goto('/app')}
  />
</div>

<SelfHostContactConfirmDialog
  open={rueckfrage}
  hostname={einladung?.host ?? ''}
  onConfirm={() => {
    rueckfrage = false;
    void beitreten(true);
  }}
  onCancel={() => (rueckfrage = false)}
/>
