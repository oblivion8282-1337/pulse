# Overnight Bugfix-Loop — zurückgestellte Befunde (nicht auto-committed)

Befunde, die echt aussehen, aber KEIN minimaler Single-File-Fix sind (Cross-Service
und/oder Policy-Entscheidung nötig) — bewusst nicht im Loop gefixt, dem User zur
Entscheidung vorgelegt.

## 1. Voice-Force-Mute ohne Rollen-Hierarchie (voice_override.py)
- `PUT /channels/{cid}/members/{uid}/voice-override` prüft nur, dass der Aufrufer
  `MUTE_MEMBERS` hält — KEIN Vergleich mit der Rollen-Position des Ziels.
- Folge: ein Moderator mit `MUTE_MEMBERS` kann den Guild-Owner/Admin stummschalten
  (Override persistiert in Redis + live via LiveKit). Privilege-Eskalation innerhalb
  der Moderationswerkzeuge.
- Warum nicht im Loop gefixt: voice-signaling hat keine lokalen Rollen-Positionen
  (nur Permission-Bits des Aufrufers via chat-gateway). Fix braucht einen
  erweiterten/neuen chat-gateway-Endpoint (Top-Rollen-Position Aufrufer vs. Ziel)
  + Policy-Entscheidung (Admin-Ausnahme? gleiche Position erlaubt?). Parallel zum
  bereits notierten Kick/Ban-Hierarchie-Backlog.
- Analog: `*-deafen` und `voice-disconnect` denselben Check geben, falls eingeführt.

## 2. Letzter-Faktor-Löschung ohne Warnung (PasskeyRow.svelte)
- Löscht der User seinen EINZIGEN Passkey ohne aktivem TOTP, entfernt das Backend
  ihn + droppt die MFA-weiten Backup-Codes (CLAUDE.md-Spec) — die UI warnt NICHT,
  dass danach keine 2FA mehr übrig ist. Komponenten-Kommentar nennt das Entfernen
  bewusst „nicht account-destruktiv", deckt den Letzter-Faktor-Fall aber nicht ab.
- Warum nicht im Loop gefixt: braucht Eltern-Prop (isLastFactor / Gesamtzahl +
  TOTP-Status) + Produkt-/Copy-Entscheidung (Modal vs. Inline-Warnung, Wording).
  Cross-Component-Feature, kein minimaler Single-File-Fix. Löschung selbst korrekt.

## 3. ws_ops nicht auf Plugin-Namespace validiert (plugins/manifest.py) — Stufe-B-Härtung
- `PluginUses.ws_ops` wird nicht geprüft, dass jede Op mit `<plugin_name>:` beginnt.
  Ein Manifest könnte fremde Ops (z.B. `tamagotchi:feed`) deklarieren.
- Warum nicht im Loop gefixt: Stufe A lädt nur first-party Repo-Plugins (vertraut),
  und der ws_op-Registry-Dup-Guard fängt echte Kollisionen bei der Registrierung.
  Echte Relevanz erst bei Stufe B (externe/untrusted Plugins). Minimaler Fix dann:
  Loader-Check nach dem dir-name-Check, dass alle `manifest.uses.ws_ops` mit
  `manifest.name + ":"` beginnen (analog zum bestehenden name==dir-Check).

## 4. remove_reaction ohne VIEW_CHANNEL/ADD_REACTIONS-Check (routes/reactions.py) — niedrig
- `add_reaction` gatet (guild) auf ADD_REACTIONS (und via revoke_all-Invariante
  auf VIEW_CHANNEL); `remove_reaction` prüft nur Membership (resolve_channel_or_raise).
- Folge: ein Guild-Member ohne VIEW_CHANNEL kann eigene Reaktionen entfernen
  (`WHERE user_id==current.id`) + ein schwaches Message-Existenz-Orakel (404 vs 204).
  Kein Content-Leak, message_ids sind Snowflakes. Eigene Reaktion entfernen ist
  zudem eine De-Eskalation (arguably ok ohne ADD_REACTIONS).
- Warum nicht im Loop gefixt: braucht Refactor von `_load_for_reaction` (→ (kind, ch)
  zurückgeben) für einen Niedrig-Severity-Konsistenz-Gewinn. Minimaler Fix dokumentiert
  im Agent-Befund: VIEW_CHANNEL-Gate in remove_reaction spiegeln (wie add_reaction).

## 5. Guild-Audit-Log Pagination: created_at-Cursor kann Einträge überspringen (mod_queue.py:459 + AuditLogViewer.svelte) — niedrig
- list_audit_log paginiert mit `ModAuditLog.created_at < before` (strikt <),
  Frontend cursort auf `created_at` des letzten Eintrags. Postgres `now()` ist
  pro Transaktion konstant → schreibt EINE Aktion ≥2 Audit-Zeilen, teilen sie
  exakt denselben created_at. Fällt so eine Gruppe auf die 50er-Seiten-Grenze,
  wird der Rest still übersprungen (fehlende Audit-Einträge).
- Das Schwester-Admin-Log (admin.py:311) nutzt korrekt `id < before` (kollisionsfrei).
- Warum nicht im Loop gefixt: cross-cutting API-Contract-Change (mod_queue
  list_audit_log auf id-Cursor umstellen + AuditLogViewer.load anpassen).
  Niedrige Wahrscheinlichkeit (Mod-Aktionen meist 1 Audit-Zeile, distinkte Zeit).
  Minimaler Fix: Cursor auf `ModAuditLog.id < before` umstellen (analog admin.py).

## 6. Aktiver Self-Host kann Cloud-Social-Stores spoofen (dispatch-rules.ts / gateway-connection.ts _handle) — mittel, ARCHITEKTUR-ENTSCHEIDUNG
- Die aktive Connection dispatcht laut Design ALLES (dispatch-rules.ts docstring:
  "die aktive Connection dispatcht weiterhin alles"). Ist der aktive Server ein
  (bösartig modifizierter) Self-Host, kann er PURE_SOCIAL_OPS-Frames senden
  (friend_request_received/accepted/declined/cancelled, friend_removed,
  user_blocked, user_unblocked, dm_bump) → die landen in den CLOUD-globalen
  Social-Stores (friendRequests/friends/blocks/directMessages). Folge: gefälschte
  Freundschaftsanfragen, „Freund entfernt", „blockiert", Fake-DM-Bumps in der UI.
- KEIN Daten-Integritätsbruch: Cloud-DB unberührt; ein Accept geht via cloudRoute
  an die Cloud → schlägt fehl. Reines Client-UI-Spoofing + Social-Engineering-Vektor.
  Verstößt aber gegen das Minecraft-Isolationsmodell (Self-Host ≠ Cloud-Identität).
- Manifestiert nur mit einem BÖSARTIG modifizierten Self-Host (ehrliche Self-Hosts
  bedienen keine friend/DM-Routen — die sind CloudOnly, emittieren also diese Ops nie).
- **KRITISCHER Fix-Vorbehalt (Agent hatte's falsch):** NUR PURE_SOCIAL_OPS dürfen von
  einer Nicht-Cloud-Connection geblockt werden. PRESENCE_OPS (presence_update/
  status_changed) und MESSAGE_FAMILY_OPS sind DUAL-USE — presence_update trägt auch
  Self-Host-GUILD-Member-Presence, message-ops Self-Host-Guild-Chat. Diese zu blocken
  würde legitime Self-Host-Presence/Chat zerstören.
- Minimaler korrekter Fix: in gateway-connection._handle eine `cloudOnlyOp(evt)`-Prüfung
  (= PURE_SOCIAL_OPS.has(evt.op)) ergänzen: `if (!this.isCloud && cloudOnlyOp(evt)) return;`
  — gilt für aktive UND Background-Nicht-Cloud-Connections. Verhaltensneutral für
  ehrliche Server. Sicherheits-Architektur-Änderung am Dispatch-Trust-Core → User-Freigabe.

## 7. reports.py — kleine Härtungs-Optionen (KEINE manifesten Bugs, Backlog-Item)
- Backlog nannte "reports". Audit: rate-limited (10/h), body 10–5000, reason_code Literal — Kern-Schutz da.
- Enumeration-Oracle: WIDERLEGT — Route gibt IMMER {status:"received"} zurück, egal ob target existiert/sichtbar (keine response-differenzierung); mod-queue ist mod-only. Kein Leak.
- Optionale Härtung (nicht committed, low-value): (a) Selbst-Report blocken
  (target_user_id==current.id → 422; harmlose Noise, dismissable); (b) bei
  target_channel_id/message_id existenz+VIEW_CHANNEL prüfen + non-existent targets
  ablehnen (verhindert orphaned rows — bounded durch rate-limit, kein 500).
  Minimale Validierung ist aber bewusst (man darf global melden, z.B. aus DM/nach Kick).
