/**
 * Was die Gegenseite über EIGENE Nachrichten zurückmeldet — der Stoff der
 * Häkchen-Treppe (`nachrichten/haekchen.ts`). Zwei Karten, beide
 * Kanal → Konto → kanonische Nachrichten-ID:
 *
 *  - `gelesen`: bis wohin ein Konto gelesen hat (DM: die Gegenstelle;
 *    Gruppe: jedes Mitglied, auch man selbst — die Treppe fragt nur fremde).
 *  - `zugestellt`: bis wohin MEINE Nachrichten bei einem Konto angekommen
 *    sind (doppelt grau).
 *
 * Nur im Arbeitsspeicher, aber nicht mehr flüchtig: der Server hält beide
 * Stände (Migration 0101) und liefert sie im `ready`-Rahmen bzw. in
 * `GET /gruppen` nach; die Ereignisse `dm_lesestand`, `gruppe_lesestand` und
 * `zustellung_bestaetigt` ziehen live nach. Alles nur vorwärts.
 *
 * Geleert wird über `readState` (`clear`/`resetCacheOnly`/`forgetChannel`) —
 * dieselben Pfade wie bisher, als die Karten dort lagen.
 */
import { vorwaertsMerge } from '$lib/stores/lesestandKern';
import type { PrivateGruppe } from '$lib/api/gruppen';

type Karte = Record<string, Record<string, string>>;

function eintragen(karte: Karte, kanal: string, konto: string, bis: string): Karte {
  const jeKanal = karte[kanal] ?? {};
  const neu = vorwaertsMerge(jeKanal[konto], bis);
  if (neu === jeKanal[konto]) return karte;
  return { ...karte, [kanal]: { ...jeKanal, [konto]: neu } };
}

class Quittungen {
  gelesen = $state<Karte>({});
  zugestellt = $state<Karte>({});

  gelesenMelden(kanal: string, konto: string, bis: string): void {
    this.gelesen = eintragen(this.gelesen, kanal, konto, bis);
  }

  zugestelltMelden(kanal: string, konto: string, bis: string): void {
    this.zugestellt = eintragen(this.zugestellt, kanal, konto, bis);
  }

  gelesenVon(kanal: string, konto: string): string | undefined {
    return this.gelesen[kanal]?.[konto];
  }

  zugestelltBei(kanal: string, konto: string): string | undefined {
    return this.zugestellt[kanal]?.[konto];
  }

  /** Stände aus `GET /gruppen` übernehmen (Mutations-Antworten tragen keine,
   *  dann bleibt alles, wie es ist). */
  gruppeSeeden(gruppe: PrivateGruppe): void {
    for (const m of gruppe.members) {
      if (m.gelesen_bis) this.gelesenMelden(gruppe.id, m.user_id, m.gelesen_bis);
      if (m.zugestellt_bis) this.zugestelltMelden(gruppe.id, m.user_id, m.zugestellt_bis);
    }
  }

  kanalVergessen(kanal: string): void {
    if (kanal in this.gelesen) {
      const { [kanal]: _weg, ...rest } = this.gelesen;
      this.gelesen = rest;
    }
    if (kanal in this.zugestellt) {
      const { [kanal]: _weg, ...rest } = this.zugestellt;
      this.zugestellt = rest;
    }
  }

  clear(): void {
    this.gelesen = {};
    this.zugestellt = {};
  }
}

export const quittungen = new Quittungen();
