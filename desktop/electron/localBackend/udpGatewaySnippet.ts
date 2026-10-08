/**
 * Inline-Python des UDP-Gateways für Altimages (aus containerBackendManager.ts
 * herausgezogen, Größen-Policy). Muss zum s6-Service
 * infra/self-host/s6/etc/s6-overlay/scripts/udp-gateway.py passen.
 */

/** Fallback für Images OHNE udp-gateway-s6-Service (Stand < 0.1.93): das
 *  App-Start-Skript pusht das Gateway per exec -d in den laufenden Container.
 *  Komplett inline, damit kein Datei-Mount nötig ist. */
export const UDP_GATEWAY_SNIPPET = `
import socket, struct, threading
LISTEN = ("0.0.0.0", 55981)
def recvn(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError
        buf += chunk
    return buf
def handle(conn):
    udp = None
    try:
        port = struct.unpack(">H", recvn(conn, 2))[0]
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.bind(("127.0.0.1", 0))
        udp.settimeout(180)
        server_addr = ("127.0.0.1", port)
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
`;
