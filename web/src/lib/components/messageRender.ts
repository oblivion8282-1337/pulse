/**
 * Safe markdown + mention rendering for chat messages.
 *
 * Pipeline:
 *  1. Pre-parse pass replaces the Discord-style mention markup in the raw
 *     content with a sentinel placeholder so marked never sees the raw `<@…>`
 *     (which it would otherwise mangle as autolinks).
 *  2. `marked.parse` turns it into HTML.
 *  3. DOMPurify sanitizes; an afterSanitize hook rewrites our placeholder
 *     `<a href="mention:…">` tags into self-contained `<span class="mention …">`
 *     pills so the live DOM carries no clickable user-controlled hrefs.
 *
 * The mention list is the server's authoritative parse — we resolve display
 * names from the local user/role caches, and fall back to `@unknown` when
 * the target isn't loaded yet (no NULL/undefined crashes).
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Mention } from '$lib/api/types';
import { userCache } from '$lib/stores/users.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { memberRoles } from '$lib/stores/memberRoles.svelte';

const ALLOWED_TAGS = [
  'b', 'i', 'em', 'strong', 'code', 'pre', 'del', 's',
  'a', 'ul', 'ol', 'li', 'br', 'p', 'blockquote', 'span'
];
const ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'data-mention-type', 'data-mention-id', 'data-self'];

// One-time hook setup — DOMPurify is a singleton; we use removeAllHooks
// instead of removeHook(name) so re-imports during HMR don't stack
// duplicate hooks that all rewrite the same node.
let _hooksInstalled = false;
function installHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (href.startsWith('mention:')) {
        // Replace `<a href="mention:user:123">@name</a>` with a self-contained
        // `<span class="mention …">@name</span>`. We mutate in place because
        // DOMPurify hooks operate on the live DOM tree.
        const parts = href.slice('mention:'.length).split(':');
        const type = parts[0];
        const id = parts[1] ?? '';
        const span = node.ownerDocument!.createElement('span');
        const cls = ['mention'];
        if (type === 'user') cls.push('mention--user');
        else if (type === 'role') cls.push('mention--role');
        else if (type === 'everyone') cls.push('mention--everyone');
        if (node.getAttribute('data-self') === '1') cls.push('mention--self');
        span.className = cls.join(' ');
        span.setAttribute('data-mention-type', type);
        if (id) span.setAttribute('data-mention-id', id);
        span.textContent = node.textContent ?? '';
        node.replaceWith(span);
        return;
      }
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Markdown-escape characters that would otherwise break out of the
 * `[label](href)` link syntax. We only need to neutralise `[`, `]`, `\`. */
function mdEscape(s: string): string {
  return s.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/** Resolve a user mention to its display name, with `@unknown` fallback so
 * a missing/uncached user can't crash the render. */
function userMentionLabel(id: string): string {
  const u = userCache.get(id);
  if (!u) {
    // Fire-and-forget queue so the next render picks it up.
    userCache.queue(id);
    return '@unknown';
  }
  return '@' + (u.display_name ?? u.username);
}

/** Resolve a role mention to its name, scoped across every cached guild —
 * the message itself doesn't carry the guild id at render time, so we
 * search the lists we have. */
function roleMentionLabel(id: string): string {
  const r = roles.roleIdMap.get(id);
  if (r) return '@' + r.name;
  return '@unknown-role';
}

/** True when the resolved mention targets the current user — either
 * directly, or via a role the user holds in any guild. Drives the
 * `mention--self` highlight class. */
function isSelfMention(m: Mention): boolean {
  const meId = auth.user?.id;
  if (!meId) return false;
  if (m.type === 0) return m.id === meId;
  if (m.type === 1) {
    const role = roles.roleIdMap.get(m.id);
    if (!role) return false;
    const myRoles = memberRoles.for(role.guild_id, meId);
    return myRoles?.includes(m.id) ?? false;
  }
  // @everyone always targets us when we're a member of the channel the
  // message was posted in — at render time we trust the server's mention
  // list and treat it as a self-highlight.
  return m.type === 2;
}

/**
 * Pre-parse pass: rewrite the raw mention markup into markdown links with
 * a `mention:` href scheme. The marked → DOMPurify pipeline then converts
 * them into `<span class="mention …">` pills.
 */
function rewriteMentions(content: string, mentions: Mention[]): string {
  // Build a lookup so we know which ids are *actually* mentions on the wire
  // — anyone could type `<@123>` in their message; only the server-parsed
  // list gets the pill treatment.
  const userSet = new Set(mentions.filter((m) => m.type === 0).map((m) => m.id));
  const roleSet = new Set(mentions.filter((m) => m.type === 1).map((m) => m.id));
  const hasEveryone = mentions.some((m) => m.type === 2);

  let out = content;
  // Users: `<@123>`
  out = out.replace(/<@(\d+)>/g, (full, id: string) => {
    if (!userSet.has(id)) return full;
    const label = userMentionLabel(id);
    const self = isSelfMention({ type: 0, id }) ? ' "self"' : '';
    return `[${mdEscape(label)}](mention:user:${id}${self})`;
  });
  // Roles: `<@&456>`
  out = out.replace(/<@&(\d+)>/g, (full, id: string) => {
    if (!roleSet.has(id)) return full;
    const label = roleMentionLabel(id);
    const self = isSelfMention({ type: 1, id }) ? ' "self"' : '';
    return `[${mdEscape(label)}](mention:role:${id}${self})`;
  });
  // Everyone / here literals — only treat as mention pills if the server
  // confirmed the everyone-mention on this message.
  if (hasEveryone) {
    out = out.replace(/@(everyone|here)\b/g, (_full, w: string) => {
      return `[${mdEscape('@' + w)}](mention:everyone:0 "self")`;
    });
  }
  return out;
}

/** Marked renders `[label](href "title")` by setting the title attribute;
 * we (ab)use the title slot to flag self-mentions so the sanitizer hook
 * can promote them to `mention--self`. */
function promoteSelfTitleToDataAttr(html: string): string {
  // Convert `title="self"` on any `<a href="mention:…">` into `data-self="1"`
  // before DOMPurify strips title (which is whitelisted, but we want a
  // more obvious marker). Cheap regex — the input is already marked-output,
  // so quoting is well-formed.
  return html.replace(
    /<a href="mention:([^"]+)" title="self">/g,
    '<a href="mention:$1" data-self="1">'
  );
}

/**
 * Client-side mention-marker extraction for the optimistic-send echo.
 * Mirrors `dcc_chat_gateway/mentions.py::parse_markers` so a just-sent
 * message renders its pills immediately, instead of flashing the raw
 * `<@id>` marker until the server's authoritative `mentions` list lands
 * on the WS echo. The server still has the last word — `upsert` swaps
 * the optimistic copy and may drop markers that don't ping a real
 * member/role (non-member, locked role, missing MENTION_EVERYONE).
 */
export function parseMentionMarkers(content: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  const add = (type: 0 | 1 | 2, id: string) => {
    const key = `${type}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, id });
  };
  for (const m of content.matchAll(/<@(\d{1,20})>/g)) add(0, m[1]);
  for (const m of content.matchAll(/<@&(\d{1,20})>/g)) add(1, m[1]);
  if (/@(everyone|here)\b/.test(content)) add(2, '0');
  return out;
}

/**
 * Plain-text mention resolution for previews/snippets — reply quotes, the
 * composer reply banner, notification bodies. Converts the wire markers
 * `<@id>` / `<@&id>` into a readable `@name` with no markdown or HTML, so the
 * result is safe to drop into a plain `{text}` slot. Unlike `rewriteMentions`
 * this resolves *every* marker (no server mention-list needed) — a preview
 * doesn't carry pill semantics, it just shouldn't leak the raw `<@id>` token.
 */
export function plainifyMentions(content: string): string {
  let out = content;
  // Users `<@123>` (the `\d` guard means this never touches role `<@&123>`).
  out = out.replace(/<@(\d{1,20})>/g, (_full, id: string) => userMentionLabel(id));
  // Roles `<@&456>`.
  out = out.replace(/<@&(\d{1,20})>/g, (_full, id: string) => roleMentionLabel(id));
  return out;
}

/**
 * Public render entry point. Safe to call with `mentions=undefined` — the
 * markup pass becomes a no-op and the output matches the legacy renderer.
 */
export function renderMessage(content: string, mentions?: Mention[]): string {
  installHooks();
  const pre = mentions && mentions.length > 0
    ? rewriteMentions(content, mentions)
    : content;
  // marked emits `<p>…</p>`; `breaks: true` so single line-breaks become
  // `<br>`, matching the legacy renderer's behaviour.
  const html = marked.parse(pre, { breaks: true }) as string;
  const withFlag = promoteSelfTitleToDataAttr(html);
  return DOMPurify.sanitize(withFlag, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORCE_BODY: true
  });
}
