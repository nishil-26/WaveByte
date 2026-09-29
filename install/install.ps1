# WaveByte CLI installer — Windows (PowerShell).
# Installs sox (audio I/O) if missing, then installs the `wavebyte` command
# globally via npm, straight from this GitHub repo. This script is fetched
# once, over the internet, as any installer for any tool is — after this
# one-time setup, WaveByte itself never uses the internet or a shared
# network between the two laptops; only sound.
#
# Everything here runs inside a function and uses `return` (never bare
# `exit`) to stop early on a problem. That matters specifically because this
# script is meant to be run as `irm <url> | iex`, which evaluates the script
# text directly in your CURRENT PowerShell session rather than a separate
# process — a bare `exit` in that context closes your whole terminal window
# instead of just stopping the script, before you'd ever see why.

function Install-WaveByte {
    $Repo = "github:nishil-26/WaveByte"

    Write-Host "==> WaveByte CLI installer"

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Node.js is required but wasn't found. Install it from https://nodejs.org, then re-run this script." -ForegroundColor Red
        return
    }

    if (-not (Get-Command sox -ErrorAction SilentlyContinue)) {
        Write-Host "==> Installing sox (used for microphone/speaker access)..."
        if (Get-Command choco -ErrorAction SilentlyContinue) {
            choco install sox.portable -y
            if ($LASTEXITCODE -ne 0) {
                Write-Host "choco install sox.portable failed (exit code $LASTEXITCODE). See the output above for why." -ForegroundColor Red
                return
            }
        } else {
            Write-Host "Chocolatey wasn't found, so sox can't be installed automatically." -ForegroundColor Red
            Write-Host "Either install Chocolatey from https://chocolatey.org/install and re-run this script," -ForegroundColor Red
            Write-Host "or download SoX manually from https://sourceforge.net/projects/sox/files/sox/ and add its folder to your PATH yourself." -ForegroundColor Red
            return
        }
    } else {
        Write-Host "==> sox already installed."
    }

    Write-Host "==> Installing the wavebyte command..."
    npm install -g $Repo
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed (exit code $LASTEXITCODE). See the output above for why." -ForegroundColor Red
        return
    }

    Write-Host ""
    Write-Host "Done. On each laptop, first run:  wavebyte calibrate" -ForegroundColor Green
    Write-Host "Then just run:                    wavebyte" -ForegroundColor Green
}

Install-WaveByte
