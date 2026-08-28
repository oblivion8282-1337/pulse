/**
 * Uebersetzt eine `AnhangAngabe` aus der entschluesselten Nutzlast in die
 * `Attachment`-Form, die die Anzeige ohnehin schon kennt
 * (`MessageAttachments.svelte`, `AutoRefreshImage.svelte`, `Lightbox`).
 *
 * Eine eigene Anhang-Komponente fuer den verschluesselten Fall waere der
 * teurere Weg gewesen: sie haette Lightbox, Platzreservierung,
 * Groessenformat und den Herunterladen-Knopf still verloren. Stattdessen
 * tragen die bestehenden Kacheln ein Merkmal (`verschluesselt`) und holen
 * ihre Bytes anders — alles andere bleibt.
 *
 * `url`/`thumb_url` bleiben leer: eine vorsignierte Adresse gibt es hier
 * nicht im Voraus (sie kostet einen Geraete-Nachweis, s.
 * `anhangHolen.ts`), und selbst mit ihr zeigte ein `<img src=…>` darauf
 * nichts als Kauderwelsch.
 */
import type { Attachment } from '../api/types';
import type { AnhangAngabe } from './nachrichtNutzlast';

export function anhangAngabeZuAttachment(angabe: AnhangAngabe): Attachment {
  return {
    id: angabe.id,
    filename: angabe.name,
    mime: angabe.typ,
    size: angabe.groesse,
    width: angabe.breite,
    height: angabe.hoehe,
    thumb_width: angabe.vorschau?.breite ?? null,
    thumb_height: angabe.vorschau?.hoehe ?? null,
    url: '',
    thumb_url: null,
    verschluesselt: true,
    schluessel: angabe.schluessel,
    thumb_schluessel: angabe.vorschau?.schluessel ?? null
  };
}
