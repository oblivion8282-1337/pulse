# Standplatz-Geräte: Verwaltung vom Konto statt von der Maschine

Entwurf, 2026-08-20. Nachfolger von `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`
(Stufe 1, ausgeliefert 2026-08-16) und Voraussetzung für dessen Stufe 2.

Betrifft: `services/chat-gateway` (Route, Modell, Register, WS-Ops),
`web/src/lib/devices/**`, `web/src/lib/remote/standplatz.svelte.ts`,
`web/src/lib/components/settings/**`.

---

## 1. Ausgangslage: drei Schichten, die nichts zusammenhält

Ein Standplatz-Gerät besteht heute aus drei Teilen, die an drei verschiedenen
Orten leben:

| Schicht | Wo | Was sie weiss |
|---|---|---|
| **Die Zeile** | `chat.devices` (Datenbank) | Es gibt ein Gerät, es heisst `werkstatt-pc`, es gehört Nutzer X, es steht in Kanal Y der Community Z. |
| **Die Selbsterkenntnis** | `pulse-stream.json` auf dem Rechner, Schlüssel `remote.geraete` | „Welches der eingetragenen Geräte bin **ich**" — ein Eintrag je Server: `serverId → {guildId, deviceId, name}`. |
| **Der Zustand** | In-Prozess-Register am ConnectionManager (`device_registry.py`) | bereit / belegt / offline — aus lebenden Sockets, bewusst nicht aus einer Spalte. |

Die Selbsterkenntnis liegt aus einem guten Grund am Rechner: läge sie am Konto,
wäre der Laptop des Besitzers automatisch auch der Werkstatt-PC, und ein Erraten
(„der erste Socket dieses Nutzers") wäre in dem Moment falsch, in dem der
Besitzer nebenher am Laptop sitzt — falsch auf die gefährliche Art, weil der
Laptop dann als übernehmbarer Rechner im Kanal stünde.

**Der Fehler liegt woanders:** die *Verwaltungsoberfläche* wurde an die
Selbsterkenntnis gehängt statt an die Zeile. Der Standplatz-Reiter fragt
`geraeteAnmeldung.fuerServer(serverId)` und zeigt nur, was **dieser** Rechner
über sich selbst weiss. Damit ist ein Gerät nur von genau einer Maschine aus
verwaltbar: von sich selbst.

`devicesApi.remove` wird im gesamten Frontend an **einer** Stelle gerufen —
`SettingsGeraeteEintragung.svelte`, für die eigene lokale Eintragung.

## 2. Die Lücken, die daraus folgen

1. **Keine Verwaltung ausserhalb des Geräts.** Auf Linux, macOS, Android und im
   Browser gibt es überhaupt keine; von einem zweiten Windows-Rechner desselben
   Kontos keine für den ersten. `MANAGE_GUILD` darf serverseitig fremde Geräte
   räumen (`routes/devices.py::_require_owner_or_manager`), hat dafür aber
   **keinen einzigen Knopf** in der Oberfläche.
2. **Das tote Gerät.** Rechner neu aufgesetzt, `pulse-stream.json` weg, Maschine
   verkauft: die Zeile bleibt für immer und steht auf „offline". Erreichbar ist
   sie über die Oberfläche nirgends mehr. Der Deckel (10 je Besitzer und
   Community) füllt sich mit Leichen.
3. **Das entrissene Gerät.** Löscht ein Admin die Zeile oder wird der Besitzer
   gebannt, erfährt der Rechner das per `device_changed`/`removed` — und räumt
   seine lokale Eintragung **nicht**. Er bleibt im Standplatz-Betrieb (hält den
   Bildschirm wach über `DeviceKiosk`, meldet sich bei jedem Verbinden als ein
   Gerät an, das es nicht gibt; der Gateway verwirft still).
4. **Ein Rechner steht je Server an genau einem Standplatz — und kann die
   Community nicht wechseln.** `merken()` ersetzt den Eintrag je `serverId`, und
   `PATCH` prüft, dass der Zielkanal in derselben Community liegt. Umwidmen
   heisst deshalb heute: entfernen und neu eintragen — und Eintragen schreibt
   lokale Selbsterkenntnis, also **muss jemand an den Rechner**. Trägt man
   denselben Rechner in einer zweiten Community ein, verwaist die erste Zeile
   stumm zu Fall 2.
5. **Keine Bindung Zeile ↔ Maschine.** `cert_id` ist vorgesehen, wird vom Client
   aber nie gesendet; der Eindeutigkeits-Riegel `(guild_id, owner_user_id,
   cert_id)` greift wegen NULL nie. Die Anmeldung beweist damit nur: *ein Client
   dieses Kontos behauptet, dieser Rechner zu sein.*
6. **Die Dauerfreigabe ist nur vor Ort einseh- und widerrufbar** — sie liegt in
   `pulse-stream.json`. Vom Linux-Rechner, vom Handy, vom zweiten Arbeitsplatz:
   nichts.
7. **Kein Besitzerwechsel, kein Geräte-Konto.** `owner_user_id` ist
   unveränderlich; verlässt der Einrichter die Community, verschwinden alle
   seine Geräte mit. Und weil das Gerät unter seinem Konto verbunden ist, hält
   es ihn dauerhaft „online" (`ws_ready` sendet `presence_update(online=True)`),
   und seine privaten Nachrichten liegen auf jedem Standplatz-Rechner offen.

Die Server-Seite ist ansonsten sauber: Bann, Austritt, Community-Löschung und
Kontolöschung räumen Geräte alle korrekt ab
(`bans.py`, `guilds.py`, `user_purge.py`).

## 3. Das Bild, an dem der Entwurf sich misst

Eine Filmproduktion mit vielen Schnittplätzen. Ein Konto („CEO") ist auf jedem
Rechner angemeldet, jeder Rechner ist ein Standplatz-Gerät. Der CEO sitzt an
seinem Arbeitsplatz und bestimmt von dort, welcher Rechner in welchem
Sprachkanal welcher Community verfügbar ist, wer ihn übernehmen darf, und
räumt Plätze weg, die es nicht mehr gibt — ohne aufzustehen.

Dieses Bild ist der Grund, warum Punkt 4 (Community-Wechsel) und Rollen in der
Freigabeliste mit hineingehören: Projekte kommen und gehen, und zwölf Cutter mal
fünfzehn Plätze sind einzeln geklickt 180 Freigaben.

## 4. Entscheidungen

**E1 — Die Freigabe wandert auf den Server, Schreibrecht hart beim Besitzer.**

Stufe 1 legte sie bewusst ans Gerät, weil *ein serverseitiger Schalter von einem
Admin fernaktivierbar wäre*. Der Riegel dagegen ist jetzt das Schreibrecht: nur
`owner_user_id` darf die Liste lesen und schreiben, `MANAGE_GUILD` nicht.

**Ehrlich benannter Rest:** auf einem Self-Host ist der Betreiber zugleich der
Server und kommt notfalls über die Datenbank am Riegel vorbei. In der Cloud ist
das dicht. Verworfen wurden: „nur Entzug aus der Ferne" (löst den Firmenfall
nicht) und „Schalter am Gerät schaltet Fernverwaltung frei" (mehr Mechanik für
denselben Effekt).

**E2 — Der Server rechnet, das Gerät antwortet.**

Rollen kann der Client nicht auflösen — genau deshalb fehlten sie in Stufe 1.
Der Gateway reicht `remote_request` wie bisher an das Gerät durch und hängt ein
Feld an: *diese Anfrage ist durch eine Freigabe gedeckt*. Das Gerät antwortet
daraufhin selbsttätig mit Zustimmung.

Erhalten bleibt damit: das Drahtprotokoll wortgleich, der gesamte Schutzapparat
(Rechte-Wache im 30-Sekunden-Takt, Sitzungsdeckel, Abbau bei Rauswurf und Bann)
unangetastet, und vor allem der Fail-Safe **Gerät offline = keine Zustimmung**.
Ein Server, der selbst zustimmt, hätte genau den verloren.

**E3 — Der lokale Hauptschalter bleibt.**

Kein zweite Liste, sondern ein reiner Aus-Knopf am Gerät: steht er auf „aus",
stimmt der Rechner nie selbsttätig zu, egal was auf dem Server steht. Kostet
nichts, gibt jedem Platz einen physischen Notaus und macht den Umstieg weich.

**E4 — Das Gerät gehört dem Konto; Community und Kanal sind Eigenschaften.**

`PATCH` darf `guild_id` mitändern. Ohne das bleibt Umwidmen Handarbeit vor Ort.

**E5 — Die Ausweisbindung wartet auf den Ausweisbezug im Cloud-Token.**

Das Cloud-Zugangstoken trägt keinen (Self-Hosts haben ihn über
`SessionClaims.cert_id`). Verworfen wurde ein eigenes Gerätegeheimnis als
Zwischenlösung: es wäre ein zweiter Ausweisbegriff neben dem echten. Die Naht
bleibt offen — `cert_id` bleibt in der Tabelle stehen.

## 5. Datenmodell

### 5.1 `chat.devices` — eine Erweiterung, keine Änderung

`PATCH /guilds/{guild_id}/devices/{device_id}` nimmt zusätzlich `guild_id` im
Rumpf. Der Pfad bleibt die **aktuelle** Community, damit jeder bestehende Aufruf
gültig bleibt.

Bedingungen für den Wechsel:

* nur der Besitzer (wie beim Kanalwechsel — der Standplatz ist der Rechteanker,
  `MANAGE_GUILD` darf räumen, nicht umwidmen),
* Mitgliedschaft in der Zielcommunity,
* `VIEW_CHANNEL` **und** `STREAM` im Zielkanal, Zielkanal ist ein Sprachkanal
  (dieselbe Prüfung wie `_standplatz_kanal`, nur gegen die Zielcommunity),
* Namenskonflikt in der Zielcommunity → 409 (`uq_devices_guild_name`).

Zwei Folgen, die leicht durchrutschen:

* **Die Meldung geht an zwei Communities.** Heute meldet ein Standplatzwechsel
  „entfernt" an den alten und „geändert" an den neuen Kanal, beide in derselben
  Community. Bei einem Community-Wechsel sind es zwei Ereignis-Bereiche; wer das
  übersieht, lässt das Gerät in der Kanalliste der alten Community stehen, bis
  jemand neu lädt. `mgr.device_move` muss die neue `guild_id` mitbekommen.
* **Rollen-Freigaben überleben den Wechsel nicht.** Eine Rolle gehört einer
  Community; nach dem Wechsel zeigen sie ins Leere. Sie werden beim Wechsel
  **gelöscht**, und die Antwort sagt, wie viele — still zu erben wäre die
  gefährliche Variante. Nutzer-Freigaben bleiben (Nutzerkennungen gelten
  serverweit); wer in der neuen Community nichts darf, scheitert ohnehin an der
  Rechteprüfung.

Wie bisher gilt: ein Standplatzwechsel beendet eine laufende Fernsteuerung, und
zwar **nach** dem Commit.

### 5.2 `chat.device_grants` — neu

Hängt per `ON DELETE CASCADE` an `devices`, damit eine gelöschte Zeile keine
Freigaben zurücklässt.

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | BigInt (Snowflake) | Primärschlüssel |
| `device_id` | BigInt, FK → `devices.id` CASCADE | wem die Freigabe gilt |
| `subject_type` | Text | `user` · `role` · `everyone` |
| `subject_id` | BigInt, nullable | Nutzer- oder Rollenkennung; leer bei `everyone` |
| `expires_at` | timestamptz, nullable | leer = dauerhaft |
| `created_at` | timestamptz | fürs Protokoll |
| `created_by_user_id` | BigInt | wer sie erteilt hat |

Eindeutig: `(device_id, subject_type, subject_id)`. Index auf `device_id`.

`everyone` heisst „jeder, der überhaupt anfragen darf" — also jeder, der am
Standplatz `REMOTE_CONTROL` hat. Es ist keine Abkürzung an der Rechteprüfung
vorbei, sondern der Verzicht auf eine **zusätzliche** Einschränkung.

**Der Ort verschwindet aus der einzelnen Freigabe.** Heute trägt jede Freigabe
ihren Kanal mit sich, weil die Prüfung sonst löchrig war: geprüft wurde der
Kanal, den *der Anfragende nennt*. Künftig ist der Ort implizit der Standplatz
des Geräts, und der Server prüft `REMOTE_CONTROL` genau dort. Das Loch kann
damit nicht wiederkommen.

Abgelaufene Zeilen werden **nicht** gefegt, sondern beim Auflösen ignoriert und
beim nächsten Schreiben derselben Freigabe überschrieben. Ein Fegelauf wäre ein
Hintergrund-Task für Zeilen, die niemanden stören.

## 6. Rechte

| Handlung | Wer |
|---|---|
| Gerät sehen | `VIEW_CHANNEL` am Standplatz (unverändert) |
| Eintragen | `STREAM` im Kanal (unverändert) |
| Umbenennen, Entfernen | Besitzer **oder** `MANAGE_GUILD` (unverändert) |
| Kanal wechseln | nur Besitzer (unverändert) |
| **Community wechseln** | nur Besitzer, plus Rechte am Ziel (neu) |
| **Freigaben lesen** | nur Besitzer (neu) |
| **Freigaben schreiben** | nur Besitzer (neu) |

`MANAGE_GUILD` darf räumen und umbenennen, aber **nicht** in die Freigabeliste
sehen und nicht freigeben. Räumen ist Hausrecht; freigeben wäre der
Admin-Fernschalter, den E1 gerade ausschliesst. Hineinsehen wäre die Vorstufe
davon und hat keinen Zweck, den Räumen nicht schon erfüllt.

## 7. Der Zustimmungsweg

```
Anfragender          Gateway                                   Gerät
    │                   │                                        │
    │ remote_request    │                                        │
    ├──────────────────▶│ Rechte am Standplatz prüfen            │
    │                   │ Freigaben auflösen (user/role/everyone)│
    │                   │ remote_request + freigabe:true/false   │
    │                   ├───────────────────────────────────────▶│
    │                   │                                        │ Hauptschalter an?
    │                   │              remote_respond (accept)   │ ja → nach ~20 ms
    │                   │◀───────────────────────────────────────┤
```

Die Auflösung ist eine reine Funktion und gehört in ein eigenes Modul
(`device_grants.py`), nicht in den WS-Handler:

```
gedeckt(device, anfragender) =
      REMOTE_CONTROL des Anfragenden im Standplatz-Kanal des Geräts
  UND (  eine gültige user-Freigabe auf ihn
       ODER eine gültige role-Freigabe auf eine seiner Rollen in der
            Community des Standplatzes
       ODER eine gültige everyone-Freigabe )
```

Gültig heisst: `expires_at` leer oder in der Zukunft. Fehlt die Rechteprüfung
oder ist keine Freigabe da, geht `freigabe:false` hinaus — dann läuft alles wie
heute weiter (Dialog am Gerät, Verfall nach 30 s).

## 8. Oberfläche

### 8.1 In der Geräteansicht

`DeviceView.svelte` hat 237 Zeilen bei einer Grenze von 250; die Verwaltung
bekommt eigene Dateien:

* `devices/components/DeviceVerwaltung.svelte` — Name, Standplatz (Community und
  Kanal), Entfernen. Besitzer sieht alles, `MANAGE_GUILD` nur Umbenennen und
  Entfernen.
* `devices/components/DeviceFreigaben.svelte` — die Freigabeliste (Nutzer,
  Rollen, „jeder", je mit Befristung). Nur für den Besitzer, für alle anderen
  gar nicht erst im DOM.
* `devices/verwaltung.svelte.ts` und `devices/freigaben.svelte.ts` — Rufe,
  Fehler, Zustand. Die Komponenten bleiben Darstellung.

### 8.2 Im Standplatz-Reiter

Neuer Abschnitt „Meine Geräte auf diesem Server": Liste, Sprung in die
Geräteansicht, Entfernen. Er ist das Fangnetz für ein Gerät in einem Kanal, den
man nicht mehr sehen darf — über die Kanalliste findet man das nie.

Die Sichtbarkeit des Reiters wird:

```
darfStandplatzSein() || lokale Eintragung vorhanden || ich besitze Geräte auf diesem Server
```

**`darfStandplatzSein.ts` bleibt unangetastet** — es beantwortet „kann dieser
Rechner Standplatz *sein*", und daran hängen ausserdem die Anmeldung
(`ws/handlers/ready.ts`) und die Übernahme (`remote/session.svelte.ts`). Die
Reiter-Regel bekommt eine eigene Funktion daneben; die beiden Fragen liefen am
2026-08-18 schon einmal auseinander, und das Ergebnis war ein Rechner, der sich
weiter anmeldete, während sein Reiter versteckt war.

### 8.3 Altlast, die dabei fällig wird

`SettingsStandplatz.svelte` hat **485 Zeilen** bei einer Grenze von 250 — heute
schon eine Verletzung, und ein weiterer Abschnitt macht es schlimmer. Die Datei
wird entlang ihrer drei Themen zerlegt (Freigabe, Protokoll, Geräteliste). Das
ist keine Zusatzarbeit, sondern die Voraussetzung dafür, dass der neue Abschnitt
irgendwo hin kann.

Die Freigabe-Oberfläche im Reiter und `DeviceFreigaben.svelte` sind dieselbe
Sache und werden **eine** Komponente, keine zwei.

### 8.4 Kanalliste

Unverändert. Das Ziehen bleibt die schnelle Geste für einen Kanalwechsel
innerhalb der Community.

## 9. Geräte-Deckel

Statt der Konstante `MAX_DEVICES_PER_OWNER = 10` ein Limit in `guild_limits.py`
(`max_devices_per_owner`), damit es die vorhandene Zwei-Ebenen-Mechanik erbt:
Betreiber-Obergrenze klemmt den Community-Wert, das Formularfeld entsteht laut
Modulkopf von selbst aus `LIMITS`.

**Vorgabe 25.** Deckt eine Postproduktion in der Grösse aus §3 mit Luft ab und
bleibt klein genug, dass ein Client, der sich in einer Schleife einträgt,
auffällt, bevor er die Kanalliste flutet. Der Deckel war nie ein Schutz gegen
einen Angreifer — wer eintragen darf, darf auch übertragen, und das ist die
teurere Handlung.

## 10. Die lokale Eintragung räumt sich selbst

Im WS-Handler `handlers/devices.ts`, beide Fälle:

* **entfernt** (`device_changed` mit `removed`): betrifft es das eigene Gerät,
  vergisst der Rechner seine Eintragung. Kiosk-Betrieb endet, das sinnlose
  Anmelden bei jedem Verbinden hört auf. Schliesst Lücke 3.
* **geändert**: nach einem Community-Wechsel aus der Ferne trägt die lokale
  Eintragung noch die alte `guildId`. Sie wird nachgezogen — sonst lädt der
  Rechner die Geräteliste der falschen Community, und der eigene Reiter zeigt
  ins Leere.

## 11. Umzug der bestehenden Freigaben

Beim ersten Start nach dem Update schiebt jedes eingetragene Gerät seine lokale
Liste **einmal** auf den Server und merkt sich das lokal. Bis der Schub
gelungen ist, bleibt die lokale Datei die Wahrheit; scheitert er, wird er beim
nächsten Start wiederholt. Es geht nichts verloren.

Verworfen: Freigaben fallenlassen und neu erteilen lassen. Die Funktion ist erst
vier Tage alt und dürfte ausserhalb der eigenen Rechner nirgends benutzt sein —
aber es ist die Sorte Entscheidung, die man bereut, wenn doch schon jemand
Freigaben gesetzt hat.

## 12. Prüfen

**pytest** trägt die Last:

* Community-Wechsel über die volle Rechte-Matrix: Besitzer / `MANAGE_GUILD` /
  Fremder; Rechte am Ziel (Mitglied, `VIEW_CHANNEL`, `STREAM`, Sprachkanal);
  Namenskonflikt; Meldung an **beide** Communities; Rollen-Freigaben geräumt;
  laufende Sitzung beendet, und zwar erst nach erfolgreichem Commit.
* Freigabe-Routen: nur der Besitzer liest und schreibt, `MANAGE_GUILD` bekommt
  403; CASCADE beim Löschen des Geräts.
* Auflösung (`device_grants.py`): Nutzer, Rolle, „jeder", abgelaufen, und der
  Fall „freigegeben, aber am Standplatz fehlt `REMOTE_CONTROL`".

**Web-Unit** (Nodes Läufer, kein Vitest) nur für reine Rechnung: Restzeit einer
Befristung und die Reiter-Sichtbarkeitsregel, als importfreies Modul nach dem
Muster `lib/remote/zeigerbildPruefung.ts`.

**Playwright** bekommt nichts Neues aufgezwungen; die bestehenden Geräte-Tests
müssen grün bleiben.

## 13. Nicht in diesem Umbau

* **Geräte-Konto.** Das eigentliche Problem aus §2.7 — ein Konto auf jedem
  Schnittplatz heisst, dass die privaten Nachrichten des Besitzers dort offen
  liegen (der Sichtschutz greift nur, solange jemand fernsteuert) und dass er
  rund um die Uhr „online" ist. Wird ein eigenes Entwurfsdokument, nicht Code.
* **Ausweisbindung** (§4 E5) — wartet auf den Ausweisbezug im Cloud-Token.
* **Besitzerwechsel.** Ein Gerät, das der Werkstatt gehört und nicht dem
  Einrichter, braucht ihn; er hängt aber am Geräte-Konto und wird dort
  entschieden.
* **Das Geräte-Protokoll bleibt lokal.** Man kann einen Rechner aus der Ferne
  verwalten, aber nicht nachlesen, wer ihn letzte Woche geweckt hat — das steht
  in der Datei auf dem Rechner. Bewusste Asymmetrie, eigener Schritt.
* **Das prozesslokale Geräte-Register.** Bei mehr als einem Gateway-Prozess sähe
  jeder nur seine eigenen Geräte. Heute einer, also heute kein Problem; bleibt
  als Wachstumsgrenze notiert.

## 14. Etappen

Jede ist für sich grün testbar.

1. **Server: Community-Wechsel.** `PATCH` um `guild_id`, Meldung an beide
   Communities, `device_move` mit neuer Community, Rollen-Freigaben räumen
   (letzteres wirkungslos, bis Etappe 2 die Tabelle bringt — die Reihenfolge
   ist trotzdem richtig, weil der Wechsel ohne Freigaben schon vollständig
   prüfbar ist).
2. **Server: `device_grants`** — Migration, Modell, Routen (lesen/setzen/
   entfernen), Besitzer-Riegel.
3. **Server: Auflösung** — `device_grants.py::gedeckt()`, Feld am
   weitergereichten `remote_request`.
4. **Client: Gerät liest vom Server.** `standplatz.svelte.ts` entscheidet nicht
   mehr selbst über die Liste, sondern über Hauptschalter + Feld; Einmal-Umzug
   der lokalen Liste.
5. **Client: Verwaltung in der Geräteansicht** (`DeviceVerwaltung`,
   `DeviceFreigaben`, beide Module).
6. **Client: Reiter** — Sichtbarkeitsregel, „Meine Geräte"-Liste, Zerlegung von
   `SettingsStandplatz.svelte`.
7. **Deckel** in `guild_limits.py` (+ Migration).
8. **Selbstaufräumung** der lokalen Eintragung (§10).
9. **Doku**: dieser Entwurf verlinkt, `CLAUDE.md`-Abschnitt „Standplatz-Geräte"
   nachgezogen, `docs/2026-08-16-standplatz-geraet-einrichten.md` ergänzt,
   Entwurf „Geräte-Konto" angelegt, Changelog-Eintrag.

## 15. Berührte Dateien (Erwartung, keine Zusage)

**Server**
`routes/devices.py` · `models/devices.py` (+ Migration `device_grants`,
Guild-Limit-Spalten) · `device_grants.py` (neu) · `device_meldungen.py` ·
`device_registry.py` (`device_move` mit Community) · `routes/ws_remote_handlers.py`
· `guild_limits.py` · Tests unter `services/chat-gateway/tests/`.

**Client**
`lib/devices/components/{DeviceView,DeviceVerwaltung,DeviceFreigaben}.svelte` ·
`lib/devices/{verwaltung,freigaben}.svelte.ts` (neu) · `lib/devices/anmeldung.svelte.ts`
· `lib/ws/handlers/devices.ts` · `lib/remote/standplatz.svelte.ts` ·
`lib/components/SettingsDialog.svelte` · `lib/components/settings/SettingsStandplatz*.svelte`
· `lib/api/devices.ts` · `web/messages/*.json` · `web/static/changelog.json`.

## 16. Änderungen an bestehenden Zusagen

Wer eine dieser Aussagen anderswo findet, zieht sie mit (Regel „nie an nur einer
Stelle korrigieren"):

* „Die Freigabe liegt am GERÄT, nie auf dem Server" — gilt nach diesem Umbau
  nicht mehr in dieser Form. Neu: *die Liste liegt auf dem Server und darf nur
  vom Besitzer geschrieben werden; die Zustimmung erteilt weiterhin das Gerät.*
  Steht in `CLAUDE.md`, im Kopf von `standplatz.svelte.ts` und im Entwurf vom
  2026-08-14.
* „Rollen bleiben draussen" (Stufe 1) — erledigt.
* „höchstens 10 Geräte je Besitzer und Community" — wird ein Community-Limit mit
  Vorgabe 25.
