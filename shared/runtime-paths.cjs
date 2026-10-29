'use strict';

const path = require('node:path');
const { RUNTIME_FILE_NAME } = require('./protocol.cjs');

const DEFAULT_RUNTIME_DIR_NAME = '.devpilot';

function resolveRuntimeDir(root, env = process.env) {
  const configured = env.DEVPILOT_RUNTIME_DIR?.trim();
  return configured ? path.resolve(root, configured) : path.join(root, DEFAULT_RUNTIME_DIR_NAME);
}

function runtimeFileFor(root, env = process.env) {
  return path.join(resolveRuntimeDir(root, env), RUNTIME_FILE_NAME);
}

module.exports = {
  DEFAULT_RUNTIME_DIR_NAME,
  resolveRuntimeDir,
  runtimeFileFor,
};
