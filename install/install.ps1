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
    # Installed from a tarball URL rather than npm's `github:owner/repo`
    # shorthand -- that shorthand goes through npm's git-clone install path,
    # which (confirmed by testing) can leave a dangling symlink into npm's
    # own temp cache instead of actually copying the package, breaking
    # `wavebyte` right after a successful-looking install. A tarball URL
    # doesn't have that problem.
    $Repo = "https://github.com/nishil-26/WaveByte/archive/refs/heads/main.tar.gz"

    Write-Host "==> WaveByte CLI installer"

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Node.js is required but wasn't found. Install it from https://nodejs.org, then re-run this script." -ForegroundColor Red
        return
    }

    if (-not (Get-Command sox -ErrorAction SilentlyContinue)) {
        # Deliberately NOT automated: the Chocolatey "sox.portable" package is
        # flagged "Possibly broken" upstream (confirmed -- its install script
        # calls a helper function Chocolatey itself no longer ships), and a
        # scripted SourceForge download also isn't reliable (its file links
        # go through an HTML/JS interstitial page that PowerShell can't
        # click through, so Invoke-WebRequest ends up saving that HTML page
        # instead of the real file). Both were tried and failed in practice.
        # The manual path below is the one confirmed to actually work.
        Write-Host "sox wasn't found. Install it manually (2 minutes, one-time):" -ForegroundColor Yellow
        Write-Host "  1. Open https://sourceforge.net/projects/sox/files/sox/14.4.2/ in your browser" -ForegroundColor Yellow
        Write-Host "     and download sox-14.4.2-win32.zip." -ForegroundColor Yellow
        Write-Host "  2. Right-click the downloaded zip -> Extract All." -ForegroundColor Yellow
        Write-Host "  3. Find the folder inside it containing sox.exe." -ForegroundColor Yellow
        Write-Host "  4. Add that folder to your PATH: Win+R -> sysdm.cpl -> Advanced ->" -ForegroundColor Yellow
        Write-Host "     Environment Variables -> edit your User 'Path' -> add that folder." -ForegroundColor Yellow
        Write-Host "  5. Open a NEW PowerShell window and re-run this installer." -ForegroundColor Yellow
        return
    }
    Write-Host "==> sox already installed."

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
