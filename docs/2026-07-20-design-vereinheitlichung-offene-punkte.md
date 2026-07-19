# Design-Vereinheitlichung — was noch offen ist

Stand 2026-07-20, Branch `refactor/design-vereinheitlichung` (32 Commits, gepusht,
noch kein PR). Bestandsaufnahme und Begründungen:
`docs/2026-07-19-design-vereinheitlichung-bestandsaufnahme.md`.
Alles nebeneinander zu sehen: Dev-Route **`/app/dev/design`** (nicht im Menü).

---

## Als Nächstes vereinbart

### 1. Touch-Grössen auf dem Handy — 16 Stellen

Beim Button-Umbau (`72d26e6e`) sind 16 mobile Sonderabstände verschwunden
(`md:p-1`, `md:p-1.5`, `md:p-2`, `md:py-1`), weil die Button-Komponente feste
Höhen hat. Die Knöpfe sind auf dem Telefon damit kleiner als vorher — betrifft
vor allem Symbol-Knöpfe in den Einstellungen (Passkey löschen, Sitzung beenden,
Gerät entfernen).

Zu finden mit:

    git show 72d26e6e | grep "^-" | grep -oE "md:(py|p)-[a-z0-9.]+" | sort | uniq -c

**Nicht** wieder pauschal in der Komponente lösen — das wurde versucht
(`1685188f`) und zurückgenommen (`3eb60a65`), weil es die Voice-Leiste umbrechen
liess: die Aufrufstellen, denen Trefferflächen wichtig sind, lösen es selbst und
gezielter (`VoiceControlBar` nutzt `size-14 md:size-8`). Der richtige Weg ist,
an diesen 16 Stellen einzeln eine Touch-Grösse über `class` zu ergänzen.

---

## Fehlende Komponenten

### 2. Schieberegler, Datei- und Farbwähler

Für `type="range"` (11x), `type="file"` (5x), `type="color"` (4x) und
`type="radio"` (6x) gibt es kein Gegenstück im Baukasten. Sie blieben deshalb
roh. Ebenso `<select>` und `<textarea>`.

Die Schieberegler sind der lohnendste Fall — sie sitzen in Mikrofonpegel,
Lautstärke, Bitrate und A/V-Versatz und sehen dort überall etwas anders aus.

### 3. `AdminJoinControl.svelte:63` — Schalter, der als Kästchen gebaut ist

Ein `<input type="checkbox" class="sr-only">` mit handgemalter Schalter-Grafik
daneben, alles in einem klickbaren `<label>`. Funktional ein Schalter.
`<Switch />` einzusetzen würde einen `<button>` in ein `<label>` setzen — dann
toggelt der Klick auf die Beschriftung nicht mehr. Braucht einen Umbau der
ganzen Zeile, nicht nur einen Element-Tausch.

Zwei gleichgelagerte Fälle in `SettingsAudioVideo` (Selbst-Abhören, Räumlicher
Klang): Kästchen mit `role="switch"` in umschliessender `<label>`. Aus demselben
Grund gelassen.

---

## Kleinigkeiten

### 4. Plus-Knopf der Community-Leiste

Steht auf 12px Rundung (`rounded-xl`), das Pulse-Symbol darüber auf 8px
(`rounded-md`). Die Community-Symbole ruhen auf 12px und gehen beim
Überfahren/Aktivsein auf 8px. Bewusst so gelassen, weil der Knopf nicht
Gegenstand der Anpassung war — aber es ist die letzte Abweichung in der Leiste.

### 5. Zwei Ladehinweise mit fremden Übersetzungsbausteinen

`MessageReactions.svelte:230` nutzt `m.admin_permissions_loading()`,
`AdminVoiceLimits.svelte:105` nutzt `m.admin_stream_limits_loading()`. Beides
**Bestand**, nicht aus diesem Branch — die alten Zeilen benutzten dieselben Keys.
Ein Reaktions-Popover, das einen Admin-Text vorliest, ist trotzdem falsch.
Gehört ins offene i18n-Aufräumen.

### 6. `StreamPickerDialog.svelte:55`

Der einzige `MenuRow` mit einer Optik-Klasse (`border border-border/60`). Der
Rahmen trennt eine Sammelaktion („Alle ansehen") von der Einzelliste. Vertretbar,
weil es eine Positions- und keine Zustandsaussage ist. Taucht das Muster ein
zweites Mal auf, gehört daraus eine Ausprägung `separated` gemacht.

### 7. Reiter der Einstellungs- und Community-Dialoge

Beide sind das `MenuRow`-Muster, wurden aber nicht migriert: sie sind auf dem
Handy grösser (`py-3 md:py-1.5`, `text-base md:text-sm`), und `MenuRow` kennt nur
feste Dichten. Eine responsive Dichte einzuführen würde für Mobil **nichts**
gewinnen (die Grössen stehen ja schon da) — es wäre reine Entdopplung. Bewusst
gelassen.

---

## Vor dem PR zu erledigen

- **Changelog-Eintrag** (`web/static/changelog.json`). Das CI-Gate
  (`scripts/check-changelog.sh`) verlangt einen, sobald `web/src/**` angefasst
  ist. Stil vorher mit dem User abstimmen, keine Emojis.
- **Playwright ist nie gelaufen.** `web/tests/e2e/dropbox.spec.ts` wurde
  angepasst (der Test akzeptierte den alten Systemdialog und wäre sonst grün
  geblieben, ohne noch etwas zu prüfen) — diese Anpassung ist ungeprüft. An
  Anmeldung, Registrierung und Ablage hängen Tests, und die Formulare wurden
  angefasst.
- Optischer Durchgang auf **Mobil**. Bisher nur im Electron-Fenster am Desktop
  gegengesehen.

## Was NICHT offen ist

Icons sind sauber (eine Bibliothek, `size-*`-Syntax, neun Ausreisser von ~412) —
dort war und ist nichts zu tun.
