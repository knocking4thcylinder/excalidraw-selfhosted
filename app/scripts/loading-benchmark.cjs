const { execFileSync } = require("node:child_process");
const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { deflateSync, gzipSync } = require("node:zlib");

const root = path.resolve(__dirname, "../..");
const build =
  process.env.BENCH_BUILD_DIR ||
  path.join(root, ".build-cache/loading-benchmark/build");
const directory =
  process.env.BENCH_DATA_DIR ||
  mkdtempSync(path.join(os.tmpdir(), "excalidraw-loading-"));
const port = Number(process.env.BENCH_PORT || 5173);
const apiPort = Number(process.env.BENCH_API_PORT || 3006);
const socketPort = Number(process.env.BENCH_SOCKET_PORT || 3007);
const hostname =
  process.env.BENCH_HOST ||
  JSON.parse(
    execFileSync("tailscale", ["status", "--json"]),
  ).Self.DNSName.replace(/\.$/, "");
const image = process.env.BENCH_API_IMAGE || "excalidraw-api-elixir-sync-test";
const containers = [
  `whiteboard-benchmark-api-${process.pid}`,
  `whiteboard-benchmark-room-${process.pid}`,
];
const secret = Buffer.alloc(16, 7);
const key = secret.toString("base64url");
const assetBuffers = new Map();
const transfers = [];
const results = [];
const staticBuffers = new Map();
let delayMs = 0;
let bytesPerSecond = 0;
let offline = false;
let server;
const pendingResponses = [];
const podman = (...args) =>
  execFileSync("sudo", ["-n", "podman", ...args], {
    encoding: "utf8",
    timeout: 60000,
  });

const encrypt = (buffer) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-128-gcm", secret, iv);
  return {
    iv,
    ciphertext: Buffer.concat([
      cipher.update(buffer),
      cipher.final(),
      cipher.getAuthTag(),
    ]),
  };
};
const encryptedJSON = (value) => {
  const encrypted = encrypt(Buffer.from(JSON.stringify(value)));
  return {
    iv: encrypted.iv.toString("base64"),
    ciphertext: encrypted.ciphertext.toString("base64"),
  };
};
const decryptJSON = (record) => {
  const buffer = Buffer.from(record.ciphertext, "base64");
  const decipher = createDecipheriv(
    "aes-128-gcm",
    secret,
    Buffer.from(record.iv, "base64"),
  );
  decipher.setAuthTag(buffer.subarray(-16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(buffer.subarray(0, -16)),
      decipher.final(),
    ]).toString(),
  );
};
const concatenate = (...buffers) => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(1);
  return Buffer.concat([
    header,
    ...buffers.flatMap((buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(buffer.length);
      return [length, buffer];
    }),
  ]);
};
const crc32 = (buffer) => {
  let checksum = 0xffffffff;
  for (const byte of buffer) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++)
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  return (checksum ^ 0xffffffff) >>> 0;
};
const pngChunk = (name, data) => {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
};
const imageAsset = (imageIndex) => {
  const width = 256;
  const pixels = Buffer.alloc((width * 4 + 1) * width);
  let randomState = imageIndex + 1;
  for (let row = 0; row < width; row++) {
    for (let column = 0; column < width; column++) {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      const offset = row * (width * 4 + 1) + column * 4 + 1;
      pixels[offset] = randomState >>> 24;
      pixels[offset + 1] = randomState >>> 16;
      pixels[offset + 2] = randomState >>> 8;
      pixels[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const id = `benchmark-image-${imageIndex}`;
  const metadata = Buffer.from(
    JSON.stringify({ id, mimeType: "image/png", created: 1 }),
  );
  const contents = concatenate(
    metadata,
    Buffer.from(`data:image/png;base64,${png.toString("base64")}`),
  );
  const encrypted = encrypt(deflateSync(contents));
  assetBuffers.set(
    id,
    concatenate(
      Buffer.from(
        JSON.stringify({
          version: 2,
          compression: "pako@1",
          encryption: "AES-GCM",
        }),
      ),
      encrypted.iv,
      encrypted.ciphertext,
    ),
  );
  return id;
};
const baseElement = (index) => ({
  id: `benchmark-shape-${index}`,
  x: (index % 60) * 35,
  y: Math.floor(index / 60) * 25,
  width: 30,
  height: 18,
  angle: 0,
  strokeColor: ["#1971c2", "#e03131", "#2f9e44"][index % 3],
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: `a0V${String(index).padStart(5, "0")}V`,
  roundness: null,
  seed: index + 1,
  version: 1,
  versionNonce: index + 1,
  isDeleted: false,
  boundElements: [],
  link: null,
  locked: false,
  updated: 1,
});
const drawings = {
  "benchmark-large": Array.from({ length: 2400 }, (_, index) => ({
    ...baseElement(index),
    type: "freedraw",
    simulatePressure: true,
    pressures: [],
    lastCommittedPoint: null,
    points: Array.from({ length: 32 }, (_, point) => [
      Number(((point * 30) / 31).toFixed(2)),
      Number((9 + Math.sin(point / 3 + index) * 8).toFixed(2)),
    ]),
  })),
  "benchmark-images": Array.from({ length: 16 }, (_, index) => ({
    ...baseElement(index),
    id: `benchmark-image-shape-${index}`,
    type: "image",
    fileId: imageAsset(index),
    status: "saved",
    x: (index % 4) * 280,
    y: Math.floor(index / 4) * 280,
    width: 256,
    height: 256,
    scale: [1, 1],
    crop: null,
  })),
};

const bootScript = `(() => {
  const ownerWindow = document.currentScript.ownerDocument.defaultView;
  const boot = ownerWindow.__loadingBenchmarkBoot = {requests: [], decryptions: [], longTasks: []};
  const nativeFetch = ownerWindow.fetch.bind(ownerWindow);
  ownerWindow.fetch = async (input, options) => {
    let address = typeof input === "string" ? input : input.url || String(input);
    const roomFile = address.match(new RegExp("/api/rooms/[^/]+/files/([^/?]+)"));
    if (roomFile && (options?.method || "GET") === "GET") {
      address = "/__bench/assets/" + roomFile[1];
      input = address;
    }
    const tracked = address.includes("/api/rooms") || address.includes("/__bench/assets/");
    const record = {url: address, method: options?.method || "GET", started: ownerWindow.performance.now(), uploadBytes: typeof options?.body === "string" ? options.body.length : 0};
    if (tracked) boot.requests.push(record);
    try {
      const response = await nativeFetch(input, options);
      record.headersMs = ownerWindow.performance.now();
      record.status = response.status;
      record.downloadBytes = Number(response.headers.get("content-length") || 0);
      return response;
    } catch (error) { record.error = String(error); record.failedMs = ownerWindow.performance.now(); throw error; }
  };
  const nativeDecrypt = ownerWindow.crypto.subtle.decrypt.bind(ownerWindow.crypto.subtle);
  ownerWindow.crypto.subtle.decrypt = async (...argumentsList) => {
    const started = ownerWindow.performance.now();
    try { return await nativeDecrypt(...argumentsList); }
    finally { boot.decryptions.push({started, duration: ownerWindow.performance.now() - started}); }
  };
  if (ownerWindow.PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    new ownerWindow.PerformanceObserver(list => list.getEntries().forEach(entry => boot.longTasks.push({started:entry.startTime, duration:entry.duration})))
      .observe({type:"longtask", buffered:true});
  }
  if (new URL(ownerWindow.location.href).searchParams.get("androidProfile") === "1") {
    const script = ownerWindow.document.createElement("script");
    script.src = "/__bench/android.js";
    ownerWindow.document.head.appendChild(script);
  }
})();`;

const json = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
};
const sendData = (response, status, headers, buffer) => {
  response.writeHead(status, { ...headers, "content-length": buffer.length });
  if (!bytesPerSecond || status === 304) response.end(buffer);
  else pendingResponses.push({ response, buffer, offset: 0 });
};
const throttleTimer = setInterval(() => {
  if (!bytesPerSecond) {
    for (const pending of pendingResponses.splice(0)) {
      if (!pending.response.destroyed)
        pending.response.end(pending.buffer.subarray(pending.offset));
    }
    return;
  }
  let budget = Math.max(1, Math.floor(bytesPerSecond / 50));
  let visits = pendingResponses.length + Math.ceil(budget / 16384);
  while (pendingResponses.length && visits-- > 0 && budget > 0) {
    const pending = pendingResponses.shift();
    if (pending.response.destroyed) continue;
    const size = Math.min(
      budget,
      16384,
      pending.buffer.length - pending.offset,
    );
    pending.response.write(
      pending.buffer.subarray(pending.offset, pending.offset + size),
    );
    pending.offset += size;
    budget -= size;
    if (pending.offset === pending.buffer.length) pending.response.end();
    else pendingResponses.push(pending);
  }
}, 20);
const apiRequest = async (pathname, method = "GET", body) => {
  const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Fixture API returned ${response.status}`);
  return response;
};
const patchRoom = async (roomId) => {
  if (!drawings[roomId]) throw new Error("Unknown fixture room");
  const response = await apiRequest(
    `/api/rooms/${roomId}/scene?key=${key}&sync=1`,
  );
  const manifest = await response.json();
  let elements = decryptJSON(manifest);
  for (const encryptedPatch of manifest.patches) {
    const patch = decryptJSON(encryptedPatch);
    const values = new Map(elements.map((element) => [element.id, element]));
    for (const id of patch.removedIds) values.delete(id);
    for (const element of patch.upserts) values.set(element.id, element);
    elements = patch.order
      ? patch.order.map((id) => values.get(id))
      : [...values.values()];
  }
  const edited = {
    ...elements[0],
    x: elements[0].x + 25,
    version: elements[0].version + 1,
    versionNonce: elements[0].versionNonce + 10000,
  };
  await apiRequest(`/api/rooms/${roomId}/scene`, "PATCH", {
    key,
    syncVersion: 1,
    baseEtag: response.headers.get("etag"),
    ...encryptedJSON({ format: 1, upserts: [edited], removedIds: [] }),
    sceneVersion:
      elements.reduce((total, element) => total + element.version, 0) + 1,
    isEmpty: false,
  });
};
const proxy = (request, response, targetPort) => {
  const chunks = [];
  let uploadBytes = 0;
  const started = Date.now();
  const forwarded = http.request(
    {
      host: "127.0.0.1",
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${targetPort}` },
    },
    (upstream) => {
      upstream.on("data", (chunk) => chunks.push(chunk));
      upstream.on("end", () => {
        const body = Buffer.concat(chunks);
        transfers.push({
          method: request.method,
          path: request.url,
          status: upstream.statusCode,
          downloadBytes: body.length,
          uploadBytes,
          backendMs: Date.now() - started,
        });
        sendData(response, upstream.statusCode, upstream.headers, body);
      });
    },
  );
  request.on("data", (chunk) => {
    uploadBytes += chunk.length;
  });
  forwarded.on("error", () =>
    json(response, 502, { error: "isolated upstream unavailable" }),
  );
  request.pipe(forwarded);
};
const handler = async (request, response) => {
  const address = new URL(request.url, `https://${hostname}:${port}`);
  if (address.pathname === "/__bench/control") {
    delayMs = Math.max(0, Number(address.searchParams.get("delay") || 0));
    bytesPerSecond = Math.max(0, Number(address.searchParams.get("rate") || 0));
    offline = address.searchParams.get("offline") === "1";
    if (address.searchParams.has("resetMetrics")) transfers.length = 0;
    return json(response, 200, { delayMs, bytesPerSecond, offline });
  }
  if (address.pathname === "/__bench/metrics")
    return json(response, 200, {
      transfers,
      results,
      directory,
      rooms: Object.fromEntries(
        Object.entries(drawings).map(([id, elements]) => [
          id,
          {
            elements: elements.length,
            plaintextBytes: Buffer.byteLength(JSON.stringify(elements)),
            firstElementId: elements[0].id,
          },
        ]),
      ),
    });
  if (address.pathname === "/__bench/patch") {
    await patchRoom(address.searchParams.get("room"));
    return json(response, 200, { ok: true });
  }
  if (address.pathname === "/__bench/result" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    results.push(JSON.parse(body));
    writeFileSync(
      path.join(directory, "results.json"),
      JSON.stringify(results, null, 2),
    );
    return json(response, 200, { ok: true });
  }
  if (address.pathname === "/__bench/reset") {
    response.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
    });
    const next = JSON.stringify(
      `/?run=${encodeURIComponent(
        address.searchParams.get("run") || "cold",
      )}#room=${address.searchParams.get("room") || "benchmark-large"},${key}`,
    );
    return response.end(
      `<body>Clearing isolated benchmark storage…<script>(async()=>{
        localStorage.clear();
        for(const entry of await indexedDB.databases()) {
          await new Promise((resolve,reject)=>{
            const request=indexedDB.open(entry.name);
            request.onerror=()=>reject(request.error);
            request.onblocked=()=>reject(new Error("Close other tabs using the benchmark origin and retry"));
            request.onsuccess=()=>{
              const database=request.result;
              const stores=Array.from(database.objectStoreNames);
              if(!stores.length){database.close();resolve();return;}
              const transaction=database.transaction(stores,"readwrite");
              transaction.oncomplete=()=>{database.close();resolve();};
              transaction.onabort=()=>{database.close();reject(transaction.error);};
              for(const store of stores)transaction.objectStore(store).clear();
            };
          });
        }
        location.replace(${next});
      })().catch(error=>document.body.textContent=String(error));</script>`,
    );
  }
  if (address.pathname === "/__bench/boot.js") {
    response.writeHead(200, {
      "content-type": "text/javascript",
      "cache-control": "no-store",
    });
    return response.end(bootScript);
  }
  if (address.pathname === "/__bench/android.js") {
    response.writeHead(200, {
      "content-type": "text/javascript",
      "cache-control": "no-store",
    });
    return response.end(
      readFileSync(path.join(__dirname, "android-profile.js")),
    );
  }
  if (address.pathname.startsWith("/__bench/assets/")) {
    const data = assetBuffers.get(
      decodeURIComponent(address.pathname.split("/").pop()),
    );
    if (offline || !data)
      return json(response, offline ? 503 : 404, {
        error: "asset unavailable",
      });
    transfers.push({
      method: "GET",
      path: address.pathname,
      status: 200,
      downloadBytes: data.length,
      uploadBytes: 0,
    });
    return setTimeout(
      () =>
        sendData(
          response,
          200,
          {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
          },
          data,
        ),
      delayMs,
    );
  }
  if (address.pathname.startsWith("/api/")) {
    if (offline) return json(response, 503, { error: "benchmark API offline" });
    const delayed =
      request.method === "GET" && address.pathname.endsWith("/scene");
    return setTimeout(
      () => proxy(request, response, apiPort),
      delayed ? delayMs : 0,
    );
  }
  if (address.pathname.startsWith("/socket.io/"))
    return proxy(request, response, socketPort);
  const filename = path.resolve(
    build,
    `.${address.pathname === "/" ? "/index.html" : address.pathname}`,
  );
  if (!filename.startsWith(`${build}/`) || !existsSync(filename))
    return json(response, 404, { error: "not found" });
  let data = staticBuffers.get(filename);
  if (!data) {
    data = readFileSync(filename);
    if (filename.endsWith("index.html"))
      data = Buffer.from(
        data
          .toString()
          .replace("<head>", '<head><script src="/__bench/boot.js"></script>'),
      );
    staticBuffers.set(filename, data);
  }
  const extension = path.extname(filename);
  const contentType =
    {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".woff2": "font/woff2",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    }[extension] || "application/octet-stream";
  const compress =
    [".html", ".js", ".css", ".json"].includes(extension) &&
    request.headers["accept-encoding"]?.includes("gzip");
  const body = compress ? gzipSync(data) : data;
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": filename.endsWith("index.html")
      ? "no-store"
      : "public, max-age=3600",
    ...(compress
      ? { "content-encoding": "gzip", vary: "accept-encoding" }
      : {}),
  });
  response.end(body);
};
const shutdown = (exitCode = 0) => {
  clearInterval(throttleTimer);
  server?.close();
  for (const container of containers) {
    try {
      podman("rm", "-f", container);
    } catch {}
  }
  process.exit(exitCode);
};
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

(async () => {
  if (!existsSync(path.join(build, "index.html")))
    throw new Error("Build the benchmark bundle first");
  for (const candidate of [port, apiPort, socketPort]) {
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(candidate, "0.0.0.0", () => probe.close(resolve));
    });
  }
  mkdirSync(path.join(directory, "data"), { recursive: true });
  podman(
    "run",
    "-d",
    "--name",
    containers[0],
    "--network",
    "host",
    "-e",
    `PORT=${apiPort}`,
    "-e",
    "ERL_FLAGS=+S 4:4",
    "-e",
    "RELEASE_DISTRIBUTION=none",
    "-e",
    "SCENE_SYNC_ENABLED=true",
    "-v",
    `${directory}/data:/data`,
    image,
  );
  podman(
    "run",
    "-d",
    "--name",
    containers[1],
    "-p",
    `127.0.0.1:${socketPort}:80`,
    "docker.io/excalidraw/excalidraw-room:latest",
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/api/rooms`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const [roomId, elements] of Object.entries(drawings)) {
    await apiRequest("/api/rooms", "POST", { roomId, roomKey: key });
    await apiRequest(`/api/rooms/${roomId}/scene`, "POST", {
      key,
      ...encryptedJSON(elements),
      sceneVersion: elements.length,
      isEmpty: false,
      syncVersion: 1,
      baseEtag: null,
    });
  }
  server = https.createServer(
    {
      cert: readFileSync(
        process.env.BENCH_CERT || path.join(root, "certs", `${hostname}.crt`),
      ),
      key: readFileSync(
        process.env.BENCH_KEY || path.join(root, "certs", `${hostname}.key`),
      ),
    },
    (request, response) => {
      handler(request, response).catch((error) => {
        console.error(error);
        if (!response.headersSent)
          json(response, 500, { error: String(error) });
        else response.destroy();
      });
    },
  );
  server.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(socketPort, "127.0.0.1", () => {
      upstream.write(
        `${request.method} ${request.url} HTTP/${
          request.httpVersion
        }\r\n${Object.entries(request.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  server.on("error", (error) => {
    console.error(error);
    shutdown(1);
  });
  server.listen(port, "0.0.0.0", () => {
    const summary = {
      url: `https://${hostname}:${port}/?run=large-cold#room=benchmark-large,${key}`,
      directory,
      containers,
      key,
      rooms: Object.fromEntries(
        Object.entries(drawings).map(([id, elements]) => [
          id,
          {
            elements: elements.length,
            plaintextBytes: Buffer.byteLength(JSON.stringify(elements)),
          },
        ]),
      ),
      assetBytes: [...assetBuffers.values()].reduce(
        (total, data) => total + data.length,
        0,
      ),
    };
    writeFileSync(
      path.join(directory, "fixture.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary, null, 2));
  });
})().catch((error) => {
  console.error(error);
  shutdown(1);
});
