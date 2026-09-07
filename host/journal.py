"""
Every interaction with the device, timestamped, on disk.

Three factory resets in two days, and each time the evidence was whatever
anyone happened to remember. Ledger's protection mode says an event was
interpreted as an attack and does not say which event, so the only way to
learn anything from a fourth occurrence is to have the preceding hours
written down before it happens.

Deliberately dumb: append-only JSON lines, no rotation, no analysis. It costs
nothing to write and the whole point is that it is already there when someone
finally needs it.
"""
import json
import os
import sys
import time

PATH = os.environ.get(
    "VELA_JOURNAL",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 ".vela-journal.jsonl"),
)


_complained = False


def record(event: str, **fields) -> None:
    """
    Append one entry. Never raises: instrumentation must not break the run.

    It does complain, once, and that is the lesson from the first gap. This
    journal exists so a fourth device reset produces evidence rather than a
    fourth guess — and it went quiet for nine hours across a session of real
    grants and payments without a word. A recorder that fails silently is
    worse than none, because it is believed.
    """
    global _complained
    try:
        line = {"t": round(time.time(), 3),
                "iso": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "event": event}
        line.update(fields)
        with open(PATH, "a") as f:
            f.write(json.dumps(line) + "\n")
    except Exception as e:
        if not _complained:
            _complained = True
            print(f"[journal] cannot write {PATH}: {e} — "
                  f"device history is NOT being recorded", file=sys.stderr, flush=True)


def tail(n: int = 40):
    """The last n entries, for reading after something has gone wrong."""
    try:
        with open(PATH) as f:
            lines = f.readlines()[-n:]
        return [json.loads(x) for x in lines]
    except FileNotFoundError:
        return []


if __name__ == "__main__":
    import sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    for e in tail(n):
        extra = " ".join(f"{k}={v}" for k, v in e.items()
                         if k not in ("t", "iso", "event"))
        print(f"{e['iso']}  {e['event']:22} {extra}")
