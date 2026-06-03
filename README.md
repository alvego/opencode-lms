# opencode-lms

An [opencode](https://opencode.ai/) plugin that discovers locally served [LM Studio](https://lmstudio.ai/) models and updates the `lmstudio` provider metadata.

Published npm package: [`opencode-lms`](https://www.npmjs.com/package/opencode-lms)

The plugin calls LM Studio's `/api/v1/models` endpoint, filters LLM models, and fills in model context limits, modalities, and reasoning metadata where LM Studio exposes it.

## Requirements

- Node.js 18 or newer.
- opencode with plugin support.
- LM Studio running locally with the server/API enabled.

## Installation

Use the published npm package through your opencode plugin configuration. You do not need to manually install it globally.

Add the package name to your opencode config:

```jsonc
{
  "plugin": ["opencode-lms"]
}
```

## Configuration

Full config example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-lms"]
}
```

With options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-lms", { "ports": [1234], "debug": true }]
  ]
}
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `host` | `"localhost"` | LM Studio host. `http://` is added when omitted. |
| `ports` | `[1234]` | Ports to probe for the LM Studio API. |
| `timeout` | `750` | Fetch timeout in milliseconds per port. |
| `providerId` | `"lmstudio"` | opencode provider id to update. |
| `debug` | `false` | Print discovery failures and results to stderr. Debug logs can include endpoint and error details. |
| `allowRemoteHost` | `false` | Allow probing a non-local LM Studio host when `host` is intentionally set to a remote endpoint. |

If LM Studio is not running or no LLM models are returned, the plugin exits without changing provider metadata and does not fail opencode startup.

By default, the plugin only probes local LM Studio hosts such as `localhost` and `127.0.0.1`. Remote hosts are possible only when you intentionally set `host` and `allowRemoteHost: true`.

## What It Adds

For each LM Studio model with `type: "llm"`, the plugin may add:

- `limit.input`, `limit.output`, and `limit.context` from `loaded_instances[].config.context_length` or `max_context_length`.
- `modalities.input` with `image` when LM Studio reports vision support.
- Reasoning metadata and `reasoning_content` interleaving when LM Studio reports reasoning support.

Existing user-defined model metadata is preserved. The plugin fills missing fields only; it does not overwrite existing `limit`, `modalities`, `reasoning`, `variants`, or `interleaved` values.

## Development

```sh
npm test
npm pack --dry-run
```

This package is ESM-only and has no build step.

## License

MIT
