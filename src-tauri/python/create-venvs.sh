#!/bin/bash
set -e

echo "=== Setting up Python Environment for Tauri App ==="

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Script directory: $SCRIPT_DIR"

# Navigate to the Tauri app directory (assuming this script is in the project root)
cd "$SCRIPT_DIR"

# Determine the target directory for the virtual environment
# For Tauri, we need it in the resources/python directory
TAURI_RESOURCES_DIR="src-tauri/resources"
PYTHON_DIR="$TAURI_RESOURCES_DIR/python"

echo "Creating Python environment in: $PYTHON_DIR"

# Clean up existing directory
if [ -d "$PYTHON_DIR" ]; then
    echo "Removing existing Python directory..."
    rm -rf "$PYTHON_DIR"
fi

# Create directory structure
mkdir -p "$PYTHON_DIR"

# Create requirements.txt if it doesn't exist
if [ ! -f "requirements.txt" ]; then
    cat > requirements.txt << EOF
pandas>=2.0.0
numpy>=1.24.0
groq>=0.36.0
matplotlib>=3.7.0
openpyxl>=3.1.0
EOF
    echo "Created requirements.txt"
fi

echo "Installing packages from requirements.txt:"
cat requirements.txt

# ===== CREATE LINUX VENV =====
echo "Creating Linux virtual environment..."
VENV_PATH="$PYTHON_DIR/linux-venv"
python3 -m venv "$VENV_PATH"

# Install packages
"$VENV_PATH/bin/pip" install --upgrade pip
"$VENV_PATH/bin/pip" install -r requirements.txt

# CRITICAL: Fix permissions
echo "Fixing permissions..."
chmod -R 755 "$VENV_PATH/"
find "$VENV_PATH/bin" -type f -name "python*" -exec chmod 755 {} \;
find "$VENV_PATH/bin" -type f -name "pip*" -exec chmod 755 {} \;
find "$VENV_PATH/bin" -type f -name "activate*" -exec chmod 755 {} \;

# Also copy analyzer.py if it exists
ANALYZER_SRC="analyzer.py"
if [ -f "$ANALYZER_SRC" ]; then
    echo "Copying analyzer.py to Python directory..."
    cp "$ANALYZER_SRC" "$PYTHON_DIR/"
else
    echo "Warning: analyzer.py not found in current directory"
    # Create a placeholder analyzer.py
    cat > "$PYTHON_DIR/analyzer.py" << 'EOF'
#!/usr/bin/env python3
import sys
import json
import pandas as pd

def main():
    print("Python analyzer is working!")
    print(f"Python version: {sys.version}")
    
    try:
        import pandas
        print(f"Pandas version: {pandas.__version__}")
        print("SUCCESS: All packages loaded correctly")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
EOF
fi

# ===== VERIFY =====
echo "=== Verifying setup ==="
echo "Directory structure:"
find "$PYTHON_DIR" -type f -name "python*" | head -10

echo ""
echo "Testing Python binary:"
if "$VENV_PATH/bin/python" -c "import sys; print(f'Python {sys.version}')"; then
    echo "✓ Python binary works"
else
    echo "✗ Python binary failed"
    exit 1
fi

echo ""
echo "Testing imports:"
if "$VENV_PATH/bin/python" -c "
import pandas, numpy, groq, matplotlib, openpyxl
print('✓ All packages imported successfully')
print(f'  Pandas: {pandas.__version__}')
print(f'  NumPy: {numpy.__version__}')
"; then
    echo "✓ Virtual environment setup complete"
else
    echo "✗ Package import failed"
    exit 1
fi

echo ""
echo "=== Setup Complete! ==="
echo "Python environment created at: $PYTHON_DIR"
echo "Virtual environment size: $(du -sh "$VENV_PATH" | cut -f1)"
echo ""
echo "File permissions for Python binary:"
ls -la "$VENV_PATH/bin/python" | awk '{print "  " $1 " " $3 " " $4 " " $9}'
