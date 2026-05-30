/**
 * Markdown-Renderer für die statischen Rechtstexte (Impressum, Datenschutz,
 * AGB) unter `src/lib/legal/*.md`. Eigene, großzügigere Allowlist als der
 * Chat-Renderer (Überschriften, Tabellen, hr) — der Inhalt stammt aus eigenen,
 * gebündelten Dateien (vertrauenswürdig), wird aber trotzdem mit DOMPurify
 * gesäubert (defense in depth). Läuft client-seitig (ssr=false).
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'a', 'ul', 'ol', 'li', 'br', 'hr',
  'strong', 'em', 'b', 'i', 'code', 'pre', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];
const ALLOWED_ATTR = ['href', 'title', 'target', 'rel'];

export function renderLegal(md: string): string {
  const html = marked.parse(md, { gfm: true }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}
