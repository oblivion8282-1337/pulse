#!/usr/bin/env bash
# Sitzungsstart: meldet, wenn der Wissensgraph auf DIESER Maschine fehlt.
#
# **Warum es das braucht.** `graphify-gate.sh` ist bewusst fail-open: ohne
# `graphify-out/graph.json` laesst es jede Suche durch. Das ist richtig — ein
# kaputtes Gate darf die Arbeit nicht anhalten —, hat aber eine unangenehme
# Folge: Auf einer Maschine, auf der graphify nie eingerichtet wurde, greift
# die Schranke NIE, und nichts weist darauf hin. Die Hooks wandern ueber das
# Repo mit (`.claude/` ist getrackt), das Werkzeug und der Graph nicht.
#
# Genau dieses Muster — gebaut, ausgeliefert, aber auf der Zielmaschine nie
# aktiv — hat in diesem Projekt schon mehrfach Zeit gekostet. Deshalb hier ein
# Hinweis beim Start statt stiller Wirkungslosigkeit.
#
# Es BLOCKIERT nicht. Am Sitzungsstart etwas zu verweigern waere unverhaeltnis-
# maessig; wer ohne Graph arbeiten will, soll das koennen.

set -uo pipefail
cat >/dev/null 2>&1 || true   # Hook-Eingabe verwerfen, wir brauchen sie nicht

melde() {
  python3 -c "
import json,sys
print(json.dumps({'systemMessage': sys.argv[1]}))
" "$1" 2>/dev/null || true
  exit 0
}

if ! command -v graphify >/dev/null 2>&1; then
  melde "Graphify ist auf dieser Maschine nicht installiert — die Graph-Schranke (.claude/hooks/graphify-gate.sh) laeuft daher wirkungslos. Einrichten mit: uv tool install graphifyy && graphify update ."
fi

if [ ! -f graphify-out/graph.json ]; then
  melde "Graphify ist installiert, aber fuer dieses Projekt gibt es noch keinen Graphen — die Schranke laeuft wirkungslos. Aufbauen mit: graphify update ."
fi

exit 0
