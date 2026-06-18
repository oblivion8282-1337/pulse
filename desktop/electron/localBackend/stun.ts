// Minimaler STUN-Client (RFC 5389) für die Public-IP-Ermittlung — node:dgram,
// keine Dependency. Nur Binding-Request + XOR-MAPPED-ADDRESS-Parsing.
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';

export const STUN_MAGIC_COOKIE = 0x2112a442;

export function buildStunRequest(): { packet: Buffer; transactionId: Buffer } {
  const transactionId = randomBytes(12);
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(0x0001, 0);   // Binding Request
  packet.writeUInt16BE(0x0000, 2);   // Message Length
  packet.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(packet, 8);
  return { packet, transactionId };
}

export function parseStunResponse(packet: Buffer): string | null {
  if (packet.length < 20 || packet.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null;
  let off = 20;
  while (off + 4 <= packet.length) {
    const type = packet.readUInt16BE(off);
    const len = packet.readUInt16BE(off + 2);
    const val = off + 4;
    if (type === 0x0020 && len >= 8 && packet.readUInt8(val + 1) === 0x01) {
      // XOR-MAPPED-ADDRESS, IPv4: jedes Adress-Byte mit dem Magic-Cookie XOR-en
      const cookieBytes = [0x21, 0x12, 0xa4, 0x42];
      const octets = cookieBytes.map((c, i) => packet.readUInt8(val + 4 + i) ^ c);
      return octets.join('.');
    }
    off = val + len + ((4 - (len % 4)) % 4); // 4-Byte-Padding
  }
  return null;
}

const DEFAULT_STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
];

export async function discoverPublicIp(
  servers: Array<{ host: string; port: number }> = DEFAULT_STUN_SERVERS,
  timeoutMs = 3000,
): Promise<string | null> {
  for (const srv of servers) {
    const ip = await queryOne(srv.host, srv.port, timeoutMs);
    if (ip) return ip;
  }
  return null;
}

function queryOne(host: string, port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    const { packet } = buildStunRequest();
    let done = false;
    const finish = (ip: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      resolve(ip);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('message', (msg) => finish(parseStunResponse(msg)));
    sock.on('error', () => finish(null));
    sock.send(packet, port, host, (err) => { if (err) finish(null); });
  });
}
