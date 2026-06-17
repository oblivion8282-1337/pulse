# Channel Name Styling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow per-channel color/gradient styling of channel names (text + voice), editable by users with MANAGE_CHANNELS, visible everywhere the channel name appears.

**Architecture:** Mirror the existing username-gradient feature exactly. Three nullable columns on the chat-gateway `channels` table (`name_color`, `name_color_secondary`, `name_gradient_angle`). The existing `ChannelPatchIn`/`patch_channel` route gains the three fields with the same hex/angle validation used for profiles. The frontend reuses the already-decoupled `NameColorEditor.svelte` (adding a preset row) inside `RenameChannelDialog.svelte`, and a new `channelNameStyle()` helper renders the stored style anywhere the channel name shows (sidebar, chat header, quick switcher).

**Tech Stack:** FastAPI + SQLAlchemy[asyncio] + Alembic (chat-gateway), pydantic v2; Svelte 5 runes + Tailwind 4 (web); pytest (backend), `pnpm check` + `pnpm build` (frontend — no unit test runner exists).

## Global Constraints

- Hex color regex (copy verbatim, backend + frontend): `^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`
- Gradient angle bounds: integer `0–360` inclusive; default 90° when NULL.
- Alembic revision-id string ≤ 32 chars; chat-gateway schema is `chat`; new revision `0039_channel_name_colors`, down_revision `0038_profile_gradient_angle`.
- New DB columns are nullable (SQLite-test safe, no backfill — NULL = today's plain look).
- Snowflake IDs cross the API as **strings**.
- Permission for editing channel style: `Permissions.MANAGE_CHANNELS` (same as rename), enforced server-side.
- Refactoring must not change behavior — endpoint path `/channels/{channel_id}`, response model `ChannelOut`, and existing `data-testid`s stay identical.
- Code-size policy: source ≤ 350 lines, Svelte components ≤ 250. Split if exceeded.
- No new dependencies.
- Changelog entry required (user-facing). No emojis anywhere. Offer the user style options before writing it.
- Run `code-simplifier` over changed app code, then re-green tests, then `bash .claude/hooks/simplify-stamp.sh` before each commit (CLAUDE.md gate). Tests/migrations/`components/ui/`/docs/changelog are exempt from the gate.
- Local test prerequisite: backend pytest must be prefixed with `REDIS_URL=redis://localhost:6380/0` and `PULSE_INSTANCE_MODE=cloud`.

---

### Task 1: DB columns + migration (chat-gateway `channels`)

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/models/channels.py:34-49`
- Create: `services/chat-gateway/alembic/versions/20260617_1600_0039_channel_name_colors.py`

**Interfaces:**
- Produces: `Channel.name_color: str | None`, `Channel.name_color_secondary: str | None`, `Channel.name_gradient_angle: int | None` (SQLAlchemy mapped columns on the `channels` table, schema `chat`).

- [ ] **Step 1: Add the three columns to the model**

In `models/channels.py`, after the `topic` column (line 43) and before `created_at`, add:

```python
    # Per-channel name styling (mirrors users.profile_color*). NULL = no color
    # (plain default look). Two colors → gradient; one → solid; angle default 90°.
    name_color: Mapped[str | None] = mapped_column(String(32), nullable=True)
    name_color_secondary: Mapped[str | None] = mapped_column(String(32), nullable=True)
    name_gradient_angle: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
```

(`String` and `SmallInteger` are already imported in this file — confirm the import line near the top includes both; if `SmallInteger` is missing, add it to the existing `from sqlalchemy import (...)`.)

- [ ] **Step 2: Create the Alembic migration**

Create `services/chat-gateway/alembic/versions/20260617_1600_0039_channel_name_colors.py`:

```python
"""channel name colors — per-channel name styling

Adds nullable ``name_color`` / ``name_color_secondary`` / ``name_gradient_angle``
to ``channels``. Mirrors users.profile_color*: a channel name can be solid
(one color), a gradient (two colors), at a direction (angle, default 90°).

NULL = no styling (plain default look). Nullable → SQLite-safe add_column.

Revision ID: 0039_channel_name_colors
Revises: 0038_profile_gradient_angle
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0039_channel_name_colors"
down_revision = "0038_profile_gradient_angle"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "channels",
        sa.Column("name_color", sa.String(length=32), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "channels",
        sa.Column("name_color_secondary", sa.String(length=32), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "channels",
        sa.Column("name_gradient_angle", sa.SmallInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("channels", "name_gradient_angle", schema=SCHEMA)
    op.drop_column("channels", "name_color_secondary", schema=SCHEMA)
    op.drop_column("channels", "name_color", schema=SCHEMA)
```

- [ ] **Step 3: Verify the model imports + migration parse**

Run: `cd /home/michael/Dokumente/pulse && uv run python -c "from dcc_chat_gateway.models.channels import Channel; print(Channel.name_color, Channel.name_gradient_angle)" --package dcc-chat-gateway`
Expected: prints the two column attributes without ImportError. If the package flag form differs, instead run `uv run --all-packages python -c "import dcc_chat_gateway.models.channels"` and expect no error.

- [ ] **Step 4: Commit**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/models/channels.py services/chat-gateway/alembic/versions/20260617_1600_0039_channel_name_colors.py
git commit -m "feat(chat): channels name-color columns + migration"
```

(Migration + model column-only change — exempt from the simplifier gate.)

---

### Task 2: Backend schema + patch route + WS serialization

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/schemas.py:139-160` (ChannelOut + ChannelPatchIn)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/channels.py:40-54` (`_channel_dict`) and `:225-256` (`patch_channel`)
- Test: `services/chat-gateway/tests/test_channels.py` (add tests; create if absent — search first with `ls services/chat-gateway/tests/`)

**Interfaces:**
- Consumes: `Channel.name_color`, `Channel.name_color_secondary`, `Channel.name_gradient_angle` (Task 1).
- Produces: `ChannelOut` now serializes `name_color: str | None`, `name_color_secondary: str | None`, `name_gradient_angle: int | None`; `ChannelPatchIn` accepts the same three (validated); `_channel_dict()` includes them in the WS envelope.

- [ ] **Step 1: Write the failing test**

First inspect an existing channel test for the fixtures/helpers in use (auth headers, guild/channel creation): `ls services/chat-gateway/tests/` then read the closest `test_channels*.py`. Mirror its style. Add to that file (or create `test_channel_name_colors.py` using the same fixtures):

```python
import pytest


@pytest.mark.asyncio
async def test_patch_channel_sets_name_gradient(client, owner_headers, guild_channel):
    # guild_channel: a (guild, channel) the owner can manage. Adapt to the
    # fixtures actually present in this test module.
    channel_id = guild_channel.channel_id
    resp = await client.patch(
        f"/channels/{channel_id}",
        json={
            "name_color": "#ff8800",
            "name_color_secondary": "#3b82f6",
            "name_gradient_angle": 135,
        },
        headers=owner_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name_color"] == "#ff8800"
    assert body["name_color_secondary"] == "#3b82f6"
    assert body["name_gradient_angle"] == 135


@pytest.mark.asyncio
async def test_patch_channel_rejects_bad_hex(client, owner_headers, guild_channel):
    resp = await client.patch(
        f"/channels/{guild_channel.channel_id}",
        json={"name_color": "red; font-size:99px"},
        headers=owner_headers,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_patch_channel_rejects_out_of_range_angle(client, owner_headers, guild_channel):
    resp = await client.patch(
        f"/channels/{guild_channel.channel_id}",
        json={"name_gradient_angle": 999},
        headers=owner_headers,
    )
    assert resp.status_code == 422
```

If the module's fixtures differ (likely — check names like `app_client`, `admin_headers`, helper factories), adapt the fixture names/argument shape to match; keep the three assertions identical in intent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/michael/Dokumente/pulse && REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest services/chat-gateway/tests/test_channel_name_colors.py -q`
Expected: FAIL (422→404/500 mismatch or the new fields absent in the 200 body / not validated yet).

- [ ] **Step 3: Extend `ChannelOut`**

In `schemas.py`, inside `class ChannelOut` (after `restricted: bool = False`, before the `@field_serializer`):

```python
    # Per-channel name styling (mirrors profile_color*). NULL = no styling.
    name_color: str | None = None
    name_color_secondary: str | None = None
    name_gradient_angle: int | None = None
```

- [ ] **Step 4: Extend `ChannelPatchIn`**

Replace the body of `class ChannelPatchIn` with:

```python
class ChannelPatchIn(BaseModel):
    name: Annotated[str | None, Field(default=None, min_length=1, max_length=64)] = None
    topic: Annotated[str | None, Field(default=None, max_length=1024)] = None
    # Per-channel name styling. Hex-only (value lands in client `style="…"`):
    # default=... sentinel so model_fields_set distinguishes "not sent" from
    # "set to null" (clearing the color). Same pattern as profile_color.
    name_color: Annotated[
        str | None,
        Field(default=..., pattern=r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"),
    ] = None
    name_color_secondary: Annotated[
        str | None,
        Field(default=..., pattern=r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"),
    ] = None
    name_gradient_angle: Annotated[int | None, Field(default=..., ge=0, le=360)] = None
```

(Confirm `Annotated` and `Field` are already imported in `schemas.py` — they are, since `name`/`topic` use them.)

- [ ] **Step 5: Apply the fields in `patch_channel`**

In `routes/channels.py`, inside `patch_channel`, after the existing `if payload.topic is not None:` block (line ~250) and before `await session.commit()`, add (use `model_fields_set` so an explicit `null` clears, but an omitted field is left untouched):

```python
    fields_set = payload.model_fields_set
    if "name_color" in fields_set:
        channel.name_color = payload.name_color
    if "name_color_secondary" in fields_set:
        channel.name_color_secondary = payload.name_color_secondary
    if "name_gradient_angle" in fields_set:
        channel.name_gradient_angle = payload.name_gradient_angle
```

- [ ] **Step 6: Add the fields to `_channel_dict`**

In `routes/channels.py` `_channel_dict` (line 44-54 dict), add before the closing `}`:

```python
        "name_color": channel.name_color,
        "name_color_secondary": channel.name_color_secondary,
        "name_gradient_angle": channel.name_gradient_angle,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /home/michael/Dokumente/pulse && REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest services/chat-gateway/tests/test_channel_name_colors.py -q`
Expected: PASS (3 passed).

- [ ] **Step 8: Run the full chat-gateway channel test module (no regressions)**

Run: `cd /home/michael/Dokumente/pulse && REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest services/chat-gateway/tests/ -q -k channel`
Expected: PASS (all channel tests green).

- [ ] **Step 9: Simplify + stamp + commit**

Run `code-simplifier` over the two edited non-test files, re-run Step 7-8 to confirm green, then:

```bash
bash .claude/hooks/simplify-stamp.sh
git add services/chat-gateway/src/dcc_chat_gateway/schemas.py services/chat-gateway/src/dcc_chat_gateway/routes/channels.py services/chat-gateway/tests/
git commit -m "feat(chat): accept + serialize channel name colors on PATCH"
```

---

### Task 3: Frontend types, API client, store passthrough

**Files:**
- Modify: `web/src/lib/api/types.ts:55-66` (Channel type)
- Modify: `web/src/lib/api/chat.ts:210-215` (patchChannel payload type)
- Verify: `web/src/lib/stores/guilds.svelte.ts:121` (`updateChannel` already merges `Partial<Channel>` — no change expected)

**Interfaces:**
- Produces: `Channel` type gains `name_color?: string | null`, `name_color_secondary?: string | null`, `name_gradient_angle?: number | null`; `chatApi.patchChannel` payload accepts the same.

- [ ] **Step 1: Extend the `Channel` type**

In `types.ts`, inside `export type Channel`, after `restricted?: boolean;`:

```typescript
  /** Per-channel name styling (mirrors User.profile_color*). null/absent =
   *  plain default look. Two colors → gradient; one → solid; angle default 90°. */
  name_color?: string | null;
  name_color_secondary?: string | null;
  name_gradient_angle?: number | null;
```

- [ ] **Step 2: Widen the `patchChannel` payload type**

In `chat.ts`, change the `patchChannel` signature payload to:

```typescript
  patchChannel(
    channelId: string,
    payload: {
      name?: string;
      topic?: string;
      name_color?: string | null;
      name_color_secondary?: string | null;
      name_gradient_angle?: number | null;
    }
  ): Promise<Channel> {
    return request<Channel>(`/channels/${channelId}`, { method: 'PATCH', body: payload });
  }
```

- [ ] **Step 3: Type-check**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm check`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api/types.ts web/src/lib/api/chat.ts
git commit -m "feat(web): channel name-color fields in type + api client"
```

(Type-only changes; if the simplifier gate triggers on `chat.ts`, run the simplifier + stamp first.)

---

### Task 4: `channelNameStyle()` helper + gradient presets

**Files:**
- Modify: `web/src/lib/utils/nameColor.ts` (add helper + presets at end of file)

**Interfaces:**
- Consumes: existing `sanitizeProfileColor`, `sanitizeGradientAngle`, `gradientTextStyle` (same file).
- Produces:
  - `channelNameStyle(channel: { name_color?: string | null; name_color_secondary?: string | null; name_gradient_angle?: number | null }): string` — inline style string (empty when no color).
  - `NAME_STYLE_PRESETS: { label: string; color1: string; color2?: string; angle?: number }[]` — preset palette for the editor.

- [ ] **Step 1: Add the helper + presets**

Append to `web/src/lib/utils/nameColor.ts`:

```typescript
/** Inline `style` for a channel name from its stored styling fields:
 *  two colors → gradient; one → solid; none → '' (default text color).
 *  Same sanitizers/helper as usernames, so editor preview == real render. */
export function channelNameStyle(channel: {
  name_color?: string | null;
  name_color_secondary?: string | null;
  name_gradient_angle?: number | null;
}): string {
  const c1 = sanitizeProfileColor(channel.name_color);
  const c2 = sanitizeProfileColor(channel.name_color_secondary);
  if (c1 && c2) return gradientTextStyle(c1, c2, sanitizeGradientAngle(channel.name_gradient_angle));
  if (c1) return `color: ${c1}`;
  return '';
}

/** Click-to-apply palette for the name-color editor (profile + channels):
 *  a few solid accents and a few gradients. angle omitted → default 90°. */
export const NAME_STYLE_PRESETS: {
  label: string;
  color1: string;
  color2?: string;
  angle?: number;
}[] = [
  { label: 'Amber', color1: '#f59e0b' },
  { label: 'Rose', color1: '#ec4899' },
  { label: 'Emerald', color1: '#10b981' },
  { label: 'Sky', color1: '#38bdf8' },
  { label: 'Sunset', color1: '#f59e0b', color2: '#ef4444', angle: 90 },
  { label: 'Ocean', color1: '#22d3ee', color2: '#3b82f6', angle: 90 },
  { label: 'Candy', color1: '#a78bfa', color2: '#ec4899', angle: 90 },
  { label: 'Lime', color1: '#a3e635', color2: '#10b981', angle: 90 }
];
```

- [ ] **Step 2: Type-check**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm check`
Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Simplify + stamp + commit**

Run `code-simplifier` on `nameColor.ts`, re-run `pnpm check`, then:

```bash
bash .claude/hooks/simplify-stamp.sh
git add web/src/lib/utils/nameColor.ts
git commit -m "feat(web): channelNameStyle helper + name-style presets"
```

---

### Task 5: Add preset row to `NameColorEditor.svelte`

**Files:**
- Modify: `web/src/lib/components/settings/NameColorEditor.svelte`

**Interfaces:**
- Consumes: `NAME_STYLE_PRESETS` (Task 4); existing bindable props `useColor/color1/useGradient/color2/angle`.
- Produces: a clickable preset row that sets the bindable props. No prop signature change (so existing `SettingsProfile` usage keeps working unchanged).

- [ ] **Step 1: Import presets + add an apply function**

In the `<script>` of `NameColorEditor.svelte`, add to imports:

```typescript
  import { NAME_STYLE_PRESETS } from '$lib/utils/nameColor';
```

After the `previewStyle` `$derived` block, add:

```typescript
  function applyPreset(p: (typeof NAME_STYLE_PRESETS)[number]) {
    useColor = true;
    color1 = p.color1;
    if (p.color2) {
      useGradient = true;
      color2 = p.color2;
      angle = p.angle ?? 90;
    } else {
      useGradient = false;
    }
  }
```

- [ ] **Step 2: Render the preset row**

Inside the `{#if useColor}` block, directly after the closing `</div>` of the ramp bar (the `data-testid="profile-color-ramp"` div, ~line 90) and before the `useGradient` toggle label, add:

```svelte
    <div class="flex flex-wrap gap-1.5" data-testid="name-style-presets">
      {#each NAME_STYLE_PRESETS as p (p.label)}
        <button
          type="button"
          onclick={() => applyPreset(p)}
          title={p.label}
          aria-label={p.label}
          class="border-border size-6 rounded-md border transition-transform hover:scale-110"
          style={p.color2
            ? `background-image: linear-gradient(${p.angle ?? 90}deg, ${p.color1}, ${p.color2});`
            : `background-color: ${p.color1};`}
        ></button>
      {/each}
    </div>
```

- [ ] **Step 3: Type-check + size check**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm check`
Expected: 0 errors, 0 warnings.
Then confirm the file is ≤ 250 lines: `wc -l src/lib/components/settings/NameColorEditor.svelte` (should still be well under). If over, extract presets markup into a tiny child component — unlikely.

- [ ] **Step 4: Simplify + stamp + commit**

Run `code-simplifier` on the component, re-run `pnpm check`, then:

```bash
bash .claude/hooks/simplify-stamp.sh
git add web/src/lib/components/settings/NameColorEditor.svelte
git commit -m "feat(web): preset swatches in name-color editor"
```

---

### Task 6: Wire the editor into `RenameChannelDialog.svelte`

**Files:**
- Modify: `web/src/lib/components/RenameChannelDialog.svelte`

**Interfaces:**
- Consumes: `NameColorEditor` (Task 5), `chatApi.patchChannel` widened payload (Task 3), `sanitizeProfileColor`/`sanitizeGradientAngle`/`DEFAULT_GRADIENT_ANGLE` from `nameColor.ts`.
- Produces: the dialog now also edits + saves channel name colors. The `channel` prop must carry the styling fields (it already receives a `Channel` from the caller; widen its inline type).

- [ ] **Step 1: Widen the `channel` prop type + imports**

In the `<script>`, update imports:

```typescript
  import NameColorEditor from '$lib/components/settings/NameColorEditor.svelte';
  import {
    sanitizeProfileColor,
    sanitizeGradientAngle,
    DEFAULT_GRADIENT_ANGLE
  } from '$lib/utils/nameColor';
```

Change the `channel` prop type to include the styling fields:

```typescript
    channel:
      | {
          id: string;
          name: string;
          topic?: string | null;
          name_color?: string | null;
          name_color_secondary?: string | null;
          name_gradient_angle?: number | null;
        }
      | null;
```

- [ ] **Step 2: Add color state + seed it on open**

Add to the `$state` declarations (near `name`/`topic`):

```typescript
  const DEFAULT_COLOR = '#3b82f6';
  const DEFAULT_SECONDARY = '#a78bfa';
  let useColor = $state(false);
  let color1 = $state(DEFAULT_COLOR);
  let useGradient = $state(false);
  let color2 = $state(DEFAULT_SECONDARY);
  let angle = $state(DEFAULT_GRADIENT_ANGLE);
```

Extend the existing `$effect(() => { if (open && channel) {...} })` to also seed colors:

```typescript
  $effect(() => {
    if (open && channel) {
      name = channel.name;
      topic = channel.topic ?? '';
      const safe1 = sanitizeProfileColor(channel.name_color);
      useColor = !!safe1;
      color1 = safe1 ?? DEFAULT_COLOR;
      const safe2 = sanitizeProfileColor(channel.name_color_secondary);
      useGradient = !!safe1 && !!safe2;
      color2 = safe2 ?? DEFAULT_SECONDARY;
      angle = sanitizeGradientAngle(channel.name_gradient_angle);
    }
  });
```

- [ ] **Step 3: Extend the save to include colors**

Replace the `submit` body's patch-building section. After computing `nameChanged`/`topicChanged`, compute the desired color state and dirty flags, and bail only when nothing changed:

```typescript
    const desiredColor = useColor ? color1 : null;
    const desiredSecondary = useColor && useGradient ? color2 : null;
    const desiredAngle = useColor && useGradient ? angle : (channel.name_gradient_angle ?? null);
    const colorChanged = desiredColor !== sanitizeProfileColor(channel.name_color);
    const secondaryChanged =
      desiredSecondary !== sanitizeProfileColor(channel.name_color_secondary);
    const angleChanged = desiredAngle !== (channel.name_gradient_angle ?? null);

    if (!nameChanged && !topicChanged && !colorChanged && !secondaryChanged && !angleChanged) {
      onClose();
      return;
    }
    const patch: {
      name?: string;
      topic?: string;
      name_color?: string | null;
      name_color_secondary?: string | null;
      name_gradient_angle?: number | null;
    } = {};
    if (nameChanged) patch.name = trimmedName;
    if (topicChanged) patch.topic = newTopic;
    if (colorChanged) patch.name_color = desiredColor;
    if (secondaryChanged) patch.name_color_secondary = desiredSecondary;
    if (angleChanged) patch.name_gradient_angle = desiredAngle;
```

(The existing `busy`/`try`/`chatApi.patchChannel`/`guilds.updateChannel(updated)` block stays as-is — it already merges the returned `Channel`, which now carries the colors.)

- [ ] **Step 4: Render the editor in the dialog body**

Inside the `<form>`, after the topic field and before the submit/cancel buttons, add:

```svelte
    <NameColorEditor
      bind:useColor
      bind:color1
      bind:useGradient
      bind:color2
      bind:angle
      previewName={name || channel?.name || ''}
    />
```

- [ ] **Step 5: Type-check + size check**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm check`
Expected: 0 errors, 0 warnings.
Run: `wc -l src/lib/components/RenameChannelDialog.svelte` — must be ≤ 250. If over, extract the color state/seed/save logic into a small `$lib/channels/nameStyleForm.svelte.ts` helper module and call it from the dialog.

- [ ] **Step 6: Simplify + stamp + commit**

Run `code-simplifier` on the dialog, re-run `pnpm check`, then:

```bash
bash .claude/hooks/simplify-stamp.sh
git add web/src/lib/components/RenameChannelDialog.svelte
git commit -m "feat(web): edit channel name color in rename dialog"
```

---

### Task 7: Render styled channel names (sidebar, header, quick switcher)

**Files:**
- Modify: `web/src/lib/components/ChannelList.svelte:330-332` (text) and `:416-417` (voice)
- Modify: `web/src/lib/components/ChatView.svelte:382` (header name span)
- Modify: `web/src/lib/components/QuickSwitcher.svelte:54-62` (build) and `:149` (render)

**Interfaces:**
- Consumes: `channelNameStyle(channel)` (Task 4).

- [ ] **Step 1: Import the helper in ChannelList + apply to both name spans**

In `ChannelList.svelte` `<script>`, add: `import { channelNameStyle } from '$lib/utils/nameColor';`

Text channel name span (line 331) — add a `style` (keep the existing class/unread logic):

```svelte
              <span class="truncate {isUnread ? 'font-semibold text-text-bright' : ''}" style={channelNameStyle(c)}>{c.name}</span>
```

Voice channel name span (line 417):

```svelte
              <span class="truncate" style={channelNameStyle(c)}>{c.name}</span>
```

(The active/unread background highlight is on the parent button and is unaffected. When a color is set it overrides the default text color — intended.)

- [ ] **Step 2: Apply in the chat header**

In `ChatView.svelte`, import the helper (`import { channelNameStyle } from '$lib/utils/nameColor';` — confirm not already imported) and update the header name span (line 382). Only apply for non-DM channels (DMs have no styling):

```svelte
      <span class="text-text-bright truncate text-lg font-semibold tracking-tight" style={headerKind === 'dm' ? '' : channelNameStyle(channel)} data-testid="active-channel-name">{channel.name}</span>
```

- [ ] **Step 3: Apply in QuickSwitcher**

In `QuickSwitcher.svelte`, import the helper. In the channel-result push (lines 54-62), add a `nameStyle` field:

```typescript
          out.push({
            kind: 'channel',
            key: 'c:' + c.id,
            label: c.name,
            sublabel: g.name,
            channelType: c.type,
            nameStyle: channelNameStyle(c),
            href: `/app/guilds/${g.id}/channels/${c.id}`
          });
```

Add `nameStyle?: string` to the result item's TypeScript type (find the type/interface for the `out` array entries in this file and add the optional field). Then in the render (line 149) apply it:

```svelte
            <span class="truncate" style={r.nameStyle ?? ''}>{r.label}</span>
```

- [ ] **Step 4: Type-check + build**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm check && pnpm build`
Expected: `pnpm check` 0/0; build succeeds.

- [ ] **Step 5: Simplify + stamp + commit**

Run `code-simplifier` on the three components, re-run `pnpm check && pnpm build`, then:

```bash
bash .claude/hooks/simplify-stamp.sh
git add web/src/lib/components/ChannelList.svelte web/src/lib/components/ChatView.svelte web/src/lib/components/QuickSwitcher.svelte
git commit -m "feat(web): render channel name colors in sidebar, header, switcher"
```

---

### Task 8: Changelog entry

**Files:**
- Modify: `web/static/changelog.json`

- [ ] **Step 1: Draft user-facing text + get the style from the user**

Derive a plain, non-technical entry (e.g. title "Kanäle einfärben", item "Einzelne Text- und Sprachkanäle lassen sich jetzt mit einer Farbe oder einem Farbverlauf hervorheben — über das Kanal-Bearbeiten-Menü."). Present 2-3 style options to the user (e.g. Sachlich / Verspielt / Kurz) and let them pick. No emojis.

- [ ] **Step 2: Insert the entry at the top of `entries`**

Add a new object as the first element of the `entries` array, with a unique `id` (date `2026-06-17`; if one already exists for today use `2026-06-17.2`), `date`, the chosen `style`, `title`, and `items[]`.

- [ ] **Step 3: Validate JSON + changelog gate**

Run: `cd /home/michael/Dokumente/pulse && node -e "JSON.parse(require('fs').readFileSync('web/static/changelog.json','utf8')); console.log('ok')"`
Expected: `ok`.
Run: `bash scripts/check-changelog.sh` (if it supports a no-arg/working-tree mode) to confirm the gate is satisfied.

- [ ] **Step 4: Commit**

```bash
git add web/static/changelog.json
git commit -m "docs(changelog): Kanäle einfärben"
```

(Changelog is exempt from the simplifier gate.)

---

### Final verification (before opening a PR)

- [ ] Backend: `cd /home/michael/Dokumente/pulse && REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q` — green (flake-retry per CLAUDE.md if a pub/sub race trips).
- [ ] Frontend: `cd web && pnpm check && pnpm build` — 0/0 and build OK.
- [ ] Manual smoke (user-driven, not automated per repo convention): in a guild, right-click a channel → edit → pick a preset/gradient → save → confirm the name is colored in the sidebar, the chat header, and Ctrl+K; reload → color persists; clear the color → name returns to default.
- [ ] PR only on explicit user go-ahead (merge to main = prod deploy). Use `bash scripts/ship.sh` when greenlit.

## Self-Review Notes

- **Spec coverage:** data model (Task 1), backend validation + route + WS (Task 2), frontend types/API (Task 3), helper + presets (Task 4), editor reuse + presets (Tasks 5-6), rendering in sidebar+header+switcher (Task 7), changelog (Task 8). All spec sections mapped.
- **Editor generalization:** the spec mentioned possibly generalizing `NameColorEditor`; on inspection it is already fully decoupled (bindable props, parent owns save), so no refactor is needed — only the preset row is added. Noted intentionally.
- **Naming consistency:** `name_color` / `name_color_secondary` / `name_gradient_angle` used identically across DB, schema, TS type, API payload, and helper. Helper is `channelNameStyle`; presets `NAME_STYLE_PRESETS`.
- **Open spec questions resolved:** preset palette specified concretely in Task 4; active-state behavior — color overrides default text color, background highlight unchanged (Task 7 Step 1 note).
