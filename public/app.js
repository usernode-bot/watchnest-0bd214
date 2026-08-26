(function () {
  'use strict';

  const Domain = window.WatchNestDomain;
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const demo = params.get('demo') === '1';
  const validScreens = new Set(['home', 'discover', 'library', 'upcoming', 'profile']);
  const ui = {
    screen: validScreens.has(params.get('screen')) ? params.get('screen') : 'home',
    detailKey: params.get('detail') || null,
    catalogItems: [],
    query: '',
    searchResults: [],
    searching: false,
    discoverType: 'all',
  };

  let store;
  let catalog;
  let searchTimer;
  const screenEl = document.getElementById('screen');
  const navEl = document.getElementById('bottom-nav');
  const warningEl = document.getElementById('remote-warning');
  const subtitleEl = document.getElementById('header-subtitle');
  const networkEl = document.getElementById('network-status');
  const importEl = document.getElementById('import-file');
  const liveEl = document.getElementById('live-region');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    }[char]));
  }

  function safeImage(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }

  function formatDate(value, options) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return 'Date TBA';
    return new Intl.DateTimeFormat(undefined, options || { month: 'short', day: 'numeric' }).format(parsed);
  }

  function episodeCode(episode) {
    return `S${String(episode.season).padStart(2, '0')} E${String(episode.number).padStart(2, '0')}`;
  }

  function typeLabel(type) {
    return type === 'show' ? 'Show' : type === 'anime' ? 'Anime' : 'Movie';
  }

  function icon(name, className = 'h-5 w-5') {
    const paths = {
      check: '<path d="m5 12 4 4L19 6"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      play: '<path d="m9 7 8 5-8 5Z"/>',
      heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.7-7.5a5.5 5.5 0 0 0 1.1-8.9Z"/>',
      chevron: '<path d="m9 18 6-6-6-6"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
      calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    };
    return `<svg viewBox="0 0 24 24" class="${className}" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${paths[name] || ''}</svg>`;
  }

  function poster(media, compact = false) {
    const image = safeImage(media.thumb || media.image);
    if (image) return `<img src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    return `<div class="poster-fallback"><span>${escapeHtml(media.title)}</span><small class="mt-2 text-[0.65rem] font-bold uppercase tracking-widest text-amber-200/70">${escapeHtml(typeLabel(media.type))}${compact ? '' : ' · WatchNest pick'}</small></div>`;
  }

  function mediaCard(media) {
    const entry = store.state.library[media.key];
    const progress = entry ? Domain.progressFor(entry) : null;
    const actionIcon = entry ? icon('check', 'h-5 w-5') : icon('plus', 'h-5 w-5');
    const actionLabel = entry ? `${media.title} is in your library` : `Add ${media.title} to your library`;
    return `<article class="media-card" data-media-key="${escapeHtml(media.key)}">
      <div class="poster-art">
        <button type="button" data-action="open-detail" data-key="${escapeHtml(media.key)}" class="absolute inset-0 z-[1] w-full" aria-label="Open ${escapeHtml(media.title)} details">${poster(media)}</button>
        <span class="poster-badge">${escapeHtml(typeLabel(media.type))}</span>
        <button type="button" data-action="${entry ? 'open-detail' : 'add-media'}" data-key="${escapeHtml(media.key)}" class="poster-action z-[2] un-touch-target" aria-label="${escapeHtml(actionLabel)}">${actionIcon}</button>
      </div>
      <h3 class="card-title">${escapeHtml(media.title)}</h3>
      <p class="card-meta">${media.year || 'Year TBA'}${media.genres?.[0] ? ` · ${escapeHtml(media.genres[0])}` : ''}</p>
      ${progress ? `<div class="progress-track" aria-label="${progress.percent}% watched"><div class="progress-fill" style="width:${progress.percent}%"></div></div>` : ''}
    </article>`;
  }

  function rail(title, items, kicker) {
    if (!items.length) return '';
    return `<section><div class="section-heading"><div><h2 class="section-title">${escapeHtml(title)}</h2>${kicker ? `<p class="section-kicker">${escapeHtml(kicker)}</p>` : ''}</div></div>
      <div class="media-rail">${items.map((item) => mediaCard(item.media || item)).join('')}</div></section>`;
  }

  function emptyState(title, copy, action) {
    return `<div class="empty-card"><div class="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-amber-400/10 text-amber-300">${icon('play')}</div>
      <h3 class="font-bold text-slate-100">${escapeHtml(title)}</h3><p class="mx-auto mt-1 max-w-sm text-sm leading-relaxed">${escapeHtml(copy)}</p>
      ${action ? `<button type="button" data-action="navigate" data-screen="discover" class="primary-button mt-4">Explore titles</button>` : ''}</div>`;
  }

  function nextRow(item) {
    const media = item.entry.media;
    const episode = item.episode;
    return `<article class="next-card">
      <button type="button" data-action="open-detail" data-key="${escapeHtml(media.key)}" class="next-thumb relative overflow-hidden" aria-label="Open ${escapeHtml(media.title)}">${poster(media, true)}</button>
      <button type="button" data-action="open-detail" data-key="${escapeHtml(media.key)}" class="min-w-0 text-left">
        <p class="truncate text-sm font-extrabold">${escapeHtml(media.title)}</p>
        <p class="mt-0.5 truncate text-xs text-slate-400">${escapeHtml(episodeCode(episode))} · ${escapeHtml(episode.title)}</p>
        <p class="mt-1 text-[0.68rem] font-semibold text-amber-300">${episode.runtime || media.runtime || (media.type === 'anime' ? 24 : 45)} min</p>
      </button>
      <button type="button" data-action="toggle-episode" data-key="${escapeHtml(media.key)}" data-episode-id="${escapeHtml(episode.id)}" class="check-button un-touch-target" aria-label="Mark ${escapeHtml(episode.title)} watched">${icon('check')}</button>
    </article>`;
  }

  function renderHome() {
    const watchNext = Domain.selectWatchNext(store.state);
    const inactive = Domain.selectInactive(store.state);
    const library = Object.values(store.state.library).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const caughtUp = library.filter((entry) => entry.media.type !== 'movie' && !Domain.getNextEpisode(entry));
    const lead = watchNext[0];
    return `<div class="screen-inner" data-screen="home">
      <section class="hero-card mt-2">
        <p class="text-xs font-extrabold uppercase tracking-[0.16em] text-amber-300">Watch next</p>
        ${lead ? `<div class="relative z-[1] mt-3 flex items-center gap-3">
          <div class="min-w-0 flex-1"><h1 class="truncate text-2xl font-black tracking-tight">${escapeHtml(lead.entry.media.title)}</h1>
          <p class="mt-1 truncate text-sm text-slate-300">${escapeHtml(episodeCode(lead.episode))} · ${escapeHtml(lead.episode.title)}</p></div>
          <button type="button" data-action="toggle-episode" data-key="${escapeHtml(lead.entry.media.key)}" data-episode-id="${escapeHtml(lead.episode.id)}" class="primary-button relative z-[2] flex items-center gap-2">${icon('check', 'h-4 w-4')} Watched</button>
        </div>` : `<div class="relative z-[1] mt-3"><h1 class="text-2xl font-black tracking-tight">Your nest is ready</h1><p class="mt-1 max-w-lg text-sm leading-relaxed text-slate-300">Add a show or anime and its next unwatched episode will always be waiting here.</p><button type="button" data-action="navigate" data-screen="discover" class="primary-button mt-4">Find something great</button></div>`}
      </section>
      ${watchNext.length ? `<section><div class="section-heading"><div><h2 class="section-title">Up next</h2><p class="section-kicker">One tap moves every story forward</p></div><span class="text-xs font-bold text-amber-300">${watchNext.length} ready</span></div><div class="grid gap-2 md:grid-cols-2">${watchNext.slice(0, 8).map(nextRow).join('')}</div></section>` : ''}
      ${rail('Continue watching', library.filter((entry) => entry.media.type !== 'movie' && !inactive.includes(entry)).slice(0, 10), 'Progress saved privately in this browser')}
      ${rail('Caught up', caughtUp.slice(0, 10), 'Nothing aired is waiting')}
      ${rail('Not watched for a while', inactive.slice(0, 10), 'Still here when you are')}
      ${!library.length ? `<div class="mt-6">${emptyState('Nothing tracked yet', 'Browse live catalogs for movies, shows, and anime, then add anything with one tap.', true)}</div>` : ''}
    </div>`;
  }

  function typePills(context) {
    const current = context === 'discover' ? ui.discoverType : store.state.preferences.libraryType;
    return `<div class="pill-row" role="group" aria-label="Media type">
      ${[['all','All'],['show','Shows'],['anime','Anime'],['movie','Movies']].map(([value, label]) => `<button type="button" class="pill" data-action="set-${context}-type" data-value="${value}" aria-pressed="${current === value}">${label}</button>`).join('')}
    </div>`;
  }

  function renderDiscover() {
    const type = ui.discoverType;
    const visible = (ui.query ? ui.searchResults : ui.catalogItems).filter((item) => type === 'all' || item.type === type);
    const label = ui.query ? `Results for “${ui.query}”` : 'Popular right now';
    return `<div class="screen-inner" data-screen="discover">
      <div class="mt-2"><p class="text-xs font-extrabold uppercase tracking-[0.16em] text-amber-300">Discover</p><h1 class="mt-1 text-3xl font-black tracking-tight">Movies, shows &amp; anime</h1><p class="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">Search live catalogs or browse WatchNest picks. Your searches are never stored on the backend.</p></div>
      <label class="search-wrap mt-5 block">${icon('search')}<span class="sr-only">Search titles</span><input id="catalog-search" class="search-field" type="search" autocomplete="off" placeholder="Search a title…" value="${escapeHtml(ui.query)}"></label>
      <div class="mt-3">${typePills('discover')}</div>
      <section><div class="section-heading"><div><h2 class="section-title">${escapeHtml(label)}</h2><p class="section-kicker">${ui.searching ? 'Searching live catalogs…' : `${visible.length} titles`}</p></div></div>
      ${ui.searching ? `<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6"><div class="skeleton aspect-[2/3]"></div><div class="skeleton aspect-[2/3]"></div><div class="skeleton aspect-[2/3]"></div><div class="skeleton aspect-[2/3]"></div></div>` : visible.length ? `<div class="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">${visible.map(mediaCard).join('')}</div>` : emptyState('No titles found', 'Try another spelling or switch media type. The bundled catalog remains available offline.', false)}
      </section>
    </div>`;
  }

  function statusPills() {
    const current = store.state.preferences.libraryStatus;
    return `<div class="pill-row" role="group" aria-label="Library status">${[['all','All'],['watching','Watching'],['watch-later','Watch later'],['completed','Completed'],['archived','Archived']].map(([value,label]) => `<button type="button" class="pill" data-action="set-library-status" data-value="${value}" aria-pressed="${current === value}">${label}</button>`).join('')}</div>`;
  }

  function libraryRow(entry) {
    const media = entry.media;
    const progress = Domain.progressFor(entry);
    const next = Domain.getNextEpisode(entry);
    return `<article class="library-row">
      <button type="button" data-action="open-detail" data-key="${escapeHtml(media.key)}" class="library-cover relative overflow-hidden" aria-label="Open ${escapeHtml(media.title)}">${poster(media, true)}</button>
      <button type="button" data-action="open-detail" data-key="${escapeHtml(media.key)}" class="min-w-0 text-left">
        <div class="flex items-center gap-2"><h3 class="truncate text-sm font-extrabold">${escapeHtml(media.title)}</h3>${entry.favorite ? '<span aria-label="Favorite" class="text-amber-300">♥</span>' : ''}</div>
        <p class="mt-0.5 truncate text-xs text-slate-400">${escapeHtml(typeLabel(media.type))} · ${escapeHtml(entry.status.replace('-', ' '))}${next ? ` · Next ${escapeHtml(episodeCode(next))}` : ''}</p>
        <div class="progress-track"><div class="progress-fill" style="width:${progress.percent}%"></div></div>
      </button>
      <button type="button" data-action="status-menu" data-key="${escapeHtml(media.key)}" class="un-touch-target grid h-11 w-11 place-items-center rounded-full text-slate-400" aria-label="Change ${escapeHtml(media.title)} status">•••</button>
    </article>`;
  }

  function renderLibrary() {
    const type = store.state.preferences.libraryType;
    const status = store.state.preferences.libraryStatus;
    const entries = Object.values(store.state.library)
      .filter((entry) => (type === 'all' || entry.media.type === type) && (status === 'all' || entry.status === status))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return `<div class="screen-inner" data-screen="library">
      <div class="mt-2 flex items-end justify-between gap-3"><div><p class="text-xs font-extrabold uppercase tracking-[0.16em] text-amber-300">Library</p><h1 class="mt-1 text-3xl font-black tracking-tight">Your nest</h1></div><span class="rounded-full bg-slate-800 px-3 py-1 text-xs font-bold text-slate-300">${Object.keys(store.state.library).length} titles</span></div>
      <div class="mt-5">${typePills('library')}${statusPills()}</div>
      <div class="library-list mt-2">${entries.length ? entries.map(libraryRow).join('') : emptyState('No matches in this view', 'Adjust the filters or discover something new to add.', true)}</div>
    </div>`;
  }

  function renderUpcoming() {
    const groups = Domain.selectUpcoming(store.state);
    const total = Object.values(groups).reduce((sum, items) => sum + items.length, 0);
    return `<div class="screen-inner" data-screen="upcoming">
      <div class="mt-2"><p class="text-xs font-extrabold uppercase tracking-[0.16em] text-amber-300">Calendar</p><h1 class="mt-1 text-3xl font-black tracking-tight">Your upcoming</h1><p class="mt-2 text-sm text-slate-400">Future episodes and movie releases from titles in your private library.</p></div>
      ${total ? Object.entries(groups).map(([label, items]) => items.length ? `<section class="date-group"><h2 class="date-label">${label}</h2><div>${items.map((item) => `<article class="schedule-row">
        <div class="schedule-date"><strong class="block text-lg text-slate-100">${formatDate(item.when, { day:'numeric' })}</strong>${formatDate(item.when, { month:'short' })}</div>
        <button type="button" data-action="open-detail" data-key="${escapeHtml(item.entry.media.key)}" class="min-w-0 text-left"><p class="truncate text-sm font-extrabold">${escapeHtml(item.entry.media.title)}</p><p class="mt-1 truncate text-xs text-slate-400">${item.episode ? `${escapeHtml(episodeCode(item.episode))} · ${escapeHtml(item.episode.title)}` : 'Movie release'}</p><p class="mt-1 text-[0.68rem] font-semibold text-amber-300">${formatDate(item.when, { weekday:'long', hour:'numeric', minute:'2-digit' })}</p></button>
      </article>`).join('')}</div></section>` : '').join('') : `<div class="mt-6">${emptyState('You’re all caught up', 'Add an airing show, anime, or upcoming movie and its release will appear here automatically.', true)}</div>`}
    </div>`;
  }

  function formatWatchTime(minutes) {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    return days ? `${days}d ${hours % 24}h` : `${hours}h`;
  }

  function renderProfile() {
    const stats = Domain.calculateStats(store.state);
    const favorites = Object.values(store.state.library).filter((entry) => entry.favorite);
    const clock = store.state.meta.localClock ? new Date(store.state.meta.localClock).toLocaleString() : 'No changes yet';
    return `<div class="screen-inner" data-screen="profile">
      <div class="mt-2"><p class="text-xs font-extrabold uppercase tracking-[0.16em] text-amber-300">Private profile</p><h1 class="mt-1 text-3xl font-black tracking-tight">Your watch time</h1><p class="mt-2 text-sm text-slate-400">Calculated entirely from watch events stored in this browser.</p></div>
      <section class="stat-grid mt-5">
        <div class="stat-card"><p class="text-xs font-bold text-slate-400">Watch time</p><p class="stat-value">${formatWatchTime(stats.minutes)}</p></div>
        <div class="stat-card"><p class="text-xs font-bold text-slate-400">Episodes</p><p class="stat-value">${stats.episodes}</p></div>
        <div class="stat-card"><p class="text-xs font-bold text-slate-400">Movies</p><p class="stat-value">${stats.movies}</p></div>
        <div class="stat-card"><p class="text-xs font-bold text-slate-400">In your nest</p><p class="stat-value">${stats.titles}</p></div>
      </section>
      ${rail('Favorites', favorites, `${stats.favorites} saved locally`)}
      <section class="privacy-card">
        <div class="flex items-start gap-3"><div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300">●</div><div><h2 class="font-extrabold">Browser-only by design</h2><p class="mt-1 text-sm leading-relaxed text-emerald-100/70">Your titles, watch history, ratings, and preferences stay in IndexedDB. The backend receives only a numeric last-change timestamp.</p></div></div>
        <dl class="mt-4 grid gap-2 text-xs text-slate-400 sm:grid-cols-2"><div><dt class="font-bold text-slate-300">Local clock</dt><dd class="mt-0.5">${escapeHtml(clock)}</dd></div><div><dt class="font-bold text-slate-300">Timestamp status</dt><dd class="mt-0.5">${store.state.meta.pendingClock ? 'Waiting to notify backend' : 'Backend notified'}</dd></div></dl>
        <div class="mt-4 flex flex-wrap gap-2"><button type="button" data-action="export" class="secondary-button">Export JSON</button><button type="button" data-action="import" class="secondary-button">Import JSON</button><button type="button" data-action="reset" class="danger-button">Erase this browser</button></div>
      </section>
      ${stats.recent.length ? `<section><div class="section-heading"><h2 class="section-title">Recently watched</h2></div><div class="un-group">${stats.recent.slice(0,8).map((item) => `<div class="un-group-row flex items-center justify-between gap-3 px-4 py-3"><div class="min-w-0"><p class="truncate text-sm font-bold">${escapeHtml(item.title)}</p><p class="text-xs text-slate-500">${escapeHtml(typeLabel(item.type))}</p></div><time class="shrink-0 text-xs text-slate-400">${formatDate(item.at)}</time></div>`).join('')}</div></section>` : ''}
    </div>`;
  }

  function groupedEpisodes(media) {
    const seasons = new Map();
    Domain.sortedEpisodes(media).forEach((episode) => {
      if (!seasons.has(episode.season)) seasons.set(episode.season, []);
      seasons.get(episode.season).push(episode);
    });
    return seasons;
  }

  function renderEpisodes(entry, media) {
    if (!media.episodes?.length) return emptyState('Episode guide unavailable', 'The live provider did not return an episode guide. Try again later; your library entry is safe.', false);
    return Array.from(groupedEpisodes(media)).map(([season, episodes]) => {
      const allWatched = entry && episodes.every((episode) => entry.watchedEpisodes[episode.id]);
      return `<section class="episode-season"><div class="season-header"><div><h3 class="font-extrabold">Season ${season || 'Specials'}</h3><p class="text-xs text-slate-400">${episodes.length} episodes</p></div>${entry ? `<button type="button" data-action="season-watched" data-key="${escapeHtml(media.key)}" data-season="${season}" data-watched="${allWatched ? '0' : '1'}" class="secondary-button">${allWatched ? 'Mark unwatched' : 'Mark all watched'}</button>` : ''}</div>
        <div>${episodes.map((episode) => {
          const watched = Boolean(entry?.watchedEpisodes[episode.id]);
          const aired = Domain.isAired(episode);
          return `<article class="episode-row ${aired ? '' : 'opacity-60'}"><button type="button" ${entry && aired ? '' : 'disabled'} data-action="toggle-episode" data-key="${escapeHtml(media.key)}" data-episode-id="${escapeHtml(episode.id)}" class="episode-toggle ${watched ? 'is-watched' : ''}" aria-label="${watched ? 'Mark unwatched' : 'Mark watched'}">${watched ? icon('check','h-4 w-4 mx-auto') : episode.number}</button>
            <div class="min-w-0"><p class="truncate text-sm font-bold">${escapeHtml(episode.title)}</p><p class="mt-0.5 text-xs text-slate-400">${escapeHtml(episodeCode(episode))} · ${episode.airdate ? formatDate(episode.airdate) : 'Date TBA'}${episode.runtime ? ` · ${episode.runtime}m` : ''}</p></div>
            ${entry && aired && !watched ? `<button type="button" data-action="mark-through" data-key="${escapeHtml(media.key)}" data-episode-id="${escapeHtml(episode.id)}" class="min-h-11 px-2 text-[0.66rem] font-bold text-amber-300">Through here</button>` : ''}</article>`;
        }).join('')}</div></section>`;
    }).join('');
  }

  function renderDetail() {
    const entry = store.state.library[ui.detailKey];
    const media = entry?.media || ui.catalogItems.find((item) => item.key === ui.detailKey) || catalog.find(ui.detailKey);
    if (!media) return `<div class="screen-inner" data-screen="detail"><button type="button" data-action="close-detail" class="secondary-button mt-3">Back</button><div class="mt-6">${emptyState('Title unavailable', 'This catalog item could not be loaded. Your saved library was not changed.', false)}</div></div>`;
    const progress = entry ? Domain.progressFor(entry) : null;
    const image = safeImage(media.image || media.thumb);
    const genres = (media.genres || []).map((genre) => `<span class="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300">${escapeHtml(genre)}</span>`).join('');
    return `<div class="screen-inner" data-screen="detail">
      <section class="detail-hero">${image ? `<img src="${escapeHtml(image)}" alt="" referrerpolicy="no-referrer">` : `<div class="absolute inset-0 bg-gradient-to-br from-amber-400/25 via-slate-800 to-slate-950"></div>`}<button type="button" data-action="close-detail" class="back-button un-touch-target" aria-label="Back">${icon('back','h-5 w-5 mx-auto')}</button></section>
      <section class="detail-copy px-1">
        <div class="flex flex-wrap items-center gap-2"><span class="rounded-full bg-amber-400/15 px-2.5 py-1 text-xs font-extrabold text-amber-300">${escapeHtml(typeLabel(media.type))}</span><span class="text-xs text-slate-400">${media.year || 'Year TBA'}${media.status ? ` · ${escapeHtml(media.status)}` : ''}</span></div>
        <h1 class="mt-3 text-3xl font-black tracking-tight sm:text-4xl">${escapeHtml(media.title)}</h1>
        ${progress ? `<div class="mt-3"><div class="flex justify-between text-xs text-slate-400"><span>${progress.watched} of ${progress.total} watched</span><strong class="text-amber-300">${progress.percent}%</strong></div><div class="progress-track mt-2"><div class="progress-fill" style="width:${progress.percent}%"></div></div></div>` : ''}
        <div class="mt-4 flex flex-wrap gap-2">${entry ? `<button type="button" data-action="status-menu" data-key="${escapeHtml(media.key)}" class="primary-button">${escapeHtml(entry.status.replace('-', ' '))}</button><button type="button" data-action="favorite" data-key="${escapeHtml(media.key)}" class="secondary-button flex items-center gap-2">${icon('heart','h-4 w-4')} ${entry.favorite ? 'Favorited' : 'Favorite'}</button><button type="button" data-action="remove-media" data-key="${escapeHtml(media.key)}" class="secondary-button">Remove</button>` : `<button type="button" data-action="add-media" data-key="${escapeHtml(media.key)}" class="primary-button flex items-center gap-2">${icon('plus','h-4 w-4')} Add to my list</button>`}</div>
        <div class="mt-4 flex flex-wrap gap-2">${genres}</div>
        <p class="mt-5 max-w-3xl text-sm leading-7 text-slate-300">${escapeHtml(media.synopsis || 'No synopsis is available yet.')}</p>
      </section>
      ${media.type === 'movie' ? `<section class="mt-6 rounded-2xl border border-slate-800 bg-slate-900/70 p-4"><div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="section-title">Movie diary</h2><p class="section-kicker">Private to this browser</p></div>${entry ? `<button type="button" data-action="toggle-movie" data-key="${escapeHtml(media.key)}" class="${entry.watchedAt ? 'secondary-button' : 'primary-button'}">${entry.watchedAt ? 'Mark unwatched' : 'Mark watched'}</button>` : ''}</div>${entry ? `<div class="mt-4"><p class="text-xs font-bold uppercase tracking-wider text-slate-500">Your rating</p><div class="mt-1 flex" role="group" aria-label="Movie rating">${[1,2,3,4,5].map((rating) => `<button type="button" data-action="rate" data-key="${escapeHtml(media.key)}" data-rating="${rating}" class="star-button ${Number(entry.rating) >= rating ? 'is-active' : ''}" aria-label="${rating} stars">★</button>`).join('')}</div></div>` : ''}</section>` : `<section class="mt-7"><div class="section-heading"><div><h2 class="section-title">Episodes</h2><p class="section-kicker">Tap once to track · “Through here” backfills earlier episodes</p></div></div>${entry ? renderEpisodes(entry, media) : `<div class="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-100/80">Add this title to track individual episodes.</div>${renderEpisodes(null, media)}`}</section>`}
    </div>`;
  }

  function render() {
    if (!store?.state) return;
    warningEl.hidden = !store.remoteAhead;
    const subtitles = { home:'Your next episode is waiting', discover:'Movies, shows & anime', library:'Saved only in this browser', upcoming:'Episodes and releases ahead', profile:'Private stats and data', detail:'Title details' };
    const active = ui.detailKey ? 'detail' : ui.screen;
    subtitleEl.textContent = subtitles[active];
    navEl.querySelectorAll('[data-screen]').forEach((button) => {
      if (button.dataset.screen === ui.screen && !ui.detailKey) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    screenEl.innerHTML = ui.detailKey ? renderDetail() : ({
      home: renderHome,
      discover: renderDiscover,
      library: renderLibrary,
      upcoming: renderUpcoming,
      profile: renderProfile,
    }[ui.screen] || renderHome)();
    screenEl.setAttribute('aria-busy', 'false');
  }

  function notify(message) {
    liveEl.textContent = message;
    if (window.unNative?.toast) window.unNative.toast(message);
  }

  function findMedia(key) {
    return store.state.library[key]?.media
      || ui.catalogItems.find((item) => item.key === key)
      || ui.searchResults.find((item) => item.key === key)
      || catalog.find(key);
  }

  async function openDetail(key, fromEl) {
    let media = findMedia(key);
    if (!media) return notify('That title is unavailable');
    media = await catalog.episodes(media);
    const entry = store.state.library[key];
    if (entry && JSON.stringify(entry.media.episodes || []) !== JSON.stringify(media.episodes || [])) {
      await store.dispatch({ type:'UPDATE_MEDIA', media });
    } else {
      const index = ui.catalogItems.findIndex((item) => item.key === key);
      if (index >= 0) ui.catalogItems[index] = media;
      else ui.catalogItems.push(media);
    }
    const mutation = () => { ui.detailKey = key; render(); screenEl.scrollTop = 0; };
    if (window.unNative?.transition && fromEl) window.unNative.transition(mutation, { type:'push' });
    else mutation();
  }

  async function hydrateAddedMedia(media) {
    const hydrated = await catalog.episodes(media);
    const entry = store.state.library[media.key];
    if (!entry) return;
    const previous = JSON.stringify(entry.media.episodes || []);
    const next = JSON.stringify(hydrated.episodes || []);
    if (previous !== next) await store.dispatch({ type:'UPDATE_MEDIA', media:hydrated });
  }

  async function addMedia(key) {
    const media = findMedia(key);
    if (!media) return notify('That title is unavailable');

    // Save first so the control responds even when a live episode provider is slow.
    await store.dispatch({ type:'ADD_MEDIA', media });
    notify(`${media.title} added to your nest`);
    void hydrateAddedMedia(media).catch(() => undefined);
  }

  async function chooseStatus(key, anchorEl) {
    const entry = store.state.library[key];
    if (!entry) return;
    const items = [
      { label:'Watching', value:'watching' },
      { label:'Watch later', value:'watch-later' },
      { label:'Completed', value:'completed' },
      { label:'Archived', value:'archived' },
    ].map((item) => ({ ...item, handler: () => store.dispatch({ type:'SET_STATUS', key, status:item.value }) }));
    if (window.unNative?.menu) await window.unNative.menu({ anchorEl, title:entry.media.title, items });
    else await store.dispatch({ type:'SET_STATUS', key, status: entry.status === 'watching' ? 'watch-later' : 'watching' });
  }

  function navigate(screen) {
    if (!validScreens.has(screen)) return;
    const mutation = () => { ui.screen = screen; ui.detailKey = null; render(); screenEl.scrollTop = 0; };
    if (window.unNative?.transition) window.unNative.transition(mutation, { type:'none' });
    else mutation();
  }

  async function confirmAction(title, message, actionLabel) {
    if (window.unNative?.alert) {
      const result = await window.unNative.alert({ title, message, buttons:[{ label:'Cancel', style:'cancel' }, { label:actionLabel, style:'destructive' }] });
      return result?.button?.style === 'destructive';
    }
    return window.confirm(`${title}\n\n${message}`);
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const key = button.dataset.key;
    try {
      if (action === 'navigate') navigate(button.dataset.screen);
      else if (action === 'open-search') navigate('discover');
      else if (action === 'open-detail') await openDetail(key, button);
      else if (action === 'close-detail') {
        const mutation = () => { ui.detailKey = null; render(); };
        if (window.unNative?.transition) window.unNative.transition(mutation, { type:'pop' }); else mutation();
      } else if (action === 'add-media') await addMedia(key);
      else if (action === 'remove-media') {
        const media = findMedia(key);
        if (await confirmAction('Remove from your nest?', `${media.title} and its local watch history will be removed from this browser.`, 'Remove')) {
          await store.dispatch({ type:'REMOVE_MEDIA', key }); ui.detailKey = null; notify('Removed from this browser');
        }
      } else if (action === 'toggle-episode') {
        await store.dispatch({ type:'TOGGLE_EPISODE', key, episodeId:button.dataset.episodeId }); notify('Episode progress updated');
      } else if (action === 'mark-through') {
        await store.dispatch({ type:'MARK_THROUGH', key, episodeId:button.dataset.episodeId }); notify('Earlier episodes marked watched');
      } else if (action === 'season-watched') {
        await store.dispatch({ type:'SET_SEASON_WATCHED', key, season:Number(button.dataset.season), watched:button.dataset.watched === '1' }); notify('Season progress updated');
      } else if (action === 'toggle-movie') await store.dispatch({ type:'TOGGLE_MOVIE_WATCHED', key });
      else if (action === 'favorite') await store.dispatch({ type:'TOGGLE_FAVORITE', key });
      else if (action === 'rate') await store.dispatch({ type:'SET_RATING', key, rating:Number(button.dataset.rating) });
      else if (action === 'status-menu') await chooseStatus(key, button);
      else if (action === 'set-discover-type') { ui.discoverType = button.dataset.value; render(); }
      else if (action === 'set-library-type') await store.dispatch({ type:'SET_PREFERENCE', key:'libraryType', value:button.dataset.value });
      else if (action === 'set-library-status') await store.dispatch({ type:'SET_PREFERENCE', key:'libraryStatus', value:button.dataset.value });
      else if (action === 'export') {
        const blob = new Blob([JSON.stringify(await store.exportData(), null, 2)], { type:'application/json' });
        const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `watchnest-${new Date().toISOString().slice(0,10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Export created');
      } else if (action === 'import') importEl.click();
      else if (action === 'reset') {
        if (await confirmAction('Erase WatchNest on this browser?', 'This permanently removes the local library and watch history. Export first if you may need it.', 'Erase')) { await store.reset(); notify('Local WatchNest data erased'); }
      }
    } catch (error) {
      notify(error.message || 'Something went wrong');
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id !== 'catalog-search') return;
    ui.query = event.target.value.slice(0, 80);
    clearTimeout(searchTimer);
    if (ui.query.trim().length < 2) { ui.searchResults = []; ui.searching = false; render(); return; }
    ui.searching = true;
    const query = ui.query;
    searchTimer = setTimeout(async () => {
      ui.searchResults = await catalog.search(query, ui.discoverType);
      ui.searching = false;
      render();
      document.getElementById('catalog-search')?.focus({ preventScroll:true });
    }, 280);
  });

  importEl.addEventListener('change', async () => {
    const file = importEl.files?.[0];
    importEl.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return notify('That export is too large');
    try {
      const value = JSON.parse(await file.text());
      Domain.validateImport(value, store.state.userId);
      if (await confirmAction('Replace this browser’s library?', 'The imported library will replace the current local data on this browser.', 'Import')) {
        await store.importData(value); notify('WatchNest export imported');
      }
    } catch (error) { notify(error.message || 'Invalid WatchNest export'); }
  });

  function updateNetworkStatus() {
    const online = navigator.onLine;
    networkEl.textContent = online ? 'Online' : 'Offline';
    networkEl.className = online
      ? 'rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[0.65rem] font-bold text-emerald-300'
      : 'rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[0.65rem] font-bold text-amber-300';
  }

  window.addEventListener('online', () => { updateNetworkStatus(); store.checkRemoteClock(); store.queueClock(); });
  window.addEventListener('offline', updateNetworkStatus);

  async function initialize() {
    updateNetworkStatus();
    catalog = new window.WatchNestCatalog.CatalogClient({ token, demo });
    store = new window.WatchNestStore.WatchNestStore({ token, demo, forceStale:params.get('stale') === '1' });
    await Promise.all([catalog.initialize(), store.initialize()]);
    if (demo) store.seedDemo(catalog.fallback);
    store.subscribe(render);
    ui.catalogItems = await catalog.discover();
    if (ui.detailKey) {
      const media = findMedia(ui.detailKey);
      if (media) {
        const hydrated = await catalog.episodes(media);
        const index = ui.catalogItems.findIndex((item) => item.key === hydrated.key);
        if (index >= 0) ui.catalogItems[index] = hydrated; else ui.catalogItems.push(hydrated);
      }
    }
    render();
    await store.checkRemoteClock();
    if ('serviceWorker' in navigator && !demo) {
      navigator.serviceWorker.register('/sw.js?v=20260826-4').then((registration) => registration.update()).catch(() => undefined);
    }
    if (window.unNative?.attachPullToRefresh) window.unNative.attachPullToRefresh(screenEl, async () => { ui.catalogItems = await catalog.discover(); render(); }, { topEl:document.getElementById('top-bar') });
    if (window.unNative?.attachKeyboardAvoidance) window.unNative.attachKeyboardAvoidance(screenEl, { topEl:document.getElementById('top-bar') });
  }

  initialize().catch((error) => {
    screenEl.innerHTML = `<div class="screen-inner"><div class="empty-card mt-8"><h1 class="text-xl font-black text-slate-100">WatchNest needs one online visit</h1><p class="mt-2">${escapeHtml(error.message || 'The private local library could not be opened.')}</p></div></div>`;
    screenEl.setAttribute('aria-busy', 'false');
  });
})();
