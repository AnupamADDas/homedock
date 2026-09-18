#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Auto-activate virtual environment if present
if [ -d "$SCRIPT_DIR/venv" ]; then
    source "$SCRIPT_DIR/venv/bin/activate"
fi

export PYTHONPATH="$SCRIPT_DIR:$PYTHONPATH"
export HOMEDOCK_DATA_DIR="${HOMEDOCK_DATA_DIR:-$SCRIPT_DIR/data}"
export HOMEDOCK_HOST="${HOMEDOCK_HOST:-0.0.0.0}"
export HOMEDOCK_PORT="${HOMEDOCK_PORT:-8090}"

mkdir -p "$HOMEDOCK_DATA_DIR"

echo "=========================================================="
echo " Starting HomeDock — Web-Based Server Manager"
echo " Host: $HOMEDOCK_HOST | Port: $HOMEDOCK_PORT"
echo " Data Directory: $HOMEDOCK_DATA_DIR"
echo "=========================================================="

exec python3 -m uvicorn app.main:app --host "$HOMEDOCK_HOST" --port "$HOMEDOCK_PORT"
