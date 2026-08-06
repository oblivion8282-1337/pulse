#!/usr/bin/env bash
# Graphify-Gate — verweigert die Roh-Suche, solange der Graph nicht befragt wurde.
#
# **Warum es das braucht.** Bis 2026-08-06 hing an denselben Werkzeugen nur ein
# HINWEIS ("MANDATORY: run graphify query first"). Ein Hinweis wird gelesen und
# überstimmt; in einer langen Sitzung ist praktisch durchgehend direkt gegrept
# worden, obwohl der Graph danebenlag. Die Simplifier-Sperren daneben werden
# dagegen nie umgangen — weil sie sperren. Genau dieser Unterschied wird hier
# nachgezogen.
#
# **Was es NICHT tut.** Es verbietet die Roh-Suche nicht dauerhaft, sondern
# verlangt EINMAL pro Sitzung eine Graph-Abfrage. Danach ist der Weg frei: für
# gezielte Einzelstellen (eine bekannte Datei, eine konkrete Zeile) ist grep
# weiterhin das richtige Werkzeug, und der Graph hat dann seinen Zweck erfüllt
# — die Orientierung.
#
# Fail-open an drei Stellen, alle mit Absicht: ohne Graph, ohne Sitzungs-ID und
# bei jedem inneren Fehler wird durchgelassen. Ein kaputtes Gate darf die
# Arbeit nicht anhalten — es soll lenken, nicht blockieren.

set -uo pipefail

EINGABE=$(cat 2>/dev/null || true)

wert() { # $1 = Schlüsselpfad in der Hook-Eingabe
  printf '%s' "$EINGABE" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print(''); raise SystemExit
t=d.get('tool_input',d)
print(d.get('$1') or t.get('$1') or '')
" 2>/dev/null || true
}

durchlassen() { exit 0; }

# Kein Graph im Projekt -> nichts zu verlangen.
[ -f graphify-out/graph.json ] || durchlassen

SITZUNG=$(wert session_id)
[ -n "$SITZUNG" ] || durchlassen

STEMPEL=".git/.graphify-used-${SITZUNG}"
[ -f "$STEMPEL" ] && durchlassen

# Die Abfrage selbst darf nie blockiert werden — sonst gäbe es keinen Weg heraus.
BEFEHL=$(wert command)
case "$BEFEHL" in *graphify*) durchlassen ;; esac

# **Nur Roh-Suchen sperren, nicht jeden Aufruf.** Ohne diese Einschränkung
# stünde das Gate vor `ls`, `git status` und allem anderen — es würde die
# Arbeit anhalten statt sie zu lenken, und wäre nach einer Stunde abgeschaltet.
# Gemeint ist die BREITE Suche über den Baum; ein `grep` in einer einzelnen,
# bereits bekannten Datei ist genau der Fall, den auch der Hinweistext
# ausdrücklich erlaubt.
if [ -n "$BEFEHL" ]; then
  case "$BEFEHL" in
    grep*|*" grep "*|rg\ *|*" rg "*|ag\ *|ack\ *|*"git grep"*) : ;;
    *) durchlassen ;;
  esac
fi

# Für Read/Glob: nur Quelltext zählt. Doku, Konfiguration und Messakten sind
# keine Struktur-Erkundung — dort hilft der Graph nicht.
PFAD="$(wert file_path)$(wert pattern)"
if [ -z "$BEFEHL" ] && [ -n "$PFAD" ]; then
  case "$PFAD" in
    *.py|*.ts|*.tsx|*.js|*.svelte|*.rs|*.go|*.java|*.c|*.h|*.cpp) : ;;
    *) durchlassen ;;
  esac
fi

python3 <<'PY'
import json
grund = (
    "Graphify-Gate: In dieser Sitzung wurde der Wissensgraph noch nicht befragt.\n"
    "\n"
    "Fuehre ZUERST eine der folgenden Abfragen aus — sie liefert einen gezielten\n"
    "Teilgraphen und ist bei breiten Fragen schneller und vollstaendiger als eine\n"
    "Roh-Suche:\n"
    "\n"
    "    graphify query \"<deine Frage>\"\n"
    "    graphify explain \"<Begriff>\"\n"
    "    graphify path \"<A>\" \"<B>\"\n"
    "\n"
    "Danach ist die Roh-Suche fuer den Rest der Sitzung frei — fuer gezielte\n"
    "Einzelstellen ist sie weiterhin das richtige Werkzeug."
)
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": grund,
    }
}))
PY
exit 0
