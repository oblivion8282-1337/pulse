/**
 * Logic-only controller for the dropbox view.
 *
 * Owns the WS subscription, the data state (quota / entries /
 * path / search / view-mode / targets) and the server-side actions
 * (refresh / create-folder / upload / trash / pin / restore / rename /
 * move). The orchestrator (``DropboxView.svelte``) binds the
 * public fields and methods to markup.
 *
 * Class pattern (matches ``stores/guildSounds.svelte.ts`` et al):
 * fields use ``$state`` so mutation triggers reactivity; methods
 * carry the actions. ``$effect`` blocks handle the WS subscription
 * + auto-refresh on path/search/trash changes. The class is
 * instantiated per ``Channel`` mount via ``useDropboxView(channel)``.
 */

import { browser } from '$app/environment';
import { toast } from 'svelte-sonner';

import {
  dropboxApi,
  isFile,
  isFolder,
  type DropboxConfig,
  type DropboxEntry
} from '$lib/api/dropbox';
import type { Channel } from '$lib/api/types';
import { m as pm } from '$lib/paraglide/messages.js';

class DropboxViewModel {
  // ----- State -----
  quota = $state<DropboxConfig | null>(null);
  entries = $state<DropboxEntry[]>([]);
  currentPath = $state('');
  searchQuery = $state('');
  viewTrash = $state(false);
  isGridView = $state(true);
  uploading = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  creatingFolder = $state(false);
  newFolderName = $state('');
  renameTarget = $state<DropboxEntry | null>(null);
  renameValue = $state('');
  moveTarget = $state<DropboxEntry | null>(null);
  moveValue = $state('');
  fileInput = $state<HTMLInputElement | null>(null);

  // Stale-response token — see comment on ``refreshEntries``.
  #entriesGen = 0;

  constructor(public channel: Channel) {
    // ----- WS subscription -----
    // Flat-field shape; see DropboxQuotaUpdatedEvent in
    // shared/src/dcc_shared/events/guild.py.
    $effect(() => {
      if (!browser) return;
      let unsub: (() => void) | null = null;
      let cancelled = false;

      void this.refreshAll();
      void import('$lib/ws/connection').then(({ gateway }) => {
        if (cancelled) return;
        unsub = gateway.on((evt) => {
          const e = evt as unknown as {
            op?: string;
            guild_id?: string;
          } & Partial<DropboxConfig>;
          if (e.guild_id !== this.channel.guild_id) return;
          if (!e.op) return;
          switch (e.op) {
            case 'dropbox_entry_created':
            case 'dropbox_entry_updated':
            case 'dropbox_entry_deleted':
            case 'dropbox_entry_restored':
            case 'dropbox_entry_purged':
              void this.refreshAll();
              break;
            case 'dropbox_quota_updated':
              this.quota = {
                guild_id: e.guild_id ?? this.channel.guild_id,
                enabled: Boolean(e.enabled),
                total_quota_bytes: Number(e.total_quota_bytes ?? 0),
                per_file_max_bytes: Number(e.per_file_max_bytes ?? 0),
                used_bytes: Number(e.used_bytes ?? 0),
                trash_retention_days: Number(e.trash_retention_days ?? 0),
                updated_at: new Date().toISOString()
              } as DropboxConfig;
              break;
          }
        });
      });

      return () => {
        cancelled = true;
        unsub?.();
      };
    });

    // ----- Auto-refresh -----
    $effect(() => {
      // Reading the runes here registers them as dependencies.
      this.currentPath;
      this.searchQuery;
      this.viewTrash;
      void this.refreshEntries();
    });
  }

  // ----- Refresh -----
  async refreshAll() {
    await Promise.all([this.refreshQuota(), this.refreshEntries()]);
  }

  async refreshQuota() {
    try {
      this.quota = await dropboxApi.getQuota(this.channel.guild_id);
    } catch {
      this.quota = null;
    }
  }

  async refreshEntries() {
    const myGen = ++this.#entriesGen;
    this.loading = true;
    this.error = null;
    try {
      const r = await dropboxApi.listEntries(this.channel.guild_id, {
        path: this.currentPath,
        q: this.searchQuery,
        includeTrash: this.viewTrash
      });
      if (myGen !== this.#entriesGen) return;
      this.entries = r.entries;
    } catch (e) {
      if (myGen !== this.#entriesGen) return;
      this.error = (e as Error).message;
      this.entries = [];
    } finally {
      if (myGen === this.#entriesGen) this.loading = false;
    }
  }

  // ----- Folder navigation -----
  enterFolder(entry: DropboxEntry) {
    if (!isFolder(entry)) return;
    this.currentPath = entry.parent_path
      ? `${entry.parent_path}/${entry.name}`
      : entry.name;
    this.searchQuery = '';
    this.viewTrash = false;
  }

  navigateTo(seg: string) {
    if (!seg) {
      this.currentPath = '';
    } else {
      const parts = this.currentPath.split('/');
      const idx = parts.indexOf(seg);
      this.currentPath = parts.slice(0, idx).join('/');
    }
    this.searchQuery = '';
    this.viewTrash = false;
  }

  openFile(e: DropboxEntry) {
    if (!isFile(e) || !e.url) return;
    window.open(e.url, '_blank', 'noopener,noreferrer');
  }

  // ----- Folder creation -----
  async createFolder() {
    if (!this.newFolderName.trim()) return;
    try {
      await dropboxApi.createFolder(
        this.channel.guild_id,
        this.currentPath,
        this.newFolderName.trim()
      );
      this.newFolderName = '';
      this.creatingFolder = false;
      await this.refreshEntries();
      toast.success(pm.dropbox_folder_created());
    } catch (e) {
      toast.error(pm.dropbox_error_generic(), {
        description: (e as Error).message
      });
    }
  }

  // ----- File upload -----
  openFilePicker() {
    this.fileInput?.click();
  }

  async onFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    if (!this.quota || !this.quota.enabled) {
      toast.error(pm.dropbox_disabled_error());
      return;
    }
    this.uploading = true;
    let okCount = 0;
    for (const f of files) {
      try {
        const mint = await dropboxApi.mintUploadUrl(this.channel.guild_id, {
          parent_path: this.currentPath,
          name: f.name,
          content_type: f.type || 'application/octet-stream',
          size_bytes: f.size
        });
        const putRes = await fetch(mint.upload_url, {
          method: 'PUT',
          body: f,
          headers: {
            'Content-Type': f.type || 'application/octet-stream'
          }
        });
        if (!putRes.ok) throw new Error(`upload failed: ${putRes.status}`);
        await dropboxApi.finishUpload(this.channel.guild_id, {
          id: mint.id,
          parent_path: this.currentPath,
          name: f.name,
          size_bytes: f.size,
          content_type: f.type || 'application/octet-stream'
        });
        okCount++;
      } catch (e) {
        toast.error(pm.dropbox_upload_failed({ name: f.name }), {
          description: (e as Error).message
        });
      }
    }
    this.uploading = false;
    if (okCount > 0) {
      toast.success(pm.dropbox_upload_success({ count: okCount }));
      await this.refreshAll();
    }
  }

  // ----- Per-entry actions -----
  startRename(e: DropboxEntry) {
    this.renameTarget = e;
    this.renameValue = e.name;
  }
  async commitRename() {
    if (!this.renameTarget) return;
    const v = this.renameValue.trim();
    if (!v || v === this.renameTarget.name) {
      this.renameTarget = null;
      return;
    }
    try {
      await dropboxApi.patchEntry(this.channel.guild_id, this.renameTarget.id, {
        name: v
      });
      this.renameTarget = null;
      await this.refreshEntries();
    } catch (e) {
      toast.error(pm.dropbox_rename_failed(), {
        description: (e as Error).message
      });
    }
  }

  startMove(e: DropboxEntry) {
    this.moveTarget = e;
    this.moveValue = e.parent_path;
  }
  async commitMove() {
    if (!this.moveTarget) return;
    const v = this.moveValue.trim();
    if (v === this.moveTarget.parent_path) {
      this.moveTarget = null;
      return;
    }
    try {
      await dropboxApi.patchEntry(this.channel.guild_id, this.moveTarget.id, {
        parent_path: v
      });
      this.moveTarget = null;
      await this.refreshEntries();
    } catch (e) {
      toast.error(pm.dropbox_move_failed(), {
        description: (e as Error).message
      });
    }
  }

  async togglePin(e: DropboxEntry) {
    try {
      await dropboxApi.patchEntry(this.channel.guild_id, e.id, {
        pinned: !e.pinned
      });
      await this.refreshEntries();
    } catch (err) {
      toast.error(pm.dropbox_pin_failed(), {
        description: (err as Error).message
      });
    }
  }

  async trashEntry(e: DropboxEntry) {
    if (!confirm(pm.dropbox_confirm_delete({ name: e.name }))) return;
    try {
      await dropboxApi.deleteEntry(this.channel.guild_id, e.id);
      await this.refreshAll();
    } catch (err) {
      toast.error(pm.dropbox_delete_failed(), {
        description: (err as Error).message
      });
    }
  }

  async restore(e: DropboxEntry) {
    try {
      await dropboxApi.restoreEntry(this.channel.guild_id, e.id);
      await this.refreshAll();
    } catch (err) {
      toast.error(pm.dropbox_restore_failed(), {
        description: (err as Error).message
      });
    }
  }
}

export function useDropboxView(channel: Channel): DropboxViewModel {
  return new DropboxViewModel(channel);
}
