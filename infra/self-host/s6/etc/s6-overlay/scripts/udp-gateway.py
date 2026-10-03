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
"""
import socket
import struct
import threading

LISTEN = ("0.0.0.0", 55981)


def recvn(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("tcp geschlossen")
        buf += chunk
    return buf


def handle(conn):
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


def main():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(128)
    print("[udp-gateway] bereit auf 55981/tcp", flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


main()
