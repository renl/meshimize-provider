#!/bin/sh
set -e

# The config references docs at ./docs-source/ (relative to /app), but the
# actual documents live on a persistent Fly.io volume mounted at /data.
# Create a symlink so the app can resolve ./docs-source to /data/docs-source.
ln -sf /data/docs-source /app/docs-source

exec "$@"
