# Etappe D — Das Postfach (Server-Hälfte) — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Server nimmt verschlüsselte Umschläge entgegen, hält sie bis zur
Abholung, und löscht sie danach — quittiert oder verfristet. Er kann keinen
davon öffnen.

**Architecture:** Zwei Tabellen, nicht eine. Die **Nutzlast** ist der Umschlag
selbst, die **Zustellung** ist eine Zeile je Empfängergerät, die darauf zeigt.
Bei einer DM verschlüsselt Olm für jedes Gerät einzeln — so viele Nutzlasten
wie Zustellungen. Bei einer Gruppe verschlüsselt Megolm einmal — eine Nutzlast,
viele Zustellungen. Ohne diese Trennung wäre der Gruppenfall ein Sonderweg.

**Tech Stack:** FastAPI · SQLAlchemy[asyncio] · Alembic · Redis Pub/Sub · pytest

**Spec:** `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` (§4 „Zustellung
und Löschen", §9 „Was Gruppen mit dem Rest teilen")

**Ausdrücklich NICHT in dieser Etappe:** der Klient. Diese Etappe baut, wogegen
er später spricht, und ist vollständig mit pytest prüfbar. Etappe A
(`pulse-krypto`) wird hier **nicht** benutzt — der Server bewegt undurchsichtige
Bytes.

## Global Constraints

- **Alembic-Revision-ID ≤ 32 Zeichen**, `down_revision` gegen den tatsächlichen Kopf (`alembic heads`). Der Wächter `tests/test_alembic_koepfe.py` muss grün bleiben.
- **Quelldateien ≤ 350 Zeilen (hart 500).**
- **Niemals Umschläge, Schlüssel oder Klartext loggen** — auch keine Auszüge, auch nicht in Fehlermeldungen. Eine Grössenangabe ist in Ordnung, ein Inhalt nie.
- **Keine neuen Abhängigkeiten. Kein `git push`.**
- **Changelog:** unsichtbar für Nutzer → **kein** Eintrag.
- Deutsche Kommentare und Commit-Nachrichten, echte Umlaute.

## Was vorher da ist

| Was | Wo |
|---|---|
| Heutiger Sendeweg (Klartext, bleibt unangetastet) | `routes/ws_op_send.py:68`, veröffentlicht auf `chat:channel:{id}` (`:281`), dazu `dm_bump` (`:337-345`) und Web-Push (`:354`) |
| Gerät weist sich mit Zertifikat + Unterschrift aus | `schluessel_nachweis.py::pruefe_geraet(cert_jwt, nutzlast, signatur_b64, user, redis)` (Etappe B) |
| Verzeichnis der Geräte | `models/geraete_schluessel.py::DeviceKeyBundle` (Etappe B) |
| Wer darf wem schreiben | `routes/schluessel.py::_darf_schluessel_holen` bzw. `routes/dms.py` (Block- und Freundschaftsprüfung) |
| Aufräum-Schleife, in die ein zweiter Gegenstand gehört | `cleanup.py::_run_once` + `cleanup_loop` — trägt seit dem 2026-08-28 bereits zwei Gegenstände |
| Redis-Kanalnamen | `pubsub_channels.py` |

**Die Entscheidung, die diese Etappe leicht macht:** das Abholen läuft über
**REST mit Zertifikats-Nachweis**, nicht über die WebSocket-Verbindung. Grund:
der WS-Zugang kennt den **Nutzer**, aber kein **Gerät** — auf der Cloud trägt
der Access-Token keine Geräteangabe. Etappe B hat den Nachweis dafür schon
gebaut; ihn hier wiederzuverwenden kostet nichts. Die WS-Verbindung meldet nur
„da liegt etwas", der Klient holt es dann ab.

## Dateizuschnitt

| Datei | Verantwortung |
|---|---|
| `models/postfach.py` | `DmNutzlast`, `DmZustellung` |
| `alembic/versions/<datum>_<n>_postfach.py` | beide Tabellen |
| `routes/postfach.py` | einliefern, abholen, quittieren |
| `postfach_pflege.py` | Verfall und verwaiste Nutzlasten |
| `cleanup.py` | ruft die Pflege mit auf (**keine zweite Schleife**) |
| `tests/test_postfach.py` | alles davon |

---

### Task 1: Die zwei Tabellen

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/models/postfach.py`
- Create: `services/chat-gateway/alembic/versions/<datum>_<n>_postfach.py`
- Modify: `models/__init__.py`
- Test: `services/chat-gateway/tests/test_postfach.py`

**Interfaces:**
- Produces: `DmNutzlast(id, channel_id, absender_device_pubkey, art, daten, groesse, created_at)`
- Produces: `DmZustellung(id, nutzlast_id, empfaenger_device_pubkey, empfaenger_user_id, verfaellt_am, created_at)`

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
"""Das Postfach: Nutzlast und Zustellung getrennt."""

import pytest


@pytest.mark.asyncio
async def test_eine_nutzlast_traegt_mehrere_zustellungen(session_factory):
    """Der Gruppenfall. Megolm verschluesselt EINMAL fuer alle — ohne diese
    Trennung muesste derselbe Umschlag je Geraet kopiert werden, und bei
    zwanzig Mitgliedern mit je zwei Geraeten waeren das vierzig Kopien
    derselben Bytes.
    """
    from sqlalchemy import select

    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id

    nid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="umschlag", groesse=8,
        ))
        for pubkey in ("G1", "G2", "G3"):
            s.add(DmZustellung(
                id=next_id(), nutzlast_id=nid,
                empfaenger_device_pubkey=pubkey, empfaenger_user_id=2,
            ))
        await s.commit()

    async with session_factory() as s:
        zustellungen = (await s.execute(
            select(DmZustellung).where(DmZustellung.nutzlast_id == nid)
        )).scalars().all()
        assert len(zustellungen) == 3


@pytest.mark.asyncio
async def test_zustellungen_verschwinden_mit_ihrer_nutzlast(session_factory):
    """Eine Zustellung ohne Nutzlast ist ein Zeiger ins Leere."""
    from sqlalchemy import delete, select

    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id

    nid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="x", groesse=1,
        ))
        s.add(DmZustellung(
            id=next_id(), nutzlast_id=nid,
            empfaenger_device_pubkey="G1", empfaenger_user_id=2,
        ))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(DmNutzlast).where(DmNutzlast.id == nid))
        await s.commit()

    async with session_factory() as s:
        rest = (await s.execute(
            select(DmZustellung).where(DmZustellung.nutzlast_id == nid)
        )).scalars().all()
        assert rest == []
```

**Zur zweiten Prüfung:** die Test-DB ist SQLite und erzwingt
`ON DELETE CASCADE` nur mit `PRAGMA foreign_keys=ON`. `tests/test_schluessel.py`
setzt das bereits über eine `autouse`-Fixture — **denselben Weg nehmen**, nicht
die Prüfung abschwächen.

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

```bash
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest \
  services/chat-gateway/tests/test_postfach.py -v
```

- [ ] **Schritt 3: `models/postfach.py` schreiben**

Am Muster von `models/geraete_schluessel.py`. Wichtige Festlegungen, die als
Kommentar hineingehören:

- `daten` ist **Text (Base64)**, nicht `LargeBinary` — dasselbe Format, in dem
  der Krypto-Kern seine Umschläge herausreicht, und dasselbe, in dem der Klient
  sie über JSON bekommt. Eine Umkodierung an der Grenze wäre eine zusätzliche
  Fehlerquelle ohne Gewinn.
- `groesse` wird **mitgeschrieben**, damit Obergrenzen und Aufräum-Statistiken
  ohne Lesen der Nutzlast auskommen.
- **Geführt wird über `device_pubkey`, nicht über `cert_id`** — die
  Zertifikatserneuerung wechselt alle 30 Tage die `cert_id` bei gleichem
  Pubkey; an ihr hängende Zustellungen verwaisten monatlich. (Dieselbe
  Festlegung wie in Etappe B, aus demselben Grund.)
- `verfaellt_am` ist **nullable-frei**: jede Zustellung hat eine Frist. Eine
  Zeile ohne Frist wäre eine, die nie wegginge — genau das, was diese Etappe
  verhindern soll.
- Index auf `(empfaenger_device_pubkey, id)`: die häufigste Abfrage ist „was
  liegt für mich, älteste zuerst".
- Index auf `verfaellt_am` für den Verfallslauf.

- [ ] **Schritt 4: Re-Export, Migration, Tests, Committen**

`alembic heads` vorher lesen. Revision-ID ≤ 32 Zeichen. `downgrade()` löscht in
umgekehrter Reihenfolge.

```bash
git commit -m "feat(postfach): Tabellen fuer Nutzlast und Zustellung"
```

---

### Task 2: Einliefern

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/routes/postfach.py`
- Modify: `routes/__init__.py`, `schemas.py`
- Test: `tests/test_postfach.py`

**Interfaces:**
- Produces: `POST /postfach` — Rumpf `{channel_id, cert, signatur, nutzlasten: [{art, daten, empfaenger: [device_pubkey…]}]}` — **`cert`, nicht `cert_jwt`**; letzteres ist nur der Parametername in `pruefe_geraet`
- Produces: WS-Ereignis `postfach_neu` auf dem bestehenden Kanalweg

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

```python
@pytest.mark.asyncio
async def test_einliefern_legt_je_empfaenger_eine_zustellung_an(client, ...):
    """Eine Nutzlast, drei Empfaengergeraete -> drei Zustellungen."""


@pytest.mark.asyncio
async def test_fremder_kanal_wird_abgewiesen(client, ...):
    """Wer im Kanal nichts zu suchen hat, liefert auch nichts ein.
    Dieselbe Regel wie beim Klartext-Senden — NICHT eine neue erfinden."""


@pytest.mark.asyncio
async def test_zu_grosser_umschlag_wird_abgewiesen(client, ...):
    """Ohne Obergrenze ist das Postfach ein kostenloser Dateispeicher, und
    zwar einer, dessen Inhalt niemand pruefen kann."""


@pytest.mark.asyncio
async def test_unbekanntes_empfaengergeraet_wird_uebergangen(client, ...):
    """Ein Pubkey ohne Buendel im Verzeichnis erzeugt keine Zustellung —
    aber auch keinen Fehler fuer die uebrigen Empfaenger. Ein Geraet kann
    zwischen Abholen der Schluessel und Absenden abgemeldet worden sein;
    das ist Alltag, kein Fehler."""


@pytest.mark.asyncio
async def test_einliefern_weckt_die_empfaenger(client, ...):
    """Ohne Weckruf merkt ein offener Klient nichts, bis er zufaellig
    nachsieht."""
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen.**

- [ ] **Schritt 3: Die Route schreiben**

Ablauf, alle Prüfungen fail-closed:

1. `pruefe_geraet(...)` aus Etappe B — der Absender weist sich als Gerät aus.
   Die unterschriebene Nutzlast bekommt einen **eigenen Zweck** (`"postfach"`),
   damit eine für ein Schlüsselbündel geleistete Unterschrift hier nicht gilt.
2. Kanalzugang prüfen — **dieselbe** Regel wie im Klartext-Weg
   (`ws_op_send.py:139-151`): DM-Kanal laden, fehlt er → abweisen; sonst
   `block_exists_either_way` und `friendship_exists` aus `friend_helpers`.
   Das sind dieselben Helfer, die schon `routes/schluessel.py` benutzt —
   **keine dritte Regel erfinden.**
3. Obergrenzen: Grösse je Umschlag, Anzahl Nutzlasten je Anfrage, und offene
   Zustellungen je Empfängergerät. Werte in die Einstellungen, Vorbild
   `push_subscription_idle_days`.
4. Nutzlasten und Zustellungen anlegen, `verfaellt_am = jetzt + Frist`.
5. Weckruf: ein **inhaltsloses** Ereignis auf dem bestehenden Kanalweg
   (`pubsub_channels.py`). Es trägt Kanal und Anzahl, **nie** einen Umschlag —
   sonst läge der Inhalt wieder in Redis.

- [ ] **Schritt 4: Tests laufen lassen, Committen**

```bash
git commit -m "feat(postfach): verschluesselte Umschlaege einliefern"
```

---

### Task 3: Abholen und Quittieren

**Files:**
- Modify: `routes/postfach.py`, `schemas.py`
- Test: `tests/test_postfach.py`

**Interfaces:**
- Produces: `POST /postfach/abholen` — Nachweis wie oben, liefert die offenen Zustellungen dieses Geräts
- Produces: `POST /postfach/quittung` — Liste von Zustellungs-IDs, löscht sie

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

```python
@pytest.mark.asyncio
async def test_abholen_liefert_nur_die_eigenen(client, ...):
    """Das Geraet eines anderen Nutzers darf nichts davon sehen — und das
    Geraet DESSELBEN Nutzers auch nicht: ein Umschlag ist fuer genau ein
    Geraet verschluesselt."""


@pytest.mark.asyncio
async def test_abholen_loescht_noch_nichts(client, ...):
    """Zweimal abholen ohne Quittung liefert dasselbe. Wer beim Ausliefern
    loescht, verliert die Nachricht, wenn die Antwort unterwegs verlorengeht
    — und genau das passiert bei einem Handy im Funkloch staendig."""


@pytest.mark.asyncio
async def test_quittung_loescht_die_zustellung(client, ...):
    """Der Normalfall."""


@pytest.mark.asyncio
async def test_letzte_quittung_raeumt_die_nutzlast_mit(client, ...):
    """Eine Nutzlast, die niemand mehr abholen kann, ist Muell. Bei einer
    Gruppe faellt sie erst mit der LETZTEN Zustellung."""


@pytest.mark.asyncio
async def test_fremde_zustellungs_id_quittiert_nichts(client, ...):
    """Eine erratene ID darf nicht die Zustellung eines anderen loeschen.
    Die Quittung filtert auf das eigene Geraet, nicht nur auf die ID."""
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen.**

- [ ] **Schritt 3: Umsetzen**

**Der entscheidende Entwurfspunkt: Abholen löscht nicht.** Gelöscht wird erst
auf Quittung. Anders wäre jede verlorene Antwort ein verlorener Umschlag, und
weil es kein serverseitiges Backup gibt, wäre er endgültig weg. Der Preis ist,
dass ein Klient, der nie quittiert, seine Zustellungen bis zur Frist behält —
das ist die richtige Richtung, in die man sich irrt.

Die Quittung filtert **immer** zusätzlich auf das nachgewiesene Empfängergerät.
Das Aufräumen der Nutzlast danach läuft über „hat sie noch Zustellungen?" —
und **nicht** über einen Zähler in der Nutzlast, den zwei gleichzeitige
Quittungen falsch stellen könnten.

- [ ] **Schritt 4: Tests laufen lassen, Committen**

```bash
git commit -m "feat(postfach): abholen und quittieren, geloescht wird auf Quittung"
```

---

### Task 4: Verfall

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/postfach_pflege.py`
- Modify: `cleanup.py` (Aufruf **und** Modul-Docstring), `config.py`
- Test: `tests/test_postfach.py`

**Interfaces:**
- Produces: `sweep_verfallene_zustellungen(session) -> int`, `sweep_verwaiste_nutzlasten(session) -> int`

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

```python
@pytest.mark.asyncio
async def test_verfallene_zustellung_wird_gefegt(session_factory):
    """Ein Geraet, das nie wiederkommt, darf den Server nicht dauerhaft
    belegen."""


@pytest.mark.asyncio
async def test_nicht_verfallene_bleibt_stehen(session_factory):
    """Die Gegenprobe. Ohne sie faengt der Fegelauf im Zweifel alles weg,
    und das faellt erst auf, wenn Nachrichten verschwinden."""


@pytest.mark.asyncio
async def test_verwaiste_nutzlast_wird_gefegt(session_factory):
    """Eine Nutzlast, deren letzte Zustellung verfiel, ist unlesbar
    geworden — sie loescht sich nicht von selbst, weil der Verfall an der
    Zustellung haengt."""
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen.**

- [ ] **Schritt 3: Umsetzen und in den bestehenden Takt hängen**

`cleanup.py` hat mit `cleanup_loop` bereits eine schlafgesteuerte Schleife und
fegt zwei Gegenstände (Web-Push-Abos und abgelaufene Einladungen). **Den
dritten dort mit aufrufen, keine neue Schleife**, und den Modul-Docstring auf
drei Gegenstände erweitern — er zählt sie namentlich auf und wäre sonst falsch.

- [ ] **Schritt 4:** `bash scripts/gate.sh` grün, dann committen

```bash
git commit -m "feat(postfach): Verfall und verwaiste Nutzlasten wegfegen"
```

---

## Nachtrag 2026-08-28 zur Antwortform

`POST /postfach` antwortet **nicht mehr mit 204**, sondern mit
`PostfachEinliefernResponse{zustellungen_angelegt, uebersprungene_empfaenger,
verworfene_nutzlasten}`. Grund: ein unbedingtes 204 liess den Absender glauben,
die Nachricht sei zugestellt, auch wenn jedes Empfängergerät übersprungen wurde
(kein Bündel, oder Kontingent voll) und deshalb gar nichts gespeichert wurde.
Wer diesen Plan für die Gruppen-Erweiterung abschreibt, übernimmt sonst genau
diesen Fehler noch einmal.

## Selbstprüfung dieses Plans

**Spec-Abdeckung:** §4 „Postfach je Empfängergerät, Nutzlast und Zustellung
getrennt" → Task 1. „Quittung löscht, Frist löscht" → Task 3 und 4. §4 „der
Verteilweg bleibt derselbe" → Task 2, Weckruf über den bestehenden Kanalweg.
§9 „derselbe Fächer-Aufsatz trägt Gruppen" → Task 1, eine Nutzlast mit mehreren
Zustellungen ist der erste Test.

**Nicht in dieser Etappe:** der Klient, die Umstellung des Sendewegs, das
Löschen des Klartext-Bestands (Etappe I), Anhänge (Etappe E).

**Die zwei Punkte, die beim Schreiben unsicher waren, sind nachgeschlagen:**

1. **Die Kanalzugangsprüfung** im Klartext-Weg (`routes/ws_op_send.py:139-151`):
   bei `kind == "dm"` wird der `DirectMessageChannel` geladen; fehlt er, gilt
   der Kanal als unzugänglich (`ok = False`) — der Kommentar dort begründet
   das ausdrücklich damit, dass ein Durchfallen auf `ok = True` das
   Freundschafts- und Block-Gate überspringen und eine verwaiste Nachricht
   schreiben würde. Das Gate selbst nutzt `block_exists_either_way` und
   `friendship_exists` aus `friend_helpers` (Import `:27-29`) — **dieselben
   Helfer, die auch das Schlüssel-Abholen aus Etappe B verwendet.** Task 2
   ruft sie ebenfalls, statt eine dritte Regel zu erfinden.
2. **Der Weckruf** trägt: der Berechtigungs-Filter (`pubsub_perm_filter.py`)
   gatet `chat:channel:*` über `VIEW_CHANNEL`, lässt **DM-Kanäle aber
   ungefiltert** — für DMs entscheidet die Mitgliedschaft am Kanal, nicht ein
   Rechte-Bit. Für private Gruppen (Etappe G) ist das erneut zu prüfen, weil
   dort eine Mitgliedertabelle dazukommt.

**Was diese Etappe bewusst NICHT löst:** ein Gerät, das seine Zustellungen
abholt, verrät dem Server damit, **dass** es online ist und **wie viel** für es
anliegt. Metadaten dieser Art bleiben sichtbar — das Schutzziel der Spec ist
Datensparsamkeit bei den Inhalten, nicht Verkehrsanalyse-Schutz. Wer das später
angreift, baut ein anderes System.
