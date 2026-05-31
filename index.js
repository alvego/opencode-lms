import { applyModelMetadata, discoverModels, normalizeOptions } from "./internal.js";

export const Plugin = async (_input = {}, pluginOptions = {}) => {
  const options = normalizeOptions(pluginOptions);
  const log = options.debug ? (message) => console.error(`[opencode-lms] ${message}`) : () => {};
  let cachedModels = [];

  async function refresh() {
    cachedModels = await discoverModels(options, log);
  }

  return {
    config: async (config) => {
      await refresh();
      applyModelMetadata(config, options.providerId, cachedModels, log);
    },

    "session.created": async () => {
      if (!cachedModels.length) await refresh();
    },
  };
};

export default Plugin;
