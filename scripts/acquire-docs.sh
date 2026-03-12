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

# ─── Elixir Docs ───
# Extracts Elixir guide pages and documentation from the elixir-lang/elixir
# source repository. Copies markdown guides directly — no compilation needed.
# Prerequisites: git
acquire_elixir_docs() {
  local slug="elixir-docs"
  local elixir_version="${ELIXIR_VERSION:-v1.18.3}"
  local target="${DOCS_DIR}/${slug}"
  local elixir_repo="https://github.com/elixir-lang/elixir.git"
  local elixir_dir="${DOCS_DIR}/.elixir-source"

  echo "Extracting Elixir docs from source (${elixir_version})..."

  mkdir -p "${DOCS_DIR}"

  # Clone or update Elixir repo at specified version (shallow)
  if [ -d "${elixir_dir}/.git" ]; then
    echo "Updating Elixir source..."
    git -C "${elixir_dir}" fetch --depth 1 origin "refs/tags/${elixir_version}"
    git -C "${elixir_dir}" checkout FETCH_HEAD
    git -C "${elixir_dir}" clean -fdx
  else
    echo "Cloning Elixir source (${elixir_version})..."
    git clone --depth 1 --branch "${elixir_version}" "${elixir_repo}" "${elixir_dir}"
  fi

  # Clean and populate target directory (idempotent)
  rm -rf "${target}"
  mkdir -p "${target}"

  # Copy guide pages from lib/elixir/pages/ (preserving directory structure)
  local pages_dir="${elixir_dir}/lib/elixir/pages"
  if [ -d "${pages_dir}" ]; then
    local guide_count=0
    while IFS= read -r -d '' src; do
      local rel="${src#"${pages_dir}"/}"
      local dest_dir="${target}/guides/$(dirname "${rel}")"
      mkdir -p "${dest_dir}"
      cp "${src}" "${dest_dir}/"
      guide_count=$((guide_count + 1))
    done < <(find "${pages_dir}" -name '*.md' -print0)
    echo "  Copied: ${guide_count} guide pages to guides/"
  else
    echo "  WARNING: lib/elixir/pages/ not found, skipping guides"
  fi

  # Copy .md files from library source directories
  local libs=("mix" "ex_unit" "iex" "logger" "eex")
  for lib in "${libs[@]}"; do
    local lib_dir="${elixir_dir}/lib/${lib}"
    if [ -d "${lib_dir}" ]; then
      local lib_count=0
      while IFS= read -r -d '' src; do
        local rel="${src#"${lib_dir}"/}"
        local dest_dir="${target}/${lib}/$(dirname "${rel}")"
        mkdir -p "${dest_dir}"
        cp "${src}" "${dest_dir}/"
        lib_count=$((lib_count + 1))
      done < <(find "${lib_dir}" -name '*.md' -print0)
      if [ "${lib_count}" -gt 0 ]; then
        echo "  Copied: ${lib_count} doc files from lib/${lib}/"
      fi
    fi
  done

  echo "Acquired: ${slug} → ${target}"
}

# ─── Main ───
case "${1:-all}" in
  fly-docs) acquire_fly_docs ;;
  elixir-docs) acquire_elixir_docs ;;
  all)
    acquire_fly_docs
    acquire_elixir_docs
    ;;
  *) echo "Unknown slug: $1"; exit 1 ;;
esac
