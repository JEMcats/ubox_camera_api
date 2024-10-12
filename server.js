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
            const ubia_response = await makeUbiaRequest({}, '/api/v2/user/device_list');
            res.writeHead(ubia_response.code, { 'Content-Type': 'application/json' });
            res.write(JSON.stringify(ubia_response.data)); // Ensure JSON data is stringified
            res.end();
            break;
        case '/api/user/families':
            // Implement other API logic here
            break;
        case '/api/user/get_subscription_ios_device':
            // Implement other API logic here
            break;
        default:
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.write('Not Found');
            res.end();
            break;
    }
}

function POSTrequest(req, res) {
    switch (req.url) {
        case '/api/user/qry/device/device_services':
            // Implement other API logic here
            break;
        case '/api/user/cloud_list':
            // Implement other API logic here
            break;
        case '/api/user/event_calendar':
            // Implement other API logic here
            break;
        case '/api/user/get_cloud_video_url':
            // Implement other API logic here
            break;
        case '/api/v2/user/card4g-info':
            // Implement other API logic here
            break;
        default:
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.write('Not Found');
            res.end();
            break;
    }
}

// Create a server object:
http.createServer(function (req, res) {
    switch (req.method) {
        case 'GET':
            GETrequest(req, res);
            break;
        case 'POST':
            POSTrequest(req, res);
            break;
        default:
            break;
    }
}).listen(port); // The server object listens on port 8020
console.log(`Server running on port ${port}`);