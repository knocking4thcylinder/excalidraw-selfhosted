import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { flushRoomCache } from "./data/roomCache";

type BenchmarkBoot = {
  requests: Array<Record<string, unknown>>;
  decryptions: Array<{ started: number; duration: number }>;
  longTasks: Array<{ started: number; duration: number }>;
};

type BenchmarkWindow = Window & {
  __loadingBenchmarkBoot?: BenchmarkBoot;
  __loadingBenchmark?: {
    api: ExcalidrawImperativeAPI;
    snapshot: () => Record<string, unknown>;
    flush: typeof flushRoomCache;
    dispose: () => void;
  };
};

export const attachLoadingBenchmark = (
  api: ExcalidrawImperativeAPI,
  ownerWindow: Window,
) => {
  const benchmarkWindow = ownerWindow as BenchmarkWindow;
  benchmarkWindow.__loadingBenchmark?.dispose();
  const metrics: Record<string, unknown> = {
    editorMountedMs: ownerWindow.performance.now(),
  };
  let interactionStarted: number | null = null;
  const frames = new Set<number>();
  const afterPaintOpportunity = (callback: () => void) => {
    const first = ownerWindow.requestAnimationFrame(() => {
      frames.delete(first);
      const second = ownerWindow.requestAnimationFrame(() => {
        frames.delete(second);
        callback();
      });
      frames.add(second);
    });
    frames.add(first);
  };
  const unsubscribe = api.onChange((elements, appState, files) => {
    const visible = elements.filter((element) => !element.isDeleted);
    if (visible.length && metrics.sceneAvailableMs === undefined) {
      metrics.sceneAvailableMs = ownerWindow.performance.now();
      afterPaintOpportunity(() => {
        metrics.scenePaintOpportunityMs = ownerWindow.performance.now();
      });
    }
    const imageIds = visible.flatMap((element) =>
      element.type === "image" && element.fileId ? [element.fileId] : [],
    );
    if (
      imageIds.length &&
      imageIds.every((id) => !!files[id]) &&
      metrics.imagesAvailableMs === undefined
    ) {
      metrics.imagesAvailableMs = ownerWindow.performance.now();
      afterPaintOpportunity(() => {
        metrics.imagesPaintOpportunityMs = ownerWindow.performance.now();
      });
    }
    if (
      interactionStarted !== null &&
      appState.activeTool.type === "rectangle"
    ) {
      const started = interactionStarted;
      interactionStarted = null;
      afterPaintOpportunity(() => {
        metrics.toolResponseMs = ownerWindow.performance.now() - started;
      });
    }
  });
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    if (target?.closest('[data-testid="toolbar-rectangle"]')) {
      interactionStarted = ownerWindow.performance.now();
    }
  };
  ownerWindow.document.addEventListener("click", onClick, true);
  const dispose = () => {
    unsubscribe();
    ownerWindow.document.removeEventListener("click", onClick, true);
    for (const frame of frames) {
      ownerWindow.cancelAnimationFrame(frame);
    }
    delete benchmarkWindow.__loadingBenchmark;
  };
  benchmarkWindow.__loadingBenchmark = {
    api,
    flush: flushRoomCache,
    dispose,
    snapshot: () => ({
      ...metrics,
      elements: api.getSceneElements().length,
      files: Object.keys(api.getFiles()).length,
      activeTool: api.getAppState().activeTool.type,
      secureContext: ownerWindow.isSecureContext,
      visibility: ownerWindow.document.visibilityState,
      validationPending:
        !!ownerWindow.document.querySelector('[role="status"]'),
      offlinePending:
        ownerWindow.document.body.innerText.includes("Offline — waiting"),
      boot: benchmarkWindow.__loadingBenchmarkBoot,
      resources: ownerWindow.performance
        .getEntriesByType("resource")
        .map((entry) => {
          const resource = entry as PerformanceResourceTiming;
          return {
            name: resource.name,
            started: resource.startTime,
            duration: resource.duration,
            transferBytes: resource.transferSize,
            encodedBytes: resource.encodedBodySize,
          };
        }),
      paints: ownerWindow.performance
        .getEntriesByType("paint")
        .map((entry) => ({ name: entry.name, started: entry.startTime })),
    }),
  };
  return dispose;
};
