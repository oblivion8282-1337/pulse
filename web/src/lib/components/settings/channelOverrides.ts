/**
 * API-side actions for ChannelOverridesEditor — create/exclude logic and
 * the channelPermissions cache merge live here so the component stays
 * within the size policy and only owns UI state (buffers/toggles).
 */
import { overwritesApi, type Overwrite } from '$lib/api/roles';
import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
import { Perm, has, toBitfield } from '$lib/permissions/bitfield';

export function owKey(ow: { target_type: 0 | 1; target_id: string }): string {
  return `${ow.target_type}:${ow.target_id}`;
}

/** Merge an overwrite row into the cache so the list repaints immediately —
 *  without this it only updates after the WS broadcast lands, which makes
 *  the UI feel laggy on slow links. */
export function applyToCache(channelId: string, ow: Overwrite): void {
  const current = channelPermissions.byChannel[channelId] ?? [];
  const key = owKey(ow);
  const exists = current.some((c) => owKey(c) === key);
  channelPermissions.apply(
    channelId,
    exists ? current.map((c) => (owKey(c) === key ? ow : c)) : [...current, ow]
  );
}

/** Create a fresh overwrite row. Exclusive role adds start with
 *  VIEW_CHANNEL allowed so the role keeps access once @everyone is denied. */
export async function createOverride(
  channelId: string,
  targetType: 0 | 1,
  targetId: string,
  exclusive: boolean
): Promise<Overwrite> {
  const created = await overwritesApi.set(channelId, targetType, targetId, {
    allow: exclusive ? Perm.VIEW_CHANNEL.toString() : '0',
    deny: '0'
  });
  applyToCache(channelId, created);
  return created;
}

/** Make sure @everyone is denied VIEW_CHANNEL — the "channel goes
 *  exclusive" half of an exclusive role add. Returns the saved row so the
 *  caller can force-sync its editor buffer, or null when the deny was
 *  already in place (no-op). */
export async function excludeEveryone(
  channelId: string,
  everyoneId: string
): Promise<Overwrite | null> {
  const existing = (channelPermissions.byChannel[channelId] ?? []).find(
    (ow) => ow.target_type === 0 && ow.target_id === everyoneId
  );
  const prevAllow = existing ? toBitfield(existing.allow) : 0n;
  const prevDeny = existing ? toBitfield(existing.deny) : 0n;
  if (has(prevDeny, Perm.VIEW_CHANNEL)) return null;
  const saved = await overwritesApi.set(channelId, 0, everyoneId, {
    allow: (prevAllow & ~Perm.VIEW_CHANNEL).toString(),
    deny: (prevDeny | Perm.VIEW_CHANNEL).toString()
  });
  applyToCache(channelId, saved);
  return saved;
}
