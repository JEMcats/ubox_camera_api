# /api/user/get_cloud_video_url
Gets recorded events in a time range.

***Note: This endpoint has had issues recently and may not be avalible.***

## Request
Make a ```POST``` request to ```/api/user/get_cloud_video_url``` using the request body:
```json
{
    "uid": "device_uid From Cloud List",
    "bucket_name": "bucket_name From Cloud List",
    "image": "From Cloud List",
    "endpoint": "From Cloud List",
    "guid": "uuid in cloud list"
}
```

## Response
Returns a json formatted like:
```json
{
    "guid": "uuid in the cloud list",
    "video_url": "Url To The Video",
    "expired_second": 3600,
    "cloud_provider": "1_amazon"
},
```
