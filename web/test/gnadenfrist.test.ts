/**
 * Die Gnadenfrist nach einem Verbindungsabriss darf eine Sitzung nicht mehr
 * sofort beenden — und muss trotzdem enden, wenn niemand mehr wiederkommt.
 *
 * **Warum es diesen Test gibt.** Bis zum 2026-08-19 beendete
 * `wachten.ts::verbindungsWacht` eine laufende Fernsteuer-Sitzung, sobald ihr
 * Socket abriss — sofort, ohne Ausnahme. Auf dem gemeinsamen Remote-Dev-Stack
 * (Electron → lokales Vite → Internet → Hetzner) passierte das alle paar
 * Minuten, unabhängig vom eigentlichen Fehlerbild: ein Backend-Sync auf dem
 * Stack lädt `uvicorn --reload` neu und trennt dabei jeden angeschlossenen
 * Socket, gemessen bis zu 8 s. Eine echte, funktionierende Sitzung starb daran
 * nach 37 Sekunden.
 *
 * Geprüft wird [`Gnadenfrist`] — die Zeitrechnung hinter der Ausnahme — und
 * nicht `wachten.ts` selbst: das importiert `$lib/ws/connection` und ist damit
 * für Nodes Testläufer (erweiterungslose Laufzeit-Importe) unerreichbar.
 * Gleiches Muster wie `vorrang-takt.test.ts` für `VorrangBuch`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CLIENT_GRACE_MS, Gnadenfrist, SERVER_GRACE_S } from '../src/lib/remote/gnadenfrist.ts';

describe('Gnadenfrist', () => {
  it('läuft erst nach der eingestellten Frist ab, nicht früher', () => {
    const g = new Gnadenfrist();
    g.verloren(1_000, 5_000);
    assert.equal(g.abgelaufen(5_999), false);
    assert.equal(g.abgelaufen(6_000), true);
  });

  it('ohne einen Verlust ist nichts abgelaufen und nichts aktiv', () => {
    const g = new Gnadenfrist();
    assert.equal(g.aktiv, false);
    assert.equal(g.abgelaufen(999_999), false);
  });

  it('ein rechtzeitiges Wiederherstellen löscht die Frist', () => {
    const g = new Gnadenfrist();
    const gen = g.verloren(1_000, 5_000);
    g.wiederhergestellt(gen);
    assert.equal(g.aktiv, false);
    assert.equal(g.abgelaufen(999_999), false);
  });

  it('ein wiederholter Abriss VERLÄNGERT die Frist, statt die alte auslaufen zu lassen', () => {
    // Flatternde Verbindung: zweiter Abriss kurz nach dem ersten, bevor die
    // erste Frist abgelaufen ist. Sie muss von JETZT an neu laufen, sonst
    // bekäme eine flatternde Verbindung eine SCHRUMPFENDE Gnadenfrist statt
    // bei jedem Versuch die volle.
    const g = new Gnadenfrist();
    g.verloren(1_000, 5_000); // liefe bis 6_000 ab
    g.verloren(4_000, 5_000); // jetzt bis 9_000
    assert.equal(g.abgelaufen(6_500), false, 'die erste, kürzere Frist darf nicht mehr gelten');
    assert.equal(g.abgelaufen(8_999), false);
    assert.equal(g.abgelaufen(9_000), true);
  });

  it('ein spätes Wiederherstellen einer ÜBERHOLTEN Generation zählt nicht', () => {
    // Zwei Reconnect-Versuche liegen in der Luft (etwa: die WS reconnectet,
    // reisst sofort wieder ab, reconnectet erneut) — die ANTWORT auf den
    // ERSTEN darf die Frist des ZWEITEN, gerade laufenden Abrisses nicht
    // löschen. Sonst überlebt die Sitzung eine Frist, die serverseitig
    // längst abgelaufen sein könnte.
    const g = new Gnadenfrist();
    const ersteGeneration = g.verloren(1_000, 5_000);
    g.verloren(2_000, 5_000); // zweiter, aktueller Abriss — läuft bis 7_000
    g.wiederhergestellt(ersteGeneration); // spätes Echo des ERSTEN Versuchs
    assert.equal(g.aktiv, true, 'die Frist des zweiten Abrisses muss weiterlaufen');
    assert.equal(g.abgelaufen(7_000), true);
  });

  it('ein Wiederherstellen der AKTUELLEN Generation löscht auch nach mehreren Abrissen', () => {
    const g = new Gnadenfrist();
    g.verloren(1_000, 5_000);
    const aktuelleGeneration = g.verloren(2_000, 5_000);
    g.wiederhergestellt(aktuelleGeneration);
    assert.equal(g.aktiv, false);
  });
});

describe('Client- und Server-Frist bleiben zueinander passend', () => {
  it('die Client-Frist hat Vorsprung vor der Server-Frist, nicht umgekehrt', () => {
    // Gibt der Client ZUERST auf, hätte der Server einen Reconnect vielleicht
    // noch angenommen — die Sitzung stürbe trotzdem, nur später als heute.
    assert.ok(
      CLIENT_GRACE_MS > SERVER_GRACE_S * 1000,
      `CLIENT_GRACE_MS (${CLIENT_GRACE_MS}ms) muss über SERVER_GRACE_S (${SERVER_GRACE_S}s) liegen`,
    );
  });

  it('SERVER_GRACE_S hier stimmt mit der tatsächlichen Zahl im Backend überein', () => {
    // `remote_reconnect_registry.py` ist Python — hier wird nur der
    // dokumentierte Vorgabewert im Quelltext abgeglichen, damit ein
    // Verstellen der einen Zahl ohne die andere auffällt.
    const hier = dirname(fileURLToPath(import.meta.url)); // .../web/test
    const pfad = join(
      hier,
      '..',
      '..',
      'services',
      'chat-gateway',
      'src',
      'dcc_chat_gateway',
      'remote_reconnect_registry.py',
    );
    const quelle = readFileSync(pfad, 'utf8');
    const treffer = quelle.match(/REMOTE_DISCONNECT_GRACE_S\s*=\s*float\(os\.environ\.get\("REMOTE_DISCONNECT_GRACE_S",\s*"(\d+)"\)\)/);
    assert.ok(treffer, 'REMOTE_DISCONNECT_GRACE_S-Vorgabe in remote_reconnect_registry.py nicht gefunden — Test mitziehen');
    assert.equal(Number(treffer[1]), SERVER_GRACE_S);
  });
});
