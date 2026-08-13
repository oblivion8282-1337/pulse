# Kanal-Ereignisse ohne Sicht-Schranke (2026-08-13)

Befund aus dem zweiten Bughunt, am Code bestätigt. **Teilweise behoben** — der
schwierigere Rest ist hier beschrieben, samt der Sackgasse, in die der
naheliegende Fix führt.

## Was behoben ist

`channel_created` und `channel_updated` gehen jetzt nur noch an Mitglieder mit
`VIEW_CHANNEL` für den betroffenen Kanal
(`pubsub_channel_guild.py::handle_guild_events`). Vorher waren sie nur nach
Guild-Mitgliedschaft gefiltert: wer einen privaten Kanal nicht sehen darf,
erfuhr trotzdem von seiner Entstehung und jeder Umbenennung.

`channel_deleted` bleibt bewusst ungefiltert: den Kanal gibt es dann nicht mehr,
`_resolve_channel_perms` löst ihn auf 0 auf, und der Filter würde **jeden**
Empfänger verwerfen — auch die, die ihn sehen durften und ihn jetzt aus ihrer
Liste nehmen müssen. Das Ereignis trägt ohnehin nur die Kennung.

## Was offen ist — und warum es nicht in einem Zug geht

`channel_permissions_updated` trägt die **vollständige Ausnahmeliste** des
Kanals: also genau, welche Rollen und Nutzer ihn sehen dürfen. Es geht heute an
alle Guild-Mitglieder, auch an die ohne Sichtrecht. Der Kommentar im Quelltext
räumt das sogar ein. An anderer Stelle versteckt das Programm die blosse
Existenz eines verbotenen Kanals ausdrücklich (404 statt 403) — über diesen
Nebenkanal ist das ausgehebelt.

**Der naheliegende Fix ist falsch.** Ein `VIEW_CHANNEL`-Filter (oder ein
Schwärzen der Liste) schliesst das Leck und bricht dabei die Seitenleiste:

* Der Client leitet **aus dieser Liste** ab, dass er den Zugriff gerade verloren
  hat — `web/src/lib/ws/handlers/channels.ts` reicht sie an
  `channelPermissions.apply` weiter, und die Sichtbarkeit in der Seitenleiste
  wird daraus berechnet.
* Wer sie ihm vorenthält, lässt ihm denselben Kanal stehen. Ein Klick darauf
  endet dann in einem 404 — schlechter als der Status quo.
* Genau das zeigt auch der bestehende Test
  `test_private_channel_blocks_member_from_message_broadcast`: er wartet
  ausdrücklich auf dieses Ereignis, um zu wissen, dass die Sperre greift.

## Wie es richtig ginge

Zwei verschiedene Nachrichten statt einer:

1. Wer den Kanal weiterhin sehen darf, bekommt `channel_permissions_updated`
   unverändert.
2. Wer ihn gerade **verloren** hat, bekommt stattdessen ein Ereignis, das nur
   sagt „dieser Kanal ist für dich weg" — ohne Liste. Ein passendes gibt es
   bereits: `ChannelHiddenEvent` (`shared/src/dcc_shared/events/guild.py`),
   heute für den Sprachkanal-Fall benutzt und ausdrücklich dafür beschrieben,
   dass ein Kanal die Liste eines Nutzers verlassen muss.
3. Wer ihn gerade **gewonnen** hat, braucht das Gegenstück `ChannelRevealedEvent`
   — sonst fehlt ihm der Kanal bis zum nächsten Neuladen.

Der Aufwand steckt nicht im Senden, sondern im **Delta**: der Gateway muss beim
Fan-out je Empfänger wissen, ob sich seine Sicht gerade geändert hat. Die
Bausteine dafür sind da (`_filter_by_view_channel`, der pro-Socket-Cache und
dessen Verwerfen laufen bereits vor dem Fan-out), aber es ist ein Eingriff in
den Weg, über den jede Kanal-Änderung aller Nutzer läuft.

## Einschätzung

Kein akuter Notfall: betroffen sind nur Mitglieder derselben Community, und was
sie erfahren, ist die Zusammensetzung der Berechtigungen — keine Inhalte, keine
Nachrichten, keine Anhänge. Es gehört trotzdem behoben, weil es einer
ausdrücklichen Zusage des Programms widerspricht.

Vor der Umsetzung am besten am laufenden Client prüfen, wie die Seitenleiste
heute wirklich auf Zugriffsverlust reagiert — dieser Text stützt sich auf das
Lesen von `channels.ts`, nicht auf eine Beobachtung.
