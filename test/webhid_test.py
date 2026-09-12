"""
The Ledger connection in the corner of the console, driven in a browser.

The bug this exists for: the page opened the Flex over WebHID, reported the
app and the version correctly, and took the rest of the console down with it —
every fleet slot on ECONNREFUSED, because macOS gives the HID interface to one
process and the browser had just taken it from host/bridge.py. Underneath that
was a second one: web/ledger.js reassembled multi-packet replies by returning
whatever had arrived, so every reply over 57 bytes came back truncated. The
only call the device panel makes is fourteen bytes, which is why the one thing
anyone could watch working was the one thing that could not show the fault.

Neither was visible to any other suite here, because neither is reachable
without a browser holding a device.

So: a real Chromium, the real page, the real console and the real gateway —
with one layer stubbed. navigator.hid answers from test/fixtures/flex-apdu.json,
recorded off a Ledger Flex, so this needs no device and no emulator. If the
console ever asks the chip something the recording does not contain, that is a
failure rather than a skip: the fixture is a claim about what the page asks.

    python3 test/webhid_test.py

Skips, rather than fails, when playwright is missing or when something is
already on the bridge's port — a tab cannot take a device host/bridge.py is
holding, and saying so is the correct outcome, not a red test.
"""
import json
import os
import socket
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.environ.get("VELA_WEB", "http://127.0.0.1:4050")
BRIDGE_PORT = int(os.environ.get("VELA_BRIDGE_PORT", "8099"))
FIXTURE = os.path.join(HERE, "fixtures", "flex-apdu.json")

# Everything the recording knows the page asks for, keyed by APDU. Anything
# else is a question this test has never seen the console ask.
REPLIES = json.load(open(FIXTURE))

STUB = """
(() => {
  const CHANNEL = 0x0101, TAG = 0x05, PACKET = 64;
  const listeners = [];
  let inbuf = [];

  function unframe(packets) {
    let expected = null; const out = [];
    for (let i = 0; i < packets.length; i++) {
      const p = packets[i];
      if (i === 0) {
        expected = new DataView(p.buffer, p.byteOffset).getUint16(5);
        out.push(...p.subarray(7));
      } else out.push(...p.subarray(5));
      if (out.length >= expected) break;
    }
    return expected === null || out.length < expected ? null
         : new Uint8Array(out.slice(0, expected));
  }
  function frame(apdu) {
    const body = new Uint8Array(2 + apdu.length);
    new DataView(body.buffer).setUint16(0, apdu.length);
    body.set(apdu, 2);
    const packets = [];
    for (let seq = 0, at = 0; at < body.length || seq === 0; seq++) {
      const head = new Uint8Array(PACKET);
      const dv = new DataView(head.buffer);
      dv.setUint16(0, CHANNEL); head[2] = TAG; dv.setUint16(3, seq);
      const chunk = body.subarray(at, at + PACKET - 5);
      head.set(chunk, 5); packets.push(head); at += chunk.length;
    }
    return packets;
  }

  const device = {
    vendorId: 0x2c97, productId: 0x5011, productName: "Ledger Flex (recorded)",
    opened: false,
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    addEventListener(t, fn) { if (t === "inputreport") listeners.push(fn); },
    removeEventListener(t, fn) {
      const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
    },
    async sendReport(_id, packet) {
      inbuf.push(new Uint8Array(packet));
      const apdu = unframe(inbuf);
      if (!apdu) return;                      // the rest is still coming
      inbuf = [];
      const hex = [...apdu].map(b => b.toString(16).padStart(2, "0")).join("");
      const r = await window.velaApdu(hex);
      // The recording holds what the bridge returns, which is the reply with
      // its status word already stripped. WebHID does not strip it.
      const data = r.data ?? "";
      const sw = r.sw ?? 0x6f00;
      const bytes = Uint8Array.from(
        ((data.match(/../g) ?? []).map(h => parseInt(h, 16)))
        .concat([(sw >> 8) & 0xff, sw & 0xff]));
      for (const p of frame(bytes)) {
        for (const fn of listeners) fn({ data: new DataView(p.buffer) });
      }
    },
  };
  // A prototype getter in Chromium: a plain assignment is dropped in silence
  // and the page goes on talking to the real, empty API.
  Object.defineProperty(navigator, "hid", {
    configurable: true,
    value: {
      async getDevices() { return [device]; },
      async requestDevice() { return [device]; },
    },
  });
})();
"""


def port_busy(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("\n  playwright is not installed — skipping the WebHID check.")
        print("  pip3 install playwright && playwright install chromium\n")
        return 0

    try:
        urllib.request.urlopen(f"{WEB}/api/config", timeout=3).read()
    except Exception:
        print(f"  not running on {WEB} — skipped")
        return 0

    if port_busy(BRIDGE_PORT):
        # Correct behaviour, not a failure: a tab cannot take a device that
        # host/bridge.py is holding, and the console says so rather than
        # pretending.
        print(f"  something is on :{BRIDGE_PORT} — a tab cannot take over, skipped")
        return 0

    results = []
    def check(name, ok, detail=""):
        results.append(ok)
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not ok else ""))

    asked = []
    missing = []

    def replay(hex_apdu):
        asked.append(hex_apdu)
        if hex_apdu not in REPLIES:
            missing.append(hex_apdu)
            return {"data": "", "sw": 0x6f00}
        return REPLIES[hex_apdu]

    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1440, "height": 1100})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.expose_function("velaApdu", replay)
        page.add_init_script(STUB)
        page.goto(WEB, wait_until="domcontentloaded")
        page.wait_for_timeout(4000)

        page.locator("#device").click()
        page.wait_for_timeout(600)

        connect = page.locator("#device-connect")
        check("the console offers to connect when no bridge is up",
              connect.is_visible())
        if not connect.is_visible():
            b.close()
            return 1

        connect.click()
        page.wait_for_timeout(7000)

        state = page.locator("#device-state").inner_text()
        facts = page.locator("#device-facts").inner_text()
        check("the panel reports the device", state == "Connected", state)
        check("and says the tab is holding it", "WebHID" in facts, facts)
        # The fix, stated as a fact on screen: the tab did not take the device
        # away from the console, it is answering for it.
        check("and that it is answering for the bridge",
              ":8099" in facts, facts)

        page.wait_for_timeout(6000)
        agents = page.locator("#agents .agent").all_inner_texts()
        live = [a for a in agents if "free" not in a and "unknown" not in a]
        check("the fleet reads the chip through the tab", len(live) >= 1,
              json.dumps(agents)[:200])
        check("no slot fell back to a refused bridge",
              not any("ECONNREFUSED" in a for a in agents))
        # The truncation bug lived here: a mandate is well over one packet, so
        # a short read makes every figure on this row wrong or absent.
        check("and the figures survived reassembly",
              any("HBAR" in a for a in live), json.dumps(live)[:200])
        check("the envelope loaded",
              page.locator("#available").inner_text().strip() not in ("—", ""))

        page.locator("#device-disconnect").click()
        page.wait_for_timeout(3000)
        after = page.locator("#device-state").inner_text()
        check("releasing the device says so plainly",
              after != "Connected" and after != "Waiting on a screen", after)

        check("nothing the page asked was outside the recording",
              not missing, ", ".join(missing[:4]))
        check("the page raised no errors", not errors, "; ".join(errors[:2]))
        b.close()

    passed = sum(1 for r in results if r)
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
