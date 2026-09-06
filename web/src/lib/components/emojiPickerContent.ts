/**
 * Geteilte Props für das `DropdownMenu.Content`, das den Emoji-Picker
 * trägt (MessageActions, MessageInput, MessageReactions, WatchChatPanel).
 * Der Picker ist ein eigenes Popover — der Menü-Container selbst muss
 * unsichtbar bleiben (`border-0 bg-transparent p-0 shadow-none`) und darf
 * nicht clippen, sonst wird der Emoji-Raster am Viewport-Rand beschnitten.
 */
export const emojiPickerContentProps = {
  side: 'top',
  sideOffset: 6,
  class: 'w-auto max-w-[calc(100vw-1rem)] overflow-visible border-0 bg-transparent p-0 shadow-none'
} as const;
