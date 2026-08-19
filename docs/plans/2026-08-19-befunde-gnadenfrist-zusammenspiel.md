# Befunde: Gnadenfrist trifft Platz-Neumeldung und Vorrang

**Stand 2026-08-19, Übergabe an die andere Maschine. Nichts davon ist repariert.**

Am 2026-08-19 sind auf `remote/2026-08-19/integration` zwei Reparaturen zusammengekommen, die
beide am Verbindungsabriss hängen und **unabhängig voneinander auf zwei Maschinen gebaut**
wurden:

- **(A) Platz-Neumeldung** (`22d70b4f`): der Standplatz meldete nach einem WS-Abriss seine
  Sendeplätze nie wieder. Neu `web/src/lib/devices/platzMeldungBuch.ts`.
- **(B) Gnadenfrist** (`8addf03a`): die Fernsteuerung endet bei einem Abriss nicht mehr sofort.
  Neu `web/src/lib/remote/gnadenfrist.ts`, `remote_reconnect_registry.py`.

Dazu (C), am selben Tag: der **Vorrang-Herzschlag** (`95a1a9c9`, `GEDULD_MS = 4000`).

Beide Testsuiten sind grün. **Keine prüft das Zusammenspiel** — und dort liegen sieben Befunde.
Zwei unabhängige Prüfläufe (Client-Seite, Gateway-Seite) sind auf das Geräteregister-Problem
getrennt gestossen; das ist der am besten belegte Befund.

Alle Befunde sind am Code verifiziert, mehrere zusätzlich gegen die **echten** Registry-Mixins
gefahren (Wegwerf-Skripte nach dem Muster von `tests/test_remote_reconnect_registry.py`).

---

## 1 — HOCH: Der Rechte-Prüflauf tötet Sitzungen mitten in der Frist

**Ort:** `services/chat-gateway/src/dcc_chat_gateway/remote_guard.py:69` (`_end_reason`)

`_end_reason` ist fail-closed: liefert `manager.remote_socket_user(...)` `None`, stirbt die
Sitzung. Während der Gnadenfrist ist das der **Normalzustand** — `remove_socket` nimmt den Socket
im `finally` von `ws_ops.py` aus `_ws_user`, direkt nachdem die Frist geplant wurde.

Der Prüflauf tickt alle 30 s, die Frist dauert 10 s → **rund ein Drittel aller Wackler** beendet
die Sitzung trotzdem; ein späteres `remote_reclaim` bekommt „session gone".

Der Kommentar an der Stelle begründet das fail-closed ausdrücklich mit dem Disconnect-Pfad. Er
stammt aus der Zeit des Sofort-Endes und **trägt nicht mehr**.

**Szenario:** Sitzung läuft, Socket reisst ab, Client ist nach 1,6 s zurück, bei t=4 s läuft der
Audit-Tick → Sitzung tot.

**Belegt:** Skript mit echtem `audit_remote_sessions` gegen eine Sitzung in laufender Frist →
„vom Prüflauf beendet: 1, Sitzung noch da: False".

**Richtung für die Reparatur:** eine Sitzung in laufender Frist darf der Prüflauf nicht am
fehlenden Socket-Nutzer messen. Entweder die Frist im Prüflauf berücksichtigen, oder die
Rechteprüfung an die gemerkte Nutzerkennung der Sitzung hängen statt an den Socket. Vorsicht: das
fail-closed hat einen echten zweiten Grund (der Pubsub-Verteiler meldet Sockets bei Sendefehler
ohne Disconnect-Pfad ab) — der darf nicht mit wegfallen.

---

## 2 — HOCH: Reissen BEIDE Sockets, stirbt die Sitzung schneller als vorher

**Ort:** `remote_reconnect_registry.py::remote_schedule_disconnect_grace` +
`web/src/lib/remote/wachten.ts` (Reclaim-Fehlweg)

`_remote_disconnect_timers` hält **eine** `(Rolle, Task)` je Sitzung, und
`remote_schedule_disconnect_grace` ruft `remote_cancel_disconnect_grace(session_id)` **ohne
Rollenfilter** vorweg. Der zweite Abriss überschreibt damit die Frist des ersten.

**Das ist kein Randfall, sondern euer Arbeitsalltag:** `uvicorn --reload` trennt JEDEN Socket,
also immer beide Rollen — genau bei `pnpm dev:sync`.

**Szenario:** Host und Steuernder verlieren gleichzeitig die Verbindung, beide kommen nach 1,6 s
zurück. `remote_disconnect_grace_role` steht auf `controller`; der Reclaim des Hosts scheitert mit
„no grace window for this role". `wachten.ts` behandelt `remote_reclaim_failed` als **endgültig**
(`ab(); beiEndgueltigemVerlust()`) → die Sitzung stirbt sofort, also **schneller als vor der
Gnadenfrist**.

**Belegt:** Ad-hoc-Test gegen die echte Mixin-Klasse → `grace_role=controller`,
`host reclaim: FEHLGESCHLAGEN`, `controller reclaim: OK`. Kein Bestandstest deckt zwei Abrisse
verschiedener Rollen ab.

**Richtung:** Frist je (Sitzung, Rolle) halten statt je Sitzung. Und auf der Client-Seite prüfen,
ob „no grace window for this role" wirklich endgültig sein soll.

---

## 3 — MITTEL: Das Geräteregister wird beim Wiederverbinden nicht wiederhergestellt

**Ort:** `device_registry.py::device_withdraw` ↔ `remote_reconnect_registry.py::remote_reclaim`
**Von beiden Prüfläufen unabhängig gefunden.**

`device_withdraw` löscht beim letzten Socket die Belegung (`device_set_busy(None)`).
`remote_reclaim` setzt nur den Socket der Sitzung und stellt die Belegung **nie** wieder her;
`device_set_busy` wird ausschliesslich beim `remote_respond`-Accept gesetzt (einzige Fundstelle),
weder `device_announce` noch `remote_reclaim` ziehen sie nach.

Fix (A) stellt nach dem Wiederverbinden nur die **Plätze** wieder her, nicht die Belegung.

**Szenario:** Standplatz überträgt, A steuert, WS des Geräts blinzelt 1,6 s. Nach dem Reclaim läuft
die Sitzung und die Plätze stehen wieder — der Zustand ist aber `ready`/`busy_with: null` statt
`busy`. B sieht das Gerät als frei, kann es **wecken** (`device_wake` prüft keine Belegung → echter
Encoder-Start auf einem fremden Rechner) und prallt erst bei `remote_request` an 4054 ab.

**Belegt:** Skript mit den echten Mixins → `device_state` = `('ready', None)` bei laufender,
reklamierter Sitzung.

**Kein Doppelzugriff:** `remote_create` verweigert eine zweite Sitzung je (Host, Gerät) mit 4054.
Die Anzeige lügt, die Tür ist zu.

---

## 4 — MITTEL: Bei mehreren Fenstern bleibt das Gerät dauerhaft „belegt"

**Ort:** `device_registry.py::device_release_for_socket`

Hat das Gerät mehrere Fenster und fällt ausgerechnet das der Sitzung, bleibt
`_device_busy_socket[device]` auf dem **toten** Socket, während `sess.host_socket` nach dem Reclaim
der neue ist. Beim regulären Sitzungsende sucht `remote_end` über den neuen Socket und findet
nichts → das Gerät bleibt belegt, bis seine App neu startet.

Das ist exakt der Fehler, den `_device_busy_socket` beim Bughunt am 2026-08-16 beheben sollte. Vor
dem Umbau konnte er nicht auftreten, weil der Abbau sofort mit dem alten Socket lief.

**Belegt:** dasselbe Skript, zweiter Durchlauf → nach Sitzungsende `('busy', '20')`, keine
Freigabemeldung.

---

## 5 — MITTEL: Gehaltene Tasten überleben den Abriss nicht mehr

**Ort:** `web/src/lib/remote/session.svelte.ts::#watchVerbindung` + `p2p.ts::senden`

Nach einem erfolgreichen Reclaim wird **nichts neu behauptet** — kein Hello, kein
`nachziehBuendel`. `remoteP2P.senden()` bucht jeden Frame in die Buchführung, **bevor** gesendet
wird, und `sendInput` gibt bei totem Socket nur `false` zurück (Rückgabe an mehreren Stellen
ignoriert). Gebuchter und echter Zustand laufen über den Abriss hinweg auseinander.

**Szenario:** Steuernder hält W (Host: W unten), WS reisst ab, er lässt bei t=3 s los → Loslass-
Frame verworfen, Buchführung trotzdem leer. Nach dem Reclaim behauptet niemand etwas → W bleibt am
fernen Rechner gedrückt.

Vorher endete die Sitzung beim Abriss, und `#reset` → `eingabeFreigeben()` räumte das ab. Die
Gnadenfrist hat diesen Aufräumer entfernt, ohne ihn zu ersetzen.

**Richtung:** nach einem geglückten Reclaim dasselbe tun wie beim Rückfall Kanal→Serverweg — ein
Hello schicken, das alles freigibt, und Gehaltenes nachziehen (`buchfuehrung.ts`). Die
Reihenfolge-Regel aus `CLAUDE.md` beachten: **eine Zeigerlage geht immer voran**, sonst schluckt
das Orts-Tor Knopf und Rad.

---

## 6 — MITTEL: Ein beendeter Vorrang geht während des Abrisses verloren

**Ort:** `web/src/lib/remote/vorrang.ts::GEDULD_MS` (4000) gegen die Gnadenfrist (12 s)

Die Vorrang-Geduld läuft **innerhalb** der Gnadenfrist ab, und ihr Nachziehen geht über
`void this.sendInput(...)` (`session.svelte.ts:417`) — Ergebnis ungeprüft, bei totem Socket
verworfen.

Für einen **geltenden** Vorrang heilt das von selbst: der Sidecar wiederholt je Sekunde, nach dem
Reclaim kommt die Flanke erneut. Für einen **beendeten** nicht — `VorrangBuch.melden` wiederholt
nur bei `gilt === true`.

**Szenario:** Host hat Vorrang (und hat dabei alles Gehaltene freigegeben), WS des Steuernden
reisst ab. Host gibt bei t=2 s frei → das einmalige „aus" fällt in den toten Socket. Bei t=4 s
feuert die Geduld, das Nachziehen geht ins Leere. Reconnect bei t=6 s: keine weitere
Vorrang-Meldung, kein Nachziehen. Die gehaltene Taste ist **deterministisch** tot.

Der Vorrang-Fix von heute (`95a1a9c9`) hat das nicht verursacht — die Gnadenfrist macht daraus
einen sicheren Fehler statt eines unwahrscheinlichen. Befund 5 und 6 haben denselben Kern und
vermutlich dieselbe Reparatur.

---

## 7 — NIEDRIG bis MITTEL: Der Reclaim prüft `REMOTE_CONTROL` nicht erneut

**Ort:** `routes/ws_remote_reconnect.py::handle_reclaim`

Geprüft werden Sitzung, Rolle, Nutzerkennung und laufende Frist — **nicht** `REMOTE_CONTROL` und
nicht die Kanalmitgliedschaft. Vor dem Umbau war ein Reconnect gleichbedeutend mit einer neuen
`remote_request` samt voller Rechteprüfung.

**Der Bann bleibt dicht** (`end_remote_sessions_for_member` entfernt die Sitzung, der Reclaim
scheitert dann mit „session gone"). Ein blosser Rollen- oder Overwrite-Entzug ohne Bann wird erst
vom 30-s-Prüflauf gefangen — und der hat Befund 1.

---

## Was geprüft wurde und PASST

- **Die Invariante aus `CLAUDE.md` hält für den Abriss:** `ws_ops.py` ruft
  `ws_device_handlers.on_disconnect` weiter vor `cleanup_remote_on_disconnect`, und weil
  `device_withdraw` beim letzten Socket die Belegung mit räumt, geht genau eine Meldung hinaus
  („offline") — kein „bereit"-Blitzer. **Neu ist die Gegenrichtung:** für die Wiederkehr gibt es
  keine entsprechende Regel (Befunde 3 und 4).
- **Zwei Steuernde gleichzeitig sind ausgeschlossen** (`remote_create` → 4054).
- **Reihenfolge beim `ready`** greift sauber: erst der rohe `conn.on`-Zuhörer der Gnadenfrist
  (`remote_reclaim`), dann — nach `await refreshMonitors()` — `device_announce`, dann
  `vergessen()`, dann der Kiosk-Effekt mit `device_streams`. Eine früh eintreffende Eingabe
  richtet keinen Schaden an, weil `handlers/remote.ts::eingabe` nur die Sitzungskennung prüft.
- **Keine Zustands-Lecks nach abgelaufener Frist:** `beiEndgueltigemVerlust` → `#reset()` schaltet
  `#verbindung`/`#fehler`/`#frist` ab und ruft `remoteVorrang.stop()`, `remoteP2P.stop()` und
  `eingabeFreigeben()`.
- **Fristen-Verhältnis sonst unauffällig:** 10 s Fernsteuer-Frist gegen 30 s
  `WATCH_HOST_GRACE_S` sind getrennte Register ohne gemeinsamen Zustand; Geräte- und
  Fernsteuer-Register leben im Prozess ohne Redis-TTL, der Reconcile-Loop fasst nur die
  Voice-Sets an. Der **einzige** Takt, der in die Frist hineinschreibt, ist der Rechte-Prüflauf.

## Zu den neuen Tests

`tests/test_remote_reconnect_registry.py` und die beiden neuen WS-Tests sind als Code gelesen
sauber und decken mehr als den Glücksfall: falsche Rolle, falscher Nutzer, keine laufende Frist,
unbekannte Sitzung, Flatter-Verlängerung, überholter Zeitgeber, und WS-seitig ein Dritter, der eine
fremde Kennung reklamiert. Sie laufen hier grün (37 passed in 5,94 s).

**Nicht abgedeckt** — und dort liegen die Befunde:

- das Geräteregister (kein Test rührt `device_*` an → Befunde 3 und 4)
- das Zusammenspiel mit `audit_remote_sessions` (Befund 1)
- Rechteentzug während der Frist (Befund 7)
- zwei Abrisse verschiedener Rollen (Befund 2)
- der Zweit-Nutzer-Fall nur als Reclaim-Diebstahl, nicht als parallele Übernahme über
  `remote_request`

## Lehre, die über diese Befunde hinausgeht

Eine Gnadenfrist ist kein lokaler Eingriff, sondern **eine Änderung der Zeitachse des
Verbindungsabbaus**. Alles, was bisher „beim Abriss ist sowieso alles vorbei" annehmen durfte, wird
dadurch falsch — und diese Annahme steht selten als Code da, sondern als weggelassener Aufräumer
(Befund 5), als fail-closed mit veralteter Begründung (Befund 1) oder als Registry-Eintrag, den
niemand wiederherstellt (Befunde 3 und 4). Wer die Frist verlängert oder verkürzt, prüft zuerst
jeden anderen Takt, der in dasselbe Fenster schreibt.
