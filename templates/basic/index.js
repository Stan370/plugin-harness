'use strict';

/** @type {import('./harness').Plugin} */
module.exports = {
  // Called once when the plugin process starts. `host` gives you config,
  // logging, the workspace path, brokered fetch and secrets.
  activate(host) {
    this.host = host;
    host.log.info('activated with config', host.config);
  },

  tools: {
    // Every tool declared in plugin.json needs a handler with the same name.
    async greet({ name }, ctx) {
      ctx.progress(`preparing a greeting for ${name}…`);
      return `${ctx.host.config.greeting}，${name}！👋`;
    },
  },
};
