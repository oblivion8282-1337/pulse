# Historie des früheren eigenen Repos

`pulse-linux-hq-sidecar.bundle` ist die vollständige Git-Historie des Repos, in
dem dieser Sidecar bis zum 2026-07-29 lag — 65 Commits, beide Branches
(`main` und `mess/keyframe-abstand`, letzterer ist der Messzweig, aus dem
`streaming/hq-labor/` hervorging).

**Warum sie hier liegt:** Das Repo auf GitHub existiert nicht mehr. Beim Umzug
in dieses Verzeichnis wurde der Code als sauberer Schnitt übernommen, ohne
Historien-Import — die Begründungen lebten also nur noch dort weiter. Als das
am 2026-07-31 auffiel, war der lokale Klon die einzige verbliebene Kopie.

**Was drinsteht und hier fehlt:** die Herleitung der Encoder- und Puffer-Werte
mit den zugehörigen Messungen, aufgeteilt auf einzelne Schritte
(„Vorlauf des Encoders abgeschaltet — 33,4 auf 2,9 ms", „der Ton bündelte das
Bild — an der Quelle behoben", „preset=p2 — gleiche Bildqualität, rund 40
Prozent weniger GPU"). Die verdichtete Fassung steht in der `CLAUDE.md` eine
Ebene höher; wer die einzelnen Schritte und ihre Zahlen braucht, klont hier.

## Hineinschauen

Ein Bundle verhält sich wie ein entferntes Repo:

```bash
git clone streaming/linux-hq-sidecar/historie/pulse-linux-hq-sidecar.bundle /tmp/lhs
cd /tmp/lhs && git log --all --oneline
```

Prüfen, ohne zu klonen:

```bash
git bundle verify streaming/linux-hq-sidecar/historie/pulse-linux-hq-sidecar.bundle
git bundle list-heads streaming/linux-hq-sidecar/historie/pulse-linux-hq-sidecar.bundle
```

**Nicht nachführen.** Das ist ein Standbild vom 2026-07-31, kein lebendes Repo.
Weiterentwickelt wird ausschließlich hier im Hauptrepo.
