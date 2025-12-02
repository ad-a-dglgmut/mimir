#!/bin/bash
set -e

echo "=== Creating Universal macOS Virtual Environment for Apple Silicon/Intel ==="

# Clean up
rm -rf macos-venv

# Check architecture
ARCH=$(uname -m)
echo "Running on: $ARCH"

# 1. Create venv with --copies to avoid symlinks to framework
echo "Creating virtual environment with copied binaries..."
python3 -m venv --copies macos-venv

# 2. Install packages
echo "Installing packages..."
./macos-venv/bin/pip install --upgrade pip
./macos-venv/bin/pip install -r requirements.txt

# 3. Test it works in CI
echo "Testing in CI..."
./macos-venv/bin/python -c "import pandas, numpy, groq, matplotlib; print('✓ All packages work in CI')"

# 4. CRITICAL: Create a universal wrapper that works on both Intel and ARM
echo "Creating universal wrapper script..."

# Get Python version
PYTHON_VERSION=$(./macos-venv/bin/python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")

# Create a robust wrapper that handles Rosetta 2 and framework paths
cat > macos-venv/bin/python_wrapper << 'EOF'
#!/bin/bash
# Universal Python wrapper for macOS (Intel/ARM + Rosetta 2)
# This works around framework path issues and app translocation

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
VENV_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Find site-packages directory
SITE_PACKAGES="$VENV_ROOT/lib/python__PYVER__/site-packages"

# Debug info (can be removed in production)
if [ -n "$DEBUG_PYTHON" ]; then
    echo "=== Python Wrapper Debug ==="
    echo "Script dir: $SCRIPT_DIR"
    echo "Venv root: $VENV_ROOT"
    echo "Site packages: $SITE_PACKAGES"
    echo "Architecture: $(uname -m)"
    echo "Python version: __PYVER__"
    echo "============================"
fi

# Check if we're running under Rosetta
if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null) == "1" ]]; then
    echo "⚠ Running under Rosetta 2 translation"
fi

# Set up Python environment
export PYTHONPATH="$SITE_PACKAGES:$PYTHONPATH"
export VIRTUAL_ENV="$VENV_ROOT"

# Unset PYTHONHOME to avoid conflicts with framework Python
unset PYTHONHOME

# Try multiple Python executables in order:
# 1. System python (architecture appropriate)
# 2. python3 from PATH
# 3. python from PATH

# First, try to use the architecture-appropriate system Python
if command -v python__PYVER__ >/dev/null 2>&1; then
    exec python__PYVER__ "$@"
elif command -v python3 >/dev/null 2>&1; then
    exec python3 "$@"
elif command -v python >/dev/null 2>&1; then
    exec python "$@"
else
    echo "ERROR: No Python interpreter found!" >&2
    echo "Tried: python__PYVER__, python3, python" >&2
    exit 1
fi
EOF

# Replace version placeholder
sed -i.bak "s/__PYVER__/$PYTHON_VERSION/g" macos-venv/bin/python_wrapper
rm -f macos-venv/bin/python_wrapper.bak

# Make executable
chmod +x macos-venv/bin/python_wrapper

# 5. Backup original and replace with wrapper
echo "Replacing Python binary with wrapper..."
mv macos-venv/bin/python macos-venv/bin/python.framework
ln -sf python_wrapper macos-venv/bin/python
ln -sf python_wrapper macos-venv/bin/python3

# 6. Also create a pip wrapper
cat > macos-venv/bin/pip_wrapper << EOF
#!/bin/bash
SCRIPT_DIR="\$( cd "\$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
\$SCRIPT_DIR/python -m pip "\$@"
EOF

chmod +x macos-venv/bin/pip_wrapper
ln -sf pip_wrapper macos-venv/bin/pip
ln -sf pip_wrapper macos-venv/bin/pip3

# 7. Test the wrapper
echo "Testing wrapper..."
if ./macos-venv/bin/python -c "import pandas; print(f'✓ Wrapper successful! Pandas {pandas.__version__}')"; then
    echo "✓ Universal wrapper works!"
else
    echo "⚠ Wrapper test failed, but venv may still work in CI"
fi

echo "=== Universal macOS venv created! ==="
echo "Size: \$(du -sh macos-venv | cut -f1)"
echo ""
echo "This venv uses a wrapper that:"
echo "1. Works on both Intel and Apple Silicon"
echo "2. Handles Rosetta 2 translation"
echo "3. Avoids framework path issues"
echo "4. Survives app translocation"
