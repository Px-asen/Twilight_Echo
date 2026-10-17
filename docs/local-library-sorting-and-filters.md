# Local Library Sorting And Filters

Song table views keep their own sorting and filtering state under the local `twilight-echo:library-view-preferences:v1` preference key. A view is keyed by its local navigation category plus detail filter, so the all-songs table, an artist detail, an album detail, a playlist, and a folder can be configured independently.

Supported sort keys are title, artist, album, duration, format, sample rate, library-added time, and last played time. Filtering is conjunctive: lossless, DSD, sample rate, bit depth, directory, and provider selections all apply together. Empty metadata sorts before known numeric values in ascending order; source order remains stable for equal values.

`Track.addedAt` records the first time a local file is added to the library. Scanner updates retain its existing value so a metadata refresh never changes the user-visible join time. Legacy tracks without this field remain usable and sort as unknown until they are rescanned or re-added.

The view transformation runs before virtual-list slicing. Its regression suite covers combined filters, all sort fields, independent persistence, and a 10,000-track filter/sort budget.

## Locate the current track (Issue #139)

All songs and local playlist, album, artist, genre, folder, and recent track tables offer a crosshair button below the back-to-top arrow. The locator can also appear at the top of a page, where the arrow remains hidden.

Both buttons share a floating container and use absolute positioning inside it: arrow above, locator below with a 16px gap. Each slot stays fixed when either button is hidden, so visibility changes do not move the arrow.

Both actions also share the same opacity, slide and scale transitions, including their first visible paint when entering a page. The existing motion preference controls these transitions; off mode switches visibility immediately.

The button appears only when the current track is present in the current filtered/sorted list and is outside the visible viewport. Pure local-library views also require local-library membership; application playlists and device history can locate their retained online snapshots. Offscreen rows mounted by virtual-list overscan do not count as visible; title-bar clearance and the bottom player bar are excluded from the viewport. A partly visible row hides the button. No button or explanation is shown when there is no current track, the track is outside the applicable list/library, or search/filters exclude it.

Activation scrolls the existing list to place the row as close to the viewport center as the scroll boundaries allow. It does not change search, filters, sorting, playback, the queue, or multi-selection, and adds no highlight. Paused tracks remain locatable. Scrolling respects the existing motion preference.

All locator adapters, including the online virtual tables, use the same `scrollMotionBehavior()` as back-to-top: smooth scrolling in full mode and an immediate jump in reduced/off mode. Online query/sort resets retain their existing immediate scroll behavior.

`LocatePlayingTrack.behavior.test.ts` runs the real `SongList` in Electron with a virtualized 1,000-track library. It covers visibility, overscan, chrome obstruction, search/filter exclusion, sorting, multiple local views, playback/selection preservation, themes, narrow windows, and cleanup. It is included in `pnpm run test:local-perf`.

The online **我的音乐库 → 我喜欢** page uses `StreamingDetailStage`, not `SongList`. It and online playlist/album/recent/ranking details, plus the artist/social track tables, register the same floating locator through `useStreamingTrackLocator`. Online tracks are matched against the current page's filtered list without requiring a local-library copy. The previous toolbar locator that cleared search has been removed. `StreamingPage.layout.behavior.test.ts` exercises the real liked-page route, placement below the arrow, centering above the player, search exclusion, selection preservation, and navigation between online detail types.

The remaining desktop lists also participate: aggregate playlists, unified song search, cloud songs, platform history, the NCM chart modal, network directories/library results, all home layout song previews, listening rankings, saved radio stations and podcast episodes. Pagination, selected home tabs, hidden sources and loaded cloud chunks define the current list; locating does not change or fetch them. Aggregate rows use their displayed source variant and the virtual row stride matches their rendered height.

`composables/useTrackLocator.ts` owns the shared visibility, centering and registration lifecycle for both existing virtual adapters and `useDomTrackLocator`. Nonvirtual components mark their real rows with `data-te-track-id`; the DOM adapter tracks rendered rows and resolves their actual scroll container. Song sections sharing one container share one action, which hides when any occurrence of the current song is visible. Unmounting one section preserves the others' registration. Updates are coalesced per animation frame rather than rescanning the list on every scroll.

Run `pnpm run test:track-locator` for the focused real-Electron coverage, including filtered results, pagination, modal cleanup, duplicate home rows, network directory/file mixing, online snapshots and playback/selection preservation. The independent remote-control web client is outside this desktop change.
