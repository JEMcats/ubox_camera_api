const fs = require('fs');
const axios = require('axios');
const https = require('https');
require('dotenv').config();
var sha1 = require('js-sha1');
// HMAC SHA-1 with Base64 Encoding
function hmacSha1Base64(data) {
if (process.env.debug_mode == 'false') {
    var hash = sha1.hmac.array('', data);
    var base_hash = Buffer.from(hash).toString('base64');
    // Replace the last character with a comma
    const modifiedSignature =  base_hash.replace(/.$/, ',');
    
    return modifiedSignature;
} else {
    return data
}
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

// Load email and password from environment variables
const email = process.env.email;
const password = hmacSha1Base64(process.env.password);
if (process.env.debug_mode == 'true') {
    console.log('email',process.env.email)
    console.log('password',process.env.password)
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
    "app_version": "1.1.115",
    "brand": "iPhone15,2(18.1)",
    "device_type": 2
};


// Create an axios instance that ignores SSL errors (only if necessary)
const axiosInstance = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false  // Allow SSL certificate bypass (use with caution)
    })
});

// Make the POST request
axiosInstance.post('https://portal.ubianet.com/api/v3/login', body, { headers })
    .then(response => {
        console.log("Response received:", response.data);  // Log the full response

        const data = response.data;

        if (data.code === 0) {
            // Extract required information from the response
            const tokenInfo = {
                token: data.data.Token,
                token_secret: data.data.Token_secret,
                AWS_key: data.data.app_config.aws_cloud.key,
                AWS_secret: data.data.app_config.aws_cloud.secret,
                device_token: data.data.device_token
            };

            // Save the extracted information to 'user.json'
            fs.writeFileSync('user.json', JSON.stringify(tokenInfo, null, 4));
            console.log("Token information saved to user.json");
        } else {
            console.error("Login failed:", data.msg);  // Log error message from API
        }
    })
    .catch(error => {
        // Handle and log errors during the API request
        if (error.response) {
            console.error("Error response data:", error.response.data);
            console.error("Status code:", error.response.status);
        } else if (error.request) {
            console.error("No response received:", error.request);
        } else {
            console.error("Request error:", error.message);
        }
    });