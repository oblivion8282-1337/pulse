# Self-Host-Erreichbarkeit: sagen, wo es hängt

**Stand 2026-08-25.** Gilt für den VPS-Self-Host (`infra/self-host/`, allinone-Image)
und den Weg, auf dem ein Nutzer so einen Server hinzufügt.

## Das Problem in einem Satz

Ein Self-Host muss sieben Glieder hintereinander bestehen — DNS, TCP/443,
TLS-Zertifikat, HTTP-Routing durch einen fremden Proxy, CORS-Header,
WebSocket-Upgrade, UDP-Medienports — und geprüft wird davon heute genau eines,
einmal, als Ja/Nein. Reißt irgendein anderes, sagt jede Stelle im System
dasselbe: „nicht erreichbar".

## Was heute stillschweigend reißt

Alles hier ist am Code belegt, nicht vermutet.

1. **Niemand schaut je von außen hinein.** Die Cloud kennt den Hostnamen
   (`registered_instances.hostname`), probt ihn aber nie. Es *gibt* eine
   Erreichbarkeitsprüfung — `services/auth/src/dcc_auth/routes_reachability.py` —
   die probt aber ausschließlich die Quell-IP ihres Aufrufers und wird nur von
   der Desktop-Server-App gerufen (`desktop/electron/main.ts:503`). Ein VPS hat
   davon nichts.

2. **Der Client kann nicht unterscheiden.** `web/src/lib/api/server-info.ts`
   fängt DNS-Fehler, TLS-Fehler, CORS-Block, Timeout und Netz-aus in *einem*
   `catch` und gibt für alles `unreachable` zurück. Der Kommentar dort gibt es
   selbst zu.

3. **Der WebSocket wird nie vorgeprüft** — die häufigste Proxy-Falle (nginx ohne
   `Upgrade`-Header, Nginx Proxy Manager ohne den Haken). `/health` antwortet,
   die Vorprüfung ist grün, der Cert-Login klappt, und *danach* lädt nichts.

4. **Der Installer wartet fünf Minuten ins Leere.** `web/static/install.sh`
   pollt 60 × 5 s auf `https://<host>/api/chat/health`. Im Modus `static-docker`
   *kann* das nie grün werden: der Container bekommt nur `--network`, keinen
   veröffentlichten Port, und die Proxy-Route wird erst **nach** dem Check
   ausgegeben.

5. **Der Container weiß es, sagt es aber nur ins `docker logs`.** ACME-Fehler,
   gescheiterte Migration, Dienst im Restart-Loop (`restart-gate.sh`) — nichts
   davon erreicht Installer, App oder Cloud. `/health` liefert `db/redis/jwks`.

6. **`/internal/health-probe` ist für seinen Zweck unbenutzbar.** Der Docstring
   sagt „für Cloud-Health-Probe nach Update", die Auth läuft über
   `INTERNAL_SERVICE_SECRET` — das pro Container lokal erzeugt wird
   (`03-init-secrets.sh:32`) und die Cloud nie sieht. Daneben: `/internal/
   trigger-update` hat eine Caddy-Route und einen Cloud-Sender mit signiertem
   JWT (`routes_suspended_instances.py:313`), aber **keinen Handler** — die
   Route existiert nirgends im chat-gateway.

7. **UDP/Voice/HQ wird für VPS gar nicht geprüft.** „Chat geht, Voice nicht"
   steht als Verdacht in der Doku, gemessen wird es nie.

8. **Der Bootstrap-Token verbrennt, bevor der Container läuft.** Eingelöst in
   Schritt 2, `docker run` erst in Schritt 4. Ein belegter Port 3478 lässt
   `docker run` unter `set -e` sterben — Token weg, neuer Antrag nötig.
   `port_busy` prüft nur 80/443, nicht die Medienports.

## Was NICHT gebaut wird

**Kein Relay-Rückfallweg für VPS-Self-Hosts.** Die Maschinerie steht vollständig
(frps, `relay-frps-plugin`, frpc im Image, On-Demand-TLS) und bleibt dem
**App-Hosting** vorbehalten — ein Heimrechner, der nie eine eigene Adresse
hatte. Ein VPS-Self-Host bleibt isoliert; das ist die Zusage, nicht ein
technischer Zufall. Entschieden 2026-08-25.

Folge für die Diagnose: Befund „Eingangsrichtung zu" endet in einer Anweisung
(welcher Port, an welcher Stelle) und, wenn die Maschine grundsätzlich keine
öffentliche Adresse hat, in der klaren Aussage, dass sie als Self-Host nicht
taugt. Nicht in einem Tunnelangebot.

## Der Bauplan

### Stufe 1 — Der Client hört auf zu raten (`web/`, `desktop/`)

Kein Backend-Eingriff, sofort spürbar beim „Server hinzufügen".

- **`no-cors`-Gegenprobe.** Scheitert der CORS-Fetch, ein zweiter mit
  `mode:'no-cors'`. Kommt eine opaque Antwort, *steht* der Server und es ist ein
  Header-/Proxy-Problem; kommt keine, ist es Netz/DNS/TLS. Neue Ursache `cors`
  neben `unreachable`.
- **WS-Probe.** `ws.py:126` macht `accept()` **vor** der Token-Prüfung. Ein
  `/ws?token=<zufall>` liefert damit einen sauberen Close-Code, und der trennt
  vier Ursachen auf einmal:
  | Ergebnis | Befund |
  |---|---|
  | Close 4001 | die ganze Kette steht (DNS→TLS→Proxy-Upgrade→Gateway) |
  | Close 4070 | Instanz ist in der Cloud gesperrt |
  | Close 4046 | **der Server erreicht die Cloud nicht** (Ausgangsrichtung) |
  | kein Upgrade | der Proxy reicht WebSockets nicht durch |
  Der Token-Query ist Pflicht (`token: str = Query(...)`) — ohne ihn antwortet
  FastAPI mit 422 vor dem `accept()`, der Probe braucht also einen Dummy-Wert.
- **Echte Diagnose im Electron.** Node kennt keine Browser-Maskierung:
  `dns.lookup`, `net.connect`, `tls.connect` (mit `rejectUnauthorized:false`, um
  das Zertifikat *lesen* und den Namen vergleichen zu können). Muster und Ort:
  `desktop/electron/localBackend/`.

**Testbarkeit:** die Zuordnung Close-Code/Fehlerart gehört in ein importfreies
Modul (Muster `lib/remote/zeigerbildPruefung.ts`) — sonst läuft sie in
`pnpm test:unit` nicht, weil Nodes Läufer erweiterungslose Laufzeit-Importe
nicht auflöst.

### Stufe 2 — Eine Prüfung, die von außen schaut (auth-svc)

Neuer cloud-only Endpunkt, der die **registrierte** Instanz durchprobt und eine
Schritt-für-Schritt-Liste zurückgibt (`{schritt, status, befund, was_tun}`).

Schritte, in dieser Reihenfolge, jeder mit eigenem Befund:

1. `dns` — A/AAAA für den Hostnamen.
2. `tcp443` — Connect je aufgelöster IP.
3. `tls` — Handshake; SAN enthält den Hostnamen? Aussteller? Restlaufzeit?
   selbstsigniert? (Heute komplett unsichtbar.)
4. `health` — `GET /health`, `failed[]` durchreichen.
5. `identität` — `GET /.well-known/pulse-server-info`; **`instance_id` muss die
   erwartete sein.** Ein falsch gesetzter Proxy landet sonst auf einer fremden
   Pulse-Instanz, und alles andere sieht grün aus.
6. `cors` — `OPTIONS` mit `Origin: <cloud>`; prüft genau das, was der Browser
   prüft. Doppelte `Access-Control-Allow-Origin` erkennen (die alte Caddy-Falle).
7. `websocket` — der 4001-Probe aus Stufe 1, server-seitig.
8. `rtmps` — TCP 1936.
9. `stun` — echter STUN-Binding-Request an UDP 3478. coturn **antwortet
   garantiert** (das ist sein Zweck) → beweiskräftig, dass die UDP-Eingangs-
   richtung grundsätzlich offen ist. Der Client-seitige Bauteil dafür existiert
   bereits: `desktop/electron/localBackend/stun.ts`.

**Sicherheit.** Ziel ist ausschließlich `instance.hostname` aus der DB (bei der
Genehmigung geprüft). Trotzdem: DNS selbst auflösen und private/Loopback/
Link-Local/CGNAT-Ziele verweigern (`_INTERNAL_NETS` aus `routes_reachability.py`
wiederverwenden), keine Redirects folgen, harte Zeitgrenzen, Rate-Limit je
Instanz **und** je Aufrufer. Aufrufberechtigt: der Owner (Session) und die
Instanz selbst (`client_id`/`client_secret`, damit der Installer am Ende prüfen
kann).

**Offener Messpunkt — nicht raten.** Ob die ICE-Ports (LiveKit 7882, MediaMTX
8189) auf einen STUN-Binding-Request **ohne** ICE-Credentials antworten, ist
unbekannt; pion könnte still verwerfen. Vor dem Bau messen. Bis dahin gilt 3478
ausdrücklich als *Stellvertreter* („UDP kommt grundsätzlich durch") und wird
auch so benannt — beide stammen aus derselben `docker run`-Zeile und derselben
Firewall-Regel, aber das ist eine Plausibilität, keine Messung.

### Stufe 3 — Der Container sagt, wo er steht (`infra/self-host/`)

- **`GET /health/setup`** (öffentlich, nur Phasennamen und Zeitstempel, keine
  Secrets): die cont-init-Skripte schreiben ihren Fortschritt nach
  `/data/setup-status.json`, der chat-gateway liefert ihn aus. Bei Caddy
  zusätzlich die letzte ACME-Fehlermeldung — das ist der mit Abstand häufigste
  Erststart-Fehler und steht heute nur im Container-Log.
- **`pulse-doctor`** im Image (`docker exec pulse pulse-doctor`): dieselben
  Prüfungen von innen, plus **Ausgangsrichtung** (Cloud/JWKS/CRL erreichbar?),
  plus der Vergleich innen/außen. Ist `http://127.0.0.1:8002/health` grün und
  `https://$PULSE_HOSTNAME/health` nicht, liegt es an DNS/Firewall/Proxy — das
  allein verortet die Mehrheit der Fälle. **Vorsicht bei der Deutung:** manche
  NAT-Aufbauten können den eigenen öffentlichen Namen von innen nicht erreichen
  (kein Hairpin); der Befund muss das als eigene Möglichkeit ausweisen und darf
  nicht als Fehler durchgehen.

### Stufe 4 — Der Installer wird ehrlich (`web/static/install.sh`)

- **Alle** zu bindenden Ports prüfen, **bevor** der Token eingelöst wird — heute
  nur 80/443; ein belegter 3478 verbrennt den Token an einem Fehler, der zwei
  Sekunden vorher erkennbar gewesen wäre.
- `static-docker`: erst die Proxy-Route ausgeben, dann prüfen. Nicht fünf
  Minuten gegen eine Adresse pollen, die es zu dem Zeitpunkt nicht geben *kann*.
- Statt Blindwarten `/health/setup` pollen und eine mitlaufende Checkliste
  drucken.
- Am Ende die Prüfung aus Stufe 2 auslösen, damit das Ergebnis in der App
  landet und nicht nur im Terminal steht.

### Stufe 5 — Die App zeigt es (`web/src/lib/components/`)

„Meine Instanzen" zeigt heute nur `active`/`suspended` aus der Cloud-DB — das
sagt, ob die **Cloud** gesperrt hat, nicht ob der Server läuft. Dort die Zeilen
aus Stufe 2 anzeigen, plus einen „Verbindung prüfen"-Knopf im
`ServerInfoDialog`. Größen-Policy beachten (Svelte ≤ 250 Zeilen).

## Reihenfolge und Begründung

1 → 2 → 3 → 4 → 5. Stufe 1 wirkt ohne jeden Server-Eingriff und deckt die
häufigste Proxy-Falle ab. Stufe 2 ist der eigentliche Kern; 3–5 hängen sich an
dieselbe Prüfliste und dieselben Fehlertexte, weshalb die Texte **einmal**
festgelegt und dann wiederverwendet werden — sonst driften Installer, App und
`pulse-doctor` auseinander und beschreiben denselben Zustand mit drei Wörtern.
