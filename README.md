# tether

[![CI](https://github.com/galawaydude/tether/actions/workflows/ci.yml/badge.svg)](https://github.com/galawaydude/tether/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/galawaydude/tether)](https://github.com/galawaydude/tether/releases/latest)
[![License](https://img.shields.io/github/license/galawaydude/tether)](LICENSE)

**Run persistent Claude Code and OpenAI Codex sessions on your machine, then
control them from a phone-friendly browser.**

Sessions run under your OS user in durable tmux processes. Provider credentials
stay with the provider CLI on the host.

## Features

- Conversation-first UI with the real terminal one tap away
- Persistent sessions, transcript history, resume and removal
- Claude Code and Codex conversations, status and folder trust
- Approve or deny supported permission prompts from your phone
- Fast PTY input, image attachments and mobile-friendly controls
- Optional public HTTPS through Tailscale Funnel
- Desktop session rail and bounded history for long-running work

## Security

> **Access to tether is shell access to the host.**

There is one shared password, no read-only mode and no per-person permissions.
Anyone with access can run commands as your OS user inside the allowed roots.
The default installer offers a **public** Funnel URL; viewers need only a browser
and the tether password. Use `--access local` to keep tether on the host.

Read the [security and remote-access guide](docs/security.md) before exposing it.

## Install

Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/galawaydude/tether/main/install.sh | bash
```

The installer shows every system command and service file before asking. It can
set up Tailscale on the host and keep tether running through launchd or systemd.
Nothing is installed on viewing devices.

For loopback-only installation:

```sh
curl -fsSL https://raw.githubusercontent.com/galawaydude/tether/main/install.sh | bash -s -- --access local
```

See [Installation](docs/installation.md) for requirements, upgrades, pinned
versions and uninstall steps.

## First run

If public setup completed, open the HTTPS URL printed by the installer. For a
local installation:

```sh
tether set-password
tether serve
```

Open `http://127.0.0.1:8787`, sign in and create a session.

```sh
tether new ~/src/project
tether ls
tether resume <session-id>
tether access status
```

## Documentation

- [Installation](docs/installation.md)
- [User guide](docs/user-guide.md)
- [Security and remote access](docs/security.md)
- [Contributing, testing, API and releases](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Development

```sh
npm ci
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for all checks and architecture notes.
CI never runs a real provider or uses provider credentials.

## License

[MIT](LICENSE)
