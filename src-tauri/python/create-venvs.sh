#!/bin/bash
set -e

echo "=== Setting up Local Python Venv (Linux) ==="

# 1. Get the directory where THIS script is located
# All paths will be relative to this folder
VENV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PATH="$VENV_ROOT/linux-venv"
REQ_FILE="$VENV_ROOT/../../requirements.txt" # Adjusting to find requirements in project root

echo "Location: $VENV_ROOT"

# 2. Clean existing venv
if [ -d "$VENV_PATH" ]; then
    echo "Cleaning existing Linux venv..."
    rm -rf "$VENV_PATH"
fi

# 3. Create Linux Venv
echo "Creating venv in: $VENV_PATH"
python3 -m venv "$VENV_PATH"

# 4. Install Dependencies
# If requirements.txt isn't 2 levels up, it checks the current folder
if [ ! -f "$REQ_FILE" ]; then
    REQ_FILE="$VENV_ROOT/requirements.txt"
fi

if [ -f "$REQ_FILE" ]; then
    echo "Installing packages from $REQ_FILE..."
    "$VENV_PATH/bin/pip" install --upgrade pip
    "$VENV_PATH/bin/pip" install -r "$REQ_FILE"
else
    echo "Warning: No requirements.txt found. Installing base packages..."
    "$VENV_PATH/bin/pip" install pandas numpy groq matplotlib openpyxl
fi

# 5. Ensure analyzer.py exists in this same folder
if [ ! -f "$VENV_ROOT/analyzer.py" ]; then
    echo "Creating placeholder analyzer.py..."
    cat > "$VENV_ROOT/analyzer.py" << 'EOF'
import sys
import json
import pandas as pd

# This line is REQUIRED for your Rust 'start_python_service' function
print("PYTHON_READY")
sys.stdout.flush()

for line in sys.stdin:
    try:
        data = json.loads(line)
        # Your analysis logic goes here
        print("===RESULT_START===")
        print(json.dumps({"raw_output": "Success", "summary": "Venv is active"}))
        print("===RESULT_END===")
        sys.stdout.flush()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
EOF
fi

# 6. Fix Permissions
chmod -R 755 "$VENV_PATH"
chmod +x "$VENV_ROOT/analyzer.py"

echo "=== Setup Complete! ==="
echo "Venv size: $(du -sh "$VENV_PATH" | cut -f1)"
