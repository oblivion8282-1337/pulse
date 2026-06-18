// NAT-PMP (RFC 6886) — reine Byte-Encode/Decode, keine I/O.
export const NATPMP_PORT = 5351;

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
