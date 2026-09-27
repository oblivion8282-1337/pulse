/**
 * Erster sichtbarer Buchstabe eines Namens für Avatar-Initialen.
 *
 * Bughunt Runde 14: `name.slice(0, 1)` / `charAt(0)` arbeitet in UTF-16-
 * Code-Einheiten — ein Name, der mit einem Astral-Zeichen beginnt
 * ("🌊Max", "𠮷野家"), liefert ein hohes Surrogat-Halbbyte und rendert
 * als Kaputt/Leer. `Array.from` iteriert Code-Points.
 */
export function anfangsBuchstabe(name: string): string {
  const erste = Array.from(name.trim())[0] ?? '';
  return erste.toUpperCase();
}
