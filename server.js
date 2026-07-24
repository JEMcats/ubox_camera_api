const http = require('http');
const fs = require('fs');
const path = require('path');
const { GETrequest, POSTrequest, LOGINrequest } = require('./src/main/requests');
const { logDebug, makeUbiaRequest, hoursAgo } = require('./src/main/helpers');
const { buildMp4FromAnnexB } = require('./src/stream/h264-mp4');
const { UBoxLiveStreamManager } = require('./src/stream/ubox-live-stream');
require('dotenv').config();

global.liveStreams = new UBoxLiveStreamManager({
    dumpDir: path.join(__dirname, 'stream-dumps'),
    logDir: path.join(__dirname, 'stream-logs'),
    enableSessionLogs: process.env.debug_mode !== 'false',
    enableDumpFiles: process.env.debug_mode !== 'false',
});

require('dotenv').config();

async function initializeLogin() {
    let loginCredentials;

    if (fs.existsSync('.storedLogin.json')) {
        console.log('Saved login was found, attempting to load...')
        loginCredentials = JSON.parse(fs.readFileSync('.storedLogin.json'));

        if (loginCredentials && loginCredentials.file_created_by_ubox_camera_api && loginCredentials.login_time && loginCredentials.token_valid_hours && loginCredentials.file_created_by_ubox_camera_api == 1) {
            let hoursSinceLogin = hoursAgo(loginCredentials.login_time);
            logDebug(`It has been ${hoursSinceLogin} hours since login, the token is valid for ${loginCredentials.token_valid_hours} hours.`);
            if (hoursSinceLogin < loginCredentials.token_valid_hours) {
                global.userdata = loginCredentials;
                let login_validity = await checkLoginValidity();
                if (login_validity == true) {
                    console.log('Loaded saved login credentials.');
                    if (process.env.debug_mode == 'true') {
                        logDebug(JSON.stringify(loginCredentials));
                    }
                } else {
                    console.log('Stored Login Is Not Working, attempting new login...')
                    fs.unlinkSync('.storedLogin.json')
                    global.userdata = {};
                    loginCredentials = await LOGINrequest();
                    global.userdata = loginCredentials;
                    let login_validity = await checkLoginValidity();
                    if (login_validity == true) {
                        console.log('Login succeeded, credentials have been saved!')
                        if (process.env.debug_mode == 'true') {
                            logDebug(JSON.stringify(loginCredentials));
                        }
                    } else {
                        console.error('Login failed!');
                        process.exit(1);
                    }
                }
            } else {
                console.log('Stored Login Is Expired, attempting new login...')
                fs.unlinkSync('.storedLogin.json')
                loginCredentials = await LOGINrequest();
                global.userdata = loginCredentials;
                let login_validity = await checkLoginValidity();
                if (login_validity == true) {
                    console.log('Login succeeded, credentials have been saved!')
                    if (process.env.debug_mode == 'true') {
                        logDebug(JSON.stringify(loginCredentials));
                    }
                } else {
                    console.error('Login failed!');
                    process.exit(1);
                }
            }
        } else {
            console.log('Stored Login File Is Corrupt/Invalid, attempting new login...')
            fs.unlinkSync('.storedLogin.json')
            loginCredentials = await LOGINrequest();
            global.userdata = loginCredentials;
            let login_validity = await checkLoginValidity();
            if (login_validity == true) {
                console.log('Login succeeded, credentials have been saved!')
                if (process.env.debug_mode == 'true') {
                    logDebug(JSON.stringify(loginCredentials));
                }
            } else {
                console.error('Login failed!');
                process.exit(1);
            }
        }
    } else {
        console.log('No login is stored, attempting login...');
        loginCredentials = await LOGINrequest();
        global.userdata = loginCredentials;
        let login_validity = await checkLoginValidity();
        if (login_validity == true) {
            console.log('Login succeeded, credentials have been saved!')
            if (process.env.debug_mode == 'true') {
                logDebug(JSON.stringify(loginCredentials));
            }
        } else {
            console.error('Login failed!');
            process.exit(1);
        }
    }

    return loginCredentials;
}

async function checkLoginValidity() {
    logDebug("Checking login validity...");
    const ubia_response_device_list = await makeUbiaRequest({}, '/api/v2/user/device_list');
    const isValidResponse = ubia_response_device_list && (ubia_response_device_list.code === 0 || ubia_response_device_list.code === '0');

    if (isValidResponse) {
        logDebug("Login is valid!");
        return true;
    }

    logDebug("Login is not valid!", ubia_response_device_list);
    if (ubia_response_device_list && ubia_response_device_list.code !== undefined) {
        logDebug("API response code", ubia_response_device_list.code);
    }
    return false;
}

async function startServer() {
    await initializeLogin();

    const port = process.env.server_port || 3000;

    // Create the server
    http.createServer(async function (req, res) {
        logDebug("Incoming request", { method: req.method, url: req.url });

        if (!global.userdata.token) {
            res.writeHead(401, { 'Content-Type': 'text/html' });
            res.write('Not Yet Logged In');
            res.end();
            return;
        }

        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

        if (parsedUrl.pathname.includes('/api/stream/hls')) {
            switch (req.method) {
                case 'GET':
                    GETrequest(req, res);
                    break;

                case 'POST':
                    POSTrequest(req, res);
                    break;

                default:
                    logDebug("Invalid request method", req.method);
                    res.writeHead(405, { 'Content-Type': 'text/html' });
                    res.write('Method Not Allowed');
                    res.end();
                    break;
            }
        } else {
            let login_validity = await checkLoginValidity();
            if (login_validity == true) {
                switch (req.method) {
                    case 'GET':
                        GETrequest(req, res);
                        break;

                    case 'POST':
                        POSTrequest(req, res);
                        break;

                    default:
                        logDebug("Invalid request method", req.method);
                        res.writeHead(405, { 'Content-Type': 'text/html' });
                        res.write('Method Not Allowed');
                        res.end();
                        break;
                }
            } else {
                fs.unlinkSync('.storedLogin.json')
                global.userdata = {};
                loginCredentials = await LOGINrequest();
                global.userdata = loginCredentials;
                let login_validity = await checkLoginValidity();
                if (login_validity == true) {
                    console.log('Re-Login succeeded, credentials have been saved!')
                    if (process.env.debug_mode == 'true') {
                        logDebug(loginCredentials);
                    }
                    switch (req.method) {
                        case 'GET':
                            GETrequest(req, res);
                            break;

                        case 'POST':
                            POSTrequest(req, res);
                            break;

                        default:
                            logDebug("Invalid request method", req.method);
                            res.writeHead(405, { 'Content-Type': 'text/html' });
                            res.write('Method Not Allowed');
                            res.end();
                            break;
                    }
                } else {
                    console.error('Login failed!');
                    process.exit(1);
                }
            }
        }
    }).listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}

startServer();