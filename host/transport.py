"""
Where the device is.

VELA_SPECULOS=1 talks to the emulator over TCP on 9999 instead of USB. The
APDU layer is identical, which is the point: policy logic, refusal codes and
protobuf shapes can all be exercised without touching hardware — and without
a wedged USB pipe taking the rest of the session down with it.

Anything about NVRAM surviving a restart still has to run on the Flex.
"""
import os


def open_device():
    if os.environ.get("VELA_SPECULOS"):
        from ledgerblue.commTCP import getDongle as tcp
        return tcp(server="127.0.0.1", port=9999)
    from ledgerblue.comm import getDongle
    return getDongle(False)


def where() -> str:
    return "speculos" if os.environ.get("VELA_SPECULOS") else "usb"
