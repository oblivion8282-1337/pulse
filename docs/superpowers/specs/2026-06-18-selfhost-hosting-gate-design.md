# Selfhost ④ — Hosting-Freischaltung (Cloud-Gate, Design)

**Datum:** 2026-06-18
**Slice:** ④ (letzte Scheibe von ①–④)
**Status:** Design (autonom; User-Entscheidung 2026-06-18: **„Cloud schaltet pro User frei"** — kein Payment-Provider, der Code prüft nur ein Freischalt-Flag). Kein Emoji. Kein Push auf main ohne Freigabe.

## Ziel

Eine Cloud-kontrollierte, **pro-User**-Freischaltung des Selbst-Hostens. Ohne Freischaltung kann ein User keinen Host-Token erzeugen → kein Pairing → kein Hosting. Das eigentliche „Bezahlen" bleibt vorerst extern/manuell; der Code ist das Gate (das Flag kann später von einer Zahlungs-Integration gesetzt werden — ④ legt den Haken, nicht die Kasse).

## Entscheidung & Abgrenzung

- **Gate = ein boolescher Flag pro User** (`self_host_enabled`, Default `false`) in `auth.users`. Nur Cloud-Admins setzen ihn (bestehendes Admin-User-Patch-Muster). Unabhängig vom Instanz-Antrag/Approval (eine Instanz kann existieren, Hosting aber abgeschaltet sein — z.B. bei „abgelaufenem Abo").
- **Gate-Punkt = `POST /me/instances/{id}/bootstrap-token`** (Mint). `!self_host_enabled` → **403**. Das ist der engste Punkt: ohne frischen Token kein `host.pair` → kein Start. Der Antrag (`submit_instance_application`) bleibt offen (man darf sich bewerben, bevor man freigeschaltet ist). Redeem-seitiges Nach-Prüfen ist bewusst NICHT Teil von ④ (Token ist single-use + 5-Min-TTL; Mint-Gate genügt).
- **Sichtbarkeit:** `/me` (`UserPublic`) trägt `self_host_enabled` → der Renderer weiß Bescheid. `LocalHosting` zeigt bei `!self_host_enabled` eine **ruhige „noch nicht freigeschaltet"-Karte** (statt Start/Antrag-Logik) — menschlich, erklärt knapp, wie man Zugang bekommt. Kein Verstecken (der User soll das Feature + den Weg sehen).
- **Kein neues Payment-SDK, keine neue Dependency.**

## Bestehende Muster (wiederverwenden, nicht doppeln)

- `User`-Flags `is_admin`/`disabled`/`is_suspended` (`models.py`), `server_default text("false")`. Neuer Flag analog. Nächste Migration = **0033**.
- Admin-Toggle: `PATCH /admin/users/{id}` (`routes_admin.py`), `UserAdminPatch`/`UserAdminOut` (`schemas.py`), Guard `_require_admin`, Audit via `_audit()`. Frontend: `AdminUsers.svelte::toggle()` + `adminApi.patchUser()` + `AdminUser`-Type (`admin.ts`).
- `/me` → `UserPublic` (`routes.py`/`schemas.py`); Frontend-Mirror `User` (`api/types.ts`), gehalten in `auth.user` (`stores/auth.svelte.ts`).
- ③c-Mint-Endpoint `mint_bootstrap_token` (`routes_instance_applications.py`) — hier kommt der 403-Check nach `_require_user`.

## Komponenten & Grenzen

**Backend (auth-svc):**
- Migration `0033_user_self_host_enabled`: Spalte `self_host_enabled BOOLEAN NOT NULL DEFAULT false`.
- `User.self_host_enabled` (models.py).
- `UserPublic.self_host_enabled: bool = False` (an `/me` ausgeliefert).
- `UserAdminPatch.self_host_enabled: bool | None = None` + `UserAdminOut.self_host_enabled: bool`; `patch_user` setzt + auditiert ihn (gleiches Muster wie `disabled`).
- `mint_bootstrap_token`: nach `_require_user` → `if not user.self_host_enabled: raise HTTPException(403, "self-hosting not enabled")`.
- pytest: Mint ohne Flag → 403; mit Flag → 201; Admin-Patch flippt den Flag; `/me` spiegelt ihn.

**Frontend:**
- `User`-Type (`api/types.ts`) + `AdminUser`-Type (`api/admin.ts`): `self_host_enabled?: boolean`. `adminApi.patchUser`-Payload-Typ erweitern.
- `AdminUsers.svelte`: dritter Toggle „Selbst-Hosting" (gleiches `toggle()`-Muster). Neue i18n-Keys.
- `LocalHosting.svelte`: ganz oben im `idle`-Zweig — `auth.user?.self_host_enabled === false` → ruhige Sperr-Karte (`local-host-locked`, neue i18n `local_host_locked_*`), die die ③c-Instanz-Logik überdeckt. Bei `true` (oder unbekannt → permissiv? **nein**: Cloud-User haben das Feld immer; Self-Host-Cert-User haben kein `/me` → dort ist LocalHosting ohnehin nicht der Pfad) läuft die bestehende ③c-Logik.
- E2E: `local-hosting.spec.ts` — ein Fall mit `self_host_enabled:false` (über die `/me`-Antwort bzw. den auth-Store) zeigt `local-host-locked` und keinen Start.

## Sicherheit / Robustheit

- Server ist die Wahrheit: der 403-Gate sitzt im Backend; das Frontend-Gate ist nur UX (ein manipuliertes Frontend kommt trotzdem nicht an einen Token). `_require_admin` re-checkt die DB-Spalte (wie bei `is_admin`).
- Default `false` → frische Deploys + Bestands-User sind zu (Opt-in), konsistent mit `allow_guild_creation`.
- Self-Demote-Schutz nicht nötig (kein „letzter Hoster"-Invariant).

## Nicht in ④

- Zahlungs-Provider/Abo-Webhooks (das Flag ist der Anschlusspunkt dafür).
- Redeem-seitiges Entitlement-Nachprüfen.
- Pro-Instanz- statt pro-User-Gating (bewusst pro User).
