# /api/stream/events
Gets latest 1000 log lines from the connected live stream.

## Request
Make a ```GET``` request to ```/api/stream/events```.

## Response
Connects to a ```text/event-stream``` stream and gets the latest log entries, each message looks like:
```json
{
    "at": "Log entry timestamp",
    "event": "log-event-name",
    // other data related to the event
}
```