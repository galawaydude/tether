# Security

## Access and security

**Treat tether access as shell access.** One shared password authorizes every
session and file under the allowed roots. Set it locally before serving:

```sh
tether set-password
tether serve
```

Security defaults:

- The server binds `127.0.0.1` unless `--host` is supplied.
- An off-loopback `--host` and every `--funnel` refuse to start without a password.
- `--allowed-host` controls accepted `Host` headers.
- `--trusted-proxy` controls which proxies may supply `X-Forwarded-*` headers.
- Session directories must resolve inside your home directory. Widen this with a
  colon-separated list:

  ```sh
  TETHER_ALLOWED_ROOTS=/srv/code:/mnt/work tether serve
  ```

Tether does not terminate TLS. Use Funnel, SSH, a private tailnet or a reverse
proxy. State lives under `~/.local/state/tether` with private permissions; use
`$XDG_STATE_HOME` or `$TETHER_STATE_DIR` to move it. Runtime state is never
written into your repository.

Logs go to stderr at `warn`. Use `TETHER_LOG_LEVEL=info tether serve` for request
logs.

## Reaching it from your phone

### Tailscale Funnel

Funnel is the default because the **host alone** installs Tailscale. Every viewer
uses a normal browser and the tether password—no Tailscale app, account, VPN or
extension.

**Funnel makes tether's login page public.** The URL is not a secret; anyone with
the password has shell-level access. The installer checks the password and port,
shows the exact Funnel command, and asks before publishing.

The installer configures Funnel. Once it is enabled, the server command is:

```sh
tether serve --funnel
```

`--funnel` derives the Tailscale hostname, keeps tether on loopback, allows that
hostname, and trusts only the loopback Funnel proxy. Disable and diagnose it with:

```sh
sudo tailscale funnel --bg off
tether access status
```

The installer can also add a launchd/systemd user service. Funnel itself remains
configured until you turn it off. A new Funnel hostname can take several minutes
to become reachable.

#### Why Funnel is the default

| Option                                                                                                                                                 | Why it is not the default                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) | Cloudflare labels them development/testing only; hostnames are temporary. |
| [Cloudflare Tunnel + Access](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/)                      | Requires a Cloudflare account, managed DNS and `cloudflared`.             |
| [ngrok](https://ngrok.com/docs/gateway/agent-cli-quickstart/)                                                                                          | Requires a host account, agent and token.                                 |
| Caddy or another proxy                                                                                                                                 | Best when you already manage a domain, TLS and ingress.                   |

All remain supported through `--allowed-host` and `--trusted-proxy`.

### Private tailnet

Safer when every viewer is one of your devices, but each viewer must install and
join Tailscale:

```sh
tailscale ip -4
tailscale status --json | grep '"DNSName"'
tether serve --host <tailscale-ip> --allowed-host <tailscale-name>
```

Open `http://<tailscale-name>:8787` from a device in the tailnet. Bind the
Tailscale IP, not `0.0.0.0`.

### SSH tunnel

```sh
ssh -N -L 8787:127.0.0.1:8787 you@box
```

Open `http://localhost:8787`. Tether stays on loopback.

### Reverse proxy

Example Caddy configuration:

```
tether.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```sh
tether serve --allowed-host tether.example.com --trusted-proxy 127.0.0.1
```

Keep tether on loopback and add authentication at the proxy when possible.

## Known risks

**The conversation view is built on file formats that are not public APIs.**
Claude Code writes its transcript to `~/.claude/projects/` and Codex writes its
rollout to `~/.codex/sessions/`. Both ship frequently and owe tether nothing. A
release can change the record shapes, and when it does the conversation view
loses detail — a tool card, a message, at worst the whole view. tether parses
them tolerantly for that reason: an unrecognised record is logged to stderr and
ignored, never thrown.

**The composer's option controls are the same kind of bet.** Each is a slash
command typed at the agent, or — for Claude Code's permission mode — a keystroke
plus a read of the words in the pane's own status line, so an agent that renames
a command or redraws that line can leave a control doing nothing. It can never
leave one lying: permission mode is reported only as the mode that was read back,
and every other control claims nothing at all, so the agent's own reply above the
composer is what says the change landed. Every axis was established against
Claude Code 2.1.220 and codex-cli 0.145.0; setting any of them by hand in the
terminal always works. So is the slash-command list beside them, and what it says
about where a command's answer turns up is a **prediction rather than a
promise**: an agent is free to stop and ask something the table could not foresee
— `/model opus` opens a _Switch model?_ confirmation on a session with a cached
conversation — which is why no note ever claims nothing else will happen, and why
the waiting banner is the correction.

**Folder trust is the same bet, and the one place tether takes it while
_writing_.** Where each agent records a trusted directory is its own business, and
`~/.claude.json` and `~/.codex/config.toml` can change shape in any release. Both
were established against Claude Code 2.1.220 and codex-cli 0.145.0. The
consequences are bounded on purpose: a file tether cannot make sense of gets no
checkbox and no write, a write it will not make refuses the session outright
rather than starting one on a promise it did not keep, and an existing file is
copied into tether's state directory before it is touched. What a stale reader
costs you is the question moving back into the terminal, where it has always been
answerable.

**The terminal view depends on none of it.** It is the real TUI over tmux, it is
always correct, and it is a complete fallback. If the conversation ever looks
wrong or empty after a provider upgrade, that is the failure to expect, summoning
the terminal is the answer, and the session itself was never at risk.
