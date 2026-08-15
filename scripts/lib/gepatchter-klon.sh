# Gemeinsamer Helfer: einen fremden Quellbaum auf einen festen Stand holen und
# unsere Patches darauf anwenden — wiederholbar.
#
# Zum Sourcen gedacht, nicht zum Ausfuehren:
#
#     . "$repo_root/scripts/lib/gepatchter-klon.sh"
#     gepatchter_klon <repo-url> <ref> <zielverzeichnis> <patch-verzeichnis> [pruef-commit]
#
# Benutzt von `streaming/pulse-player/scripts/bootstrap-webrtc.sh` (webrtc-rs)
# und `streaming/ffmpeg-patches/bootstrap-ffmpeg.sh` (FFmpeg). Beide hatten das
# vorher eigenstaendig ausgeschrieben; die zwei Erkenntnisse unten waren damit
# doppelt gepflegt und drohten auseinanderzulaufen.

# Holt `$ref` aus `$repo` nach `$ziel` und wendet alle `*.patch` aus
# `$patch_dir` in alphabetischer Reihenfolge an. Mehrfach aufrufbar: ein
# zweiter Lauf setzt erst zurueck und patcht dann frisch.
#
# `$pruef_commit` (optional): Wenn gesetzt, muss HEAD danach genau darauf
# stehen, sonst Abbruch — und der Rueckfall beim zweiten Lauf laeuft darueber
# statt ueber `$ref`. Das ist noetig, sobald `$ref` ein annotierter Tag ist:
# ein flacher Klon kann den nicht peelen ("refs/tags/… ist kein Commit"), und
# `reset --hard <tag>` scheitert dann beim zweiten Lauf.
gepatchter_klon() {
    local repo="$1" ref="$2" ziel="$3" patch_dir="$4" pruef_commit="${5:-}"

    # ALLE Patches, nicht ein hartcodierter. Frueher stand in
    # `bootstrap-webrtc.sh` genau einer — der zweite (NACK-Sperrfrist) haette
    # damit auf jeder anderen Maschine und in der CI stillschweigend gefehlt,
    # und der Player haette dort ein anderes Verhalten gezeigt als gemessen.
    #
    # Absolut aufloesen, BEVOR irgendetwas mit `git -C "$ziel"` laeuft: `-C`
    # wechselt das Verzeichnis, ein relativer Patch-Pfad wuerde danach unter
    # `$ziel` gesucht und nicht gefunden. Weil `apply --check` sein stderr
    # verwirft, saehe der Aufrufer statt "Datei fehlt" die voellig falsche
    # Meldung "Patch passt nicht" — genau so beim ersten Test passiert.
    patch_dir="$(cd "$patch_dir" && pwd)" || return 1

    local patch_dateien=()
    local p
    shopt -s nullglob
    patch_dateien=("$patch_dir"/*.patch)
    shopt -u nullglob
    if [ ${#patch_dateien[@]} -eq 0 ]; then
        echo "Keine Patches in $patch_dir" >&2
        return 1
    fi

    if [ -d "$ziel/.git" ]; then
        # Schon da: auf den Ausgangsstand zurueck, damit ein zweiter Lauf nicht
        # denselben Patch ein zweites Mal anzuwenden versucht.
        #
        # `checkout` allein GENUEGT NICHT — es laesst Aenderungen an getrackten
        # Dateien stehen, und genau die sind hier ja die Patches. Der Rueckfall
        # wirkte deshalb nie; mit einem einzigen Patch fiel es nur nicht auf,
        # weil `apply --check` danach am schon gepatchten Baum scheiterte und
        # das Skript mit "wurde die Abhaengigkeit angehoben?" abbrach — einer
        # Meldung, die in die voellig falsche Richtung zeigt.
        git -C "$ziel" reset -q --hard "${pruef_commit:-$ref}"
        git -C "$ziel" clean -qfd
    else
        mkdir -p "$(dirname "$ziel")"
        # --depth 1 auf den Ref: die Historie brauchen wir nicht, der Klon ist
        # sonst erheblich groesser.
        git clone -q --depth 1 --branch "$ref" "$repo" "$ziel"
    fi

    if [ -n "$pruef_commit" ] && [ "$(git -C "$ziel" rev-parse HEAD)" != "$pruef_commit" ]; then
        echo "$ziel steht auf $(git -C "$ziel" rev-parse HEAD), erwartet war $pruef_commit" >&2
        return 1
    fi

    for p in "${patch_dateien[@]}"; do
        git -C "$ziel" apply --check "$p" 2>/dev/null || {
            echo "Patch passt nicht auf $ref: $(basename "$p")" >&2
            echo "Wurde die Abhaengigkeit angehoben? Dann den Patch nachziehen." >&2
            return 1
        }
        git -C "$ziel" apply "$p"
        echo "  angewandt: $(basename "$p")"
    done

    # Zeitstempel einfrieren — derselbe Grund wie in
    # `win-hq-sidecar/scripts/bootstrap-windows-capture.sh`: cargo entscheidet
    # fuer Pfad-Abhaengigkeiten an der mtime. Ein frischer Klon (oder ein
    # `reset --hard` mit Patch obendrauf) sieht sonst bei jedem CI-Lauf
    # geaendert aus, und der gepatchte Zweig wird jedes Mal neu uebersetzt —
    # beim webrtc-Kern sind das 27k Zeilen plus alles, was dagegen linkt.
    # `.git` bleibt ausgespart: dort haengt kein Uebersetzer dran, und Git
    # verwirrt es unnoetig.
    find "$ziel" -path "$ziel/.git" -prune -o -exec touch -h -d '2020-01-01T00:00:00Z' {} + 2>/dev/null || true
}
