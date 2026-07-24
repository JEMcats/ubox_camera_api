var sha1 = require('js-sha1');
const axios = require('axios');
require('dotenv').config();

// Helper function to log debug messages
function logDebug(message, data) {
    if (process.env.debug_mode == 'true') {
        console.log(`[DEBUG] ${message}`, data || '');
    }
}

// HMAC SHA-1 with Base64 Encoding
function hmacSha1Base64(data) {
    var hash = sha1.hmac.array('', data);
    var base_hash = Buffer.from(hash).toString('base64');
    // Replace the last character with a comma
    const modifiedSignature =  base_hash.replace(/.$/, ',');
    
    return modifiedSignature;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  res.end(body);
}

function binary(res, status, body, type) {
  res.writeHead(status, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

// Function to generate a random string for the device token
function generateRandomString(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

async function makeUbiaRequest(body, url) {
    logDebug("Preparing request", { body, url });

    const headers = {
        "method": "POST",
        "scheme": "https",
        "path": url,
        "authority": "portal.ubianet.com",
        "accept": "*/*",
        "content-type": "application/json",
        "x-ubia-auth-usertoken": global.userdata?.token || ''
    };

    logDebug("Request headers", headers);

    try {
        const response = await axios.post(`https://portal.ubianet.com${url}`, body, { headers });
        logDebug("Received response", { status: response.status, data: response.data });

        if (response.data.code === 0) {
            return response.data;
        } else {
            logDebug("API returned error", response.data.msg);
            return response.data;
        }
    } catch (error) {
        if (error.response) {
            logDebug("Error response from API", {
                status: error.response.status,
                data: error.response.data
            });
            return { "code": error.response.status, "msg": error.response.data };
        } else if (error.request) {
            logDebug("No response received from API", error.request);
            return { "code": 500, "msg": 'Unknown Error' };
        } else {
            logDebug("Error during request setup", error.message);
            return { "code": 500, "msg": error.message };
        }
    }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 512 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function hoursAgo(isoString) {
  const then = new Date(isoString);
  const now = new Date();
  const diffMs = now - then;
  return diffMs / (1000 * 60 * 60);
}

function normalizeUbiaStatusCode(code) {
    const parsed = Number(code);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed < 600) {
        return parsed;
    }
    if (parsed === 0 || code === 0 || code === '0') {
        return 200;
    }
    return 502;
}

function writeUbiaJsonResponse(res, ubiaResponse) {
    const payload = ubiaResponse?.data !== undefined ? ubiaResponse.data : ubiaResponse;
    const statusCode = normalizeUbiaStatusCode(ubiaResponse?.code);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify(payload));
    res.end();
}

// ---------------------------------------------------------------------------
// RTSP / HLS on-off toggles
// ---------------------------------------------------------------------------
// These lazily require the stream modules INSIDE the function body (not at
// the top of this file) on purpose: h264-rtsp.js and h264-hls.js both
// require helpers.js for logDebug, so requiring them back at the top of
// this file would create a circular require. Deferring the require until
// the function is actually called sidesteps that entirely.

function setRtspEnabled(enabled) {
    const rtsp = require('./h264-rtsp.js');
    return enabled ? rtsp.enableRtsp() : rtsp.disableRtsp();
}

function isRtspEnabled() {
    return require('./h264-rtsp.js').isRtspEnabled();
}

function setHlsEnabled(enabled) {
    const hls = require('./h264-hls.js');
    return enabled ? hls.enableHls() : hls.disableHls();
}

function isHlsEnabled() {
    return require('./h264-hls.js').isHlsEnabled();
}

module.exports = {
    hmacSha1Base64,
    generateRandomString,
    makeUbiaRequest,
    logDebug,
    json,
    text,
    binary,
    readBody,
    hoursAgo,
    normalizeUbiaStatusCode,
    writeUbiaJsonResponse,
    setRtspEnabled,
    isRtspEnabled,
    setHlsEnabled,
    isHlsEnabled
}