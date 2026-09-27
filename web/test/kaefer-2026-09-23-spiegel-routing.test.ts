/**
 * Kaefer-Nachmittag 2026-09-23 — die beiden Nebbenbefunde aus Michaels
 * Konsolen-Log, gesichert gegen stillen Verfall (Quelltext-Pruefung nach
 * Haus-Stil: der Laufzeit-Importkegel von WASM/IDB/.svelte-Modulen ist in
 * Nodes Testlaeufer nicht erreichbar, s. krypto-empfangen-schonabgelegt).
 *
 * Befund 1 — Gilden-Anfragen auf dem falschen Server: Plugin- und
 * Rechte-Abrufe fuer eine Community eines ANDEREN Servers liefen auf den
 * AKTIVEN Server (403 „not a member" / 404, beide Richtungen beobachtet).
 * Ausloeser sind alle direkten Sprünge, die den GuildRail-Klick umgehen:
 * Mitteilungs-Klick, Deep-Link, Reload, Mitgliederlisten-Spruenge.
 *
 * Befund 2 — Postfach-Spam: eine dauerhaft unlesbare Zustellung warnte
 * JEDEM Zyklus (20+ „Umschlag nicht zu oeffnen" pro Minute), und weil
 * der Kaefber-Ring nur console.error faengt, war der Fehler fuer keinen
 * Diagnosebericht sichtbar.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const lese = (...p: string[]): string => readFileSync(join(HIER, '../src/lib', ...p), 'utf8');

const serverGuildsQuelle = lese('stores/serverGuilds.svelte.ts');
const layoutQuelle = readFileSync(join(HIER, '../src/routes/app/+layout.svelte'), 'utf8');
const channelListQuelle = lese('components/ChannelList.svelte');
const pluginApiQuelle = lese('api/guild-plugins.ts');
const permissionsStoreQuelle = lese('stores/channelPermissions.svelte.ts');
const oeffnenQuelle = lese('krypto/zustellungOeffnen.ts');

describe('Gilden-Anfragen erreichen den Server, dem die Community gehoert', () => {
  it('serverGuilds loest die Server-ID einer Community auf', () => {
    assert.match(serverGuildsQuelle, /serverIdForGuild/);
  });

  it('das App-Layout richtet den aktiven Server je Community-Betreten aus', () => {
    // Guard existiert und benutzt den Resolver …
    assert.match(layoutQuelle, /serverGuilds\.serverIdForGuild\(gid\)/);
    assert.match(layoutQuelle, /activeServer\.set\(serverId\)/);
    // … aber nur EINMAL je Community (ausgerichteteGilde): ein absichtlicher
    // Server-Wechsel per Server-Kopf-Klick (activeServer.set OHNE Navigation)
    // darf nicht sofort wieder zurueckgerungen werden.
    assert.match(layoutQuelle, /ausgerichteteGilde/);
    assert.match(layoutQuelle, /gid === ausgerichteteGilde/);
  });

  it('Plugin-Abruf traegt die Server-Route, ChannelList loest sie reaktiv auf', () => {
    assert.match(pluginApiQuelle, /list\(guildId: string, route: RequestRoute = \{\}\)/);
    assert.match(channelListQuelle, /serverGuilds\.serverIdForGuild\(gid\)/);
    assert.match(channelListQuelle, /ensureGuildPluginsLoaded\(gid, sid\)/);
  });

  it('Kanal-Rechte-Abruf nimmt die Server-ID an', () => {
    assert.match(
      permissionsStoreQuelle,
      /ensure\(channelId: string, serverId\?: string\): Promise<Overwrite\[\]>/
    );
    assert.match(permissionsStoreQuelle, /\.list\(channelId, serverId \? \{ serverId \} : \{\}\)/);
  });
});

describe('unlesbare Postfach-Zustellungen spammen nicht und landen im Kaefber-Ring', () => {
  it('zaehlt Fehlversuche dauerhaft (localStorage) und meldet nur den ersten', () => {
    assert.match(oeffnenQuelle, /function versuchZaehlen/);
    assert.match(oeffnenQuelle, /localStorage/);
    assert.match(oeffnenQuelle, /if \(versuch === 1\)/);
  });

  it('beide Fehlpfade speisen den Diagnose-Ring (console.warn wird nicht gefangen)', () => {
    assert.match(oeffnenQuelle, /melde\('postfach', 'umschlag_unlesbar'/);
    assert.match(oeffnenQuelle, /melde\('postfach', 'umschlag_ohne_sitzung'/);
  });

  it('gibt die Zustellung NICHT nach N Versuchen auf (kein Datenverlust nach Zeitplan)', () => {
    // Es darf keinen Aufgabe-/Quittierungspfad am Zaehler geben — bewusstes
    // Design: ob ein Umschlag spaeter doch noch oeffnbar ist, entscheidet
    // der Krypto-Kern, nicht ein Zaehler.
    assert.doesNotMatch(oeffnenQuelle, /versuch >= \d+/);
    assert.doesNotMatch(oeffnenQuelle, /versuch > \d+/);
  });
});
