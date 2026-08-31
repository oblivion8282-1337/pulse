<script lang="ts">
  /**
   * Die Wiederherstellungs-Richtung der Sicherung — Container aus dem
   * Laufwerk lesen und in den lokalen Verlauf ablegen. Bewusst ohne Auto-
   * Start: Wiederherstellen ist eine Entscheidung des Nutzers, kein
   * Nebenprogramm.
   */
  import { Button } from '$lib/components/ui/button/index.js';
  import { leseSicherung } from '$lib/sicherung/wiederherstellen';
  import { adapterLieferant } from '$lib/sicherung/geraete';
  import { zuSatz } from '$lib/verlauf/satz';
  import { verlaufPutSaetze } from '$lib/verlauf/db';
  import { aktuellesKonto } from '$lib/verlauf/konto';

  const { aufFertig } = $props<{ aufFertig: (anzahl: number) => void }>();

  let passwort = $state('');
  let meldung = $state('');
  let laeuft = $state(false);

  async function wiederherstellen(): Promise<void> {
    if (!passwort || laeuft) return;
    laeuft = true;
    meldung = '';
    try {
      const adapter = await adapterLieferant();
      const bestand = await leseSicherung(adapter, passwort);
      const kontoId = aktuellesKonto();
      let anzahl = 0;
      const saetze = [];
      for (const eintrag of bestand.eintraege) {
        if (!kontoId) break;
        const n = eintrag.nachricht;
        const satz = zuSatz(eintrag.kanalId, {
          id: n.id,
          author_id: n.autor,
          content: n.inhalt,
          created_at: n.zeit,
          edited_at: n.bearbeitet,
          reply_to_id: n.antwortAuf,
          attachments: n.anhaenge.map((a) => ({
            id: a.id,
            filename: a.name,
            mime: a.mime,
            size: a.groesse,
          })),
        }, kontoId);
        if (satz) {
          saetze.push(satz);
          anzahl += 1;
        }
      }
      await verlaufPutSaetze(saetze);
      meldung = bestand.lücken.length > 0
        ? `${anzahl} wiederhergestellt, ${bestand.lücken.length} unlesbare Stellen übersprungen.`
        : `${anzahl} Nachrichten wiederhergestellt.`;
      passwort = '';
      aufFertig(anzahl);
    } catch (e) {
      meldung = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }
</script>

<div class="space-y-2">
  <p class="text-sm text-muted-foreground">
    Verlauf aus dem Laufwerk wiederherstellen. Nachrichten, die dieses Gerät
    schon hat, bleiben unangetastet.
  </p>
  <input
    class="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm"
    type="password"
    placeholder="Sicherungs-Passwort"
    bind:value={passwort}
  />
  {#if meldung}<p class="text-sm text-muted-foreground">{meldung}</p>{/if}
  <Button onclick={wiederherstellen} variant="secondary" size="sm" disabled={laeuft || !passwort}>
    {laeuft ? 'Lese …' : 'Wiederherstellen'}
  </Button>
</div>
