import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const CHANNEL = process.argv.find((argument) => argument.startsWith("--channel="))
  ?.slice("--channel=".length) || "chrome";
assert(["chrome", "edge"].includes(CHANNEL), "channel must be chrome or edge");
const EXTENSION_PATH = join(PROJECT_ROOT, CHANNEL);
const FIXTURE_PATH = join(PROJECT_ROOT, "test", "fixture");
const ACTION_TIMEOUT = 5_000;
const UI_TIMEOUT = 7_000;
const STORAGE_TIMEOUT = 7_000;
const CASE_FILTER = process.argv.find((argument) => argument.startsWith("--filter="))
  ?.slice("--filter=".length) || "";
const FIXTURE_FILES = new Set([
  "index.html",
  "other.html",
  "cross.html",
  "frame.html",
  "overlays.html"
]);

const MODIFIERS = {
  Control: { key: "Control", code: "ControlLeft", mask: 2 },
  Alt: { key: "Alt", code: "AltLeft", mask: 1 },
  Meta: { key: "Meta", code: "MetaLeft", mask: 4 },
  Shift: { key: "Shift", code: "ShiftLeft", mask: 8 }
};
const STANDARD_SELECTION_MODIFIER = "Shift";

class CdpClient {
  constructor(url, label) {
    this.url = url;
    this.label = label;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await withTimeout(new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    }), 8_000, `连接 ${this.label}`);

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(`${this.label} ${pending.method}: ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) {
        listener(message.params);
      }
    });

    const rejectPending = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`${this.label} CDP 连接意外关闭`));
      }
      this.pending.clear();
    };
    this.socket.addEventListener("close", rejectPending, { once: true });
  }

  send(method, params = {}, timeout = 10_000) {
    assert.equal(this.socket?.readyState, WebSocket.OPEN, `${this.label} CDP 未连接`);
    const id = ++this.sequence;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`${this.label} ${method} 等待 ${timeout}ms 超时`));
      }, timeout);
      this.pending.set(id, { method, resolve: resolveSend, reject: rejectSend, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
    return () => {
      this.listeners.set(method, (this.listeners.get(method) || []).filter((item) => item !== listener));
    };
  }

  close() {
    this.socket?.close();
  }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function withTimeout(promise, timeout, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(`${label}等待 ${timeout}ms 超时`)), timeout);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check, label, timeout = 7_000, interval = 50) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeout) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  const suffix = lastError ? `；最后错误：${lastError.message}` : "";
  throw new Error(`${label}等待 ${timeout}ms 超时${suffix}`);
}

function mimeType(fileName) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml"
  }[extname(fileName)] || "application/octet-stream";
}

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const fileName = url.pathname === "/" ? "index.html" : basename(decodeURIComponent(url.pathname));
      if (!FIXTURE_FILES.has(fileName)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const body = await readFile(join(FIXTURE_PATH, fileName));
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": mimeType(fileName)
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object", "测试服务器未取得端口");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  };
}

async function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    process.platform === "win32"
      ? join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe")
      : null
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known Chrome location.
    }
  }
  throw new Error("找不到 Chrome。请设置 CHROME_BIN 为 Chrome 可执行文件绝对路径。");
}

async function launchChrome(initialUrl) {
  const chromeBinary = await findChromeBinary();
  const profilePath = await mkdtemp(join(tmpdir(), "annoy-killer-e2e-profile-"));
  const args = [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--force-device-scale-factor=1",
    "--window-size=1280,900",
    initialUrl
  ];
  if (process.env.ANNOY_KILLER_TEST_DISABLE_WEBGL === "1") args.unshift("--disable-webgl");
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    args.unshift("--no-sandbox");
  }

  const chrome = spawn(chromeBinary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-24_000);
  });

  const activePortFile = join(profilePath, "DevToolsActivePort");
  const activePort = await waitFor(async () => {
    if (chrome.exitCode !== null) {
      throw new Error(`Chrome 提前退出 (${chrome.exitCode})\n${diagnostics}`);
    }
    try {
      const [port] = (await readFile(activePortFile, "utf8")).trim().split(/\r?\n/);
      return /^\d+$/.test(port) ? Number(port) : null;
    } catch {
      return null;
    }
  }, "Chrome DevTools 端口", 12_000);

  return {
    chrome,
    diagnostics: () => diagnostics,
    port: activePort,
    profilePath,
    async close() {
      if (chrome.exitCode === null) {
        chrome.kill("SIGTERM");
        await Promise.race([
          new Promise((resolveExit) => chrome.once("exit", resolveExit)),
          sleep(2_000).then(() => chrome.kill("SIGKILL"))
        ]);
      }
      await rm(profilePath, { recursive: true, force: true });
    }
  };
}

async function getHttpTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  assert(response.ok, `读取 Chrome targets 失败：HTTP ${response.status}`);
  return response.json();
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text || "页面表达式执行失败";
    throw new Error(`${client.label}: ${detail}`);
  }
  return response.result.value;
}

function attributesOf(node) {
  const entries = [];
  for (let index = 0; index < (node.attributes || []).length; index += 2) {
    entries.push([node.attributes[index], node.attributes[index + 1]]);
  }
  return Object.fromEntries(entries);
}

function flattenDom(node, ancestors = [], output = []) {
  if (!node) {
    return output;
  }
  output.push({ node, ancestors });
  const nextAncestors = [...ancestors, node];
  for (const child of node.children || []) {
    flattenDom(child, nextAncestors, output);
  }
  for (const shadowRoot of node.shadowRoots || []) {
    flattenDom(shadowRoot, nextAncestors, output);
  }
  if (node.contentDocument) {
    flattenDom(node.contentDocument, nextAncestors, output);
  }
  return output;
}

function hasClass(node, className) {
  return (attributesOf(node).class || "").split(/\s+/).includes(className);
}

function hasExtensionAncestor(entry) {
  return entry.ancestors.some((ancestor) =>
    Object.keys(attributesOf(ancestor)).some((name) => name.startsWith("data-annoy-killer"))
  );
}

async function piercedEntries(page) {
  await page.send("DOM.enable");
  const { root } = await page.send("DOM.getDocument", { depth: -1, pierce: true });
  return flattenDom(root);
}

async function findPiercedNode(page, predicate, label) {
  const match = (await piercedEntries(page)).find(predicate);
  assert(match, `closed shadow DOM 中找不到${label}`);
  return match.node;
}

async function callOnNode(page, node, functionDeclaration, args = []) {
  const { object } = await page.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
  assert(object.objectId, `无法解析 DOM 节点 ${node.nodeName}`);
  try {
    const response = await page.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  } finally {
    await page.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
  }
}

async function nodeBox(page, node) {
  const box = await page.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
  const quad = box.model.border;
  return {
    left: Math.min(quad[0], quad[2], quad[4], quad[6]),
    top: Math.min(quad[1], quad[3], quad[5], quad[7]),
    right: Math.max(quad[0], quad[2], quad[4], quad[6]),
    bottom: Math.max(quad[1], quad[3], quad[5], quad[7])
  };
}

function centerOf(rect) {
  return {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2
  };
}

async function rectFor(page, elementExpression) {
  // Storage assertions bring the options tab forward; background tabs may
  // suspend rAF entirely, so focus the page before waiting for layout frames.
  await page.send("Page.bringToFront");
  const rect = await evaluate(page, `(async () => {
    const element = (${elementExpression});
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height };
  })()`);
  assert(rect && rect.width > 0 && rect.height > 0, `目标没有可点击区域：${elementExpression}`);
  return rect;
}

async function dispatchMouseClick(page, point, modifiers = 0) {
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: point.x, y: point.y, modifiers
  });
  await sleep(100);
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y,
    button: "left", clickCount: 1, modifiers
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y,
    button: "left", clickCount: 1, modifiers
  });
}

async function keyChange(page, modifier, type) {
  const config = MODIFIERS[modifier];
  assert(config, `未知修饰键：${modifier}`);
  await page.send("Input.dispatchKeyEvent", {
    type,
    key: config.key,
    code: config.code,
    modifiers: type === "keyDown" ? config.mask : 0
  });
}

async function closePickerWithEscape(page) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await waitFor(async () => evaluate(page,
    "!document.querySelector('[data-annoy-killer-ui]')"), "Escape 自动保存并关闭", STORAGE_TIMEOUT);
}

async function clickClosedShadowButton(page, ariaLabel) {
  await page.send("Page.bringToFront");
  const button = await waitFor(async () => {
    const node = await findPiercedNode(page, ({ node: candidate, ancestors }) =>
      candidate.nodeName === "BUTTON" &&
      attributesOf(candidate)["aria-label"] === ariaLabel &&
      ancestors.some((ancestor) => Object.prototype.hasOwnProperty.call(
        attributesOf(ancestor), "data-annoy-killer-ui"
      )), `“${ariaLabel}”按钮`);
    const state = await callOnNode(page, node, `function () {
      const rect = this.getBoundingClientRect();
      const root = this.getRootNode();
      const pointX = (rect.left + rect.right) / 2;
      const pointY = (rect.top + rect.bottom) / 2;
      const internalHit = root.elementFromPoint?.(pointX, pointY);
      const host = root.host;
      const documentHit = document.elementFromPoint(pointX, pointY);
      const style = getComputedStyle(this);
      const hostStyle = host ? getComputedStyle(host) : null;
      return {
        enabled: !this.disabled,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" &&
          style.display !== "none" && Number(style.opacity) !== 0 &&
          (!hostStyle || (hostStyle.visibility !== "hidden" && hostStyle.display !== "none" &&
            Number(hostStyle.opacity) !== 0)),
        hit: internalHit === this || this.contains(internalHit),
        hostHit: !host || documentHit === host || host.contains(documentHit)
      };
    }`);
    return state.enabled && state.visible && state.hit && state.hostHit ? { node, state } : null;
  }, `闭合 Shadow DOM “${ariaLabel}”按钮可真实命中`, UI_TIMEOUT, 20);
  await dispatchMouseClick(page, centerOf(await nodeBox(page, button.node)));
}

async function highlightState(page) {
  const node = await findPiercedNode(page, ({ node: candidate, ancestors }) =>
    hasClass(candidate, "highlight") &&
    ancestors.some((ancestor) => Object.prototype.hasOwnProperty.call(
      attributesOf(ancestor), "data-annoy-killer-ui"
    )), "选区高亮");
  return callOnNode(page, node, `function () {
    const rect = this.getBoundingClientRect();
    const style = getComputedStyle(this);
    return { display: style.display, left: rect.left, top: rect.top,
      right: rect.right, bottom: rect.bottom, className: this.className };
  }`);
}

async function toolbarCount(page) {
  const node = await findPiercedNode(page, ({ node: candidate, ancestors }) =>
    hasClass(candidate, "count") &&
    ancestors.some((ancestor) => Object.prototype.hasOwnProperty.call(
      attributesOf(ancestor), "data-annoy-killer-ui"
    )), "隐藏计数");
  return callOnNode(page, node, "function () { return this.textContent; }");
}

async function hiddenPreviewMaskState(page, elementExpression) {
  const expected = await rectFor(page, elementExpression);
  let lastStates = [];
  try {
    return await waitFor(async () => {
    const entries = (await piercedEntries(page)).filter(({ node }) =>
      hasClass(node, "hidden-preview-mask"));
    lastStates = [];
    for (const { node } of entries) {
      const state = await callOnNode(page, node, `function () {
        const rect = this.getBoundingClientRect();
        const button = this.querySelector("button");
        const buttonRect = button.getBoundingClientRect();
        const center = { x: (buttonRect.left + buttonRect.right) / 2,
          y: (buttonRect.top + buttonRect.bottom) / 2 };
        const hit = this.getRootNode().elementFromPoint(center.x, center.y);
        const anchor = this.previousElementSibling;
        return {
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          opacity: Number(getComputedStyle(this).opacity),
          background: getComputedStyle(this).backgroundColor,
          backdropFilter: getComputedStyle(this).backdropFilter,
          maskZ: Number(getComputedStyle(this).zIndex),
          layerZ: Number(getComputedStyle(this.parentElement).zIndex),
          hostZ: this.getRootNode().host
            ? Number(getComputedStyle(this.getRootNode().host).zIndex)
            : null,
          anchored: this.hasAttribute("data-annoy-killer-preview-mask"),
          eyeOpenness: Number(this.dataset.eyeOpenness),
          referencePath: button.querySelector(".eye-reference")?.getAttribute("d"),
          buttonBackground: getComputedStyle(button).backgroundColor,
          buttonShadow: getComputedStyle(button).boxShadow,
          buttonColor: getComputedStyle(button).color,
          eyeSize: parseFloat(getComputedStyle(button.querySelector("svg")).width),
          strokeWidth: Number(button.querySelector(".eye-contour").getAttribute("stroke-width")),
          buttonWidth: buttonRect.width,
          icon: Boolean(button.querySelector("svg path")),
          iris: Boolean(button.querySelector('svg circle[stroke="currentColor"]')),
          pupil: Boolean(button.querySelector('svg circle[fill="currentColor"]')),
          label: button.getAttribute("aria-label"),
          center,
          hitButton: hit === button || button.contains(hit),
          hitNode: hit ? hit.localName + "#" + (hit.id || "") + "." + (hit.className || "") +
            (hit.hasAttribute("data-annoy-killer-ui") ? "[ui]" : "") +
            (hit.hasAttribute("data-annoy-killer-preview-mask") ? "[mask]" : "") : null,
          maskPosition: getComputedStyle(this).position,
          maskPointerEvents: getComputedStyle(this).pointerEvents,
          buttonPointerEvents: getComputedStyle(button).pointerEvents,
          anchorPosition: anchor ? getComputedStyle(anchor).position : null,
          anchorZ: anchor ? getComputedStyle(anchor).zIndex : null
        };
      }`);
      lastStates.push(state);
      if (rectsNearlyEqual(state, expected) && state.opacity > 0.95 &&
          state.icon && state.buttonWidth > 0 && state.hitButton) {
        return state;
      }
    }
    return null;
    }, "隐藏项遮罩跟随模块位置", UI_TIMEOUT);
  } catch (error) {
    error.message += `；期望=${JSON.stringify(expected)}；实际=${JSON.stringify(lastStates)}`;
    throw error;
  }
}

async function restoreAllButtonState(page) {
  const node = await findPiercedNode(page, ({ node: candidate }) =>
    hasClass(candidate, "restore-all"), "恢复全部按钮");
  return callOnNode(page, node, `function () {
    const rect = this.getBoundingClientRect();
    return { visible: rect.width > 0 && rect.height > 0,
      disabled: this.disabled };
  }`);
}

async function canvasEntries(page) {
  return (await piercedEntries(page)).filter((entry) =>
    entry.node.nodeName === "CANVAS" && hasExtensionAncestor(entry)
  );
}

async function canvasStats(page) {
  const entries = await canvasEntries(page);
  const stats = [];
  for (const entry of entries) {
    const sampled = await callOnNode(page, entry.node, `async function () {
      const rect = this.getBoundingClientRect();
      let context = this.getContext("2d");
      if (!context && this.dataset.annoyKillerRenderer === "webgl") {
        // Read in the rendering frame before the non-preserved GPU buffer is
        // discarded. Production rendering never reads pixels back to the CPU.
        const copy = document.createElement("canvas");
        copy.width = this.width;
        copy.height = this.height;
        context = copy.getContext("2d");
        await new Promise(resolve => requestAnimationFrame(() => {
          context.drawImage(this, 0, 0);
          resolve();
        }));
      }
      if (!context || !this.width || !this.height) {
        return { width: this.width, height: this.height, nonZero: 0, alpha: 0, hash: 0,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            width: rect.width, height: rect.height } };
      }
      const data = context.getImageData(0, 0, this.width, this.height).data;
      const step = Math.max(1, Math.floor(Math.sqrt((this.width * this.height) / 90000)));
      let nonZero = 0;
      let alpha = 0;
      let weightedX = 0;
      let weightedY = 0;
      let hash = 2166136261;
      let minX = this.width;
      let minY = this.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < this.height; y += step) {
        for (let x = 0; x < this.width; x += step) {
          const index = (y * this.width + x) * 4;
          const pixelAlpha = data[index + 3];
          if (!pixelAlpha) continue;
          nonZero += 1;
          alpha += pixelAlpha;
          weightedX += x * pixelAlpha;
          weightedY += y * pixelAlpha;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          hash = Math.imul(hash ^ data[index] ^ data[index + 1] ^
            data[index + 2] ^ pixelAlpha, 16777619);
        }
      }
      return {
        width: this.width,
        height: this.height,
        nonZero,
        alpha,
        hash: hash >>> 0,
        centerX: alpha ? weightedX / alpha : 0,
        centerY: alpha ? weightedY / alpha : 0,
        bounds: nonZero ? { minX, minY, maxX, maxY } : null,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height },
        opacity: Number(getComputedStyle(this).opacity)
      };
    }`);
    stats.push({
      ...sampled,
      layer: attributesOf(entry.node)["data-annoy-killer-layer"] || "unknown",
      renderer: attributesOf(entry.node)["data-annoy-killer-renderer"] || "canvas2d",
      particleCount: Number(
        attributesOf(entry.node)["data-annoy-killer-particle-count"] || 0
      )
    });
  }
  return stats;
}

function canvasSignature(stats) {
  return stats.map((item) =>
    `${item.layer}:${item.hash}:${item.nonZero}:${Math.round(item.alpha)}:${item.opacity}`
  ).join("|");
}

async function startAnimationFrameProbe(page) {
  await evaluate(page, `(() => {
    window.__annoyKillerFrameProbe?.stop?.();
    const probe = {
      intervals: [],
      longTasks: [],
      rafId: 0,
      observer: null,
      stopped: false,
      lastFrameAt: 0,
      stop() {
        this.stopped = true;
        cancelAnimationFrame(this.rafId);
        this.observer?.disconnect();
      }
    };
    const frame = (now) => {
      if (probe.stopped) return;
      if (probe.lastFrameAt) probe.intervals.push(now - probe.lastFrameAt);
      probe.lastFrameAt = now;
      probe.rafId = requestAnimationFrame(frame);
    };
    try {
      probe.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
      });
      probe.observer.observe({ type: "longtask" });
    } catch {}
    probe.rafId = requestAnimationFrame(frame);
    window.__annoyKillerFrameProbe = probe;
    return true;
  })()`);
}

async function stopAnimationFrameProbe(page) {
  return evaluate(page, `(() => {
    const probe = window.__annoyKillerFrameProbe;
    if (!probe) return null;
    probe.stop();
    const intervals = probe.intervals.slice().sort((a, b) => a - b);
    const percentile = (ratio) => intervals.length
      ? intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * ratio))]
      : 0;
    const result = {
      frames: intervals.length,
      average: intervals.length
        ? intervals.reduce((total, value) => total + value, 0) / intervals.length
        : 0,
      p95: percentile(0.95),
      maximum: intervals.at(-1) || 0,
      longTaskCount: probe.longTasks.length,
      longestTask: probe.longTasks.length ? Math.max(...probe.longTasks) : 0
    };
    delete window.__annoyKillerFrameProbe;
    return result;
  })()`);
}

function paintedPageBounds(canvas) {
  if (!canvas.bounds || !canvas.rect || !canvas.width || !canvas.height) {
    return null;
  }
  const scaleX = canvas.rect.width / canvas.width;
  const scaleY = canvas.rect.height / canvas.height;
  return {
    left: canvas.rect.left + canvas.bounds.minX * scaleX,
    top: canvas.rect.top + canvas.bounds.minY * scaleY,
    right: canvas.rect.left + (canvas.bounds.maxX + 1) * scaleX,
    bottom: canvas.rect.top + (canvas.bounds.maxY + 1) * scaleY
  };
}

function rectsOverlap(first, second) {
  return Math.min(first.right, second.right) > Math.max(first.left, second.left) &&
    Math.min(first.bottom, second.bottom) > Math.max(first.top, second.top);
}

async function visible(page, elementExpression) {
  return evaluate(page, `(() => {
    const element = (${elementExpression});
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
      style.visibility !== "hidden" && Number(style.opacity) !== 0;
  })()`);
}

async function waitVisible(page, elementExpression, expected, label, timeout = UI_TIMEOUT) {
  await waitFor(async () => (await visible(page, elementExpression)) === expected,
    `${label}应${expected ? "显示" : "隐藏"}`, timeout);
}

async function shadowDiagnostics(page, targetExpression, cardExpression) {
  return evaluate(page, `(() => {
    const target = (${targetExpression});
    const card = (${cardExpression});
    const root = target?.getRootNode();
    const host = root?.host;
    const describe = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.localName,
        id: element.id,
        className: element.className,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height },
        display: style.display,
        visibility: style.visibility,
        session: element.getAttribute("data-annoy-killer-session-hidden"),
        persistent: element.hasAttribute("data-annoy-killer-persistent-hidden")
      };
    };
    const targetRect = target?.getBoundingClientRect();
    const innerHit = targetRect && root?.elementFromPoint?.(
      (targetRect.left + targetRect.right) / 2,
      (targetRect.top + targetRect.bottom) / 2
    );
    const adoptedRules = [];
    for (const sheet of root?.adoptedStyleSheets || []) {
      try {
        adoptedRules.push(...[...sheet.cssRules].map((rule) => rule.cssText));
      } catch {}
    }
    const fallbackRootStyle = root?.querySelector?.("style[data-annoy-killer-root-style]");
    return {
      target: describe(target),
      card: describe(card),
      host: describe(host),
      rootStyle: Boolean(fallbackRootStyle) || adoptedRules.some((rule) =>
        rule.includes("data-annoy-killer-session-hidden") && rule.includes("display: none")),
      rootStyleMode: fallbackRootStyle ? "style" : adoptedRules.length ? "adopted" : "none",
      innerHit: describe(innerHit)
    };
  })()`);
}

async function selectAndAssertShadowFine(e2e, page, {
  targetExpression,
  cardExpression,
  modifier,
  label
}) {
  const hovered = await e2e.hover(page, targetExpression, modifier);
  let highlight;
  let highlightError = null;
  try {
    await waitFor(async () => {
      highlight = await highlightState(page);
      return highlight.className.includes("fine") && rectsNearlyEqual(highlight, hovered.rect);
    }, `${label}高亮严格命中内部元素`, 2_000, 20);
  } catch (error) {
    highlightError = error;
    highlight = await highlightState(page);
  }
  const before = await shadowDiagnostics(page, targetExpression, cardExpression);

  await e2e.pressSelection(page, hovered);
  let hideError = null;
  try {
    await waitVisible(page, targetExpression, false, label);
  } catch (error) {
    hideError = error;
  }
  const after = await shadowDiagnostics(page, targetExpression, cardExpression);
  const evidence = JSON.stringify({ highlight, expected: hovered.rect, before, after });
  if (highlightError) {
    throw new Error(`${highlightError.message}；诊断=${evidence}`);
  }
  if (hideError) {
    throw new Error(`${hideError.message}；诊断=${evidence}`);
  }
  assert.notEqual(after.target?.session, null,
    `${label}点击后内部元素缺少 session 隐藏属性；诊断=${evidence}`);
  assert.equal(after.rootStyle, true,
    `${label}点击后 ShadowRoot 缺少隐藏样式；诊断=${evidence}`);
  return { before, after };
}

async function captureFailure(page, artifactPath, name, storage) {
  await mkdir(artifactPath, { recursive: true });
  const safeName = name.replace(/[^\p{Letter}\p{Number}_.-]+/gu, "-");
  if (page) {
    try {
      const screenshot = await page.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false
      });
      await writeFile(join(artifactPath, `${safeName}.png`), Buffer.from(screenshot.data, "base64"));
    } catch {
      // The page may already be gone. Storage evidence is still preserved below.
    }
  }
  await writeFile(join(artifactPath, `${safeName}.storage.json`),
    `${JSON.stringify(storage, null, 2)}\n`);
}

async function captureScreenshot(page, artifactPath, name) {
  await mkdir(artifactPath, { recursive: true });
  const screenshot = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  const path = join(artifactPath, `${name}.png`);
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
  return path;
}

class ExtensionE2E {
  constructor({ browser, chromeEnvironment, extensionId, optionsPage, primaryOrigin, crossOrigin }) {
    this.browser = browser;
    this.chromeEnvironment = chromeEnvironment;
    this.extensionId = extensionId;
    this.optionsPage = optionsPage;
    this.primaryOrigin = primaryOrigin;
    this.crossOrigin = crossOrigin;
    this.caseSequence = 0;
    this.pages = new Set();
  }

  fixtureUrl(pathname = "/index.html", label = "case") {
    const url = new URL(pathname, this.primaryOrigin);
    url.searchParams.set("case", `${++this.caseSequence}-${label}`);
    url.searchParams.set("crossOrigin", this.crossOrigin);
    return url.href;
  }

  crossFixtureUrl(pathname = "/cross.html", label = "cross") {
    const url = new URL(pathname, this.crossOrigin);
    url.searchParams.set("case", `${++this.caseSequence}-${label}`);
    return url.href;
  }

  async connectPage(targetId, label) {
    const target = await waitFor(async () =>
      (await getHttpTargets(this.chromeEnvironment.port)).find((item) => item.id === targetId),
    `${label} target`);
    const page = new CdpClient(target.webSocketDebuggerUrl, label);
    page.targetId = targetId;
    await page.open();
    await Promise.all([
      page.send("Runtime.enable"),
      page.send("Page.enable"),
      page.send("DOM.enable"),
      page.send("Performance.enable")
    ]);
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    this.pages.add(page);
    return page;
  }

  async openPage(url, label, background = false) {
    const { targetId } = await this.browser.send("Target.createTarget", { url, background });
    const page = await this.connectPage(targetId, label);
    await this.waitDocument(page, url);
    return page;
  }

  async closePage(page) {
    page.close();
    this.pages.delete(page);
    await this.browser.send("Target.closeTarget", { targetId: page.targetId }).catch(() => undefined);
  }

  async waitDocument(page, expectedUrl) {
    await waitFor(async () => evaluate(page, `location.href === ${JSON.stringify(expectedUrl)} &&
      document.readyState === "complete"`), `${page.label} 加载 ${expectedUrl}`, 10_000);
    if (expectedUrl.startsWith(this.primaryOrigin) || expectedUrl.startsWith(this.crossOrigin)) {
      await waitFor(async () => evaluate(page, "Boolean(window.__fixture?.version)"),
        `${page.label} fixture ready`, 5_000);
    }
  }

  async navigate(page, url) {
    await page.send("Page.navigate", { url });
    await this.waitDocument(page, url);
    await sleep(120);
  }

  async clearStorage() {
    assert(this.optionsPage, "设置页尚未连接，无法清理扩展存储");
    await this.optionsPage.send("Page.bringToFront");
    await evaluate(this.optionsPage, `(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ ruleSyncEnabled: false });
      await chrome.storage.sync.clear();
      await chrome.alarms.clear('annoy-killer:sync-rules');
      return true;
    })()`);
  }

  async getStorage(keys) {
    assert(this.optionsPage, "设置页尚未连接，无法读取扩展存储");
    await this.optionsPage.send("Page.bringToFront");
    return evaluate(this.optionsPage,
      `chrome.storage.local.get(${JSON.stringify(keys ?? null)})`);
  }

  async setStorage(values) {
    assert(this.optionsPage, "设置页尚未连接，无法写入扩展存储");
    await this.optionsPage.send("Page.bringToFront");
    await evaluate(this.optionsPage,
      `chrome.storage.local.set(${JSON.stringify(values)}).then(() => true)`);
  }

  async removeStorage(keys) {
    assert(this.optionsPage, "设置页尚未连接，无法删除扩展存储");
    await this.optionsPage.send("Page.bringToFront");
    await evaluate(this.optionsPage,
      `chrome.storage.local.remove(${JSON.stringify(keys)}).then(() => true)`);
  }

  async executeInContentWorld(page, functionDeclaration, args = []) {
    assert(this.optionsPage, "设置页尚未连接，无法执行隔离世界测试探针");
    const url = await evaluate(page, "location.href");
    return evaluate(this.optionsPage, `(async () => {
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter(tab => tab.url === ${JSON.stringify(url)});
      if (matches.length !== 1) {
        throw new Error(${JSON.stringify("测试页必须对应且仅对应一个浏览器标签页")} +
          "：" + ${JSON.stringify(url)} + "；实际=" + matches.length);
      }
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: matches[0].id, frameIds: [0] },
        world: "ISOLATED",
        func: (${functionDeclaration}),
        args: ${JSON.stringify(args)}
      });
      return injection?.result;
    })()`);
  }

  async installFirstCommitResponseDelay(page) {
    const installed = await this.executeInContentWorld(page, function () {
      globalThis.__annoyKillerCommitResponseDelay?.restore?.();
      const original = chrome.runtime.sendMessage;
      let forwardFirst;
      let releaseFirst;
      const forwardGate = new Promise(resolve => { forwardFirst = resolve; });
      const responseGate = new Promise(resolve => { releaseFirst = resolve; });
      const state = {
        commitCalls: 0,
        firstIntercepted: false,
        firstForwardStarted: false,
        firstForwarded: false,
        firstReleased: false
      };
      const patched = function (...args) {
        const message = args.find(value => value && typeof value === "object" && value.type);
        if (message?.type !== "annoy-killer:commit-rules") {
          return original.apply(chrome.runtime, args);
        }
        state.commitCalls += 1;
        if (state.commitCalls !== 1) return original.apply(chrome.runtime, args);
        state.firstIntercepted = true;
        return forwardGate.then(() => {
          state.firstForwardStarted = true;
          return original.apply(chrome.runtime, args);
        }).then(result => {
          state.firstForwarded = true;
          state.firstResult = result;
          return responseGate.then(() => result);
        });
      };
      chrome.runtime.sendMessage = patched;
      globalThis.__annoyKillerCommitResponseDelay = {
        state,
        forward() {
          if (state.firstForwardStarted) return;
          forwardFirst();
        },
        release() {
          if (state.firstReleased) return;
          state.firstReleased = true;
          releaseFirst();
        },
        restore() {
          this.forward();
          this.release();
          if (chrome.runtime.sendMessage === patched) chrome.runtime.sendMessage = original;
          delete globalThis.__annoyKillerCommitResponseDelay;
        }
      };
      return chrome.runtime.sendMessage === patched;
    });
    assert.equal(installed, true, "无法安装首个规则提交响应延迟探针");
  }

  async commitResponseDelayState(page) {
    return this.executeInContentWorld(page, function () {
      const probe = globalThis.__annoyKillerCommitResponseDelay;
      return probe ? { ...probe.state } : null;
    });
  }

  async forwardFirstCommit(page) {
    return this.executeInContentWorld(page, function () {
      const probe = globalThis.__annoyKillerCommitResponseDelay;
      probe?.forward();
      return probe ? { ...probe.state } : null;
    });
  }

  async releaseFirstCommitResponse(page) {
    return this.executeInContentWorld(page, function () {
      const probe = globalThis.__annoyKillerCommitResponseDelay;
      probe?.release();
      return probe ? { ...probe.state } : null;
    });
  }

  async restoreCommitResponseDelay(page) {
    return this.executeInContentWorld(page, function () {
      const probe = globalThis.__annoyKillerCommitResponseDelay;
      probe?.restore();
      return true;
    }).catch(() => undefined);
  }

  async setSameClass(value) {
    await this.setStorage({ settings: { hideSameClass: value } });
  }

  async reset(page, { path = "/index.html", sameClass = false, label = "reset" } = {}) {
    await this.clearStorage();
    await this.setStorage({ shortcutGuideSeen: true, hiddenPreviewEnabled: false });
    await this.setSameClass(sameClass);
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
    });
    const url = this.fixtureUrl(path, label);
    await this.navigate(page, url);
    assert.equal(await evaluate(page, "Boolean(document.querySelector('[data-annoy-killer-ui]'))"),
      false, "重置后选择界面仍存在");
    return url;
  }

  async wakeServiceWorker() {
    await evaluate(this.optionsPage, `(async () => {
      try {
        await chrome.runtime.sendMessage({ type: "annoy-killer:e2e-wake" });
      } catch {}
      return true;
    })()`);
    await waitFor(async () => {
      const { targetInfos } = await this.browser.send("Target.getTargets", { filter: [{}] });
      return targetInfos.some((target) => target.type === "service_worker" &&
        target.url === `chrome-extension://${this.extensionId}/background.js`);
    }, "扩展 service worker 启动", 3_000);
    await sleep(60);
  }

  async currentTabTarget(page) {
    const url = await evaluate(page, "location.href");
    const { targetInfos } = await this.browser.send("Target.getTargets", { filter: [{}] });
    const matches = targetInfos.filter((target) => target.type === "tab" && target.url === url);
    assert.equal(matches.length, 1, `URL ${url} 应对应且仅对应一个 tab target，实际 ${matches.length}`);
    return matches[0];
  }

  async triggerAction(page) {
    await this.wakeServiceWorker();
    const tab = await this.currentTabTarget(page);
    await this.browser.send("Target.activateTarget", { targetId: tab.targetId });
    const startedAt = performance.now();
    await this.browser.send("Extensions.triggerAction", {
      id: this.extensionId,
      targetId: tab.targetId
    });
    return performance.now() - startedAt;
  }

  async beginPicker(page, { preview = false } = {}) {
    assert.equal(await evaluate(page, "Boolean(document.querySelector('[data-annoy-killer-ui]'))"),
      false, "开启前不应已有选择界面");
    const actionDuration = await this.triggerAction(page);
    await waitFor(async () => evaluate(page,
      "Boolean(document.querySelector('[data-annoy-killer-ui]'))"),
    "真实扩展 action 打开选择界面", ACTION_TIMEOUT);
    // Selection/animation scenarios explicitly use a known preview state.
    // Pass null to test the actual stored/default startup preference.
    if (preview !== null) {
      const button = await findPiercedNode(page, ({ node }) => hasClass(node, "hidden-toggle"), "显示隐藏按钮");
      const enabled = await callOnNode(page, button, "function () { return this.getAttribute('aria-pressed') === 'true'; }");
      if (enabled !== preview) {
        await clickClosedShadowButton(page, "切换已隐藏项目显示");
        await sleep(300);
      }
    }
    return actionDuration;
  }

  async closeWithAction(page) {
    assert.equal(await evaluate(page, "Boolean(document.querySelector('[data-annoy-killer-ui]'))"),
      true, "关闭前选择界面不存在");
    await this.triggerAction(page);
    await waitFor(async () => evaluate(page,
      "!document.querySelector('[data-annoy-killer-ui]')"),
    "真实扩展 action 关闭界面", UI_TIMEOUT);
  }

  async hover(page, elementExpression, modifier) {
    const rect = await rectFor(page, elementExpression);
    return this.hoverAt(page, centerOf(rect), modifier, rect);
  }

  async hoverAt(page, point, modifier, rect = null) {
    const config = modifier ? MODIFIERS[modifier] : null;
    if (modifier) {
      await keyChange(page, modifier, "keyDown");
    }
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      modifiers: config?.mask || 0
    });
    await waitFor(async () => (await highlightState(page)).display !== "none",
      `${modifier || "默认"}选区高亮`, UI_TIMEOUT);
    return { point, rect, modifier, mask: config?.mask || 0 };
  }

  async pressSelection(page, hovered, { releaseModifier = true } = {}) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: hovered.point.x,
      y: hovered.point.y,
      button: "left",
      clickCount: 1,
      modifiers: hovered.mask
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: hovered.point.x,
      y: hovered.point.y,
      button: "left",
      clickCount: 1,
      modifiers: hovered.mask
    });
    if (hovered.modifier && releaseModifier) {
      await keyChange(page, hovered.modifier, "keyUp");
    }
  }

  async select(page, elementExpression, modifier) {
    const hovered = await this.hover(page, elementExpression, modifier);
    await this.pressSelection(page, hovered);
    return hovered;
  }

  async waitStorageRule(scope, key) {
    const storageKey = scope === "site" ? "hiddenRulesBySite" : "hiddenRulesByPage";
    return waitFor(async () => {
      const storage = await this.getStorage([storageKey]);
      const rules = storage[storageKey]?.[key];
      return Array.isArray(rules) && rules.length ? rules : null;
    }, `${scope} 规则 ${key} 持久化`, STORAGE_TIMEOUT);
  }

  async close() {
    for (const page of this.pages) {
      page.close();
    }
    this.pages.clear();
    this.optionsPage?.close();
    this.browser?.close();
  }
}

function pageKey(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    return `file://${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  const queryNames = new Set([
    "q", "query", "search", "keyword", "keywords", "term", "text", "wd", "word", "search_query"
  ]);
  const positionNames = new Set(["page", "p", "start", "offset", "pn"]);
  const names = [...parsed.searchParams.keys()].map((name) => name.toLowerCase());
  if (!names.some((name) => queryNames.has(name))) {
    return `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  const canonical = new URL(`${parsed.origin}${parsed.pathname}`);
  for (const [name, value] of parsed.searchParams) {
    const normalized = name.toLowerCase();
    if (queryNames.has(normalized) || positionNames.has(normalized)) {
      canonical.searchParams.append(name, value);
    }
  }
  canonical.hash = parsed.hash;
  return `${canonical.origin}${canonical.pathname}${canonical.search}${canonical.hash}`;
}

function rectsNearlyEqual(first, second, tolerance = 3) {
  return Math.abs(first.left - second.left) <= tolerance &&
    Math.abs(first.top - second.top) <= tolerance &&
    Math.abs(first.right - second.right) <= tolerance &&
    Math.abs(first.bottom - second.bottom) <= tolerance;
}

async function waitHighlightRect(page, expectedRect, label, fine = true) {
  let lastState = null;
  try {
    return await waitFor(async () => {
      lastState = await highlightState(page);
      return lastState.display !== "none" && rectsNearlyEqual(lastState, expectedRect) &&
        (!fine || lastState.className.includes("fine")) ? lastState : null;
    }, `${label}高亮严格匹配`, UI_TIMEOUT, 20);
  } catch (error) {
    throw new Error(`${error.message}；期望=${JSON.stringify(expectedRect)}；` +
      `实际=${JSON.stringify(lastState)}`);
  }
}

async function inlineDisplayState(page, elementExpression) {
  return evaluate(page, `(() => {
    const element = (${elementExpression});
    if (!element) return null;
    return {
      value: element.style.getPropertyValue("display"),
      priority: element.style.getPropertyPriority("display"),
      computed: getComputedStyle(element).display,
      session: element.getAttribute("data-annoy-killer-session-hidden"),
      persistent: element.hasAttribute("data-annoy-killer-persistent-hidden"),
      cssText: element.style.cssText
    };
  })()`);
}

async function hiddenMarkerCounts(page) {
  return evaluate(page, `({
    session: document.querySelectorAll("[data-annoy-killer-session-hidden]").length,
    persistent: document.querySelectorAll("[data-annoy-killer-persistent-hidden]").length
  })`);
}

async function fallbackCardStates(page) {
  return evaluate(page, `(() => [...document.querySelectorAll("#fallback-zone > fixture-card")]
    .map((node, index) => ({
      index,
      display: getComputedStyle(node).display,
      inlineDisplay: node.style.getPropertyValue("display"),
      inlinePriority: node.style.getPropertyPriority("display"),
      session: node.getAttribute("data-annoy-killer-session-hidden"),
      persistent: node.hasAttribute("data-annoy-killer-persistent-hidden")
    })))()`);
}

function assertOnlyFallbackTargetHidden(states, phase, marker) {
  assert.equal(states.length, 3, `${phase} fallback 卡片数量错误`);
  for (const state of states) {
    if (state.index === 1) {
      assert.equal(state.display, "none", `${phase} 第 2 个 fallback 未隐藏`);
      assert.equal(state.inlineDisplay, "none", `${phase} 第 2 个 fallback 缺少 inline none`);
      assert.equal(state.inlinePriority, "important", `${phase} 第 2 个 fallback 缺少 important`);
      assert(marker === "session" ? Boolean(state.session) : state.persistent,
        `${phase} 第 2 个 fallback 缺少 ${marker} 标记`);
      assert.equal(marker === "session" ? state.persistent : state.session,
        marker === "session" ? false : null,
        `${phase} 第 2 个 fallback 存在错误阶段标记`);
    } else {
      assert.notEqual(state.display, "none", `${phase} decoy ${state.index + 1} 被误隐藏`);
      assert.equal(state.inlineDisplay, "", `${phase} decoy ${state.index + 1} 被写 inline display`);
      assert.equal(state.session, null, `${phase} decoy ${state.index + 1} 残留 session`);
      assert.equal(state.persistent, false, `${phase} decoy ${state.index + 1} 残留 persistent`);
    }
  }
}

async function pickerLayerState(page, hitPoint = null) {
  const entries = await piercedEntries(page);
  const uiHostNode = entries.find(({ node }) =>
    Object.prototype.hasOwnProperty.call(attributesOf(node), "data-annoy-killer-ui"))?.node;
  const findUiNode = (className) => entries.find(({ node, ancestors }) =>
    hasClass(node, className) && ancestors.some((ancestor) =>
      Object.prototype.hasOwnProperty.call(attributesOf(ancestor), "data-annoy-killer-ui")))?.node;
  const captureNode = findUiNode("capture");
  const toolbarNode = findUiNode("toolbar");
  assert(uiHostNode && captureNode && toolbarNode,
    "闭合 Shadow DOM 中缺少 picker host/capture/toolbar");
  const describe = (point) => `function () {
    const rect = this.getBoundingClientRect();
    const style = getComputedStyle(this);
    const root = this.getRootNode();
    const hit = ${point ? `root.elementFromPoint(${point.x}, ${point.y})` : "null"};
    return {
      display: style.display,
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
      cursor: style.cursor,
      backgroundColor: style.backgroundColor,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height },
      hitSelf: hit === this || this.contains(hit)
    };
  }`;
  const [capture, toolbar, host] = await Promise.all([
    callOnNode(page, captureNode, describe(hitPoint)),
    callOnNode(page, toolbarNode, describe(null)),
    evaluate(page, `(() => {
      const host = document.querySelector("[data-annoy-killer-ui]");
      const modal = host?.closest?.("dialog") ||
        (host?.localName === "dialog" ? host : null);
      const pointHit = ${hitPoint
        ? `document.elementFromPoint(${hitPoint.x}, ${hitPoint.y})`
        : "null"};
      return {
        exists: Boolean(host),
        popoverOpen: Boolean(host?.matches?.(":popover-open")),
        modalOpen: Boolean(modal?.matches?.(":modal")),
        pointHitsHost: Boolean(host && pointHit === host),
        pointHitTag: pointHit?.localName || null,
        pointHitId: pointHit?.id || null
      };
    })()`)
  ]);
  return {
    capture,
    toolbar,
    host,
    backendNodeIds: {
      uiHost: uiHostNode.backendNodeId,
      capture: captureNode.backendNodeId
    }
  };
}

async function installCaptureEventProbe(page, backendNodeId) {
  return callOnNode(page, { backendNodeId, nodeName: "DIV" }, `function () {
    const probe = { events: [] };
    this.__annoyKillerE2ECaptureProbe = probe;
    for (const type of ["pointerdown", "pointerup", "click"]) {
      this.addEventListener(type, (event) => {
        const toolbar = this.getRootNode().querySelector(".toolbar");
        probe.events.push({
          type,
          isTrusted: event.isTrusted,
          targetSelf: event.target === this,
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
          toolbarVisibility: toolbar ? getComputedStyle(toolbar).visibility : null
        });
      }, { capture: true });
    }
    return true;
  }`);
}

async function readCaptureEventProbe(page, backendNodeId) {
  return callOnNode(page, { backendNodeId, nodeName: "DIV" }, `function () {
    return this.__annoyKillerE2ECaptureProbe || null;
  }`);
}

async function resetCaptureEventProbe(page, backendNodeId) {
  return callOnNode(page, { backendNodeId, nodeName: "DIV" }, `function () {
    const probe = this.__annoyKillerE2ECaptureProbe;
    if (!probe) return null;
    probe.events.length = 0;
    const toolbar = this.getRootNode().querySelector(".toolbar");
    return { toolbarVisibility: toolbar ? getComputedStyle(toolbar).visibility : null };
  }`);
}

async function captureLayerSnapshot(page, backendNodeId, point) {
  return callOnNode(page, { backendNodeId, nodeName: "DIV" }, `function (x, y) {
    const rect = this.getBoundingClientRect();
    const style = getComputedStyle(this);
    const root = this.getRootNode();
    const hit = root.elementFromPoint(x, y);
    const toolbar = root.querySelector(".toolbar");
    const toolbarStyle = toolbar ? getComputedStyle(toolbar) : null;
    return {
      capture: {
        display: style.display,
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
        backgroundColor: style.backgroundColor,
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        },
        hitSelf: hit === this || this.contains(hit)
      },
      toolbar: {
        display: toolbarStyle?.display || null,
        visibility: toolbarStyle?.visibility || null
      }
    };
  }`, [point.x, point.y]);
}

async function eventState(page) {
  return evaluate(page, "window.__fixture.getEvents()");
}

function totalEventCount(events) {
  const counts = events.counts || events;
  return Object.values(counts).reduce((total, value) => total + Number(value || 0), 0);
}

async function runSuite(e2e, mainPage, artifactPath) {
  const results = [];
  let activePage = mainPage;

  async function run(name, body) {
    if (CASE_FILTER && !name.includes(CASE_FILTER)) {
      return;
    }
    const startedAt = performance.now();
    try {
      await body();
      const duration = Math.round(performance.now() - startedAt);
      results.push({ name, ok: true, duration });
      console.log(`PASS ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Math.round(performance.now() - startedAt);
      results.push({ name, ok: false, duration, error });
      const storage = await e2e.getStorage().catch((storageError) => ({
        storageReadError: storageError.message
      }));
      await captureFailure(activePage, artifactPath, name, storage).catch(() => undefined);
      console.error(`FAIL ${name} (${duration}ms)\n${error.stack || error}`);
      for (const page of new Set([activePage, mainPage])) {
        for (const modifier of Object.values(MODIFIERS)) {
          await page.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: modifier.key,
            code: modifier.code,
            modifiers: 0
          }).catch(() => undefined);
        }
        await page.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape"
        }).catch(() => undefined);
        await page.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape"
        }).catch(() => undefined);
        await evaluate(page, "window.__fixture?.closeTopLayers?.(); true")
          .catch(() => undefined);
      }
      activePage = mainPage;
    }
  }

  await run("屏蔽规则同步默认开启、开关持久化与远端恢复", async () => {
    const panel = await e2e.openPage(`chrome-extension://${e2e.extensionId}/options.html`, "同步选项");
    const ready = () => evaluate(panel, "!document.querySelector('#rule-sync').disabled");
    const toggle = async () => {
      await evaluate(panel, "document.querySelector('#rule-sync').focus()");
      await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await waitFor(ready, "同步开关操作完成");
    };
    try {
      await e2e.clearStorage();
      await e2e.removeStorage(['ruleSyncEnabled']);
      await waitFor(async () => await ready() && await evaluate(panel, "document.querySelector('#rule-sync').checked"), "同步默认开启");
      await waitFor(async () => await evaluate(panel,
        "!document.querySelector('#sync-empty').hidden && document.querySelector('#sync-storage').textContent.includes('/')"),
      "空同步列表与空间总量完成渲染");
      assert.equal(await evaluate(panel,
        "(() => { const empty = getComputedStyle(document.querySelector('#sync-empty')); const note = getComputedStyle(document.querySelector('.sync-note')); return empty.fontSize === '12px' && empty.textAlign === 'center' && empty.color === note.color; })()"),
      true, "暂无已同步网站应使用较小字号、横向居中并与同步说明同色");
      assert.equal(await evaluate(panel,
        "document.querySelector('.sync-setting > [data-i18n=\"syncNote\"]')?.textContent === chrome.i18n.getMessage('syncNote') && document.querySelector('#sync-storage')?.parentElement?.classList.contains('sync-setting')"),
      true, "Google 同步说明与空间用量应和同步标题在同一行");
      assert.equal(await evaluate(panel,
        "(() => { const sync = getComputedStyle(document.querySelector('.sync-setting')); const instructions = getComputedStyle(document.querySelector('.instructions')); return new Set([sync.marginTop, sync.paddingTop, instructions.marginTop, instructions.paddingTop]).size === 1; })()"),
      true, "两条分隔线的上下间距应保持一致");
      assert.equal(await evaluate(panel,
        "!document.querySelector('[data-i18n=\"syncedSites\"]') && !document.querySelector('[data-i18n=\"syncStatus\"]') && !document.querySelector('[data-i18n=\"syncStorage\"]')"),
      true, "不再显示已同步网站、同步状态或同步空间标题");
      assert.equal(await evaluate(panel,
        "(() => { const clean = value => value.replace(/\\s+/g, ' ').trim(); return document.querySelectorAll('.instructions li').length === 6 && clean(document.querySelector('.instructions li:nth-child(3)').textContent) === clean(chrome.i18n.getMessage('exitUndo', ['ESC', 'Enter'])); })()"),
      true, "使用说明第三点说明自动保存且第七点已删除");
      await captureScreenshot(panel, artifactPath, 'rule-sync-options');
      await panel.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: false });
      assert(await evaluate(panel, 'document.documentElement.scrollWidth <= innerWidth'), '同步开关窄屏不得溢出');
      await captureScreenshot(panel, artifactPath, 'rule-sync-options-narrow');
      await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await captureScreenshot(panel, artifactPath, 'rule-sync-options-dark');
      await panel.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await toggle();
      assert.equal((await e2e.getStorage(['ruleSyncEnabled'])).ruleSyncEnabled, false);
      await e2e.navigate(panel, `chrome-extension://${e2e.extensionId}/options.html`);
      await waitFor(ready, '重新打开设置');
      assert.equal(await evaluate(panel, "document.querySelector('#rule-sync').checked"), false);
      await toggle();
      const url = e2e.fixtureUrl('/index.html', 'sync-rule');
      await e2e.setStorage({ shortcutGuideSeen: true });
      await e2e.navigate(mainPage, url);
      const result = await evaluate(panel, `chrome.runtime.sendMessage({ type: 'annoy-killer:commit-rules',
        pageKey: ${JSON.stringify(pageKey(url))}, siteKey: ${JSON.stringify(e2e.primaryOrigin)},
        pageRules: [{ selector: '#unique-target' }] })`);
      assert.equal(result.ok, true);
      await waitVisible(mainPage, "document.querySelector('#unique-target')", false, '本地保存仍立即隐藏');
      assert(await evaluate(panel, "chrome.alarms.get('annoy-killer:sync-rules')"), '保存应安排后台同步');
      // Enabling again flushes the pending batch without waiting for the 30-second alarm.
      await evaluate(panel, "chrome.runtime.sendMessage({ type: 'annoy-killer:set-rule-sync', enabled: true })");
      const cloud = await evaluate(panel, 'chrome.storage.sync.get(null)');
      const entry = Object.entries(cloud).find(([, record]) => record.r?.[2]?.selector === '#unique-target');
      assert(entry, '真实 Chrome sync 存储应收到屏蔽规则');
      for (let index = 1; index <= 4; index += 1) {
        const site = `https://sync-${index}.example`;
        const added = await evaluate(panel, `chrome.runtime.sendMessage({ type: 'annoy-killer:commit-rules',
          pageKey: ${JSON.stringify(`${site}/page`)}, siteKey: ${JSON.stringify(site)},
          pageRules: [{ selector: ${JSON.stringify(`#sync-${index}`)} }] })`);
        assert.equal(added.ok, true);
        if (index === 2) {
          await waitFor(async () => await evaluate(panel,
            "document.querySelectorAll('#sync-sites > li').length === 3"),
          "三条同步网站完成渲染");
          assert.equal(await evaluate(panel,
            "(() => { const button = document.querySelector('#sync-sites-toggle'); return button.hidden && getComputedStyle(button).display === 'none'; })()"),
          true, "同步网站不超过三条时不显示查看全部");
        }
      }
      await waitFor(async () => await evaluate(panel,
        "(() => { const button = document.querySelector('#sync-sites-toggle'); return document.querySelectorAll('#sync-sites > li').length === 3 && Boolean(document.querySelector('.sync-now')) && !button.hidden && getComputedStyle(button).display !== 'none'; })()"),
      "默认显示三个网站并提供手动同步");
      await evaluate(panel, "document.querySelector('.sync-now').click()");
      await waitFor(async () => await evaluate(panel,
        "document.querySelectorAll('#sync-sites > li').length === 3 && !document.querySelector('.sync-now') && !document.querySelector('#sync-storage').textContent.includes('--')"),
      "手动同步完成并显示真实空间用量");
      assert.equal(await evaluate(panel,
        "(() => { const noteColor = getComputedStyle(document.querySelector('.sync-note')).color; return [...document.querySelectorAll('.sync-site-status')].every(status => { const style = getComputedStyle(status); return style.fontSize === '12px' && style.color === noteColor; }); })()"),
      true, "同步状态文字应缩小为 12px 并与同步说明同色");
      assert(await evaluate(panel,
        "(() => { const button = document.querySelector('#sync-sites-toggle').getBoundingClientRect(); const section = document.querySelector('.sync-details').getBoundingClientRect(); return Math.abs((button.left + button.right) / 2 - (section.left + section.right) / 2) <= 1; })()"),
      "查看全部应在同步详情区域内横向居中");
      await captureScreenshot(panel, artifactPath, 'rule-sync-sites');
      await evaluate(panel, "document.querySelector('#sync-sites-toggle').click()");
      await waitFor(async () => await evaluate(panel,
        "document.querySelectorAll('#sync-sites > li').length === 5 && document.querySelector('#sync-sites-toggle').getAttribute('aria-expanded') === 'true'"),
      "查看全部展开完整网站列表");
      assert.equal(await evaluate(panel,
        "[...document.querySelectorAll('.sync-site-status')].every(status => status.dataset.state === 'synced')"), true,
      "展开后每个网站都应显示已同步");
      await captureScreenshot(panel, artifactPath, 'rule-sync-sites-expanded');
      const clearedSite = 'https://sync-4.example';
      const clearedPage = `${clearedSite}/page`;
      const cleared = await evaluate(panel, `chrome.runtime.sendMessage({ type: 'annoy-killer:commit-rules',
        pageKey: ${JSON.stringify(clearedPage)}, siteKey: ${JSON.stringify(clearedSite)},
        removePageRules: [{ selector: '#sync-4' }],
        siteRules: [{ selector: '#legacy-site-rule' }],
        visiblePageRules: [{ selector: '#sync-4' }] })`);
      assert.equal(cleared.ok, true);
      await waitFor(async () => await evaluate(panel,
        "document.querySelectorAll('#sync-sites > li').length === 4 && ![...document.querySelectorAll('.sync-site-name')].some(name => name.textContent === 'sync-4.example')"),
      "没有屏蔽内容的网站不再显示在同步列表");
      const clearedStorage = await e2e.getStorage(['hiddenRulesBySite', 'visibleExceptionsByPage']);
      assert(clearedStorage.hiddenRulesBySite?.[clearedSite]?.length &&
        clearedStorage.visibleExceptionsByPage?.[clearedPage]?.length,
      "旧网站级规则与页面恢复例外仍可保留同步，但不能让空网站继续显示");
      await evaluate(panel, "document.querySelector('#sync-sites-toggle').click()");
      await waitFor(async () => await evaluate(panel,
        "document.querySelectorAll('#sync-sites > li').length === 3 && document.querySelector('#sync-sites-toggle').getAttribute('aria-expanded') === 'false'"),
      "收起后恢复三个网站");
      await panel.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: false });
      assert(await evaluate(panel, 'document.documentElement.scrollWidth <= innerWidth'), '同步网站列表窄屏不得溢出');
      await captureScreenshot(panel, artifactPath, 'rule-sync-sites-narrow');
      await panel.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      const [id, record] = entry;
      const deletion = { v: [Math.max(Date.now(), record.v[0]) + 100, 'other-device'] };
      await evaluate(panel, `chrome.storage.sync.set(${JSON.stringify({ [id]: deletion })})`);
      await waitVisible(mainPage, "document.querySelector('#unique-target')", true, '收到其他设备删除后恢复元素');
      await toggle();
      const restore = { ...record, v: [deletion.v[0] + 1, 'other-device'] };
      await evaluate(panel, `chrome.storage.sync.set(${JSON.stringify({ [id]: restore })})`);
      await sleep(200);
      assert.equal((await e2e.getStorage(['hiddenRulesByPage'])).hiddenRulesByPage?.[pageKey(url)]?.length || 0, 0,
        '关闭同步时不得应用远端规则');
      await toggle();
      await waitVisible(mainPage, "document.querySelector('#unique-target')", false, '重新开启后应用远端规则');
      assert.equal(await evaluate(panel, "document.querySelector('#rule-sync').getAttribute('aria-invalid')"), 'false');
      await toggle();
      assert((await e2e.getStorage(['hiddenRulesByPage'])).hiddenRulesByPage?.[pageKey(url)]?.length,
        '关闭同步必须保留本地规则');
      assert.equal(await evaluate(panel,
        "[...document.querySelectorAll('.sync-site-status')].every(status => status.dataset.state === 'paused') && !document.querySelector('.sync-now')"), true,
      "关闭总开关后应显示暂停且不擅自提供重启同步按钮");
    } finally {
      await e2e.closePage(panel);
      await e2e.clearStorage();
    }
  });

  await run("屏蔽规则同步网站在全部恢复或规则失效后消失", async () => {
    const url = await e2e.reset(mainPage, { sameClass: true, label: "sync-restored-site" });
    const pageScope = pageKey(url);
    await evaluate(mainPage, `(() => {
      for (const card of document.querySelectorAll('.bulk-card')) {
        card.innerHTML = '<a href="/promotion"><img alt="Campaign artwork" ' +
          'src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></a>' +
          '<span>广告</span>';
      }
    })()`);
    const first = "document.querySelector('#bulk-card-one')";
    const second = "document.querySelector('#bulk-card-two')";
    const panel = await e2e.openPage(`chrome-extension://${e2e.extensionId}/options.html`, "同步恢复选项");
    try {
      const saved = await evaluate(panel, `chrome.runtime.sendMessage({ type: 'annoy-killer:commit-rules',
        pageKey: ${JSON.stringify(pageScope)}, siteKey: ${JSON.stringify(e2e.primaryOrigin)},
        pageRules: [{ selector: '#bulk-card-one' }, { selector: '#bulk-card-two' }] })`);
      assert.equal(saved.ok, true);
      await evaluate(panel,
        "chrome.runtime.sendMessage({ type: 'annoy-killer:set-rule-sync', enabled: true })");
      await Promise.all([
        waitVisible(mainPage, first, false, "同步规则隐藏第一个项目"),
        waitVisible(mainPage, second, false, "同步规则隐藏第二个项目")
      ]);
      await waitFor(async () => await evaluate(panel,
        "document.querySelectorAll('#sync-sites > li').length === 1"),
      "有屏蔽内容的网站显示在同步列表");

      await e2e.beginPicker(mainPage);
      await clickClosedShadowButton(mainPage, "重置");
      await waitFor(async () => (await toolbarCount(mainPage)) === "0个项目已隐藏",
        "恢复全部同步项目");
      await Promise.all([
        waitVisible(mainPage, first, true, "恢复第一个同步项目"),
        waitVisible(mainPage, second, true, "恢复第二个同步项目")
      ]);
      await clickClosedShadowButton(mainPage, "完成");
      await waitFor(async () => evaluate(mainPage,
        "!document.querySelector('[data-annoy-killer-ui]')"), "保存全部恢复结果");
      await waitFor(async () => {
        const stored = await e2e.getStorage(["hiddenRulesByPage"]);
        return !(stored.hiddenRulesByPage?.[pageScope]?.length);
      }, "最后一个项目恢复后删除页面屏蔽规则");
      await waitFor(async () => await evaluate(panel,
        "document.querySelectorAll('#sync-sites > li').length === 0 && !document.querySelector('#sync-empty').hidden"),
      "全部恢复后网站从同步列表消失");

      const stale = await evaluate(panel, `chrome.runtime.sendMessage({ type: 'annoy-killer:commit-rules',
        pageKey: ${JSON.stringify(pageScope)}, siteKey: ${JSON.stringify(e2e.primaryOrigin)},
        pageRules: [{ selector: '#element-that-no-longer-exists' }] })`);
      assert.equal(stale.ok, true);
      await waitFor(async () => await evaluate(panel,
        "document.querySelectorAll('#sync-sites > li').length === 0 && !document.querySelector('#sync-empty').hidden"),
      "已打开网页没有实际屏蔽内容时立即隐藏同步网站");
      await e2e.beginPicker(mainPage);
      assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
      assert.deepEqual(await restoreAllButtonState(mainPage), { visible: true, disabled: false },
        "规则目标已消失时仍应允许重置旧规则");
      await clickClosedShadowButton(mainPage, "重置");
      await waitFor(async () => (await restoreAllButtonState(mainPage)).disabled === false,
        "旧规则重置完成");
      await clickClosedShadowButton(mainPage, "完成");
      await waitFor(async () => {
        const stored = await e2e.getStorage(["hiddenRulesByPage"]);
        return !(stored.hiddenRulesByPage?.[pageScope]?.length);
      }, "重置清除已失效的页面规则");
      await waitFor(async () => await evaluate(panel,
        "document.querySelectorAll('#sync-sites > li').length === 0 && !document.querySelector('#sync-empty').hidden"),
      "失效规则重置后网站从同步列表消失");
    } finally {
      await e2e.closePage(panel);
      await e2e.clearStorage();
    }
  });

  await run("每打开五次显示咖啡气泡且点击后继续按周期展示", async () => {
    const url = await e2e.reset(mainPage, { label: "coffee-prompt" });
    const getCoffee = async () => (await piercedEntries(mainPage)).find(entry =>
      hasExtensionAncestor(entry) && hasClass(entry.node, "coffee-prompt"));
    for (let count = 1; count <= 5; count++) {
      await e2e.beginPicker(mainPage);
      await waitFor(async () => (await e2e.getStorage(["pickerOpenCount"])).pickerOpenCount === count,
        `记录第 ${count} 次打开`);
      await mainPage.send("Page.bringToFront");
      if (count < 5) {
        assert.equal(Boolean(await getCoffee()), false, "前四次不展示打赏入口");
        await e2e.closeWithAction(mainPage);
        assert.equal((await e2e.getStorage(["pickerOpenCount"])).pickerOpenCount, count,
          "关闭工具条不计数");
        await e2e.navigate(mainPage, url);
      }
    }
    const coffee = await waitFor(getCoffee, "第五次显示咖啡气泡");
    const geometry = await callOnNode(mainPage, coffee.node, `function () {
      const rect = this.getBoundingClientRect();
      const bar = this.parentElement.getBoundingClientRect();
      return { gap: rect.top - bar.bottom, center: rect.x + rect.width / 2,
        barCenter: bar.x + bar.width / 2, arrow: getComputedStyle(this, '::before').content };
    }`);
    assert(geometry.gap >= 10 && geometry.gap <= 13);
    assert(Math.abs(geometry.center - geometry.barCenter) < 1);
    assert.equal(geometry.arrow, '\"\"', "气泡包含指向工具条的尖角");
    await captureScreenshot(mainPage, artifactPath, "coffee-bubble");
    await mainPage.send("Emulation.setDeviceMetricsOverride", {
      width: 360, height: 740, deviceScaleFactor: 1, mobile: false
    });
    try {
      const narrow = await nodeBox(mainPage, coffee.node);
      assert(narrow.left >= 0 && narrow.right <= 360, "窄屏气泡完整显示");
      await captureScreenshot(mainPage, artifactPath, "coffee-bubble-narrow");
    } finally {
      await mainPage.send("Emulation.clearDeviceMetricsOverride");
    }
    const beforeDrag = await nodeBox(mainPage, coffee.node);
    const start = centerOf(beforeDrag);
    await mainPage.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
    await mainPage.send("Input.dispatchMouseEvent", { type: "mousePressed", ...start,
      button: "left", clickCount: 1 });
    await mainPage.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + 30,
      y: start.y + 40, button: "left", buttons: 1 });
    await mainPage.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: start.x + 30,
      y: start.y + 40, button: "left", clickCount: 1 });
    const afterDrag = await nodeBox(mainPage, coffee.node);
    assert.equal(afterDrag.left - beforeDrag.left, 30, "气泡随工具条拖动");
    assert.equal(afterDrag.top - beforeDrag.top, 40);
    const coffeeUrl = `chrome-extension://${e2e.extensionId}/options.html#coffee`;
    const beforeClick = await e2e.browser.send("Target.getTargets", { filter: [{}] });
    assert(!beforeClick.targetInfos.some(item => item.url === coffeeUrl), "拖动气泡不应误触跳转");
    await clickClosedShadowButton(mainPage, "请我喝杯咖啡吧～");
    const target = await waitFor(async () => {
      const { targetInfos } = await e2e.browser.send("Target.getTargets", { filter: [{}] });
      return targetInfos.find(item => item.type === "page" && item.url === coffeeUrl);
    }, "点击打开选项页打赏区域");
    const panel = await e2e.connectPage(target.targetId, "打赏选项页");
    try {
      await e2e.waitDocument(panel, coffeeUrl);
      assert(await evaluate(panel, "Boolean(document.querySelector('#coffee .coffee-codes'))"));
      await waitFor(async () => !await getCoffee(), "点击后关闭本次气泡");
      await e2e.closeWithAction(mainPage);
      // Old installations may retain this flag; it must no longer suppress future cycles.
      await e2e.setStorage({ coffeePromptVisited: true });
      for (let count = 6; count <= 16; count++) {
        await e2e.navigate(mainPage, url);
        await e2e.beginPicker(mainPage);
        await waitFor(async () => (await e2e.getStorage(["pickerOpenCount"])).pickerOpenCount === count,
          `记录第 ${count} 次打开`);
        await mainPage.send("Page.bringToFront");
        if (count % 5 === 0) {
          await waitFor(getCoffee, `第 ${count} 次再次显示咖啡气泡`);
        } else {
          await sleep(100);
          assert.equal(Boolean(await getCoffee()), false, `第 ${count} 次不展示咖啡气泡`);
        }
        await e2e.closeWithAction(mainPage);
        assert.equal((await e2e.getStorage(["pickerOpenCount"])).pickerOpenCount, count,
          "关闭工具条不计数");
      }
    } finally {
      await e2e.closePage(panel);
    }
  });

  await run("首次快捷键引导只显示一次", async () => {
    const url = await e2e.reset(mainPage, { label: "shortcut-guide" });
    await e2e.removeStorage(["shortcutGuideSeen"]);
    const getGuide = async () => (await piercedEntries(mainPage)).find(entry =>
      hasExtensionAncestor(entry) && hasClass(entry.node, "shortcut-guide"));
    await e2e.beginPicker(mainPage);
    let guide = await waitFor(getGuide, "首次打开显示快捷键引导");
    const text = await callOnNode(mainPage, guide.node, "function() { return this.textContent; }");
    const isMac = await evaluate(mainPage, "/mac/i.test(navigator.userAgentData?.platform || navigator.platform)");
    assert(text.includes("可临时切换为网页鼠标点击状态") &&
      text.includes("可缩小选择范围") && text.includes("可进一步缩小范围") &&
      text.includes("Shift"));
    assert(isMac ? text.includes("Option") && !text.includes("Alt") : text.includes("Alt") && !text.includes("Option"));
    assert(isMac ? text.includes("Command") && !text.includes("Ctrl") : text.includes("Ctrl") && !text.includes("Command"));
    assert(text.includes("按 ESC 或 Enter 键可以退出操作模式。"));
    assert(text.includes(`双击 ${isMac ? "Command" : "Control"} 可打开或关闭插件。`));
    assert(text.includes("右键点击插件图标 → 选项，可修改双击按键。"));
    const steps = await callOnNode(mainPage, guide.node, `function() {
      const list = this.querySelector('ol.guide-steps');
      const items = [...list.children];
      return { count: items.length, numbering: getComputedStyle(list).listStyleType,
        gaps: items.slice(1).map((item, index) => item.getBoundingClientRect().top -
          items[index].getBoundingClientRect().bottom) };
    }`);
    assert.equal(steps.count, 3, "首次引导第 3、4 条合并后共三条");
    assert(await callOnNode(mainPage, guide.node, `function() {
      const last = this.querySelector('.guide-steps li:last-child').textContent;
      return last.includes('可打开或关闭插件。') &&
        last.includes('右键点击插件图标 → 选项，可修改双击按键。');
    }`), "双击开关与选项入口必须在同一条提示中");
    assert.equal(steps.numbering, "decimal");
    assert(steps.gaps.every(gap => gap >= 10), "每条提示之间至少留 10px 间距");
    const closePlacement = await callOnNode(mainPage, guide.node, `function() {
      const guide = this.getBoundingClientRect();
      const close = this.querySelector('.guide-close').getBoundingClientRect();
      return { top: close.top - guide.top, right: guide.right - close.right,
        width: close.width, height: close.height };
    }`);
    assert(Math.abs(closePlacement.top - 10) <= 1 && Math.abs(closePlacement.right - 10) <= 1,
      `关闭按钮应固定在右上角：${JSON.stringify(closePlacement)}`);
    assert.equal(closePlacement.width, 28);
    assert.equal(closePlacement.height, 28);
    await captureScreenshot(mainPage, artifactPath, "shortcut-guide-first-use");
    await mainPage.send("Emulation.setDeviceMetricsOverride", {
      width: 360, height: 740, deviceScaleFactor: 1, mobile: false
    });
    guide = await getGuide();
    const bounds = await callOnNode(mainPage, guide.node, `function() {
      const rect = this.getBoundingClientRect();
      const toolbar = this.getRootNode().querySelector('.toolbar').getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        toolbarBottom: toolbar.bottom, width: innerWidth, height: innerHeight };
    }`);
    assert(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height &&
      bounds.top >= bounds.toolbarBottom, `窄屏引导不可溢出或遮挡工具栏：${JSON.stringify(bounds)}`);
    await captureScreenshot(mainPage, artifactPath, "shortcut-guide-narrow");
    await clickClosedShadowButton(mainPage, "关闭引导");
    assert(!(await getGuide()), "关闭按钮移除引导");
    assert.equal((await e2e.getStorage(["shortcutGuideSeen"])).shortcutGuideSeen, true);
    await closePickerWithEscape(mainPage);
    await e2e.beginPicker(mainPage);
    assert(!(await getGuide()), "重新打开不重复引导");
    await closePickerWithEscape(mainPage);
    await e2e.navigate(mainPage, url + "&reopen=1");
    await e2e.beginPicker(mainPage);
    assert(!(await getGuide()), "换页面不重复引导");
    await closePickerWithEscape(mainPage);
    // Drain prior first-use claims before resetting storage for another simulated user.
    await evaluate(e2e.optionsPage,
      "chrome.runtime.sendMessage({ type: 'annoy-killer:claim-shortcut-guide' })");
    await e2e.removeStorage(["shortcutGuideSeen"]);
    await e2e.setStorage({ toggleShortcutKey: "q" });
    await e2e.beginPicker(mainPage);
    guide = await waitFor(getGuide, "模拟新用户再次显示引导");
    assert((await callOnNode(mainPage, guide.node, "function() { return this.textContent; }"))
      .includes("双击 Q 可打开或关闭插件。"), "引导显示当前设置的双击按键");
    const platformSelectionKey = isMac ? "Meta" : "Control";
    await keyChange(mainPage, platformSelectionKey, "keyDown");
    assert(!(await getGuide()), "实际使用快捷键后自动收起引导");
    await keyChange(mainPage, platformSelectionKey, "keyUp");
    await closePickerWithEscape(mainPage);
    await mainPage.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    });
  });

  await run("三档选择范围与平台主修饰键临时网页点击", async () => {
    await e2e.reset(mainPage, { label: "selection-levels" });
    await evaluate(mainPage, `(() => {
      const broad = document.createElement('section');
      broad.id = 'range-broadest';
      broad.style.cssText = 'position:fixed;left:100px;top:180px;width:480px;height:300px;padding:20px;background:#171717;box-sizing:border-box;z-index:1000';
      broad.innerHTML = '<div id="range-default" style="width:320px;height:200px;padding:20px;background:#292929;box-sizing:border-box">' +
        '<div id="range-smaller" style="width:150px;height:90px;padding:10px;background:#454545;display:flow-root;box-sizing:border-box">' +
        '<div id="range-smallest" style="display:flow-root;width:120px;height:64px;padding:3px;box-sizing:border-box"><span>插件入口</span></div>' +
        '</div></div>';
      document.body.append(broad);
      window.__normalClickCount = 0;
      document.getElementById('range-smallest').addEventListener('click', () => window.__normalClickCount++);
    })()`);
    await e2e.beginPicker(mainPage);
    const target = "document.querySelector('#range-smallest span')";
    const levels = [
      [null, "range-broadest", "无按键选择比原默认更广的完整区块"],
      ["Shift", "range-default", "Shift 选择标准范围"],
      ["Alt", "range-smaller", "Alt 选择最小范围"]
    ];
    for (const [modifier, id, label] of levels) {
      await e2e.hover(mainPage, target, modifier);
      await waitHighlightRect(mainPage, await rectFor(mainPage, `document.getElementById('${id}')`),
        label, Boolean(modifier));
      if (modifier) await keyChange(mainPage, modifier, "keyUp");
    }
    const areas = [];
    for (const id of ["range-broadest", "range-default", "range-smaller"]) {
      const rect = await rectFor(mainPage, `document.getElementById('${id}')`);
      areas.push(rect.width * rect.height);
    }
    assert(areas.every((area, index) => index === 0 || areas[index - 1] > area),
      `三档范围应依次缩小：${areas.join(' > ')}`);
    assert(areas[0] >= areas[1] * 1.35 && areas[1] >= areas[2] * 1.35,
      `三档范围应有明显区分：${areas.join(' > ')}`);
    const primary = process.platform === "darwin" ? "Meta" : "Control";
    await e2e.hover(mainPage, target);
    await mainPage.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...centerOf(await rectFor(mainPage, target)),
      modifiers: MODIFIERS[primary].mask
    });
    assert(await evaluate(mainPage,
      "document.documentElement.classList.contains('annoy-killer-click-through')"),
    "鼠标事件带平台主修饰键时也进入网页点击状态");
    assert.equal((await highlightState(mainPage)).display, "none",
      "鼠标事件带平台主修饰键时选择框应消失");
    await keyChange(mainPage, primary, "keyUp");
    await e2e.hover(mainPage, target);
    await keyChange(mainPage, primary, "keyDown");
    assert(await evaluate(mainPage,
      "document.documentElement.classList.contains('annoy-killer-click-through')"),
    "按住平台主修饰键进入网页点击状态");
    assert.equal((await highlightState(mainPage)).display, "none",
      "按住平台主修饰键后选择框应立即消失");
    await dispatchMouseClick(mainPage, centerOf(await rectFor(mainPage, target)), MODIFIERS[primary].mask);
    assert.equal(await evaluate(mainPage, "window.__normalClickCount"), 1,
      "临时网页点击应交给页面处理");
    assert.equal(await evaluate(mainPage,
      "Boolean(document.querySelector('[data-annoy-killer-session-hidden]'))"), false,
    "临时网页点击不能隐藏元素");
    await keyChange(mainPage, primary, "keyUp");
    assert.equal(await evaluate(mainPage,
      "document.documentElement.classList.contains('annoy-killer-click-through')"), false,
    "松开平台主修饰键恢复选择状态");
    await e2e.hover(mainPage, target);
    await waitHighlightRect(mainPage, await rectFor(mainPage,
      "document.getElementById('range-broadest')"), "松开后恢复默认选择范围", false);
    await closePickerWithEscape(mainPage);
  });

  await run("紧凑入口连同视觉底层隐藏且不扩散", async () => {
    await e2e.reset(mainPage, { label: "compact-promo-background" });
    await evaluate(mainPage, `(() => {
      const sidebar = document.createElement('aside');
      sidebar.id = 'promo-sidebar';
      sidebar.style.cssText = 'position:fixed;left:100px;top:180px;width:160px;height:500px;background:#131313;color:white;z-index:1000';
      sidebar.innerHTML = '<div id="promo-menu" style="height:376px">侧边栏菜单</div>' +
        '<div id="promo-slot" style="position:relative;display:flex;width:160px;height:44px">' +
        '<div id="promo-shell" style="position:relative;display:block;width:136px;height:44px;margin-left:12px">' +
        '<img id="promo-background" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" ' +
        'style="position:absolute;inset:0;width:136px;height:44px;background:#1d2632;border:1px solid #38404a;border-radius:12px;box-sizing:border-box;z-index:-1">' +
        '<div id="promo-content" style="position:relative;display:flex;align-items:center;width:136px;height:44px">' +
        '<span style="display:block;width:24px;height:24px;margin:0 8px;background:#20e3cf;border-radius:6px"></span>' +
        '<div>下载抖音精选</div></div>' +
        '</div></div>' +
        '<div id="promo-neighbor" style="position:relative;display:flex;width:160px;height:44px">' +
        '<div style="display:flex;align-items:center;width:136px;height:44px;margin-left:12px">其他入口</div></div>';
      document.body.append(sidebar);
    })()`);
    await e2e.beginPicker(mainPage);
    const target = "document.querySelector('#promo-content div')";
    await e2e.hover(mainPage, target, "Alt");
    await waitHighlightRect(mainPage, await rectFor(mainPage,
      "document.getElementById('promo-slot')"), "最小范围也包含同组件视觉底层");
    await keyChange(mainPage, "Alt", "keyUp");
    await e2e.select(mainPage, target, "Alt");
    await waitFor(async () => evaluate(mainPage,
      "document.getElementById('promo-slot').hasAttribute('data-annoy-killer-session-hidden')"),
    "完整入口一起隐藏");
    await waitVisible(mainPage, "document.getElementById('promo-background')", false,
      "视觉底层不再残留");
    await waitVisible(mainPage, "document.getElementById('promo-menu')", true,
      "侧栏菜单保持显示");
    await waitVisible(mainPage, "document.getElementById('promo-neighbor')", true,
      "相邻入口保持显示");
    await closePickerWithEscape(mainPage);
  });

  await run("默认选择完整模块且一次只隐藏一个模块", async () => {
    const url = await e2e.reset(mainPage, { label: "repeating-feed-module" });
    await evaluate(mainPage, `(() => {
      const root = document.createElement('div');
      root.id = 'family-feed';
      root.style.cssText = 'position:fixed;left:80px;top:140px;width:1000px;height:720px;z-index:1000';
      document.body.style.cssText = 'height:0;overflow-y:scroll';
      const shelf = (id, title) => '<video-shelf id="' + id + '" is-shorts style="display:block;width:900px;height:460px;padding:20px;background:#f7f7f7;box-sizing:border-box">' +
        '<h2>' + title + '</h2>' +
        '<div class="family-default" style="display:block;width:320px;height:200px;padding:20px;background:#ddd;box-sizing:border-box">' +
        '<div class="family-smaller" style="display:flow-root;width:150px;height:90px;padding:10px;background:#bbb;box-sizing:border-box">' +
        '<div class="family-smallest" style="display:flow-root;width:120px;height:64px;padding:3px;box-sizing:border-box"><span>Shorts</span></div>' +
        '</div></div></video-shelf>';
      root.innerHTML = shelf('family-one', '最相关') + shelf('family-two', 'Shorts') +
        '<video-shelf id="family-other" style="display:block;width:900px;height:120px;background:#def">普通推荐</video-shelf>';
      document.body.append(root);
    })()`);
    await e2e.beginPicker(mainPage);
    const target = "document.querySelector('#family-one .family-smallest span')";
    await e2e.hover(mainPage, target);
    await waitHighlightRect(mainPage, await rectFor(mainPage,
      "document.getElementById('family-one')"), "无按键选择完整 feed 模块", false);
    await e2e.hover(mainPage, target, "Alt");
    await waitHighlightRect(mainPage, await rectFor(mainPage,
      "document.querySelector('#family-one .family-smaller')"), "Alt 选择最小范围");
    await keyChange(mainPage, "Alt", "keyUp");

    await e2e.select(mainPage, target);
    await waitVisible(mainPage, "document.getElementById('family-one')", false, "所选模块隐藏");
    await waitVisible(mainPage, "document.getElementById('family-two')", true, "同页同类模块保持显示");
    await waitVisible(mainPage, "document.getElementById('family-other')", true, "不同类型模块保持显示");
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏",
      "一次选择只能增加一个隐藏项目");
    await closePickerWithEscape(mainPage);
    const rules = await e2e.waitStorageRule("page", pageKey(url));
    assert(rules.some(rule => rule.all !== true && rule.selector === "video-shelf[is-shorts]" &&
      rule.fingerprint?.heading === "最相关"),
    `应保存所选模块的身份规则：${JSON.stringify(rules)}`);
    await evaluate(mainPage, `(() => {
      document.getElementById('family-one').outerHTML =
        '<video-shelf id="family-late" is-shorts style="display:block;width:900px;height:460px;background:#eee">' +
        '<h2>最相关</h2><div>刷新后的不同推荐内容</div></video-shelf>';
    })()`);
    await waitVisible(mainPage, "document.getElementById('family-late')", false,
      "所选板块刷新内容后继续隐藏");
    await waitVisible(mainPage, "document.getElementById('family-two')", true,
      "相邻同类板块在刷新后仍保持显示");
  });

  await run("共享通用属性的板块只隐藏用户选中的一个", async () => {
    await e2e.reset(mainPage, { label: "shared-component-capability" });
    await evaluate(mainPage, `(() => {
      const shelf = (title, top) => {
        const element = document.createElement('recommendation-shelf');
        element.setAttribute('has-expansion-button', '');
        element.style.cssText = 'position:fixed;left:80px;top:' + top +
          'px;display:block;width:920px;height:260px;padding:20px;background:#202020;color:white;box-sizing:border-box;z-index:1000';
        element.innerHTML = '<h2>' + title + '</h2><div style="height:160px;background:#363636">推荐内容</div>';
        document.body.append(element);
      };
      shelf('最相关', 120);
      shelf('短视频', 404);
    })()`);
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelectorAll('recommendation-shelf')[0].querySelector('h2')");
    await waitVisible(mainPage, "document.querySelectorAll('recommendation-shelf')[0]", false, "所选板块隐藏");
    await waitVisible(mainPage, "document.querySelectorAll('recommendation-shelf')[1]", true, "共享能力属性的其他板块保持显示");
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏", "一次选择只能增加一个隐藏项目");
    await closePickerWithEscape(mainPage);
  });

  await run("语义模块候选数量变化后按原槽位持续隐藏", async () => {
    const url = await e2e.reset(mainPage, { label: "semantic-slot-count-change" });
    const installShelves = async (phase) => evaluate(mainPage, `(() => {
      const host = document.createElement('main');
      host.id = 'semantic-slot-feed';
      host.style.cssText = 'position:fixed;left:80px;top:100px;width:980px;z-index:1000';
      const shelf = (id, kind, copy) =>
        '<ytd-rich-section-renderer style="display:block;width:920px;height:250px;margin-bottom:16px">' +
        '<div><ytd-rich-shelf-renderer id="' + id + '" ' + kind +
        ' is-truncated style="display:block;width:920px;height:250px;padding:18px;background:#f7f7f7;box-sizing:border-box">' +
        '<h2>Shorts</h2><div class="shorts-card" style="width:280px;height:130px;padding:18px;background:#ddd;box-sizing:border-box">' +
        '<span class="shorts-label">' + copy +
        '</span></div></ytd-rich-shelf-renderer></div></ytd-rich-section-renderer>';
      host.innerHTML = ${JSON.stringify(phase)} === 'first'
        ? shelf('shorts-original', 'is-shorts', '旧推荐内容') +
          shelf('related-original', 'is-related', '相关内容')
        : shelf('shorts-replacement', 'is-shorts', '刷新后的全新推荐') +
          shelf('shorts-adjacent', 'is-shorts', '另一个 Shorts 栏') +
          shelf('related-replacement', 'is-related', '刷新后的相关内容');
      document.body.append(host);
    })()`);

    await installShelves("first");
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#shorts-original .shorts-label')");
    await waitVisible(mainPage, "document.getElementById('shorts-original')", false,
      "隐藏选中的语义模块");
    await waitVisible(mainPage, "document.getElementById('related-original')", true,
      "不同语义模块保持显示");
    await closePickerWithEscape(mainPage);
    const rules = await e2e.waitStorageRule("page", pageKey(url));
    assert(rules.some(rule => rule.selector === "ytd-rich-shelf-renderer[is-shorts]" &&
      rule.fingerprint?.count === 1),
    `应避开瞬态属性并保存 Shorts 语义槽位：${JSON.stringify(rules)}`);

    await e2e.navigate(mainPage, url);
    await installShelves("second");
    await waitVisible(mainPage, "document.getElementById('shorts-replacement')", false,
      "刷新后原 Shorts 槽位继续隐藏");
    await waitVisible(mainPage, "document.getElementById('shorts-adjacent')", true,
      "新增的相邻 Shorts 槽位保持显示");
    await waitVisible(mainPage, "document.getElementById('related-replacement')", true,
      "相关模块保持显示");
  });

  await run("旧版普通模块批量规则不再误隐藏多个板块", async () => {
    const url = await e2e.reset(mainPage, { label: "legacy-broad-component-rule" });
    await e2e.setStorage({ hiddenRulesByPage: { [pageKey(url)]: [{
      selector: "recommendation-shelf[has-expansion-button]",
      all: true
    }] } });
    await e2e.navigate(mainPage, url);
    await evaluate(mainPage, `(() => {
      for (const title of ['最相关', '最新']) {
        const element = document.createElement('recommendation-shelf');
        element.setAttribute('has-expansion-button', '');
        element.style.cssText = 'display:block;width:800px;height:160px;background:#202020;color:white';
        element.innerHTML = '<h2>' + title + '</h2><div>推荐内容</div><span>广告</span>';
        document.body.append(element);
      }
    })()`);
    await sleep(350);
    await waitVisible(mainPage, "document.querySelectorAll('recommendation-shelf')[0]", true,
      "旧版批量规则不再隐藏第一个普通板块");
    await waitVisible(mainPage, "document.querySelectorAll('recommendation-shelf')[1]", true,
      "旧版批量规则不再隐藏相邻普通板块");

    await e2e.setStorage({ hiddenRulesByPage: { [pageKey(url)]: [{
      selector: "recommendation-shelf[has-expansion-button]",
      all: true,
      marker: { text: "广告", family: "promotion", container: true }
    }] } });
    await sleep(350);
    await waitVisible(mainPage, "document.querySelectorAll('recommendation-shelf')[0]", true,
      "带 promotion marker 的旧批量规则不隐藏第一个容器");
    await waitVisible(mainPage, "document.querySelectorAll('recommendation-shelf')[1]", true,
      "带 promotion marker 的旧批量规则不隐藏相邻容器");
  });

  await run("旧裸 selector 多匹配不误伤且唯一匹配仍兼容", async () => {
    const url = await e2e.reset(mainPage, { label: "legacy-bare-selector" });
    const target = "document.querySelector('[data-legacy-bare=target]')";
    const neighbour = "document.querySelector('[data-legacy-bare=neighbour]')";
    await e2e.setStorage({ hiddenRulesByPage: { [pageKey(url)]: [{
      selector: ".legacy-bare-selector"
    }] } });
    await evaluate(mainPage, `(() => {
      const host = document.createElement('section');
      host.id = 'legacy-bare-host';
      host.innerHTML = ['target', 'neighbour'].map(name =>
        '<article class="legacy-bare-selector" data-legacy-bare="' + name +
        '" style="display:block;width:420px;height:90px">' + name + '</article>').join('');
      document.body.append(host);
    })()`);
    await sleep(350);
    await waitVisible(mainPage, target, true, "旧裸 selector 多匹配时保留目标");
    await waitVisible(mainPage, neighbour, true, "旧裸 selector 多匹配时保留邻项");
    assert.equal(await evaluate(mainPage,
      "document.querySelectorAll('[data-annoy-killer-persistent-hidden]').length"), 0,
    "歧义 selector 不得标记任何匹配项");

    await evaluate(mainPage, `${neighbour}.remove()`);
    await waitVisible(mainPage, target, false, "旧裸 selector 恢复唯一匹配后继续隐藏");
    assert.equal(await evaluate(mainPage,
      `${target}.hasAttribute('data-annoy-killer-persistent-hidden')`), true,
    "唯一匹配必须保留旧规则兼容性");
  });

  await run("普通 fingerprint 目标消失重排时不按旧索引误伤邻项", async () => {
    const url = await e2e.reset(mainPage, { label: "fingerprint-no-slot-fallback" });
    const selector = ".ordinary-fingerprint-card";
    await e2e.setStorage({ hiddenRulesByPage: { [pageKey(url)]: [{
      selector,
      fingerprint: {
        text: "Saved target",
        childSignature: "span",
        index: 1,
        count: 3
      }
    }] } });
    await evaluate(mainPage, `(() => {
      const host = document.createElement('section');
      host.id = 'ordinary-fingerprint-host';
      host.innerHTML = ['neighbour-c', 'neighbour-a', 'neighbour-b'].map(name =>
        '<article class="ordinary-fingerprint-card" data-card="' + name +
        '" style="display:block;width:420px;height:90px"><span>' + name + '</span></article>').join('');
      document.body.append(host);
    })()`);
    await sleep(350);
    const states = await evaluate(mainPage, `([...document.querySelectorAll(${JSON.stringify(selector)})]
      .map(node => ({ name: node.dataset.card, display: getComputedStyle(node).display,
        persistent: node.hasAttribute('data-annoy-killer-persistent-hidden') })))`);
    assert(states.every(state => state.display !== "none" && !state.persistent),
      `无唯一身份证据时不得按旧 index 隐藏重排邻项：${JSON.stringify(states)}`);

    await evaluate(mainPage,
      "document.querySelector('[data-card=neighbour-c] span').textContent = 'Saved target'");
    await waitVisible(mainPage, "document.querySelector('[data-card=neighbour-c]')", false,
      "唯一身份重新出现后恢复目标");
    await waitVisible(mainPage, "document.querySelector('[data-card=neighbour-a]')", true,
      "旧 index 对应邻项保持显示");
  });

  await run("近等尺寸内容层默认提升到布局槽位并释放占位", async () => {
    await e2e.reset(mainPage, { label: "layout-slot-wrapper" });
    await evaluate(mainPage, `(() => {
      const stage = document.createElement('section');
      stage.id = 'media-stage';
      stage.style.cssText = 'position:fixed;left:90px;top:100px;width:1000px;height:650px;display:grid;grid-template-rows:minmax(0,1fr) auto;background:#111;z-index:1000';
      stage.innerHTML = '<div id="media-surface" style="min-height:0;background:#251052"></div>' +
        '<div id="control-slot" style="height:100px;display:flex;align-items:flex-end">' +
        '<div id="control-bar" style="display:flex;width:1000px;height:96px;align-items:center;background:#51472f;color:white">' +
        '<div style="display:flex;width:120px;height:40px;align-items:center;padding:6px;box-sizing:border-box">互动工具</div>' +
        '<div style="display:flex;flex:1;height:40px;align-items:center">快捷操作列表</div>' +
        '</div></div>';
      document.body.append(stage);
    })()`);
    const surfaceHeight = async () => evaluate(mainPage,
      "document.getElementById('media-surface').getBoundingClientRect().height");
    const before = await surfaceHeight();
    await e2e.beginPicker(mainPage);
    const target = "document.querySelector('#control-bar div')";
    await e2e.hover(mainPage, target);
    await waitHighlightRect(mainPage, await rectFor(mainPage,
      "document.getElementById('control-slot')"), "默认选择负责占位的近等尺寸外层", false);
    await e2e.select(mainPage, target);
    await waitVisible(mainPage, "document.getElementById('control-slot')", false, "完整布局槽位隐藏");
    await waitFor(async () => await surfaceHeight() >= before + 99, "媒体区域释放占位并向下延展");
    assert(await evaluate(mainPage,
      "document.getElementById('media-stage').getBoundingClientRect().height === 650"),
    "不能误选整个媒体舞台");
    await closePickerWithEscape(mainPage);
  });

  await run("深层匿名直播控制默认提升到通用底部槽位", async () => {
    await e2e.reset(mainPage, { label: "generic-deep-live-slot" });
    await evaluate(mainPage, `(() => {
      const stage = document.createElement('section');
      stage.id = 'generic-live-stage';
      stage.style.cssText = 'position:fixed;left:60px;top:100px;width:1100px;height:680px;display:grid;grid-template-rows:minmax(0,1fr) auto;background:#140032;z-index:1000';
      stage.innerHTML = '<div id="generic-video-surface" style="min-height:0;background:#251052"></div>' +
        '<div id="generic-bottom-slot" style="height:88px;display:block;background:#45453f">' +
        '<div style="position:relative;display:flex;width:1100px;height:88px">' +
        '<div style="display:flex;width:1088px;height:104px;margin:-8px 6px 0">' +
        '<div style="display:flex;width:1040px;height:80px;margin:0 4px">' +
        '<div style="display:flex;width:900px;height:96px;overflow:hidden">' +
        '<div style="display:flex;width:82px;height:80px">' +
        '<div id="generic-live-control" style="display:flex;width:70px;height:44px;align-items:center;color:white">直播互动控制</div>' +
        '</div></div></div></div></div></div>';
      document.body.append(stage);
    })()`);
    const before = await evaluate(mainPage,
      "document.getElementById('generic-video-surface').getBoundingClientRect().height");
    await e2e.beginPicker(mainPage);
    const target = "document.getElementById('generic-live-control')";
    await e2e.hover(mainPage, target);
    await waitHighlightRect(mainPage, await rectFor(mainPage,
      "document.getElementById('generic-bottom-slot')"), "通用规则选中完整底部槽位", false);
    await e2e.select(mainPage, target);
    await waitVisible(mainPage, "document.getElementById('generic-bottom-slot')", false,
      "通用规则隐藏完整底部槽位");
    await waitFor(async () => evaluate(mainPage,
      `document.getElementById('generic-video-surface').getBoundingClientRect().height >= ${before + 87}`),
    "通用直播画面释放底部占位");
    await waitVisible(mainPage, "document.getElementById('generic-live-stage')", true,
      "通用规则不能误隐藏整个直播舞台");
    await closePickerWithEscape(mainPage);
  });

  await run("直播底部控制内容默认提升到完整布局槽位", async () => {
    await e2e.reset(mainPage, { label: "live-control-slot" });
    await evaluate(mainPage, `(() => {
      const stage = document.createElement('section');
      stage.id = 'live-stage';
      stage.style.cssText = 'position:fixed;left:60px;top:100px;width:1100px;height:680px;background:#140032;z-index:1000';
      stage.innerHTML = '<div id="ContainerBackgroundLayout" style="width:100%;height:100%">' +
        '<div id="LeftBackgroundLayout" style="width:100%;height:100%;display:grid;grid-template-rows:minmax(0,1fr) auto">' +
        '<div id="live-video" style="min-height:0;background:#251052"></div>' +
        '<div id="BottomLayout" style="height:88px;display:block;background:#45453f">' +
        '<div class="YWoVbeaa NP47LiqA klDKYUkp" style="position:relative;display:flex;width:1100px;height:88px">' +
        '<div class="xAG9cqUC gitBarOptimizeEnabled metro" style="display:flex;width:1088px;height:88px;margin:0 6px">' +
        '<div class="RlvV_pZh" style="display:flex;width:1040px;height:80px;margin:0 4px">' +
        '<div class="NMfqnFm5" style="display:flex;width:900px;height:80px;overflow:hidden">' +
        '<div class="gift_item_gift_bar" style="display:flex;width:82px;height:80px">' +
        '<div id="live-control-content" style="display:flex;width:70px;height:44px;align-items:center;color:white">直播互动控制</div>' +
        '</div></div></div></div></div></div></div></div>';
      document.body.append(stage);
    })()`);
    const before = await evaluate(mainPage,
      "document.getElementById('live-video').getBoundingClientRect().height");
    await e2e.beginPicker(mainPage);
    const target = "document.querySelector('#live-control-content')";
    await e2e.hover(mainPage, target);
    await waitHighlightRect(mainPage, await rectFor(mainPage,
      "document.getElementById('BottomLayout')"), "默认选中抖音真实 BottomLayout", false);
    await e2e.select(mainPage, target);
    await waitVisible(mainPage, "document.getElementById('BottomLayout')", false,
      "第一次点击即隐藏完整底部槽位");
    await waitFor(async () => evaluate(mainPage,
      `document.getElementById('live-video').getBoundingClientRect().height >= ${before + 87}`),
    "直播画面释放底部占位");
    await waitVisible(mainPage, "document.getElementById('live-stage')", true,
      "不能误隐藏整个直播舞台");
    await closePickerWithEscape(mainPage);
  });

  await run("结构化结果列表默认选择完整结果项", async () => {
    await e2e.reset(mainPage, { label: "result-list" });
    await evaluate(mainPage, `(() => {
      const host = document.createElement('main');
      host.setAttribute('role', 'main');
      host.style.cssText = 'position:fixed;left:90px;top:150px;width:720px;padding:8px 24px;background:white;z-index:1000';
      host.innerHTML = [1, 2].map(index => '<article class="result-card" style="display:block;width:620px;margin:0 0 18px;padding:18px 0;background:white">' +
        '<h3 style="margin:0 0 8px;font-size:22px"><a href="/result-' + index + '">Result title ' + index + '</a></h3>' +
        '<div class="result-meta" style="margin-bottom:8px;color:#64748b">example.com</div>' +
        '<div class="result-summary" style="width:360px;padding:10px;background:#eef2ff">Summary text ' + index + '</div>' +
        '</article>').join('');
      document.body.append(host);
    })()`);
    const first = "document.querySelector('.result-card')";
    const summary = "document.querySelector('.result-card .result-summary')";
    const second = "document.querySelectorAll('.result-card')[1]";
    await e2e.beginPicker(mainPage);
    await e2e.hover(mainPage, summary);
    await waitHighlightRect(mainPage, await rectFor(mainPage, first), "结果列表完整项", false);
    await e2e.select(mainPage, summary);
    await waitVisible(mainPage, first, false, "隐藏完整结果项");
    await waitVisible(mainPage, "document.querySelector('.result-card h3')", false,
      "结果标题随完整结果项一起隐藏");
    await waitVisible(mainPage, second, true, "相邻结果项保持显示");
  });

  await run("重复内容卡片默认选择整卡且 Option 选择细节", async () => {
    await e2e.reset(mainPage, { label: "repeated-content-card-selection" });
    await evaluate(mainPage, `(() => {
      const grid = document.createElement('content-grid');
      grid.style.cssText = 'position:fixed;left:80px;top:120px;width:930px;display:grid;grid-template-columns:repeat(3, 1fr);gap:18px;z-index:1000';
      const tile = (index) => '<content-tile data-index="' + index + '" style="display:block;height:330px;padding:12px;background:white;box-sizing:border-box">' +
        '<media-pane style="display:block;width:100%;height:190px"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" style="display:block;width:100%;height:100%;background:#dbeafe"></media-pane>' +
        '<details-pane style="display:block;width:240px;height:96px;padding:10px;box-sizing:border-box;background:#f8fafc">' +
        '<a href="/item-' + index + '">推荐内容 ' + index + '</a><span class="card-meta" style="display:block;margin-top:10px">内容来源与附加信息</span>' +
        '</details-pane></content-tile>';
      grid.innerHTML = tile(1) + tile(2) + tile(3);
      document.body.append(grid);
    })()`);
    const target = "document.querySelector('content-tile .card-meta')";
    const card = "document.querySelector('content-tile')";
    const detail = "document.querySelector('content-tile details-pane')";
    const neighbor = "document.querySelectorAll('content-tile')[1]";
    await e2e.beginPicker(mainPage);
    await e2e.hover(mainPage, target);
    await waitHighlightRect(mainPage, await rectFor(mainPage, card), "默认选中完整重复卡片", false);
    await e2e.hover(mainPage, target, "Alt");
    await waitHighlightRect(mainPage, await rectFor(mainPage, detail), "Option 选择卡片内部细节");
    await keyChange(mainPage, "Alt", "keyUp");
    await e2e.select(mainPage, target);
    await waitVisible(mainPage, card, false, "默认隐藏完整卡片");
    await waitVisible(mainPage, neighbor, true, "相邻卡片保持显示");
    await closePickerWithEscape(mainPage);
  });

  await run("广告披露网格卡片隐藏后释放占位并持续匹配槽位", async () => {
    const url = await e2e.reset(mainPage, { label: "promotion-grid-slot-collapse" });
    await evaluate(mainPage, `(() => {
      const host = document.createElement('main');
      host.id = 'promotion-grid';
      host.style.cssText = 'position:fixed;left:90px;top:120px;width:930px;display:grid;grid-template-columns:repeat(3, 1fr);gap:18px;z-index:1000';
      const card = (kind, title, disclosure = '') =>
        '<article class="feed-card" data-kind="' + kind + '" style="display:block;min-width:0;height:260px;padding:16px;background:white;border:1px solid #d6d6d6;box-sizing:border-box">' +
        '<a href="/' + kind + '"><img alt="" style="display:block;width:100%;height:138px;background:#dbeafe"></a>' +
        '<h3 style="margin:12px 0 8px;font-size:18px"><a href="/' + kind + '">' + title + '</a></h3>' +
        (disclosure ? '<div class="meta"><span>' + disclosure + '</span></div>' : '<p>普通推荐内容</p>') +
        '</article>';
      host.innerHTML =
        card('ad', '首个赞助卡片', '赞助商广告 · Example') +
        card('organic-one', '普通卡片一') +
        card('organic-two', '普通卡片二');
      document.body.append(host);
    })()`);
    const firstCard = "document.querySelector('[data-kind=ad]')";
    const secondCard = "document.querySelector('[data-kind=organic-one]')";
    const originalFirstRect = await rectFor(mainPage, firstCard);
    const originalSecondRect = await rectFor(mainPage, secondCard);

    await e2e.beginPicker(mainPage);
    await e2e.hover(mainPage, "document.querySelector('[data-kind=ad] .meta span')");
    await waitHighlightRect(mainPage, originalFirstRect, "默认选择完整广告卡片槽位", false);
    await e2e.select(mainPage, "document.querySelector('[data-kind=ad] .meta span')");
    await waitVisible(mainPage, firstCard, false, "隐藏完整广告卡片");
    await waitFor(async () => {
      const moved = await rectFor(mainPage, secondCard);
      return Math.abs(moved.left - originalFirstRect.left) <= 3 &&
        Math.abs(moved.top - originalFirstRect.top) <= 3 &&
        Math.abs(moved.left - originalSecondRect.left) > 30;
    }, "隐藏后相邻卡片顶到原广告槽位");
    await closePickerWithEscape(mainPage);

    const rules = await e2e.waitStorageRule("page", pageKey(url));
    assert(rules.some(rule => rule.marker?.family === "promotion" &&
      /feed-card|article/.test(rule.selector)),
    `广告披露规则应指向通用卡片容器：${JSON.stringify(rules)}`);

    await evaluate(mainPage, `(() => {
      const oldAd = document.querySelector('[data-kind=ad]');
      const replacement = document.createElement('article');
      replacement.className = 'feed-card refreshed-campaign';
      replacement.dataset.kind = 'ad';
      replacement.style.cssText = 'display:block;min-width:0;height:260px;padding:16px;background:white;border:1px solid #d6d6d6;box-sizing:border-box';
      replacement.innerHTML = '<a href="/new-ad"><img alt="" style="display:block;width:100%;height:138px;background:#fee2e2"></a>' +
        '<h3 style="margin:12px 0 8px;font-size:18px"><a href="/new-ad">刷新后的新广告素材</a></h3>' +
        '<div class="meta"><span aria-label="Sponsored ad by Example"></span></div>';
      oldAd.replaceWith(replacement);
    })()`);
    await waitVisible(mainPage, "document.querySelector('[data-kind=ad]')", false,
      "同一广告槽位替换新素材后继续隐藏");
  });

  await run("搜索跟踪参数变化、结果摘要与广告素材替换后继续隐藏", async () => {
    const resetUrl = await e2e.reset(mainPage, { label: "search-slot-persistence" });
    const firstAddress = new URL(resetUrl);
    firstAddress.searchParams.set("q", "stable search topic");
    firstAddress.searchParams.set("tracking", "first-request");
    await e2e.navigate(mainPage, firstAddress.href);

    const installResults = async (phase) => evaluate(mainPage, `(() => {
      const existing = document.getElementById('dynamic-search-results');
      if (existing) existing.remove();
      const host = document.createElement('main');
      host.id = 'dynamic-search-results';
      host.setAttribute('role', 'main');
      host.style.cssText = 'position:fixed;left:90px;top:110px;width:760px;padding:12px 30px;background:white;z-index:1000';
      const card = (kind, title, summary, disclosure = '') =>
        '<article class="result-card" data-kind="' + kind + '" style="display:block;width:660px;margin:0 0 14px;padding:14px 0;background:white">' +
        '<h3 style="margin:0 0 7px;font-size:21px"><a href="/' + kind + '">' + title + '</a></h3>' +
        '<div class="result-summary">' + summary + '</div>' +
        (disclosure ? '<div class="result-meta"><span>' + disclosure + '</span></div>' : '') +
        '</article>';
      const replacementAd = (kind, title, summary) =>
        '<section class="replacement-campaign-module" data-kind="' + kind + '" style="display:block;width:660px;margin:0 0 14px;padding:14px 0;background:white">' +
        '<h3 style="margin:0 0 7px;font-size:21px"><a href="/' + kind + '-replacement">' + title + '</a></h3>' +
        '<div class="replacement-copy">' + summary + '</div>' +
        (kind === 'ad'
          ? '<footer><a href="/disclosure"><span aria-label="Sponsored content"></span></a></footer>'
          : '<footer><button title="Promoted"></button><a href="/details">Details</a></footer>') +
        '</section>';
      const bannerAd = '<div class="promo-banner-module" data-kind="ad-banner" style="display:block;width:660px;height:84px;margin:0 0 14px;background:#eef2ff">' +
        '<a href="/banner"><img alt="Campaign artwork" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></a>' +
        '<span aria-label="Advertisement"></span></div>';
      host.innerHTML = ${JSON.stringify("first")} === ${JSON.stringify(phase)}
        ? card('first', 'Persistent result one', 'Original summary one') +
          card('ad', 'Original campaign title', 'Original campaign body', '广告') +
          card('second', 'Persistent result two', 'Original summary two') +
          card('organic', 'Visible organic result', 'Must stay visible')
        : replacementAd('ad', 'Completely different campaign', 'Replacement creative and destination') +
          card('first', 'Persistent result one', 'Changed summary one') +
          card('organic', 'Visible organic result', 'This article discusses advertising but is not a disclosure label') +
          replacementAd('ad-two', 'Another new campaign', 'A second advertising module') +
          bannerAd +
          card('second', 'Persistent result two', 'Changed summary two');
      document.body.append(host);
    })()`);

    await installResults("first");
    await e2e.beginPicker(mainPage);
    for (const kind of ["first", "ad", "second"]) {
      const target = `document.querySelector('[data-kind="${kind}"] .result-summary')`;
      await e2e.select(mainPage, target);
      await waitVisible(mainPage, `document.querySelector('[data-kind="${kind}"]')`, false,
        `隐藏搜索结果 ${kind}`);
    }
    await clickClosedShadowButton(mainPage, "完成");
    const rules = await e2e.waitStorageRule("page", pageKey(firstAddress.href));
    assert.equal(rules.length, 3, `应保存三个结果模块规则：${JSON.stringify(rules)}`);
    assert(rules.some((rule) => rule.marker?.text === "广告"),
      `广告规则必须保存披露标记：${JSON.stringify(rules)}`);
    assert(rules.some((rule) => rule.marker?.text === "广告" && rule.all !== true),
      `新广告规则必须优先保存单槽位匹配：${JSON.stringify(rules)}`);
    assert(rules.some((rule) => rule.marker?.family === "promotion"),
      `广告规则必须保存通用披露标记族：${JSON.stringify(rules)}`);

    const secondAddress = new URL(firstAddress);
    secondAddress.searchParams.set("tracking", "second-request");
    secondAddress.searchParams.set("request_id", "changed-every-search");
    await e2e.navigate(mainPage, secondAddress.href);
    await installResults("second");
    for (const kind of ["first", "ad", "second"]) {
      await waitVisible(mainPage, `document.querySelector('[data-kind="${kind}"]')`, false,
        `重新搜索后继续隐藏 ${kind}`);
    }
    await waitVisible(mainPage, "document.querySelector('[data-kind=ad-two]')", true,
      "重新搜索后未选择的同结构广告保持显示");
    await waitVisible(mainPage, "document.querySelector('[data-kind=ad-banner]')", true,
      "无标题且仅用无障碍标签标记的未选广告横幅保持显示");
    await waitVisible(mainPage, "document.querySelector('[data-kind=organic]')", true,
      "未选择的普通结果保持显示");

    await evaluate(mainPage, `(() => {
      const oldAd = document.querySelector('[data-kind=ad]');
      oldAd.outerHTML = '<div class="third-campaign-result" data-kind="ad" style="display:block;width:660px;margin:0 0 14px;padding:14px 0;background:white">' +
        '<h3><a href="/ad-new">Third campaign after async refresh</a></h3>' +
        '<div class="result-summary">Entirely new asynchronous creative</div>' +
        '<div class="result-meta"><span title="Advertisement"></span></div></div>';
    })()`);
    await waitVisible(mainPage, "document.querySelector('[data-kind=ad]')", false,
      "广告模块异步更换素材后继续隐藏");

    const differentQueryAddress = new URL(secondAddress);
    differentQueryAddress.searchParams.set("q", "a different search topic");
    differentQueryAddress.searchParams.set("tracking", "third-request");
    await e2e.navigate(mainPage, differentQueryAddress.href);
    await installResults("second");
    await waitVisible(mainPage, "document.querySelector('[data-kind=ad]')", false,
      "更换搜索词后选中的广告槽位继续隐藏");
    for (const kind of ["ad-two", "ad-banner", "first", "organic", "second"]) {
      await waitVisible(mainPage, `document.querySelector('[data-kind="${kind}"]')`, true,
        `更换搜索词后未选择模块不扩散 ${kind}`);
    }
  });

  await run("视觉区块纯图标按钮与默认范围保底", async () => {
    await e2e.reset(mainPage, { label: "icon-only-controls" });
    await evaluate(mainPage, `(() => {
      const sidebar = document.createElement('div');
      sidebar.id = 'icon-sidebar';
      sidebar.style.cssText = 'position:fixed;left:100px;top:180px;width:160px;height:640px;background:#161616;color:#aaa;z-index:1000';
      sidebar.innerHTML = '<style>' +
        '#icon-panel-menu {position:relative;display:flex;width:160px;height:60px;padding:14px 0 14px 12px}' +
        '.icon-item {position:relative;flex:none;width:32px;height:32px}' +
        '.icon-control {display:flex;width:32px;height:32px;padding:4px}' +
        '.icon-item svg {display:block;width:24px;height:24px}' +
        '#icon-item-3 {display:flex;align-items:center;justify-content:center}' +
        '#icon-item-3::after {content:"";position:absolute;right:2px;top:1px;width:4px;height:4px;border-radius:50%;background:#fe2c55}' +
        '</style><div style="height:580px">页面导航</div><div id="icon-panel-menu"></div>';
      const menu = sidebar.querySelector('#icon-panel-menu');
      for (let index=0;index<4;index++) {
        const item=document.createElement('div');
        item.id='icon-item-'+index;
        item.className='icon-item';
        const svg='<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 4H20V20H4Z" stroke="currentColor" stroke-width="2"/></svg>';
        item.innerHTML=index===3?'<span role="img">'+svg+'</span>':'<div class="icon-control">'+svg+'</div>';
        menu.append(item);
      }
      menu.insertAdjacentHTML('beforeend', '<svg id="bare-footer-icon" width="16" height="16" viewBox="0 0 16 16" style="position:absolute;left:143px;top:22px"><path d="M2 2H14V14H2Z" fill="currentColor"/></svg>');
      document.body.append(sidebar);
    })()`);
    await e2e.beginPicker(mainPage);
    const menu = "document.getElementById('icon-panel-menu')";
    const menuRect = await rectFor(mainPage, menu);
    for (let index = 0; index < 4; index += 1) {
      const item = `document.getElementById('icon-item-${index}')`;
      const icon = `(${item}).querySelector('svg')`;
      await e2e.hover(mainPage, icon);
      await waitHighlightRect(mainPage, menuRect, "默认选中底部按钮区域", false);
      for (const modifier of ['Alt']) {
        await e2e.hover(mainPage, icon, modifier);
        await waitHighlightRect(mainPage, await rectFor(mainPage, item), "快捷键选中完整的无文字按钮");
        await keyChange(mainPage, modifier, 'keyUp');
        await waitHighlightRect(mainPage, menuRect, "松开快捷键恢复原来的选区", false);
      }
    }
    for (const modifier of ['Alt']) {
      await e2e.hover(mainPage, "document.getElementById('bare-footer-icon')");
      await waitHighlightRect(mainPage, menuRect, "装饰图标默认选区", false);
      await keyChange(mainPage, modifier, 'keyDown');
      await waitHighlightRect(mainPage, menuRect, "没有更小完整控件时保留原选区，不跳到侧栏");
      await keyChange(mainPage, modifier, 'keyUp');
    }
    await e2e.hover(mainPage, "document.querySelector('#icon-item-3 svg')", 'Alt');
    await waitHighlightRect(mainPage, await rectFor(mainPage, "document.getElementById('icon-item-3')"), "图标按钮截图");
    await captureScreenshot(mainPage, artifactPath, 'icon-only-control-highlight');
    await keyChange(mainPage, 'Alt', 'keyUp');
    for (let index = 0; index < 4; index += 1) {
      const item = `document.getElementById('icon-item-${index}')`;
      await e2e.select(mainPage, `(${item}).querySelector('svg')`, 'Alt');
      await waitFor(async () => evaluate(mainPage, `(${item}).hasAttribute('data-annoy-killer-session-hidden')`), "隐藏完整图标按钮容器");
      for (let sibling = index + 1; sibling < 4; sibling += 1) {
        assert(await visible(mainPage, `document.getElementById('icon-item-${sibling}')`));
      }
    }
    await closePickerWithEscape(mainPage);
    for (let index = 0; index < 4; index += 1) await waitVisible(mainPage,
      `document.getElementById('icon-item-${index}')`, false, "Escape 自动保存完整图标按钮");
  });

  await run("视觉区块导航每一项可独立隐藏", async () => {
    let url = await e2e.reset(mainPage, { label: "fine-nav-items" });
    const mountNav = async () => evaluate(mainPage, `(() => {
      const panel = document.createElement('div');
      panel.id = 'fine-nav-panel';
      panel.style.cssText = 'position:fixed;left:100px;top:180px;width:600px;height:160px;padding:24px;background:#39321d;z-index:1000;color:#b9b59e';
      panel.innerHTML = '<style>' +
        '#fine-nav-row {display:flex;align-items:center;gap:24px;width:520px;height:72px}' +
        '.fine-nav-item {position:relative;display:inline-flex;justify-content:center;flex:none;width:32px;height:44px;margin:0;padding:0;border:0;background:none;color:inherit;text-decoration:none;font:10px/20px sans-serif}' +
        '.fine-nav-core {display:flex;flex-direction:column;align-items:center;height:44px}' +
        '.fine-nav-icon {display:block;width:24px;height:24px;flex:none}' +
        '.fine-nav-label {margin:0;padding:0;white-space:nowrap}' +
        '.fine-nav-css-icon {display:block;width:24px;height:24px;background:currentColor;clip-path:polygon(5% 15%,95% 15%,45% 95%)}' +
        '.fine-nav-count-wrap {position:absolute;top:-4px;right:-6px}' +
        '.fine-nav-count {display:block;width:20px;height:20px;border-radius:50%;background:#fe2c55;color:white;text-align:center}' +
        '</style><div id="fine-nav-row"></div>';
      const row = panel.querySelector('#fine-nav-row');
      ['充钻石','客户端','壁纸','通知','消息','投稿'].forEach((text, index) => {
        const item = document.createElement(['div','a','button','ul','div','div'][index]);
        item.id = 'fine-nav-' + index;
        item.className = 'fine-nav-item';
        if (index === 1) item.href = '#download';
        if (index === 5) item.setAttribute('role','button');
        const icon = index === 4 ? '<i class="fine-nav-css-icon"></i>' : '<span role="img"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3 21 10 12 21 3 10Z" stroke="currentColor" stroke-width="2"/></svg></span>';
        item.innerHTML = '<div class="fine-nav-core" data-e2e="something-button"><div class="fine-nav-icon">' + icon + '</div><p class="fine-nav-label">' + text + '</p></div>' +
          (index === 4 ? '<div class="fine-nav-count-wrap"><span class="fine-nav-count">1</span></div>' : '');
        row.append(item);
      });
      document.body.append(panel);
    })()`);
    await mountNav();
    await e2e.beginPicker(mainPage);
    const panel = "document.getElementById('fine-nav-panel')";
    for (let index = 0; index < 6; index += 1) {
      const item = `document.getElementById('fine-nav-${index}')`;
      const itemRect = await rectFor(mainPage, item);
      for (const child of ['.fine-nav-icon', '.fine-nav-label']) {
        await e2e.hover(mainPage, `(${item}).querySelector('${child}')`);
        const largeRect = await rectFor(mainPage, panel);
        await waitHighlightRect(mainPage, largeRect, "默认选取整个较大导航区域", false);
        assert(largeRect.width * largeRect.height > itemRect.width * itemRect.height * 10,
          "默认和快捷键选区应有明显大小差异");
        for (const modifier of ['Alt']) {
          await e2e.hover(mainPage, `(${item}).querySelector('${child}')`, modifier);
          await waitHighlightRect(mainPage, itemRect, "快捷键选择单项的完整图标和文字");
          await keyChange(mainPage, modifier, 'keyUp');
        }
      }
    }
    await e2e.hover(mainPage, "document.querySelector('#fine-nav-4 .fine-nav-label')", 'Alt');
    await waitHighlightRect(mainPage, await rectFor(mainPage, "document.getElementById('fine-nav-4')"), "消息整体选区");
    await captureScreenshot(mainPage, artifactPath, 'fine-nav-single-item');
    await keyChange(mainPage, 'Alt', 'keyUp');
    for (let index = 0; index < 6; index += 1) {
      const item = `document.getElementById('fine-nav-${index}')`;
      await e2e.select(mainPage, `(${item}).querySelector('.fine-nav-label')`, 'Alt');
      await waitFor(async () => evaluate(mainPage, `(${item}).hasAttribute('data-annoy-killer-session-hidden')`), "单独隐藏完整导航项");
      for (const child of ['.fine-nav-icon', '.fine-nav-label']) {
        await waitVisible(mainPage, `(${item}).querySelector('${child}')`, false, "图标和文字一起消失");
      }
      for (let sibling = index + 1; sibling < 6; sibling += 1) {
        assert(await visible(mainPage, `document.getElementById('fine-nav-${sibling}')`), "其他导航项不受影响");
      }
    }
    await waitVisible(mainPage, "document.querySelector('.fine-nav-count')", false, "消息附带的红色数字标签也随整项隐藏");
    await closePickerWithEscape(mainPage);
    for (let index = 0; index < 6; index += 1) {
      await waitVisible(mainPage, `document.getElementById('fine-nav-${index}')`, false,
        "Escape 自动保存每一项");
    }
    url = await e2e.reset(mainPage, { label: "fine-nav-save-one" });
    await mountNav();
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#fine-nav-4 .fine-nav-icon')", 'Alt');
    await waitVisible(mainPage, "document.getElementById('fine-nav-4')", false, "保存单独隐藏的消息项");
    await clickClosedShadowButton(mainPage, '完成');
    await e2e.waitStorageRule('page', pageKey(url));
    await e2e.navigate(mainPage, url);
    await mountNav();
    await waitVisible(mainPage, "document.getElementById('fine-nav-4')", false, "单项隐藏刷新后继续生效");
    for (const index of [0,1,2,3,5]) assert(await visible(mainPage, `document.getElementById('fine-nav-${index}')`));
  });

  await run("视觉区块真实 SVG NEW 标签整体选择", async () => {
    const url = await e2e.reset(mainPage, { label: "svg-new-badge" });
    const mountBadge = async () => evaluate(mainPage, `(() => {
      const panel = document.createElement('div');
      panel.id = 'svg-label-panel';
      panel.style.cssText = 'position:fixed;left:100px;top:180px;width:360px;height:140px;padding:24px;background:#39321d;z-index:1000';
      panel.innerHTML = '<div class="oi8cIVOq" style="position:relative;width:80px;height:60px;color:white">客户端<div class="ln1eo2Lx RE1BSMn6" style="position:absolute;left:48px;top:-12px"><svg width="28" height="15" fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 15"><rect width="28" height="15" rx="7.5" fill="#FE2C55"></rect><path d="M8.05 4v4.27L5.05 4H4v7h1.38V6.72l3 4.28h1.05V4H8.05zM12.108 9.68V8.11h2.65v-1.3h-2.65V5.32h2.9V4h-4.28v7h4.33V9.68h-2.95zM17.491 11h1.57l1.31-4.62 1.32 4.62h1.57l1.96-7h-1.45l-1.34 5.19L20.961 4h-1.18l-1.46 5.19L16.981 4h-1.45l1.96 7z" fill="#fff"></path></svg></div></div>';
      document.body.append(panel);
    })()`);
    await mountBadge();
    const badge = "document.querySelector('#svg-label-panel .ln1eo2Lx')";
    const panel = "document.getElementById('svg-label-panel')";
    const badgeRect = await rectFor(mainPage, badge);
    await e2e.beginPicker(mainPage);
    for (const modifier of ['Alt']) {
      for (const child of ['rect', 'path']) {
        await e2e.hover(mainPage, `(${badge}).querySelector('${child}')`, modifier);
        await waitHighlightRect(mainPage, badgeRect, "红底和路径文字选中同一个完整 SVG");
      }
      await keyChange(mainPage, modifier, 'keyUp');
    }
    await e2e.hover(mainPage, badge);
    await waitHighlightRect(mainPage, await rectFor(mainPage, panel), "默认仍选择较大的区块", false);
    await e2e.hover(mainPage, `(${badge}).querySelector('path')`, 'Alt');
    await waitHighlightRect(mainPage, badgeRect, "真实标签高亮贴合");
    await captureScreenshot(mainPage, artifactPath, 'svg-new-badge-highlight');
    await e2e.select(mainPage, `(${badge}).querySelector('path')`, 'Alt');
    await waitFor(async () => evaluate(mainPage, `(${badge}).hasAttribute('data-annoy-killer-session-hidden')`), "隐藏整个标签容器而非 SVG 子路径");
    for (const child of ['svg', 'rect', 'path']) {
      await waitVisible(mainPage, `(${badge}).querySelector('${child}')`, false, "SVG、红色背景和文字全部消失");
    }
    assert(await visible(mainPage, panel), "客户端所属区块仍然可见");
    await closePickerWithEscape(mainPage);
    await waitVisible(mainPage, badge, false, "Escape 保存完整 SVG 隐藏");
    await e2e.beginPicker(mainPage);
    await clickClosedShadowButton(mainPage, "重置");
    await e2e.select(mainPage, badge, 'Alt');
    await waitVisible(mainPage, badge, false, "再次选中完整 SVG 后保存");
    await clickClosedShadowButton(mainPage, '完成');
    await e2e.waitStorageRule('page', pageKey(url));
    await e2e.navigate(mainPage, url);
    await mountBadge();
    await waitVisible(mainPage, badge, false, "刷新后完整 SVG 规则持久生效");
    assert(await visible(mainPage, panel), "刷新后仍只隐藏标签");
  });

  await run("视觉区块小标签整体选择", async () => {
    await e2e.reset(mainPage, { label: "compact-badges" });
    await evaluate(mainPage, `(() => {
      const panel = document.createElement('div');
      panel.id = 'badge-panel';
      panel.style.cssText = 'position:fixed;left:100px;top:180px;width:540px;height:180px;padding:24px;background:#39321d;z-index:1000;display:flex;align-items:flex-start;gap:16px';
      panel.innerHTML = '<style>' +
        '.compact-badge {position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;width:60px;height:28px;color:white;font:700 14px/1 sans-serif;border-radius:8px}' +
        '#badge-pseudo::before {content:"";position:absolute;inset:0;background:#ff4652;border-radius:8px}' +
        '#badge-pseudo span,#badge-split span {position:relative}' +
        '#badge-decoration {position:absolute;inset:0;border:2px solid #ff4652;border-radius:8px}' +
        '</style>' +
        '<span id="badge-solid" class="compact-badge" style="background:#ff4652"><span>NEW</span></span>' +
        '<span id="badge-pseudo" class="compact-badge"><span>NEW</span></span>' +
        '<span id="badge-split" class="compact-badge"><i id="badge-decoration"></i><span>NEW</span></span>' +
        '<span id="badge-count" class="compact-badge" style="width:20px;height:20px;background:#ff4652;border-radius:50%">1</span>' +
        '<span id="badge-plain" style="color:white">Text</span>' +
        '<svg id="badge-icon" width="24" height="24" style="border:1px solid white"><rect width="20" height="20" fill="white"/></svg>';
      document.body.append(panel);
    })()`);
    await e2e.beginPicker(mainPage);
    const panel = "document.getElementById('badge-panel')";
    const ids = ['badge-solid', 'badge-pseudo', 'badge-split', 'badge-count'];
    for (const id of ids) {
      const badge = `document.getElementById('${id}')`;
      const label = `(${badge}).querySelector('span') || (${badge})`;
      await e2e.hover(mainPage, label);
      await waitHighlightRect(mainPage, await rectFor(mainPage, panel), "默认保留较大区块", false);
      for (const modifier of ['Alt']) {
        await e2e.hover(mainPage, label, modifier);
        await waitHighlightRect(mainPage, await rectFor(mainPage, badge), "标签文字与装饰一起高亮");
        await keyChange(mainPage, modifier, "keyUp");
      }
      const rect = await rectFor(mainPage, badge);
      await e2e.hoverAt(mainPage, { x: rect.left + 3, y: rect.top + rect.height / 2 }, 'Alt');
      await waitHighlightRect(mainPage, rect, "点击标签边缘也选择同一个整体");
      await keyChange(mainPage, 'Alt', 'keyUp');
    }
    for (const id of ['badge-plain', 'badge-icon']) {
      await e2e.hover(mainPage, `document.getElementById('${id}')`, 'Alt');
      await waitHighlightRect(mainPage, await rectFor(mainPage, panel), "裸文字或图标仍向上选择区块");
      await keyChange(mainPage, 'Alt', 'keyUp');
    }
    await e2e.hover(mainPage, "document.querySelector('#badge-solid span')", 'Alt');
    await waitHighlightRect(mainPage, await rectFor(mainPage, "document.getElementById('badge-solid')"), "标签截图高亮完整贴合");
    await captureScreenshot(mainPage, artifactPath, 'compact-badge-highlight');
    await keyChange(mainPage, 'Alt', 'keyUp');
    for (const id of ids) {
      const badge = `document.getElementById('${id}')`;
      await e2e.select(mainPage, `(${badge}).querySelector('span') || (${badge})`, 'Alt');
      await waitFor(async () => evaluate(mainPage, `(${badge}).hasAttribute('data-annoy-killer-session-hidden')`), "隐藏的是整个标签容器");
      await waitVisible(mainPage, badge, false, "标签文字和边框全部隐藏");
      assert(await visible(mainPage, panel), "父级导航仍然可见");
    }
    await closePickerWithEscape(mainPage);
    for (const id of ids) await waitVisible(mainPage, `document.getElementById('${id}')`, false,
      "Escape 自动保存完整标签");
  });

  await run("视觉区块选择与单项隐藏", async () => {
    const url = await e2e.reset(mainPage, { sameClass: true, label: "visual-blocks" });
    await e2e.setStorage({ hiddenRulesBySite: {
      [new URL(url).origin]: [{ selector: ".bulk-card", classSignature: "bulk-card" }]
    }});
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, "document.querySelector('#bulk-card-one')", true, "旧同类规则不再生效");
    await evaluate(mainPage, `(() => {
      const outer = document.createElement('div');
      outer.id = 'visual-outer';
      outer.style.cssText = 'position:fixed;left:100px;top:180px;width:360px;height:200px;padding:24px;background:white;z-index:1000';
      outer.innerHTML = '<div id="visual-inner" style="width:240px;height:64px;padding:12px;background:lightblue"><span id="visual-text" style="display:inline-block;width:48px;height:24px">Text</span><svg id="visual-icon" width="24" height="24"><rect width="24" height="24"/></svg></div>';
      document.body.append(outer);
    })()`);
    await e2e.beginPicker(mainPage);
    for (const target of ['visual-text', 'visual-icon']) {
      await e2e.hover(mainPage, `document.getElementById('${target}')`);
      await waitHighlightRect(mainPage, await rectFor(mainPage, "document.getElementById('visual-outer')"), "默认选择完整大区块", false);
      for (const modifier of ['Alt']) {
        await e2e.hover(mainPage, `document.getElementById('${target}')`, modifier);
        await waitHighlightRect(mainPage, await rectFor(mainPage, "document.getElementById('visual-inner')"), "快捷键选择较小完整区块");
        await keyChange(mainPage, modifier, "keyUp");
      }
    }
    await closePickerWithEscape(mainPage);
    await evaluate(mainPage, "document.getElementById('visual-outer').remove()");
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#bulk-card-one .bulk-label')",
      STANDARD_SELECTION_MODIFIER);
    await waitVisible(mainPage, "document.querySelector('#bulk-card-one')", false, "点击卡片隐藏");
    await waitVisible(mainPage, "document.querySelector('#bulk-card-two')", true, "同类卡片保持可见");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, "document.querySelector('#bulk-card-one')", false, "单项规则刷新生效");
    await waitVisible(mainPage, "document.querySelector('#bulk-card-two')", true, "刷新不隐藏同类");
  });

  await run("真实 action、默认大块、页面事件抑制、Escape 自动保存", async () => {
    // This is intentionally the first action: the page existed before the extension was installed,
    // so background.js must exercise its executeScript fallback.
    await e2e.clearStorage();
    await e2e.setSameClass(false);
    await evaluate(mainPage, "window.__fixture.resetEvents()");
    const actionDuration = await e2e.beginPicker(mainPage);
    assert(actionDuration < UI_TIMEOUT, "真实 action 调用耗时异常");

    const hovered = await e2e.hover(mainPage,
      "document.querySelector('#bulk-card-one .bulk-label')");
    const rowRect = await rectFor(mainPage, "document.querySelector('.bulk-row')");
    await waitHighlightRect(mainPage, rowRect, "默认选区扩大到完整模块", false);
    await e2e.pressSelection(mainPage, hovered);
    await waitVisible(mainPage, "document.querySelector('#bulk-card-one')", false, "第一张卡片");
    assert.equal(await visible(mainPage, "document.querySelector('#bulk-card-two')"), false,
      "默认最大范围应同时隐藏完整模块内的第二张卡片");
    assert.match(await toolbarCount(mainPage), /1\s*个项目已隐藏/,
      "工具栏应显示一个已隐藏项目");
    assert.equal(totalEventCount(await eventState(mainPage)), 0,
      "选择事件不应冒泡到网页");

    await closePickerWithEscape(mainPage);
    await waitFor(async () => evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), "Escape 关闭界面");
    await waitVisible(mainPage, "document.querySelector('#bulk-card-one')", false, "Escape 保存后的第一张卡片");
    await waitVisible(mainPage, "document.querySelector('#bulk-card-two')", false, "Escape 保存后的第二张卡片");
    const storage = await e2e.getStorage(["hiddenRulesByPage", "hiddenRulesBySite"]);
    assert.equal(Object.values(storage.hiddenRulesByPage || {}).flat().length, 1, "Escape 应保存页面规则");
    assert.equal(Object.values(storage.hiddenRulesBySite || {}).flat().length, 0,
      "默认页面范围不应写入网站规则");
  });

  await run("Escape 自动保存与刷新持久化", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "escape" });
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#unique-target')", "Alt");
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "待撤销唯一目标");
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await waitFor(async () => evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), "Escape 关闭界面");
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "Escape 自动保存后刷新保持隐藏");
  });

  await run("点击隐藏后不退出也立即保存", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "autosave-hide" });
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#unique-target')", "Alt");
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "点击隐藏后立即隐藏");
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false,
      "未按完成或快捷键时刷新仍保持隐藏");
  });

  await run("点击显示后不退出也立即保存", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "autosave-show" });
    const target = "document.querySelector('#unique-target')";
    const saved = await evaluate(e2e.optionsPage, `chrome.runtime.sendMessage({
      type: 'annoy-killer:commit-rules',
      pageKey: ${JSON.stringify(pageKey(url))},
      siteKey: ${JSON.stringify(e2e.primaryOrigin)},
      pageRules: [{ selector: '#unique-target' }]
    })`);
    assert.equal(saved.ok, true);
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, false, "刷新后先应用历史隐藏");

    await e2e.beginPicker(mainPage);
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await waitVisible(mainPage, target, true, "显示已隐藏项目");
    const mask = await hiddenPreviewMaskState(mainPage, target);
    await dispatchMouseClick(mainPage, mask.center);
    await waitFor(async () => {
      const storage = await e2e.getStorage(["hiddenRulesByPage"]);
      return (storage.hiddenRulesByPage?.[pageKey(url)] || []).length === 0;
    }, "点击显示后立即移除页面规则", STORAGE_TIMEOUT);
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, true,
      "未按完成或快捷键时刷新仍保持显示");
  });

  await run("隐藏后立即显示不受晚到提交响应污染", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "late-hide-show" });
    const scope = pageKey(url);
    const target = "document.querySelector('#unique-target')";
    await e2e.installFirstCommitResponseDelay(mainPage);
    try {
      await e2e.beginPicker(mainPage, { preview: true });
      await e2e.select(mainPage, target, "Alt");
      const mask = await hiddenPreviewMaskState(mainPage, target);
      await waitFor(async () => (await e2e.commitResponseDelayState(mainPage))?.firstIntercepted,
        "首个隐藏提交响应进入延迟探针", STORAGE_TIMEOUT);

      await dispatchMouseClick(mainPage, mask.center);
      await waitFor(async () => (await toolbarCount(mainPage)) === "0个项目已隐藏",
        "立即显示后计数归零");
      await waitFor(async () => evaluate(mainPage, `(() => {
        const node = ${target};
        return !node.hasAttribute("data-annoy-killer-session-hidden") &&
          !node.hasAttribute("data-annoy-killer-persistent-hidden") &&
          getComputedStyle(node).display !== "none";
      })()`), "立即显示后移除全部隐藏状态");
      await evaluate(mainPage, `(() => {
        const node = ${target};
        window.__lateHideShowProbe = { staleHide: false };
        new MutationObserver(() => {
          if (node.hasAttribute("data-annoy-killer-session-hidden") ||
              node.hasAttribute("data-annoy-killer-persistent-hidden") ||
              getComputedStyle(node).display === "none") {
            window.__lateHideShowProbe.staleHide = true;
          }
        }).observe(node, { attributes: true, attributeFilter: [
          "style", "data-annoy-killer-session-hidden", "data-annoy-killer-persistent-hidden"
        ] });
      })()`);

      await e2e.forwardFirstCommit(mainPage);
      await waitFor(async () => (await e2e.commitResponseDelayState(mainPage))?.firstForwarded,
        "首个隐藏提交已保存但响应保持延迟", STORAGE_TIMEOUT);
      await sleep(150);
      assert.equal(await evaluate(mainPage, "window.__lateHideShowProbe.staleHide"), false,
        "首个隐藏提交写入存储后不能重新隐藏已显示项目");
      await e2e.releaseFirstCommitResponse(mainPage);
      await waitFor(async () => (await e2e.commitResponseDelayState(mainPage))?.commitCalls >= 2,
        "显示操作排队提交删除规则", STORAGE_TIMEOUT);
      await waitFor(async () => {
        const stored = await e2e.getStorage(["hiddenRulesByPage"]);
        return !(stored.hiddenRulesByPage?.[scope]?.length);
      }, "晚到隐藏响应后仍清除页面规则", STORAGE_TIMEOUT);
      await sleep(350);
      assert.equal(await evaluate(mainPage, "window.__lateHideShowProbe.staleHide"), false,
        "晚到的首个隐藏响应不能重新隐藏已显示项目");
      assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
      await clickClosedShadowButton(mainPage, "完成");
      await e2e.restoreCommitResponseDelay(mainPage);

      await e2e.navigate(mainPage, url);
      await waitVisible(mainPage, target, true, "立即显示竞态刷新结果");
      await e2e.beginPicker(mainPage);
      assert.equal(await toolbarCount(mainPage), "0个项目已隐藏",
        "立即显示竞态刷新后计数必须为零");
      await clickClosedShadowButton(mainPage, "完成");
    } finally {
      await e2e.releaseFirstCommitResponse(mainPage).catch(() => undefined);
      await e2e.restoreCommitResponseDelay(mainPage);
    }
  });

  await run("隐藏后立即重置完成不受晚到提交响应污染", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "late-hide-reset-done" });
    const scope = pageKey(url);
    const target = "document.querySelector('#unique-target')";
    await e2e.installFirstCommitResponseDelay(mainPage);
    try {
      await e2e.beginPicker(mainPage);
      await e2e.select(mainPage, target, "Alt");
      await waitVisible(mainPage, target, false, "立即重置前的隐藏项目");
      await waitFor(async () => (await e2e.commitResponseDelayState(mainPage))?.firstIntercepted,
        "重置竞态首个隐藏提交响应进入延迟探针", STORAGE_TIMEOUT);

      await clickClosedShadowButton(mainPage, "重置");
      await clickClosedShadowButton(mainPage, "完成");
      await e2e.forwardFirstCommit(mainPage);
      await waitFor(async () => (await e2e.commitResponseDelayState(mainPage))?.firstForwarded,
        "重置竞态首个隐藏提交已保存但响应保持延迟", STORAGE_TIMEOUT);
      await e2e.releaseFirstCommitResponse(mainPage);
      await waitFor(async () => evaluate(mainPage,
        "!document.querySelector('[data-annoy-killer-ui]')"), "重置后立即完成关闭界面", STORAGE_TIMEOUT);
      await waitFor(async () => {
        const stored = await e2e.getStorage(["hiddenRulesByPage"]);
        return !(stored.hiddenRulesByPage?.[scope]?.length);
      }, "重置完成删除首个隐藏提交写入的规则", STORAGE_TIMEOUT);
      await waitVisible(mainPage, target, true, "重置完成后项目保持显示");
      await evaluate(mainPage, `(() => {
        const node = ${target};
        window.__lateResetDoneProbe = { staleHide: false };
        new MutationObserver(() => {
          if (node.hasAttribute("data-annoy-killer-session-hidden") ||
              node.hasAttribute("data-annoy-killer-persistent-hidden") ||
              getComputedStyle(node).display === "none") {
            window.__lateResetDoneProbe.staleHide = true;
          }
        }).observe(node, { attributes: true, attributeFilter: [
          "style", "data-annoy-killer-session-hidden", "data-annoy-killer-persistent-hidden"
        ] });
      })()`);

      await sleep(350);
      const afterRelease = await e2e.getStorage(["hiddenRulesByPage"]);
      assert.equal(afterRelease.hiddenRulesByPage?.[scope]?.length || 0, 0,
        "晚到的首个隐藏响应不能恢复已重置规则");
      assert.equal(await evaluate(mainPage, "window.__lateResetDoneProbe.staleHide"), false,
        "完成后晚到的隐藏响应不能重新标记项目");
      await e2e.restoreCommitResponseDelay(mainPage);

      await e2e.navigate(mainPage, url);
      await waitVisible(mainPage, target, true, "重置完成竞态刷新结果");
      await e2e.beginPicker(mainPage);
      assert.equal(await toolbarCount(mainPage), "0个项目已隐藏",
        "重置完成竞态刷新后计数必须为零");
      await clickClosedShadowButton(mainPage, "完成");
    } finally {
      await e2e.releaseFirstCommitResponse(mainPage).catch(() => undefined);
      await e2e.restoreCommitResponseDelay(mainPage);
    }
  });

  await run("工具栏任意位置拖动且不误触按钮", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "toolbar-drag" });
    await e2e.beginPicker(mainPage);
    const node = await findPiercedNode(mainPage, ({ node }) => hasClass(node, "toolbar"), "工具栏");
    const read = (selector) => callOnNode(mainPage, node, `function (selector) {
      const rect = this.getBoundingClientRect();
      const target = selector ? this.querySelector(selector).getBoundingClientRect() : rect;
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        x: selector ? target.x + target.width / 2 : rect.left + 2,
        y: target.y + target.height / 2,
        preview: this.querySelector('.hidden-toggle').getAttribute('aria-pressed'),
        reset: this.querySelector('.restore-all').getAttribute('aria-pressed') };
    }`, [selector]);
    const drag = async (start, dx, dy) => {
      await mainPage.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y });
      await mainPage.send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y,
        button: "left", clickCount: 1 });
      await mainPage.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + dx,
        y: start.y + dy, button: "left", buttons: 1 });
      await mainPage.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: start.x + dx,
        y: start.y + dy, button: "left", clickCount: 1 });
    };
    for (const selector of ["", ".count", ".hidden-toggle svg", ".restore-all .button-label", ".done .button-label"]) {
      const before = await read(selector);
      await drag(before, 30, 65);
      const after = await read(selector);
      assert.equal(after.left, before.left + 30, selector);
      assert.equal(after.top, before.top + 65, selector);
      assert.equal(after.preview, "false", "拖动不能触发显示按钮");
      assert.equal(after.reset, "false", "拖动不能触发重置按钮");
    }
    await drag(await read(".count"), -1100, -800);
    const edge = await read(".count");
    assert.equal(edge.left, 0);
    assert.equal(edge.top, 0);
    await dispatchMouseClick(mainPage, await read(".hidden-toggle .button-label"));
    assert.equal((await read(".count")).preview, "true", "拖动后正常点击仍有效");
    await dispatchMouseClick(mainPage, await read(".done .button-label"));
    await waitFor(async () => evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), "正常点击完成关闭面板");
  });

  await run("工具栏按钮右侧文案、状态切换与窄屏布局", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "toolbar-labels" });
    const target = "document.querySelector('#unique-target')";
    const readButtons = async () => {
      const node = await findPiercedNode(mainPage, ({ node: candidate }) =>
        hasClass(candidate, "toolbar"), "工具栏");
      return callOnNode(mainPage, node, `function () {
        return [...this.querySelectorAll("button")].map(button => {
          const rect = button.getBoundingClientRect();
          const label = button.querySelector(".button-label");
          const labelRect = label.getBoundingClientRect();
          const icon = [...button.querySelectorAll("svg")].find(svg =>
            getComputedStyle(svg).display !== "none");
          const iconRect = icon.getBoundingClientRect();
          const point = { x: (labelRect.left + labelRect.right) / 2,
            y: (labelRect.top + labelRect.bottom) / 2 };
          return { text: label.textContent, point,
            rightOfIcon: labelRect.left >= iconRect.right,
            sameRow: Math.abs((labelRect.top + labelRect.bottom) / 2 -
              (iconRect.top + iconRect.bottom) / 2) < 1,
            inViewport: rect.left >= 0 && rect.right <= innerWidth,
            hit: button.contains(this.getRootNode().elementFromPoint(point.x, point.y)) };
        });
      }`);
    };
    const assertLayout = (buttons, firstLabel = "显示") => {
      assert.deepEqual(buttons.map(button => button.text), [firstLabel, "重置", "完成"]);
      for (const button of buttons) {
        assert(button.rightOfIcon && button.sameRow && button.inViewport && button.hit,
          `图标右侧文案应可见且可点击：${JSON.stringify(button)}`);
      }
    };
    await e2e.beginPicker(mainPage);
    assertLayout(await readButtons());
    const toolbar = await findPiercedNode(mainPage, ({ node }) => hasClass(node, "toolbar"), "工具栏");
    const appearance = await callOnNode(mainPage, toolbar, `function () {
      const style = getComputedStyle(this);
      return {
        radius: style.borderRadius, background: style.backgroundColor,
        blur: style.backdropFilter,
        buttons: [...this.querySelectorAll("button")].map(button => getComputedStyle(button).borderRadius)
      };
    }`);
    assert.equal(appearance.radius, "999px", "面板应使用胶囊大圆角");
    assert(appearance.buttons.every(radius => radius === "999px"), "面板内每个按钮都应使用大圆角");
    assert.equal(appearance.background, "rgba(8, 8, 12, 0.42)", "面板底色不能盖住玻璃透色");
    assert.match(appearance.blur, /blur\(18px\)/, "面板应保留毛玻璃背景模糊");
    const longCountLayout = await callOnNode(mainPage, toolbar, `function () {
      const count = this.querySelector('.count');
      const original = count.textContent;
      const before = this.getBoundingClientRect();
      count.textContent = '已隐藏 12345678901234567890 个项目';
      const after = this.getBoundingClientRect();
      const result = { beforeWidth: before.width, afterWidth: after.width,
        left: after.left, right: after.right, viewportWidth: innerWidth,
        countClientWidth: count.clientWidth, countScrollWidth: count.scrollWidth };
      count.textContent = original;
      return result;
    }`);
    assert(longCountLayout.afterWidth > longCountLayout.beforeWidth,
      `隐藏数量变长时工具栏应随内容拉长：${JSON.stringify(longCountLayout)}`);
    assert(longCountLayout.left >= 0 && longCountLayout.right <= longCountLayout.viewportWidth,
      `拉长后的工具栏不能超出视口：${JSON.stringify(longCountLayout)}`);
    assert.equal(longCountLayout.countClientWidth, longCountLayout.countScrollWidth,
      `长数字不能在计数区域内被截断：${JSON.stringify(longCountLayout)}`);
    await captureScreenshot(mainPage, artifactPath, "toolbar-button-labels");
    await dispatchMouseClick(mainPage, (await readButtons())[0].point);
    assertLayout(await readButtons(), "隐藏");
    await dispatchMouseClick(mainPage, (await readButtons())[0].point);
    assertLayout(await readButtons());
    try {
      for (const width of [480, 440, 375, 320]) {
        await mainPage.send("Emulation.setDeviceMetricsOverride", {
          width, height: 900, deviceScaleFactor: 1, mobile: false
        });
        assertLayout(await readButtons());
        const narrowToolbar = await callOnNode(mainPage, toolbar, `function () {
          const rect = this.getBoundingClientRect();
          return { radius: getComputedStyle(this).borderRadius,
            left: rect.left, right: rect.right, width: rect.width, viewportWidth: innerWidth };
        }`);
        assert.equal(narrowToolbar.radius, "24px", "窄屏工具栏外框应为圆角矩形");
        assert(narrowToolbar.left >= 0 && narrowToolbar.right <= narrowToolbar.viewportWidth,
          `窄屏圆角矩形不能超出视口：${JSON.stringify(narrowToolbar)}`);
      }
      await captureScreenshot(mainPage, artifactPath, "toolbar-button-labels-narrow");
    } finally {
      await mainPage.send("Emulation.setDeviceMetricsOverride", {
        width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
      });
    }
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "恢复文字点击前隐藏目标");
    await dispatchMouseClick(mainPage, (await readButtons())[1].point);
    await waitVisible(mainPage, target, true, "点击恢复文字恢复目标");
    await closePickerWithEscape(mainPage);
    await waitFor(async () => evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), "Escape 关闭界面");
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "完成文字点击前隐藏目标");
    await dispatchMouseClick(mainPage, (await readButtons())[2].point);
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, false, "点击完成文字保存规则");
  });

  await run("工具栏毛玻璃真实后景模糊与透色", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "toolbar-glass" });
    await e2e.beginPicker(mainPage);
    await evaluate(mainPage, `(() => {
      const backdrop = document.createElement("div");
      backdrop.id = "glass-test-backdrop";
      backdrop.style.cssText = "position:fixed;inset:0 0 auto;height:130px;pointer-events:none;background:repeating-linear-gradient(90deg,#000 0 8px,#fff 8px 16px)";
      document.body.append(backdrop);
    })()`);
    const toolbar = await findPiercedNode(mainPage, ({ node }) => hasClass(node, "toolbar"), "工具栏");
    const rect = await nodeBox(mainPage, toolbar);
    const sample = async () => {
      const screenshot = await mainPage.send("Page.captureScreenshot", { format: "png" });
      return evaluate(mainPage, `(async () => {
        const image = new Image();
        image.src = "data:image/png;base64," + ${JSON.stringify(screenshot.data)};
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(${Math.round(rect.left + 35)}, ${Math.round(rect.bottom - 7)},
          ${Math.round(rect.right - rect.left - 70)}, 1).data;
        const values = [];
        for (let i = 0; i < data.length; i += 4) values.push((data[i]+data[i+1]+data[i+2])/3);
        const mean = values.reduce((a,b) => a+b, 0)/values.length;
        return { mean, deviation: Math.sqrt(values.reduce((a,b) => a+(b-mean)**2,0)/values.length) };
      })()`);
    };
    const frosted = await sample();
    await callOnNode(mainPage, toolbar, `function () { this.style.backdropFilter = "none"; }`);
    const unfiltered = await sample();
    assert(frosted.deviation < unfiltered.deviation * 0.35,
      `必须实际模糊背后条纹，不只是声明 CSS：${JSON.stringify({ frosted, unfiltered })}`);
    assert(unfiltered.deviation > 30, "底色需要足够透明才能看见后景变化");
    await callOnNode(mainPage, toolbar, `function () { this.style.removeProperty("backdrop-filter"); }`);
    await evaluate(mainPage, `document.querySelector('#glass-test-backdrop').style.background =
      'repeating-linear-gradient(90deg,transparent 0 5px,#ffffff66 5px 10px),linear-gradient(90deg,#e5484d,#e5a13d,#38bdb3,#526fe9)'`);
    await captureScreenshot(mainPage, artifactPath, "toolbar-frosted-color-backdrop");
    const warm = await sample();
    await evaluate(mainPage, `document.querySelector('#glass-test-backdrop').style.background = '#ffffff'`);
    const light = await sample();
    assert(Math.abs(warm.mean - light.mean) > 6, "毛玻璃应随背景颜色发生变化");
    console.log(`METRIC glass stripeDeviation=${frosted.deviation.toFixed(1)} unfiltered=${unfiltered.deviation.toFixed(1)}`);
    await evaluate(mainPage, "document.querySelector('#glass-test-backdrop').remove()");
    const imageRect = await rectFor(mainPage, "document.querySelector('#particle-target')");
    await callOnNode(mainPage, toolbar, `function (top) { this.style.top = top + "px"; }`,
      [(imageRect.top + imageRect.bottom) / 2 - 22]);
    await captureScreenshot(mainPage, artifactPath, "toolbar-frosted-on-image");
    await closePickerWithEscape(mainPage);
  });

  await run("预览隐藏不临时折叠且动态页面不连带隐藏邻项", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "preview-stability" });
    await evaluate(mainPage, `(() => {
      const host = document.createElement("section");
      host.className = "preview-stability-host";
      host.style.cssText = "display:grid;gap:12px;width:520px;margin:24px;padding:12px";
      const target = document.createElement("div");
      target.className = "preview-stability-card";
      target.dataset.previewStability = "target";
      target.textContent = "selected-original-content";
      target.style.cssText = "display:grid;width:480px;height:120px;padding:12px;background:#fee";
      const sibling = document.createElement("div");
      sibling.className = "preview-stability-card";
      sibling.dataset.previewStability = "sibling";
      sibling.textContent = "unrelated-neighbour-content";
      sibling.style.cssText = "display:grid;width:480px;height:120px;padding:12px;background:#eef";
      host.append(target, sibling);
      document.body.prepend(host);
      const transientDisplayNone = [];
      let reordered = false;
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === "style" && /display:\\s*none/i.test(record.oldValue || "")) {
            transientDisplayNone.push(record.oldValue);
          }
        }
        if (!reordered && target.hasAttribute("data-annoy-killer-session-hidden")) {
          reordered = true;
          target.textContent = "selected-content-changed-after-click";
          host.insertBefore(sibling, target);
        }
      }).observe(target, { attributes: true, attributeOldValue: true });
      window.__previewStability = { target, sibling, transientDisplayNone };
    })()`);
    const target = "document.querySelector('[data-preview-stability=target]')";
    await e2e.beginPicker(mainPage, { preview: true });
    await e2e.select(mainPage, target, "Alt");
    await hiddenPreviewMaskState(mainPage, target);
    await sleep(700);
    const state = await evaluate(mainPage, `(() => {
      const { target, sibling, transientDisplayNone } = window.__previewStability;
      const hidden = node => node.hasAttribute("data-annoy-killer-session-hidden") ||
        node.hasAttribute("data-annoy-killer-persistent-hidden");
      return {
        transientDisplayNone,
        targetHidden: hidden(target),
        siblingHidden: hidden(sibling),
        siblingDisplay: getComputedStyle(sibling).display
      };
    })()`);
    assert.deepEqual(state.transientDisplayNone, [],
      `预览选择不能先 display:none 再恢复：${JSON.stringify(state)}`);
    assert(state.targetHidden, "本次选中的目标必须保留隐藏标记");
    assert(!state.siblingHidden && state.siblingDisplay !== "none",
      `页面重排后不能把未选择的邻项一起隐藏：${JSON.stringify(state)}`);
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏");
    await closePickerWithEscape(mainPage);
  });

  await run("普通鼠标与已隐藏项目预览切换", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "hidden-preview" });
    const target = "document.querySelector('#unique-target')";
    await e2e.beginPicker(mainPage);
    const picker = await pickerLayerState(mainPage);
    assert.equal(picker.capture.cursor, "default", "选择模式应使用普通箭头鼠标");
    assert.deepEqual(await restoreAllButtonState(mainPage), { visible: true, disabled: true },
      "没有隐藏项时恢复按钮也应显示并置灰");

    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "预览前的会话隐藏目标");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await waitVisible(mainPage, target, true, "会话隐藏目标预览");
    const sessionPreview = await evaluate(mainPage, `(() => {
      const node = ${target};
      const style = getComputedStyle(node);
      return {
        session: node.hasAttribute("data-annoy-killer-session-hidden"),
        persistent: node.hasAttribute("data-annoy-killer-persistent-hidden"),
        opacity: Number(style.opacity),
        outlineStyle: style.outlineStyle
      };
    })()`);
    assert(sessionPreview.session && !sessionPreview.persistent,
      `会话预览必须保留隐藏标记：${JSON.stringify(sessionPreview)}`);
    assert(sessionPreview.opacity > 0 && sessionPreview.opacity < 0.6 &&
      sessionPreview.outlineStyle === "dashed",
    `会话预览必须显示半透明隐藏效果：${JSON.stringify(sessionPreview)}`);
    const sessionMask = await hiddenPreviewMaskState(mainPage, target);
    assert(sessionMask.icon && sessionMask.hitButton,
      `模块中心必须有可点击的闭眼图标：${JSON.stringify(sessionMask)}`);
    assert.equal(sessionMask.label, "恢复此隐藏项目");
    assert.equal(sessionMask.backdropFilter, "blur(10px) saturate(0.72)",
      "透明遮罩仍必须保留模糊效果");
    await dispatchMouseClick(mainPage, { x: sessionMask.left + 8, y: sessionMask.top + 8 });
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏",
      "点击遮罩空白处应恢复模块");
    await dispatchMouseClick(mainPage, { x: sessionMask.left + 8, y: sessionMask.top + 8 },
      MODIFIERS.Alt.mask);
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏", "再次点击同一模块应重新隐藏");
    await hiddenPreviewMaskState(mainPage, target);
    await captureScreenshot(mainPage, artifactPath, "hidden-module-eye-mask");

    await dispatchMouseClick(mainPage, sessionMask.center);
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏", "点击闭眼图标恢复本次隐藏项");
    await waitFor(async () => !(await piercedEntries(mainPage)).some(({ node }) =>
      hasClass(node, "hidden-preview-mask")), "单项恢复后移除遮罩");
    await e2e.select(mainPage, target, "Alt");
    await waitFor(async () => (await toolbarCount(mainPage)) === "1个项目已隐藏",
      "预览开启时重新隐藏模块");
    await hiddenPreviewMaskState(mainPage, target);

    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await waitVisible(mainPage, target, false, "关闭会话隐藏预览");
    assert(!(await piercedEntries(mainPage)).some(({ node }) =>
      hasClass(node, "hidden-preview-mask")), "关闭预览不能残留遮罩");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(url));

    await e2e.beginPicker(mainPage);
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏",
      "工具栏计数必须包含历史隐藏项目");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await waitVisible(mainPage, target, true, "持久隐藏目标预览");
    const persistentPreview = await evaluate(mainPage, `(() => {
      const node = ${target};
      const style = getComputedStyle(node);
      return {
        session: node.hasAttribute("data-annoy-killer-session-hidden"),
        persistent: node.hasAttribute("data-annoy-killer-persistent-hidden"),
        opacity: Number(style.opacity),
        outlineStyle: style.outlineStyle
      };
    })()`);
    assert(!persistentPreview.session && persistentPreview.persistent,
      `持久预览必须保留隐藏标记：${JSON.stringify(persistentPreview)}`);
    assert(persistentPreview.opacity > 0 && persistentPreview.opacity < 0.6 &&
      persistentPreview.outlineStyle === "dashed",
    `持久预览必须显示半透明隐藏效果：${JSON.stringify(persistentPreview)}`);

    await evaluate(mainPage, `(${target}).style.width = "440px"`);
    const persistentMask = await hiddenPreviewMaskState(mainPage, target);
    await dispatchMouseClick(mainPage, persistentMask.center);
    await waitFor(async () => evaluate(mainPage,
      `!(${target}).hasAttribute("data-annoy-killer-persistent-hidden")`),
    "点击单个预览项目恢复");
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏",
      "单项恢复后计数必须立即减少");
    await closePickerWithEscape(mainPage);
    await waitVisible(mainPage, target, true, "Escape 自动保存单项恢复");

    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, true, "确认后保持单项恢复");
    await waitFor(async () => {
      const stored = await e2e.getStorage(["hiddenRulesByPage"]);
      return !(stored.hiddenRulesByPage?.[pageKey(url)]?.length);
    }, "单项恢复持久化");
  });

  await run("重置恢复往返保留历史和本次隐藏且退出自动保存", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "reset-restore" });
    const history = "document.querySelector('#unique-target')";
    const pending = "document.querySelector('.fine-target')";
    const extra = "document.querySelector('#bulk-card-two')";
    const keys = ["hiddenRulesByPage", "hiddenRulesBySite", "visibleExceptionsByPage"];
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, history, "Alt");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, pending, "Alt");
    await waitVisible(mainPage, pending, false, "本次新增隐藏完成");
    assert.equal(await toolbarCount(mainPage), "2个项目已隐藏");
    await waitFor(async () => (await e2e.getStorage(keys))
      .hiddenRulesByPage?.[pageKey(url)]?.length === 2,
    "本次新增隐藏立即保存", STORAGE_TIMEOUT);
    const storedBeforeReset = await e2e.getStorage(keys);
    for (const preview of [false, true]) {
      if (preview) await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
      await clickClosedShadowButton(mainPage, "重置");
      assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
      assert.deepEqual(await restoreAllButtonState(mainPage), { visible: true, disabled: false },
        "重置后计数为零，恢复按钮也必须可用");
      await waitVisible(mainPage, history, true, "重置显示历史模块");
      await waitVisible(mainPage, pending, true, "重置显示本次隐藏模块");
      assert.deepEqual(await e2e.getStorage(keys), storedBeforeReset, "重置不能写入存储");
      await e2e.select(mainPage, "document.querySelector('#bulk-card-two .bulk-label')");
      await waitFor(async () => (await toolbarCount(mainPage)) === "1个项目已隐藏", "重置后的额外隐藏完成");
      assert.equal(await toolbarCount(mainPage), "1个项目已隐藏");
      await clickClosedShadowButton(mainPage, "恢复");
      assert.equal(await toolbarCount(mainPage), "2个项目已隐藏");
      assert(await evaluate(mainPage, `(${history}).hasAttribute("data-annoy-killer-persistent-hidden") &&
        (${pending}).hasAttribute("data-annoy-killer-session-hidden") &&
        !(${extra}).hasAttribute("data-annoy-killer-session-hidden")`),
      "恢复应精确回到重置前的历史和本次隐藏，不保留重置后的额外选择");
      await waitVisible(mainPage, extra, true, "恢复重置前原本可见模块");
      await waitVisible(mainPage, history, preview, "恢复保持当前预览开关");
      await waitVisible(mainPage, pending, preview, "恢复本次隐藏状态");
      assert.deepEqual(await e2e.getStorage(keys), storedBeforeReset, "恢复也不能写入存储");
      await clickClosedShadowButton(mainPage, "重置");
      await clickClosedShadowButton(mainPage, "恢复");
      assert.equal(await toolbarCount(mainPage), "2个项目已隐藏", "重复往返不能丢失快照");
    }
    await clickClosedShadowButton(mainPage, "完成");
    await waitFor(async () => (await e2e.getStorage(keys)).hiddenRulesByPage?.[pageKey(url)]?.length === 2,
      "完成后保存恢复的本次隐藏");
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, history, false, "恢复完成后历史规则仍有效");
    await waitVisible(mainPage, pending, false, "恢复完成后本次规则已保存");

    await e2e.beginPicker(mainPage);
    await clickClosedShadowButton(mainPage, "重置");
    await closePickerWithEscape(mainPage);
    await waitFor(async () => !(await e2e.getStorage(keys)).hiddenRulesByPage?.[pageKey(url)]?.length,
      "Escape 自动保存重置");
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, history, true, "重置完成后刷新保持初始页面");
    await waitVisible(mainPage, pending, true, "重置完成后所有模块保持显示");
  });

  await run("不同 page site 分组命中同一元素只计一个可操作单元", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "overlapping-rule-groups" });
    const target = "document.querySelector('#unique-target')";
    const companionA = "document.querySelector('#overlap-companion-a')";
    const companionB = "document.querySelector('#overlap-companion-b')";
    const unrelated = "document.querySelector('#bulk-card-one')";
    const sourcePageA = `${e2e.primaryOrigin}/source-a`;
    const sourcePageB = `${e2e.primaryOrigin}/source-b`;
    const sourceRulesA = [
      { selector: "#source-a-shared", component: "section#unique-target", group: "site-overlap-a" },
      { selector: "#source-a-companion", component: "section#overlap-companion-a", group: "site-overlap-a" }
    ];
    const sourceRulesB = [
      { selector: "#source-b-shared", component: "section#unique-target", group: "site-overlap-b" },
      { selector: "#source-b-companion", component: "section#overlap-companion-b", group: "site-overlap-b" }
    ];
    await e2e.setStorage({
      hiddenRulesByPage: {
        [sourcePageA]: sourceRulesA,
        [sourcePageB]: sourceRulesB
      }
    });
    await e2e.navigate(mainPage, url);
    await evaluate(mainPage, `(() => {
      for (const suffix of ['a', 'b']) {
        const node = document.createElement('section');
        node.id = 'overlap-companion-' + suffix;
        node.textContent = 'companion-' + suffix;
        node.style.cssText = 'display:block;width:420px;height:90px';
        document.body.append(node);
      }
    })()`);
    await Promise.all([
      waitVisible(mainPage, target, false, "两个同源分组共同隐藏共享目标"),
      waitVisible(mainPage, companionA, false, "第一个同源分组隐藏自己的伴随项"),
      waitVisible(mainPage, companionB, false, "第二个同源分组隐藏自己的伴随项")
    ]);
    await e2e.beginPicker(mainPage);
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏",
      "两个同源 group 必须经共享 DOM 合并成一个可操作单元");

    await e2e.select(mainPage, unrelated, "Alt");
    await waitFor(async () => (await toolbarCount(mainPage)) === "2个项目已隐藏",
      "隐藏无关当前页元素后计数增加一个");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    const unrelatedMask = await hiddenPreviewMaskState(mainPage, unrelated);
    await dispatchMouseClick(mainPage, unrelatedMask.center);
    await sleep(450);
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏",
      "无关规则自动保存响应不得冲掉同源分组计数");
    assert.equal(await evaluate(mainPage, `[${target}, ${companionA}, ${companionB}].every(node =>
      node.hasAttribute('data-annoy-killer-persistent-hidden'))`), true,
    "无关规则提交响应不得丢失同源分组成员");

    const sharedMask = await hiddenPreviewMaskState(mainPage, target);
    await dispatchMouseClick(mainPage, sharedMask.center);
    await waitFor(async () => (await toolbarCount(mainPage)) === "0个项目已隐藏",
      "显示重叠规则目标后计数归零");
    await Promise.all([
      waitVisible(mainPage, target, true, "一次显示恢复共享目标"),
      waitVisible(mainPage, companionA, true, "一次显示恢复第一个伴随项"),
      waitVisible(mainPage, companionB, true, "一次显示恢复第二个伴随项")
    ]);
    await clickClosedShadowButton(mainPage, "完成");
    const stored = await waitFor(async () => {
      const value = await e2e.getStorage(["hiddenRulesByPage", "visibleExceptionsByPage"]);
      const exceptions = value.visibleExceptionsByPage?.[pageKey(url)] || [];
      return exceptions.some(rule => rule.selector === "section#unique-target") ? value : null;
    }, "同源共享目标恢复例外持久化", STORAGE_TIMEOUT);
    assert.deepEqual(stored.hiddenRulesByPage?.[sourcePageA], sourceRulesA,
      "第一个来源页规则必须保持原样");
    assert.deepEqual(stored.hiddenRulesByPage?.[sourcePageB], sourceRulesB,
      "第二个来源页规则必须保持原样");

    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, true, "刷新后共享目标不被同源规则重新隐藏");
    await e2e.beginPicker(mainPage);
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏",
      "刷新后同源共享目标计数保持为零");
    await clickClosedShadowButton(mainPage, "完成");
  });

  await run("重置后新增隐藏再恢复必须严格回到重置前快照", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "reset-snapshot-autosave" });
    const history = "document.querySelector('#unique-target')";
    const extra = "document.querySelector('#bulk-card-two')";
    const keys = ["hiddenRulesByPage", "hiddenRulesBySite", "visibleExceptionsByPage"];
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, history, "Alt");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(url));
    const snapshot = await e2e.getStorage(keys);

    await e2e.beginPicker(mainPage);
    await clickClosedShadowButton(mainPage, "重置");
    await waitVisible(mainPage, history, true, "重置预览恢复历史目标");
    await e2e.select(mainPage, extra, "Alt");
    await waitVisible(mainPage, extra, false, "重置预览期间隐藏额外目标");
    await sleep(650);
    assert.deepEqual(await e2e.getStorage(keys), snapshot,
      "重置快照期间的额外隐藏不得被自动保存");
    await clickClosedShadowButton(mainPage, "恢复");
    await waitFor(async () => (await toolbarCount(mainPage)) === "1个项目已隐藏",
      "恢复重置快照后的计数");
    await waitVisible(mainPage, history, false, "恢复快照重新隐藏历史目标");
    await waitVisible(mainPage, extra, true, "恢复快照丢弃额外隐藏");
    await clickClosedShadowButton(mainPage, "完成");
    await waitFor(async () => {
      assert.deepEqual(await e2e.getStorage(keys), snapshot);
      return true;
    }, "完成后存储严格回到重置前快照", STORAGE_TIMEOUT);

    await e2e.navigate(mainPage, url);
    assert.deepEqual(await e2e.getStorage(keys), snapshot, "刷新后存储快照不得漂移");
    await waitVisible(mainPage, history, false, "刷新后历史目标保持隐藏");
    await waitVisible(mainPage, extra, true, "刷新后额外目标保持显示");
  });

  await run("恢复按钮常驻且可在关闭预览时恢复全部", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "restore-without-preview" });
    const target = "document.querySelector('#unique-target')";
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "不预览时本次隐藏项");
    assert.deepEqual(await restoreAllButtonState(mainPage), { visible: true, disabled: false });
    await clickClosedShadowButton(mainPage, "重置");
    await waitVisible(mainPage, target, true, "不预览时恢复本次隐藏项");
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "准备保存历史隐藏项");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.beginPicker(mainPage);
    assert.deepEqual(await restoreAllButtonState(mainPage), { visible: true, disabled: false });
    await clickClosedShadowButton(mainPage, "重置");
    await waitVisible(mainPage, target, true, "不预览时恢复历史隐藏项");
    await closePickerWithEscape(mainPage);
    await waitVisible(mainPage, target, true, "Escape 保存不预览恢复");
    await e2e.beginPicker(mainPage);
    assert.deepEqual(await restoreAllButtonState(mainPage), { visible: true, disabled: true },
      "自动保存恢复结果后重置按钮应禁用");
    await clickClosedShadowButton(mainPage, "完成");
    await waitFor(async () => {
      const stored = await e2e.getStorage(["hiddenRulesByPage"]);
      return !(stored.hiddenRulesByPage?.[pageKey(url)]?.length);
    }, "不预览恢复全部的结果持久化");
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, true, "不预览恢复全部后刷新保持显示");
  });

  await run("重置覆盖当前页面未显示的历史隐藏规则且刷新不自动保存", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "reset-hidden-missing" });
    const target = "document.querySelector('#unique-target')";
    const missingSelector = "#reset-missing-target";
    const keys = ["hiddenRulesByPage"];
    await e2e.setStorage({ hiddenRulesByPage: { [pageKey(url)]: [
      { selector: "#unique-target" },
      { selector: missingSelector }
    ] } });
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, false, "历史规则隐藏当前显示项目");
    await e2e.beginPicker(mainPage);
    await clickClosedShadowButton(mainPage, "重置");
    await waitVisible(mainPage, target, true, "重置恢复当前显示项目");
    assert.deepEqual((await e2e.getStorage(keys)).hiddenRulesByPage?.[pageKey(url)]?.map(rule => rule.selector),
      ["#unique-target", missingSelector], "仅点击重置并不会立即写入存储");
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, false, "重置后直接刷新不会保存重置");

    await e2e.beginPicker(mainPage);
    await clickClosedShadowButton(mainPage, "重置");
    await clickClosedShadowButton(mainPage, "完成");
    await waitFor(async () => !(await e2e.getStorage(keys)).hiddenRulesByPage?.[pageKey(url)]?.length,
      "完成后当前页面全部历史规则都被清除");
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, true, "完成后刷新保持重置结果");
  });

  await run("预览模块任意位置切换、内部按钮与拖动保护", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "whole-preview-toggle" });
    await evaluate(mainPage, `(() => {
      const node = document.querySelector('#unique-target');
      node.innerHTML = '<button id="preview-inner-button" style="width:110px;height:44px">内部按钮</button>';
      window.__previewInnerClicks = 0;
      node.querySelector('button').onclick = () => window.__previewInnerClicks++;
    })()`);
    const target = "document.querySelector('#unique-target')";
    await e2e.beginPicker(mainPage);
    const initialRect = await rectFor(mainPage, target);
    await dispatchMouseClick(mainPage, { x: initialRect.left + 12, y: initialRect.top + 12 }, MODIFIERS.Alt.mask);
    await waitVisible(mainPage, target, false, "隐藏整个带按钮的模块");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.beginPicker(mainPage);
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    const mask = await hiddenPreviewMaskState(mainPage, target);
    const corner = { x: mask.left + 12, y: mask.top + 12 };
    for (const type of ["mousePressed", "mouseReleased"]) {
      await mainPage.send("Input.dispatchMouseEvent", { type,
        x: corner.x, y: corner.y, button: "right", clickCount: 1 });
    }
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏", "右键不能切换模块");
    await mainPage.send("Input.dispatchMouseEvent", { type: "mousePressed",
      x: corner.x, y: corner.y, button: "left", clickCount: 1 });
    await mainPage.send("Input.dispatchMouseEvent", { type: "mouseMoved",
      x: corner.x + 32, y: corner.y, button: "left", buttons: 1 });
    await mainPage.send("Input.dispatchMouseEvent", { type: "mouseReleased",
      x: corner.x + 32, y: corner.y, button: "left", clickCount: 1 });
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏", "拖动不能误恢复模块");
    await dispatchMouseClick(mainPage, corner, MODIFIERS.Alt.mask);
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏", "点击角落恢复历史隐藏模块");
    await dispatchMouseClick(mainPage, corner);
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏", "淡出中也能再次点击隐藏");
    await dispatchMouseClick(mainPage, corner);
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
    await waitFor(async () => !(await piercedEntries(mainPage)).some(({ node }) =>
      hasClass(node, "hidden-preview-mask")), "恢复动画完成");
    await dispatchMouseClick(mainPage, centerOf(await rectFor(mainPage,
      "document.querySelector('#preview-inner-button')")), MODIFIERS.Alt.mask);
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏");
    assert(await evaluate(mainPage, `document.querySelector('#preview-inner-button')
      .hasAttribute("data-annoy-killer-session-hidden")`),
    "按住 Alt 点击内部按钮应隐藏较小的完整范围");
    assert.equal(await evaluate(mainPage, "window.__previewInnerClicks"), 0,
      "切换模块不能触发网页按钮");
    const finalMask = await hiddenPreviewMaskState(mainPage,
      "document.querySelector('#preview-inner-button')");
    await dispatchMouseClick(mainPage, { x: finalMask.right - 12, y: finalMask.bottom - 12 });
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
    await clickClosedShadowButton(mainPage, "完成");
    await waitFor(async () => !(await e2e.getStorage(["hiddenRulesByPage"]))
      .hiddenRulesByPage?.[pageKey(url)]?.length, "模块恢复结果已保存");
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, true, "刷新后保持恢复");
  });

  await run("附件闭眼图标、眼皮开合顺序与白色毛玻璃", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "reference-eye-motion" });
    const target = "document.querySelector('#unique-target')";
    const referenceSvg = await readFile(join(EXTENSION_PATH, "icons", "hidden.svg"), "utf8");
    const referencePath = referenceSvg.match(/<path d="([^"]+)"/)[1];
    await e2e.beginPicker(mainPage);
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    const toolbar = await findPiercedNode(mainPage, ({ node }) => hasClass(node, "toolbar"), "工具栏");
    const startProbe = () => callOnNode(mainPage, toolbar, `function () {
      const root = this.getRootNode();
      const ownerDocument = this.ownerDocument;
      const probe = { running: true, frames: [] };
      this.__eyeMotionProbe = probe;
      function sample() {
        const mask = root.querySelector(".hidden-preview-mask") ||
          ownerDocument.querySelector("[data-annoy-killer-preview-mask].hidden-preview-mask");
        probe.frames.push(mask ? { present: true, openness: Number(mask.dataset.eyeOpenness),
          opacity: Number(getComputedStyle(mask).opacity),
          contour: mask.querySelector(".eye-contour").getAttribute("d"),
          referenceOpacity: Number(mask.querySelector(".eye-reference").style.opacity),
          irisOpacity: Number(mask.querySelector(".eye-iris").style.opacity) } : { present: false });
        if (probe.running) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }`);
    const readProbe = () => callOnNode(mainPage, toolbar, `function () {
      this.__eyeMotionProbe.running = false;
      return this.__eyeMotionProbe.frames;
    }`);
    await startProbe();
    await e2e.select(mainPage, target, "Alt");
    const closed = await waitFor(async () => {
      const mask = await hiddenPreviewMaskState(mainPage, target);
      return mask.eyeOpenness === 0 ? mask : null;
    }, "睁眼逐渐闭合到附件形状");
    const closingFrames = (await readProbe()).filter(frame => frame.present);
    assert(closingFrames.some(frame => frame.openness === 1 && frame.opacity > 0.1),
      `隐藏时应先显示睁开的眼睛：${JSON.stringify(closingFrames.slice(0, 12))}`);
    assert(new Set(closingFrames.filter(frame => frame.openness > 0 && frame.openness < 1)
      .map(frame => frame.contour)).size >= 4, "眼皮曲线必须连续变化，不只是替换图标");
    assert.equal(closingFrames.at(-1).referenceOpacity, 1);
    assert.equal(closingFrames.at(-1).irisOpacity, 0);
    assert.equal(closed.referencePath, referencePath, "闭眼终态必须精确使用附件 path");
    assert.equal(closed.background, "rgba(0, 0, 0, 0)");
    assert.equal(closed.backdropFilter, "blur(10px) saturate(0.72)");
    assert.equal(closed.buttonBackground, "rgba(0, 0, 0, 0)");
    await captureScreenshot(mainPage, artifactPath, "reference-closed-eye-frosted");

    await startProbe();
    await dispatchMouseClick(mainPage, { x: closed.left + 12, y: closed.top + 12 });
    await waitFor(async () => !(await piercedEntries(mainPage)).some(({ node }) =>
      hasClass(node, "hidden-preview-mask")), "睁眼后快速淡出整个遮罩");
    const openingFrames = (await readProbe()).filter(frame => frame.present);
    assert(openingFrames.some(frame => frame.openness === 0), "恢复应从闭眼状态开始");
    assert(new Set(openingFrames.filter(frame => frame.openness > 0 && frame.openness < 1)
      .map(frame => frame.contour)).size >= 4, "恢复时眼皮曲线连续睁开");
    assert(openingFrames.some(frame => frame.openness === 1 && frame.irisOpacity === 1 &&
      frame.opacity > 0.95),
    `眼睛完全睁开时遮罩仍应可见：${JSON.stringify(openingFrames.slice(-12))}`);
    const fadingFrames = openingFrames.filter(frame => frame.opacity < 0.95);
    assert(fadingFrames.length > 0 && fadingFrames.every(frame => frame.openness === 1),
      "遮罩只能在眼睛完全睁开后淡出");
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");

    await mainPage.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }]
    });
    await e2e.select(mainPage, target, "Alt");
    assert.equal((await hiddenPreviewMaskState(mainPage, target)).eyeOpenness, 0,
      "减少动态效果模式直接使用附件闭眼终态");
    await clickClosedShadowButton(mainPage, "重置");
    await waitFor(async () => !(await piercedEntries(mainPage)).some(({ node }) =>
      hasClass(node, "hidden-preview-mask")), "减少动态效果模式直接移除遮罩");
    await closePickerWithEscape(mainPage);
    await mainPage.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
    });
  });

  await run("闭眼图标无圆底、平滑过渡与快速切换清理", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "preview-motion" });
    const target = "document.querySelector('#unique-target')";
    await evaluate(mainPage, `(() => {
      const node = ${target};
      node.style.opacity = "0.8";
      node.style.setProperty("transition-property", "color", "important");
      node.style.setProperty("transition-duration", "0.37s");
    })()`);
    const inlineState = () => evaluate(mainPage, `(() => {
      const style = (${target}).style;
      return ["opacity", "transition-property", "transition-duration",
        "transition-timing-function", "transition-delay", "transition-behavior"].map(name =>
        [name, style.getPropertyValue(name), style.getPropertyPriority(name)]);
    })()`);
    const original = await inlineState();
    const settle = async (opacity) => waitFor(async () => evaluate(mainPage,
      `Math.abs(Number(getComputedStyle(${target}).opacity) - ${opacity}) < 0.001 &&
        (${target}).style.getPropertyPriority("opacity") === ""`), "淡入淡出结束并清理样式");
    const probe = async () => evaluate(mainPage, `(() => {
      window.__previewMotionProbe = { samples: [], running: true };
      const probe = window.__previewMotionProbe;
      function sample() {
        const style = getComputedStyle(${target});
        probe.samples.push({ opacity: Number(style.opacity), display: style.display });
        if (probe.running) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })()`);
    const samples = async () => evaluate(mainPage, `(() => {
      window.__previewMotionProbe.running = false;
      return window.__previewMotionProbe.samples;
    })()`);
    const assertIntermediateFrames = (frames, min, max, rising) => {
      const values = frames.filter(frame => frame.display !== "none" &&
        frame.opacity > min + 0.001 && frame.opacity < max - 0.001).map(frame => frame.opacity);
      assert(new Set(values).size >= 3, `应有连续透明度动画帧：${JSON.stringify(frames)}`);
      assert(rising ? values.at(-1) > values[0] : values.at(-1) < values[0],
        `淡入/淡出方向应正确：${values}`);
    };
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "动画测试隐藏目标");
    await probe();
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await settle(0.42);
    assertIntermediateFrames(await samples(), 0, 0.42, true);
    const mask = await hiddenPreviewMaskState(mainPage, target);
    assert.equal(mask.buttonBackground, "rgba(0, 0, 0, 0)");
    assert.equal(mask.buttonShadow, "none");
    assert(["rgba(0, 0, 0, 0.3)", "rgba(255, 255, 255, 0.3)"].includes(mask.buttonColor),
      "眼睛必须根据背景使用黑色或白色");
    assert(mask.iris && mask.pupil, "眼睛图标必须包含完整虹膜和瞳孔");
    await mainPage.send("Input.dispatchMouseEvent", { type: "mouseMoved",
      x: mask.center.x, y: mask.center.y });
    assert.equal((await hiddenPreviewMaskState(mainPage, target)).buttonBackground,
      "rgba(0, 0, 0, 0)", "悬停时也不能出现圆底");
    await captureScreenshot(mainPage, artifactPath, "hidden-eye-no-circle");
    await probe();
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await waitVisible(mainPage, target, false, "淡出完成才收起预览");
    assertIntermediateFrames(await samples(), 0, 0.42, false);
    assert.deepEqual(await inlineState(), original);

    for (let index = 0; index < 5; index += 1) {
      await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    }
    await settle(0.42);
    await probe();
    await dispatchMouseClick(mainPage, (await hiddenPreviewMaskState(mainPage, target)).center);
    await settle(0.8);
    assertIntermediateFrames(await samples(), 0.42, 0.8, true);
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
    assert.deepEqual(await inlineState(), original);
    await waitFor(async () => !(await piercedEntries(mainPage)).some(({ node }) =>
      hasClass(node, "hidden-preview-mask")), "恢复后遮罩淡出并移除");

    await e2e.select(mainPage, target, "Alt");
    await settle(0.42);
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await clickClosedShadowButton(mainPage, "重置");
    await settle(0.8);
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
    assert.deepEqual(await inlineState(), original);

    await mainPage.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }]
    });
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "减少动态效果模式隐藏目标");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await settle(0.42);
    assert.deepEqual(await inlineState(), original);
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await waitVisible(mainPage, target, false, "减少动态效果模式立即关闭预览");
    await closePickerWithEscape(mainPage);
    assert.deepEqual(await inlineState(), original);
    await mainPage.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
    });
  });

  await run("闭眼图标粗描边、随模块缩放并限制上限", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "preview-eye-size" });
    await evaluate(mainPage, `(() => {
      const node = document.createElement("div");
      node.id = "eye-size-target";
      node.style.cssText = "position:fixed;left:80px;top:180px;width:240px;height:120px;background:#34363b;z-index:1000";
      document.body.append(node);
    })()`);
    const target = "document.querySelector('#eye-size-target')";
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "自适应图标目标隐藏");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    // Wait for entry motion so its scale does not affect the size/centering checks.
    await waitFor(async () => evaluate(mainPage,
      `(${target}).style.getPropertyPriority("opacity") === ""`), "预览淡入完成");
    for (const [width, height, expected] of [
      [240, 24, 12], [48, 48, 24], [160, 96, 48], [600, 300, 80], [900, 480, 80], [14, 10, 5]
    ]) {
      await evaluate(mainPage, `Object.assign((${target}).style, {
        width: "${width}px", height: "${height}px"
      })`);
      const mask = await hiddenPreviewMaskState(mainPage, target);
      assert.equal(mask.eyeSize, expected, `${width}×${height} 模块图标应为 ${expected}px`);
      assert.equal(mask.strokeWidth, 76.8, "睁眼描边应匹配附件的粗细");
      assert(["rgba(0, 0, 0, 0.3)", "rgba(255, 255, 255, 0.3)"].includes(mask.buttonColor),
        "眼睛必须根据背景使用黑色或白色");
      assert(mask.iris && mask.pupil, "缩放后保留眼球结构");
      assert.equal(mask.buttonBackground, "rgba(0, 0, 0, 0)");
      assert.equal(mask.buttonShadow, "none");
      assert(mask.buttonWidth >= mask.eyeSize && mask.buttonWidth <= Math.min(width, height),
        "透明点击区域应容纳图标但不能超出模块");
      assert(Math.abs(mask.center.x - (mask.left + mask.right) / 2) < 1 &&
        Math.abs(mask.center.y - (mask.top + mask.bottom) / 2) < 1 && mask.hitButton,
      "缩放后图标应保持居中并能点击");
    }
    await dispatchMouseClick(mainPage, (await hiddenPreviewMaskState(mainPage, target)).center);
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏", "极小模块也能点击图标恢复");
    await closePickerWithEscape(mainPage);
    await evaluate(mainPage, `(${target}).remove()`);
  });

  await run("闭眼遮罩覆盖 Shadow DOM、iframe 并跟随滚动裁切", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "preview-mask-boundaries" });
    for (const target of [
      `document.querySelector('#open-shadow-host').shadowRoot
        .querySelector('#nested-shadow-host').shadowRoot.querySelector('.nested-shadow-fine')`,
      "document.querySelector('#cross-origin-frame')"
    ]) {
      await e2e.beginPicker(mainPage);
      await e2e.select(mainPage, target, "Alt");
      await waitVisible(mainPage, target, false, "边界模块隐藏");
      await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
      const mask = await hiddenPreviewMaskState(mainPage, target);
      assert(mask.hitButton, `边界模块的闭眼按钮必须可点击：${JSON.stringify(mask)}`);
      await dispatchMouseClick(mainPage, mask.center);
      assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
      await closePickerWithEscape(mainPage);
    }

    await evaluate(mainPage, `(() => {
      const panel = document.createElement("div");
      panel.id = "preview-scroll-panel";
      panel.style.cssText = "position:fixed;left:100px;top:180px;width:360px;height:180px;overflow:auto;background:white;z-index:1000";
      panel.innerHTML = '<div style="height:120px"></div><div id="preview-scroll-target" style="height:140px;width:320px;background:coral"></div><div style="height:200px"></div>';
      document.body.append(panel);
    })()`);
    const target = "document.querySelector('#preview-scroll-target')";
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "滚动容器中的隐藏模块");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await hiddenPreviewMaskState(mainPage, target);
    await evaluate(mainPage, 'document.querySelector("#preview-scroll-panel").scrollTop = 160');
    await waitFor(async () => {
      const node = await findPiercedNode(mainPage, ({ node }) =>
        hasClass(node, "hidden-preview-mask"), "滚动中的遮罩");
      const box = await nodeBox(mainPage, node);
      const targetBox = await rectFor(mainPage, target);
      return Math.abs(box.top - targetBox.top) < 2 && Math.abs(box.bottom - targetBox.bottom) < 2;
    }, "锚点遮罩与滚动中的元素保持同帧位置");
    const clipping = await evaluate(mainPage, `(() => {
      const mask = document.querySelector("[data-annoy-killer-preview-mask]");
      const outside = document.elementFromPoint(260, 170);
      const inside = document.elementFromPoint(260, 230);
      const describe = element => element
        ? element.localName + "#" + (element.id || "") + "." + (element.className || "") +
          (element.hasAttribute("data-annoy-killer-ui") ? "[ui]" : "") +
          (element.hasAttribute("data-annoy-killer-preview-mask") ? "[mask]" : "")
        : null;
      const style = getComputedStyle(mask);
      const rect = mask.getBoundingClientRect();
      return {
        clipped: outside !== mask && mask.contains(inside),
        outside: describe(outside),
        inside: describe(inside),
        containsInside: mask.contains(inside),
        mask: {
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          position: style.position,
          zIndex: style.zIndex,
          parent: describe(mask.parentElement),
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom
        }
      };
    })()`);
    assert(clipping.clipped, `滚动容器在边界外裁掉蒙层：${JSON.stringify(clipping)}`);
    await dispatchMouseClick(mainPage, { x: 260, y: 230 });
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
    await closePickerWithEscape(mainPage);
    await evaluate(mainPage, 'document.querySelector("#preview-scroll-panel").remove()');

    await evaluate(mainPage, `(() => {
      const target = document.createElement("div");
      target.id = "preview-occluded-target";
      target.style.cssText = "position:fixed;left:120px;top:180px;width:420px;height:180px;background:linear-gradient(135deg,#e5f0ff,#fff7e5);z-index:10";
      const search = document.createElement("div");
      search.id = "preview-occluding-search";
      search.style.cssText = "position:fixed;left:100px;top:150px;width:460px;height:80px;background:white;border:2px solid #4b7bec;z-index:1000";
      document.body.append(target, search);
    })()`);
    const occludedTarget = "document.querySelector('#preview-occluded-target')";
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, occludedTarget, "Alt");
    await waitVisible(mainPage, occludedTarget, false, "被搜索栏遮住的隐藏模块");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    const occludedMask = await hiddenPreviewMaskState(mainPage, occludedTarget);
    assert(Math.abs(occludedMask.top - 180) < 2 && Math.abs(occludedMask.bottom - 360) < 2,
      `锚点遮罩保持在隐藏元素自身位置：${JSON.stringify(occludedMask)}`);
    assert(await evaluate(mainPage, `(() => {
      const search = document.querySelector("#preview-occluding-search");
      const mask = document.querySelector("[data-annoy-killer-preview-mask]");
      return document.elementFromPoint(330, 200) === search &&
        mask.contains(document.elementFromPoint(330, 295));
    })()`), "页面搜索栏按自身层级盖在蒙层上方");
    await dispatchMouseClick(mainPage, { x: 330, y: 295 });
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
    await closePickerWithEscape(mainPage);
    await evaluate(mainPage, `document.querySelector("#preview-occluding-search").remove();
      document.querySelector("#preview-occluded-target").remove()`);

    await evaluate(mainPage, `(() => {
      const panel = document.createElement("div");
      panel.id = "preview-fallback-panel";
      panel.style.cssText = "position:fixed;left:120px;top:0;width:420px;height:500px;overflow:auto;z-index:10";
      const spacer = document.createElement("div");
      spacer.style.height = "150px";
      const target = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      target.id = "preview-fallback-svg";
      target.setAttribute("viewBox", "0 0 420 180");
      target.style.cssText = "display:block;width:420px;height:180px;background:#e5f0ff";
      target.innerHTML = '<rect width="420" height="180" fill="#e5f0ff"/>';
      const tail = document.createElement("div");
      tail.style.height = "300px";
      panel.append(spacer, target, tail);
      const header = document.createElement("div");
      header.id = "preview-fallback-header";
      header.style.cssText = "position:fixed;left:100px;top:0;width:460px;height:112px;background:white;border-bottom:2px solid #4b7bec;z-index:2019";
      document.body.append(panel, header);
    })()`);
    const fallbackTarget = "document.querySelector('#preview-fallback-svg')";
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, fallbackTarget, "Alt");
    await waitVisible(mainPage, fallbackTarget, false, "固定回退蒙层中的隐藏模块");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await evaluate(mainPage, 'document.querySelector("#preview-fallback-panel").scrollTop = 78');
    await waitFor(async () => Math.abs(await evaluate(mainPage,
      'document.querySelector("#preview-fallback-panel").scrollTop') - 78) < 2,
      "页面滚动到固定浮层测试位置");
    await waitFor(async () => {
      const node = await findPiercedNode(mainPage, ({ node }) =>
        hasClass(node, "hidden-preview-mask"), "固定回退蒙层");
      const mask = await nodeBox(mainPage, node);
      return Math.abs(mask.top - 112) < 2 && Math.abs(mask.bottom - 252) < 2;
    }, "固定回退蒙层滚入页面浮层时裁掉重叠部分");
    await evaluate(mainPage, 'document.querySelector("#preview-fallback-panel").scrollTop = 110');
    await waitFor(async () => Math.abs(await evaluate(mainPage,
      'document.querySelector("#preview-fallback-panel").scrollTop') - 110) < 2,
      "页面继续向下滚动");
    await waitFor(async () => {
      const node = await findPiercedNode(mainPage, ({ node }) =>
        hasClass(node, "hidden-preview-mask"), "继续滚动的固定回退蒙层");
      const mask = await nodeBox(mainPage, node);
      return Math.abs(mask.top - 112) < 2 && Math.abs(mask.bottom - 220) < 2;
    }, "继续向下滚动时蒙层不越过页面浮层");
    await evaluate(mainPage, 'document.querySelector("#preview-fallback-panel").scrollTop = 0');
    await waitFor(async () => Math.abs(await evaluate(mainPage,
      'document.querySelector("#preview-fallback-panel").scrollTop')) < 2,
      "页面向上滚离固定浮层");
    let revealedMask;
    await waitFor(async () => {
      const node = await findPiercedNode(mainPage, ({ node }) =>
        hasClass(node, "hidden-preview-mask"), "向上滚离浮层的固定回退蒙层");
      revealedMask = await nodeBox(mainPage, node);
      return Math.abs(revealedMask.top - 150) < 2 && Math.abs(revealedMask.bottom - 330) < 2;
    }, "向上滚离浮层后蒙层恢复完整尺寸");
    await dispatchMouseClick(mainPage, centerOf(revealedMask));
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏");
    await closePickerWithEscape(mainPage);
    await evaluate(mainPage, `document.querySelector("#preview-fallback-header").remove();
      document.querySelector("#preview-fallback-panel").remove()`);
  });

  await run("恢复全部历史隐藏项目并更新总数", async () => {
    const url = await e2e.reset(mainPage, { sameClass: true, label: "restore-all-hidden" });
    const first = "document.querySelector('#bulk-card-one')";
    const second = "document.querySelector('#bulk-card-two')";
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#bulk-card-one .bulk-label')",
      STANDARD_SELECTION_MODIFIER);
    await waitVisible(mainPage, first, false, "等待第一项隐藏后再定位第二项");
    await e2e.select(mainPage, "document.querySelector('#bulk-card-two .bulk-label')",
      STANDARD_SELECTION_MODIFIER);
    await Promise.all([
      waitVisible(mainPage, first, false, "隐藏的第一个项目"),
      waitVisible(mainPage, second, false, "隐藏的第二个项目")
    ]);
    assert.equal(await toolbarCount(mainPage), "2个项目已隐藏");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(url));

    await e2e.beginPicker(mainPage);
    assert.equal(await toolbarCount(mainPage), "2个项目已隐藏",
      "重新进入时必须统计两个历史隐藏项目");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await Promise.all([
      waitVisible(mainPage, first, true, "恢复全部前的第一个预览项目"),
      waitVisible(mainPage, second, true, "恢复全部前的第二个预览项目")
    ]);
    await dispatchMouseClick(mainPage, centerOf(await rectFor(mainPage, first)));
    await waitFor(async () => evaluate(mainPage, `(() => {
      const first = ${first};
      const second = ${second};
      return !first.hasAttribute("data-annoy-killer-persistent-hidden") &&
        second.hasAttribute("data-annoy-killer-persistent-hidden");
    })()`), "同类规则中只恢复点击的单个项目");
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏",
      "同类规则单项恢复后只应减少一个项目");
    await closePickerWithEscape(mainPage);
    await Promise.all([
      waitVisible(mainPage, first, true, "Escape 保存单项恢复后的第一个项目"),
      waitVisible(mainPage, second, false, "Escape 保存单项恢复后的第二个项目")
    ]);

    await e2e.navigate(mainPage, url);
    await Promise.all([
      waitVisible(mainPage, first, true, "确认单项恢复后的第一个项目"),
      waitVisible(mainPage, second, false, "确认单项恢复后仍隐藏的第二个项目")
    ]);
    await waitFor(async () => {
      const stored = await e2e.getStorage(["hiddenRulesByPage"]);
      const rules = stored.hiddenRulesByPage?.[pageKey(url)] ?? [];
      return rules.length === 1 && rules[0].selector === "#bulk-card-two";
    }, "同类规则单项恢复持久化");
    await e2e.navigate(mainPage, url);
    await Promise.all([
      waitVisible(mainPage, first, true, "刷新后保留单项恢复"),
      waitVisible(mainPage, second, false, "刷新后另一项仍隐藏")
    ]);

    await e2e.beginPicker(mainPage);
    assert.equal(await toolbarCount(mainPage), "1个项目已隐藏",
      "单项恢复持久化后历史计数必须为一");
    await e2e.select(mainPage, "document.querySelector('#bulk-card-one .bulk-label')");
    await waitVisible(mainPage, first, false, "重新隐藏已单项恢复的项目");
    assert.equal(await toolbarCount(mainPage), "2个项目已隐藏");
    await closePickerWithEscape(mainPage);
    await Promise.all([
      waitVisible(mainPage, first, false, "Escape 自动保存重新隐藏"),
      waitVisible(mainPage, second, false, "Escape 保存后保留另一项目隐藏")
    ]);

    await e2e.beginPicker(mainPage);
    assert.equal(await toolbarCount(mainPage), "2个项目已隐藏");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await waitVisible(mainPage, second, true, "恢复全部前剩余的预览项目");
    await clickClosedShadowButton(mainPage, "重置");
    await waitFor(async () => evaluate(mainPage, `[
      ${first}, ${second}
    ].every((node) => !node.hasAttribute("data-annoy-killer-persistent-hidden"))`),
    "恢复全部隐藏项目");
    assert.equal(await toolbarCount(mainPage), "0个项目已隐藏",
      "全部恢复后计数必须归零");
    await clickClosedShadowButton(mainPage, "完成");
    await Promise.all([
      waitVisible(mainPage, first, true, "全部恢复后的第一个项目"),
      waitVisible(mainPage, second, true, "全部恢复后的第二个项目")
    ]);
    await waitFor(async () => {
      const stored = await e2e.getStorage([
        "hiddenRulesBySite",
        "visibleExceptionsByPage"
      ]);
      return !(stored.hiddenRulesBySite?.[new URL(url).origin]?.length) &&
        !(stored.visibleExceptionsByPage?.[pageKey(url)]?.length);
    }, "恢复全部持久化");
  });

  await run("默认隐藏且记住上次状态", async () => {
    const url = await e2e.reset(mainPage, { label: "preview-preference" });
    await e2e.removeStorage("hiddenPreviewEnabled");
    const target = "document.querySelector('#unique-target')";
    const assertPreview = async (enabled) => {
      const button = await findPiercedNode(mainPage, ({ node }) => hasClass(node, "hidden-toggle"), "显示隐藏按钮");
      assert.equal(await callOnNode(mainPage, button,
        "function () { return this.getAttribute('aria-pressed'); }"), String(enabled));
    };
    await e2e.beginPicker(mainPage, { preview: null });
    await assertPreview(false);
    await e2e.select(mainPage, target, STANDARD_SELECTION_MODIFIER);
    await waitVisible(mainPage, target, false, "默认隐藏新选项目");
    await closePickerWithEscape(mainPage);
    await e2e.waitStorageRule("page", pageKey(url));
    await waitVisible(mainPage, target, false, "关闭后隐藏仍生效");
    await e2e.beginPicker(mainPage, { preview: null });
    await assertPreview(false);
    await waitVisible(mainPage, target, false, "默认隐藏已保存项目");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await assertPreview(true);
    await hiddenPreviewMaskState(mainPage, target);
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await closePickerWithEscape(mainPage);
    await e2e.navigate(mainPage, url);
    await e2e.beginPicker(mainPage, { preview: null });
    await assertPreview(false);
    await waitVisible(mainPage, target, false, "刷新重开保留隐藏模式");
    await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
    await e2e.closeWithAction(mainPage);
    await e2e.navigate(mainPage, url);
    await e2e.beginPicker(mainPage, { preview: null });
    await assertPreview(true);
    await hiddenPreviewMaskState(mainPage, target);
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.navigate(mainPage, url);
    await e2e.beginPicker(mainPage, { preview: null });
    await assertPreview(true);
    await closePickerWithEscape(mainPage);
    assert.equal((await e2e.getStorage(["hiddenPreviewEnabled"])).hiddenPreviewEnabled, true,
      "内部关闭预览不能覆盖用户偏好");
  });

  await run("完成按钮、刷新持久化", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "done-button" });
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#unique-target')", STANDARD_SELECTION_MODIFIER);
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "完成按钮目标");
    await clickClosedShadowButton(mainPage, "完成");
    await waitFor(async () => evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), "完成按钮关闭界面", STORAGE_TIMEOUT);
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "刷新后唯一目标");
  });

  await run("Enter 完成、刷新持久化与空会话关闭", async () => {
    const url = await e2e.reset(mainPage, { label: "enter-done" });
    await evaluate(mainPage, `window.enterCount = 0;
      document.addEventListener('keydown', event => {
        if (event.key === 'Enter') window.enterCount++;
      });`);
    await e2e.beginPicker(mainPage);
    await evaluate(mainPage, `document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, isComposing: true
    }))`);
    assert.equal(await evaluate(mainPage,
      "!!document.querySelector('[data-annoy-killer-ui]')"), true,
      "输入法确认不得完成隐藏");
    await evaluate(mainPage, "window.enterCount = 0");
    await e2e.select(mainPage, "document.querySelector('#unique-target')", STANDARD_SELECTION_MODIFIER);
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
    await waitFor(async () => evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), "Enter 关闭界面", STORAGE_TIMEOUT);
    assert.equal(await evaluate(mainPage, "window.enterCount"), 0, "完成键不得触发网页操作");
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "Enter 完成后刷新保持隐藏");
    const stored = await e2e.getStorage(["hiddenRulesByPage"]);
    await e2e.beginPicker(mainPage);
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
    await waitFor(async () => evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), "Enter 关闭空会话", STORAGE_TIMEOUT);
    assert.deepEqual(await e2e.getStorage(["hiddenRulesByPage"]), stored);
  });

  await run("双击快捷键开关、误触防护与设置持久化", async () => {
    const url = await e2e.reset(mainPage, { label: "double-shortcut" });
    const defaultKey = process.platform === "darwin" ? "Meta" : "Control";
    const state = () => evaluate(mainPage, "!!document.querySelector('[data-annoy-killer-ui]')");
    const keyEvent = (key, type, extra = {}) => mainPage.send("Input.dispatchKeyEvent", {
      type, key, code: MODIFIERS[key]?.code || (key.length === 1 ? `Key${key.toUpperCase()}` : key),
      modifiers: type === "keyDown" ? MODIFIERS[key]?.mask || 0 : 0, ...extra
    });
    const tap = async key => { await keyEvent(key, "keyDown"); await keyEvent(key, "keyUp"); };
    const doubleTap = async key => { await tap(key); await tap(key); };
    await mainPage.send("Page.bringToFront");
    await tap(defaultKey);
    assert.equal(await state(), false, "单击不得打开");
    await sleep(450);
    await keyEvent(defaultKey, "keyDown");
    await keyEvent(defaultKey, "keyDown", { autoRepeat: true });
    await keyEvent(defaultKey, "keyUp");
    await tap(defaultKey);
    assert.equal(await state(), false, "长按重复不得打开");
    await sleep(450);
    await keyEvent(defaultKey, "keyDown");
    await keyEvent("c", "keyDown", { modifiers: MODIFIERS[defaultKey].mask });
    await keyEvent("c", "keyUp", { modifiers: MODIFIERS[defaultKey].mask });
    await keyEvent(defaultKey, "keyUp");
    await tap(defaultKey);
    assert.equal(await state(), false, "组合键后单击不得打开");
    await sleep(450);
    await doubleTap(defaultKey);
    await waitFor(state, "双击默认按键打开");
    await e2e.select(mainPage, "document.querySelector('#unique-target')", STANDARD_SELECTION_MODIFIER);
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "双击关闭前隐藏目标");
    await doubleTap(defaultKey);
    await waitFor(async () => !await state(), "再次双击关闭");
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "双击自动保存后刷新保持隐藏");
    const panel = await e2e.openPage(`chrome-extension://${e2e.extensionId}/options.html`, "选项");
    try {
      await waitFor(async () => evaluate(panel, "!document.querySelector('#shortcut-key').disabled"), "设置面板就绪");
      assert.equal(await evaluate(panel, "document.querySelector('#shortcut-key').value"), defaultKey);
      assert.equal(await evaluate(panel,
        "(() => { const style = getComputedStyle(document.querySelector('#shortcut-key')); return style.appearance === 'none' && style.paddingRight === '42px' && style.backgroundImage !== 'none'; })()"),
      true, "下拉箭头应使用向内留出间距的自定义样式");
      assert.equal(await evaluate(panel, "document.title"), "选项");
      assert.equal(await evaluate(panel, "document.querySelectorAll('.instructions li').length"), 6);
      assert.equal(await evaluate(panel, "document.querySelector('#toggle-key-label').textContent"),
        defaultKey === 'Meta' ? 'Command' : 'Control');
      const selectionHelp = await evaluate(panel,
        "document.querySelector('.instructions li:nth-child(2)').textContent");
    assert(selectionHelp.includes("可临时切换为网页鼠标点击状态") &&
      selectionHelp.includes("可缩小选择范围") && selectionHelp.includes("可进一步缩小范围") &&
      selectionHelp.includes("Shift"));
      assert(defaultKey === "Meta" ? selectionHelp.includes("Option") && !selectionHelp.includes("Alt") :
        selectionHelp.includes("Alt") && !selectionHelp.includes("Option"));
      assert(selectionHelp.includes(defaultKey === "Meta" ? "Command" : "Ctrl"));
      assert.equal(await evaluate(panel,
        "document.querySelector('.instructions li:nth-child(3)').textContent"),
      "按 ESC 或 Enter 键可以退出操作模式，隐藏元素自动保存。");
      await captureScreenshot(panel, artifactPath, "shortcut-settings");
      await panel.send("Emulation.setDeviceMetricsOverride", {
        width: 360, height: 900, deviceScaleFactor: 1, mobile: false
      });
      assert(await evaluate(panel, "document.documentElement.scrollWidth <= innerWidth"), "选项页窄屏无横向溢出");
      await captureScreenshot(panel, artifactPath, "options-narrow");
      await evaluate(panel, `(() => { const select = document.querySelector('#shortcut-key');
        select.value = 'q'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await waitFor(async () => (await e2e.getStorage(["toggleShortcutKey"])).toggleShortcutKey === "q", "保存自定义双击键");
      await waitFor(async () => evaluate(panel,
        "document.querySelector('#toggle-key-label').textContent === 'Q'"), "使用说明同步显示自定义按键");
      await mainPage.send("Page.bringToFront");
      await doubleTap(defaultKey);
      assert.equal(await state(), false, "修改后旧快捷键失效");
      await evaluate(mainPage, `const input = document.createElement('input');
        input.id = 'shortcut-input'; document.body.append(input); input.focus();`);
      await doubleTap("q");
      assert.equal(await state(), false, "输入框打字不得触发字母快捷键");
      await evaluate(mainPage, "document.querySelector('#shortcut-input').blur()");
      await doubleTap("q");
      await waitFor(state, "新按键立即生效");
      await doubleTap("q");
      await waitFor(async () => !await state(), "新按键再次关闭");
      await e2e.navigate(mainPage, url);
      await doubleTap("q");
      await waitFor(state, "刷新后自定义按键生效");
      await closePickerWithEscape(mainPage);
      await evaluate(panel, `(() => { const select = document.querySelector('#shortcut-key');
        select.value = ${JSON.stringify(defaultKey)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await waitFor(async () => (await e2e.getStorage(["toggleShortcutKey"])).toggleShortcutKey === defaultKey, "重新选择默认按键");
      await mainPage.send("Page.bringToFront");
      await doubleTap(defaultKey);
      await waitFor(state, "恢复默认后打开");
      await doubleTap(defaultKey);
      await waitFor(async () => !await state(), "恢复默认后关闭");
    } finally {
      await e2e.closePage(panel);
    }
  });

  await run("真实 action 再点自动保存且保留历史隐藏", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "action-close" });
    const target = "document.querySelector('#fine-panel > .fine-target')";
    const history = "document.querySelector('#unique-target')";
    const keys = ['hiddenRulesByPage', 'hiddenRulesBySite', 'visibleExceptionsByPage'];
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, history, STANDARD_SELECTION_MODIFIER);
    await waitVisible(mainPage, history, false, '已保存的历史项目');
    await clickClosedShadowButton(mainPage, '完成');
    await e2e.waitStorageRule('page', pageKey(url));
    const stored = await e2e.getStorage(keys);
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "本次待保存目标");
    await e2e.closeWithAction(mainPage);
    await waitVisible(mainPage, target, false, "再点插件自动保存本次隐藏");
    await waitVisible(mainPage, history, false, "保留历史隐藏");
    const saved = await e2e.getStorage(keys);
    assert.equal(saved.hiddenRulesByPage[pageKey(url)].length, stored.hiddenRulesByPage[pageKey(url)].length + 1, "关闭保存新增规则");
    await e2e.beginPicker(mainPage);
    await e2e.closeWithAction(mainPage);
    assert.deepEqual(await e2e.getStorage(keys), saved, "空会话可反复打开关闭");
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, target, false, "关闭后刷新保留本次目标");
    await waitVisible(mainPage, history, false, "刷新后历史规则仍生效");
  });

  await run("页面事件 pointer/click/contextmenu 全抑制", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "events" });
    await evaluate(mainPage, "window.__fixture.resetEvents()");
    await e2e.beginPicker(mainPage);
    const hovered = await e2e.hover(mainPage, "document.querySelector('#event-target')", STANDARD_SELECTION_MODIFIER);
    await e2e.pressSelection(mainPage, hovered);
    await waitVisible(mainPage, "document.querySelector('#event-target')", false, "事件目标");
    await mainPage.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: hovered.point.x, y: hovered.point.y,
      button: "right", clickCount: 1
    });
    await mainPage.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: hovered.point.x, y: hovered.point.y,
      button: "right", clickCount: 1
    });
    await sleep(100);
    const events = await eventState(mainPage);
    assert.deepEqual(events.counts,
      { pointerdown: 0, pointerup: 0, click: 0, contextmenu: 0 },
      `页面收到选择事件：${JSON.stringify(events)}`);
    await closePickerWithEscape(mainPage);
  });

  await run("inline display!important 会话隐藏、精确恢复与持久化停用", async () => {
    const target = "document.querySelector('#inline-important-target')";

    await e2e.reset(mainPage, { sameClass: false, label: "inline-important-cancel" });
    await evaluate(mainPage, "window.__fixture.restoreInlineImportantStyle()");
    const original = await inlineDisplayState(mainPage, target);
    assert.deepEqual(
      { value: original.value, priority: original.priority, computed: original.computed },
      { value: "block", priority: "important", computed: "block" },
      `inline 初始状态错误：${JSON.stringify(original)}`
    );

    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "inline important 会话目标");
    const sessionHidden = await inlineDisplayState(mainPage, target);
    assert.equal(sessionHidden.value, "none", "会话隐藏必须覆盖原 inline display");
    assert.equal(sessionHidden.priority, "important", "会话隐藏必须使用 important");
    assert(sessionHidden.session, "会话隐藏后必须存在 session 属性");
    assert.equal(sessionHidden.persistent, false, "完成前不应有 persistent 属性");

    await clickClosedShadowButton(mainPage, "重置");
    await closePickerWithEscape(mainPage);
    await waitFor(async () => evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), "inline important 重置后自动保存关闭");
    await waitVisible(mainPage, target, true, "inline important 取消恢复目标");
    const cancelled = await inlineDisplayState(mainPage, target);
    assert.deepEqual(
      { value: cancelled.value, priority: cancelled.priority, computed: cancelled.computed },
      { value: original.value, priority: original.priority, computed: original.computed },
      `取消未精确恢复 value+priority：${JSON.stringify({ original, cancelled })}`
    );
    assert.equal(cancelled.session, null, "取消后残留 session 属性");
    assert.equal(cancelled.persistent, false, "取消后残留 persistent 属性");
    const cancelledStorage = await e2e.getStorage(["hiddenRulesByPage", "hiddenRulesBySite"]);
    assert.deepEqual(cancelledStorage.hiddenRulesByPage || {}, {}, "取消不应写 page 规则");
    assert.deepEqual(cancelledStorage.hiddenRulesBySite || {}, {}, "取消不应写 site 规则");
    assert.deepEqual(await hiddenMarkerCounts(mainPage), { session: 0, persistent: 0 },
      "取消后页面不得残留隐藏标记");

    await evaluate(mainPage, "window.__fixture.setInlineImportantDisplay('inline-flex', '')");
    const sentinel = await inlineDisplayState(mainPage, target);
    assert.deepEqual(
      { value: sentinel.value, priority: sentinel.priority, computed: sentinel.computed },
      { value: "inline-flex", priority: "", computed: "inline-flex" },
      `非默认 inline sentinel 设置失败：${JSON.stringify(sentinel)}`
    );
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "非默认 inline sentinel 会话目标");
    await clickClosedShadowButton(mainPage, "重置");
    await closePickerWithEscape(mainPage);
    await waitVisible(mainPage, target, true, "非默认 inline sentinel 重置恢复");
    const sentinelRestored = await inlineDisplayState(mainPage, target);
    assert.deepEqual(
      {
        value: sentinelRestored.value,
        priority: sentinelRestored.priority,
        computed: sentinelRestored.computed
      },
      { value: sentinel.value, priority: sentinel.priority, computed: sentinel.computed },
      `取消逻辑疑似硬编码 block!important：${JSON.stringify({ sentinel, sentinelRestored })}`
    );
    assert.deepEqual(await hiddenMarkerCounts(mainPage), { session: 0, persistent: 0 },
      "sentinel 取消后页面不得残留隐藏标记");
    await evaluate(mainPage, "window.__fixture.restoreInlineImportantStyle()");

    const persistentUrl = await e2e.reset(mainPage, {
      sameClass: true,
      label: "inline-important-persistent"
    });
    await evaluate(mainPage, "window.__fixture.restoreInlineImportantStyle()");
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, "inline important 完成前目标");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(persistentUrl));
    await waitFor(async () => (await inlineDisplayState(mainPage, target)).persistent,
      "inline important persistent 属性");
    const committed = await inlineDisplayState(mainPage, target);
    assert.equal(committed.session, null, "完成后不应残留 session 属性");
    assert.deepEqual(
      { value: committed.value, priority: committed.priority, computed: committed.computed },
      { value: "none", priority: "important", computed: "none" },
      `完成后目标未持久隐藏：${JSON.stringify(committed)}`
    );

    await e2e.navigate(mainPage, persistentUrl);
    await waitVisible(mainPage, target, false, "inline important 刷新持久化");
    await e2e.clearStorage();
    await waitVisible(mainPage, target, true, "清除隐藏规则后的 inline 目标");
    const disabled = await inlineDisplayState(mainPage, target);
    assert.deepEqual(
      { value: disabled.value, priority: disabled.priority, computed: disabled.computed },
      { value: original.value, priority: original.priority, computed: original.computed },
      `清除隐藏规则未恢复原 inline value+priority：${JSON.stringify(disabled)}`
    );
    assert.equal(disabled.session, null);
    assert.equal(disabled.persistent, false);
    await e2e.navigate(mainPage, persistentUrl);
    await waitVisible(mainPage, target, true, "清除隐藏规则后刷新目标");
    const disabledReload = await inlineDisplayState(mainPage, target);
    assert.equal(disabledReload.value, "block");
    assert.equal(disabledReload.priority, "important");
    assert.deepEqual(await hiddenMarkerCounts(mainPage), { session: 0, persistent: 0 },
      "清除隐藏规则并刷新后不得残留标记");
  });

  for (const identity of ["动态ID", "动态类名"]) {
    await run(`规则恢复：${identity}、祖先变化、延迟加载与歧义保护`, async () => {
      const url = await e2e.reset(mainPage, { label: "rule-recovery" });
      const target = "document.querySelector('recovery-card[data-e2e=target]')";
      const mount = async (changed, includeTarget) => evaluate(mainPage, `(() => {
        const panel = document.createElement('section');
        panel.id = ${JSON.stringify(changed ? "panelBeta" : "panelAlpha")};
        panel.style.cssText = 'position:fixed;left:70px;top:150px;width:700px;padding:20px;background:white;z-index:1000';
        const names = ${JSON.stringify(includeTarget ? ["neighbour-a", "target", "neighbour-b"] : ["neighbour-b", "neighbour-a"])};
        for (const name of names) {
          const card = document.createElement('recovery-card');
          card.dataset.e2e = name;
          card.className = ${JSON.stringify(changed ? "cardBeta" : "cardAlpha")};
          if (${JSON.stringify(identity)} === '动态ID') card.id = name + ${JSON.stringify(changed ? "Beta" : "Alpha")};
          card.style.cssText = 'display:block;margin:12px;padding:20px;background:#eee';
          card.innerHTML = name === 'target' ? '<span>Saved</span><div>target identity</div>' : 'Keep ' + name;
          panel.append(card);
        }
        document.body.append(panel);
        window.recoveryWronglyHidden = false;
        new MutationObserver(() => {
          if ([...panel.querySelectorAll('recovery-card')].some(node =>
            node.dataset.e2e !== 'target' && node.dataset.e2e !== 'duplicate' &&
            (node.hasAttribute('data-annoy-killer-persistent-hidden') || getComputedStyle(node).display === 'none')))
            window.recoveryWronglyHidden = true;
        }).observe(panel, {subtree:true, attributes:true, childList:true});
      })()`);
      await mount(false, true);
      await e2e.beginPicker(mainPage);
      await e2e.select(mainPage, target, "Alt");
      await waitVisible(mainPage, target, false, '保存目标');
      await clickClosedShadowButton(mainPage, '完成');
      const rules = await e2e.waitStorageRule('page', pageKey(url));
      assert(rules[0].recovery, '规则必须持久保存恢复特征');
      await evaluate(mainPage, `(() => {
        const duplicate = (${target}).cloneNode(true);
        duplicate.dataset.e2e = 'duplicate';
        duplicate.removeAttribute('data-annoy-killer-persistent-hidden');
        duplicate.style.removeProperty('display');
        (${target}).after(duplicate);
      })()`);
      await waitVisible(mainPage, target, true, '原选择器出现重复身份时也不得猜测');
      await waitVisible(mainPage, "document.querySelector('recovery-card[data-e2e=duplicate]')", true, '原选择器不得通过 CSS 批量隐藏重复项');
      await evaluate(mainPage, "document.querySelector('recovery-card[data-e2e=duplicate]').remove()");
      await waitVisible(mainPage, target, false, '原选择器恢复唯一后继续隐藏');
      await e2e.navigate(mainPage, url);
      await mount(true, false);
      await sleep(450);
      assert.equal(await evaluate(mainPage, 'window.recoveryWronglyHidden'), false, '目标未加载时不得隐藏邻居');
      await evaluate(mainPage, `(() => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = '<recovery-card data-e2e="target" class="cardBeta" style="display:block;padding:20px"><span>Saved</span><div>target identity</div></recovery-card>';
        document.getElementById('panelBeta').append(wrapper);
      })()`);
      await waitVisible(mainPage, target, false, 'ID、类名、祖先与位置变化后恢复目标');
      await sleep(450);
      assert.equal(await visible(mainPage, target), false, '隐藏状态不能影响文本指纹并导致反复出现');
      assert.equal(await evaluate(mainPage, 'window.recoveryWronglyHidden'), false);
      await evaluate(mainPage, `(() => {
        const clone = (${target}).cloneNode(true);
        clone.dataset.e2e = 'duplicate';
        clone.removeAttribute('data-annoy-killer-persistent-hidden');
        clone.style.removeProperty('display');
        document.getElementById('panelBeta').append(clone);
      })()`);
      await waitVisible(mainPage, target, true, '恢复候选有歧义时不猜测');
      await waitVisible(mainPage, "document.querySelector('recovery-card[data-e2e=duplicate]')", true, '重复候选不得误隐藏');
      await evaluate(mainPage, "document.querySelector('recovery-card[data-e2e=duplicate]').remove()");
      await waitVisible(mainPage, target, false, '歧义消除后重新识别');
      await evaluate(mainPage, `(${target}).style.setProperty('display', 'block', 'important')`);
      await waitVisible(mainPage, target, false, '网站重写 inline 样式后继续隐藏');
      await e2e.beginPicker(mainPage);
      await clickClosedShadowButton(mainPage, '重置');
      await clickClosedShadowButton(mainPage, '完成');
      await waitVisible(mainPage, target, true, '恢复规则可正常撤销');
      await e2e.navigate(mainPage, url);
      await mount(true, true);
      await waitVisible(mainPage, target, true, '撤销后刷新仍然可见');
    });
  }

  await run("规则恢复：延迟 Shadow Root、宿主变化与纯文本更新", async () => {
    const url = await e2e.reset(mainPage, { label: 'shadow-recovery' });
    const host = "document.querySelector('[aria-label=RecoveryHost]')";
    const target = `(${host}).shadowRoot.querySelector('aside')`;
    const mountHost = async changed => evaluate(mainPage, `(() => {
      const host = document.createElement('recovery-host');
      host.id = ${JSON.stringify(changed ? 'hostBeta' : 'hostAlpha')};
      host.setAttribute('aria-label', 'RecoveryHost');
      host.style.cssText = 'display:block;position:fixed;left:80px;top:150px;width:400px;height:200px;background:white;z-index:1000';
      document.body.append(host);
    })()`);
    const mountShadow = async changed => evaluate(mainPage, `(() => {
      const root = (${host}).attachShadow({mode:'open'});
      root.innerHTML = '<aside class="${changed ? 'panelBeta' : 'panelAlpha'}" style="display:block;padding:30px">Saved shadow content</aside>';
    })()`);
    await mountHost(false);
    await mountShadow(false);
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, target, "Alt");
    await waitVisible(mainPage, target, false, '保存 shadow 子项');
    await clickClosedShadowButton(mainPage, '完成');
    await e2e.waitStorageRule('page', pageKey(url));
    await e2e.navigate(mainPage, url);
    await mountHost(true);
    await sleep(400);
    await mountShadow(true);
    await waitVisible(mainPage, target, false, '发现延迟附加的 shadow root 并恢复内部目标');
    await evaluate(mainPage, `(${target}).firstChild.data = 'Changed content'`);
    await waitVisible(mainPage, target, true, '特征不符时停止恢复匹配');
    await evaluate(mainPage, `(${target}).firstChild.data = 'Saved shadow content'`);
    await waitVisible(mainPage, target, false, 'shadow 内纯 characterData 修改后重新匹配');
  });

  await run("规则恢复：iframe 属性更新与旧规则兼容", async () => {
    await e2e.reset(mainPage, { label: 'frame-recovery' });
    const frame = "document.querySelector('#same-origin-frame').contentDocument";
    await waitFor(async () => evaluate(mainPage, `${frame}?.readyState === 'complete'`), 'iframe ready');
    const frameUrl = await evaluate(mainPage, `${frame}.location.href`);
    await evaluate(mainPage, `(() => {
      const node = (${frame}).createElement('aside');
      node.id = 'frame-recovery-new';
      node.textContent = 'Loading';
      (${frame}).body.append(node);
    })()`);
    await e2e.setStorage({ hiddenRulesByPage: { [pageKey(frameUrl)]: [{
      selector: '#frame-recovery-old',
      recovery: { selector: 'aside', fingerprint: { attributes: { 'aria-label': 'Saved frame panel' } } }
    }] } });
    const target = `(${frame}).getElementById('frame-recovery-new')`;
    await waitVisible(mainPage, target, true, '尚未提供识别属性时保留显示');
    await evaluate(mainPage, `(${target}).setAttribute('aria-label', 'Saved frame panel')`);
    await waitVisible(mainPage, target, false, 'iframe 仅修改属性也会重新匹配');
    await e2e.setStorage({ hiddenRulesByPage: { [pageKey(frameUrl)]: ['#frame-recovery-new'] } });
    await waitVisible(mainPage, target, false, '旧字符串规则继续有效');
    await e2e.setStorage({ hiddenRulesByPage: {} });
    await waitVisible(mainPage, target, true, '移除旧规则能恢复');
  });

  await run("fallback 精确规则跨 text/src/子内容变化与刷新", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "fallback-structure" });
    const target = "document.querySelector('#fallback-zone > fixture-card:nth-of-type(2)')";
    await evaluate(mainPage, "window.__fixture.clearFallbackMutation()");
    const before = await evaluate(mainPage, "window.__fixture.getFallbackState()");
    const expectedFingerprintText = await evaluate(mainPage, `(() => {
      const node = (${target});
      return (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240);
    })()`);
    assert.equal(before.index, 1, "fallback 目标必须位于稳定结构索引 1");
    assert.equal(before.hasStableId, false, "fallback 目标不得有稳定 id");
    assert.deepEqual(before.dataAttributes, [], "fallback 目标不得有 data-* 捷径");
    assert.equal(await evaluate(mainPage,
      "document.querySelectorAll('#fallback-zone > fixture-card').length"), 3,
    "fallback selector 必须有多个候选，不能退化成唯一 selector");
    const initialFallbackCards = await fallbackCardStates(mainPage);
    assert(initialFallbackCards.every((state) => state.display !== "none" &&
      !state.session && !state.persistent),
    `fallback 三个候选初始都必须可见且无标记：${JSON.stringify(initialFallbackCards)}`);

    await e2e.beginPicker(mainPage);
    const targetRect = await rectFor(mainPage, target);
    const blankPoint = { x: targetRect.right - 9, y: targetRect.bottom - 9 };
    const fallbackHover = await e2e.hoverAt(mainPage, blankPoint, "Alt", targetRect);
    await waitHighlightRect(mainPage, targetRect, "fallback fixture-card", true);
    await e2e.pressSelection(mainPage, fallbackHover);
    await waitVisible(mainPage, target, false, "fallback 原始目标");
    assertOnlyFallbackTargetHidden(
      await fallbackCardStates(mainPage),
      "fallback 会话阶段",
      "session"
    );
    await clickClosedShadowButton(mainPage, "完成");
    const rules = await e2e.waitStorageRule("page", pageKey(url));
    assert.equal(rules.length, 1,
      `fallback 精确选择必须只写一条 page 规则：${JSON.stringify(rules)}`);
    const fallbackRule = rules.find((rule) => rule?.fingerprint &&
      rule.selector.includes("fixture-card"));
    assert(fallbackRule, `必须生成带 fingerprint 的 fallback 规则：${JSON.stringify(rules)}`);
    assert.equal(fallbackRule.fingerprint.index, 1, "fallback 规则必须保存结构索引 1");
    assert.equal(fallbackRule.fingerprint.text, expectedFingerprintText,
      "fallback 规则必须记录不受 display 状态影响的文本指纹");
    assert.equal(fallbackRule.fingerprint.attributes?.src, before.src,
      "fallback 规则必须记录原 src 作为软指纹");
    assert.equal(fallbackRule.fingerprint.childSignature, before.childSignature,
      "fallback 规则必须记录原子内容签名");
    assertOnlyFallbackTargetHidden(
      await fallbackCardStates(mainPage),
      "fallback 完成阶段",
      "persistent"
    );

    const mutation = await evaluate(mainPage, `window.__fixture.mutateFallback({
      variant: "runtime-mutated",
      text: "completely changed fallback text ",
      src: "/fixture-fallback-runtime-new.svg",
      children: [
        { tag: "strong", text: "new-strong" },
        { tag: "mark", text: "new-mark" },
        { tag: "small", text: "new-small" }
      ]
    })`);
    assert.notEqual(mutation.before.text, mutation.after.text, "fallback text 必须实际改变");
    assert.notEqual(mutation.before.src, mutation.after.src, "fallback src 必须实际改变");
    assert.notEqual(mutation.before.childSignature, mutation.after.childSignature,
      "fallback 子内容签名必须实际改变");

    const replacement = await evaluate(mainPage, `(() => {
      const oldTarget = (${target});
      const clone = oldTarget.cloneNode(true);
      clone.removeAttribute("data-annoy-killer-session-hidden");
      clone.removeAttribute("data-annoy-killer-persistent-hidden");
      clone.style.removeProperty("display");
      oldTarget.replaceWith(clone);
      return {
        sameNode: oldTarget === clone,
        initiallyMarked: clone.hasAttribute("data-annoy-killer-persistent-hidden"),
        initiallyInlineDisplay: clone.style.getPropertyValue("display")
      };
    })()`);
    assert.deepEqual(replacement,
      { sameNode: false, initiallyMarked: false, initiallyInlineDisplay: "" },
      "动态替换节点必须先移除隐藏痕迹，避免假通过");
    await waitFor(async () => evaluate(mainPage, `(() => {
      const node = (${target});
      return node.hasAttribute("data-annoy-killer-persistent-hidden") &&
        node.style.getPropertyValue("display") === "none" &&
        node.style.getPropertyPriority("display") === "important" &&
        getComputedStyle(node).display === "none";
    })()`), "fallback 动态替换后按结构重新隐藏", UI_TIMEOUT);
    assertOnlyFallbackTargetHidden(
      await fallbackCardStates(mainPage),
      "fallback 动态替换阶段",
      "persistent"
    );

    await e2e.navigate(mainPage, url);
    const afterReload = await evaluate(mainPage, "window.__fixture.getFallbackState()");
    assert.equal(afterReload.variant, "runtime-mutated", "fallback 变体必须跨同 URL reload 保留");
    assert.equal(afterReload.text, mutation.after.text);
    assert.equal(afterReload.src, mutation.after.src);
    assert.equal(afterReload.childSignature, mutation.after.childSignature);
    await waitVisible(mainPage, target, false, "fallback 指纹全变后的刷新目标");
    assert.equal(await evaluate(mainPage, `(${target}).hasAttribute(
      "data-annoy-killer-persistent-hidden")`), true,
    "fallback 刷新隐藏必须由持久化标记实现");
    assertOnlyFallbackTargetHidden(
      await fallbackCardStates(mainPage),
      "fallback 刷新阶段",
      "persistent"
    );
    await evaluate(mainPage, "window.__fixture.clearFallbackMutation()");
  });

  for (const mode of ["nested", "portal", "siblings"]) {
    await run(`全屏覆盖弹窗默认选择与遮罩整体隐藏 ${mode}`, async () => {
      const url = await e2e.reset(mainPage, { path: `/overlays.html?mode=${mode}`, label: `overlay-${mode}` });
      await mainPage.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }]
      });
      const panel = "document.querySelector('#popup-panel')";
      const root = mode === "siblings" ? panel : "document.querySelector('#overlay-root')";
      await e2e.beginPicker(mainPage);
      const hovered = await e2e.hover(mainPage, "document.querySelector('#popup-button')");
      await waitHighlightRect(mainPage, await rectFor(mainPage, root), "普通模式选中完整覆盖层", false);
      await captureScreenshot(mainPage, artifactPath, `overlay-default-${mode}`);
      await e2e.pressSelection(mainPage, hovered);
      await waitVisible(mainPage, root, false, "弹窗容器已隐藏");
      if (mode === "siblings") await waitVisible(mainPage, "document.querySelector('#popup-mask')", false, "关联遮罩已隐藏");
      await waitFor(async () => evaluate(mainPage, "getComputedStyle(document.body).overflowY === 'auto'"), "隐藏后解除滚动锁定");
      assert.equal(await evaluate(mainPage, "document.body.dataset.popupClicks || '0'"), "0", "不能触发促销按钮");
      assert.notEqual(await evaluate(mainPage, "getComputedStyle(document.querySelector('#page-content')).display"), "none");
      if (mode === "siblings") {
        const mask = "document.querySelector('#popup-mask')";
        assert.equal(await toolbarCount(mainPage), "1个项目已隐藏",
          "一次操作关联隐藏 panel 与 mask 也只能计为一个项目");
        await e2e.waitStorageRule("page", pageKey(url));
        await e2e.installFirstCommitResponseDelay(mainPage);
        try {
          await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
          await Promise.all([
            waitVisible(mainPage, panel, true, "同组恢复前的弹窗预览"),
            waitVisible(mainPage, mask, true, "同组恢复前的遮罩预览")
          ]);
          const groupPreview = await hiddenPreviewMaskState(mainPage, panel);
          await dispatchMouseClick(mainPage, groupPreview.center);
          await waitFor(async () => (await e2e.commitResponseDelayState(mainPage))?.firstIntercepted,
            "同组显示提交进入延迟探针", STORAGE_TIMEOUT);
          await Promise.all([
            waitFor(async () => evaluate(mainPage, `!(${panel}).hasAttribute(
              "data-annoy-killer-persistent-hidden") && !(${panel}).hasAttribute(
              "data-annoy-killer-session-hidden")`), "恢复同组弹窗标记"),
            waitFor(async () => evaluate(mainPage, `!(${mask}).hasAttribute(
              "data-annoy-killer-persistent-hidden") && !(${mask}).hasAttribute(
              "data-annoy-killer-session-hidden")`), "恢复同组遮罩标记")
          ]);
          assert.equal(await toolbarCount(mainPage), "0个项目已隐藏",
            "显示同组任一实现节点后逻辑项目计数必须归零");

          await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
          await sleep(300);
          await e2e.select(mainPage, "document.querySelector('#popup-button')");
          await Promise.all([
            waitVisible(mainPage, panel, false, "显示提交完成前再次隐藏同组弹窗"),
            waitVisible(mainPage, mask, false, "显示提交完成前再次隐藏同组遮罩")
          ]);
          assert.equal(await toolbarCount(mainPage), "1个项目已隐藏",
            "立即再次隐藏同组后仍只能计为一个项目");

          await e2e.forwardFirstCommit(mainPage);
          await waitFor(async () => (await e2e.commitResponseDelayState(mainPage))?.firstForwarded,
            "同组显示删除已写入但响应保持延迟", STORAGE_TIMEOUT);
          await e2e.releaseFirstCommitResponse(mainPage);
          await waitFor(async () => (await e2e.commitResponseDelayState(mainPage))?.commitCalls >= 2,
            "再次隐藏提交取消显示 tombstone", STORAGE_TIMEOUT);
          await e2e.waitStorageRule("page", pageKey(url));
          await e2e.restoreCommitResponseDelay(mainPage);
          await clickClosedShadowButton(mainPage, "完成");
        } finally {
          await e2e.releaseFirstCommitResponse(mainPage).catch(() => undefined);
          await e2e.restoreCommitResponseDelay(mainPage);
        }

        await e2e.navigate(mainPage, url);
        await Promise.all([
          waitVisible(mainPage, panel, false, "刷新继续隐藏同组弹窗"),
          waitVisible(mainPage, mask, false, "刷新继续隐藏同组遮罩")
        ]);
        await e2e.beginPicker(mainPage);
        assert.equal(await toolbarCount(mainPage), "1个项目已隐藏",
          "完成并刷新后同组仍只计为一个项目");
        await clickClosedShadowButton(mainPage, "重置");
        await clickClosedShadowButton(mainPage, "完成");
        await Promise.all([
          waitVisible(mainPage, panel, true, "同组计数用例清理弹窗"),
          waitVisible(mainPage, mask, true, "同组计数用例清理遮罩")
        ]);
        return;
      }
      await clickClosedShadowButton(mainPage, "重置");
      await closePickerWithEscape(mainPage);
      await waitVisible(mainPage, root, true, "重置后恢复完整弹层");
      assert.equal(await evaluate(mainPage, "getComputedStyle(document.body).overflowY"), "hidden");
      assert.equal(await evaluate(mainPage, "document.body.style.getPropertyPriority('overflow-y')"), "important");

      // Selecting the blank backdrop works without any modifier too.
      await e2e.beginPicker(mainPage);
      const backdropHover = await e2e.hoverAt(mainPage, { x: 25, y: 180 });
      await e2e.pressSelection(mainPage, backdropHover);
      await waitVisible(mainPage, panel, false, "点击遮罩空白处隐藏弹窗");
      await clickClosedShadowButton(mainPage, "完成");
      const rules = await e2e.waitStorageRule("page", pageKey(url));
      assert(rules.every(rule => rule.overlay), "保存覆盖层类型用于恢复滚动状态");
      await e2e.navigate(mainPage, url);
      await waitVisible(mainPage, panel, false, "刷新继续隐藏弹窗");
      await waitFor(async () => evaluate(mainPage, "getComputedStyle(document.body).overflowY === 'auto'"), "刷新后也解除滚动锁定");
      await dispatchMouseClick(mainPage, centerOf(await rectFor(mainPage, "document.querySelector('#page-button')")));
      assert.equal(await evaluate(mainPage, "document.body.dataset.pageClicks"), "1", "页面可点击");
      await e2e.beginPicker(mainPage);
      await clickClosedShadowButton(mainPage, "切换已隐藏项目显示");
      await waitVisible(mainPage, root, true, "显示隐藏项预览");
      assert.equal(await evaluate(mainPage, "getComputedStyle(document.body).overflowY"), "hidden", "预览时恢复原滚动锁");
      await clickClosedShadowButton(mainPage, "重置");
      await clickClosedShadowButton(mainPage, "完成");
      await waitVisible(mainPage, root, true, "重置完成后恢复弹层");
    });
  }

  await run("全屏覆盖弹窗识别不误选普通应用外壳", async () => {
    await e2e.reset(mainPage, { path: "/overlays.html?mode=shell", label: "overlay-shell-safety" });
    await e2e.beginPicker(mainPage);
    await e2e.hover(mainPage, "document.querySelector('#page-button')");
    const highlight = await highlightState(mainPage);
    assert(highlight.right - highlight.left < 1000 && highlight.bottom - highlight.top < 500,
      "普通满屏应用外壳不能作为弹窗整体选中");
    await closePickerWithEscape(mainPage);
  });

  await run("dialog 与 popover top-layer 上方 picker 可操作并隐藏弹层", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "top-layer" });
    const topLayer = await evaluate(mainPage, "window.__fixture.openTopLayers()");
    assert.equal(topLayer.dialogOpen, true, "dialog.showModal() 未打开 dialog");
    assert.equal(topLayer.dialogModal, true, "fixture dialog 必须处于 :modal top layer");
    assert.equal(topLayer.popoverSupported, true, "当前 Chrome 必须支持 popover API");
    assert.equal(topLayer.popoverOpen, true, "fixture popover 必须处于 :popover-open");
    assert.equal(topLayer.dialog.blankPointHitsHost, true,
      `dialog blankPoint 未命中宿主：${JSON.stringify(topLayer.dialog)}`);
    assert.equal(topLayer.popover.blankPointHitsHost, true,
      `popover blankPoint 未命中宿主：${JSON.stringify(topLayer.popover)}`);

    await e2e.beginPicker(mainPage);
    const picker = await pickerLayerState(mainPage, topLayer.dialog.blankPoint);
    assert.equal(picker.host.modalOpen, true,
      `已有 modal 时 picker 必须以更高 modal layer 打开：${JSON.stringify(picker.host)}`);
    assert.equal(picker.host.pointHitsHost, true,
      `document hit-test 必须命中最上层 picker host：${JSON.stringify(picker)}`);
    assert.equal(picker.capture.hitSelf, true,
      `closed shadow capture 必须在 dialog 坐标命中自身：${JSON.stringify(picker)}`);
    assert(picker.capture.rect.left <= topLayer.dialog.blankPoint.x &&
      picker.capture.rect.right >= topLayer.dialog.blankPoint.x &&
      picker.capture.rect.top <= topLayer.dialog.blankPoint.y &&
      picker.capture.rect.bottom >= topLayer.dialog.blankPoint.y,
    "picker 捕获层布局框必须覆盖 dialog 空白点");
    assert.equal(picker.capture.pointerEvents, "auto");
    assert.equal(picker.toolbar.visibility, "visible");
    assert(picker.toolbar.rect.width > 0 && picker.toolbar.rect.height > 0,
      "top-layer 上方 toolbar 必须有真实布局框");
    await captureScreenshot(mainPage, artifactPath, "top-layer-picker-active");

    const popoverRect = topLayer.popover.rect;
    const popoverPicker = await pickerLayerState(mainPage, topLayer.popover.blankPoint);
    assert.equal(popoverPicker.host.pointHitsHost, true,
      `popover 坐标必须由 picker host 捕获：${JSON.stringify(popoverPicker)}`);
    assert.equal(popoverPicker.capture.hitSelf, true,
      `closed shadow capture 必须在 popover 坐标命中自身：${JSON.stringify(popoverPicker)}`);
    assert(popoverPicker.capture.rect.left <= topLayer.popover.blankPoint.x &&
      popoverPicker.capture.rect.right >= topLayer.popover.blankPoint.x &&
      popoverPicker.capture.rect.top <= topLayer.popover.blankPoint.y &&
      popoverPicker.capture.rect.bottom >= topLayer.popover.blankPoint.y,
    "picker 捕获层布局框必须覆盖 popover 空白点");
    const popoverHover = await e2e.hoverAt(
      mainPage,
      topLayer.popover.blankPoint,
      "Alt",
      popoverRect
    );
    await waitHighlightRect(mainPage, popoverRect, "popover top-layer", true);
    await e2e.pressSelection(mainPage, popoverHover);
    await waitVisible(mainPage, "document.querySelector('#fixture-popover')", false,
      "popover top-layer 宿主");
    const afterPopover = await evaluate(mainPage, `(() => {
      const popover = document.querySelector("#fixture-popover");
      const dialog = document.querySelector("#fixture-dialog");
      return {
        popover: {
          session: popover.getAttribute("data-annoy-killer-session-hidden"),
          persistent: popover.hasAttribute("data-annoy-killer-persistent-hidden"),
          inlineDisplay: popover.style.getPropertyValue("display"),
          inlinePriority: popover.style.getPropertyPriority("display"),
          computed: getComputedStyle(popover).display
        },
        dialog: {
          open: dialog.open,
          modal: dialog.matches(":modal"),
          session: dialog.getAttribute("data-annoy-killer-session-hidden"),
          persistent: dialog.hasAttribute("data-annoy-killer-persistent-hidden"),
          computed: getComputedStyle(dialog).display
        }
      };
    })()`);
    assert(afterPopover.popover.session && !afterPopover.popover.persistent &&
      afterPopover.popover.inlineDisplay === "none" &&
      afterPopover.popover.inlinePriority === "important" &&
      afterPopover.popover.computed === "none",
    `popover 必须由 session inline 隐藏：${JSON.stringify(afterPopover)}`);
    assert(afterPopover.dialog.open && afterPopover.dialog.modal &&
      afterPopover.dialog.session === null && !afterPopover.dialog.persistent &&
      afterPopover.dialog.computed !== "none",
    `隐藏 popover 不得关闭或标记 dialog：${JSON.stringify(afterPopover)}`);

    const dialogRect = topLayer.dialog.rect;
    const dialogPickerAfterPopover = await pickerLayerState(mainPage, topLayer.dialog.blankPoint);
    assert.equal(dialogPickerAfterPopover.host.pointHitsHost, true,
      `隐藏 popover 后 dialog 坐标仍必须由 picker host 捕获：${JSON.stringify(
        dialogPickerAfterPopover)}`);
    assert.equal(dialogPickerAfterPopover.capture.hitSelf, true,
      `隐藏 popover 后 closed shadow capture 必须命中 dialog 坐标：${JSON.stringify(
        dialogPickerAfterPopover)}`);
    const dialogHover = await e2e.hoverAt(
      mainPage,
      topLayer.dialog.blankPoint,
      "Alt",
      dialogRect
    );
    await waitHighlightRect(mainPage, dialogRect, "dialog top-layer", true);
    await e2e.pressSelection(mainPage, dialogHover);
    await waitVisible(mainPage, "document.querySelector('#fixture-dialog')", false,
      "dialog top-layer 宿主");
    const bothSessionHidden = await evaluate(mainPage, `(() =>
      [document.querySelector("#fixture-popover"), document.querySelector("#fixture-dialog")]
        .map((node) => ({
          id: node.id,
          session: node.getAttribute("data-annoy-killer-session-hidden"),
          persistent: node.hasAttribute("data-annoy-killer-persistent-hidden"),
          inlineDisplay: node.style.getPropertyValue("display"),
          inlinePriority: node.style.getPropertyPriority("display"),
          computed: getComputedStyle(node).display
        })))()`);
    assert(bothSessionHidden.every((item) => item.session && !item.persistent &&
      item.inlineDisplay === "none" && item.inlinePriority === "important" &&
      item.computed === "none"),
    `top-layer 两宿主必须同时保持 session inline 隐藏：${JSON.stringify(bothSessionHidden)}`);
    assert.equal(await toolbarCount(mainPage), "2个项目已隐藏",
      "top-layer 隐藏计数必须为 2");
    await captureScreenshot(mainPage, artifactPath, "top-layer-items-hidden");

    await clickClosedShadowButton(mainPage, "完成");
    const rules = await e2e.waitStorageRule("page", pageKey(url));
    assert.equal(rules.length, 2, `top-layer 必须恰好保存两条规则：${JSON.stringify(rules)}`);
    assert.deepEqual(new Set(rules.map((rule) => rule.selector)),
      new Set(["#fixture-dialog", "#fixture-popover"]),
      `top-layer 持久化规则目标错误：${JSON.stringify(rules)}`);
    assert.equal(await evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), true,
    "top-layer 完成后 picker 必须关闭");
    const committedTopLayers = await evaluate(mainPage, `(() =>
      [document.querySelector("#fixture-popover"), document.querySelector("#fixture-dialog")]
        .map((node) => ({
          id: node.id,
          session: node.getAttribute("data-annoy-killer-session-hidden"),
          persistent: node.hasAttribute("data-annoy-killer-persistent-hidden"),
          inlineDisplay: node.style.getPropertyValue("display"),
          inlinePriority: node.style.getPropertyPriority("display"),
          computed: getComputedStyle(node).display
        })))()`);
    assert(committedTopLayers.every((item) => item.session === null && item.persistent &&
      item.inlineDisplay === "none" && item.inlinePriority === "important" &&
      item.computed === "none"),
    `top-layer 完成后必须转为 persistent：${JSON.stringify(committedTopLayers)}`);
  });

  await run("截图期间透明捕获层持续抑制真实 pointer/click", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "capture-event-isolation" });
    await evaluate(mainPage, "window.__fixture.resetEvents(); window.__fixture.resetCaptureEvents()");
    await e2e.beginPicker(mainPage);
    await sleep(560);
    const target = "document.querySelector('#capture-event-target')";
    const hovered = await e2e.hover(mainPage, target, STANDARD_SELECTION_MODIFIER);
    await waitHighlightRect(mainPage, hovered.rect, "截图事件目标", true);
    const preCaptureLayer = await pickerLayerState(mainPage, hovered.point);
    await installCaptureEventProbe(mainPage, preCaptureLayer.backendNodeIds.capture);
    await e2e.pressSelection(mainPage, hovered);

    const duringCapture = await waitFor(async () => {
      const state = await captureLayerSnapshot(
        mainPage,
        preCaptureLayer.backendNodeIds.capture,
        hovered.point
      );
      return state.toolbar.visibility === "hidden" ? state : null;
    }, "截图期间 toolbar 临时隐藏窗口", 1_500, 5);
    assert.equal(duringCapture.capture.visibility, "visible",
      "截图期间 capture layer 不得一并隐藏");
    assert.equal(duringCapture.capture.display, "block");
    assert.equal(duringCapture.capture.pointerEvents, "auto");
    assert.equal(duringCapture.capture.hitSelf, true,
      "截图期间目标坐标必须命中透明 capture layer");
    assert.match(duringCapture.capture.backgroundColor, /^(?:rgba\(0, 0, 0, 0\)|transparent)$/,
      `capture layer 必须透明：${duringCapture.capture.backgroundColor}`);
    const resetProbeState = await resetCaptureEventProbe(
      mainPage,
      preCaptureLayer.backendNodeIds.capture
    );
    assert.equal(resetProbeState?.toolbarVisibility, "hidden",
      "probe 增量起点必须位于截图隐藏 toolbar 的时间窗");

    await mainPage.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: hovered.point.x,
      y: hovered.point.y
    });
    await mainPage.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: hovered.point.x,
      y: hovered.point.y,
      button: "left",
      clickCount: 1
    });
    await mainPage.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: hovered.point.x,
      y: hovered.point.y,
      button: "left",
      clickCount: 1
    });
    const immediatelyAfter = await captureLayerSnapshot(
      mainPage,
      preCaptureLayer.backendNodeIds.capture,
      hovered.point
    );
    assert.equal(immediatelyAfter.toolbar.visibility, "hidden",
      "测试 click 必须真实发生在截图窗口内，不能在截图完成后假通过");
    assert.equal(immediatelyAfter.capture.hitSelf, true);

    const captureProbe = await readCaptureEventProbe(
      mainPage,
      preCaptureLayer.backendNodeIds.capture
    );
    assert(captureProbe, "未读取到 capture trusted-event probe");
    for (const type of ["pointerdown", "pointerup", "click"]) {
      const matching = captureProbe.events.filter((event) => event.type === type);
      assert.equal(matching.length, 1,
        `截图窗口内 capture 必须恰好收到一次 ${type}：${JSON.stringify(captureProbe)}`);
      assert(matching.every((event) => event.isTrusted && event.targetSelf && event.button === 0),
        `capture ${type} 必须是命中自身的 trusted 左键事件：${JSON.stringify(matching)}`);
      assert.equal(matching[0].toolbarVisibility, "hidden",
        `${type} 必须发生在截图隐藏 toolbar 的时间窗：${JSON.stringify(matching)}`);
    }

    await waitVisible(mainPage, target, false, "截图触发选择目标");
    const [targetEvents, pageEvents] = await Promise.all([
      evaluate(mainPage, "window.__fixture.getCaptureEvents()"),
      eventState(mainPage)
    ]);
    for (const type of ["pointerdown", "pointerup", "click"]) {
      assert.equal(targetEvents.counts[type], 0,
        `截图期间底层目标收到 ${type}：${JSON.stringify(targetEvents)}`);
      assert.equal(pageEvents.counts[type], 0,
        `截图期间页面收到冒泡 ${type}：${JSON.stringify(pageEvents)}`);
    }

    await closePickerWithEscape(mainPage);
    await waitVisible(mainPage, target, false, "截图事件目标自动保存隐藏");
    const afterCancelEvents = (await evaluate(mainPage,
      "window.__fixture.getCaptureEvents()")).counts;
    for (const type of ["pointerdown", "pointerup", "click"]) {
      assert.equal(afterCancelEvents[type], 0,
        `取消后底层目标不应补发 ${type}：${JSON.stringify(afterCancelEvents)}`);
    }
  });

  await run("SPA push/replace/back 同站组件复用", async () => {
    const originalUrl = await e2e.reset(mainPage, { sameClass: false, label: "spa" });
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#unique-target')",
      STANDARD_SELECTION_MODIFIER);
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "SPA 原路径目标");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(originalUrl));

    await evaluate(mainPage, "window.__fixture.pushPath('/fixture-spa-push')");
    await waitFor(async () => evaluate(mainPage, "location.pathname === '/fixture-spa-push'"),
      "SPA pushState 路径");
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false,
      "SPA 新路径继承组件规则");

    await evaluate(mainPage, "history.back(); true");
    await waitFor(async () => evaluate(mainPage,
      `location.href === ${JSON.stringify(originalUrl)}`), "SPA back 返回原路径");
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false,
      "SPA back 恢复原路径规则");

    await evaluate(mainPage, "window.__fixture.replacePath('/fixture-spa-replace')");
    await waitFor(async () => evaluate(mainPage, "location.pathname === '/fixture-spa-replace'"),
      "SPA replaceState 路径");
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false,
      "SPA replace 新路径继续隐藏组件");
  });

  await run("同站组件跨直播间、参数、动态重建与恢复", async () => {
    const firstUrl = await e2e.reset(mainPage, { label: "shared-components" });
    const install = async (page, room) => evaluate(page, `(() => {
      const panel = document.createElement('section');
      panel.id = 'room_' + ${room};
      panel.style.cssText = 'position:fixed;left:100px;top:180px;width:700px;height:250px;background:white;z-index:1000';
      panel.innerHTML = '<div class="live-ranking" style="height:80px;background:coral">Rank ${room}</div>' +
        '<div data-testid="gift-tray" style="height:80px;background:lightblue">Gifts ${room}</div>' +
        '<div class="chat-panel" style="height:80px;background:lightgreen">Chat ${room}</div>';
      document.body.append(panel);
    })()`);
    const ranking = "document.querySelector('.live-ranking')";
    const gifts = "document.querySelector('[data-testid=gift-tray]')";
    const chat = "document.querySelector('.chat-panel')";
    await install(mainPage, 123456789);
    await e2e.beginPicker(mainPage);
    for (const target of [ranking, gifts]) {
      await e2e.select(mainPage, target, "Alt");
      await waitVisible(mainPage, target, false, "首个直播间隐藏组件");
    }
    await clickClosedShadowButton(mainPage, "完成");
    const rules = await e2e.waitStorageRule("page", pageKey(firstUrl));
    assert.equal(rules.length, 2);
    assert(rules.every(rule => rule.component && !rule.component.includes('123456789')));
    const secondUrl = e2e.fixtureUrl('/other.html', 'second-room') + '&anchor_id=987654321#live';
    const second = await e2e.openPage(secondUrl, "同站另一直播间");
    const reloadSecond = async () => {
      await second.send("Page.reload");
      await waitFor(async () => evaluate(second, "!document.querySelector('.live-ranking')"), "确认完整刷新清除了旧 DOM");
      await e2e.waitDocument(second, secondUrl);
      await install(second, 987654321);
    };
    try {
      await install(second, 987654321);
      for (const target of [ranking, gifts]) await waitVisible(second, target, false, "不同地址共享组件");
      await waitVisible(second, chat, true, "聊天区域保持可见");
      await evaluate(second, `(${ranking}).outerHTML = '<div class="live-ranking" style="height:80px;background:coral">Changed rank</div>'`);
      await waitVisible(second, ranking, false, "组件异步重建继续隐藏");
      await evaluate(second, `(${ranking}).insertAdjacentHTML('afterend', '<div class="live-ranking" style="height:80px">Ambiguous neighbour</div>')`);
      await waitFor(async () => evaluate(second, `[...document.querySelectorAll('.live-ranking')].every(e => getComputedStyle(e).display !== 'none')`), "多候选时不误隐藏");
      await evaluate(second, "document.querySelectorAll('.live-ranking')[1].remove()");
      await waitVisible(second, ranking, false, "恢复唯一组件后继续隐藏");

      await e2e.beginPicker(second);
      await clickClosedShadowButton(second, "切换已隐藏项目显示");
      await dispatchMouseClick(second, (await hiddenPreviewMaskState(second, gifts)).center);
      await clickClosedShadowButton(second, "完成");
      await waitVisible(second, gifts, true, "在第二页单独恢复礼物栏");
      await reloadSecond();
      await waitVisible(second, gifts, true, "恢复例外刷新后保留");
      await waitVisible(second, ranking, false, "未恢复的组件继续隐藏");
      await waitVisible(mainPage, gifts, false, "第二页恢复不影响第一页");

      await evaluate(second, `(${ranking}).remove()`);
      await waitFor(async () => evaluate(second, `!(${ranking})`), "重置前共享组件尚未渲染");
      await e2e.beginPicker(second);
      await clickClosedShadowButton(second, "重置");
      await clickClosedShadowButton(second, "完成");
      await reloadSecond();
      for (const target of [ranking, gifts]) await waitVisible(second, target, true, "重置共享组件刷新后保留");

      await e2e.navigate(second, e2e.crossFixtureUrl());
      await install(second, 123456789);
      for (const target of [ranking, gifts]) await waitVisible(second, target, true, "不同源网站不共享规则");
    } finally {
      activePage = mainPage;
      await e2e.closePage(second);
    }
  });

  await run("旧版唯一组件跨页兼容与重复内容隔离", async () => {
    const url = await e2e.reset(mainPage, { label: 'legacy-sharing' });
    const oldPage = new URL('/old-room?anchor_id=123456789', url).href;
    await e2e.setStorage({ hiddenRulesByPage: { [oldPage]: [
      { selector: '#unique-target', recovery: { selector: 'div', fingerprint: { text: 'Old content' } } },
      { selector: '#fallback-zone > fixture-card', fingerprint: { index: 1, count: 3 },
        recovery: { selector: 'fixture-card', fingerprint: { text: 'Old content' } } }
    ] } });
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "旧版唯一组件自动共享");
    assert((await fallbackCardStates(mainPage)).every(state => state.display !== 'none'),
      "旧版多个候选中的单项内容不能跨页按位置隐藏");
  });

  await run("同源与跨源 iframe host 选择", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "iframes" });
    await waitFor(async () => evaluate(mainPage,
      "document.querySelector('#same-origin-frame')?.contentDocument?.readyState === 'complete'"),
    "同源 iframe 加载");
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#same-origin-frame')", STANDARD_SELECTION_MODIFIER);
    await waitVisible(mainPage, "document.querySelector('#same-origin-frame')", false, "同源 iframe host");
    await closePickerWithEscape(mainPage);
    await waitVisible(mainPage, "document.querySelector('#same-origin-frame')", false,
      "Escape 自动保存同源 iframe host");

    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#cross-origin-frame')", "Alt");
    await waitVisible(mainPage, "document.querySelector('#cross-origin-frame')", false, "跨源 iframe host");
    await clickClosedShadowButton(mainPage, "完成");
    const currentUrl = await evaluate(mainPage, "location.href");
    await e2e.waitStorageRule("page", pageKey(currentUrl));
    await e2e.navigate(mainPage, currentUrl);
    await waitVisible(mainPage, "document.querySelector('#cross-origin-frame')", false,
      "跨源 iframe host 刷新持久化");
  });

  await run("跨源 iframe 节点替换后 src 前缀规则仍命中", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "iframe-replace" });
    await waitFor(async () => evaluate(mainPage,
      "Boolean(document.querySelector('#cross-origin-frame')?.src)"),
      "跨源 iframe 加载", 5_000);
    const frameSelector = "document.querySelector('#cross-origin-frame')";
    const oldSrc = await evaluate(mainPage, `${frameSelector}.src`);

    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, frameSelector, "Alt");
    await waitVisible(mainPage, frameSelector, false, "跨源 iframe host 隐藏");
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(url));

    await evaluate(mainPage, `(() => {
      const old = document.querySelector('#cross-origin-frame');
      const parent = old.parentElement;
      const replacement = document.createElement('iframe');
      replacement.id = 'cross-origin-frame';
      replacement.src = ${JSON.stringify(oldSrc)};
      parent.replaceChild(replacement, old);
    })()`);
    await waitFor(async () => evaluate(mainPage,
      "Boolean(document.querySelector('#cross-origin-frame')?.src)"),
      "新跨源 iframe 已挂载", 5_000);
    await waitVisible(mainPage, frameSelector, false,
      "iframe 节点替换后 src 前缀规则仍命中新节点");
  });

  await run("嵌套 open shadow 精细选择与持久化", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "open-shadow" });
    const shadowFine = `document.querySelector('#open-shadow-host').shadowRoot
      .querySelector('.shadow-card > .shadow-fine')`;
    const shadowCard = `document.querySelector('#open-shadow-host').shadowRoot
      .querySelector('.shadow-card')`;
    const nestedFine = `document.querySelector('#open-shadow-host').shadowRoot
      .querySelector('#nested-shadow-host').shadowRoot.querySelector('.nested-shadow-fine')`;
    const nestedCard = `document.querySelector('#open-shadow-host').shadowRoot
      .querySelector('#nested-shadow-host').shadowRoot.querySelector('.nested-shadow-card')`;

    await e2e.beginPicker(mainPage);
    await selectAndAssertShadowFine(e2e, mainPage, {
      targetExpression: shadowFine,
      cardExpression: shadowCard,
      modifier: "Alt",
      label: "open shadow 精细目标"
    });
    assert.equal(await visible(mainPage, shadowCard), true, "open shadow 父卡片不应隐藏");
    await selectAndAssertShadowFine(e2e, mainPage, {
      targetExpression: nestedFine,
      cardExpression: nestedCard,
      modifier: "Alt",
      label: "嵌套 open shadow 精细目标"
    });
    assert.equal(await visible(mainPage, nestedCard), true, "嵌套 shadow 父卡片不应隐藏");
    assert.match(await toolbarCount(mainPage), /2\s*个项目已隐藏/);
    await clickClosedShadowButton(mainPage, "完成");
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, shadowFine, false, "open shadow 刷新规则");
    await waitVisible(mainPage, nestedFine, false, "嵌套 shadow 刷新规则");
  });

  await run("粒子 Canvas 真实像素、演化、时序", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "particles" });
    await mainPage.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
    });
    await e2e.beginPicker(mainPage);
    const hovered = await e2e.hover(mainPage, "document.querySelector('#particle-target')", STANDARD_SELECTION_MODIFIER);
    const clickedAt = performance.now();
    await e2e.pressSelection(mainPage, hovered);
    await waitVisible(mainPage, "document.querySelector('#particle-target')", false, "粒子目标", 1_200);
    const hideLatency = performance.now() - clickedAt;
    assert(hideLatency < 1_200, `点击到隐藏耗时过长：${Math.round(hideLatency)}ms`);

    const first = await waitFor(async () => {
      const stats = await canvasStats(mainPage);
      return stats.some((item) => item.layer === "particles" && item.nonZero > 20) ? stats : null;
    }, "particles Canvas 层出现真实非透明像素", 1_500, 30);
    const firstPixelLatency = performance.now() - clickedAt;
    assert(firstPixelLatency < 1_500,
      `点击到粒子首帧耗时过长：${Math.round(firstPixelLatency)}ms`);
    assert(first.every((item) => item.width > 0 && item.height > 0), "粒子 Canvas 尺寸必须有效");
    const sourceLayer = first.find((item) => item.layer === "source" && item.nonZero > 20);
    const particleLayer = first.find((item) => item.layer === "particles" && item.nonZero > 20);
    assert(sourceLayer, `source Canvas 未呈现目标截图像素：${JSON.stringify(first)}`);
    assert(particleLayer, `particles Canvas 未呈现粒子像素：${JSON.stringify(first)}`);
    assert(particleLayer.particleCount >= 2_500,
      `高密度粒子数量不足：${JSON.stringify(particleLayer)}`);
    const sourcePaint = paintedPageBounds(sourceLayer);
    assert(sourcePaint && rectsOverlap(sourcePaint, hovered.rect),
      `source Canvas 像素未覆盖被隐藏目标：${JSON.stringify({ sourcePaint, target: hovered.rect })}`);
    const signatures = [canvasSignature(first)];
    await captureScreenshot(mainPage, artifactPath, "particles-0150ms");
    for (const [delay, name] of [[180, "particles-0350ms"], [300, "particles-0650ms"], [350, "particles-1000ms"]]) {
      await sleep(delay);
      const stats = await canvasStats(mainPage);
      signatures.push(canvasSignature(stats));
      await captureScreenshot(mainPage, artifactPath, name);
    }
    assert(new Set(signatures.filter(Boolean)).size >= 2,
      `Canvas 像素/透明度未随时间变化：${JSON.stringify(signatures)}`);
    await waitFor(async () => (await canvasEntries(mainPage)).length === 0,
      "粒子 Canvas 动画结束后清理", 2_600, 50);
    const cleanupLatency = performance.now() - clickedAt;
    assert(cleanupLatency < 3_600,
      `点击到粒子 Canvas 清理耗时过长：${Math.round(cleanupLatency)}ms`);
    console.log(`METRIC 粒子 renderer=${particleLayer.renderer} count=${particleLayer.particleCount} hide=${Math.round(hideLatency)}ms ` +
      `first-pixel=${Math.round(firstPixelLatency)}ms cleanup=${Math.round(cleanupLatency)}ms`);
  });

  await run("录屏参考尺寸与粒子资源上限", async () => {
    for (const [label, expression] of [
      ["small", "document.querySelector('.fine-target')"],
      ["dark-card", "document.querySelector('#event-target').closest('.test-group')"],
      ["large-color", "document.querySelector('#particle-target').closest('.test-group')"]
    ]) {
      await e2e.reset(mainPage, { sameClass: false, label: `safari-${label}` });
      await e2e.beginPicker(mainPage);
      const rect = await rectFor(mainPage, expression);
      const point = label === "small" ? centerOf(rect) : { x: rect.left + 26, y: rect.top + 12 };
      const modifier = label === "small" ? "Alt" : undefined;
      await e2e.pressSelection(mainPage, await e2e.hoverAt(mainPage, point, modifier));
      await waitFor(async () => evaluate(mainPage,
        `(${expression}).hasAttribute("data-annoy-killer-session-hidden")`), "隐藏完整参考模块");
      await waitFor(async () => (await canvasEntries(mainPage)).some(entry =>
        attributesOf(entry.node)["data-annoy-killer-layer"] === "particles"), "参考粒子层", 2000, 10);
      for (const [delay, time] of [[100, "0100"], [150, "0250"], [200, "0450"], [250, "0700"]]) {
        await sleep(delay);
        await captureScreenshot(mainPage, artifactPath, `safari-${label}-${time}ms`);
      }
      const layers = await canvasEntries(mainPage);
      for (const entry of layers) {
        const count = Number(attributesOf(entry.node)["data-annoy-killer-particle-count"] || 0);
        assert(count <= 180_000, "粒子数量必须受上限约束");
        const area = await callOnNode(mainPage, entry.node, "function () { return this.width * this.height; }");
        assert(area <= 1_405_000, "画布像素必须受上限约束");
      }
      await closePickerWithEscape(mainPage);
      await waitFor(async () => (await canvasEntries(mainPage)).length === 0, "退出释放粒子资源");
    }
  });

  await run("四倍 CPU 降速下粒子动画保持响应", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "particle-performance" });
    await mainPage.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
    });
    await mainPage.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    try {
      await e2e.beginPicker(mainPage);
      const hovered = await e2e.hover(mainPage, "document.querySelector('#particle-target')", STANDARD_SELECTION_MODIFIER);
      await e2e.pressSelection(mainPage, hovered);
      await waitVisible(mainPage, "document.querySelector('#particle-target')", false,
        "性能测试粒子目标", 2_000);
      await waitFor(async () => (await canvasEntries(mainPage)).some((entry) =>
        attributesOf(entry.node)["data-annoy-killer-layer"] === "particles"),
      "性能测试粒子 Canvas", 2_000, 25);
      await startAnimationFrameProbe(mainPage);
      await sleep(850);
      const metrics = await stopAnimationFrameProbe(mainPage);
      assert(metrics && metrics.frames >= 16,
        `四倍 CPU 降速下采集到的动画帧不足：${JSON.stringify(metrics)}`);
      assert(metrics.p95 < 35,
        `四倍 CPU 降速下粒子动画 P95 帧间隔过高：${JSON.stringify(metrics)}`);
      assert(metrics.maximum < 90,
        `四倍 CPU 降速下粒子动画出现明显长卡顿：${JSON.stringify(metrics)}`);
      assert(metrics.longestTask < 70,
        `四倍 CPU 降速下粒子动画出现长任务：${JSON.stringify(metrics)}`);
      console.log(`METRIC 粒子 4xCPU frames=${metrics.frames} ` +
        `avg=${metrics.average.toFixed(1)}ms p95=${metrics.p95.toFixed(1)}ms ` +
        `max=${metrics.maximum.toFixed(1)}ms longTasks=${metrics.longTaskCount}`);
    } finally {
      await stopAnimationFrameProbe(mainPage).catch(() => undefined);
      await mainPage.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
      await closePickerWithEscape(mainPage).catch(() => undefined);
    }
  });

  await run("reduced-motion 不渲染粒子但仍隐藏", async () => {
    await e2e.reset(mainPage, { sameClass: false, label: "reduced-motion" });
    await mainPage.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }]
    });
    await e2e.beginPicker(mainPage);
    await e2e.select(mainPage, "document.querySelector('#particle-target')", STANDARD_SELECTION_MODIFIER);
    await waitVisible(mainPage, "document.querySelector('#particle-target')", false,
      "reduced-motion 粒子目标");
    await sleep(350);
    assert.equal((await canvasEntries(mainPage)).length, 0,
      "reduced-motion 下不应创建粒子 Canvas");
    await closePickerWithEscape(mainPage);
  });

  await run("点击后立即完成无竞态丢失", async () => {
    const url = await e2e.reset(mainPage, { sameClass: false, label: "rapid-finish" });
    await e2e.beginPicker(mainPage);
    const hovered = await e2e.hover(mainPage, "document.querySelector('#unique-target')", STANDARD_SELECTION_MODIFIER);
    await e2e.pressSelection(mainPage, hovered);
    await clickClosedShadowButton(mainPage, "完成");
    await waitFor(async () => evaluate(mainPage,
      "!document.querySelector('[data-annoy-killer-ui]')"), "快速完成关闭界面", STORAGE_TIMEOUT);
    await e2e.waitStorageRule("page", pageKey(url));
    await e2e.navigate(mainPage, url);
    await waitVisible(mainPage, "document.querySelector('#unique-target')", false,
      "快速完成刷新持久化");
  });

  await run("双标签并发完成不互相覆盖", async () => {
    const firstUrl = await e2e.reset(mainPage, { sameClass: false, label: "concurrent-first" });
    const secondUrl = e2e.fixtureUrl("/other.html", "concurrent-second");
    const secondPage = await e2e.openPage(secondUrl, "并发第二标签页", true);
    activePage = secondPage;
    try {
      await e2e.beginPicker(mainPage);
      await e2e.select(mainPage, "document.querySelector('#unique-target')", STANDARD_SELECTION_MODIFIER);
      await waitVisible(mainPage, "document.querySelector('#unique-target')", false, "并发第一标签目标");

      await e2e.beginPicker(secondPage);
      await e2e.select(secondPage, "document.querySelector('#unique-target')", "Alt");
      await waitVisible(secondPage, "document.querySelector('#unique-target')", false, "并发第二标签目标");

      await Promise.all([
        clickClosedShadowButton(mainPage, "完成"),
        clickClosedShadowButton(secondPage, "完成")
      ]);
      await Promise.all([
        e2e.waitStorageRule("page", pageKey(firstUrl)),
        e2e.waitStorageRule("page", pageKey(secondUrl))
      ]);
      const stored = await e2e.getStorage(["hiddenRulesByPage"]);
      assert(Array.isArray(stored.hiddenRulesByPage?.[pageKey(firstUrl)]), "缺少第一标签规则");
      assert(Array.isArray(stored.hiddenRulesByPage?.[pageKey(secondUrl)]), "缺少第二标签规则");

      await Promise.all([
        e2e.navigate(mainPage, firstUrl),
        e2e.navigate(secondPage, secondUrl)
      ]);
      await Promise.all([
        waitVisible(mainPage, "document.querySelector('#unique-target')", false, "并发第一标签刷新规则"),
        waitVisible(secondPage, "document.querySelector('#unique-target')", false, "并发第二标签刷新规则")
      ]);
    } finally {
      activePage = mainPage;
      await e2e.closePage(secondPage);
    }
  });

  const failures = results.filter((result) => !result.ok);
  assert(results.length > 0, `没有测试名称匹配 --filter=${CASE_FILTER}`);
  console.log(`\nE2E 结果：${results.length - failures.length}/${results.length} 通过`);
  if (failures.length) {
    throw new AggregateError(failures.map((result) => result.error),
      `${failures.length} 个真实 Chrome E2E 场景失败：${failures.map((item) => item.name).join("、")}`);
  }
  return results;
}

async function main() {
  const crossServer = await startFixtureServer();
  const primaryServer = await startFixtureServer();
  const bootUrl = new URL("/index.html", primaryServer.origin);
  bootUrl.searchParams.set("case", "boot-before-extension-install");
  bootUrl.searchParams.set("crossOrigin", crossServer.origin);

  const artifactPath = await mkdtemp(join(tmpdir(), "annoy-killer-e2e-artifacts-"));
  let chromeEnvironment;
  let e2e;
  let browser;
  try {
    chromeEnvironment = await launchChrome(bootUrl.href);
    const version = await fetch(`http://127.0.0.1:${chromeEnvironment.port}/json/version`)
      .then((response) => response.json());
    browser = new CdpClient(version.webSocketDebuggerUrl, "Browser");
    await browser.open();

    const bootTarget = await waitFor(async () =>
      (await getHttpTargets(chromeEnvironment.port)).find((target) =>
        target.type === "page" && target.url === bootUrl.href),
    "扩展安装前已打开的测试页面", 10_000);

    const loaded = await browser.send("Extensions.loadUnpacked", { path: EXTENSION_PATH }, 15_000);
    const extensionId = loaded.id || loaded.extensionId;
    assert(extensionId, "Chrome 未返回扩展 ID");

    e2e = new ExtensionE2E({
      browser,
      chromeEnvironment,
      extensionId,
      optionsPage: null,
      primaryOrigin: primaryServer.origin,
      crossOrigin: crossServer.origin
    });
    const mainPage = await e2e.connectPage(bootTarget.id, "主测试标签页");
    await e2e.waitDocument(mainPage, bootUrl.href);

    const optionsUrl = `chrome-extension://${extensionId}/manifest.json`;
    const optionsPage = await e2e.openPage(optionsUrl, "扩展设置页", true);
    e2e.optionsPage = optionsPage;
    await waitFor(async () => evaluate(optionsPage, "Boolean(chrome.storage?.local)"), "扩展存储就绪");

    console.log(`Chrome: ${version.Browser}`);
    console.log(`扩展: ${extensionId}`);
    console.log(`主测试源: ${primaryServer.origin}`);
    console.log(`隔离测试源: ${crossServer.origin}`);
    const results = await runSuite(e2e, mainPage, artifactPath);
    await writeFile(join(artifactPath, "results.json"), `${JSON.stringify({
      chrome: version.Browser,
      extensionId,
      generatedAt: new Date().toISOString(),
      cases: results.map(({ name, ok, duration }) => ({ name, ok, duration }))
    }, null, 2)}\n`);
    console.log(`测试证据目录: ${artifactPath}`);
  } catch (error) {
    if (chromeEnvironment?.diagnostics()) {
      console.error(`\nChrome diagnostics:\n${chromeEnvironment.diagnostics()}`);
    }
    console.error(`\n${error.stack || error}`);
    console.error(`失败证据目录: ${artifactPath}`);
    process.exitCode = 1;
  } finally {
    await e2e?.close().catch(() => undefined);
    if (!e2e) {
      browser?.close();
    }
    await chromeEnvironment?.close().catch(() => undefined);
    await Promise.all([
      primaryServer.close().catch(() => undefined),
      crossServer.close().catch(() => undefined)
    ]);
  }
}

await main();
