const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Kcp } = require("kcpjs/dist/kcp");
const { buildPacket, decodeDatagram, describeMsg, encodeP4P } = require("./p4p-codec");
const { LiveMp4Muxer, extractAnnexB, parseNalUnits } = require("./live-mp4");
const { buildWebCodecsCodecString, detectStreamFormat } = require("./video-codec");

const DISCOVERY_SERVERS = [
  "175.178.248.245",
  "121.199.12.37",
  "43.153.110.207",
  "8.208.11.50",
  "43.134.10.68",
  "43.157.31.112",
];

function discoveryServersForQueryKind(queryKind) {
  return queryKind === 4 ? DISCOVERY_SERVERS.slice(0, 3) : DISCOVERY_SERVERS;
}

const NON_LAN_KNOCK_STATES = new Set([3, 5, 6]);

// remove when LAN support added
const IGNORED_LAN_STREAM_MESSAGES = new Set([0x1301, 0x1302, 0x1303, 0x1304, 0x1307, 0x1308]);

const DEFAULT_STREAM_OPTIONS = {
  enableStartVideoControl: true,
  enableRdtAck: true,
  enableGracefulStop: true,
  enableNativeSessionFields: false,
  requireWakeupReadyStatus: true,
  queryRetryMs: 1000,
  queryRetryAttempts: 10,
  relayWakeupMs: 500,
  relayWakeupAttempts: 20,
  relayStreamReqMs: 1000,
  relayStreamReqAttempts: 16,
  kcpSkipAfterMs: 2500,
  kcpSkipThrottleMs: 1500,
  relayRenewAfterMs: 15000,
  relayRenewThrottleMs: 10000,
  reuseStaleAfterMs: 10000,
  rdtAckIntervalMs: 25,
  rdtAckMinIntervalMs: 20,
  sessionSnapshotMs: 2000,
  nativeKcpUpdateMs: 10,
  keepaliveMissLimit: 13,
  logoutGraceMs: 350,
};

function nowIso() {
  return new Date().toISOString();
}

function safeFilePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function toFixedAsciiBuffer(value, length) {
  const out = Buffer.alloc(length);
  Buffer.from(String(value || ""), "ascii").copy(out, 0, 0, length);
  return out;
}

function readFixedAsciiBuffer(value) {
  return value.toString("ascii").replace(/\0+$/g, "");
}

function ipv4FromLe(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff].join(".");
}

function normalizeUdpTarget(address, port) {
  const numericPort = Number(port);
  if (!address || !Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) return null;
  const parts = String(address).split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  if (address === "0.0.0.0" || address === "255.255.255.255") return null;
  return { address, port: numericPort };
}

function uniqueTargets(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    const key = `${target.address}:${target.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseNativeVpgItem(payload) {
  const base = 0x1c;
  const itemLength = 0x6c;
  if (!Buffer.isBuffer(payload) || payload.length < base + 0x2c) {
    return { present: false, vpgId: null, flags: [], targets: [], ipv6Targets: [], prefix: null };
  }

  const targets = [];
  const ipv6Targets = [];
  const item = payload.subarray(base, Math.min(payload.length, base + itemLength));
  const vpgId = item.length >= 2 ? item.readUInt16LE(0) : null;
  const flags = [];

  for (let index = 0; index < 4; index += 1) {
    const flag = item.length > 0x08 + index ? item[0x08 + index] : 0;
    flags.push(flag);
    const portOffset = 0x0c + index * 2;
    const port = item.length >= portOffset + 2 ? item.readUInt16BE(portOffset) : 0;

    if ((flag & 1) !== 0 && item.length >= 0x1c + index * 4 + 4) {
      const address = ipv4FromLe(item.readUInt32LE(0x1c + index * 4));
      const target = normalizeUdpTarget(address, port);
      if (target) targets.push({ ...target, source: "query-rsp-vpg", index, flag });
    }

    if ((flag & 2) !== 0 && item.length >= 0x2c + index * 0x10 + 0x10) {
      ipv6Targets.push({
        index,
        port,
        flag,
        addressHex: item.subarray(0x2c + index * 0x10, 0x2c + index * 0x10 + 0x10).toString("hex"),
      });
    }
  }

  return {
    present: true,
    vpgId,
    flags,
    targets: uniqueTargets(targets),
    ipv6Targets,
    prefix: item.subarray(0, Math.min(item.length, 0x6c)).toString("hex"),
  };
}

function firstValue(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function normalizeStreamIndex(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(3, Math.trunc(n)));
}

function isNativeTwoSensorDevice(identity) {
  return identity?.cloudDeviceType === 8 || identity?.cloudDeviceType === 9;
}

function flattenObject(object, prefix = "", out = {}) {
  if (!object || typeof object !== "object" || Buffer.isBuffer(object)) return out;
  for (const [key, value] of Object.entries(object)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value, next, out);
    } else {
      out[next] = value;
    }
  }
  return out;
}

function getDeviceIdentity(device) {
  const flat = flattenObject(device);
  const cloudDeviceType = Number(firstValue(flat, ["device_type", "raw.device_type", "infos.device_type"]) || 0);
  const p4pDeviceType = Number(firstValue(flat, ["devType", "p4pDeviceType", "raw.devType", "raw.p4pDeviceType"]) || 2);
  return {
    uid: firstValue(flat, ["uid", "device_uid", "raw.device_uid", "deviceInfo.device_uid", "info.device_uid"]),
    loginId: firstValue(flat, [
      "loginId",
      "login_id",
      "devLoginID",
      "device_login_id",
      "device_pwd",
      "devicePwd",
      "raw.login_id",
      "raw.loginId",
      "raw.device_login_id",
      "raw.device_loginid",
      "raw.dev_login_id",
      "raw.device_pwd",
      "raw.devicePwd",
      "info.device_pwd",
      "infos.device_pwd",
    ]),
    loginPwd: firstValue(flat, [
      "loginPwd",
      "login_pwd",
      "devLoginPwd",
      "device_login_pwd",
      "device_user",
      "deviceUser",
      "raw.login_pwd",
      "raw.loginPwd",
      "raw.device_login_pwd",
      "raw.device_loginpwd",
      "raw.dev_login_pwd",
      "raw.device_user",
      "raw.deviceUser",
      "info.device_user",
      "infos.device_user",
    ]),
    streamIndex: normalizeStreamIndex(
      firstValue(flat, ["streamindex", "streamIndex", "stream_type", "raw.streamindex", "raw.stream_type"]),
      0,
    ),
    zoneId: Number(firstValue(flat, ["zoneID", "zoneId", "zoneid", "zone_id", "raw.zoneID", "raw.zoneid", "raw.zone_id"]) || 0),
    channel: Number(firstValue(flat, ["channel", "raw.channel"]) || 0),
    cloudDeviceType,
    deviceType: p4pDeviceType,
    videoSidSeed: Number(firstValue(flat, ["videoSidSeed", "raw.videoSidSeed"]) || 0x0f),
  };
}

function randomIdForUid(uid) {
  const uidBytes = Buffer.from(String(uid || ""), "ascii");
  let value = crypto.randomBytes(4).readUInt32LE(0) & 0xffff0000;
  value += Date.now() & 0xff00;
  for (let i = 0; i < Math.min(4, uidBytes.length); i += 1) value = (value + uidBytes[i]) >>> 0;
  return value >>> 0;
}

function isAnnexB(buf) {
  return buf.includes(Buffer.from([0, 0, 1])) || buf.includes(Buffer.from([0, 0, 0, 1]));
}

function parseKcpSegments(buf) {
  const segments = [];
  let offset = 0;
  while (offset + 24 <= buf.length) {
    const len = buf.readUInt32LE(offset + 20);
    if (offset + 24 + len > buf.length) break;
    segments.push({
      conv: buf.readUInt32LE(offset),
      cmd: buf[offset + 4],
      frg: buf[offset + 5],
      wnd: buf.readUInt16LE(offset + 6),
      ts: buf.readUInt32LE(offset + 8),
      sn: buf.readUInt32LE(offset + 12),
      una: buf.readUInt32LE(offset + 16),
      len,
      data: buf.subarray(offset + 24, offset + 24 + len),
    });
    offset += 24 + len;
  }
  return segments;
}

function parseInnerRecord(buf) {
  if (buf.length < 32) return null;
  const recordLength = buf.readUInt32LE(8);
  const payloadLength = recordLength >= 16 && recordLength + 16 <= buf.length ? recordLength - 16 : Math.max(buf.length - 32, 0);
  const frameInfo = buf.subarray(16, 32);
  const frameMeta = parseFrameInfo(frameInfo);
  const payload = buf.subarray(32, 32 + payloadLength);
  return {
    type: buf.readUInt16LE(0),
    streamByte: buf[3],
    recordLength,
    totalLength: 16 + recordLength,
    frameSeq: buf.readUInt16LE(6),
    crc32: buf.readUInt32LE(12),
    frameInfo,
    frameMeta,
    payload,
  };
}

function parseFrameInfo(frameInfo) {
  if (!frameInfo || frameInfo.length < 16) return null;
  return {
    codec: frameInfo[0],
    flags: frameInfo[2],
    cam: frameInfo[3],
    online: frameInfo[4],
    timestamp: frameInfo.readUInt32LE(12),
  };
}

// Native forwards callback frame bytes upward; the web bridge only normalizes
// Annex-B framing and preserves every parsed NAL unit.
function normalizeAnnexB(annexB) {
  const parts = [];
  const nals = parseNalUnits(annexB);
  if (!nals.length) return null;
  for (const nal of nals) {
    parts.push(Buffer.from([0, 0, 0, 1]), nal.data);
  }
  return Buffer.concat(parts);
}

function summarizeNalUnits(annexB) {
  const counts = {};
  for (const nal of parseNalUnits(annexB)) {
    counts[nal.type] = (counts[nal.type] || 0) + 1;
  }
  return counts;
}

function framePacket(frame) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(frame.length, 0);
  return Buffer.concat([header, frame]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function align4(value) {
  return (value + 3) & ~3;
}

function seqDistance(from, to) {
  return (to - from) & 0xffff;
}

function seqMinus(value, amount) {
  return (value - amount) & 0xffff;
}

function seqPlus(value, amount) {
  return (value + amount) & 0xffff;
}

function buildRdtAckPayload({ lastFrameSeq = 0, receivedFrameSeqs = new Set() } = {}) {
  const count = receivedFrameSeqs.size ? Math.min(255, receivedFrameSeqs.size) : 1;
  const startSeq = seqMinus(lastFrameSeq, count - 1);
  const bitmapBytes = Math.ceil(count / 8);
  const ackDataLength = align4(8 + bitmapBytes);
  const ackTlv = Buffer.alloc(4 + ackDataLength);

  ackTlv.writeUInt16LE(1, 0);
  ackTlv.writeUInt16LE(ackDataLength, 2);
  ackTlv.writeUInt16LE(lastFrameSeq & 0xffff, 4);
  ackTlv.writeUInt16LE(startSeq & 0xffff, 8);
  ackTlv[10] = count & 0xff;
  ackTlv[11] = bitmapBytes & 0xff;
  for (let i = 0; i < count; i += 1) {
    const seq = seqPlus(startSeq, i);
    if (receivedFrameSeqs.has(seq)) ackTlv[12 + Math.floor(i / 8)] |= 1 << (i % 8);
  }

  const statsTlv = Buffer.alloc(4 + 16);
  statsTlv.writeUInt16LE(4, 0);
  statsTlv.writeUInt16LE(16, 2);

  const bandwidthTlv = Buffer.alloc(4 + 24);
  bandwidthTlv.writeUInt16LE(5, 0);
  bandwidthTlv.writeUInt16LE(24, 2);
  bandwidthTlv.writeUInt32LE(1024 * 1024, 4);
  bandwidthTlv.writeUInt32LE(1024 * 1024, 8);
  bandwidthTlv.writeUInt16LE(256, 12);
  bandwidthTlv.writeUInt16LE(0, 14);
  bandwidthTlv.writeUInt16LE(0, 16);
  bandwidthTlv.writeUInt16LE(0, 18);
  bandwidthTlv.writeUInt16LE(15, 20);
  bandwidthTlv.writeUInt16LE(15, 22);

  const tlvs = Buffer.concat([ackTlv, statsTlv, bandwidthTlv]);
  const payload = Buffer.alloc(12 + tlvs.length);
  payload[0] = 6;
  payload.writeUInt16LE(tlvs.length, 2);
  payload.writeUInt16LE(0, 4);
  tlvs.copy(payload, 12);
  return payload;
}

function createStartConfig(identity) {
  const config = Buffer.alloc(0x40);
  config[0] = identity.deviceType & 0xff;
  config[1] = 1;
  config[2] = 0;
  config[3] = 0;
  config[4] = identity.channel & 0xff;
  config[5] = identity.streamIndex & 0xff;
  config[6] = 0;
  config[7] = identity.zoneId & 0xff;
  toFixedAsciiBuffer(identity.uid, 0x14).copy(config, 0x08);
  toFixedAsciiBuffer(identity.loginId, 0x10).copy(config, 0x1c);
  toFixedAsciiBuffer(identity.loginPwd || "admin", 0x14).copy(config, 0x2c);
  return config;
}

function parseRdtBlock(record) {
  if (!record || record.length < 0x18) return null;
  const packetLen = record.readUInt16LE(2);
  const payloadLen = Math.max(0, Math.min(record.length, packetLen || record.length) - 0x18);
  return {
    type: record[0],
    flags: record[1],
    packetLen,
    blockSeq: record.readUInt16LE(4),
    baseBlockSeq: record.readUInt16LE(6),
    blockCount: record[8],
    blocksInFrame: record[9],
    frameNo: record.readUInt16LE(10),
    frameId: record.readUInt16LE(12),
    blockIndex: record[15],
    fullFrameLen: record.readUInt32LE(16),
    payload: record.subarray(0x18, 0x18 + payloadLen),
  };
}

class UBoxLiveStreamManager {
  constructor({ dumpDir, logDir, defaultOptions = {}, enableSessionLogs = true, enableDumpFiles = true }) {
    this.dumpDir = dumpDir;
    this.logDir = logDir || path.join(dumpDir, "..", "live-session-logs");
    this.defaultOptions = { ...DEFAULT_STREAM_OPTIONS, ...defaultOptions };
    this.enableSessionLogs = enableSessionLogs;
    this.enableDumpFiles = enableDumpFiles;
    this.session = null;
    this.events = [];
    this.sseClients = new Set();
    this.sessionLogFile = "";
    this.sessionLogBuffer = [];
    this.sessionLogTimer = null;
    this.restartPromise = null;
    if (this.enableSessionLogs) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  status() {
    return {
      active: Boolean(this.session),
      dumpDir: this.dumpDir,
      logDir: this.logDir,
      eventCount: this.events.length,
      session: this.session?.summary() || null,
    };
  }

  recentEvents(limit = 120) {
    return this.events.slice(-limit);
  }

  addSseClient(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.status())}\n\n`);
    for (const event of this.recentEvents(30)) {
      res.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
    }
    this.sseClients.add(res);
    res.on("close", () => this.sseClients.delete(res));
  }

  addMp4Client(res) {
    if (!this.session) {
      res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Live decoder is not running." }));
      return;
    }
    this.session.addMp4Client(res);
  }

  addH264Client(res, track = "primary") {
    if (!this.session) {
      res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Live decoder is not running." }));
      return;
    }
    this.session.addH264Client(res, track);
  }

  emit(event, detail = {}) {
    const row = {
      at: nowIso(),
      event,
      sessionId: detail.sessionId || this.session?.sessionId || undefined,
      ...detail,
    };
    this.events.push(row);
    this.events = this.events.slice(-500);
    this.writeSessionLog(row);
    for (const client of this.sseClients) {
      client.write(`event: log\ndata: ${JSON.stringify(row)}\n\n`);
    }
    return row;
  }

  openSessionLog(session) {
    if (!this.enableSessionLogs) {
      this.sessionLogFile = "";
      return;
    }
    this.closeSessionLog();
    fs.mkdirSync(this.logDir, { recursive: true });
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFilePart(session.identity.uid)}-${session.randomId}.jsonl`;
    const file = path.join(this.logDir, fileName);
    session.logFile = file;
    this.sessionLogFile = file;
    this.sessionLogBuffer = [];
    this.sessionLogTimer = setInterval(() => this.flushSessionLog(), 250);
    this.writeSessionLog({
      at: nowIso(),
      event: "session-log-opened",
      sessionId: session.sessionId,
      uid: session.identity.uid,
      dumpFile: session.dumpFile,
      logFile: file,
      options: session.options,
      identity: {
        uid: session.identity.uid,
        loginIdPresent: Boolean(session.identity.loginId),
        loginPwdPresent: Boolean(session.identity.loginPwd),
        streamIndex: session.identity.streamIndex,
        zoneId: session.identity.zoneId,
        channel: session.identity.channel,
        cloudDeviceType: session.identity.cloudDeviceType,
        deviceType: session.identity.deviceType,
        videoSidSeed: session.identity.videoSidSeed,
      },
    });
  }

  writeSessionLog(row) {
    if (!this.sessionLogFile) return;
    this.sessionLogBuffer.push(`${JSON.stringify(row)}\n`);
    if (this.sessionLogBuffer.length >= 100) this.flushSessionLog();
  }

  flushSessionLog() {
    if (!this.sessionLogFile || !this.sessionLogBuffer.length) return;
    const chunk = this.sessionLogBuffer.join("");
    this.sessionLogBuffer = [];
    try {
      fs.appendFileSync(this.sessionLogFile, chunk);
    } catch {
      // Logging must never break live stream handling.
    }
  }

  closeSessionLog() {
    if (this.sessionLogTimer) clearInterval(this.sessionLogTimer);
    this.sessionLogTimer = null;
    this.flushSessionLog();
    this.sessionLogFile = "";
  }

  restartSession(session, reason, detail = {}) {
    if (this.session !== session || this.restartPromise) return;
    this.restartPromise = (async () => {
      this.emit("session-auto-restart", { sessionId: session.sessionId, reason, ...detail, previous: session.summary() });
      await this.stop();
      await this.start(session.identity, { ...session.options, forceRestart: true });
    })()
      .catch((error) => this.emit("session-auto-restart-error", { sessionId: session.sessionId, reason, message: error.message }))
      .finally(() => {
        this.restartPromise = null;
      });
  }

  async start(device, options = {}) {
    const sessionOptions = { ...this.defaultOptions, ...options };
    const identity = getDeviceIdentity(device);
    if (sessionOptions.streamIndex !== undefined) {
      identity.streamIndex = normalizeStreamIndex(sessionOptions.streamIndex, identity.streamIndex);
    }
    if (!identity.uid) {
      const error = new Error("Selected device does not include a UID.");
      error.status = 400;
      throw error;
    }
    const sameStreamIndex = this.session?.identity.streamIndex === identity.streamIndex;
    const reusable =
      this.session &&
      this.session.identity.uid === identity.uid &&
      sameStreamIndex &&
      !sessionOptions.forceRestart &&
      !this.session.isStaleForReuse(sessionOptions);
    if (reusable) {
      this.emit("session-reused", this.session.summary());
      this.session.sendStartVideoControl();
      return this.status();
    }
    if (this.session && this.session.identity.uid === identity.uid) {
      this.emit("session-restart", {
        reason: sessionOptions.forceRestart ? "forced" : sameStreamIndex ? "stale-session" : "stream-index-changed",
        previous: this.session.summary(),
        nextStreamIndex: identity.streamIndex,
      });
    }
    await this.stop();
    if (this.enableDumpFiles) {
      fs.mkdirSync(this.dumpDir, { recursive: true });
    }
    this.session = new UBoxLiveStreamSession({
      identity,
      manager: this,
      dumpFile: this.enableDumpFiles ? path.join(this.dumpDir, `${identity.uid}-${Date.now()}.h264`) : null,
      options: sessionOptions,
    });
    this.openSessionLog(this.session);
    await this.session.start();
    return this.status();
  }

  async stop() {
    if (!this.session) return;
    const old = this.session;
    this.session = null;
    await old.stop();
    this.emit("session-stopped", { sessionId: old.sessionId, ...old.summary() });
    this.closeSessionLog();
  }

  decodePacket(hex) {
    const raw = Buffer.from(String(hex || "").replace(/[^a-fA-F0-9]/g, ""), "hex");
    const decoded = decodeDatagram(raw);
    if (!decoded.header) return { ok: false, bytes: raw.length };
    return {
      ok: true,
      bytes: raw.length,
      encrypted: decoded.encrypted,
      header: decoded.header,
      message: describeMsg(decoded.header.msg),
      prefix: decoded.clear.subarray(0, Math.min(decoded.clear.length, 96)).toString("hex"),
    };
  }
}

class UBoxLiveStreamSession {
  constructor({ identity, manager, dumpFile, options }) {
    this.identity = identity;
    this.manager = manager;
    this.dumpFile = dumpFile;
    this.options = options;
    this.socket = dgram.createSocket("udp4");
    this.randomId = randomIdForUid(identity.uid);
    this.sessionId = `${Date.now()}-${safeFilePart(identity.uid)}-${this.randomId}`;
    this.logFile = "";
    this.sid = 0;
    this.remoteSid = 0;
    this.videoSid = 0;
    this.channel = identity.channel || 0;
    this.startConfig = createStartConfig(identity);
    this.sessionState = {
      active: true,
      state: 1,
      role: 2,
      queryKind: this.startConfig[7],
      localSid: identity.videoSidSeed & 0xff,
      peerSidByte: 0,
      peerValue08: 0,
      peerValue0a: 0,
      randomId: this.randomId,
      sessionIndex: 0,
      seqByte: crypto.randomBytes(1)[0],
      relayMode: 1,
      liveMissCount: 0,
      aliveSendCount: 0,
      streamReqEnabled: this.startConfig[1],
      streamFlag1: this.startConfig[2],
      streamFlag2: this.startConfig[3],
      avKind: this.startConfig[4],
      reqByteE1: this.startConfig[5],
      uid: this.startConfig.subarray(0x08, 0x1c),
      sessionBlobF8: this.startConfig.subarray(0x1c, 0x2c),
      sessionBlob108: this.startConfig.subarray(0x2c, 0x40),
      clientStartSecond: Math.floor(Date.now() / 1000) >>> 0,
    };
    this.relayEstablished = false;
    this.relayPeer = null;
    this.learnedVpgTargets = [];
    this.stopping = false;
    this.lastInboundAt = 0;
    this.lastAliveAt = 0;
    this.lastH264At = 0;
    this.lastKcpInputAt = 0;
    this.lastKcpMessageAt = 0;
    this.lastVideoKickAt = 0;
    this.lastRelayRenewAt = 0;
    this.relayPendingSince = null;
    this.kcp = null;
    this.kcpConv = null;
    this.lastKcpHeader = null;
    this.kcpStateEvents = 0;
    this.kcpUna = null;
    this.kcpReceivedSns = new Set();
    this.lastKcpSkipAt = 0;
    this.lastRdtAckAt = 0;
    this.lastStartVideoKcpAt = 0;
    this.rdtAckState = {
      lastFrameSeq: 0,
      hasFrame: false,
      receivedFrameSeqs: new Set(),
    };
    this.rdtFrames = new Map();
    this.muxer = new LiveMp4Muxer({ fps: Number(options.fps || 15) });
    this.streamFormat = null;
    this.streamCodec = null;
    this.mp4Clients = new Set();
    this.mp4Backlog = [];
    this.h264Tracks = new Map([
      ["primary", { clients: new Set(), backlog: [], frames: 0 }],
      ["secondary", { clients: new Set(), backlog: [], frames: 0 }],
    ]);
    this.counters = {
      rx: 0,
      tx: 0,
      decoded: 0,
      queryPackets: 0,
      relayWakePackets: 0,
      kcpSegments: 0,
      kcpMessages: 0,
      videoFrames: 0,
      annexBFrames: 0,
      bytesWritten: 0,
      mp4Clients: 0,
      mp4Fragments: 0,
      h264Clients: 0,
      h264Frames: 0,
      h264DroppedFrames: 0,
      kcpGapDrops: 0,
      kcpInputErrors: 0,
      kcpOutputPackets: 0,
      rdtAckPackets: 0,
      rdtPackets: 0,
      rdtFrames: 0,
      rdtFrameDrops: 0,
      videoKicks: 0,
      relayRenews: 0,
      alivePackets: 0,
      knockPackets: 0,
      knockAcks: 0,
      logoutPackets: 0,
    };
    this.queryTimer = null;
    this.queryRetriesLeft = Number(this.options.queryRetryAttempts || 10);
    this.punchTimer = null;
    this.relayTimer = null;
    this.relayWakeRetriesLeft = 0;
    this.relayStreamRetriesLeft = 0;
    this.knockRetriesLeft = 0;
    this.startedAt = nowIso();
  }

  summary() {
    return {
      uid: this.identity.uid,
      loginIdPresent: Boolean(this.identity.loginId),
      loginPwdPresent: Boolean(this.identity.loginPwd),
      randomId: this.randomId,
      sid: this.sid,
      remoteSid: this.remoteSid,
      videoSid: this.videoSid,
      channel: this.channel,
      streamIndex: this.identity.streamIndex,
      nativeVideoRouting: {
        twoSensorDevice: isNativeTwoSensorDevice(this.identity),
        rule: isNativeTwoSensorDevice(this.identity) ? "split-by-cam-index" : "all-frames-to-primary",
      },
      sessionState: {
        state: this.sessionState.state,
        localSid: this.sessionState.localSid,
        peerSidByte: this.sessionState.peerSidByte,
        peerValue08: this.sessionState.peerValue08,
        peerValue0a: this.sessionState.peerValue0a,
        seqByte: this.sessionState.seqByte,
        relayMode: this.sessionState.relayMode,
        liveMissCount: this.sessionState.liveMissCount,
        aliveSendCount: this.sessionState.aliveSendCount,
        queryRetriesLeft: this.queryRetriesLeft,
        relayWakeRetriesLeft: this.relayWakeRetriesLeft,
        relayStreamRetriesLeft: this.relayStreamRetriesLeft,
      },
      dumpFile: this.dumpFile,
      logFile: this.logFile,
      mp4Ready: Boolean(this.muxer.initSegment),
      mp4Codec: this.muxer.codec || this.streamCodec,
      streamFormat: this.streamFormat,
      streamCodec: this.streamCodec,
      mp4Backlog: this.mp4Backlog.length,
      h264Backlog: this.h264Tracks.get("primary").backlog.length,
      h264Tracks: Object.fromEntries([...this.h264Tracks.entries()].map(([track, state]) => [
        track,
        {
          clients: state.clients.size,
          backlog: state.backlog.length,
          frames: state.frames,
        },
      ])),
      counters: this.counters,
      kcpState: this.kcp
        ? {
            conv: this.kcpConv,
            rcvNxt: this.kcp.rcv_nxt,
            rcvQueue: this.kcp.rcv_queue.length,
            rcvBuf: this.kcp.rcv_buf.length,
            peekSize: this.kcp.peekSize(),
            sndUna: this.kcp.snd_una,
            sndNxt: this.kcp.snd_nxt,
            lastKcpInputAgoMs: this.lastKcpInputAt ? Date.now() - this.lastKcpInputAt : null,
            lastKcpMessageAgoMs: this.lastKcpMessageAt ? Date.now() - this.lastKcpMessageAt : null,
            lastH264AgoMs: this.lastH264At ? Date.now() - this.lastH264At : null,
            mtu: this.kcp.mtu,
            mss: this.kcp.mss,
            sndWnd: this.kcp.snd_wnd,
            rcvWnd: this.kcp.rcv_wnd,
            interval: this.kcp.interval,
            rxMinRto: this.kcp.rx_minrto,
          }
        : null,
      startedAt: this.startedAt,
    };
  }

  isStaleForReuse(options = this.options) {
    const now = Date.now();
    const startedAt = Date.parse(this.startedAt);
    const ageMs = Number.isFinite(startedAt) ? now - startedAt : 0;
    const staleAfterMs = Number(options.reuseStaleAfterMs || 10000);
    if (ageMs < staleAfterMs) return false;
    const videoQuietMs = this.lastH264At ? now - this.lastH264At : ageMs;
    const transportQuietMs = this.lastKcpInputAt ? now - this.lastKcpInputAt : ageMs;
    return videoQuietMs > staleAfterMs || transportQuietMs > staleAfterMs * 2;
  }

  async start() {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.socket.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.socket.off("error", onError);
        resolve();
      };
      this.socket.once("error", onError);
      this.socket.once("listening", onListening);
      this.socket.bind(0);
    });

    this.socket.on("message", (raw, rinfo) => this.handleDatagram(raw, rinfo));
    this.socket.on("error", (error) => this.manager.emit("udp-error", { message: error.message }));
    this.manager.emit("session-started", this.summary());
    this.sendDiscovery();
    this.queryTimer = setInterval(() => this.queryTick(), Number(this.options.queryRetryMs || 1000));
    this.aliveTimer = setInterval(() => this.keepaliveTick(), 1000);
    if (this.options.enableRdtAck) {
      this.rdtAckTimer = setInterval(() => this.sendRdtVideoAck("timer"), Number(this.options.rdtAckIntervalMs || 25));
    }
    this.snapshotTimer = setInterval(() => {
      this.manager.emit("session-snapshot", this.summary());
    }, Number(this.options.sessionSnapshotMs || 2000));
    this.videoWatchdogTimer = setInterval(() => this.checkVideoWatchdog(), 2000);
    this.kcpTimer = setInterval(() => this.updateKcp(), Number(this.options.nativeKcpUpdateMs || 10));
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.queryTimer);
    clearInterval(this.relayTimer);
    clearInterval(this.aliveTimer);
    clearInterval(this.rdtAckTimer);
    clearInterval(this.punchTimer);
    clearInterval(this.snapshotTimer);
    clearInterval(this.videoWatchdogTimer);
    clearInterval(this.kcpTimer);
    for (const client of this.mp4Clients) client.res.end();
    this.mp4Clients.clear();
    for (const state of this.h264Tracks.values()) {
      for (const client of state.clients) client.res.end();
      state.clients.clear();
    }
    if (this.options.enableGracefulStop) {
      this.sendStopVideoControl("stop");
      this.sendLogoutRequest("stop");
      await sleep(Number(this.options.logoutGraceMs || 350));
    }
    await new Promise((resolve) => this.socket.close(resolve));
  }

  addMp4Client(res) {
    res.writeHead(200, {
      "content-type": "video/mp4",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const client = { res, initSent: false };
    this.mp4Clients.add(client);
    this.counters.mp4Clients = this.mp4Clients.size;
    if (this.muxer.initSegment) {
      res.write(this.muxer.initSegment);
      client.initSent = true;
      for (const fragment of this.mp4Backlog) res.write(fragment);
    }
    this.manager.emit("mp4-client-connected", { clients: this.mp4Clients.size, codec: this.muxer.codec, backlog: this.mp4Backlog.length });
    res.on("close", () => {
      this.mp4Clients.delete(client);
      this.counters.mp4Clients = this.mp4Clients.size;
      this.manager.emit("mp4-client-disconnected", { clients: this.mp4Clients.size });
    });
  }

  h264Track(track) {
    return this.h264Tracks.get(track) || this.h264Tracks.get("primary");
  }

  updateH264ClientCounter() {
    this.counters.h264Clients = [...this.h264Tracks.values()].reduce((sum, state) => sum + state.clients.size, 0);
  }

  addH264Client(res, track = "primary") {
    const state = this.h264Track(track);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-stream-format": "uint32be-length-prefixed-annexb-h264",
      "x-stream-track": track,
    });
    const client = { res, track };
    state.clients.add(client);
    this.updateH264ClientCounter();
    for (const frame of state.backlog) res.write(framePacket(frame));
    this.manager.emit("h264-client-connected", { track, clients: state.clients.size, backlog: state.backlog.length });
    res.on("close", () => {
      state.clients.delete(client);
      this.updateH264ClientCounter();
      this.manager.emit("h264-client-disconnected", { track, clients: state.clients.size });
    });
  }

  send(address, port, clearPacket, encrypted = true) {
    const packet = encrypted ? encodeP4P(clearPacket) : clearPacket;
    try {
      this.socket.send(packet, port, address);
    } catch (error) {
      this.manager.emit("udp-send-error", { to: `${address}:${port}`, message: error.message });
    }
    this.counters.tx += 1;
  }

  resetLiveCount(reason) {
    this.lastInboundAt = Date.now();
    if (this.sessionState.liveMissCount !== 0) {
      this.manager.emit("live-count-reset", { reason, previous: this.sessionState.liveMissCount });
    }
    this.sessionState.liveMissCount = 0;
  }

  keepaliveTick() {
    if (!this.relayEstablished || !this.relayPeer) return;
    this.sessionState.liveMissCount += 1;
    const limit = Number(this.options.keepaliveMissLimit || 13);
    if (this.sessionState.liveMissCount >= limit) {
      this.manager.emit("keepalive-dead", {
        misses: this.sessionState.liveMissCount,
        limit,
        lastInboundAgoMs: this.lastInboundAt ? Date.now() - this.lastInboundAt : null,
      });
      this.manager.restartSession(this, "keepalive-dead", { misses: this.sessionState.liveMissCount, limit });
      return;
    }
    this.sendAlive();
  }

  sendDiscovery() {
    if (this.sessionState.state !== 1) {
      this.manager.emit("p4p-query-skipped", { state: this.sessionState.state, reason: "native-state-not-query" });
      return false;
    }
    const payload = Buffer.alloc(44);
    toFixedAsciiBuffer(this.identity.uid, 20).copy(payload, 4);
    const packet = buildPacket({ msg: 0x1051, payload, msgLen: 0x28 });
    const servers = discoveryServersForQueryKind(this.sessionState.queryKind);
    for (const host of servers) this.send(host, 10240, packet, true);
    this.counters.queryPackets += 1;
    this.manager.emit("p4p-query-sent", {
      uid: this.identity.uid,
      queryKind: this.sessionState.queryKind,
      servers: servers.length,
      nativeQueryKind4Fanout: this.sessionState.queryKind === 4,
      packets: this.counters.queryPackets,
    });
    return true;
  }

  queryTick() {
    if (this.sessionState.state !== 1) {
      clearInterval(this.queryTimer);
      this.queryTimer = null;
      return;
    }
    if (this.queryRetriesLeft <= 0) {
      clearInterval(this.queryTimer);
      this.queryTimer = null;
      this.manager.emit("p4p-query-timeout", {
        packets: this.counters.queryPackets,
        state: this.sessionState.state,
      });
      this.manager.restartSession(this, "p4p-query-timeout", { packets: this.counters.queryPackets });
      return;
    }
    this.queryRetriesLeft -= 1;
    this.sendDiscovery();
  }

  beginRelayWakeup(reason, rinfo = null, query = {}) {
    if (this.sessionState.state !== 1 && this.sessionState.state !== 2) {
      this.manager.emit("relay-wakeup-phase-skipped", {
        reason,
        state: this.sessionState.state,
      });
      return false;
    }
    clearInterval(this.queryTimer);
    this.queryTimer = null;
    this.sessionState.state = 2;
    this.relayPendingSince = Date.now();
    if (Array.isArray(query.relayTargets)) {
      this.learnedVpgTargets = uniqueTargets(query.relayTargets);
    }
    this.relayWakeRetriesLeft = Number(this.options.relayWakeupAttempts || 20);
    if (!this.relayTimer) {
      this.relayTimer = setInterval(() => this.relayWakeupTick(), Number(this.options.relayWakeupMs || 500));
    }
    this.manager.emit("relay-wakeup-phase-started", {
      reason,
      from: rinfo ? `${rinfo.address}:${rinfo.port}` : undefined,
      status: query.status,
      vpgId: query.vpgId,
      relayTargets: this.learnedVpgTargets.map((target) => `${target.address}:${target.port}`),
      relayTargetCount: this.learnedVpgTargets.length,
      state: this.sessionState.state,
      intervalMs: Number(this.options.relayWakeupMs || 500),
      attempts: this.relayWakeRetriesLeft,
    });
    this.sendRelayWakeup(reason);
    return true;
  }

  relayWakeupTick() {
    if (this.relayEstablished) return;
    if (this.sessionState.state !== 2) {
      clearInterval(this.relayTimer);
      this.relayTimer = null;
      return;
    }
    if (this.relayWakeRetriesLeft <= 0) {
      clearInterval(this.relayTimer);
      this.relayTimer = null;
      this.manager.emit("relay-wakeup-timeout", {
        state: this.sessionState.state,
        packets: this.counters.relayWakePackets,
      });
      this.manager.restartSession(this, "relay-wakeup-timeout", { packets: this.counters.relayWakePackets });
      return;
    }
    this.relayWakeRetriesLeft -= 1;
    this.sendRelayWakeup("timer");
  }

  beginRelayStreamRequest(address, port, reason = "wakeup-rsp") {
    clearInterval(this.relayTimer);
    this.relayTimer = null;
    this.relayPeer = { address, port };
    this.sessionState.state = 3;
    this.relayStreamRetriesLeft = Number(this.options.relayStreamReqAttempts || 16);
    this.relayTimer = setInterval(() => this.relayStreamRequestTick(), Number(this.options.relayStreamReqMs || 1000));
    this.manager.emit("relay-stream-phase-started", {
      reason,
      to: `${address}:${port}`,
      state: this.sessionState.state,
      intervalMs: Number(this.options.relayStreamReqMs || 1000),
      attempts: this.relayStreamRetriesLeft,
    });
    this.sendRelayStreamRequest(address, port, reason);
  }

  relayStreamRequestTick() {
    if (this.relayEstablished) {
      clearInterval(this.relayTimer);
      this.relayTimer = null;
      return;
    }
    if (!this.relayPeer || this.sessionState.state !== 3) {
      clearInterval(this.relayTimer);
      this.relayTimer = null;
      return;
    }
    if (this.relayStreamRetriesLeft <= 0) {
      clearInterval(this.relayTimer);
      this.relayTimer = null;
      this.manager.emit("relay-stream-req-timeout", {
        state: this.sessionState.state,
        to: `${this.relayPeer.address}:${this.relayPeer.port}`,
      });
      this.manager.restartSession(this, "relay-stream-req-timeout");
      return;
    }
    this.relayStreamRetriesLeft -= 1;
    this.sendRelayStreamRequest(this.relayPeer.address, this.relayPeer.port, "timer");
  }

  relayWakeupTargets() {
    return uniqueTargets(this.learnedVpgTargets);
  }

  sendRelayWakeup(reason = "timer") {
    if (this.relayEstablished) return;
    if (this.sessionState.state !== 2) {
      this.manager.emit("relay-wakeup-skipped", {
        state: this.sessionState.state,
        reason: "native-state-not-wakeup",
      });
      return;
    }
    if (!this.relayPendingSince) this.relayPendingSince = Date.now();
    const payload = Buffer.alloc(44);
    payload[0] = 1;
    payload[1] = 1;
    toFixedAsciiBuffer(this.identity.uid, 20).copy(payload, 4);
    const packet = buildPacket({ msg: 0x1201, payload, msgLen: 0x24 });
    const targets = this.relayWakeupTargets();
    if (targets.length === 0) {
      this.manager.emit("relay-wakeup-skipped", {
        state: this.sessionState.state,
        reason: "no-native-vpg-relay-targets",
      });
      return;
    }
    for (const target of targets) this.send(target.address, target.port, packet, true);
    this.counters.relayWakePackets += 1;
    this.manager.emit("relay-wakeup-sent", {
      reason,
      servers: targets.length,
      relayTargets: targets.map((target) => `${target.address}:${target.port}`),
      packets: this.counters.relayWakePackets,
      retriesLeft: this.relayWakeRetriesLeft,
    });
  }

  sendRelayStreamRequest(address, port, reason = "wakeup-rsp") {
    if (this.relayEstablished) return;
    this.sessionState.state = 3;
    const payload = this.options.enableNativeSessionFields ? this.buildRelayStreamRequestPayload() : this.buildLegacyRelayStreamRequestPayload();
    const packet = buildPacket({ msg: 0x1205, payload, msgLen: 0x24 });
    this.send(address, port, packet, true);
    this.manager.emit("relay-stream-req-sent", {
      reason,
      to: `${address}:${port}`,
      nativeFields: Boolean(this.options.enableNativeSessionFields),
      loginIdPresent: Boolean(this.identity.loginId),
      loginPwdPresent: Boolean(this.identity.loginPwd),
      p4pDeviceType: this.identity.deviceType,
      cloudDeviceType: this.identity.cloudDeviceType,
      videoSidSeed: this.identity.videoSidSeed,
      prefix: payload.subarray(0, 108).toString("hex"),
    });
  }

  buildRelayStreamRequestPayload() {
    const s = this.sessionState;
    const payload = Buffer.alloc(0x6c);
    payload[0x00] = 1;
    payload[0x01] = s.relayMode & 0xff;
    payload[0x03] = s.seqByte & 0xff;
    // FIXME(native): p4p_client_send_rlystreamreq fills these from pP4PMgmt
    // source-address fields, not from Node's 0.0.0.0-bound socket.
    payload[0x0c] = 0x0a;
    payload[0x0e] = 0x02;
    payload[0x0f] = 0x0f;
    s.uid.copy(payload, 0x18, 0, 0x14);
    s.sessionBlob108.copy(payload, 0x2c, 0, 0x14);
    payload[0x41] = s.avKind & 0xff;
    payload[0x42] = s.localSid & 0xff;
    payload.writeUInt32LE(s.randomId >>> 0, 0x48);
    s.sessionBlobF8.copy(payload, 0x4c, 0, 0x10);
    payload[0x5c] = s.streamReqEnabled ? 9 : 0;
    payload[0x5e] = s.reqByteE1 & 0xff;
    payload[0x5f] = (s.streamFlag1 ? 1 : 0) | (s.streamFlag2 ? 2 : 0);
    payload.writeUInt32LE(s.clientStartSecond >>> 0, 0x64);
    return payload;
  }

  buildLegacyRelayStreamRequestPayload() {
    const payload = Buffer.alloc(108);
    payload[0] = 1;
    payload[3] = this.identity.deviceType || 2;
    payload[12] = 0x0a;
    payload[14] = 0x02;
    payload[15] = 0x0f;
    payload.writeUInt32LE(crypto.randomBytes(4).readUInt32LE(0) & 0xffff, 16);
    toFixedAsciiBuffer(this.identity.uid, 20).copy(payload, 24);
    toFixedAsciiBuffer(this.identity.loginId, 16).copy(payload, 44);
    payload[66] = this.identity.videoSidSeed & 0xff;
    payload.writeUInt32LE(this.randomId, 72);
    toFixedAsciiBuffer(this.identity.loginPwd || "admin", 20).copy(payload, 76);
    payload[92] = 9;
    payload[95] = 1;
    payload.writeUInt32LE(this.identity.zoneId || 0, 100);
    return payload;
  }

  sendAlive() {
    if (!this.relayPeer) return;
    const s = this.sessionState;
    const isLanState = s.state === 7 || s.state === 8;
    const payload = Buffer.alloc(20);
    payload[0] = s.localSid & 0xff;
    payload[1] = this.channel & 0xff;
    payload.writeUInt16LE(s.peerValue08 & 0xffff, 2);
    payload.writeUInt32LE(s.randomId >>> 0, 4);
    payload.writeUInt16LE(s.localSid & 0xffff, 8);
    payload.writeUInt32LE(s.randomId >>> 0, 12);
    const packet = buildPacket({
      msg: 0x1405,
      payload,
      sidOrChannel: s.localSid & 0xffff,
      msgLen: isLanState ? 0x21 : 0x24,
      seqOrParam: isLanState ? s.peerSidByte & 0xffff : s.peerValue0a & 0xffff,
      kind: this.channel & 0xff,
    });
    this.send(this.relayPeer.address, this.relayPeer.port, packet, true);
    this.sessionState.aliveSendCount += 1;
    this.counters.alivePackets += 1;
  }

  sendKnock(reason = "knock", destination = null) {
    const target = destination || this.relayPeer;
    if (!target) return false;
    const s = this.sessionState;
    const payload = Buffer.alloc(0x44);

    s.uid.copy(payload, 0x00, 0, 0x14);
    s.sessionBlob108.copy(payload, 0x14, 0, 0x14);
    payload[0x2a] = s.localSid & 0xff;
    payload[0x2b] = s.peerSidByte & 0xff;
    payload.writeUInt16LE(s.peerValue08 & 0xffff, 0x2c);
    payload.writeUInt16LE(s.peerValue0a & 0xffff, 0x2e);
    payload.writeUInt32LE(s.randomId >>> 0, 0x30);
    s.sessionBlobF8.copy(payload, 0x34, 0, 0x10);

    const packet = buildPacket({
      msg: 0x130b,
      payload,
      msgLen: 0x21,
      flag: s.seqByte & 0xff,
    });
    this.send(target.address, target.port, packet, true);
    this.counters.knockPackets += 1;
    this.manager.emit("knock-sent", {
      reason,
      packets: this.counters.knockPackets,
      to: `${target.address}:${target.port}`,
      localSid: s.localSid,
      peerSidByte: s.peerSidByte,
      peerValue08: s.peerValue08,
      peerValue0a: s.peerValue0a,
      seqByte: s.seqByte,
      prefix: payload.toString("hex"),
    });
    return true;
  }

  startPunchRetries() {
    clearInterval(this.punchTimer);
    this.knockRetriesLeft = 6;
    this.punchTimer = setInterval(() => {
      if (!this.relayEstablished || !this.relayPeer || this.sessionState.state !== 6) {
        clearInterval(this.punchTimer);
        this.punchTimer = null;
        return;
      }
      if (this.knockRetriesLeft <= 0) {
        this.sessionState.state = 5;
        clearInterval(this.punchTimer);
        this.punchTimer = null;
        this.manager.emit("punch-retries-expired", { state: this.sessionState.state });
        return;
      }
      this.knockRetriesLeft -= 1;
      this.sendKnock("punch-timer");
    }, 1000);
  }

  handleKnockResponse(payload, rinfo) {
    const s = this.sessionState;
    const status = payload.length >= 0x16 ? payload.readInt16LE(0x14) : null;
    const avState = payload.length > 0x16 ? payload[0x16] : null;
    const avKind = payload.length > 0x19 ? payload[0x19] : this.channel;
    const localSid = payload.length > 0x1a ? payload[0x1a] : s.localSid;
    const peerSidByte = payload.length > 0x1b ? payload[0x1b] : s.peerSidByte;
    const peerValue08 = payload.length >= 0x1e ? payload.readUInt16LE(0x1c) : s.peerValue08;
    const peerValue0a = payload.length >= 0x20 ? payload.readUInt16LE(0x1e) : s.peerValue0a;

    if (!NON_LAN_KNOCK_STATES.has(s.state)) {
      this.manager.emit("knock-rsp-ignored", {
        from: `${rinfo.address}:${rinfo.port}`,
        state: s.state,
        status,
        avState,
        reason: "native-state-not-punchable-non-lan",
        prefix: payload.subarray(0, 80).toString("hex"),
      });
      return;
    }

    if (payload.length > 0x1a) s.localSid = localSid & 0xff;
    if (payload.length > 0x1b) s.peerSidByte = peerSidByte & 0xff;
    if (payload.length >= 0x1e) s.peerValue08 = peerValue08 & 0xffff;
    if (payload.length >= 0x20) s.peerValue0a = peerValue0a & 0xffff;
    if (payload.length > 0x19) {
      s.avKind = avKind & 0xff;
      this.channel = s.avKind;
    }
    const previousPeer = this.relayPeer ? `${this.relayPeer.address}:${this.relayPeer.port}` : null;
    this.relayPeer = { address: rinfo.address, port: rinfo.port };
    this.videoSid = s.localSid;
    this.sid = s.peerSidByte;
    this.remoteSid = s.peerValue0a;
    s.state = 7;
    this.relayEstablished = true;
    this.relayPendingSince = null;
    clearInterval(this.relayTimer);
    this.relayTimer = null;
    clearInterval(this.punchTimer);
    this.punchTimer = null;
    this.resetLiveCount("knock-rsp");
    this.manager.emit("knock-rsp", {
      from: `${rinfo.address}:${rinfo.port}`,
      previousPeer,
      activePeer: `${this.relayPeer.address}:${this.relayPeer.port}`,
      status,
      avState,
      localSid: s.localSid,
      peerSidByte: s.peerSidByte,
      peerValue08: s.peerValue08,
      peerValue0a: s.peerValue0a,
      seqByte: s.seqByte,
      prefix: payload.subarray(0, 80).toString("hex"),
    });
    this.sendKnockAck(payload, rinfo, "knock-rsp");
    this.sendAlive();
  }

  handlePeerKnock(payload, rinfo) {
    const state = this.sessionState.state;
    const from = `${rinfo.address}:${rinfo.port}`;
    if (!NON_LAN_KNOCK_STATES.has(state)) {
      this.manager.emit("knock-peer-ignored", {
        from,
        state,
        reason: "native-state-not-punchable-non-lan",
        prefix: payload.subarray(0, 80).toString("hex"),
      });
      return;
    }
    this.manager.emit("knock-peer", {
      from,
      state,
      prefix: payload.subarray(0, 80).toString("hex"),
    });
    if (!this.sendKnock("knock-peer", { address: rinfo.address, port: rinfo.port })) {
      this.manager.emit("knock-peer-reply-skipped", { from, state, reason: "knock-build-failed" });
    }
  }

  sendKnockAck(knockPayload, rinfo, reason = "knock-ack") {
    const payload = Buffer.alloc(0x24);
    if (knockPayload.length >= 0x20) knockPayload.copy(payload, 0x14, 0x14, 0x20);
    payload.writeUInt32LE(this.sessionState.randomId >>> 0, 0x20);
    const packet = buildPacket({
      msg: 0x130d,
      payload,
      msgLen: 0x21,
      flag: this.sessionState.seqByte & 0xff,
    });
    this.send(rinfo.address, rinfo.port, packet, true);
    this.counters.knockAcks += 1;
    this.manager.emit("knock-ack-sent", {
      reason,
      to: `${rinfo.address}:${rinfo.port}`,
      packets: this.counters.knockAcks,
      seqByte: this.sessionState.seqByte,
      prefix: payload.toString("hex"),
    });
    return true;
  }

  checkVideoWatchdog() {
    const now = Date.now();
    if (!this.relayEstablished || !this.relayPeer) {
      return;
    }
    const quietMs = this.lastH264At ? now - this.lastH264At : now - Date.parse(this.startedAt);
    const transportQuietMs = this.lastKcpInputAt ? now - this.lastKcpInputAt : Infinity;
    if (quietMs < 5000 || now - this.lastVideoKickAt < 5000) return;
    this.lastVideoKickAt = now;
    this.counters.videoKicks += 1;
    const skipped = this.maybeRecoverKcpStall("watchdog");
    this.manager.emit("video-watchdog-kick", {
      quietMs,
      transportQuietMs,
      skipped,
      kicks: this.counters.videoKicks,
      sid: this.sid,
      remoteSid: this.remoteSid,
      videoSid: this.videoSid,
    });
    const relayRenewAfterMs = Number(this.options.relayRenewAfterMs || 15000);
    const relayRenewThrottleMs = Number(this.options.relayRenewThrottleMs || 10000);
    if (transportQuietMs > relayRenewAfterMs && now - this.lastRelayRenewAt > relayRenewThrottleMs) {
      this.renewRelay(transportQuietMs);
      return;
    }
    this.sendStartVideoControl();
  }

  renewRelay(quietMs) {
    this.lastRelayRenewAt = Date.now();
    this.counters.relayRenews += 1;
    this.manager.emit("relay-renew", {
      quietMs,
      renews: this.counters.relayRenews,
      oldSid: this.sid,
      oldRemoteSid: this.remoteSid,
      oldVideoSid: this.videoSid,
    });
    this.relayEstablished = false;
    this.relayPeer = null;
    this.learnedVpgTargets = [];
    clearInterval(this.queryTimer);
    this.queryTimer = null;
    clearInterval(this.relayTimer);
    this.relayTimer = null;
    clearInterval(this.punchTimer);
    this.punchTimer = null;
    this.queryRetriesLeft = Number(this.options.queryRetryAttempts || 10);
    this.relayWakeRetriesLeft = 0;
    this.relayStreamRetriesLeft = 0;
    this.knockRetriesLeft = 0;
    this.relayPendingSince = null;
    this.sessionState.state = 1;
    this.sid = 0;
    this.remoteSid = 0;
    this.videoSid = 0;
    this.resetKcp();
    this.kcpUna = null;
    this.kcpReceivedSns = new Set();
    this.lastKcpSkipAt = 0;
    this.lastStartVideoKcpAt = 0;
    this.sendDiscovery();
    this.queryTimer = setInterval(() => this.queryTick(), Number(this.options.queryRetryMs || 1000));
  }

  sendStartVideoControl() {
    if (!this.options.enableStartVideoControl) {
      this.manager.emit("start-video-skipped", { reason: "disabled-pcap-match" });
      return;
    }
    if (!this.relayPeer || !this.remoteSid) {
      this.manager.emit("start-video-skipped", {
        relay: Boolean(this.relayPeer),
        sid: this.sid,
        remoteSid: this.remoteSid,
      });
      return;
    }
    const payload = Buffer.alloc(16);
    payload[0] = 9;
    payload[1] = 0;
    payload[2] = this.identity.streamIndex & 0xff;
    payload[3] = 1;
    if (this.kcp) return this.sendAvControlKcp(payload, "start-video");
    this.sendAvControlDirect(payload, "start-video");
  }

  sendStopVideoControl(reason = "stop-video") {
    if (!this.relayPeer || !this.remoteSid) return false;
    const payload = Buffer.alloc(16);
    payload[0] = 2;
    payload[1] = 0;
    payload[2] = this.identity.streamIndex & 0xff;
    payload[3] = 1;
    if (this.kcp) return this.sendAvControlKcp(payload, reason);
    return this.sendAvControlDirect(payload, reason);
  }

  sendAvControlDirect(payload, reason) {
    const s = this.sessionState;
    const isLanState = s.state === 7 || s.state === 8;
    const packet = buildPacket({
      msg: 0x1407,
      payload,
      sidOrChannel: s.localSid & 0xffff,
      msgLen: isLanState ? 0x21 : 0x24,
      seqOrParam: isLanState ? s.peerSidByte & 0xffff : s.peerValue0a & 0xffff,
      kind: this.channel & 0xff,
    });
    this.send(this.relayPeer.address, this.relayPeer.port, packet, true);
    this.manager.emit("avctrl-sent", {
      reason,
      command: payload[0],
      to: `${this.relayPeer.address}:${this.relayPeer.port}`,
      sid: this.sid,
      remoteSid: this.remoteSid,
      videoSid: this.videoSid,
      channel: this.channel,
      streamIndex: this.identity.streamIndex,
    });
    return true;
  }

  sendAvControlKcp(payload, reason = "avctrl") {
    if (!this.kcp) return false;
    const record = Buffer.alloc(16 + payload.length);
    record.writeUInt16LE(1, 0);
    record[2] = this.channel & 0xff;
    record[3] = 0;
    record.writeUInt16LE(0, 4);
    record.writeUInt16LE(0, 6);
    record.writeUInt32LE(payload.length, 8);
    record.writeUInt32LE(0, 12);
    payload.copy(record, 16);
    const ret = this.kcp.send(record);
    this.kcp.flush(false);
    if (payload[0] === 9) this.lastStartVideoKcpAt = Date.now();
    this.manager.emit("avctrl-kcp-sent", {
      reason,
      command: payload[0],
      ret,
      bytes: record.length,
      sid: this.sid,
      remoteSid: this.remoteSid,
      conv: this.kcpConv,
      streamIndex: this.identity.streamIndex,
    });
    return ret >= 0;
  }

  sendStartVideoKcp(payload, reason = "start") {
    return this.sendAvControlKcp(payload, reason);
  }

  sendLogoutRequest(reason = "logout") {
    if (!this.relayPeer || !this.sessionState.active) return false;
    const s = this.sessionState;
    const payload = Buffer.alloc(0x54);
    payload[0] = 1;
    payload.writeUInt16LE(s.peerValue08 & 0xffff, 0x40);
    payload.writeUInt32LE(s.randomId >>> 0, 0x44);
    const state = s.state;
    const packet = buildPacket({
      msg: state === 7 || state === 8 ? 0x1309 : 0x1207,
      payload,
      sidOrChannel: s.localSid & 0xffff,
      msgLen: state === 7 || state === 8 ? 0x21 : 0x24,
      seqOrParam: state === 7 || state === 8 ? s.peerSidByte & 0xffff : s.peerValue0a & 0xffff,
      kind: this.channel & 0xff,
    });
    this.send(this.relayPeer.address, this.relayPeer.port, packet, true);
    this.counters.logoutPackets += 1;
    this.manager.emit("logout-req-sent", {
      reason,
      msg: `0x${(state === 7 || state === 8 ? 0x1309 : 0x1207).toString(16)}`,
      packets: this.counters.logoutPackets,
      sid: this.sid,
      remoteSid: this.remoteSid,
      localSid: s.localSid,
      peerValue0a: s.peerValue0a,
    });
    return true;
  }

  observeVideoRecord(record) {
    if (!this.options.enableRdtAck) return;
    if (!record || !Number.isFinite(record.frameSeq)) return;
    const seq = record.frameSeq & 0xffff;
    this.rdtAckState.lastFrameSeq = seq;
    this.rdtAckState.hasFrame = true;
    this.rdtAckState.receivedFrameSeqs.add(seq);

    const floor = seqMinus(seq, 254);
    this.rdtAckState.receivedFrameSeqs = new Set(
      [...this.rdtAckState.receivedFrameSeqs].filter((value) => seqDistance(floor, value) <= 254),
    );
    if (Date.now() - this.lastRdtAckAt >= Number(this.options.rdtAckMinIntervalMs || 20)) {
      this.sendRdtVideoAck("frame");
    }
  }

  sendRdtVideoAck(reason = "timer") {
    if (!this.relayEstablished || !this.relayPeer) return false;
    if (!this.rdtAckState.hasFrame) return false;
    const payload = buildRdtAckPayload(this.rdtAckState);
    const s = this.sessionState;
    const packet = buildPacket({
      msg: 0x1403,
      payload,
      sidOrChannel: s.localSid & 0xffff,
      msgLen: 0x24,
      seqOrParam: s.peerValue0a & 0xffff,
      kind: this.channel & 0xff,
    });
    this.send(this.relayPeer.address, this.relayPeer.port, packet, true);
    this.lastRdtAckAt = Date.now();
    this.counters.rdtAckPackets += 1;
    if (this.counters.rdtAckPackets <= 5 || this.counters.rdtAckPackets % 100 === 0) {
      this.manager.emit("rdt-video-ack-sent", {
        reason,
        packets: this.counters.rdtAckPackets,
        lastFrameSeq: this.rdtAckState.lastFrameSeq,
        received: this.rdtAckState.receivedFrameSeqs.size,
        bytes: payload.length,
        prefix: payload.subarray(0, 48).toString("hex"),
      });
    }
    return true;
  }

  handleQueryResponse(payload, rinfo) {
    const status = payload.length >= 2 ? payload.readInt16LE(0) : null;
    const uid = payload.length >= 0x18 ? readFixedAsciiBuffer(payload.subarray(4, 0x18)) : "";
    const vpgMapVersion = payload.length >= 0x1c ? payload.readUInt32LE(0x18) : null;
    const vpgItem = parseNativeVpgItem(payload);
    const query = {
      from: `${rinfo.address}:${rinfo.port}`,
      status,
      uid,
      vpgMapVersion,
      vpgId: vpgItem.vpgId,
      vpgFlags: vpgItem.flags,
      relayTargets: vpgItem.targets,
      relayTargetCount: vpgItem.targets.length,
      ipv6RelayTargetCount: vpgItem.ipv6Targets.length,
      ipv6RelayTargets: vpgItem.ipv6Targets,
      state: this.sessionState.state,
      prefix: payload.subarray(0, Math.min(payload.length, 64)).toString("hex"),
      vpgPrefix: vpgItem.prefix,
    };
    this.manager.emit("p4p-query-rsp", query);

    if (status === -0x7d1) {
      this.manager.emit("p4p-query-rsp-error", { ...query, reason: "native-query-error" });
      this.manager.restartSession(this, "p4p-query-rsp-error", { status });
      return;
    }

    if (this.sessionState.state === 1) {
      this.beginRelayWakeup("query-rsp", rinfo, query);
      return;
    }

    if (this.sessionState.state === 2) {
      this.learnedVpgTargets = uniqueTargets(query.relayTargets);
      this.sendRelayWakeup("query-rsp-repeat");
      return;
    }

    this.manager.emit("p4p-query-rsp-ignored", {
      ...query,
      reason: "native-state-not-query-or-wakeup",
    });
  }

  handleDatagram(raw, rinfo) {
    this.counters.rx += 1;
    const decoded = decodeDatagram(raw);
    if (!decoded.header) {
      this.manager.emit("udp-undecoded", { from: `${rinfo.address}:${rinfo.port}`, bytes: raw.length });
      return;
    }
    this.counters.decoded += 1;
    const { clear, header } = decoded;
    const payload = clear.subarray(16, 16 + Math.min(header.length, clear.length - 16));
    this.manager.emit("p4p-packet", {
      from: `${rinfo.address}:${rinfo.port}`,
      encrypted: decoded.encrypted,
      msg: `0x${header.msg.toString(16)}`,
      name: describeMsg(header.msg),
      len: header.length,
      msgLen: header.msgLen,
      sidOrChannel: header.sidOrChannel,
      seqOrParam: header.seqOrParam,
      kind: header.kind,
      flag: header.flag,
      state: this.sessionState.state,
    });

    if (header.msg === 0x1052) {
      this.handleQueryResponse(payload, rinfo);
    } else if (header.msg === 0x1202) {
      if (this.relayEstablished) return;
      const statusByte = payload.length > 0x28 ? payload[0x28] : null;
      const responseCount = payload.length > 0 ? payload[0] : null;
      this.manager.emit("relay-wakeup-rsp", {
        from: `${rinfo.address}:${rinfo.port}`,
        statusByte,
        responseCount,
        prefix: payload.subarray(0, Math.min(payload.length, 64)).toString("hex"),
      });
      if (this.sessionState.state !== 2) {
        this.manager.emit("relay-wakeup-ignored", {
          from: `${rinfo.address}:${rinfo.port}`,
          statusByte,
          state: this.sessionState.state,
          reason: "native-state-not-waiting-for-wakeup",
        });
        return;
      }
      if (this.options.requireWakeupReadyStatus && statusByte !== null && statusByte !== 2) {
        this.manager.emit("relay-wakeup-ignored", {
          from: `${rinfo.address}:${rinfo.port}`,
          statusByte,
          reason: "native-status-not-ready",
        });
        return;
      }
      this.resetLiveCount("relay-wakeup-rsp");
      this.beginRelayStreamRequest(rinfo.address, rinfo.port, "wakeup-rsp");
    } else if (header.msg === 0x1206) {
      if (this.relayEstablished) return;
      this.relayPeer = { address: rinfo.address, port: rinfo.port };
      if (!this.applyRelayStreamResponse(payload)) return;
      clearInterval(this.relayTimer);
      this.relayTimer = null;
      this.videoSid = this.sessionState.localSid;
      this.sid = this.sessionState.peerSidByte;
      this.remoteSid = this.sessionState.peerValue0a;
      this.channel = this.sessionState.avKind || this.identity.channel || 0;
      this.sessionState.state = 6;
      this.relayEstablished = true;
      this.relayPendingSince = null;
      this.resetLiveCount("relay-stream-rsp");
      this.manager.emit("relay-stream-rsp", {
        sid: this.sid,
        remoteSid: this.remoteSid,
        videoSid: this.videoSid,
        channel: this.channel,
        peerSidByte: this.sessionState.peerSidByte,
        peerValue08: this.sessionState.peerValue08,
        peerValue0a: this.sessionState.peerValue0a,
        prefix: payload.subarray(0, 80).toString("hex"),
      });
      this.sendKnock("relay-stream-rsp");
      this.startPunchRetries();
      this.sendAlive();
      this.sendStartVideoControl();
    } else if (header.msg === 0x130c) {
      this.handleKnockResponse(payload, rinfo);
    } else if (header.msg === 0x130e) {
      this.handlePeerKnock(payload, rinfo);
    } else if (IGNORED_LAN_STREAM_MESSAGES.has(header.msg)) {
      this.manager.emit("lan-message-ignored", {
        from: `${rinfo.address}:${rinfo.port}`,
        msg: `0x${header.msg.toString(16)}`,
        name: describeMsg(header.msg),
        state: this.sessionState.state,
        reason: "lan-state-machine-disabled",
        prefix: payload.subarray(0, Math.min(payload.length, 80)).toString("hex"),
      });
    } else if (header.msg === 0x1406 || header.msg === 0x140a) {
      this.resetLiveCount(header.msg === 0x1406 ? "alive" : "kcp");
      if (header.msg === 0x1406) this.lastAliveAt = Date.now();
      if (header.msg === 0x140a && header.sidOrChannel && header.sidOrChannel !== this.remoteSid) {
        const previous = this.remoteSid;
        this.remoteSid = header.sidOrChannel;
        this.sessionState.peerValue0a = header.sidOrChannel;
        this.manager.emit("remote-sid-learned", { previous, remoteSid: this.remoteSid, msg: `0x${header.msg.toString(16)}` });
      }
      if (header.seqOrParam && header.seqOrParam !== this.videoSid) {
        const previous = this.videoSid;
        this.videoSid = header.seqOrParam;
        this.manager.emit("video-sid-learned", { previous, videoSid: this.videoSid, msg: `0x${header.msg.toString(16)}` });
      }
      if (header.msg === 0x140a) {
        const kcpBytes = clear.subarray(16, 16 + header.length);
        this.handleKcpDatagram(kcpBytes, header, rinfo);
      }
    } else if (header.msg === 0x1404) {
      this.resetLiveCount("rdt");
      this.handleRdtDatagram(payload, header, rinfo);
    } else if (header.msg === 0x1409) {
      this.resetLiveCount("kcp");
      const kcpBytes = clear.subarray(16, 16 + header.length);
      this.handleKcpDatagram(kcpBytes, header, rinfo);
    } else if (header.msg === 0x1208) {
      this.manager.emit("logout-rsp", { sidOrChannel: header.sidOrChannel, seqOrParam: header.seqOrParam, prefix: payload.subarray(0, 64).toString("hex") });
      this.sessionState.active = false;
    }
  }

  applyRelayStreamResponse(payload) {
    if (!payload || payload.length < 0x40) return false;
    const recordOffset = 0x18;
    const status = payload.readInt16LE(recordOffset);
    const avKind = payload[recordOffset + 0x1d];
    const sessionIndex = payload[recordOffset + 0x1e];
    const peerSidByte = payload[recordOffset + 0x1f];
    const peerValue08 = payload.readUInt16LE(recordOffset + 0x20);
    const peerValue0a = payload.readUInt16LE(recordOffset + 0x22);
    const randomId = payload.readUInt32LE(recordOffset + 0x24);
    if (randomId !== this.randomId) {
      this.manager.emit("relay-stream-rsp-ignored", {
        reason: "native-random-id-mismatch",
        status,
        randomId,
        expectedRandomId: this.randomId,
        prefix: payload.subarray(0, 80).toString("hex"),
      });
      return false;
    }
    if (status !== 0) {
      this.manager.emit("relay-stream-rsp-ignored", {
        reason: "native-status-error",
        status,
        randomId,
        prefix: payload.subarray(0, 80).toString("hex"),
      });
      return false;
    }
    this.sessionState.avKind = avKind;
    this.sessionState.sessionIndex = sessionIndex;
    this.sessionState.localSid = sessionIndex;
    this.sessionState.peerSidByte = peerSidByte;
    this.sessionState.peerValue08 = peerValue08;
    this.sessionState.peerValue0a = peerValue0a;
    return true;
  }

  handleKcpDatagram(kcpBytes, header, rinfo) {
    const segments = parseKcpSegments(kcpBytes);
    if (!segments.length) {
      this.manager.emit("kcp-unparsed", { from: `${rinfo.address}:${rinfo.port}`, bytes: kcpBytes.length, prefix: kcpBytes.subarray(0, 48).toString("hex") });
      return;
    }
    this.counters.kcpSegments += segments.length;
    const dataSegments = [];
    for (const segment of segments) {
      this.manager.emit("kcp-segment", {
        conv: segment.conv,
        cmd: `0x${segment.cmd.toString(16)}`,
        frg: segment.frg,
        sn: segment.sn,
        una: segment.una,
        len: segment.len,
        p4pKind: header.kind,
      });
      if (segment.cmd === 0x51) dataSegments.push(segment);
    }
    if (!this.ensureKcp(segments[0].conv)) return;
    this.lastKcpHeader = header;
    this.lastKcpInputAt = Date.now();
    if (!this.lastStartVideoKcpAt && this.options.enableStartVideoControl) this.sendStartVideoControl();
    const beforeQueue = this.kcp.rcv_queue.length;
    const result = this.kcp.input(kcpBytes, true, true);
    if (typeof result === "number" && result < 0) {
      this.counters.kcpInputErrors += 1;
      this.manager.emit("kcp-input-error", {
        code: result,
        conv: this.kcpConv,
        bytes: kcpBytes.length,
        errors: this.counters.kcpInputErrors,
        prefix: kcpBytes.subarray(0, 48).toString("hex"),
      });
      return;
    }
    if (dataSegments.length) {
      this.trackKcpReceipt(dataSegments.map((segment) => segment.sn));
    }
    this.drainKcpMessages();
    if (this.kcp.rcv_queue.length !== beforeQueue || dataSegments.length) {
      this.kcpStateEvents += 1;
      if (this.kcpStateEvents <= 5 || this.kcpStateEvents % 100 === 0) {
        this.manager.emit("kcp-state", {
          conv: this.kcpConv,
          rcvNxt: this.kcp.rcv_nxt,
          rcvQueue: this.kcp.rcv_queue.length,
          rcvBuf: this.kcp.rcv_buf.length,
          sndUna: this.kcp.snd_una,
          sndNxt: this.kcp.snd_nxt,
        });
      }
    }
  }

  handleRdtDatagram(payload, header, rinfo) {
    const block = parseRdtBlock(payload);
    if (!block) {
      this.manager.emit("rdt-unparsed", { from: `${rinfo.address}:${rinfo.port}`, bytes: payload.length, prefix: payload.subarray(0, 48).toString("hex") });
      return;
    }
    this.counters.rdtPackets += 1;
    this.rdtAckState.lastFrameSeq = block.blockSeq;
    this.rdtAckState.hasFrame = true;
    this.rdtAckState.receivedFrameSeqs.add(block.blockSeq);
    if (this.rdtAckState.receivedFrameSeqs.size > 512) {
      this.rdtAckState.receivedFrameSeqs = new Set([...this.rdtAckState.receivedFrameSeqs].slice(-256));
    }

    const key = `${block.frameId}:${block.frameNo}`;
    let frame = this.rdtFrames.get(key);
    if (!frame) {
      frame = {
        createdAt: Date.now(),
        expectedBlocks: Math.max(1, block.blocksInFrame || block.blockCount || 1),
        fullFrameLen: block.fullFrameLen,
        blocks: new Map(),
      };
      this.rdtFrames.set(key, frame);
    }
    frame.blocks.set(block.blockIndex, Buffer.from(block.payload));

    if (this.counters.rdtPackets <= 5 || this.counters.rdtPackets % 50 === 0) {
      this.manager.emit("rdt-block", {
        type: `0x${block.type.toString(16)}`,
        flags: `0x${block.flags.toString(16)}`,
        frameId: block.frameId,
        frameNo: block.frameNo,
        blockSeq: block.blockSeq,
        blockIndex: block.blockIndex,
        blocks: frame.blocks.size,
        expectedBlocks: frame.expectedBlocks,
      });
    }

    if (Date.now() - this.lastRdtAckAt >= Number(this.options.rdtAckMinIntervalMs || 20)) {
      this.sendRdtVideoAck("rdt-block");
    }

    if (frame.blocks.size < frame.expectedBlocks) {
      this.pruneRdtFrames();
      return;
    }

    const parts = [];
    for (let i = 0; i < frame.expectedBlocks; i += 1) {
      const part = frame.blocks.get(i);
      if (!part) return;
      parts.push(part);
    }
    let data = Buffer.concat(parts);
    if (frame.fullFrameLen > 0 && data.length > frame.fullFrameLen) data = data.subarray(0, frame.fullFrameLen);
    this.rdtFrames.delete(key);
    this.counters.rdtFrames += 1;
    this.processVideoPayload(data, {
      source: "rdt",
      streamByte: header.kind,
      frameSeq: block.frameNo,
      frameMeta: { cam: block.type === 0x09 ? 1 : 0, timestamp: Date.now() >>> 0 },
    });
  }

  pruneRdtFrames() {
    const cutoff = Date.now() - 5000;
    for (const [key, frame] of this.rdtFrames) {
      if (frame.createdAt < cutoff) {
        this.rdtFrames.delete(key);
        this.counters.rdtFrameDrops += 1;
      }
    }
  }

  resetKcp() {
    if (this.kcp) this.kcp.release();
    this.kcp = null;
    this.kcpConv = null;
    this.lastKcpHeader = null;
    this.kcpStateEvents = 0;
  }

  ensureKcp(conv) {
    if (!Number.isFinite(conv)) return false;
    if (this.kcp && this.kcpConv === conv) return true;
    if (this.kcp && this.kcpConv !== conv) {
      this.manager.emit("kcp-conv-changed", { previous: this.kcpConv, next: conv });
      this.resetKcp();
    }
    this.kcpConv = conv;
    this.kcp = new Kcp(conv, { session: this });
    this.kcp.setMtu(0x518);
    this.kcp.setNoDelay(1, 10, 0, 1);
    this.kcp.setWndSize(0x80, 0x100);
    this.kcp.rx_minrto = 0x0c;
    this.kcp.nocwnd = 0;
    this.kcp.setOutput((data, size) => this.sendKcpOutput(data, size));
    this.manager.emit("kcp-created", {
      conv,
      sndWnd: this.kcp.snd_wnd,
      rcvWnd: this.kcp.rcv_wnd,
      mtu: this.kcp.mtu,
      mss: this.kcp.mss,
      interval: this.kcp.interval,
      rxMinRto: this.kcp.rx_minrto,
      nocwnd: this.kcp.nocwnd,
    });
    return true;
  }

  trackKcpReceipt(sns) {
    for (const sn of sns) this.kcpReceivedSns.add(sn);
    const minSn = Math.min(...sns);
    if (this.kcpUna === null || minSn < this.kcpUna) this.kcpUna = minSn;
    while (this.kcpReceivedSns.has(this.kcpUna)) {
      this.kcpReceivedSns.delete(this.kcpUna);
      this.kcpUna += 1;
    }
    if (this.kcpReceivedSns.size > 2048) {
      const floor = (this.kcpUna || 0) - 1;
      this.kcpReceivedSns = new Set([...this.kcpReceivedSns].filter((value) => value > floor).slice(-1024));
    }
  }

  sendKcpOutput(data, size) {
    if (!this.relayPeer || !size) return;
    const payload = Buffer.from(data.subarray(0, size));
    const header = this.lastKcpHeader;
    const s = this.sessionState;
    const isLanState = s.state === 7 || s.state === 8;
    const packet = buildPacket({
      msg: 0x1409,
      payload,
      sidOrChannel: isLanState ? s.localSid & 0xffff : s.peerSidByte & 0xffff,
      msgLen: isLanState ? 0x21 : 0x24,
      seqOrParam: isLanState ? s.peerSidByte & 0xffff : s.peerValue0a & 0xffff,
      kind: this.channel & 0xff,
    });
    this.send(this.relayPeer.address, this.relayPeer.port, packet, true);
    this.counters.kcpOutputPackets += 1;
    if (this.counters.kcpOutputPackets <= 5 || this.counters.kcpOutputPackets % 50 === 0) {
      this.manager.emit("kcp-output-sent", { bytes: payload.length, packets: this.counters.kcpOutputPackets, prefix: payload.subarray(0, 24).toString("hex") });
    }
  }

  promoteKcpReceiveBuffer() {
    if (!this.kcp) return 0;
    let count = 0;
    for (const segment of this.kcp.rcv_buf) {
      if (segment.sn !== this.kcp.rcv_nxt || this.kcp.rcv_queue.length + count >= this.kcp.rcv_wnd) break;
      this.kcp.rcv_nxt += 1;
      count += 1;
    }
    if (count > 0) {
      this.kcp.rcv_queue.push(...this.kcp.rcv_buf.slice(0, count));
      this.kcp.rcv_buf.splice(0, count);
    }
    return count;
  }

  forceKcpLiveSkip(reason) {
    if (!this.kcp) return false;
    let droppedQueued = 0;
    let skippedSequences = 0;

    if (this.kcp.peekSize() < 0 && this.kcp.rcv_queue.length > 0) {
      do {
        const [segment] = this.kcp.rcv_queue.splice(0, 1);
        droppedQueued += 1;
        if (segment?.frg === 0) break;
      } while (this.kcp.rcv_queue.length > 0);
    }

    if (this.kcp.rcv_queue.length === 0 && this.kcp.rcv_buf.length > 0) {
      const next = this.kcp.rcv_buf[0].sn;
      if (next > this.kcp.rcv_nxt) {
        skippedSequences = next - this.kcp.rcv_nxt;
        this.kcp.rcv_nxt = next;
      }
      this.promoteKcpReceiveBuffer();
    }

    if (!droppedQueued && !skippedSequences) return false;
    this.counters.kcpGapDrops += 1;
    this.manager.emit("kcp-live-skip", {
      reason,
      drops: this.counters.kcpGapDrops,
      droppedQueued,
      skippedSequences,
      rcvNxt: this.kcp.rcv_nxt,
      rcvQueue: this.kcp.rcv_queue.length,
      rcvBuf: this.kcp.rcv_buf.length,
    });
    this.drainKcpMessages();
    return true;
  }

  maybeRecoverKcpStall(reason) {
    if (!this.kcp) return false;
    const now = Date.now();
    if (now - this.lastKcpSkipAt < Number(this.options.kcpSkipThrottleMs || 1500)) return false;
    const messageQuietMs = this.lastKcpMessageAt ? now - this.lastKcpMessageAt : Infinity;
    if (messageQuietMs < Number(this.options.kcpSkipAfterMs || 2500)) return false;
    if (!this.kcp.rcv_queue.length && !this.kcp.rcv_buf.length) return false;
    this.lastKcpSkipAt = now;
    return this.forceKcpLiveSkip(reason);
  }

  updateKcp() {
    if (!this.kcp) return;
    this.kcp.update();
    this.drainKcpMessages();
    this.maybeRecoverKcpStall("timer");
  }

  drainKcpMessages() {
    if (!this.kcp) return;
    for (;;) {
      const size = this.kcp.peekSize();
      if (size <= 0) return;
      const out = Buffer.alloc(size);
      const read = this.kcp.recv(out);
      if (read <= 0) return;
      this.handleKcpMessage(out.subarray(0, read));
    }
  }

  handleKcpMessage(message) {
    this.counters.kcpMessages += 1;
    this.lastKcpMessageAt = Date.now();
    const record = parseInnerRecord(message);
    if (!record) {
      this.manager.emit("kcp-message", { bytes: message.length, parsed: false });
      return;
    }
    const isVideo = record.type === 0x11 || record.type === 0x14;
    this.manager.emit("inner-record", {
      type: `0x${record.type.toString(16)}`,
      streamByte: record.streamByte,
      recordLength: record.recordLength,
      payloadBytes: record.payload.length,
      frameSeq: record.frameSeq,
      video: isVideo,
      annexB: isAnnexB(record.payload),
      frameMeta: record.frameMeta,
      frameInfoPrefix: record.frameInfo.subarray(0, 16).toString("hex"),
      prefix: record.payload.subarray(0, 16).toString("hex"),
    });
    if (isVideo) {
      this.counters.videoFrames += 1;
      this.processVideoPayload(record.payload, { source: "kcp", streamByte: record.streamByte, frameSeq: record.frameSeq, frameMeta: record.frameMeta });
    }
  }

  processVideoPayload(payload, meta = {}) {
    const annexB = extractAnnexB(payload);
    if (annexB) {
      if (this.dumpFile) {
        fs.appendFileSync(this.dumpFile, annexB);
      }
      this.counters.annexBFrames += 1;
      this.counters.bytesWritten += annexB.length;
      const clean = normalizeAnnexB(annexB);
      if (clean) {
        if (!this.streamFormat) {
          this.streamFormat = detectStreamFormat(clean);
          if (this.streamFormat) {
            this.streamCodec = buildWebCodecsCodecString(clean, this.streamFormat);
            this.manager.emit("stream-codec-learned", {
              format: this.streamFormat,
              codec: this.streamCodec,
              frameMeta: meta.frameMeta,
            });
          }
        } else if (!this.streamCodec) {
          this.streamCodec = buildWebCodecsCodecString(clean, this.streamFormat);
        }
        // Native OnLiveVideoStateCallback only routes cam_index to sensor1 for
        // DeviceUtil.is2CameraSendSor(), i.e. vrexttype 8 or 9.
        const track = isNativeTwoSensorDevice(this.identity) && meta.frameMeta?.cam === 1 ? "secondary" : "primary";
        this.broadcastH264(clean, track);
        if (track === "primary") this.broadcastMp4(clean);
      } else {
        this.counters.h264DroppedFrames += 1;
        if (this.counters.h264DroppedFrames <= 5 || this.counters.h264DroppedFrames % 30 === 0) {
          this.manager.emit("h264-frame-dropped", {
            reason: "no-annexb-nals",
            source: meta.source,
            streamByte: meta.streamByte,
            frameSeq: meta.frameSeq,
            frameMeta: meta.frameMeta,
            bytes: annexB.length,
            nalTypes: summarizeNalUnits(annexB),
            dropped: this.counters.h264DroppedFrames,
          });
        }
      }
    }
  }

  broadcastH264(annexB, track = "primary") {
    this.lastH264At = Date.now();
    const state = this.h264Track(track);
    state.backlog.push(annexB);
    state.backlog = state.backlog.slice(-450);
    const packet = framePacket(annexB);
    for (const client of [...state.clients]) {
      try {
        client.res.write(packet);
      } catch {
        state.clients.delete(client);
      }
    }
    this.updateH264ClientCounter();
    this.counters.h264Frames += 1;
    state.frames += 1;
    if (this.counters.h264Frames <= 5 || this.counters.h264Frames % 30 === 0) {
      this.manager.emit("h264-frame", { track, bytes: annexB.length, clients: state.clients.size, backlog: state.backlog.length });
    }
  }

  broadcastMp4(annexB) {
    const muxed = this.muxer.pushAnnexB(annexB);
    if (!muxed) return;
    this.mp4Backlog.push(muxed.fragment);
    this.mp4Backlog = this.mp4Backlog.slice(-120);
    for (const client of [...this.mp4Clients]) {
      try {
        if (!client.initSent) {
          client.res.write(muxed.init);
          client.initSent = true;
        }
        client.res.write(muxed.fragment);
      } catch {
        this.mp4Clients.delete(client);
      }
    }
    this.counters.mp4Clients = this.mp4Clients.size;
    this.counters.mp4Fragments += 1;
    this.manager.emit("mp4-fragment", {
      bytes: muxed.fragment.length,
      codec: muxed.codec,
      keyframe: muxed.keyframe,
      clients: this.mp4Clients.size,
    });
  }
}

module.exports = {
  UBoxLiveStreamManager,
  getDeviceIdentity,
  parseInnerRecord,
  parseKcpSegments,
};
