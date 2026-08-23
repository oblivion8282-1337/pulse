/**
 * Die gemeinsame Optik einer Kanalzeile.
 *
 * Steht seit der Aufteilung von `ChannelList.svelte` hier, weil sie von allen
 * drei Abschnitten (Text, Ablage, Sprache) benutzt wird und jede Kopie
 * irgendwann eine andere Polsterung bekäme. Die Zeile ist auf dem Handy
 * bewusst höher (`py-4`) als am Rechner (`md:py-2`) — sie muss mit dem Daumen
 * getroffen werden.
 */
export const CHANNEL_BTN_CLASS =
  'group flex w-full items-center gap-3 rounded-xl px-3 py-4 text-left text-base font-medium transition-colors md:gap-2.5 md:py-2 md:text-sm hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary';
