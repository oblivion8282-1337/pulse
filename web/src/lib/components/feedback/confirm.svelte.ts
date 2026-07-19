/**
 * Bestätigungs-Abfrage als Versprechen — Ersatz für das native `confirm()`.
 *
 * Warum ein Dienst und nicht ein `<AlertDialog>` je Fundstelle: zwei der acht
 * Aufrufe stehen in reinen `.ts`-Modulen (`popoverActions.ts`,
 * `DropboxViewModel.svelte.ts`), die gar nichts rendern können. Ein Versprechen
 * lässt sich von dort genauso aufrufen wie aus einer Komponente — und der
 * Aufruf sieht fast aus wie vorher:
 *
 *     if (!confirm(msg)) return;                                  // vorher
 *     if (!(await confirmDialog({ description: msg }))) return;   // nachher
 *
 * Gerendert wird genau einmal, von `ConfirmDialog.svelte` im Wurzel-Layout.
 */
export type ConfirmOptions = {
  /** Die eigentliche Frage. Pflicht. */
  description: string;
  /** Überschrift. Vorgabe: „Bist du sicher?" */
  title?: string;
  /** Beschriftung des bestätigenden Knopfes. Vorgabe: „Ja, fortfahren" */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Färbt den bestätigenden Knopf rot — für Unwiderrufliches. */
  destructive?: boolean;
};

export type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void };

let pending = $state<PendingConfirm | null>(null);

/** Die offene Abfrage, oder `null`. Nur `ConfirmDialog.svelte` liest das. */
export function currentConfirm(): PendingConfirm | null {
  return pending;
}

/**
 * Fragt nach und wartet auf die Antwort. `true` = bestätigt.
 *
 * Läuft bereits eine Abfrage, wird die alte automatisch mit `false` beantwortet
 * — sonst hinge ihr Aufrufer für immer, wenn zwei Abfragen kollidieren.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  pending?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { ...opts, resolve };
  });
}

/**
 * Antwort zurückgeben und schliessen. Nur `ConfirmDialog.svelte` ruft das.
 *
 * `req` ist die Frage, die beantwortet wird — nicht einfach „die gerade
 * offene". Ist inzwischen eine andere nachgerückt, passiert nichts: sonst
 * könnte das Schliessen des Dialogs die Antwort einer fremden Frage stehlen.
 */
export function settleConfirm(req: PendingConfirm, ok: boolean): void {
  if (pending !== req) return;
  pending = null;
  req.resolve(ok);
}
