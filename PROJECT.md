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
                                               ├─ Caddy :8443 (TLS, domain steamdeck.example.ts.net)
                                               ├─ excalidraw app (nginx :3000)
                                               ├─ excalidraw-room (socket.io :3002)
                                               └─ short-code service (node :3003)
```

- **URL:** `https://steamdeck.example.ts.net:8443`
- **Join a room:** full link *or* a short code like `7QU6-38SK` (server-side map,
  codes persisted in `~/excalidraw/shortcode-data/codes.json` — this file also
  keeps room keys, so E2E purity is traded for link brevity)
- **Live sync:** the forked Excalidraw connects to the room dialect on
  `wss://...:8443/socket.io/<roomID>` — one websocket per client; mirrored
  drawing happens over that (system-socket only, no autosave)
- **My Rooms:** server-side room registry + encrypted scene snapshots in the
  short-code service (`rooms.json` + `scenes.json` in `~/excalidraw/shortcode-data`,
  new `/api/rooms*` endpoints). The fork auto-registers a room when it becomes
  active and auto-saves encrypted snapshots (same cadence as the old firebase
  path); the ShareDialog lists rooms across devices. Note: rooms created
  before this feature appear in the list once anyone joins them again.

## The repo (monorepo, private: github.com/knocking4thcylinder/excalidraw-selfhosted, branch `master`)

`~/excalidraw` on the Deck IS this repo's checkout. The former
`excalidraw-selfhosted-fork` was merged in as `app/` via `git subtree add`
(full history preserved, incl. the Firestore-load fix `891781cd`); its old
remote is frozen. Upstream pulls: `git subtree pull --prefix=app
https://github.com/excalidraw/excalidraw.git <tag> --squash`. No bundles:
the Deck updates via `git pull` inside `redeploy.sh` (needs one
read credential for this private repo; otherwise sync files from the Mac).

1. **Packaging** (repo root):
   - `install.sh` — canonical Deck installer. Idempotent. Handles:
     - SteamOS quirks: disables rootfs readonly prerequisite, moves podman's
       root store from `/var` (230 MB!) to `/home/containers/storage`,
       forces the `vfs` storage driver (overlay fails on `/home`'s FS)
     - Tailscale cert as user `deck` (Tailscale runs userspace, no sudo)
     - Caddyfile with `:8443` TLS and reverse-proxy routing: `/s/*`,
       `/api/code*`, `/api/resolve*`, `/api/rooms*` → shortcode svc;
       `/socket.io/*` → room; `/` → app
     - Runtime patch of the Excalidraw JS bundle: replaces
       `https://oss-collab.excalidraw.com` with `wss://$FQDN:8443` and **verifies
       zero remaining `oss-collab` references** before starting nginx (tripwire)
     - systemd units (`excalidraw.service`, `excalidraw-room.service`,
       `excalidraw-caddy.service`, `excalidraw-shortcode.service`) with
       `Restart=always`, `WantedBy=multi-user.target`
     - `reinstall.sh` — post-SteamOS-update recovery (re-runs `install.sh`)
   - `mac/install-mac.sh`, `mac/fix_ts_routes.sh`, `mac/com.fixtsroutes.plist` —
     a LaunchDaemon (`user.fixtsroutes`) that, **every 20 seconds**, asserts a
     `/32` host route through the current Tailscale utun interface for every
     peer in `tailscale status`. Needed because proxy/TUN apps on the Mac
     (Happ/Xray TUN mode) hijack `100.64/10` and DNS; also adds a hosts entry
     `steamdeck.example.ts.net → 100.64.0.10`.
   - `shortcode/server.js` — tiny HTTP service: `POST /api/code {url}` mints a
     code; `GET /api/resolve/<code>` returns the full room URL as JSON (used by
     the Join-room UI via `fetch`, deliberately *not* a page navigation to avoid
     service-worker interception); `GET /s/<code>` returns a 302 to the room.
     Plus the My Rooms registry: `POST /api/rooms` (register/touch a room),
     `GET /api/rooms` (list, most-recent first),
     `POST /api/rooms/<roomId>/rename` and `DELETE /api/rooms/<roomId>` (rename/delete),
     `POST /api/rooms/<roomId>/scene` + `GET /api/rooms/<roomId>/scene`
     (save/load an encrypted snapshot), `GET /api/rooms/<roomId>/scene-history`
     — registry in `rooms.json`, snapshots in `scenes.json`. Snapshots are
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
     handle `blob:`), VIEW-intent filter for `steamdeck.example.ts.net`
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
   - **Workbox/PWA plugin disabled** (`vite.config.mts` + dropped the
     `registerSW` import in `index.tsx`): redeploys now reach clients as plain
     network loads, no service-worker interception, no stale-cache dance.
     Trade-off: no offline cached app shell.
   - **Firebase saves disabled** (`data/firebase.ts`, opt-in
     `VITE_APP_ENABLE_FIREBASE_SAVE=true` to re-enable): the OSS build's
     auto-snapshot of collab rooms into Excalidraw's public Firestore hit the
     1 MB doc limit on big boards and reported bogus "file too large" errors;
     now the room socket is the only store, devices keep local copies in
     browser storage.
   - No other functional changes; the app image (tagged `excalidraw-selfhost`)
     builds via `sudo podman build -t excalidraw-selfhost .` from this source.

## The machines (as of last verification, all contiguous)

- **MacBook** (`macbook`, `100.64.0.11`)
  - route-fixer daemon loaded as `user.fixtsroutes`
  - `/etc/hosts` entry `steamdeck.example.ts.net → 100.64.0.10`
  - `~/src/excalidraw/` ← this repo on disk (monorepo)
- **Steam Deck** (`steamdeck`, `100.64.0.10`) — runs the live stack; has
  passwordless `sudo podman` via `/etc/sudoers.d/deck-podman` (they ran the
  chmod). `/home/excalidraw/install.sh` matches the repo (md5 equal).
- **Android tablet** (`tablet`, `100.64.0.12`) — Excalidraw APK v1.4
  installed (package `com.k4c.excalidraw`, UJA10 146), **wireless adb** over
  its tailnet IP `100.64.0.12:5555` (USB-cable re-plug + `adb tcpip 5555`
  needed once if the daemon resets).

## Reproduction / redeploy one-liners

| On | Command |
|---|---|
| Deck (first ever run) | `sudo steamos-readonly disable` then `bash ~/excalidraw/install.sh` |
| Deck (after fork/image change) | `bash ~/excalidraw/redeploy.sh` |
| Post-OS-update wipe on Deck | `bash ~/excalidraw/reinstall.sh` (just calls install.sh) |
| Mac network fixes | `sudo bash ~/src/excalidraw/mac/install-mac.sh` |
| Android APK build + install | `cd android && ./build.sh && adb install -r build/Excalidraw.apk` |

## Incident 2026-09-11: rooms opened empty (root causes, all fixed)

1. **Boot race — double `startCollaboration`, null wins** (`app/.../Collab.tsx`).
   On boot the dialog fires twice ~20ms apart. The 2nd call saw the fresh
   socket and resolved `null` instantly, beating the real snapshot load, so
   the canvas stayed empty forever. Fix: an in-flight load for the SAME room
   is now shared (`pendingScenePromise` + `pendingSceneRoomId`, captured
   synchronously — `portal.roomId` is assigned too late, after the
   socket.io import). Different-room and settled-load behavior unchanged.
2. **Ghost campers fed empty INITs.** Stale tabs with empty scenes held rooms
   open; joiners resolved to their empty INIT and discarded the snapshot
   (resolved promises can't be un-resolved). Fix: an empty reconciled INIT
   now falls back to the stored snapshot; live non-empty content still wins.
3. **Duplicate rootless `excalidraw-room` container** fought the canonical
   root one for `:3002` (crash loop). Never run bare `podman` on the Deck —
   always `sudo podman` (rootless + root runtimes share host networking).
   Fixed + `/etc/sudoers.d/deck-podman` (NOPASSWD podman/systemctl/tee).
4. **Stale bundles pinned by HTTP cache.** `index.html` is now `no-store`,
   hashed assets `immutable` (entrypoint injects the nginx policy).
5. **Monorepo.** The fork is `app/` (subtree, full history); the Deck's
   `~/excalidraw` IS this repo. No bundles. `excalidraw-selfhosted-fork`
   remote is frozen; local `./excalidraw-fork` (nested, gitignored) remains
   the upstream-tracking clone (`git subtree pull --prefix=app …` for
   upstream updates). Repo lives at `~/src/excalidraw/`.

## Known trade-offs / gotchas worth inches if extending

- **Server-side scene persistence is one encrypted snapshot per room** (the My
  Rooms feature above) — not full history, and only for rooms registered after
  the feature shipped. The live socket is still the realtime store. (Before
  this: a room's scene existed only in the socket and each client's browser
  storage; reload == lose room if no one kept it open.)
- **Firestore size ceiling was the cause of "file too large" on big boards** —
  now gone (see fork commit `5eff2067`).
- **Service worker was REMOVED from the fork** (commit "disable Workbox"), so
  after every image rebuild all clients pick up fresh bundles on next load —
  the `chrome://serviceworker-internals` + hard reload dance is only needed
  once more now (transitioning away from the SW), never again.
- **`crypto.subtle` needs a Secure Context**: `http://<ip>` or self-signed URL
  makes collab silently fail ("Start session" no-op). This is why Tailscale
  cert + the hostname (not IP) is pinned in all places.
- **Caddy path matchers**: `/api/code/*` does NOT match bare `/api/code` — the
  fork calls bare path, so the matcher must be `/api/code*` (no slash).
- **Caddyfile as a single-file bind mount**: `sed -i` inside a container fails
  ("Resource busy"); edit the host file, restart the container.
- **SteamOS updates wipe podman's `/var/...` state** — but the installer moves
  storage to `/home/containers/storage` (survives updates) and `reinstall.sh`
  regenerates containers from the fork clone in `~/excalidraw/fork`.

## Where I'd go next (for a successor model)

The obvious stretch goals, all in the fork or the packaging repo, roughly in
value order:

1. ~~**Persistent scene storage on the Deck**~~ — **DONE** as the My Rooms
   feature (see "What exists"): the short-code service gained `/api/rooms*`
   endpoints storing one encrypted snapshot per room (`scenes.json`), the fork
   auto-saves at the old firebase cadence; no new container was needed.
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
