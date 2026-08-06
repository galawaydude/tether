# Security policy

## Supported versions

Security fixes are made for the latest release only. Upgrade by re-running the
installer.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/galawaydude/remote-control-agent/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability.

Include the affected version, impact, reproduction steps and any suggested
mitigation. Never include real provider credentials, Remote Control Agent passwords,
transcripts or private source code.

## Security model

Access to Remote Control Agent is equivalent to shell access as the host OS user. The shared
password is the authorization boundary; Remote Control Agent has no read-only or per-person
role. See [Security and remote access](docs/security.md) for deployment guidance
and known risks.
