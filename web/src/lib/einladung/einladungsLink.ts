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

/** Öffentliche Community-Adresse `/c/<handle>[?host=<fqdn>]`. */
export interface Adresse {
  handle: string;
  host: string | null;
}

/** Was die Karte zeigen kann: eine Einladung (Code) oder eine Adresse (Handle). */
export type Ziel = Einladung | Adresse;

export function istAdresse(z: Ziel): z is Adresse {
  return 'handle' in z;
}

/** Handle-Form wie `parseJoinInput` (lib/guilds/joinByInvite.ts). */
const HANDLE_RE = /^(?:[a-z0-9][a-z0-9-]{0,30}[a-z0-9]|[a-z0-9])$/;

export function istGueltigerHandle(h: string): boolean {
  return HANDLE_RE.test(h);
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

/** Nur Links auf die Cloud oder auf die laufende App (`seitenHost`, inkl.
 *  Port) zählen — `discord.com/invite/…` und Ähnliches gehören nicht Pulse. */
function eigeneUrl(url: string, cloudHost: string, seitenHost: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.host.toLowerCase();
  if (h !== nackt(cloudHost) && h !== seitenHost.trim().toLowerCase()) return null;
  return u;
}

/** `…/invite/<code>[?…host=<fqdn>…]` aus einer absoluten URL. */
export function einladungAusUrl(
  url: string,
  cloudHost: string,
  seitenHost: string
): Einladung | null {
  const u = eigeneUrl(url, cloudHost, seitenHost);
  if (!u) return null;
  const m = u.pathname.match(/^\/invite\/([^/]+)\/?$/);
  if (!m || !istGueltigerCode(m[1])) return null;
  const host = zielHost(u.searchParams.get('host'), cloudHost);
  if (host === undefined) return null;
  return { code: m[1], host };
}

/** `…/c/<handle>[?…host=<fqdn>…]` aus einer absoluten URL, gleiche Herkunftsregeln. */
export function adresseAusUrl(url: string, cloudHost: string, seitenHost: string): Adresse | null {
  const u = eigeneUrl(url, cloudHost, seitenHost);
  if (!u) return null;
  const m = u.pathname.match(/^\/c\/([^/]+)\/?$/);
  if (!m) return null;
  const handle = m[1].toLowerCase();
  if (!istGueltigerHandle(handle)) return null;
  const host = zielHost(u.searchParams.get('host'), cloudHost);
  if (host === undefined) return null;
  return { handle, host };
}

export function zielAusUrl(url: string, cloudHost: string, seitenHost: string): Ziel | null {
  return einladungAusUrl(url, cloudHost, seitenHost) ?? adresseAusUrl(url, cloudHost, seitenHost);
}

const LINK_RE = /https?:\/\/[^\s<>"]+/g;
/** Satzzeichen, die beim Schreiben am Link kleben („…/invite/abc.“, „(…)“). */
const NACHLAUF_RE = /[.,;:!?)\]}'"»]+$/;

/** Erste gültige Einladung in einem Nachrichtentext — für die Karte unter der
 *  Nachricht. `roh` ist der Link ohne angeklebte Satzzeichen. */
export function ersteEinladungImText(
  text: string,
  cloudHost: string,
  seitenHost: string
): { einladung: Einladung; roh: string } | null {
  for (const treffer of text.match(LINK_RE) ?? []) {
    const roh = treffer.replace(NACHLAUF_RE, '');
    const einladung = einladungAusUrl(roh, cloudHost, seitenHost);
    if (einladung) return { einladung, roh };
  }
  return null;
}

// Der Dialog in der App öffnet sich über Parameter an der AKTUELLEN Adresse —
// man bleibt, wo man war, und Zurück schließt ihn wieder.
const P_CODE = 'einladung';
const P_ADRESSE = 'einladung_adresse';
const P_HOST = 'einladung_host';

export function mitEinladung(pfadUndSuche: string, z: Ziel): string {
  const u = new URL(pfadUndSuche, 'http://x');
  if (istAdresse(z)) {
    u.searchParams.set(P_ADRESSE, z.handle);
    u.searchParams.delete(P_CODE);
  } else {
    u.searchParams.set(P_CODE, z.code);
    u.searchParams.delete(P_ADRESSE);
  }
  if (z.host) u.searchParams.set(P_HOST, z.host);
  else u.searchParams.delete(P_HOST);
  return u.pathname + u.search + u.hash;
}

export function ohneEinladung(pfadUndSuche: string): string {
  const u = new URL(pfadUndSuche, 'http://x');
  u.searchParams.delete(P_CODE);
  u.searchParams.delete(P_ADRESSE);
  u.searchParams.delete(P_HOST);
  return u.pathname + u.search + u.hash;
}

/** null = keine Einladung in der Adresse, 'kaputt' = eine, aber ungültig. */
export function einladungAusParametern(
  p: URLSearchParams,
  cloudHost: string
): Ziel | 'kaputt' | null {
  const code = p.get(P_CODE);
  const handle = p.get(P_ADRESSE);
  if (code === null && handle === null) return null;
  const host = zielHost(p.get(P_HOST), cloudHost);
  if (host === undefined) return 'kaputt';
  if (code !== null) return istGueltigerCode(code) ? { code, host } : 'kaputt';
  return handle !== null && istGueltigerHandle(handle) ? { handle, host } : 'kaputt';
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

/** Wohin ein Einladungs-Deep-Link der Desktop-App führt. `bereit` = angemeldet
 *  und E-Mail bestätigt.
 *  - 'dialog': auf einer echten Unterseite von /app — Dialog an der Adresse.
 *  - 'merken': nicht bereit, oder genau auf `/app` — dort leitet
 *    app/+page.svelte mit replaceState weiter und verwirft die Query; der
 *    Dialog holt die Einladung stattdessen aus dem Speicher.
 *  - 'merken-und-app': bereit, aber außerhalb von /app. */
export function deepLinkWeg(pfad: string, bereit: boolean): 'dialog' | 'merken' | 'merken-und-app' {
  if (!bereit) return 'merken';
  if (pfad.startsWith('/app/')) return 'dialog';
  return pfad === '/app' ? 'merken' : 'merken-und-app';
}

/** Dieselbe Einladung kurz hintereinander noch einmal? Der Hauptprozess der
 *  Desktop-App meldet einen Deep-Link bei laufender App mehrfach (jeder
 *  Fehlversuch der zweiten Instanz um das Single-Instance-Lock löst ein
 *  `second-instance` aus — gemessen: 7× im Abstand von 500 ms). */
export function deepLinkWiederholung(
  vorher: { schluessel: string; zeit: number } | null,
  schluessel: string,
  jetzt: number,
  fensterMs = 5000
): boolean {
  if (vorher === null || vorher.schluessel !== schluessel) return false;
  const abstand = jetzt - vorher.zeit;
  return abstand >= 0 && abstand < fensterMs;
}
