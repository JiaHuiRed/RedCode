#!/bin/bash
#
# ensure-deps.sh
# Ensures typegraph-mcp dependencies are installed.
# Called automatically by Claude Code on session start via plugin hooks.
#

set -e

PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

if command -v node &> /dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "Warning: typegraph-mcp requires Node.js >= 22. Current: $(node -v)"
    exit 1
  fi
fi

# Check if node_modules exist with required packages
if [ -d "$PLUGIN_DIR/node_modules/@modelcontextprotocol" ] && \
   [ -d "$PLUGIN_DIR/node_modules/oxc-parser" ] && \
   [ -d "$PLUGIN_DIR/node_modules/oxc-resolver" ]; then
  echo "typegraph-mcp dependencies OK"
  exit 0
fi

echo "Installing typegraph-mcp dependencies..."
cd "$PLUGIN_DIR"

if command -v npm &> /dev/null; then
  npm install --include=optional
else
  echo "Warning: npm not found. Run 'npm install' in $PLUGIN_DIR manually."
  exit 1
fi

echo "typegraph-mcp dependencies installed"
exit 0
