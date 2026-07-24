# /api/v2/user/card4g-info
Gets info about the sim card plan for a device.

***Note: This endpoint has had issues recently and may not be avalible.***

## Request
Make a ```POST``` request to ```/api/v2/user/card4g-info``` using the request body:
```json
{
    "icc_id": "Sim Card ICC Id Of Your Device"
},
```

## Response
Returns a json formatted like:
```json
{
    "icc_id": "Sim Card ICC Id",
    "supplier": 6,
    "operator": "international",
    "data_total": 61439,
    "data_used": 7511,
    "data_left": 53928,
    "activated_at": "2023-11-23",
    "effective_at": "",
    "expired_at": "2024-12-29",
    "expired_at_utc": 1729339041,
    "state": 0,
    "batch": "A-230726",
    "status": "ACTIVATED_NAME",
    "flow_unlimit": false,
    "card_suit_id": "16",
    "only_free": false,
    "card_pkg_flow_status": "normal",
    "card_pkg_expire_status": "normal",
    "is_live_control": false,
    "live_keep_seconds": 0
}
```
