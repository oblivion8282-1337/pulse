# Halbfertige Features — Bestandsaufnahme

> Automatischer Scan der gesamten Codebasis (Sonnet-Agenten, je ein Blickwinkel, jeder
> Fund einzeln gegengeprüft). Stand: **2026-06-16**.
> 34 Kandidaten gefunden → 25 bestätigt → nach Dubletten-Bereinigung **17 eigenständige Baustellen**.
> `(merkt man)` = ein normaler Nutzer bemerkt das Fehlen.
> `[ERLEDIGT JJJJ-MM-TT]` = inzwischen abgearbeitet.

---

## 1. Backend kann es, aber es gibt keinen Knopf

- **[ERLEDIGT 2026-06-16] Mitglied direkt per ID hinzufügen** *(merkt man)* — Admins/Mods können keinen User
  manuell zu einer Community hinzufügen, obwohl der Server-Endpunkt fertig ist.
  `services/chat-gateway/.../routes/guilds.py:334`
  → UI ergänzt im Einladungen-Tab der Community-Einstellungen (`GuildInvitesEditor.svelte`),
  gegated auf MANAGE_INVITES; API `chatApi.addMemberById`.
- **Stream-Anwesenheit erscheint verzögert** *(merkt man)* — Wer streamt, wird in anderen
  Communitys erst beim nächsten Auto-Update sichtbar, nicht sofort beim Öffnen.
  `services/chat-gateway/.../routes/streaming.py:179`
- **Missbrauchsmeldungen gegen Instanzen: kein Admin-Bereich** *(merkt man)* — Nutzer können
  Beschwerden einreichen, aber der Cloud-Admin hat keine Oberfläche zum Einsehen/Weiterleiten.
  `services/auth/.../routes_complaints.py:93ff`
- **Watch-Party-Anwesenheit ohne REST-Fallback** — Wer eine Watch-Party hält, erscheint in
  nicht-aktiven Sektionen evtl. erst nach dem nächsten WS-Push.
  `services/chat-gateway/.../routes/watch.py:25`
- **`myGuildPermissions()` gebaut, nie aufgerufen** — Toter Code-Ballast.
  `web/src/lib/api/roles.ts:89`

## 2. Knopf da, aber dahinter passiert nichts

- **[GESTRICHEN 2026-06-16] Globaler Push-to-Talk nur im Vordergrund** *(merkt man)* — Die Taste wirkt nur, solange das
  App-Fenster offen und aktiv ist. Minimiert/Hintergrund: kein PTT. Einstiegspunkt existiert,
  ist bewusst leer (No-op-Stub). Braucht nativen Key-Listener (z.B. uiohook-napi) im Electron-Main.
  `web/src/lib/platform/ptt.ts:26-28`, `desktop/electron/main.ts:508-512`
  → Bewusst NICHT gebaut (Aufwand/Nutzen — wird nicht genutzt). No-op-Stub `ptt.ts` entfernt,
  Aufruf im Layout raus. Das funktionierende In-Fenster-PTT (`settings.voice.pttKey`) bleibt.
- **[ERLEDIGT 2026-06-16] Highlight-Clip (F8) zeigt nur eine Meldung** *(merkt man)* — Taste im Cheatsheet/Einstellungen
  sichtbar, macht aber nur einen "coming soon"-Toast; der 30-Sekunden-Puffer im Backend existiert nicht.
  `web/src/lib/components/ShortcutHost.svelte:110-113`
  → Vorerst versteckt: Aktion als `hidden` in `actions.ts` geparkt (nicht im Spickzettel/Einstellungen,
  F8 frei), irreführender Handler entfernt. Code bleibt für späteren echten Bau erhalten.
- **"Desktop + Mikrofon" beim Windows-HQ-Streaming fehlt** *(merkt man)* — Modus ist auf Windows
  ausgeblendet, weil der Mixer-Code im Sidecar einen Platzhalter-Fehler zurückwirft (Stage-7-Mixer fehlt).
  `streaming/win-hq-sidecar/src/audio/wasapi.rs:324-331`
- **[ERLEDIGT 2026-06-16] "Verwarnen" in der Mod-Queue tut nichts Sichtbares** *(merkt man)* — Mod wählt "Warn",
  bekommt Erfolgsmeldung, aber der betroffene Nutzer erhält keine Benachrichtigung.
  `web/src/lib/api/moderation.ts:17-23`
  → Ehrlich beschriftet: Hinweis im Auflösen-Dialog, dass das Maßnahmen-Menü nur fürs Protokoll ist
  und niemanden automatisch benachrichtigt (`ModQueue.svelte`). Echte Verwarnung = Stufe 2 (Meldewesen).
- **Beschwerde-Weiterleitung schickt keine E-Mail** *(merkt man)* — "Weiterleiten" setzt nur einen
  DB-Status; der Self-Host-Betreiber erhält keine E-Mail.
  `services/auth/.../routes_complaints.py:168-188`
- **JWKS-Sicherheitswarnung nur im Server-Log** *(merkt man)* — Ändert sich ein sicherheitsrelevanter
  Schlüssel unerwartet, gibt es keinen sichtbaren Banner im Admin-Panel.
  `services/chat-gateway/.../app.py:286`

## 3. Halb gebaute Abläufe / abgeschaltete Features

- **Missbrauchs-Meldewesen: Frontend + E-Mail fehlen** *(merkt man)* — Einreichen geht technisch,
  aber es gibt keine Admin-Oberfläche und keine E-Mail-Weiterleitung an Instanz-Betreiber.
  `services/auth/.../routes_complaints.py`, `web/src/routes/app/admin/+page.svelte`
- **[ERLEDIGT 2026-06-16] Server-Liste der Desktop-App im falschen Speicher** — Eigene Server landen in der Electron-App
  im normalen Browser-Speicher statt im abgesicherten App-Speicher. Sicherer Pfad ist gebaut, aber
  nicht angeschlossen.
  `web/src/lib/api/servers.svelte.ts:9-11`
  → Auf Desktop in den chmod-600-Tresor verschoben (synchroner `getAllSync`-Boot-Read, async Write,
  einmalige localStorage→Tresor-Migration + Klartext-Löschung). Browser bleibt bei localStorage.
  Geändert: `store getAllSync`-IPC (`main.ts`/`preload.ts`/`pulse.d.ts`) + `servers.svelte.ts`.

## 4. Eingebaut, aber ungenutzt / tote Einstellungen

- **Profil-Cache-Lebenszeit (`profile_cache_ttl_seconds`)** — Per Umgebungsvariable einstellbar,
  wird aber im Betrieb nie gelesen.
  `services/chat-gateway/.../config.py:105`
- **Bind-Adresse in media-svc / mediamtx-auth-hook** — `BIND_HOST`/`BIND_PORT` einstellbar, aber die
  Startskripte hartcodieren die Adresse; die Einstellung hat keinen Effekt.
  `services/media-svc/.../config.py:70-71`, `services/mediamtx-auth-hook/.../config.py:30-31`
- **Server-seitige Einstellungs-Synchronisation komplett ungenutzt** — Datenbanktabelle, API-Endpunkte
  und Frontend-Sync-Code existieren, aber kein einziger Einstellungsbereich nutzt sie.
  `web/src/lib/settings-registry/server-sync.ts`, `services/chat-gateway/.../routes/preferences.py`

## 5. Offene Notizen im Code (TODO/FIXME)

- **[ERLEDIGT 2026-06-16] Desktop-Server-Liste: TODO für sicheren Speicher** — Kommentar beschrieb den nötigen Umstieg von
  `localStorage` auf `window.pulse.store`; jetzt umgesetzt (siehe Gruppe 3).
  `web/src/lib/api/servers.svelte.ts:9-11`

---

## Zusammenhängende Großbaustellen

Zwei Themen ziehen sich durch mehrere Punkte oben — die sind beim Fertigstellen am meisten "wert":

1. **Missbrauchs-Meldewesen (Beschwerden)** — Backend da, aber Admin-Oberfläche UND E-Mail-Versand fehlen.
2. **Desktop-Server-Liste im sicheren Speicher** — Electron-Seite fertig, Frontend-Anschluss fehlt.
