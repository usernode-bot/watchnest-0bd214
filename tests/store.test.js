'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Domain = require('../public/domain');

function tokenFor(id) {
  const payload = Buffer.from(JSON.stringify({ id })).toString('base64url');
  return `header.${payload}.signature`;
}

function loadStore(values = new Map()) {
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  const requests = [];
  const window = { WatchNestDomain:Domain };
  const context = vm.createContext({
    window,
    localStorage,
    atob,
    navigator:{ onLine:true },
    fetch:async (...args) => { requests.push(args); throw new Error('Unexpected network request'); },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'store.js'), 'utf8'),
    context,
    { filename:'public/store.js' }
  );
  return { api:window.WatchNestStore, values, requests };
}

test('device-only notice acknowledgement is local and namespaced by user', () => {
  const { api, values } = loadStore();
  const first = new api.WatchNestStore({ token:tokenFor(7) });
  first.state = Domain.createInitialState('7');
  const before = JSON.stringify(first.state);

  assert.equal(first.deviceOnlyNoticeVisible, true);
  first.dismissDeviceOnlyNotice();
  assert.equal(first.deviceOnlyNoticeVisible, false);
  assert.equal(JSON.stringify(first.state), before);
  assert.equal(first.state.meta.pendingClock, false);
  assert.equal(values.get(api.deviceNoticeKey(7)), '1');

  assert.equal(new api.WatchNestStore({ token:tokenFor(7) }).deviceOnlyNoticeVisible, false);
  assert.equal(new api.WatchNestStore({ token:tokenFor(8) }).deviceOnlyNoticeVisible, true);
});

test('demo notice is shown only when the deterministic route forces it', () => {
  const { api } = loadStore();
  assert.equal(new api.WatchNestStore({ demo:true }).deviceOnlyNoticeVisible, false);
  assert.equal(new api.WatchNestStore({ demo:true, forceDeviceNotice:true }).deviceOnlyNoticeVisible, true);
});

test('guest mode keeps mutations local and never calls the account clock', async () => {
  const { api, requests } = loadStore();
  const guest = new api.WatchNestStore();
  guest.state = Domain.createInitialState(api.GUEST_USER_ID);
  guest.persist = async () => {};

  assert.equal(guest.isGuest, true);
  assert.equal(guest.userId, 'guest');
  await guest.dispatch({ type:'ADD_MEDIA', media:{
    id:'1', source:'tvmaze', type:'show', title:'Guest Show', episodes:[],
  } });
  await guest.checkRemoteClock();
  await guest.pushClock();

  assert.equal(guest.state.library['tvmaze:1'].media.title, 'Guest Show');
  assert.equal(guest.state.meta.pendingClock, false);
  assert.equal(guest.remoteAhead, false);
  assert.deepEqual(requests, []);
});
