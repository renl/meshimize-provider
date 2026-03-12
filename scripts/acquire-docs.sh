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
# Builds full Elixir documentation using ExDoc (extracts @moduledoc/@doc from
# .ex source files + guide pages). Compiles Elixir from source, builds ExDoc,
# generates HTML, then converts to markdown with pandoc.
# Prerequisites: git, erl (Erlang/OTP 27+), make, pandoc
acquire_elixir_docs() {
  local slug="elixir-docs"
  local elixir_version="${ELIXIR_VERSION:-v1.18.3}"
  local exdoc_version="${EXDOC_VERSION:-v0.40.1}"
  local target="${DOCS_DIR}/${slug}"
  local elixir_repo="https://github.com/elixir-lang/elixir.git"
  local exdoc_repo="https://github.com/elixir-lang/ex_doc.git"
  local elixir_dir="${DOCS_DIR}/.elixir-source"
  local exdoc_dir="${DOCS_DIR}/.ex-doc"

  # ── Prerequisite checks ──
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=("git")
  command -v erl >/dev/null 2>&1 || missing+=("erl (Erlang/OTP 27+)")
  command -v make >/dev/null 2>&1 || missing+=("make")
  command -v pandoc >/dev/null 2>&1 || missing+=("pandoc")

  if [ ${#missing[@]} -gt 0 ]; then
    echo "ERROR: Missing required tools: ${missing[*]}"
    echo "Install them and try again."
    exit 1
  fi

  # Validate OTP version (27+ required for Elixir 1.18+)
  local otp_version
  otp_version="$(erl -noshell -eval 'io:put_chars(erlang:system_info(otp_release)), halt().')"

  # Ensure otp_version is a numeric major release before comparing
  if ! [[ "${otp_version}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Unable to detect a valid numeric Erlang/OTP release (got: '${otp_version}')."
    echo "Ensure Erlang/OTP 27+ is installed and 'erl' is on PATH."
    exit 1
  fi

  if [ "${otp_version}" -lt 27 ]; then
    echo "ERROR: Erlang/OTP ${otp_version} found, but 27+ is required."
    echo "Install OTP 27+ and try again."
    exit 1
  fi

  echo "Building Elixir docs with ExDoc (Elixir ${elixir_version}, ExDoc ${exdoc_version})..."

  mkdir -p "${DOCS_DIR}"

  # ── Step 1: Clone or update Elixir source ──
  if [ -d "${elixir_dir}/.git" ]; then
    echo "Updating Elixir source..."
    git -C "${elixir_dir}" fetch --depth 1 origin "refs/tags/${elixir_version}"
    git -C "${elixir_dir}" checkout FETCH_HEAD
    git -C "${elixir_dir}" clean -fdx
  else
    # Remove stale directory that isn't a git repo (e.g. interrupted clone)
    if [ -d "${elixir_dir}" ]; then
      echo "Removing stale ${elixir_dir} (not a git repo)..."
      rm -rf "${elixir_dir}"
    fi
    echo "Cloning Elixir source (${elixir_version})..."
    git clone --depth 1 --branch "${elixir_version}" "${elixir_repo}" "${elixir_dir}"
  fi

  # ── Step 2: Clone or update ExDoc ──
  if [ -d "${exdoc_dir}/.git" ]; then
    echo "Updating ExDoc source..."
    git -C "${exdoc_dir}" fetch --depth 1 origin "refs/tags/${exdoc_version}"
    git -C "${exdoc_dir}" checkout FETCH_HEAD
    git -C "${exdoc_dir}" clean -fdx
  else
    if [ -d "${exdoc_dir}" ]; then
      echo "Removing stale ${exdoc_dir} (not a git repo)..."
      rm -rf "${exdoc_dir}"
    fi
    echo "Cloning ExDoc (${exdoc_version})..."
    git clone --depth 1 --branch "${exdoc_version}" "${exdoc_repo}" "${exdoc_dir}"
  fi

  # ── Step 3: Compile Elixir from source ──
  echo "Compiling Elixir..."
  make -C "${elixir_dir}" clean compile

  # ── Step 4: Build ExDoc escript ──
  # Build the ExDoc escript using the just-compiled Elixir's mix.
  echo "Building ExDoc escript..."
  local elixir_abs
  elixir_abs="$(cd "${elixir_dir}" && pwd)"
  (
    cd "${exdoc_dir}"
    export PATH="${elixir_abs}/bin:${PATH}"
    export MIX_HOME="${DOCS_DIR}/.mix"
    export HEX_HOME="${DOCS_DIR}/.hex"
    mix local.hex --force --if-missing
    mix deps.get
    mix escript.build
  )

  # ── Step 5: Generate HTML docs with ExDoc ──
  # The Makefile's `make docs` target expects ../ex_doc relative to the Elixir
  # source dir. We create a symlink to satisfy this convention.
  echo "Generating HTML docs..."
  local exdoc_abs
  exdoc_abs="$(cd "${exdoc_dir}" && pwd)"
  local expected_exdoc="${elixir_dir}/../ex_doc"

  # Create or update symlink: .elixir-source/../ex_doc → .ex-doc
  if [ -L "${expected_exdoc}" ]; then
    rm "${expected_exdoc}"
  elif [ -e "${expected_exdoc}" ]; then
    echo "ERROR: ${expected_exdoc} exists and is not a symlink."
    echo "Refusing to remove it automatically; please delete or move it manually, then rerun this script."
    exit 1
  fi
  ln -s "${exdoc_abs}" "${expected_exdoc}"

  # Ensure the temporary ExDoc symlink is always cleaned up, even on error
  cleanup_exdoc_symlink() { rm -f "${expected_exdoc}"; }
  trap cleanup_exdoc_symlink EXIT

  # Run make docs (generates doc/<library>/ directories with HTML + EPUB)
  CANONICAL="" make -C "${elixir_dir}" docs

  # ── Step 6: Convert HTML to markdown ──
  echo "Converting HTML docs to markdown..."

  # Clean and populate target directory (idempotent)
  rm -rf "${target}"
  mkdir -p "${target}"

  local libraries=("elixir" "eex" "mix" "iex" "ex_unit" "logger")

  # Files to skip during HTML→markdown conversion (navigation/infrastructure)
  local skip_files="index.html search.html 404.html genindex.html"

  local total_converted=0
  for lib in "${libraries[@]}"; do
    local doc_dir="${elixir_dir}/doc/${lib}"
    if [ ! -d "${doc_dir}" ]; then
      echo "  WARNING: doc/${lib}/ not found, skipping"
      continue
    fi

    local lib_target="${target}/${lib}"
    mkdir -p "${lib_target}"

    local lib_count=0
    while IFS= read -r -d '' html_file; do
      local basename
      basename="$(basename "${html_file}")"

      # Skip non-documentation HTML files
      local skip=false
      for skip_name in ${skip_files}; do
        if [ "${basename}" = "${skip_name}" ]; then
          skip=true
          break
        fi
      done
      if [ "${skip}" = true ]; then
        continue
      fi

      # Skip files in dist/ and assets/ directories (CSS/JS/images)
      case "${html_file}" in
        */dist/* | */assets/*) continue ;;
      esac

      # Convert HTML to markdown
      local md_name="${basename%.html}.md"
      if pandoc -f html -t markdown --wrap=none -o "${lib_target}/${md_name}" "${html_file}" 2>/dev/null; then
        lib_count=$((lib_count + 1))
      else
        echo "  WARNING: pandoc failed on ${lib}/${basename}, skipping"
      fi
    done < <(find "${doc_dir}" -maxdepth 1 -name '*.html' -print0)

    total_converted=$((total_converted + lib_count))
    echo "  Converted: ${lib_count} HTML files from doc/${lib}/ → ${lib}/"
  done

  # ── Step 7: Copy guide pages (native markdown, no conversion needed) ──
  local pages_dir="${elixir_dir}/lib/elixir/pages"
  local guide_count=0
  if [ -d "${pages_dir}" ]; then
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

  # Clean up symlink and clear the trap
  cleanup_exdoc_symlink
  trap - EXIT

  echo "Acquired: ${slug} → ${target} (${total_converted} API docs + ${guide_count} guides)"
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
