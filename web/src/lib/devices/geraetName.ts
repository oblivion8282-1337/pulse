/**
 * Gerätenamen normalisieren — die Vorschau auf das, was der Server ohnehin
 * durchsetzt (`_NAME_RE` in `routes/devices.py`): klein, ohne Leerzeichen,
 * nur Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich.
 *
 * Statt einer Fehlermeldung macht die Oberfläche die Eingabe einfach gültig
 * (Remote-UI-Runde 2026-09-09): Gross wird klein, Leerraum jeglicher Art wird
 * ein Bindestrich, alles andere Ungültige fällt weg. Importfrei für den
 * Nodes-Testläufer.
 */
export function geraetNameNormalisieren(eingabe: string): string {
  return eingabe
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
}
