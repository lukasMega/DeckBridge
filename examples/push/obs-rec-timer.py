"""OBS script: show "REC MM:SS" on a DeckBridge key bound to the channel "obs-rec".

UNTESTED in OBS. Load it via Tools -> Scripts, then fill in the URL and token properties.
Standard library only.
"""
import json
import time
import urllib.request

import obspython as obs

url = "http://127.0.0.1:3000"
token = ""
started = None


def push(payload):
    req = urllib.request.Request(
        f"{url}/api/push/obs-rec",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=2).close()
    except Exception as e:  # never break OBS over a missed update
        print("deckbridge push failed:", e)


def clear():
    req = urllib.request.Request(
        f"{url}/api/push/obs-rec",
        headers={"Authorization": f"Bearer {token}"},
        method="DELETE",
    )
    try:
        urllib.request.urlopen(req, timeout=2).close()
    except Exception as e:
        print("deckbridge clear failed:", e)


def tick():
    if started is None:
        return
    s = int(time.time() - started)
    push({"text": f"REC\n{s // 60:02d}:{s % 60:02d}", "ttl": 5, "background": "#b00020"})


def on_event(event):
    global started
    if event == obs.OBS_FRONTEND_EVENT_RECORDING_STARTED:
        started = time.time()
        obs.timer_add(tick, 1000)
    elif event == obs.OBS_FRONTEND_EVENT_RECORDING_STOPPED:
        obs.timer_remove(tick)
        started = None
        clear()


def script_description():
    return "Shows the recording time on a DeckBridge key (channel obs-rec)."


def script_properties():
    props = obs.obs_properties_create()
    obs.obs_properties_add_text(props, "url", "DeckBridge URL", obs.OBS_TEXT_DEFAULT)
    obs.obs_properties_add_text(props, "token", "Push token", obs.OBS_TEXT_PASSWORD)
    return props


def script_update(settings):
    global url, token
    url = obs.obs_data_get_string(settings, "url") or url
    token = obs.obs_data_get_string(settings, "token")


def script_load(settings):
    obs.obs_frontend_add_event_callback(on_event)
