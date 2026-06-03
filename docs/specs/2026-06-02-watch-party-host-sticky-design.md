# Watch-Party: Host-sticky statt Auto-Handoff

**Datum:** 2026-06-02
**Status:** Design (zur Review)
**Betrifft:** `services/chat-gateway` (Watch-Party-Lifecycle)

## Problem

Aktuell promotet der Server beim Host-Wegfall (Disconnect / Channel-Leave /
Kachel-Unmount) automatisch den ältesten verbliebenen Watcher zum Host
(`promote_or_end`, verdrahtet in `cleanup_on_disconnect` und `handle_leave`).

Reales Symptom: Geht der Host kurz AFK und seine WS-Verbindung bricht weg
(Rechner schläft / Bildschirmsperre / Netzwerk-Blip), wird **sofort** ein
anderer Zuschauer Host. Der ursprüngliche Host kommt zurück und ist seine Party
los. Das ist unerwünscht.

## Gewünschtes Verhalten

Der **Host besitzt die Party**. Sie wechselt den Host nur, wenn der Host sie
*explizit* abgibt. Verschwindet der Host, **endet die Party** — sie wird nicht
weitergereicht. Gegen kurze Verbindungsabrisse schützt eine **30-Sekunden-
Schonfrist**: Kommt der Host innerhalb von 30 s zurück, behält er die Party.

### Regeltabelle

| Auslöser | Op | Verhalten |
|---|---|---|
| Stop-Button | `watch_stop` (`handle_stop`) | endet **sofort** (host-only) — unverändert |
| Expliziter Handoff | `watch_handoff` (`handle_handoff`) | gibt an Ziel-Watcher bzw. nächsten ab — unverändert |
| Host Kachel-Unmount / Channel-Wechsel | `watch_leave` (`handle_leave`) | endet **sofort** — bewusste Aktion, keine Schonfrist |
| Host disconnect (WS-Abriss) | `cleanup_on_disconnect` | **30 s Schonfrist**, dann Ende, falls Host nicht zurück |
| Host kommt in <30 s zurück | `watch_join` | Schonfrist-Timer abgebrochen, bleibt Host |
| Zuschauer (nicht-Host) geht | `watch_leave` / cleanup | nichts — Party läuft weiter |

**Warum nur Disconnect die Schonfrist bekommt:** Ein Channel-Wechsel ist eine
bewusste Navigation bei *bestehender* Verbindung (Client sendet `watch_leave`,
Socket lebt weiter). Ein Blip dagegen ist ein WS-Abriss ohne `watch_leave` →
landet auf `cleanup_on_disconnect`. Genau dort — und nur dort — schützt die
Schonfrist.

**Kein Auto-Promotion mehr** auf den Departure-Pfaden. `promote_or_end` bleibt
erhalten, wird aber **nur noch** vom expliziten `handle_handoff` aufgerufen.

## Backend-Änderungen (`services/chat-gateway`)

### 1. Schonfrist-Timer-Registry (`ConnectionManager` / Watch-Registry-Mixin)

Neuer in-process State auf dem Manager (single-pod, single-writer — wie die
bestehende Watcher-Registry, kein Redis):

```
_watch_end_timers: dict[str, tuple[str, asyncio.Task]]   # channel_id -> (host_uid, task)
```

Neue Methoden auf dem Mixin (`watch_registry.py`):

- **`schedule_host_end(redis, channel_id, host_uid, *, delay=WATCH_HOST_GRACE_S)`**
  Bricht einen ggf. bestehenden Timer für den Channel ab und legt einen neuen
  `asyncio.Task` an, der nach `delay` Sekunden `_host_end_after_grace` ausführt.
  Idempotent pro Channel (immer nur ein Timer).

- **`cancel_host_end(channel_id, *, host_uid=None)`**
  Bricht den Timer ab (no-op, wenn keiner läuft). Mit `host_uid` nur abbrechen,
  wenn der Timer auf genau diesen Host läuft (für den `watch_join`-Pfad).

- **`_host_end_after_grace(redis, channel_id, host_uid, delay)`** (intern):
  1. `await asyncio.sleep(delay)`
  2. Unter `self._lock`: ist `host_uid` wieder in der Watcher-Menge des
     Channels? → **abort** (Host ist zurück).
  3. `state = read_state(...)`; ist `None` oder `host_user_id != host_uid` →
     **abort** (Party schon beendet oder Host hat explizit abgegeben).
  4. Sonst: `delete_state(...)` → Party endet (null-State-Event an alle).
  5. `finally`: eigenen Eintrag aus `_watch_end_timers` entfernen.

  Punkt 2+3 sind die Autorität (Belt-and-Suspenders); `cancel_host_end` ist der
  schnelle Pfad, der den Task gar nicht erst durchlaufen lässt.

`WATCH_HOST_GRACE_S = 30` als Modul-Konstante (in `watchkeys.py`, neben den
TTLs) — injizierbar über den `delay`-Parameter für Tests.

### 2. Departure-Pfade trennen: sofort-Ende vs. Schonfrist

Zwei neue Funktionen in `watch_handoff.py` — beide no-op, wenn der Gehende
*nicht* der Host ist (Zuschauer-Abgang lässt die Party laufen):

```python
async def end_if_host(redis, channel_id, departing_uid):
    """Host left deliberately (tile unmount / channel switch) → end now."""
    if redis is None:
        return
    state = await watchkeys.read_state(redis, channel_id)
    if state is None or str(state.get("host_user_id")) != str(departing_uid):
        return
    await watchkeys.delete_state(redis, channel_id)


async def end_or_grace_if_host(redis, manager, channel_id, departing_uid):
    """Host's WS dropped → start the grace timer (party ends in
    WATCH_HOST_GRACE_S unless the host reconnects and rejoins)."""
    if redis is None:
        return
    state = await watchkeys.read_state(redis, channel_id)
    if state is None or str(state.get("host_user_id")) != str(departing_uid):
        return
    manager.schedule_host_end(redis, channel_id, str(departing_uid))
```

Call-Sites umstellen (waren `promote_or_end`):
- `ws_watch.py::handle_leave` → **`end_if_host`** (sofort, keine Schonfrist)
- `ws_watch.py::cleanup_on_disconnect` → **`end_or_grace_if_host`** (30 s Schonfrist)

### 3. Timer-Abbruch verdrahten

- **`watch_join`** (`watch_registry.py`): nach dem Hinzufügen der Socket
  `cancel_host_end(channel_id, host_uid=user_id)` aufrufen — der zurückgekehrte
  Host bricht seine eigene Schonfrist ab. (Reine in-process-Operation, kein
  Redis-Read nötig: der Timer kennt seinen `host_uid`.)
- **`handle_stop`**: nach `delete_state` `cancel_host_end(cid)` — kein
  verwaister Timer auf eine bereits beendete Party.
- **`handle_handoff`**: nach erfolgreichem Handoff `cancel_host_end(cid)` —
  der State-Host hat gewechselt, eine ggf. (theoretisch) laufende Schonfrist
  auf den alten Host ist gegenstandslos.

### 4. `promote_or_end` bleibt — nur noch für expliziten Handoff

Unverändert, einziger verbleibender Aufrufer ist `handle_handoff` (no-target-
Pfad). Target-Handoff (`promoted_state` + `write_state`) unverändert.

## UX während der Schonfrist (bewusst akzeptiert)

Die beiden Einstiegspunkte zum *Öffnen* der Party — das PARTY-Badge auf der
Voice-Teilnehmer-Kachel (`VoiceParticipantTile.svelte`) und in der Mitglieder-
Sidebar (`VoiceChannelMembers.svelte`) — hängen an der Host-Präsenz im Voice-
Channel. Bei einem echten Disconnect fällt der Host auch aus LiveKit-Voice →
beide Badges verschwinden. Folge in den 30 s:

- Zuschauer mit **bereits geöffnetem** Tile schauen nahtlos weiter (lokale
  Wiedergabe läuft; ohne Host-Heartbeats nur kein Drift-Abgleich). Kommt der
  Host zurück, greift der Sync wieder.
- Zuschauer **ohne** geöffneten Tile haben in dem Fenster keinen Öffnen-Button.

Das ist akzeptiert: Die Schonfrist dient der Host-Rückkehr und dem nahtlosen
Weiterschauen, nicht dem Neu-Einstieg während des Blips. Kommt der Host zurück,
ist das Badge sofort wieder da; kommt er nicht, endet die Party ohnehin. Eine
host-entkoppelte Party-Anzeige ist **nicht** Teil dieses Specs.

## Frontend

**Keine funktionale Änderung nötig.** Das Party-Ende (null-State auf
`watch:events`) wird vom Client bereits gehandhabt (Kachel unmountet). Der
„du bist jetzt Host"-Toast feuert auf Departure schlicht nicht mehr, weil keine
Promotion mehr stattfindet. Der explizite Handoff-Picker bleibt voll funktional.

Reconnect-Verhalten ist bereits korrekt: Nach einem WS-Reconnect remountet die
Kachel und sendet `watch_join` → bricht die Schonfrist ab.

Ggf. nur Kommentar-/Doku-Anpassungen.

## Edge Cases

- **Multi-Tab:** `watch_leave` liefert `fully_left=True` nur, wenn die *letzte*
  Socket des Hosts geht. Ein zweiter Tab hält die Party → kein Timer. Unverändert.
- **Host gibt explizit ab, während (theoretisch) ein Timer läuft:** Der Host ist
  beim Abgeben verbunden, also läuft kein Timer; zusätzlich bricht
  `handle_handoff` vorsorglich ab.
- **Pod-Restart während der Schonfrist:** In-process-Timer geht verloren; die
  Party lingert dann zur 6h-TTL (alle Clients ohnehin disconnected). Akzeptiert
  — single-pod, seltener Fall, kein Regress ggü. heute.
- **Zuschauer-Disconnect:** `end_or_grace_if_host` ist no-op (kein Host) → Party
  läuft. Unverändert.
- **Doppelter Disconnect-Trigger:** `schedule_host_end` ist idempotent pro
  Channel; `_host_end_after_grace` re-checkt State + Watcher-Menge vor dem Löschen.

## Tests

### Backend (`services/chat-gateway/tests/test_watch.py`)

- **`test_cleanup_on_disconnect_promotes_to_remaining_watcher`** → umschreiben zu
  `test_cleanup_on_disconnect_schedules_end_not_promote`: Host disconnected mit
  anderem Watcher anwesend → **kein** Host-Wechsel; mit `delay=0` (bzw.
  Timer awaiten) → State gelöscht (Party endet, wird *nicht* an "999" übergeben).
- **`test_cleanup_on_disconnect_ends_when_solo`** → anpassen: nach `delay=0` +
  Timer-await ist State `None`. (Vorher war Ende sofort — jetzt nach Schonfrist.)
- **`test_cleanup_on_disconnect_multitab_keeps_party`** → bleibt grün
  (kein fully_left → kein Timer).
- **Neu** `test_host_reconnect_within_grace_cancels_end`: Host disconnect →
  Timer geplant → `watch_join` (Host zurück) → Timer abgebrochen → State
  unverändert vorhanden, Host = ursprünglicher Host.
- **Neu** `test_grace_expires_ends_party`: Host disconnect, kein Rejoin →
  nach Ablauf (`delay=0`) State gelöscht.
- **Neu** `test_handle_leave_host_ends_immediately`: Host `watch_leave`
  (Channel-Wechsel) mit weiterem Watcher anwesend → State **sofort** gelöscht,
  **ohne** Schonfrist, **ohne** Promotion an den anderen Watcher.
- **Neu** `test_handle_leave_viewer_keeps_party`: Zuschauer `watch_leave` →
  State unverändert, Host bleibt.
- **`test_promote_or_end_*`** + **`test_handoff_*`** bleiben (decken jetzt nur
  noch den expliziten Handoff-Pfad).

Schonfrist in Tests über injizierten `delay=0` + Await des Tasks aus
`_watch_end_timers` (oder einen Test-Helper `await_watch_end(cid)`); kein
`asyncio.sleep(30)` im Test.

### E2E (`web/tests/e2e/watch-party.spec.ts`)

Sichten, ob ein Test Auto-Promotion bei Host-Leave annimmt; falls ja, auf
„Party endet" anpassen. Explizite-Handoff-E2E (falls vorhanden) bleibt.

## Doku

`CLAUDE.md`-Abschnitt **„Watch-Party Host-Handoff"** umschreiben: kein
Auto-Promotion auf Departure mehr; Host-sticky mit 30 s Schonfrist; explizites
`watch_handoff` ist der einzige Host-Wechsel-Pfad; `promote_or_end` nur noch
von `handle_handoff`.

## Nicht im Scope

- Cross-Pod-Schonfrist (Watch-Transport ist single-pod).
- Konfigurierbare Schonfrist-Dauer pro Guild/User (Konstante 30 s reicht).
- Reclaim-nach-Promotion (entfällt, da keine Auto-Promotion mehr).
