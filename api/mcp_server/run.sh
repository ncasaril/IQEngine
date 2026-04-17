#!/usr/bin/env bash
# IQEngine MCP server launcher — stdio transport.
# Set IQENGINE_API_URL to point at a non-default backend (default: http://localhost:5000).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/.venv/bin/python" "$HERE/server.py"
