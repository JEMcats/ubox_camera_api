# About

uBox Camera API is made to take your existing uBox cameras and get infromation from them.

There is no official uBox Camera API documentation so this is an unofficial API.

We are NOT affiliated, associated, authorized, endorsed by, or in any way officially connected with UBIA TECHNOLOGIES CO. The official Ubia website can be found at [ubianet.com](https://www.ubianet.com).

# Features

| Features   | Status |
| -------- | ------- |
| List Of Devices | Available |
| Sim Card Info | Available |
| Cloud Recording List | Available |
| Events Calendar | Available |
| Get Cloud Video Url | Available |
| Get Subscribed iOS Devices | Available |
| uBox Camera Streaming | ***Experimental*** |
| API Documentation | Avalible |
| Web Interface | Upcoming |
| Stream Recording | Upcoming |

***Note: Features marked as "Experimental" may experience issues. Please report any problems in Github issues.***

# Install

Choose the correct install for your system

## MacOS
Install Homebrew
```
$ /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" 
```

Install NPM and Git
```
$ brew install npm git
```

Clone Repo
```
$ git clone https://github.com/JEMcats/ubox_camera_api.git
```

Navigate To The Cloned Repo
```
$ cd ubox_camera_api
```

Install The Required Dependiences
```
$ npm install
```
The API is now setup and ready to be used.

## Linux

Choose the install for your Linux Distribution

### Ubuntu

Install NPM And Git
```
$ sudo apt update
sudo apt install npm git
```

Clone The Repo
```
$ git clone https://github.com/JEMcats/ubox_camera_api.git
```

Navigate To The Cloned Repo
```
$ cd ubox_camera_api
```

Install The Required Dependiences
```
$ npm install
```
The API is now setup and ready to be used.

### Other Distributions

If there is another Linux distibution you would like added feel free to open a pull request.

## Windows

As of now we do not have an install guide for Windows, if you would you would like this added feel free to open a pull request.

# Usage

Navigate to the directory you have cloned from this repo. If you have not cloned the repository yet please follow the installation directions.

## Setup

Start by copying/renaming ```.env.example``` to ```.env```. 

Then fill out your username and password in ```.env```. (You may also change ports as needed)

Setup is complete 🎉.

## Hosting API

Onece you have followed the Setup instructions above, run the following command:
```
$ npm run main
```

Login should automatically run and load stored login if possible

Once your server has started you will see:
```
Server running on port 8020
```
in your console.

If you would like to change the port, modify the ```server_port``` varible in the env file.

***Note: RTSP uses a different port***

## API usage

See the [/docs](https://github.com/JEMcats/ubox_camera_api/tree/main/docs/) directory in this repo!

# Using The Password Hashing Tool

To hash you password to for using the raw login endpoint [```portal.ubianet.com/api/v3/login```](https://github.com/JEMcats/ubox_camera_api/tree/main/api_docs/portal.ubianet.com/api/v3/login.json), you will need to hash your password with ```hash_password.js```.

To start make sure that the ```password=YOUR_PASSWORD``` value is set in your ```.env``` file.

Run this on the command line:
```
$ node hash_password.js
```

Wait for the console to say
```
Hashed Password: HASHEDPASSWORD,
```

Copy the hashed password and use it as your password in the POST Request JSON Body.
# Contributing

***Note: If you are planning on modifying files in ```src/stream```, I highly recommend making pull requests to [ubox-web](https://github.com/asyrk/ubox-web) instead of this repo! Changes will be pulled to this repo as needed.***

To start make a fork of the dev branch.

In your fork make the changes you would like make.

Fill out the information for the pull request.

When you are ready open your pull request.

# Troubleshooting
Here are some troubleshooting steps to take before making a Github issue.

## ```login.js```
Here are some troubleshooting steps for ```login.js```

### Reset Your Password Without Special Characters
In the uBox app reset your password, ensure you do not use special characters in the new password, and try login in with ```login.js``` again.

<!-- ## ```server.js``` -->

# Credits
- [@JEMcats](https://github.com/jemcats) - Owner/Creator
- [@asyrk](https://github.com/asyrk) - Camera streaming code, [ubox-web](https://github.com/asyrk/ubox-web)