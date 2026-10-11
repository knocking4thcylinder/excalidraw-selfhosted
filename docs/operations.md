# Operations

Everything you need to deploy, update, and recover the stack on the Steam Deck.
For first-time setup, see the [README](../README.md#quick-start).

## Deploying updates

Commit under `app/` (or packaging), push `master`, then on the Deck:

```bash
cd ~/excalidraw && ./deploy.sh   # git pull (when a checkout) + rebuild + swap + HTTPS checks
```

No bundles: the Deck updates via `git pull`, falling back to files synced
from the Mac.

For smaller updates, deploy only the affected component:

```bash
./deploy.sh app       # build/swap frontend only; leave backend and proxy running
./deploy.sh backend   # rebuild/swap the Elixir API; no frontend build
./deploy.sh full      # default: frontend + shortcode backend + proxy routes
./deploy.sh app --local  # deploy working-tree files without git pull
```

Selective modes still pull the whole checkout unless `--local` is passed, but
only deploy the selected component. Use `full` for changes spanning components
or proxy routes. `backend` updates the shortcode/rooms API, not the external
`excalidraw-room` collaboration image. The API backend is the Elixir/SQLite
service in `backend/`; the former Node service has been retired. On a Deck
still running Node, the first backend deployment imports its JSON files into
SQLite once and restores the old container if the health checks fail. See
`backend/README.md` for preview, JSON import, backups, and recovery.
Each deployment prints stage timings, including dependency and frontend builds.
On Podman's `vfs` driver, builds automatically use a reusable, pinned Node
container with a host-mounted `.build-cache/` workspace. Source files are synced
without touching the checkout's dependencies or build output. Dependencies
persist between builds; only the small nginx runtime image is rebuilt. The
builder stops after each build and restarts on demand. This path requires rsync,
but does not require Node or Yarn on the host.

Other storage drivers retain the multi-stage container build. Override selection
with `DEPLOY_BUILD_MODE=fast` or `DEPLOY_BUILD_MODE=container`. Both paths key
dependency caching by the lockfile, workspace manifests, and pinned Node image;
the first build populates the cache, and source-only changes skip installation.
The container path retains dependencies under the `excalidraw-build-deps` image
tag. Workspace additions must also be listed in the Dockerfile's manifest stage
(`node --test deploy.test.js` checks this).
To validate a build without changing the deployment image tag, run
`DEPLOY_IMAGE_TAG=excalidraw-verify ./deploy.sh build`; no live containers are swapped.

Image cleanup is no longer part of each deployment. The next deployment (or
`./deploy.sh start`) installs the weekly cleanup timer. To clean up immediately,
run `./deploy.sh cleanup` manually.
Cleanup preserves tagged images (including dependencies) and refuses to run
during a deployment/build. Fast builds require 6 GiB of free space; multi-stage
builds require 12 GiB. Both the workspace and Podman storage filesystems are
checked. Override the threshold with `DEPLOY_MIN_FREE_KB` (KiB)
only when sufficient space is available for your storage driver.

## Recovery and diagnostics

The whole stack is managed by a boot-enabled systemd service:

```bash
sudo systemctl status excalidraw-stack
sudo systemctl restart excalidraw-stack  # restart all four containers
sudo systemctl stop excalidraw-stack     # stop all four containers
sudo systemctl start excalidraw-stack
sudo systemctl start --no-block excalidraw-deploy  # build and deploy in the background
sudo systemctl status excalidraw-deploy           # deployment result and recent logs
```

The stack service is a coordinator (`active (exited)` is normal); each component
has its own continuously supervised service. Deployment is on-demand only,
not run on every boot. In a synced directory without `.git`, it builds local files.

```bash
./deploy.sh start   # restore boot services and start existing containers; no rebuild
./deploy.sh status  # container/service state and verified HTTPS app, room, API checks
./deploy.sh logs    # recent logs for all four services
```

Always use `https://<deck>.<tailnet>.ts.net:8443` on the tablet with
Tailscale connected. Port 443 may serve another application. If the app works
locally but the tablet cannot connect, check the HTTPS proxy with `status`;
`start` repairs missing systemd units, including the Caddy unit, so the stack
starts after reboot. It also renews the TLS certificate when it has less than
seven days remaining, and installs a daily certificate-renewal timer.

`./deploy.sh build` builds only the app image.

Deploying builds the local files as they are; it does not download GitHub
updates. Run `git pull` in a checkout of
`knocking4thcylinder/excalidraw-selfhosted` first to pick them up.
Deployment preserves `shortcode-data/` and prevents concurrent deployments.

## Pulling upstream Excalidraw

`app/` is the former `excalidraw-selfhosted-fork`, merged as a git subtree with
full history (see `git log -- app`). To pull upstream changes:

```bash
git subtree pull --prefix=app https://github.com/excalidraw/excalidraw.git <tag-or-main> --squash
```

`--squash` keeps upstream history out of our log; drop it to keep full
history. The old `excalidraw-selfhosted-fork` remote is frozen/archive.

## Runtime files

`~/excalidraw` on the Deck is this repo's checkout (branch `master`). Runtime
files live next to it and are never committed:

| Path | Contents |
| --- | --- |
| `shortcode-data/whiteboard.sqlite3` | rooms, folders, short codes, encrypted snapshots and images — **contains room keys** |
| `certs/` | Tailscale-issued TLS certificate and key |
| `Caddyfile` | generated from `Caddyfile.template` |
| `recovery/` | `shortcode-data/` backups taken by each backend deployment |
| `.build-cache/` | reusable frontend build workspace |

To restore a room from a local `.excalidraw` export, use
`node tools/restore-room.js <scene-url> <roomId> <roomKey> <export.excalidraw>`.
The previous snapshot is kept in history, so this is reversible.

## Hard-won lessons

Things that cost hours. Don't re-learn them.

- **SteamOS `/var` is a 230 MB partition.** Podman's root store must live on
  `/home`, and the `overlay` driver fails on `/home`'s filesystem here, so the
  installer sets **vfs** on `/home/containers/storage` and frees the old
  `/var/lib/containers` store. SteamOS updates wipe `/var` state;
  `reinstall.sh` re-runs the installer.
- **`crypto.subtle` needs a secure origin.** Plain-IP `http://` silently breaks
  "Start session" (no exception surfaces); hence HTTPS and the MagicDNS name
  everywhere.
- **The collab socket uses the page's own origin.** Production builds leave
  `VITE_APP_WS_SERVER_URL` empty, Caddy routes `/socket.io/*` to the room
  server, and the app image ships its own nginx config
  (`app/excalidraw-app/nginx.conf`); nothing is patched at container start.
- **Offline app shell.** The build enables Workbox/PWA precaching with runtime
  caches for fonts, locales and lazy chunks. A browser must load those once
  before it can launch offline; room-data caching alone does not make a
  first-ever visit work without the server.
- **Caddy path matchers.** `/api/code/*` does not match a bare `/api/code`
  request, hence the `*` without a slash in `Caddyfile.template`.
- **Single-file bind mounts.** `sed -i` inside the Caddy container fails with
  "Resource busy" (temp-file rename); edit the host file and restart the
  container.
- **Proxy/TUN apps on the Mac** (Happ etc.) hijack `100.64/10` and DNS. The
  per-peer `/32` route daemon and the hosts entry neutralize both.
- **vfs layers pile up.** Builds on vfs consume disk fast; the weekly cleanup
  timer and free-space checks exist because the disk filled once.
