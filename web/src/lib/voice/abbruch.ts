/**
 * Abraeumen eines LiveKit-Raums, der waehrend des Verbindens entwertet wurde.
 *
 * Legt ein `connect()` los und der Nutzer legt mittendrin auf (oder ein
 * Administrator wirft ihn hinaus), dann kehrt der Verbindungsaufbau aus seinem
 * `await` in eine Welt zurueck, die ihn nicht mehr haben will. Er muss dann
 * alles hergeben, was er bis dahin an sich gezogen hat — und zwar in dieser
 * Reihenfolge:
 *
 *  1. die lokalen Geraete-Spuren (Mikrofon, Kamera, Bildschirm): erst aus der
 *     Leitung nehmen, dann die Spur des Geraets stoppen,
 *  2. danach den Raum trennen.
 *
 * Die Reihenfolge ist der springende Punkt: trennt man zuerst den Raum, laeuft
 * das spaetere Zuruecknehmen ins Leere — die Aufnahme des Geraets bliebe offen
 * (offenes Mikrofon, leuchtende Kamera-Anzeige). Ein Abbruch, der ein offenes
 * Mikrofon zuruecklaesst, waere schlimmer als der Fehler, den er behebt.
 *
 * Die Ereignis-Anmeldungen brauchen keinen eigenen Schritt: sie haengen am
 * Raum-Objekt selbst und ihre Wachposten in `livekit.svelte.ts` vergleichen
 * gegen `#room`, sind also nach dem Verwerfen wirkungslos.
 */

import { Track, type LocalTrack, type Room } from 'livekit-client';

/** Nimmt eine lokale Quelle aus der Leitung und stoppt die Geraete-Spur. */
export async function quelleZuruecknehmen(room: Room, quelle: Track.Source): Promise<void> {
  const spur = room.localParticipant.getTrackPublication(quelle)?.track as LocalTrack | undefined;
  if (!spur) return;
  try {
    // `true` = beim Zuruecknehmen auch stoppen.
    await room.localParticipant.unpublishTrack(spur, true);
  } catch {
    // Raum bereits getrennt — dann bleibt nur das Stoppen der Spur selbst.
  }
  try {
    spur.stop();
  } catch {
    // Schon gestoppt; unerheblich.
  }
}

/** Vollstaendiges Abraeumen eines verwaisten Raums (siehe Kopf-Kommentar). */
export async function raumVerwerfen(room: Room): Promise<void> {
  await quelleZuruecknehmen(room, Track.Source.Microphone);
  await quelleZuruecknehmen(room, Track.Source.Camera);
  await quelleZuruecknehmen(room, Track.Source.ScreenShare);
  await quelleZuruecknehmen(room, Track.Source.ScreenShareAudio);
  try {
    await room.disconnect();
  } catch {
    // War nie oder nicht mehr verbunden.
  }
}
