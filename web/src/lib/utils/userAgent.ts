/**
 * Tiny user-agent prettifier. Covers the four browsers + five OSes that
 * make up ~99 % of real-world traffic. Anything we don't recognise falls
 * back to the first 60 chars of the raw string so the UI never shows an
 * empty cell.
 *
 * NOT a full UA-parser — we deliberately avoid pulling a dep (`ua-parser-js`
 * & friends are heavy + need updates to track new browsers). For sessions-
 * management this is "good enough" since the UA is advisory.
 *
 * The match-order matters: Edge before Chrome (Edge UA contains the literal
 * "Chrome/" substring), and iOS before macOS (iPad UAs on iPadOS 13+ ship a
 * macOS-like UA, so we look for explicit iPad/iPhone tokens first).
 */

const BROWSERS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'Edge', re: /Edg\/(\d+)/ },
  { name: 'Firefox', re: /Firefox\/(\d+)/ },
  { name: 'Chrome', re: /Chrome\/(\d+)/ },
  // Safari without Chrome — Safari UAs end in "Safari/<n>" but Chrome does
  // too. The negative-lookahead via the earlier Chrome match handles it as
  // long as we check Safari LAST in this list.
  { name: 'Safari', re: /Version\/(\d+).*Safari\// }
];

const OSES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'iOS', re: /iPhone|iPad|iPod/ },
  { name: 'Android', re: /Android/ },
  { name: 'Windows', re: /Windows NT/ },
  { name: 'macOS', re: /Mac OS X|Macintosh/ },
  { name: 'Linux', re: /Linux/ }
];

function detectBrowser(ua: string): string | null {
  for (const b of BROWSERS) {
    const m = ua.match(b.re);
    if (m) return m[1] ? `${b.name} ${m[1]}` : b.name;
  }
  return null;
}

function detectOs(ua: string): string | null {
  for (const o of OSES) if (o.re.test(ua)) return o.name;
  return null;
}

/**
 * Returns a human-readable label like "Chrome 120 auf macOS". If the UA
 * is null/empty/unparseable, returns "Unbekanntes Gerät" or a truncated
 * raw string. Never throws.
 */
export function formatUserAgent(ua: string | null): string {
  if (!ua || ua.trim() === '') return 'Unbekanntes Gerät';
  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  if (browser && os) return `${browser} auf ${os}`;
  if (browser) return browser;
  if (os) return os;
  // Last-ditch fallback: show the first chunk of the raw string so the user
  // at least has *something* to identify the entry by.
  return ua.length > 60 ? ua.slice(0, 60) + '…' : ua;
}
