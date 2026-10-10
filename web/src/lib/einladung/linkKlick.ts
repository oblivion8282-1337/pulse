// Ein schlichter Linksklick auf einen Einladungslink in einer Nachricht
// öffnet den Einladungsdialog an der aktuellen Adresse, statt eines neuen
// Tabs — und in der Desktop-App statt eines zweiten, nackten Fensters:
// messageRender.ts setzt `target="_blank"`, und main.ts lässt Fenster gleichen
// Ursprungs ohne Preload aufgehen. Strg/Cmd/Mittelklick bleiben unberührt
// (klickAbfangen).
import { goto } from '$app/navigation';
import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import { klickAbfangen, zielAusUrl, mitEinladung } from './einladungsLink';

export function einladungsKlicksAbfangen(el: HTMLElement): () => void {
  const beiKlick = (ev: MouseEvent) => {
    if (!klickAbfangen(ev)) return;
    const a = (ev.target as Element | null)?.closest?.('a[href]');
    if (!(a instanceof HTMLAnchorElement) || !el.contains(a)) return;
    const e = zielAusUrl(a.href, CLOUD_HOSTNAME, window.location.host);
    if (!e) return;
    ev.preventDefault();
    void goto(mitEinladung(window.location.pathname + window.location.search, e), {
      noScroll: true,
      keepFocus: true
    });
  };
  el.addEventListener('click', beiKlick);
  return () => el.removeEventListener('click', beiKlick);
}
