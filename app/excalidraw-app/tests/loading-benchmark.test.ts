import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { attachLoadingBenchmark } from "../loadingBenchmark";

const createBenchmark = () => {
  const ownerWindow = document.body.ownerDocument.defaultView!;
  Object.defineProperty(ownerWindow.document.body, "innerText", {
    value: "",
    configurable: true,
  });
  const unsubscribe = vi.fn();
  let change: Parameters<ExcalidrawImperativeAPI["onChange"]>[0];
  const elements = [{ id: "image", type: "image", fileId: "asset" }];
  const files = {};
  const api = {
    onChange: vi.fn((callback) => {
      change = callback;
      return unsubscribe;
    }),
    getSceneElements: () => elements,
    getFiles: () => files,
    getAppState: () => ({ activeTool: { type: "selection" } }),
  } as unknown as ExcalidrawImperativeAPI;
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(ownerWindow, "requestAnimationFrame").mockImplementation(
    (callback) => frames.push(callback),
  );
  const cancel = vi.spyOn(ownerWindow, "cancelAnimationFrame");
  const dispose = attachLoadingBenchmark(api, ownerWindow);
  const snapshot = () =>
    (
      ownerWindow as unknown as Window & {
        __loadingBenchmark: { snapshot: () => Record<string, unknown> };
      }
    ).__loadingBenchmark.snapshot();
  const emit = (nextFiles = files) =>
    change(
      elements as unknown as Parameters<typeof change>[0],
      api.getAppState(),
      nextFiles as Parameters<typeof change>[2],
    );
  return { ownerWindow, unsubscribe, frames, cancel, dispose, snapshot, emit };
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
