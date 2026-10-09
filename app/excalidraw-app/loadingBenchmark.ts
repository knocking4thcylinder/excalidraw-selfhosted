import type {
  RenderPerformanceSample,
  RenderPerformanceWindow,
} from "@excalidraw/excalidraw/renderer/renderPerformance";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { flushRoomCache } from "./data/roomCache";

const RENDERS_LIMIT = 2000;
const ROOM_SWITCHES_LIMIT = 100;

type BenchmarkBoot = {
  requests: Array<Record<string, unknown>>;
  decryptions: Array<{ started: number; duration: number }>;
  longTasks: Array<{ started: number; duration: number }>;
};

type RoomSwitchStatus = "pending" | "ready" | "cancelled";

type RoomSwitchRecord = {
  label: string;
  start: number;
  status: RoomSwitchStatus;
  expectedElementId: string;
  dataReadyMs?: number;
  filesReadyMs?: number;
  paintOpportunityMs?: number;
};

type LoadingBenchmark = {
  api: ExcalidrawImperativeAPI;
  snapshot: () => Record<string, unknown>;
  flush: typeof flushRoomCache;
  dispose: () => void;
  beginRoomSwitch: (label: string, expectedElementId: string) => void;
  resetProfile: () => void;
};

type BenchmarkWindow = Window & {
  __loadingBenchmarkBoot?: BenchmarkBoot;
  __loadingBenchmark?: LoadingBenchmark;
};

export const attachLoadingBenchmark = (
  api: ExcalidrawImperativeAPI,
  ownerWindow: Window,
) => {
  const benchmarkWindow = ownerWindow as BenchmarkWindow;
  const renderWindow = ownerWindow as RenderPerformanceWindow;
  benchmarkWindow.__loadingBenchmark?.dispose();
  const metrics: Record<string, unknown> = {
    editorMountedMs: ownerWindow.performance.now(),
  };
  const renders: RenderPerformanceSample[] = [];
  const roomSwitches: RoomSwitchRecord[] = [];
  let pendingSwitch: RoomSwitchRecord | null = null;
  let disposed = false;
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
  const previousRenderProfiler = renderWindow.__excalidrawRenderProfiler;
  const renderProfiler = (sample: RenderPerformanceSample) => {
    renders.push({ ...sample });
    if (renders.length > RENDERS_LIMIT) {
      renders.splice(0, renders.length - RENDERS_LIMIT);
    }
    previousRenderProfiler?.(sample);
  };
  renderWindow.__excalidrawRenderProfiler = renderProfiler;
  const beginRoomSwitch = (label: string, expectedElementId: string) => {
    if (pendingSwitch?.status === "pending") {
      pendingSwitch.status = "cancelled";
    }
    const record: RoomSwitchRecord = {
      label,
      start: ownerWindow.performance.now(),
      status: "pending",
      expectedElementId,
    };
    roomSwitches.push(record);
    if (roomSwitches.length > ROOM_SWITCHES_LIMIT) {
      roomSwitches.splice(0, roomSwitches.length - ROOM_SWITCHES_LIMIT);
    }
    pendingSwitch = record;
  };
  const resetProfile = () => {
    renders.splice(0, renders.length);
    roomSwitches.splice(0, roomSwitches.length);
    if (pendingSwitch) {
      pendingSwitch.status = "cancelled";
      pendingSwitch = null;
    }
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
    const record = pendingSwitch;
    if (!record) {
      return;
    }
    if (!visible.some((element) => element.id === record.expectedElementId)) {
      return;
    }
    const elapsed = ownerWindow.performance.now() - record.start;
    if (record.dataReadyMs === undefined) {
      record.dataReadyMs = elapsed;
    }
    if (
      record.filesReadyMs !== undefined ||
      !imageIds.every((id) => !!files[id])
    ) {
      return;
    }
    record.filesReadyMs = elapsed;
    record.status = "ready";
    afterPaintOpportunity(() => {
      if (
        disposed ||
        pendingSwitch !== record ||
        record.status === "cancelled"
      ) {
        return;
      }
      record.paintOpportunityMs = ownerWindow.performance.now() - record.start;
    });
  });
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    if (target?.closest('[data-testid="toolbar-rectangle"]')) {
      interactionStarted = ownerWindow.performance.now();
    }
  };
  ownerWindow.document.addEventListener("click", onClick, true);
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribe();
    ownerWindow.document.removeEventListener("click", onClick, true);
    for (const frame of frames) {
      ownerWindow.cancelAnimationFrame(frame);
    }
    if (pendingSwitch?.status === "pending") {
      pendingSwitch.status = "cancelled";
    }
    pendingSwitch = null;
    if (renderWindow.__excalidrawRenderProfiler === renderProfiler) {
      if (previousRenderProfiler) {
        renderWindow.__excalidrawRenderProfiler = previousRenderProfiler;
      } else {
        delete renderWindow.__excalidrawRenderProfiler;
      }
    }
    if (benchmarkWindow.__loadingBenchmark === publicApi) {
      delete benchmarkWindow.__loadingBenchmark;
    }
  };
  const publicApi: LoadingBenchmark = {
    api,
    flush: flushRoomCache,
    dispose,
    beginRoomSwitch,
    resetProfile,
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
      renders: renders.map((sample) => ({ ...sample })),
      roomSwitches: roomSwitches.map((record) => ({ ...record })),
    }),
  };
  benchmarkWindow.__loadingBenchmark = publicApi;
  return dispose;
};
