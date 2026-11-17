'use strict';
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
  HOST_VERSION: require(path.join(ROOT, 'package.json')).version,
  // Bumped only on breaking changes to the host <-> plugin protocol.
  API_VERSION: 1,
  ROOT,
  RUNTIME_DIR: path.join(ROOT, 'src', 'runtime'),
  MANIFEST_FILE: 'plugin.json',

  HOOK_EVENTS: {
    'chat.userMessage': '用户消息进入 Agent 之前，可改写 text 或阻止',
    'tool.beforeCall': '工具调用之前，可改写 input 或阻止',
    'tool.afterCall': '工具返回之后，可改写 result',
  },

  LIMITS: {
    activationTimeoutMs: 5000,
    defaultToolTimeoutMs: 15000,
    maxToolTimeoutMs: 120000,
    defaultHookTimeoutMs: 3000,
    providerTimeoutMs: 180000,
    maxMemoryMb: 256,
    defaultMemoryMb: 128,
    maxResultChars: 20000,
    maxFetchBytes: 2 * 1024 * 1024,
    maxMessageBytes: 4 * 1024 * 1024,
    crashWindowMs: 60000,
    maxCrashesInWindow: 3,
    maxConsecutiveTimeouts: 2,
    agentMaxSteps: 8,
  },
};
