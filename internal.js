const DEFAULT_OPTIONS = {
  host: "localhost",
  ports: [1234],
  timeout: 750,
  providerId: "lmstudio",
  debug: false,
  allowRemoteHost: false,
};

const DANGEROUS_OBJECT_KEYS = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeOptions(options = {}) {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  const ports = Array.isArray(merged.ports) ? merged.ports : [merged.ports];

  return {
    host: normalizeHost(merged.host),
    ports: [...new Set(ports.map(normalizePort).filter((port) => port !== null))],
    timeout: normalizeTimeout(merged.timeout),
    providerId: merged.providerId ?? DEFAULT_OPTIONS.providerId,
    debug: Boolean(merged.debug),
    allowRemoteHost: Boolean(merged.allowRemoteHost),
  };
}

function normalizeHost(host) {
  const value = String(host || DEFAULT_OPTIONS.host).trim().replace(/\/+$/, "");
  if (!value) return `http://${DEFAULT_OPTIONS.host}`;
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function normalizePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) return null;
  return value;
}

function normalizeTimeout(timeout) {
  const value = Number(timeout);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_OPTIONS.timeout;
}

export function modelUrl(host, port) {
  const url = new URL(host);
  if (port) url.port = String(port);
  url.pathname = "/api/v1/models";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function safeObjectKey(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || DANGEROUS_OBJECT_KEYS.has(trimmed)) return null;

  return trimmed;
}

function safeModelId(model) {
  return safeObjectKey(model.key ?? model.id);
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "REDACTED";
      parsed.password = "REDACTED";
    }
    return parsed.toString();
  } catch {
    return redactText(String(url));
  }
}

function redactText(text) {
  return String(text).replace(/(https?:\/\/)([^\s/@]+(?::[^\s/@]*)?@)/gi, "$1REDACTED:REDACTED@");
}

function isLocalHost(host) {
  const hostname = new URL(host).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function timeoutSignal(timeout) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(timeout), cleanup: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

async function fetchJson(url, timeout) {
  const { signal, cleanup } = timeoutSignal(timeout);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    cleanup();
  }
}

export function extractLlmModels(payload) {
  const rawModels = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];

  return rawModels.filter((model) => {
    if (!isPlainObject(model) || !safeModelId(model)) return false;
    if (model.type === undefined || model.type === null || model.type === "") return true;
    return String(model.type).toLowerCase() === "llm";
  });
}

function getContextLength(model) {
  const loadedInstances = Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
  const loadedContext = loadedInstances
    .map((instance) => instance?.config?.context_length)
    .find((value) => Number.isFinite(value) && value > 0);

  return loadedContext ?? model.max_context_length ?? null;
}

export function applyModelMetadata(config, providerId, models, log = () => {}) {
  if (!models.length) return;

  const safeProviderId = safeObjectKey(providerId);
  if (!safeProviderId) {
    log("skipped config update: providerId is not safe for object indexing");
    return;
  }

  if (config.provider == null) config.provider = {};
  if (!isPlainObject(config.provider)) {
    log("skipped config update: config.provider is not an object");
    return;
  }

  if (!Object.hasOwn(config.provider, safeProviderId) || config.provider[safeProviderId] == null) {
    config.provider[safeProviderId] = {};
  }
  if (!isPlainObject(config.provider[safeProviderId])) {
    log(`skipped config update: config.provider.${safeProviderId} is not an object`);
    return;
  }

  const provider = config.provider[safeProviderId];
  if (provider.models == null) provider.models = {};
  if (!isPlainObject(provider.models)) {
    log(`skipped config update: config.provider.${safeProviderId}.models is not an object`);
    return;
  }

  for (const model of models) {
    const id = safeModelId(model);
    if (!id) continue;

    if (!Object.hasOwn(provider.models, id) || provider.models[id] == null) provider.models[id] = {};
    if (!isPlainObject(provider.models[id])) {
      log(`skipped model ${id}: existing model metadata is not an object`);
      continue;
    }

    const target = provider.models[id];
    const context = getContextLength(model);
    if (target.limit === undefined && context && context > 0) {
      target.limit = { input: context, output: context, context };
    }

    const capabilities = model.capabilities;
    if (!isPlainObject(capabilities)) continue;

    if (target.modalities === undefined) {
      const inputModalities = ["text"];
      if (capabilities.vision) inputModalities.push("image");
      target.modalities = {
        input: inputModalities,
        output: ["text"],
      };
    }

    if (capabilities.reasoning) {
      if (target.reasoning === undefined) target.reasoning = true;
      if (target.variants === undefined) {
        target.variants = {
          reasoning: { reasoningEffort: "high" },
          "no-reasoning": { reasoningEffort: "none" },
        };
      }
      if (target.interleaved === undefined) target.interleaved = { field: "reasoning_content" };
    }
  }
}

export async function discoverModels(options, log) {
  try {
    new URL(options.host);
  } catch (error) {
    log(`skipped LM Studio discovery: invalid host ${redactText(options.host)} (${redactText(error.message)})`);
    return [];
  }

  if (!options.allowRemoteHost && !isLocalHost(options.host)) {
    log(`skipped remote LM Studio host ${redactUrl(options.host)}; set allowRemoteHost: true to enable it`);
    return [];
  }

  const ports = options.ports.length ? options.ports : [null];

  for (const port of ports) {
    let url;
    try {
      url = modelUrl(options.host, port);
    } catch (error) {
      log(`skipped LM Studio discovery: invalid endpoint (${redactText(error.message)})`);
      continue;
    }

    try {
      const data = await fetchJson(url, options.timeout);
      const models = extractLlmModels(data);
      log(`discovered ${models.length} LLM model(s) at ${redactUrl(url)}`);
      if (models.length) return models;
    } catch (error) {
      log(`failed to fetch ${redactUrl(url)}: ${redactText(error.message)}`);
    }
  }

  return [];
}
