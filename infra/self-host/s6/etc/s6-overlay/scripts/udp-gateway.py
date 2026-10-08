"""UDP-Gateway im Heimserver-Container — TCP⇄UDP-Brücke für Host-Relays.

Betriebssystem-Plumbing für App-Hosts in einer podman-machine-VM (Win-WSL2 /
mac-gvproxy): eingehendes UDP an den Host-Port erreicht den Container dort
grundsätzlich nicht (WSL2 leitet published UDP nicht; gvproxy/mac leitet es
nicht zuverlässig). Die Server-App schließt die Lücke mit einem UDP-Relay auf
dem Host — und dieses Relay braucht einen zuverlässigen Weg, die Pakete in die
VM zu bringen. Auf Win (host-networking) ist das die VM-IP per UDP; auf macOS
bleibt nur TCP (gvproxy published TCP zuverlässig) — für genau den Weg ist
dieser Gateway-Service da.

Protokoll (pro TCP-Verbindung):
  - Die ERSTEN 2 Bytes = Ziel-UDP-Port (big-endian), an den im Container
    (127.0.0.1) zugestellt wird.
  - Danach Frames beidseitig: [2 Byte Länge big-endian][Payload].
  - Eine Verbindung = ein UDP-Gegenstellen-Flow (das Host-Relay hält pro
    Client-Adresse eine Verbindung, damit die Antworten zurücksinnen).
Der Port (UDP_GATEWAY_PORT = 55981) ist im Container nicht nach außen
publiziert; die Server-App erreicht ihn über ihren 127.0.0.1-Publish.

**Warum 0.0.0.0 und nicht 127.0.0.1** (Security-Scan 2026-10-08 geprüft):
Ein Publish (`-p 127.0.0.1:55981:55981/tcp`) schränkt nur die HOST-Seite ein.
Im Container kommt die weitergeleitete Verbindung über dessen Netzschnittstelle
an, nicht über sein Loopback — ein Bind auf 127.0.0.1 nähme sie nicht an. Die
Erreichbarkeit hängt deshalb am Publish, nicht an diesem Bind. Wo der Container
mit `--network host` läuft (Windows-podman-machine), lauscht der Dienst auf
allen Adressen der VM; wer ihn dort nicht braucht, schaltet ihn ab:
`PULSE_UDP_GATEWAY_DISABLED=true` (s6-rc.d/udp-gateway/run).

**Grenze gleichzeitiger Flows** (`MAX_FLOWS`): je Verbindung zwei Threads,
vorher unbegrenzt — eine Verbindungsflut legte den Prozess über die
Thread-Zahl lahm. Die Gegenseite (`desktop/electron/localBackend/udpGateway.ts`
mit `relayGrenzen.ts`) hält höchstens 256 Peers je Listener bei 14
Medien-Ports, also bis zu 3 584 legitime Flows; 4 096 liegt darüber, damit die
Grenze nur eine Flut trifft. Über der Grenze wird die neue Verbindung sofort
geschlossen — die Gegenseite verwirft dann diesen einen Peer und baut beim
nächsten Paket neu auf.
"""
import socket
import struct
import threading

LISTEN = ("0.0.0.0", 55981)
MAX_FLOWS = 4096


def recvn(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("tcp geschlossen")
        buf += chunk
    return buf


def handle(conn, plaetze):
    udp = None
    try:
        port = struct.unpack(">H", recvn(conn, 2))[0]
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.bind(("127.0.0.1", 0))
        # BEWUSST kein settimeout: es wirkt socket-global und würde nach der
        # Frist auch den Empfangs-Thread töten (Bug 2026-10-03: nach 180 s
        # Stille kamen keine Gateway-Antworten mehr an). Blockierend lesen;
        # das finally-close unten befreit den Thread beim Verbindungs-Ende.
        server_addr = ("127.0.0.1", port)
        print(f"[udp-gateway] flow offen -> udp 127.0.0.1:{port}", flush=True)

        def udp_to_tcp():
            try:
                while True:
                    data, _ = udp.recvfrom(65535)
                    conn.sendall(struct.pack(">H", len(data)) + data)
            except Exception:
                pass

        threading.Thread(target=udp_to_tcp, daemon=True).start()
        while True:
            (ln,) = struct.unpack(">H", recvn(conn, 2))
            udp.sendto(recvn(conn, ln), server_addr)
    except Exception:
        pass
    finally:
        print("[udp-gateway] flow zu", flush=True)
        try:
            udp.close()  # befreit einen blockierenden recvfrom im Empfangs-Thread
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
        plaetze.release()


def serve(srv, max_flows=MAX_FLOWS):
    """Nimmt Verbindungen an, höchstens `max_flows` gleichzeitig."""
    plaetze = threading.BoundedSemaphore(max_flows)
    voll_gemeldet = False
    while True:
        conn, _ = srv.accept()
        if not plaetze.acquire(blocking=False):
            if not voll_gemeldet:
                print(f"[udp-gateway] {max_flows} Flows offen — weitere abgewiesen", flush=True)
                voll_gemeldet = True
            conn.close()
            continue
        voll_gemeldet = False
        try:
            threading.Thread(target=handle, args=(conn, plaetze), daemon=True).start()
        except RuntimeError:
            # Kein Thread mehr zu haben (Systemgrenze) — diese eine Verbindung
            # aufgeben statt den ganzen Dienst sterben zu lassen.
            plaetze.release()
            conn.close()


def main():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(128)
    print("[udp-gateway] bereit auf 55981/tcp", flush=True)
    serve(srv)


if __name__ == "__main__":
    main()
