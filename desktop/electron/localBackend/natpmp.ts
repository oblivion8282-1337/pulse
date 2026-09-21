// NAT-PMP (RFC 6886) — reine Byte-Encode/Decode, keine I/O.
// PCP (RFC 6887) reuses the NAT-PMP port (RFC 6887 §3), so no separate const.
export const NATPMP_PORT = 5351;

export function ipv4MappedV6(ip: string): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16BE(0xffff, 10);
  const o = ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) b.writeUInt8(o[i] ?? 0, 12 + i);
  return b;
}

export function encodePcpMapRequest(input: {
  clientIp: string; proto: 'udp' | 'tcp'; internalPort: number; externalPort: number;
  lifetime: number; nonce: Buffer;
}): Buffer {
  const b = Buffer.alloc(60);
  b.writeUInt8(2, 0);                 // version
  b.writeUInt8(1, 1);                 // R=0, opcode=1 (MAP)
  b.writeUInt16BE(0, 2);              // reserved
  b.writeUInt32BE(input.lifetime, 4);
  ipv4MappedV6(input.clientIp).copy(b, 8);       // client IP (16)
  input.nonce.copy(b, 24, 0, 12);                // mapping nonce
  b.writeUInt8(input.proto === 'udp' ? 17 : 6, 36); // protocol
  // reserved(3) @37..39
  b.writeUInt16BE(input.internalPort, 40);
  b.writeUInt16BE(input.externalPort, 42);
  ipv4MappedV6('0.0.0.0').copy(b, 44);           // suggested external IP (16)
  return b;
}

export function parsePcpMapResponse(
  buf: Buffer,
): { resultCode: number; lifetime: number; externalPort: number; externalIp: string } | null {
  if (buf.length < 60 || buf.readUInt8(0) !== 2) return null;
  const resultCode = buf.readUInt8(3);
  const lifetime = buf.readUInt32BE(4);
  // Bughunt Runde 44: hier stand 30 — das liegt im MAPPING NONCE (24..35,
  // Zufallsbytes, die der Router unverändert zurückschickt). RFC 6887 §7.2:
  // Antwort-Header 24 Oktette, dann Nonce 24..35, protocol 36, reserved
  // 37..39, internal port 40..41, ASSIGNED EXTERNAL PORT 42..43, external
  // IP 44..59. Der Vergleich externalPort === port traf deshalb praktisch
  // nie zu — jede echte PCP-Verkabelung lief auf "partial"/"needs-your-
  // help", obwohl der Router die Mappings angelegt hatte (die eigenen
  // Test-Fixtures bauten dieselbe falsche Lay-out und hielten grün).
  const externalPort = buf.readUInt16BE(42);
  // Die 128-Bit-Adresse @44..59 ist RFC-konform IPv4-mapped (::ffff:a.b.c.d
  // → a.b.c.d @56..59). Zweitbug derselben Stelle: vorher wurde 44..47
  // gelesen — die vier NULL-Bytes des Mapped-Präfix, d. h. die WAN-IP war
  // immer 0.0.0.0. Lenient-Fallback 44..47 für Router, die rohes IPv4
  // schicken.
  const externalIp =
    buf.readUInt16BE(54) === 0xffff
      ? `${buf.readUInt8(56)}.${buf.readUInt8(57)}.${buf.readUInt8(58)}.${buf.readUInt8(59)}`
      : `${buf.readUInt8(44)}.${buf.readUInt8(45)}.${buf.readUInt8(46)}.${buf.readUInt8(47)}`;
  return { resultCode, lifetime, externalPort, externalIp };
}

export function encodeExternalAddressRequest(): Buffer {
  return Buffer.from([0x00, 0x00]); // version 0, opcode 0
}

export function parseExternalAddressResponse(
  buf: Buffer,
): { resultCode: number; externalIp: string } | null {
  if (buf.length < 12 || buf.readUInt8(0) !== 0 || buf.readUInt8(1) !== 128) return null;
  const resultCode = buf.readUInt16BE(2);
  const externalIp = `${buf.readUInt8(8)}.${buf.readUInt8(9)}.${buf.readUInt8(10)}.${buf.readUInt8(11)}`;
  return { resultCode, externalIp };
}

export function encodeMapRequest(
  proto: 'udp' | 'tcp', internalPort: number, externalPort: number, lifetime: number,
): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt8(0, 0);                       // version
  b.writeUInt8(proto === 'udp' ? 1 : 2, 1); // opcode
  b.writeUInt16BE(0, 2);                    // reserved
  b.writeUInt16BE(internalPort, 4);
  b.writeUInt16BE(externalPort, 6);
  b.writeUInt32BE(lifetime, 8);
  return b;
}

export function parseMapResponse(
  buf: Buffer,
): { resultCode: number; internalPort: number; externalPort: number; lifetime: number } | null {
  if (buf.length < 16 || buf.readUInt8(0) !== 0 || buf.readUInt8(1) < 128) return null;
  return {
    resultCode: buf.readUInt16BE(2),
    internalPort: buf.readUInt16BE(8),
    externalPort: buf.readUInt16BE(10),
    lifetime: buf.readUInt32BE(12),
  };
}
