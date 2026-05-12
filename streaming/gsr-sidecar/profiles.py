"""Stream- und Server-Profile als immutable Dataclasses.

Stream-Profile bestimmen Codec, Bitrate, Audio-Codec, Container,
und welches GSR-Binary genutzt wird.

Server-Profile bestimmen Push-URL-Template, ob Auth nötig ist und
auf welchem Endpunkt Empfänger zuschauen.

Vendored aus ``~/Dokumente/GPU_Screen_Recorder/ui/profiles.py`` (2026-05-11).
GSR-Binary-Resolver wandert in ``gsr_binary.py``. Neu hier:
``ServerProfile.from_channel()`` für Pulse-spezifische Channel-Pfade.
"""
from __future__ import annotations
import os
import subprocess
from dataclasses import dataclass


@dataclass(frozen=True)
class StreamProfile:
    name: str
    codec: str            # h264 | hevc | av1
    audio_codec: str      # aac | opus
    container: str        # flv | mpegts
    bitrate_kbps: int     # CBR target
    fps: int
    needs_custom_build: bool   # True falls Custom-GSR mit FLV-Patch nötig
    notes: str = ""


@dataclass(frozen=True)
class ServerProfile:
    name: str
    push_protocol: str       # rtmp | srt
    push_host: str           # ip oder dns
    push_port: int
    push_path: str = "test"  # stream-name (z.B. "channel-<id>-<uid>")
    needs_auth: bool = True
    auth_user: str = "michael"
    # If set, this exact URL is handed to GSR's `-o` verbatim — used by the
    # Pulse channel pathway, where media-svc already built the full rtmps://… /
    # srt://… URL (token included), so we don't reconstruct it here.
    push_url: str | None = None
    webrtc_url_template: str = "http://{host}:8889/{path}"
    hls_url_template: str = "http://{host}:8888/{path}"
    player_url_template: str = "http://{host}:8000/"  # Custom HTML-Player mit Stats

    @classmethod
    def from_channel(
        cls,
        channel_id: str,
        token: str,
        mediamtx_endpoint: str = "77.42.71.166",
        *,
        push_protocol: str = "rtmp",
        push_port: int | None = None,
        auth_user: str | None = None,
        name: str | None = None,
        push_url: str | None = None,
    ) -> "ServerProfile":
        """Erzeugt ein ServerProfile für einen Pulse-Channel.

        Pfad = ``channel-<channel_id>`` (statt fixem ``test``); Stream-Token
        steht im Aufrufer-Code als ``auth_user``/Token-Pärchen zur Verfügung —
        der ``token`` wird wie ein klassischer Stream-Key behandelt (RTMP-
        Query-Param ``pass=`` bzw. SRT-streamid-Tail).

        Die zurückgegebene URL-Form ist identisch zu der die der Original-
        ``StreamController._build_push_url()`` für ein gleichartiges
        ``ServerProfile`` produzieren würde — d.h. exakt die URL-Form aus den
        ``start-stream-server*.fish``-Skripten:

        - RTMP: ``rtmp://<host>:1935/channel-<id>?user=<user>&pass=<token>``
        - SRT:  ``srt://<host>:8890?streamid=publish:channel-<id>:<user>:<token>&pkt_size=1316``

        Parameters
        ----------
        channel_id:
            Pulse-Channel-Snowflake-ID (string, *nicht* int — Snowflakes > 2^53).
        token:
            Stream-Token (vergeben von ``media-svc`` in T5; hier opak).
        mediamtx_endpoint:
            Host oder ``host:port`` (ohne Schema). Default = aktueller Dev-VPS.
            Falls ``host:port`` angegeben, wird ``port`` daraus gelesen, aber
            nur wenn ``push_port`` nicht explizit gesetzt ist.
        push_protocol:
            ``"rtmp"`` (Default, Enhanced-RTMP-Pfad) oder ``"srt"``.
        push_port:
            Override für den Push-Port. Default: 1935 für RTMP, 8890 für SRT.
        auth_user:
            User-Teil der Auth. Default = ``token[:16]`` falls Token gesetzt,
            sonst ``"publisher"``. Pulse-Konvention: der User-Teil ist nicht
            geheim, die Auth-Stärke kommt vom Token. ``mediamtx-auth-hook``
            (T5) prüft ``user+pass``-Paar serverseitig.
        name:
            Anzeige-Name. Default: ``"channel-<id>"``.
        """
        # Endpoint kann "host" oder "host:port" sein
        host = mediamtx_endpoint
        endpoint_port: int | None = None
        if ":" in mediamtx_endpoint and not mediamtx_endpoint.startswith("["):
            host_part, _, port_part = mediamtx_endpoint.partition(":")
            if port_part.isdigit():
                host = host_part
                endpoint_port = int(port_part)

        if push_port is None:
            push_port = (
                endpoint_port
                if endpoint_port is not None
                else (1935 if push_protocol == "rtmp" else 8890)
            )

        if auth_user is None:
            auth_user = token[:16] if token else "publisher"

        # Path only matters when we reconstruct the URL ourselves; when media-svc
        # gave us a full `push_url`, that's authoritative (it already has the
        # `channel-<cid>-<uid>` path + token in it).
        channel_path = f"channel-{channel_id}"
        display_name = name if name is not None else channel_path

        return cls(
            name=display_name,
            push_protocol=push_protocol,
            push_host=host,
            push_port=push_port,
            push_path=channel_path,
            needs_auth=True,
            auth_user=auth_user,
            push_url=push_url,
            # Receiver-URLs zeigen — gleicher Pfad
            webrtc_url_template="http://{host}:8889/{path}",
            hls_url_template="http://{host}:8888/{path}",
            player_url_template="http://{host}:8000/",
        )


# ── Stream-Profile ──────────────────────────────────────────────────
PROFILES: list[StreamProfile] = [
    StreamProfile(
        name="AV1 Effizient",
        codec="av1",
        audio_codec="opus",
        container="flv",
        bitrate_kbps=4000,
        fps=60,
        needs_custom_build=True,
        notes="Halbe Bandbreite, gleiche Qualität. Browser muss AV1 können.",
    ),
    StreamProfile(
        name="H.264 Standard",
        codec="h264",
        audio_codec="opus",
        container="flv",
        bitrate_kbps=8000,
        fps=60,
        needs_custom_build=True,  # Opus+FLV-Patch
        notes="Universelle Browser-Kompat, Audio in WebRTC.",
    ),
    StreamProfile(
        name="H.264 Sparmodus",
        codec="h264",
        audio_codec="opus",
        container="flv",
        bitrate_kbps=4000,
        fps=60,
        needs_custom_build=True,
        notes="Halbe Bandbreite, leicht pixeliger bei Bewegung.",
    ),
    StreamProfile(
        name="Custom",
        codec="h264",
        audio_codec="opus",
        container="flv",
        bitrate_kbps=8000,
        fps=60,
        needs_custom_build=True,
        notes="Override-Sektion in der UI nutzen.",
    ),
]


def profile_by_name(name: str) -> StreamProfile:
    for p in PROFILES:
        if p.name == name:
            return p
    raise KeyError(f"Unknown stream profile: {name}")


# ── Server-Profile ──────────────────────────────────────────────────
SERVERS: list[ServerProfile] = [
    ServerProfile(
        name="Hetzner",
        push_protocol="rtmp",
        push_host="77.42.71.166",
        push_port=1935,
        needs_auth=True,
    ),
    ServerProfile(
        name="Lokal",
        push_protocol="rtmp",
        push_host="localhost",
        push_port=1935,
        needs_auth=False,
    ),
]


def server_by_name(name: str) -> ServerProfile:
    for s in SERVERS:
        if s.name == name:
            return s
    raise KeyError(f"Unknown server profile: {name}")


# ── Video-Codecs ────────────────────────────────────────────────────
# Mapping UI-Label → GSR-Argument für `-k`.
VIDEO_CODECS_ALL: dict[str, str] = {
    "H.264":            "h264",
    "HEVC":             "hevc",
    "HEVC 10-bit":      "hevc_10bit",
    "HEVC HDR":         "hevc_hdr",
    "AV1":              "av1",
    "AV1 10-bit":       "av1_10bit",
    "AV1 HDR":          "av1_hdr",
}

# Im Flatpak nur H.264 + AV1 — HEVC ist im Browser-WebRTC unzuverlässig
# (Linux-Decoder-Lottery), 10-bit hat Player-Kompat-Issues, HDR braucht
# direkten Monitor (im Sandbox unmöglich, dort ist nur Portal verfügbar).
VIDEO_CODECS_FLATPAK: dict[str, str] = {
    "H.264": "h264",
    "AV1":   "av1",
}


def is_flatpak() -> bool:
    """True wenn der Sidecar im Flatpak-Sandbox läuft."""
    return os.path.exists("/.flatpak-info") or "FLATPAK_ID" in os.environ


def get_video_codecs() -> dict[str, str]:
    """Codec-Liste je nach Umgebung."""
    return VIDEO_CODECS_FLATPAK if is_flatpak() else VIDEO_CODECS_ALL


def codec_label_for(codec_value: str) -> str:
    """Reverse lookup: 'av1_hdr' → 'AV1 HDR'."""
    codecs = get_video_codecs()
    for label, val in codecs.items():
        if val == codec_value:
            return label
    for label, val in codecs.items():
        if codec_value.startswith(val):
            return label
    return next(iter(codecs.keys()))


def is_hdr_codec(codec_value: str) -> bool:
    return codec_value.endswith("_hdr")


def is_10bit_codec(codec_value: str) -> bool:
    return codec_value.endswith("_10bit") or codec_value.endswith("_hdr")


# ── Audio-Modi (statisch) ───────────────────────────────────────────
AUDIO_MODES: dict[str, str | None] = {
    "Aus": None,
    "Desktop": "default_output",
    "Mikrofon": "default_input",
    "Desktop + Mikrofon": "default_output|default_input",
}

APP_LABEL_PREFIX = "App: "


def list_audio_applications(gsr_binary: str = "gpu-screen-recorder") -> list[str]:
    """Holt aktuell laufende Apps mit Audio-Output via GSR --list-application-audio."""
    try:
        res = subprocess.run(
            [gsr_binary, "--list-application-audio"],
            capture_output=True, text=True, timeout=5,
        )
        return [line.strip() for line in res.stdout.splitlines() if line.strip()]
    except (subprocess.SubprocessError, FileNotFoundError):
        return []


def _audio_label_to_base_arg(label: str) -> str | None:
    """Übersetzt UI-Label in den Basis-GSR-Arg (ohne Excludes)."""
    label = label.removesuffix(" (offline)").strip()
    if label in AUDIO_MODES:
        return AUDIO_MODES[label]
    if label.startswith(APP_LABEL_PREFIX):
        return f"app:{label[len(APP_LABEL_PREFIX):]}"
    return None


def build_audio_arg(audio_mode_label: str, excluded_apps: list[str]) -> str | None:
    """Baut das finale GSR -a Argument aus Hauptquelle + persistenten Excludes.

    Logik unverändert aus dem GSR-Original — siehe Doku dort.
    """
    base = _audio_label_to_base_arg(audio_mode_label)
    if base is None:
        return None  # Aus
    if not excluded_apps:
        return base

    # App-spezifische Hauptquelle: Excludes irrelevant (GSR-Limit)
    if base.startswith("app:"):
        return base

    inverse_chunk = "|".join(f"app-inverse:{a}" for a in excluded_apps)

    if base == "default_output":
        return inverse_chunk
    if base == "default_input":
        return base
    if base == "default_output|default_input":
        return f"{inverse_chunk}|default_input"
    return base
