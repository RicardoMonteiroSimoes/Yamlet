#!/bin/sh
# install.sh — link the yamlet pi resources into a location pi discovers.
#
# Why this exists: pi loads *skills* from packages, but `@tintinweb/pi-subagents`
# discovers *agents* from exactly three hardcoded directories — `.pi/agents/`,
# `.agents/agents/` and `$PI_CODING_AGENT_DIR/agents/` (default
# `~/.pi/agent/agents/`). There is no package-based agent discovery and no
# configurable path, so the agent files have to be placed on disk. This script
# does that, and links the skills alongside them so both halves stay in sync
# with the repo (symlinks, not copies — `git pull` updates them).
#
#   ./install.sh              # global: ~/.pi/agent/{agents,skills}/
#   ./install.sh --project    # project: ./.pi/{agents,skills}/ in the CWD
#   ./install.sh --uninstall  # remove links this script created (honours --project)
#
# Skills alternatively install as a normal pi package (`pi install ./pi`), which
# does not need this script — but the agents still do.
set -eu

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

SCOPE=global
ACTION=install
for arg in "$@"; do
    case "$arg" in
        --project|-l) SCOPE=project ;;
        --uninstall)  ACTION=uninstall ;;
        -h|--help)    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) printf 'install.sh: unknown option %s (try --help)\n' "$arg" >&2; exit 2 ;;
    esac
done

if [ "$SCOPE" = project ]; then
    DEST="$PWD/.pi"
else
    DEST="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
fi

# Link one file/dir into a destination directory, replacing only a link we own.
link() {
    src=$1; dest_dir=$2; name=$(basename "$src")
    target="$dest_dir/$name"
    if [ -e "$target" ] && [ ! -L "$target" ]; then
        printf '  ! %-34s exists and is not a symlink — left alone\n' "$name" >&2
        return 0
    fi
    ln -sfn "$src" "$target"
    printf '  + %s\n' "$target"
}

unlink_if_ours() {
    src=$1; dest_dir=$2; name=$(basename "$src")
    target="$dest_dir/$name"
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$src" ]; then
        rm -f "$target"
        printf '  - %s\n' "$target"
    fi
}

if [ "$ACTION" = uninstall ]; then
    printf 'Removing yamlet pi resources from %s\n' "$DEST"
    for f in "$SRC"/agents/*.md; do
        [ -e "$f" ] && unlink_if_ours "$f" "$DEST/agents"
    done
    for d in "$SRC"/skills/*/; do
        [ -d "$d" ] && unlink_if_ours "${d%/}" "$DEST/skills"
    done
    printf 'Done.\n'
    exit 0
fi

printf 'Installing yamlet pi resources into %s\n' "$DEST"
mkdir -p "$DEST/agents" "$DEST/skills"

printf 'agents (require @tintinweb/pi-subagents):\n'
for f in "$SRC"/agents/*.md; do
    [ -e "$f" ] || { printf '  (none)\n'; break; }
    link "$f" "$DEST/agents"
done

printf 'skills:\n'
for d in "$SRC"/skills/*/; do
    [ -d "$d" ] || { printf '  (none)\n'; break; }
    link "${d%/}" "$DEST/skills"
done

printf '\nNext:\n'
command -v yamlet >/dev/null 2>&1 \
    && printf '  ok   yamlet on PATH (%s)\n' "$(yamlet --version 2>/dev/null || echo 'version unknown')" \
    || printf '  TODO install the yamlet CLI — brew tap RicardoMonteiroSimoes/yamlet && brew install yamlet\n'
printf '  TODO install the subagent host if you have not: pi install npm:@tintinweb/pi-subagents\n'
printf '  then: pi, and ask it to write a yamlet spec (or /skill:yamlet-author)\n'
