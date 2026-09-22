/**
 * Konsole-Fang — führt alles, was sonst nur in den DevTools landet, ins
 * Diagnose-Gedächtnis (Käfer-Knopf, Spec 2026-09-21 §5; nachgerüstet
 * 2026-09-22).
 *
 * **Die Lücke:** der Ringpuffer (`app-diagnose.ts`) hörte nur auf gezielte
 * `melde()`-Aufrufe einzelner Bausteine. Ein Fehler, den nur die Konsole
 * sieht — „Uncaught (in promise) TypeError: Failed to fetch", eine 404-Ressource
 * — musste vom Nutzer per DevTools-Kopie weitergegeben werden; ausgerechnet
 * im Störfall, für den der Käfer gebaut wurde.
 *
 * **Was gefangen wird:** `console.error`, `window`-Error-Events (JS-Fehler
 * UND Ressourcen-Ladefehler — letztere tragen kein `message`, nur das Ziel)
 * und `unhandledrejection`. `console.warn` bewusst NICHT: der Konstant-Rausch
 * (CSP-Dev-Warnung, HLS-Part-Dauern) würde den 250er-Ring mit Bekanntem
 * fluten. Browser-interne Zeilen (z. B. CORS-Block-Meldungen) sind aus JS
 * grundsätzlich nicht lesbar — ihre FOLGE (der gescheiterte Fetch) landet aber
 * als Promise-Ablehnung hier.
 *
 * **Geheimnisse (Spec §8):** Argumente werden zu einem String verdichtet und
 * vor der Übergabe gekappt und geschwärzt — Query-Parameter, die wie Tokens/
 * Signaturen aussehen, werden entfernt, BEVOR sie den Ring erreichen. `melde()`
 * kappt zusätzlich hart als letzte Instanz.
 *
 * Importfrei außer `app-diagnose` — installiert wird einmalig beim App-Start
 * (`+layout.svelte`); ein zweiter Aufruf ist harmlos.
 */

// `.ts`-Endung bewusst: hält das Modul unter `node --test` lauffähig (Vite
// und Node lösen dasselbe Ziel), gleiche Praxis wie quellenummer.ts u. a.
import { melde } from './app-diagnose.ts';

/** Query-Werte, die nie im Ring landen dürfen — geprüft als Parameter-NAME. */
const SCHWARZLISTE = /(token|secret|password|signature|key)=/i;

/** Schwärzt token-artige Query-Werte: `?token=abc…` → `?token=…`. */
function schwaerzen(text: string): string {
  return text.replace(/([?&][^?&\s]*?(token|secret|password|signature|key))=[^&\s]+/gi, '$1=…');
}

/** Ein einzelnes Konsolen-Argument zu Text — Error, Primitiv, Objekt. */
function argumentZuText(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  if (arg === null || arg === undefined || typeof arg !== 'object') return String(arg);
  try {
    return JSON.stringify(arg) ?? '[leer]';
  } catch {
    // Zirkulär oder Getter wirft — String() greift auf toString zurück.
    return '[objekt]';
  }
}

/**
 * Alle Argumente einer Konsole-Meldung zu EINEM Ring-tauglichen Text: joinen,
 * schwärzen, kappen (etwas großzügiger als `melde` selbst, der nochmal kürzt —
 * hier gekappt, damit die Verdichtung unten nicht an 10-KB-Strings hängt).
 * Exportiert für den Test — die Schwärzung ist die Sicherheits-Kante.
 */
export function textAus(args: unknown[], maxLaenge = 300): string {
  const roh = schwaerzen(args.map(argumentZuText).join(' '));
  return roh.length > maxLaenge ? `${roh.slice(0, maxLaenge)}…` : roh;
}

let installiert = false;

/** Installiert die Fänge — idempotent, wirft nie. Nur im Browser wirksam. */
export function starteKonsolenFang(): void {
  try {
    if (installiert || typeof window === 'undefined') return;
    installiert = true;

    const original = console.error;
    console.error = (...args: unknown[]) => {
      melde('konsole', 'konsole_error', textAus(args));
      original.apply(console, args);
    };

    window.addEventListener('error', (e: ErrorEvent) => {
      if (e.error instanceof Error || e.message) {
        melde('fenster', 'fenster_error', textAus([e.error ?? e.message]), {
          ort: `${(e.filename ?? '').split('/').at(-1) ?? ''}:${e.lineno ?? 0}`
        });
        return;
      }
      // Kein message = Ressourcen-Ladefehler (Bild/Sound/Script): das Ziel ist
      // der Beleg — genau die 404-Sounds der Bughunt-Konsolen wären so sichtbar
      // gewesen, ohne dass jemand DevTools öffnen muss.
      const ziel = e.target as { src?: string; href?: string; tagName?: string } | null;
      const url = ziel?.src ?? ziel?.href ?? '';
      if (url) {
        melde('fenster', 'ressource_fehler', textAus([url]), { element: ziel?.tagName ?? '' });
      }
    });

    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
      melde('promise', 'promise_reject', textAus([e.reason ?? '[ohne Grund]']));
    });
  } catch {
    // Diagnostik darf nie zur Störung werden — gleiche Regel wie app-diagnose.
  }
}
