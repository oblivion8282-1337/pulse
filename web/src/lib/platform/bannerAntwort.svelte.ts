/**
 * Antworten aus dem Mitteilungs-Banner (iOS, Aktion „Antworten" — Knopf
 * „Senden", `AppDelegate.swift::mitteilungsAktionenRegistrieren`).
 *
 * **Sie werden GESENDET, nicht als Entwurf abgelegt** (Bughunt 2026-10-11,
 * T10). Bis dahin stand hier ein Entwurf — mit der Begründung, Senden
 * gehöre in den Chat, der gerade aufgeht. Der Knopf hiess aber „Senden",
 * und im schon offenen Gespräch griff die Entwurf-Wiederherstellung nicht
 * (sie läuft nur beim Wechsel des Kanals): der erste Tastendruck
 * überschrieb den Text.
 *
 * Die Begründung von damals bleibt gültig, nur der Ort ist ein anderer:
 * gesendet wird DORT, im Chat — sobald seine Seite den Kanal kennt
 * (`routes/app/@me/[[dmChannelId]]/+page.svelte`), über denselben
 * Sende-Einstieg wie das Eingabefeld (`chat/dmSenden.ts`). Scheitert es,
 * meldet der das laut und legt den Text in die Zwischenablage; hier kommt
 * er zusätzlich als Entwurf zurück.
 */
class BannerAntworten {
  #offen = $state<Record<string, string>>({});

  ablegen(kanalId: string, text: string): void {
    this.#offen = { ...this.#offen, [kanalId]: text };
  }

  /** Reaktiv lesen — für den `$effect` der Chat-Seite. */
  fuer(kanalId: string): string | undefined {
    return this.#offen[kanalId];
  }

  /** Herausnehmen, damit sie genau EINMAL gesendet wird. */
  nehmen(kanalId: string): string | undefined {
    const text = this.#offen[kanalId];
    if (text === undefined) return undefined;
    const { [kanalId]: _weg, ...rest } = this.#offen;
    this.#offen = rest;
    return text;
  }
}

export const bannerAntworten = new BannerAntworten();
