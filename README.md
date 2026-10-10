# CLA-Unterschriften

Dieser Zweig enthält NUR die Unterschriftenliste des CLA-Bots
(`signatures/version1/cla.json`). Der Bot (`.github/workflows/cla.yml` auf
`main`) schreibt jede neue Unterschrift hierher.

Warum nicht auf `main`: `main` nimmt Änderungen nur mit Review an, und der Bot
hat keine Ausnahme — er könnte dort keine Unterschrift ablegen.

- Nicht löschen: ohne diesen Zweig kann niemand mehr unterschreiben.
- Nicht in `main` mergen: dieser Zweig hat keine gemeinsame Geschichte mit `main`.
- Von Hand nur in echten Ausnahmefällen ändern; der Bot pflegt die Liste selbst.
