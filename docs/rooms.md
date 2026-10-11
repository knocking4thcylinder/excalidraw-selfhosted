# Rooms

How shared rooms, the Rooms Explorer, offline caching and scene sync behave.
For the HTTP API behind them, see [`backend/README.md`](../backend/README.md).

## Sharing a room

Start a session from **Live Collaboration → Start session**. The dialog shows
both the full room link and a short code such as `7QU6-38SK`. Either one works
in the **Join room** panel on another device. Short codes are resolved with a
`fetch` to `/api/resolve/<code>`, and `/s/<code>` redirects to the room.

## Rooms Explorer

**My rooms** displays an editor-style file tree, with expandable folders and
rooms nested beneath them. Click a folder to expand or collapse it; click a
room to open its drawing. Rooms without a folder appear at the root.

The explorer is a **Rooms Explorer** tab in Excalidraw's existing right sidebar,
alongside the library and canvas search. The existing top-right sidebar button
or **My rooms** opens it. The native pin and close buttons control docking and
visibility; there is no separate rail or half-screen panel. Compact tree rows,
icon-only actions, indentation guides, and right-click menus follow an editor
Explorer layout. **Expand all** and **Collapse all** control the whole tree.
Opening or creating a room keeps the explorer open.

Search finds rooms and folder paths across the entire tree, automatically
revealing matching branches without changing your saved expansion state.

Deleting a room opens an explicit confirmation naming the room; confirm to
remove it, or cancel to keep it. Deleting the current room disconnects its
session but keeps the drawing on the local canvas.

### Folders

Folders can be nested: select a folder and use **New folder** to create a
subfolder. Click the tree's heading to deselect the folder and create at the
root. Creation and F2 rename use an inline name field in the tree: Enter saves,
Escape cancels, and leaving a nonempty field saves it. Names must be unique
within the same parent, but may be reused in different branches.

Drag rooms or folders onto another folder to move them. While dragging, the
**Top level** target moves items back to the root. On tablets, the room's move
menu provides room moves without dragging. Destination menus show full paths.
A folder cannot be moved into itself or a descendant.

Select a folder to rename, move, or delete it. Deleting a folder also removes
its subfolders, but keeps all their rooms and drawings, moving them to
**Unfiled**.

Folders are shared across all clients of this instance, like the room
registry, and are stored in the backend's SQLite database.

### Keyboard

| Key | Action |
| --- | --- |
| Up / Down | move between rows |
| Right | expand a folder, or step into it |
| Left | collapse a folder, or jump to its parent |
| Home / End | first / last row |
| Enter / Space | open a room or toggle a folder |
| F2 | rename the focused room or folder |

## Caching and offline use

The room list appears independently of folder loading and stays visible during
background refreshes. The app warms the room list in the background and retains
it across sidebar closes, so reopening the explorer does not wait for a request.
Room lists and folder metadata persist in IndexedDB and appear while fresh
network requests run. Failed refreshes retain the available local metadata.

Up to 32 confirmed drawings persist by room and key, including their ETags.
Reopening a cached room displays the local drawing without waiting for server
validation; **Checking for updates…** remains visible until validation completes.
Cached room switches also restore the scene and cached images before the
collaboration client finishes loading; connection setup runs in the background.
The server validates the encrypted snapshot fingerprint and sends no drawing
payload when it is unchanged, even after a browser restart.

### Drafts

Edits made while validation runs are saved as separate room/key-scoped recovery
drafts. They merge with the validated snapshot before broadcasting or saving,
using the same reconciliation rule as live collaboration; unchanged cached
shapes removed from the server snapshot are not resurrected. Failed validation
preserves local work and resumes the existing reconnect flow. Room switches
ignore old responses; deleting a room clears its per-room cache and prevents a
closing session's delayed draft write from recreating it.

When a confirmed drawing is evicted from the cache, its draft is dropped with
it unless the draft still holds unsynced changes. Room sessions never write
into your personal (non-room) canvas.

Browser storage can still fail or be cleared/evicted: export important drawings
as backups. Cached drawings are stored locally as decoded data, alongside room
keys, like the existing canvas recovery storage. This is not an
encrypted-at-rest vault.

### Images

Room images persist by room, key and file ID. Previously cached images appear
without downloading again, and mixed requests download only missing files.
Local images are cached before upload and alongside recovery drafts, so failed
uploads do not discard the available local image data. Cached local images are
not treated as proof of a successful remote upload. Deleting a room also
deletes its cached images and blocks late attachment writes.

Attachments remain until their room is explicitly deleted (even if its
confirmed snapshot is evicted), to preserve recovery drafts; large image
libraries can consume browser storage. Cache failures fall back to downloads.
Local caching works with any API configuration. Uncached images, fonts and
features may still need the network.

## Saving and loading

Room joins merge saved snapshots with live peer updates. Failed snapshot
downloads show a connection error instead of being treated as empty rooms, and
incomplete joins cannot save a partial scene over the snapshot. Empty scenes
never replace a non-empty snapshot, and the server keeps the last ten versions
for manual recovery.

Downloads time out after 20 seconds without receiving data, rather than after
20 seconds total, so a slow but progressing transfer can finish. Empty-save
protection checks snapshot existence with a body-free HEAD request instead of
repeatedly downloading the entire drawing.

### Incremental scene sync (opt-in)

The backend supports encrypted partial updates:

```bash
SCENE_SYNC_ENABLED=true ./deploy.sh backend --local
```

Update the app and refresh clients before enabling it. Small edits upload only
changed shapes, removed IDs, and ordering when needed; cached-room downloads
request only patches since the confirmed ETag. Revision checks prevent stale
writers from overwriting concurrent saves, and periodic full checkpoints bound
the patch chain. Deployments without the flag retain full snapshots. Old
clients cannot read active patch chains and are rejected safely. See
[`backend/README.md`](../backend/README.md#incremental-scene-sync) for protocol
limits, and [`loading-benchmark.md`](loading-benchmark.md) for isolated loading
measurements and how to reproduce them.
