# Copilot instructions

See [AGENTS.md](../AGENTS.md) for the full project rules.

Short version:

- This is a DSH bundle: one root Host row (`dshp-collection`) + one shared
  `./client` bundle + Host-only subpath plugins (`dshps/plugins/dshp-*`).
- Never add secrets, personal paths, account data or screenshots with real
  balances. Test fixtures must be obviously fake. Run `npm run hygiene`.
- Preserve `package.json` exports and `cordis.patch.yml` row names — they are
  install identities in DSH profiles.
- Keep zh/en UI strings in sync; vendor order follows Settings → Models.
- Run `npm run check && npm run hygiene && npm test` before proposing changes.
  Host tests need `npm run setup:test-deps` with `DSH_ASAR` pointing at a local
  DSH `app.asar`.
