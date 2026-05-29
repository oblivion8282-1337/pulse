/**
 * Permission bitfield + resolver — TypeScript mirror of
 * ``dcc_shared/permissions.py`` and ``dcc_shared/permission_resolver.py``.
 * Wire format ships every bitfield as a string (snowflake-style), so the
 * resolver operates on bigint to safely handle bits past 2^52.
 *
 * Bit layout must match the Python side verbatim — when adding a new
 * bit there, mirror it here in the same position.
 */

// 0-4 server admin · 5-7 reserved · 8-12 member admin · 13-19 reserved
// 20-27 channel · 28-29 reserved · 30-36 voice · 37-50 reserved · 51 admin
export const Perm = {
  MANAGE_CHANNELS: 1n << 0n,
  MANAGE_GUILD: 1n << 1n,
  MANAGE_PERMISSIONS: 1n << 2n,
  MANAGE_ROLES: 1n << 3n,
  MANAGE_INVITES: 1n << 4n,

  KICK_MEMBERS: 1n << 8n,
  BAN_MEMBERS: 1n << 9n,
  CHANGE_NICKNAME: 1n << 10n,
  MANAGE_NICKNAMES: 1n << 11n,

  VIEW_CHANNEL: 1n << 20n,
  READ_HISTORY: 1n << 21n,
  SEND_MESSAGES: 1n << 22n,
  MANAGE_MESSAGES: 1n << 23n,
  ATTACH_FILES: 1n << 24n,
  ADD_REACTIONS: 1n << 25n,
  CREATE_INVITES: 1n << 26n,
  MENTION_EVERYONE: 1n << 27n,

  CONNECT: 1n << 30n,
  SPEAK: 1n << 31n,
  STREAM: 1n << 32n,
  USE_VIDEO: 1n << 33n,
  MUTE_MEMBERS: 1n << 34n,
  DEAFEN_MEMBERS: 1n << 35n,
  MOVE_MEMBERS: 1n << 36n,

  ADMINISTRATOR: 1n << 51n
} as const;

export type Permission = (typeof Perm)[keyof typeof Perm];

// Mask of every bit defined above. Matches GRANT_ALL_SAFE on the Python
// side ((1<<52)-1). Owners + ADMINISTRATOR resolve to this rather than
// `~0n` so unset reserved bits stay zero.
export const GRANT_ALL_SAFE = (1n << 52n) - 1n;

/** Parse a wire bitfield (snowflake-style string) to bigint. */
export function toBitfield(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (!v) return 0n;
  return BigInt(v);
}

export function has(value: bigint, perm: Permission): boolean {
  return (value & perm) === perm;
}

export type Override = { allow: bigint; deny: bigint };

export type RoleSnapshot = {
  id: string;
  position: number;
  permissions: bigint;
  is_everyone: boolean;
};

export type OverwriteSnapshot = {
  target_type: 0 | 1; // 0 = role, 1 = user
  target_id: string;
  allow: bigint;
  deny: bigint;
};

export type ResolverContext = {
  isGlobalAdmin: boolean;
  isOwner: boolean;
  isMember: boolean;
  userId: string;
  roles: RoleSnapshot[];
  overwrites: OverwriteSnapshot[];
};

function applyOverride(value: bigint, ow: Override): bigint {
  return (value | ow.allow) & ~ow.deny;
}

/** Resolve a member's effective guild-wide permission bitfield. */
export function resolveGuildPermissions(ctx: ResolverContext): bigint {
  if (ctx.isGlobalAdmin || ctx.isOwner) return GRANT_ALL_SAFE;
  if (!ctx.isMember) return 0n;
  let value = 0n;
  for (const r of ctx.roles) value |= r.permissions;
  if (has(value, Perm.ADMINISTRATOR)) return GRANT_ALL_SAFE;
  return value;
}

/**
 * Channel-scope resolution. Layering matches the Python resolver:
 *   1. start with guild-wide perms
 *   2. apply the @everyone channel overwrite
 *   3. apply each role overwrite in position order (low → high)
 *   4. apply the user overwrite (always wins)
 *   5. if !VIEW_CHANNEL: revoke everything (security invariant)
 */
export function resolveChannelPermissions(ctx: ResolverContext): bigint {
  if (ctx.isGlobalAdmin || ctx.isOwner) return GRANT_ALL_SAFE;
  if (!ctx.isMember) return 0n;

  let value = resolveGuildPermissions(ctx);
  if (value === GRANT_ALL_SAFE) return GRANT_ALL_SAFE;

  const byTarget = new Map<string, Override>();
  for (const ow of ctx.overwrites) {
    byTarget.set(`${ow.target_type}:${ow.target_id}`, { allow: ow.allow, deny: ow.deny });
  }

  // @everyone first, then other roles in position order, then the user.
  // Avoid cloning + sorting when the caller pre-sorted (e.g. after caching
  // in snapshotsForUser). Check is O(n) but allocation-free on the fast path.
  function isSorted(arr: RoleSnapshot[]): boolean {
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i];
      const evA = a.is_everyone ? -1 : 1, evB = b.is_everyone ? -1 : 1;
      if (evA !== evB ? evA > evB : a.position > b.position) return false;
    }
    return true;
  }
  const sortedRoles = isSorted(ctx.roles) ? ctx.roles : [...ctx.roles].sort((a, b) => {
    if (a.is_everyone !== b.is_everyone) return a.is_everyone ? -1 : 1;
    return a.position - b.position;
  });

  for (const r of sortedRoles) {
    const ow = byTarget.get(`0:${r.id}`);
    if (ow) value = applyOverride(value, ow);
  }
  const userOw = byTarget.get(`1:${ctx.userId}`);
  if (userOw) value = applyOverride(value, userOw);

  if (!has(value, Perm.VIEW_CHANNEL)) return 0n;
  return value;
}
