# Excalidraw self-hosted: Steam Deck + Android tablet + MacBook

Self-hosted collaborative whiteboard stack. Excalidraw (app + collab room) runs on
a Steam Deck under podman, exposed over HTTPS on the tailnet via a Tailscale-issued
certificate; an Android WebView app (HarmonyOS-compatible) wraps the tablet side;
Mac-side network fixes make Tailscale coexist with proxy/TUN apps.

Result: draw with a stylus on the Android tablet, live mirror on any device in the
tailnet. No external services.

```
                 tailnet (wireguard)
  Android tablet ────────────────► Steam Deck ──── Caddy :8443
   (APK wrapper, stylus)              │                │
                                      │                │ /socket.io/* → excalidraw-room :3002
   MacBook ───────────────────────────┘──► (mirror)     └─ anything else → app :3000
```

## Components

| Path | What |
|---|---|
| `install.sh` | Full Deck installer: storage setup (vfs on `/home`), Tailscale cert, Caddy TLS proxy, app + room containers, systemd units, patch-the-bundle tripwire, `reinstall.sh` for post-OS-update recovery |
| `mac/` | Mac-side: persistent route fixer LaunchDaemon (kept Tailscale alive under proxy/TUN apps like Happ) + `/etc/hosts` entry |
| `android/` | WebView APK source + reproducible build script (fetches Android SDK cmdline-tools, builds + signs) |

## Deck setup (one-time)

```bash
sudo steamos-readonly disable   # once
./install.sh
```

Reproducible after a SteamOS update wipes container state:

```bash
~/excalidraw/reinstall.sh
```

URL: `https://<this-host>.<tailnet>.ts.net:8443`

## Android app

```bash
cd android && ./build.sh   # installs cmdline-tools locally on first run, builds signed APK
adb install build/Excalidraw.apk    # or copy to tablet and tap it
```

Requirements on the tablet: Tailscale app signed in to the tailnet (for the tailnet
route + the Tailscale CA that validates the `ts.net` certificate). Minimum Android/Arc:
HarmonyOS 2.0 was verified.

## MacBook setup

```bash
cd mac && sudo ./install-mac.sh
```

Installs LaunchDaemon `user.fixtsroutes` (re-asserts a `100.64/10` route through the
Tailscale utun interface every 20 s — defeats proxy/TUN-app route shadowing) and the
`/etc/hosts` entry mapping `steamdeck.example.ts.net` to the Deck's tailnet IP
(defeats DNS hijacking by TUN apps).

## Why pieces exist (gotchas that cost us hours)

- **SteamOS `/var` is a 230 MB partition** — podman's root store must live on `/home`
- **`overlay` storage driver fails on `/home`'s FS on this hardware** — use `vfs`
- **webcrypto (`crypto.subtle`) needs a secure origin** — plain-IP `http://` silently
  breaks "Start session"; hence the Tailscale cert + HTTPS everywhere
- **Excalidraw's collab URL is baked into the JS bundle** — the installer patches every
  bundle URL to `wss://<fqdn>:8443` and *verifies* by grepping for zero remaining
  `oss-collab.excalidraw.com` references
- **Service-worker cache** — after re-patching, clients must hard-reload / unregister
  the service worker once, otherwise they serve the stale bundle
- **proxy/TUN apps on the Mac (Happ etc.) hijack routes and DNS** — hence the daemon +
  hosts entry
