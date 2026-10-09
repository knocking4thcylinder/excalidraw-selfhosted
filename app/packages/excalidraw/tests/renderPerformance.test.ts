import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  profileRender,
  type RenderPerformanceSample,
  type RenderPerformanceWindow,
} from "../renderer/renderPerformance";

const capture = (run: () => unknown) => {
  try {
    run();
    return { caught: undefined as unknown, threw: false };
  } catch (error) {
    return { caught: error, threw: true };
  }
};

describe("profileRender", () => {
  let canvas: HTMLCanvasElement;
  let ownerWindow: RenderPerformanceWindow;

  beforeEach(() => {
    canvas = document.createElement("canvas");
    ownerWindow = canvas.ownerDocument.defaultView as RenderPerformanceWindow;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete ownerWindow.__excalidrawRenderProfiler;
  });

  it("runs the render directly without touching the clock when no hook is installed", () => {
    const nowSpy = vi.spyOn(ownerWindow.performance, "now");
    const render = vi.fn(() => "painted");

    expect(profileRender(canvas, "static", 12, render)).toBe("painted");
    expect(render).toHaveBeenCalledTimes(1);
    expect(nowSpy).not.toHaveBeenCalled();

    const hook = vi.fn();
    ownerWindow.__excalidrawRenderProfiler = hook;

    expect(profileRender(null, "interactive", 3, render)).toBe("painted");
    expect(render).toHaveBeenCalledTimes(2);
    expect(hook).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it("measures the synchronous render only and reports phase, timing and element count", () => {
    let fakeNow = 0;
    vi.spyOn(ownerWindow.performance, "now").mockImplementation(() => fakeNow);

    const samples: RenderPerformanceSample[] = [];
    ownerWindow.__excalidrawRenderProfiler = (sample) => {
      fakeNow += 500;
      samples.push(sample);
    };

    fakeNow = 1000;
    profileRender(canvas, "static", 4, () => {
      fakeNow = 1016;
    });

    fakeNow = 2000;
    profileRender(canvas, "interactive", 9, () => {
      fakeNow = 2040;
    });

    expect(samples).toEqual([
      { phase: "static", started: 1000, duration: 16, elements: 4 },
      { phase: "interactive", started: 2000, duration: 40, elements: 9 },
    ]);
  });

  it("preserves the render return value while a hook is installed", () => {
    const hook = vi.fn();
    ownerWindow.__excalidrawRenderProfiler = hook;

    const value = { scrollBars: null };
    expect(profileRender(canvas, "interactive", 7, () => value)).toBe(value);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      phase: "interactive",
      started: expect.any(Number),
      duration: expect.any(Number),
      elements: 7,
    });
  });

  it("reports the sample for a throwing render and rethrows the render's own error", () => {
    const renderError = new Error("render exploded");
    const hook = vi.fn();
    ownerWindow.__excalidrawRenderProfiler = hook;

    const failed = capture(() =>
      profileRender(canvas, "static", 2, () => {
        throw renderError;
      }),
    );

    expect(failed.threw).toBe(true);
    expect(failed.caught).toBe(renderError);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({
      phase: "static",
      elements: 2,
    });
  });

  it("never lets a throwing hook mask the render's error or break a render", () => {
    const renderError = new Error("render exploded");
    ownerWindow.__excalidrawRenderProfiler = () => {
      throw new Error("hook exploded");
    };

    const failed = capture(() =>
      profileRender(canvas, "static", 2, () => {
        throw renderError;
      }),
    );
    expect(failed.threw).toBe(true);
    expect(failed.caught).toBe(renderError);

    const painted = profileRender(canvas, "interactive", 5, () => "painted");
    expect(painted).toBe("painted");
  });

  it("reads the hook from the canvas owner window", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);

    try {
      const frameWindow = iframe.contentWindow as RenderPerformanceWindow;
      const outerHook = vi.fn();
      const innerHook = vi.fn();
      ownerWindow.__excalidrawRenderProfiler = outerHook;
      frameWindow.__excalidrawRenderProfiler = innerHook;

      const frameCanvas = frameWindow.document.createElement("canvas");

      expect(profileRender(frameCanvas, "static", 1, () => "painted")).toBe(
        "painted",
      );
      expect(innerHook).toHaveBeenCalledTimes(1);
      expect(outerHook).not.toHaveBeenCalled();

      expect(profileRender(canvas, "static", 1, () => "painted")).toBe(
        "painted",
      );
      expect(outerHook).toHaveBeenCalledTimes(1);
      expect(innerHook).toHaveBeenCalledTimes(1);
    } finally {
      delete ownerWindow.__excalidrawRenderProfiler;
      iframe.remove();
    }
  });
});
