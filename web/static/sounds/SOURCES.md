# Pulse-Sound-Assets

13 Sound-Files in diesem Verzeichnis (`web/static/sounds/`). Engine ist
404-tolerant — solange ein File fehlt, ist der zugehörige Sound stiller
No-Op. Sobald du eine Datei droppst, greift sie beim nächsten
`pnpm build` (statisches Asset, kein Code-Change nötig).

## Erwartete Dateien

| Filename (`web/static/sounds/`) | Sound-ID                   | Kategorie     | Wann er feuert                                                       |
|---------------------------------|----------------------------|---------------|----------------------------------------------------------------------|
| `notification-message.ogg`      | `notification.message`     | notification  | Neue Nachricht in nicht-aktivem Channel (gated: kein Mention-Echo)   |
| `notification-mention.ogg`      | `notification.mention`     | notification  | Du wirst erwähnt (@, @everyone, eigene Rolle)                        |
| `notification-dm.ogg`           | `notification.dm`          | notification  | DM-Nachricht in nicht-aktiver DM                                     |
| `voice-user-join.ogg`           | `voice.user_join`          | voice         | Anderer Nutzer joint *deinen* Voice-Channel                          |
| `voice-user-leave.ogg`          | `voice.user_leave`         | voice         | Anderer Nutzer verlässt *deinen* Voice-Channel                       |
| `voice-self-join.ogg`           | `voice.self_join`          | voice         | Du joinst Voice                                                      |
| `voice-self-leave.ogg`          | `voice.self_leave`         | voice         | Du verlässt Voice                                                    |
| `voice-self-mute.ogg`           | `voice.self_mute`          | voice         | Du schaltest dich stumm (toggleMic, nicht PTT)                       |
| `voice-self-unmute.ogg`         | `voice.self_unmute`        | voice         | Du gehst aus mute                                                    |
| `voice-self-deafen.ogg`         | `voice.self_deafen`        | voice         | Du betäubst dich (oder Admin tut es)                                 |
| `voice-self-undeafen.ogg`       | `voice.self_undeafen`      | voice         | Du gehst aus deafen                                                  |
| `ui-send.ogg`                   | `ui.send`                  | ui            | Nachricht-Send queued (default Kategorie OFF)                        |
| `ui-modal-open.ogg`             | `ui.modal_open`            | ui            | Settings-Dialog öffnet (default Kategorie OFF)                       |

## Quellen — empfohlene CC0/Pixabay-Pakete

**Bevorzugt** — geben einen kohärenten Look-and-Feel weil aus einer
Hand. Lade ein Pack, schneide raus was passt:

1. **Kenney UI Audio Pack** (CC0, kein Attribution nötig) —
   <https://kenney.nl/assets/ui-audio>
   - `click1.ogg`..`click5.ogg`, `confirmation_001`..`004`,
     `bong_001`..`003`, `error_*`. Sehr clean, „App-Sound-Design"-Vibe.
   - Gut für: `ui.send`, `ui.modal_open`, evtl. `voice.self_mute/unmute`.
2. **Kenney Interface Sounds** (CC0) — <https://kenney.nl/assets/interface-sounds>
   - 28 generische UI-Bleeps. Etwas Game-Console-iger als „UI Audio".
3. **Material Design Sound Resources** (Apache 2.0 — Attribution
   in einer LICENSES.md genügt, kommerziell ok) —
   <https://m2.material.io/design/sound/sound-resources.html>
   - „Notification" / „Hero / Begin / Complete" / „State Change /
     State-Change-Confirm-Up" / „Alert / Alert-High-Intensity".
   - Notification-Pings sind sehr Discord-like; gut für
     `notification.*` und `voice.user_join/leave`.

**Einzeln** — wenn du pro Sound eigene Picks willst, ist Pixabay die
schnellste Option (Pixabay-Content-License — auch kommerziell ok,
Attribution nicht zwingend):

- Mention/DM-Ping → <https://pixabay.com/sound-effects/search/notification/>
- Voice-Join/Leave → <https://pixabay.com/sound-effects/search/door%20open/> bzw. `door close`
- Mute/Unmute → <https://pixabay.com/sound-effects/search/switch/> oder `click`
- Deafen → <https://pixabay.com/sound-effects/search/mute/>
- Send → <https://pixabay.com/sound-effects/search/whoosh/>

Alternative für sehr feines Tuning: <https://freesound.org/> mit
Filter „License: Creative Commons 0" — qualitativ heterogener,
aber riesiger Pool.

## Codec / Format

- Engine erwartet `.ogg` (Opus oder Vorbis im OGG-Container — Browser
  decodieren beides). MP3/WAV gehen technisch auch, aber dann muss
  `SOUND_EXT` in `web/src/lib/sounds/engine.ts` angepasst werden, und
  alle Files brauchen dieselbe Endung.
- Empfehlung: bei OGG bleiben, mono ist okay (HTMLAudioElement decodiert
  ohne extra Setup), 44.1 kHz, 96–128 kbps. Files sollen 100–800 ms lang
  sein — UI-Sounds < 200 ms, Voice/Notification-Pings 300–500 ms.

## ffmpeg-Konvertierung & Normalisierung

Pixabay liefert meistens MP3. Konvertieren + auf gemeinsame Lautheit
ziehen (alle Sounds gleich laut bei selber Slider-Position):

```fish
# Eine Datei MP3 → OGG Vorbis, normalisiert auf EBU R128 (-23 LUFS)
ffmpeg -i input.mp3 \
  -af loudnorm=I=-23:LRA=7:TP=-2 \
  -c:a libvorbis -q:a 4 \
  output.ogg

# Batch (alle MP3 in /tmp/sounds/ → /tmp/out/)
for f in /tmp/sounds/*.mp3
  ffmpeg -i $f \
    -af loudnorm=I=-23:LRA=7:TP=-2 \
    -c:a libvorbis -q:a 4 \
    /tmp/out/(basename $f .mp3).ogg
end
```

`I=-23` ist konservativ (Discord-Niveau). Wenn du lauter willst,
`I=-18` oder `-16`. Per-Sound trimmen mit `-ss 0.0 -to 0.4` falls
vorne/hinten Stille drin ist.

## Attribution-Trail

Wenn du Material Design oder ein Freesound-CC-BY-File verwendest,
trage es in eine `LICENSES.md` neben den Files ein — wird vom
Static-Adapter nicht ausgeliefert, dient nur als Audit-Trail:

```markdown
- `notification-mention.ogg` — Material Design "Hero Begin",
  Apache-2.0, https://m2.material.io/design/sound/sound-resources
- `voice-user-join.ogg` — Pixabay #12345 "Door Open Soft" (Pixabay
  License), https://pixabay.com/sound-effects/door-open-soft-12345/
```

Kenney + Pixabay haben null Attribution-Pflicht, brauchen also
keinen Eintrag — können trotzdem rein für die eigene Übersicht.

## Test-Workflow

Nachdem du Files droppst:

1. `pnpm dev` (oder Browser-Refresh wenn schon offen).
2. Einstellungen → Sounds → Test-Button neben jedem Sound. Engine
   markiert fehlende Files automatisch als „missing" (Button
   disabled + Tooltip „Sound-Datei fehlt").
3. Master-Volume + Kategorie-Volume A/B testen.
4. Funktionstest:
   - `notification.message` → Zweit-Account schickt Nachricht im Channel den du nicht ansiehst.
   - `notification.mention` → Zweit-Account erwähnt dich.
   - `voice.user_join` → Zweit-Account joint deinen Voice-Channel.
   - `voice.self_*` → Voice joinen + Mute/Deafen togglen.
   - `ui.send` → Nachricht senden (Kategorie erst in Settings einschalten).
