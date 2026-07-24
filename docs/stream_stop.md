# /api/stream/stop
Stops live streaming a camera device.

***Note: This endpoint is still experimental and may have issues.***

## Request
Make a ```POST``` request to ```/api/stream/stop``` using the request body:
```json
{}
```

## Response
Returns a json formatted like:
```json
{
    "active": false,
    "dumpDir": "Stream h264 System Output Directory (Only Active When debug_mode: true in the env file)",
    "logDir": "Stream Log System Output Directory (Only Active When debug_mode: true in the env file)",
    "eventCount": count of events in log,
    "session": null
}
```