#!/bin/sh
# update-tap.sh — render the Homebrew formula from packaging/yamlet.rb.tmpl using
# the checksums produced by build-release.sh, then commit it to the tap repo
# (RicardoMonteiroSimoes/homebrew-yamlet) as Formula/yamlet.rb.
#
#   TAP_TOKEN=<pat> ./scripts/update-tap.sh 0.1.0
#
# Expects dist/SHA256SUMS to exist (run build-release.sh first). TAP_TOKEN must
# be a token with contents:write on the tap repo; in CI it is the
# HOMEBREW_TAP_TOKEN secret. Runs from the `tooling/` directory.
set -eu

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    printf 'usage: update-tap.sh <version>   (e.g. 0.1.0, no leading v)\n' >&2
    exit 2
fi
if [ -z "${TAP_TOKEN:-}" ]; then
    printf 'update-tap: TAP_TOKEN is not set\n' >&2
    exit 2
fi

TAP_OWNER="RicardoMonteiroSimoes"
TAP_REPO="homebrew-yamlet"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TOOLING_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DIST="$TOOLING_DIR/dist"
TEMPLATE="$TOOLING_DIR/packaging/yamlet.rb.tmpl"
SUMS="$DIST/SHA256SUMS"

[ -f "$SUMS" ] || { printf 'update-tap: %s not found (run build-release.sh)\n' "$SUMS" >&2; exit 1; }

# Pull a checksum out of SHA256SUMS by its target triple.
sha_for() {
    awk -v f="yamlet-$VERSION-$1.tar.gz" '$2 == f { print $1 }' "$SUMS"
}
SHA_MAC_ARM=$(sha_for aarch64-apple-darwin)
SHA_MAC_X86=$(sha_for x86_64-apple-darwin)
SHA_LINUX_ARM=$(sha_for aarch64-unknown-linux-gnu)
SHA_LINUX_X86=$(sha_for x86_64-unknown-linux-gnu)
for pair in \
    "aarch64-apple-darwin:$SHA_MAC_ARM" \
    "x86_64-apple-darwin:$SHA_MAC_X86" \
    "aarch64-unknown-linux-gnu:$SHA_LINUX_ARM" \
    "x86_64-unknown-linux-gnu:$SHA_LINUX_X86"; do
    if [ -z "${pair#*:}" ]; then
        printf 'update-tap: no checksum for %s in SHA256SUMS\n' "${pair%%:*}" >&2
        exit 1
    fi
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

git clone --depth 1 \
    "https://x-access-token:${TAP_TOKEN}@github.com/${TAP_OWNER}/${TAP_REPO}.git" \
    "$WORK/tap"

mkdir -p "$WORK/tap/Formula"
sed \
    -e "s|__VERSION__|$VERSION|g" \
    -e "s|__SHA_AARCH64_APPLE_DARWIN__|$SHA_MAC_ARM|g" \
    -e "s|__SHA_X86_64_APPLE_DARWIN__|$SHA_MAC_X86|g" \
    -e "s|__SHA_AARCH64_UNKNOWN_LINUX_GNU__|$SHA_LINUX_ARM|g" \
    -e "s|__SHA_X86_64_UNKNOWN_LINUX_GNU__|$SHA_LINUX_X86|g" \
    "$TEMPLATE" >"$WORK/tap/Formula/yamlet.rb"

# A rendered template must have no placeholders left and be valid Ruby syntax.
if grep -q '__[A-Z0-9_]*__' "$WORK/tap/Formula/yamlet.rb"; then
    printf 'update-tap: rendered formula still contains placeholders\n' >&2
    exit 1
fi
if command -v ruby >/dev/null 2>&1; then
    ruby -c "$WORK/tap/Formula/yamlet.rb" >/dev/null
fi

cd "$WORK/tap"
# Stage first, then diff the index against HEAD: `git diff` alone ignores an
# untracked file, so on a fresh/empty tap the formula is brand-new and untracked
# and a bare `git diff --quiet` would wrongly report "nothing to push" — never
# committing the first release. Staging makes a new file show as a cached change.
git add Formula/yamlet.rb
if git diff --cached --quiet; then
    printf 'update-tap: formula already up to date for v%s, nothing to push\n' "$VERSION"
    exit 0
fi

git config user.name "yamlet-release[bot]"
git config user.email "release@yamlet.invalid"
git commit -m "yamlet $VERSION"
git push origin HEAD
printf 'update-tap: pushed Formula/yamlet.rb for v%s\n' "$VERSION"
