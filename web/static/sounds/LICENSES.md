# Sound-File-Lizenzen

Die OGG-Files in diesem Verzeichnis stammen aus dem **Kenney UI Audio Pack**
(<https://kenney.nl/assets/ui-audio>), lizenziert unter **CC0 1.0
Universal** (<https://creativecommons.org/publicdomain/zero/1.0/>) — Public
Domain, keine Attribution-Pflicht. Wir nennen Kenney trotzdem als gutgemeinten
Trail.

## Mapping (Pulse-ID → Kenney-Original)

| Pulse-File                  | Kenney-Original            |
|-----------------------------|----------------------------|
| `notification-message.ogg`  | `Audio/switch7.ogg`        |
| `notification-mention.ogg`  | `Audio/switch17.ogg`       |
| `notification-dm.ogg`       | `Audio/switch15.ogg`       |
| `voice-user-join.ogg`       | `Audio/switch4.ogg`        |
| `voice-user-leave.ogg`      | `Audio/switch5.ogg`        |
| `voice-self-join.ogg`       | `Audio/switch2.ogg`        |
| `voice-self-leave.ogg`      | `Audio/switch3.ogg`        |
| `voice-self-mute.ogg`       | `Audio/switch8.ogg`        |
| `voice-self-unmute.ogg`     | `Audio/switch9.ogg`        |
| `voice-self-deafen.ogg`     | `Audio/switch11.ogg`       |
| `voice-self-undeafen.ogg`   | `Audio/switch10.ogg`       |
| `ui-send.ogg`               | `Audio/click1.ogg`         |
| `ui-modal-open.ogg`         | `Audio/rollover2.ogg`      |
| `stream-user-start.ogg`     | _noch nicht zugeordnet — Pixabay/Freesound-Pick_ |
| `stream-user-stop.ogg`      | _noch nicht zugeordnet — Pixabay/Freesound-Pick_ |
| `stream-self-start.ogg`     | _noch nicht zugeordnet — Pixabay/Freesound-Pick_ |

Pack-Download (Stand 2026-05-18):
<https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip>

## Austauschen

Files sind 1:1-ersetzbar — Engine lädt sie über `/sounds/<filename>.ogg`,
keine Code-Änderung nötig. Beim Tausch:

1. Eigenes OGG droppen (gleicher Filename).
2. Browser-Refresh.
3. Engine bemerkt den geänderten Inhalt beim nächsten `play()`.

Beim Tauschen auf File aus anderer Quelle: Lizenz hier nachtragen.
