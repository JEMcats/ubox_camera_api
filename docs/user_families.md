# /api/user/families
This endpoint returns a list of homes and info about them.

## Request
Make a ```GET``` request to ```/api/user/families```.

## Response
Formatted like:
```json
[
    {
        "id": "Home Id",
        "name": "My home",
        "zone_id": 1,
        "country_code": "E2",
        "province": "New York",
        "city": "",
        "addr_1": "",
        "addr_2": "",
        "zip_code": "",
        "geo_info": {},
        "lbs_code": "LBS code"
    }
]
```