export type RenderPerformanceSample = {
  phase: "static" | "interactive";
  started: number;
  duration: number;
  elements: number;
};

export type RenderPerformanceWindow = Window & {
  __excalidrawRenderProfiler?: (sample: RenderPerformanceSample) => void;
};

export const profileRender = <T>(
  canvas: HTMLCanvasElement | null,
  phase: RenderPerformanceSample["phase"],
  elements: number,
  render: () => T,
): T => {
  const ownerWindow: RenderPerformanceWindow | null | undefined =
    canvas?.ownerDocument.defaultView;

  const profiler = ownerWindow?.__excalidrawRenderProfiler;

  if (!ownerWindow || !profiler) {
    return render();
  }

  const started = ownerWindow.performance.now();

  let result: T | undefined;
  let failure: unknown;
  let failed = false;

  try {
    result = render();
  } catch (error) {
    failure = error;
    failed = true;
  }

  const duration = ownerWindow.performance.now() - started;

  try {
    profiler({ phase, started, duration, elements });
  } catch {}

  if (failed) {
    throw failure;
  }

  return result as T;
};
