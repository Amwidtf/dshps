# Contributing

Thanks for your interest in `dshps`.

## Ground rules

- **Never commit secrets**: no API keys, cookies, session tokens, Kimi `refresh_token`,
  account names, emails or personal absolute paths. Test fixtures must use obviously
  fake values (e.g. `sk-test-…`, `fake-token`).
- Keep the bundle structure: one root Host row (`dshp-collection`) + one shared Web
  client bundle (`./client`) + subpath Host plugins (`dshps/plugins/dshp-*`).
- Do not reorder or rename existing `exports` entries; DSH profile patch rows refer to them.
- UI text should stay concise and bilingual (zh/en locale dictionaries in `client.js`,
  `locale/*.json` for plugin metadata).

## Development setup

```bash
# Host tests need @deepseek-ai/schemastery, extracted from a local DSH install.
DSH_ASAR=/path/to/Harness/resources/app.asar npm run setup:test-deps
npm run check
npm run docs:check
npm test
```

`tools/test-host.mjs` runs the Host half against offline fixtures; `tools/test-client.mjs`
renders the client bundle with a minimal React/VM harness. Both must pass before a PR.

## Documentation

- Stack-level behaviour goes in the root `README.md` / `README.en.md`.
- Plugin-specific behaviour goes in `plugins/dshp-*/README.md` (and `README.en.md`).
- Add the plugin to the root README table when you add it.
- Keep zh/en docs in sync; `npm run docs:check` verifies relative links and anchors.

## Pull requests

1. Describe the user-visible change and the providers/endpoints involved.
2. Include tests for new provider parsing, storage or UI behaviour.
3. Update the root README plugin table and the plugin README when behaviour changes.
4. Confirm `npm run check`, `npm run docs:check` and `npm test` pass.
5. Keep commits focused; avoid unrelated formatting churn.

For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
