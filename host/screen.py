"""
Drive and read the emulated device screen.

Speculos exposes what is drawn, with coordinates, and accepts touch events.
That makes the interface testable: we can assert on the words a user would
actually read before approving a mandate, rather than trusting that the
right buffer was formatted somewhere.

Only for the emulator. On hardware a human taps, which is the entire point.
"""
import json
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:5001"


def _get(path):
    with urllib.request.urlopen(API + path, timeout=5) as r:
        return json.load(r)


def _post(path, payload):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.read()


def clear():
    """Drop the event log. Speculos accumulates every screen ever drawn, so
    without this a read returns the whole session's history."""
    req = urllib.request.Request(API + "/events", method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=5):
            pass
    except urllib.error.URLError:
        pass


def texts():
    """Everything currently on screen, as (text, x, y)."""
    try:
        ev = _get("/events?currentscreen=true")["events"]
    except (urllib.error.URLError, KeyError):
        ev = _get("/events")["events"]
    return [(e["text"], e["x"], e["y"]) for e in ev]


def screen() -> str:
    return " | ".join(t for t, _, _ in texts())


def tap(x, y):
    _post("/finger", {"action": "press-and-release", "x": int(x), "y": int(y)})
    time.sleep(0.4)


def swipe(direction="left", y=300):
    """NBGL reviews page with a swipe, not a tap."""
    x1, x2 = (400, 80) if direction == "left" else (80, 400)
    _post("/finger", {"action": "press", "x": x1, "y": y})
    time.sleep(0.1)
    _post("/finger", {"action": "release", "x": x2, "y": y})
    time.sleep(0.5)


def long_press(x=240, y=470, seconds=2.5):
    """NBGL's final confirmation is a hold, not a tap."""
    _post("/finger", {"action": "press", "x": int(x), "y": int(y)})
    time.sleep(seconds)
    _post("/finger", {"action": "release", "x": int(x), "y": int(y)})
    time.sleep(0.8)


def tap_text(needle, occurrence=-1):
    """Tap the element whose label contains `needle`."""
    hits = [(t, x, y) for t, x, y in texts() if needle.lower() in t.lower()]
    if not hits:
        raise LookupError(f"{needle!r} is not on screen: {screen()}")
    t, x, y = hits[occurrence]
    tap(x + 40, y + 12)
    return t


def wait_for(needle, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if any(needle.lower() in t.lower() for t, _, _ in texts()):
            return True
        time.sleep(0.3)
    return False


def shot(path):
    """Save what is on screen. Useful for the README and the demo."""
    with urllib.request.urlopen(API + "/screenshot", timeout=5) as r:
        data = r.read()
    with open(path, "wb") as f:
        f.write(data)
    return path
