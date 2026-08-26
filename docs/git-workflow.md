# Git-Workflow — `git tidy` und warum Zweige liegenbleiben

Ausgelagert aus `CLAUDE.md` am 2026-08-26, Inhalt unverändert. Dort stehen die
verbindlichen Regeln (Feature-Zweig, Landen über `scripts/ship.sh`,
Remote-Dev-Sitzung); hier der Alias samt seiner drei nicht-offensichtlichen
Stücke, die man nur beim Einrichten oder Reparieren braucht.

- **Warum sich Zweige trotz `git tidy` ansammeln** (Erfahrung vom 2026-08-19, 50 → 9 Zweige): `git tidy` räumt nur weg, was der Server bereits gelöscht hat — also nur, was über einen eigenen PR gelandet ist. Unterzweige einer Remote-Dev-Sitzung werden lokal in den Integrationszweig gefaltet und bleiben deshalb liegen (28 Stück). Und Arbeit, die **neu gebaut statt gemergt** wurde, zählt `git cherry` weiter als offen, obwohl inhaltlich alles in `main` steht (`feat/remote-control-windows`, `wgpu30-migration`). **Prüfregel für einen alten Zweig: existieren seine Dateien in `main` überhaupt noch?** Beim Player-Fix für hohe Bildraten war `app/takt.rs` längst ein ganzes Modul — der Zweig sah nach ungelöstem Problem aus und war erledigt.

  ```
  git config --global alias.tidy '!f() {
    git fetch --prune -q
    LC_ALL=C git for-each-ref --format="%(refname:short) %(upstream:track)" refs/heads |
      awk "\$2==\"[gone]\" {print \$1}" |
      while read -r b; do
        if [ -n "$(git cherry main "$b" 2>/dev/null | grep "^+")" ]; then
          echo "BEHALTEN - $b hat Commits, die nicht in main sind"
        elif ! git branch -D "$b" 2>/dev/null; then
          echo "BEHALTEN - $b ist in einem Worktree ausgecheckt (erst: git worktree remove)"
        fi
      done
  }; f'
  ```

  Drei nicht-offensichtliche Stücke (beim Kürzen nicht wegfallen):

  **`for-each-ref` statt `branch -vv`.** Bis zum 2026-08-17 stand hier `git branch -vv` samt `awk`-Griff „nimm Spalte 2, wenn Spalte 1 ein `*` ist". Das übersieht **`+`**, mit dem `git branch` einen in einem **Worktree** ausgecheckten Branch markiert — der Alias las dann `+` als Branchnamen und meldete je Worktree ein `Fehler: Branch '+' nicht gefunden`, während die eigentlichen Branches liegenblieben. `for-each-ref` gibt gar keine Markierung aus; damit ist die Fallunterscheidung überflüssig statt nur repariert.

  **`LC_ALL=C`** Pflicht (sonst schreibt git auf deutscher Maschine `[entfernt]` statt `[gone]` → Muster greift nie, räumt still gar nichts).

  **`git cherry`** statt `--merged`/`-d`: bei Rebase-Merges haben gleiche Änderungen andere Prüfsummen, `--merged`/`-d` halten den Branch fälschlich für ungemergt — mit `-D` wäre er wortlos weg. **Diese Prüfung fehlte am 2026-08-17 in der real installierten Fassung**, obwohl sie hier dokumentiert war; wer den Alias auf einer Maschine schon hat, gleicht ihn mit `git config --global --get alias.tidy` gegen den Block oben ab.

  Ein Branch in einem Worktree lässt sich nicht löschen, solange dieser besteht — der Alias sagt das jetzt, statt mit einer Fehlermeldung abzubrechen. Aufräumen: `git worktree list`, dann `git worktree remove <pfad>`, dann erneut `git tidy`.
