# Ablage & Weg A — Umsetzungsstand nach der Nacht (2026-08-31)

> Für den Eigentümer: Was heute gebaut, getestet und entschieden wurde — und
> was als Nächstes kommt. Zweig: `feat/e2e-dm-krypto-weg-a` (alles gepusht).

---

## 1. Was heute neu entstanden ist

| Stück | Wo | Stand |
|---|---|---|
| Konzept „Kanäle mit eigener Ablage" | `docs/user-gehostete-kanaele-konzept.md` | fertig, inkl. §6a Bau-Variante 2 und §2a Produktentscheidung |
| Schnittanalyse DM-Zweig ↔ Ablage | `docs/ablage-krypto-schnittanalyse.md` | fertig; zentraler Befund: Zertifikats-Entfernung auf main vs. DM-Zweig |
| Ablage-Log-Format + Schreiber/Leser | `web/src/lib/ablage/` (format, segment, manifest, schreiber, leser, pruefsumme, adapter) | fertig, gegen echte Server erprobt |
| Speicher-Adapter | `web/src/lib/ablage/{syncOrdner,webdav,dropbox,onedrive,gdrive,s3}.ts` | fertig; MinIO, Nextcloud 34, Dropbox, Google Drive **live erprobt** |
| OAuth-Bausteine + App-Folder-Anbindungen | `oauth.ts`, `dropbox.ts`, `onedrive.ts`, `gdrive.ts` | fertig; Dropbox + Google **live durchlaufen** (Konsent, Code-Tausch, Refresh) |
| Instanz-Einstellung Kanal-Erstellung | `channel_creation_policy` (config + capabilities + Erzwingung) | fertig, 1555/1555 Gateway-Tests |
| Weg A (Gerätekrypto ohne Zertifikat) | `feat/e2e-dm-krypto-weg-a` | Klient- und Server-Seite zusammengeführt, **Zwei-Geräte-E2E gegen den Hetzner-Stack grün** |
| Login-Hook | `auth.svelte.ts` + `issue-flow.ts` | Geraete-Anmeldung (Key-Publishing) läuft wieder nach Login und Session-Restore — jetzt ohne Zertifikat |

---

## 2. Der Zwei-Geräte-Beweis (Hetzner-Stack)

`web/tests/e2e/e2e-dm-hetzner.spec.ts` (Lauf siehe Commit `c87665bc`):

1. `dev` und `dev2` melden sich über die normale Login-Seite an
2. Beide Geräte veröffentlichen ihre Schlüsselbündel **durch den Login-Hook**
   (Weg A — ohne Zertifikat; das war der Kern des Beweises)
3. Freundschaft, DM-Kanal, `dev` sendet verschlüsselt
4. `dev2` liest den Klartext live
5. **Postgres-Gegenprobe:** `chat.messages` bleibt für den Kanal leer — der
   Server hat den Klartext nie gesehen; das Postfach quittiert leer

Der Anhang-Testfall (gleiches Muster) ist ebenfalls grün: verschlüsselter
Upload, `dev2` sieht das Bild als blob-URL, und in
`chat.message_attachments` bleiben Name/Typ/Maß/Nachrichtenzeile NULL.

---

## 3. Was noch offen ist (ehrlich, nach Größe)

1. **Megolm für Ablage-Kanäle verkabeln** (größter Posten): Kanal-Flavor
   „eigene Ablage" auf Basis der privaten Gruppen (Etappe G1/G2),
   Megolm-Rahmen (Typ 2) im Ablage-Log, Postfach als Nachzieher-Quelle
   (Tausch gegen `quelle.ts`), verschlüsseltes Manifest.
2. **Kopplungs-E2E** (Etappe F): Zwei-Geräte-Verlaufsumzug — Server-Routen
   sind montiert und rauchgeprüft (401/422), der Krypto-Durchlauf braucht
   ein eigenes Spec.
3. **OneDrive-Anbindung**: Adapter + OAuth-Skript-Stecker sind gebaut und
   unit-geprüft; der echte Lauf braucht die Azure-Entscheidung
   (Kostenlos-Konto, Karte zur Identitätsprüfung).
4. **UI**: Erstellen-Dialog mit Laufwerk-Auswahl und Verbindungs-Assistent
   (Dropbox/OneDrive/Google: Zustimmen-Klick; Sync-Ordner: Ordnerdialog;
   Nextcloud: Link+Passwort), Festigungs-Kennzeichnung, Gerätesteuerung.
5. **Rust-Shim auf dieser Maschine**: `~/.cargo/bin/rustup` ist eine
   AppImage-Kopie und muss auf `/usr/bin/rustup` umgestellt werden (die
   17 pulse-krypto-Tests selbst sind vom Merge unberührt; CI deckt sie ab).

---

## 4. Entschärfte Risiken heute

- **Token-Vorfall:** Ein Bisektions-Probe-Push enthielt kurz den
  Dropbox-Refresh-Token (`weg-a-test-bisect`). Branch gelöscht, lokal
  gefegt, Gitignore-Regel sitzt. **Empfehlung: Dropbox-Zugriff für
  Pulse-Ablage-Dev in den Kontoeinstellungen entziehen** — der nächste
  Testlauf mint automatisch frisch.
- **Google-Token:** war nie auf GitHub (Push Protection blockierte ihn).
- **Koexistenz-Falle:** Serverseitig wird der Klartext-Weg für
  Ablage-Kanäle hart verworfen (403) — Mischzustände, wie sie den sechsten
  Bughunt prägten, sind am Server nicht mehr ausdrückbar.

---

## 5. Nächste Etappen in Ordnung

1. Zwei-Geräte-Erprobung der privaten Gruppen scharf schalten
   (`PRIVATE_GRUPPEN_ENABLED` + `E2E_DMS_ENABLED` als Instanz-Entscheidung)
2. Krypto-Etappe der Ablage (Liste oben, Punkt 1)
3. Erstellen-Dialog mit Ablage-Auswahl hinter der Instanz-Einstellung
4. OneDrive-Entscheidung (Azure-Kostenlos-Konto) und Kopplungs-E2E
