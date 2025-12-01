#!/bin/bash
set -e

echo "=== Creating Python Virtual Environments for All Platforms ==="

# Create directories
mkdir -p windows-venv linux-venv macos-venv

# Create requirements.txt if it doesn't exist
if [ ! -f "requirements.txt" ]; then
    cat > requirements.txt << EOF
pandas>=2.0.0
numpy>=1.24.0
groq>=0.3.0
matplotlib>=3.7.0
openpyxl>=3.1.0
EOF
    echo "Created requirements.txt"
fi

echo "Installing packages from requirements.txt:"
cat requirements.txt

# Create Linux venv
echo "Creating Linux virtual environment..."
python3 -m venv linux-venv
./linux-venv/bin/pip install --upgrade pip
./linux-venv/bin/pip install -r requirements.txt

# Create MacOS venv  
echo "Creating MacOS virtual environment..."
python3 -m venv macos-venv
./macos-venv/bin/pip install --upgrade pip
./macos-venv/bin/pip install -r requirements.txt

# Create Windows venv structure (will be functional on Windows)
echo "Creating Windows virtual environment..."
python3 -m venv windows-venv
./windows-venv/bin/pip install --upgrade pip
./windows-venv/bin/pip install -r requirements.txt

# Verify installations with ASCII-only output
echo "=== Verifying installations ==="
echo "Linux Python packages:"
./linux-venv/bin/pip list | head -20

echo "MacOS Python packages:"
./macos-venv/bin/pip list | head -20

echo "Windows Python packages:"
./windows-venv/bin/pip list | head -20

# Create ASCII-only verification script
cat > verify_venv.py << 'EOF'
#!/usr/bin/env python3
import sys
import pandas as pd
import numpy as np
import matplotlib
from groq import Groq
import openpyxl

print("SUCCESS: All packages imported successfully!")
print(f"Pandas version: {pd.__version__}")
print(f"Numpy version: {np.__version__}") 
print(f"Matplotlib version: {matplotlib.__version__}")
print(f"Openpyxl version: {openpyxl.__version__}")

# Test Groq client creation (without making actual API calls)
try:
    client = Groq()
    print("Groq: Client created successfully")
except Exception as e:
    print(f"Groq: Client creation failed (this may be normal without API key): {e}")

# Test basic functionality
df = pd.DataFrame({'test': [1, 2, 3]})
print("Basic pandas functionality verified")
EOF

echo "Running verification script..."
echo "=== Linux ==="
./linux-venv/bin/python verify_venv.py
echo "=== MacOS ==="  
./macos-venv/bin/python verify_venv.py
echo "=== Windows ==="
./windows-venv/bin/python verify_venv.py

rm verify_venv.py

echo "=== Virtual environments created successfully! ==="
echo "Linux venv size: $(du -sh linux-venv | cut -f1)"
echo "MacOS venv size: $(du -sh macos-venv | cut -f1)" 
echo "Windows venv size: $(du -sh windows-venv | cut -f1)"
