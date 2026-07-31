# Tailscale fixture

Captured from **tailscale 1.98.10** on 2026-07-31, on a real tailnet with Funnel
enabled, with `tailscale status --json`.

CI must never call the real `tailscale` binary or touch a real tailnet, so
`tailscale.test.ts` drives `funnelHostname` from this file instead. The impure
half — `tailscaleStatus`, which spawns the binary — is not covered here and is
verified by hand; `server/src/machine/tailscale.ts` says why the split is where
it is.

| File                    | What it is                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tailscale-status.json` | One real `tailscale status --json`, from a logged-in node whose tailnet permits Funnel. Both capability shapes are present as they really are: the current `Self.CapMap` and the deprecated `Self.Capabilities` list beside it. |

**Redacted, and it had to be.** This file is published. `Peer` — every other
device on the tailnet — was dropped whole, and the tailnet name, MagicDNS name,
node ID, user, public key and addresses were replaced with the README's own
`my-box.tailnet-1234.ts.net` / `100.101.102.103` examples. Nothing about the
_shape_ was touched: the key names, the nesting, the trailing dot on `DNSName`
and the two capability lists are exactly what the binary printed. The unmet
preconditions are built in the test by removing a field from this file rather
than by capturing four more tailnets, which is the only way three of them could
be captured at all.

## How the capture was made

```sh
tailscale status --json | python3 redact.py > tailscale-status.json
```

To refresh it, re-capture the same way, redact the same fields, and record the
version above.
