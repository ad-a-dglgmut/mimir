#!/bin/bash
set -e

echo "=== Setting up Python Environment for Tauri (Linux) ==="

# 1. Path Setup - Match your project structure
# This assumes the script is in the project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_DIR="$SCRIPT_DIR/src-tauri/python"

echo "Project root: $SCRIPT_DIR"
echo "Target Python directory: $PYTHON_DIR"

# 2. Clean and Create Directory
if [ -d "$PYTHON_DIR" ]; then
    echo "Cleaning existing Python directory..."
    # We remove everything EXCEPT the windows-python folder if it exists
    # to avoid breaking cross-platform builds
    find "$PYTHON_DIR" -maxdepth 1 ! -name 'windows-python' ! -name 'python' -exec rm -rf {} +
fi

mkdir -p "$PYTHON_DIR"

# 3. Create requirements.txt if missing
if [ ! -f "$SCRIPT_DIR/requirements.txt" ]; then
    cat > "$SCRIPT_DIR/requirements.txt" << EOF
pandas>=2.0.0
numpy>=1.24.0
groq>=0.36.0
matplotlib>=3.7.0
openpyxl>=3.1.0
EOF
    echo "Created requirements.txt in project root"
fi

# 4. Create Linux Venv
VENV_PATH="$PYTHON_DIR/linux-venv"
echo "Creating venv in: $VENV_PATH"

python3 -m venv "$VENV_PATH"

# 5. Install Dependencies
echo "Installing packages..."
"$VENV_PATH/bin/pip" install --upgrade pip
"$VENV_PATH/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"

# 6. Copy Analyzer Script
# Looks for analyzer.py in project root or src-tauri/python
if [ -f "$SCRIPT_DIR/analyzer.py" ]; then
    cp "$SCRIPT_DIR/analyzer.py" "$PYTHON_DIR/analyzer.py"
elif [ -f "$PYTHON_DIR/analyzer.py" ]; then
    echo "analyzer.py already in place"
else
    echo "Creating placeholder analyzer.py"
    cat > "$PYTHON_DIR/analyzer.py" << 'EOF'
import sys
import pandas as pd
print(f"Python: {sys.version}")
print(f"Pandas: {pd.__version__}")
EOF
fi

# 7. Fix Permissions
echo "Setting execution permissions..."
chmod -R 755 "$VENV_PATH"
chmod +x "$PYTHON_DIR/analyzer.py"

echo "=== Setup Complete! ==="
echo "Linux venv size: $(du -sh "$VENV_PATH" | cut -f1)"
