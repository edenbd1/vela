# Ledger — developer experience feedback

**Project:** Vela, a native BOLOS app that keeps an agent's spending envelope in
NVRAM and decides each draw on-chip.
**Device:** Ledger Flex (`target_id 0x33300004`, SE 1.6.1, MCU 6.9.2).
**Host:** macOS, Docker Desktop, `ledger-app-builder:latest`, `flex-secure-sdk`
v26.6.1 (API level 26), `ledgerwallet` 0.10.0.
**Scope:** everything below was hit in a single evening, on the standard path —
clone `app-boilerplate`, retarget it, define an APDU protocol, load it on a
physical device. No exotic cryptography, no unusual configuration.

---

## TL;DR

The platform is good, and the parts that are good are *very* good: NBGL, the
build image, the boilerplate, and the SDK's own `make -n load` are all
excellent. We shipped a working native app on day one.

Every problem we hit falls into one pattern:

> **The failure surfaces far away from its cause, and the message points
> somewhere else.**

Seven times in one evening, the tooling knew exactly what was wrong and told us
something unrelated. Each one is a small fix — usually one error string.

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

## 10. `@ledgerhq/ledger-key-ring-protocol` cannot be installed from npm

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

## 11. The ESM build of `hw-ledger-key-ring-protocol` does not load in Node

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
