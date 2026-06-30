/**
 * Pick the right lucide-svelte component for a dropbox entry.
 * Single source of truth — both ``DropboxEntryCard`` and
 * ``DropboxEntryList`` import this so the icon set stays
 * consistent across views.
 *
 * Folder entries always render as ``FolderIcon``; file entries
 * branch on the MIME-type prefix (image / video / audio / archive).
 */

import type { Component } from 'svelte';
import ArchiveIcon from '@lucide/svelte/icons/archive';
import FileIcon from '@lucide/svelte/icons/file';
import FolderIcon from '@lucide/svelte/icons/folder';
import ImageIcon from '@lucide/svelte/icons/image';
import MusicIcon from '@lucide/svelte/icons/music';
import VideoIcon from '@lucide/svelte/icons/video';

import { isFolder, type DropboxEntry } from '$lib/api/dropbox';

export function fileIcon(entry: DropboxEntry): Component {
  if (isFolder(entry)) return FolderIcon;
  const t = (entry.content_type || '').toLowerCase();
  if (t.startsWith('image/')) return ImageIcon;
  if (t.startsWith('video/')) return VideoIcon;
  if (t.startsWith('audio/')) return MusicIcon;
  if (t.includes('zip') || t.includes('archive')) return ArchiveIcon;
  return FileIcon;
}