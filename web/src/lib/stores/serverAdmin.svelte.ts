/**
 * Per-server admin status.
 *
 * "Admin" is per server, not per account: on the Cloud it comes from
 * ``auth.user.is_admin`` (auth-svc /me), but on a self-host server it comes
 * from that server's WS ``ready`` frame (``is_admin``) — a cert-login user has
 * no auth-svc /me there. We therefore track it keyed by ``serverId`` and let
 * the admin page pick the right source for the active server.
 *
 * Fed from the ready handler (one entry per connected server). Cleared on
 * sign-out. Not reset on server-switch — each server's status stays cached.
 */
class ServerAdminStore {
  private byServer = $state<Record<string, boolean>>({});

  set(serverId: string, isAdmin: boolean): void {
    if (!serverId) return;
    this.byServer = { ...this.byServer, [serverId]: isAdmin };
  }

  /** True iff we have a definitive admin answer for this server yet. */
  has(serverId: string): boolean {
    return serverId in this.byServer;
  }

  isAdmin(serverId: string): boolean {
    return this.byServer[serverId] ?? false;
  }

  clear(): void {
    this.byServer = {};
  }
}

export const serverAdmin = new ServerAdminStore();
