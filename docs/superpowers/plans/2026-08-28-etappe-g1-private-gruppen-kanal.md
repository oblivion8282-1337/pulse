# Etappe G1 — Private Gruppen: die Kanal-Hälfte — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine neue Kanalart „private Gruppe" mit Mitgliederverwaltung —
anlegen, hinzufügen, entfernen, verlassen, auflisten. **Ohne Krypto und ohne
Oberfläche.**

**Architecture:** Ein privater Gruppenkanal ist ein dritter Kanaltyp neben
Community-Kanal und DM. `Message.channel_id` zeigt schon heute polymorph auf
zwei Arten (der Docstring von `DirectMessageChannel` sagt das ausdrücklich) —
die dritte reiht sich ein. Rechte gibt es keine: wer anlegt, darf hinzufügen
und entfernen; jedes Mitglied darf gehen. Das ist der Unterschied zu einer
Community.

**Tech Stack:** FastAPI · SQLAlchemy[asyncio] · Alembic · pytest

**Spec:** `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` §9

## Warum diese Hälfte allein gebaut wird

Die Spec sagt es selbst: die Kanalart samt Mitgliederverwaltung ist gewöhnliche
Produktarbeit und unabhängig von der Krypto prüfbar; die Megolm-Sitzungen und
der Schlüsselwechsel setzen Etappe D voraus. Zusammen gebaut wäre keine der
beiden Hälften einzeln rot zu sehen.

## Der Punkt, an dem man dieses Vorhaben ruinieren kann

Die Spec zieht ihren grössten Vorteil daraus, dass es private Gruppen **heute
nicht gibt**: sie können deshalb *von Geburt an verschlüsselt* sein, ohne
Rückfallweg und ohne Umschaltmoment.

**Diese Etappe darf diesen Vorteil nicht verspielen.** Wird die Kanalart jetzt
in der Oberfläche freigeschaltet, entstehen unverschlüsselte Gruppen — und
sobald es davon eine gibt, gibt es Altbestand, eine Migration und einen
Umschaltmoment, also genau das, was die Spec sich erspart.

**Also: bauen, prüfen, aber NICHT freischalten.** Die Routen existieren und
sind durch Tests gedeckt; die Oberfläche bekommt sie erst, wenn G2 (Megolm)
steht. Ein Schalter in den Einstellungen (Vorgabe **aus**), am Vorbild von
`cloud_dm_attachments_enabled` — der ist genau dafür gemacht und wird an
derselben Stelle geprüft wie dort.

## Global Constraints

- **Alembic-Revision-ID ≤ 32 Zeichen**, `down_revision` gegen den tatsächlichen Kopf. Der Wächter `tests/test_alembic_koepfe.py` muss grün bleiben. **Diese Etappe kommt nach Etappe D** — zwei gleichzeitig entstehende Migrationen wären zwei Köpfe.
- **Quelldateien ≤ 350 Zeilen (hart 500).**
- **Keine neuen Abhängigkeiten. Kein `git push`.**
- **Changelog: NEIN** — die Funktion ist nicht freigeschaltet, ein Nutzer merkt nichts. Der Eintrag gehört zu G2.
- Deutsche Kommentare und Commit-Nachrichten, echte Umlaute.

## Was als Vorbild dient

| Was | Wo |
|---|---|
| Kanal-Modell mit Snowflake-PK und `last_message_id` | `models/channels.py:69-99` (`DirectMessageChannel`) |
| Kanalauflösung für einen Nutzer | `routes/_deps.py::resolve_channel_for_user` |
| Zugangsprüfung beim Senden | `routes/ws_op_send.py:139-151` |
| Ereignis-Filter | `pubsub_perm_filter.py` — gatet `chat:channel:*` über `VIEW_CHANNEL`, lässt DMs ungefiltert |
| Schalter mit Vorgabe „aus" | `config.py:155` (`cloud_dm_attachments_enabled`), geprüft in `routes/attachments.py:117-131` |
| Konto-Löschung räumt mit | `user_purge.py` |

---

### Task 1: Modelle und Migration

**Files:**
- Create: `models/private_gruppen.py`, `alembic/versions/<datum>_<n>_private_gruppen.py`
- Modify: `models/__init__.py`
- Test: `tests/test_private_gruppen.py`

**Interfaces:**
- Produces: `PrivateGroupChannel(id, ersteller_id, name, created_at, last_message_id)`
- Produces: `PrivateGroupMember(id, gruppe_id, user_id, beigetreten_am)`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
@pytest.mark.asyncio
async def test_dieselbe_person_ist_nur_einmal_mitglied(session_factory):
    """Sonst zaehlt die Gruppe falsch, und beim Verteilen des
    Gruppenschluessels (G2) bekaeme dasselbe Konto zwei Umschlaege."""


@pytest.mark.asyncio
async def test_mitglieder_verschwinden_mit_der_gruppe(session_factory):
    """Aufgeloeste Gruppe, verwaiste Mitgliedszeilen — dieselbe
    CASCADE-Pruefung wie beim Schluesselverzeichnis. SQLite braucht dafuer
    PRAGMA foreign_keys=ON (autouse-Fixture, s. tests/test_schluessel.py)."""
```

- [ ] **Schritt 2 bis 4:** Fehlschlag bestätigen, Modelle schreiben, Migration
      (`alembic heads` lesen), Re-Export, Tests, Committen.

**Kanal-ID aus demselben Generator** wie Community-Kanäle und DMs — nur dann
bleibt `Message.channel_id` polymorph eindeutig. `snowflake_pk()` benutzen, wie
`DirectMessageChannel` es tut.

---

### Task 2: Routen und Mitgliedschaft

**Files:**
- Create: `routes/private_gruppen.py`
- Modify: `routes/__init__.py`, `schemas.py`, `config.py`
- Test: `tests/test_private_gruppen.py`

**Interfaces:**
- Produces: `POST /gruppen` · `GET /gruppen` · `GET /gruppen/{id}` · `POST /gruppen/{id}/mitglieder` · `DELETE /gruppen/{id}/mitglieder/{user_id}` · `POST /gruppen/{id}/verlassen`

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

```python
@pytest.mark.asyncio
async def test_abgeschaltet_gibt_es_keine_gruppen(client, ...):
    """Der wichtigste Test dieser Etappe. Die Vorgabe ist AUS, und solange
    sie aus ist, darf keine Gruppe entstehen — sonst gaebe es
    unverschluesselten Altbestand, und die Spec verliert ihren groessten
    Vorteil (Gruppen sind von Geburt an verschluesselt, weil es sie vorher
    nicht gab)."""


@pytest.mark.asyncio
async def test_nur_der_ersteller_fuegt_hinzu_und_entfernt(client, ...):
    """Keine Rollen, keine Overwrites — das ist der Unterschied zu einer
    Community. Aber auch keine Selbstbedienung."""


@pytest.mark.asyncio
async def test_jedes_mitglied_darf_selbst_gehen(client, ...):
    """Auch der Ersteller. Was dann mit der Gruppe passiert, entscheidet
    Schritt 3 — und der Test haelt die Entscheidung fest."""


@pytest.mark.asyncio
async def test_nichtmitglied_sieht_die_gruppe_nicht(client, ...):
    """Weder in der Liste noch einzeln. Zwei Wege, zwei Pruefungen —
    dieselbe Doppelung wie bei den Standplatz-Geraeten (Route UND
    Ereignisweg)."""


@pytest.mark.asyncio
async def test_geblockte_person_kann_nicht_hinzugefuegt_werden(client, ...):
    """Sonst waere die Gruppe ein Weg, eine Blockierung zu umgehen."""


@pytest.mark.asyncio
async def test_obergrenze_der_mitgliederzahl(client, ...):
    """In G2 wird der Gruppenschluessel an JEDES Geraet JEDES Mitglieds
    verteilt. Ohne Obergrenze ist eine Mitgliedschaftsaenderung in einer
    grossen Gruppe ein Schwall."""
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen.**

- [ ] **Schritt 3: Umsetzen**

Drei Festlegungen, die getroffen werden **müssen** und deren Begründung in den
Code gehört:

1. **Was passiert, wenn der Ersteller geht?** Vorschlag: die Gruppe bleibt und
   das dienstälteste verbleibende Mitglied erbt. Begründung: eine Gruppe, die
   mit ihrem Gründer verschwindet, nimmt allen anderen ihren Verlauf mit — und
   der liegt ab Etappe C nur noch auf Geräten. Die Alternative (Gruppe wird
   aufgelöst) ist vertretbar, muss dann aber **ausdrücklich** so entschieden
   und im Test festgehalten werden.
2. **Was passiert bei der letzten Person?** Die Gruppe wird gelöscht — eine
   Gruppe mit null Mitgliedern ist nichts.
3. **Blockierungen** werden beim Hinzufügen geprüft, mit denselben Helfern wie
   überall (`block_exists_either_way`).

- [ ] **Schritt 4: Konto-Löschung nachziehen**

`user_purge.py` muss Mitgliedschaften räumen — und die Frage aus Punkt 1
beantworten, wenn der Gelöschte Ersteller war. **Nicht vergessen:** genau diese
Stelle wurde bei Migration 0063 übersehen, und die Einladungs-Inbox blieb
danach stehen. Ein Test dafür gehört dazu.

- [ ] **Schritt 5: Tests laufen lassen, `bash scripts/gate.sh`, Committen**

---

### Task 3: Nachrichten in einer Gruppe

**Files:**
- Modify: `routes/_deps.py` (`resolve_channel_for_user`), `routes/ws_op_send.py`, `pubsub_perm_filter.py`
- Test: `tests/test_private_gruppen.py`

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

```python
@pytest.mark.asyncio
async def test_mitglied_kann_in_die_gruppe_schreiben(client, ...): ...


@pytest.mark.asyncio
async def test_nichtmitglied_kann_nicht_schreiben(client, ...): ...


@pytest.mark.asyncio
async def test_wer_entfernt_wurde_bekommt_nichts_mehr(client, ...):
    """Der Ereignisweg, nicht nur die Route. Wer nur die Route prueft,
    laesst einen Entfernten weiter mitlesen, solange sein Socket offen ist
    — und genau so lange dauert eine Sitzung."""
```

- [ ] **Schritt 2 bis 4: Umsetzen, prüfen, committen**

**Der Ereignis-Filter ist der heikle Teil.** `pubsub_perm_filter.py` kennt heute
zwei Fälle: Community-Kanäle über `VIEW_CHANNEL`, DMs ungefiltert. Eine private
Gruppe ist keins von beidem — sie braucht eine Mitgliedschaftsprüfung. Wer sie
als DM behandelt („ungefiltert"), schickt jede Gruppennachricht an jeden
verbundenen Socket.

---

## Selbstprüfung dieses Plans

**Spec-Abdeckung:** §9 „neue Kanalart samt Mitgliederverwaltung" → Task 1 und 2.
„wer die Gruppe anlegt, darf hinzufügen und entfernen; jedes Mitglied darf
selbst gehen" → Task 2. „Obergrenze für die Mitgliederzahl" → Task 2.
Nachrichtenweg → Task 3.

**Nicht hier:** Megolm, Schlüsselverteilung, Schlüsselwechsel bei
Mitgliedschaftsänderung, Oberfläche. Das ist G2 und setzt Etappe D voraus.

**Die Anforderung „Teilnahme setzt ein App-Gerät voraus"** aus der Spec gehört
ebenfalls zu G2, nicht hierher: sie ergibt erst dann einen Sinn, wenn die
Gruppe wirklich verschlüsselt ist. Sie hier zu prüfen, hiesse Leute
auszusperren, ohne dass es ihnen etwas brächte.

**Der Zuschnitt von Task 3 war zu klein, und das ist nachgezählt.** Der erste
Entwurf nannte zwei Stellen (`resolve_channel_for_user`, der Ereignis-Filter).
Tatsächlich unterscheiden **fünfzehn Dateien** zwischen Kanalarten
(`rg -rn 'kind == "dm"|kind == "guild"|is_dm|DirectMessageChannel' services/chat-gateway/src/`,
Stand 2026-08-28):

| Datei | Fundstellen |
|---|---|
| `routes/dms.py` | 20 |
| `routes/messages.py` | 14 |
| `routes/ws_op_send.py` | 12 |
| `routes/_deps.py` | 7 |
| `routes/ws_ready.py` | 6 |
| `user_purge.py` | 5 |
| `routes/reactions.py`, `routes/attachments.py` | je 4 |
| `system_dm.py`, `routes/ws_ops_handlers.py` | je 3 |
| `routes/ws_typing.py`, `routes/reports.py`, `routes/admin.py`, `pubsub_perm_filter.py` | je 2 |

**Eine dritte Kanalart ist damit kein Zusatz, sondern ein Durchgang durch den
halben Dienst.** Jede dieser Stellen fragt heute „DM oder Community?" und
bekommt für eine Gruppe eine Antwort, die zufällig ist — meist „Community",
weil das der `else`-Zweig ist. Ein Gruppenkanal ohne Guild landet dann in einer
Rechteprüfung, die keine Rolle findet.

**Folge für die Umsetzung:** Task 3 ist NICHT in einem Zug zu machen. Wer ihn
angeht, geht die Tabelle Datei für Datei durch, entscheidet je Fundstelle
bewusst (Gruppe verhält sich wie DM? wie Community? eigener Zweig?) und
schreibt die Entscheidung als Kommentar dazu. Reaktionen, Anhänge, Tipp-Anzeige
und Meldungen sind dabei je ein eigener kleiner Schritt mit eigenem Test.

**Und eine Warnung an die Oberfläche**, die aus derselben Zählung folgt: der
`ready`-Rahmen (`ws_ready.py`) liefert heute `dm_channels`. Gruppen brauchen
dort ein eigenes Feld — sie in die DM-Liste zu mischen, weil beide „privat"
sind, macht aus zwei Begriffen einen und rächt sich an jeder Stelle, die danach
sortiert oder zählt.
