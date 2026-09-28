# WaveByte

Send files and text between two laptops using **sound** — their built-in
speakers and microphones, near-ultrasonic (18–19.8 kHz), with FEC, CRC32,
ARQ retransmission, and end-to-end SHA-256 verification. No Wi-Fi, no
Bluetooth, no LAN, no internet, no pairing, no server.

This is the terminal edition. There is no web page and nothing to host —
the earlier browser build needed a page to be *loaded* over the internet
(GitHub Pages, etc.) before it could work, which defeats the point of an
offline link. The CLI needs the internet exactly once, to install itself.

## Install

Requires [Node.js](https://nodejs.org) 18+ already installed. Paste the line for your OS:

**macOS / Linux**
```
curl -fsSL https://raw.githubusercontent.com/nishil-26/WaveByte/main/install/install.sh | bash
```

**Windows (PowerShell)**
```
irm https://raw.githubusercontent.com/nishil-26/WaveByte/main/install/install.ps1 | iex
```

> Like any `curl | bash` installer, feel free to open the script first and
> read it before running it.

Each script installs [`sox`](http://sox.sourceforge.net/) (a small,
long-standing command-line audio tool — WaveByte uses it to talk to your
speakers/mic, since Node has no built-in audio I/O) via your OS's normal
package manager, then installs the `wavebyte` command globally via npm,
straight from this GitHub repo.

**After that one-time install, run `wavebyte` on both laptops. Nothing
either of them does from then on touches a network, Wi-Fi, Bluetooth, or
the internet — only sound.**


## License

MIT — see [`LICENSE`](LICENSE).
