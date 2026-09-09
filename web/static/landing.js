/**
 * Verhalten der statischen Landingpage (`landing.html`).
 *
 * Die Seite liegt bewusst NEBEN der SvelteKit-App: nginx faengt in der Cloud
 * `/` ab und liefert `landing.html` aus (siehe `infra/prod/web-nginx.conf`),
 * alles andere bleibt die SPA. Deshalb hat diese Datei keinen Bundler, keine
 * Abhaengigkeiten und keinen Zugriff auf `$lib/*`.
 *
 * Aufbau: oben reine Funktionen OHNE DOM-Zugriff beim Import — nur so lassen
 * sie sich mit Nodes eingebautem Testlaeufer pruefen (`web/test/landing.test.ts`,
 * Regeln in CLAUDE.md unter „pnpm test:unit"). Alles, was das Dokument
 * anfasst, haengt an `init()`, und `init()` laeuft nur im Browser.
 *
 * Die CSP der Seite erlaubt kein Inline-Script (`script-src 'self'`) — deshalb
 * steht hier auch der Anmelde-Weiterleiter und nicht im HTML-Kopf.
 */

// ── Download-Quellen ─────────────────────────────────────────────────────────
// KOPIE von `web/src/lib/downloads/appDownloads.ts` — synchron halten.
// Diese Datei kann nicht importieren (kein Bundler, siehe Kopf), und die
// Landingpage muss dieselben Artefakte anbieten wie Login-Screen und
// Einstellungen. Wer dort eine URL aendert, aendert sie hier mit.
const BASE = 'https://howispulse.com';
import { WOERTERBUCH, uebersetzen } from './landing-woerterbuch.js';

export const WINDOWS_INSTALLER_URL = `${BASE}/updates/win/Pulse-Setup-latest.exe`;
export const ANDROID_APK_URL = `${BASE}/downloads/pulse-latest.apk`;
export const MAC_DMG_URL = `${BASE}/downloads/Pulse-latest.dmg`;
export const LINUX_FLATPAKREF_URL = `${BASE}/flatpak/com.howispulse.Pulse.flatpakref`;
export const LINUX_INSTALL_COMMAND = `flatpak install --from ${LINUX_FLATPAKREF_URL}`;

/** localStorage-Schluessel der App (Paraglide-Strategie, s. `web/vite.config.ts`). */
export const SPRACH_SCHLUESSEL = 'PARAGLIDE_LOCALE';
/** localStorage-Schluessel des Refresh-Tokens (s. `web/src/lib/api/storage.ts`). */
export const REFRESH_SCHLUESSEL = 'dcc.tokens.refresh';

// ── Reine Funktionen (ohne DOM) ──────────────────────────────────────────────

/**
 * Betriebssystem aus User-Agent/Plattform-Kennung.
 * iOS und iPadOS liefern bewusst `null`: dort gibt es keine App zum Laden.
 *
 * @param {string | undefined | null} userAgent
 * @param {string | undefined | null} platform
 * @returns {'windows'|'mac'|'linux'|'android'|null}
 */
export function plattformErkennen(userAgent, platform) {
  const ua = String(userAgent || '');
  const pf = String(platform || '');
  if (/iPhone|iPad|iPod/i.test(ua) || /^iP(hone|ad|od)/i.test(pf)) return null;
  if (/Android/i.test(ua)) return 'android';
  if (/Windows|Win32|Win64|WOW64/i.test(ua) || /^Win/i.test(pf)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua) || /^Mac/i.test(pf)) return 'mac';
  if (/Linux|X11|CrOS/i.test(ua) || /^Linux/i.test(pf)) return 'linux';
  return null;
}

/**
 * Was „App laden" auf dieser Plattform bedeutet.
 * Ohne erkannte Plattform wird nicht geraten, sondern zur Plattform-Liste
 * gescrollt — dort waehlt der Nutzer selbst.
 *
 * @param {string | null | undefined} plattform
 * @returns {{art:'download',url:string}|{art:'flatpak',befehl:string}|{art:'scrollen',ziel:string}}
 */
export function appLadenZiel(plattform) {
  switch (plattform) {
    case 'windows':
      return { art: 'download', url: WINDOWS_INSTALLER_URL };
    case 'mac':
      return { art: 'download', url: MAC_DMG_URL };
    case 'android':
      return { art: 'download', url: ANDROID_APK_URL };
    case 'linux':
      return { art: 'flatpak', befehl: LINUX_INSTALL_COMMAND };
    default:
      return { art: 'scrollen', ziel: '#plattformen' };
  }
}

/**
 * Sprachregel wie in der App (`web/src/lib/i18n.ts`): eine gespeicherte Wahl
 * gewinnt, sonst Deutsch nur bei deutscher Browsersprache.
 *
 * @param {string | null | undefined} gespeichert
 * @param {string | undefined} navigatorLanguage
 * @returns {'de'|'en'}
 */
export function spracheErmitteln(gespeichert, navigatorLanguage) {
  if (gespeichert === 'de' || gespeichert === 'en') return gespeichert;
  return String(navigatorLanguage || '')
    .toLowerCase()
    .startsWith('de')
    ? 'de'
    : 'en';
}

/**
 * Angemeldet, wenn ein Refresh-Token im Speicher liegt.
 *
 * @param {{getItem(k: string): string | null} | null | undefined} speicher
 */
export function eingeloggt(speicher) {
  try {
    return !!(speicher && speicher.getItem(REFRESH_SCHLUESSEL));
  } catch {
    return false; // privater Modus / blockierte Speicher
  }
}

// ── Browser-Teil ─────────────────────────────────────────────────────────────

/**
 * Zeigerpunkt-Effekt im Hero: Polarraster + Lichtkegel + Klick-Pings.
 * @param {HTMLElement} hero
 */
function heroEffektVerdrahten(hero) {
  const raster = /** @type {HTMLElement | null} */ (hero.querySelector('[data-lp-raster]'));
  const kegel = /** @type {HTMLElement | null} */ (hero.querySelector('[data-lp-kegel]'));
  const feld = /** @type {HTMLElement | null} */ (hero.querySelector('[data-lp-feld]'));
  if (!raster || !kegel || !feld) return;

  /** @param {number} x @param {number} y */
  const maske = (x, y) =>
    `radial-gradient(circle 260px at ${x}px ${y}px,#000 0%,rgba(0,0,0,.35) 55%,transparent 80%)`;

  feld.addEventListener('mousemove', (ereignis) => {
    const e = /** @type {MouseEvent} */ (ereignis);
    const r = feld.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    raster.style.maskImage = maske(x, y);
    raster.style.setProperty('-webkit-mask-image', maske(x, y));
    raster.style.opacity = '1';
    kegel.style.left = `${x}px`;
    kegel.style.top = `${y}px`;
    kegel.style.opacity = '1';
  });
  feld.addEventListener('mouseleave', () => {
    raster.style.opacity = '0';
    kegel.style.opacity = '0';
  });
  feld.addEventListener('click', (ereignis) => {
    const e = /** @type {MouseEvent} */ (ereignis);
    const r = feld.getBoundingClientRect();
    const ping = document.createElement('div');
    ping.className = 'lp-ping';
    ping.style.left = `${e.clientX - r.left}px`;
    ping.style.top = `${e.clientY - r.top}px`;
    ping.addEventListener('animationend', () => ping.remove());
    feld.appendChild(ping);
  });
}

/**
 * Umlaufbahn im Self-Hosting-Abschnitt: vier Knoten, eine Umrundung in 80 s.
 * @param {HTMLElement} wurzel
 */
function umlaufbahnVerdrahten(wurzel) {
  const chips = /** @type {HTMLElement[]} */ (Array.from(wurzel.querySelectorAll('[data-lp-chip]')));
  const linien = /** @type {SVGLineElement[]} */ (
    Array.from(wurzel.querySelectorAll('[data-lp-linie]'))
  );
  if (chips.length !== 4 || linien.length !== 4) return;
  const cx = 240;
  const cy = 150;
  // Bahn etwas enger als die 480 px des Kastens: das breiteste Kaestchen
  // („SELBST GEHOSTET · ANONYM") misst rund 200 px und steht mittig auf der
  // Bahn — bei rx 168 ragte es ~30 px ueber den Rand, mit 140 noch ~2 px.
  const rx = 140;
  const ry = 102;
  const winkel = [-2.45, -0.85, 0.75, 2.35];
  const w = (2 * Math.PI) / 80;

  /** @param {number} t Sekunden seit dem Start */
  function stellen(t) {
    for (let i = 0; i < 4; i++) {
      const a = winkel[i] + t * w;
      const x = cx + rx * Math.cos(a);
      const y = cy + ry * Math.sin(a);
      chips[i].style.left = `${x}px`;
      chips[i].style.top = `${y}px`;
      chips[i].style.zIndex = y > cy ? '3' : '1';
      linien[i].setAttribute('x2', String(x));
      linien[i].setAttribute('y2', String(y));
    }
  }
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    stellen(0); // ruhige Anordnung statt Dauerbewegung
    return;
  }
  const start = performance.now();
  /** @param {number} jetzt */
  const schritt = (jetzt) => {
    stellen((jetzt - start) / 1000);
    requestAnimationFrame(schritt);
  };
  requestAnimationFrame(schritt);
}

/**
 * Sprachumschalter + `<html lang>` + alle Texte.
 * @param {'de'|'en'} sprache
 */
function spracheAnwenden(sprache) {
  document.documentElement.lang = sprache;
  uebersetzen(document.body, WOERTERBUCH, sprache);
  for (const knopf of /** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll('[data-lp-sprache]')
  )) {
    const aktiv = knopf.dataset.lpSprache === sprache;
    knopf.setAttribute('aria-pressed', aktiv ? 'true' : 'false');
    knopf.classList.toggle('lp-sprache-aktiv', aktiv);
  }
}

export function init() {
  if (typeof document === 'undefined') return;

  // Angemeldete Nutzer sehen die Werbeseite gar nicht erst. Der Body ist bis
  // hierher `hidden` — sonst blitzt die Landingpage vor der Weiterleitung auf.
  let speicher = null;
  try {
    speicher = window.localStorage;
  } catch {
    speicher = null;
  }
  if (eingeloggt(speicher)) {
    location.replace('/app');
    return;
  }
  document.body.removeAttribute('hidden');

  /** @type {'de'|'en'} */
  let sprache = 'de';
  try {
    sprache = spracheErmitteln(speicher && speicher.getItem(SPRACH_SCHLUESSEL), navigator.language);
  } catch {
    sprache = 'de';
  }
  spracheAnwenden(sprache);

  for (const knopf of /** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll('[data-lp-sprache]')
  )) {
    knopf.addEventListener('click', () => {
      const gewaehlt = /** @type {'de'|'en'} */ (knopf.dataset.lpSprache);
      try {
        speicher && speicher.setItem(SPRACH_SCHLUESSEL, gewaehlt);
      } catch {
        /* Speicher blockiert — die Wahl gilt dann nur fuer diesen Besuch. */
      }
      spracheAnwenden(gewaehlt);
    });
  }

  // „App laden": ohne JS ein Anker auf die Plattform-Liste, mit JS der direkte
  // Weg fuer die erkannte Plattform.
  const dialog = /** @type {HTMLDialogElement | null} */ (
    document.getElementById('lp-linux-dialog')
  );
  const plattform = plattformErkennen(navigator.userAgent, navigator.platform);
  const ziel = appLadenZiel(plattform);
  for (const a of /** @type {NodeListOf<HTMLAnchorElement>} */ (
    document.querySelectorAll('[data-lp-app-laden]')
  )) {
    if (ziel.art === 'download') {
      a.href = ziel.url;
    } else if (ziel.art === 'flatpak') {
      a.href = LINUX_FLATPAKREF_URL;
      a.addEventListener('click', (e) => {
        if (dialog && typeof dialog.showModal === 'function') {
          e.preventDefault();
          dialog.showModal();
        }
      });
    }
  }

  // Linux-Karte oeffnet denselben Dialog, unabhaengig von der Plattform.
  for (const a of /** @type {NodeListOf<HTMLAnchorElement>} */ (
    document.querySelectorAll('[data-lp-linux]')
  )) {
    a.addEventListener('click', (e) => {
      if (dialog && typeof dialog.showModal === 'function') {
        e.preventDefault();
        dialog.showModal();
      }
    });
  }
  if (dialog) {
    const kopieren = /** @type {HTMLElement | null} */ (
      dialog.querySelector('[data-lp-kopieren]')
    );
    const schliessen = dialog.querySelector('[data-lp-dialog-schliessen]');
    schliessen && schliessen.addEventListener('click', () => dialog.close());
    kopieren &&
      kopieren.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(LINUX_INSTALL_COMMAND);
          const alt = kopieren.textContent;
          kopieren.textContent = document.documentElement.lang === 'en' ? 'Copied' : 'Kopiert';
          setTimeout(() => {
            kopieren.textContent = alt;
          }, 1600);
        } catch {
          /* Zwischenablage verweigert — der Befehl steht daneben und laesst
             sich markieren. */
        }
      });
  }

  const hero = /** @type {HTMLElement | null} */ (document.querySelector('[data-lp-hero]'));
  if (hero) heroEffektVerdrahten(hero);
  const bahn = /** @type {HTMLElement | null} */ (
    document.querySelector('[data-lp-umlaufbahn]')
  );
  if (bahn) umlaufbahnVerdrahten(bahn);
}

init();
