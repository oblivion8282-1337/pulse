/**
 * Der Entwurf der Kanalrechte — was der Bearbeiter gesetzt, aber noch nicht
 * gespeichert hat.
 *
 * **Nur Abweichungen liegen hier.** Ein Ziel ohne Eintrag folgt dem Server;
 * `stand()` fällt dann auf den gespeicherten Wert zurück. Das ersetzt die
 * frühere „einmal einsäen"-Mechanik samt Merkliste bereits eingesäter Zeilen
 * und löst nebenbei deren Zielkonflikt: kommt über den WS eine fremde Änderung,
 * zieht jede unberührte Zeile sofort mit, nur die selbst angefassten bleiben
 * stehen.
 *
 * **Gespeichert wird über alle Ziele auf einmal.** Wer einen Kanal exklusiv
 * macht, ändert zwei Ziele in einem Gedanken (Rolle erlauben, @everyone
 * entziehen); zwei getrennte Speicherknöpfe hätten dazwischen einen Zustand
 * hinterlassen, in dem niemand mehr hineinsieht.
 *
 * Der Server bleibt die Wahrheit: er prüft Anti-Eskalation selbst
 * (`assert_overwrite_within_editor_scope`), die Sperren in der Ansicht sind
 * Rückmeldung, keine Sicherung.
 */

import { overwritesApi, type Overwrite } from '$lib/api/roles';
import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
import { Perm, has, toBitfield, type Permission } from './bitfield';
import { teileSchluessel, zielSchluessel } from './schnappschuesse';

export type Zustand = 'allow' | 'neutral' | 'deny';
export type Paar = { allow: bigint; deny: bigint };

const LEER: Paar = { allow: 0n, deny: 0n };

/** Eine Überschreibung in den Zwischenspeicher legen, damit die Liste sofort
 *  neu zeichnet — ohne das ändert sie sich erst mit dem WS-Ereignis. */
function inZwischenspeicher(channelId: string, ow: Overwrite): void {
  const bestand = channelPermissions.byChannel[channelId] ?? [];
  const key = zielSchluessel(ow);
  const vorhanden = bestand.some((c) => zielSchluessel(c) === key);
  channelPermissions.apply(
    channelId,
    vorhanden ? bestand.map((c) => (zielSchluessel(c) === key ? ow : c)) : [...bestand, ow]
  );
}

export class KanalEntwurf {
  #channelId: () => string;
  /** `<art>:<id>` → gewünschter Stand. Nur angefasste Ziele stehen hier. */
  aenderungen = $state<Record<string, Paar>>({});
  speichert = $state(false);

  constructor(channelId: () => string) {
    this.#channelId = channelId;
  }

  /** Serverstand eines Ziels. */
  gespeichert(key: string): Paar {
    const bestand = channelPermissions.byChannel[this.#channelId()] ?? [];
    const ow = bestand.find((c) => zielSchluessel(c) === key);
    return ow ? { allow: toBitfield(ow.allow), deny: toBitfield(ow.deny) } : LEER;
  }

  /** Was der Bearbeiter gerade sieht — Entwurf, sonst Serverstand. */
  stand(key: string): Paar {
    return this.aenderungen[key] ?? this.gespeichert(key);
  }

  zustand(key: string, perm: Permission): Zustand {
    const p = this.stand(key);
    if (has(p.allow, perm)) return 'allow';
    if (has(p.deny, perm)) return 'deny';
    return 'neutral';
  }

  setze(key: string, perm: Permission, zu: Zustand): void {
    const p = this.stand(key);
    const allow = (p.allow & ~perm) | (zu === 'allow' ? perm : 0n);
    const deny = (p.deny & ~perm) | (zu === 'deny' ? perm : 0n);
    this.aenderungen = { ...this.aenderungen, [key]: { allow, deny } };
  }

  /** Wie viele der gezeigten Rechte weichen beim Ziel vom Serverstand ab. */
  offen(key: string, rechte: readonly Permission[]): number {
    const entwurf = this.aenderungen[key];
    if (!entwurf) return 0;
    const alt = this.gespeichert(key);
    let zahl = 0;
    for (const perm of rechte) {
      const gleich =
        has(entwurf.allow, perm) === has(alt.allow, perm) &&
        has(entwurf.deny, perm) === has(alt.deny, perm);
      if (!gleich) zahl += 1;
    }
    return zahl;
  }

  /** Offene Änderungen über alle Ziele — die Zahl in der Leiste unten. */
  offenGesamt(rechte: readonly Permission[]): number {
    let zahl = 0;
    for (const key of Object.keys(this.aenderungen)) zahl += this.offen(key, rechte);
    return zahl;
  }

  /** Gesetzte Abweichungen eines Ziels — die Zahl neben dem Namen links. */
  gesetzte(key: string, rechte: readonly Permission[]): number {
    const p = this.stand(key);
    return rechte.filter((perm) => has(p.allow, perm) || has(p.deny, perm)).length;
  }

  verwirf(): void {
    this.aenderungen = {};
  }

  /**
   * Alle offenen Ziele schreiben. Nacheinander statt parallel: der Server
   * schickt nach jedem Schreiben eine neue Liste, und zwei gleichzeitige
   * Antworten überholen sich.
   */
  async speichern(rechte: readonly Permission[]): Promise<void> {
    const channelId = this.#channelId();
    const offene = Object.keys(this.aenderungen).filter((k) => this.offen(k, rechte) > 0);
    if (offene.length === 0) return;
    this.speichert = true;
    try {
      for (const key of offene) {
        const { art, id } = teileSchluessel(key);
        const p = this.aenderungen[key];
        const gespeichert = await overwritesApi.set(channelId, art, id, {
          allow: p.allow.toString(),
          deny: p.deny.toString()
        });
        inZwischenspeicher(channelId, gespeichert);
      }
      this.verwirf();
    } finally {
      this.speichert = false;
    }
  }

  /** Ganze Abweichung entfernen — das Ziel folgt danach wieder den Rollen. */
  async loesche(key: string): Promise<void> {
    const channelId = this.#channelId();
    const { art, id } = teileSchluessel(key);
    await overwritesApi.delete(channelId, art, id);
    channelPermissions.apply(
      channelId,
      (channelPermissions.byChannel[channelId] ?? []).filter((ow) => zielSchluessel(ow) !== key)
    );
    if (this.aenderungen[key]) {
      const rest = { ...this.aenderungen };
      delete rest[key];
      this.aenderungen = rest;
    }
  }

  /**
   * „Kanal nur für diese Rolle" — die Rolle darf sehen, @everyone nicht mehr.
   * Landet als Entwurf, nicht als Schreibvorgang: sonst wäre der Kanal
   * geschlossen, bevor der Bearbeiter die restlichen Zeilen gesetzt hat.
   */
  exklusiv(rolleId: string, everyoneId: string): void {
    this.setze(`0:${rolleId}`, Perm.VIEW_CHANNEL, 'allow');
    this.setze(`0:${everyoneId}`, Perm.VIEW_CHANNEL, 'deny');
  }
}
