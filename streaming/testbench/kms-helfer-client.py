"""Verbindet sich mit dem Pulse-KMS-Helfer und fragt ein Bild an — als wer auch
immer dieses Programm ausfuehrt.

Absichtlich ein EIGENSTAENDIGER Client und nicht unsere Gegenstelle aus dem
Sidecar: eine Probe, die dieselbe Bibliothek benutzt wie das Geprueft, kann
einen Fehler im Format auf dem Draht nicht sehen. Und er laesst sich unter einem
fremden Benutzer starten, was mit dem Sidecar nicht ginge.

Aufruf:  python3 kms-helfer-client.py <socket> [Ausgang]
Benutzt von `kms-helfer-schranken.sh`; Messakte
`profiles/hdr-2026-08-08-kms-helfer-linux.json`.
"""
import os
import socket
import struct
import sys

PFAD = sys.argv[1]
FASSUNG = 1
OP_BILD = 1
AUSGANG = sys.argv[2].encode() if len(sys.argv) > 2 else b"DP-1"

anfrage = struct.pack("<4sIII", b"PKHA", FASSUNG, OP_BILD, 0) + AUSGANG.ljust(32, b"\0")
s = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
print(f"uid={os.geteuid()} verbinde …", flush=True)
try:
    s.connect(PFAD)
except OSError as e:
    print(f"ERGEBNIS connect-abgewiesen: {e}")
    sys.exit(0)
print("verbunden", flush=True)
s.settimeout(5)
try:
    s.send(anfrage)
    daten, fds, _, _ = socket.recv_fds(s, 256, 4)
except OSError as e:
    print(f"ERGEBNIS kein-bild: {type(e).__name__} {e}")
    sys.exit(0)
if not daten:
    print("ERGEBNIS kein-bild: Gegenseite hat aufgelegt")
    sys.exit(0)
kennung, fassung, ergebnis = struct.unpack("<4sIi", daten[:12])
breite, hoehe = struct.unpack("<II", daten[12:20])
print(f"ERGEBNIS bild: {kennung} fassung={fassung} ergebnis={ergebnis} "
      f"{breite}x{hoehe} deskriptoren={len(fds)}")
