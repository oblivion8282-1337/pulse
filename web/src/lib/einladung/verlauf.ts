// Merkt sich die Adresse, die WIR per `goto` (neuer Verlaufseintrag) für den
// Einladungsdialog angelegt haben. Schließen kann dann `history.back()` gehen,
// statt die Adresse nur zu ersetzen — sonst führt „Zurück" auf denselben
// Eintrag mit `?einladung…` und öffnet den Dialog erneut.
let selbstGepusht: string | null = null;

function normal(url: string): string {
  const u = new URL(url, window.location.origin);
  return u.pathname + u.search;
}

export function merkeSelbstGeoeffnet(url: string): void {
  selbstGepusht = normal(url);
}

/** Die selbst gepushte Adresse, falls die aktuelle genau darauf steht. */
export function selbstGeoeffnet(aktuell: string): string | null {
  return selbstGepusht !== null && selbstGepusht === normal(aktuell) ? selbstGepusht : null;
}

export function vergissSelbstGeoeffnet(): void {
  selbstGepusht = null;
}
