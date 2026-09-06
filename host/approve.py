"""
Walk an NBGL review to its end, on the emulator.

Only for tests. On hardware this is a human reading four pages and holding a
button, which is the whole point of the device — but a test that needs a
human is a test nobody runs.
"""
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import screen


def approve(max_pages=8, verbose=False):
    """Swipe through the review and confirm. Returns the pages seen."""
    seen = []
    for _ in range(max_pages):
        time.sleep(0.6)
        txt = screen.texts()
        if txt:
            seen.append([t for t, _, _ in txt])
            if verbose:
                print("   ", " | ".join(t for t, _, _ in txt))
        screen.clear()

        labels = " ".join(t.lower() for t, _, _ in txt)
        if "hold to" in labels or "approve" in labels or "confirm" in labels:
            # The final page confirms on a hold, not a tap.
            screen.long_press()
            return seen
        screen.swipe("left")
    return seen
