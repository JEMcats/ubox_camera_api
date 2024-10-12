const http = require('http');
const fs = require('fs');
const axios = require('axios');

let port = 8020;

const userdata = JSON.parse(fs.readFileSync('user.json'));

async function makeUbiaRequest(body, url) {
    // Define the request headers
    const headers = {
        "method": "POST",
        "scheme": "https",
        "path": url,
        "authority": "portal.ubianet.com",
        "accept": "*/*",
        "content-type": "application/json",
        "x-ubia-auth-usertoken": userdata.token
    };

    try {
        const response = await axios.post(`https://portal.ubianet.com${url}`, body, { headers });
        const data = response.data;

        if (data.code === 0) {
            return { "code": response.status, "msg": data.msg, "data": data };
        } else {
            console.error("Request Failed", data.msg);  // Log error message from API
            return { "code": response.status, "msg": data.msg };
        }
    } catch (error) {
        // Handle and log errors during the API request
        if (error.response) {
            console.error("Error response data:", error.response.data);
            console.error("Status code:", error.response.status);
            return { "code": error.response.status, "msg": error.response.data };
        } else if (error.request) {
            console.error("No response received:", error.request);
            return { "code": 500, "msg": 'Unknown Error' };
        } else {
            console.error("Request error:", error.message);
            return { "code": 500, "msg": error.message };
        }
    }
}

async function GETrequest(req, res) {
    switch (req.url) {
        case '/api/v2/user/device_list':
            const ubia_response_device_list = await makeUbiaRequest({}, req.url);
            res.writeHead(ubia_response_device_list.code, { 'Content-Type': 'application/json' });
            res.write(JSON.stringify(ubia_response_device_list.data)); // Ensure JSON data is stringified
            res.end();
        break;
        case '/api/user/families':
            const ubia_response_families = await makeUbiaRequest({"token":userdata.token}, req.url);
            res.writeHead(ubia_response_families.code, { 'Content-Type': 'application/json' });
            res.write(JSON.stringify(ubia_response_families.data)); // Ensure JSON data is stringified
            res.end();
        break;
        case '/api/user/get_subscription_ios_device':
            const ubia_response_get_subscription_ios_device = await makeUbiaRequest({}, req.url);
            res.writeHead(ubia_response_get_subscription_ios_device.code, { 'Content-Type': 'application/json' });
            res.write(JSON.stringify(ubia_response_get_subscription_ios_device.data)); // Ensure JSON data is stringified
            res.end();
        break;
        default:
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.write('Not Found');
            res.end();
        break;
    }
}

async function POSTrequest(req, res) {
    let body = '';

    // Accumulate data chunks in the body string
    req.on('data', chunk => {
        body += chunk.toString(); // Convert Buffer to string
    });

    // When the body is fully received, proceed
    req.on('end', async () => {
        // Try to parse the JSON body
        try {
            const parsedBody = JSON.parse(body);
            parsedBody.token = userdata.token; // Attach the token

            // Handle different POST routes
            switch (req.url) {
                case '/api/user/qry/device/device_services':
                    const ubia_response_device_services = await makeUbiaRequest(parsedBody, req.url);
                    res.writeHead(ubia_response_device_services.code, { 'Content-Type': 'application/json' });
                    res.write(JSON.stringify(ubia_response_device_services.data));
                    res.end();
                    break;

                case '/api/user/cloud_list':
                    const ubia_response_cloud_list = await makeUbiaRequest(parsedBody, req.url);
                    res.writeHead(ubia_response_cloud_list.code, { 'Content-Type': 'application/json' });
                    res.write(JSON.stringify(ubia_response_cloud_list.data));
                    res.end();
                    break;

                case '/api/user/event_calendar':
                    const ubia_response_event_calendar = await makeUbiaRequest(parsedBody, req.url);
                    res.writeHead(ubia_response_event_calendar.code, { 'Content-Type': 'application/json' });
                    res.write(JSON.stringify(ubia_response_event_calendar.data));
                    res.end();
                    break;

                case '/api/user/get_cloud_video_url':
                    const ubia_response_get_cloud_video_url = await makeUbiaRequest(parsedBody, req.url);
                    res.writeHead(ubia_response_get_cloud_video_url.code, { 'Content-Type': 'application/json' });
                    res.write(JSON.stringify(ubia_response_get_cloud_video_url.data));
                    res.end();
                    break;

                case '/api/v2/user/card4g-info':
                    const ubia_response_card4g_info = await makeUbiaRequest(parsedBody, req.url);
                    res.writeHead(ubia_response_card4g_info.code, { 'Content-Type': 'application/json' });
                    res.write(JSON.stringify(ubia_response_card4g_info.data));
                    res.end();
                    break;

                default:
                    res.writeHead(404, { 'Content-Type': 'text/html' });
                    res.write('Not Found');
                    res.end();
                    break;
            }

        } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.write(JSON.stringify({ error: 'Invalid JSON' }));
            res.end();
        }
    });
}

// Create a server object:
http.createServer(function (req, res) {
    switch (req.method) {
        case 'GET':
            GETrequest(req, res);
            break;
        case 'POST':
            console.log(req.body)
            POSTrequest(req, res);
            break;
        default:
            break;
    }
}).listen(port); // The server object listens on port 8020
console.log(`Server running on port ${port}`);