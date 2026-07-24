'use strict';

/**
 * h264-rtsp.js
 * ---------------------------------------------------------------------------
 * Always-on HTTP -> RTSP bridge for the existing `/api/stream/live.h264` source.
 *
 * No system-installed ffmpeg/ffprobe and no separate RTSP server binary
 * (e.g. MediaMTX) required — everything is provided by npm packages:
 *
 *   npm install ffmpeg-static ffprobe-static rtsp-streaming-server
 *
 * As soon as this file is required, it:
 *   1. Starts an in-process RTSP server (rtsp-streaming-server).
 *   2. Pulls BOTH the "primary" and "secondary" tracks from:
 *        http://127.0.0.1:<server_port>/api/stream/live.h264?track=primary
 *        http://127.0.0.1:<server_port>/api/stream/live.h264?track=secondary
 *   3. Publishes each into the RTSP server via ffmpeg.
 *
 * Viewers connect to:
 *   rtsp://localhost:<rtsp_port>/primary
 *   rtsp://localhost:<rtsp_port>/secondary
 *
 * `rtsp_port` (from .env) is the CLIENT/viewer-facing port. Internally,
 * ffmpeg publishes to a separate "producer" port, which defaults to
 * `rtsp_port + 1` unless you set `rtsp_publish_port` explicitly in .env.
 * This split exists because rtsp-streaming-server listens for producers
 * and consumers on two different ports.
 *
 * Usage:
 *   require('./h264-rtsp.js'); // side-effecting import — starts everything
 *
 * `server_port` and `rtsp_port` (and optionally `rtsp_publish_port`,
 * `rtsp_rtp_port_start`, `rtsp_rtp_port_count`) are read from .env.
 * ---------------------------------------------------------------------------
 * NOTE: THIS CODE IS FULLY VIBECODED, IT HAS NOT BEEN REVIEWED (ONLY TESTED)!
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const RtspServer = require('rtsp-streaming-server').default;
const { logDebug } = require('./helpers.js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRACKS = ['primary', 'secondary'];
const RESTART_DELAY_MS = 2000;           // base delay before restarting a crashed track
const RESTART_DELAY_MAX_MS = 15000;      // cap for backoff
const CODEC_PROBE_TIMEOUT_MS = 8000;

// How often to surface a heartbeat log while a track is stuck in "source not
// available yet" failures. 1 = log the first failure, then every Nth after.
const QUIET_LOG_EVERY_N = 10;

// Failure text matching any of these is treated as "the H.264 source isn't
// up yet" rather than a real problem — expected while the stream hasn't been
// started via its API, so it gets logged rarely instead of on every retry.
const QUIET_ERROR_PATTERNS = [
    /connection refused/i,
    /no route to host/i,
    /network is unreachable/i,
    /connection timed out/i,
    /operation timed out/i,
    /failed to connect/i,
    /server returned 4\d\d/i,
    /server returned 5\d\d/i,
    /server returned 5xx/i,
    /invalid data found when processing input/i,
    /could not find codec parameters/i,
    /end of file/i,
    /immediate exit requested/i,
    /announce failed/i,
    /service unavailable/i
];

function isQuietError(text) {
    return QUIET_ERROR_PATTERNS.some((re) => re.test(text || ''));
}

// Logs "source not up yet" failures sparingly; logs anything else every time.
function reportFailure(track, runner, rawMessage) {
    if (!isQuietError(rawMessage)) {
        logDebug('RTSP push error', { track, error: rawMessage });
        runner.quietFailureCount = 0;
        return;
    }

    runner.quietFailureCount = (runner.quietFailureCount || 0) + 1;

    if (runner.quietFailureCount === 1 || runner.quietFailureCount % QUIET_LOG_EVERY_N === 0) {
        logDebug('RTSP push: H.264 source not available yet, retrying quietly', {
            track,
            attempts: runner.quietFailureCount
        });
    }
}

// ---------------------------------------------------------------------------
// (Logging comes from helpers.js's `logDebug`, imported above.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// .env lookup (generic, with an optional default when the key is missing)
// ---------------------------------------------------------------------------

const envCache = {};
let envFileContents = null;

function readEnvFile() {
    if (envFileContents !== null) return envFileContents;

    let envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
        const altPath = path.resolve(__dirname, '.env');
        if (fs.existsSync(altPath)) envPath = altPath;
    }

    try {
        envFileContents = fs.readFileSync(envPath, 'utf8');
    } catch (err) {
        envFileContents = ''; // no .env file — fall back to defaults / process.env only
    }

    return envFileContents;
}

function loadEnvValue(key, defaultValue) {
    if (envCache[key] !== undefined) return envCache[key];

    const envKey = key.toUpperCase();
    if (process.env[key] || process.env[envKey]) {
        envCache[key] = process.env[key] || process.env[envKey];
        return envCache[key];
    }

    const contents = readEnvFile();
    for (const rawLine of contents.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) continue;

        const lineKey = line.slice(0, eqIndex).trim();
        let value = line.slice(eqIndex + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        if (lineKey.toLowerCase() === key.toLowerCase()) {
            envCache[key] = value;
            return envCache[key];
        }
    }

    if (defaultValue !== undefined) {
        envCache[key] = defaultValue;
        return envCache[key];
    }

    throw new Error(`h264-rtsp: "${key}" was not found in .env`);
}

function buildSourceUrl(track) {
    const serverPort = loadEnvValue('server_port');
    return `http://127.0.0.1:${serverPort}/api/stream/live.h264?track=${encodeURIComponent(track)}`;
}

// ---------------------------------------------------------------------------
// Codec detection (source may say .h264 but actually be H.265)
// ---------------------------------------------------------------------------

function detectCodec(sourceUrl) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            sourceUrl
        ];

        execFile(ffprobePath, args, { timeout: CODEC_PROBE_TIMEOUT_MS }, (err, stdout) => {
            if (err) return reject(new Error(`ffprobe failed: ${err.message}`));

            const codec = stdout.trim().split('\n')[0].trim().toLowerCase();
            if (!codec) return reject(new Error('ffprobe returned no codec_name for the source stream'));

            resolve(codec); // typically 'h264' or 'hevc'
        });
    });
}

// ---------------------------------------------------------------------------
// In-process RTSP server (no MediaMTX / external binary needed)
// ---------------------------------------------------------------------------

const clientPort = Number(loadEnvValue('rtsp_port'));
const publishPort = Number(loadEnvValue('rtsp_publish_port', String(clientPort + 1)));
const rtpPortStart = Number(loadEnvValue('rtsp_rtp_port_start', '10000'));
const rtpPortCount = Number(loadEnvValue('rtsp_rtp_port_count', '200'));

// ---------------------------------------------------------------------------
// Transcode canvas (for the HEVC -> H.264 path only)
// ---------------------------------------------------------------------------
// The source's resolution can change mid-stream. libx264, once initialized
// at a given frame size, cannot handle differently-sized frames without
// crashing — so instead of assuming/capping the SOURCE resolution, we scale
// + pad the decoded output onto a fixed CANVAS before it reaches the
// encoder. The decoder is free to follow the source's actual resolution
// changes; the encoder never sees anything but a constant frame size.
// Override via .env if your cameras exceed 1920x1080 (keep both even).
const CANVAS_WIDTH = Number(loadEnvValue('rtsp_canvas_width', '1920'));
const CANVAS_HEIGHT = Number(loadEnvValue('rtsp_canvas_height', '1080'));

const rtspServer = new RtspServer({
    serverPort: publishPort,   // ffmpeg publishes here
    clientPort: clientPort,    // viewers connect here
    rtpPortStart,
    rtpPortCount,
    // Best-effort extra layer: try to reject a viewer's SETUP before it ever
    // reaches the library's own (buggy) mount-lookup code. If the internal
    // `mounts` accessor isn't there or behaves differently than expected,
    // this just falls through and returns true, so it can't make things
    // worse — the uncaughtException guard above is the real safety net.
    clientServerHooks: {
        checkMount: async (req) => {
            try {
                if (rtspServer.mounts && typeof rtspServer.mounts.getMount === 'function') {
                    const mount = rtspServer.mounts.getMount(req.uri);
                    if (!mount) return 404;
                }
            } catch (err) {
                // Unknown internal shape — don't block on our own uncertainty.
            }
            return true;
        }
    }
});

let rtspServerReady = null; // promise, resolved once the server has started

function ensureRtspServerStarted() {
    if (!rtspServerReady) {
        rtspServerReady = rtspServer.start()
            .then(() => {
                logDebug('RTSP server started', { clientPort, publishPort });
            })
            .catch((err) => {
                logDebug('RTSP server failed to start', { error: err.message });
                rtspServerReady = null; // allow a future retry
                throw err;
            });
    }
    return rtspServerReady;
}

function buildPublishUrl(track) {
    return `rtsp://127.0.0.1:${publishPort}/${encodeURIComponent(track)}`;
}

// ---------------------------------------------------------------------------
// Per-track always-on ffmpeg publisher with auto-restart
// ---------------------------------------------------------------------------

const runners = new Map(); // track -> { process, restartAttempts, stopped, stderrTail }

async function spawnFfmpegForTrack(track) {
    const sourceUrl = buildSourceUrl(track);
    const outputUrl = buildPublishUrl(track);

    const runner = runners.get(track);

    let codec;
    try {
        codec = await detectCodec(sourceUrl);
        if (runner.quietFailureCount) {
            logDebug('RTSP push: H.264 source is back, resuming', { track, previousFailures: runner.quietFailureCount });
            runner.quietFailureCount = 0;
        }
    } catch (err) {
        reportFailure(track, runner, err.message);
        codec = 'h264';
    }

    const inputFormat = codec === 'hevc' ? 'hevc' : 'h264';

    // Already H.264 -> remux only (lowest latency, no re-encode, and
    // naturally handles mid-stream resolution changes since we never
    // decode/encode).
    // H.265 -> transcode to H.264 for the widest RTSP client compatibility.
    //
    // No explicit "-level" here: a hardcoded level caps the frame size the
    // encoder will accept, and the source can change resolution mid-stream.
    // Instead, "scale + pad" below normalizes every frame onto a fixed
    // canvas before it reaches libx264, so the encoder always sees a
    // constant size no matter what the source does; libx264 then picks
    // its own level for that canvas automatically.
    const canvasFilter = `scale=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:force_original_aspect_ratio=decrease,pad=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    const videoCodecArgs = (inputFormat === 'hevc')
        ? ['-vf', canvasFilter, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-g', '50', '-sc_threshold', '0']
        : ['-c:v', 'copy'];

    const args = [
        '-loglevel', 'warning',
        // Give ffmpeg more leeway to find a clean access unit (valid SPS/PPS)
        // before it locks in stream parameters, instead of grabbing whatever
        // partial/corrupted data happens to be first off the wire.
        '-probesize', '10M',
        '-analyzeduration', '5M',
        '-fflags', '+genpts+nobuffer+discardcorrupt',
        '-flags', 'low_delay',
        '-avioflags', 'direct',
        '-err_detect', 'ignore_err',
        '-f', inputFormat,
        '-i', sourceUrl,
        ...videoCodecArgs,
        '-an',
        '-f', 'rtsp',
        // NOTE: no "-rtsp_transport tcp" here — rtsp-streaming-server only
        // supports UDP RTP for producers right now, not TCP-interleaved RTSP.
        outputUrl
    ];

    if (!runner.quietFailureCount) {
        logDebug('Starting RTSP push', { track, codec, inputFormat, outputUrl });
    }

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    runner.process = proc;
    runner.stderrTail = [];

    proc.stderr.on('data', (chunk) => {
        runner.stderrTail.push(chunk.toString());
        if (runner.stderrTail.length > 40) runner.stderrTail.shift();
    });

    proc.on('exit', (code, signal) => {
        if (runner.stopped) return;
        reportFailure(track, runner, runner.stderrTail.join(''));
        scheduleRestart(track);
    });

    proc.on('error', (err) => {
        if (runner.stopped) return;
        reportFailure(track, runner, err.message);
        scheduleRestart(track);
    });
}

function scheduleRestart(track) {
    const runner = runners.get(track);
    if (!runner || runner.stopped) return;

    runner.restartAttempts = (runner.restartAttempts || 0) + 1;
    const delay = Math.min(RESTART_DELAY_MS * runner.restartAttempts, RESTART_DELAY_MAX_MS);

    // Only announce the restart itself when we're not already in a quiet
    // failure streak (reportFailure already logged its own heartbeat above).
    const inQuietStreak = (runner.quietFailureCount || 0) > 0;
    if (!inQuietStreak) {
        logDebug('Scheduling RTSP push restart', { track, delayMs: delay, attempt: runner.restartAttempts });
    }

    setTimeout(() => {
        if (!runner.stopped) spawnFfmpegForTrack(track);
    }, delay);
}

function startTrack(track) {
    runners.set(track, { process: null, restartAttempts: 0, stopped: false, stderrTail: [] });
    ensureRtspServerStarted()
        .then(() => spawnFfmpegForTrack(track))
        .catch(() => scheduleRestart(track));
}

// Gives ffmpeg a chance to cleanly TEARDOWN its RTSP session before we force
// it closed. A hard SIGKILL skips that, which leaves a stale/zombie mount
// registered in the RTSP server — the next publish attempt to the same path
// then gets rejected with a 503 ("mount already existed").
function killGracefully(proc, graceMs = 1500) {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;

    let exited = false;
    proc.once('exit', () => { exited = true; });

    try { proc.kill('SIGTERM'); } catch (e) { /* ignore */ }

    setTimeout(() => {
        if (!exited) {
            try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
    }, graceMs);
}

function stopAll() {
    for (const [track, runner] of runners.entries()) {
        runner.stopped = true;
        killGracefully(runner.process);
        logDebug('Stopped RTSP push', { track });
    }
    runners.clear();

    try { rtspServer.stop && rtspServer.stop(); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// On/off toggle
// ---------------------------------------------------------------------------

let rtspEnabled = false;

function enableRtsp() {
    if (rtspEnabled) return;
    rtspEnabled = true;
    logDebug('RTSP: enabling');
    for (const track of TRACKS) {
        startTrack(track);
    }
}

function disableRtsp() {
    if (!rtspEnabled) return;
    rtspEnabled = false;
    logDebug('RTSP: disabling');
    stopAll();
    rtspServerReady = null; // so a future enableRtsp() re-starts the server cleanly
}

function isRtspEnabled() {
    return rtspEnabled;
}

// Start immediately on import, matching the original always-on behavior —
// call disableRtsp() (or setRtspEnabled(false) from helpers.js) to turn it off.
enableRtsp();

process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });

// ---------------------------------------------------------------------------
// Known rtsp-streaming-server bug: if a viewer sends SETUP for a track that
// isn't currently being published, ClientWrapper's constructor throws
// synchronously ("Mount does not exist") instead of the caller returning a
// clean 404 — and nothing catches it, so it becomes an uncaught exception
// that crashes the whole process. Since the H.264 source is frequently down
// and viewers will often connect before a track is live, this is expected
// and not fatal to us — so we swallow *only* this specific error here.
// Anything else still crashes normally, so real bugs aren't hidden.
// ---------------------------------------------------------------------------

let mountRaceCount = 0;

process.on('uncaughtException', (err) => {
    const isKnownMountRace =
        err &&
        typeof err.message === 'string' &&
        err.message.includes('Mount does not exist') &&
        typeof err.stack === 'string' &&
        err.stack.includes('ClientWrapper');

    if (!isKnownMountRace) {
        throw err; // not our known case — let it crash as it normally would
    }

    mountRaceCount += 1;
    if (mountRaceCount === 1 || mountRaceCount % QUIET_LOG_EVERY_N === 0) {
        logDebug('RTSP client tried to connect before a track was publishing (ignored)', {
            occurrences: mountRaceCount
        });
    }
});

// ---------------------------------------------------------------------------
// Minimal introspection export, in case you want to check status elsewhere
// ---------------------------------------------------------------------------

function getStatus() {
    const status = {
        rtsp: { clientPort, publishPort },
        tracks: {}
    };
    for (const [track, runner] of runners.entries()) {
        status.tracks[track] = {
            running: !!runner.process && runner.process.exitCode === null,
            restartAttempts: runner.restartAttempts || 0
        };
    }
    return status;
}

module.exports = { getStatus, stopAll, enableRtsp, disableRtsp, isRtspEnabled };