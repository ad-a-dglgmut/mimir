#!/bin/bash
set -e

echo "=== Creating Python Virtual Environments ==="

# Skip macOS - we'll use the specialized script
echo "Note: macOS venv should be created with create-macos-venv.sh"
echo "Creating Linux and Windows venvs only..."

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

# Create Linux venv (standard)
echo "Creating Linux virtual environment..."
python3 -m venv linux-venv
./linux-venv/bin/pip install --upgrade pip
./linux-venv/bin/pip install -r requirements.txt

# Create Windows venv (will be used on Windows CI)
echo "Creating Windows virtual environment..."
python3 -m venv windows-venv
./windows-venv/bin/pip install --upgrade pip
./windows-venv/bin/pip install -r requirements.txt

# Verify
echo "=== Verifying ==="
echo "Linux packages:"
./linux-venv/bin/python -c "import pandas; print(f'Pandas: {pandas.__version__}')"

echo "Windows packages:"
./windows-venv/bin/python -c "import pandas; print(f'Pandas: {pandas.__version__}')"

echo "=== Linux & Windows venvs created! ==="
echo "Linux size: $(du -sh linux-venv | cut -f1)"
echo "Windows size: $(du -sh windows-venv | cut -f1)"
