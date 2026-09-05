import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Der Stummeintrag eines Gastes kommt als ganz normaler ``user_states``-Eintrag
// beim Klienten an (der Server schreibt ihn vor dem Versand in dieselbe Map).
// Die Gästereihe in der Kanalliste muss ihn lesen — sonst bleibt das
// Stumm-Zeichen dauerhaft weg, denn Gäste haben keinen zweiten Zustands-Weg.
//
// Die Gästereihe lebt in einer .svelte-Komponente, der Zustand in einem
// .svelte.ts-Store (Runes) — beides ist im Node-Runner nicht importierbar
// (``pnpm test:unit``-Falle, s. CLAUDE.md). Deshalb hier die Quellsicherung,
// wie sonst bei ``selfhost-einstieg-gating``.

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const REIHE = readFileSync(
	join(WURZEL, 'src/lib/components/VoiceChannelMembers.svelte'),
	'utf8'
).replace(/<!--[\s\S]*?-->/g, '');

test('die Gästereihe liest den Stumm-Zustand aus user_states', () => {
	assert.match(
		REIHE,
		/userStates\[gid\]/,
		'Die Gästereihe liest userStates[gid] nicht mehr — das Stumm-Zeichen ' +
			'für Gäste ist damit weg (Gäste haben keine zweite Zustandsquelle).'
	);
	assert.match(
		REIHE,
		/gastState\?\.mic_muted[\s\S]{0,200}VoiceMuteIcon/s,
		'Das Mikrofon-Stumm-Zeichen wird in der Gästereihe nicht mehr gerendert.'
	);
});

test('das Abzeichen steht VOR dem Namen, es gibt keinen Kreis davor', () => {
	// „Gast" beantwortet, wer hier spricht — der Name ist selbst getippt und
	// von niemandem geprüft, das muss man sehen, BEVOR man den Namen liest.
	const abzeichen = REIHE.indexOf('gast_abzeichen()');
	const name = REIHE.indexOf('{gastName}');
	assert.ok(abzeichen !== -1 && name !== -1, 'Abzeichen oder Name fehlen.');
	assert.ok(
		abzeichen < name,
		'Das Abzeichen steht nicht mehr vor dem Namen.'
	);
	// Kein runder Avatar-Ersatz (vorher: festes „G" bzw. Namens-Initiale).
	assert.ok(!/size-7[^"]*rounded-full/.test(REIHE), 'Der Kreis ist zurück.');
	assert.ok(!REIHE.includes('gastInitial'), 'Das Kürzel ist zurück.');
});

test('die Gast-Pille ist auffällig (Bernstein), nicht grau', () => {
	assert.match(
		REIHE,
		/amber-500/,
		'Die Pille fällt nicht mehr auf — Bernstein wurde durch Grau ersetzt.'
	);
});
