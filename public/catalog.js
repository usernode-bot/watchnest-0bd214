(function (root) {
  'use strict';

  const dayMs = 86400000;

  function isoDate(offsetDays) {
    const value = new Date(Date.now() + Number(offsetDays || 0) * dayMs);
    return value.toISOString().slice(0, 10);
  }

  function materialize(item) {
    return {
      ...item,
      releaseDate: item.releaseOffsetDays == null ? (item.releaseDate || null) : isoDate(item.releaseOffsetDays),
      episodes: (item.episodes || []).map((episode) => ({
        ...episode,
        airdate: episode.offsetDays == null ? (episode.airdate || null) : isoDate(episode.offsetDays),
        airstamp: episode.offsetDays == null ? (episode.airstamp || null) : `${isoDate(episode.offsetDays)}T20:00:00Z`,
      })),
      updatedAt: Date.now(),
    };
  }

  class CatalogClient {
    constructor({ token, demo = false } = {}) {
      this.token = token || '';
      this.demo = Boolean(demo);
      this.fallback = [];
    }

    headers() {
      return this.token ? { 'x-usernode-token': this.token } : {};
    }

    async initialize() {
      try {
        const response = await fetch('/fallback-catalog.json', { cache: 'no-cache' });
        const data = await response.json();
        this.fallback = (Array.isArray(data.items) ? data.items : []).map(materialize);
      } catch {
        this.fallback = [];
      }
      return this.fallback;
    }

    async api(path) {
      const response = await fetch(path, { headers: this.headers() });
      if (!response.ok) throw new Error('Catalog unavailable');
      return response.json();
    }

    fallbackFor(type = 'all') {
      return this.fallback.filter((item) => type === 'all' || item.type === type);
    }

    async discover() {
      if (this.demo) return this.fallback.slice();
      const calls = ['show', 'anime'].map(async (kind) => {
        try {
          const data = await this.api(`/api/catalog/discover?kind=${kind}`);
          return Array.isArray(data.items) ? data.items : [];
        } catch {
          return [];
        }
      });
      const remote = (await Promise.all(calls)).flat();
      const merged = new Map(this.fallback.map((item) => [item.key, item]));
      remote.forEach((item) => merged.set(item.key, item));
      return Array.from(merged.values());
    }

    async search(query, type = 'all') {
      const clean = String(query || '').trim().slice(0, 80);
      const local = this.fallback.filter((item) => {
        const matchesType = type === 'all' || item.type === type;
        const haystack = `${item.title} ${(item.genres || []).join(' ')} ${item.synopsis || ''}`.toLowerCase();
        return matchesType && haystack.includes(clean.toLowerCase());
      });
      if (clean.length < 2 || this.demo) return local;
      const kinds = type === 'all' ? ['show', 'anime', 'movie'] : [type];
      const calls = kinds.map(async (kind) => {
        try {
          const data = await this.api(`/api/catalog/search?kind=${kind}&q=${encodeURIComponent(clean)}`);
          return Array.isArray(data.items) ? data.items : [];
        } catch {
          return [];
        }
      });
      const merged = new Map(local.map((item) => [item.key, item]));
      (await Promise.all(calls)).flat().forEach((item) => merged.set(item.key, item));
      return Array.from(merged.values());
    }

    async episodes(media) {
      if (Array.isArray(media.episodes) && media.episodes.length) return media;
      if (media.type === 'movie' || !['tvmaze', 'jikan'].includes(media.source) || this.demo) return media;
      try {
        const data = await this.api(`/api/catalog/episodes?source=${encodeURIComponent(media.source)}&id=${encodeURIComponent(media.id)}`);
        return { ...media, episodes: Array.isArray(data.episodes) ? data.episodes : [], updatedAt: Date.now() };
      } catch {
        return media;
      }
    }

    find(key) {
      return this.fallback.find((item) => item.key === key) || null;
    }
  }

  root.WatchNestCatalog = { CatalogClient };
})(window);
