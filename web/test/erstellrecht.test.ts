import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { darfCommunityAnlegen, type Eingaben } from '../src/lib/servers/erstellrecht.ts';

const selfhost: Eingaben = {
  istCloud: false,
  cloudAdmin: false,
  rolleLautCloud: null,
  adminLautServer: null,
  offenFuerAlle: false,
};

describe('Self-Host: der Server hat schon geantwortet', () => {
  it('sagt er Admin, darf man', () => {
    assert.equal(darfCommunityAnlegen({ ...selfhost, adminLautServer: true }), true);
  });

  it('sagt er NEIN, gilt das — auch gegen die Cloud-Rolle', () => {
    // Er entscheidet die Anfrage ohnehin. Ein Knopf, der in einen 403 laeuft,
    // waere schlechter als keiner; fuer diesen Fall gibt es die
    // Erreichbarkeitspruefung, die ihn benennt.
    assert.equal(
      darfCommunityAnlegen({ ...selfhost, adminLautServer: false, rolleLautCloud: 'owner' }),
      false,
    );
  });
});

describe('Self-Host: der Server hat noch nichts gesagt', () => {
  it('der Betreiber darf — DAS ist der Fall vom 2026-08-27', () => {
    // Ohne Verbindung kein ready-Rahmen, also kein `is_admin`. Vorher fiel das
    // auf `false` und der Betreiber sah auf seinem eigenen frischen Server
    // keinen Weg, eine Community anzulegen.
    assert.equal(darfCommunityAnlegen({ ...selfhost, rolleLautCloud: 'owner' }), true);
  });

  it('ein blosses Mitglied darf nicht', () => {
    assert.equal(darfCommunityAnlegen({ ...selfhost, rolleLautCloud: 'member' }), false);
  });

  it('ohne jede Angabe darf man nicht', () => {
    assert.equal(darfCommunityAnlegen(selfhost), false);
  });

  it('null und false sind NICHT dasselbe', () => {
    // Die Unterscheidung ist der ganze Punkt: „noch nicht gefragt" las sich
    // vorher wie „nein".
    const unbekannt = { ...selfhost, rolleLautCloud: 'owner' as const, adminLautServer: null };
    const verneint = { ...unbekannt, adminLautServer: false };
    assert.notEqual(darfCommunityAnlegen(unbekannt), darfCommunityAnlegen(verneint));
  });
});

describe('Ein offener Server lässt jeden anlegen', () => {
  it('auch ohne Rolle und ohne Antwort', () => {
    assert.equal(darfCommunityAnlegen({ ...selfhost, offenFuerAlle: true }), true);
  });

  it('aber nicht gegen ein Nein des Servers... doch: die Freigabe gilt für alle', () => {
    // `allow_guild_creation` heisst woertlich „jeder darf" — ein Nicht-Admin
    // ist genau der Fall, fuer den die Freigabe existiert.
    assert.equal(
      darfCommunityAnlegen({ ...selfhost, adminLautServer: false, offenFuerAlle: true }),
      true,
    );
  });
});

describe('Cloud', () => {
  const cloud: Eingaben = { ...selfhost, istCloud: true };

  it('Plattform-Admin darf', () => {
    assert.equal(darfCommunityAnlegen({ ...cloud, cloudAdmin: true }), true);
  });

  it('gewoehnlicher Nutzer nur bei offener Freigabe', () => {
    assert.equal(darfCommunityAnlegen(cloud), false);
    assert.equal(darfCommunityAnlegen({ ...cloud, offenFuerAlle: true }), true);
  });

  it('die Self-Host-Rolle zaehlt auf der Cloud NICHT', () => {
    // Sonst machte ein „owner" auf irgendeinem eigenen Server den Nutzer auch
    // auf der Cloud zum Anleger.
    assert.equal(darfCommunityAnlegen({ ...cloud, rolleLautCloud: 'owner' }), false);
  });

  it('und das Cloud-Flag zaehlt auf einem Self-Host nicht', () => {
    // Die Gegenprobe: `auth.user.is_admin` ist das Plattform-Flag der Cloud.
    // Wer es dort liest, machte jeden Cloud-Admin zum Admin auf jedem fremden
    // Server (dieselbe Falle wie beim `admin`-Claim im Cert, CLAUDE.md).
    assert.equal(darfCommunityAnlegen({ ...selfhost, cloudAdmin: true }), false);
  });
});
