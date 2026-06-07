# Live-Test-Plan: Global Friends + neues Einladungs-Modell (Stufen 1–5)

**Branch:** `feat/global-friends-stage1` · **Stand:** 2026-06-08 · statisch verifiziert, **noch nicht live getestet**.

## Voraussetzung
Der neue Code muss **deployed** sein (Push `main` → watchtower auf Cloud + Self-Host). Vorher testet man nur den alten Stand. **Nicht ohne Freigabe deployen.**

Setup: zwei unabhängige CDP-Chrome-Instanzen (getrennte Profile/Ports 9222/9223). Fenster A = **dev** (Owner des Self-Host `pulse.unicutmedia.com`), Fenster B = **dev2**. Passwort beider: `test1234`. Login + Server-Switch lassen sich per Playwright `connectOverCDP` automatisieren (siehe frühere Session-Skripte: Login via `[data-testid=login-identifier/password/submit]`, Server-Switch via `button[aria-label="<host>"]`, ~5 s WS-Ready abwarten).

## Szenarien (jeweils: Schritt → erwartetes Ergebnis)

### 0. Identitäts-Fix (Regression-Smoke)
- dev auf Self-Host, eigene Nachricht in `#general` → **Edit + Delete verfügbar**, **kein „melden"** auf eigener Nachricht. (Vor dem Fix fehlte Edit/Delete, „melden" war da.)
- Owner-Optionen, Watch-Party-Host-Controls, eigene Reaktionen/Mentions hervorgehoben — alle auf dem Self-Host vorhanden.

### 1. Globale Freunde
- dev + dev2 befreunden (Cloud). → In **beiden** Fenstern erscheint der andere in der Freundesliste.
- dev2 auf den Self-Host wechseln → **dieselbe** Freundesliste sichtbar (nicht die alte per-Instanz-Liste). dev2 zurück auf Cloud → Communities/Guilds wieder da (Cached-Ready-Replay, **nicht leer**).
- dev schickt dev2 eine DM während dev2 auf dem Self-Host aktiv ist → **kommt an** (Hintergrund-Dispatch über Cloud).

### 2. Freund-Einladung → Self-Host-Community (B-lite + Auto-Join)
- dev (auf Self-Host, Community „hetzner-cloud") → „Leute einladen" → dev2 auswählen → senden.
- dev2 → Friends/Ausstehend-Tab → **„Beitreten"-Karte** für die Community. (Vorbedingung: befreundet — sonst lehnt der Broker ab.)
- dev2 klickt Beitreten → **Self-Host-Disclaimer** (neuer Host) → bestätigen → **Auto-Join**: Server hinzugefügt + Cert-Login + Instanz- + Community-Mitglied. Karte verschwindet (B-lite-Delete).
- Negativ: Einladung an einen **Nicht-Freund** ist gar nicht erst möglich (Picker zeigt nur Freunde; Broker 403).

### 3. Freund-Einladung → Cloud-Community
- dev (auf Cloud-Community) → „Leute einladen" → dev2 → senden → dev2 nimmt an → **direkt beigetreten** (kein Disclaimer, kein Server-Add).

### 4. Öffentliche Community-Adresse
- dev → Community-Settings → „Öffentliche Adresse" → Handle setzen (z. B. `gaming`) + **Öffentlich** an → Adresse `pulse.unicutmedia.com/c/gaming` wird angezeigt + kopierbar.
- dev2 → „+“ → „Community beitreten“ → Adresse eingeben → (neuer Self-Host → Disclaimer) → **beigetreten**, ohne Freundschaft/Einladung.
- Negativ: Handle einer **nicht-öffentlichen** Community → „nicht gefunden“ (404, kein Leak). Öffentlich-Toggle **ohne Handle** → abgelehnt.
- Cloud-Variante: Cloud-Community öffentlich machen → `howispulse.com/c/<handle>` → dev2 tritt bei. Logged-out + Adresse → Login-dann-Beitreten.

### 5. „Server gesperrt"-Toggle (Stufe 5)
- dev → Admin-Panel → **„Server gesperrt"** an.
- dev2 (noch kein Mitglied) versucht beizutreten — per Freund-Einladung **und** per öffentlicher Adresse → **beide blockiert** (403, „Server nimmt keine neuen Mitglieder auf“).
- Bestehende Mitglieder (dev2, falls schon drin) + dev (Owner) **bleiben** drin und können weiter agieren.
- Toggle wieder aus → Beitritt klappt wieder.
- Prüfen: **kein** alter „Beitritts-Code"-Schritt mehr im „Server hinzufügen"-Dialog; **keine** Join-Mode-Radios/Code-Liste mehr im Admin-Panel.

### 6. Self-Host hat kein eigenes Social mehr (Stufe 1b)
- Auf dem Self-Host gibt es **keine** eigene Freundes-/DM-Ansicht mehr; der „DM senden"-Eintrag im Self-Host-Member-Kontext entfällt (bzw. zielt auf die Cloud).

## Bekannte Default-Entscheidungen (im Test bestätigen / ggf. anpassen)
- Community-Invite-Grant ist **non-consuming** (Re-Auth bricht keinen single-use-Invite).
- Migration mappt altes `join_mode='closed'` **nicht** auf `locked=true` — vormals geschlossene Self-Hosts kommen **entsperrt** zurück (ggf. „Server gesperrt“ neu setzen).
- Handle-Namespace: Slug pro Instanz eindeutig; Squatting/Moderation v1 out-of-scope.
