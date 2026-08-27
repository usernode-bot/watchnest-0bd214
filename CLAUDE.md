# WatchNest — coding-agent notes

This app runs on Usernode Social Vibecoding. Read the current platform
conventions before changing it:

https://social-vibecoding.usernodelabs.org/claude.md

## Product intent

WatchNest is a privacy-first, TV Time-style personal tracker for movies,
shows, and anime. Its essential loops are Discover → add to Library → Watch
Next → mark watched → see progress and Upcoming releases.

## Load-bearing privacy rules

- IndexedDB, namespaced by authenticated Usernode user id or the isolated
  `guest` namespace, is the sole source of truth for library/history/ratings/
  favorites/preferences and cached media.
- Never add backend storage for media ids, watch events, usernames, searches,
  preferences, ratings, exports, or device information.
- `user_change_clock(user_id, updated_at_ms)` is the only product table. It is
  marked `staging:private` and stores only the last-change number.
- Every signed-in local mutation must durably set `pendingClock`, persist
  first, then notify `POST /api/change-clock`. Offline notifications retry
  later. Guest mutations persist fully but never call the account clock.
- The remote-ahead warning is sticky for the entire session once the backend
  clock is larger than the local clock. A later write from the stale device
  must not silently clear it.
- A tokenless launch uses the separate guest namespace. An identity-bearing
  cached URL continues to resolve the signed-in namespace while offline.

## App conventions

- Keep catalog access read-through only; never persist catalog results in
  Postgres. The three GET-only catalog endpoints are intentionally public so
  guest mode retains discovery, search, and episode guides.
- Preserve deny-by-default RS256 Usernode authentication.
- Keep the hosted bridge, native kit, safe-area forwarding, service worker,
  and dev-console forwarder.
- Use whole literal Tailwind classes so the precompiler can see them.
- Add a `dapp.json` route check for every new or changed screen.
- `public/tailwind.css` is generated in the image build and must not be
  committed.
