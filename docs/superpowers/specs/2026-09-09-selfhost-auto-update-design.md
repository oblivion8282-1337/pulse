# Self-Host-Auto-Update: Drift sichtbar machen und den Compose-Pfad versorgen

Stand 2026-09-09. **Entwurf, noch nicht umgesetzt.** Besprochen und
grundsätzlich beschlossen: Ansatz A plus Ansatz C (unten). Eine Entscheidung
ist offen (§6). Umsetzung folgt in einer eigenen Sitzung, dann über
`writing-plans`.

## 1. Anlass

Wird die Cloud (howispulse.com) aktualisiert und ziehen Self-Host-Instanzen
nicht nach, brechen sie. Die Sorge des Betreibers: Compose-Nutzer vergessen,
den Update-Cron einzurichten, und niemand merkt es, bis etwas kaputt ist.

## 2. Was heute gilt (nachgelesen, nicht vermutet)

- **Installer-Pfad** (`web/static/install.sh`): Auto-Update vorhanden.
  Schreibt `pulse-update.sh` plus systemd-Timer (root) oder User-Cron
  (non-root), alle 5 min, Digest-Vergleich, Rename-Recreate mit Rollback.
  Abschaltbar über `PULSE_NO_AUTOUPDATE`.
- **Compose-Pfad** (`infra/self-host/docker-compose.yml`): bewusst **kein**
  Updater. Nur ein Kommentar und ein Skript-Template
  (`infra/self-host/pulse-update.sh`), das der Nutzer selbst einhängen muss.
- **Watchtower** ist seit 2026-06-11 überall entfernt. Grund: der Container
  hielt den Docker-Socket, das ist Host-Root. Begründung und Mechanik im
  Abschnitt „Auto-update" von `infra/self-host/README.md`.
- **Die Cloud kennt die Version einer Instanz nicht.** `RegisteredInstance`
  (`models_instances.py`) hat keine Versionsspalte; der Heartbeat
  (`routes_selfhost_directory.py::HeartbeatIn`) trägt nur Kandidaten und
  Fingerprint. Drift ist unsichtbar.
- **Es gibt schon einen Riegel, der die Sorge wahr macht:**
  `web/src/lib/api/constants.ts::MIN_SERVER_VERSION` wird ins Web-Bundle
  gebacken, `server-info.ts` lehnt zu alte Server ab. Ein Cloud-Deploy mit
  angehobenem Wert sperrt jede nicht nachgezogene Instanz aus, ohne Vorwarnung.
- **`server_version` ist eine Konstante, keine Versionsnummer.**
  `dcc_chat_gateway/__init__.py::__version__ = "0.8.0"` steht seit Monaten
  fest; jeder `main`-Push liefert ein anderes Image mit derselben Zahl. Am
  2026-09-09 nachgesehen: `selfhost.unicutmedia.com` (Compose-Weg, ohne
  Updater, Instanz-ID 86842704352251904) lief auf dem Bau von 14:15 UTC,
  die Registry hatte seit 15:32 UTC einen neueren, und beide meldeten
  `0.8.0`. **Folge für A:** die Version muss beim Bau aus Commit oder Tag
  eingebrannt werden (z. B. `0.8.0+sha-<short>` oder das Image-Digest),
  sonst kann die Cloud Drift auch mit Versionsspalte nicht sehen.
- **Versions-Policy** (`/.well-known/pulse-version-policy.json`,
  `routes_version_policy.py`; Poller `cloud_policy_poller.py`, 6 h): wird
  ausgeliefert und in Redis abgelegt, **nirgends verglichen**. Vorgabe
  `min_version = 0.0.0`, Betreiber setzt `PULSE_POLICY_MIN_VERSION`.
- **Toter Push-Weg:** `routes_suspended_instances.py::broadcast_update`
  sendet ein signiertes JWT an `https://<host>/internal/trigger-update`, Caddy
  reicht es an :8002 durch, der chat-gateway hat **keinen Handler**. Für diese
  Aufgabe ohnehin nutzlos: ein Container ohne Socket kann sich nicht selbst
  erneuern.
- **Keine Image-Signierung im Baum** (`cosign`/`sigstore` kommt nirgends vor).
  Wer Registry oder GitHub-Konto übernimmt, erreicht binnen 5 min jeden
  Auto-Updater, gleich ob Cron oder Container.
- Tags: `allinone.yml` taggt jeden `main`-Push als `:edge` **und** `:stable`
  (Phasen-Policy 2026-06-10). Self-Host-Compose zieht
  `registry.howispulse.com/pulse-allinone:stable`.

## 3. Der Grundsatz, der die Ansätze sortiert

**Jeder Updater, der einen Container neu anlegen kann, ist Host-Root.** Ein
Update ist kein Neustart, sondern Neuanlage (ein Container hängt an einer
Image-ID). `POST /containers/create` lässt sich nicht so beschneiden, dass
„anlegen" erlaubt bleibt, aber „mit `/` als Bind-Mount" verboten wird. Ein
Socket-Proxy (z. B. `docker-socket-proxy`) verkleinert nur die Bug-Fläche
(kein exec, keine Volumes, kein Swarm), nicht die Rechte.

Die Sicherheitsfrage lautet deshalb nicht „Socket ja oder nein", sondern:
**wessen Code hält ihn**, und **was darf durch die Leitung kommen**.

## 4. Drei Ansätze

### A: Drift sichtbar machen und abfedern (kein Updater)

- Heartbeat trägt `server_version`; Cloud speichert sie je Instanz
  (neue Spalte `RegisteredInstance.reported_version` + `version_seen_at`,
  Migration im auth-svc).
- „Meine Instanzen" zeigt Version und warnt, wenn `min_version` unterschritten
  ist. Die Erreichbarkeits-Diagnose (`docs/selfhost-erreichbarkeit.md`)
  bekommt ein zehntes Glied „Version".
- Die Cloud hält ein Kompatibilitätsfenster: `MIN_SERVER_VERSION` wird erst
  angehoben, wenn die Instanzliste zeigt, dass alle nachgezogen haben, oder
  nachdem Betreiber gewarnt wurden. Das ist eine Regel für den Betreiber,
  kein Automatismus.
- Löst „ich update Prod und die anderen brechen still", nicht „der
  Compose-Nutzer muss selbst nachziehen".

### B: Watchtower-Fork im Compose, hart eingezäunt

- `nicholas-fedor/watchtower` (gepflegter Fork; `containrrr/watchtower` ist
  archiviert), per Digest gepinnt, standardmäßig im Compose.
- Zaun: `--label-enable` plus Label nur am `pulse`-Container (die Labels
  stehen noch in `infra/self-host/Dockerfile`), HTTP-API aus, `read_only`,
  `cap_drop: ALL`, `no-new-privileges`, eigenes Netz ohne Verbindung zum
  Pulse-Container.
- Restrisiko: Fremdprojekt mit Host-Root, **keine Signaturprüfung**.
- **Verworfen** zugunsten von C.

### C: eigener minimaler Updater-Container mit Signaturprüfung

- Winziges Image aus dem eigenen Baum (Alpine + Docker-CLI + `cosign`), das
  die Logik von `pulse-update.sh` fährt: Pull, Digest-Vergleich,
  Rename-Recreate mit Rollback, altes Image erst nach einem gesunden Lauf
  löschen.
- **Vor dem Recreate prüft er die Image-Signatur.** Ohne gültiges Siegel
  bleibt das neue Image liegen und wird nie gestartet. Das ist der einzige
  Hebel, der „etwas Bösartiges kommt durch die Leitung" wirklich abfängt.
- Dieselbe Prüfung gehört in `pulse-update.sh` des Installer-Pfads (sonst
  schützt sie nur die Hälfte der Instanzen).
- Zaun wie bei B. Der Pulse-Container erreicht den Updater nicht, auch
  kompromittiert nicht.
- Restrisiko: ein socket-haltendes Image in eigener Pflege. Ein Fehler darin
  ist ein Fehler mit Root-Rechten.

### Empfehlung und Beschluss

**A zuerst, dann C. B nicht.** A ist Pflicht unabhängig vom Updater: ohne
Versionssicht bleibt jeder Updater ein Hoffen, und der
`MIN_SERVER_VERSION`-Riegel bleibt eine Falle. C ist Watchtower überlegen,
weil die Signaturprüfung der einzige Schutz gegen ein gekapertes Lager ist,
und der Aufwand liegt nur wenig über B, weil das Skript existiert.

Vom Betreiber am 2026-09-09 so beschlossen.

## 5. Welche Installationswege C erreicht

| Weg | Updater | Woher |
|---|---|---|
| Installer-Skript (`curl … \| bash`) | schon heute | Timer/Cron auf dem Host; C ergänzt nur die Siegelprüfung |
| Compose mit unserer Datei | **neu durch C** | zweiter Dienst in `docker-compose.yml`, kommt mit `docker compose up -d` automatisch mit; Abwahl: Eintrag löschen oder `docker compose up -d pulse` |
| Ganz manuell (eigene Compose-Datei, `docker run`) | nie | nur A fängt sie: die Cloud sieht die alte Version und warnt in der App |

Deshalb gehören A und C zusammen: C schließt die Lücke für alle, die die
Vorlage nehmen; A fängt den Rest sichtbar statt durch stillen Ausfall.

## 6. Offene Entscheidung: wer hält den Signierschlüssel?

Noch **nicht entschieden**, wird beim Start der Umsetzung geklärt.

- **Stufe 1: Bau-Automatik stempelt.** Schlüssel liegt als GitHub-Secret,
  `allinone.yml` signiert jeden Push. Self-Hoster bekommen Updates binnen
  Minuten wie heute. Schützt gegen ein gekapertes Lager, **nicht** gegen ein
  gekapertes GitHub-Konto. Empfehlung als Einstieg.
- **Stufe 2: Handfreigabe.** Schlüssel nur auf dem Rechner des Betreibers;
  jedes Self-Host-Update ist ein lokaler Promote-Schritt (der offene
  Release-Account-Plan, s. `~/.claude/...`-Memory `self-host-host-updater`
  und `security-audit-2026-06-10`). Schützt gegen beides, kostet pro Release
  einen Handgriff; Self-Hoster hinken der Cloud bewusst hinterher.

Beide nutzen dieselbe Prüfung auf Empfängerseite (öffentlicher Schlüssel im
Updater-Image und in `pulse-update.sh`). Der Umstieg von 1 auf 2 ändert am
Self-Host nichts. **Schlüsselbasiert, nicht keyless:** keyless (Fulcio/Rekor)
hinge an der öffentlichen Sigstore-Infrastruktur; fällt die aus, stünden
fail-closed alle Updates. Ein eingebackener öffentlicher Schlüssel prüft
offline.

Offen bleibt daneben: Schlüsselrotation (wie kommt ein neuer öffentlicher
Schlüssel zu Bestandsinstanzen, ohne dass sie das Update dazu ablehnen).
Naheliegend: Updater-Image akzeptiert eine Liste, alter und neuer Schlüssel
laufen eine Übergangszeit parallel.

## 7. Entwurfsskizze (Detailtiefe folgt im Plan)

### A

- auth-svc: Spalten `reported_version`, `version_seen_at` an
  `RegisteredInstance`; `HeartbeatIn.server_version` optional (alte
  Instanzen senden keins, `extra="forbid"` bleibt).
- Self-Host sendet `__version__` des chat-gateway im Heartbeat mit.
- `GET /me/instances` liefert Version + „veraltet"-Flag (Vergleich gegen die
  Policy der Cloud, `PULSE_POLICY_MIN_VERSION`).
- Frontend `AdminInstances`/„Meine Instanzen": Version anzeigen, Warnung mit
  `was_tun` (Texte in `diagnose_texte.py`, de/en, wie die anderen Glieder).
- Erreichbarkeits-Diagnose: zehntes Glied `selfhost_probe_version.py`.
- Betreiberregel dokumentieren: `MIN_SERVER_VERSION` nur anheben, wenn die
  Instanzliste es hergibt.

### C

- Neues Verzeichnis `infra/self-host/updater/` mit `Dockerfile` und
  `update.sh` (aus `pulse-update.sh` abgeleitet; die Logik soll **einmal**
  existieren, Installer und Updater-Image ziehen dieselbe Datei).
- `docker-compose.yml` und `docker-compose.behind-proxy.yml`: zweiter Dienst
  `updater`, Digest-gepinnt, `read_only`, `cap_drop: [ALL]`,
  `security_opt: [no-new-privileges]`, Socket read-write eingehängt (anders
  geht Recreate nicht), eigenes Netz, kein Port, nur Ziel-Container `pulse`
  (per Name, nicht „alle").
- `allinone.yml`: Signatur-Schritt nach dem Push (`cosign sign`), Mirror auf
  `registry.howispulse.com` signiert mitziehen.
- Öffentlicher Schlüssel: im Updater-Image **und** in `pulse-update.sh`
  eingebacken; Installer-Skript prüft ab dann ebenfalls.
- Verhalten bei Prüfungsfehler: Image bleibt liegen, Log-Zeile mit Grund,
  nächster Lauf versucht es erneut; **nie** ein ungeprüftes Image starten.
- Neuer Bau-Workflow für das Updater-Image selbst (klein, Multi-Arch nativ
  wie `allinone.yml`, nicht QEMU), ebenfalls signiert.

## 8. Prüfplan

**Lokal beweisbar (Pflicht vor dem Landen):**
- A: pytest (Heartbeat mit/ohne Version, Vergleich, `/me/instances`),
  `pnpm check`/`build`, Frontend-Unit-Test für den Vergleich (importfreies
  Modul, s. `pnpm test:unit`-Falle in `CLAUDE.md`).
- C: lokale Registry (`registry:2`), Test-Image mit Wegwerf-Schlüssel
  signiert, Updater-Container fährt echte Umzüge gegen einen Dummy-Container.
  Drei Fälle: gültiges Siegel wird eingezogen; fehlendes oder falsches Siegel
  bleibt liegen (Container unverändert, Log nennt den Grund); kaputter Start
  rollt zurück. Zusätzlich: Updater fasst keinen fremden Container an.

**Nicht lokal beweisbar (nach dem Landen beobachten):**
- Der Signatur-Schritt in `allinone.yml` läuft nur beim Push auf `main`.
- Eine echte fremde Self-Host-Instanz gibt es derzeit nicht (Hetzner fährt
  den Dev-Stack im Cloud-Modus). Der Compose-Ernstfall ist nur lokal
  nachstellbar.

## 9. Bewusst nicht Teil davon

- `/internal/trigger-update` bleibt tot (§2).
- Hosts ohne cron/systemd (Docker Desktop, NAS): fängt C mit, sofern sie die
  Compose-Vorlage nehmen; sonst A.
- Ein Socket-Proxy: allenfalls spätere Härtung, kein Sicherheitsgewinn an den
  Rechten.
- Neue Abhängigkeit `cosign` (CI + Updater-Image): vom Betreiber mit der
  Wahl von C in Kauf genommen; Version beim Umsetzen gegen die aktuelle Doku
  prüfen, nicht aus dem Gedächtnis.
