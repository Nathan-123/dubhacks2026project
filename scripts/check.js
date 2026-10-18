#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/** Lightweight source guards for direct accesses; not a JavaScript linter or typechecker. */
function architectureErrors(file, source) {
  const errors = [];
  if (/^(extension|server)\//.test(file) && /\.\s*_internal\b|\[\s*['"]_internal['"]\s*\]/.test(source)) {
    errors.push(`${file}: production must not access extractor diagnostics (_internal)`);
  }
  if (file === 'extension/lib/classification.js' && /\b(window|document|chrome|navigator|fetch|XMLHttpRequest|WebSocket|require|importScripts|import)\b/.test(source)) {
    errors.push(`${file}: classification must stay independent of browser, network and imported modules`);
  }
  return errors;
}

function javascriptFiles(directory) {
  return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return javascriptFiles(file);
    return entry.isFile() && entry.name.endsWith('.js') ? [file] : [];
  });
}

function check() {
  const errors = [];
  for (const file of ['extension', 'server', 'scripts', 'probe', 'test'].flatMap(javascriptFiles)) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    try { new vm.Script(source, { filename: file }); }
    catch (error) { errors.push(`${file}: ${error.message}`); }
    errors.push(...architectureErrors(file, source));
  }
  for (const error of errors) console.error(error);
  const probe = spawnSync(process.execPath, [path.join(__dirname, 'build-probe.js'), '--check'], { cwd: ROOT, stdio: 'inherit' });
  if (probe.error) console.error(probe.error.message);
  if (errors.length || probe.status !== 0) process.exitCode = 1;
  else console.log('JavaScript syntax and architecture source guards pass');
}

if (require.main === module) check();
module.exports = { architectureErrors };
