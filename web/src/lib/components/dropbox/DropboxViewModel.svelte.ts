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
import { confirmDialog } from '$lib/components/feedback/confirm.svelte';

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
  /** Bulk-move flag — when true, ``commitMove`` iterates over
   *  ``selectedIds`` instead of patching only ``moveTarget``. */
  bulkMoveActive = $state(false);

  /** Number of entries that will be moved when the dialog commits.
   *  Used by the dialog for the hint line + footer count. */
  get moveCount(): number {
    return this.bulkMoveActive ? this.selectedIds.size : 1;
  }
  fileInput = $state<HTMLInputElement | null>(null);
  selectedIds = $state<Set<string>>(new Set());
  /** Mehrfachauswahl-Limit, das zum Backend-Passt (MAX_MULTI_IDS). */
  static readonly MAX_SELECTION = 100;

  get hasSelection(): boolean {
    return this.selectedIds.size > 0;
  }

  get selectionCount(): number {
    return this.selectedIds.size;
  }

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
      // A path/search/trash switch invalidates any stale selection — the
      // entry rows the selection referred to are no longer on screen.
      this.selectedIds = new Set();
      void this.refreshEntries();
    });
  }

  // ----- Selection -----
  toggleSelect(id: string) {
    const next = new Set(this.selectedIds);
    if (next.has(id)) next.delete(id);
    else if (next.size < DropboxViewModel.MAX_SELECTION) next.add(id);
    this.selectedIds = next;
  }

  clearSelection() {
    this.selectedIds = new Set();
  }

  isSelected(id: string): boolean {
    return this.selectedIds.has(id);
  }

  // ----- Downloads -----
  /** Mint a download URL and hand it to the browser — NICHT via
   *  ``window.location.href``: Eine Top-Level-Navigation feuert
   *  ``beforeunload`` (auch wenn die Antwort per Content-Disposition
   *  ``attachment`` nie wirklich navigiert), und livekit-client trennt darauf
   *  die Voice-Verbindung (``disconnectOnPageLeave``, Default true) — der
   *  Download warf einen also aus dem Voice-Channel.
   *
   *  Same-Origin (Prod-Presigned via nginx, Archiv-Endpoint überall): ein
   *  ``<a download>``-Klick lädt ganz ohne Navigation → kein beforeunload,
   *  streamt direkt auf die Platte. Cross-Origin (nur Dev-MinIO auf :9000,
   *  dort wird das download-Attribut ignoriert und iframe-Downloads blockt
   *  Chrome ohne User-Activation): eigenes Fenster, das der Browser nach
   *  Download-Start selbst schließt — beforeunload des Hauptfensters bleibt
   *  unberührt. Mint-Fehler surfacen als Toast. */
  async #download(urlPromise: Promise<string>): Promise<void> {
    try {
      const url = await urlPromise;
      if (new URL(url, window.location.href).origin === window.location.origin) {
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } catch (err) {
      toast.error(pm.dropbox_download_failed(), {
        description: (err as Error).message
      });
    }
  }

  async downloadFile(e: DropboxEntry) {
    if (!isFile(e)) return;
    void this.#download(
      dropboxApi
        .getDownloadUrl(this.channel.guild_id, e.id)
        .then((r) => r.url)
    );
  }

  async downloadFolder(e: DropboxEntry) {
    if (!isFolder(e)) return;
    const path = e.parent_path ? `${e.parent_path}/${e.name}` : e.name;
    void this.#download(dropboxApi.archiveUrl(this.channel.guild_id, { path }));
  }

  async downloadSelection() {
    const files = this.entries.filter(
      (e) => isFile(e) && this.selectedIds.has(e.id)
    );
    if (files.length === 0) {
      toast.error(pm.dropbox_no_files_selected());
      return;
    }
    if (this.selectedIds.size > DropboxViewModel.MAX_SELECTION) {
      toast.error(
        pm.dropbox_download_too_many({ count: DropboxViewModel.MAX_SELECTION })
      );
      return;
    }
    void this.#download(
      dropboxApi.archiveUrl(this.channel.guild_id, {
        entryIds: files.map((f) => f.id)
      })
    );
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

  /** Navigate to ancestor at position ``i`` (0 = root, segments.length =
   *  current). Index-based avoids the duplicate-name footgun of the old
   *  ``indexOf(seg)`` lookup (e.g. on path ``a/b/a`` the second ``a``
   *  crumb would otherwise jump to root). */
  navigateToIndex(i: number) {
    if (i < 0) return;
    const parts = this.currentPath.split('/');
    this.currentPath = parts.slice(0, i).join('/');
    this.searchQuery = '';
    this.viewTrash = false;
  }

  /** Go up one level. No-op at root so the toolbar arrow doesn't
   *  visually promise movement it can't deliver. */
  goUp() {
    if (!this.currentPath) return;
    const parts = this.currentPath.split('/');
    this.navigateToIndex(parts.length - 1);
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
    this.bulkMoveActive = false;
  }

  /** Open the move dialog with the current selection as the targets.
   *  ``moveTarget`` is set to the first selected entry — its id is
   *  used to exclude that subtree from the folder picker (the picker
   *  only filters one entry; nested exclusions are an honest TODO if
   *  the bulk selection contains multiple folders). */
  startBulkMove() {
    if (this.selectedIds.size === 0) return;
    const rep = this.entries.find((e) => this.selectedIds.has(e.id));
    if (!rep) return;
    this.moveTarget = rep;
    this.moveValue = '';
    this.bulkMoveActive = true;
  }

  /** Close the move dialog and reset both single + bulk state. */
  cancelMove() {
    this.moveTarget = null;
    this.bulkMoveActive = false;
  }

  async commitMove() {
    if (!this.moveTarget) return;
    const v = this.moveValue.trim();
    if (this.bulkMoveActive) {
      // ponytail: sequential PATCH loop. A batch endpoint would be nicer
      // once we see this hot; until then the simplicity beats a new route.
      const ids = Array.from(this.selectedIds);
      const skipSame = (id: string) => {
        const e = this.entries.find((x) => x.id === id);
        return e ? e.parent_path !== v : true;
      };
      const targets = ids.filter(skipSame);
      if (targets.length === 0) {
        this.cancelMove();
        return;
      }
      let ok = 0;
      let failed = 0;
      for (const id of targets) {
        try {
          await dropboxApi.patchEntry(this.channel.guild_id, id, {
            parent_path: v
          });
          ok++;
        } catch (e) {
          failed++;
          toast.error(pm.dropbox_move_failed(), {
            description: (e as Error).message
          });
        }
      }
      this.cancelMove();
      await this.refreshAll();
      // ponytail: combined toast so a 50-file move doesn't spam 50
      // success toasts on top of the per-entry failures above.
      if (ok > 0 && failed === 0) {
        toast.success(pm.dropbox_move_success({ count: ok }));
      }
      return;
    }

    if (v === this.moveTarget.parent_path) {
      this.cancelMove();
      return;
    }
    try {
      await dropboxApi.patchEntry(this.channel.guild_id, this.moveTarget.id, {
        parent_path: v
      });
      this.cancelMove();
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
    const ok = await confirmDialog({
      description: pm.dropbox_confirm_delete({ name: e.name }),
      destructive: true
    });
    if (!ok) return;
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

  /** Number of trashed entries currently loaded. The trash listing
   *  is the same as ``entries`` when ``viewTrash=true``. Only
   *  accurate while in trash view. */
  get trashCount(): number {
    return this.viewTrash ? this.entries.length : 0;
  }

  /** Manual empty-trash. Admin-only on the server (MANAGE_CHANNELS);
   *  if a non-admin triggers it the API returns 403 and the toast
   *  surfaces the message. Confirm dialog is owned by the toolbar
   *  call-site. */
  async emptyTrash() {
    try {
      const r = await dropboxApi.emptyTrash(this.channel.guild_id);
      await this.refreshAll();
      toast.success(pm.dropbox_empty_trash_success({ count: r.purged }));
    } catch (err) {
      toast.error(pm.dropbox_empty_trash_failed(), {
        description: (err as Error).message
      });
    }
  }
}

export function useDropboxView(channel: Channel): DropboxViewModel {
  return new DropboxViewModel(channel);
}
