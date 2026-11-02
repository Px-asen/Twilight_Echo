# Local Library Metadata Enrichment

Local tracks are published through the existing SQLite library before online enrichment.
Core owns scanning and background metadata work; the renderer reads pages and sends commands.
Closing a page does not stop accepted work. Enrichment must not delay the first local-library
render, change a local track into a provider track, or write audio tags without confirmation.

There are two distinct paths:

- **Track enrichment** fills missing cover art, lyrics and compatible tag-like fields from
  enabled streaming search providers, using the existing cache policy and local-track matching.
- **Entity metadata** identifies artists, recordings, album projects and specific releases,
  then stores introductions, classification facts, credits and artwork separately from Track
  tags. These are durable Core tasks, shared only through confirmed typed identities.

The production wiring is in [Core entry](D:/Project/Twilight_Echo/src/main/coreProcess/entry.ts),
[CoreMetadataService](D:/Project/Twilight_Echo/src/core/library/metadataService.ts) and the
[SQLite worker](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseService.ts).

## Enable Everything After The First Import

After the first successful import, **让音乐资料更完整** offers **开启自动补全** and
**暂不开启**. Accepting enables new-import enrichment, existing-library backfill, every
registered source and the NetEase local fallback together. Text, permitted portraits and
their source attribution stay in the existing SQLite and durable artwork cache. Declining
is remembered. Either choice survives a restart; **设置 → 媒体库与存储 → 音乐库资料 →
开启全部资料获取** can enable everything later.

New profiles and old profiles without identification preferences start with `setup: pending`.
Automatic network work waits for that choice. An upgraded profile with music already imported
gets the same one-time prompt. Existing saved scope/source choices are preserved rather than
overwritten or re-prompted. The prompt waits until the welcome wizard and active scan finish.

### Public NetEase caches survive a plugin upgrade

Anonymous NetEase metadata uses its own stable data-contract context. Upgrading the bundled
plugin, logging in, or changing unrelated playback capabilities no longer hides saved public
introductions and portraits. The reader also accepts official `public-metadata-v2` caches
under the same metadata methods, text/image permissions and exact-identity contract. Disabling
the provider, revoking permissions or reaching an expiry still withdraws the cached material;
job publication retains its exact context fence.

NetEase album metadata includes `publishTime` as a Shanghai calendar release date. Core stores
it as an attributed release fact. Album cards, headers and the overview use it only when the
file has no date and every displayed release reference confirms the same identity. Incomplete
or conflicting references cannot borrow another edition's date. The fallback does not alter
audio tags or the Track's `releaseDate`; expiry removes it from an open page too.

Development, preview and installed builds share the shipped public-service defaults in
`src/main/coreProcess/metadataConfiguration.ts`: MusicBrainz identity/structured metadata,
Wikipedia introductions, Commons licensed artist portraits and non-exportable local NCM
text/image caching. No `.env.metadata.local` file or private key is required for those defaults.
Explicit Core environment restrictions still take precedence. Source identity checks,
per-image licensing, manual overrides and the existing request budgets remain in effect.
Selecting every source does not supply missing TheAudioDB keys, Discogs search tokens or
additional image rights; their actual capability reasons remain visible in settings.

The task center's **刷新状态** only rereads saved task state; it does not start a scan
or an online lookup. Facts and task transitions are committed as each result arrives.
On restart, interrupted running jobs resume; completed results, candidates, failures
and scheduled retry times remain saved. Unchanged automatic scheduling does not requery
completed lookups just because the application reopened or a day elapsed. New imports,
changed identification evidence and explicit online requery can create new work.
Task totals include per-source lookups and retained history, not song counts or missing
field counts. Use **资料覆盖明细** for actual missing fields.

### Keep Listening And Editing During Completion

Automatic completion stays in Core's durable background queue. Task progress updates the
task center, not the artist's portrait placeholder, biography or open identity review.
Artist pages keep their current content and source-choice buttons usable during a background
read; expanded biographies, editor drafts, text selection and keyboard focus stay in place.
Temporary read failures keep the last displayed source and its editors, with an explicit retry.
Changed identities and revoked display permissions still withdraw the old content immediately.

`entityMetadataRevision` retains its task-and-content meaning for existing clients.
`entityMetadataContentRevision` separately signals committed identities, candidates, facts,
manual edits and display-permission changes. Display consumers use the content revision when
available and the original revision with older Core versions. Neither opening a page nor
polling progress creates new work.

Confirmed identities take the next bounded scheduling page ahead of unidentified inputs.
Ready automatic detail jobs at the same priority keep FIFO across artists and albums, so newer album work cannot
continually overtake a queued portrait. Explicit requests and fourth-turn aging retain their
existing priority. Artist cards display completed reads during unrelated content commits;
content revisions still invalidate their remount cache. Session, permission and collection
changes reject old reads. Core rechecks the source's identity and personal-edit revision after
materializing a portrait, so a late bitmap cannot restore a detached identity or hidden image.

### Existing Libraries Recover Their Original Identification Tags

Upgrading does not require removing or reimporting songs. The startup scan upgrades old
file metadata caches from version 1 to version 2 by rereading raw identification tags and
NetEase native recording/release/artist references. It publishes those observations only
after the scan succeeds, using the existing file-version and library-scope fences. Changed
evidence automatically reschedules previous failed identity tasks and continues enrichment.
Track IDs, displayed names, lyrics, artwork and personal fields remain unchanged; explicit
manual identification observations remain authoritative. CUE and ISO segment identities
are kept separate from their containing file. Successfully upgraded files are not reread
on the next unchanged startup. Unreadable files remain retryable.

Automatic jobs wait while a present local track is being re-projected into the catalog.
A cover/lyrics refresh does not cancel its identity or biography demand as if the track
had left the library. In-flight results wait for fresh claim/input checks before publication;
actual removals and changed identification evidence retain their existing commit fences.

The SQLite worker backs up schema 29 before migrating to schema 30. Cached biographies
remain in SQLite; permitted metadata images remain in `music-cache/cover-cache/metadata-artwork`
while cover caching is enabled. They can display after a restart without redownloading.
Ambiguous identities still require review; a same-name search is not automatic confirmation.

## Library Organization And One-Click Completion

Open **音乐库整理** from the local library's tools menu. **需要你决定** lists unresolved
source catalog entities with saved identity candidates. Each entity counts once, regardless of
how many candidates or fields it has. Confirmed and explicitly detached identities are excluded
before counting and pagination. Same-name source entities remain independent. **查看候选** opens
the existing evidence, conflict and confirmation controls; opening the dialog never starts a scan
or online lookup. Missing portraits, biographies, covers and optional tags are not default chores.

**补充资料** asks Core to check the current library and submit available work in one operation,
without requiring a prior report. It produces explicit demands for the existing durable metadata
queue. Core rechecks identities, manual choices, capabilities and permissions before enqueueing;
repeated fields share one entity/provider task. Automatic identity confirmation retains the
established proof checks, while ambiguity stays in candidate review. Successful identification
continues with missing names, biographies and permitted portraits even when automatic import/history
switches are off. If no work is available, the round ends normally without inventing new chores.

**处理记录** is folded and loaded on demand. Failed source identity queries offer **重新查询**;
only saved candidate-review results offer **核对身份**. Requerying shared enrichment results
retains explicit source selection. Provider, language, batch and per-demand cancellation controls
remain under **技术详情与任务控制**. Refreshing records only reads saved state.

**文件问题** initially shows saved file-metadata matches awaiting confirmation. Open **可选整理**
for missing covers/tags, ignored/completed findings, duplicate detection and the existing full-library
rescan. Evidence and actions open after inspecting or selecting a row. File edits retain the tag
preview; marking a finding never modifies audio files. These metadata lists do not check whether
every audio file is currently readable. **更多工具** retains the full identity review/history,
genre mapping/hierarchy and playback-version workspaces.

**资料覆盖明细** is folded and checked on demand. Its per-field meanings are unchanged: local
tags/covers/genre tags; artist identities/names/portraits/biographies; album-project identities/
introductions; and specific-release identities. Artist and album coverage includes local and
in-library streaming source entities, not display-name groups. Each field retains existing,
missing, hidden and actionable counts. A completed job with no usable field still means missing
coverage. Selecting a metric or status opens paged findings. Manual clear/hide is excluded from
missing counts. Personal ratings, preferences and custom classifications remain optional curation;
a personal genre classification does not write a missing file tag.

Closing the dialog leaves Core work running, including the check-to-enqueue transition. Accepted
queue jobs survive application restart; the report and its in-memory follow-up coordinator do not.
If Core exits between identification and submitting detail jobs, reopen **音乐库整理** and choose
**补充资料** to submit remaining work. The queue retains existing jobs rather than creating another
executor. Recent completed lookups respect the existing one-day cache; no-content fields can be
attempted again after it expires. Saved artwork records can be checked without downloading images.

Implementation: [health service](D:/Project/Twilight_Echo/src/core/library/libraryHealthService.ts),
[health contract](D:/Project/Twilight_Echo/src/shared/libraryHealth.ts), and
[health panel](D:/Project/Twilight_Echo/src/renderer/src/components/library-inbox/LibraryHealthPanel.vue).

The isolated Electron gate in
[LibraryInboxDialog.behavior.test.ts](D:/Project/Twilight_Echo/src/renderer/src/components/library-inbox/LibraryInboxDialog.behavior.test.ts)
exercises completion, candidate expansion, failed-query retry, optional file filters, cross-page
selection and chunked decisions. Set `TWILIGHT_INBOX_EVIDENCE` to a writable directory to retain
light/dark and narrow-window screenshots using fixture data, without a user's library or online services.

## Local Artist Detail

Open an artist from the local library to see a portrait, biography and complete local
album/song counts. **概览** includes up to six albums; **专辑** browses twelve albums per
page by name and opens the existing album detail. **歌曲** retains the virtual song table,
search, sorting, multi-selection, native context menu and playing-track locator.
The hero's **播放全部 / 随机播放** always use the artist's full local collection, independent
of the song table's search or filters. **参与作品** browses saved relationships by role,
with separate library and cached-external scopes; it does not import tracks.

**管理资料** contains biography editing, source preferences, personal image/hide/reset,
identity review and **更新资料**. Opening the page or this disclosure only reads saved
data. Updating explicitly submits existing durable Core jobs under the current provider
permissions, even when automatic import/history enrichment is off. Recently completed
jobs use the existing generation-fenced requery command for the selected source.

The hero, biography and editors share one state owner in
[ArtistDetailPage](D:/Project/Twilight_Echo/src/renderer/src/components/song-list/ArtistDetailPage.vue).
`catalog.query.artistName` is an optional exact, trimmed artist-title filter, applied before
counting and pagination. Without it, existing collection-reference semantics are unchanged.
It excludes collaborators without splitting literal artist names such as `AC/DC`.
Multiple exact-name sources choose a confirmed display profile: manual confirmation ranks
above automatic proof and legacy confirmation, then agreement and source coverage break ties.
This choice neither confirms nor merges the other sources. Composite collection names retain
an explicit source choice.
Personal biographies, images and hidden states stay with that source; they never become
the shared person's automatic metadata. Artist-list cards without a usable portrait show
one of that artist's song covers instead. Personal images take precedence; an explicit image
hide suppresses this fallback. Song covers have no portrait attribution and are not saved as
identity artwork. The detail hero retains its person-photo presentation.
Text and images retain attribution, usage permissions and expiry.
Shared reads opt into `metadata.entity.detail.includeAutomaticArtwork` so a representative
source's personal image/hide does not suppress the person's permitted automatic portrait.
Other detail callers keep their existing override-only artwork reads.

Unstructured display credits and single copied ARTIST tags split `/`, `／` and spaced
` & ` / ` ＆ ` into individual artists. For example, `打打だいず & Ashrount` contributes
its songs to both artist cards, details and playback queries. Explicit multi-member credits,
provider-identified names, `AC/DC` and compact punctuation such as `R&B` remain intact.
Existing libraries apply this rule through bounded v3 catalog credit maintenance on startup;
original file tags, joined-name links and source-owned personal metadata remain available.

When a collection needs an explicit source, select its saved profile and choose
**将此资料用于艺术家封面**. The artist card and detail page remember that display choice
across restarts; **恢复自动选择** removes it. This does not confirm the other same-name
sources. Reads revalidate collection membership and the selected source's confirmed target,
so a detached or replaced identity cannot leave the old person's portrait on the card.
The profile-local display choice is stored separately from source-owned personal metadata.

Permitted, non-expiring automatic portraits are retained in the profile's
`music-cache/cover-cache/metadata-artwork` store when Core projects their artwork. They do
not use the ordinary remote cover cache's seven-day lifetime. Saved text, attribution and
license data remain in SQLite. Every display still requires current metadata permissions
and a fresh media grant; expiring images retain their original expiry path, and HTTP
`no-store` responses are not saved. The existing cover-cache switch and clear-cache action
also apply to this store. A saved portrait can therefore load offline after a restart.

Unresolved sources expose **待核对身份** rather than silently accepting the first name
match. Use **管理资料** to inspect saved candidates or explicitly request online
re-identification; if the public source has no suitable record, set personal text and an
image there. Composite credits remain intact, including literal slashes such as `AC/DC`.

The editorial layout follows Roon's public
[visual design](https://blog.roonlabs.com/roon-1-8-preview-1-of-5/),
[music data](https://roon.app/en/music/data) and
[discography browsing](https://blog.roonlabs.com/roon-1-8-preview-3-of-5/) references,
using Twilight Echo's theme tokens and controls. Streaming pages are unchanged.

`test:local-perf` includes the artist state, update and Electron behavior tests.
Set `TWILIGHT_ARTIST_EVIDENCE_DIR` to retain light/dark screenshots at 1280, 900 and
520 px, including long names and absent/failed portraits. The test uses an isolated
profile and fixture Core, not a user's music library or online metadata services.

Verified on 2026-10-25: 80 targeted catalog, identity, metadata, artwork and collection
tests; the artist-page, album-page and album-background-refresh Electron behavior tests;
renderer and main-process type checks; and targeted ESLint. Light/dark wide and narrow
renders, portrait placeholders, long names and album grids were visually inspected.
Background reads retain the painted metadata pane and edit draft while disabling stale
writes. Elevated Windows test hosts can set `NO_SANDBOX=1` for these isolated Electron
runners; this does not change the application's production sandbox settings.

## Use NetEase As A Local Fallback

When an artist has no permitted biography or portrait, **网易云音乐（兜底）** can fill
the missing field. Existing public-source biographies and images remain first, even if
NetEase has a closer language match. A source-specific biography preference can explicitly
select NetEase; personal text, image overrides, clear/hide and reset keep their priority.
Streaming-page text selection keeps its existing native-source priority.

Open **管理资料 → 身份与候选复核 → 联网重新识别** to find an unlinked NetEase profile.
Open its typed ID link to check the person or release. For an already confirmed identity,
choose **确认同一身份，补充网易云引用** when offered, then **更新资料**. This adds an
unowned native reference to the existing shared identity without replacing its MusicBrainz
reference, biographies, portraits or personal content. The preview states that the added
reference is shared by other entries of the same confirmed identity. A reference owned by
another target, a second NetEase ID in the same namespace or a stale preview cannot be
attached. The existing **确认替换关联** remains a separate identity replacement operation.
An unresolved artist uses the existing explicit **确认关联** flow. Search names alone never
authorize either automatic confirmation or attachment.

Files without a NetEase song ID can be identified automatically from their saved
audio tags. Core compares the song title, original-precision duration (within two
seconds), complete performer credits and album. For translated artist names, it
reads the official aliases of the exact artist ID returned by NetEase; an alias
does not link unrelated same-name library entries. Explicit `feat.` title credits
and whole joined performer strings can match structured platform credits without
splitting local names such as `AC/DC`. Live, remix and other version qualifiers stay.
An over-broad search is retried with the observed album title; only a complete,
unique match can confirm an identity. Missing or conflicting credits remain reviewable.
Official artist aliases share the existing session response cache, while confirmed
identities and downloaded metadata use the existing persistent stores.

The built-in NCM plugin uses its existing request/cancellation/rate-budget channel:

- `/cloudsearch?type=100` works anonymously and continues using an available account.
- `/artist/detail` verifies the native artist ID and supplies `avatar`, then `cover` or
  `picUrl` from the artist itself. Its identity-only handler also returns official
  names and aliases for recording verification. Album covers are never used as portraits.
- `/artist/desc` combines the brief biography and all titled introduction sections.
  The detail response's brief biography is used when the description response has none.
- `/album` verifies the native release ID and supplies `description`/`briefDesc` plus
  its own artwork. Missing descriptions remain empty; a platform release is not an album
  project or a MusicBrainz pressing. Select the specific release layer for these details.

Only canonical NetEase image-CDN resources are accepted, upgraded to HTTPS. Images go
through the existing Core projection and persistent metadata-artwork cache; the renderer
receives media handles, not raw CDN URLs. Images without text are valid results. API failures
remain task failures/retries, not invented biographies. Source language remains `und` when
the API does not declare it, and absent open-license information remains empty.

Confirmed NCM native IDs work without MusicBrainz access. For a confirmed MusicBrainz artist
or release, an approved MB request may follow one unique typed `music.163.com` URL relation.
No link or conflicting links returns no match, not a name-based guess. In the four real-library
MB identities sampled on 2026-10-25, none contained such a link. Without corroborating
recording evidence, these need explicit native profile review. This source improves
field availability after identity selection; it does not turn every same-name result
into an identified person.

The installed app includes local NCM display and caching. Accept the first-import prompt,
or enable **网易云资料兜底** in the library metadata settings. Its switch is saved in the
existing settings file; enabling it also selects NCM for automatic work. Disabling it
withdraws the local text/image permission and invalidates old automatic projections without
removing NCM identity search or deleting the saved records. Existing attribution controls
identify the source; no additional badge is added.

Deployment owners can still override the profile choice with:

```dotenv
TWILIGHT_METADATA_ENABLED=1
TWILIGHT_METADATA_NCM_LOCAL_FALLBACK=1
```

The second switch explicitly enables NCM text and image use on this local library, retains
source attribution and sets `export: false`; `0` prohibits that local fallback. It does not
assign an open license. Other platform deployments continue using separately reviewed `TWILIGHT_METADATA_PLATFORM_USAGE` and
`TWILIGHT_METADATA_PLATFORM_ARTWORK_USAGE` provider-to-usage JSON maps. Explicit denials and
expiry in those maps narrow the personal opt-in. Other providers receive no new permissions.
The development launcher allowlists these keys from `.env.metadata.local`; the next launcher
start loads changes. Preview/release builds use the shipped defaults and any explicit process overrides.
Opening a page still reads saved data; **更新资料** submits the existing durable tasks.

## Combine Public Sources Without Requiring MusicBrainz

In **管理资料**, use **重新识别** for missing identities and **更新资料** for a confirmed
artist or album. Explicit requests use all eligible registered adapters and do not require
automatic history backfill. Choose sources under **设置 → 媒体库与存储 → 音乐库资料** for
automatic import/history work. Opening a page still only reads saved metadata.

- **VocaDB** adds independent artist/album IDs, aliases and descriptions for Vocaloid, UTAU
  and related music. Exact-name results remain review candidates, including a single result.
- **TheAudioDB** adds multilingual biographies and album descriptions. Its free name search
  returns only one result, so it never proves a unique identity. Images require either the
  artist record's Creative Commons flag or a separately approved deployment image policy.
- **Discogs** adds artist profiles and specific-release notes. Name search needs a Token;
  exact public-ID detail requests do not. Discogs data expires after six hours. A master
  record without notes stays empty; specific-release notes are not borrowed for a master.

Confirmed native IDs work independently of MusicBrainz. If only a confirmed MBID exists,
VocaDB/Discogs follow its unique explicit outbound link, and TheAudioDB checks its exact
MBID response. They do not search a same-name person to fill a missing cross-reference.
Native IDs take priority and artist/project/release namespaces stay separate. Confirming a
candidate is an identity decision; a new candidate is not counted as a successful automatic
identification. Existing MusicBrainz recording-based confirmation rules are unchanged.

Text from different eligible sources shares the established language/source preference
selection. Manual text, picture overrides and hidden states remain source-owned. Local album
management now has the same persistent update controls, including queued, failed, no-content
and partial-content results. Health completion can request permitted public portraits for
native-only identities, rather than requiring a MusicBrainz artwork ID.

### Configure keys in Core, not in the renderer

Development reads these optional keys through the existing `.env.metadata.local` allowlist;
release deployments provide private keys in the Core launch environment. Restart after changing
keys. Public enablement and the application contact are already included in the installed app.

```dotenv
TWILIGHT_METADATA_VOCADB=1
TWILIGHT_METADATA_THEAUDIODB=1
TWILIGHT_METADATA_THEAUDIODB_KEY=123
TWILIGHT_METADATA_DISCOGS=1
# Set TWILIGHT_METADATA_DISCOGS_TOKEN through your private Core configuration for name search.
```

`123` is TheAudioDB's public development key, supplied by default only in development.
Application-store distribution requires the appropriate TheAudioDB subscription/key. A
missing search Token does not disable Discogs detail lookup. Credentials are excluded from
renderer state, persisted job context and task logs. Requests use the shared bounded GET-only
HTTP transport and per-host rate limits; no additional scraping service is introduced.

VocaDB and Discogs uploaded pictures do not inherit their database text licenses. Deployment
owners with separately reviewed rights may supply `TWILIGHT_METADATA_PUBLIC_ARTWORK_USAGE`
as a provider-to-`MetadataUsage` JSON map. Without approval those pictures stay unavailable.
Existing permitted, non-expiring Commons portraits retain their durable cache; expiring public
images keep their expiry and export restrictions. Source attribution and license links remain
visible. This application uses Discogs’ API but is not affiliated with, sponsored or endorsed
by Discogs. ‘Discogs’ is a trademark of Zink Media, LLC.

Sources: [VocaDB API](https://wiki.vocadb.net/docs/public-api),
[VocaDB license](https://wiki.vocadb.net/docs/license),
[TheAudioDB terms](https://www.theaudiodb.com/docs_terms_of_use.php),
[Discogs API](https://www.discogs.com/developers/),
[Discogs terms](https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use).

## Local Album Release Dates

Album cards and detail headers use local `releasedate`, `date`, then `year` tags. Invalid
calendar dates fall through to the next tag. Persisted `releaseDate` retains only the available
precision (`YYYY`, `YYYY-MM`, or `YYYY-MM-DD`); timezone suffixes never shift the calendar day.
Albums select the most frequent valid year, then the most precise date within that year.
Equal precision uses frequency, with album track order breaking ties. Collection identities
and sorting are unchanged. CUE subtracks inherit their source date; SACD ISO tracks use native years.

The date-only backfill contract is to read unchanged legacy files after the existing library
is available, merge only `releaseDate`, and retain titles, artists, artwork, lyrics, track
identities and provider matches. Successful reads set file-index `metadataVersion: 1`, including
files without a date; failed reads remain retryable. A cancelled date-only backfill must not
publish its date changes or completion markers. Date-only changes must not enqueue online
enrichment. New or actually changed files keep the normal scan and enrichment flow.

Both the retained JSON scan and the production SQLite scan implement that narrow merge.
SQLite schema 29 stages dates per scan job and physical file in `scan_release_dates`.
`commitScanBatch` acknowledges date-only work without changing Track fields or completion markers;
successful `finishScan` validates every staged file and dependency before publishing dates and
markers in one transaction. Validation and publication read pages of at most 256 files. A
concurrent edit or changed file prevents the whole date publication and queues the affected
directory for retry. Pausing retains staging; cancellation, failure and interrupted recovery
discard it. Files with trusted unchanged v0 identities from JSON migration also use this path.

Date reads skip cover extraction and have the existing overall metadata parsing deadline.
ISO date reads use the native reader without expanding existing logical tracks. Successful
reads with no valid date clear an obsolete date and complete once; failed reads retain the
old date and retry eligibility. Ordinary new/changed-file batches still publish immediately,
and cancellation retains those committed batches. A full scan retains its explicit reparse
behavior. See
[scan batch publication](D:/Project/Twilight_Echo/src/main/library/libraryDatabase.ts),
[database scanner](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseScanner.ts) and
[legacy date-only merge](D:/Project/Twilight_Echo/src/main/library/libraryIndexCoordinator.ts).
Pause, cancel and progress use the existing Core scan controls, not a page-owned scan.
The automatic regression covers narrow publication, cancellation, recovery and migration;
the 100k query benchmark does not measure a 100k-file legacy-date finalization transaction.

## Library Organization Inbox

The local-library tools menu opens **曲库整理收件箱**. Its **文件问题** section calls
`library.inbox.refresh`; Core reads revision-fenced SQLite Track pages of 200 and derives an
in-memory issue view. Opening it does not parse audio, hash files or search providers.
Missing covers include both cached cover and durable cover origin. Required-tag review covers
title/artist/album, empty or known placeholder values, and titles equal to the filename stem.
Filename matches are explicitly possible fallbacks, not proof that a file lacks a title tag.
Enrichment review means an existing medium-confidence provider match; absence of a provider match
alone is not an error. CUE entries retain distinct identities.

Users can filter, select, ignore, mark reviewed and reopen issues. Decisions belong to
[CoreInboxService](D:/Project/Twilight_Echo/src/core/library/inboxService.ts), persisted in
CoreState SQLite's `inbox` domain through `coreInboxWrite`, with the latest 20,000 decisions
retained. `library.inbox.mark` checks the view ID, decision revision and current library revision;
the renderer is only a page/selection projection. The old `twilight.library-inbox.v1`
localStorage record is a read-only, one-shot migration source, not an active writer.

Decisions remain profile-local and do not alter tracks or files. Identity plus a content
fingerprint fences old decisions; changed metadata, reimport timestamps or duplicate membership
produce pending issues again. A refreshed view replaces the issue index. Duplicate evidence must
match its library revision and requires explicit rechecking after a library change. Storage
failures are visible; Core rereads uncertain durable state rather than assuming a failed reply
means no write occurred.

Issue rows, duplicate members, tag previews and write results render in pages of 50. The dialog
retains selected issue indexes and their displayed Track projections; it does not own the full
issue index or persist decisions. The explicit **全库后台重扫与补全** command reuses
`startFullLibraryScan`, now a projection of `scan.start { mode: 'full' }`. The Settings library
panel reads Core scan/enrichment status and controls cancellation. Closing the inbox does not
cancel that shared job. Loudness jobs are not included in this inbox.

**音乐资料复核** is a separate section: `identification.inbox` returns 20 real library entities
per page, with candidate counts and source examples. Deleted, missing and pending catalog sources
are excluded. Opening, paging or rereading saved candidates is local-only; **联网重新识别** is
the explicit network action. Confirm, replace, reject, detach and historical restore use the
existing preview/revision-checked identity commands. File issue decisions are not identity
confirmations. See [M2.5](D:/Project/Twilight_Echo/docs/unified-music-library-m2.5.md).

Tag editing requires a per-file before/after preview and separate confirmation. Empty/whitespace
text fields leave existing tags intact, including fields that were typed then cleared. CUE/container
subtracks cannot be written through this file-level form; users edit the source file and rescan.
At most 1,000 distinct files can be submitted in one existing tag transaction. The form opens a
Core-owned `library.selection` snapshot and submits its ID to `library.tags.write`; the renderer
does not send trusted paths. Core checks selected row versions and incarnations, authorizes
files, reserves the scanner and drains affected file resources, then rechecks before dispatching
the journalled worker write. Accepted work outlives the dialog. Core queues affected directories
for reindexing afterward, including recovery paths; an explicit background rescan remains
available to refresh authoritative file values. Failed, rolled-back or unattempted files can be
previewed and retried separately. These fences do not lock out external editors.

The production owner is
[CoreLibraryMaintenance](D:/Project/Twilight_Echo/src/core/library/maintenanceService.ts), consumed
by [LocalLibraryTagManager](D:/Project/Twilight_Echo/src/renderer/src/components/LocalLibraryTagManager.vue).

## Core Track Enrichment Queue

- The queue uses six workers by default and clamps configuration to four through eight workers.
- Core reads at most 200 local tracks per database page. Requests are deduplicated by normalized
  title-and-artist query while queued/running; candidate search broadens only when no usable
  match has been found. Failed queries carry in-process exponential backoff (15 seconds up to
  5 minutes). This queue is not the durable entity task repository.
- Status is exposed separately from the file scan: the Settings library panel reports scanning,
  enriching, completed, failed, and cancelled states. Cancelling discards queued work and settles
  callers immediately.
- Each update carries its source Track and enriched Track. Core rereads that exact local ID,
  compares path, title, artist, album, duration, CUE range and changed fields, then commits only
  the allowed metadata patch with the database row's expected version. A removal, concurrent
  scan/edit or newer result cannot be overwritten by an old provider result. No renderer object
  reference or `saveMusicLibrary` call is a persistence authority.

## Development Source Configuration

The normal development command remains `node scripts/run-electron-vite.cjs dev`.
Its optional, Git-ignored `.env.metadata.local` configures only these five variables:

```dotenv
TWILIGHT_METADATA_ENABLED=1
TWILIGHT_METADATA_PUBLIC_SERVICE_APPROVED=1
TWILIGHT_METADATA_WIKIPEDIA_TEXT=1
TWILIGHT_METADATA_COMMONS_IMAGES=1
TWILIGHT_METADATA_CONTACT=https://github.com/Px-asen/Twilight_Echo
```

The launcher reads an allowlist, leaves explicit shell values in control, and never
loads this file for preview or packaged launches. These public sources need no API
key. `PUBLIC_SERVICE_APPROVED` records the deployment's eligibility to use the public
service; check the service terms separately before commercial distribution. This
configuration enables Commons artist images after per-file rights checks; it does not approve
platform text caching or Cover Art Archive usage. Commons CC-BY/CC-BY-SA images retain author
and license links. Public-domain templates without a license URL require consistent structured
PD, copyright, usage-term and restriction fields; an absent license alone is insufficient.

For one-time setup of an existing profile, create Git-ignored
`.local/music-metadata-setup.json` with this shape, substituting that profile's absolute root:

```json
{
  "version": 1,
  "profileRoot": "C:/Users/<user>/AppData/Roaming/TwilightEcho",
  "newImports": true,
  "history": false,
  "sources": ["musicbrainz"]
}
```

On the next development launch, the Core's settings owner applies just these identification
preferences before automatic metadata tasks activate. It retains the selected language and
all unrelated settings, then renames the request to `music-metadata-setup.json.applied`.
Later launches do not re-enable a switch the user has turned off. A different profile,
unresolved settings load issue or invalid request leaves it pending and logs a warning;
an isolated test profile cannot consume a normal-profile request. If saving succeeds but
renaming fails, the warning explicitly reports `settingsApplied: true`; remove or rename
the pending request before changing those preferences again.

This setup does not modify an already-running player's settings or deployment environment.
Close it normally and relaunch development to apply the saved configuration. This does not
enable a full-library history pass; pending import/input changes still follow the existing
new-import schedule. The **音乐库资料** settings section can separately control new imports,
history, sources and language afterward. MusicBrainz
supplies structured artist/recording/album-project/release data; the current Wikipedia
adapter supplies artist and album-project introductions through reciprocal typed Wikidata IDs
and the corresponding Wikipedia page. A release-group introduction describes the album work,
not a particular pressing, and is not an editorial review or rating.

### Automatic identification uses songs, not just names

Local tags without external IDs can now provide structured cross-checks:

- **Artists:** exact song title, complete ordered credits and a duration within two seconds,
  plus an exact album title for a single-song sample. Two different songs can corroborate the
  same artist without album tags. Recording search is bounded, uses the shared HTTP budget and
  includes the raw album title when available. Ambiguous or truncated results remain reviewable.
- **Partial album imports:** one unambiguous album-project candidate and a fully loaded release
  must corroborate every imported song's raw title, duration and credits. Missing local track
  totals do not prevent this project-only identification. A positive witness need not enumerate
  hundreds of pressings. This proof does not confirm a concrete release or propagate child IDs.
- **Complete albums and explicit IDs:** retain their existing validation paths. Known external
  IDs, ISRCs, album credits and pressing evidence remain constraints, not disposable hints.

SQLite rechecks structured proofs inside the existing generation/input/link-fenced finish
transaction. Automatic results cannot replace a manual confirmation, rejected candidate,
detached identity or conflicting personal identity data. The matcher version changes once so
the existing scheduler can reassess eligible import work; no separate repair queue is introduced.

Artist cards project confirmed names and permitted avatars from saved metadata rather than
only showing track covers. Multiple source-scoped performers share automatic card data only
when every member confirms the same target, unless a user explicitly chooses one source for
the card. Missing or conflicting profiles use a themed artist placeholder, never a song or
album cover. Collection keys and file tags are unchanged. Image attribution is available from the card;
expired or revoked display rights remove the projection. Source-entity personal image choices
are not silently applied across a whole multi-source collection.

The default album overview can show an attributed **album-project introduction** while its
pressing remains unresolved. The label and “查看作品资料” action keep that introduction's scope
separate from release facts and editors. Explicit manual hide/clear is respected. Task-list
refreshes coalesce background revisions instead of repeatedly aborting an in-flight page read.

Public-source coverage remains a content dependency: an artist with no eligible public photo
or encyclopedia article cannot be filled by name alone. MusicBrainz HTTP 503 means the public
server is busy; the durable queue retains its retry/failure state rather than reporting a
successful biography lookup. A new source configuration takes effect on the next normal
development launch, not in a process that already inherited the old environment.

## Durable Entity Identification And Enrichment

### First import: choose once, enrich in the background

On the first import, the local import dialog leaves metadata preferences unchanged and
asks once in the post-import prompt. For already-configured profiles, it shows the available sources and an explicit
“自动补全头像、简介和专辑资料” choice. Choosing a folder grants access through
the existing native picker but does not register a watcher or start import.
Acceptance saves the metadata choice, submits the explicit import, then registers
the watched folder. Historical backfill remains independent. Old no-argument
folder-picker callers retain their existing immediate registration behavior.

The scanner can read the public NetEase file-format identity comment. Only a
bounded ID/title/album/paired-credit/duration record is retained. File title,
album, full artist credit and duration must independently agree; copied/stale
comments, CUE segments and conflicting IDs cannot auto-confirm. `AC/DC` stays one
name. A consistent file-native identity selects NCM before speculative searches;
it is a file declaration, not a claim that a remote song lookup has occurred.

For files without usable IDs, the optional structured recording search compares
raw titles, original-precision duration (within two seconds), complete credits
and album. Core reads at most forty results, requires a complete stable index and
a unique corroborated identity, and recomputes the proof against current saved
observations inside the commit fence. This confirms a platform digital record,
not a MusicBrainz physical pressing. Unknown collaborator IDs remain unknown.

NCM fallback metadata uses public, account-independent requests with a separate
one-request-per-second budget. A rate limit stops upstream metadata requests for
at least sixty seconds and remains a visible durable retry instead of exhausting
an individual item's ordinary five-error budget. Login and playback retain their
existing channels. Local-only usage still retains NCM attribution and prohibits
export. Task summaries distinguish active work, attention and terminal records;
query-record totals are not song counts.

Imported tags, embedded artwork and playback are usable without waiting for
online enrichment. Sources can legitimately supply an image without prose, or
no biography at all. A successful HTTP response alone does not establish full
library metadata coverage.

[CoreEntityMetadataService](D:/Project/Twilight_Echo/src/core/library/entityMetadataService.ts)
claims existing SQLite jobs, calls adapters outside database transactions and publishes through
`metadataFinish`. Identity confirmation and external-reference changes schedule follow-up work
through the transactional outbox; each scheduling pass handles at most 200 entities. Jobs and
demands survive Core/worker restart, with generation recovery fencing old results.

Automatic new-library and historical-backfill scopes are separately configured, both off by
default. The selected source, language, deployment permission, capability and account context
must authorize the work. Existing explicit lookup/refresh entry points do not acquire these
automatic switches as new prerequisites. A shared provider/language/typed-ID/context job retains
each consumer's demand; claim and commit check current membership, confirmed linkage and scope.
Removing one consumer does not cancel the others. Removing the last valid demand prevents a
late commit. Closing TaskCenter or a metadata panel does not cancel accepted jobs.

Introductions can come from an approved platform detail adapter, or from MusicBrainz identity
and its corroborated Wikidata/Wikipedia links. A name match or a Track `metadataMatch` is not
permission to attach that person's biography. MusicBrainz/public-service approval, Wikipedia
text permission, Commons image permission, Cover Art Archive usage and platform caching approval
are separate deployment decisions. Platform-native metadata does not require MusicBrainz public
service approval; it still requires the actual supported method and approved usage context.
The settings capability query is read-only and does not probe the network. Facts retain their
actual language, attribution, source link and permitted use/expiry; opening a page does not
automatically fetch missing material.

Stable `catalog.query` references connect local and platform song/artist/album pages to the same
entity panels. Ambiguous references require selection, not the first same-name result. Release
and album-project facts remain distinct; recording credits are not copied from an entire album.
Reference, credit, candidate and task lists are paged and revision-fenced. TaskCenter shows persistent
tasks 10 per page and demands 6 per page; cancelling withdraws only the selected demand, and
terminal requery uses explicitly selected current consumers. See
[M2.5](D:/Project/Twilight_Echo/docs/unified-music-library-m2.5.md).

### Collaborations appear under each credited artist

A local song credited to Alice and Bob appears on both artist pages, alongside
their solo songs; the joined display credit is not a third artist card. Artist
counts, search, album membership and full playback queues use the same members.
Repeated names within one credit count the song once per artist. Collection-card
references include only that card's artist, not their collaborators.

Structured `Track.artists` takes priority, followed by saved multi-value audio-file
artist tags (including paired NCM file credits). These are names, not confirmed
provider identities; parallel MusicBrainz ID arrays are never zipped. CUE tracks
keep their own performer credits. Existing profiles re-project retained file tags
through bounded catalog maintenance without rescanning audio. A split credit never
inherits the old composite artist's identity or manual image/introduction; unchanged
named artists retain their existing source entity and overrides.

Literal band names containing punctuation stay intact. Without structured credits,
the existing spaced ` / ` separator is
supported. An unspaced slash, ampersand or comma alone does not prove multiple
people: `AC/DC` and `Earth, Wind & Fire` remain intact. Original song display
credits and old full-credit links remain usable. Artist-specific `catalog.query`
continues to apply its exact `artistName` filter before pagination; callers that
omit it retain their broader collection-reference contract.

Manual introductions, explicit clear/hide and restore-automatic are distinct operations.
Automatic facts never overwrite personal values; restoring automatic only removes the override
and rereads saved facts. Personal pictures and per-entity introduction-source preferences live
in SQLite, independent of playback source preferences. A preference selects existing permitted
text, not a new network source. Personal music backup preserves these values and known-provenance
imported text; automatic/restricted caches and jobs are excluded. Unknown old Rhine prose needs
per-version rights review before export. See
[M5.2](D:/Project/Twilight_Echo/docs/unified-music-library-m5.2.md).

## Cancellation Fences Remain Necessary Across Processes

`LibraryMetadataEnrichmentQueue` supplies an `AbortSignal` to provider adapters and aborts every
active controller on cancellation. This is used when an adapter supports request aborting.

Production Core forwards the signal to `plugins.callProvider`; the plugin manager propagates
cancellation to queued/active host RPC. An adapter may still finish work that it cannot physically
abort. Queue generation checks, source comparisons and database CAS therefore remain required
even with transport cancellation. Entity tasks additionally check durable generation, current
consumers and usage context at publication. Shutdown joins accepted writes; a client disconnect
does not reinterpret an accepted durable job as cancelled.
