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
| uBox Camera Stream To RTSP | Upcoming |
| Web Interface | Upcoming |
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

## Login
To login to the API create a .env file and write the following
```
email=your_email
password=your_password
```
Once you have completed that run the following command
```
$ node login.js
```
This will generate a users.json file which will contain your token and other infromation.

If the uBox Camera API ever stops working it is most likely that your login has expired, please run ``` login.js ``` again.

## Hosting API

Coming Soon!