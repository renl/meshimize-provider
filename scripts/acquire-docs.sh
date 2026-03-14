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
  local abs_docs_dir
  abs_docs_dir="$(cd "${DOCS_DIR}" && pwd)"

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
    export MIX_HOME="${abs_docs_dir}/.mix"
    export HEX_HOME="${abs_docs_dir}/.hex"
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

# ─── Phoenix Docs ───
# Builds Phoenix ecosystem documentation using ExDoc. Clones each Phoenix
# library, compiles it with mix, generates HTML docs, converts to markdown.
# Prerequisites: git, erl (Erlang/OTP 27+), elixir, mix, pandoc
acquire_phoenix_docs() {
  local slug="phoenix-docs"
  local phoenix_version="${PHOENIX_VERSION:-v1.8.5}"
  local target="${DOCS_DIR}/${slug}"

  # ── Prerequisite checks ──
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=("git")
  command -v erl >/dev/null 2>&1 || missing+=("erl (Erlang/OTP 27+)")
  command -v mix >/dev/null 2>&1 || missing+=("mix (Elixir)")
  command -v pandoc >/dev/null 2>&1 || missing+=("pandoc")

  if [ ${#missing[@]} -gt 0 ]; then
    echo "ERROR: Missing required tools: ${missing[*]}"
    echo "Install them and try again."
    exit 1
  fi

  echo "Building Phoenix ecosystem docs (Phoenix ${phoenix_version})..."

  mkdir -p "${DOCS_DIR}"
  local abs_docs_dir
  abs_docs_dir="$(cd "${DOCS_DIR}" && pwd)"

  # Clean and prepare target directory
  rm -rf "${target}"
  mkdir -p "${target}"

  # Phoenix ecosystem libraries to document.
  # Each entry: "repo_url tag_prefix package_name"
  # tag_prefix is used to construct the git tag: "${tag_prefix}${version}"
  # For phoenix core, the tag is just the version (e.g., v1.8.5).
  # For ecosystem libs, each has its own repo and version tags.
  local -A phoenix_libs=(
    ["phoenix"]="https://github.com/phoenixframework/phoenix.git v ${phoenix_version}"
    ["phoenix_live_view"]="https://github.com/phoenixframework/phoenix_live_view.git v ${PHOENIX_LIVE_VIEW_VERSION:-v1.0.9}"
    ["phoenix_html"]="https://github.com/phoenixframework/phoenix_html.git v ${PHOENIX_HTML_VERSION:-v4.2.1}"
    ["phoenix_ecto"]="https://github.com/phoenixframework/phoenix_ecto.git v ${PHOENIX_ECTO_VERSION:-v4.6.4}"
    ["phoenix_pubsub"]="https://github.com/phoenixframework/phoenix_pubsub.git v ${PHOENIX_PUBSUB_VERSION:-v2.1.3}"
  )

  # Files to skip during HTML→markdown conversion (navigation/infrastructure)
  local skip_files="index.html search.html 404.html genindex.html"

  local grand_total=0

  for lib in "${!phoenix_libs[@]}"; do
    local info="${phoenix_libs[$lib]}"
    local repo_url tag_prefix version
    repo_url="$(echo "${info}" | awk '{print $1}')"
    tag_prefix="$(echo "${info}" | awk '{print $2}')"
    version="$(echo "${info}" | awk '{print $3}')"

    local lib_src="${DOCS_DIR}/.phoenix-source/${lib}"
    local lib_tag="${version}"

    echo "── Processing ${lib} (${lib_tag}) ──"

    # Clone or update source
    if [ -d "${lib_src}/.git" ]; then
      echo "  Updating ${lib} source..."
      git -C "${lib_src}" fetch --depth 1 origin "refs/tags/${lib_tag}"
      git -C "${lib_src}" checkout FETCH_HEAD
      git -C "${lib_src}" clean -fdx
    else
      if [ -d "${lib_src}" ]; then
        echo "  Removing stale ${lib_src} (not a git repo)..."
        rm -rf "${lib_src}"
      fi
      echo "  Cloning ${lib} (${lib_tag})..."
      mkdir -p "$(dirname "${lib_src}")"
      git clone --depth 1 --branch "${lib_tag}" "${repo_url}" "${lib_src}"
    fi

    # Build docs with mix
    echo "  Compiling and generating docs..."
    (
      cd "${lib_src}"
      export MIX_HOME="${abs_docs_dir}/.mix"
      export HEX_HOME="${abs_docs_dir}/.hex"
      export MIX_ENV=docs
      mix local.hex --force --if-missing
      mix local.rebar --force --if-missing

      # Ensure ex_doc is available for `mix docs`.
      # Some Phoenix ecosystem libs don't include ex_doc as a dependency,
      # others restrict it to specific Mix environments (only: :docs or only: :dev).
      # We inject it without env restriction if not present, and always run in MIX_ENV=docs.
      if ! grep -q ':ex_doc' mix.exs; then
        echo "  Injecting ex_doc dependency into mix.exs..."
        sed -i '/def\(p\)\{0,1\} deps do/,/\[/ s/\[/[\n      {:ex_doc, "~> 0.34", runtime: false},/' mix.exs
      fi

      mix deps.get
      mix compile
      mix docs
    )

    # Convert HTML to markdown
    local doc_dir="${lib_src}/doc"
    if [ ! -d "${doc_dir}" ]; then
      echo "  WARNING: doc/ not found for ${lib}, skipping conversion"
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
    done < <(find "${doc_dir}" -name '*.html' -print0)

    grand_total=$((grand_total + lib_count))
    echo "  Converted: ${lib_count} HTML files for ${lib}"
  done

  echo "Acquired: ${slug} → ${target} (${grand_total} total docs across ${#phoenix_libs[@]} libraries)"
}

# ─── Main ───
case "${1:-all}" in
  fly-docs) acquire_fly_docs ;;
  elixir-docs) acquire_elixir_docs ;;
  phoenix-docs) acquire_phoenix_docs ;;
  all)
    acquire_fly_docs
    acquire_elixir_docs
    acquire_phoenix_docs
    ;;
  *) echo "Unknown slug: $1"; exit 1 ;;
esac
