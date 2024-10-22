require('dotenv').config();
var sha1 = require('js-sha1');
// HMAC SHA-1 with Base64 Encoding
    var hash = sha1.hmac.array('', process.env.password);
    var base_hash = Buffer.from(hash).toString('base64');
    // Replace the last character with a comma
    const modifiedSignature =  base_hash.replace(/.$/, ',');
    
    console.log('Hashed Password:', modifiedSignature);
