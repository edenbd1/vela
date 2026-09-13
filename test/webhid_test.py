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
import time
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

# The mandate replies, captured off the same device, so a browser reading the
# chip on its own has something to read. Kept in their own file because they
# also pin web/mandate.js against the gateway's parser.
_MANDATES = os.path.join(HERE, "fixtures", "mandate-bytes.json")
for _slot, _rec in json.load(open(_MANDATES)).items():
    REPLIES[f"e010{int(_slot):02x}0000"] = {"data": _rec["apdu"], "sw": 0x9000}

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
        # ---------------------------------------------------------------
        # The same connection on a copy with no gateway behind it.
        #
        # vela-console.vercel.app has no bridge, no broker and no device — and
        # a browser there can still open a Ledger, because WebHID wants a
        # secure origin and a click and nothing else. So the page reads the
        # chip itself. That is a second reader of the wire format, which is
        # why web/mandate.js is pinned against the gateway's parser, and it is
        # a second path through the device panel, which is this.
        # The first page is done with the device. Left open it goes on polling
        # it every eight seconds through the same binding this one needs, and
        # two pages taking turns on one stub is not what is being tested here.
        try: page.close()
        except Exception: pass

        import http.server, socketserver, threading, shutil, tempfile
        static = tempfile.mkdtemp(prefix="vela-hid-static-")
        web = os.path.join(os.path.dirname(HERE), "web")
        for f in os.listdir(web):
            if f.endswith((".html", ".js", ".css", ".json")):
                shutil.copy(os.path.join(web, f), static)
        brand = os.path.join(os.path.dirname(web), "brand")
        if os.path.isdir(brand):
            shutil.copytree(brand, os.path.join(static, "brand"), dirs_exist_ok=True)

        class Quiet(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **k): super().__init__(*a, directory=static, **k)
            def log_message(self, *a): pass

        srv = socketserver.TCPServer(("127.0.0.1", 0), Quiet)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        sport = srv.server_address[1]

        flat = b.new_page(viewport={"width": 1280, "height": 1400})
        flat_errs = []
        flat.on("pageerror", lambda e: flat_errs.append(str(e)))
        flat_logs = []
        flat.on("console", lambda m: flat_logs.append(m.text[:200]))
        flat.expose_function("velaApdu", replay)
        flat.add_init_script(STUB)
        flat.goto(f"http://127.0.0.1:{sport}/", wait_until="domcontentloaded")
        flat.wait_for_timeout(6000)

        check("a copy with no gateway says so rather than blaming a bridge",
              "no device behind it" in flat.inner_text("#device-panel"),
              flat.inner_text("#device-panel")[:120])

        flat.locator("#device").click()
        time.sleep(0.6)
        offer = flat.locator("#device-connect")
        check("and still offers to connect, because WebHID needs no host",
              offer.is_visible() and not offer.is_disabled())

        if offer.is_visible() and not offer.is_disabled():
            offer.click()
            time.sleep(0.4)
            # Wait for the banner, not for the panel: the panel's poll can
            # paint "ready" from its own read while the slot walk is still
            # going, so the state settles before the page has finished
            # changing what it claims about itself.
            for _ in range(50):
                time.sleep(0.5)
                if "Your Flex" in flat.inner_text("#demo-banner"):
                    break
            check("connecting reads the chip with no gateway in the path",
                  flat.eval_on_selector("#device", "e => e.dataset.state") == "ready",
                  flat.inner_text("#device-panel")[:140])
            # Not the fleet's contents: a recording made on the same day as
            # the fixture holds the same figures, so "research-1 is on screen"
            # is true whichever half drew it. The panel's own sentence is only
            # ever written when this page holds the device, so that is the one
            # that distinguishes them.
            why = flat.inner_text("#device-why")
            check("and the panel says the page opened the device itself",
                  "opened your device itself" in why, why[:120])
            names = flat.eval_on_selector_all(
                "#agents .agent .name", "e => e.map(x => x.textContent)")
            check("with a fleet on screen", len(names) >= 3, f"{names}")

        check("the static copy raised no errors", not flat_errs,
              "; ".join(flat_errs[:2]))
        try: flat.close()
        except Exception: pass
        srv.shutdown()
        shutil.rmtree(static, ignore_errors=True)

        b.close()

    passed = sum(1 for r in results if r)
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
