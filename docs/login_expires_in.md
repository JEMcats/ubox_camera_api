# /api/login/expires_in
Gets latest 1000 log lines from the connected live stream.

## Request
Make a ```GET``` request to ```/api/login/expires_in```.

## Response
Returns a json formatted like:
```json
{
    "hours_since_login": returns the amount of time formatted in hours since login credentials were saved,
    "token_valid_for": returns the amount of time formatted in hours it takes for saved login credentials to expire
}
```
Note: These values allow you to calculate the amount of time remaining on the stored login by subtracting ```hours_since_login``` from ```token_valid_for```