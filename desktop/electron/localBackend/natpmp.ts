// NAT-PMP (RFC 6886) — reine Byte-Encode/Decode, keine I/O.
export const NATPMP_PORT = 5351;

// PCP (RFC 6887) — reine Byte-Encode/Decode, keine I/O.
export const PCP_PORT = 5351;

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
  const externalPort = buf.readUInt16BE(30);
  const externalIp = `${buf.readUInt8(44)}.${buf.readUInt8(45)}.${buf.readUInt8(46)}.${buf.readUInt8(47)}`;
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
