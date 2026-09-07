/**
 * Klebt die Nachrichtenliste am Ende? — die reine Rechnung hinter
 * `MessageList.svelte`, importfrei (s. `pnpm test:unit`-Falle in CLAUDE.md).
 *
 * Zwei Fehler, die einander ausschliessen sahen, zwangen zu diesem Zustand
 * mit ZWEI Feldern statt einem Schalter:
 *
 * 1. Bis 2026-09-03 setzte der Scroll-Handler `klebt` in beide Richtungen.
 *    Die eigene Gleitfahrt ans Ende (`pinToEnd(true)`) erzeugt aber
 *    Zwischen-Scroll-Ereignisse, die noch nicht am Ende liegen — jedes davon
 *    löste das Kleben, und eine Nachricht in diesem Fenster fand keinen Pin
 *    mehr vor („die Nachrichten hängen zu weit oben").
 * 2. Der Fix vom 2026-09-04 schaltete den Handler auf „nur noch scharf
 *    stellen" um. Damit stellte ihn aber auch ein Rad-Tick nach oben wieder
 *    scharf: Chromium animiert einen Tick über mehrere Frames, die ersten
 *    liegen noch in der Toleranzzone, und weil nichts mehr nach false
 *    schaltete, blieb das Kleben stehen — die nächste Nachricht (oder ein
 *    nachgeladenes Bild) zog die Ansicht zurück ans Ende („beim Hochscrollen
 *    springt es zurück"). Nachgestellt in `tests/e2e/chat-scroll.spec.ts`.
 *
 * Auflösung: der Handler unterscheidet, WESSEN Scroll er sieht. Während einer
 * eigenen Fahrt darf er nur scharf stellen; sonst rechnet er beidseitig. Eine
 * Fahrt endet, wenn ein Ereignis GENAU am Ende liegt (nicht bloss in der
 * Toleranz — sonst endete sie an ihrem ersten Zwischenframe), oder wenn der
 * Nutzer eingreift. Eine von virtua verworfene Fahrt (Messzeit abgelaufen,
 * kein Scroll) bleibt bis zur nächsten Nutzergeste offen — das ist genau das
 * Verhalten von Fassung 2, also nicht schlechter als vorher.
 */

export type Klebezustand = {
	/** Der Nutzer will unten bleiben: neue Zeilen ziehen die Ansicht nach. */
	klebt: boolean;
	/** `pinToEnd` hat eine Fahrt angestossen, die noch nicht angekommen ist. */
	eigeneFahrt: boolean;
};

/** Wie weit über dem Ende noch „unten" gilt (Bruchteil einer Nachricht). */
export const KLEBE_TOLERANZ_PX = 80;

/** Subpixel-Rest, unter dem eine Fahrt als angekommen gilt. */
const ANKUNFT_TOLERANZ_PX = 1;

/** Der Zustand beim Öffnen eines Kanals: unten, ohne laufende Fahrt. */
export function anfangsKlebezustand(): Klebezustand {
	return { klebt: true, eigeneFahrt: false };
}

/**
 * Ein Scroll-Ereignis der Liste verrechnen. `offset`/`viewport`/`size` sind
 * die Werte von virtua (`size` ist mindestens so gross wie das Sichtfenster).
 */
export function nachScroll(
	z: Klebezustand,
	offset: number,
	viewport: number,
	size: number
): Klebezustand {
	// Vor dem ersten echten Inhalt ist die Grösse 0 — nicht auswerten.
	if (size === 0) return z;
	const abstand = size - (offset + viewport);
	const amEnde = abstand <= KLEBE_TOLERANZ_PX;
	if (z.eigeneFahrt) {
		return { klebt: z.klebt || amEnde, eigeneFahrt: abstand > ANKUNFT_TOLERANZ_PX };
	}
	return { klebt: amEnde, eigeneFahrt: false };
}

/** `pinToEnd` hat eine Fahrt angestossen: bis sie ankommt, nur scharf stellen. */
export function nachEigenerFahrt(z: Klebezustand): Klebezustand {
	return { klebt: z.klebt, eigeneFahrt: true };
}

/**
 * Rad/Finger nach oben, Tasten, Griff an die Scrollleiste. Der bisherige
 * Zustand geht nicht ein — die Geste löst das Kleben und bricht eine laufende
 * eigene Fahrt ab, aus jedem Zustand heraus. Sie nimmt ihn trotzdem entgegen,
 * damit alle Übergänge dieselbe Form haben.
 */
export function nachNutzergeste(_z: Klebezustand): Klebezustand {
	return { klebt: false, eigeneFahrt: false };
}
