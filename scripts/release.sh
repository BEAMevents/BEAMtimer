#!/bin/bash
# Makes the update file for "Check for updates":
#   scripts/release.sh             -> dist/beamtimer-X.Y.Z.tar.gz and .sha256 (X.Y.Z from package.json)
#   scripts/release.sh --publish   -> also creates GitHub release vX.Y.Z on BEAMevents/BEAMtimer and
#                                     uploads both files (needs GH_TOKEN with access to that repo)
# Release notes: dist/notes.txt if it exists (shown on the control page before installing).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="BEAMevents/BEAMtimer"
VERSION=$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' "$DIR/package.json" | head -1)
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "No version in package.json" >&2; exit 1; }
NAME="beamtimer-$VERSION.tar.gz"
mkdir -p "$DIR/dist"
OUT="$DIR/dist/$NAME"

# Same files push.sh copies to a Pi.
COPYFILE_DISABLE=1 tar --no-xattrs -C "$DIR" --exclude '.DS_Store' --exclude '__pycache__' -czf "$OUT" server public pi package.json README.md
(cd "$DIR/dist" && shasum -a 256 "$NAME" > "$NAME.sha256")
echo "Made dist/$NAME ($(du -h "$OUT" | cut -f1 | tr -d ' ')), sha256 $(cut -c1-16 "$OUT.sha256")…"

[ "${1:-}" = --publish ] || exit 0
[ -n "${GH_TOKEN:-}" ] || { echo "Set GH_TOKEN to publish." >&2; exit 1; }
API="https://api.github.com/repos/$REPO"
NOTES="BEAMtime $VERSION"
[ -f "$DIR/dist/notes.txt" ] && NOTES="$(cat "$DIR/dist/notes.txt")"
BODY=$(NOTES="$NOTES" VERSION="$VERSION" python3 -c 'import json,os; print(json.dumps({"tag_name":"v"+os.environ["VERSION"],"name":"BEAMtime "+os.environ["VERSION"],"body":os.environ["NOTES"]}))')
REL=$(curl -fsS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" "$API/releases" -d "$BODY")
UPLOAD=$(printf '%s' "$REL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["upload_url"].split("{")[0])')
for f in "$NAME" "$NAME.sha256"; do
  curl -fsS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary @"$DIR/dist/$f" "$UPLOAD?name=$f" >/dev/null
  echo "Uploaded $f"
done
echo "Published v$VERSION on $REPO"
