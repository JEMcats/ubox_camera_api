# /api/user/cloud_list
Gets recorded events in a time range.

## Request
Make a ```POST``` request to ```/api/user/cloud_list``` using the request body:
```json
{
    "summer_time": 1,
    "time_revised": true,
    "device_uid": [
        "Your Device Identifier"
    ],
    "time_diff": -18000,
    "page": 1,
    "timestamp": [
        1783814400,
        1784332800
    ]
}
```

## Response
Returns a json formatted like:
```json
{
    "cloud": 1,
    "count": {
        "total": 1,
        "pages": 1,
        "page": 1,
        "page_num": 20
    },
    "list": [
        {
            "battery": 33,
            "bucket_name": "ubiabox-us",
            "cloud": 1,
            "cp": 1,
            "device_uid": "device id",
            "end_point": "storage endpoint",
            "event_time": timestamp of the event,
            "id": event id,
            "img": "image url",
            "realname": "",
            "status": 2,
            "type": 1,
            "uuid": "event uuid",
            "zone_id": "1",
            "cloud_image_url": "event thumbnail image url",
            "event_type_message": "",
            "ai_flag": 0,
            "ai_result": {},
            "user_tag": {},
            "video_info": {}
        }
    ],
    "service": true,
    "time_diff": -18000
}
```
