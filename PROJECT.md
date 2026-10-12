# Project: Self-hosted collaborative whiteboard (Excalidraw) — Steam Deck host + Android tablet + MacBook

## What exists

A working, reproducible stack for live multi-device drawing. The Excalidraw web app
(a fork with local modifications) plus its collab room server run in **podman
containers on a Steam Deck** (SteamOS). All traffic is HTTPS over
**Tailscale** (WireGuard tailnet), certificate issued via `tailscale cert` for the
host's MagicDNS name. No third-party services.

```
Android tablet (APK wrapper, stylus)
        │ per-app VPN (Tailscale App Connections)
        ▼
MacBook ── route-fixer daemon + /etc/hosts ──► Steam Deck
                                               ├─ Caddy :8443 (TLS, domain <deck>.<tailnet>.ts.net)
                                               ├─ excalidraw app (nginx :3000)
                                               ├─ excalidraw-room (socket.io :3002)
                                               └─ rooms/short-code API (Elixir :3003)
```

- **URL:** `https://<deck>.<tailnet>.ts.net:8443`
- **Join a room:** full link *or* a short code like `7QU6-38SK` (server-side map,
  codes persisted in `~/excalidraw/shortcode-data/whiteboard.sqlite3` — the
  database also keeps room keys; so does the room registry, which lists them to
  every client — the server can read every room)
- **Live sync:** the forked Excalidraw connects to the room dialect on
  `wss://...:8443/socket.io/<roomID>` — one websocket per client; mirrored
  drawing happens over that (system-socket only, no autosave)
- **My Rooms:** server-side room registry + encrypted scene snapshots in the
  API service (SQLite `~/excalidraw/shortcode-data/whiteboard.sqlite3`,
  new `/api/rooms*` endpoints). The fork auto-registers a room when it becomes
  active and auto-saves encrypted snapshots; image files are stored per room
  under `/api/rooms/<roomId>/files/<fileId>`; the Rooms page lists rooms across
  devices. Note: rooms created
  before this feature appear in the list once anyone joins them again.

## The repo (monorepo: github.com/knocking4thcylinder/excalidraw-selfhosted, branch `master`)

`~/excalidraw` on the Deck IS this repo's checkout. The former
`excalidraw-selfhosted-fork` was merged in as `app/` via `git subtree add`
(full history preserved, incl. the Firestore-load fix `891781cd`); its old
remote is frozen. Upstream pulls: `git subtree pull --prefix=app
https://github.com/excalidraw/excalidraw.git <tag> --squash`. No bundles:
the Deck updates with `git pull` before `deploy.sh` (or with files synced
from the Mac).

1. **Packaging** (repo root):
   - `install.sh` — canonical Deck installer. Idempotent. Handles:
     - SteamOS quirks: disables rootfs readonly prerequisite, moves podman's
       root store from `/var` (230 MB!) to `/home/containers/storage`,
       forces the `vfs` storage driver (overlay fails on `/home`'s FS)
     - Tailscale cert as user `deck` (Tailscale runs userspace, no sudo)
     - Caddyfile with `:8443` TLS and reverse-proxy routing: `/s/*`,
       `/api/code*`, `/api/resolve*`, `/api/rooms*` → shortcode svc;
       `/socket.io/*` → room; `/` → app
     - The app image is used as built: it carries its nginx config
       (`app/excalidraw-app/nginx.conf`, port 3000) and connects the collab
       socket to its own origin
     - Podman Quadlet units in `systemd/` (`excalidraw`, `excalidraw-room`,
       `excalidraw-caddy`, `excalidraw-shortcode`) with `Restart=always`,
       grouped under the boot-enabled `excalidraw-stack.target`; installed by
       `deploy.sh start`
     - `reinstall.sh` — post-SteamOS-update recovery (re-runs `install.sh`)
   - `mac/install-mac.sh`, `mac/fix_ts_routes.sh`, `mac/com.fixtsroutes.plist` —
     a LaunchDaemon (`user.fixtsroutes`) that, **every 20 seconds**, asserts a
     `/32` host route through the current Tailscale utun interface for every
     peer in `tailscale status`. Needed because proxy/TUN apps on the Mac
     (Happ/Xray TUN mode) hijack `100.64/10` and DNS; also adds a hosts entry
     `<deck>.<tailnet>.ts.net → <deck-tailnet-ip>`.
   - `backend/` — Elixir/SQLite HTTP service (replaced the original Node
     `shortcode/server.js`, which wrote `rooms.json`/`scenes.json`): `POST /api/code {url}` mints a
     code; `GET /api/resolve/<code>` returns the full room URL as JSON (used by
     the Join-room UI via `fetch`, deliberately *not* a page navigation to avoid
     service-worker interception); `GET /s/<code>` returns a 302 to the room.
     Plus the My Rooms registry: `POST /api/rooms` (register/touch a room),
     `GET /api/rooms` (list, most-recent first),
     `POST /api/rooms/<roomId>/rename` and `DELETE /api/rooms/<roomId>` (rename/delete),
     `POST /api/rooms/<roomId>/scene` + `GET /api/rooms/<roomId>/scene`
     (save/load an encrypted snapshot), `GET /api/rooms/<roomId>/scene-history`
     — registry, folders, codes and snapshots in SQLite. Snapshots are
      **versioned** (last 10 kept): every overwrite pushes the previous
      snapshot to history, fetchable via `GET .../scene?slot=N` (`0` =
      current) for manual recovery. **Empty scenes never replace a non-empty
      snapshot** (client declares `isEmpty`, server answers 409; the client
      also skips such saves) — lesson of the 2026-09-11 incident where
      post-restart empty joins clobbered two rooms.
   - `android/build.sh`, `android/app/...` — no-gradle APK builder. Downloads
     Google `cmdline-tools` first run, compiles with `aapt2`/`javac`/`d8`
     (SDK 34, min API 21 since HarmonyOS 2.0), signs with a locally generated
     keystore. A fallback to `dx` from build-tools 30.0.3 exists because the
     8.2.2-dev d8 in 34.0.0 NPE's on code with `NestHost` attribute chains;
     switching to `build-tools;35.0.0` d8 fixed it. Logs at `/tmp/build.log`.
     The APK is a **fullscreen WebView wrapper** (domain-pinned) with:
     `addJavascriptInterface` `AndroidBlobSaver` (writes `blob:` exports to
     MediaStore `Downloads/`, base64 → file, since DownloadManager can't
     handle `blob:`), VIEW-intent filter for `<deck>.<tailnet>.ts.net`
     room links, keep-screen-on, no cleartext traffic.

2. **`app/`** — ex-`excalidraw/excalidraw` snapshot (former fork repo,
   branch `main`, now a subtree; canonical — the local `selfhost` branch is
   retired), commits applied on top:
   - `excalidraw-app/share/ShareDialog.tsx` + `.../ShareDialog.scss` — new
     "Join room" panel (accepts full link *or* short code via `/api/resolve`,
     validation, error messages), room-code display with Copy in the active
     session dialog, layout/spacing fixes. Multiline React-controlled inputs —
     **the file must be edited carefully: puppeteer's DOM '.value=' injection is
     not enough** — tests must type into inputs like real users (keyboard
     events), and the bundle is React-minified.
   - `packages/excalidraw/locales/en.json` and `ru-RU.json` — all new strings
     (button_joinSession, joinLinkLabel, roomCode, error_invalidLink, etc.)
   - **Workbox/PWA enabled** for an offline app shell (`vite.config.mts`,
     `registerSW()` in `index.tsx`); nginx serves `index.html` as `no-store`
     and revalidates the service worker so redeploys reach clients.
   - **Firebase removed**: scenes and images persist only in the self-hosted
     API (SQLite); devices keep local copies in browser storage.
   - The app image (tagged `excalidraw-selfhost`) builds via
     `sudo podman build -t excalidraw-selfhost .` from this source.

## The machines

- **MacBook**: route-fixer daemon loaded as `user.fixtsroutes`, plus an
  `/etc/hosts` entry mapping the Deck's MagicDNS name to its tailnet IP.
- **Steam Deck**: runs the live stack. Passwordless `sudo podman` comes from a
  sudoers drop-in (`<user> ALL=(root) NOPASSWD: /usr/bin/podman`).
- **Android tablet**: the Excalidraw APK (package `com.k4c.excalidraw`), with
  **wireless adb** over its tailnet IP on port 5555 (USB re-plug +
  `adb tcpip 5555` needed once if the daemon resets).

## Reproduction / redeploy one-liners

| On | Command |
|---|---|
| Deck (first ever run) | `sudo steamos-readonly disable` then `bash ~/excalidraw/install.sh` |
| Deck (after fork/image change) | `bash ~/excalidraw/deploy.sh` |
| Post-OS-update wipe on Deck | `bash ~/excalidraw/reinstall.sh` (just calls install.sh) |
| Mac network fixes | `sudo ./mac/install-mac.sh` |
| Android APK build + install | `cd android && APP_HOST=<deck>.<tailnet>.ts.net ./build.sh && adb install -r build/Excalidraw.apk` |

## Known trade-offs / gotchas worth inches if extending

- **Server-side scene persistence is one current snapshot per room plus the
  last 10 versions** (the My Rooms feature above), only for rooms registered
  after the feature shipped. The live socket is still the realtime store. (Before
  this: a room's scene existed only in the socket and each client's browser
  storage; reload == lose room if no one kept it open.)
- **Firestore size ceiling was the cause of "file too large" on big boards** —
  Firebase is gone entirely now.
- **`crypto.subtle` needs a Secure Context**: `http://<ip>` or self-signed URL
  makes collab silently fail ("Start session" no-op). This is why Tailscale
  cert + the hostname (not IP) is pinned in all places.
- **Caddy path matchers**: `/api/code/*` does NOT match bare `/api/code` — the
  fork calls bare path, so the matcher must be `/api/code*` (no slash).
- **Caddyfile as a single-file bind mount**: `sed -i` inside a container fails
  ("Resource busy"); edit the host file, restart the container.
- **SteamOS updates wipe podman's `/var/...` state** — but the installer moves
  storage to `/home/containers/storage` (survives updates) and `reinstall.sh`
  rebuilds the images from the checkout.

## Where I'd go next (for a successor model)

The obvious stretch goals, all in the fork or the packaging repo, roughly in
value order:

1. ~~**Persistent scene storage on the Deck**~~ — **DONE** as the My Rooms
   feature (see "What exists"): the short-code service gained `/api/rooms*`
   endpoints storing encrypted snapshots per room (now in SQLite); no new
   container was needed.
2. **Client-side "Save to file" flows in the APK** — already partially done
   via blob-hook; could add an "Export PNG straight to Downloads" button using
   the same bridge (`AndroidBlobSaver.saveFile`).
3. **PWA add-to-homescreen manifest** without Workbox (small, but blocked on
   the lack of the manifest plugin inside the current Vite config — would
   instead ship a static `manifest.webmanifest` from `public/`).
4. **Windows/Linux clients** for the mirror — or a single "watch this room"
   kiosk page, e.g. on a second monitor.
5. **Tablet-side have "join" as default action, not "create"**: currently the
   app opens fresh canvas; handing the user a room link is a tap away, but a
   nicer UX would be "Room code?" first. Small UI change in the ShareDialog.
