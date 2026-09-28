# WaveByte CLI installer — Windows (PowerShell).
# Installs sox (audio I/O) if missing, then installs the `wavebyte` command
# globally via npm, straight from this GitHub repo. This script is fetched
# once, over the internet, as any installer for any tool is — after this
# one-time setup, WaveByte itself never uses the internet or a shared
# network between the two laptops; only sound.

$Repo = "github:nishil-26/WaveByte"

Write-Host "==> WaveByte CLI installer"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required but wasn't found. Install it from https://nodejs.org, then re-run this script."
    exit 1
}

if (-not (Get-Command sox -ErrorAction SilentlyContinue)) {
    Write-Host "==> Installing sox (used for microphone/speaker access)..."
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install sox.portable -y
    } else {
        Write-Error "Chocolatey wasn't found. Install it from https://chocolatey.org/install and re-run this script, or download SoX manually from https://sourceforge.net/projects/sox/files/sox/ and add its folder to your PATH yourself."
        exit 1
    }
} else {
    Write-Host "==> sox already installed."
}

Write-Host "==> Installing the wavebyte command..."
npm install -g $Repo

Write-Host ""
Write-Host "Done. On each laptop, first run:  wavebyte calibrate"
Write-Host "Then just run:                    wavebyte"
