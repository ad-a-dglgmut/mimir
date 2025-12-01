# PowerShell script to create virtual environments on Windows
Write-Host "=== Creating Python Virtual Environments for All Platforms ===" -ForegroundColor Green

# Create directories
New-Item -ItemType Directory -Force -Path "windows-venv", "linux-venv", "macos-venv" | Out-Null

# Create requirements.txt if it doesn't exist
if (!(Test-Path "requirements.txt")) {
    @"
pandas>=2.0.0
numpy>=1.24.0
groq>=0.3.0
matplotlib>=3.7.0
openpyxl>=3.1.0
"@ | Out-File -FilePath "requirements.txt" -Encoding UTF8
    Write-Host "Created requirements.txt" -ForegroundColor Yellow
}

Write-Host "Installing packages from requirements.txt:" -ForegroundColor Cyan
Get-Content requirements.txt

# Create Windows venv
Write-Host "Creating Windows virtual environment..." -ForegroundColor Cyan
python -m venv windows-venv
.\windows-venv\Scripts\pip.exe install --upgrade pip
.\windows-venv\Scripts\pip.exe install -r requirements.txt

# Note: Linux and MacOS venvs will be created on their respective platforms
Write-Host "Note: Linux and MacOS venvs will be created on their respective CI platforms" -ForegroundColor Yellow

# Verify installation
Write-Host "=== Verifying Windows installation ===" -ForegroundColor Cyan
.\windows-venv\Scripts\pip.exe list

# Create Windows-compatible verification script (ASCII only)
@"
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
    
except ImportError as e:
    print(f"FAILED: {e}")
    sys.exit(1)
"@ | Out-File -FilePath "verify_venv.py" -Encoding UTF8

Write-Host "Running verification script..." -ForegroundColor Cyan
$env:PYTHONIOENCODING = "utf-8"
.\windows-venv\Scripts\python.exe verify_venv.py

Remove-Item verify_venv.py -ErrorAction SilentlyContinue

# Calculate directory size
$windowsSize = (Get-ChildItem -Path "windows-venv" -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host "Windows venv size: $([math]::Round($windowsSize, 2)) MB" -ForegroundColor Green

Write-Host "=== Virtual environments created successfully! ===" -ForegroundColor Green
