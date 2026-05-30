/**
 * i18n-Helfer rund um die von Paraglide generierte Runtime.
 *
 * Sprachregel (vom Product Owner): Deutsch nur, wenn die Browser-/Systemsprache
 * Deutsch ist — sonst Englisch. Eine manuelle Wahl (Umschalter in den
 * Einstellungen) hat Vorrang und wird in localStorage gehalten.
 *
 * baseLocale ist `de` (die Quelltexte sind Deutsch). Paraglides Default-Fallback
 * wäre damit `de`, was exotische Sprachen fälschlich auf Deutsch setzen würde —
 * deshalb erzwingt initLocale() die „de sonst en"-Regel explizit.
 */
import {
  getLocale,
  setLocale,
  isLocale,
  locales,
  type Locale,
} from '$lib/paraglide/runtime';

// Paraglides localStorage-Strategie nutzt diesen Key (s. vite.config.ts).
const STORAGE_KEY = 'PARAGLIDE_LOCALE';

/** Früh beim Client-Start aufrufen (ssr=false). Setzt die Sprache nach der
 *  „de sonst en"-Regel, sofern keine manuelle Wahl gespeichert ist. */
export function initLocale(): void {
  if (typeof window === 'undefined') return;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && isLocale(stored)) return; // manuelle Wahl gewinnt
  const nav = navigator.language?.toLowerCase() ?? '';
  const desired: Locale = nav.startsWith('de') ? 'de' : 'en';
  if (getLocale() !== desired) setLocale(desired, { reload: false });
}

/** Aktuelle Sprache. */
export function currentLocale(): Locale {
  return getLocale();
}

/** Manueller Sprachwechsel (Umschalter). Lädt die Seite neu, damit alle Texte
 *  sicher neu gerendert werden (Paraglide-Default reload:true). */
export function changeLocale(locale: Locale): void {
  setLocale(locale);
}

/** Verfügbare Sprachen — für den Umschalter. */
export const availableLocales = locales;

/** Anzeigenamen der Sprachen für die UI. */
export const localeLabels: Record<Locale, string> = {
  de: 'Deutsch',
  en: 'English',
};
