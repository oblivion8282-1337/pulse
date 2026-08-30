<script lang="ts">
	/**
	 * Dev-Probe für die Ablage — sichtbar NUR im Dev-Server (oder wenn
	 * ABLAGE_KANAL_ENABLED einmal angeschaltet wird); im ausgelieferten
	 * Build rendert diese Seite nichts. Sie existiert, damit man den
	 * Sync-Ordner-Weg ohne jede Anbieter-Registrierung anfassen kann:
	 * Ordner wählen — am besten einen leeren Unterordner im eigenen
	 * OneDrive — und der installierte Sync-Client trägt die Dateien in die
	 * Cloud. Kein Token, kein Konsent, kein Portal.
	 */
	import { syncOrdnerMoeglich, adapterAusVerzeichnis, type AblageVerzeichnis } from '$lib/ablage/syncOrdner';
	import { AblageSchreiber } from '$lib/ablage/schreiber';
	import { leseVerlauf } from '$lib/ablage/leser';
	import { nachziehen } from '$lib/ablage/nachzieher';
	import { kodiereNachricht, leseNachricht } from '$lib/ablage/nutzlast';
	import { ABLAGE_KANAL_ENABLED } from '$lib/featureFlags';

	const sichtbar = import.meta.env.DEV || ABLAGE_KANAL_ENABLED;

	let ordnerName: string | null = $state(null);
	let adapter: ReturnType<typeof adapterAusVerzeichnis> | null = $state(null);
	let schreiber: AblageSchreiber | null = $state(null);
	let laeuft = $state(false);
	let zeilen: string[] = $state([]);

function note(zeile: string): void {
		zeilen = [...zeilen, `${new Date().toLocaleTimeString()} — ${zeile}`];
	}

	async function ordnerWaehlen(): Promise<void> {
		try {
			const wahl = (window as unknown as {
				showDirectoryPicker?: (o?: { mode?: string }) => Promise<AblageVerzeichnis>;
			}).showDirectoryPicker;
			if (wahl === undefined) {
				note('Dieser Browser kann keine Ordner wählen — Chrome, Edge oder die Desktop-App nehmen.');
				return;
			}
			const verzeichnis: AblageVerzeichnis = await wahl({ mode: 'readwrite' });
			adapter = adapterAusVerzeichnis(verzeichnis);
			schreiber = null;
			ordnerName = (verzeichnis as unknown as { name?: string }).name ?? 'gewählter Ordner';
			note(`Ordner „${ordnerName}" gewählt. Schreiben mit Knopf drücken.`);
		} catch (fehler) {
			if (!(fehler instanceof DOMException && fehler.name === 'AbortError')) {
				note(`Ordnerwahl gescheitert: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
			}
		}
	}

	async function schreiben(): Promise<void> {
		if (adapter === null || laeuft) {
			return;
		}
		laeuft = true;
		try {
			schreiber ??= new AblageSchreiber(adapter, 'probe', 1500);
			const stempel = Date.now();
			const eintraege = Array.from({ length: 30 }, (_, i) => {
				const id = BigInt(stempel + i);
				return {
					id,
					nutzlast: kodiereNachricht({
						fassung: 1,
						id: id.toString(),
						autor: 'probe',
						inhalt: `Probe ${stempel} #${i}`,
						zeit: new Date().toISOString(),
						bearbeitet: null,
						antwortAuf: null,
						anhaenge: [],
					}),
					typ: 1,
				};
			});
			const bericht = await nachziehen(schreiber, { async holen(nachId, limit) {
				const bei = nachId === null ? 0 : eintraege.findIndex((e) => e.id > nachId);
				const ab = Math.max(bei, 0);
				return eintraege.slice(ab, ab + limit);
			} }, { limit: 10 });
			note(`${bericht.festigt} Nachrichten festigt — ${schreiber.stand()?.segmente.length ?? 0} Segmente, letzte Id ${schreiber.stand()?.letzteId ?? '—'}. Der Sync-Client trägt sie jetzt hoch.`);
		} finally {
			laeuft = false;
		}
	}

	async function lesen(): Promise<void> {
		if (adapter === null || laeuft) {
			return;
		}
		laeuft = true;
		try {
			const verlauf = await leseVerlauf(adapter);
			note(`Verlauf: ${verlauf.rahmen.length} Rahmen${verlauf.luecken.length > 0 ? `, LÜCKEN: ${verlauf.luecken.join('; ')}` : ', keine Lücken'}`);
			if (verlauf.rahmen.length > 0) {
				const erste = leseNachricht(verlauf.rahmen[0].nutzlast);
				const letzte = leseNachricht(verlauf.rahmen[verlauf.rahmen.length - 1].nutzlast);
				note(`Erste: „${erste.inhalt}" — Letzte: „${letzte.inhalt}"`);
			}
			const liste = await adapter.liste();
			note(`Dateien im Ordner: ${liste.length} (${liste.slice(0, 4).join(', ')}${liste.length > 4 ? ', …' : ''})`);
		} finally {
			laeuft = false;
		}
	}
</script>

<svelte:head><title>Ablage-Probe</title></svelte:head>

{#if sichtbar}
	<div class="probe">
		<h1>Ablage-Probe</h1>
		<p>
			Ordner wählen — am besten einen <strong>leeren Unterordner in deinem OneDrive</strong>
			(z.&nbsp;B. <code>OneDrive/Pulse-Probe</code>). Die Dateien, die hier entstehen, trägt
			dein normaler OneDrive-Client in deine Cloud. Kein Token, kein Portal.
		</p>
		<div class="aktionen">
			<button onclick={ordnerWaehlen}>{ordnerName === null ? '1 · Ordner wählen' : `Ordner: ${ordnerName}`}</button>
			<button onclick={schreiben} disabled={adapter === null || laeuft}>2 · 30 Nachrichten festigen</button>
			<button onclick={lesen} disabled={adapter === null || laeuft}>3 · Verlauf zurücklesen</button>
		</div>
		{#if !syncOrdnerMoeglich()}
			<p class="warn">Dieser Browser kann keine Ordner wählen — Chrome, Edge oder die Desktop-App nehmen.</p>
		{/if}
		<ul>
			{#each zeilen as zeile, i (i + zeile)}
				<li><code>{zeile}</code></li>
			{/each}
		</ul>
	</div>
{:else}
	<h1>404</h1>
{/if}

<style>
	.probe {
		max-width: 46rem;
		margin: 3rem auto;
		padding: 0 1.25rem;
	}
	.aktionen {
		display: flex;
		gap: 0.75rem;
		margin: 1.25rem 0;
		flex-wrap: wrap;
	}
	.warn {
		color: #a33;
	}
	ul {
		list-style: none;
		padding: 0;
		font-size: 0.875rem;
		line-height: 1.7;
	}
</style>
