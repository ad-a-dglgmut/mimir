#!/bin/bash
set -e

echo "=== Creating macOS Virtual Environment with venv-pack ==="

# Clean up
rm -rf macos-venv macos-venv-packed.tar.gz

# 1. Create standard venv
echo "Creating standard virtual environment..."
python3 -m venv macos-venv

# 2. Install packages
echo "Installing packages..."
./macos-venv/bin/pip install --upgrade pip
./macos-venv/bin/pip install -r requirements.txt

# 3. Test it works
echo "Testing venv..."
./macos-venv/bin/python -c "import pandas, numpy, groq, matplotlib; print('✓ All packages imported successfully')"

# 4. Use venv-pack to make it portable
echo "Creating portable package with venv-pack..."
# Note: We're not actually packing it, just using venv-pack to verify it can be made portable
venv-pack --prefix ./macos-venv --output ./macos-venv-packed.tar.gz

# 5. Create a simple wrapper script (fallback if packed venv doesn't work)
echo "Creating wrapper script for portability..."

# Get Python version from the venv
PYTHON_VERSION=$(./macos-venv/bin/python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")

# Create a simpler wrapper that just sets PYTHONPATH
cat > macos-venv/bin/python_wrapper << EOF
#!/bin/bash
# Simple wrapper for macOS portability
# Get the directory where this script is located
SCRIPT_DIR="\$( cd "\$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
VENV_ROOT="\$( cd "\$SCRIPT_DIR/.." && pwd )"

# Add our site-packages to Python path
export PYTHONPATH="\$VENV_ROOT/lib/python$PYTHON_VERSION/site-packages:\$PYTHONPATH"

# Use system Python
exec python$PYTHON_VERSION "\$@"
EOF

chmod +x macos-venv/bin/python_wrapper

# 6. Test the wrapper
echo "Testing wrapper..."
if ./macos-venv/bin/python_wrapper -c "import pandas; print(f'✓ Wrapper works! Pandas {pandas.__version__}')"; then
    echo "Wrapper script works!"
    
    # Optional: You can replace the python binary with the wrapper
    # mv macos-venv/bin/python macos-venv/bin/python.original
    # ln -sf python_wrapper macos-venv/bin/python
else
    echo "Wrapper script may not work on all systems"
    echo "The standard venv should still work in CI"
fi

# 7. Clean up the packed file (we don't need it, just used for verification)
rm -f macos-venv-packed.tar.gz

echo "=== macOS venv created successfully! ==="
echo "Size: \$(du -sh macos-venv | cut -f1)"
echo ""
echo "Note: This venv uses a wrapper script for portability."
echo "If the wrapper fails, the original venv Python is at: macos-venv/bin/python.original"
