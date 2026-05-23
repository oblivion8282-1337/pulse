class PresenceStore {
  onlineIds = $state<Set<string>>(new Set());

  seed(userIds: string[]): void {
    this.onlineIds = new Set(userIds);
  }

  apply(userId: string, online: boolean): void {
    const next = new Set(this.onlineIds);
    if (online) next.add(userId);
    else next.delete(userId);
    this.onlineIds = next;
  }

  isOnline(userId: string): boolean {
    return this.onlineIds.has(userId);
  }

  clear(): void {
    this.onlineIds = new Set();
  }
}

export const presence = new PresenceStore();
