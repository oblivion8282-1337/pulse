/**
 * Startadresse des Electron-Fensters.
 *
 * Die Wurzel (`/`) ist seit dem 2026-09-09 in der Cloud die statische
 * Landingpage (nginx mappt `location = /` auf `landing.html`), und die leitet
 * nur ANGEMELDETE Nutzer nach `/app` weiter. Wer die Desktop-App ohne Sitzung
 * startete, sah deshalb die Werbeseite statt des Anmeldeschirms. Die App
 * steuert darum nie die Wurzel an, sondern direkt die SPA:
 *
 * - Normal-App: `/app` — angemeldet bleibt man dort, sonst schickt die
 *   App-Hülle nach `/login` (`web/src/routes/app/+layout.svelte`).
 * - Server-App (Login-Phase): `/login` — NICHT `/app`, denn `startLoginWatch`
 *   in `main.ts` wertet jede Navigation nach `/app` als Login-Erfolg; die
 *   Erst-Navigation dorthin feuert aber auch ohne Sitzung. Eine schon gültige
 *   Sitzung faengt dort weiter der Cookie-Poll.
 */
export function startAdresse(basis: string, serverModus: boolean): string {
  return new URL(serverModus ? '/login' : '/app', basis).href;
}
