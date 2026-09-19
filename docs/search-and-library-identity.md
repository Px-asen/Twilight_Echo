# Search And Library Identity

## Search Requests

Renderer search state is committed only by the latest monotonically increasing request id.
Each Streaming search snapshots `query`, `type`, `source`, and `offset` before calling a
provider. Unified search snapshots its query and pagination inputs. A later response from an
older snapshot must not change results, loading state, or error state.

`pagehide` and component disposal invalidate outstanding request ids. They do not make a
network request successful or turn an old response into current UI state.

The title-bar command button and Ctrl+K / Command+K open the command palette. An empty query
shows common actions without searching or changing audio settings. Prefix a query with `>` to
search only actions and the existing settings index. Other queries search unified songs and
loaded local/aggregate playlists after a 250 ms debounce. Song selection uses the normal player
route; playlist selection opens its existing detail view. Device profiles open the playback
settings anchor; opening EQ, DSP or a settings result does not apply a configuration.

The palette renders a bounded virtual window and pages songs and playlists in batches of 20
per source. Unified search caps each source page at 100 and reports `hasMore` from individual
source totals, rather than treating their combined total as one source's page count. The local
index caches normalized search blobs and source-priority order by the immutable library array;
queries allocate only page results. Logical grouping still uses `logicalTrackModel` within the
returned source pages. The displayed source variants are those found in the current page.

Typing clears old selectable results immediately; newer queries and closing abort provider
requests and invalidate late network-library reads. IME composition does not search, execute,
or dismiss the palette until the composition commits. Arrow keys, Enter and Escape work with
the native modal dialog's focus containment; closing restores the prior control. Disabled
actions explain the unavailable state. Ctrl+K / Command+K are reserved application shortcuts:
existing conflicting global bindings remain saved but are not registered, and settings reports
the conflict instead of dispatching two actions.

## Album Identity

The album display name is not an identity. Local-library album groups use `albumId` when
available. Otherwise they use the normalized `albumArtist + album` tuple, with `artist` as the
legacy fallback for files that do not carry an album-artist tag. Album navigation and Vue keys
use this group id, so two artists with the same album title remain separate.

## Folder Identity

Folder cards represent configured scan roots. A root owns tracks whose normalized file paths are
equal to the root or start with the root followed by a path separator. This includes nested
directories while excluding similarly prefixed siblings such as `C:\\music-other` for the root
`C:\\music`.
