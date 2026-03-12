# Scripts

Documentation acquisition scripts for meshimize-provider.

## Overview

The `acquire-docs.sh` script downloads and prepares documentation sources that the provider agent
ingests into its vector store. Each documentation set is identified by a **slug** that matches the
group configuration in `config/meshimize-provider.yaml`.

Output is written to `docs-source/<slug>/` (git-ignored).

## Prerequisites

| Dependency      | Required For  | Notes                                         |
| --------------- | ------------- | --------------------------------------------- |
| `git`           | All           | Cloning documentation repositories            |
| `Erlang/OTP 27` | `elixir-docs` | Required to compile Elixir from source        |
| `make`          | `elixir-docs` | Building Elixir and ExDoc                     |
| `mix`           | `elixir-docs` | Ships with Erlang/OTP install (used by ExDoc) |

> **Note**: The `fly-docs` target only requires `git`.

## Usage

```bash
# Acquire a specific documentation set
./scripts/acquire-docs.sh fly-docs
./scripts/acquire-docs.sh elixir-docs

# Acquire all documentation sets
./scripts/acquire-docs.sh all

# Acquire all (same as omitting the argument)
./scripts/acquire-docs.sh
```

## Documentation Sets

### `fly-docs`

Clones the [Fly.io documentation](https://github.com/superfly/docs) repository (shallow clone). On
subsequent runs, pulls the latest changes.

- **Output**: `docs-source/fly-docs/`
- **Time**: ~30 seconds

### `elixir-docs`

Builds the Elixir standard library documentation from source using ExDoc. This is necessary because
the Elixir docs are not available as pre-built markdown — they must be generated from the Elixir
source code.

The script:

1. Clones `elixir-lang/elixir` at a specified version tag (default: `v1.18.3`)
2. Clones `elixir-lang/ex_doc` as a build tool
3. Compiles Elixir from source
4. Builds the ExDoc escript
5. Runs `make docs` to generate markdown documentation
6. Copies the 6 doc sets (`elixir`, `mix`, `ex_unit`, `iex`, `logger`, `eex`) to the output
   directory
7. Copies guide pages (getting-started, references, mix-and-otp, anti-patterns, meta-programming,
   cheatsheets) to `guides/`

- **Output**: `docs-source/elixir-docs/`
- **Time**: Several minutes (compiling from source)
- **Elixir version**: Set via `ELIXIR_VERSION` env var (default: `v1.18.3`)

```bash
# Build docs for a specific Elixir version
ELIXIR_VERSION=v1.17.3 ./scripts/acquire-docs.sh elixir-docs
```

## Idempotency

All acquisition functions are idempotent. Running the script multiple times is safe:

- `fly-docs`: Pulls latest changes if already cloned
- `elixir-docs`: Cleans and rebuilds the output directory from scratch

## Uploading Docs to Fly.io

After acquiring docs locally, you need to upload them to the Fly.io persistent volume so the
deployed provider agent can access them. The `fly sftp shell` command is interactive and does not
support recursive directory uploads, so we tar the docs first, upload a single archive, then extract
on the remote machine.

### Generic Pattern

Replace `<slug>` with the documentation set slug (e.g., `fly-docs`, `elixir-docs`):

```bash
# 1. Tar up the docs directory locally
tar czf <slug>.tar.gz -C docs-source/<slug> .

# 2. Upload the tarball via sftp (interactive — type the `put` command at the prompt)
fly sftp shell --app meshimize-provider
# sftp> put <slug>.tar.gz /data/<slug>.tar.gz

# 3. SSH in and extract
fly ssh console --app meshimize-provider
mkdir -p /data/docs-source/<slug>
tar xzf /data/<slug>.tar.gz -C /data/docs-source/<slug>
rm /data/<slug>.tar.gz
```

### Example: `fly-docs`

```bash
tar czf fly-docs.tar.gz -C docs-source/fly-docs .

fly sftp shell --app meshimize-provider
# sftp> put fly-docs.tar.gz /data/fly-docs.tar.gz

fly ssh console --app meshimize-provider
mkdir -p /data/docs-source/fly-docs
tar xzf /data/fly-docs.tar.gz -C /data/docs-source/fly-docs
rm /data/fly-docs.tar.gz
```

### Example: `elixir-docs`

```bash
tar czf elixir-docs.tar.gz -C docs-source/elixir-docs .

fly sftp shell --app meshimize-provider
# sftp> put elixir-docs.tar.gz /data/elixir-docs.tar.gz

fly ssh console --app meshimize-provider
mkdir -p /data/docs-source/elixir-docs
tar xzf /data/elixir-docs.tar.gz -C /data/docs-source/elixir-docs
rm /data/elixir-docs.tar.gz
```

> **Why tar?** `fly sftp shell` opens an interactive SFTP session that only supports single-file
> transfers (`put`/`get`). It cannot recursively upload directories. Tarring first collapses the
> entire docs tree into one file for upload, then we extract it on the volume.
