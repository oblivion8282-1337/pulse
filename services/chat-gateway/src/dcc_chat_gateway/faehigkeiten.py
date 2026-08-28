"""Was dieser Server kann — an EINER Stelle.

Zwei Oberflächen nennen dieselbe Liste: ``GET /.well-known/pulse-server-info``
(ohne Anmeldung erreichbar) und der ``hello``-Rahmen der WebSocket (erst nach
einer gültigen Anmeldung).

**Warum beide.** Der ``hello``-Rahmen kommt zu spät für die Frage, die als
Erstes gestellt wird: Wie melde ich mich hier überhaupt an? Ihn dafür zu
benutzen hiesse, eine Anmeldung vorauszusetzen, um die Anmeldung zu wählen. Die
öffentliche Auskunft beantwortet sie ohne Umweg — sie trägt das ``capabilities``-
Feld seit Phase 3.3 und war bis dahin leer.

**Warum eine Liste und nicht zwei.** Zwei Listen liefen auseinander, sobald
jemand nur eine anfasst, und die Abweichung fiele erst auf, wenn ein Klient sich
auf die eine verlässt und der Server nach der anderen handelt.
"""

from __future__ import annotations

#: ``server-ticket``: kennt ``POST /session`` — der Klient meldet sich über ein
#: von der Cloud ausgestelltes Ticket an statt über ein Gerätezertifikat.
#:
#: ``token_refresh``: erneuert das Sitzungs-Token am offenen Socket, statt ihn
#: beim Ablauf zu schliessen.
SERVER_FAEHIGKEITEN: tuple[str, ...] = ("token_refresh", "server-ticket")
