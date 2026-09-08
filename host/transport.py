"""
Where the device is.

Three ways in, and the choice is not really about preference:

  VELA_SPECULOS=1   the emulator, over TCP on 9999. The APDU layer is
                    identical, which is the point: policy logic, refusal
                    codes and protobuf shapes can all be exercised without
                    touching hardware.

  the bridge        host/bridge.py, if it is up. macOS gives the HID
                    interface to one process at a time, so anything that
                    opens the device directly fails the moment the bridge
                    holds it — and the failure is an opaque `OSError: open
                    failed`, not "something else has this". Preferring the
                    bridge when it is listening means a tool can run
                    alongside the gateway instead of demanding the rest of
                    the stack be shut down first.

  direct USB        when nothing else is running.

Anything about NVRAM surviving a restart still has to run on the Flex.
"""
import json
import os
import urllib.error
import urllib.request


class DeviceUnreachable(Exception):
    """
    The bridge could not talk to the device at all.

    Distinct from CommException on purpose: a status word is the chip
    answering, and this is the chip not being there. Callers that treat every
    failure as a refusal report a locked device as a policy decision.
    """


class CommException(Exception):
    """Mirrors ledgerblue's, so callers can read .sw the same way."""

    def __init__(self, sw: int, data: bytes = b""):
        super().__init__(f"Invalid status {sw:04x}")
        self.sw = sw
        self.data = data


class _Bridge:
    """A dongle-shaped object that speaks to host/bridge.py."""

    def __init__(self, url: str, timeout: int = 200):
        self.url = url
        self.timeout = timeout

    def exchange(self, apdu: bytes, timeout: int = None) -> bytearray:
        req = urllib.request.Request(
            f"{self.url}/apdu",
            data=json.dumps({"apdu": bytes(apdu).hex()}).encode(),
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                body = json.load(r)
        except urllib.error.HTTPError as e:
            # The bridge answers non-2xx when it could not reach the device at
            # all, and puts the reason in the body. Letting urllib's exception
            # escape gives the caller a traceback about HTTP, which is never
            # the interesting half — the interesting half is usually "the Vela
            # app is not open" or "the device is locked".
            try:
                detail = json.load(e).get("error", "")
            except Exception:
                detail = ""
            raise DeviceUnreachable(detail or f"the bridge answered {e.code}") from None
        except urllib.error.URLError as e:
            raise DeviceUnreachable(f"no bridge at {self.url}: {e.reason}") from None
        sw = body["sw"]
        data = bytes.fromhex(body.get("data") or "")
        if sw != 0x9000:
            raise CommException(sw, data)
        return bytearray(data)

    def close(self):
        pass


def _bridge_url() -> str:
    return os.environ.get("VELA_BRIDGE", "http://127.0.0.1:8099")


def _bridge_is_up(url: str) -> bool:
    try:
        _Bridge(url, timeout=5).exchange(bytes([0xB0, 0x01, 0, 0, 0]))
        return True
    except CommException:
        return True          # it answered; the status word is the app's business
    except Exception:
        return False


def open_device():
    if os.environ.get("VELA_SPECULOS"):
        from ledgerblue.commTCP import getDongle as tcp
        return tcp(server="127.0.0.1", port=9999)

    # VELA_NO_BRIDGE forces the direct handle. The persistence test needs it:
    # it quits and relaunches the application, and the bridge cannot relay a
    # command to a dashboard it is not holding — nor survive the app exiting
    # mid-exchange. Anything driving the device's lifecycle has to own it.
    url = _bridge_url()
    if not os.environ.get("VELA_NO_BRIDGE") and _bridge_is_up(url):
        return _Bridge(url)

    from ledgerblue.comm import getDongle
    return getDongle(False)


def where() -> str:
    if os.environ.get("VELA_SPECULOS"):
        return "speculos"
    if os.environ.get("VELA_NO_BRIDGE"):
        return "usb"
    return "bridge" if _bridge_is_up(_bridge_url()) else "usb"
