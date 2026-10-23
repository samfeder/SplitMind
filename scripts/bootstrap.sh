#!/usr/bin/env bash
# Prepare a SplitMind checkout: fetch the pinned OpenConnector submodule,
# apply SplitMind's patches to it, and install dependencies.
#
# Usage: scripts/bootstrap.sh [--skip-install]
#
# Safe to re-run: patches that are already applied are skipped. A patch that
# neither applies nor is already applied stops the script with a non-zero exit.
set -euo pipefail

usage() {
  echo "Usage: scripts/bootstrap.sh [--skip-install]"
  echo
  echo "  --skip-install  init the submodule and apply patches, but skip npm ci"
}

skip_install=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) skip_install=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "bootstrap: unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
engine="vendor/open-connector"
cd "$root"

echo "==> Fetching $engine at its pinned commit"
git submodule sync --quiet -- "$engine"
git submodule update --init -- "$engine"
echo "    $(git -C "$engine" describe --tags --always 2>/dev/null) ($(git -C "$engine" rev-parse --short HEAD))"

echo "==> Applying patches"
shopt -s nullglob
patches=("$root"/patches/*.patch)
shopt -u nullglob
if [ ${#patches[@]} -eq 0 ]; then
  echo "    No patches to apply."
fi
for patch in ${patches[@]+"${patches[@]}"}; do
  name="patches/$(basename "$patch")"
  if git -C "$engine" apply --reverse --check "$patch" 2>/dev/null; then
    echo "    already applied: $name"
  elif git -C "$engine" apply --check "$patch" 2>/dev/null; then
    git -C "$engine" apply "$patch"
    echo "    applied: $name"
  else
    echo "bootstrap: $name does not apply to $engine; see docs/upgrading-openconnector.md" >&2
    exit 1
  fi
done

if [ "$skip_install" -eq 1 ]; then
  echo "==> Skipping dependency install (--skip-install)"
else
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -lt 22 ]; then
    echo "bootstrap: Node 22 or newer is required (found $(node -v))" >&2
    exit 1
  fi
  echo "==> Installing SplitMind dependencies"
  npm ci --no-audit --no-fund
  echo "==> Installing OpenConnector dependencies"
  (cd "$engine" && npm ci --no-audit --no-fund)
fi

echo "==> Bootstrap complete"
