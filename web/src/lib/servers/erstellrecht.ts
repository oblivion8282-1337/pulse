/**
 * Darf ich auf DIESEM Server eine Community anlegen? — reine Rechnung, ohne
 * Zustand und ohne Nachbarmodule.
 *
 * **Warum importfrei:** damit sie prüfbar ist. Der Web-Testläufer
 * (`pnpm test:unit`, Nodes eingebauter) führt eine Datei nur aus, wenn sie
 * keine erweiterungslosen Laufzeit-Importe mitschleppt — die löst der Bundler
 * auf, Node nicht. Gleiches Muster wie `lib/api/verbindungsbefund.ts` und
 * `lib/navigation/tabs.ts`, aus demselben Grund.
 *
 * **Warum überhaupt eine gemeinsame Stelle.** Dieselbe Frage wurde an drei
 * Orten beantwortet — in der `GuildRail` und in zwei Routen —, und die drei
 * Antworten waren bereits auseinandergelaufen: die Rail las die Freigabe pro
 * Server (`serverCapabilities`), die Routen die des gerade aktiven
 * (`capabilities`). Auf einem zweiten Server konnte derselbe Nutzer damit an
 * einer Stelle einen Knopf sehen und an der anderen nicht.
 *
 * **Der Fall, der das ausgelöst hat (2026-08-27).** Ein Betreiber konnte auf
 * seinem eigenen frischen Self-Host keine Community anlegen. Er durfte es
 * sehr wohl — sein Server führte ihn als Admin (nachgemessen). Nur wusste
 * seine App das nicht: Der Admin-Status kam ausschliesslich aus dem
 * `ready`-Rahmen, den es nur über eine bestehende WebSocket gibt, und die
 * baut die App nur zum AKTIVEN Server auf (`app/+layout.svelte`). Sein Server
 * war nicht aktiv, weil er dort keine Community zum Anklicken hatte — und den
 * Menüpunkt, der ihn aktiviert hätte, bekam er mangels Admin-Status nicht zu
 * sehen. Eine Henne-Ei-Falle, die genau die Neulinge trifft, für die der
 * Punkt gedacht ist.
 */

/** Was der Server über EINE Person sagt — oder dass er nichts gesagt hat. */
export type Eingaben = {
  /** Cloud-Server (howispulse.com) statt Self-Host. */
  istCloud: boolean;
  /** `auth.user.is_admin` — das Cloud-Plattform-Flag. Gilt NUR auf der Cloud. */
  cloudAdmin: boolean;
  /**
   * Rolle laut Cloud-Serverliste (`GET /me/instances`, `role`). Die Cloud weiss
   * aus `registered_instances.registered_by`, wem ein Server gehört — und das
   * weiss sie ohne jede Verbindung zu diesem Server.
   */
  rolleLautCloud: 'owner' | 'member' | null;
  /**
   * Was der Server selbst im `ready`-Rahmen gemeldet hat (`is_admin`), oder
   * `null`, wenn er noch nichts gemeldet hat. **`null` und `false` sind
   * verschiedene Dinge** — die Unterscheidung ist der ganze Punkt dieser
   * Datei; ohne sie las sich „noch nicht gefragt" wie „nein".
   */
  adminLautServer: boolean | null;
  /** `allow_guild_creation` DIESES Servers. Auf frischen Servern absichtlich falsch. */
  offenFuerAlle: boolean;
};

/**
 * **Die Auskunft des Servers gewinnt, sobald es eine gibt.** Er ist die
 * Autorität — er entscheidet die Anfrage am Ende ohnehin (`POST /guilds`
 * liest den `admin`-Claim). Sagt er „nein", wäre ein Knopf, der in einen 403
 * läuft, schlechter als keiner: Der Weg dahin ist dann die
 * Erreichbarkeitsprüfung, die genau diesen Fall benennt.
 *
 * Nur solange er nichts gesagt hat, tritt die Cloud-Angabe ein. Sie ist eine
 * begründete Erwartung, keine Tatsache — aber eine, die ohne Verbindung
 * vorliegt, und damit genau dort, wo bisher gar nichts stand.
 */
export function darfCommunityAnlegen(e: Eingaben): boolean {
  if (e.istCloud) return e.cloudAdmin || e.offenFuerAlle;
  const admin = e.adminLautServer ?? e.rolleLautCloud === 'owner';
  return admin || e.offenFuerAlle;
}
