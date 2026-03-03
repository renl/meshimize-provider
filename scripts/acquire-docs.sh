#!/usr/bin/env bash
# Acquire documentation sources for meshimize-provider groups.
# Usage: ./scripts/acquire-docs.sh [slug]
# If slug is provided, only acquire that group's docs.
# If no slug, acquire all configured groups.

set -euo pipefail

DOCS_DIR="./docs-source"

# ─── Fly.io Docs ───
acquire_fly_docs() {
  local slug="fly-docs"
  local repo="https://github.com/superfly/docs.git"
  local target="${DOCS_DIR}/${slug}"

  if [ -d "${target}/.git" ]; then
    echo "Updating ${slug}..."
    git -C "${target}" pull --ff-only
  else
    echo "Cloning ${slug}..."
    mkdir -p "${DOCS_DIR}"
    git clone --depth 1 "${repo}" "${target}"
  fi

  echo "Acquired: ${slug} → ${target}"
}

# ─── Main ───
case "${1:-all}" in
  fly-docs) acquire_fly_docs ;;
  all)      acquire_fly_docs ;;
  *)        echo "Unknown slug: $1"; exit 1 ;;
esac
