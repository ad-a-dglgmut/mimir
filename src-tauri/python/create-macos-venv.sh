#!/bin/bash
set -e

echo "=== Creating Portable macOS Virtual Environment ==="

# Clean up existing venv
rm -rf macos-venv-portable

# Create a temporary venv for package installation
echo "Creating temporary venv..."
python3 -m venv macos-venv-temp
source macos-venv-temp/bin/activate

# Install packages
pip install --upgrade pip
pip install -r requirements.txt

# Get Python version
PYTHON_VERSION=$(python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "Python version: $PYTHON_VERSION"

# Create portable venv structure
echo "Creating portable venv structure..."
mkdir -p macos-venv-portable/bin
mkdir -p macos-venv-portable/lib/python$PYTHON_VERSION/site-packages
mkdir -p macos-venv-portable/lib/python$PYTHON_VERSION/site-packages

# Copy site-packages
echo "Copying installed packages..."
cp -r macos-venv-temp/lib/python$PYTHON_VERSION/site-packages/* macos-venv-portable/lib/python$PYTHON_VERSION/site-packages/

# Create a proper Python launcher script
cat > macos-venv-portable/bin/python << 'EOF'
#!/bin/bash
# Portable Python launcher for macOS

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
VENV_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Calculate Python version from directory structure
PYTHON_LIB_DIR=$(find "$VENV_ROOT/lib" -name "python3.*" -type d | head -1)
PYTHON_VERSION=$(basename "$PYTHON_LIB_DIR" | sed 's/python//')

# Set environment variables
export PYTHONHOME="$VENV_ROOT"
export VIRTUAL_ENV="$VENV_ROOT"
export PYTHONPATH="$PYTHON_LIB_DIR/site-packages"

# Use system Python but with our site-packages
exec /usr/bin/env python$PYTHON_VERSION -c "
import sys
sys.path.insert(0, '$PYTHON_LIB_DIR/site-packages')
# Now run the actual command
if len(sys.argv) > 1:
    # If called with -c, we need special handling
    if sys.argv[1] == '-c':
        exec(sys.argv[2])
    else:
        # Run as script
        with open(sys.argv[1], 'r') as f:
            code = compile(f.read(), sys.argv[1], 'exec')
            exec(code)
" "$@"
EOF

# Create pip wrapper
cat > macos-venv-portable/bin/pip << 'EOF'
#!/bin/bash
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
VENV_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
PYTHON_LIB_DIR=$(find "$VENV_ROOT/lib" -name "python3.*" -type d | head -1)

# Use system pip with our site-packages path
/usr/bin/env python3 -c "
import sys
sys.path.insert(0, '$PYTHON_LIB_DIR/site-packages')
import pip
sys.exit(pip.main())
" "$@"
EOF

# Create python3 symlink
ln -sf python macos-venv-portable/bin/python3

# Make executable
chmod +x macos-venv-portable/bin/python
chmod +x macos-venv-portable/bin/pip

# Test the portable venv
echo "Testing portable venv..."
if macos-venv-portable/bin/python -c "import pandas, numpy, groq, matplotlib; print('SUCCESS: All imports work')"; then
    echo "✓ Portable venv created successfully"
else
    echo "✗ Portable venv test failed"
    exit 1
fi

# Clean up temp venv
rm -rf macos-venv-temp

# Rename to standard name for bundling
mv macos-venv-portable macos-venv

echo "=== macOS portable virtual environment ready! ==="
echo "Size: $(du -sh macos-venv | cut -f1)"
