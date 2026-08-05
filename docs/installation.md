# Installation

## Requirements

- Linux or macOS
- Node at the version in [`.nvmrc`](../.nvmrc)
- tmux 3.7 or newer
- A C++ toolchain on Linux
- Tailscale on the host only when using the public Funnel link

The installer can build tmux and install Linux prerequisites through apt, dnf,
yum, zypper, pacman or apk. On macOS it uses Homebrew for tmux and offers
Tailscale's signed Standalone package.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/galawaydude/tether/main/install.sh | bash
```

To inspect it first:

```sh
curl -fsSL https://raw.githubusercontent.com/galawaydude/tether/main/install.sh -o install.sh
less install.sh
bash install.sh
```

The default flow offers a public Tailscale Funnel link and a launchd/systemd user
service. Every system command and service file is shown before consent. Declining
leaves tether available on loopback.

```sh
bash install.sh --access local             # no Tailscale or public link
bash install.sh --yes                      # accept displayed changes
TETHER_VERSION=v0.3.0 bash install.sh      # install one release
```

The installer puts the checkout under `~/.local/share/tether`, links the command
at `~/.local/bin/tether`, and stores runtime state under
`~/.local/state/tether`. `--dir` changes the checkout location.

## First run

If the installer completed public setup, open the HTTPS URL it printed. For a
local installation:

```sh
tether set-password
tether serve
```

Open `http://127.0.0.1:8787`.

## Upgrade

Re-run the installer. It installs the highest `vX.Y.Z` release tag. Set
`TETHER_VERSION` to install another tag or branch deliberately.

## Uninstall

Stop the service for your platform, turn off Funnel if enabled, and remove the
installation:

```sh
# Linux service
systemctl --user disable --now tether.service
rm -f ~/.config/systemd/user/tether.service
systemctl --user daemon-reload

# macOS service
launchctl bootout gui/$UID/dev.tether.server
rm -f ~/Library/LaunchAgents/dev.tether.server.plist

# Public access and tether data
sudo tailscale funnel --bg off
rm -f ~/.local/bin/tether
rm -rf ~/.local/share/tether
rm -rf ~/.local/state/tether
```

The state directory contains the password hash, session registry, attachments,
hooks and logs. Project hook and trust entries remain in provider-owned
configuration files that you chose to modify.
