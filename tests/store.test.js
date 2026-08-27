'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Domain = require('../public/domain');

function loadStore() {
  const requests = [];
  const window = { WatchNestDomain:Domain };
  const context = vm.createContext({
    window,
    atob,
    navigator:{ onLine:true },
    fetch:async (...args) => { requests.push(args); throw new Error('Unexpected network request'); },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'store.js'), 'utf8'),
    context,
    { filename:'public/store.js' }
  );
  return { api:window.WatchNestStore, requests };
}

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
