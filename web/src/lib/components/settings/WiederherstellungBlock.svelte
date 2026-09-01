<script lang="ts">
  /**
   * Wiederherstellung — Einstellungs-Block (E4, Aufgabe 4). Hängt unter
   * `SpeicherSektion.svelte` ein, weil der Code ohne eine Ablage-Verbindung
   * nichts zu sichern hätte (s. `krypto/wiederherstellung.svelte.ts`).
   *
   * Drei Wege, drei Zustände:
   *  - **Erzeugen/Erneuern**: derselbe Knopf, nur die Beschriftung wechselt
   *    ("einrichten" vs. "neuen Code erzeugen") — serverseitig ist Erneuern
   *    ein PUT, das das alte Päckchen ersetzt (`erzeugeUndSichere`).
   *  - **Einlösen**: eigener Dialog (`WiederherstellungEinloesen.svelte`).
   *  - Der Code-Anzeige-Dialog lässt sich NICHT per Escape/Aussenklick
   *    schliessen (`escapeKeydownBehavior`/`interactOutsideBehavior`
   *    "ignore", `showCloseButton={false}`) — nur die Bestätigung in
   *    `WiederherstellungCodeZeigen.svelte` schliesst ihn. Genau das ist der
   *    Punkt: niemand soll den Code wegklicken, ohne ihn notiert zu haben.
   */
  import type { RueckwegBericht } from '$lib/ablage/archivRueckweg.ts';
  import { onMount } from 'svelte';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { toast } from 'svelte-sonner';
  import WiederherstellungCodeZeigen from './WiederherstellungCodeZeigen.svelte';
  import WiederherstellungEinloesen from './WiederherstellungEinloesen.svelte';
  import { erzeugeUndSichere } from '$lib/krypto/wiederherstellung.svelte.ts';
  import { getRecoveryPackage } from '$lib/api/recovery-package';
  import { ApiError } from '$lib/api/client';
  import { m } from '$lib/paraglide/messages.js';

  type Zustand = 'unbekannt' | 'keins' | 'vorhanden';
  let zustand = $state<Zustand>('unbekannt');
  let zuletztAktualisiert = $state<string | null>(null);

  let erzeugenOffen = $state(false);
  let einloesenOffen = $state(false);
  let neuerCode = $state<string | null>(null);
  let busy = $state(false);

  async function ladeStatus() {
    try {
      const paket = await getRecoveryPackage();
      zustand = 'vorhanden';
      zuletztAktualisiert = paket.updated_at;
    } catch (err) {
      // Nur ein echtes 404 ist ein Befund ("keins") — jeder andere Fehler
      // (Netz, 500) sagt nichts über das Vorhandensein, s. Aufgabe 4.
      if (err instanceof ApiError && err.status === 404) zustand = 'keins';
    }
  }

  onMount(() => void ladeStatus());

  async function starteErzeugen() {
    if (busy) return;
    busy = true;
    try {
      neuerCode = await erzeugeUndSichere();
      erzeugenOffen = true;
    } catch {
      toast.error(m.wiederherstellung_erzeugen_fehler());
    } finally {
      busy = false;
    }
  }

  function erzeugenFertig() {
    erzeugenOffen = false;
    neuerCode = null;
    zustand = 'vorhanden';
    zuletztAktualisiert = new Date().toISOString();
    toast.success(m.wiederherstellung_erzeugen_erfolg());
  }

  function wiederhergestellt(anzahl: number, verlauf: RueckwegBericht | null) {
    toast.success(m.wiederherstellung_einloesen_erfolg({ anzahl }));
    // **Den Verlauf getrennt melden, und auch die Null.** Zurueckgeholte
    // Laufwerke sind nicht der Zweck der Uebung — der Verlauf ist es. Kaeme
    // hier nichts an und stuende trotzdem nur „3 Laufwerke wiederhergestellt",
    // hielte der Nutzer den Vorgang fuer gelungen und merkte den Verlust
    // vielleicht erst Wochen spaeter.
    if (verlauf === null) {
      toast.info(
        'Es war kein Archiv hinterlegt — deine Laufwerke sind zurück, dein Verlauf konnte nicht geholt werden.'
      );
    } else if (verlauf.zurueckgeholt === 0) {
      toast.warning('Im Archiv lag kein Verlauf. Deine Laufwerke sind zurück.');
    } else {
      const uebersprungen =
        verlauf.uebersprungen > 0 ? ` (${verlauf.uebersprungen} unlesbar übersprungen)` : '';
      toast.success(`${verlauf.zurueckgeholt} Nachrichten zurückgeholt${uebersprungen}.`);
    }
    void ladeStatus();
  }
</script>

<section class="space-y-4" data-testid="wiederherstellung-block">
  <div>
    <h3 class="text-base font-semibold">{m.wiederherstellung_titel()}</h3>
    <p class="text-sm text-muted-foreground">{m.wiederherstellung_beschreibung()}</p>
  </div>

  <Alert.Root data-testid="wiederherstellung-wahrheiten">
    <KeyRoundIcon />
    <Alert.Description class="space-y-1">
      <p>{m.wiederherstellung_wahrheit_endgueltig()}</p>
      <p>{m.wiederherstellung_wahrheit_ordner()}</p>
      <p>{m.wiederherstellung_wahrheit_oauth()}</p>
    </Alert.Description>
  </Alert.Root>

  {#if zustand === 'vorhanden' && zuletztAktualisiert}
    <p class="text-text-muted text-xs" data-testid="wiederherstellung-stand">
      {m.wiederherstellung_stand({ datum: new Date(zuletztAktualisiert).toLocaleDateString() })}
    </p>
  {/if}

  <div class="flex flex-wrap gap-2">
    <Button onclick={starteErzeugen} disabled={busy} data-testid="wiederherstellung-erzeugen-knopf">
      {zustand === 'vorhanden' ? m.wiederherstellung_erneuern_knopf() : m.wiederherstellung_einrichten_knopf()}
    </Button>
    <Button
      variant="secondary"
      onclick={() => (einloesenOffen = true)}
      disabled={busy}
      data-testid="wiederherstellung-einloesen-knopf"
    >
      {m.wiederherstellung_einloesen_knopf()}
    </Button>
  </div>
</section>

<Dialog.Root bind:open={erzeugenOffen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content
      data-testid="wiederherstellung-erzeugen-dialog"
      class="max-w-md"
      showCloseButton={false}
      escapeKeydownBehavior="ignore"
      interactOutsideBehavior="ignore"
    >
      <Dialog.Header>
        <Dialog.Title>{m.wiederherstellung_code_titel()}</Dialog.Title>
      </Dialog.Header>
      {#if neuerCode}
        <WiederherstellungCodeZeigen code={neuerCode} onFertig={erzeugenFertig} />
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<WiederherstellungEinloesen bind:open={einloesenOffen} onWiederhergestellt={wiederhergestellt} />
