// Einladungslinks lesen und prüfen — importfrei (Node-Unit-Tests, CLAUDE.md).
//
// EINE Stelle für alle Leser: Nachrichtenanzeige (Karte + Klick), Beitritts-
// feld, Einladungsseite, Dialog, Deep-Link und gemerkte Einladung. Vorher
// hatte jede ihren eigenen Ausdruck, und sie widersprachen sich: MessageItem
// fand `host=` nur als ERSTEN Parameter, parseJoinInput überall.

export interface Einladung {
  code: string;
  /** Nackter FQDN eines Self-Hosts; null = Cloud. */
  host: string | null;
}

/** Code-Form wie `INVITE_CODE_RE` in desktop/electron/deeplink.ts. */
const CODE_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function istGueltigerCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** Maßstab von `isValidFqdn` (desktop/electron/deeplink.ts): mindestens ein
 *  Punkt, nur Label-Zeichen, keine IP in irgendeiner Schreibweise. Damit
 *  fallen auch Port, Userinfo (`@`), Backslash und Pfad heraus — genau die
 *  Zeichen, an denen Pythons `urlsplit` (Cloud) und `new URL` (Browser) einen
 *  Host verschieden lesen: `evil.example\@victim.example` ist für die Cloud
 *  `victim.example`, für den Browser `evil.example` (nachgemessen 2026-10-10). */
export function istGueltigerHost(host: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  if (/(?:^|\.)0x[0-9a-f]+/i.test(host)) return false;
  if (/(?:^|\.)0\d+(?:\.|$)/.test(host)) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host);
}

function nackt(roh: string): string {
  return roh.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** Zielserver aus einem rohen `host`-Wert: null = Cloud (fehlt, leer oder der
 *  Cloud-Host selbst), undefined = ungültig (Einladung verwerfen). */
export function zielHost(roh: string | null, cloudHost: string): string | null | undefined {
  if (roh === null || roh.trim() === '') return null;
  const h = nackt(roh);
  if (h === nackt(cloudHost)) return null;
  return istGueltigerHost(h) ? h : undefined;
}

/** `…/invite/<code>[?…host=<fqdn>…]` aus einer absoluten URL. Der Origin
 *  zählt nicht: ein Cloud-Link bleibt ein Cloud-Link, wer ihn auch postet. */
export function einladungAusUrl(url: string, cloudHost: string): Einladung | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const m = u.pathname.match(/^\/invite\/([^/]+)\/?$/);
  if (!m || !istGueltigerCode(m[1])) return null;
  const host = zielHost(u.searchParams.get('host'), cloudHost);
  if (host === undefined) return null;
  return { code: m[1], host };
}

const LINK_RE = /https?:\/\/[^\s<>"]+/g;
/** Satzzeichen, die beim Schreiben am Link kleben („…/invite/abc.“, „(…)“). */
const NACHLAUF_RE = /[.,;:!?)\]}'"»]+$/;

/** Erste gültige Einladung in einem Nachrichtentext — für die Karte unter der
 *  Nachricht. `roh` ist der Link ohne angeklebte Satzzeichen. */
export function ersteEinladungImText(
  text: string,
  cloudHost: string
): { einladung: Einladung; roh: string } | null {
  for (const treffer of text.match(LINK_RE) ?? []) {
    const roh = treffer.replace(NACHLAUF_RE, '');
    const einladung = einladungAusUrl(roh, cloudHost);
    if (einladung) return { einladung, roh };
  }
  return null;
}

// Der Dialog in der App öffnet sich über Parameter an der AKTUELLEN Adresse —
// man bleibt, wo man war, und Zurück schließt ihn wieder.
const P_CODE = 'einladung';
const P_HOST = 'einladung_host';

export function mitEinladung(pfadUndSuche: string, e: Einladung): string {
  const u = new URL(pfadUndSuche, 'http://x');
  u.searchParams.set(P_CODE, e.code);
  if (e.host) u.searchParams.set(P_HOST, e.host);
  else u.searchParams.delete(P_HOST);
  return u.pathname + u.search + u.hash;
}

export function ohneEinladung(pfadUndSuche: string): string {
  const u = new URL(pfadUndSuche, 'http://x');
  u.searchParams.delete(P_CODE);
  u.searchParams.delete(P_HOST);
  return u.pathname + u.search + u.hash;
}

/** null = keine Einladung in der Adresse, 'kaputt' = eine, aber ungültig. */
export function einladungAusParametern(
  p: URLSearchParams,
  cloudHost: string
): Einladung | 'kaputt' | null {
  const code = p.get(P_CODE);
  if (code === null) return null;
  if (!istGueltigerCode(code)) return 'kaputt';
  const host = zielHost(p.get(P_HOST), cloudHost);
  return host === undefined ? 'kaputt' : { code, host };
}

export interface KlickArt {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** Nur der schlichte Linksklick wird zum Dialog. Strg/Cmd/Umschalt/Alt oder
 *  die mittlere Taste heißen „neuer Tab/neues Fenster“ — das bleibt so. */
export function klickAbfangen(k: KlickArt): boolean {
  return (
    !k.defaultPrevented && k.button === 0 && !k.metaKey && !k.ctrlKey && !k.shiftKey && !k.altKey
  );
}
