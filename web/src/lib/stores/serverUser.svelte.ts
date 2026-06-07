/**
 * Per-server current-user id.
 *
 * Your user id is per server, not global: on the Cloud it equals
 * ``auth.user.id``, but on a self-host server it's that server's own user id
 * (cert-login / pairwise sub). "Is this mine?" checks must compare a message's
 * ``author_id`` against the *active server's* id, never the Cloud id — else the
 * answer is always false on self-hosts (you can't edit/delete your own
 * messages, and "report" shows up on your own message). Same root cause as the
 * per-server admin flag — see ``serverAdmin``.
 *
 * Fed from each server's WS ``ready`` frame (``user_id``). Cleared on sign-out.
 * Not reset on server-switch — each server's id stays cached.
 */
class ServerUserStore {
  private byServer = $state<Record<string, string>>({});

  set(serverId: string, userId: string): void {
    if (!serverId || !userId) return;
    this.byServer = { ...this.byServer, [serverId]: userId };
  }

  /** This account's user id on the given server, or null if not seeded yet. */
  idFor(serverId: string | undefined | null): string | null {
    if (!serverId) return null;
    return this.byServer[serverId] ?? null;
  }

  clear(): void {
    this.byServer = {};
  }
}

export const serverUser = new ServerUserStore();
