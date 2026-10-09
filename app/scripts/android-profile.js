(() => {
  const ownerWindow = document.currentScript.ownerDocument.defaultView;
  const sleep = (duration) =>
    new Promise((resolve) => ownerWindow.setTimeout(resolve, duration));
  const waitFor = async (predicate, label, timeout = 60000) => {
    const started = ownerWindow.performance.now();
    while (!predicate()) {
      if (ownerWindow.performance.now() - started > timeout) {
        throw new Error(`Timed out waiting for ${label}`);
      }
      await sleep(50);
    }
  };
  const frame = () =>
    new Promise((resolve, reject) => {
      const timeout = ownerWindow.setTimeout(() => {
        ownerWindow.cancelAnimationFrame(handle);
        reject(new Error("Animation frame unavailable"));
      }, 5000);
      const handle = ownerWindow.requestAnimationFrame((timestamp) => {
        ownerWindow.clearTimeout(timeout);
        resolve(timestamp);
      });
    });
  const post = (phase, data) =>
    ownerWindow
      .fetch("/__bench/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "android-profile",
          run: new URL(ownerWindow.location.href).searchParams.get("run"),
          phase,
          userAgent: ownerWindow.navigator.userAgent,
          visibility: ownerWindow.document.visibilityState,
          viewport: {
            width: ownerWindow.innerWidth,
            height: ownerWindow.innerHeight,
            pixelRatio: ownerWindow.devicePixelRatio,
          },
          ...data,
        }),
      })
      .then((response) => {
        if (!response.ok)
          throw new Error(`Result upload failed: ${response.status}`);
      });
  const run = async () => {
    await post("boot", {});
    const configResponse = await ownerWindow.fetch("/__bench/metrics");
    if (!configResponse.ok) throw new Error("Fixture metadata unavailable");
    const config = await configResponse.json();
    const roomNames = ["benchmark-large", "benchmark-images"];
    const roomKey = ownerWindow.location.hash.split(",")[1];
    if (
      !roomKey ||
      !roomNames.every((room) => config.rooms[room]?.firstElementId) ||
      !roomNames.some((room) =>
        ownerWindow.location.hash.startsWith(`#room=${room},`),
      )
    ) {
      throw new Error("Android profiling requires an isolated fixture room");
    }
    await waitFor(() => ownerWindow.__loadingBenchmark, "opt-in profiling API");
    const benchmark = ownerWindow.__loadingBenchmark;
    const roomReady = (room) => {
      const elements = benchmark.api.getSceneElements();
      const files = benchmark.api.getFiles();
      return (
        elements.length === config.rooms[room].elements &&
        elements.some(
          (element) => element.id === config.rooms[room].firstElementId,
        ) &&
        elements.every(
          (element) => element.type !== "image" || !!files[element.fileId],
        ) &&
        !benchmark.snapshot().validationPending
      );
    };
    await waitFor(() => roomReady("benchmark-large"), "initial large scene");
    await post("startup", { snapshot: benchmark.snapshot() });
    const switchRoom = async (room, label) => {
      await benchmark.flush();
      benchmark.beginRoomSwitch(label, config.rooms[room].firstElementId);
      const previousURL = ownerWindow.location.href;
      const nextURL = new URL(previousURL);
      nextURL.hash = `room=${room},${roomKey}`;
      ownerWindow.history.replaceState(null, "", nextURL);
      ownerWindow.dispatchEvent(
        new ownerWindow.HashChangeEvent("hashchange", {
          oldURL: previousURL,
          newURL: nextURL.href,
        }),
      );
      await waitFor(() => roomReady(room), label);
      await frame();
      await frame();
      await sleep(250);
    };
    await switchRoom("benchmark-images", "images-first-visit");
    await switchRoom("benchmark-large", "large-warmup");
    benchmark.resetProfile();
    for (let iteration = 1; iteration <= 3; iteration++) {
      await switchRoom("benchmark-images", `images-cached-${iteration}`);
      await switchRoom("benchmark-large", `large-cached-${iteration}`);
    }
    await post("cached-switches", { snapshot: benchmark.snapshot() });
    for (const room of roomNames) {
      if (room !== "benchmark-large") await switchRoom(room, "pan-fixture");
      const originalState = benchmark.api.getAppState();
      benchmark.api.updateScene({
        appState: { scrollX: 0, scrollY: 0, zoom: { value: 0.1 } },
      });
      await frame();
      await frame();
      await sleep(250);
      for (let iteration = 1; iteration <= 2; iteration++) {
        benchmark.resetProfile();
        const longTaskOffset =
          ownerWindow.__loadingBenchmarkBoot.longTasks.length;
        const intervals = [];
        const started = ownerWindow.performance.now();
        let previous = await frame();
        try {
          for (let step = 0; step < 120; step++) {
            const offset = step < 60 ? step * 20 : (119 - step) * 20;
            benchmark.api.updateScene({ appState: { scrollX: offset } });
            const timestamp = await frame();
            intervals.push(timestamp - previous);
            previous = timestamp;
            if ((step + 1) % 10 === 0) {
              await post("pan-progress", {
                room,
                iteration,
                steps: step + 1,
                elapsedMs: ownerWindow.performance.now() - started,
                snapshot: benchmark.snapshot(),
              });
            }
            if (ownerWindow.performance.now() - started > 45000) {
              break;
            }
          }
          await frame();
          await post("programmatic-pan", {
            room,
            iteration,
            completedSteps: intervals.length,
            durationMs: ownerWindow.performance.now() - started,
            rafIntervalsMs: intervals,
            longTasks:
              ownerWindow.__loadingBenchmarkBoot.longTasks.slice(
                longTaskOffset,
              ),
            snapshot: benchmark.snapshot(),
          });
        } finally {
          benchmark.api.updateScene({ appState: { scrollX: 0 } });
        }
      }
      benchmark.api.updateScene({
        appState: {
          scrollX: originalState.scrollX,
          scrollY: originalState.scrollY,
          zoom: originalState.zoom,
        },
      });
    }
    await benchmark.flush();
    await post("complete", {});
  };
  run().catch((error) =>
    post("error", { error: String(error) }).catch(() => {}),
  );
})();
