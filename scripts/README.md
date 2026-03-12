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
