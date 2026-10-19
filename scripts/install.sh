#!/bin/sh
# Symlinks every plugins/*/skills/* folder into a harness's user skills folder.
# Prints the plan by default; --apply makes the links. A second --apply changes nothing.
set -eu

usage() {
  cat <<'EOF'
usage: sh scripts/install.sh [--harness codex|opencode|agents|all] [--dry-run|--apply]

  codex     ${CODEX_HOME:-~/.codex}/skills
  opencode  ${XDG_CONFIG_HOME:-~/.config}/opencode/skills
  agents    ~/.agents/skills, which both codex and opencode read
  all       codex and opencode (default)

Claude Code is not a target here: it installs through the plugin marketplace.
EOF
}

harness=all
mode=dry-run
while [ $# -gt 0 ]; do
  case $1 in
    --harness) [ $# -ge 2 ] || { usage >&2; exit 2; }; harness=$2; shift 2 ;;
    --harness=*) harness=${1#--harness=}; shift ;;
    --dry-run) mode=dry-run; shift ;;
    --apply) mode=apply; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

case $harness in
  codex|opencode|agents) targets=$harness ;;
  # agents is left out of all: codex and opencode read it too, so each skill would load twice
  all) targets="codex opencode" ;;
  *) usage >&2; exit 2 ;;
esac

repo=$(cd "$(dirname "$0")/.." && pwd)

# Prints the harness's skills folder, or nothing when it can't be determined.
folder() {
  [ -n "${HOME:-}" ] || return 0
  case $1 in
    codex)
      if [ -n "${CODEX_HOME:-}" ]; then echo "$CODEX_HOME/skills"
      elif command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then echo "$HOME/.codex/skills"
      fi ;;
    opencode)
      cfg=${XDG_CONFIG_HOME:-$HOME/.config}
      if command -v opencode >/dev/null 2>&1 || [ -d "$cfg/opencode" ]; then echo "$cfg/opencode/skills"; fi ;;
    agents) echo "$HOME/.agents/skills" ;;
  esac
}

linked=0 unchanged=0 skipped=0
for t in $targets; do
  dir=$(folder "$t")
  if [ -z "$dir" ]; then
    echo "skipped $t: skills folder can't be determined (harness not installed and no config folder)"
    skipped=$((skipped + 1))
    continue
  fi
  for src in "$repo"/plugins/*/skills/*/; do
    [ -f "$src/SKILL.md" ] || continue
    src=${src%/}
    name=$(basename "$src")
    dest=$dir/$name
    if [ -L "$dest" ]; then
      if [ "$(readlink "$dest")" = "$src" ]; then
        echo "unchanged $t: $dest"
        unchanged=$((unchanged + 1))
        continue
      fi
      action="relink"
    elif [ -e "$dest" ]; then
      echo "skipped $t: $dest exists and is not a symlink"
      skipped=$((skipped + 1))
      continue
    else
      action="link"
    fi
    echo "$action $t: $dest -> $src"
    linked=$((linked + 1))
    if [ "$mode" = apply ]; then
      mkdir -p "$dir"
      ln -sfn "$src" "$dest"
    fi
  done
done

if [ "$mode" = apply ]; then
  echo "applied: $linked linked, $unchanged unchanged, $skipped skipped"
else
  echo "dry run: $linked to link, $unchanged unchanged, $skipped skipped; rerun with --apply"
fi
