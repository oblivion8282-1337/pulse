/**
 * Markdown-Wrap-Helper für die Composer-Actions. Nimmt die aktuelle
 * Textarea-Selection und ersetzt sie durch `prefix + sel + suffix`; bei
 * leerer Selection wird das Caret zwischen die Wrap-Teile gesetzt.
 *
 * Aufgerufen aus MessageInput.onKeydown via `lookupComposer(e)`.
 */

import type { ActionId } from './actions';

type Wrap = { prefix: string; suffix: string; block?: boolean };

const WRAPS: Partial<Record<ActionId, Wrap>> = {
  'composer.bold': { prefix: '**', suffix: '**' },
  'composer.italic': { prefix: '*', suffix: '*' },
  'composer.code': { prefix: '`', suffix: '`' },
  // Codeblock setzt bei vorhandener Selection einen Newline auf beide Seiten,
  // damit das ``` auf eigener Zeile steht (Discord-Verhalten).
  'composer.codeblock': { prefix: '```', suffix: '```', block: true },
  'composer.strike': { prefix: '~~', suffix: '~~' }
};

export function applyComposerAction(
  id: ActionId,
  ta: HTMLTextAreaElement,
  value: string,
  setValue: (v: string) => void
): boolean {
  const w = WRAPS[id];
  if (!w) return false;
  const start = ta.selectionStart ?? value.length;
  const end = ta.selectionEnd ?? value.length;
  const selected = value.slice(start, end);
  const sep = w.block && selected.length > 0 ? '\n' : '';
  const before = w.prefix + sep;
  const after = sep + w.suffix;
  setValue(value.slice(0, start) + before + selected + after + value.slice(end));
  const newStart = start + before.length;
  const newEnd = newStart + selected.length;
  queueMicrotask(() => {
    ta.focus();
    ta.setSelectionRange(newStart, newEnd);
  });
  return true;
}
