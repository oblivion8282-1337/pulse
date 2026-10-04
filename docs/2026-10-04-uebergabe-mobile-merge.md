# Übergabe: Mobile-Merge-Zweig + Anrufe-Härtung + Archiv-Bau

> Stand: 2026-10-04, früh · Branch `merge/mobile-2026-10` (gepusht, Commit
> `11167d75`) · Basis: `feat/mobile` (Kuriiko, 106 Commits ab 06.09.) in
> main gemergt und versöhnt.
>
> Selbsttragend gedacht: Eine Person (und deren KI-Assistent) soll ohne
> Gesprächsverlauf weiterarbeiten können. Alle Pfade repo-relativ.

---

## 1. Wo steht was

- **`merge/mobile-2026-10`** = feat/mobile in die main-Linie geholt.
  Alle Prüfungen grün: svelte-check 0/0, Web-Tests **1328/1328**
  (`node --test test/*.test.ts` im `web/`), chat-gateway **1689/1689**,
  voice-signaling **98/98**, shared **129/129**, `alembic heads` = genau
  einer (`0097_meine_anhaenge`).
- **NOCH NICHT in main.** Vor dem PR stehen die Anruf-Fixes (§3) und das
  Desktop-Tuning (§4). PR-Titel/-Merge wie üblich:
  `gh pr merge --merge --admin` mit `merge: <Thema> <Datum>`
  (KEIN Rebase — der Zweig trägt Merge-Commits).
- Kuriiko arbeitet weiter auf `feat/mobile` — neue Commits dort einfach
  erneut in `merge/mobile-2026-10` mergen (Konfliktmuster sind unten
  dokumentiert, die nächsten sind billiger).

### Versöhnungs-Entscheidungen (nicht neu diskutieren)

| Ort | Entscheidung |
|---|---|
| Alembic | Branch-Migrationen als **0094–0097** hinter mains `0093_buendel_signatur` umbettet (Revision-IDs mit umbenannt). |
| `MessageList.svelte` | **klebe/klebezustand (main) ist die Klebe-Autorität.** Branch-Sicherungen drumherum: Erstladung-Sperre mit 150-ms-Ruhe-Frist (`initialBereit`), 250-ms-Nachmess-Wächter, 30-px-Klemme, 150-ms-Abwärtsblock. mains `messSperre` (overflow-hidden) **gestrichen** — die Spinner-Sperre deckt sie ab, doppelt wäre eins zu viel. `itemSize=48` + `itemSizeEstimate={hoeheNachIndex}` (main) **bleibt**, NICHT branchs 120. |
| Krypto-Frames | `rahmenAusNutzlast` liefert `loeschung` **mit `absenderUserId`** (mains Bughunt-Bindung 23.09.); Lookup-Filter (`loeschZiel.ts`, `verlaufSatzIdFuerKryptoId`) **optional** für reaktion/bearbeitung (die löschen nichts). `'verworfen'` → `{art:'ohneAblage'}`. |
| `VoiceControlBar` | Konsequent Branch-Seite (`speakerOn`, zwei Zustände); mains drei-Zustände-`route` ist weg. |
| kanalWechsel (beide) | BEIDE Seiten: `gapFill` (main, Bughunt Runde 5) **und** `vorbereiten` (Branch, Top-Blitz-Fix) **und** `schlaeftServerVon` (main, schlafende Server). `alreadyLoaded`-Guard fiel an die C2-Sequenz (jeder Öffner = Frischlader). |
| Postfach-Drossel | Branch-Form (`message`-Rahmen 10/s, von `test_postfach_drossel.py` gepinnt); mains alte `postfach`-Regel aus der Tabelle entfernt. |

### Fix, der im Merge mit drin ist

- **„Neue Nachrichten“-Knopf war tot**: `neueUnten += count - lastCount`
  lief NACH `lastCount = count` → immer 0. Jetzt: Delta vorher sichern
  (`zuwachs`). `web/src/lib/components/MessageList.svelte`.

---

## 2. Lokale Umgebung (die Fallen)

- **chat-gateway-Tests** brauchen (laufender Dev-Stack hält sonst Locks,
  root-`.env` treibt Tests in den Selfhost-Crash):
  ```
  cd services/chat-gateway
  PULSE_INSTANCE_MODE=cloud PULSE_ALLOW_MULTIPLE_WORKERS=1 \
  REDIS_URL="redis://localhost:6380/0" uv run --no-sync pytest -q
  ```
- **Lokale Postgres kennt die ALTEN Branch-Revision-IDs nicht mehr**
  (0090_dm_lesestand → heißt jetzt 0094_dm_lesestand …). Beim ersten
  dev-up/Alembic auf diesem Zweig kommt „Can't locate revision“.
  Tabellen existieren schon → nur stempeln, nicht neu fahren:
  `alembic stamp 0097_meine_anhaenge` (im Container bzw. gegen die
  Dev-DB) — oder Dev-DB-Volume wegwerfen.
- Nach Branch-Wechsel IMMER `pnpm install` im `web/` (AGENTS.md).
- Vite/Dev-Stack-Start: s. AGENTS.md Startcheckliste (dev-up.fish,
  Ports 5173 + 8001-8005, NICHT auf Skriptende warten).

---

## 3. Offen vor dem PR: Anruf-Fixes (Reihenfolge = Priorität)

Befunde aus dem Code-Review 03.10. (zwei Erkundungs-Agenten, Beweise mit
Datei:Zeile). Alles auf `merge/mobile-2026-10` fixen, je Fix ein Commit
mit Test wo machbar (Zustandsmaschine ist Node-untestbar — Mock-Adapter
oder Server-Tests erweitern).

1. **Zweitgerät des Angerufenen killt laufenden DM-Anruf nach 45 s.**
   `call_angenommen` geht an alle Geräte des Kontos;
   `verbindenNachAnnahme()` ignoriert Rolle `eingehend`
   (`web/src/lib/anrufe/anruf.svelte.ts:386-392`) → Zweitgerät klingelt
   weiter, Wecker feuert `ablehnen()` (`:416-425`), und der Server
   beendet bei `ablehnen` **ohne Zustandsprüfung** jeden DM-Anruf
   (`services/chat-gateway/src/dcc_chat_gateway/routes/anrufe.py:190-205`).
   Fix beidseitig: Server lehnt `ablehnen` auf `laufend` ab (409/eignals
   `call_ende`- Grund) ODER Client entschärft den Wecker, sobald
   `call_angenommen` für dieselbe call_id kam (besser beides).
2. **Doppel-`#verbinden` → LiveKit-Raum-Leak mit aktivem Mikro (Echo).**
   Kein Reentrancy-Guard (`anruf.svelte.ts:386-392`, `#room`-Überschreiben
   `:471`); Server published bei JEDEM `/annehmen` erneut
   (`anrufe.py:179-187`); Doppel-Tipp auf Annehmen möglich
   (`AnrufOverlay.svelte:74-84`). Vorbild-Lösung im Haus:
   `#connectGen`-Wächter aus `voice/livekit.svelte.ts:436-530`.
3. **Gruppenanruf endet für alle beim ersten Auflegen.**
   `anruf_auflegen` beendet unabhängig von `art`
   (`anrufe.py:208-231`) — inkonsistent zu `ablehnen` (nur DM).
4. **`/anrufe` hat keine Drossel** (Klingel-Fan-out an ganze Gruppen =
   Spam-Vektor). Regel in `ratelimit.py` + Check als Schritt 0 in der
   Route; Test analog `test_postfach_drossel.py`.
5. **Kein `Disconnected`-Handling** im Anruf-Store
   (`anruf.svelte.ts:473-478` behandelt nur `Connected`) → totes Overlay
   bei LiveKit-Kick/Netzverlust. Dazu: Dauer-Timer-Leak bei Reconnect
   (`:526-531`, `clearInterval` fehlt).
6. **Presence-Refcount im Webhook fehlt:** `participant_left` EINES
   Geräts streicht die nackte User-ID komplett aus den Presence-Sets,
   obwohl das andere Gerät noch drin ist
   (`services/voice-signaling/src/dcc_voice_signaling/webhook.py`,
   `_apply_join/_apply_leave` ~:303-330). Refcount je Identität führen.
   Nebeneffekt derselben Wurzel: Anruf-Räume bekommen weiter Identitäten
   OHNE Suffix (`routes/call_token.py:94`) → zwei Geräte desselben
   Nutzers im selben Anruf treten sich per LiveKit-Duplicate-Identity
   raus — nach Fix 1+2 mitbedenken.
7. **Kleinere:** unhandled Rejections bei `starten/stummUmschalten/
   kameraUmschalten` (`anruf.svelte.ts:227-230, 373-384`;
   `AnrufOverlay.svelte:101,113`) + Toggle-Desync; FCM-IntegrityError
   schluckt Verlust still (`routes/fcm.py:83-88`); Lesestand-Event
   published den angefragten statt des gespeicherten Werts
   (`routes/dms.py:272-276`); `anrufe`-Zeilen werden bei
   Kontolöschung nicht geräumt (kein FK auf `einleiter_id`); kein
   Sweeper für hängende `klingelnd`-Zeilen abgestürzter Clients.

**Desktop-Lücken bei Anrufen (nach den Fixes, vor/während PR):**
- Eingehender Anruf bei minimiertem Fenster = nur ein kurzer DM-Sound.
  Das Notification-Framework existiert schon und wird nicht benutzt:
  `notifications/inPage.ts:133-158` → Electron-IPC `window.pulse.notify`
  → `desktop/electron/notify.ts`. Einbauen: Klingel-Loop +
  Klick-zum-Annehmen.
- Kein Wake-Lock / keine MediaSession im Anruf — beides hat die
  Voice-Engine schon (`voice/livekit.svelte.ts:29,58`), nur importieren.

---

## 4. Desktop-Tuning (klein, vor dem PR)

- **Lade-Sperre-Spinner bei JEDEM Chat-Öffnen** läuft auch am Desktop
  (`MessageList.svelte`, `initialBereit`). Desktop hat den Verlauf lokal
  sofort — das Blitzen ist dort Rückschritt. Vorschlag: Sperre nur
  zeigen, wenn länger als ~1 Frame gewartet wird (z. B. Sperre erst
  nach 100 ms sichtbar schalten), oder Touch-only. Michaels ausdrücklicher
  Wunsch: Desktop-Oberfläche nicht verschlechtern.
- Michaels offenes Scroll-Problem („Kanal öffnen lässt ~2
  Nachrichtenhöhen Rest“, Desktop-App) ist von diesem Merge
  **very likely mitgefixt** (Ruhe-Frist + Nachmess-Wächter + Klemme
  zielen genau auf die beiden Verdächtigen: später Server-Nachschlag,
  nachmessende Schriften/Bilder). **Browser-Gegenprobe offenkundig noch
  ausständig** — nachziehen und im PR vermerken.

---

## 5. Danach: Archiv-Bau („überall den exakten Verlauf“)

Michaels Anforderungen, final (03./04.10., alle früheren QR-Pläne für
den ARCHIV-Zugang sind verworfen):

1. **Textnachrichten** verschlüsselt beim Server, **120 Tage ab
   Versand**, dann automatische Löschung (Sweeper). Erstmal **1:1-DMs**;
   private Gruppen analog später (Megolm-Weg existiert).
2. **Zugang = ganz normale Anmeldung** (Benutzername + Passwort, 2FA
   folgtlosen). Kein QR, kein Wiederherstellungs-Päckchen fürs Archiv.
3. **Passwort-Reset (E-Mail, existiert) darf NICHTS verlieren.**
   Design: zufälliger Archiv-Master-Schlüssel je Konto, **zweifach
   gewrappt**: (a) unter Passwort-KDF (Argon2id + Salt, clientseitig
   gerechnet) für den Login; (b) unter einem **Server-Schrank-Geheimnis
   außerhalb der Datenbank** (Env/Config), das NUR der Reset-Weg zum
   Neu-Verschließen nutzt. Ehrliche Grenze (Michael bekannt): DB-Dieb
   sieht Chiffre; Ganz-Server-Dieb kann 120-Tage-Texte lesen —
   unvermeidbar, wenn Reset ohne Alt-Passwort öffnen können soll.
   Passwort-Wechsel (`/me/password`, altes Passwort nötig) umschließt
   direkt neu.
4. **Anhänge bleiben Durchlauferhitzer** (nach Empfang+Quittung weg,
   wie heute). Fehlender Anhang am anderen Rechner = **Platzhalter mit
   Rückholknopf aus der privaten Cloud-Sicherung**; ohne eingerichtete
   Sicherung nur ein Hinweis „Sicherung einrichten“.
   **Bestand:** der Rückholweg ist in main schon gebaut
   (`web/src/lib/sicherung/archivAnhang.ts`, lazy Anhang-Bytes aus dem
   Archiv, Multi-Ziel Google Drive + Ordner; Einbau in
   `krypto/anhangHolen.ts` als Fallback). Fehlt: sichtbare
   Platzhalter-Kachel mit Knopf + Feinschliff.
5. Login schickt das Passwort heute serverseitig mit
   (`services/auth/src/dcc_auth/routes.py:456`) — die Stufe schützt
   vor Datenbank-/Disk-Diebstahl, nicht vor live kompromittiertem
   Server. Stärkere Variante (SRP/OPAQUE-Login) bewusst NICHT jetzt;
   nur erwähnen, falls Michael je mehr will.
6. Alter Entwurf liegt ungemergt auf `docs/dm-historie-archiv-entwurf`
   (`docs/2026-09-25-dm-historie-verschluesseltes-archiv.md`) — dort
   steht noch „dauerhaft + QR“, oben ist die aktuelle Wahrheit.

**Bau-Reihenfolge vorgeschlagen:** Server (Tabelle `archiv_zeilen` +
Migration 0098, Einlieferung im Sendeweg neben das Postfach, Sweeper,
Wrap-Endpunkte am auth- oder chat-Dienst) → Klient (KDF + Abholen +
Entschlüsseln in den Verlauf, nur für Kanäle ohne lokalen Bestand
nachladen) → UI (Platzhalter-Kachel) → Tests (KDF-Roundtrip importfrei,
Sweeper, Reset-Re-Wrap).

---

## 6. Kurz-Checkliste für den nächsten Rechner

```
git switch merge/mobile-2026-10 && git pull
cd web && pnpm install
# Tests: s. §2 (Web + chat-gateway + voice + shared)
# Dev-Stack: ./scripts/dev-up.fish (Hintergrund, s. AGENTS.md) —
#   beim ersten Mal: Alembic-Stempel s. §2
```

Reihenfolge: §3 Anruf-Fixes → §4 Tuning → Rauchprobe im Dev-Stack
(Anruf zwischen zwei Fenstern, Chat-Öffnen-Scroll, Reaktion auf
verschlüsselter Nachricht) → PR mit Michaels GO → §5 Archiv.
