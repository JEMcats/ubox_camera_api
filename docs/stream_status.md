# /api/stream/status
Gets current status about the connected (or disconnected) live stream.

## Request
Make a ```GET``` request to ```/api/stream/status```.

## Response
Changes based on current stream status:

Disconnected:
```json
{
    "active": false,
    "dumpDir": "Stream h264 System Output Directory (Only Active When debug_mode: true in the env file)",
    "logDir": "Stream Log System Output Directory (Only Active When debug_mode: true in the env file)",
    "eventCount": 0,
    "session": null,
    "events": []
}
```

Connected:
```json
{
    "active": true,
    "dumpDir": "Stream h264 System Output Directory (Only Active When debug_mode: true in the env file)",
    "logDir": "Stream Log System Output Directory (Only Active When debug_mode: true in the env file)",
    "eventCount": 146,
    "session": {
        "uid": "Camera UUID",
        "loginIdPresent": true,
        "loginPwdPresent": true,
        "randomId": Random Identifier,
        "sid": 0,
        "remoteSid": 0,
        "videoSid": 0,
        "channel": 0,
        "streamIndex": 1 or 0,
        "nativeVideoRouting": {
            "twoSensorDevice": true or false (depends on if your camera has 2 lenses or not),
            "rule": "all-frames-to-primary"
        },
        "sessionState": {
            // All values at 0, will be different in reality
            "state": 0,
            "localSid": 0,
            "peerSidByte": 0,
            "peerValue08": 0,
            "peerValue0a": 0,
            "seqByte": 0,
            "relayMode": 0,
            "liveMissCount": 0,
            "aliveSendCount": 0,
            "queryRetriesLeft": 0,
            "relayWakeRetriesLeft": 0,
            "relayStreamRetriesLeft": 0
        },
        "dumpDir": "Stream h264 System Output File (Only Active When debug_mode: true in the env file)",
        "logDir": "Stream Log System Output File (Only Active When debug_mode: true in the env file)",
        "mp4Ready": false,
        "mp4Codec": null,
        "streamFormat": null,
        "streamCodec": null,
        "mp4Backlog": 0,
        "h264Backlog": 0,
        "h264Tracks": {
            "primary": {
                "clients": 0,
                "backlog": 0,
                "frames": 0
            },
            "secondary": {
                "clients": 0,
                "backlog": 0,
                "frames": 0
            }
        },
        "counters": {
            // All values at 0, will be different in reality
            "rx": 0,
            "tx": 0,
            "decoded": 0,
            "queryPackets": 0,
            "relayWakePackets": 0,
            "kcpSegments": 0,
            "kcpMessages": 0,
            "videoFrames": 0,
            "annexBFrames": 0,
            "bytesWritten": 0,
            "mp4Clients": 0,
            "mp4Fragments": 0,
            "h264Clients": 0,
            "h264Frames": 0,
            "h264DroppedFrames": 0,
            "kcpGapDrops": 0,
            "kcpInputErrors": 0,
            "kcpOutputPackets": 0,
            "rdtAckPackets": 0,
            "rdtPackets": 0,
            "rdtFrames": 0,
            "rdtFrameDrops": 0,
            "videoKicks": 0,
            "relayRenews": 0,
            "alivePackets": 0,
            "knockPackets": 0,
            "knockAcks": 0,
            "logoutPackets": 0
        },
        "kcpState": null,
        "startedAt": "stream start time"
    },
    "events": [
       // The latest 1000 log lines.
    ]
}
```