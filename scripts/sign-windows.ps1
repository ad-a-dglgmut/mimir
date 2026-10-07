
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Files
)

$ErrorActionPreference = 'Stop'

if (-not $Files -or $Files.Count -eq 0) {
    Write-Error "No files given to sign"
    exit 1
}

java -jar $env:JSIGN_JAR `
    --storetype GOOGLECLOUD `
    --storepass $env:GCP_ACCESS_TOKEN `
    --keystore $env:KMS_KEYSTORE `
    --alias $env:KMS_KEY `
    --certfile $env:SIGN_CERT_PATH `
    --tsaurl "http://timestamp.sectigo.com/rfc3161" `
    --tsmode RFC3161 `
    @Files

if ($LASTEXITCODE -ne 0) {
    Write-Error "jsign failed with exit code $LASTEXITCODE"
    exit 1
}
