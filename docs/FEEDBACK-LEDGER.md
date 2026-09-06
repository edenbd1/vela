# Ledger — developer experience feedback

**Project:** Vela, a native BOLOS app that keeps an agent's spending envelope in
NVRAM and decides each draw on-chip.
**Device:** Ledger Flex (`target_id 0x33300004`, SE 1.6.1, MCU 6.9.2).
**Host:** macOS, Docker Desktop, `ledger-app-builder:latest`, `flex-secure-sdk`
v26.6.1 (API level 26), `ledgerwallet` 0.10.0.
**Scope:** everything below was hit on the standard path — clone
`app-boilerplate`, retarget it, define an APDU protocol, load it on a physical
device. No exotic cryptography, no unusual configuration, and no privileged
capability the app asked for.

**Cost, before the list starts:** one Ledger Flex factory-reset twice, and a
seed lost with it, from running the loader the boilerplate's own default
configuration produces.

---

## TL;DR

The platform is good, and the parts that are good are *very* good: NBGL, the
build image, the boilerplate, and the SDK's own `make -n load` are all
excellent. We shipped a working native app on day one, and this document
exists because we kept going, not because we struggled to start.

Every problem we hit falls into one pattern:

> **The failure surfaces far away from its cause, and the message points
> somewhere else.**

Thirteen times, the tooling knew exactly what was wrong and told us something
unrelated — or nothing at all. Most are a small fix, often one error string.

**Read \#13 first.** The boilerplate's default configuration factory-resets a
Flex on every sideload, in silence. It cost us a seed twice before we thought
to look at a number the loader prints without comment. Everything else in this
document is a papercut by comparison.

Three others are real bugs: \#10 writes past the end of a correctly sized
buffer, \#7 copies the wrong number of bytes, and \#12 is a documented build
option the SDK stopped reading, which kills the application at runtime with no
diagnostic anywhere.

---

## Triage

Ordered by what it costs the developer, not by the order we hit them.

| | finding | what it costs | where the fix is |
|---|---|---|---|
| 🔴 | [13 — `ENABLE_BLUETOOTH=1` factory-resets the device](#13-the-default-boilerplate-config-factory-resets-a-flex-on-every-sideload) | the seed, silently, on every sideload | `ledgerblue.loadApp` warning · boilerplate default |
| 🟠 | [10 — `bip32_derive_..._pubkey_256` writes 65 bytes for Ed25519](#10-bip32_derive_with_seed_get_pubkey_256-writes-65-bytes-for-ed25519) | stack overrun and a wrong key, failing far away | SDK, or one line of doc |
| 🟠 | [12 — the APDU buffer knob is no longer read](#12-the-makefile-knob-for-the-apdu-buffer-is-no-longer-read) | app dies at runtime, no status word | honour the variable or delete the line |
| 🟠 | [7 — `buffer_move()` copies the whole remainder](#7-buffer_move-does-the-opposite-of-what-its-signature-says) | every multi-field APDU fails on its first field | add `buffer_read_bytes()` |
| 🟡 | [11 — `io_send_response_pointer` keeps the pointer](#11-io_send_response_pointer-keeps-the-pointer) | stale bytes returned with a success status | one line of doc |
| 🟡 | [1 — the SDK silently needs a git repository](#1-the-sdk-requires-a-git-repository-and-fails-at-link-time-instead) | `undefined symbol: app_main`, cause elsewhere | make the guard fatal |
| 🟡 | [2 — `ledgerctl install` cannot install on Flex](#2-ledgerctl-install-cannot-install-on-flex-and-says-0x6512) | `0x6512`, no path forward | teach `manifest_toml.py` about `apiLevel` |
| 🟡 | [8 — `@ledgerhq/ledger-key-ring-protocol` is uninstallable](#8-ledgerhqledger-key-ring-protocol-cannot-be-installed-from-npm) | a dead dependency on the published package | publish the missing dep |
| 🟡 | [9 — its ESM build does not load in Node](#9-the-esm-build-of-hw-ledger-key-ring-protocol-does-not-load-in-node) | extensionless imports | emit extensions |
| ⚪ | [3 — two manifests with near-identical names](#3-two-manifests-with-near-identical-names-and-no-cross-reference) | "wrong kind of file" | detect the shape |
| ⚪ | [4 — `install-ca` demands recovery mode](#4-install-ca-demands-recovery-mode-without-saying-whether-you-need-it) | an unnecessary detour | one sentence |
| ⚪ | [5 — nothing says to quit Ledger Wallet](#5-nothing-says-to-quit-ledger-wallet-first) | drifting status words | detect the process |
| ⚪ | [6 — `ledgerctl run` has no inverse](#6-ledgerctl-run-app-has-no-inverse) | no way back to the dashboard | a dashboard command |

**If only one thing changes:** `ledgerblue.loadApp` already knows the flags and
already talks to the device. One line — *"this will erase the device's seed"* —
would have prevented both wipes.

---

## What was great

- **NBGL is a genuine UI framework, not a widget set.** `BARS_LIST`,
  `INFOS_LIST`, `INFO_BUTTON`, `nbgl_useCaseGenericConfiguration` let us build a
  real touch control panel — a mandate list where each row opens a detail page
  with its own action button. We expected to be able to *approve* things on the
  device; we did not expect to be able to build an actual interface. This is
  underplayed in the docs.
- **`ledger-app-builder` + `BOLOS_SDK=/opt/flex-secure-sdk`** worked first try.
- **The boilerplate already targets `apex_p` and Flex**, already declares the
  curve and path knobs, and already has an NVRAM storage pattern in place.
- **`make -n load`** is the single most useful debugging command on the
  platform. See finding 2 — it is what unblocked us.
- **`app-passwords` is an excellent reference** for NVRAM record storage
  (magic-guarded init, an array of records, a count). We found it by grepping
  the org; it deserves to be linked from the docs on persistent storage.

---

## 1. The SDK requires a git repository, and fails at link time instead

`Makefile.rules` line 61:

```makefile
APP_DIR := $(shell git rev-parse --show-toplevel)
ifeq ($(APP_DIR),)
    MSG := "[ERROR] You should be inside a git repo (you can use 'git init')"
```

The message exists. It never printed.

**What happens:** with no `.git`, `APP_DIR` is empty, the object-path stem
replacement produces nothing, and **every application source file is silently
dropped**. The whole SDK compiles, then:

```
ld.lld: error: undefined symbol: app_main
>>> referenced by main.c:74 (lib_standard_app/main.c:74)
```

**Why it is easy to hit:** copying the boilerplate into a new project without
its `.git` is the most natural way to start. It is also what happens when you
mount only the app directory into the builder container — `git rev-parse` sees
nothing from inside.

**Cost:** two build cycles and a wrong hypothesis, because `undefined symbol:
app_main` points at your own `app_main.c`, not at version control.

**Suggested fix:** make the guard fatal by default. If it must stay a warning,
add a second check before linking: if `APP_SOURCE_FILES` is empty, say so.

---

## 2. `ledgerctl install` cannot install on Flex, and says `0x6512`

`ledgerctl install <manifest.toml>` gets through the whole secure-channel
handshake, then dies:

```
CommException: Invalid status 6512 (Unknown reason)
```

Three parameters are missing, and only the first is documented anywhere:

| Parameter | `ledgerctl` | What the SDK actually sends |
| --- | --- | --- |
| `apiLevel` | only for Nano S+ — hardcoded in `manifest_toml.py::get_api_level` | `26` |
| `appFlags` | `0x000` from the manifest | `0x200` |
| `installparamsSize` | **no field exists in the TOML format** | `264` |

**How we found it:** `make -n load`, which prints the authoritative command:

```bash
python3 -m ledgerblue.loadApp --targetId 0x33300004 --targetVersion="" \
  --apiLevel 26 --fileName bin/app.hex --appName "Vela" --appFlags 0x200 \
  --delete --tlv \
  --dataSize $((_envram_data - _nvram_data)) \
  --installparamsSize $((_einstall_parameters - _install_parameters))
```

That worked immediately.

**Suggested fix:** either teach `manifest_toml.py` about `apiLevel` for every
NBGL device and add an `installparamsSize` field, or state plainly in the docs
that `ledgerctl install` does not support Stax/Flex/Apex and that
`ledgerblue.loadApp` is the path. Right now the tool looks like it should work.

**Related:** the `--dataSize` formula in the `ledgerctl` README is
`_envram_data - _nvram_data`. That is correct, but incomplete without
`--installparamsSize`, and the failure mode when you get it wrong is a bare
`AssertionError` on `assert code_length % 64 == 0` with no context. We spent a
cycle "fixing" `dataSize` to `_nvram_end - _nvram_data` (776), which makes the
assertion pass and the install fail later, because the real layout is
`code | nvram_data (512) | install_parameters (264)`.

---

## 3. Two manifests with near-identical names and no cross-reference

`ledger_app.toml` (SDK: `devices = [...]`, use-cases, test paths) and the
`ledgerctl` manifest (keyed by target id: `binary`, `dataSize`, `flags`, `icon`,
`derivationPath`) are unrelated formats with confusingly similar roles.

Passing the first to `ledgerctl` gives:

```
ValueError: TOML manifest has no installation information about the current device : Ledger Flex
```

which reads as "add your device to the list" — the fix we tried — rather than
"this is the wrong kind of file".

**Suggested fix:** detect the SDK manifest shape (an `[app]` table with
`devices`) and say so.

---

## 4. `install-ca` demands recovery mode without saying whether you need it

Chasing finding 2, we tried `ledgerctl install-ca "Vela Dev"`, on the reasonable
theory that unsigned code needs a trusted CA. It answered:

```
The device is not in recovery mode.
```

A custom CA is not required for ordinary sideloading. The message is true and
unhelpful: it explains the precondition for the command without saying the
command is not the one you want.

**Suggested fix:** one sentence — "a custom CA is only needed for X; to load a
development app, see …".

---

## 5. Nothing says to quit Ledger Wallet first

With Ledger Wallet running, `ledgerctl` commands returned drifting status words
— `0x6512`, then `0x6901`, then `0x5515` — on commands that had worked thirty
seconds earlier. Two processes were competing for the HID handle.

The symptom points at the device, or at your own APDUs. It does not point at
"another application holds the port", and we only found it by listing
processes.

**Suggested fix:** `ledgerctl` could detect the Ledger Wallet process and refuse
to start with an explanation. Failing that, one line at the top of the
sideloading docs.

---

## 6. `ledgerctl run <app>` has no inverse

You can launch an app from the host. You cannot exit one. Every
build → load → test cycle therefore requires a physical trip to the device to
tap "Quit app", because loading requires the dashboard.

On a tight loop this is the single largest source of friction, and it is
asymmetric for no obvious reason.

**Workaround:** we added a `QUIT_APP` instruction to our own app that calls
`os_sched_exit(0)`. Exiting is not a privileged action and the dashboard is the
safe state, so this seems harmless — but every app author will have to
reinvent it.

**Suggested fix:** a dashboard-level "return to dashboard" command, or document
the `os_sched_exit` pattern as the recommended development affordance.

---

## 7. `buffer_move()` does the opposite of what its signature says

This is the subtlest one and cost the most time.

```c
bool buffer_copy(const buffer_t *buffer, uint8_t *out, size_t out_len)
{
    if (buffer->size - buffer->offset > out_len) {
        return false;
    }
    memmove(out, buffer->ptr + buffer->offset, buffer->size - buffer->offset);
    return true;
}

bool buffer_move(buffer_t *buffer, uint8_t *out, size_t out_len)
{
    if (!buffer_copy(buffer, out, out_len)) return false;
    buffer_seek_cur(buffer, out_len);
    return true;
}
```

The name, the parameter order, and the doc comment ("Move bytes from buffer")
all read as *"read `out_len` bytes and advance"*. What it actually does is
*"copy the entire remaining buffer, and fail if more remains than `out_len`"*.

**Consequence:** any multi-field APDU payload fails on its **first** field, with
a bare `false`. Ours was:

```
agent_id (20) || n_services (1) || services (n×16) || budget (8) || per_call (8) || expiry (4)
```

73 bytes remaining, `out_len` 20, `73 > 20` → refused. We instrumented eleven
exit points with distinct status words to find it.

**Why the boilerplate never hits it:** `sign_tx` uses `buffer_move` only for a
trailing field that *is* the rest of the message, which is the one case where
the semantics coincide.

**Suggested fix:** add `buffer_read_bytes(buffer, out, n)` with the obvious
meaning, and note in `buffer_move`'s doc comment that it consumes the remainder.
Anyone writing their own APDU protocol — which is every native-app author —
will reach for `buffer_move` first.

---

## 8. `@ledgerhq/ledger-key-ring-protocol` cannot be installed from npm

The SDK for the feature this track asks people to build on does not install.

```
npm error 404 Not Found - GET https://registry.npmjs.org/@ledgerhq%2flive-dmk-speculos
npm error 404  '@ledgerhq/live-dmk-speculos@0.10.0' could not be found
```

The chain is `@ledgerhq/ledger-key-ring-protocol@0.15.2` →
`@ledgerhq/speculos-transport@0.10.6` → `@ledgerhq/live-dmk-speculos@0.10.0`,
and the last one is not on the registry at any version.

**Workaround:** `@ledgerhq/hw-ledger-key-ring-protocol@0.10.7` installs
cleanly on its own and is where the protocol lives — `AddMember`,
`EditMember`, `PublishKey`, `Permissions`, `SoftwareDevice`, `CommandStream`.
Building against it turned out to be the better choice anyway. But a
developer following the obvious path hits a 404 on their first command.

**Suggested fix:** publish `@ledgerhq/live-dmk-speculos`, or move
`speculos-transport` to an optional/dev dependency. Nothing about a
production key-ring integration needs an emulator transport at install time.

---

## 9. The ESM build of `hw-ledger-key-ring-protocol` does not load in Node

`lib-es/` uses extensionless relative imports (`from "./Device"`), which
bundlers resolve and native Node ESM does not:

```
ERR_MODULE_NOT_FOUND
url: '.../hw-ledger-key-ring-protocol/lib-es/Device'
```

The failure names a path *inside the package*, which reads like a broken
install rather than a packaging choice.

**Workaround:** use the CommonJS build — drop `"type": "module"` and
`require()` it.

**Suggested fix:** emit extensions in the ESM build, or set `"exports"` so
Node picks `lib/` automatically.

---

## 10. `bip32_derive_with_seed_get_pubkey_256` writes 65 bytes for Ed25519

The obvious destination for an Ed25519 public key is 32 bytes. The SDK writes
an **uncompressed point** — `0x04 || x || y` — so a 32-byte buffer is a
33-byte stack overrun on every call.

It does not fail there. The corruption lands on whatever the app does *next*:
in our case the following command opened an NBGL review and the app
disappeared, with no status word and no log. We spent an hour isolating the
review screen, and even swapped our app icon for an SDK one and concluded —
wrongly — that our glyph was at fault. It was a correlation: the reload that
came with the swap changed which commands ran first.

Two separate problems in one signature:

- **Silent overrun.** Nothing in the name, the parameter list, or the
  surrounding documentation suggests 65 bytes.
- **A public key that looks valid but is not.** The first 32 bytes are `0x04`
  followed by most of `x`. Every length check accepts it, tools display it
  happily, and it can be used to create an account nothing will ever be able
  to spend from. We funded one before noticing.

The conversion is not obvious either, and `app-hedera` has it:

```c
for (int i = 0; i < 32; i++) dst[i] = raw_pubkey[64 - i];   // y, little endian
if (raw_pubkey[32] & 1) dst[31] |= 0x80;                    // x parity in the top bit
```

**Suggested fix:** take the destination length and check it, and say in the
doc comment that Ed25519 yields an uncompressed point. Better still, offer a
`get_pubkey_ed25519_compressed` so every app does not reimplement the same
sixteen lines — or get them wrong and not find out until a signature fails on
mainnet.

---

## 11. `io_send_response_pointer` keeps the pointer

The name is honest, and the consequence is not written down anywhere: the
buffer must outlive the handler. A response built in a local array is read
after its frame is gone, and what the host receives is one stale byte with a
**success** status.

That is the worst possible failure shape. A wrong status word sends you to
the right place; a plausible reply with `0x9000` reads as a protocol
disagreement between two sides that are, in fact, agreeing perfectly.

We hit it four times in one app before spotting the pattern.

**Suggested fix:** one line in the doc comment — "the buffer must remain
valid until the response is sent; do not pass a local".

---

## 12. The Makefile knob for the APDU buffer is no longer read

`ledger-app-boilerplate`'s `Makefile` documents this, and every app derived
from it carries the line:

```make
#DISABLE_DEFAULT_IO_SEPROXY_BUFFER_SIZE = 1 # To allow custom size declaration
```

Flex gets a 272-byte buffer:

```make
# flex-secure-sdk/Makefile.defines
DEFINES += OS_IO_SEPH_BUFFER_SIZE=272
```

We needed more — a signed transaction body plus two 64-byte signatures and a
29-byte attestation comes to well over three hundred — so we did what the
Makefile says:

```make
DISABLE_DEFAULT_IO_SEPROXY_BUFFER_SIZE = 1
DEFINES += OS_IO_SEPH_BUFFER_SIZE=512
DEFINES += CUSTOM_IO_APDU_BUFFER_SIZE=512
```

**`DISABLE_DEFAULT_IO_SEPROXY_BUFFER_SIZE` appears nowhere in the SDK.**

```console
$ grep -rn "DISABLE_DEFAULT_IO_SEPROXY_BUFFER_SIZE" /opt/flex-secure-sdk/
$ echo $?
1
```

It is read by nothing. The SDK still emits its own
`OS_IO_SEPH_BUFFER_SIZE=272`, ours is appended after it, and the build
succeeds without a word.

**What it costs.** The app believes it has a 512-byte buffer and answers a
command with 311 bytes. There is no bounds check and no status word: the
application dies, the device falls back to the dashboard, and the host sees a
read error from a transport that was working a millisecond earlier. Nothing
points at the buffer. We suspected the new handler, the encoder, and RAM
pressure from the static buffers before checking whether the Makefile
variable existed at all.

**Cost:** a crashed app on real hardware, a wiped NVRAM from the reinstall
that followed, and the wrong three hypotheses first.

**Suggested fix.** Either honour the variable, or delete the line from the
boilerplate. A commented-out knob in a template is read as documentation. If
raising the buffer is genuinely unsupported now, `Makefile.defines` could
refuse a second definition rather than silently keeping the first — the
duplicate is visible at build time, and the runtime failure is not.

**Workaround.** Split the response across two commands. Ours returns the
signature and the attestation, and a second command returns the body. It
costs a round trip, and it is safe: the signature is over the body, so a body
that does not match will not verify.

## 13. The default boilerplate config factory-resets a Flex on every sideload

This one cost a seed. Twice.

`ledger-app-boilerplate` ships with:

```make
ENABLE_BLUETOOTH = 1
```

On Flex, `Makefile.standard_app` turns that into a privilege:

```make
ifeq ($(ENABLE_BLUETOOTH), 1)
ifeq ($(TARGET_NAME),$(filter $(TARGET_NAME),TARGET_NANOX TARGET_STAX TARGET_FLEX TARGET_APEX_P))
    HAVE_APPLICATION_FLAG_BOLOS_SETTINGS = 1
```

which reaches the loader as `--appFlags 0x200` — `APPLICATION_FLAG_BOLOS_SETTINGS`,
permission to modify the operating system's own settings. It is a one-line
change to demonstrate:

```console
$ grep '^ENABLE_BLUETOOTH' Makefile
ENABLE_BLUETOOTH = 1
$ make -n load | tr ' ' '\n' | grep -A1 -- --appFlags
--appFlags
0x200

$ sed -i 's/^ENABLE_BLUETOOTH = 1/ENABLE_BLUETOOTH = 0/' Makefile
$ make -n load | tr ' ' '\n' | grep -A1 -- --appFlags
--appFlags
0x0
```

Installing an unsigned application that requests a privileged flag onto an
onboarded device wipes it. That is a defensible security decision — a seed
should not survive granting OS privileges to uncertified code. What is not
defensible is arriving there by default, in silence.

**What it costs.** The device comes back showing *"Welcome to Ledger Flex,
your digital signer"*. Twenty-four words gone. Ledger Wallet reports a
brand-new device that passes its genuine check, because it is genuine — and
empty.

**Why it took two devices to find.** Nothing connects the cause to the
effect at any point in the chain:

- The app never asked for the privilege. It came from a Bluetooth option
  the app does not use, and the app was talking over USB the whole time.
- `make load` prints `--appFlags 0x200` with no comment, among a dozen other
  numeric parameters. There is nothing to make it stand out.
- `ledgerblue.loadApp` prints `Broken certificate chain - loading from user
  key` and `Application full hash: ...`, then succeeds. No warning.
- The device says nothing on the way down and shows the welcome screen on the
  way up, which reads like the device broke rather than like the load
  did it.
- The failure lands on the *device*, so the first hypothesis is anything but
  the build configuration. We suspected a wedged USB pipe, our own APDU
  handler, and RAM pressure first.

We ran the same load command a dozen times over two days before the number
was worth looking at. The first wipe was written off as the device being
strange.

**Suggested fixes**, in the order we would want them:

1. **`ledgerblue.loadApp` should refuse, or at minimum warn, when
   `--appFlags` carries a privileged bit and the device is onboarded.** One
   line of output — *"this will erase the device's seed"* — would have saved
   both wipes. It already knows the flags and it already talks to the device.
2. **`ENABLE_BLUETOOTH` should not imply `BOLOS_SETTINGS` silently.** If BLE
   genuinely needs it, say so where the option is set, in the boilerplate
   Makefile, next to the line every new app inherits.
3. **Do not ship `ENABLE_BLUETOOTH = 1` as the boilerplate default.** Most
   apps start on USB. An option that is on by default and grants a privilege
   is a trap for exactly the developer least able to see it — the new one.

**Workaround.** `ENABLE_BLUETOOTH = 0`, and a loader that checks before it
loads:

```bash
APP_FLAGS=$(make -n load | tr ' ' '\n' | grep -A1 -- '--appFlags' | tail -1)
if [ $(( $APP_FLAGS & 0xA50 )) -ne 0 ]; then
  echo "REFUSING — privileged flags ($APP_FLAGS) will factory-reset the device" >&2
  exit 1
fi
```

## Tutorial we would have wanted

Nothing linked from the "getting started" path covers the actual arc of writing
a native app: *define your own APDU protocol, persist state in NVRAM, build a
custom NBGL screen, and load it on a physical device from macOS.* Each piece
exists somewhere; the path between them does not.

A single page — "your own protocol, end to end on a physical device" — covering
findings 1, 2, 6 and 7 would have saved this entire evening.

## Time-savers for the next builder

1. `git init` before your first build.
2. Mount the **repository root**, not the app directory, into the builder.
3. Get load parameters from `make -n load`. Do not hand-write them.
4. Quit Ledger Wallet before touching `ledgerctl`.
5. Turn off device auto-lock while developing.
6. Do not use `buffer_move` for anything but a trailing field.
7. NVRAM is per app **name** — renaming your app wipes its persistent state.
8. Depend on `@ledgerhq/hw-ledger-key-ring-protocol`, not the Live wrapper.
9. Use its CommonJS build.
10. Response buffers must be static — never a local.
11. Ed25519 public keys come back as 65-byte uncompressed points.
12. **Check `--appFlags` before every load.** `make -n load | grep -A1
    appFlags`. Anything but `0x0` means the build is asking for a privilege,
    and a privileged flag on an unsigned app erases an onboarded device.
    `ENABLE_BLUETOOTH=1` — the boilerplate default — sets it on Flex.
13. Do not trust `DISABLE_DEFAULT_IO_SEPROXY_BUFFER_SIZE`. It is not read.
    Split the response instead.
