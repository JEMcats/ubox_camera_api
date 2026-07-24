const fs = require('fs');
const axios = require('axios');
const https = require('https');
const { makeUbiaRequest, hmacSha1Base64, generateRandomString, logDebug, json, readBody, normalizeUbiaStatusCode, writeUbiaJsonResponse, setRtspEnabled, setHlsEnabled, isRtspEnabled, isHlsEnabled, hoursAgo } = require('./helpers.js');
const { isHlsRequest, handleHlsRequest } = require('./h264-hls.js');
require('./h264-rtsp.js');
setRtspEnabled(false);
require('dotenv').config();

async function GETrequest(req, res) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = requestUrl.pathname;

    logDebug("Handling GET request", { url: req.url, pathname });

    if (isHlsRequest(pathname)) {
        return handleHlsRequest(req, res, requestUrl);
    }

    switch (pathname) {
        case '/api/v2/user/device_list':
            logDebug("Fetching device list");
            const ubia_response_device_list = await makeUbiaRequest({}, req.url);
            logDebug("Response from device list", ubia_response_device_list);
            return writeUbiaJsonResponse(res, ubia_response_device_list);
            break;

        case '/api/user/families':
            logDebug("Fetching families");
            const ubia_response_families = await makeUbiaRequest({ "token": global.userdata?.token }, req.url);
            logDebug("Response from families", ubia_response_families);
            return writeUbiaJsonResponse(res, ubia_response_families);
            break;

        case '/api/user/get_subscription_ios_device':
            logDebug("Fetching subscription iOS device");
            const ubia_response_get_subscription_ios_device = await makeUbiaRequest({}, req.url);
            logDebug("Response from subscription iOS device", ubia_response_get_subscription_ios_device);
            return writeUbiaJsonResponse(res, ubia_response_get_subscription_ios_device);
            break;

        case '/api/stream/status':
            return json(res, 200, {
                ...global.liveStreams.status(),
                events: global.liveStreams.recentEvents(80),
            });
            break;

        case '/api/stream/events':
            return global.liveStreams.addSseClient(res);
            break;

        case '/api/stream/live.h264':
            if (!global.liveStreams?.addH264Client) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Live stream manager is not available.' }));
                return;
            }
            return global.liveStreams.addH264Client(res, requestUrl.searchParams.get("track") || "primary");
            break;

        case '/api/login/expires_in':
            const hoursSinceLogin = hoursAgo(global.userdata.login_time);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write(JSON.stringify({
                hours_since_login: hoursSinceLogin,
                token_valid_for: global.userdata.token_valid_hours
            }));
            res.end();
            break;
        default:
    logDebug("Invalid GET route", req.url);
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.write('Not Found');
    res.end();
    break;
}
}

async function POSTrequest(req, res) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = requestUrl.pathname;

    logDebug("Handling POST request", { url: req.url, pathname });

    let body = '';
    req.on('data', chunk => {
        logDebug("Receiving chunk", chunk.toString());
        body += chunk.toString();
    });

    req.on('end', async () => {
        logDebug("Complete body received", body);

        try {
            const parsedBody = JSON.parse(body);
            parsedBody.token = global.userdata?.token; // Attach token
            logDebug("Parsed body with token", parsedBody);

            switch (pathname) {
                case '/api/user/qry/device/device_services':
                    logDebug("Fetching device services");
                    const ubia_response_device_services = await makeUbiaRequest(parsedBody, req.url);
                    logDebug("Response from device services", ubia_response_device_services);
                    return writeUbiaJsonResponse(res, ubia_response_device_services);
                    break;

                case '/api/user/cloud_list':
                    logDebug("Fetching cloud list");
                    const ubia_response_cloud_list = await makeUbiaRequest(parsedBody, req.url);
                    logDebug("Response from cloud list", ubia_response_cloud_list);
                    return writeUbiaJsonResponse(res, ubia_response_cloud_list);
                    break;

                case '/api/stream/start':
                    logDebug("Stream start request payload", parsedBody);
                    setRtspEnabled(true);
                    if (!parsedBody.device && !parsedBody.uid) {
                        logDebug("Stream start rejected: missing device or uid", parsedBody);
                        return json(res, 400, { error: "device or uid is required." });
                    }

                    const requestedStreamIndex = parsedBody.streamIndex ?? parsedBody.options?.streamIndex;

                    let device;

                    if (parsedBody.device) {
                        device = {
                            ...(parsedBody.device || { uid: parsedBody.uid, ...parsedBody }),
                            ...(requestedStreamIndex !== undefined ? { streamIndex: requestedStreamIndex } : {}),
                        };
                    } else {
                        const ubia_response_device_list = await makeUbiaRequest({}, '/api/v2/user/device_list');
                        const devices = Array.isArray(ubia_response_device_list?.data?.items) ? ubia_response_device_list.data.items : [];
                        const devicesInfo = Array.isArray(ubia_response_device_list?.data?.infos) ? ubia_response_device_list.data.infos : [];

                        const matchedDevice = devices.find((item) => item?.device_uid === parsedBody.uid || item?.uid === parsedBody.uid);
                        const matchedDeviceInfo = devicesInfo.find((item) => item?.device_uid === parsedBody.uid || item?.uid === parsedBody.uid);

                        device = {
                            uid: matchedDevice.device_uid,
                            name: matchedDevice.device_name,
                            owner: matchedDevice.is_owner,
                            source: "infos",
                            raw: matchedDeviceInfo
                        };
                    }

                    const options = {
                        ...(parsedBody.options || {}),
                        ...(requestedStreamIndex !== undefined ? { streamIndex: requestedStreamIndex } : {}),
                    };

                    logDebug("Normalized stream start device", device);
                    logDebug("Normalized stream start options", options);

                    const status = await global.liveStreams.start(device, options);
                    logDebug("Stream start response", status);
                    return json(res, 200, status);
                    break;

                case '/api/stream/stop':
                    setRtspEnabled(false);
                    await global.liveStreams?.stop?.();
                    return json(res, 200, global.liveStreams?.status?.() || { state: 'stopped' });
                    break;

                case '/api/stream/decode-packet':
                    const body = await readBody(req);
                    if (!body.hex) return json(res, 400, { error: "hex is required." });
                    return json(res, 200, liveStreams.decodePacket(body.hex));
                    break;
                default:
                    logDebug("Invalid POST route", req.url);
                    res.writeHead(404, { 'Content-Type': 'text/html' });
                    res.write('Not Found');
                    res.end();
                    break;
            }
        } catch (error) {
            logDebug("Error parsing POST body", error.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.write(JSON.stringify({ error: 'Invalid JSON' }));
            res.end();
        }
    });
}

async function LOGINrequest() {
    // Load email and password from environment variables
    const email = process.env.email;
    const password = hmacSha1Base64(process.env.password);
    if (process.env.debug_mode == 'true') {
        console.log('email', process.env.email)
        console.log('password', process.env.password)
        console.log(password)
    }
    // Check if email and password are defined
    if (!email || !password) {
        console.error("Error: Email or password not found in environment variables.");
        process.exit(1);
    }

    // Define the request headers
    const headers = {
        "method": "POST",
        "scheme": "https",
        "path": "/api/v3/login",
        "authority": "portal.ubianet.com",
        "accept": "*/*",
        "content-type": "application/json"
    };

    // Define the request body
    const body = {
        "account": email,
        "password": password,
        "lang": "en",
        "app": "ubox",
        "device_token": generateRandomString(30), // Generate random 30-character string
        "device_type": 2
    };


    // Create an axios instance that ignores SSL errors (only if necessary)
    const axiosInstance = axios.create({
        httpsAgent: new https.Agent({
            rejectUnauthorized: false  // Allow SSL certificate bypass (use with caution)
        })
    });

    try {
        const response = await axiosInstance.post('https://portal.ubianet.com/api/v3/login', body, { headers });
        const data = response.data;

        if (data.code === 0) {
            const tokenInfo = {
                token: data.data.Token,
                uuid: data.data.uuid,
                token_valid_hours: data.data.token_valid_hours,
                kuid: data.data.kuid,
                login_time: new Date().toISOString(),
                file_created_by_ubox_camera_api: 1
            };

            global.userdata = tokenInfo;

            fs.writeFileSync('.storedLogin.json', JSON.stringify(tokenInfo, null, 4));
            return tokenInfo;
        }

        console.error("Login failed:", data.msg);
        process.exit(1);
    } catch (error) {
        if (error.response) {
            console.error("Error response data:", error.response.data);
            console.error("Status code:", error.response.status);
            process.exit(1);
        } else if (error.request) {
            console.error("No response received:", error.request);
            process.exit(1);
        } else {
            console.error("Request error:", error.message);
            process.exit(1);
        }
    }
}

module.exports = {
    GETrequest,
    POSTrequest,
    LOGINrequest
}