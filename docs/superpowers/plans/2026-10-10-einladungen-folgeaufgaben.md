# Einladungen — Folgeaufgaben Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Die offenen Punkte aus der Schlussprüfung der Einladungsseite schließen (Memory
`project_einladungsseite_folgeaufgaben`): `/c/`-Links im Chat öffnen den Dialog, öffentliche Self-Host-Adressen
erzeugen funktionierende Links, Abgemeldete sehen auf `/c/` Name und Mitgliederzahl, die angemeldete
Einladungs-Vorschau wird gebremst und die IP-Bremse fasst IPv6 nach /64 zusammen, dazu drei Kleinigkeiten.

**Architecture:** Baut auf dem bestehenden Einladungsweg auf (`web/src/lib/einladung/`, `routes/invite_public.py`).
Keine neuen Abhängigkeiten.

**Spec:** `docs/superpowers/specs/2026-10-10-einladungsseite-design.md` (bindend für Verhalten und Sicherheit);
der Eigentümer hat am 2026-10-10 alle Folgeaufgaben zur selbstständigen Umsetzung freigegeben.

## Global Constraints

- Alle sichtbaren Texte über Paraglide (de + en), Katalog `web/messages/{de,en}.json` append-only (Werte ändern erlaubt).
- Echte Umlaute, keine Emojis; ein Kommentar behauptet nicht mehr, als der Code an dieser Stelle hält.
- `web/src/lib/einladung/{einladungsLink,gemerkt,fehlertext}.ts` bleiben importfrei (Geschwister nur mit `.ts`) und runenfrei.
- Svelte-Komponenten ≤ 250 Zeilen, Quelltext ≤ 350 Zeilen.
- Backend-Tests mit `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0`.
- Kein Einladungscode/Token in Logs.
- Keine Änderung unter `desktop/` (kein Versionssprung nötig).

## Bewusst nicht in diesem Plan

- **Remote-Dev-Stack-CSP** (Datei auf dem gemeinsamen Hetzner-Server, nicht im Repo): ein Eingriff dort bei
  Abwesenheit des Eigentümers riskiert den gemeinsamen Dev-Stack (Skript-Hashes der CSP); nur dokumentiert.
- **Server-App-Versionssprung** für `pulse:` in der Self-Host-Caddyfile-Vorlage: Release-Entscheidung, praktisch
  folgenlos (der Self-Host liefert keine Einladungsseite aus).
- **„Community öffnen“ schaltet nicht auf den Self-Host um**: bereits gelöst — `web/src/routes/app/+layout.svelte`
  richtet den aktiven Server an der Gilde in der Route aus (`serverGuilds.serverIdForGuild`).
- Handprüfungen (Windows/macOS-`pulse://`, Safari, Android, E-Mail-Bestätigung): brauchen Geräte/Eigentümer.

---

### Task 1: `/c/`-Links im Chat öffnen den Dialog (+ Testlücken des Parsers)

**Files:** `web/src/lib/einladung/einladungsLink.ts`, `web/src/lib/einladung/linkKlick.ts`,
`web/src/lib/einladung/EinladungDialog.svelte` (nur falls nötig), `web/test/einladung-link.test.ts`,
`web/tests/e2e/einladung-adresse.spec.ts`.

**Requirements:**
- Neue reine Funktion `adresseAusUrl(url: string, cloudHost: string, seitenHost: string): Adresse | null` —
  erkennt `…/c/<handle>[/][?…host=<fqdn>…]` mit denselben Origin-Regeln wie `einladungAusUrl` (nur Cloud-Host oder
  Seiten-Host, http/https), Handle klein geschrieben und per `istGueltigerHandle` geprüft, Host per `zielHost`
  (ungültig → null). Und `zielAusUrl(url, cloudHost, seitenHost): Ziel | null` = Einladung oder Adresse.
- Dialog-Adressparameter für Adressen: `mitEinladung(pfadUndSuche, z: Ziel)` setzt für eine Adresse
  `einladung_adresse=<handle>` (und `einladung_host` wie bisher) und entfernt `einladung`; für einen Code umgekehrt.
  `ohneEinladung` entfernt alle drei. `einladungAusParametern` liefert `Ziel | 'kaputt' | null` und erkennt
  `einladung_adresse`. Alle bisherigen Aufrufer (Dialog, `linkKlick.ts`, `deepLink.ts`) bleiben typkorrekt.
- `linkKlick.ts` fängt auch `/c/`-Links ab (`zielAusUrl`), sonst unverändert (nur schlichter Linksklick).
- Die Karte unter einer Nachricht (InviteEmbed) bleibt nur für Einladungscodes — keine neue Karte für `/c/`.
- Unit-Tests: `adresseAusUrl` (Cloud, Seiten-Host, Self-Host-`?host=`, fremde Domain → null, Großschreibung →
  klein, ungültiger Handle → null, Schrägstrich am Ende), `zielAusUrl`, `mitEinladung`/`ohneEinladung`/
  `einladungAusParametern` für Adressen; dazu die alten Testlücken: `?host=howispulse.com` über
  `einladungAusUrl` → Cloud, Hash bleibt bei `mitEinladung`/`ohneEinladung` erhalten, `/invite/<code>/`
  mit Schrägstrich am Ende, Label mit 63 Zeichen gültig / 64 ungültig.
- E2E in `einladung-adresse.spec.ts`: Alice postet im Kanal eine Nachricht mit dem `/c/<handle>`-Link der
  öffentlichen Community, ein angemeldeter Nicht-Mitglied-Nutzer klickt ihn → Adresse enthält
  `einladung_adresse=`, Dialog zeigt den Community-Namen, kein neuer Tab (`context.pages().length === 1`).

### Task 2: Öffentliche Self-Host-Adressen erzeugen funktionierende Links

**Files:** `web/src/lib/guilds/inviteLink.ts`, `web/src/lib/components/settings/GuildPublicAddressEditor.svelte`,
ggf. ein Unit-Test, falls die Logik importfrei herausgezogen wird.

**Requirements:**
- Heute: `GuildPublicAddressEditor.svelte:65` kopiert `<aktiver-Server-Host>/c/<handle>`; auf einem Self-Host
  liefert `https://<selfhost>/c/<handle>` eine leere Seite (der Self-Host-Caddy liefert kein Web-UI aus).
- Neu: dieselbe Regel wie `inviteLink.ts`: `${window.location.origin}/c/<handle>` für die Cloud,
  `${window.location.origin}/c/<handle>?host=<nackter Host>` für einen Self-Host. Als Funktion
  `oeffentlicheAdresse(handle: string): string` neben `inviteLink` in `web/src/lib/guilds/inviteLink.ts`.
- Die sichtbare Vorsilbe vor dem Eingabefeld zeigt den Origin der App (`location.host`/c/), nicht den Self-Host;
  bei einem Self-Host zusätzlich ein kurzer Hinweis, dass der kopierte Link `?host=…` trägt, NUR falls ohne
  neuen Text nicht verständlich — wenn ein Text nötig ist, neuer Paraglide-Schlüssel de+en.
- `grep -rn "/c/" web/src --include='*.svelte' --include='*.ts'` auf weitere Erzeuger prüfen und mitziehen.

### Task 3: Kleinkram im Web

**Files:** `web/src/lib/guilds/joinByInvite.ts`, `web/src/lib/einladung/{EinladungDialog.svelte,EinladungKarte.svelte,linkKlick.ts,deepLink.ts}`,
ggf. neues importfreies Modul + Unit-Test.

**Requirements:**
1. `parseJoinInput`: `decodeURIComponent` auf `host=` wirft bei kaputtem `%`-Escape einen `URIError`, der roh
   beim Nutzer landet. In `try/catch` fassen; ein nicht dekodierbarer Host gilt als ungültig → derselbe Fehler
   `m.einladung_host_ungueltig()` wie bei einem abgelehnten Host.
2. Verlaufseintrag beim Schließen: Öffnet `linkKlick.ts` oder `deepLink.ts` den Dialog per `goto` OHNE
   `replaceState` (neuer Verlaufseintrag), entfernt Schließen heute den Parameter mit `replaceState` — Zurück
   führt dann auf denselben Eintrag mit `?einladung…` und öffnet den Dialog erneut. Neu: merkt sich das
   Öffnen per Push (modulweit, z. B. in einem kleinen Modul `web/src/lib/einladung/verlauf.ts`: die URL, die
   wir selbst gepusht haben); beim Schließen gilt: steht die aktuelle Adresse genau auf dieser selbst gepushten
   URL, `history.back()`, sonst wie bisher `replaceState`. Beim Beitreten/Öffnen der Community die Markierung
   verwerfen.
3. Barrierefreiheit: Im Dialog-Rahmen trägt die Karte heute ein `<h1>` neben dem `sr-only`-`Dialog.Title`.
   Im Rahmen `dialog` `<h2>` statt `<h1>` (z. B. `<svelte:element this={…}>`); im Rahmen `karte` bleibt `<h1>`.
   Karte ≤ 250 Zeilen.
- E2E: bestehende Tests grün; für Punkt 2 ein Test in `einladungsseite.spec.ts`: Chat-Link klicken → Dialog
  schließen (Escape) → `page.goBack()` öffnet den Dialog NICHT wieder (Adresse ohne `einladung`, kein Dialog).

### Task 4: Bremse für die angemeldete Vorschau, IPv6 nach /64

**Files:** `services/chat-gateway/src/dcc_chat_gateway/{client_ip.py,ratelimit.py,routes/invites.py,routes/invite_public.py,routes/gast.py}`,
Tests unter `services/chat-gateway/tests/`.

**Requirements:**
- `client_ip.py`: neue Funktion `bremsen_schluessel(ip: str) -> str` — IPv6 → das /64-Netz als String
  (`ipaddress.ip_network(f"{ip}/64", strict=False)`), IPv4 und Unparsbares unverändert. Kommentar: warum (/64
  ist die kleinste übliche Zuteilung an einen Anschluss; je Adresse zu zählen gäbe jedem Anschluss Milliarden
  Eimer).
- Überall, wo eine anonyme Bremse nach IP zählt, den Schlüssel darüber bilden: `routes/invite_public.py`
  (`_bremsen`), `routes/gast.py` (`_absender_ip` bzw. die Stelle, an der der IP-Schlüssel für
  `gaeste.bremse_pruefen` entsteht). `internal_secret` bleibt unverändert (Dienstverkehr).
- `ratelimit.py`: neue Regel `"invite_preview": (120, 60.0)` (120 Vorschauen / Minute je Nutzer) mit
  Kommentar; `GET /invites/{code}` (`routes/invites.py`) prüft sie vor dem DB-Zugriff → 429
  `rate limit exceeded` (dieselbe Formulierung wie die Erzeugungsbremse).
- Tests: Unit-Test für `bremsen_schluessel` (IPv4 unverändert, zwei IPv6 aus demselben /64 → gleicher
  Schlüssel, aus verschiedenen /64 → verschieden, Müll unverändert); Route-Test: die 121. Vorschau eines
  Nutzers in einer Minute → 429; `test_invite_public.py` und Gast-Tests bleiben grün. Die In-Prozess-Bremse
  zwischen Tests zurücksetzen (wie bestehende Ratelimit-Tests es tun — nachsehen).

### Task 5: Anonyme Vorschau für `/c/<handle>`

**Files:** `services/chat-gateway/src/dcc_chat_gateway/routes/public_community.py` (oder neue Datei
`routes/public_community_preview.py`, falls die Datei über 350 Zeilen käme), `routes/__init__.py`,
Test `services/chat-gateway/tests/test_public_community_preview.py`, `web/src/lib/api/chat.ts`,
`web/src/lib/einladung/laden.ts`, `web/tests/e2e/einladung-adresse.spec.ts`.

**Requirements:**
- Neue anonyme Route `GET /c/{handle}/public-preview` → `{ guild: { name, icon_url }, member_count }` —
  eigene Route (nicht optionale Anmeldung an `GET /c/{handle}`), dieselben Regeln wie
  `routes/invite_public.py`: Bremse in Redis je IP (über `bremsen_schluessel`, 30/min) und je Handle
  (60/min), gleiche 404 `community not found` für unbekannt, privat (`is_public = false`) und gesperrt
  (`suspended_at`); keine `guild.id`-Feld, kein `is_public`. Handle-Pfad max. 64 Zeichen. Docstring nennt,
  dass `icon_url` die Guild-ID im Bildpfad trägt (Bild ist ohnehin öffentlich), wie bei `invite_public.py`.
- Datenschutz-Abwägung im Docstring: wer einen öffentlichen Handle kennt, darf laut Produktregel beitreten;
  dieselbe Vorschau bekam bisher schon jedes (kostenlose) Konto; die Bremse verhindert billiges Abtasten des
  Handle-Raums.
- Tests analog `test_invite_public.py` (Felder exakt, alle 404-Fälle gleich, Bremse je IP und je Handle,
  keine Anmeldung nötig).
- Web: `chatApi.getPublicCommunityPublicPreview(handle, route)` mit `{ auth: false }`;
  `laden.ts::ladeAdresse` für Abgemeldete und Cloud-Adressen → Name, Bild, Mitgliederzahl; 404 → `ungueltig`;
  Bremse/Netz → wie heute (nur der Handle als Name); Self-Host-Adressen weiterhin ohne Abruf.
- E2E: abgemeldet `/c/<handle>` zeigt den Community-Namen (nicht nur den Handle); abgemeldet unbekannter
  Handle → `ungueltig`.

## Abschluss

Nach allen Tasks: code-simplifier (Controller), eine Gesamtprüfung auf dem stärksten Modell, eine Korrekturrunde
falls nötig, `bash scripts/gate.sh`, Stempel, Memory `project_einladungsseite_folgeaufgaben` aktualisieren,
CLAUDE.md-Abschnitt „Einladungslinks“ um die anonyme `/c/`-Vorschau und den Adress-Parameter ergänzen,
Landen per `bash scripts/ship.sh` (Freigabe des Eigentümers liegt vor: „selbstständig ohne Pause fertig“).
Kein Changelog-Eintrag (Verfeinerungen desselben Themas am selben Tag; ein vierter Hinweis an einem Tag wäre
Rauschen).
