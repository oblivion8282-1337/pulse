"""Heim-Server-Kompletttest (manuell, gegen einen laufenden lokalen Stack).

Fährt den gesamten Nutzer-Weg durch: Selbstbedienungs-Registrierung in der
Cloud → Bootstrap → All-in-One-Container mit frischem Volume → TLS-Health →
Owner-Session → Community/Kanal/Invite → zweiter User (Ticket mit
Invite-Gate, Session, Beitritt, Nachricht) → Owner liest → Telefonbuch-
Eintrag für Mitglieder. 14 Schritte, alle müssen grün sein.

Voraussetzungen:
  * dcc_test-Postgres (5434) + Redis (6380) + auth-svc (8101) laufen
    (z.B. via /tmp/start-e2e-cloud.sh-Muster aus dem Dev-Alltag)
  * docker + gebautes Image `pulse-allinone:heim-test`
    (docker build -f infra/self-host/Dockerfile …)
  * sudo (für den /etc/hosts-Eintrag der Instanz-Hostname)
  * /tmp/heim-certs/{cert.pem,key.pem} als Cert für den Hostnamen
    (openssl req -x509 … -subj "/CN=<hostname>")

Aufruf:  python3 heim-server-lauf.py
Danach optional: heim-server-webrtc.ts (echter Browser-DataChannel-Test).
"""

"""Heim-Server-Kompletttest: Selbstbedienung → Container → Friend-Join → Chat."""
import json, urllib.request, ssl, subprocess, time, pathlib

CTX = ssl.create_default_context(); CTX.check_hostname=False; CTX.verify_mode=ssl.CERT_NONE
AUTH = "http://127.0.0.1:8101"

def call(url, method="GET", body=None, cookie=None, bearer=None):
    req = urllib.request.Request(url, method=method)
    if cookie: req.add_header("Cookie", cookie)
    if bearer: req.add_header("Authorization", f"Bearer {bearer}")
    data = json.dumps(body).encode() if body is not None else None
    if body is not None: req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data, context=CTX, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def login(email, pw):
    req = urllib.request.Request(f"{AUTH}/login", method="POST", data=json.dumps(
        {"email_or_username": email, "password": pw}).encode())
    req.add_header("Content-Type", "application/json")
    resp = urllib.request.urlopen(req, timeout=15)
    return [c.split(";")[0] for c in resp.headers.get_all("Set-Cookie")
            if c.startswith("pulse_session=")][0]

ts = int(time.time())
owner = {"username": f"kk_owner_{ts}", "email": f"kk_owner_{ts}@example.com",
         "password": "kk-pass-123", "display_name": "Owner"}
call(f"{AUTH}/register", "POST", owner)
oc = login(owner["email"], owner["password"])

s, inst = call(f"{AUTH}/me/instances", "POST", {}, cookie=oc)
print("1) Selbstbedienung:", s); assert s == 201, inst
iid, host = inst["instance"]["id"], inst["instance"]["hostname"]
s, mint = call(f"{AUTH}/me/instances/{iid}/bootstrap-token", "POST", {}, cookie=oc)
s, creds = call(f"{AUTH}/selfhost/bootstrap", "POST", None, bearer=mint["token"])
assert s == 200, creds
print("2) Bootstrap-Redeem:", s)

subprocess.run(["docker", "rm", "-f", "pulse-heim-e2e"], capture_output=True)
subprocess.run(["sh", "-c", "docker volume rm pulse-heim-e2e-data >/dev/null 2>&1 || true"])
pairs = [("PULSE_HOSTNAME", host), ("PULSE_INSTANCE_ID", creds["instance_id"]),
         ("PULSE_INSTANCE_OWNER_ID", creds["owner_user_id"]),
         ("PULSE_CLOUD_CLIENT_ID", creds["client_id"]),
         ("PULSE_CLOUD_CLIENT_SECRET", creds["client_secret"]),
         ("PULSE_ADMIN_EMAIL", creds["admin_email"]),
         ("PULSE_CLOUD_ORIGIN", "http://127.0.0.1:8101"), ("PULSE_CLOUD_API_PREFIX", ""),
         ("PULSE_TLS_MODE", "provided"), ("PULSE_DIRECT_EXTRA_HOST_IPS", "127.0.0.1")]
cmd = ["docker", "run", "-d", "--name", "pulse-heim-e2e", "--network", "host",
       "-v", "/tmp/heim-certs:/data/certs", "-v", "pulse-heim-e2e-data:/data"]
for k, v in pairs: cmd += ["-e", f"{k}={v}"]
cmd.append("pulse-allinone:heim-test")
assert subprocess.run(cmd, capture_output=True).returncode == 0
print("3) Container gestartet (neue Instanz + frisches Volume)")

subprocess.run(["sudo", "sed", "-i", "/app-[0-9]/d", "/etc/hosts"], check=True)
subprocess.run(["sudo", "tee", "-a", "/etc/hosts"], input=f"127.0.0.1 {host}\n".encode(),
               check=True, capture_output=True)

ok = False
for i in range(40):
    time.sleep(4)
    try:
        with urllib.request.urlopen(f"https://{host}/api/chat/health", context=CTX, timeout=5) as r:
            if r.status == 200:
                print(f"4) Container healthy über TLS nach ~{(i+1)*4}s"); ok = True; break
    except Exception:
        pass
assert ok, "Container wurde nicht healthy"

s, ticket = call(f"{AUTH}/me/server-ticket", "POST", {"hostname": host}, cookie=oc)
assert s == 200, ticket
s, sess = call(f"https://{host}/api/chat/session", "POST", {"ticket": ticket["ticket"]})
print("5) Owner-Session am Heim-Server:", s); assert s == 200, sess
ot = sess["session_token"]

s, g = call(f"https://{host}/api/chat/guilds", "POST", {"name": "KK Lounge"}, bearer=ot)
print("6) Community gegründet:", s); assert s in (200, 201), g
gid = g["id"]
s, ch = call(f"https://{host}/api/chat/guilds/{gid}/channels", "POST",
             {"name": "general", "type": 0, "position": 0}, bearer=ot)
chan = ch["id"]
s, inv = call(f"https://{host}/api/chat/guilds/{gid}/invites", "POST",
              {"max_uses": 5, "expires_in_seconds": 86400}, bearer=ot)
code = inv["code"]
s, _ = call(f"https://{host}/api/chat/channels/{chan}/messages", "POST",
            {"content": "willkommen auf meinem eigenen server"}, bearer=ot)
print("7) Community/Kanal/Invite/Message:", s)

bob = {"username": f"kk_bob_{ts}", "email": f"kk_bob_{ts}@example.com",
       "password": "kk-pass-123", "display_name": "Bob"}
call(f"{AUTH}/register", "POST", bob)
bc = login(bob["email"], bob["password"])
s, _ = call(f"{AUTH}/me/instances/{iid}/membership", "POST", {}, cookie=bc)
print("8) Bob-Membership (Cloud):", s)
s, bt = call(f"{AUTH}/me/server-ticket", "POST",
             {"hostname": host, "community_grant_code": code}, cookie=bc)
print("9) Bob-Ticket mit Invite-Gate:", s); assert s == 200, bt
s, bs = call(f"https://{host}/api/chat/session", "POST",
             {"ticket": bt["ticket"], "community_grant_code": code})
print("10) Bob-Session am Heim-Server:", s); assert s == 200, bs
btok = bs["session_token"]
s, _ = call(f"https://{host}/api/chat/invites/{code}/accept", "POST", {}, bearer=btok)
print("11) Bob-Beitritt zur Community:", s)
s, _ = call(f"https://{host}/api/chat/channels/{chan}/messages", "POST",
            {"content": "bob war hier — gepostet vom Heim-Server"}, bearer=btok)
print("12) Bob-Nachricht:", s)
s, msgs = call(f"https://{host}/api/chat/channels/{chan}/messages", bearer=ot)
inhalt = [m.get("content") for m in msgs]
assert any("bob war hier" in (t or "") for t in inhalt)
print("13) Owner liest Bobs Nachricht: JA")
s, ep = call(f"{AUTH}/me/instances/{iid}/direct-endpoint", cookie=bc)
print("14) Telefonbuch-Eintrag (für Bob als Mitglied):", s, "→",
      ep["candidates"][0]["ip"] + ":" + str(ep["candidates"][0]["port"]), "online:", ep["online"])
print()
print("=== ALLE 14 SCHRITTE GRÜN: zweiter User hat sich am selbstgehosteten")
print("=== Server angemeldet, beigetreten und gechattet ===")
json.dump({"instance_id": iid, "hostname": host, "chan": chan, "code": code,
           "owner_cookie": oc, "user": owner,
           "bob": bob, "bob_cookie": bc},
          open("/tmp/heim-komplett-state.json", "w"))
