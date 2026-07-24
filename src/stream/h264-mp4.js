const fs = require("fs");

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

function groupAccessUnits(nals) {
  const samples = [];
  let current = [];
  let hasVcl = false;

  for (const nal of nals) {
    const isVcl = nal.type === 1 || nal.type === 5;
    const startsNew = hasVcl && (isVcl || nal.type === 7 || nal.type === 8 || nal.type === 9);
    if (startsNew && current.length) {
      samples.push(current);
      current = [];
      hasVcl = false;
    }
    current.push(nal);
    if (isVcl) hasVcl = true;
  }

  if (current.length) samples.push(current);
  return samples.filter((sample) => sample.some((nal) => nal.type === 1 || nal.type === 5));
}

class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.bit = 0;
  }

  readBit() {
    const byte = this.buffer[this.bit >> 3];
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

function removeEmulationPrevention(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (i >= 2 && bytes[i] === 0x03 && bytes[i - 1] === 0x00 && bytes[i - 2] === 0x00) continue;
    out.push(bytes[i]);
  }
  return Buffer.from(out);
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

function avcCBox(sps, pps) {
  return box(
    "avcC",
    u8(1, sps[1], sps[2], sps[3], 0xff, 0xe1),
    u16(sps.length),
    sps,
    u8(1),
    u16(pps.length),
    pps,
  );
}

function makeSamples(samples) {
  return samples.map((sample) => {
    const payloadParts = [];
    let size = 0;
    let isSync = false;
    for (const nal of sample) {
      payloadParts.push(u32(nal.data.length), nal.data);
      size += nal.data.length + 4;
      if (nal.type === 5) isSync = true;
    }
    return { data: Buffer.concat(payloadParts), size, isSync };
  });
}

function mvhd(duration, timescale) {
  return fullBox("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), u16(0), Buffer.alloc(8), Buffer.from([
    0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
  ]), Buffer.alloc(24), u32(2));
}

function tkhd(trackId, duration, width, height) {
  return fullBox("tkhd", 0, 7, u32(0), u32(0), u32(trackId), u32(0), u32(duration), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), Buffer.from([
    0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
  ]), u32(width << 16), u32(height << 16));
}

function mdhd(duration, timescale) {
  return fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
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
    u16(0x0018),
    u16(0xffff),
    avcCBox(sps, pps),
  );
  return fullBox("stsd", 0, 0, u32(1), avc1);
}

function stts(sampleCount, sampleDuration) {
  return fullBox("stts", 0, 0, u32(1), u32(sampleCount), u32(sampleDuration));
}

function stss(samples) {
  const sync = [];
  samples.forEach((sample, index) => {
    if (sample.isSync) sync.push(index + 1);
  });
  return fullBox("stss", 0, 0, u32(sync.length), ...sync.map(u32));
}

function stsc() {
  return fullBox("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1));
}

function stsz(samples) {
  return fullBox("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map((sample) => u32(sample.size)));
}

function stco(offsets) {
  return fullBox("stco", 0, 0, u32(offsets.length), ...offsets.map(u32));
}

function moov({ samples, sps, pps, width, height, timescale, sampleDuration, offsets }) {
  const duration = samples.length * sampleDuration;
  return box(
    "moov",
    mvhd(duration, timescale),
    box(
      "trak",
      tkhd(1, duration, width, height),
      box(
        "mdia",
        mdhd(duration, timescale),
        hdlr(),
        box(
          "minf",
          vmhd(),
          dinf(),
          box("stbl", stsd(sps, pps, width, height), stts(samples.length, sampleDuration), stss(samples), stsc(), stsz(samples), stco(offsets)),
        ),
      ),
    ),
  );
}

function buildMp4FromAnnexB(filePath, fps = 15) {
  const annexb = fs.readFileSync(filePath);
  const nals = parseNalUnits(annexb);
  const sps = nals.find((nal) => nal.type === 7)?.data;
  const pps = nals.find((nal) => nal.type === 8)?.data;
  if (!sps || !pps) throw new Error("H.264 dump does not contain SPS/PPS.");

  const rawSamples = groupAccessUnits(nals);
  const samples = makeSamples(rawSamples);
  const timescale = 90000;
  const sampleDuration = Math.round(timescale / fps);
  const { width, height } = parseSpsDimensions(sps);
  const ftyp = box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso2"), str("avc1"), str("mp41"));
  const mdatPayload = Buffer.concat(samples.map((sample) => sample.data));
  const mdatHeaderSize = 8;
  const zeroOffsets = samples.map(() => 0);
  let movie = moov({ samples, sps, pps, width, height, timescale, sampleDuration, offsets: zeroOffsets });

  let cursor = ftyp.length + movie.length + mdatHeaderSize;
  const offsets = samples.map((sample) => {
    const offset = cursor;
    cursor += sample.size;
    return offset;
  });
  movie = moov({ samples, sps, pps, width, height, timescale, sampleDuration, offsets });
  const mdat = box("mdat", mdatPayload);
  return {
    buffer: Buffer.concat([ftyp, movie, mdat]),
    meta: {
      width,
      height,
      fps,
      samples: samples.length,
      bytes: annexb.length,
      syncSamples: samples.filter((sample) => sample.isSync).length,
      codec: `avc1.${[sps[1], sps[2], sps[3]].map((x) => x.toString(16).padStart(2, "0")).join("")}`,
    },
  };
}

module.exports = { buildMp4FromAnnexB };
