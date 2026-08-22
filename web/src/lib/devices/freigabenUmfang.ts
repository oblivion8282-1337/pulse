/**
 * Der Umfang einer Server-Freigabeliste, wie ihn `RemoteStandplatzBanner`
 * anzeigt: „jeder" (mindestens ein `everyone`-Eintrag) oder die Anzahl der
 * übrigen Einträge (Nutzer und Rollen zusammen — die Liste unterscheidet
 * beim Anzeigen nicht, WER freigegeben ist, nur WIE VIELE).
 *
 * Importfrei, damit Nodes eingebauter Testläufer sie direkt laden kann
 * (Muster wie `restzeit.ts`).
 */
export interface FreigabenUmfang {
  jeder: boolean;
  anzahl: number;
}

export function freigabenUmfang(grants: { subject_type: 'user' | 'role' | 'everyone' }[]): FreigabenUmfang {
  return {
    jeder: grants.some((g) => g.subject_type === 'everyone'),
    anzahl: grants.length,
  };
}
