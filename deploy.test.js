const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "excalidraw-deploy-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, ".local/bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["app", "backend", "shortcode-data", "units", "quadlet"]) {
    mkdirSync(path.join(directory, name));
  }
  for (const name of ["deploy.sh", "Caddyfile.template"]) {
    copyFileSync(path.join(__dirname, name), path.join(directory, name));
  }
  cpSync(path.join(__dirname, "systemd"), path.join(directory, "systemd"), { recursive: true });
  copyFileSync(path.join(__dirname, "app/Dockerfile"), path.join(directory, "app/Dockerfile"));
  for (const name of ["package.json", "yarn.lock", ".npmrc", "excalidraw-app/package.json", "packages/common/package.json"]) {
    mkdirSync(path.dirname(path.join(directory, "app", name)), { recursive: true });
    writeFileSync(path.join(directory, "app", name), "fixture\n");
  }
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
if (command === "curl" && process.env.MOCK_FAIL_CHECK) {
  if (process.env.MOCK_NEW_DATABASE) fs.writeFileSync(path.join(process.env.HOME, "shortcode-data/whiteboard.sqlite3"), "imported database");
  process.exit(1);
}
if (command === "podman" && args[0] === "image" && args[1] === "exists" && process.env.MOCK_MISSING_IMAGE) process.exit(1);
// Root file helpers (podman run --entrypoint <cmd> <image> <args>) run for real
// inside the fixture directory.
if (command === "podman" && args[0] === "run" && args.includes("--entrypoint")) {
  const entrypoint = args.indexOf("--entrypoint");
  const result = require("node:child_process").spawnSync(args[entrypoint + 1], args.slice(entrypoint + 3), {stdio: "inherit"});
  process.exit(result.status);
}
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
  process.stdin.on("end", () => fs.writeFileSync(args[0], input));
}
`);
  for (const command of ["sudo", "git", "df", "openssl", "tailscale", "curl", "rsync"]) {
    writeFileSync(path.join(bin, command), `#!/bin/bash\nexec "${process.execPath}" "${mock}" "${command}" "$@"\n`, { mode: 0o755 });
  }
  const log = path.join(directory, "commands.jsonl");
  const env = {
    ...process.env, HOME: directory, FQDN: "test.example", MOCK_LOG: log, DEPLOY_BUILD_MODE: "container",
    QUADLET_DIR: path.join(directory, "quadlet"), UNIT_DIR: path.join(directory, "units"),
  };
  return {
    directory,
    env,
    run(args, extraEnv = {}) {
      const result = spawnSync("bash", [path.join(directory, "deploy.sh"), ...args], {
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

// File work on root-owned backend data runs as `podman run --entrypoint <cmd> <image> <args>`;
// returns those inner commands as [cmd, ...args].
function rootFileCommands(commands) {
  return commands
    .filter((command) => command[0] === "podman" && command[1] === "run" && command.includes("--entrypoint"))
    .map((command) => {
      const entrypoint = command.indexOf("--entrypoint");
      return [command[entrypoint + 1], ...command.slice(entrypoint + 3)];
    });
}

function imageBuilds(commands, image) {
  return commands.filter((command) => command[0] === "podman" && command[1] === "build" && command.includes(image)).length;
}

function systemctl(commands, ...args) {
  return commands.filter((command) => command[0] === "systemctl" && args.every((value, index) => command[index + 1] === value));
}

function tags(commands) {
  return commands.filter((command) => command[0] === "podman" && command[1] === "tag").map((command) => command.slice(2));
}

test("app deploy rebuilds and restarts only the app", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"]);
  assert.equal(result.status, 0, result.stderr);
  const commands = setup.commands();
  assert.ok(includesCommand(commands, "podman", "build", "--layers", "--target", "dependencies"));
  assert.ok(includesCommand(commands, "podman", "build", "--layers", "-t", "excalidraw-selfhost"));
  assert.deepEqual(tags(commands), [["excalidraw-selfhost:latest", "excalidraw-selfhost:previous"]]);
  assert.equal(systemctl(commands, "restart", "excalidraw.service").length, 1);
  assert.equal(imageBuilds(commands, "excalidraw-api-elixir"), 0);
  assert.equal(systemctl(commands, "stop").length, 0);
  assert.equal(systemctl(commands, "restart", "excalidraw-caddy.service").length, 0);
  assert.ok(!includesCommand(commands, "podman", "image", "prune"));
  assert.ok(!includesCommand(commands, "git", "pull"));
  assert.equal(commands.filter(([command]) => command === "curl").length, 3);
  assert.match(result.stdout, /TIMING: dependency image/);
  assert.match(result.stdout, /TIMING: total app deploy:/);
  assert.equal(readFileSync(path.join(setup.directory, "Caddyfile"), "utf8"), "old config\n");
});

test("app deploy discovers and exports the hostname", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"], { FQDN: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(setup.commands().some((command) => command[0] === "curl" && command.includes("https://test.example:8443/")));
});

test("default deploy pulls the checkout, reruns the pulled script and deploys everything", (context) => {
  const setup = fixture(context);
  const result = setup.run([]);
  assert.equal(result.status, 0, result.stderr);
  const commands = setup.commands();
  assert.equal(commands.filter((command) => command[0] === "git" && command[1] === "pull").length, 1);
  assert.equal(imageBuilds(commands, "excalidraw-selfhost"), 1);
  assert.equal(imageBuilds(commands, "excalidraw-api-elixir"), 1);
  assert.equal(systemctl(commands, "restart", "excalidraw-caddy.service").length, 1);
  const config = readFileSync(path.join(setup.directory, "Caddyfile"), "utf8");
  assert.match(config, /^test\.example:8443 \{/);
  assert.match(config, /tls \/certs\/test\.example\.crt \/certs\/test\.example\.key/);
  assert.deepEqual([...config.matchAll(/handle (\S+) \{\s+reverse_proxy localhost:(\d+)/g)].map((match) => match.slice(1)), [
    ["/s/*", "3003"], ["/api/code*", "3003"], ["/api/resolve*", "3003"],
    ["/api/rooms*", "3003"], ["/socket.io/*", "3002"],
  ]);
  assert.match(config, /handle \{\s+reverse_proxy localhost:3000/);
  assert.ok(!config.includes("@@FQDN@@"));
  assert.match(result.stdout, /TIMING: total full deploy:/);
});

test("full redeploy skips proxy restart when routes are unchanged", (context) => {
  const setup = fixture(context);
  assert.equal(setup.run(["full", "--local"]).status, 0);
  const previousCount = setup.commands().length;
  const result = setup.run(["full", "--local"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(systemctl(setup.commands().slice(previousCount), "restart", "excalidraw-caddy.service").length, 0);
  assert.match(result.stdout, /routes unchanged/);
});

test("missing images fail with installer instructions", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"], { MOCK_MISSING_IMAGE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Run .\/install.sh first/);
  assert.ok(!includesCommand(setup.commands(), "podman", "build"));
  assert.equal(readdirSync(path.join(setup.directory, "quadlet")).length, 0);
});

test("failed image build switches the tag back and leaves services running", (context) => {
  const setup = fixture(context);
  const result = setup.run(["full", "--local"], { MOCK_FAIL_BUILD: "1" });
  assert.notEqual(result.status, 0);
  const commands = setup.commands();
  assert.deepEqual(tags(commands), [
    ["excalidraw-selfhost:latest", "excalidraw-selfhost:previous"],
    ["excalidraw-selfhost:previous", "excalidraw-selfhost:latest"],
  ]);
  assert.equal(systemctl(commands, "stop").length, 0);
  assert.equal(systemctl(commands, "restart").length, 0);
});

test("failed fast install stops the builder without restarting services or recording cache success", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"], { DEPLOY_BUILD_MODE: "fast", MOCK_FAIL_INSTALL: "1" });
  assert.notEqual(result.status, 0);
  assert.ok(includesCommand(setup.commands(), "podman", "stop", "-t", "1", "excalidraw-builder"));
  assert.equal(systemctl(setup.commands(), "restart").length, 0);
  assert.ok(!existsSync(path.join(setup.directory, ".build-cache/dependencies.sha256")));
});

test("failed app health check restores the previous app image", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"], { MOCK_FAIL_CHECK: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /switching back to the previous images/);
  const commands = setup.commands();
  assert.deepEqual(tags(commands), [
    ["excalidraw-selfhost:latest", "excalidraw-selfhost:previous"],
    ["excalidraw-selfhost:previous", "excalidraw-selfhost:latest"],
  ]);
  const lastTag = commands.findLastIndex((command) => command[0] === "podman" && command[1] === "tag");
  assert.equal(systemctl(commands.slice(lastTag), "restart", "excalidraw.service").length, 1);
  assert.equal(systemctl(commands, "stop").length, 0);
});

test("Elixir backend builds before stopping, backs up data and passes settings through .backend.env", (context) => {
  const setup = fixture(context);
  const result = setup.run(["backend", "--local"]);
  assert.equal(result.status, 0, result.stderr);
  const commands = setup.commands();
  assert.equal(commands.filter((command) => command[0] === "podman" && command[1] === "build").length, 1);
  const buildIndex = commands.findIndex((command) => command[0] === "podman" && command[1] === "build");
  const stopIndex = commands.findIndex((command) => command[0] === "systemctl" && command[1] === "stop");
  assert.ok(buildIndex >= 0 && buildIndex < stopIndex);
  assert.deepEqual(commands[stopIndex], ["systemctl", "stop", "excalidraw-shortcode.service"]);
  assert.ok(includesCommand(rootFileCommands(commands), "cp", "-a", path.join(setup.directory, "shortcode-data")));
  assert.equal(systemctl(commands, "start", "excalidraw-shortcode.service").length, 1);
  assert.equal(systemctl(commands, "restart", "excalidraw.service").length, 0);
  assert.equal(readFileSync(path.join(setup.directory, ".backend.env"), "utf8"), "SCENE_SYNC_ENABLED=false\n");
  assert.equal(readFileSync(path.join(setup.directory, "shortcode-data/codes.json"), "utf8"), "persisted data\n");
  const [backup] = readdirSync(path.join(setup.directory, "recovery"));
  assert.equal(readFileSync(path.join(setup.directory, "recovery", backup, "data/codes.json"), "utf8"), "persisted data\n");
});

test("successful backend deploys keep only the newest data backups", (context) => {
  const setup = fixture(context);
  for (let index = 0; index < 4; index += 1) {
    mkdirSync(path.join(setup.directory, `recovery/backend-2020010${index}-000000-1`), { recursive: true });
  }
  mkdirSync(path.join(setup.directory, "recovery/manual-snapshot"));
  assert.equal(setup.run(["backend", "--local"], { BACKEND_BACKUPS_KEPT: "2" }).status, 0);
  const removed = rootFileCommands(setup.commands()).filter((command) => command[0] === "rm" && command[1] === "-rf").map((command) => path.basename(command.at(-1)));
  assert.deepEqual(removed.sort(), ["backend-20200100-000000-1", "backend-20200101-000000-1", "backend-20200102-000000-1"]);
  assert.equal(readdirSync(path.join(setup.directory, "recovery")).length, 3);
});

test("failed Elixir build leaves the old service untouched", (context) => {
  const setup = fixture(context);
  const result = setup.run(["backend", "--local"], { MOCK_FAIL_BUILD: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(systemctl(setup.commands(), "stop").length, 0);
  assert.deepEqual(tags(setup.commands()).at(-1), ["excalidraw-api-elixir:previous", "excalidraw-api-elixir:latest"]);
});

test("scene sync opt-in persists across successful backend deployments", (context) => {
  const setup = fixture(context);
  const result = setup.run(["backend", "--local"], { SCENE_SYNC_ENABLED: "true" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(setup.directory, ".scene-sync-enabled"), "utf8"), "true\n");
  assert.equal(setup.run(["backend", "--local"]).status, 0);
  assert.equal(readFileSync(path.join(setup.directory, ".backend.env"), "utf8"), "SCENE_SYNC_ENABLED=true\n");
});

test("scene sync validation runs before changing services", (context) => {
  const setup = fixture(context);
  const result = setup.run(["backend", "--local"], { SCENE_SYNC_ENABLED: "invalid" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /SCENE_SYNC_ENABLED must be/);
  assert.deepEqual(setup.commands(), []);
});

test("failed Elixir health check restores the previous image, settings and database", (context) => {
  const setup = fixture(context);
  const result = setup.run(["backend", "--local"], { MOCK_FAIL_CHECK: "1", MOCK_NEW_DATABASE: "1", SCENE_SYNC_ENABLED: "true" });
  assert.notEqual(result.status, 0);
  const commands = setup.commands();
  assert.deepEqual(tags(commands).at(-1), ["excalidraw-api-elixir:previous", "excalidraw-api-elixir:latest"]);
  assert.equal(systemctl(commands, "start", "excalidraw-shortcode.service").length, 2);
  assert.ok(includesCommand(rootFileCommands(commands), "mv", path.join(setup.directory, "shortcode-data/whiteboard.sqlite3")));
  assert.ok(!existsSync(path.join(setup.directory, "shortcode-data/whiteboard.sqlite3")));
  assert.equal(readFileSync(path.join(setup.directory, ".backend.env"), "utf8"), "SCENE_SYNC_ENABLED=false\n");
  assert.ok(!existsSync(path.join(setup.directory, ".scene-sync-enabled")));
});

test("start installs rendered Quadlet and timer units, then leaves unchanged units alone", (context) => {
  const setup = fixture(context);
  const result = setup.run(["start"]);
  assert.equal(result.status, 0, result.stderr);
  const quadlets = readdirSync(path.join(setup.directory, "quadlet")).sort();
  assert.deepEqual(quadlets, ["excalidraw-caddy.container", "excalidraw-room.container", "excalidraw-shortcode.container", "excalidraw.container"]);
  for (const name of [...quadlets.map((name) => `quadlet/${name}`), ...readdirSync(path.join(setup.directory, "units")).map((name) => `units/${name}`)]) {
    assert.ok(!readFileSync(path.join(setup.directory, name), "utf8").match(/@[A-Z]+@/), name);
  }
  assert.match(readFileSync(path.join(setup.directory, "quadlet/excalidraw-shortcode.container"), "utf8"),
    new RegExp(`Volume=${setup.directory}/shortcode-data:/data`));
  assert.match(readFileSync(path.join(setup.directory, "units/excalidraw-cleanup.service"), "utf8"), /deploy.sh cleanup/);
  assert.match(readFileSync(path.join(setup.directory, "units/excalidraw-cleanup.timer"), "utf8"), /OnCalendar=weekly/);
  assert.match(readFileSync(path.join(setup.directory, "units/excalidraw-cert-renew.service"), "utf8"), /FQDN=test\.example/);
  const commands = setup.commands();
  assert.equal(systemctl(commands, "daemon-reload").length, 1);
  assert.ok(includesCommand(commands, "systemctl", "enable", "excalidraw-stack.target", "excalidraw-cert-renew.timer", "excalidraw-cleanup.timer"));
  assert.ok(includesCommand(commands, "systemctl", "start", "excalidraw-stack.target"));
  assert.equal(readFileSync(path.join(setup.directory, ".backend.env"), "utf8"), "SCENE_SYNC_ENABLED=false\n");

  const previousCount = commands.length;
  assert.equal(setup.run(["start"]).status, 0);
  const again = setup.commands().slice(previousCount);
  assert.ok(!again.some(([command]) => command === "tee"));
  assert.equal(systemctl(again, "daemon-reload").length, 0);
});

test("start restarts only containers whose definition changed", (context) => {
  const setup = fixture(context);
  assert.equal(setup.run(["start"]).status, 0);
  writeFileSync(path.join(setup.directory, "quadlet/excalidraw-room.container"), "stale\n");
  const previousCount = setup.commands().length;
  assert.equal(setup.run(["start"]).status, 0);
  const commands = setup.commands().slice(previousCount);
  assert.deepEqual(systemctl(commands, "try-restart"), [["systemctl", "try-restart", "excalidraw-room.service"]]);
});

test("start creates the Quadlet directory through a root container", (context) => {
  const setup = fixture(context);
  rmSync(path.join(setup.directory, "quadlet"), { recursive: true });
  assert.equal(setup.run(["start"]).status, 0);
  assert.ok(includesCommand(rootFileCommands(setup.commands()), "mkdir", "-p", path.join(setup.directory, "quadlet")));
  assert.equal(readdirSync(path.join(setup.directory, "quadlet")).length, 4);
});

test("start replaces hand-written units from before Quadlet", (context) => {
  const setup = fixture(context);
  for (const name of ["excalidraw.service", "excalidraw-stack.service", "excal-redeploy.service"]) {
    writeFileSync(path.join(setup.directory, "units", name), "[Service]\n");
  }
  const result = setup.run(["start"]);
  assert.equal(result.status, 0, result.stderr);
  const commands = setup.commands();
  assert.ok(includesCommand(commands, "systemctl", "disable", "--now", "excalidraw.service", "excalidraw-stack.service", "excal-redeploy.service"));
  for (const name of ["excalidraw.service", "excalidraw-stack.service", "excal-redeploy.service"]) {
    assert.ok(!existsSync(path.join(setup.directory, "units", name)), name);
  }
  const disable = commands.findIndex((command) => command[0] === "systemctl" && command[1] === "disable");
  const reload = commands.findIndex((command) => command[0] === "systemctl" && command[1] === "daemon-reload");
  assert.ok(disable < reload);
});

test("unit files describe one stack of four host-network containers", () => {
  const directory = path.join(__dirname, "systemd");
  const containers = readdirSync(directory).filter((name) => name.endsWith(".container"));
  const target = readFileSync(path.join(directory, "excalidraw-stack.target"), "utf8");
  assert.equal(containers.length, 4);
  for (const name of containers) {
    const unit = readFileSync(path.join(directory, name), "utf8");
    const service = name.replace(/\.container$/, "");
    assert.match(unit, new RegExp(`^ContainerName=${service}$`, "m"));
    assert.match(unit, /^PartOf=excalidraw-stack\.target$/m);
    assert.match(unit, /^Network=host$/m);
    assert.match(target, new RegExp(`^Wants=.*\\b${service}\\.service\\b`, "m"));
  }
  const roomImage = readFileSync(path.join(directory, "excalidraw-room.container"), "utf8").match(/^Image=(.*)$/m)[1];
  assert.ok(readFileSync(path.join(__dirname, "install.sh"), "utf8").includes(`podman pull ${roomImage}`));
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

test("deploy.sh only uses the commands the Deck allows through passwordless sudo", () => {
  const source = readFileSync(path.join(__dirname, "deploy.sh"), "utf8");
  const commands = [...source.matchAll(/^[^#\n]*\bsudo\s+(\S+)/gm)].map((match) => match[1]);
  assert.ok(commands.length > 0);
  assert.deepEqual(commands.filter((command) => !["podman", "systemctl", "tee"].includes(command)), []);
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

test("runtime image uses the same pinned nginx base as the multi-stage build", () => {
  const dockerfile = readFileSync(path.join(__dirname, "app/Dockerfile"), "utf8");
  const runtime = readFileSync(path.join(__dirname, "app/Dockerfile.runtime"), "utf8");
  const nginxBase = dockerfile.split("\n").find((line) => line.startsWith("FROM nginx:"));
  assert.ok(runtime.startsWith(nginxBase));
  assert.ok(runtime.includes("COPY build/ /usr/share/nginx/html"));
  assert.ok(runtime.includes("COPY nginx.conf /etc/nginx/conf.d/default.conf"));
  assert.ok(dockerfile.includes("COPY excalidraw-app/nginx.conf /etc/nginx/conf.d/default.conf"));
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

test("low build storage fails before image build or service swap", (context) => {
  const setup = fixture(context);
  const result = setup.run(["app", "--local"], { MOCK_FREE_KB: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Not enough build storage/);
  assert.ok(!includesCommand(setup.commands(), "podman", "build"));
  assert.ok(!includesCommand(setup.commands(), "systemctl", "stop"));
});

test("cleanup only prunes dangling images", (context) => {
  const setup = fixture(context);
  const result = setup.run(["cleanup"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(setup.commands(), [["podman", "image", "prune", "-f"]]);
});

