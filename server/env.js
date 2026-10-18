/*
 * Loads the project-root .env (if present) into process.env, without overriding variables
 * already set in the shell. Uses Node's built-in loader; no dependency.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) process.env[k] = v; // shell wins
}
