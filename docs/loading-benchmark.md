# Isolated loading benchmark

## Physical Android profiling

The opt-in bundle now records bounded synchronous static/interactive canvas
render samples and explicit room-switch data/file readiness. These measure
JavaScript canvas command execution, not GPU completion or pixel presentation.
No profiler is attached in normal builds. Samples use the canvas's owner window.

`app/scripts/android-profile.js` can self-report through the isolated fixture
server, without WebView debugging or an APK replacement. Build with
`VITE_APP_LOADING_BENCHMARK=true`, point `VITE_APP_WS_SERVER_URL` at the isolated
HTTPS origin, and launch `app/scripts/loading-benchmark.cjs` with matching
`BENCH_PORT` and an isolated `BENCH_BUILD_DIR`/`BENCH_DATA_DIR`. Choose unused API
and socket ports as well. The HTTPS certificate must be trusted by the tablet.

Open the printed large-room fixture URL in the Android wrapper, adding
`androidProfile=1` to its query string. The runner warms both synthetic rooms,
measures three cached switches each, then performs two 120-step programmatic
horizontal pans per scene at 10% zoom, capped at 45 seconds per pan. Partial
samples identify their completed step count; progress is posted every ten steps.
Hash changes are dispatched in-document
to avoid the wrapper's external-origin navigation restriction. The result route
stores startup, cached switches, canvas samples, animation-frame intervals,
long tasks, errors, and a completion record in `results.json`.

This is an API-driven benchmark, not touch/stylus input latency. Animation-frame
intervals measure callback scheduling, not display FPS, and double-rAF values
remain paint opportunities only. Scene IDs prevent a stale source scene from
being mistaken for the destination. Readiness waits also verify fixture element
counts, image files and absence of the validation status indicator. The first
navigation is not a process-cold launch, and no caches are cleared automatically.

Before temporarily navigating away from a real drawing, export a safety copy
and retain its room URL locally. Return to that URL after testing. Never open
the fixture reset route on the production origin, replace production with this
unauthenticated runner, or interpret synthetic-scene results as real-drawing
latency. Keep the runner reachable only by trusted test devices and shut down
its own server/containers after collecting results.

### Android observations — October 3, 2026

The installed Huawei AGS6_W09 Android 10 wrapper loaded an isolated instrumented
bundle in its existing process, using Huawei WebView/Chromium 114.0.5735.196.
The landscape viewport was 1920 × 1200 device pixels. The fixture API and socket
containers were separate from production; no production storage was reset.

| Measurement                                               |          Samples | Result                           |
| --------------------------------------------------------- | ---------------: | -------------------------------- |
| Cached large-scene data/file readiness                    |       3 switches | 464 ms median (448–478 ms)       |
| Cached image-scene data/file readiness                    |       3 switches | 1,285 ms median (1,280–1,286 ms) |
| Large-scene synchronous static canvas work during one pan |  92 render calls | 167.5 ms median; 188.2 ms p95    |
| Interactive overlay work in the same pan                  | 102 render calls | 0.5 ms median; 0.7 ms p95        |
| Animation-frame callback intervals in the same pan        |    120 intervals | 366.7 ms median; 866.7 ms p95    |

The measured pan completed in 46.4 seconds with all 2,400 shapes visible at 10%
zoom. There were 148 observed long tasks, with a maximum duration of 620 ms.
The first navigation reached scene availability at 4,137 ms; this was not a
process-cold launch. Scene validation requests on warmed switches returned 304
with zero scene-body bytes; server processing is not equivalent to device
round-trip time. Switches used the actual hashchange application path, not the
Rooms Explorer's trusted-click path, so these are not interchangeable benchmarks.

Static canvas work is much more expensive than the measured interactive overlay
in this sample. The static timing includes element traversal and synchronous
canvas command submission; it excludes pre-render React work, asynchronous GPU
completion, and display presentation. This narrows the investigation, but does
not identify shape-cache misses, rasterization, GPU stalls, or a specific function
as the root cause. Callback intervals must not be converted into display FPS.

The device reported thermal status 2 during testing, so thermal conditions may
affect these numbers. Only one large-scene pan was captured: a subsequent reload
failed with `net::ERR_NAME_NOT_RESOLVED`, preventing a full repeated/image-pan
series. The original production drawing was restored from its retained room URL
and appeared from cache with an offline-waiting-for-sync indicator. A safety
export was verified before navigation. No APK install or production deployment
was needed. Raw results are retained locally in
`/tmp/excalidraw-android-benchmark/profile-results.json`.

## Desktop loading results

Measured October 3, 2026, using the shared T3 Chromium/Electron desktop preview
at 1280 × 800. These are synthetic-room measurements against isolated Elixir and
Socket.IO containers, **not production results or a comparison with the old app**.
No production drawing data was read or modified.

## Results

Times start at document navigation. “Scene available” means nondeleted elements
arrived at the editor's `onChange` callback; “images available” means every image
element has its file data in the editor. Neither metric proves pixels were painted
or that the editor is fully interactive.

Controlled slow-data runs use a 1,500 ms delay per scene GET and image request,
plus an aggregate 1 MiB/s response-body budget. App-shell assets are not throttled.
JavaScript and CSS have warm HTTP/service-worker caches in these runs.

| Scenario                                                          | Samples |               Scene available |    All images available |   Scene response body | Image downloads |
| ----------------------------------------------------------------- | ------: | ----------------------------: | ----------------------: | --------------------: | --------------: |
| Large room, cold room-data cache, slow data                       |       3 | 4,703 ms median (4,692–4,725) |                       — |       2,902,780 bytes |               0 |
| Large room, cached reopen, slow data                              |       2 |       241 ms median (240–242) |                       — |     0 bytes, HTTP 304 |               0 |
| Large room, cached reopen with one remote shape change, slow data |       1 |                        262 ms |                       — |           1,589 bytes |               0 |
| Large room, cached reopen with API unavailable                    |       1 |                        256 ms |                       — | HTTP 503 error bodies |               0 |
| Image room, cold room-data/image cache, slow data                 |       1 |                      1,771 ms |                8,436 ms |          10,753 bytes |              16 |
| Image room, cached reopen, slow data                              |       3 |       106 ms median (106–120) | 153 ms median (143–158) |     0 bytes, HTTP 304 |               0 |
| Image room, cached reopen with API/assets unavailable             |       1 |                        100 ms |                  139 ms | HTTP 503 error bodies |               0 |

The large fixture contains 2,400 freedraw elements, 32 points each, occupying
2,175,811 plaintext JSON bytes. The image fixture contains 16 saved image elements
with procedural 256 × 256 PNGs: 3,609,504 encrypted asset bytes in total. Encryption
and envelope encoding match the app; the benchmark intercepts room image URLs
and serves synthetic encrypted assets locally.

The local large scene becomes available before validation, despite the 1.5-second
network delay. The genuine remote patch moves the first shape from x=0 to x=25;
that updated coordinate was verified after validation. Its response is approximately
99.95% smaller than the cold checkpoint response. This measures **downloaded tail
size**, not frontend save/upload latency. Unchanged reopens transfer no scene body.
Image reopens make no asset requests, rather than merely relying on HTTP caching.

API-unavailable runs return 503 for API/assets while the shell and collaboration
socket remain reachable. Cached scenes and all image file data are retained; a
trusted Rectangle toolbar click changes the active tool during this condition.
This is **not a full-device offline or offline drawing-persistence test**.

### Startup and measurement limitations

- The first unthrottled startup took 19,944 ms to scene availability. The editor
  mounted at 613 ms, but two lazy chunks started around 626 ms and took about
  18.8 seconds to finish. A subsequent unthrottled cached reopen still took
  10,587 ms. These are retained observations, not included in the warmed-shell
  slow-data table. The reason for those unusually delayed chunk requests is not
  established; caching alone does not guarantee fast first startup.
- Cold **room data** is not a cold browser/app-shell cache. Reset clears
  localStorage and IndexedDB, not HTTP caches or service-worker caches. One
  attempted reset was intercepted by the service worker and is excluded because
  it did not actually clear room data. Opt-in benchmark builds now exclude
  `/__bench/` navigations from the service-worker SPA fallback.
- Preview screenshot capture failed, paint entries were absent, and animation
  frames were inconsistently scheduled. Consequently two-rAF paint opportunities
  and the measured tool-response delay are **not accepted as visual readiness
  or interaction latency benchmarks**. Availability and response-body measurements
  are still recorded separately. No CPU/rendering bottleneck conclusion is drawn
  from the empty long-task list.
- The throttle buffers upstream bodies and schedules response chunks every 20 ms.
  It is a reproducible synthetic data-network model, not OS-level network emulation.
  Browser connection limits also affect concurrent image downloads.
- Sample counts are small and asymmetric. Results do not predict mobile devices,
  production networks, real drawings, or different browser storage conditions.
- The app shell still requests its normal external fonts and analytics. Those are
  not mapped to fixtures or covered by the data-network throttle.

## Reproduce

Dependencies: existing app dependencies, Node 18+, passwordless `sudo podman`,
and a trusted HTTPS certificate for a hostname reachable by the preview browser.
Use a dedicated origin: the reset route deletes **all localStorage and IndexedDB
data on that origin**. Never run this fixture on a production app origin.
The control routes are unauthenticated and for isolated local testing only.
Close other tabs using that origin before a reset to prevent late cache writes.

From the repository root, build an isolated API image without replacing the
production tag:

```bash
sudo podman build --layers -t excalidraw-api-elixir-sync-test backend
```

Build the opt-in frontend using the same HTTPS origin as the fixture:

```bash
cd app/excalidraw-app
VITE_APP_LOADING_BENCHMARK=true \
VITE_APP_WS_SERVER_URL=https://<deck>.<tailnet>.ts.net:5173 \
VITE_APP_DISABLE_SENTRY=true \
../node_modules/.bin/vite build \
  --outDir ../../.build-cache/loading-benchmark/build --emptyOutDir
cd ../..
node app/scripts/loading-benchmark.cjs
```

The runner prints the URL, synthetic room key, temporary data directory, fixture
sizes, and its own two container names. Defaults use ports 5173/3006/3007;
startup checks that they are free. `BENCH_HOST` defaults to this machine's MagicDNS name. Override `BENCH_HOST`, `BENCH_PORT`,
`BENCH_API_PORT`, `BENCH_SOCKET_PORT`, `BENCH_CERT`, `BENCH_KEY`,
`BENCH_API_IMAGE`, `BENCH_BUILD_DIR`, or `BENCH_DATA_DIR` as needed. Keep the
frontend socket URL aligned with these settings. Build/data directories should be
absolute paths. SIGINT/SIGTERM removes only the runner's own containers, preserving
the temporary fixtures/results for inspection.

Routes on the isolated origin:

- `/__bench/control?delay=1500&rate=1048576&offline=0&resetMetrics=1`
  configures data delay, aggregate bandwidth, and availability. Omitted settings
  reset to zero/online; `rate=0` disables throttling.
- `/__bench/reset?room=benchmark-large&run=large-cold` clears browser room data and
  navigates to the fixture. Use `benchmark-images` for the image room. On older
  benchmark builds, unregister the service worker before navigating here.
- `/__bench/patch?room=benchmark-large` appends a genuine revision-checked,
  encrypted one-shape patch. Prefer invoking it while the drawing is unloaded.
- `/__bench/metrics` returns server transfer counts and stored browser results.
- `/__bench/result` accepts a POSTed JSON result and persists `results.json` in the
  temporary directory. The runner also persists `fixture.json`.

In the preview, inspect `window.__loadingBenchmark.snapshot()` and wait for the
expected element/file counts **and a completed validation response** before saving
a sample. Call `await window.__loadingBenchmark.flush()` before navigation to finish
pending room-cache writes. A different `?run=...` value forces a cached reopen.
Use a trusted toolbar click for interaction checks rather than a synthetic DOM click.

Raw results from this run remain at `/tmp/excalidraw-loading-VbXzmV/results.json`.
The excluded reset and startup observations remain in that file for auditing.
Normal builds explicitly disable and tree-shake the instrumentation; the hook and
control routes do not belong in production deployments.

## Cached-room switch follow-up

Cached-scene restoration now runs independently of the Socket.IO client import.
The room-opening promise resolves as soon as the local preview is restored, while
connection setup and validation continue in the background. Cached image files
load independently of connection setup. A room-start generation prevents cancelled
starts from reconnecting or painting an old room, and same-room starts share the
pending preview even before a socket exists. The Rooms Explorer also reuses the
already-restored elements instead of restoring the full scene a second time.

Same-document switches between the two warmed fixtures were measured with trusted
Rooms Explorer clicks. The timestamp starts in the click event's capture phase;
the end is the editor's `onChange` with the destination's element count. Image
readiness additionally requires every referenced file to be present. Both fixtures
and their image data were already hydrated in this document. The data-network
settings remained 1,500 ms delay and 1 MiB/s, with body-free 304 validation.

| Cached destination | Samples | Scene available after click | Image data available after click |
| ------------------ | ------: | --------------------------: | -------------------------------: |
| 2,400-shape room   |       3 |     167 ms median (154–198) |                                — |
| 16-image room      |       3 |       95 ms median (32–110) |            95 ms median (32–110) |

These are availability measurements, not pixel-paint guarantees or a before/after
switch comparison. Large rooms still require local storage reads, restoration,
reconciliation, and drawing work; the patch does not promise zero-latency switching.
Raw follow-up results remain at `/tmp/excalidraw-loading-PWl8YW/results.json`.
Regression tests cover cached previews/images before connection setup, edits
persisted when leaving that preview, same-room duplicate starts, late cancelled
connections, and background connection failures without losing the local drawing.

## Remaining optimization

Profile first navigation on a browser with dependable rendering/screenshot support
before claiming first-paint improvements or changing rendering code. Prioritize
shell/lazy-chunk availability and cached-image hydration over AES optimization:
the large cold-room AES calls totaled approximately 0.6–1.4 ms in the controlled runs.

## Prepared-room revisit path

The next optimization retains recently visited editor-ready scenes in memory.
A revisit can reuse the same element objects, allowing the renderer's object-keyed
shape caches to remain useful, instead of rebuilding elements from stored JSON.
The room's previous pan and zoom are installed together with its elements. Cached
first visits calculate their fitted viewport before installing the scene; the
Rooms Explorer avoids reinstalling elements that collaboration already installed.

Prepared entries are scoped to both room ID and encryption key and checked against
local cache generations. Scene/draft writes and deletion invalidate older entries.
Focus/visibility restoration clears memory caches so a returning tab rereads local
storage. The prepared cache retains at most eight rooms, 20,000 elements, and an
estimated 64 MiB of referenced image data. Eviction falls back to persistent storage.
Persistent drafts and backups remain separate from this optional acceleration.

Switches still reset editor history and selection before installing the destination.
Server validation and conflict reconciliation continue in the background; prepared
scenes do not bypass validation or permit stale connection callbacks to paint.

An isolated follow-up measured three prepared revisits per destination using trusted
Rooms Explorer clicks, with the same 1,500 ms data delay and 1 MiB/s bandwidth:

| Destination      | Scene available after click | Reused departing element objects |
| ---------------- | --------------------------: | -------------------------------- |
| 2,400-shape room |  25.9 ms median (24.8–44.6) | All three revisits               |
| 16-image room    |  50.9 ms median (47.1–53.5) | All three revisits               |

The preview tool refocuses the browser before each click. That correctly clears the
production memory cache, so these prepared-path samples temporarily removed only
the collaboration focus-invalidation listener on the isolated page, simulating
navigation in one continuously focused document. The listener was restored after
sampling. Visibility invalidation remained enabled. With the normal focus listener
active, observed revisits fell back to restoration (123.5–157.1 ms for the large
room and 67.4–77.2 ms for the image room); these are not prepared-cache hits.

All image data was already present in the editor during the prepared samples.
These remain data-availability measurements, not pixel-paint or interaction
guarantees, and are not a paired before/after performance comparison. The preceding
table measures the earlier implementation. Raw follow-up results are saved at
`/tmp/excalidraw-loading-ZdhOOt/results.json`.

Verify repeated A→B→A switches after local writes settle, edits followed by switching,
cache invalidation, duplicate shape IDs in different rooms, and rapid cancelled
starts. Measure scene availability separately from visible rendering and interaction.
