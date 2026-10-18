# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | yes       |
| < 0.2   | no        |

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
private vulnerability reporting (Security → Advisories → "Report a
vulnerability") on this repository, or contact the maintainers through the
repository's GitHub profile.

Include:

- affected version / commit;
- DSH version and platform;
- reproduction steps and expected vs. actual behaviour;
- any relevant logs with **secrets removed**.

## Secrets and privacy

- This repository contains **no API keys, cookies, session tokens, account names
  or personal paths**. The test fixtures use obviously fake values.
- Runtime secrets are read from DSH's own credential seam
  (`ctx.credentials.resolve(...)`) inside the Host process and are never sent to
  the Web client, logged, or written to project files.
- The optional Kimi web `refresh_token` is stored with **Windows DPAPI** in
  `%USERPROFILE%\.dsh\dshps\kimi-token.dat` (only the current Windows user can
  decrypt it) or, as a fallback, in DSH's local credential store. It is not part
  of this repository or the plugin configuration. The "Clear" button removes it.
  DPAPI encryption/decryption is performed by fixed `powershell.exe`
  `ConvertTo-SecureString`/`ConvertFrom-SecureString` calls; the token is passed
  to the child process through an environment variable, never interpolated into
  the command line, and no other command is executed.
- Local developer probes under `tools/` mint a browser-session cookie from the
  local DSH credential file or read the local DPAPI token **only on the machine
  that runs them**; they print status/body excerpts, not the secrets. Their
  output may still contain account metadata (plan names, quota numbers); review
  it before pasting into a public issue.

## Scope

In scope: code in this repository (Host half, Web client bundle, bundle patch,
developer tools/tests).

Out of scope: vulnerabilities in DSH itself, vendor quota/balance endpoints, or
issues that require an already-compromised local machine.
