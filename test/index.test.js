import assert from "node:assert/strict";
import test from "node:test";

import Plugin, * as rootExports from "../index.js";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

async function withFetch(handler, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;

  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("root exports only opencode-compatible plugin functions", () => {
  assert.deepEqual(Object.keys(rootExports).sort(), ["Plugin", "default"]);
  assert.equal(rootExports.default, Plugin);
  assert.equal(typeof rootExports.Plugin, "function");
  assert.equal(rootExports.internals, undefined);
});

test("discovers models through fetch and updates empty config", async () => {
  await withFetch(
    async (url) => {
      assert.equal(url, "http://localhost:1234/api/v1/models");
      return jsonResponse({
        models: [
          {
            key: "local-model",
            type: "llm",
            loaded_instances: [{ config: { context_length: 8192 } }],
            capabilities: { vision: true, reasoning: true },
          },
          { key: "embedding-model", type: "embeddings", max_context_length: 512 },
        ],
      });
    },
    async () => {
      const hooks = await Plugin({}, { ports: [1234], timeout: 100 });
      const config = {};

      await hooks.config(config);

      assert.deepEqual(config.provider.lmstudio.models["local-model"], {
        limit: { input: 8192, output: 8192, context: 8192 },
        modalities: { input: ["text", "image"], output: ["text"] },
        reasoning: true,
        variants: {
          reasoning: { reasoningEffort: "high" },
          "no-reasoning": { reasoningEffort: "none" },
        },
        interleaved: { field: "reasoning_content" },
      });
      assert.equal(config.provider.lmstudio.models["embedding-model"], undefined);
    },
  );
});

test("preserves existing user model metadata", async () => {
  await withFetch(
    async () =>
      jsonResponse({
        models: [
          {
            key: "local-model",
            type: "llm",
            max_context_length: 8192,
            capabilities: { vision: true, reasoning: true },
          },
        ],
      }),
    async () => {
      const hooks = await Plugin({}, { ports: [1234] });
      const config = {
        provider: {
          lmstudio: {
            models: {
              "local-model": {
                limit: { input: 1024, output: 256, context: 1024 },
                modalities: { input: ["text"], output: ["text"] },
                reasoning: false,
                variants: { custom: { reasoningEffort: "low" } },
                interleaved: { field: "custom_reasoning" },
              },
            },
          },
        },
      };

      await hooks.config(config);

      assert.deepEqual(config.provider.lmstudio.models["local-model"], {
        limit: { input: 1024, output: 256, context: 1024 },
        modalities: { input: ["text"], output: ["text"] },
        reasoning: false,
        variants: { custom: { reasoningEffort: "low" } },
        interleaved: { field: "custom_reasoning" },
      });
    },
  );
});

test("supports OpenAI-compatible data response shape", async () => {
  await withFetch(
    async () =>
      jsonResponse({
        data: [{ id: "data-model", max_context_length: 4096, capabilities: { reasoning: true } }],
      }),
    async () => {
      const hooks = await Plugin({}, { ports: [1234] });
      const config = {};

      await hooks.config(config);

      assert.equal(config.provider.lmstudio.models["data-model"].limit.context, 4096);
      assert.equal(config.provider.lmstudio.models["data-model"].reasoning, true);
    },
  );
});

test("rejects dangerous model ids", async () => {
  await withFetch(
    async () =>
      jsonResponse({
        models: [
          { key: "__proto__", type: "llm", max_context_length: 9999 },
          { key: "constructor", type: "llm", max_context_length: 9999 },
          { key: "safe-model", type: "llm", max_context_length: 2048 },
          { id: 1234, type: "llm", max_context_length: 9999 },
        ],
      }),
    async () => {
      const hooks = await Plugin({}, { ports: [1234] });
      const config = {};

      await hooks.config(config);

      assert.equal(Object.hasOwn(config.provider.lmstudio.models, "safe-model"), true);
      assert.equal(Object.hasOwn(config.provider.lmstudio.models, "__proto__"), false);
      assert.equal(Object.hasOwn(config.provider.lmstudio.models, "constructor"), false);
      assert.equal({}.polluted, undefined);
    },
  );
});

test("rejects dangerous provider ids without prototype pollution", async () => {
  const errors = [];

  await withFetch(
    async () => jsonResponse({ models: [{ key: "safe-model", type: "llm", max_context_length: 2048 }] }),
    async () => {
      const originalError = console.error;
      console.error = (message) => errors.push(message);
      try {
        const hooks = await Plugin({}, { providerId: "__proto__", ports: [1234], debug: true });
        const config = {};

        await hooks.config(config);

        assert.deepEqual(config, {});
        assert.equal({}.models, undefined);
        assert.equal({}.polluted, undefined);
        assert.match(errors.join("\n"), /providerId is not safe/);
      } finally {
        console.error = originalError;
      }
    },
  );
});

test("rejects non-string and malformed provider ids", async () => {
  await withFetch(
    async () => jsonResponse({ models: [{ key: "safe-model", type: "llm", max_context_length: 2048 }] }),
    async () => {
      for (const providerId of [1234, "   ", "bad\0id", "constructor", "toString"]) {
        const hooks = await Plugin({}, { providerId, ports: [1234] });
        const config = {};

        await hooks.config(config);

        assert.deepEqual(config, {});
      }
    },
  );
});

test("does not resolve inherited provider containers", async () => {
  const inheritedProvider = { models: { inherited: {} } };
  const config = { provider: Object.create({ lmstudio: inheritedProvider }) };

  await withFetch(
    async () => jsonResponse({ models: [{ key: "safe-model", type: "llm", max_context_length: 2048 }] }),
    async () => {
      const hooks = await Plugin({}, { providerId: "lmstudio", ports: [1234] });

      await hooks.config(config);

      assert.notEqual(config.provider.lmstudio, inheritedProvider);
      assert.equal(Object.hasOwn(config.provider, "lmstudio"), true);
      assert.equal(Object.hasOwn(config.provider.lmstudio.models, "safe-model"), true);
      assert.equal(Object.hasOwn(inheritedProvider.models, "safe-model"), false);
    },
  );
});

test("malformed host does not crash config hook", async () => {
  const errors = [];

  await withFetch(
    async () => {
      throw new Error("fetch should not be called");
    },
    async () => {
      const originalError = console.error;
      console.error = (message) => errors.push(message);
      try {
        const hooks = await Plugin({}, { host: "http://[", ports: [1234], debug: true });
        const config = {};

        await hooks.config(config);

        assert.deepEqual(config, {});
        assert.match(errors.join("\n"), /invalid host/);
      } finally {
        console.error = originalError;
      }
    },
  );
});

test("malformed loaded_instances does not crash context detection", async () => {
  await withFetch(
    async () =>
      jsonResponse({
        models: [{ key: "local-model", type: "llm", loaded_instances: { bad: true }, max_context_length: 4096 }],
      }),
    async () => {
      const hooks = await Plugin({}, { ports: [1234] });
      const config = {};

      await hooks.config(config);

      assert.equal(config.provider.lmstudio.models["local-model"].limit.context, 4096);
    },
  );
});

test("debug logging redacts URL credentials", async () => {
  const errors = [];

  await withFetch(
    async (url) => {
      throw new Error(`failed ${url}`);
    },
    async () => {
      const originalError = console.error;
      console.error = (message) => errors.push(message);
      try {
        const hooks = await Plugin({}, { host: "http://user:secret@localhost", ports: [1234], debug: true });
        const config = {};

        await hooks.config(config);

        const output = errors.join("\n");
        assert.doesNotMatch(output, /user:secret/);
        assert.match(output, /REDACTED:REDACTED@localhost/);
      } finally {
        console.error = originalError;
      }
    },
  );
});

test("continues probing ports until an LLM model is found", async () => {
  const urls = [];

  await withFetch(
    async (url) => {
      urls.push(url);
      if (url.includes(":1234/")) return jsonResponse({ models: [{ key: "embedding-model", type: "embeddings" }] });
      return jsonResponse({ models: [{ key: "llm-model", type: "llm", max_context_length: 4096 }] });
    },
    async () => {
      const hooks = await Plugin({}, { ports: [1234, 4321] });
      const config = {};

      await hooks.config(config);

      assert.deepEqual(urls, ["http://localhost:1234/api/v1/models", "http://localhost:4321/api/v1/models"]);
      assert.equal(config.provider.lmstudio.models["llm-model"].limit.context, 4096);
      assert.equal(config.provider.lmstudio.models["embedding-model"], undefined);
    },
  );
});

test("skips malformed config containers instead of crashing", async () => {
  const errors = [];

  await withFetch(
    async () => jsonResponse({ models: [{ key: "local-model", type: "llm", max_context_length: 4096 }] }),
    async () => {
      const originalError = console.error;
      console.error = (message) => errors.push(message);
      try {
        const hooks = await Plugin({}, { ports: [1234], debug: true });
        const config = { provider: [] };

        await hooks.config(config);

        assert.deepEqual(config, { provider: [] });
        assert.match(errors.join("\n"), /config\.provider is not an object/);
      } finally {
        console.error = originalError;
      }
    },
  );
});

test("plugin no-ops when LM Studio is unavailable", async () => {
  await withFetch(
    async () => {
      throw new Error("offline");
    },
    async () => {
      const hooks = await Plugin({}, { ports: [1234], timeout: 1 });
      const config = {};

      await hooks.config(config);

      assert.deepEqual(config, {});
    },
  );
});

test("remote hosts require explicit opt in", async () => {
  await withFetch(
    async () => {
      throw new Error("fetch should not be called");
    },
    async () => {
      const hooks = await Plugin({}, { host: "http://192.0.2.1", ports: [1234] });
      const config = {};

      await hooks.config(config);

      assert.deepEqual(config, {});
    },
  );
});
