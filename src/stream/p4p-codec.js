const KEY = Buffer.from("I believe 1 ^ill win the battle!", "ascii");
const SWAP_8 = [7, 4, 3, 2, 1, 6, 5, 0];
const SWAP_16 = [11, 9, 8, 15, 13, 10, 12, 14, 2, 1, 5, 0, 6, 4, 7, 3];

function rotl32(value, bits) {
  bits &= 31;
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function rotr32(value, bits) {
  bits &= 31;
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function readU32LE(buf, offset) {
  return buf.readUInt32LE(offset);
}

function writeU32LE(buf, offset, value) {
  buf.writeUInt32LE(value >>> 0, offset);
}

function swapOrder(length) {
  if (length === 2) return [1, 0];
  if (length === 4) return [2, 3, 0, 1];
  if (length === 8) return SWAP_8;
  if (length === 16) return SWAP_16;
  return Array.from({ length }, (_, index) => index);
}

function swapBytes(input) {
  const order = swapOrder(input.length);
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < order.length; i += 1) out[i] = input[order[i]];
  return out;
}

function inverseSwapBytes(input) {
  const order = swapOrder(input.length);
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < order.length; i += 1) out[order[i]] = input[i];
  return out;
}

function xorKey(input) {
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i += 1) out[i] = input[i] ^ KEY[i];
  return out;
}

function decodeP4P(encoded) {
  const out = Buffer.alloc(encoded.length);
  let offset = 0;
  for (; encoded.length - offset > 15; offset += 16) {
    const shifted = Buffer.alloc(16);
    for (let word = 0; word < 4; word += 1) {
      const inOff = offset + word * 4;
      const bits = word * 4 + 3;
      writeU32LE(shifted, word * 4, rotl32(readU32LE(encoded, inOff), bits));
    }
    const xored = xorKey(swapBytes(shifted));
    for (let word = 0; word < 4; word += 1) {
      const bits = word * 4 + 1;
      writeU32LE(out, offset + word * 4, rotl32(readU32LE(xored, word * 4), bits));
    }
  }

  const remaining = encoded.length - offset;
  if (remaining > 0) {
    xorKey(swapBytes(encoded.subarray(offset))).copy(out, offset);
  }
  return out;
}

function encodeP4P(clear) {
  const out = Buffer.alloc(clear.length);
  let offset = 0;
  for (; clear.length - offset > 15; offset += 16) {
    const unshifted = Buffer.alloc(16);
    for (let word = 0; word < 4; word += 1) {
      const bits = word * 4 + 1;
      writeU32LE(unshifted, word * 4, rotr32(readU32LE(clear, offset + word * 4), bits));
    }
    const shifted = inverseSwapBytes(xorKey(unshifted));
    for (let word = 0; word < 4; word += 1) {
      const bits = word * 4 + 3;
      writeU32LE(out, offset + word * 4, rotr32(readU32LE(shifted, word * 4), bits));
    }
  }

  const remaining = clear.length - offset;
  if (remaining > 0) {
    inverseSwapBytes(xorKey(clear.subarray(offset))).copy(out, offset);
  }
  return out;
}

function parseHeader(buf) {
  if (buf.length < 16) return null;
  return {
    magic: buf.readUInt16LE(0),
    version: buf.readUInt16LE(2),
    length: buf.readUInt16LE(4),
    sidOrChannel: buf.readUInt16LE(6),
    msg: buf.readUInt16LE(8),
    msgLen: buf.readUInt16LE(10),
    seqOrParam: buf.readUInt16LE(12),
    kind: buf[14],
    flag: buf[15],
  };
}

function isP4PHeader(header) {
  return header?.magic === 0x1807 && header?.version === 0x10;
}

function decodeDatagram(raw) {
  const clearHeader = parseHeader(raw);
  if (isP4PHeader(clearHeader)) {
    return { clear: raw, header: clearHeader, encrypted: false };
  }
  const decoded = decodeP4P(raw);
  const decodedHeader = parseHeader(decoded);
  if (isP4PHeader(decodedHeader)) {
    return { clear: decoded, header: decodedHeader, encrypted: true };
  }
  return { clear: null, header: null, encrypted: null };
}

function buildPacket({ msg, payload = Buffer.alloc(0), sidOrChannel = 0, msgLen = null, seqOrParam = 0, kind = 0, flag = 0 }) {
  const packet = Buffer.alloc(16 + payload.length);
  packet.writeUInt16LE(0x1807, 0);
  packet.writeUInt16LE(0x10, 2);
  packet.writeUInt16LE(payload.length, 4);
  packet.writeUInt16LE(sidOrChannel, 6);
  packet.writeUInt16LE(msg, 8);
  packet.writeUInt16LE(msgLen ?? Math.max(payload.length - 4, 0), 10);
  packet.writeUInt16LE(seqOrParam, 12);
  packet[14] = kind;
  packet[15] = flag;
  payload.copy(packet, 16);
  return packet;
}

function describeMsg(msg) {
  return {
    0x1051: "query-req",
    0x1052: "query-rsp",
    0x1053: "syncdb-req",
    0x1054: "syncdb-rsp",
    0x1201: "relay-wakeup-req",
    0x1202: "relay-wakeup-rsp",
    0x1203: "relay-login-req",
    0x1204: "relay-login-rsp",
    0x1205: "relay-stream-req",
    0x1206: "relay-stream-rsp",
    0x1207: "relay-logout-req",
    0x1208: "relay-logout-rsp",
    0x1209: "relay-close-req",
    0x120d: "relay-hello-req",
    0x120e: "relay-rtd-update",
    0x1301: "lan-wakeup-req",
    0x1302: "lan-wakeup-rsp",
    0x1303: "lan-search-req",
    0x1304: "lan-search-rsp",
    0x1305: "lan-login-req",
    0x1306: "lan-login-rsp",
    0x1307: "lan-stream-req",
    0x1308: "lan-stream-rsp",
    0x1309: "lan-logout-req",
    0x130a: "lan-logout-rsp",
    0x130b: "knock-req",
    0x130c: "knock-rsp",
    0x130d: "knock-ack",
    0x130e: "knock-peer",
    0x1401: "ioctrl-req",
    0x1402: "ioctrl-rsp",
    0x1403: "rdt-video-ack",
    0x1404: "rdt-video",
    0x1405: "alive-req",
    0x1406: "alive-rsp",
    0x1407: "avctrl-req",
    0x1408: "avctrl-rsp",
    0x1409: "kcp-client",
    0x140a: "kcp-device",
  }[msg] || `0x${msg.toString(16).padStart(4, "0")}`;
}

module.exports = {
  decodeDatagram,
  decodeP4P,
  describeMsg,
  encodeP4P,
  isP4PHeader,
  parseHeader,
  buildPacket,
};
