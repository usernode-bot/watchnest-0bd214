'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, initializeSchema } = require('../server');

function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql:String(sql), params:params || [] });
      return handler ? handler(String(sql), params || []) : { rows:[] };
    },
  };
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const signedIn = { authenticate(req) { req.user = { id:7, username:'not-stored' }; } };

test('change-clock GET returns zero without inserting a user row', async () => {
  const pool = fakePool(() => ({ rows:[] }));
  await withServer(createApp({ pool, auth:signedIn }), async (base) => {
    const response = await fetch(`${base}/api/change-clock`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { updatedAt:0 });
  });
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /^SELECT updated_at_ms/);
  assert.deepEqual(pool.calls[0].params, [7]);
});

test('change-clock POST advances monotonically with user id as its only parameter', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /GREATEST/);
    return { rows:[{ updated_at_ms:'1777203000001' }] };
  });
  await withServer(createApp({ pool, auth:signedIn }), async (base) => {
    const response = await fetch(`${base}/api/change-clock`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:'{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { updatedAt:1777203000001 });
  });
  assert.deepEqual(pool.calls[0].params, [7]);
  assert.equal(pool.calls[0].params.length, 1);
});

test('change-clock rejects media or preference payloads before touching Postgres', async () => {
  const pool = fakePool();
  await withServer(createApp({ pool, auth:signedIn }), async (base) => {
    const response = await fetch(`${base}/api/change-clock`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ mediaId:'secret-title' }),
    });
    assert.equal(response.status, 400);
  });
  assert.equal(pool.calls.length, 0);
});

test('API authentication remains deny-by-default', async () => {
  const pool = fakePool();
  await withServer(createApp({ pool, auth:{ publicKey:'', audience:null } }), async (base) => {
    const response = await fetch(`${base}/api/change-clock`);
    assert.equal(response.status, 401);
  });
  assert.equal(pool.calls.length, 0);
});

test('anonymous users can load the shell and GET catalogs but not the account clock or writes', async () => {
  const pool = fakePool();
  const fakeFetch = async () => ({
    ok:true,
    async json() {
      return [{ show:{ id:42, name:'Guest Example', premiered:'2026-01-01', genres:[], summary:'', image:null, rating:{} } }];
    },
  });
  await withServer(createApp({ pool, auth:{ publicKey:'', audience:null }, fetchImpl:fakeFetch }), async (base) => {
    let response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /WatchNest/);

    response = await fetch(`${base}/api/catalog/search?kind=show&q=guest`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items[0].title, 'Guest Example');

    response = await fetch(`${base}/api/change-clock`);
    assert.equal(response.status, 401);
    response = await fetch(`${base}/api/catalog/search`, { method:'POST' });
    assert.equal(response.status, 401);
  });
  assert.equal(pool.calls.length, 0);
});

test('catalog validates inputs and never writes catalog data to Postgres', async () => {
  const pool = fakePool();
  const fakeFetch = async () => ({
    ok:true,
    async json() {
      return [{ show:{ id:42, name:'Example', premiered:'2026-01-01', genres:['Drama'], summary:'<b>Safe</b>', image:null, rating:{ average:8 } } }];
    },
  });
  await withServer(createApp({ pool, auth:signedIn, fetchImpl:fakeFetch }), async (base) => {
    let response = await fetch(`${base}/api/catalog/search?kind=bad&q=test`);
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/catalog/search?kind=show&q=x`);
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/catalog/search?kind=show&q=example`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items[0].key, 'tvmaze:42');
    assert.equal(body.items[0].synopsis, 'Safe');
  });
  assert.equal(pool.calls.length, 0);
});

test('schema removes the starter table and creates only the private numeric clock table', async () => {
  const pool = fakePool();
  await initializeSchema(pool);
  assert.equal(pool.calls.length, 3);
  assert.match(pool.calls[0].sql, /DROP TABLE IF EXISTS presses/);
  assert.match(pool.calls[1].sql, /CREATE TABLE IF NOT EXISTS user_change_clock/);
  assert.doesNotMatch(pool.calls[1].sql, /username|media|episode|rating|device/i);
  assert.match(pool.calls[2].sql, /staging:private/);
});
