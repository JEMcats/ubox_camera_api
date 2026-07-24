function u8(...values) {
  return Buffer.from(values);
}

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function u24(value) {
  return Buffer.from([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

function u64(value) {
  const out = Buffer.alloc(8);
  const big = BigInt(value);
  out.writeUInt32BE(Number((big >> 32n) & 0xffffffffn), 0);
  out.writeUInt32BE(Number(big & 0xffffffffn), 4);
  return out;
}

function str(value) {
  return Buffer.from(value, "ascii");
}

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(payload.length + 8), str(type), payload]);
}

function fullBox(type, version, flags, ...parts) {
  return box(type, u8(version), u24(flags), ...parts);
}

function findStartCodes(buffer) {
  const starts = [];
  for (let i = 0; i < buffer.length - 3; i += 1) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue;
    if (buffer[i + 2] === 1) {
      starts.push({ offset: i, length: 3 });
      i += 2;
    } else if (buffer[i + 2] === 0 && buffer[i + 3] === 1) {
      starts.push({ offset: i, length: 4 });
      i += 3;
    }
  }
  return starts;
}

function extractAnnexB(buffer) {
  const starts = findStartCodes(buffer);
  if (!starts.length) return null;
  return buffer.subarray(starts[0].offset);
}

function parseNalUnits(buffer) {
  const starts = findStartCodes(buffer);
  const units = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i].offset + starts[i].length;
    let end = i + 1 < starts.length ? starts[i + 1].offset : buffer.length;
    while (end > start && buffer[end - 1] === 0) end -= 1;
    if (end <= start) continue;
    const data = buffer.subarray(start, end);
    units.push({ type: data[0] & 0x1f, data });
  }
  return units;
}

function removeEmulationPrevention(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (i >= 2 && bytes[i] === 0x03 && bytes[i - 1] === 0x00 && bytes[i - 2] === 0x00) continue;
    out.push(bytes[i]);
  }
  return Buffer.from(out);
}

class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.bit = 0;
  }

  readBit() {
    const byte = this.buffer[this.bit >> 3] || 0;
    const value = (byte >> (7 - (this.bit & 7))) & 1;
    this.bit += 1;
    return value;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | this.readBit();
    return value >>> 0;
  }

  readUE() {
    let zeros = 0;
    while (this.readBit() === 0 && zeros < 32) zeros += 1;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }

  readSE() {
    const value = this.readUE();
    return value & 1 ? (value + 1) >> 1 : -(value >> 1);
  }
}

function parseSpsDimensions(sps) {
  try {
    const rbsp = removeEmulationPrevention(sps.subarray(1));
    const bits = new BitReader(rbsp);
    const profileIdc = bits.readBits(8);
    bits.readBits(8);
    bits.readBits(8);
    bits.readUE();

    let chromaFormatIdc = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormatIdc = bits.readUE();
      if (chromaFormatIdc === 3) bits.readBit();
      bits.readUE();
      bits.readUE();
      bits.readBit();
      if (bits.readBit()) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i += 1) {
          if (!bits.readBit()) continue;
          let last = 8;
          let next = 8;
          const size = i < 6 ? 16 : 64;
          for (let j = 0; j < size; j += 1) {
            if (next !== 0) next = (last + bits.readSE() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }

    bits.readUE();
    const picOrderCntType = bits.readUE();
    if (picOrderCntType === 0) {
      bits.readUE();
    } else if (picOrderCntType === 1) {
      bits.readBit();
      bits.readSE();
      bits.readSE();
      const count = bits.readUE();
      for (let i = 0; i < count; i += 1) bits.readSE();
    }

    bits.readUE();
    bits.readBit();
    const picWidthInMbsMinus1 = bits.readUE();
    const picHeightInMapUnitsMinus1 = bits.readUE();
    const frameMbsOnlyFlag = bits.readBit();
    if (!frameMbsOnlyFlag) bits.readBit();
    bits.readBit();

    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (bits.readBit()) {
      cropLeft = bits.readUE();
      cropRight = bits.readUE();
      cropTop = bits.readUE();
      cropBottom = bits.readUE();
    }

    const width = (picWidthInMbsMinus1 + 1) * 16;
    const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16;
    const cropUnitX = chromaFormatIdc === 0 ? 1 : chromaFormatIdc === 3 ? 1 : 2;
    const cropUnitY = chromaFormatIdc === 0 ? 2 - frameMbsOnlyFlag : chromaFormatIdc === 3 ? 2 - frameMbsOnlyFlag : 2 * (2 - frameMbsOnlyFlag);
    return {
      width: width - (cropLeft + cropRight) * cropUnitX,
      height: height - (cropTop + cropBottom) * cropUnitY,
    };
  } catch {
    return { width: 1280, height: 720 };
  }
}

function avcC(sps, pps) {
  return box("avcC", u8(1, sps[1], sps[2], sps[3], 0xff, 0xe1), u16(sps.length), sps, u8(1), u16(pps.length), pps);
}

function ftyp() {
  return box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso6"), str("avc1"), str("mp41"));
}

function mvhd(timescale) {
  return fullBox("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(0), u32(0x00010000), u16(0x0100), u16(0), Buffer.alloc(8), Buffer.from([
    0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
  ]), Buffer.alloc(24), u32(2));
}

function tkhd(width, height) {
  return fullBox("tkhd", 0, 7, u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), Buffer.from([
    0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
  ]), u32(width << 16), u32(height << 16));
}

function mdhd(timescale) {
  return fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
}

function hdlr() {
  return fullBox("hdlr", 0, 0, u32(0), str("vide"), Buffer.alloc(12), Buffer.from("VideoHandler\0", "ascii"));
}

function vmhd() {
  return fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
}

function dinf() {
  return box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
}

function stsd(sps, pps, width, height) {
  const avc1 = box(
    "avc1",
    Buffer.alloc(6),
    u16(1),
    Buffer.alloc(16),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    Buffer.alloc(32),
    u16(0x18),
    u16(0xffff),
    avcC(sps, pps),
  );
  return fullBox("stsd", 0, 0, u32(1), avc1);
}

function emptyStbl(sps, pps, width, height) {
  return box("stbl", stsd(sps, pps, width, height), fullBox("stts", 0, 0, u32(0)), fullBox("stsc", 0, 0, u32(0)), fullBox("stsz", 0, 0, u32(0), u32(0)), fullBox("stco", 0, 0, u32(0)));
}

function moov({ sps, pps, width, height, timescale, sampleDuration }) {
  return box(
    "moov",
    mvhd(timescale),
    box("trak", tkhd(width, height), box("mdia", mdhd(timescale), hdlr(), box("minf", vmhd(), dinf(), emptyStbl(sps, pps, width, height)))),
    box("mvex", fullBox("trex", 0, 0, u32(1), u32(1), u32(sampleDuration), u32(0), u32(0x01010000))),
  );
}

function mfhd(sequenceNumber) {
  return fullBox("mfhd", 0, 0, u32(sequenceNumber));
}

function tfhd() {
  return fullBox("tfhd", 0, 0x020000, u32(1));
}

function tfdt(baseDecodeTime) {
  return fullBox("tfdt", 1, 0, u64(baseDecodeTime));
}

function trun({ sampleDuration, sampleSize, sampleFlags, dataOffset }) {
  return fullBox("trun", 0, 0x000701, u32(1), u32(dataOffset), u32(sampleDuration), u32(sampleSize), u32(sampleFlags));
}

function makeSample(nals) {
  const parts = [];
  let isSync = false;
  for (const nal of nals.filter((unit) => unit.type === 1 || unit.type === 5 || unit.type === 6)) {
    parts.push(u32(nal.data.length), nal.data);
    if (nal.type === 5) isSync = true;
  }
  if (!parts.length) return null;
  return { data: Buffer.concat(parts), isSync };
}

function moof({ sequenceNumber, baseDecodeTime, sampleDuration, sampleSize, sampleFlags, dataOffset }) {
  return box(
    "moof",
    mfhd(sequenceNumber),
    box("traf", tfhd(), tfdt(baseDecodeTime), trun({ sampleDuration, sampleSize, sampleFlags, dataOffset })),
  );
}

class LiveMp4Muxer {
  constructor({ fps = 15 } = {}) {
    this.fps = fps;
    this.timescale = 90000;
    this.sampleDuration = Math.round(this.timescale / fps);
    this.sequenceNumber = 1;
    this.baseDecodeTime = 0;
    this.sps = null;
    this.pps = null;
    this.initSegment = null;
    this.codec = null;
  }

  pushAnnexB(annexB) {
    const nals = parseNalUnits(annexB);
    if (!nals.some((nal) => nal.type === 1 || nal.type === 5)) return null;

    const sps = nals.find((nal) => nal.type === 7)?.data;
    const pps = nals.find((nal) => nal.type === 8)?.data;
    if (sps) this.sps = Buffer.from(sps);
    if (pps) this.pps = Buffer.from(pps);
    if (!this.initSegment && this.sps && this.pps) {
      const dimensions = parseSpsDimensions(this.sps);
      this.codec = `avc1.${[this.sps[1], this.sps[2], this.sps[3]].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
      this.initSegment = Buffer.concat([
        ftyp(),
        moov({
          sps: this.sps,
          pps: this.pps,
          width: dimensions.width,
          height: dimensions.height,
          timescale: this.timescale,
          sampleDuration: this.sampleDuration,
        }),
      ]);
    }
    if (!this.initSegment) return null;

    const sample = makeSample(nals);
    if (!sample) return null;
    const mdat = box("mdat", sample.data);
    let movieFragment = moof({
      sequenceNumber: this.sequenceNumber,
      baseDecodeTime: this.baseDecodeTime,
      sampleDuration: this.sampleDuration,
      sampleSize: sample.data.length,
      sampleFlags: sample.isSync ? 0x02000000 : 0x01010000,
      dataOffset: 0,
    });
    movieFragment = moof({
      sequenceNumber: this.sequenceNumber,
      baseDecodeTime: this.baseDecodeTime,
      sampleDuration: this.sampleDuration,
      sampleSize: sample.data.length,
      sampleFlags: sample.isSync ? 0x02000000 : 0x01010000,
      dataOffset: movieFragment.length + 8,
    });
    this.sequenceNumber += 1;
    this.baseDecodeTime += this.sampleDuration;
    return { init: this.initSegment, fragment: Buffer.concat([movieFragment, mdat]), codec: this.codec, keyframe: sample.isSync };
  }
}

module.exports = {
  LiveMp4Muxer,
  extractAnnexB,
  parseNalUnits,
};
