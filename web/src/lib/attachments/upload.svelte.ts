/**
 * Composer-side two-phase upload helper.
 *
 * Each picked/pasted/dropped File becomes a `PendingAttachment` whose
 * state machine walks through queued → uploading → done | error. The
 * machine handles:
 *
 *  - client-side webp thumbnail generation for image/* (mirrors the
 *    AvatarUploadDialog pattern: createImageBitmap + canvas → Blob);
 *  - presigned-URL request to chat-gateway,
 *  - XHR PUT to MinIO (XHR over fetch so we get a progress stream),
 *  - cancellation via XHR abort,
 *  - cleanup of object URLs created for the preview thumbnail.
 *
 * Lives outside MessageInput.svelte so the component itself stays
 * presentational and under the 250-line cap.
 */

import { chatApi } from '$lib/api/chat';

export type PendingAttachment = {
  /** Stable local id (different from the server-assigned attachment.id). */
  localId: string;
  file: File;
  /** Object URL for the in-composer preview; revoke on cleanup. */
  previewUrl: string | null;
  state: 'queued' | 'uploading' | 'done' | 'error';
  progress: number; // 0-100
  /** Set when state transitions to 'done'. */
  attachmentId: string | null;
  errorMessage: string | null;
};

/** Max edge for the client-side thumbnail. 720 keeps it readable inline
 * without being a full hi-res second upload. */
const THUMB_MAX = 720;

let _idCounter = 0;
function _nextLocalId(): string {
  return `pa-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`;
}

async function _generateThumb(
  file: File
): Promise<{ blob: Blob; thumbWidth: number; thumbHeight: number; origWidth: number; origHeight: number } | null> {
  if (!file.type.startsWith('image/')) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null; // unsupported format — server still sees the original
  }
  const origWidth = bitmap.width;
  const origHeight = bitmap.height;
  const scale = Math.min(1, THUMB_MAX / Math.max(origWidth, origHeight));
  const w = Math.max(1, Math.round(origWidth * scale));
  const h = Math.max(1, Math.round(origHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, 'image/webp', 0.85)
  );
  if (!blob) return null;
  return { blob, thumbWidth: w, thumbHeight: h, origWidth, origHeight };
}

function _putWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: (pct: number) => void,
  registerAbort: (abort: () => void) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    registerAbort(() => xhr.abort());
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`PUT ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onabort = () => reject(new Error('aborted'));
    xhr.send(blob);
  });
}

/**
 * Drive an attachment all the way from "file picked" to "server-bound id".
 * `onChange` is called whenever the row's state mutates so the caller's
 * Svelte rune updates re-render the preview strip.
 *
 * Returns an `abort` function the caller can call to cancel in-flight
 * uploads (X-button on the preview tile).
 */
export function startUpload(
  channelId: string,
  file: File,
  onChange: (next: PendingAttachment) => void
): { row: PendingAttachment; abort: () => void } {
  const localId = _nextLocalId();
  const previewUrl =
    file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
  const row: PendingAttachment = {
    localId,
    file,
    previewUrl,
    state: 'queued',
    progress: 0,
    attachmentId: null,
    errorMessage: null
  };

  let abortCurrent: (() => void) | null = null;
  let cancelled = false;

  const emit = () => onChange({ ...row });

  const run = async () => {
    try {
      // 1. (image only) build the thumbnail + capture original dimensions.
      const thumb = await _generateThumb(file);
      if (cancelled) return;

      // 2. Ask the server for an upload URL (+ optional thumb URL).
      const presign = await chatApi.requestAttachmentUploadUrl(channelId, {
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        width: thumb?.origWidth,
        height: thumb?.origHeight,
        has_thumb: thumb !== null,
        thumb_size: thumb?.blob.size,
        thumb_width: thumb?.thumbWidth,
        thumb_height: thumb?.thumbHeight
      });
      if (cancelled) return;

      row.attachmentId = presign.id;
      row.state = 'uploading';
      emit();

      // 3. PUT the bytes — main file first, then the thumb in parallel
      //    isn't worth the bookkeeping; serial keeps the progress meter
      //    monotonic and simple.
      await _putWithProgress(
        presign.upload_url,
        file,
        file.type || 'application/octet-stream',
        (pct) => {
          row.progress = pct;
          emit();
        },
        (a) => {
          abortCurrent = a;
        }
      );
      if (cancelled) return;

      if (thumb && presign.thumb_upload_url) {
        await _putWithProgress(
          presign.thumb_upload_url,
          thumb.blob,
          'image/webp',
          () => {
            /* thumbs are small; ignore intermediate progress */
          },
          (a) => {
            abortCurrent = a;
          }
        );
      }

      if (cancelled) return;
      row.state = 'done';
      row.progress = 100;
      emit();
    } catch (err) {
      if (cancelled) return;
      row.state = 'error';
      row.errorMessage = err instanceof Error ? err.message : String(err);
      emit();
    }
  };

  void run();

  return {
    row,
    abort: () => {
      cancelled = true;
      abortCurrent?.();
      if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
    }
  };
}

export function cleanupRow(row: PendingAttachment): void {
  if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
}
