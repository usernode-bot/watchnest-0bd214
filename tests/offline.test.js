'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('service worker precaches the shell and never handles API requests', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(source, /'\/index\.html'/);
  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(source, /request\.method !== 'GET'/);
  const shellBlock = source.slice(source.indexOf('const SHELL'), source.indexOf('];', source.indexOf('const SHELL')));
  assert.doesNotMatch(shellBlock, /\/api\//);
});

test('proposal manifest covers every major screen and the stale-device warning', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const paths = manifest.tests.map((entry) => entry.path).join('\n');
  for (const screen of ['home', 'discover', 'library', 'upcoming', 'profile']) assert.match(paths, new RegExp(`screen=${screen}`));
  assert.match(paths, /stale=1/);
  assert.ok(manifest.tests.every((entry) => entry.expectSelector));
});
