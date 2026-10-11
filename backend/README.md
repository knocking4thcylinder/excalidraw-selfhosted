# Elixir persistence API

Phoenix HTTP endpoint + Ecto/SQLite API for rooms, folders, short codes,
encrypted scene snapshots and encrypted room images. It replaced the original Node `shortcode/server.js`,
which has been removed. The React frontend and Socket.IO collaboration service
are separate.

## Compatibility

- Existing room registration/list/rename/delete, nested folder operations, short-code creation/resolution/redirects, scene GET/HEAD/POST, and recovery history endpoints.
- Room-key authorization and case normalization match the retired Node service.
- Encrypted snapshots stay opaque; the service does not decrypt drawings.
- SHA-256 ETags match the existing API. GET supports `If-None-Match`; authentication runs before conditional responses.
- Ten previous checkpoints and the empty-overwrite guard are retained. A checkpoint's patch tail stays recoverable in history.
- JSON responses have explicit Content-Length. No API response is publicly cached.
- Successful scene writes increment a durable `X-Scene-Revision` header. This is a server revision, not Excalidraw's element-version sum.
- Malformed JSON returns 400, request bodies over 5 MiB return 413, unknown routes return 404. Short-code targets are restricted to HTTP(S); `/s/<code>` redirects only to `/#room=…` on this site, whatever host the stored URL names. Deleting a room deletes its short codes and image files.
- Room images: `PUT /api/rooms/:id/files/:fileId?key=...` stores the raw encrypted blob (`application/octet-stream`, up to 5 MiB); `GET` on the same path returns it. Blobs live in the `room_files` table.
- `HEAD /api/rooms` is a body-less reachability probe for offline clients.
- The server is trusted: it stores room keys and `GET /api/rooms` returns them, so the encryption does not protect rooms from anyone who can reach this API.

SQLite WAL replaces synchronous rewriting of the whole JSON collection with
transactional per-record writes. Historical snapshots are separate records, so
loading the current drawing does not read or decode its history. Optional
encrypted patches avoid full routine uploads and cached-room downloads. Patch
tails are stored separately, so each patch does not rewrite the checkpoint or
copy it into history. A single
database connection serializes read-modify-write operations to prevent lost
updates. This is appropriate for the initial single-Deck service, not a claim
of measured loading-time improvement or a multi-node storage design.

## Development

Requires Elixir 1.18 / OTP 27, Hex, and a C compiler when an SQLite native binary
is unavailable.

```bash
cd backend
mix deps.get
mix test
mix format --check-formatted
mix run --no-halt
```

Default binding is `127.0.0.1:3003`; Caddy remains the TLS/public boundary.
Use `PORT=3004` for development alongside the deployed backend.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3003` | HTTP port |
| `BIND_ADDRESS` | `127.0.0.1` | Listener address |
| `DATABASE_PATH` | `data/whiteboard.sqlite3` | SQLite database |
| `LEGACY_DATA_DIR` | unset | One-time import of existing JSON data |
| `SCENE_SYNC_ENABLED` | `false` | Advertise and accept encrypted incremental saves |

## Incremental scene sync

Deploy the updated app first and refresh clients before enabling this opt-in:

```bash
SCENE_SYNC_ENABLED=true ./deploy.sh backend --local
```

The deployment remembers the flag in `.scene-sync-enabled`. Ordinary backend
deployments retain it; set `SCENE_SYNC_ENABLED=false` explicitly to disable new
patches. This does not automatically deploy the frontend.

- `GET /api/rooms/:id/scene?key=...&sync=1` returns an encrypted checkpoint and patch chain. `since=<ETag>` returns only a retained patch tail when possible; old/unknown baselines receive the checkpoint. Unchanged scenes still return 304.
- `X-Scene-Sync: 1` advertises support, including on an authenticated missing-scene response. Deployments without the flag continue using full snapshots.
- `PATCH /api/rooms/:id/scene` accepts `{key, syncVersion: 1, baseEtag, iv, ciphertext, sceneVersion, isEmpty: false}`. The decrypted client-side payload contains versioned upserts, removed IDs, and optional ordering. The API never decrypts it.
- Both incremental saves and sync-aware full checkpoints compare `baseEtag` transactionally. Stale writers receive 412, not silent overwrites. The frontend reloads the latest state, merges local edits, and discards queued pre-conflict snapshots before saving again.
- Clients checkpoint after 32 patches, or when a patch is at least 60% of a full scene. The server bounds accumulated patch ciphertext to 5 MiB; 413 asks the client to send a revision-checked checkpoint instead. History advances on checkpoints, not every patch.
- The existing 5 MiB request-body limit still applies to full checkpoints. Clients reject oversized scenes before extending a chain that could no longer be checkpointed. Large normal requests avoid browser keepalive's smaller upload budget; local drafts remain the recovery path during tab close.
- An old client cannot reconstruct an active patch chain. Legacy GET/POST requests return 409 instead of serving or overwriting a stale checkpoint. Refresh all clients when enabling sync. Disabling new patches still permits reading existing chains and checkpointing them on the next updated-client save.

The first uncached load still needs a checkpoint. This is a protocol improvement,
not a measured end-to-end loading-time claim. Browser caches/drafts remain
important when no server is reachable.

## Safe preview without changing production

From the repository root:

```bash
sudo podman build --layers -t excalidraw-api-elixir backend
mkdir -p .build-cache/elixir-preview
sudo podman run -d --name excalidraw-api-preview --network host \
  -e PORT=3004 -e LEGACY_DATA_DIR=/legacy \
  -v "$PWD/shortcode-data:/legacy:ro" \
  -v "$PWD/.build-cache/elixir-preview:/data" \
  excalidraw-api-elixir
curl --fail http://127.0.0.1:3004/api/rooms
sudo podman rm -f excalidraw-api-preview
```

After building the image,
`RUN_BACKEND_CONTAINER_TESTS=1 node --test backend/test/container.test.cjs` verifies
the release over real HTTP, JSON import, restart persistence, and export
using an isolated temporary database and an ephemeral loopback port.

For a consistent import, use a copy made while the old Node service is stopped,
or an existing known-good backup, instead of reading actively changing files.
Never point two backend processes at the same SQLite database.

## Deployment

```bash
./deploy.sh backend --local
```

Deployment builds the release image before stopping the old backend, backs up
the data directory while the service is stopped, and reuses the existing
`excalidraw-shortcode` container name, port, systemd unit and Caddy routes.
The previous container is retained until the health checks pass; a failed
deployment restores it. A database created during a failed first cutover is
moved into the backup directory, so a retry cannot silently reuse stale
imported data. `install.sh` (and therefore `reinstall.sh`) runs the same image.

### Cutover from the retired Node service

A Deck that still runs the Node container has its data in `codes.json`,
`rooms.json`, `folders.json`, and `scenes.json` under `shortcode-data/`. The
first Elixir start imports them (`LEGACY_DATA_DIR=/data`) in one transaction.
It preserves room keys, codes, timestamps, folder parents, and snapshot
history; legacy string folder names are converted to objects. Missing files
are empty collections. Invalid JSON aborts startup and rolls back the whole
import, so the deployment restores the Node container. A completed-import
marker prevents stale JSON from overwriting SQLite on restarts. Source files
are never modified.

**After cutover SQLite is authoritative. JSON files are not kept in sync.**
Once the deployment succeeds the old container is removed; the leftover
`shortcode-server.js` and the JSON files can then be archived or deleted.
Returning to Node would mean checking out a commit from before its removal and
following that revision's rollback instructions.

### Backups and export

Each backend deployment copies `shortcode-data/` into `recovery/`. For a
portable JSON copy, stop the service and export into a fresh directory:

```bash
sudo systemctl stop excalidraw-shortcode.service
mkdir -p recovery/elixir-export
sudo podman run --rm --network host \
  -v "$PWD/shortcode-data:/data" \
  -v "$PWD/recovery/elixir-export:/export" \
  excalidraw-api-elixir /srv/bin/whiteboard eval \
  '{:ok, _} = Application.ensure_all_started(:whiteboard); Whiteboard.Export.run!("/export")'
sudo systemctl start excalidraw-shortcode.service
```

The export preserves opaque patch chains and history; the service never
decrypts scenes.

The API retains the existing tailnet trust model: room lists include keys and
short codes store full keyed URLs. This is not an internet-facing authenticated
service. Restrict filesystem access to data/backups and do not expose the API
directly to an untrusted network.
