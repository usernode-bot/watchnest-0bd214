(function (root) {
  'use strict';

  const Domain = root.WatchNestDomain;
  const LAST_USER_KEY = 'watchnest:last-user-id';
  const DEVICE_NOTICE_KEY_PREFIX = 'watchnest:device-only-ack:';

  function decodeTokenUserId(token) {
    if (!token) return null;
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(part));
      return claims.id || claims.sub || null;
    } catch {
      return null;
    }
  }

  function rememberedUserId() {
    try { return localStorage.getItem(LAST_USER_KEY); } catch { return null; }
  }

  function rememberUserId(userId) {
    try { localStorage.setItem(LAST_USER_KEY, String(userId)); } catch {}
  }

  function deviceNoticeKey(userId) {
    return `${DEVICE_NOTICE_KEY_PREFIX}${userId}`;
  }

  function deviceNoticeAcknowledged(userId) {
    try { return localStorage.getItem(deviceNoticeKey(userId)) === '1'; } catch { return false; }
  }

  function rememberDeviceNotice(userId) {
    try { localStorage.setItem(deviceNoticeKey(userId), '1'); } catch {}
  }

  function openDatabase(userId) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`watchnest-user-${userId}`, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
    });
  }

  function dbGet(db, key) {
    return new Promise((resolve, reject) => {
      const request = db.transaction('state', 'readonly').objectStore('state').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dbPut(db, key, value) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite');
      transaction.objectStore('state').put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  class WatchNestStore {
    constructor({ token, demo = false, forceStale = false, forceDeviceNotice = false } = {}) {
      this.token = token || '';
      this.demo = Boolean(demo);
      this.forceStale = Boolean(forceStale);
      this.forceDeviceNotice = Boolean(forceDeviceNotice);
      this.userId = this.demo ? 'demo' : (decodeTokenUserId(this.token) || rememberedUserId());
      this.db = null;
      this.state = null;
      this.remoteAhead = this.forceStale;
      this.deviceOnlyNoticeVisible = this.forceDeviceNotice
        || (!this.demo && Boolean(this.userId) && !deviceNoticeAcknowledged(this.userId));
      this.listeners = new Set();
      this.clockQueue = Promise.resolve();
      this.storageAvailable = true;
    }

    headers() {
      return this.token ? { 'x-usernode-token': this.token } : {};
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit() {
      this.listeners.forEach((listener) => listener(this.state));
    }

    dismissDeviceOnlyNotice() {
      this.deviceOnlyNoticeVisible = false;
      if (!this.demo && this.userId) rememberDeviceNotice(this.userId);
      this.emit();
    }

    async initialize() {
      if (!this.userId) throw new Error('Reconnect once to unlock your local WatchNest library');
      if (this.demo) {
        this.state = Domain.createInitialState(this.userId);
        return this.state;
      }
      rememberUserId(this.userId);
      try {
        this.db = await openDatabase(this.userId);
        const stored = await dbGet(this.db, 'app');
        this.state = stored && stored.schemaVersion === Domain.SCHEMA_VERSION
          ? stored : Domain.createInitialState(this.userId);
        await this.persist();
      } catch {
        this.storageAvailable = false;
        throw new Error('This browser blocked durable storage; WatchNest cannot safely save changes');
      }
      return this.state;
    }

    async persist() {
      if (!this.demo && this.db) await dbPut(this.db, 'app', this.state);
    }

    seedDemo(items) {
      if (!this.demo || Object.keys(this.state.library).length) return;
      const picks = [items[0], items[2], items[3], items[6], items[7]].filter(Boolean);
      picks.forEach((media, index) => {
        this.state = Domain.reduce(this.state, { type: 'ADD_MEDIA', media }, Date.now() - (index + 1) * 86400000);
      });
      const first = picks[0] && this.state.library[picks[0].key];
      if (first) {
        first.media.episodes.slice(0, 2).forEach((episode, index) => {
          first.watchedEpisodes[episode.id] = Date.now() - (4 - index) * 86400000;
        });
      }
      const anime = picks.find((media) => media.type === 'anime');
      if (anime) {
        const entry = this.state.library[anime.key];
        entry.favorite = true;
        if (entry.media.episodes[0]) entry.watchedEpisodes[entry.media.episodes[0].id] = Date.now() - 86400000;
      }
      const releasedMovie = picks.find((media) => media.type === 'movie' && Date.parse(media.releaseDate || '') < Date.now());
      if (releasedMovie) {
        const entry = this.state.library[releasedMovie.key];
        entry.watchedAt = Date.now() - 8 * 86400000;
        entry.status = 'completed';
        entry.rating = 4;
      }
      const inactive = picks[1] && this.state.library[picks[1].key];
      if (inactive) inactive.lastActivityAt = Date.now() - 35 * 86400000;
      this.state.meta.pendingClock = false;
      this.emit();
    }

    async checkRemoteClock() {
      if (this.demo) {
        this.remoteAhead = this.forceStale;
        this.emit();
        return;
      }
      if (!this.token || !navigator.onLine) return;
      try {
        const response = await fetch('/api/change-clock', { headers: this.headers() });
        if (!response.ok) return;
        const data = await response.json();
        this.remoteAhead = Domain.setRemoteAhead(this.remoteAhead, data.updatedAt, this.state.meta.localClock);
        this.emit();
        if (this.state.meta.pendingClock) this.queueClock();
      } catch {}
    }

    async dispatch(action) {
      this.state = Domain.reduce(this.state, action);
      await this.persist();
      this.emit();
      this.queueClock();
      return this.state;
    }

    queueClock() {
      if (this.demo) return;
      this.clockQueue = this.clockQueue.then(() => this.pushClock()).catch(() => undefined);
    }

    async pushClock() {
      if (!this.token || !navigator.onLine) return;
      const response = await fetch('/api/change-clock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: '{}',
      });
      if (!response.ok) return;
      const data = await response.json();
      this.state = Domain.acknowledgeClock(this.state, data.updatedAt);
      await this.persist();
      this.emit();
    }

    async exportData() {
      return Domain.exportState(this.state);
    }

    async importData(value) {
      return this.dispatch({ type: 'IMPORT_STATE', value });
    }

    async reset() {
      return this.dispatch({ type: 'RESET' });
    }
  }

  root.WatchNestStore = {
    WatchNestStore,
    decodeTokenUserId,
    deviceNoticeKey,
  };
})(window);
