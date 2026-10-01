const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "excalidraw-deploy-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, ".local/bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["app", "shortcode", "shortcode-data", "units"]) {
    mkdirSync(path.join(directory, name));
  }
  for (const name of ["deploy.sh", "redeploy.sh"]) {
    copyFileSync(path.join(__dirname, name), path.join(directory, name));
  }
  copyFileSync(path.join(__dirname, "app/Dockerfile"), path.join(directory, "app/Dockerfile"));
  for (const name of ["package.json", "yarn.lock", ".npmrc", "excalidraw-app/package.json", "packages/common/package.json"]) {
    mkdirSync(path.dirname(path.join(directory, "app", name)), { recursive: true });
    writeFileSync(path.join(directory, "app", name), "fixture\n");
  }
  writeFileSync(path.join(directory, "shortcode/server.js"), "new backend\n");
  writeFileSync(path.join(directory, "shortcode-data/codes.json"), "persisted data\n");
  writeFileSync(path.join(directory, "Caddyfile"), "old config\n");
  const mock = path.join(directory, "mock.cjs");
  writeFileSync(mock, `
const fs = require("node:fs");
const path = require("node:path");
let [command, ...args] = process.argv.slice(2);
if (command === "sudo") [command, ...args] = args;
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify([command, ...args]) + "\\n");
if (command === "podman" && args[0] === "info") console.log(args.includes("{{.Store.GraphDriverName}}") ? "vfs" : process.env.HOME);
if (command === "podman" && args[0] === "build" && process.env.MOCK_FAIL_BUILD) process.exit(1);
if (command === "podman" && args[0] === "container" && process.env.MOCK_MISSING_CONTAINER) process.exit(1);
if (command === "systemctl" && args[0] === "cat" && process.env.MOCK_MISSING_UNITS) process.exit(1);
if (command === "df") console.log("Filesystem 1024-blocks Used Available Capacity Mounted on\\nmock 999999999 0 " + (process.env.MOCK_FREE_KB || "999999999") + " 1% /mock");
if (command === "tailscale") console.log(JSON.stringify({Self: {DNSName: "test.example."}}));
const cache = path.join(process.env.HOME, ".build-cache");
if (command === "rsync") fs.cpSync(args.at(-2), args.at(-1), {recursive: true});
if (command === "podman" && args[0] === "inspect") {
  const state = path.join(cache, "builder-config");
  if (!fs.existsSync(state)) process.exit(1);
  console.log(fs.readFileSync(state, "utf8"));
}
if (command === "podman" && args[0] === "create" && args.includes("excalidraw-builder")) {
  const base = args.find((argument) => argument.startsWith("org.excalidraw.builder-base="));
  fs.writeFileSync(path.join(cache, "builder-config"), base.split("=")[1] + "\\n" + path.join(cache, "source"));
}
if (command === "podman" && args[0] === "exec" && args.includes("--frozen-lockfile")) {
  if (process.env.MOCK_FAIL_INSTALL) process.exit(1);
  fs.mkdirSync(path.join(cache, "source/node_modules"), {recursive: true});
  fs.writeFileSync(path.join(cache, "source/node_modules/.yarn-integrity"), "installed");
}
if (command === "podman" && args[0] === "exec" && args.includes("build:app:docker")) {
  fs.mkdirSync(path.join(cache, "source/excalidraw-app/build"), {recursive: true});
  fs.writeFileSync(path.join(cache, "source/excalidraw-app/build/index.html"), "compiled");
}
if (command === "tee") {
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => fs.writeFileSync(path.join(process.env.HOME, "units", path.basename(args[0])), input));
}
`);
  for (const command of ["sudo", "git", "df", "openssl", "tailscale", "curl", "rsync"]) {
    writeFileSync(path.join(bin, command), `#!/bin/bash\nexec "${process.execPath}" "${mock}" "${command}" "$@"\n`, { mode: 0o755 });
  }
  const log = path.join(directory, "commands.jsonl");
  const env = { ...process.env, HOME: directory, FQDN: "test.example", MOCK_LOG: log, DEPLOY_BUILD_MODE: "container" };
  return {
    directory,
    env,
    run(args, extraEnv = {}, script = "deploy.sh") {
      const result = spawnSync("bash", [path.join(directory, script), ...args], {
        env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30000,
      });
      assert.ifError(result.error);
      return result;
    },
    commands() {
      return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
  };
}

function includesCommand(commands, ...prefix) {
  return commands.some((command) => prefix.every((value, index) => command[index] === value));
}

test("app deploy builds dependencies and frontend without touching backend or proxy", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"]);
  assert.equal(result.status, 0, result.stderr);
  const commands = setup.commands();
  assert.ok(includesCommand(commands, "podman", "build", "--layers", "--target", "dependencies"));
  assert.ok(includesCommand(commands, "podman", "build", "--layers", "-t", "excalidraw-selfhost"));
  assert.ok(includesCommand(commands, "systemctl", "stop", "excalidraw.service"));
  assert.ok(includesCommand(commands, "podman", "create", "--name", "excalidraw"));
  assert.ok(!includesCommand(commands, "systemctl", "stop", "excalidraw-shortcode.service"));
  assert.ok(!includesCommand(commands, "systemctl", "restart", "excalidraw-caddy.service"));
  assert.ok(!includesCommand(commands, "podman", "image", "prune"));
  assert.ok(!includesCommand(commands, "git", "pull"));
  assert.equal(commands.filter(([command]) => command === "curl").length, 3);
  assert.match(result.stdout, /TIMING: dependency image/);
  assert.match(result.stdout, /TIMING: total app deploy:/);
  assert.equal(readFileSync(path.join(setup.directory, "Caddyfile"), "utf8"), "old config\n");
});

test("backend deploy skips all builds and retains persisted data", (context) => {
  const setup = fixture(context);
  const result = setup.run(["backend", "--local"]);
  assert.equal(result.status, 0, result.stderr);
  const commands = setup.commands();
  assert.ok(!includesCommand(commands, "podman", "build"));
  assert.ok(!includesCommand(commands, "systemctl", "stop", "excalidraw.service"));
  assert.ok(!includesCommand(commands, "systemctl", "restart", "excalidraw-caddy.service"));
  assert.ok(includesCommand(commands, "podman", "create", "--name", "excalidraw-shortcode"));
  assert.equal(readFileSync(path.join(setup.directory, "shortcode-server.js"), "utf8"), "new backend\n");
  assert.equal(readFileSync(path.join(setup.directory, "shortcode-data/codes.json"), "utf8"), "persisted data\n");
});

test("default deploy pulls checkout and deploys both components", (context) => {
  const setup = fixture(context);
  const result = setup.run([]);
  assert.equal(result.status, 0, result.stderr);
  const commands = setup.commands();
  assert.ok(includesCommand(commands, "git", "pull", "--ff-only"));
  assert.ok(includesCommand(commands, "podman", "create", "--name", "excalidraw"));
  assert.ok(includesCommand(commands, "podman", "create", "--name", "excalidraw-shortcode"));
  assert.ok(includesCommand(commands, "systemctl", "restart", "excalidraw-caddy.service"));
  assert.match(result.stdout, /TIMING: total full deploy:/);
});

test("full redeploy skips proxy restart when routes are unchanged", (context) => {
  const setup = fixture(context);
  assert.equal(setup.run(["full", "--local"]).status, 0);
  const previousCount = setup.commands().length;
  const result = setup.run(["full", "--local"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!includesCommand(setup.commands().slice(previousCount), "systemctl", "restart", "excalidraw-caddy.service"));
  assert.match(result.stdout, /routes unchanged/);
});

test("direct redeploy discovers and exports hostname for app-only mode", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"], { FQDN: "" }, "redeploy.sh");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(setup.commands().some((command) => command.includes("FQDN_HOST=test.example")));
});

test("low build storage fails before image build or service swap", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"], { MOCK_FREE_KB: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Not enough build storage/);
  assert.ok(!includesCommand(setup.commands(), "podman", "build"));
  assert.ok(!includesCommand(setup.commands(), "systemctl", "stop"));
});

test("failed image build leaves existing services untouched", (context) => {
  const setup = fixture(context);
  const result = setup.run(["full", "--local"], { MOCK_FAIL_BUILD: "1" });
  assert.notEqual(result.status, 0);
  assert.ok(!includesCommand(setup.commands(), "systemctl", "stop"));
  assert.ok(!includesCommand(setup.commands(), "podman", "create"));
});

test("missing containers fail with installer instructions", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"], { MOCK_MISSING_CONTAINER: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Run .\/install.sh first/);
  assert.ok(!includesCommand(setup.commands(), "podman", "build"));
});

test("cleanup only prunes dangling images", (context) => {
  const setup = fixture(context);
  const result = setup.run(["cleanup"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(setup.commands(), [["podman", "image", "prune", "-f"]]);
});

test("start installs separate weekly cleanup service and timer", (context) => {
  const setup = fixture(context);
  const result = setup.run(["start"]);
  assert.equal(result.status, 0, result.stderr);
  const service = readFileSync(path.join(setup.directory, "units/excalidraw-cleanup.service"), "utf8");
  const timer = readFileSync(path.join(setup.directory, "units/excalidraw-cleanup.timer"), "utf8");
  assert.match(service, /deploy.sh" cleanup/);
  assert.match(timer, /OnCalendar=weekly/);
  assert.ok(includesCommand(setup.commands(), "systemctl", "enable", "--now", "excalidraw-cleanup.timer"));
});

test("deployment repairs missing units and installs cleanup scheduling", (context) => {
  const setup = fixture(context);
  const result = setup.run(["backend", "--local"], { MOCK_MISSING_UNITS: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(setup.directory, "units/excalidraw-cleanup.timer")));
  assert.ok(includesCommand(setup.commands(), "systemctl", "daemon-reload"));
  assert.ok(!includesCommand(setup.commands(), "podman", "build"));
});

test("build and cleanup refuse to run under another deployment's lock", async (context) => {
  const setup = fixture(context);
  const holder = spawn("bash", ["-c", 'exec 9>"$HOME/.deploy.lock"; flock -x 9; echo ready; read -r release'], { env: setup.env });
  const exited = once(holder, "exit");
  try {
    await once(holder.stdout, "data");
    for (const mode of ["build", "cleanup"]) {
      const result = setup.run([mode]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Another deployment or cleanup is running/);
    }
    assert.deepEqual(setup.commands(), []);
  } finally {
    holder.stdin.end("release\n");
    await exited;
  }
});

test("invalid deployment arguments fail without changing services", (context) => {
  const setup = fixture(context);
  for (const args of [["unknown"], ["app", "--invalid"], ["full", "--local", "extra"]]) {
    const result = setup.run(args);
    assert.equal(result.status, 2);
  }
  assert.ok(!includesCommand(setup.commands(), "podman"));
  assert.ok(!includesCommand(setup.commands(), "systemctl"));
});

test("Docker dependency stage contains every included workspace manifest before source copy", () => {
  const dockerfile = readFileSync(path.join(__dirname, "app/Dockerfile"), "utf8");
  const [dependencies, build] = dockerfile.split("FROM dependencies AS build");
  assert.ok(!dependencies.includes("COPY . ."));
  assert.ok(build.includes("COPY . ."));
  assert.ok(build.indexOf("ARG NODE_ENV") < build.indexOf("COPY . ."));
  const workspaces = ["excalidraw-app", ...readdirSync(path.join(__dirname, "app/packages")).map((name) => `packages/${name}`)];
  for (const workspace of workspaces) {
    if (existsSync(path.join(__dirname, "app", workspace, "package.json"))) {
      assert.ok(dependencies.includes(`COPY ${workspace}/package.json ./${workspace}/package.json`), workspace);
    }
  }
});

test("vfs auto mode reuses dependencies across source edits and builds only runtime images", (context) => {
  const setup = fixture(context);
  const env = { DEPLOY_BUILD_MODE: "auto" };
  assert.equal(setup.run(["app", "--local"], env).status, 0);
  writeFileSync(path.join(setup.directory, "app/excalidraw-app/source.ts"), "changed source");
  const result = setup.run(["app", "--local"], env);
  assert.equal(result.status, 0, result.stderr);
  const commands = setup.commands();
  assert.equal(commands.filter((command) => command.includes("--frozen-lockfile")).length, 1);
  assert.equal(commands.filter((command) => command.includes("build:app:docker")).length, 2);
  assert.equal(commands.filter((command) => command.some((argument) => argument.startsWith("org.excalidraw.builder-base="))).length, 1);
  assert.ok(commands.filter((command) => command[0] === "podman" && command[1] === "build").every((command) => command.includes("-f")));
  assert.equal(commands.filter((command) => command[0] === "podman" && command[1] === "stop" && command.includes("excalidraw-builder")).length, 2);
  assert.match(result.stdout, /installation skipped/);
  assert.ok(!existsSync(path.join(setup.directory, "app/node_modules")));
  assert.ok(!existsSync(path.join(setup.directory, "app/excalidraw-app/build")));
});

test("fast mode reinstalls dependencies after a manifest change", (context) => {
  const setup = fixture(context);
  const env = { DEPLOY_BUILD_MODE: "fast" };
  assert.equal(setup.run(["build"], env).status, 0);
  writeFileSync(path.join(setup.directory, "app/package.json"), "new manifest");
  const result = setup.run(["build"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(setup.commands().filter((command) => command.includes("--frozen-lockfile")).length, 2);
});

test("failed fast install stops builder and does not swap live services or record cache success", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"], { DEPLOY_BUILD_MODE: "fast", MOCK_FAIL_INSTALL: "1" });
  assert.notEqual(result.status, 0);
  assert.ok(includesCommand(setup.commands(), "podman", "stop", "-t", "1", "excalidraw-builder"));
  assert.ok(!includesCommand(setup.commands(), "systemctl", "stop"));
  assert.ok(!existsSync(path.join(setup.directory, ".build-cache/dependencies.sha256")));
});

test("runtime image uses the same pinned nginx base as the multi-stage build", () => {
  const dockerfile = readFileSync(path.join(__dirname, "app/Dockerfile"), "utf8");
  const runtime = readFileSync(path.join(__dirname, "app/Dockerfile.runtime"), "utf8");
  const nginxBase = dockerfile.split("\n").find((line) => line.startsWith("FROM nginx:"));
  assert.ok(runtime.startsWith(nginxBase));
  assert.ok(runtime.includes("COPY build/ /usr/share/nginx/html"));
});
