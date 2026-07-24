'use strict';

/**
 * h264-hls.js
 * ---------------------------------------------------------------------------
 * On-demand HTTP -> HLS bridge for the existing `/api/stream/live.h264` source.
 *
 * No system-installed ffmpeg/ffprobe required — this uses the npm-managed
 * static binaries from `ffmpeg-static` and `ffprobe-static`.
 *
 *   npm install ffmpeg-static ffprobe-static
 *
 * Usage from your request handler file:
 *
 *   const { isHlsRequest, handleHlsRequest } = require('./h264-hls.js');
 *
 *   // inside GETrequest, before the default 404 case:
 *   if (isHlsRequest(pathname)) {
 *       return handleHlsRequest(req, res, requestUrl);
 *   }
 *
 * Routes handled by this module:
 *   GET /api/stream/live.m3u8?track=primary   -> HLS playlist (starts ffmpeg lazily)
 *   GET /api/stream/hls/<track>/<segment>.ts  -> individual HLS segments
 * ---------------------------------------------------------------------------
 * NOTE: THIS CODE IS FULLY VIBECODED, IT HAS NOT BEEN REVIEWED (ONLY TESTED)!
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { logDebug } = require('./helpers.js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HLS_ROOT = path.join(os.tmpdir(), 'h264-hls-cache');
const IDLE_TIMEOUT_MS = 30_000;          // kill ffmpeg if nobody's requested a segment in this long
const PLAYLIST_WAIT_TIMEOUT_MS = 8_000;  // how long to wait for the first playlist write
const IDLE_SWEEP_INTERVAL_MS = 10_000;

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

    throw new Error(`h264-hls: "${key}" was not found in .env`);
}

function loadServerPort() {
    return loadEnvValue('server_port');
}

function buildSourceUrl(track) {
    const port = loadServerPort();
    const safeTrack = track || 'primary';
    return `http://127.0.0.1:${port}/api/stream/live.h264?track=${encodeURIComponent(safeTrack)}`;
}

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
const CANVAS_WIDTH = Number(loadEnvValue('hls_canvas_width', '1920'));
const CANVAS_HEIGHT = Number(loadEnvValue('hls_canvas_height', '1080'));

// ---------------------------------------------------------------------------
// Codec detection (mirrors the H.264-vs-H.265-under-a-.h264-URL issue)
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

        execFile(ffprobePath, args, { timeout: 8000 }, (err, stdout) => {
            if (err) return reject(new Error(`ffprobe failed: ${err.message}`));

            const codec = stdout.trim().split('\n')[0].trim().toLowerCase();
            if (!codec) return reject(new Error('ffprobe returned no codec_name for the source stream'));

            resolve(codec); // typically 'h264' or 'hevc'
        });
    });
}

// ---------------------------------------------------------------------------
// Per-track ffmpeg process management
// ---------------------------------------------------------------------------

const TRACKS = new Map(); // track name -> state

function isProcessAlive(proc) {
    return !!proc && proc.exitCode === null && proc.signalCode === null;
}

async function startTrack(track) {
    const dir = path.join(HLS_ROOT, track);
    fs.mkdirSync(dir, { recursive: true });

    // Clear stale segments/playlist from any previous run for this track.
    for (const file of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch (e) { /* ignore */ }
    }

    const sourceUrl = buildSourceUrl(track);
    const codec = await detectCodec(sourceUrl);
    const inputFormat = codec === 'hevc' ? 'hevc' : 'h264';

    // Already H.264 -> just remux (cheap, minimal latency, and naturally
    // handles mid-stream resolution changes since we never decode/encode).
    // H.265 -> transcode to H.264 for broad/low-latency player compatibility.
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

    const playlistPath = path.join(dir, 'index.m3u8');
    const segmentPattern = path.join(dir, 'seg_%d.ts');

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
        '-an', // no audio track on the source right now; remove this and map audio if that changes
        '-f', 'hls',
        '-hls_time', '1',
        '-hls_list_size', '3',
        '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist',
        '-hls_segment_type', 'mpegts',
        '-hls_base_url', `/api/stream/hls/${encodeURIComponent(track)}/`,
        '-hls_segment_filename', segmentPattern,
        '-start_number', '0',
        '-y',
        playlistPath
    ];

    logDebug('Starting HLS ffmpeg', { track, codec, inputFormat });

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const state = {
        dir,
        process: proc,
        codec,
        lastAccess: Date.now(),
        stderrTail: []
    };

    proc.stderr.on('data', (chunk) => {
        state.stderrTail.push(chunk.toString());
        if (state.stderrTail.length > 40) state.stderrTail.shift();
    });

    proc.on('exit', (code, signal) => {
        logDebug('HLS ffmpeg exited', { track, code, signal });
        if (TRACKS.get(track) === state) TRACKS.delete(track);
    });

    proc.on('error', (err) => {
        logDebug('HLS ffmpeg failed to start', { track, error: err.message });
        if (TRACKS.get(track) === state) TRACKS.delete(track);
    });

    TRACKS.set(track, state);
    return state;
}

function waitForPlaylist(state) {
    const playlistPath = path.join(state.dir, 'index.m3u8');
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
        const check = () => {
            if (!isProcessAlive(state.process)) {
                return reject(new Error(
                    `ffmpeg exited before producing a playlist. Recent stderr:\n${state.stderrTail.join('')}`
                ));
            }

            if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0) {
                return resolve();
            }

            if (Date.now() - startedAt > PLAYLIST_WAIT_TIMEOUT_MS) {
                return reject(new Error(
                    `Timed out waiting for HLS playlist. Recent stderr:\n${state.stderrTail.join('')}`
                ));
            }

            setTimeout(check, 150);
        };

        check();
    });
}

async function ensureTrack(track) {
    let state = TRACKS.get(track);

    if (!state || !isProcessAlive(state.process)) {
        state = await startTrack(track);
    }

    state.lastAccess = Date.now();
    await waitForPlaylist(state);
    return state;
}

// Idle cleanup so we don't leave ffmpeg processes running forever.
setInterval(() => {
    const now = Date.now();
    for (const [track, state] of TRACKS.entries()) {
        if (now - state.lastAccess > IDLE_TIMEOUT_MS) {
            logDebug('Stopping idle HLS ffmpeg', { track });
            try { state.process.kill('SIGKILL'); } catch (e) { /* ignore */ }
            TRACKS.delete(track);
        }
    }
}, IDLE_SWEEP_INTERVAL_MS);

function shutdownAll() {
    for (const [, state] of TRACKS.entries()) {
        try { state.process.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
    TRACKS.clear();
}

process.on('exit', shutdownAll);
process.on('SIGINT', () => { shutdownAll(); process.exit(0); });
process.on('SIGTERM', () => { shutdownAll(); process.exit(0); });

// ---------------------------------------------------------------------------
// On/off toggle
// ---------------------------------------------------------------------------
// HLS is on-demand by nature (ffmpeg only spins up when a track is
// requested), so "disabling" it means: stop anything currently running and
// refuse new playlist/segment requests with a 503 until re-enabled.

let hlsEnabled = true;

function enableHls() {
    if (hlsEnabled) return;
    hlsEnabled = true;
    logDebug('HLS: enabled');
}

function disableHls() {
    if (!hlsEnabled) return;
    hlsEnabled = false;
    logDebug('HLS: disabling, stopping any active tracks');
    shutdownAll();
}

function isHlsEnabled() {
    return hlsEnabled;
}

// ---------------------------------------------------------------------------
// Route matching + HTTP handling
// ---------------------------------------------------------------------------

const PLAYLIST_RE = /^\/api\/stream\/live\.m3u8$/;
const SEGMENT_RE = /^\/api\/stream\/hls\/([^/]+)\/([^/]+)$/;

function isHlsRequest(pathname) {
    return PLAYLIST_RE.test(pathname) || SEGMENT_RE.test(pathname);
}

async function handleHlsRequest(req, res, requestUrl) {
    const pathname = requestUrl.pathname;

    if (!hlsEnabled) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'HLS is currently disabled' }));
        return;
    }

    try {
        if (PLAYLIST_RE.test(pathname)) {
            const track = requestUrl.searchParams.get('track') || 'primary';
            const state = await ensureTrack(track);
            state.lastAccess = Date.now();

            const playlistPath = path.join(state.dir, 'index.m3u8');
            const body = fs.readFileSync(playlistPath);

            res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(body);
        }

        const segMatch = pathname.match(SEGMENT_RE);
        if (segMatch) {
            const track = decodeURIComponent(segMatch[1]);
            const filename = decodeURIComponent(segMatch[2]);

            // Guard against path traversal via the segment filename.
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                return res.end('Bad request');
            }

            const state = TRACKS.get(track);
            if (!state) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('Stream is not running for that track (request the .m3u8 first)');
            }
            state.lastAccess = Date.now();

            const filePath = path.join(state.dir, filename);
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('Segment not found (it may have already rolled off the live window)');
            }

            const body = fs.readFileSync(filePath);
            res.writeHead(200, {
                'Content-Type': 'video/mp2t',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(body);
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    } catch (err) {
        logDebug('HLS handler error', err && err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to serve HLS stream', detail: err.message }));
    }
}

module.exports = {
    isHlsRequest,
    handleHlsRequest,
    enableHls,
    disableHls,
    isHlsEnabled
};