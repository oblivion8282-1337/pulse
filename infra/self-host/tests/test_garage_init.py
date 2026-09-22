"""Garage-Bootstrap: die GK-Schlüssel-Migration aus MinIO-Zeiten.

Scheitert das Parsen des ``key create``-Outputs leise (im Skript ist alles
``|| true``-tolerant), signiert chat-gateway fortan mit einem Schlüssel, den
Garage nicht kennt — jeder Upload ginge mit 403 ab. Deshalb fährt dieser Test
die Funktion mit einer Aufzeichnung des echten Garage-Outputs (Prod-Roll
2026-09-22) und prüft Persistenz + env.sh-Patch; der GK-Zweig darf nichts
anfassen, nur importieren.
"""

import pathlib
import subprocess

GARAGE_INIT = pathlib.Path(__file__).resolve().parents[1] / "garage-init.sh"

# So druckte garage v1.1.0 `key create` auf Prod (2026-09-22).
KEY_CREATE_AUSGABE = (
    "Key ID: GK876998d84418b9aebd858663\n"
    "Secret key: 0f1e2d3c4b5a697886955a4b3c2d1e0f00112233445566778899aabbccddeeff\n"
)
GK_ID = "GK876998d84418b9aebd858663"
GK_SECRET = "0f1e2d3c4b5a697886955a4b3c2d1e0f00112233445566778899aabbccddeeff"


def _funktion() -> str:
    zeilen = GARAGE_INIT.read_text(encoding="utf-8").split("\n")
    start = next(i for i, z in enumerate(zeilen) if z.startswith("s3_key_sicherstellen()"))
    ende = next(i for i, z in enumerate(zeilen) if i > start and z == "}")
    return "\n".join(zeilen[start : ende + 1])


def _lauf(tmp_path: str, s3_access_key: str) -> subprocess.CompletedProcess:
    """Fährt s3_key_sicherstellen mit gefälschtem garage-Binary.

    garage-Argumente landen in aufrufe.log (für den GK-Zweig), `key create`
    druckt die aufgezeichnete Ausgabe.
    """
    import os

    tmp = pathlib.Path(tmp_path)
    bin_ = tmp / "bin"
    bin_.mkdir(exist_ok=True)
    (bin_ / "garage").write_text(
        "#!/bin/bash\n"
        f'printf \'%s\\n\' "$*" >> "{tmp}/aufrufe.log"\n'
        'if [ "$3" = "key" ] && [ "$4" = "create" ]; then printf \'%s\' \''
        + KEY_CREATE_AUSGABE.replace("'", "'\\''")
        + "\'; fi\n",
        encoding="utf-8",
    )
    (bin_ / "garage").chmod(0o755)
    (tmp / "jwt_keys").mkdir(exist_ok=True)
    env_sh = tmp / "env.sh"
    env_sh.write_text(
        "export S3_ACCESS_KEY='pulse-alt'\nexport S3_SECRET_KEY='alt'\n", encoding="utf-8"
    )
    skript = f"""
{_funktion()}
G="{bin_ / 'garage'}"; CF="{tmp}/garage.toml"
S3_ACCESS_KEY='{s3_access_key}'; S3_SECRET_KEY='alt'
PULSE_DATA_PATH='{tmp}' PULSE_ENV_SH='{env_sh}' s3_key_sicherstellen
echo "user=$(cat '{tmp}/jwt_keys/minio.user' 2>/dev/null)"
echo "pass=$(cat '{tmp}/jwt_keys/minio.password' 2>/dev/null)"
echo "key=$S3_ACCESS_KEY"
"""
    umgebung = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}"}
    return subprocess.run(["bash", "-c", skript], capture_output=True, text=True, env=umgebung)


def _zeilen(ergebnis: subprocess.CompletedProcess) -> dict[str, str]:
    return dict(
        zeile.split("=", 1) for zeile in ergebnis.stdout.strip().split("\n") if "=" in zeile
    )


def test_legacy_schluessel_wird_durch_gk_ersetzt(tmp_path):
    ergebnis = _lauf(str(tmp_path), "pulse-ab12cd34")
    assert ergebnis.returncode == 0, ergebnis.stderr
    werte = _zeilen(ergebnis)
    assert werte["user"] == GK_ID
    assert werte["pass"] == GK_SECRET
    assert werte["key"] == GK_ID, "S3_ACCESS_KEY muss für bucket allow aktualisiert sein"
    env_sh = (tmp_path / "env.sh").read_text(encoding="utf-8")
    assert f"export S3_ACCESS_KEY='{GK_ID}'" in env_sh
    assert f"export S3_SECRET_KEY='{GK_SECRET}'" in env_sh


def test_gk_schluessel_wird_nur_importiert_nicht_ersetzt(tmp_path):
    ergebnis = _lauf(str(tmp_path), GK_ID)
    assert ergebnis.returncode == 0, ergebnis.stderr
    werte = _zeilen(ergebnis)
    assert werte["user"] == "", "GK-Zweig darf jwt_keys nicht anfassen"
    assert werte["key"] == GK_ID
    aufrufe = (tmp_path / "aufrufe.log").read_text(encoding="utf-8")
    assert "key import" in aufrufe and GK_ID in aufrufe
    assert "key create" not in aufrufe
