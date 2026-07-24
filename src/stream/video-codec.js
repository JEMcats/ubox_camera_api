function findStartCodeLength(buffer, offset) {
  if (offset + 3 >= buffer.length) return 0;
  if (buffer[offset] === 0 && buffer[offset + 1] === 0 && buffer[offset + 2] === 1) return 3;
  if (offset + 4 < buffer.length
    && buffer[offset] === 0
    && buffer[offset + 1] === 0
    && buffer[offset + 2] === 0
    && buffer[offset + 3] === 1) return 4;
  return 0;
}

function scanAnnexBNals(buffer) {
  const nals = [];
  if (!buffer || !buffer.length) return nals;

  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  for (let i = 0; i < bytes.length - 3; i += 1) {
    const startCodeLength = findStartCodeLength(bytes, i);
    if (!startCodeLength) continue;
    const header = bytes[i + startCodeLength];
    if (header === undefined) continue;
    nals.push({
      offset: i,
      header,
      h264Type: header & 0x1f,
      hevcType: (header >> 1) & 0x3f,
    });
    i += startCodeLength - 1;
  }
  return nals;
}

function detectStreamFormat(annexB) {
  const nals = scanAnnexBNals(annexB);
  if (!nals.length) return null;

  if (nals.some((nal) => nal.h264Type === 7 || nal.h264Type === 8 || nal.h264Type === 5)) {
    return "h264";
  }

  if (nals.some((nal) => [32, 33, 34, 19, 20, 21].includes(nal.hevcType))) {
    return "hevc";
  }

  const first = nals[0];
  if (first.h264Type === 0 && first.hevcType === 32) return "hevc";
  return "h264";
}

function isAnnexBKeyframe(annexB, format = null) {
  const streamFormat = format || detectStreamFormat(annexB);
  const nals = scanAnnexBNals(annexB);
  if (!nals.length) return false;

  if (streamFormat === "hevc") {
    return nals.some((nal) => nal.hevcType >= 19 && nal.hevcType <= 21);
  }

  return nals.some((nal) => nal.h264Type === 5);
}

function buildHevcCodecString(annexB) {
  const nals = scanAnnexBNals(annexB);
  const sps = nals.find((nal) => nal.hevcType === 33);
  if (!sps) return "hvc1.1.6.L93.B0";

  const bytes = Buffer.isBuffer(annexB) ? annexB : Buffer.from(annexB);
  const start = sps.offset + findStartCodeLength(bytes, sps.offset) + 2;
  if (start + 1 >= bytes.length) return "hvc1.1.6.L93.B0";

  const profileSpace = bytes[start] >> 6;
  const tierFlag = (bytes[start] >> 5) & 1;
  const profileIdc = bytes[start] & 0x1f;
  const level = bytes[start + 11] || 0x5d;
  const profile = `${profileSpace}.${profileIdc}`;
  const tier = tierFlag ? "H" : "L";
  const levelString = level.toString(16).toUpperCase().padStart(2, "0");
  return `hvc1.${profile}.${tier}${levelString}.B0`;
}

function buildH264CodecString(annexB) {
  const nals = scanAnnexBNals(annexB);
  const sps = nals.find((nal) => nal.h264Type === 7);
  if (!sps) return "avc1.640016";

  const bytes = Buffer.isBuffer(annexB) ? annexB : Buffer.from(annexB);
  const start = sps.offset + findStartCodeLength(bytes, sps.offset);
  if (start + 3 >= bytes.length) return "avc1.640016";

  const data = bytes.subarray(start + 1, start + 4);
  return `avc1.${[data[0], data[1], data[2]].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function buildWebCodecsCodecString(annexB, format = null) {
  const streamFormat = format || detectStreamFormat(annexB);
  if (streamFormat === "hevc") return buildHevcCodecString(annexB);
  return buildH264CodecString(annexB);
}

function summarizeAnnexB(annexB) {
  const nals = scanAnnexBNals(annexB);
  const format = detectStreamFormat(annexB);
  return {
    format,
    h264Types: nals.map((nal) => nal.h264Type),
    hevcTypes: nals.map((nal) => nal.hevcType),
    isKeyframe: isAnnexBKeyframe(annexB, format),
    codec: format ? buildWebCodecsCodecString(annexB, format) : null,
  };
}

module.exports = {
  scanAnnexBNals,
  detectStreamFormat,
  isAnnexBKeyframe,
  buildWebCodecsCodecString,
  summarizeAnnexB,
};
