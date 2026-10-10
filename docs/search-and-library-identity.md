# Search And Library Identity

## Search Requests

The independent Search page uses the existing streaming search controller for songs, albums,
playlists and artists. Its source choices are All, Local, and enabled providers that implement the selected
search method. All-source songs retain logical-track grouping; collections retain provider IDs.
Partial collection failures keep successful sources visible and name the failed providers. Each
collection page shares one global offset, with local results followed by providers in registry
order; only the requested window is rendered, without fetching full result sets. Each
streaming destination retains its own source, filters, detail stack and scroll position for the
app session. Local list queries and existing view preferences are scoped by page/detail identity.

The title bar and Ctrl+K remain available. Page actions in the command palette come from the same
registry as the sidebar, including pages hidden by the user's sidebar preferences. Opening a
hidden destination does not change those preferences.

The sidebar groups provider destinations under Streaming Music and local songs, albums, artists,
application playlists, folders and genres under Music Library. Provider collections are labelled
My Music Library within the streaming branch; application favourites remain in Playlists.
Expanding or collapsing a branch does not change the active destination, search state or playback.

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

Album search reuses the local library's derived album groups, matching album names and album
artists, including pinyin initials and multiple whitespace-separated terms. Online providers
opt in with the optional `searchAlbums` method; NetEase uses `/cloudsearch` with `type=10`.
Results retain the provider ID and release ID, display artist and source labels, and share the
collection paginator. Equal names or IDs from different sources are never merged automatically.
Album detail loads use the result's source rather than the currently selected streaming provider;
local details retain the library's disc/track order. Opening a result keeps the search query,
source and page intact for back navigation. NetEase album search and detail reads support
anonymous requests and attach the existing cookie when signed in.

The album display name is not an identity. Local-library album groups use `albumId` when
available. Otherwise they use the normalized `albumArtist + album` tuple, with `artist` as the
legacy fallback for files that do not carry an album-artist tag. Album navigation and Vue keys
use this group id, so two artists with the same album title remain separate.

## Manual Recording And Release Versions

The library tools menu, track information dialog and album detail toolbar expose song and
album version management. A version contains explicitly associated sources; a version family
links distinct recordings or releases without merging their identities. Labels, source grouping,
explicit splits, families and separate preferred-version/preferred-source choices are stored in
the versioned renderer record `twilight.music-versions.v1`. Existing libraries need no rewrite.
Remote source keys use provider and item ID; local keys use normalized path and CUE segment,
so rescanning with new generated track IDs retains overrides. Moving a file changes its key.

Manual relationships take priority in the shared logical track model, favorite matching,
playlist resolution, unified search/recent items and playback fallback. Unannotated tracks retain
legacy candidate matching; this does not create a persisted recording relationship. Different
IDs from one provider and conflicting live/remaster/acoustic markers remain separate. A local
candidate cannot bridge two otherwise incompatible provider recordings.

Edits show a preview before saving; withdrawing a relationship restores automatic interpretation.
Saving checks both the preview revision and the persisted record. Conflicts, corrupt data and
storage failures are reported without overwriting the existing document. Missing sources remain
visible for repair. Catalog entries come from the loaded library and saved playlist snapshots;
presence is not a guarantee of playback availability. Lists and member details render 50 entries
per page. Album sources reuse existing album identities and retain disc and track order.

Playing a preferred version is explicit. Ordinary playback does not switch to another recording
because it belongs to the same family. An absent preferred source requires source selection;
automatic fallback does not silently substitute another source. The player still validates the
chosen resource through its normal route. Version management never writes tags or merges files.

## Folder Identity

Folder cards represent configured scan roots. A root owns tracks whose normalized file paths are
equal to the root or start with the root followed by a path separator. This includes nested
directories while excluding similarly prefixed siblings such as `C:\\music-other` for the root
`C:\\music`.
