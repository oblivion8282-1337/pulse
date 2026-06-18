# Selfhost ④ — Hosting-Freischaltung (Cloud-Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Eine pro-User-Freischaltung (`self_host_enabled`), die das Cloud-Admin setzt; ohne sie kann kein Host-Token gemintet werden (403) → kein Pairing → kein Hosting. Sichtbar als ruhige „noch nicht freigeschaltet"-Karte im Renderer.

**Architecture:** Boolescher Flag auf `auth.users` (Default false), gegated am `mint_bootstrap_token`-Endpoint, ausgeliefert über `/me`, geschaltet über das bestehende Admin-User-Patch-Muster, gespiegelt im Frontend-`auth.user` und im LocalHosting-Idle-Gate.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (auth-svc), pydantic v2, pytest; Svelte 5 Runes, Paraglide-i18n, Playwright. Keine neue Dependency.

## Global Constraints

- **Baut auf ③c** (Branch `feat/selfhost-cloud-pairing`). ④ stackt darauf.
- **Server ist die Wahrheit:** der 403-Gate sitzt im Backend; das Frontend-Gate ist nur UX.
- **Default `false`** (Opt-in; Bestands-User + frische Deploys sind zu).
- **Keine neue Dependency. Keine Emojis. Quell-Dateien ≤350 Z., Svelte-Components ≤250 Z.** i18n de+en gepflegt, warm, kein Jargon.
- **Naming:** Spalte/Feld heißt überall `self_host_enabled` (snake_case Backend + JSON).
- **Verifikation gesamt:** Backend `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q services/auth` grün; Frontend `cd web && pnpm check` (0/0) + `pnpm build` + `pnpm exec playwright test local-hosting`.
- Kein Push auf main ohne Freigabe.

## Bekannte Fixpunkte (aus der Exploration)

- `User` (`services/auth/src/dcc_auth/models.py`): Flags via `mapped_column(Boolean, nullable=False, server_default=text("false"), default=False)`.
- Letzte Migration: `services/auth/alembic/versions/20260617_1600_0032_instance_relay_provisioning.py` (rev `0032`) → neue = **`0033`**, `down_revision="0032"`.
- `UserPublic` (`schemas.py:60`), `UserAdminPatch` (`schemas.py:139`), `UserAdminOut` (`schemas.py:120`).
- `patch_user` (`routes_admin.py:111`), Guard `_require_admin`, `changes`/`_audit`-Muster.
- `mint_bootstrap_token` (`routes_instance_applications.py:357`), `_require_user` liefert `User`.
- Frontend: `User` (`web/src/lib/api/types.ts:7`), `AdminUser` (`web/src/lib/api/admin.ts:16`), `adminApi.patchUser` (`admin.ts:206`), `AdminUsers.svelte::toggle()` (`:57`), `auth.user` (`web/src/lib/stores/auth.svelte.ts`, `import { auth } from '$lib/stores/auth.svelte'`).

---

### Task 1: Backend — Flag, Migration, /me, Admin-Patch, Mint-Gate

**Files:**
- Modify: `services/auth/src/dcc_auth/models.py` (User-Spalte)
- Create: `services/auth/alembic/versions/20260618_..._0033_user_self_host_enabled.py`
- Modify: `services/auth/src/dcc_auth/schemas.py` (UserPublic + UserAdminPatch + UserAdminOut)
- Modify: `services/auth/src/dcc_auth/routes_admin.py` (`patch_user`)
- Modify: `services/auth/src/dcc_auth/routes_instance_applications.py` (`mint_bootstrap_token`-Gate)
- Test: `services/auth/tests/` (neuer Test oder bestehende Mint-/Admin-Testdatei erweitern)

**Interfaces:**
- Produces: `User.self_host_enabled: bool`; `UserPublic.self_host_enabled: bool`; `UserAdminPatch.self_host_enabled: bool | None`; `UserAdminOut.self_host_enabled: bool`; 403 an `mint_bootstrap_token` wenn `!self_host_enabled`.

- [ ] **Step 1: Test schreiben (failing)** — in der passenden Test-Datei (z.B. die bestehende für `mint_bootstrap_token` / Instances; sonst neu `tests/test_self_host_gate.py`). Mit dem bestehenden conftest-User-Fixture-Muster:
  - `test_mint_requires_self_host_enabled`: User mit genehmigter Instanz, `self_host_enabled=false` → `POST /me/instances/{id}/bootstrap-token` → **403**.
  - `test_mint_succeeds_when_enabled`: derselbe Aufbau, Flag `true` → **201** + Token.
  - `test_admin_patch_toggles_self_host`: Admin `PATCH /admin/users/{id}` mit `{"self_host_enabled": true}` → 200, `UserAdminOut.self_host_enabled == true`; DB-Spalte gesetzt.
  - `test_me_exposes_self_host_enabled`: `GET /me` enthält `self_host_enabled`.
  (Genaue Fixture-/Client-Helfer aus den vorhandenen Tests in `services/auth/tests/` übernehmen — Muster nicht neu erfinden.)

- [ ] **Step 2: Run, verify fail** — `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q services/auth/tests/<datei> -k "self_host"`. Expected: FAIL (Spalte/Feld fehlt).

- [ ] **Step 3: Model + Migration** —
  - `models.py` User: `self_host_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"), default=False)` (neben `is_suspended`).
  - Migration `0033` (Kopf wie 0032: `revision="0033"`, `down_revision="0032"`): `op.add_column("users", sa.Column("self_host_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")))`; `downgrade` droppt die Spalte. (SQLite-Tests: die conftest-Migration/`create_all` muss die Spalte sehen — da sie am Model hängt, deckt `create_all` sie ab; die Alembic-Migration ist für Prod/asyncpg.)

- [ ] **Step 4: Schemas** —
  - `UserPublic`: `self_host_enabled: bool = False`.
  - `UserAdminPatch`: `self_host_enabled: bool | None = None`.
  - `UserAdminOut`: `self_host_enabled: bool` (+ default `= False` falls die anderen Felder Defaults haben — an `disabled` orientieren).

- [ ] **Step 5: Admin-Patch** — in `patch_user` analog zum `disabled`-Block:
```python
if payload.self_host_enabled is not None and payload.self_host_enabled != user.self_host_enabled:
    changes["self_host_enabled"] = {"from": user.self_host_enabled, "to": payload.self_host_enabled}
    user.self_host_enabled = payload.self_host_enabled
```
  (kein Self-Demote-Schutz nötig.)

- [ ] **Step 6: Mint-Gate** — in `mint_bootstrap_token` direkt nach `user = await _require_user(request, db)`:
```python
if not user.self_host_enabled:
    raise HTTPException(status.HTTP_403_FORBIDDEN, detail="self-hosting not enabled")
```

- [ ] **Step 7: Run, verify pass** — `REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q services/auth` grün (neue Tests + volle auth-Regression).

- [ ] **Step 8: Commit** — `git commit -m "feat(auth): self_host_enabled-Flag — Cloud-Gate fürs Hosting (Mint-403 + Admin-Toggle + /me)"`

---

### Task 2: Frontend Admin — Toggle „Selbst-Hosting" pro User

**Files:**
- Modify: `web/src/lib/api/types.ts` (`User`)
- Modify: `web/src/lib/api/admin.ts` (`AdminUser` + `patchUser`-Payload)
- Modify: `web/src/lib/components/admin/AdminUsers.svelte`
- Modify: `web/messages/de.json` + `web/messages/en.json`

**Interfaces:**
- Consumes: `adminApi.patchUser(id, { self_host_enabled })` (Backend Task 1).
- Produces: ein dritter Toggle pro User-Zeile, der `self_host_enabled` schaltet.

- [ ] **Step 1: Typen** — `User` (`types.ts`): `self_host_enabled?: boolean;`. `AdminUser` (`admin.ts`): `self_host_enabled: boolean;`. `patchUser`-Payload-Typ: `{ is_admin?: boolean; disabled?: boolean; self_host_enabled?: boolean }`.

- [ ] **Step 2: i18n** — de+en: `admin_users_self_host_label` („Selbst-Hosting"), `admin_users_self_host_updated` („Hosting-Freischaltung aktualisiert."). Keine Emojis.

- [ ] **Step 3: AdminUsers.svelte** — den `toggle()`-Aufruf um `'self_host_enabled'` erweitern (die `field`-Union ergänzen) und einen dritten Toggle/Schalter in der Zeile rendern, analog zum bestehenden `disabled`/`is_admin`-Control. `data-testid="admin-user-selfhost-toggle"`. Component bleibt ≤250 Z. (falls nicht: kleinste sinnvolle Extraktion).

- [ ] **Step 4: Verify** — `cd web && pnpm check` (0/0) + `pnpm build`.

- [ ] **Step 5: Commit** — `git commit -m "feat(web): Admin-Toggle für Hosting-Freischaltung pro User"`

---

### Task 3: Frontend Gate — ruhige Sperr-Karte in LocalHosting + E2E

**Files:**
- Modify: `web/src/lib/components/account/LocalHosting.svelte`
- Modify: `web/messages/de.json` + `web/messages/en.json`
- Modify: `web/tests/e2e/local-hosting.spec.ts`

**Interfaces:**
- Consumes: `auth.user?.self_host_enabled` (`import { auth } from '$lib/stores/auth.svelte'`).
- Produces: bei `self_host_enabled === false` eine Sperr-Karte statt der ③c-Idle-Logik.

- [ ] **Step 1: i18n** — de+en: `local_host_locked_title` („Hosting ist noch nicht freigeschaltet"), `local_host_locked_body` (warm, erklärt knapp, wie man Zugang bekommt — z.B. „Selbst-Hosting wird für dein Konto freigeschaltet, sobald es bereitsteht. Melde dich, wenn du loslegen möchtest."). Keine Emojis, kein Jargon.

- [ ] **Step 2: LocalHosting.svelte** — im `{#if hostStore.phase === 'idle'}`-Zweig ganz oben:
```svelte
{#if auth.user && auth.user.self_host_enabled === false}
  <div class="flex flex-col gap-2" data-testid="local-host-locked">
    <p class="text-text-bright text-sm font-medium">{m.local_host_locked_title()}</p>
    <p class="text-text-muted text-sm">{m.local_host_locked_body()}</p>
  </div>
{:else if hostStore.instances.length === 0 && !hostStore.paired}
  … (bestehende ③c-Logik unverändert) …
```
  `import { auth } from '$lib/stores/auth.svelte'` ergänzen. Die running/live/error-Zweige + bestehende `data-testid`s bleiben unverändert. (Hinweis: `=== false` explizit — bei `undefined`/Cert-User nicht sperren, dort ist LocalHosting ohnehin nicht der Pfad.)

- [ ] **Step 3: E2E** — `local-hosting.spec.ts`: ein Test, in dem `auth.user.self_host_enabled` false ist → `local-host-locked` sichtbar, `local-host-start` NICHT. Den auth-User im Test setzen: entweder die `/api/auth/me`-Antwort per `page.route` mit `self_host_enabled:false` fulfillen, ODER nach dem Login per `page.evaluate` `auth.setUser({...self_host_enabled:false})` über den Vite-Dev-Import (`/src/lib/stores/auth.svelte.ts`). Die bestehenden Pairing-Tests bekommen `self_host_enabled:true` (über dieselbe `/me`-Route oder den auth-Store), damit ihre `local-host-start`-Assertions weiter gelten. **Assertions nicht abschwächen.** Den robustesten Weg wählen; falls das auth-User-Setzen im Test spröde ist, dokumentieren.

- [ ] **Step 4: Verify** — `cd web && pnpm check` (0/0) + `pnpm build` + `pnpm exec playwright test local-hosting` (grün; Cold-Start 1× neu).

- [ ] **Step 5: Commit** — `git commit -m "feat(web): ruhige Sperr-Karte bei nicht freigeschaltetem Hosting + E2E"`

---

## Self-Review

- **Spec-Coverage:** Flag+Migration+/me+Admin-Patch+Mint-403 (Task 1) · Admin-UI-Toggle (Task 2) · Renderer-Sperr-Karte + E2E (Task 3).
- **Kein Doppel:** wiederverwendet das `disabled`/`is_admin`-Admin-Muster + die ③c-Idle-Logik (Sperr-Karte sitzt davor, ersetzt nichts).
- **Server-Wahrheit:** der echte Gate ist der 403 in Task 1; Task 3 ist nur UX.
- **Platzhalter:** keine TBD; das E2E-auth-User-Setzen ist als „robustesten Weg, nicht abschwächen" markiert.
- **Typ-Konsistenz:** `self_host_enabled` snake_case durchgängig (Backend-Model/Schema/JSON ↔ Frontend `User`/`AdminUser`); `patchUser`-Payload ↔ `UserAdminPatch`.
