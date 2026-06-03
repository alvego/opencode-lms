# Contributing

## Prerequisites

- Node.js recent enough to include the built-in `node:test` runner.
- npm.

## Validation

Run these checks before opening a PR or publishing a release:

```sh
node --check index.js
node --check internal.js
npm test
npm pack --dry-run
```

## Implementation Notes

- This package is ESM-only and has no build step.
- The public plugin entry is `index.js`.
- Helper logic lives in `internal.js`.
- Tests live in `test/index.test.js` and use Node's built-in `node:test` runner.
- The plugin discovers LM Studio models through `/api/v1/models` and conservatively fills missing opencode provider metadata instead of overwriting user-defined model settings.
- Security hardening is intentionally conservative: unsafe provider/model keys are rejected, remote hosts require explicit opt-in, debug URL credentials are redacted, and malformed payloads should not crash opencode startup.

## Release Checklist

- Update `package.json` with the new version before publishing.
- Run the validation commands above.
- Commit documentation and code changes.
- Push to the public GitHub branch, normally `main`. Confirm the local branch and upstream before pushing because local branch names may differ.
- Publish with `npm publish --access public`.
- npm publishing requires account or token authentication with the appropriate two-factor authentication or bypass policy.
- Never print, commit, or paste npm tokens. Rotate any token that may have been exposed.
