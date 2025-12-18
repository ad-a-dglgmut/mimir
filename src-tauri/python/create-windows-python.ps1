# src-tauri/python/create-windows-python.ps1
Write-Host "=== Setting Up Python Embeddable for Windows ===" -ForegroundColor Green

$pythonVersion = "3.11.9"
$zipFile = "python-$pythonVersion-embed-amd64.zip"
$destDir = "windows-python" # This sits inside your 'python' folder
$url = "https://www.python.org/ftp/python/$pythonVersion/$zipFile"

# 1. Clean old builds
if (Test-Path $destDir) { Remove-Item -Recurse -Force $destDir }
New-Item -ItemType Directory -Path $destDir | Out-Null

# 2. Download and Extract
Write-Host "Downloading Python $pythonVersion..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $zipFile
Expand-Archive -Path $zipFile -DestinationPath $destDir -Force
Remove-Item $zipFile

# 3. CRITICAL: Enable site-packages
# This allows the embedded python to actually "see" the libraries you install
$pthFile = Get-ChildItem "$destDir\python311._pth"
$content = Get-Content $pthFile
$content = $content -replace '#import site', 'import site'
$content += "`nLib\site-packages"
$content | Set-Content $pthFile

# 4. Install Pip and Requirements
Write-Host "Installing pip and dependencies..." -ForegroundColor Cyan
Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile "get-pip.py"
& ".\$destDir\python.exe" "get-pip.py" --no-warn-script-location
Remove-Item "get-pip.py"

# Install requirements into the local site-packages folder
& ".\$destDir\python.exe" -m pip install -r requirements.txt --target "$destDir\Lib\site-packages" --no-cache-dir

Write-Host "=== Windows Python Setup Complete ===" -ForegroundColor Green
