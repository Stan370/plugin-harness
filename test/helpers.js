'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Fresh, isolated HARNESS_HOME per test file. Must run before requiring src/. */
function freshHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-test-${name}-`));
  process.env.HARNESS_HOME = dir;
  delete process.env.HARNESS_WORKSPACE;
  return dir;
}

const FIXTURES = path.join(__dirname, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 8000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}

module.exports = { freshHome, FIXTURES, sleep, waitFor };
