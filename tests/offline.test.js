'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('service worker precaches the shell and never handles API requests', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(source, /'\/index\.html'/);
  assert.match(source, /watchnest-shell-v6/);
  assert.doesNotMatch(source, /caches\.match\(request\)\.then\(\(cached\) => cached \|\| fetch/);
  assert.match(source, /fetch\(request\).*\.catch\(\(\) => caches\.match\(request\)/s);
  assert.match(source, /request\.mode === 'navigate'[\s\S]*fetch\(request\)\.catch\(\(\) => caches\.match\('\/index\.html'\)\)/);
  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(source, /request\.method !== 'GET'/);
  const shellBlock = source.slice(source.indexOf('const SHELL'), source.indexOf('];', source.indexOf('const SHELL')));
  assert.doesNotMatch(shellBlock, /\/api\//);
});

test('the boot asset bypasses an obsolete worker and upgrades controlled pages', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /app\.js\?v=20260827-6/);
  assert.match(html, /serviceWorker\.addEventListener\('controllerchange'/);
  assert.match(app, /register\('\/sw\.js\?v=20260827-6'\)/);
});

test('proposal manifest covers every major screen and the stale-device warning', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const paths = manifest.tests.map((entry) => entry.path).join('\n');
  for (const screen of ['home', 'discover', 'library', 'upcoming', 'profile']) assert.match(paths, new RegExp(`screen=${screen}`));
  assert.match(paths, /stale=1/);
  assert.match(paths, /guest=1/);
  assert.ok(manifest.tests.every((entry) => entry.expectSelector));
});

test('guest mode is explicit and only newer-device detection is unavailable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /params\.get\('guest'\) === '1'/);
  assert.match(source, /Only newer-device detection requires an account/);
  assert.match(source, /Unavailable without an account/);
});
test('the add action saves locally before waiting for episode hydration', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('async function addMedia');
  const end = source.indexOf('async function chooseStatus', start);
  const addMedia = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(addMedia.indexOf("store.dispatch({ type:'ADD_MEDIA', media })") < addMedia.indexOf('hydrateAddedMedia(media)'));
  assert.match(addMedia, /void hydrateAddedMedia\(media\)\.catch/);
});

test('search-only catalog results participate in action identity lookup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function findMedia');
  const end = source.indexOf('async function openDetail', start);
  const findMedia = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(findMedia, /ui\.searchResults\.find\(\(item\) => item\.key === key\)/);
});

test('typing refreshes only search results and rejects stale responses', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf("document.addEventListener('input'");
  const end = source.indexOf("importEl.addEventListener('change'", start);
  const inputHandler = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(inputHandler, /\brender\(\)/);
  assert.match(inputHandler, /refreshDiscoverResults\(\)/);
  assert.match(inputHandler, /ui\.query !== query \|\| ui\.discoverType !== type/);
});
