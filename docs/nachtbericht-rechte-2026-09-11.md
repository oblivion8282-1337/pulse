# Nachtbericht Rechte-Management — 2026-09-11

Lauf: `scripts/nachtlauf.sh` um 08:11 (per Hand gestartet — der geplante 23:00-Job
war um eine Nacht versetzt und wurde gelöscht). Geprüfter Stand: `a0ffa930`
(lokale Commits ohne Push; Backend-Code unverändert zu `origin/main`).

## Ergebnis in einem Satz

Das Rechte-System selbst ist dicht — aber der Lauf hat **auf origin/main
vorhandene rote Tests** gefunden, die mit den UI-Refactors von 2026-09-10
ausgeliefert wurden: 5 Pytest- und etwa 10 E2E-Specs. Das lokale Test-Gate
lief zwischen den Merges nicht, und die CI fährt die chat-gateway-Pytests
bewusst nicht (Test-Gate ist lokal, CLAUDE.md).

## Teil 1: Gate (Backend-Pytest + pnpm check/build/test:unit)

**2624 passed, 5 failed** — alle fünf im REMOTE_CONTROL-Umfeld, alle dieselbe
Wurzel: `f3dff047` („Fernsteuerung anfragen in neuen Communitys standardmäßig
an") machte REMOTE_CONTROL zum @everyone-Default für neue Communitys; die
Tests nahmen noch stillschweigend das Fehlen des Bits an und fielen auf
4052 (host not reachable) statt 4051 (no access).

| Test | Befund |
|---|---|
| test_remote_handlers::test_request_requires_remote_control_bit | 4052 statt 4051 |
| test_remote_handlers::test_request_is_throttled_per_connection | 4052 statt 4051 (erste Anfrage) |
| test_remote_guard::test_audit_uses_the_real_permission_resolution | Wache beendet nicht (Bit ja jetzt da) |
| test_devices::test_wecken_verlangt_remote_control | 4061 statt 4060 |
| test_device_grants::test_freigabe_rettet_fehlendes_remote_control_nicht | 4052 statt 4051 |

**Gefixt** in Commit `807fb37a`: gemeinsamer Helfer
`everyone_remote_control_entfernen` (conftest) entfernt das Bit explizit im
Setup — Testabsicht unverändert, jetzt als ausdrücklicher Schritt statt als
Annahme über den Default. Alle 97 Tests der vier Dateien grün.

`pnpm check`/`build`/`test:unit`: grün.

## Teil 2: Playwright E2E (komplette Suite lokal)

**144 passed, 14 failed.** Drei Gruppen:

### A. UI-Refactor-Rückstand von 2026-09-10 (rot auch auf origin/main, verifiziert)

- `roles.spec.ts:116` — sucht `role-name-input`; das Feld gibt es nach
  „Rollen und Mitglieder auf einer Fläche" (5b7ed3d0) nicht mehr in der
  alten Form. **Spec-Schuld.**
- `mobile-shell/mobile-rooms/mobile-chats/mobile-treffflaechen` — suchen u. a.
  `mobile-tab-bar`; die Geräte-Ansicht-Umstellung (80f3d668, „Ansicht folgt
  dem Gerät statt der Fensterbreite") hat die Mobile-Layout-Regeln geändert.
  **Spec-Schuld.**
- `plugins.spec.ts:205` — navigiert auf `/app/guilds//channels/_` (leere IDs),
  Flow nach dem Rail-Panel-Umbau (eaa4460d) anders. **Spec-Schuld.**
- `dms.spec.ts:176`, `friends.spec.ts:123` — DM-Öffnen/Senden-Fluss hängt
  (message-input nicht treffbar / localStorage-Zugriff nach Redirect).
  **Verdacht Spec-Schuld, im Einzelnen noch nicht zugeordnet.**
- `selfhost-einstieg.spec.ts:76` — waitForURL-Rennen nach /app/friends.
  **Verdacht Flake/Refactor, offen.**

### B. Bekannte maschinenlokale Flakes (mehrfach bestätigt, auch auf vor-fixigem Code)

- `e2e-dm.spec.ts:374` — „kein Umschlag im Postfach gefunden" (Quittungs-Race).
- `verlauf-lokal.spec.ts:234` — message-input „element was detached" (reproduzierbar
  nur auf diesem Rechner; dreifach abgesichert inkl. Stand 6316bb43).
- `e2e-ablage-kanal.spec.ts:329` — selbe Umschlag-Race-Bauart wie e2e-dm.

### C. Remote-Stack-Specs im lokalen Lauf

`e2e-dm-hetzner`, `e2e-dm-hintergrund-hetzner`, `e2e-dm-verlauf-hetzner` liefen
im lokalen Lauf mit und schlugen fehl — sie gehören in die Hetzner-Config
(`playwright.hetzner.config.ts`). Die `testIgnore`-Liste der lokalen Config
nennt nur `e2e-dm-hetzner.spec.ts`; die anderen beidenHetzner-Specs fehlen
dort. **Konfigurationslücke, kein Produktionsbefund.**

## Rechte-Management im engeren Sinn

Kein einziges Loch: `rechte-pro-person.spec.ts` (9 Fälle inkl. Voice-Bits pro
Person, Einzel-Ausnahmen, Rollen an Einzelne, Reorder-Hierarchie),
`channel-permissions`, `admin`, `gast-link`, `dropbox` grün. Die 5
Pytest-Funde sind Test-Schuld, kein Enforcemen-Defekt — der Server verhielt
sich in allen Fällen korrekt nach dem NEUEN Default.

## Empfehlungen

1. Die A-Gruppe (Spec-Schuld aus den Refactors) reparieren — gern als nächste
   Arbeitseinheit; die Refactor-Commits haben keine Spec-Mitgift gebracht.
2. Die beiden fehlenden Hetzner-Specs in `testIgnore` der lokalen Config
   aufnehmen (Einzeiler).
3. Überlegen, ob die `check-changelog`-Logik analog an Tests erinnern könnte:
   Refactor-Commits, die Testids/Flows ändern, landen sonst still rot.
