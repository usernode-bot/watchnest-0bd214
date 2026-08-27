'use strict';

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const PUBLIC_GET_PATHS = new Set([
  '/health',
  '/api/catalog/discover',
  '/api/catalog/search',
  '/api/catalog/episodes',
]);
const CATALOG_TYPES = new Set(['show', 'anime', 'movie']);
const CATALOG_SOURCES = new Set(['tvmaze', 'jikan']);

function text(value, max = 5000) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

function httpsImage(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function normalizeTvmaze(show) {
  const premiered = text(show.premiered, 10) || null;
  return {
    key: `tvmaze:${show.id}`,
    id: String(show.id),
    source: 'tvmaze',
    type: 'show',
    title: text(show.name, 160) || 'Untitled show',
    year: premiered ? Number(premiered.slice(0, 4)) || null : null,
    status: text(show.status, 40) || null,
    genres: Array.isArray(show.genres) ? show.genres.map((v) => text(v, 40)).filter(Boolean).slice(0, 8) : [],
    runtime: Number(show.averageRuntime || show.runtime) || null,
    synopsis: text(show.summary, 2400),
    image: httpsImage(show.image?.original || show.image?.medium),
    thumb: httpsImage(show.image?.medium || show.image?.original),
    rating: Number(show.rating?.average) || null,
    updatedAt: Date.now(),
  };
}

function normalizeJikan(anime) {
  const year = Number(anime.year || String(anime.aired?.from || '').slice(0, 4)) || null;
  return {
    key: `jikan:${anime.mal_id}`,
    id: String(anime.mal_id),
    source: 'jikan',
    type: 'anime',
    title: text(anime.title_english || anime.title, 160) || 'Untitled anime',
    year,
    status: text(anime.status, 60) || null,
    genres: Array.isArray(anime.genres) ? anime.genres.map((g) => text(g?.name, 40)).filter(Boolean).slice(0, 8) : [],
    runtime: Number(String(anime.duration || '').match(/\d+/)?.[0]) || 24,
    synopsis: text(anime.synopsis, 2400),
    image: httpsImage(anime.images?.webp?.large_image_url || anime.images?.jpg?.large_image_url),
    thumb: httpsImage(anime.images?.webp?.image_url || anime.images?.jpg?.image_url),
    rating: Number(anime.score) || null,
    episodeCount: Number(anime.episodes) || null,
    premiered: text(anime.aired?.from, 32) || null,
    updatedAt: Date.now(),
  };
}

function normalizeWikidata(entity) {
  const description = text(entity.description, 500);
  const yearMatch = description.match(/\b(18|19|20)\d{2}\b/);
  return {
    key: `wikidata:${text(entity.id, 32)}`,
    id: text(entity.id, 32),
    source: 'wikidata',
    type: 'movie',
    title: text(entity.label, 160) || 'Untitled movie',
    year: yearMatch ? Number(yearMatch[0]) : null,
    status: 'Released',
    genres: [],
    runtime: null,
    synopsis: description,
    image: null,
    thumb: null,
    rating: null,
    updatedAt: Date.now(),
  };
}

function normalizeTvmazeEpisode(episode) {
  return {
    id: `tvmaze:${episode.id}`,
    sourceId: String(episode.id),
    season: Number(episode.season) || 0,
    number: Number(episode.number) || 0,
    title: text(episode.name, 180) || `Episode ${Number(episode.number) || '?'}`,
    airdate: text(episode.airdate, 10) || null,
    airstamp: text(episode.airstamp, 40) || null,
    runtime: Number(episode.runtime) || null,
    synopsis: text(episode.summary, 1600),
  };
}

function normalizeJikanEpisode(episode, runtime) {
  return {
    id: `jikan:${episode.mal_id}`,
    sourceId: String(episode.mal_id),
    season: 1,
    number: Number(episode.mal_id) || 0,
    title: text(episode.title, 180) || `Episode ${Number(episode.mal_id) || '?'}`,
    airdate: text(episode.aired, 10) || null,
    airstamp: text(episode.aired, 40) || null,
    runtime: Number(runtime) || 24,
    synopsis: '',
  };
}

async function upstreamJson(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'WatchNest/1.0 (Usernode)',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`Catalog provider returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function createAuthMiddleware({ publicKey, audience, authenticate } = {}) {
  const jwtPublicKey = (publicKey ?? process.env.USERNODE_JWT_PUBLIC_KEY ?? '').replace(/\\n/g, '\n');
  const appAudience = audience ?? (process.env.USERNODE_APP_ID ? `usernode:app:${process.env.USERNODE_APP_ID}` : null);

  return (req, res, next) => {
    if (typeof authenticate === 'function') authenticate(req);
    if (!req.user) {
      const token = req.query.token || req.headers['x-usernode-token'];
      if (token && jwtPublicKey && appAudience) {
        try {
          const claims = jwt.verify(token, jwtPublicKey, {
            algorithms: ['RS256'],
            issuer: 'usernode',
            audience: appAudience,
          });
          if (claims && claims.pur === 'iframe') req.user = claims;
        } catch {}
      }
    }

    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      if (req.method === 'GET' && PUBLIC_GET_PATHS.has(req.path)) return next();
      if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
  };
}

function createApp({ pool, fetchImpl = global.fetch, auth = {} } = {}) {
  if (!pool) throw new Error('A database pool is required');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(createAuthMiddleware(auth));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  app.get('/api/change-clock', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT updated_at_ms FROM user_change_clock WHERE user_id = $1',
        [req.user.id]
      );
      res.json({ updatedAt: Number(rows[0]?.updated_at_ms) || 0 });
    } catch {
      res.status(500).json({ error: 'Could not read the change clock' });
    }
  });

  app.post('/api/change-clock', async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
      return res.status(400).json({ error: 'This endpoint accepts no user data' });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO user_change_clock (user_id, updated_at_ms)
         VALUES ($1, FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
         ON CONFLICT (user_id) DO UPDATE SET
           updated_at_ms = GREATEST(
             user_change_clock.updated_at_ms + 1,
             FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
           )
         RETURNING updated_at_ms`,
        [req.user.id]
      );
      res.json({ updatedAt: Number(rows[0].updated_at_ms) });
    } catch {
      res.status(500).json({ error: 'Could not advance the change clock' });
    }
  });

  app.get('/api/catalog/discover', async (req, res) => {
    const kind = text(req.query.kind, 16);
    if (!CATALOG_TYPES.has(kind)) return res.status(400).json({ error: 'Invalid media type' });
    if (kind === 'movie') return res.json({ items: [] });
    try {
      if (kind === 'show') {
        const date = new Date().toISOString().slice(0, 10);
        const data = await upstreamJson(fetchImpl, `https://api.tvmaze.com/schedule?country=US&date=${date}`);
        const seen = new Set();
        const items = (Array.isArray(data) ? data : [])
          .map((entry) => entry.show)
          .filter((show) => show && !seen.has(show.id) && seen.add(show.id))
          .slice(0, 18)
          .map(normalizeTvmaze);
        return res.json({ items });
      }
      const data = await upstreamJson(fetchImpl, 'https://api.jikan.moe/v4/top/anime?filter=airing&limit=18&sfw=true');
      return res.json({ items: (Array.isArray(data.data) ? data.data : []).map(normalizeJikan) });
    } catch {
      return res.status(502).json({ error: 'Catalog provider is temporarily unavailable' });
    }
  });

  app.get('/api/catalog/search', async (req, res) => {
    const kind = text(req.query.kind, 16);
    const query = text(req.query.q, 80);
    if (!CATALOG_TYPES.has(kind)) return res.status(400).json({ error: 'Invalid media type' });
    if (query.length < 2) return res.status(400).json({ error: 'Search needs at least 2 characters' });
    try {
      if (kind === 'show') {
        const data = await upstreamJson(fetchImpl, `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
        return res.json({ items: (Array.isArray(data) ? data : []).slice(0, 18).map((entry) => normalizeTvmaze(entry.show || {})) });
      }
      if (kind === 'anime') {
        const data = await upstreamJson(fetchImpl, `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=18&sfw=true&order_by=popularity`);
        return res.json({ items: (Array.isArray(data.data) ? data.data : []).map(normalizeJikan) });
      }
      const url = new URL('https://www.wikidata.org/w/api.php');
      url.search = new URLSearchParams({
        action: 'wbsearchentities',
        format: 'json',
        language: 'en',
        uselang: 'en',
        type: 'item',
        limit: '24',
        search: query,
      }).toString();
      const data = await upstreamJson(fetchImpl, url.href);
      const filmWords = /\b(film|movie|cinema|motion picture|documentary)\b/i;
      const matches = (Array.isArray(data.search) ? data.search : [])
        .filter((entity) => filmWords.test(entity.description || ''))
        .slice(0, 18)
        .map(normalizeWikidata);
      return res.json({ items: matches });
    } catch {
      return res.status(502).json({ error: 'Catalog provider is temporarily unavailable' });
    }
  });

  app.get('/api/catalog/episodes', async (req, res) => {
    const source = text(req.query.source, 16);
    const id = text(req.query.id, 24);
    if (!CATALOG_SOURCES.has(source) || !/^\d{1,12}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid episode source' });
    }
    try {
      if (source === 'tvmaze') {
        const data = await upstreamJson(fetchImpl, `https://api.tvmaze.com/shows/${id}/episodes?specials=1`);
        return res.json({ episodes: (Array.isArray(data) ? data : []).map(normalizeTvmazeEpisode) });
      }
      const [episodeData, detailData] = await Promise.all([
        upstreamJson(fetchImpl, `https://api.jikan.moe/v4/anime/${id}/episodes?page=1`),
        upstreamJson(fetchImpl, `https://api.jikan.moe/v4/anime/${id}/full`),
      ]);
      const runtime = normalizeJikan(detailData.data || {}).runtime;
      const episodes = (Array.isArray(episodeData.data) ? episodeData.data : []).map((entry) => normalizeJikanEpisode(entry, runtime));
      return res.json({ episodes });
    } catch {
      return res.status(502).json({ error: 'Episode provider is temporarily unavailable' });
    }
  });

  app.use(express.static(path.join(__dirname, 'public'), { index: false }));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return app;
}

async function initializeSchema(pool) {
  await pool.query('DROP TABLE IF EXISTS presses');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_change_clock (
      user_id INTEGER PRIMARY KEY,
      updated_at_ms BIGINT NOT NULL
    )
  `);
  await pool.query("COMMENT ON TABLE user_change_clock IS 'staging:private'");
}

async function start() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await initializeSchema(pool);
  const app = createApp({ pool });
  const server = app.listen(DEFAULT_PORT, () => console.log(`Listening on :${DEFAULT_PORT}`));
  let stopping = false;

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received; draining`);
    const force = setTimeout(() => process.exit(1), 3500);
    force.unref();
    server.close(async () => {
      try {
        await pool.end();
      } finally {
        clearTimeout(force);
        process.exit(0);
      }
    });
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  createAuthMiddleware,
  initializeSchema,
  normalizeJikan,
  normalizeTvmaze,
};
