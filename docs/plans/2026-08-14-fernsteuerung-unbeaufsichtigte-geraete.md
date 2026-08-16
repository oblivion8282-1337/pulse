# Fernsteuerung: unbeaufsichtigte Geräte am Standplatz

**Stand 2026-08-14 — Entwurf, nichts davon ist gebaut.** Festgehalten wird hier
das Ergebnis eines Entwurfsgesprächs, damit die Begründungen nicht verloren
gehen. **§6 (Registrierung) kam am 2026-08-16 dazu** und beantwortet die
Frage, die vorher als offene Entscheidung in §11.1 stand.
Der Oberflächen-Entwurf liegt daneben als
`2026-08-14-geraete-standplatz-mockup.html` (in sich geschlossen, im Browser
öffnen; benutzt die echten Glasshouse-Tokens aus `web/src/app.css` und die
eingebettete Plus Jakarta Sans).

Baut auf: `2026-08-12-input-wire-protokoll-v2.md` (Drahtvertrag der Eingabe),
`2026-08-13-fernsteuerung-p2p-eingabeweg.md` (Eingabeweg).

## 1. Das Problem

Die Fernsteuerung ist heute auf einen Menschen zugeschnitten, der etwas
überträgt und gefragt wird, ob jemand mitfassen darf. Der Fall, um den es hier
geht, ist ein anderer: **ein Rechner, vor dem niemand sitzt** und der nur
existiert, um aus der Ferne benutzt zu werden.

Zwei Dinge stehen dem im Weg, und nur eines davon ist die Zustimmung.

**Die Zustimmung.** `RemoteConsentDialog` ist modal und verlangt einen Klick.
Bleibt er aus, verfällt die Anfrage nach 30 s
(`remote_registry.py::REMOTE_PENDING_TIMEOUT_S`), und das Aussitzen zählt als
Absage: `remote_note_refused` legt danach 30 s Sperrfrist auf das Paar. Ein
unbeaufsichtigter Rechner läuft also nicht nur ins Leere, er sperrt den
Anfragenden anschliessend auch noch aus.

**Der Ort.** Ein Gerät ist keine Person. Es kann nicht sprechen, gehört in keine
Sprecherliste und hat keinen Anwesenheitsstatus. Trotzdem braucht es eine
Stelle, an der man es findet und an der festgelegt ist, wer es benutzen darf.

Dazu kommt, dass der Stream heute von Hand gestartet wird und der
Fernsteuer-Knopf an einer Stream-Kachel hängt — ohne laufende Übertragung gibt
es nicht einmal einen Ort, an dem man anfragen könnte.

## 2. Befund aus dem Code

Untersucht am 2026-08-14. Die gute Nachricht zuerst:

**Das Backend hat Streaming und Voice nie gekoppelt.** Für einen Stream prüft
`routes/streaming.py::_require_voice_channel_member` (Z. 128–142) ausschliesslich
Guild-Mitgliedschaft und `channel.type == CHANNEL_TYPE_VOICE`, dazu
`Permissions.STREAM` (Z. 193–196). **Kein Blick in `voice:room:channel-<id>`** —
weder beim Publish noch beim Zuschauen (`get_whep_url`, Z. 262–296). In
`media-svc` und `mediamtx-auth-hook` findet sich kein einziger Treffer auf
`voice:room`. Ein Gerät, das überträgt ohne im LiveKit-Raum zu sein,
funktioniert heute technisch bereits.

**Gekoppelt ist nur die Oberfläche**, und zwar an zwei Stellen:

* `VoiceChannelView.svelte:227` rendert das StreamGrid nur, wenn **der
  Zuschauer** mit Voice verbunden ist.
* `ChannelList.svelte:653` leitet das LIVE-Abzeichen aus
  `voicePresence.usersIn()` ab — wer überträgt ohne Room-Join, hat dort keine
  Zeile.

Die Guild-Mitgliederliste macht es dagegen schon richtig: ihr Abzeichen kommt
aus `streamPresence.streamersIn` (`MemberList.svelte:209–219`), voice-unabhängig.
Der Kopfkommentar von `streamPresence.svelte.ts` hält die Trennung von
`voicePresence` ausdrücklich fest. Das Muster existiert also, es ist nur nicht
durchgezogen.

**Der Start-Knopf bezieht seine `channelId` aus `voice.channelId`**
(`HqStreamButton.svelte:36`, `StreamControls.svelte:68/108`), und die Leiste
rendert nur bei bestehender Voice-Verbindung (`SidebarFooter.svelte:29`). Einen
impliziten Voice-Join beim Streamstart gibt es nicht — `StreamControls.onStart`
(Z. 107–169) ruft nur `getStreamToken` und `gsr.start`.

**Der Fernsteuer-Knopf** hängt an der Kette `HqStreamBackgroundHost` →
`WhepPlayer` → `NativeWindowPanel` → `RemoteRequestButton` und setzt eine
offene HQ-Kachel eines laufenden Streams voraus. Eine Voice-Teilnahme prüft
keine dieser Stellen — indirekt wirkt sie nur über die Sichtbarkeit der Kachel.

## 3. Das Modell: Standplatz

**Ein Gerät steht in einem Kanal, ohne dort Teilnehmer zu sein.** Wie ein
Werkzeug, das in einem Raum steht: wer den Raum betreten darf, sieht es; wer die
Berechtigung hat, benutzt es.

Der Kanal ist nicht Zierde, sondern der **Rechteanker**. Daran hängt die ganze
bestehende Mechanik: `resolve_permissions(user, guild_id, channel_id)`, die
Rechte-Wache im 30-s-Takt (`remote_guard.py`), `REMOTE_CONTROL` als
Kanal-Overwrite. Ein Gerät ohne Kanal hätte keine Stelle, an der sich festlegen
liesse, wer es übernehmen darf.

**Ein Standplatz je Gerät.** Sollen mehrere Teams zugreifen, regelt das eine
Rolle im Standplatz-Kanal — keine zweite Zuordnung. Mit mehreren Standplätzen
bräuchte es eine Zuordnungstabelle und eine Entscheidung, welcher Kanal gilt,
wenn zwei Leute aus verschiedenen Kanälen gleichzeitig wollen.

**Der Standplatz ist wechselbar.** Beim Wechsel endet eine laufende Sitzung —
die Rechte hingen am alten Kanal, ein stiller Übergang wäre die falsche Art von
bequem.

Der Steuernde sitzt dabei oft sehr wohl im Sprachkanal: er will nebenbei mit den
anderen reden, während er am Gerät arbeitet. Das ist seine Sache, nicht die des
Geräts.

## 4. Gerätenatur

Bleibt sie kosmetisch, entsteht genau die Verwirrung, die das Modell vermeiden
soll — ein Ding, das aussieht wie eine Person und nicht antwortet. Also:

* Erscheint **nie** in der Sprecherliste, auch nicht ausgegraut.
* Kein Anwesenheitsstatus als Person. Stattdessen drei Gerätezustände:
  **bereit / belegt (von @x) / offline**. Beides steht bereits in der Registry —
  `remote_user_sockets` und `remote_user_has_session` liefern es, es wird nur
  nirgends ausgestrahlt.
* Keine Direktnachrichten, kein Nachrichtenverlauf.
* Eigener Abschnitt in der Mitgliederliste, nicht unter die Menschen gemischt.
* Ein **Besitzerkonto**, das die Dauerfreigabe ändern darf.

Die Zeile mit den Direktnachrichten trägt mehr als sie aussieht: wäre auf dem
Remote-Rechner das Konto seines Besitzers angemeldet, läse jeder, der ihn
steuert, dessen Chatverlauf mit. Bei einem Menschen, der zehn Minuten bewusst
hergibt, ist das seine Entscheidung; bei einem Dauergerät wäre es ein
**Dauerleck**.

## 5. Oberfläche

Voll im Mockup, hier die tragenden Entscheidungen.

**Rund heisst Mensch, eckig heisst Maschine.** Menschen behalten den runden
Avatar und ihre Namensfarbe; Geräte bekommen eine eckige Kachel, einen
Monospace-Namen und einen entsättigten Stahlton. Der Unterschied muss vor dem
Lesen wirken.

**Geräte sind eine eigene Kategorie in der Kanalliste**, gleichrangig neben
Textkanälen und Sprachkanälen — kein Anhängsel eines Kanals. Kategorien sind
dort flache Überschriften (`ChannelList.svelte:387/539`), das Muster trägt
unverändert.

**Anklicken öffnet das Gerät im Hauptbereich**, wie ein Kanal. Kein Popover, das
man wieder wegklickt: man ist dann beim Gerät, und die Kopfzeile sagt das auch.

**Geräte stehen in beiden Listen** — das ist keine Doppelung, weil beide
verschiedene Fragen beantworten. Links *wohin kann ich*: kompakt, ein
Zustandspunkt genügt, Klick führt hin. Rechts *was gehört zu dieser Community
und wie steht es gerade*: ausgeschriebener Zustand samt Nutzer, und dort hängt
das Kontextmenü mit Besitzer, Protokoll und Einstellungen. Dasselbe Verhältnis
haben Menschen heute schon — eingerückt unter dem Sprachkanal und zugleich in
der Mitgliederliste.

**Die Kategorie wird nach dem Standplatz gefiltert**, genau wie Kanäle nach
`VIEW_CHANNEL`: wer die Werkstatt nicht sehen darf, sieht auch das Gerät nicht,
das dort steht.

**Alle Bildschirme in EINER Aufnahme.** Nur so spannen die Zeigeranteile
(0..65535, Wire-Protokoll v2) den gesamten Desktop; über vier 4K-Schirme bleiben
rund vier Stufen je Pixel. Getrennte Aufnahmen je Monitor bräuchten je einen
Slot und eine Zuordnung, welcher Slot welchen Schirm meint.

## 6. Registrierung: ein Gerät ist ein Ausweis, kein Konto

**Nachtrag 2026-08-16.** Die Frage „wie meldet sich so ein Gerät überhaupt an"
beantwortet sich weitgehend von selbst, sobald man sieht, dass die Bindung eines
Rechners an eine Person längst existiert — sie wird heute nur nicht als *Gerät*
gelesen.

**Was heute schon steht.** Jede Installation erzeugt beim ersten Anmelden ein
Ed25519-Schlüsselpaar, das den Rechner nie verlässt: `extractable: false` in
IndexedDB (`web/src/lib/identity/keypair.svelte.ts`) — auch die eigene App kann
es nicht auslesen. Dafür stellt `POST /credentials/issue` einen Ausweis auf das
Konto aus (`routes_credentials.py` → Tabelle `issued_credentials`): mit
Gerätenamen, 365 Tage gültig, höchstens 20 aktive je Konto, drei Ausstellungen
je Stunde, einzeln widerrufbar. Der Widerruf erreicht auch fremde Self-Hosts
binnen zehn Sekunden (`crl_poller.py`, `CRL_POLL_INTERVAL`). Ein Gerät ist damit
heute schon **ein Ausweis, der einer Person gehört**, mit Namen, Liste und
Not-Aus.

**Die Registrierung in fünf Schritten:**

1. Der Besitzer sitzt **einmal körperlich** an dem Rechner und meldet sich
   normal an. Der Ausweis entsteht dabei ohnehin — heute namenlos als
   „irgendein Browser".
2. Er trägt das Gerät als Standplatz-Gerät ein: Name (`werkstatt-pc`),
   Community, Standplatz-Kanal. Das ist der einzige wirklich neue Schritt.
3. **Der Rechner unterschreibt diese Eintragung mit seinem eigenen Schlüssel.**
   Dieselbe Frage-Antwort-Mechanik wie beim Cert-Login
   (`routes/cert_login.py`: 32-Byte-Nonce, Ed25519 über die rohen Nonce-Bytes,
   einmalig verwendbar). **Warum nicht einfach ein Klick im Browser:** ohne die
   Unterschrift könnte jeder Angemeldete fremde Rechner auf Verdacht eintragen.
   Erst sie belegt, dass sich *dieser* Rechner einträgt.
4. Der Server legt die Gerätezeile an: Besitzer, Ausweis-Kennung, Standplatz,
   Name. Mehr braucht es nicht — die Rechte hängen ab da am Kanal (§3).
5. Die Dauerfreigabe bleibt auf dem Gerät (§7). Der Server erfährt, **dass** es
   selbsttätig annimmt; setzen darf er es nie.

**Die körperliche Anwesenheit in Schritt 1 ist kein Umstand, sondern der Ersatz
für die Zustimmung**, die später wegfällt. Genau einmal muss jemand dort
gestanden haben — dieselbe Vorverlegung wie in §7, nur eine Stufe früher.

**Der Haken, und wo er zu schließen ist.** Benutzt das Gerät den Ausweis seines
Besitzers, dann *ist* es in Pulse dieser Besitzer — und damit auch in seinen
Direktnachrichten (das Dauerleck aus §4).

*Zuerst gedacht:* der Server schließt es. In einer Self-Host-Sitzung steht
bereits, mit welchem Ausweis sie zustande kam (`SessionClaims.cert_id`,
`shared/src/dcc_shared/session_tokens.py`); an dieser einen Stelle könnte er
sagen „diese Verbindung ist ein eingetragenes Gerät" und ihr Chat, Verlauf und
Direktnachrichten verweigern.

**Beim Bauen am 2026-08-16 hat sich das als falsch herausgestellt** — es nimmt
zu viel und schließt zu wenig:

* *Zu wenig:* der Nachrichtenverlauf kommt über REST, und eine REST-Anfrage
  trägt keine Verbindung. Der Server kann ihr nicht ansehen, dass sie von einem
  gerade ferngesteuerten Rechner stammt — der Riegel verfehlte genau den Weg,
  über den ein Steuernder lesen würde.
* *Zu viel:* ein Riegel, der immer gilt, nähme dem Besitzer den Chat auf seinem
  eigenen Rechner, auch wenn niemand ihn steuert.

**Gebaut wurde deshalb ein Sichtschutz am Schirm**, der genau so lange gilt, wie
jemand steuert (`web/src/lib/devices/components/DeviceSichtschutz.svelte`).
Das ist auch die richtige Ebene: die Gefahr ist eine des **Sehens** — der
Steuernde sieht Pixel, keine API-Antworten. Und es ist wirksam, weil Pulse auf
einem Standplatz-Gerät die einzige offene Tür zu diesem Konto ist: die Anmeldung
liegt im Geräte-Speicher, nicht im Browser.

**Die Marke gehört an den Ausweis, nicht an das Konto** — sonst verstummte auch
der eigene Laptop des Besitzers.

**Ehrliche Lücke:** in der **Cloud** trägt das Zugangs-Token diese Auskunft
heute nicht. Es kennt nur `sub`, `admin`, `owner`, `email_blocked`
(`security.py`) — kein Gerät. Auf Self-Hosts trägt der Weg also sofort, für die
Cloud müsste der Ausweisbezug ins Token nachgezogen werden. Klein, aber es
gehört benannt statt vorausgesetzt.

**Damit ist §11.1 vorerst entschieden**, mit diesen Abwägungen:

* *An den Ausweis gebunden (dieser Weg):* klein, alles vorhanden; Besitz und
  Widerruf sind sofort da. Preis: das Chat-Leck muss aktiv verhindert werden,
  das Gerät lässt sich nur über das Konto des Besitzers weitergeben, und mit
  ihm fällt es, wenn er die Community verlässt.
* *Eigenes Geräte-Konto:* das Leck fällt bauartbedingt weg, der Besitzer ist
  umtragbar, das Gerät überlebt ihn. Preis: ein neuer Kontentyp greift in
  Registrierung, Mitgliederlisten und Moderation.

Der spätere Umstieg auf ein Geräte-Konto (Stufe 3, §12) tauscht dann nur aus,
**wem der Ausweis gehört** — die Mechanik darüber bleibt gleich. Deshalb der
kleine Weg zuerst, und deshalb die Marke am Ausweis.

## 7. Dauerfreigabe — die Zustimmung wird vorverlegt, nicht abgeschafft

Jemand sitzt **einmal** körperlich an dem Rechner und gibt ihn frei. Danach
beantwortet der Host-Client `remote_request` selbsttätig mit `accept: true`.

Der Vorteil: **kein Eingriff ins Protokoll**. `ws_remote_handlers.py`,
`remote_registry.py` und der Drahtvertrag bleiben wortgleich; der Gateway sieht
eine ganz normale Zustimmung, nur nach 20 ms statt nach 4 s. Der gesamte
Schutzapparat bleibt in Kraft.

**Der Schalter gehört ans Gerät, nicht auf den Server** — in
`desktop/electron/store.ts` (`pulse-stream.json`, unter Linux bereits
`chmod 600`). Ein serverseitiger Schalter wäre von einem Admin fernaktivierbar,
und „ein Admin schaltet fremde Rechner scharf" ist genau das, was diese
Zustimmung verhindern soll. Der Server darf erfahren, **dass** ein Gerät
automatisch annimmt; setzen darf er es nie.

**Nicht „für alle", sondern eine Freigabeliste** entlang derselben Achsen, die
der Zustimmungsdialog heute schon nennt (Person und Ort): Rolle und/oder
einzelne Nutzer im Standplatz-Kanal, dazu eine Geltungsdauer (bis Neustart /
8 Stunden / dauerhaft). Die Rechteprüfung engt das zusätzlich ein, sie ersetzt
es nicht.

**Ersatz für den fehlenden Zeugen.** Bei einem unbeaufsichtigten Rechner ist die
eigentliche Sicherheit von heute weg — dass jemand danebensitzt und zusieht.
Drei Teile treten an ihre Stelle:

1. **Protokoll**, gleichberechtigt neben der Freigabe und nicht in einem
   Untermenü: wer wann wie lange übernommen hat.
2. **Vorrang des Hosts als Notausstieg.** Er greift unverändert
   (`remote_input/wache.rs`); für unbeaufsichtigte Geräte sollte er zusätzlich
   anbietbar sein als *beenden* statt *fünf Sekunden dämpfen*. Wer sich an den
   Rechner setzt, will ihn zurück.
3. **Sichtbare Anzeige am Gerät selbst**, falls doch jemand hinkommt.

## 8. Aufwecken: zwei Schritte, ein Klick

Das Gerät überträgt **erst auf Abruf** — ein Remote-Rechner, der rund um die Uhr
für niemanden encodiert, ist Verschwendung.

Naheliegend wäre, `remote_request` selbst als Weckruf zu nehmen. Dagegen spricht
ein konkreter Fehlerfall: dann hinge eine **Sitzungszusage an einer
Encoder-Initialisierung**. Scheitert die — kein Monitor angeschlossen, Encoder
belegt, Startverweigerung wegen HDR oder Intra-Refresh — stünde eine aktive
Fernsteuer-Sitzung ohne Bild, und der Fehler wäre nicht lesbar.

Deshalb getrennt: wecken → übertragen → **dann** die unveränderte
`remote_request`. In der Oberfläche darf das ein Klick mit Fortschrittsanzeige
sein; im Protokoll bleiben es zwei einzeln lesbare Vorgänge.

## 9. Was bereits trägt

Der bestehende Schutzapparat passt auf unbeaufsichtigte Geräte erstaunlich gut
und braucht keine Änderung:

* **Rechte-Wache im 30-s-Takt** (`remote_guard.py::remote_perm_audit_loop`) —
  Rollenentzug und Kanal-Overwrite wirken auch mitten in der Sitzung.
* **Sofortiger Abbau bei Rauswurf und Bann**
  (`end_remote_sessions_for_member`, gerufen aus `guilds.py` und `bans.py`).
* **Absoluter Sitzungsdeckel** von 8 Stunden (`REMOTE_MAX_SESSION_S`).
* **Eine Sitzung je Host** (`remote_create` gibt sonst `None`).
* **Fail-closed bei unbekanntem Peer-Socket** (`_end_reason`).

Der Sitzungsdeckel ist bei einem Gerät unkritisch: mit Dauerfreigabe geht eine
neue Anfrage wortlos durch, solange der Host-Client von selbst wieder online
kommt.

## 10. Harte Grenzen unter Windows

Alle aus derselben Wurzel — der Sidecar ist ein Userland-Prozess:

* **Sperrbildschirm und abgemeldete Sitzung**: dort existieren Electron und
  Sidecar gar nicht. Nach einem Neustart ohne Auto-Anmeldung läuft nichts.
* **UAC / Secure Desktop**: verschluckt Bild *und* Eingabe. Das ist bereits als
  Laborbefund belegt (`streaming/win-hq-labor/testbench/`, siehe `CLAUDE.md`) —
  unbeaufsichtigt heisst es, dass ein UAC-Fenster eine Sackgasse ist, die
  niemand vor Ort wegklicken kann.
* **Kein angeschlossener Monitor**: WGC braucht eine Ausgabe (Dummy-Stecker oder
  virtueller Anzeigetreiber).

Genau deshalb ist „unattended" bei den kommerziellen Werkzeugen ein
Systemdienst. **Vorschlag für die erste Fassung: den angemeldeten, entsperrten
Desktop tragen — und das ansagen**, statt es stillschweigend halb zu können.
Dieselbe Linie wie bei Intra-Refresh und HDR (Startverweigerung statt
Etikettenschwindel).

## 11. Offene Entscheidungen

1. **Geräte-Konto oder Merkmal am bestehenden Konto.** Ein eigenes Konto ist
   sauberer und schliesst das Chat-Leck aus §4; ein Merkmal wäre schneller
   gebaut. — **Am 2026-08-16 vorerst entschieden zugunsten des Merkmals, und
   zwar am Ausweis statt am Konto (§6).** Offen bleibt nur noch der Zeitpunkt
   des Umstiegs auf ein Geräte-Konto (Stufe 3, §12).
2. **Offline-Geräte sichtbar?** Dagegen spricht Rauschen, dafür, dass man sonst
   nicht sieht, dass das Gerät überhaupt existiert. Entwurf zeigt sie
   abgeblendet.
3. **„Nur zusehen" ohne Übernahme.** Darf jemand ein Gerät allein zum Zusehen
   wecken? Naheliegend ja — aber dann kann ein Berechtigter den Rechner beliebig
   oft hochfahren lassen, ohne ihn je zu benutzen.
4. **Vorrang: dämpfen oder beenden** bei unbeaufsichtigten Geräten (§7).
5. **Mehrere gleichzeitige Zuschauer** bei nur einem Steuernden — die
   Ein-Sitzung-je-Host-Regel betrifft die Steuerung, nicht das Zusehen. Wie das
   in der Oberfläche gezeigt wird, ist offen.

## 12. Stufenplan

1. **Dauerfreigabe am Gerät + selbsttätige Zustimmung im Client.** Klein, kein
   Protokoll-Eingriff, trägt sofort. Übertragung startet noch von Hand.
2. **Geräte als Grundelement**: Kategorie in der Kanalliste, Abschnitt in der
   Mitgliederliste, Geräteansicht im Hauptbereich, Übertragung auf Abruf.
3. **Geräte-Konto, Kiosk-Betrieb, Windows-Härtung** (Auto-Anmeldung, kein
   Sperren, virtueller Monitor) samt ehrlich dokumentierter Grenzen aus §10.
