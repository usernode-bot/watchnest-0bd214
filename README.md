# WatchNest

WatchNest is a mobile-first personal tracker for movies, television shows,
and anime. It brings the core TV Time workflow to Usernode: discover titles,
build a watchlist, mark episodes or whole seasons watched, see the next
episode, follow upcoming releases, and review private viewing stats.

## Privacy model

The browser is the source of truth. Library membership, episode and movie
history, ratings, favorites, preferences, cached title metadata, and exports
live only in a Usernode-user-namespaced IndexedDB database.

The backend stores one number per user in `user_change_clock`: the timestamp
of the most recent browser mutation. On launch, WatchNest compares that number
with the local clock. A larger backend number means another device changed its
private library more recently, so WatchNest shows a sticky warning on every
screen. No title, episode, rating, username, search, or device data is sent to
Postgres.

## Catalogs

The Express server performs non-persistent, authenticated reads from keyless
public catalogs:

- TVMaze for shows and episode guides;
- Jikan for anime and episode guides;
- Wikidata entity search for movies.

A bundled catalog keeps the first-run, staging, offline, and provider-error
experience useful. Catalog responses are never written to the backend.

## Development

```bash
npm install
npm test
npm start
```

Runtime requires the standard Usernode variables: `DATABASE_URL`,
`USERNODE_JWT_PUBLIC_KEY`, `USERNODE_APP_ID`, `USERNODE_ENV`, and `PORT`.
Tailwind is compiled during the Docker image build. Do not commit
`public/tailwind.css`.

The app loads the Usernode bridge and native UI kit from the platform origin.
Do not vendor those centrally managed files.
