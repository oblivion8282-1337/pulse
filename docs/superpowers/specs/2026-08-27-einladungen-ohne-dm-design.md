# Community-Einladungen verlassen den DM-Kanal

Stand 2026-08-27. Etappe 1 des Vorhabens „Ende-zu-Ende-verschlüsselte
Direktnachrichten" (Gesamtschnitt siehe unten, §9).

## 1. Ziel

Eine Community-Einladung wird heute als **Nachricht im DM-Verlauf** zugestellt.
Sie zieht auf die Schiene um, auf der Freundschaftsanfragen und
Nutzername-Einladungen längst fahren: eine Inbox mit Annehmen/Ablehnen, ohne
jede Berührung mit dem Nachrichtenverlauf.

Danach gibt es **einen** Einladungsweg statt zwei. Die Umstellung senkt die
Komplexität, statt sie zu erhöhen.

## 2. Warum das zwingend ist, nicht kosmetisch

`routes/community_invites.py::_send_invite_dm` (Zeile 120 ff.) legt eine
`Message`-Zeile mit `author_id = inv.inviter_id` an — der Server schreibt eine
Nachricht **im Namen eines Dritten**. Der Inhalt ist der blanke Einladungslink;
die Karte entsteht erst im Client, der den Link per Regex erkennt
(`web/src/lib/components/MessageItem.svelte:91`, `INVITE_RE`).

Sobald DM-Inhalte clientseitig verschlüsselt sind, ist das unmöglich: um eine
Nachricht zu erzeugen, die als vom Einladenden verschlüsselt gilt, bräuchte der
Server dessen Schlüssel. Den hat er nicht und soll ihn nie haben. Dasselbe gilt
für den Re-Invite-Pfad, der eine vorhandene Karte **an Ort und Stelle
umschreibt** (`prior.content = link`). Zusätzlich verschwände die Einladung mit
der Zustellfrist aus Etappe 4, während der Broker-Eintrag noch lebt.

Geprüft: `community_invites.py:159` ist die **einzige** Stelle im chat-gateway,
die eine Nachricht im Namen eines anderen erzeugt. Die übrigen `Message(`-Treffer
sind die zwei regulären Sendewege (`messages.py:204`, `ws_op_send.py:238`);
Stream- und Watch-Party-Chat sind eigene flüchtige Typen und fassen `messages`
nicht an.

## 3. Ist-Zustand: zwei Wege, die dasselbe Ergebnis anstreben

| | Weg A — Broker | Weg B — Inbox |
|---|---|---|
| Tabelle | `community_invites` | `community_invite_notifications` |
| Route | `routes/community_invites.py` | `routes/member_invites.py` |
| Wer darf einladen | nur **bestätigte Freunde** | jeder mit `CREATE_INVITES`, per **Nutzername** |
| Ziel | Cloud **und Self-Host** (`target_host`, host-geprägter `code`) | **nur Cloud** (FK auf `guilds.id`) |
| Zustellung | Nachricht im DM-Verlauf | Inbox + `community_invite_received` |
| Zeile nach Entscheidung | gelöscht („B-lite, privacy by design") | bleibt als Historie (`accepted`/`declined`) |
| Frontend-Modul | `api/community-invites.ts` | `api/communityInvites.ts` |

Beide Frontend-Module exportieren `communityInvitesApi` — die Dateinamen
unterscheiden sich nur durch einen Bindestrich. Diese Verwechslungsfalle fällt
mit der Zusammenlegung weg.

Weg B ist bereits vollständig ausgebaut und **bleibt die Zielschiene**:
`GET /me/community-invites`, accept, decline, Hydration im `ready`-Rahmen
(`ws_ready.py:557`, `payload["community_invites"]`), WS-Ereignis
`community_invite_received` mit Client-Handler samt Benachrichtigung
(`web/src/lib/ws/handlers/friends.ts:40`), Anzeige in
`components/friends/CommunityInviteCards.svelte`.

## 4. Zielzustand

`POST /community-invites` bleibt als Pfad bestehen (Frontend-Kontrakt
unverändert), schreibt aber statt Broker-Zeile + DM eine Zeile in
`community_invite_notifications`. `_send_invite_dm` und `_find_prior_invite_dm`
entfallen ersatzlos.

Alle vorhandenen Gates des Broker-Wegs bleiben unverändert bestehen:
Selbsteinladung (400), Block in beide Richtungen (403, vor der
Freundschaftsprüfung), Freundschaftspflicht (403), Mitgliedschaftsprüfung für
Cloud-Ziele, Rate-Limit pro Einladendem (429).

Damit münden zwei **verschiedene Zugangswege** in eine Inbox: Freunde (mit
Self-Host-Zielen) und Nicht-Freunde per Nutzername (nur Cloud). Die Gates
bleiben unterschiedlich — das ist Absicht und gehört dokumentiert, nicht
vereinheitlicht.

Das Antwortformat von `POST /community-invites` (`CommunityInviteOut`) bleibt
feldgleich, auch wenn die Zeile aus einer anderen Tabelle stammt. Ein Refactoring
darf das Verhalten nach aussen nicht ändern; bricht ein Test, ist der Code kaputt,
nicht der Test.

## 5. Datenmodell — Migration 0063

`community_invite_notifications` wird um die Felder erweitert, die heute nur
Weg A kennt:

| Spalte | Typ | Bedeutung |
|---|---|---|
| `target_host` | `String(255)`, nullable | NULL = Cloud-Ziel; sonst der Host |
| `target_instance_id` | `BigInteger`, nullable | informativ, hilft dem Client beim Abgleich |
| `code` | `Text`, nullable | host-geprägter Einladungscode; nur beim Freundes-Weg gesetzt |
| `expires_at` | `DateTime(tz)`, nullable | spiegelt die Absicht der Host-Einladung |
| `guild_name` | `String(128)`, nullable | denormalisiert — bei Self-Host-Zielen kennt die Cloud keine `guilds`-Zeile |

**Der FK `guild_id → guilds.id` muss fallen.** Ein Self-Host-Ziel hat in der
Cloud keine `guilds`-Zeile, die Fremdschlüsselbedingung wäre unerfüllbar. Der
CASCADE-Effekt („gelöschte Community nimmt ihre offenen Einladungen mit") wird
in der Guild-Delete-Route explizit nachgebaut. Das ist im Repo etabliert:
`Message.channel_id` trägt aus demselben Grund keinen FK und wird in
`routes/channels.py::delete_channel` von Hand aufgeräumt.

**Revision-ID höchstens 32 Zeichen** — `alembic_version` ist `varchar(32)`, eine
längere ID lässt die Prod-Migration zurückrollen (kostete am 2026-06-08 bereits
einen Umlauf).

Die Migration **erweitert und übernimmt nur**. Offene Broker-Zeilen
(`community_invites`) werden in die Notification-Tabelle überführt. Die alte
Tabelle wird **nicht** in derselben Migration gedroppt, sondern in einer
Folge-Migration nach erfolgreichem Deploy — dasselbe Muster wie
`9999_drop_user_cloud_backup` in auth, aus demselben Grund: Rollback-Sicherheit.

## 6. Statusmodell

Weg A löscht die Zeile bei Entscheidung, Weg B behält sie. Übernommen wird
**Weg B**: der Status verhindert, dass jemand nach einer Ablehnung sofort erneut
einlädt. Ergänzt wird ein Aufräumlauf in `cleanup.py`, der entschiedene Zeilen
nach 30 Tagen entfernt — Spam-Schutz bleibt, Datensparsamkeit auch.

Getrennt davon steht der **Verfall offener Einladungen**: Weg A kennt
`expires_at` samt Index und fegt abgelaufene Karten. Diese Logik zieht mit um,
sonst bleiben abgelaufene Einladungen in der Inbox stehen und lassen sich
annehmen — der Host würde den Beitritt zwar ablehnen, aber erst nach dem Klick.

## 7. Annehmen bei Self-Host-Zielen

Der Accept-Endpunkt muss künftig zwei Fälle können. Für Cloud-Ziele bleibt
alles wie heute (Beitritt serverseitig, `_publish_member_added`). Für
Self-Host-Ziele gibt er dem Client `{host, code}` zurück, und der Client fährt
seinen **bestehenden** Beitrittsweg gegen den Host, der den Code live prüft.

**Kein Server-zu-Server-Aufruf.** Die Cloud kann einen fremden Einladungscode
ohnehin nicht verifizieren — sie liefert ihn nur aus. Das hält den Aufwand klein
und ändert am heutigen Vertrauensmodell nichts.

## 8. Frontend

- `api/community-invites.ts` und `api/communityInvites.ts` werden zu **einer**
  Datei zusammengeführt; der doppelte Export `communityInvitesApi` verschwindet.
- `CommunityInviteCards.svelte` zeigt zusätzlich den Ziel-Host an und löst bei
  Self-Host-Zielen den bestehenden Beitrittsweg aus.
- `InviteFriendPicker.svelte` und `InviteToServerSubmenu.svelte` rufen denselben
  Endpunkt wie bisher. Nur die Erfolgsmeldung ändert sich: „Einladung gesendet"
  statt eines Hinweises auf den Chat.
- `MessageItem.svelte::INVITE_RE` **bleibt unangetastet.** Ein von Hand
  getippter Einladungslink rendert weiterhin als Beitreten-Karte. Das ist reine
  Client-Arbeit und überlebt die Verschlüsselung unbeschadet.

## 9. Ausdrücklich nicht Teil dieser Etappe

- `routes/invites.py` (die host-geprägten Einladungscodes) bleibt unberührt.
- Freundschaftsanfragen bleiben unberührt.
- Bereits verschickte DM-Karten werden **nicht** migriert und nicht gelöscht.
  Sie sind gewöhnliche Nachrichten mit einem Link, rendern weiter und
  verschwinden mit dem Altbestand in Etappe 6.
- Keine Verschlüsselung. Diese Etappe ist Vorarbeit und für sich nützlich.

## 10. Tests

- `test_community_invites.py` wird umgeschrieben: statt „eine DM entsteht" nun
  „eine Inbox-Zeile entsteht". Alle Gate-Tests bleiben unverändert gültig.
- **Ein ausdrücklicher Test, dass die Einladung KEINE `messages`-Zeile mehr
  erzeugt.** Das ist die eigentliche Zusage dieser Etappe; ohne diesen Test
  könnte ein späterer Umbau sie stillschweigend zurücknehmen.
- `test_member_invites.py` wird um ein Self-Host-Ziel erweitert (accept liefert
  `{host, code}` statt beizutreten).
- Migrationstest: offene Broker-Zeilen landen in der Inbox.
- E2E: `web/tests/e2e/invite.spec.ts` prüft heute den DM-Weg und muss auf die
  Inbox umgestellt werden.

## 11. Changelog

User-facing — Einladungen erscheinen an einem anderen Ort. Ein Eintrag in
`web/static/changelog.json` ist fällig, Stil sachlich, ohne Emojis, mit echten
Umlauten.

## 12. Einordnung ins Gesamtvorhaben

| | Etappe | hängt an |
|---|---|---|
| **1** | **Einladungen von den DMs lösen** (dieses Dokument) | — |
| 2 | Krypto-Kern (vodozemac, Apache-2.0) und Schlüsselverzeichnis | — |
| 3 | Lokaler Verlauf im Client | — |
| 4 | Verschlüsselte Zustellung, Löschpolitik, Anhänge | 1, 2, 3 |
| 5 | Geräte-Verknüpfung und Verlaufsübertragung per QR | 3, 4 |
| 6 | Altbestand umstellen | 4 |
| 7 | iOS | 4, 5 |
| — | Android-Wecker (data-only-FCM) | unabhängig; braucht ein Firebase-Projekt |

Die getroffenen Grundsatzentscheidungen: Server hält DMs nur bis zur Zustellung;
Geräte gleichen sich ab und übertragen den Verlauf beim Verknüpfen; kein
serverseitiges Backup, das Zweitgerät ist der Rettungsweg; Verschlüsselung ist
Pflicht ab Stichtag, der Altbestand bekommt eine Frist; Schutzziel ist
Datensparsamkeit („ich will die Daten nicht haben"), nicht Signal-Niveau.
