/**
 * Gegenprobe zu `$lib/ablage/anhangArchivPfad.ts`.
 *
 * **Warum dieser winzige Test wichtiger ist, als er aussieht.** Der Pfad
 * wandert nie ueber die Leitung: der Server leitet ihn beim Verteilen aus der
 * Anhang-Kennung ab (`ablage_anhang_verteilung.py::archiv_pfad`), der Klient
 * beim Holen — zwei Ableitungen derselben Regel, in zwei Sprachen, ohne
 * gemeinsame Quelle. Laufen sie auseinander, schreibt der Server an eine
 * Stelle, an der niemand nachsieht, und der Klient faellt still auf den
 * Pulse-Weg zurueck, der nach der Verteilung keine Bytes mehr hat. Es wird
 * nirgends etwas rot; der Anhang ist einfach weg.
 *
 * Der Test auf der Gegenseite steht in
 * `services/chat-gateway/tests/test_postfach_anhaenge_laufwerk.py`
 * (`test_archiv_pfad_ist_flach_und_traegt_nur_die_kennung`) und haelt
 * dieselben Zeichenketten fest.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { anhangArchivPfad } from '../src/lib/ablage/anhangArchivPfad.ts';

describe('anhangArchivPfad', () => {
  test('die Form, auf die sich beide Seiten verlassen', () => {
    assert.equal(anhangArchivPfad('123456789'), 'anh-123456789.puls');
    assert.equal(anhangArchivPfad('123456789', true), 'anh-123456789-vs.puls');
  });

  test('flach — kein Unterordner', () => {
    // Ein `PUT` in eine WebDAV-Sammlung, die es noch nicht gibt, wird mit 409
    // beantwortet, und der Schreibweg legt bewusst keine an.
    assert.ok(!anhangArchivPfad('42').includes('/'));
  });

  test('die Kennung bleibt eine Zeichenkette', () => {
    // Snowflakes gehen als String ueber die API (JS `Number` kann 64 Bit nicht
    // exakt) — eine Umwandlung in eine Zahl waere hier ein stiller Datenfehler
    // bei genau den grossen Kennungen, die im Betrieb vorkommen.
    assert.equal(anhangArchivPfad('9007199254740993'), 'anh-9007199254740993.puls');
  });
});
