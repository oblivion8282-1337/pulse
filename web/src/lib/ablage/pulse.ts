/**
 * Der pulse-Adapter — das Pulse-Laufwerk als `AblageAdapter`, sodass
 * `DateiSpeicher` (und damit die ganze verschlüsselte Dateiablage) ohne
 * jede Sonderbehandlung darüber läuft (Spezifikation
 * ``docs/superpowers/specs/2026-09-11-pulse-laufwerk-design.md`` §3).
 *
 * Kein Credential im Browser: authentifiziert wird über die normale
 * Pulse-Session, Datenwege über kurzlebige presigned URLs. Der Adapter ist
 * zustandslos — jede Operation holt ihre URL frisch, darum sieht ein
 * erneutes `lese` des Verzeichnisses immer den jüngsten Stand aller Geräte.
 *
 * Schreiben ist zweiteilig: ankündigen (Größe — mehr sieht der Server nie)
 * → PUT → gelungen. Erst nach „gelungen“ zählt der Klumpen ins Kontingent;
 * ein abgebrochenes PUT hinterlässt eine Ankündigung ohne Wirkung, die der
 * nächste Schreibvorgang desselben Namens ohnehin überschreibt.
 *
 * `ponytail:` das gemeinsame `verzeichnis.puls` ist ein Ein-Verzeichnis-
 * Modell — zwei Geräte, die GLEICHZEITIG hochladen, können sich gegenseitig
 * den Verzeichnisstand überfahren (dieselbe Decke wie bei jedem anderen
 * geteilten Laufwerk auch, s. `dateispeicher.ts::nacheinander`).
 * Upgrade-Pfad: geräteweise Verzeichnis-Ketten laut Spezifikation §4.
 */

import type { AblageAdapter } from './adapter.ts';
import { ablagePulseApi } from '../api/ablagePulse.ts';

export function pulseAdapter(guildId: string): AblageAdapter {
  return {
    async schreibe(datei: string, inhalt: Uint8Array): Promise<void> {
      const { upload_url } = await ablagePulseApi.ankuendigen(guildId, datei, inhalt.length);
      const antwort = await fetch(upload_url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: inhalt as unknown as BodyInit
      });
      if (!antwort.ok) throw new Error(`Hochladen fehlgeschlagen: ${antwort.status}`);
      await ablagePulseApi.gelungen(guildId, datei);
    },

    async lese(datei: string): Promise<Uint8Array | null> {
      const { url } = await ablagePulseApi.leseUrl(guildId, datei);
      const antwort = await fetch(url);
      if (antwort.status === 404) return null;
      if (!antwort.ok) throw new Error(`Lesen fehlgeschlagen: ${antwort.status}`);
      return new Uint8Array(await antwort.arrayBuffer());
    },

    async liste(): Promise<string[]> {
      return ablagePulseApi.namen(guildId);
    },

    async lösche(datei: string): Promise<void> {
      await ablagePulseApi.loeschen(guildId, datei);
    }
  };
}
