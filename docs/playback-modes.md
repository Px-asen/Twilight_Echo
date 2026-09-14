# TE-4.1A Playback Mode Contract

The supported runtime playback modes are `sequential`, `listLoop`, `repeat`, `shuffle`, and `heart`.

- `sequential`: playback stops at the last queue entry.
- `listLoop`: playback wraps from the last queue entry to the first.
- `repeat`: EOF reloads the current track.
- `shuffle`: the renderer shuffles the original queue into a cycle and wraps after its
  last entry. The cycle is stable — passing the end replays the same order rather than
  reshuffling, so the renderer and the native engine never disagree about play order.
- `heart`: the renderer fetches a smart recommendation list for the NetEase "我喜欢的音乐"
  (liked songs) playlist via `/playmode/intelligence/list` and keeps refilling it at track
  boundaries. It is renderer-only, never persisted, and can only be entered while playing a
  NetEase stream from the liked playlist; other playlists and non-streaming sources cannot
  enable it. The native engine is kept on `sequential` and loads only the current track so the
  renderer owns every boundary.

The native audio ABI accepts `sequential`, `listLoop`, `repeat` and (for older hosts)
`shuffle`. Main and renderer both map through `toNativePlayMode` in
`src/shared/playbackModes.ts` — a single mapping on purpose, because two copies of it
are what let `listLoop` degrade into a non-wrapping native `sequential`:

- `listLoop` and `shuffle` both map to native `listLoop`. The renderer shuffles
  `queue` out of `originalQueue` itself, so the queue handed to the engine already _is_
  the shuffled cycle; the engine must wrap that order rather than permute it again.
  Because the native queue index therefore mirrors the renderer's in every mode,
  end-of-queue detection and optimistic track-switch UI work the same for shuffle as
  for any other mode.
- `heart` maps to native `sequential` and loads only the current track, so the renderer
  owns every boundary.

In the engine, `listLoop` (and legacy `shuffle`) wrap in both `advanceAfterEnd()` and
`upcoming()`. Wrapping `upcoming()` matters as much as the advance itself: it is what
the engine preloads, so without it the last → first hop would lose gapless playback.
A shuffle cycle wraps in place and is never re-permuted mid-session.

Should the engine still stop at a queue end while its queue is delegated — an engine
binary older than the host, which parses the unknown `listLoop` as `sequential`, or a
mode-sync race — main publishes `eof-reached` (it reports no upcoming track) and the
renderer applies its own boundary fallback. That path is why `listLoop`/`shuffle`
recover instead of capping auto-advance at the queue length.

This preserves native compatibility while keeping settings, playback-session
restoration, preload, and mini-player state on the same mode contract. `heart` is
intentionally excluded from persisted settings and saved playback sessions.

Named queue sessions preserve both the current shuffle cycle and its original order. A saved heart
queue becomes a sequential snapshot of the entries already generated. Actual playback order is
recorded independently of the saved mode: the last 200 starts include the mode active at each
start, duplicate queue occurrences and repeat boundaries. Manual queue edits end heart or
personalized refill ownership, and changing a playback mode invalidates older queue undo records.
