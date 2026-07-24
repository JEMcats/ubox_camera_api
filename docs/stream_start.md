# /api/stream/start
Starts live streaming a camera device.

***Note: This endpoint is still experimental and may have issues.***

## Request
Make a ```POST``` request to ```/api/stream/start``` using the request body:
```json
{
    "uid": "Device uid",
    "streamIndex": use 0 for SD and 1 for HD quality streaming,
    "options": {
        "forceRestart": false
    }
}
```

## Response
Returns a json formatted like:
```json
{
    "active": true,
    "dumpDir": "Stream h264 System Output Directory (Only Active When debug_mode: true in the env file)",
    "logDir": "Stream Log System Output Directory (Only Active When debug_mode: true in the env file)",
    "eventCount": events in the log,
    "session": {
        "uid": "device uid",
        "loginIdPresent": true,
        "loginPwdPresent": true,
        "randomId": random identifier,
        "sid": 0,
        "remoteSid": 0,
        "videoSid": 0,
        "channel": 0,
        "streamIndex": 1,
        "nativeVideoRouting": {
            "twoSensorDevice": false,
            "rule": "all-frames-to-primary"
        },
        "sessionState": {
            "state": 1,
            "localSid": local session id,
            "peerSidByte": 0,
            "peerValue08": 0,
            "peerValue0a": 0,
            "seqByte": 205,
            "relayMode": 1,
            "liveMissCount": 0,
            "aliveSendCount": 0,
            "queryRetriesLeft": 10,
            "relayWakeRetriesLeft": 0,
            "relayStreamRetriesLeft": 0
        },
        "dumpDir": "Stream h264 System Output Directory (Only Active When debug_mode: true in the env file)",
        "logDir": "Stream Log System Output Directory (Only Active When debug_mode: true in the env file)",
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
            "rx": 0,
            "tx": 6,
            "decoded": 0,
            "queryPackets": 1,
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
        "startedAt": "started at timestamp"
    }
}
```
After this response comes back, the following streams will be avalible (it may take more time for the first frames to be avalible):

|Stream|Protocol|Endpoint|
|-----|-----|-----|
|Primary|h264|```/api/stream/live.h264?track=primary```|
|Primary|HLS|```/api/stream/live.m3u8?track=primary```|
|Primary|RTSP|```rtsp://localhost:<rtsp_port>/primary```|
|Secondary|h264|```/api/stream/live.h264?track=secondary```|
|Secondary|HLS|```/api/stream/live.m3u8?track=secondary```|
|Secondary|RTSP|```rtsp://localhost:<rtsp_port>/secondary```|

HLS streams/segments are routed through ```/api/stream/hls/<track>/<segment>.ts```.
RTSP port defaults to ```8022``` but can be changed during setup.