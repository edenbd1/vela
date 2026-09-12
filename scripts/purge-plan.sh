#!/usr/bin/env bash
# Remove docs/PLAN.md from every commit, before this repository goes public.
#
# PLAN.md was competitive analysis. It was deleted from the working tree, and
# deleting a file does not remove it from the history — a public repository
# publishes its history too, so `git log -p` hands a reader the whole thing.
#
# This rewrites every commit. It is not run automatically and it is not run
# without you, because:
#
#   - every commit hash changes, so anything referencing one breaks
#   - the push is a force push, which cannot be undone from the remote
#   - a clone made before it still has the file
#
# And the one that surprised us, checked after running this for real:
#
#   - **GitHub still serves the old objects.** A fresh clone is clean, and
#     `git log --all` finds nothing, but the API answers on the old SHA:
#
#         gh api repos/<owner>/<repo>/contents/docs/PLAN.md?ref=<old sha>
#         → "size": 72935
#
#     Unreachable objects are not garbage-collected on push. The only
#     reliable fixes are asking GitHub Support to run gc on the repository,
#     or deleting the repository and pushing the rewritten history to a new
#     one. Rewriting locally is necessary and it is not sufficient.
#
# Read the output of --check first. Then run it, then force-push, then tell
# anyone with a clone to re-clone.
#
#   ./scripts/purge-plan.sh --check    what is in the history now
#   ./scripts/purge-plan.sh --run      rewrite it
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="docs/PLAN.md"

case "${1:-}" in
  --check)
    echo
    echo "commits touching $TARGET:"
    git log --oneline --all -- "$TARGET" | sed 's/^/  /' || true
    n=$(git log --oneline --all -- "$TARGET" | wc -l | tr -d ' ')
    echo
    if [ "$n" = "0" ]; then
      echo "  none — the history is already clean"
    else
      echo "  $n commit(s). A reader of a public repo can recover the file from any of them."
    fi
    echo
    echo "in the working tree:"
    [ -f "$TARGET" ] && echo "  present — delete and commit that first" || echo "  absent, correctly"
    echo
    exit 0
    ;;
  --run) ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "git-filter-repo is not installed." >&2
  echo "  brew install git-filter-repo   (or pipx install git-filter-repo)" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "the working tree is not clean — commit or stash first" >&2
  exit 1
fi

BACKUP="../vela-before-purge-$(date +%s)"
echo "  cloning a backup to $BACKUP"
git clone --mirror . "$BACKUP" >/dev/null
echo "  backup made. If this goes wrong, that is the repository."
echo

git filter-repo --invert-paths --path "$TARGET" --force

echo
echo "  history rewritten. Every commit hash has changed."
echo
echo "  Next, and only when you are sure:"
echo "      git remote add origin git@github.com:edenbd1/vela.git"
echo "      git push --force --all"
echo "      git push --force --tags"
echo
echo "  Then tell anyone holding a clone to re-clone. Theirs still has the file."
echo
echo "  And check the remote rather than trusting the push. A fresh clone will"
echo "  be clean while the API still answers on the old SHA:"
echo
echo "      gh api repos/<owner>/<repo>/contents/$TARGET?ref=<old sha>"
echo
echo "  If that returns a size, the objects are still there. Ask GitHub Support"
echo "  to gc the repository, or push this history to a new one."
