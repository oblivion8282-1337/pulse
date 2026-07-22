# TURN-Server (coturn) für die Fernsteuerung

Netzübergreifende Fernsteuerung braucht TURN (reine Consumer-Anschlüsse scheitern
direkt an NAT). coturn läuft eigenständig; der chat-gateway mintet die
Client-Credentials aus demselben Secret — kein Dauer-Passwort im Client.

## Deploy

1. **Secret erzeugen** (einmal): `openssl rand -hex 32`.
2. `turnserver.conf` ausfüllen: `<TURN_SECRET>`, `<PUBLIC_IP>`, `<REALM>`
   (z.B. `turn.howispulse.com`).
3. **UFW öffnen** (der Relay braucht die Range):
   ```
   sudo ufw allow 3478/tcp
   sudo ufw allow 3478/udp
   sudo ufw allow 5349/tcp        # nur bei aktiviertem TLS
   sudo ufw allow 49152:65535/udp
   ```
4. Start: `docker compose -f infra/coturn/docker-compose.yml up -d`.

## chat-gateway verdrahten

In der `.env` des chat-gateway (bzw. der Instanz):

```
TURN_URL=turn:<REALM-oder-IP>:3478
TURN_SECRET=<dasselbe Secret wie in turnserver.conf>
# optional: TURN_TTL_S=300, STUN_URL=stun:...
```

Der Client holt die Liste dann über `GET /remote/ice-servers` und bekommt STUN +
TURN mit einem Credential, das nach `TURN_TTL_S` abläuft. **Secret NUR in der
`.env`** — es steht nie im Client, nur der abgeleitete, kurzlebige HMAC.

## Test

```
# Sichtprüfung, dass coturn antwortet (turnutils aus dem coturn-Image):
docker exec -it <coturn> turnutils_uclient -v -u test -w test <PUBLIC_IP>
```

Ohne gesetztes `TURN_URL`/`TURN_SECRET` liefert der Endpoint nur STUN — für
gleiches-LAN-Tests reicht das (kein coturn nötig).
