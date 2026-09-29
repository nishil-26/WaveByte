# WaveByte

Send files and text between two laptops using **sound** — their built-in
speakers and microphones, near-ultrasonic (18–19.8 kHz). No Wi-Fi, no
Bluetooth, no LAN, no internet, no pairing, no server.


## Install

You need three things before `wavebyte` itself can go in: **Node.js**,
**npm** (comes with Node, but Windows needs one extra step for it — see
below), and **sox** (handles the actual speaker/mic access, since Node has
no built-in audio I/O). macOS and Linux get all three from one line.
Windows currently needs a few manual steps first — spelled out in full
below:

### macOS / Linux

```
curl -fsSL https://raw.githubusercontent.com/nishil-26/WaveByte/main/install/install.sh | bash
```

This installs `sox` via Homebrew/apt/dnf/pacman (whichever you have), then
installs the `wavebyte` command. Needs Node.js 18+ already installed — get
it from [nodejs.org](https://nodejs.org) if `node -v` doesn't work yet.
Like any `curl | bash` installer, feel free to open the script and read it
before running it.

### Windows

Do these four steps in order. Each one fixes a specific, real problem —
don't skip ahead.

**1. Install Node.js.**
Go to [nodejs.org/en/download](https://nodejs.org/en/download) and get the
plain **Windows Installer (.msi)** — not the Chocolatey tab, not winget.
Run it like any normal installer. Close and reopen PowerShell afterward,
then confirm with `node -v`.

**2. Let PowerShell run npm's own scripts.**
Fresh Windows setups often block this by default, and npm won't work at
all until it's fixed. In PowerShell (admin not required):
```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```
Type `Y` if it asks. This is a standard, safe setting for a dev machine —
it lets locally-installed tools' scripts (like npm's) run, while still
requiring scripts downloaded from the internet to be signed. Confirm with
`npm -v`.

**3. Install sox manually.**
Download from SourceForge:
   1. Open [sourceforge.net/projects/sox/files/sox/14.4.2](https://sourceforge.net/projects/sox/files/sox/14.4.2/)
      in your browser and download `sox-14.4.2-win32.zip`.
   2. Right-click the downloaded zip → **Extract All**.
   3. Open the extracted folder and find the one containing `sox.exe`
      (something like `sox-14.4.2\`).
   4. Add that folder to your PATH: Win+R → `sysdm.cpl` → Enter →
      **Advanced** tab → **Environment Variables** → under "User
      variables", select **Path** → **Edit** → **New** → paste the folder
      path → OK on everything.
   5. Close every PowerShell window and open a new one. Confirm with
      `sox --version`.

**4. Install wavebyte itself.**
```powershell
irm https://raw.githubusercontent.com/nishil-26/WaveByte/main/install/install.ps1 | iex
```
With steps 1–3 done, this now just confirms Node/sox are there and installs
the `wavebyte` command. Confirm with `wavebyte --version`.

## First run — do this before your first real transfer

On **each** laptop, alone, run:
```
wavebyte calibrate
```
It plays each carrier tone through that laptop's speaker and listens back
through its own mic, then reports the noise floor, an estimated SNR, which
tones (if any) are weak, and a suggested volume. This is the step that
actually tells you whether your specific hardware carries these
near-ultrasonic tones well — nothing before this point can predict that.

## Use it

```
wavebyte                # interactive menu: send / receive / text chat / calibrate
wavebyte send report.pdf
wavebyte receive
wavebyte text
wavebyte --help
```

On the sending laptop: `wavebyte send <file>` (or pick it from the menu).
On the receiving laptop, start first: `wavebyte receive`. Put both laptops
in a quiet room, a foot or two apart.

## Realistic expectations

The protocol logic (modem/FEC/CRC/packet framing) is verified bit-exact
against a simulated channel (`npm test`) — that proves the code is
correct, not that any specific pair of speakers and mics will carry the
signal well in practice. That's what `wavebyte calibrate` is for.

Given a working channel: expect tens of bytes per second, not kilobytes.
A one-page PDF can genuinely take several minutes — that's normal for
acoustic FSK at this reliability target, not a bug. Text messages are
fast. Practical size ceiling is ~2.6 MB (a 16-bit packet-sequence field);
larger files fail outright rather than transferring partially.

If a transfer won't complete at all: re-run `calibrate`, shorten the
distance between laptops, raise `--volume`, and make sure nothing else on
either machine is using the microphone.

## Troubleshooting

Problems actually hit and fixed while building this — if you're on an
older copy of this repo or still see one of these, the fix is described
here:

- **PowerShell window closes itself instantly, no visible error.**
  Older `install.ps1` versions called `exit` on failure, which — when run
  via `irm | iex` — closes your whole session, not just the script. Fixed:
  the installer now uses `return` inside a function instead. Update to the
  current version.
- **`npm : running scripts is disabled on this system`.**
  See Windows step 2 above (`Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`).
- **`sox: Sorry, there is no default audio device configured` (Windows only).**
  A known, long-standing bug in this SoX build's Windows device
  auto-detection (unmaintained upstream since 2015) — not specific to one
  machine. Fixed here by explicitly forcing the `waveaudio` driver on
  Windows instead of relying on `-d` auto-detect. If it still happens on
  your machine, override the device directly:
  ```powershell
  $env:WAVEBYTE_SOX_DEVICE = "-t waveaudio 0"
  wavebyte calibrate
  ```
  and try device index `1`, `2`, etc. if `0` doesn't work.



## License

MIT — see [`LICENSE`](LICENSE).
