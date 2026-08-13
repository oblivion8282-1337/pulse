# Das Lese-Token überlebt den Rauswurf (2026-08-13)

Befund aus dem zweiten Bughunt, am Code bestätigt. **Nicht behoben** — jeder
denkbare Fix berührt den laufenden Streaming-Weg, und keiner davon ist ohne
Messung am echten Stream verantwortbar.

## Der Befund

Wer einen HQ-Stream ansieht, bekommt von media-svc ein Lese-Token
(`GET /whep`, `routes.py:399 ff.`). Dieses Token:

* gilt **60 Minuten** (`config.py:78`, `read_token_ttl_s`),
* wird **nicht verbraucht** (WHEP braucht es für Vorabfrage, POST und jeden
  Wiederaufbau),
* ist an **Kanal und Streamer** gebunden, **nicht an den Zuschauer** — das steht
  ausdrücklich so im Quelltext.

Folge: Wird jemand aus der Community geworfen, gebannt oder verliert er das
Sichtrecht auf den Kanal, funktioniert sein bereits erhaltenes Token weiter, bis
zu einer Stunde lang. Er kann in dieser Zeit weiterschauen — und die Adresse
weitergeben. Wer sie bekommt, braucht **gar keine Mitgliedschaft**.

Der Mitgliedschafts-Check sitzt eine Ebene davor, im chat-gateway, und wird beim
Ausstellen durchlaufen. Danach nie wieder.

## Warum der naheliegende Fix nicht geht

„Das Token an den Zuschauer binden" scheitert an der Kette: MediaMTX ruft den
Auth-Hook mit dem Token aus der Adresse. Der Hook hat **keine Nutzeridentität**
— es gibt keine Anmeldung auf diesem Weg, nur die Adresse. Er kann also nicht
prüfen, ob der Abrufende derjenige ist, für den das Token gemintet wurde. Genau
deshalb steht im Code „not viewer-bound **by design**".

## Drei Wege, mit ihren Kosten

**1. Laufzeit verkürzen** (eine Konstante). 60 Minuten auf wenige Minuten
senken. Das verkleinert das Fenster, schliesst es aber nicht.
*Vorher zu klären:* prüft MediaMTX das Token nur beim Verbindungsaufbau oder
auch währenddessen? Läuft es mitten in einer laufenden Wiedergabe ab und wird
dann erneut geprüft, reisst der Stream ab — bei allen Zuschauern, nicht nur bei
den ausgeschlossenen. **Ohne diese Messung nicht anfassen.**

**2. Beim Rechteentzug aktiv sperren** (der eigentliche Fix). Wird jemand
gebannt, entfernt oder verliert das Sichtrecht, löscht der Gateway seine
Lese-Token: die Schlüssel heissen
`stream:read-cache:{viewer}:{channel}:{publisher}:{slot}` und
`stream:token:{token}`. Dafür braucht media-svc einen internen Endpunkt und der
Gateway einen Aufruf — dasselbe Muster wie
`end_remote_sessions_for_member` beim Bann, das es seit dem 2026-08-12 gibt.
Additiv, ohne Eingriff in die normale Wiedergabe.

**3. Die Weitergabe der Adresse** liesse sich nur mit einer Bindung an etwas
Beobachtbares verhindern (IP, Sitzungs-Cookie). Beides bringt eigene Probleme
(wechselnde Mobilfunk-IPs, Cookie über die MediaMTX-Domain) und ist die
schwerste der drei Varianten.

## Empfehlung

Weg 2, und Weg 1 erst nach der Messung. Weg 2 schliesst genau das, was ein
Administrator erwartet: wer hinausgeworfen wird, schaut nicht weiter zu. Die
Weitergabe an Dritte bleibt damit möglich, solange das Token lebt — das ist eine
bewusste Restlücke, die man kennen und benennen sollte.

## Einordnung

Kein akuter Notfall: es braucht einen Zuschauer, der bereits berechtigt war und
gerade entfernt wurde. Es widerspricht aber der Erwartung an einen Rauswurf, und
in einer Community, aus der jemand im Streit entfernt wird, ist genau das der
Moment, in dem es zählt.
