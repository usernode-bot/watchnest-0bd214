(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WatchNestDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const LIBRARY_STATUSES = new Set(['watching', 'watch-later', 'completed', 'archived']);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createInitialState(userId) {
    return {
      schemaVersion: SCHEMA_VERSION,
      userId: String(userId),
      library: {},
      preferences: {
        discoverType: 'all',
        libraryType: 'all',
        libraryStatus: 'all',
        libraryView: 'list',
      },
      meta: {
        revision: 0,
        localClock: 0,
        pendingClock: false,
        lastMutationAt: 0,
      },
    };
  }

  function cleanMedia(media) {
    if (!media || typeof media !== 'object') throw new Error('Media is required');
    const type = ['show', 'anime', 'movie'].includes(media.type) ? media.type : null;
    const source = String(media.source || '').slice(0, 24);
    const id = String(media.id || '').slice(0, 64);
    if (!type || !source || !id) throw new Error('Invalid media identity');
    const key = `${source}:${id}`;
    return {
      key,
      id,
      source,
      type,
      title: String(media.title || 'Untitled').slice(0, 180),
      year: Number(media.year) || null,
      status: media.status ? String(media.status).slice(0, 60) : null,
      genres: Array.isArray(media.genres) ? media.genres.map((v) => String(v).slice(0, 50)).slice(0, 10) : [],
      runtime: Number(media.runtime) || null,
      synopsis: String(media.synopsis || '').slice(0, 3000),
      image: typeof media.image === 'string' ? media.image.slice(0, 1000) : null,
      thumb: typeof media.thumb === 'string' ? media.thumb.slice(0, 1000) : null,
      rating: Number(media.rating) || null,
      releaseDate: media.releaseDate ? String(media.releaseDate).slice(0, 40) : null,
      episodes: Array.isArray(media.episodes) ? media.episodes.map(cleanEpisode).slice(0, 2000) : [],
      updatedAt: Number(media.updatedAt) || Date.now(),
    };
  }

  function cleanEpisode(episode) {
    return {
      id: String(episode.id || '').slice(0, 100),
      sourceId: String(episode.sourceId || episode.id || '').slice(0, 100),
      season: Math.max(0, Number(episode.season) || 0),
      number: Math.max(0, Number(episode.number) || 0),
      title: String(episode.title || `Episode ${Number(episode.number) || '?'}`).slice(0, 180),
      airdate: episode.airdate ? String(episode.airdate).slice(0, 10) : null,
      airstamp: episode.airstamp ? String(episode.airstamp).slice(0, 40) : null,
      runtime: Number(episode.runtime) || null,
      synopsis: String(episode.synopsis || '').slice(0, 1800),
    };
  }

  function createEntry(media, now) {
    const clean = cleanMedia(media);
    return {
      media: clean,
      status: clean.type === 'movie' ? 'watch-later' : 'watching',
      addedAt: now,
      lastActivityAt: now,
      watchedEpisodes: {},
      watchedAt: null,
      favorite: false,
      rating: null,
    };
  }

  function markMutation(state, now) {
    state.meta.revision = (Number(state.meta.revision) || 0) + 1;
    state.meta.localClock = Math.max(Number(state.meta.localClock) + 1 || 1, now);
    state.meta.pendingClock = true;
    state.meta.lastMutationAt = now;
    return state;
  }

  function requireEntry(state, key) {
    const entry = state.library[key];
    if (!entry) throw new Error('Title is not in the library');
    return entry;
  }

  function reduce(input, action, at) {
    const state = clone(input);
    const now = Number(at) || Date.now();
    const type = action && action.type;
    let changed = false;

    if (type === 'ADD_MEDIA') {
      const media = cleanMedia(action.media);
      if (!state.library[media.key]) state.library[media.key] = createEntry(media, now);
      else state.library[media.key].media = media;
      changed = true;
    } else if (type === 'UPDATE_MEDIA') {
      const media = cleanMedia(action.media);
      const entry = requireEntry(state, media.key);
      entry.media = media;
      changed = true;
    } else if (type === 'REMOVE_MEDIA') {
      if (state.library[action.key]) {
        delete state.library[action.key];
        changed = true;
      }
    } else if (type === 'SET_STATUS') {
      if (!LIBRARY_STATUSES.has(action.status)) throw new Error('Invalid library status');
      const entry = requireEntry(state, action.key);
      entry.status = action.status;
      entry.lastActivityAt = now;
      changed = true;
    } else if (type === 'TOGGLE_EPISODE') {
      const entry = requireEntry(state, action.key);
      const episodeId = String(action.episodeId || '');
      if (!entry.media.episodes.some((episode) => episode.id === episodeId)) throw new Error('Unknown episode');
      if (entry.watchedEpisodes[episodeId]) delete entry.watchedEpisodes[episodeId];
      else entry.watchedEpisodes[episodeId] = now;
      entry.lastActivityAt = now;
      changed = true;
    } else if (type === 'MARK_THROUGH') {
      const entry = requireEntry(state, action.key);
      const targetIndex = sortedEpisodes(entry.media).findIndex((episode) => episode.id === action.episodeId);
      if (targetIndex < 0) throw new Error('Unknown episode');
      sortedEpisodes(entry.media).slice(0, targetIndex + 1).forEach((episode) => {
        entry.watchedEpisodes[episode.id] = entry.watchedEpisodes[episode.id] || now;
      });
      entry.lastActivityAt = now;
      changed = true;
    } else if (type === 'SET_SEASON_WATCHED') {
      const entry = requireEntry(state, action.key);
      const season = Number(action.season);
      entry.media.episodes.filter((episode) => episode.season === season).forEach((episode) => {
        if (action.watched) entry.watchedEpisodes[episode.id] = entry.watchedEpisodes[episode.id] || now;
        else delete entry.watchedEpisodes[episode.id];
      });
      entry.lastActivityAt = now;
      changed = true;
    } else if (type === 'TOGGLE_MOVIE_WATCHED') {
      const entry = requireEntry(state, action.key);
      if (entry.media.type !== 'movie') throw new Error('Not a movie');
      entry.watchedAt = entry.watchedAt ? null : now;
      entry.status = entry.watchedAt ? 'completed' : 'watch-later';
      entry.lastActivityAt = now;
      changed = true;
    } else if (type === 'TOGGLE_FAVORITE') {
      const entry = requireEntry(state, action.key);
      entry.favorite = !entry.favorite;
      entry.lastActivityAt = now;
      changed = true;
    } else if (type === 'SET_RATING') {
      const entry = requireEntry(state, action.key);
      const rating = Number(action.rating);
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error('Invalid rating');
      entry.rating = rating || null;
      entry.lastActivityAt = now;
      changed = true;
    } else if (type === 'SET_PREFERENCE') {
      if (!Object.prototype.hasOwnProperty.call(state.preferences, action.key)) throw new Error('Invalid preference');
      state.preferences[action.key] = String(action.value).slice(0, 40);
      changed = true;
    } else if (type === 'IMPORT_STATE') {
      const imported = validateImport(action.value, state.userId);
      state.library = imported.library;
      state.preferences = imported.preferences;
      changed = true;
    } else if (type === 'RESET') {
      const empty = createInitialState(state.userId);
      state.library = empty.library;
      state.preferences = empty.preferences;
      changed = true;
    } else {
      throw new Error(`Unknown action: ${type}`);
    }

    return changed ? markMutation(state, now) : state;
  }

  function acknowledgeClock(input, updatedAt) {
    const state = clone(input);
    state.meta.localClock = Math.max(Number(state.meta.localClock) || 0, Number(updatedAt) || 0);
    state.meta.pendingClock = false;
    return state;
  }

  function sortedEpisodes(media) {
    return (media.episodes || []).slice().sort((a, b) =>
      a.season - b.season || a.number - b.number || String(a.id).localeCompare(String(b.id))
    );
  }

  function episodeTime(episode) {
    const value = episode.airstamp || (episode.airdate ? `${episode.airdate}T23:59:59` : '');
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function isAired(episode, now = Date.now()) {
    const when = episodeTime(episode);
    return when == null || when <= now;
  }

  function getNextEpisode(entry, now = Date.now()) {
    return sortedEpisodes(entry.media).find((episode) =>
      isAired(episode, now) && !entry.watchedEpisodes[episode.id]
    ) || null;
  }

  function getNextUpcomingEpisode(entry, now = Date.now()) {
    return sortedEpisodes(entry.media).find((episode) => {
      const when = episodeTime(episode);
      return when != null && when > now;
    }) || null;
  }

  function progressFor(entry, now = Date.now()) {
    if (entry.media.type === 'movie') return { watched: entry.watchedAt ? 1 : 0, total: 1, percent: entry.watchedAt ? 100 : 0 };
    const aired = sortedEpisodes(entry.media).filter((episode) => isAired(episode, now));
    const watched = aired.filter((episode) => entry.watchedEpisodes[episode.id]).length;
    return { watched, total: aired.length, percent: aired.length ? Math.round((watched / aired.length) * 100) : 0 };
  }

  function selectWatchNext(state, now = Date.now()) {
    return Object.values(state.library)
      .filter((entry) => entry.media.type !== 'movie' && entry.status === 'watching')
      .map((entry) => ({ entry, episode: getNextEpisode(entry, now) }))
      .filter((item) => item.episode)
      .sort((a, b) => Number(b.entry.lastActivityAt) - Number(a.entry.lastActivityAt));
  }

  function selectInactive(state, now = Date.now()) {
    const cutoff = now - 21 * 86400000;
    return Object.values(state.library)
      .filter((entry) => entry.status === 'watching' && Number(entry.lastActivityAt) < cutoff)
      .sort((a, b) => Number(a.lastActivityAt) - Number(b.lastActivityAt));
  }

  function groupLabel(timestamp, now) {
    const date = new Date(timestamp);
    const today = new Date(now);
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const distance = Math.floor((day - startToday) / 86400000);
    if (distance === 0) return 'Today';
    if (distance === 1) return 'Tomorrow';
    if (distance <= 7) return 'This week';
    return 'Later';
  }

  function selectUpcoming(state, now = Date.now()) {
    const groups = { Today: [], Tomorrow: [], 'This week': [], Later: [] };
    Object.values(state.library).forEach((entry) => {
      if (entry.status === 'archived') return;
      if (entry.media.type === 'movie') {
        const when = Date.parse(entry.media.releaseDate || '');
        if (Number.isFinite(when) && when > now) groups[groupLabel(when, now)].push({ entry, episode: null, when });
        return;
      }
      sortedEpisodes(entry.media).forEach((episode) => {
        const when = episodeTime(episode);
        if (when != null && when > now) groups[groupLabel(when, now)].push({ entry, episode, when });
      });
    });
    Object.values(groups).forEach((items) => items.sort((a, b) => a.when - b.when));
    return groups;
  }

  function calculateStats(state) {
    let episodes = 0;
    let movies = 0;
    let minutes = 0;
    const completed = [];
    Object.values(state.library).forEach((entry) => {
      if (entry.media.type === 'movie') {
        if (entry.watchedAt) {
          movies += 1;
          minutes += Number(entry.media.runtime) || 110;
          completed.push({ at: entry.watchedAt, title: entry.media.title, type: 'movie' });
        }
        return;
      }
      Object.entries(entry.watchedEpisodes).forEach(([episodeId, at]) => {
        episodes += 1;
        const episode = entry.media.episodes.find((item) => item.id === episodeId);
        minutes += Number(episode?.runtime || entry.media.runtime) || (entry.media.type === 'anime' ? 24 : 45);
        completed.push({ at, title: entry.media.title, type: entry.media.type });
      });
    });
    completed.sort((a, b) => Number(b.at) - Number(a.at));
    return {
      episodes,
      movies,
      minutes,
      hours: Math.round((minutes / 60) * 10) / 10,
      titles: Object.keys(state.library).length,
      favorites: Object.values(state.library).filter((entry) => entry.favorite).length,
      recent: completed.slice(0, 12),
    };
  }

  function setRemoteAhead(current, backendClock, localClock) {
    return Boolean(current) || Number(backendClock) > Number(localClock);
  }

  function validateImport(value, currentUserId) {
    if (!value || typeof value !== 'object' || value.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported WatchNest export');
    if (String(value.userId) !== String(currentUserId)) throw new Error('This export belongs to a different Usernode account');
    if (!value.library || typeof value.library !== 'object' || Array.isArray(value.library)) throw new Error('Invalid library data');
    const clean = createInitialState(currentUserId);
    const entries = Object.values(value.library);
    if (entries.length > 5000) throw new Error('Export is too large');
    entries.forEach((raw) => {
      const media = cleanMedia(raw.media);
      const entry = createEntry(media, Number(raw.addedAt) || Date.now());
      entry.status = LIBRARY_STATUSES.has(raw.status) ? raw.status : entry.status;
      entry.lastActivityAt = Number(raw.lastActivityAt) || entry.addedAt;
      entry.watchedAt = Number(raw.watchedAt) || null;
      entry.favorite = Boolean(raw.favorite);
      entry.rating = Number.isInteger(Number(raw.rating)) && Number(raw.rating) >= 1 && Number(raw.rating) <= 5 ? Number(raw.rating) : null;
      entry.watchedEpisodes = {};
      const known = new Set(media.episodes.map((episode) => episode.id));
      Object.entries(raw.watchedEpisodes || {}).slice(0, 10000).forEach(([id, watchedAt]) => {
        if (known.has(id) && Number(watchedAt) > 0) entry.watchedEpisodes[id] = Number(watchedAt);
      });
      clean.library[media.key] = entry;
    });
    if (value.preferences && typeof value.preferences === 'object') {
      Object.keys(clean.preferences).forEach((key) => {
        if (typeof value.preferences[key] === 'string') clean.preferences[key] = value.preferences[key].slice(0, 40);
      });
    }
    return clean;
  }

  function exportState(state) {
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      userId: String(state.userId),
      library: clone(state.library),
      preferences: clone(state.preferences),
    };
  }

  return {
    SCHEMA_VERSION,
    acknowledgeClock,
    calculateStats,
    cleanMedia,
    createInitialState,
    exportState,
    getNextEpisode,
    getNextUpcomingEpisode,
    isAired,
    progressFor,
    reduce,
    selectInactive,
    selectUpcoming,
    selectWatchNext,
    setRemoteAhead,
    sortedEpisodes,
    validateImport,
  };
});
