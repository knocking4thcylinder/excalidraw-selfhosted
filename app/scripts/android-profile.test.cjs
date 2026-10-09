const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const script = readFileSync(path.join(__dirname, "android-profile.js"), "utf8");
const runFixture = async ({
  room = "benchmark-large",
  failUploads = false,
  frameMs = 16.7,
} = {}) => {
  let now = 0;
  const reports = [];
  const updates = [];
  const visits = [];
  const requests = [];
  const scenes = {
    "benchmark-large": [{ id: "large", type: "freedraw" }],
    "benchmark-images": [{ id: "image", type: "image", fileId: "asset" }],
  };
  let activeRoom = room;
  let state = { scrollX: 42, scrollY: 31, zoom: { value: 0.5 } };
  const initialState = state;
  let complete;
  const done = new Promise((resolve) => {
    complete = resolve;
  });
  const location = {
    href: `https://fixture.test:5174/?androidProfile=1&run=test#room=${room},key`,
  };
  Object.defineProperty(location, "hash", {
    get: () => new URL(location.href).hash,
  });
  const ownerWindow = {
    location,
    URL,
    performance: { now: () => now },
    navigator: { userAgent: "fake-WebView" },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    document: { visibilityState: "visible" },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) =>
      setImmediate(() => {
        now += frameMs;
        callback(now);
      }),
    cancelAnimationFrame: clearImmediate,
    history: {
      replaceState: (_state, _title, address) => {
        location.href = address.href;
      },
    },
    HashChangeEvent: class {
      constructor(type, values) {
        Object.assign(this, { type, ...values });
      }
    },
    dispatchEvent: () => {
      activeRoom = new URL(location.href).hash.slice(6).split(",")[0];
    },
    __loadingBenchmarkBoot: { longTasks: [] },
    fetch: async (address, options) => {
      requests.push(address);
      if (address === "/__bench/result") {
        if (failUploads) {
          complete();
          return { ok: false, status: 503 };
        }
        const report = JSON.parse(options.body);
        reports.push(report);
        if (["complete", "error"].includes(report.phase)) complete();
        return { ok: true };
      }
      return {
        ok: true,
        json: async () => ({
          rooms: {
            "benchmark-large": { elements: 1, firstElementId: "large" },
            "benchmark-images": { elements: 1, firstElementId: "image" },
          },
        }),
      };
    },
    __loadingBenchmark: {
      api: {
        getSceneElements: () => scenes[activeRoom] || [],
        getFiles: () => ({ asset: {} }),
        getAppState: () => state,
        updateScene: (update) => {
          updates.push(update);
          state = { ...state, ...update.appState };
        },
      },
      snapshot: () => ({ validationPending: false }),
      flush: async () => {},
      beginRoomSwitch: (label, expectedElementId) =>
        visits.push({ label, expectedElementId }),
      resetProfile: () => {},
    },
  };
  const context = vm.createContext({
    document: {
      currentScript: { ownerDocument: { defaultView: ownerWindow } },
    },
    URL,
  });
  vm.runInContext(script, context);
  await done;
  return { reports, updates, visits, requests, state, initialState };
};

test("self-reporting fixture warms rooms and measures programmatic pans without editing elements", async () => {
  const result = await runFixture();
  assert.equal(result.reports.at(-1).phase, "complete");
  assert.equal(
    result.reports.filter((report) => report.phase === "programmatic-pan")
      .length,
    4,
  );
  assert.equal(
    result.visits.filter((visit) => visit.label.includes("cached")).length,
    6,
  );
  assert.ok(
    result.requests.every((address) => address.startsWith("/__bench/")),
  );
  assert.ok(
    result.updates.every((update) => Object.keys(update).join() === "appState"),
  );
  assert.deepEqual(result.state, result.initialState);
  for (const report of result.reports.filter(
    (entry) => entry.phase === "programmatic-pan",
  )) {
    assert.equal(report.rafIntervalsMs.length, 120);
    assert.ok(report.rafIntervalsMs.every((duration) => duration > 0));
  }
});

test("rejects a non-fixture room before changing scene state", async () => {
  const result = await runFixture({ room: "production-room" });
  assert.equal(result.reports.at(-1).phase, "error");
  assert.match(result.reports.at(-1).error, /isolated fixture/);
  assert.equal(result.updates.length, 0);
  assert.equal(result.visits.length, 0);
});

test("failed result upload does not start scene operations", async () => {
  const result = await runFixture({ failUploads: true });
  assert.equal(result.updates.length, 0);
  assert.equal(result.visits.length, 0);
});

test("slow animation scheduling bounds each pan and reports partial samples", async () => {
  const result = await runFixture({ frameMs: 1000 });
  assert.equal(result.reports.at(-1).phase, "complete");
  const pans = result.reports.filter(
    (report) => report.phase === "programmatic-pan",
  );
  assert.equal(pans.length, 4);
  assert.ok(pans.every((report) => report.completedSteps < 120));
  assert.ok(pans.every((report) => report.durationMs < 50000));
  assert.deepEqual(result.state, result.initialState);
});
