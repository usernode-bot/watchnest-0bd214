'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Domain = require('../public/domain');

const now = Date.parse('2026-08-26T12:00:00Z');

function show() {
  return {
    key: 'tvmaze:1', id: '1', source: 'tvmaze', type: 'show', title: 'Test Show',
    runtime: 40, status: 'Running', genres: ['Drama'], synopsis: '',
    episodes: [
      { id:'e1', season:1, number:1, title:'One', airstamp:'2026-08-01T20:00:00Z', runtime:40 },
      { id:'e2', season:1, number:2, title:'Two', airstamp:'2026-08-08T20:00:00Z', runtime:42 },
      { id:'e3', season:1, number:3, title:'Three', airstamp:'2026-08-27T20:00:00Z', runtime:41 },
    ],
  };
}

function movie() {
  return { key:'wikidata:Q1', id:'Q1', source:'wikidata', type:'movie', title:'Test Movie', runtime:120, releaseDate:'2026-08-30', episodes:[] };
}

test('every local mutation advances revision and schedules a backend clock notification', () => {
  const initial = Domain.createInitialState('7');
  const added = Domain.reduce(initial, { type:'ADD_MEDIA', media:show() }, now);
  assert.equal(added.meta.revision, 1);
  assert.equal(added.meta.localClock, now);
  assert.equal(added.meta.pendingClock, true);
  assert.deepEqual(initial.library, {});

  const watched = Domain.reduce(added, { type:'TOGGLE_EPISODE', key:'tvmaze:1', episodeId:'e1' }, now + 1);
  assert.equal(watched.meta.revision, 2);
  assert.equal(watched.meta.pendingClock, true);
  assert.equal(watched.library['tvmaze:1'].watchedEpisodes.e1, now + 1);
});

test('next episode, mark-through, progress, and caught-up selection follow episode order', () => {
  let state = Domain.reduce(Domain.createInitialState('7'), { type:'ADD_MEDIA', media:show() }, now);
  let entry = state.library['tvmaze:1'];
  assert.equal(Domain.getNextEpisode(entry, now).id, 'e1');

  state = Domain.reduce(state, { type:'MARK_THROUGH', key:'tvmaze:1', episodeId:'e2' }, now + 2);
  entry = state.library['tvmaze:1'];
  assert.equal(entry.watchedEpisodes.e1, now + 2);
  assert.equal(entry.watchedEpisodes.e2, now + 2);
  assert.equal(Domain.getNextEpisode(entry, now), null);
  assert.deepEqual(Domain.progressFor(entry, now), { watched:2, total:2, percent:100 });
  assert.equal(Domain.getNextUpcomingEpisode(entry, now).id, 'e3');
});

test('whole-season watched and unwatched actions are reversible', () => {
  let state = Domain.reduce(Domain.createInitialState('7'), { type:'ADD_MEDIA', media:show() }, now);
  state = Domain.reduce(state, { type:'SET_SEASON_WATCHED', key:'tvmaze:1', season:1, watched:true }, now + 1);
  assert.equal(Object.keys(state.library['tvmaze:1'].watchedEpisodes).length, 3);
  state = Domain.reduce(state, { type:'SET_SEASON_WATCHED', key:'tvmaze:1', season:1, watched:false }, now + 2);
  assert.equal(Object.keys(state.library['tvmaze:1'].watchedEpisodes).length, 0);
});

test('upcoming groups episodic and movie releases without backend data', () => {
  let state = Domain.reduce(Domain.createInitialState('7'), { type:'ADD_MEDIA', media:show() }, now);
  state = Domain.reduce(state, { type:'ADD_MEDIA', media:movie() }, now + 1);
  const groups = Domain.selectUpcoming(state, now);
  const upcoming = Object.values(groups).flat();
  assert.equal(upcoming.find((item) => item.episode?.id === 'e3').episode.id, 'e3');
  assert.equal(upcoming.find((item) => item.entry.media.key === 'wikidata:Q1').entry.media.key, 'wikidata:Q1');
});

test('stats derive from local episode and movie watch events', () => {
  let state = Domain.reduce(Domain.createInitialState('7'), { type:'ADD_MEDIA', media:show() }, now);
  state = Domain.reduce(state, { type:'TOGGLE_EPISODE', key:'tvmaze:1', episodeId:'e1' }, now + 1);
  state = Domain.reduce(state, { type:'ADD_MEDIA', media:movie() }, now + 2);
  state = Domain.reduce(state, { type:'TOGGLE_MOVIE_WATCHED', key:'wikidata:Q1' }, now + 3);
  assert.deepEqual(Domain.calculateStats(state), {
    episodes:1, movies:1, minutes:160, hours:2.7, titles:2, favorites:0,
    recent:[
      { at:now + 3, title:'Test Movie', type:'movie' },
      { at:now + 1, title:'Test Show', type:'show' },
    ],
  });
});

test('remote-ahead state remains sticky after this device later advances', () => {
  assert.equal(Domain.setRemoteAhead(false, 200, 100), true);
  assert.equal(Domain.setRemoteAhead(true, 200, 300), true);
  assert.equal(Domain.setRemoteAhead(false, 100, 100), false);
});

test('clock acknowledgement clears only the durable pending marker', () => {
  const state = Domain.reduce(Domain.createInitialState('7'), { type:'ADD_MEDIA', media:show() }, now);
  const acknowledged = Domain.acknowledgeClock(state, now + 500);
  assert.equal(acknowledged.meta.pendingClock, false);
  assert.equal(acknowledged.meta.localClock, now + 500);
  assert.equal(acknowledged.meta.revision, state.meta.revision);
  assert.equal(Object.keys(acknowledged.library).length, 1);
});

test('import validates account ownership before replacing current local data', () => {
  let state = Domain.reduce(Domain.createInitialState('7'), { type:'ADD_MEDIA', media:show() }, now);
  const foreign = { ...Domain.exportState(state), userId:'8' };
  assert.throws(() => Domain.reduce(state, { type:'IMPORT_STATE', value:foreign }, now + 1), /different Usernode account/);
  assert.equal(Object.keys(state.library).length, 1);

  const own = Domain.exportState(state);
  const imported = Domain.reduce(Domain.createInitialState('7'), { type:'IMPORT_STATE', value:own }, now + 2);
  assert.equal(imported.library['tvmaze:1'].media.title, 'Test Show');
  assert.equal(imported.meta.pendingClock, true);
});

test('guest import accepts an explicit export from any account into the guest namespace', () => {
  let signed = Domain.reduce(Domain.createInitialState('7'), { type:'ADD_MEDIA', media:show() }, now);
  const imported = Domain.reduce(
    Domain.createInitialState('guest'),
    { type:'IMPORT_STATE', value:Domain.exportState(signed) },
    now + 1
  );
  assert.equal(imported.userId, 'guest');
  assert.equal(imported.library['tvmaze:1'].media.title, 'Test Show');
});
