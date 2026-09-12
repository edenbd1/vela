#!/usr/bin/env bash
# Does the documentation describe this repository, or a previous one?
#
# Four bugs in one day came from the same shape: something written down that
# had stopped being true and did not fail loudly when it stopped. A README
# naming a Hedera topic the gateway no longer anchors to. A script described
# as running a suite it never ran. Assertion counts from three commits ago.
# None of them break a build; all of them mislead the one reader who matters.
#
# So the claims that can be checked mechanically, are.
#
#   ./scripts/docs-check.sh
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail=0
note() { printf "  \033[31m✗\033[0m %s\n" "$1"; fail=1; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }

echo
echo "commands the docs tell a reader to run"
python3 - <<'PY' || fail=1
import re, sys, pathlib

root = pathlib.Path(".")
docs = sorted(list(root.glob("*.md")) + list((root / "docs").glob("*.md")))

# `node hedera/recover.mjs --check`, `python3 test/chip_test.py`,
# `./scripts/up.sh --status`. Anything with a path this repo owns.
RUN = re.compile(
    r"(?:^|\$ |&& |\| )(?:node|python3|bash|sh)\s+([A-Za-z0-9_./-]+\.(?:mjs|cjs|py|sh))"
    r"((?:\s+--?[A-Za-z0-9-]+)*)"
    r"|(?:^|\$ |&& )(\./scripts/[A-Za-z0-9_.-]+\.sh)((?:\s+--?[A-Za-z0-9-]+)*)",
    re.M)

bad = []
seen = set()
for d in docs:
    for m in RUN.finditer(d.read_text()):
        path = m.group(1) or m.group(3)
        flags = (m.group(2) or m.group(4) or "").split()
        path = path.lstrip("./") if path.startswith("./scripts") else path
        f = root / path
        key = (str(d), path, tuple(flags))
        if key in seen:
            continue
        seen.add(key)
        if not f.exists():
            bad.append(f"{d}: {path} does not exist")
            continue
        body = f.read_text(errors="replace")
        for flag in flags:
            # A flag the file never mentions is a flag it does not have. This
            # is a substring check on purpose: argument parsing here is
            # argv.includes and sys.argv, never a parser library, so the
            # literal string is in the source or the flag is imaginary.
            if flag not in body:
                bad.append(f"{d}: {path} has no {flag}")

for b in bad:
    print(f"  \033[31m✗\033[0m {b}")
print(f"  \033[32m✓\033[0m {len(seen)} invocation(s) check out" if not bad
      else f"  {len(bad)} of {len(seen)} invocation(s) do not")
sys.exit(1 if bad else 0)
PY

echo
echo "links to files in this repository"
python3 - <<'PY' || fail=1
import re, sys, pathlib
root = pathlib.Path(".")
docs = sorted(list(root.glob("*.md")) + list((root / "docs").glob("*.md")))
bad, n = [], 0
for d in docs:
    for target in re.findall(r"\]\(([^)]+)\)", d.read_text()):
        if target.startswith(("http", "mailto:", "#")):
            continue
        n += 1
        path = target.split("#")[0]
        if not (d.parent / path).exists() and not (root / path).exists():
            bad.append(f"{d}: {target}")
for b in bad:
    print(f"  \033[31m✗\033[0m {b}")
print(f"  \033[32m✓\033[0m {n} link(s) resolve" if not bad
      else f"  {len(bad)} of {n} link(s) do not")
sys.exit(1 if bad else 0)
PY

# The one that bit hardest: a topic id written down once and rotated since.
# docs/README naming a topic the gateway no longer anchors to sends a judge to
# an empty log and there is nothing on screen to say so.
echo
echo "hedera ids against the live epoch"
python3 - <<'PY' || fail=1
import json, pathlib, re, sys

root = pathlib.Path(".")
live = None
try:
    live = json.loads((root / ".vela-instance").read_text()).get("topic")
except Exception:
    pass
if not live:
    print("  \033[33m!\033[0m no grant epoch — nothing to compare against")
    sys.exit(0)

docs = sorted(list(root.glob("*.md")) + list((root / "docs").glob("*.md")))
TOPIC = re.compile(r"0\.0\.\d{7,}")
stale = {}
for d in docs:
    for t in set(TOPIC.findall(d.read_text())):
        # Only topic ids, not account ids. A topic id is one that appears in a
        # hashscan topic URL or next to the word topic; everything else here
        # is an account and rotates for different reasons.
        txt = d.read_text()
        if re.search(rf"topic/{re.escape(t)}|topic\s+{re.escape(t)}|audit log {re.escape(t)}", txt):
            if t != live:
                stale.setdefault(str(d), set()).add(t)
for d, ts in stale.items():
    for t in sorted(ts):
        print(f"  \033[31m✗\033[0m {d}: topic {t}, live is {live}")
print(f"  \033[32m✓\033[0m every topic id named is {live}" if not stale else "")
sys.exit(1 if stale else 0)
PY

# A count a document states, against the file that decides it.
#
# The same bug landed three times in a week: the README and the submission
# both said fourteen findings when there were eighteen. Nothing above would
# catch it — a wrong number is a valid link. Both spellings are checked,
# because prose writes "eighteen" and tables write "18".
#
# Only findings. "eight slots" is the chip's capacity and "three agents" is
# the demo fleet: two different numbers, both correct, and a noun is not
# enough to tell them apart. A check that cries wolf gets switched off, which
# is worse than not having it.
echo
echo "counts a file decides"
python3 - <<'ENDOFPY' || fail=1
import re, sys, pathlib

root = pathlib.Path(".")
WORDS = {n: i for i, n in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve "
    "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty "
    "twentyone twentytwo twentythree twentyfour twentyfive".split())}
NUM = "|".join(WORDS)

ledger = root / "docs/FEEDBACK-LEDGER.md"
if not ledger.exists():
    print("  no feedback ledger — nothing to count against")
    sys.exit(0)
truth = len(re.findall(r"^## \d+\.", ledger.read_text(), re.M))
spoken = next((w for w, v in WORDS.items() if v == truth), str(truth))

# Plural only. A count of findings is always plural, and "One finding was
# drafted and then dropped" is a sentence about a particular one.
# Both nouns this repository uses for the same fact. The phrase that went
# stale was "fourteen concrete developer-experience problems", which the
# word "findings" would not have matched.
NOUN = r"(?:findings|developer-experience problems)"
pat = re.compile(rf"\b({NUM}|\d+)\s+(?:concrete\s+)?{NOUN}\b", re.I)
bad, checked = [], 0
for d in sorted(list(root.glob("*.md")) + list((root / "docs").glob("*.md"))):
    if d.resolve() == ledger.resolve():
        continue
    for m in pat.finditer(d.read_text()):
        raw = m.group(1).lower()
        got = WORDS[raw] if raw in WORDS else int(raw)
        checked += 1
        if got != truth:
            bad.append(f'{d}: "{m.group(0)}" — the ledger has {truth} ({spoken})')

for b in sorted(set(bad)):
    print(f"  \033[31m✗\033[0m {b}")
print(f"  \033[32m✓\033[0m {checked} stated count(s) match the ledger"
      if not bad else f"  {len(set(bad))} stated count(s) do not")
sys.exit(1 if bad else 0)
ENDOFPY

echo
[ "$fail" = 0 ] && echo "the documentation describes this repository." \
               || echo "the documentation describes a previous one."
exit $fail
