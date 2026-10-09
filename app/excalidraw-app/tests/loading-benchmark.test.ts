import { vi } from "vitest";

import type {
  RenderPerformanceSample,
  RenderPerformanceWindow,
} from "@excalidraw/excalidraw/renderer/renderPerformance";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { flushRoomCache } from "../data/roomCache";
import { attachLoadingBenchmark } from "../loadingBenchmark";

vi.mock("../data/roomCache", () => ({ flushRoomCache: vi.fn() }));

type TestElement = {
  id: string;
  type: string;
  fileId?: string;
  isDeleted?: boolean;
};

type RoomSwitchEntry = {
  label: string;
  start: number;
  status: "pending" | "ready" | "cancelled";
  expectedElementId: string;
  dataReadyMs?: number;
  filesReadyMs?: number;
  paintOpportunityMs?: number;
};

type BenchmarkSnapshot = {
  renders: RenderPerformanceSample[];
  roomSwitches: RoomSwitchEntry[];
  [key: string]: unknown;
};

type BenchmarkHarness = {
  api: ExcalidrawImperativeAPI;
  snapshot: () => BenchmarkSnapshot;
  flush: typeof flushRoomCache;
  dispose: () => void;
  beginRoomSwitch: (label: string, expectedElementId: string) => void;
  resetProfile: () => void;
};

type BenchmarkWindow = RenderPerformanceWindow & {
  __loadingBenchmark?: BenchmarkHarness;
};

const createBenchmark = (
  scene: TestElement[] = [{ id: "image", type: "image", fileId: "asset" }],
  binaryFiles: Record<string, unknown> = {},
) => {
  const ownerWindow = document.body.ownerDocument
    .defaultView as unknown as BenchmarkWindow;
  Object.defineProperty(ownerWindow.document.body, "innerText", {
    value: "",
    configurable: true,
  });
  const unsubscribe = vi.fn();
  let change: Parameters<ExcalidrawImperativeAPI["onChange"]>[0];
  let elements = scene;
  let files = binaryFiles;
  const updateScene = vi.fn();
  const api = {
    onChange: vi.fn((callback) => {
      change = callback;
      return unsubscribe;
    }),
    getSceneElements: () => elements,
    getFiles: () => files,
    getAppState: () => ({ activeTool: { type: "selection" } }),
    updateScene,
  } as unknown as ExcalidrawImperativeAPI;
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(ownerWindow, "requestAnimationFrame").mockImplementation(
    (callback) => frames.push(callback),
  );
  const cancel = vi.spyOn(ownerWindow, "cancelAnimationFrame");
  const dispose = attachLoadingBenchmark(api, ownerWindow);
  const harness = ownerWindow.__loadingBenchmark!;
  const snapshot = () => harness.snapshot();
  const emit = (
    nextFiles?: Record<string, unknown>,
    nextElements?: TestElement[],
  ) => {
    if (nextFiles) {
      files = nextFiles;
    }
    if (nextElements) {
      elements = nextElements;
    }
    change(
      elements as unknown as Parameters<typeof change>[0],
      api.getAppState(),
      files as Parameters<typeof change>[2],
    );
  };
  const flushFrames = () => {
    while (frames.length) {
      frames.shift()!(0);
    }
  };
  return {
    ownerWindow,
    unsubscribe,
    frames,
    cancel,
    dispose,
    snapshot,
    emit,
    harness,
    flushFrames,
    updateScene,
  };
};

const prepareSwitchedBenchmark = () => {
  const benchmark = createBenchmark(
    [{ id: "seed", type: "image", fileId: "seed-file" }],
    { "seed-file": {} },
  );
  benchmark.emit();
  benchmark.flushFrames();
  benchmark.harness.beginRoomSwitch("switch-room", "target");
  benchmark.emit(undefined, [{ id: "target", type: "image", fileId: "asset" }]);
  benchmark.emit({ "seed-file": {}, asset: {} });
  return benchmark;
};

afterEach(() => vi.restoreAllMocks());

describe("opt-in loading measurements", () => {
  it("separates scene availability, image availability and paint opportunities", () => {
    const benchmark = createBenchmark();
    benchmark.emit();
    expect(benchmark.snapshot().sceneAvailableMs).toEqual(expect.any(Number));
    expect(benchmark.snapshot().imagesAvailableMs).toBeUndefined();
    expect(benchmark.snapshot().scenePaintOpportunityMs).toBeUndefined();
    benchmark.frames.shift()!(0);
    expect(benchmark.snapshot().scenePaintOpportunityMs).toBeUndefined();
    benchmark.frames.shift()!(0);
    expect(benchmark.snapshot().scenePaintOpportunityMs).toEqual(
      expect.any(Number),
    );
    benchmark.emit({ asset: {} });
    expect(benchmark.snapshot().imagesAvailableMs).toEqual(expect.any(Number));
    benchmark.dispose();
  });

  it("unsubscribes and cancels outstanding frames on disposal", () => {
    const benchmark = createBenchmark();
    benchmark.emit();
    benchmark.dispose();
    expect(benchmark.unsubscribe).toHaveBeenCalledTimes(1);
    expect(benchmark.cancel).toHaveBeenCalledWith(1);
    expect(benchmark.ownerWindow).not.toHaveProperty("__loadingBenchmark");
  });
});

describe("room switch profiling", () => {
  it("waits for the expected element and rejects empty, stale and deleted scenes", () => {
    const benchmark = createBenchmark([]);
    benchmark.harness.beginRoomSwitch("switch-a", "target");
    benchmark.emit();
    expect(benchmark.snapshot().roomSwitches[0]).toMatchObject({
      label: "switch-a",
      start: expect.any(Number),
      status: "pending",
      expectedElementId: "target",
    });
    expect(benchmark.snapshot().roomSwitches[0].dataReadyMs).toBeUndefined();
    benchmark.emit(undefined, [{ id: "stale", type: "rectangle" }]);
    expect(benchmark.snapshot().roomSwitches[0].dataReadyMs).toBeUndefined();
    benchmark.emit(undefined, [
      { id: "target", type: "rectangle", isDeleted: true },
    ]);
    expect(benchmark.snapshot().roomSwitches[0].dataReadyMs).toBeUndefined();
    expect(benchmark.snapshot().roomSwitches[0].status).toBe("pending");
    benchmark.emit(undefined, [{ id: "target", type: "rectangle" }]);
    const entry = benchmark.snapshot().roomSwitches[0];
    expect(entry.dataReadyMs).toEqual(expect.any(Number));
    expect(entry.filesReadyMs).toBe(entry.dataReadyMs);
    expect(entry.status).toBe("ready");
    benchmark.dispose();
  });

  it("waits for every target scene image file before reporting readiness", () => {
    const benchmark = createBenchmark(
      [{ id: "seed", type: "image", fileId: "seed-file" }],
      { "seed-file": {} },
    );
    benchmark.emit();
    benchmark.flushFrames();
    benchmark.harness.beginRoomSwitch("images-room", "target");
    benchmark.emit(undefined, [
      { id: "target", type: "image", fileId: "asset" },
    ]);
    let entry = benchmark.snapshot().roomSwitches[0];
    expect(entry.dataReadyMs).toEqual(expect.any(Number));
    expect(entry.filesReadyMs).toBeUndefined();
    expect(entry.paintOpportunityMs).toBeUndefined();
    expect(entry.status).toBe("pending");
    benchmark.emit({ "seed-file": {}, asset: {} });
    entry = benchmark.snapshot().roomSwitches[0];
    expect(entry.filesReadyMs).toEqual(expect.any(Number));
    expect(entry.filesReadyMs!).toBeGreaterThanOrEqual(entry.dataReadyMs!);
    expect(entry.status).toBe("ready");
    expect(benchmark.snapshot().imagesAvailableMs).toEqual(expect.any(Number));
    benchmark.dispose();
  });

  it("records a two-frame paint opportunity rather than a painted pixel", () => {
    const benchmark = prepareSwitchedBenchmark();
    expect(benchmark.frames).toHaveLength(1);
    expect(
      benchmark.snapshot().roomSwitches[0].paintOpportunityMs,
    ).toBeUndefined();
    benchmark.frames.shift()!(0);
    expect(
      benchmark.snapshot().roomSwitches[0].paintOpportunityMs,
    ).toBeUndefined();
    benchmark.frames.shift()!(0);
    const entry = benchmark.snapshot().roomSwitches[0];
    expect(entry.paintOpportunityMs).toEqual(expect.any(Number));
    expect(entry.paintOpportunityMs!).toBeGreaterThanOrEqual(
      entry.dataReadyMs!,
    );
    expect(benchmark.snapshot().paints).toEqual([]);
    benchmark.dispose();
  });

  it("bounds stored renders and room switches to the most recent samples", () => {
    const benchmark = createBenchmark();
    const profiler = benchmark.ownerWindow.__excalidrawRenderProfiler!;
    for (let index = 0; index < 2005; index++) {
      profiler({
        phase: index % 2 ? "static" : "interactive",
        started: index,
        duration: 3,
        elements: index,
      });
    }
    for (let index = 0; index < 105; index++) {
      benchmark.harness.beginRoomSwitch(`switch-${index}`, `element-${index}`);
    }
    const snapshot = benchmark.snapshot();
    expect(snapshot.renders).toHaveLength(2000);
    expect(snapshot.renders[0]).toMatchObject({ started: 5 });
    expect(snapshot.renders[1999]).toMatchObject({ started: 2004 });
    expect(snapshot.roomSwitches).toHaveLength(100);
    expect(snapshot.roomSwitches[0].label).toBe("switch-5");
    expect(snapshot.roomSwitches[0].status).toBe("cancelled");
    expect(snapshot.roomSwitches[99].label).toBe("switch-104");
    expect(snapshot.roomSwitches[99].status).toBe("pending");
    benchmark.dispose();
  });

  it("restores the previous render profiler on disposal", () => {
    const ownerWindow = document.body.ownerDocument
      .defaultView as unknown as BenchmarkWindow;
    const previous = vi.fn();
    ownerWindow.__excalidrawRenderProfiler = previous;
    const benchmark = createBenchmark();
    ownerWindow.__excalidrawRenderProfiler!({
      phase: "interactive",
      started: 7,
      duration: 2,
      elements: 11,
    });
    expect(previous).toHaveBeenCalledWith({
      phase: "interactive",
      started: 7,
      duration: 2,
      elements: 11,
    });
    expect(benchmark.snapshot().renders).toEqual([
      { phase: "interactive", started: 7, duration: 2, elements: 11 },
    ]);
    benchmark.dispose();
    expect(ownerWindow.__excalidrawRenderProfiler).toBe(previous);
    delete ownerWindow.__excalidrawRenderProfiler;
  });

  it("keeps a newer render profiler owner when disposing", () => {
    const benchmark = createBenchmark();
    const newer = vi.fn();
    benchmark.ownerWindow.__excalidrawRenderProfiler = newer;
    benchmark.dispose();
    expect(benchmark.ownerWindow.__excalidrawRenderProfiler).toBe(newer);
    delete benchmark.ownerWindow.__excalidrawRenderProfiler;
  });

  it("cancels a replaced pending switch and keeps callbacks on their own record", () => {
    const benchmark = createBenchmark([]);
    benchmark.harness.beginRoomSwitch("first", "one");
    benchmark.emit();
    expect(benchmark.snapshot().roomSwitches[0].status).toBe("pending");
    benchmark.harness.beginRoomSwitch("second", "two");
    let switches = benchmark.snapshot().roomSwitches;
    expect(switches).toHaveLength(2);
    expect(switches[0]).toMatchObject({ label: "first", status: "cancelled" });
    expect(switches[1]).toMatchObject({ label: "second", status: "pending" });
    benchmark.emit(undefined, [{ id: "two", type: "rectangle" }]);
    switches = benchmark.snapshot().roomSwitches;
    expect(switches[0].dataReadyMs).toBeUndefined();
    expect(switches[0].paintOpportunityMs).toBeUndefined();
    expect(switches[1].dataReadyMs).toEqual(expect.any(Number));
    expect(switches[1].filesReadyMs).toBe(switches[1].dataReadyMs);
    benchmark.flushFrames();
    switches = benchmark.snapshot().roomSwitches;
    expect(switches[0].paintOpportunityMs).toBeUndefined();
    expect(switches[1].paintOpportunityMs).toEqual(expect.any(Number));
    benchmark.dispose();
  });

  it("stops recording renders, switches and queued frames after disposal", () => {
    const benchmark = createBenchmark([]);
    benchmark.harness.beginRoomSwitch("switch", "target");
    benchmark.emit(undefined, [{ id: "target", type: "rectangle" }]);
    expect(benchmark.snapshot().roomSwitches[0].filesReadyMs).toEqual(
      expect.any(Number),
    );
    const queued = [...benchmark.frames];
    benchmark.dispose();
    queued.forEach((callback) => callback(0));
    expect(
      benchmark.harness.snapshot().roomSwitches[0].paintOpportunityMs,
    ).toBeUndefined();
    expect(benchmark.ownerWindow.__excalidrawRenderProfiler).toBeUndefined();
    expect(benchmark.ownerWindow).not.toHaveProperty("__loadingBenchmark");
    expect(benchmark.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("clears profile buffers without touching scene or cache", () => {
    vi.mocked(flushRoomCache).mockClear();
    const benchmark = createBenchmark([]);
    const profiler = benchmark.ownerWindow.__excalidrawRenderProfiler!;
    profiler({ phase: "static", started: 1, duration: 4, elements: 2 });
    benchmark.harness.beginRoomSwitch("switch", "target");
    benchmark.emit(undefined, [{ id: "target", type: "rectangle" }]);
    expect(benchmark.snapshot().renders).toHaveLength(1);
    expect(benchmark.snapshot().roomSwitches).toHaveLength(1);
    benchmark.harness.resetProfile();
    expect(benchmark.snapshot().renders).toEqual([]);
    expect(benchmark.snapshot().roomSwitches).toEqual([]);
    expect(vi.mocked(flushRoomCache)).not.toHaveBeenCalled();
    expect(benchmark.updateScene).not.toHaveBeenCalled();
    profiler({ phase: "interactive", started: 2, duration: 1, elements: 3 });
    expect(benchmark.snapshot().renders).toHaveLength(1);
    benchmark.flushFrames();
    expect(benchmark.snapshot().roomSwitches).toEqual([]);
    benchmark.dispose();
  });
});
