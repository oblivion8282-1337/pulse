# Ende-zu-Ende-verschlüsselte Direktnachrichten — Übergabe und Etappenplan

> **Für agentische Bearbeiter:** Dieses Dokument ist eine Übergabe, kein
> einzelner Ausführungsplan. Die Aufgaben in §3 sind ausführungsfertig
> (`superpowers:subagent-driven-development` oder `superpowers:executing-plans`).
> Etappen 3 bis 7 in §5 brauchen **je einen eigenen Plan**, bevor daran
> gearbeitet wird — sie sind eigenständige Teilprojekte.

**Ziel:** Direktnachrichten werden Ende zu Ende verschlüsselt, und der
Produktivserver behält weder ihre Inhalte noch ihre Anhänge.

**Ansatz:** Der Server hält eine Nachricht nur, bis das Gerät des Empfängers
sie abgeholt hat (plus eine Frist für Offline-Geräte), dann löscht er sie. Der
Verlauf lebt ausschliesslich auf den Geräten; ein neues Gerät bekommt ihn beim
Verknüpfen vom alten. Der Krypto-Kern ist eine Rust-Kiste, die im Browser als
WASM und auf dem Telefon nativ läuft.

**Tech-Stack:** vodozemac (Apache-2.0, Double Ratchet) · Rust → WASM und JNI ·
FastAPI + SQLAlchemy + Alembic · SvelteKit 5 Runes · Capacitor-Android

**Spec:** `docs/superpowers/specs/2026-08-27-einladungen-ohne-dm-design.md`
(deckt Etappe 1 im Detail und trägt in §12 die Gesamteinordnung)

## Global Constraints

- **Keine AGPL- oder GPL-Abhängigkeit.** `libsignal` ist AGPL-3.0-only und
  damit ausgeschlossen — Pulse ist source-available, und die AGPL griffe über
  den Netzwerk-Paragraphen bis in den Server. Ersatz ist **vodozemac**
  (Apache-2.0).
- **Keine neue Abhängigkeit ohne Rückfrage** beim Eigentümer.
- **Quelldateien ≤ 350 Zeilen (hart 500), Svelte-Komponenten ≤ 250.**
- **Alembic-Revision-ID höchstens 32 Zeichen** — `alembic_version` ist
  `varchar(32)`, längere IDs lassen die Prod-Migration zurückrollen.
- **Kein `git push` und keine GitHub-CLI ohne Freigabe.** Merge nach `main`
  ist ein Prod-Deploy.
- **Prüfen vor dem Landen:** `bash scripts/gate.sh`. Playwright hängt in
  keinem Gate — „Gate grün" ist nicht „E2E grün".
- **Niemals Schlüssel oder Token loggen.**
- **Changelog:** user-sichtbare Änderungen brauchen einen Eintrag in
  `web/static/changelog.json`, Stil vom Eigentümer wählen lassen, **keine
  Emojis**, echte Umlaute.

---

## 1. Wo das Vorhaben steht

**Etappe 1 ist fertig und auf `main`.** Community-Einladungen haben den
Nachrichtenverlauf verlassen; der Server schreibt keine Nachricht mehr im Namen
eines Dritten. Enthalten sind Migration 0063, die Route `/app/invites`, der
Eintrag mit eigenem Zähler in der `@me`-Spalte, die Symbolleiste am Desktop und
der Changelog-Eintrag `2026-08-27.10`.

Der Rest des Vorhabens ist **nicht angefasst**: es gibt bis heute keine
Verschlüsselung, keinen lokalen Verlauf und keinen Krypto-Kern.

### Die fünf Grundsatzentscheidungen (getroffen, nicht mehr zur Debatte)

| Entscheidung | Folge |
|---|---|
| Server hält DMs nur bis zur Zustellung | Verlauf lebt auf den Geräten |
| Geräte gleichen sich ab, Verlauf wandert beim Verknüpfen per QR | eigenes Bauteil in Etappe 5 |
| Kein serverseitiges Backup; das Zweitgerät ist der Rettungsweg | die App muss aktiv dazu drängen |
| Verschlüsselung ist Pflicht ab Stichtag, Altbestand bekommt eine Frist | Etappe 6 |
| Schutzziel ist Datensparsamkeit, **nicht** Signal-Niveau | Krypto darf im Web laufen, die App darf ihre Oberfläche remote laden |

Das Schutzziel ist der wichtigste Satz für jede spätere Abwägung: geschützt
wird gegen Datenbank-Leak, Beschlagnahme, Haftung und neugierige Admins —
**nicht** gegen ein Pulse, das seine eigenen Nutzer angreift.

---

## 2. Offene Entscheidungen (brauchen den Eigentümer)

**E1 — Wo Einladungen am Telefon liegen.** Auf `< md` ist die `@me`-Spalte der
Bereich **Chats**; dorthin zeigt der neue Eintrag. Gleichzeitig sind die
Einladungskarten aus dem Anfragen-Reiter im Bereich **Freunde** entfernt worden.
Eine Einladung liegt damit unter Chats, obwohl sie inhaltlich zu Freunde gehört.
Wahl: (a) der Eintrag erscheint mobil zusätzlich unter Freunde, (b) mobil
bleiben die Karten im Anfragen-Reiter und der eigene Ort gilt nur ab `md`,
(c) ein fünfter Bereich in der unteren Leiste — davon ist abzuraten, vier sind
für 390 px bereits reichlich.

**E2 — Zeilenform der Einladungskarte.** Heute steht die **Person** oben
(„Lena Brandt" / „lädt dich in Pixelschmiede ein"), gleiche Form wie die
Freundschaftsanfrage daneben. Zur Wahl steht, die **Community** nach oben zu
holen, weil über sie entschieden wird. Beide Varianten sind gezeichnet.

---

## 3. Reste aus Etappe 1 — ausführungsfertig

### Task 1: Abgelaufene Einladungen wegfegen

Der Broker kannte einen Verfall über `expires_at`; die Spalte ist mit Migration
0063 mitgewandert und wird beim Anlegen gefüllt, aber **niemand räumt danach
auf**. Eine abgelaufene Einladung bleibt in der Inbox stehen und läuft beim
Antippen in einen Fehler des Zielservers.

**Dateien:**
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/cleanup.py`
- Test: `services/chat-gateway/tests/test_member_invites.py`

**Schnittstellen:**
- Nutzt: `CommunityInviteNotification.expires_at` (nullable, aus Migration 0063)
- Liefert: nichts für andere Aufgaben

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

```python
@pytest.mark.asyncio
async def test_abgelaufene_einladung_wird_gefegt(session_factory):
    """Eine Einladung mit vergangenem expires_at verschwindet beim Aufraeumen.

    Eine Zeile ohne expires_at (Cloud-Ziel, das nie verfaellt) bleibt stehen —
    NULL darf nicht als 'laengst abgelaufen' gelesen werden.
    """
    from datetime import UTC, datetime, timedelta

    from dcc_chat_gateway.cleanup import sweep_abgelaufene_einladungen
    from dcc_chat_gateway.models import CommunityInviteNotification
    from dcc_chat_gateway.snowflake import next_id

    alt_id, ewig_id = next_id(), next_id()
    async with session_factory() as s:
        s.add(CommunityInviteNotification(
            id=alt_id, guild_id=1, inviter_user_id=2, invitee_user_id=3,
            guild_name="Alt", expires_at=datetime.now(UTC) - timedelta(hours=1),
        ))
        s.add(CommunityInviteNotification(
            id=ewig_id, guild_id=1, inviter_user_id=2, invitee_user_id=4,
            guild_name="Ewig", expires_at=None,
        ))
        await s.commit()

    async with session_factory() as s:
        entfernt = await sweep_abgelaufene_einladungen(s)
        await s.commit()
    assert entfernt == 1

    async with session_factory() as s:
        assert (await s.get(CommunityInviteNotification, alt_id)) is None
        assert (await s.get(CommunityInviteNotification, ewig_id)) is not None
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen:
```bash
REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest \
  services/chat-gateway/tests/test_member_invites.py::test_abgelaufene_einladung_wird_gefegt -v
```
Erwartet: FAIL mit `ImportError: cannot import name 'sweep_abgelaufene_einladungen'`

- [ ] **Schritt 3: Die Funktion schreiben**

In `cleanup.py`. **Achtung:** das Modul fegt heute ausschliesslich
long-idle Web-Push-Abos — sein Kopf-Docstring sagt das so, und `_run_once`
tut nur das. Wer hier einen zweiten Gegenstand hineinlegt, zieht den
Docstring mit, sonst behauptet er mehr, als er hält.

```python
async def sweep_abgelaufene_einladungen(session: AsyncSession) -> int:
    """Loescht Community-Einladungen, deren Frist verstrichen ist.

    ``expires_at IS NULL`` heisst „verfaellt nicht" (Cloud-Ziele) und muss
    ausdruecklich ausgenommen werden — ein blosses ``< now()`` liesse NULL
    zwar ohnehin durchfallen, aber die Absicht gehoert in den Code, nicht in
    eine SQL-Feinheit.
    """
    ergebnis = await session.execute(
        delete(CommunityInviteNotification).where(
            CommunityInviteNotification.expires_at.is_not(None),
            CommunityInviteNotification.expires_at < datetime.now(UTC),
        )
    )
    return ergebnis.rowcount or 0
```

- [ ] **Schritt 4: In den bestehenden Aufräum-Takt hängen**

`cleanup.py` hat mit `cleanup_loop` bereits eine schlafgesteuerte Schleife
(gleiches Muster wie `routes.attachments.reaper_loop`: Fehler geloggt und
geschluckt, `CancelledError` weitergereicht). Den neuen Sweep in `_run_once`
mit aufrufen und den Modul-Docstring von „Web-Push subscriptions" auf beide
Gegenstände erweitern — **keine zweite Schleife anlegen**.

Die Frist ist bereits konfigurierbar gedacht: `push_subscription_idle_days`
ist das Vorbild für einen eigenen Einstellwert, falls einer gebraucht wird.

- [ ] **Schritt 5: Tests laufen lassen**

```bash
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud \
  uv run --all-packages pytest services/chat-gateway/tests/ -q -n 4
```
Erwartet: alle grün (zuletzt 1423)

- [ ] **Schritt 6: Committen**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/cleanup.py \
        services/chat-gateway/tests/test_member_invites.py
git commit -m "fix(einladungen): abgelaufene Einladungen verschwinden aus der Inbox"
```

### Task 2: Die alte Broker-Tabelle droppen

Migration 0063 hat `community_invites` bewusst stehen lassen, damit ein
Rollback die Daten noch findet. Der Deploy ist erfolgt, die Tabelle ist tot:
kein Code schreibt oder liest sie mehr.

**Vorbedingung:** auf Produktion prüfen, dass die Tabelle leer bzw. übernommen
ist, bevor die Migration läuft.

**Dateien:**
- Anlegen: `services/chat-gateway/alembic/versions/<datum>_0064_drop_community_invites.py`
- Löschen: `services/chat-gateway/src/dcc_chat_gateway/models/community_invites.py`
- Ändern: `services/chat-gateway/src/dcc_chat_gateway/models/__init__.py` (Re-Export)

- [ ] **Schritt 1: Vorher greppen** — `grep -rn "CommunityInvite\b" services/ web/`
      Jede Fundstelle muss auf `CommunityInviteNotification` zeigen oder weg.
      Der Löschen-Fall der Regel „eine Behauptung wird nie an nur einer Stelle
      korrigiert": ein Dateipfad ist eine Behauptung wie jede andere.
- [ ] **Schritt 2: Migration schreiben** (Revision-ID ≤ 32 Zeichen), mit
      symmetrischer `downgrade`, die die Tabelle samt Indizes wieder anlegt.
- [ ] **Schritt 3:** `REDIS_URL=… PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest services/chat-gateway/tests/ -q -n 4`
- [ ] **Schritt 4: Committen**

### Task 3: Der Self-Host-Zweig ist ungetestet

Beim Annehmen einer Einladung auf einen fremden Server gibt die Cloud
`{target_host, code}` zurück, und der Klient geht über
`joinGuildByInvite('https://app/invite/<code>?host=<host>')`. **Dieser Weg ist
nie an zwei laufenden Servern erprobt worden** — nur die Backend-Hälfte ist
durch Tests gedeckt.

- [ ] Zwei Instanzen aufsetzen (Cloud lokal + Self-Host, oder der gemeinsame
      Hetzner-Stack, s. `infra/dev-remote/README.md`)
- [ ] Einladung von einem Freund auf die Self-Host-Community verschicken
- [ ] Annehmen — erwartet: der Klient landet im Beitrittsfluss des Hosts, der
      den Code live prüft
- [ ] Fehlerfall prüfen: abgelaufener oder zurückgezogener Code

---

## 4. Etappe 2 — Krypto-Kern und Schlüsselverzeichnis

**Das ist der nächste grosse Schritt und hängt an nichts.** Vollständig ohne
Hardware und ohne fremde Konten baubar.

### Was schon da ist und wiederverwendet wird

Pulse hat das schwierigste Stück eines E2E-Systems bereits — ein
**authentifiziertes Verzeichnis von Geräteschlüsseln**, gebaut für den
Cert-Login:

- Jedes Gerät erzeugt lokal ein **Ed25519-Schlüsselpaar**
  (`web/src/lib/identity/keypair.svelte.ts`), privater Teil
  `extractable: false` — er kann das Gerät nicht verlassen, auch nicht per XSS.
- Der öffentliche Teil liegt als `issued_credentials.device_pubkey` beim
  Server, von der Cloud **signiert**. Bis zu 20 aktive Geräte pro Konto.
- Widerruf ist voll ausgebaut: CRL, Grabsteine (`auth.revoked_credentials`),
  Verteilung an Self-Hosts über `/.well-known/revoked-credentials`.

Das `extractable: false` passt genau zur getroffenen Entscheidung: der
Schlüssel kann nicht wandern, der Verlauf ist damit zwangsläufig
gerätegebunden.

### Was fehlt

1. **Ein zweites Schlüsselpaar pro Gerät zum Verschlüsseln.** Ed25519 kann nur
   signieren; für den Schlüsselaustausch braucht es X25519. Ein X25519-Paar aus
   dem Ed25519 abzuleiten ist mathematisch möglich, aber ein Krypto-Anti-Muster,
   wenn man es selbst macht — **ein eigenes Paar erzeugen.**
2. **Einmalschlüssel (Prekeys)**, damit man auch an ein ausgeschaltetes Gerät
   schreiben kann, plus Nachfüll-Route.
3. **Die Nachrichtenschicht** darüber (vodozemac-Sitzungen, Sitzungszustand).

### Aufgaben-Zuschnitt (jede braucht vor der Umsetzung einen eigenen Detailplan)

| | Aufgabe | Prüfbar durch |
|---|---|---|
| 2.1 | Kiste `streaming/…`-Muster folgend anlegen: `pulse-krypto` mit vodozemac, reine Rust-Tests | `cargo test` |
| 2.2 | WASM-Ausgabe für den Web-Klienten (`wasm-pack`), Ansprache aus TypeScript | Node-Testläufer, s. Falle unten |
| 2.3 | Android-Cross-Build (NDK, `aarch64-linux-android`) — **kompilieren genügt**, Ausführen braucht ein Gerät | `cargo build --target` |
| 2.4 | X25519-Paar je Gerät im Klienten erzeugen und veröffentlichen | Playwright + Backend-Test |
| 2.5 | Serverseitiges Verzeichnis: Spalte am `issued_credentials`-Modell oder eigene Tabelle, plus Prekey-Vorrat und Nachfüll-Route | pytest |

**Vor 2.1 nachschlagen, nicht raten:** Die vodozemac-API (Account, Session,
`OlmMessage`, Prekey-Handhabung) ist hier bewusst nicht abgeschrieben. Wer 2.1
umsetzt, liest zuerst die Dokumentation der Kiste und hält die tatsächlichen
Signaturen in seinem Detailplan fest.

**Die Falle bei 2.2:** Unit-Tests laufen über Nodes eingebauten Läufer, nicht
über Vitest. Eine geprüfte Datei darf **keinen erweiterungslosen
Laufzeit-Import** haben (`from './nachbar'`) — der Bundler löst ihn auf, Node
nicht. Reine Rechnung gehört in ein importfreies Modul (Muster:
`lib/remote/zeigerbildPruefung.ts`).

**Werkzeuge, die auf einer frischen Maschine fehlen** (kostenlos, kein Konto):

```bash
rustup target add wasm32-unknown-unknown aarch64-linux-android armv7-linux-androideabi
cargo install wasm-pack
sdkmanager "ndk;27.0.12077973"    # Pfad je nach Android-SDK-Installation
```

---

## 5. Etappen 3 bis 7 — Aufriss

Jede braucht einen eigenen Plan, bevor daran gearbeitet wird.

**Etappe 3 — Lokaler Verlauf im Klienten.** Der grösste Brocken, und bewusst
**vor** der Verschlüsselung: der Klient speichert und zeigt seinen DM-Verlauf
lokal, noch mit lesbaren Daten. Steht dieser Umbau, ist der Rest ein Austausch
der Nutzlast. Betroffen ist mehr, als es aussieht — die **DM-Vorschautexte**
kommen heute vom Server, und zwar an *zwei* Stellen: `GET /dm-channels` und der
`ready`-Rahmen, der die Liste im Klienten überschreibt. Beide müssen lokal
werden. Grobschätzung drei bis fünf Wochen.

**Etappe 4 — Verschlüsselte Zustellung, Löschpolitik, Anhänge.** Warteschlange
statt `messages`-Tabelle, Quittung löscht, Frist löscht. Anhänge im selben Zug:
verschlüsselt vor dem Upload, MinIO sieht einen Blob ohne Namen und ohne Typ.
`MessageAttachment` ist dafür vorbereitet — `mime`, `filename`, `width`,
`height` sind laut Docstring bereits „nullable by-design … Phase-2 E2EE DMs".
Der Klient muss Thumbnails und Bildmasse selbst erzeugen und mitverschlüsseln,
sonst springt das Layout.

Offen und in dieser Etappe zu klären: **was der Service Worker anzeigt.** Der
Double Ratchet hat Zustand; entschlüsseln Service Worker und offene Seite
gleichzeitig, treten sie sich auf die Füsse. Der sichere Weg ist eine
generische Meldung („Neue Nachricht von …", der Absender ist unverschlüsselt
bekannt) und Entschlüsseln erst beim Öffnen.

**Etappe 5 — Geräte-Verknüpfung per QR.** Kopplung und Verlaufsübertragung von
Gerät zu Gerät. Zugleich der einzige Rettungsweg bei Geräteverlust, weil es
kein serverseitiges Backup gibt. Ohne Kamera prüfbar, wenn der Code auch als
Text einzugeben ist — was ohnehin für Barrierefreiheit gebaut werden sollte.

**Etappe 6 — Altbestand.** Vorwarnung, Frist, Löschlauf. Klein, aber heikel:
hier verlieren Nutzer sichtbar etwas.

**Etappe 7 — iOS.** Eigenes Projekt. In `mobile/` liegt **nur** ein
`android/`-Verzeichnis; eine iOS-App existiert nicht. Braucht das Apple
Developer Program (99 USD im Jahr, auch für TestFlight) und ein iPhone.

### Unabhängig: der Android-Wecker

Data-only-FCM. Löst schon heute, dass die ausgelieferte APK **überhaupt keine**
Benachrichtigungen bekommt (Capacitor-WebView kann kein Web-Push), und ist
später die Zustellschiene für verschlüsselte DMs: Google bekommt nur „da ist
was", die App entschlüsselt selbst und baut die Meldung lokal.

Braucht ein Firebase-Projekt (kostenlos) und **ein echtes Android-Gerät** —
Doze-Verhalten lässt sich im Emulator nicht beurteilen. Das ist der einzige
Punkt des ganzen Vorhabens, der vor Etappe 7 an Hardware hängt.

Wichtig: **Web-Push braucht kein Google-Konto.** Die VAPID-Schlüssel erzeugt
`vapid.py` selbst. Wer Pulse über Chrome als PWA installiert, bekommt heute
Benachrichtigungen und behält sie nach der Umstellung. Firebase wird nur für
die APK gebraucht, nicht für das Feature.

---

## 6. Auf einer anderen Maschine weitermachen

```bash
git fetch origin && git checkout main && git pull --ff-only
bash scripts/gate.sh --maschine   # sagt, was diesem Rechner fehlt
```

Der Werkzeugkasten reist über das Repo mit, Systemwerkzeuge und die
Git-Identität nicht. Die zwei üblichen Fehlanzeigen: `redis-server` (ohne ihn
laufen die Tests seriell, ~7 min statt ~1:15) und `git config --local
pulse.adminmerge true` (ohne ihn bleibt `ship.sh` auf BLOCKED stehen und es
sieht wie eine GitHub-Störung aus).

**Dev-Stack:** `scripts/dev-up.fish` fährt alles hoch. Seit dem 2026-08-27 gibt
es `PULSE_DEV_SKIP_MEDIAMTX=1` — nötig, wenn das `gh`-Token kein
`read:packages` hat, sonst reisst der Pull des privaten MediaMTX-Images den
ganzen Stack ab. Für Streaming-Arbeit vorher `gh auth refresh -s read:packages`.

### Zwei Fallen, die in dieser Sitzung Zeit gekostet haben

**`pnpm check` neben einem laufenden Dev-Server zerschiesst die App.** Der
Befehl ruft `paraglide:compile` mit und tauscht die erzeugten
Übersetzungs-Module unter Vite aus; der Klient wirft danach
`does not provide an export named 'm'` und rendert gar nichts mehr. Sichtbar
nur in `/tmp/dcc-vite.log`. Wer während eines laufenden Stacks prüfen will,
nimmt `pnpm exec svelte-check --tsconfig ./tsconfig.json`. Nach einem
versehentlichen Lauf hilft ein Vite-Neustart.

**WS-Tests brauchen lokal `PULSE_INSTANCE_MODE=cloud`**, sonst bricht der
Lifespan mit „PULSE_INSTANCE_ID must be set … on a self-host" ab.
