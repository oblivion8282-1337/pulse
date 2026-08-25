# Installer-Audit — Befundbericht

**Datum:** 2026-08-25
**Umfang:** `web/static/install.sh` · `infra/self-host/s6/**` (cont-init) · Cloud-Erreichbarkeitsprüfung · Doku
**Methode:** fünf parallele Audits, je eine Systemgrenze
**Befunde:** 35, davon 6 selbst nachgestellt

> Dieses Dokument ist die **Spec** zu `docs/superpowers/plans/2026-08-25-installer-audit-behebung.md`.
> Der Plan verwies bis zum 2026-08-26 auf einen Dateinamen, den es nicht gab — der Bericht lag
> nur als veröffentlichtes Artefakt vor. Damit war die Anweisung am Ende des Plans
> („die sechs als *vermutet* gekennzeichneten Befunde — erst messen, dann anfassen")
> für jeden späteren Leser unausführbar: welche sechs, stand nur im Artefakt.
> Der Text unten ist aus dem Artefakt übernommen; die Gestaltung ist dabei verlorengegangen,
> der Inhalt nicht.
>
> Gestaltete Fassung: https://claude.ai/code/artifact/da27cd33-0b00-41b3-a944-eef85282b805
>
> **Was auch dieses Dokument nicht auflöst:** die Schlusszeile des Plans verlangt, die
> sechs als *vermutet* gekennzeichneten Befunde erst zu messen. Welche sechs das sind,
> stand **auch im Artefakt nicht** — es nennt die Zahl in der Kopfzeile und im Abschnitt
> „Grenzen", zeigt aber nur achtzehn Befunde im Einzelnen, und davon trägt genau einer
> die Kennzeichnung. Die übrigen fünf sind nicht identifizierbar. Das ist kein Verlust
> durch die Umwandlung, sondern eine Lücke des Berichts selbst: eine Zahl ohne die Liste
> dahinter. Wer die sechs anfassen will, muss sie neu bestimmen.


## Was der Installer verschweigt

Fünf parallele Audits über den Self-Host-Installationsweg. Zwei Fehler waren an dem Tag
real aufgetreten; die Suche nach ihrer Bauart hat dreiunddreißig weitere gefunden —
darunter drei, die einen laufenden Server unerreichbar machen.


### Auslöser Zwei Fehler an einem Nachmittag


Beide auf einer echten Maschine, beide beim ersten ernsthaften Installationsversuch. Sie sind der Grund für diesen Bericht — und sie hatten dieselbe Bauart.

Der Installer hielt eine Anwendung für den Reverse-Proxy: er nahm den ersten Container aus docker ps , dessen Image nginx enthält. Das war eine Web-Oberfläche mit Port 80 nur intern; der echte Proxy stand daneben und hielt 80 und 443. docker ps sortiert nach Erstellzeit, die Anwendung war jünger, sie gewann.

Und der Container landete im Docker-Netz eines fremden Projekts, weil der Proxy in sechs Netzen hing und head -1 das alphabetisch erste nahm. Es funktionierte zufällig — der Proxy war auch dort. Aber die Isolationsgrenze saß falsch, und ein docker compose down des fremden Projekts hätte Pulse das Netz weggerissen.


### Das Muster Erfolg melden, ohne die Wirkung zu prüfen


Alle fünf Audits fanden dieselbe Form, in vier verschiedenen Sprachen und über vier Systemgrenzen hinweg.

Eine Mehrdeutigkeit wird still durch eine willkürliche Auswahl aufgelöst — und der Schritt meldet Erfolg, ohne nachzusehen, ob er gewirkt hat.

sed findet nichts und gibt 0 zurück. Ein Bucket-Init scheitert dauerhaft und endet mit exit 0 . Der Installer nimmt den erstbesten Treffer und nennt ihn ein Ergebnis. Die Tests laufen auf einer anderen Ereignisschleife als die Produktion und melden grün. Ein Befundtext beschreibt eine Ursache, die es auf dieser Betriebsart nicht gibt.

Am unangenehmsten ist die zweite Hälfte des Musters: eine erkannte Regel wurde jedes Mal nur an einer Stelle angewandt.

| Erkannte Regel | Angewandt | Vergessen |
|---|---|---|
| Image-Name ist kein Beweis, Portveröffentlichung schon | statischer Proxy-Zweig | Auto-Discovery-Zweig, zehn Zeilen darüber |
| Den eigenen Container ausnehmen | check_ports | decide_mode |
| Nach dem Schreiben prüfen, ob es wirkte | Caddy behind-proxy | Caddy provided |
| Containername ist konfigurierbar | Installer-Bericht | vier Befundtexte der Cloud |

Der Fehler ist also nicht, dass etwas übersehen wurde. Der Fehler ist, dass niemand gesucht hat, wo dieselbe Regel sonst noch fehlt .


### Klasse I Zerstört einen laufenden Server


Diese vier machen aus einem funktionierenden Zustand einen kaputten — ausgelöst durch normale Handlungen. Sie haben Vorrang vor allem anderen.

**I·1 · Ein zweiter Installer-Lauf nimmt einen greenfield-Server vom Netz**
Ort: `install.sh:192–201, :214–215, :512–514`  
Status: selbst nachgestellt  

Mechanismus Beim zweiten Lauf hält Pulses eigener Container 80 und 443. Sein Image passt auf kein Proxy-Muster, also greift der Zweig none und schaltet auf hostproxy — der Installer hält sich selbst für einen fremden Reverse-Proxy und stuft sich herunter. 
 Lauf 1 (blanke Maschine): MODE=greenfield
Lauf 2 (Pulse läuft, hält 80/443): MODE=hostproxy 
 Folge TLS kippt auf behind-proxy , ACME stellt ein, die Bindung schrumpft auf 127.0.0.1:8080 . Der laufende Container wird gelöscht und durch den beschnittenen ersetzt. HTTPS ist tot, der Container läuft, die Checkliste ist grün. Der Installer weist danach an, eine Route in einem Proxy einzutragen, den es auf der Maschine nicht gibt. Der Token ist verbrannt. 
 Bitter check_ports kennt genau diese Ausnahme bereits und schließt den eigenen Container aus — und sorgt ausgerechnet dadurch dafür, dass niemand warnt. 
 install.sh:192–201, :214–215, :512–514

**I·2 · Der Updater hält einen abstürzenden Container für erfolgreich und löscht beide Rückwege**
Ort: `install.sh:371, :383–396`  
Status: belegt  

Mechanismus docker run -d liefert 0 , sobald der Container erzeugt ist — nicht wenn er läuft. Ein Image, das startet und sofort stirbt, gilt als Erfolg. 
 Folge Die Rollback-Kopie pulse-old wird gelöscht und das letzte funktionierende Image entfernt. Da der Tag :edge rollt, ist die Vorversion danach nicht mehr adressierbar. Fünf Minuten später sieht der Digest-Vergleich „aktuell" und versucht nichts mehr. 
 Reichweite Nicht eine Maschine — jeder Self-Host gleichzeitig, binnen fünf Minuten , ausgelöst durch ein einziges kaputtes :edge . Ohne Rückweg. 
 install.sh:371, :383–396

**I·3 · Erstinstallation ohne root: leere crontab, und der Installer stirbt vor den Schritten 6, 7 und 8**
Ort: `install.sh:435–439`  
Status: selbst nachgestellt  

Mechanismus Hat der Nutzer noch keine crontab, bekommt grep -vF leeren Input und endet mit 1 . pipefail reicht das durch, set -e beendet die Gruppe, bevor der neue Eintrag geschrieben wird. 
 leere crontab: Exit 1 · crontab 0 Byte · Zeile danach nie erreicht
mit Fremdeintrag: läuft sauber durch, Fremdeintrag bleibt erhalten 
 Folge Der Admin sieht weder die Startcheckliste noch die Proxy-Route noch die Außenprüfung. Token verbrannt, Container läuft, keine Anweisung, was noch fehlt — und ein Exit-Status, der nahelegt, die Installation sei gescheitert. 
 Behebung Ein || true . Der billigste Fix des ganzen Berichts. 
 install.sh:435–439

**I·4 · Ein fremder Container namens pulse**
Ort: `install.sh:109, :512`  
Status: belegt  

Mechanismus docker rm -f "$CONTAINER" ohne jede Identitätsprüfung — kein Image-, kein Label-Abgleich. Zusätzlich überspringt check_ports wegen der blossen Existenz die gesamte Portprüfung. 
 install.sh:109, :512


### Klasse II Funktioniert still nicht


Ein dokumentierter Weg, der nie funktioniert hat — und niemand merkt es, weil an keiner Stelle etwas rot wird.

**II·1 · Die Erreichbarkeitsprüfung war in Produktion tot**
Ort: `selfhost_probe_dienst.py:274`  
Status: behoben  

Mechanismus uvloop implementiert sock_sendto nicht. uvicorn fährt uvloop, die Tests fahren Pythons Standardschleife. 
 asyncio-Standard (= Tests): sock_sendto OK
uvloop (= Produktion): NotImplementedError 
 Folge HTTP 500 bei jedem Aufruf, der bis zum UDP-Schritt kommt. Die schlechteste denkbare Fehlerform: die Kette bricht bei DNS- oder Portfehlern früh ab — die Prüfung funktionierte also genau dann, wenn der Server kaputt war. 
 Behoben Umbau auf create_datagram_endpoint , am echten coturn nachgemessen. Dazu ein Test, der die Klasse sperrt statt nur diesen Fall, und ein Test, der unter uvloop läuft. 
 selfhost_probe_dienst.py:274

**II·2 · PULSE_TLS_MODE=provided**
Ort: `09-init-caddy.sh:43`  
Status: selbst nachgestellt  

Mechanismus Ein Backslash zu viel. Bash löst \\$PULSE_HOSTNAME zum Wert auf, gesucht wird der aufgelöste Name — im Template steht aber Caddys eigener Platzhalter. 
 gesucht: /{\chat.firma.de} {/
im Template: {$PULSE_HOSTNAME} {
Ergebnis: kein Treffer · exit 0 · Datei byteidentisch
Meldung: "Verwende bereitgestelltes Cert" 
 Folge Caddy fällt auf Let's Encrypt zurück — genau auf das, was dieser Modus verhindern soll. Er ist für Hosts ohne öffentliche Erreichbarkeit gedacht; dort scheitert ACME zwangsläufig. 
 Bitter pulse-doctor prüft dort aktiv das Falsche: ob die Dateien auf der Platte liegen, nicht ob Caddy sie benutzt. Genau das trennt der Fehler. Zwei Zeilen weiter, im Schwesterzweig, steht das Escaping korrekt und eine Nachkontrolle. 
 09-init-caddy.sh:43

**II·3 · Der Traefik-Betrieb hat noch nie funktioniert**
Ort: `install.sh:248–253`  
Status: am Parser gemessen  

Mechanismus Der Router-Name enthält die Punkte des Hostnamens. Traefik zerlegt Label-Schlüssel an Punkten und verwirft daraufhin die komplette Konfiguration des Containers — nicht nur ein Label. 
 pulse-chat.example.com → Konfiguration verworfen: node: example
pulse-chat-example-com → Router entsteht (Gegenprobe) 
 Folge Keine Route. Und das Skript versichert dabei ausdrücklich „the proxy picks it up automatically. No manual step. " — der Admin wartet auf etwas, das nie kommt, und bekommt keine Ersatzanweisung. 
 install.sh:248–253

**II·4 · Ein beliebiger Container mit traefik**
Ort: `install.sh:157–162`  
Status: belegt  

Mechanismus Die Beweisregel aus dem Nachmittagsfehler sitzt nur im statischen Zweig. Der Auto-Discovery-Zweig zehn Zeilen darüber schließt weiterhin allein vom Image-Namen — und läuft unbedingt , also auch bei freien Ports. traefik/whoami , das Demo-Image aus jeder Anleitung, genügt. 
 install.sh:157–162

**II·5 · Proxy nur am Default-Bridge: wortloser Tod, und die dafür geschriebene Warnung ist unerreichbar**
Ort: `install.sh:131–134, :210–213`  
Status: belegt  

Mechanismus Findet grep -v kein Nutzer-Netz, endet es mit 1 ; unter pipefail schlägt die Substitution fehl, und weil sie die letzte Anweisung der Funktion ist, beendet set -e das Skript. 
 Folge Abbruch ohne jede Ausgabe. Die eigens für diesen Fall geschriebene Warnung „is only on the default bridge — using loopback" ist toter Code. 
 install.sh:131–134, :210–213

**II·6 · Dockerisierter Proxy ohne eigenes Netz bekommt eine unerfüllbare Anweisung**
Ort: `install.sh:213, :615–620`  
Status: gemessen  

Mechanismus Der Rückfall auf hostproxy nennt als Ziel 127.0.0.1:8080 — im Proxy- Container dessen eigenes Loopback. Pulse veröffentlicht den Port aber nur ans Host-Loopback. 
 vom Host: HTTP 200
aus dem Container, 127.0.0.1: nicht erreichbar
aus dem Container, 172.17.0.1: nicht erreichbar 
 Selbstwiderspruch Im selben Atemzug gibt das Skript docker exec caddy caddy reload aus — es weiß also, dass der Proxy ein Container ist, und nennt trotzdem ein Host-Loopback-Ziel. 
 install.sh:213, :615–620

**II·7 · Ein Fehlschlag beim optionalen Auto-Update unterdrückt die Pflicht-Anweisungen**
Ort: `install.sh:426–427, :438`  
Status: belegt  

Mechanismus systemctl enable und crontab - stehen ungeschützt unter set -e , Fehlerausgabe nach /dev/null . 
 Folge Abbruch ohne Meldung, nachdem der Container läuft — die Routen-Anweisung entfällt. Auto-Update ist optional, die Route nicht. 
 install.sh:426–427, :438

**II·8 · Alles ausserhalb der nummerierten Startskripte ist für den Betreiber blind**
Status: belegt  

Mechanismus minio-init und backup laufen als eigene Dienste, nicht über die Fortschrittsanzeige. Der Bucket-Init gibt bei dauerhaftem Scheitern ausdrücklich exit 0 zurück. 
 Folge Datei-Uploads — Avatare, Anhänge — bleiben für immer kaputt, und keine Diagnoseebene zeigt es. Das ist keine Einzellücke, sondern eine Lücke in der Architektur der Anzeige selbst: jeder künftige Dienst erbt sie.

**II·9 · Weitere Befunde dieser Klasse**
Status: belegt  

backup hat als einziger Dienst keine Absturzbremse · PULSE_TLS_MODE kennt im Installer nur auto , behind-proxy und provided fallen still weg, ein Tippfehler ebenso · PULSE_NETWORK wird im hostproxy -Modus ignoriert, aber in der Planzeile als wirksam angezeigt · PULSE_TLS_MODE=auto wird von PULSE_NETWORK ohne Hinweis überstimmt · die Pflichtprüfung akzeptiert IP-Adressen als Hostnamen, was WebAuthn und ACME später bricht · Secrets stehen in der Prozessliste ( docker login -p ), im Updater alle fünf Minuten als root.


### Klasse III Führt in die Irre


Falsche Auskunft ist teurer als keine — der Admin sucht dann systematisch am falschen Ende.

**III·1 · Der Befundtext zu Schliesscode 4046 nennt die falsche Ursache**
Status: selbst nachgeprüft  

Text „Der Server erreicht howispulse.com nicht … Die Firewall muss ausgehende HTTPS-Verbindungen erlauben." 
 Wirklich Auf einem Self-Host zeigt AUTH_JWKS_URL auf http://127.0.0.1:8001 — den lokalen auth-svc im selben Container. 4046 heisst „der Dienst nebenan antwortet nicht", nicht „kein Internet". 
 Folge Der Betreiber prüft seine Firewall, während das Problem einen Prozess entfernt sitzt. Genau die Verwechslung, die dieses Feature beenden sollte.

**III·2 · Vier Befundtexte nageln den Containernamen pulse**
Status: belegt  

Der Installer erlaubt PULSE_CONTAINER und parametrisiert seine eigene Zeile korrekt. Die Cloud-Texte tun es nicht: docker restart pulse , docker exec pulse pulse-doctor , docker logs pulse scheitern dann mit „No such container" — an genau der Stelle, an der der Betreiber ohnehin schon ein Problem hat.

**III·3 · jget**
Status: selbst nachgestellt  

python3-Zweig: [None] → landet als PULSE_ADMIN_EMAIL=None in der .env
grep-Rückfall: Exit 1 → Installer stirbt wortlos, Token verbrannt 
 Beide Zweige brauchen einen Fix, nicht nur einer. Betroffen ist ein Feld ( admin_email ), Auslöser ein gelöschter Besitzer — schmales Fenster, aber die Pflichtprüfung des Containers lässt None durch, weil es nicht leer ist.

**III·4 · Der CORS-Text sagt „Anmelden", meint aber „Server hinzufügen"**
Status: belegt  

Der geprüfte CORS-Pfad wird gebraucht, wenn der Browser auf howispulse.com steht und gegen den Self-Host testet — nicht beim normalen Login direkt auf der eigenen Adresse. Wer ein ganz anderes Login-Problem sucht, wird hier fälschlich auf CORS verwiesen.

**III·5 · Die Prüfung testet nur die erste DNS-Adresse**
Status: vermutet  

Bei mehreren A/AAAA-Einträgen hängt das gesamte Kettenergebnis an der Adresse, die zuerst zurückkommt. Ein Browser probiert mehrere. Aus dem Code hergeleitet, nicht an einem Mehrfach-Adress-Host gemessen.


### Klasse IV Die Anleitung stimmt nicht


Ein Admin folgt der Doku. Steht dort ein Befehl, der so nicht läuft, kostet ihn das dieselbe Stunde wie ein Codefehler — nur sucht er am falschen Ende.

| Stelle | Steht da | Wirklich |
|---|---|---|
| Backup | pg_dump -U pulse pulse | Datenbank heisst dcc , Socket liegt woanders — nicht lauffähig |
| Deinstallation | docker volume rm pulse-data | Compose präfixt: pulse_pulse-data — schlägt fehl, im Moment der endgültigen Löschung |
| Health | failed enthält jwks , disk | nur db und redis — die anderen beiden nie |
| Versionen | LiveKit 1.11.0 · MediaMTX 1.17.1 | 1.13.3 · 1.19.1 |
| Registry | zwei verschiedene für dasselbe Image | eine davon privat, Befehl scheitert ohne Login |
| Kanal | Doku durchgehend :stable | Installer zieht :edge , nirgends erwähnt |

Dazu neun Umgebungsvariablen, die gelesen, aber nirgends dokumentiert werden — darunter PULSE_NETWORK , also ausgerechnet der Schalter, mit dem sich die Fehlerkennung aus Klasse I korrigieren liesse. Und PULSE_PUBLIC_IP , dessen Kommentar eine Wirkung auf LiveKit behauptet, die es im Code nicht gibt.


### Vorschlag In welcher Reihenfolge


Alles auf einmal zu reparieren wäre bei dieser Menge die nächste Fehlerquelle. Jeder Fix einzeln, jeder mit einem Test, der vorher rot ist.
- Was einen laufenden Server zerstört — I·1 bis I·4. Der zweite Lauf und der Updater zuerst; beide treffen Bestandsserver, nicht nur Neuinstallationen.
- Was still nicht funktioniert — II·2 und II·3 sind ganze Betriebsarten, die nie gingen. II·5 und II·7 sind pipefail -Fallen mit je einer Zeile Fix.
- Was falsch informiert — III·1 zuerst; ein Text, der ans falsche Ende schickt, ist schlimmer als gar kein Text.
- Die Anleitung — Backup und Deinstallation zuerst, das sind die Befehle, die jemand im Ernstfall abtippt.

Quer dazu zwei strukturelle Punkte, die keine Einzelfixes sind: die Tests laufen auf einer anderen Ereignisschleife als die Produktion — solange das so bleibt, kommt die Klasse von II·1 wieder. Und die Fortschrittsanzeige erfasst nur die nummerierten Startskripte ; jeder Dienst daneben ist unsichtbar, heute und künftig.


### Grenzen Was dieser Bericht nicht weiss


Ohne das gehört der Rest nicht gelesen.
- Kein Lauf des echten Installers gegen die echte Cloud — ein Redeem hätte einen Token verbrannt. Alle Aussagen zur Token-Reihenfolge stammen aus dem Lesen des Codes.
- Der Traefik-Befund ist am Label-Parser gemessen, nicht am laufenden Traefik gegen den Docker-Socket.
- caddy-docker-proxy und nginx-proxy wurden nur gelesen, nicht gegen ihre echten Parser gefahren.
- Ob Let's Encrypt eine Registrierung mit der Adresse None ablehnt, ist nicht nachgestellt.
- Die Betriebsarten discovery und static-docker wurden auf Wiederholbarkeit nur gedanklich durchgespielt, nicht gemessen wie greenfield .
- Sechs Befunde sind ausdrücklich als vermutet gekennzeichnet und beruhen auf reiner Codelektüre.
