#!/usr/bin/env node

import { request as httpRequest } from "node:http";
import process from "node:process";
import { URL } from "node:url";

type ProxyNode = {
  name: string;
  type: string;
  all?: string[];
  now?: string;
};

type ProxiesResponse = {
  proxies: Record<string, ProxyNode>;
};

type DelayResult = {
  delay: number;
};

type DelayMap = Map<string, number | null>;

type TransportMode = "auto" | "unix" | "http";

type UnixControllerConfig = {
  mode: "unix";
  socketPath: string;
  secret?: string;
};

type HttpControllerConfig = {
  mode: "http";
  baseUrl: string;
  secret?: string;
};

type ControllerConfig = UnixControllerConfig | HttpControllerConfig;

const DEFAULT_TEST_URL =
  process.env.CLASH_TEST_URL ?? "https://www.gstatic.com/generate_204";
const DEFAULT_TIMEOUT = Number.parseInt(process.env.CLASH_TIMEOUT_MS ?? "5000", 10);
const DEFAULT_CONCURRENCY = Number.parseInt(process.env.CLASH_CONCURRENCY ?? "8", 10);
const DEFAULT_BASE_URL = process.env.CLASH_BASE_URL ?? "http://127.0.0.1:9090";
const DEFAULT_SOCKET = process.env.CLASH_UNIX_SOCKET ?? "/tmp/verge/verge-mihomo.sock";
const SECRET = process.env.CLASH_SECRET;

type CliOptions = {
  transport: TransportMode;
  baseUrl: string;
  socketPath: string;
  secret?: string;
};

function parseCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  const argMap = new Map<string, string>();

  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith("--")) continue;
    const val = args[i + 1];
    if (!val || val.startsWith("--")) {
      argMap.set(key, "");
      continue;
    }
    argMap.set(key, val);
    i += 1;
  }

  const transportArg = argMap.get("--transport");
  const transport: TransportMode =
    transportArg === "unix" || transportArg === "http" || transportArg === "auto"
      ? transportArg
      : "auto";

  return {
    transport,
    baseUrl: argMap.get("--base-url") || DEFAULT_BASE_URL,
    socketPath: argMap.get("--socket-path") || DEFAULT_SOCKET,
    secret: argMap.get("--secret") || SECRET,
  };
}

function buildUnixConfig(opts: CliOptions): UnixControllerConfig {
  return {
    mode: "unix",
    socketPath: opts.socketPath,
    secret: opts.secret,
  };
}

function buildHttpConfig(opts: CliOptions): HttpControllerConfig {
  return {
    mode: "http",
    baseUrl: opts.baseUrl,
    secret: opts.secret,
  };
}

class ClashClient {
  constructor(private readonly config: ControllerConfig) {}

  async getProxies(): Promise<ProxiesResponse> {
    return this.requestJson<ProxiesResponse>("GET", "/proxies");
  }

  async getDelay(name: string, timeoutMs: number, testUrl: string): Promise<number | null> {
    const path =
      "/proxies/" +
      encodeURIComponent(name) +
      `/delay?timeout=${encodeURIComponent(String(timeoutMs))}&url=${encodeURIComponent(testUrl)}`;

    try {
      const body = await this.requestJson<DelayResult>("GET", path);
      return Number.isFinite(body.delay) ? body.delay : null;
    } catch {
      return null;
    }
  }

  async selectNode(selector: string, nodeName: string): Promise<void> {
    await this.requestJson("PUT", `/proxies/${encodeURIComponent(selector)}`, {
      name: nodeName,
    });
  }

  private async requestJson<T = unknown>(
    method: "GET" | "PUT",
    path: string,
    payload?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    let body: string | undefined;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }

    if (this.config.secret && this.config.secret !== "set-your-secret") {
      headers.Authorization = `Bearer ${this.config.secret}`;
    }

    const responseText = await new Promise<string>((resolve, reject) => {
      const req =
        this.config.mode === "http"
          ? (() => {
              const url = new URL(path, this.config.baseUrl);
              return httpRequest(
                {
                  protocol: url.protocol,
                  hostname: url.hostname,
                  port: url.port,
                  method,
                  path: `${url.pathname}${url.search}`,
                  headers,
                },
                (res) => {
                  const chunks: Buffer[] = [];
                  res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                  res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if ((res.statusCode ?? 500) >= 400) {
                      reject(new Error(`HTTP ${res.statusCode}: ${text}`));
                      return;
                    }
                    resolve(text);
                  });
                },
              );
            })()
          : httpRequest(
              {
                socketPath: this.config.socketPath,
                method,
                path,
                headers,
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                res.on("end", () => {
                  const text = Buffer.concat(chunks).toString("utf8");
                  if ((res.statusCode ?? 500) >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${text}`));
                    return;
                  }
                  resolve(text);
                });
              },
            );

      req.on("error", reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });

    if (!responseText) {
      return {} as T;
    }
    return JSON.parse(responseText) as T;
  }
}

type ViewMode = "selector" | "node";

type UiState = {
  loading: boolean;
  error: string | null;
  controller: string;
  viewMode: ViewMode;

  selectorList: string[];
  selectorIndex: number;

  selectorName: string | null;
  selectorCurrent: string | null;
  nodeIndex: number;
  nodes: string[];
  delays: DelayMap;

  switching: boolean;
  message: string;
  lastOperationResult: string;
};

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
};

const state: UiState = {
  loading: true,
  error: null,
  controller: "-",
  viewMode: "selector",

  selectorList: [],
  selectorIndex: 0,

  selectorName: null,
  selectorCurrent: null,
  nodeIndex: 0,
  nodes: [],
  delays: new Map(),

  switching: false,
  message: "初始化中...",
  lastOperationResult: "",
};

let client: ClashClient | null = null;
let inFlightRefresh = false;
let inFlightSwitch = false;

function clearAndHome(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

function fmtDelay(v: number | null | undefined): string {
  if (v === undefined) return `${color.dim}--${color.reset}`;
  if (v === null) return `${color.dim}timeout${color.reset}`;
  if (v < 120) return `${color.green}${v}ms${color.reset}`;
  if (v < 300) return `${color.yellow}${v}ms${color.reset}`;
  return `${color.red}${v}ms${color.reset}`;
}

function render(): void {
  clearAndHome();
  const header = `${color.bold}${color.cyan}Clash Node TUI${color.reset}`;
  process.stdout.write(`${header}\n\n`);

  const connLine = `${color.dim}controller:${color.reset} ${state.controller}`;
  process.stdout.write(`${connLine}\n\n`);

  if (state.error) {
    process.stdout.write(`${color.red}错误: ${state.error}${color.reset}\n\n`);
  }

  if (state.viewMode === "selector") {
    process.stdout.write(`${color.bold}请选择策略组：${color.reset}\n\n`);
    for (let i = 0; i < state.selectorList.length; i++) {
      const sel = state.selectorList[i];
      const cursor = i === state.selectorIndex ? `${color.cyan}>${color.reset}` : " ";
      process.stdout.write(`${cursor} ${sel}\n`);
    }
    process.stdout.write(`\n${color.dim}↑/↓选择 · Enter确认 · q/ESC退出${color.reset}`);
  } else {
    const selName = state.selectorName ?? "?";
    const current = state.selectorCurrent ?? "-";
    process.stdout.write(`${color.dim}策略组:${color.reset} ${selName}  ${color.dim}当前:${color.reset} ${current}\n\n`);

    if (state.loading) {
      process.stdout.write("加载中...\n");
    } else {
      const maxRows = Math.max(10, process.stdout.rows - 10);
      const start = Math.max(0, Math.min(state.nodeIndex - Math.floor(maxRows / 2), Math.max(0, state.nodes.length - maxRows)));
      const end = Math.min(state.nodes.length, start + maxRows);

      for (let i = start; i < end; i++) {
        const node = state.nodes[i];
        const selected = i === state.nodeIndex;
        const isCurrent = node === state.selectorCurrent;
        const cursor = selected ? `${color.cyan}>${color.reset}` : " ";
        const star = isCurrent ? `${color.green}*${color.reset}` : " ";
        const delay = fmtDelay(state.delays.get(node));
        process.stdout.write(`${cursor}${star} ${node}  ${delay}\n`);
      }

      const empty = Math.max(0, maxRows - (end - start));
      for (let i = 0; i < empty; i++) process.stdout.write("\n");
    }

    process.stdout.write(`\n ${color.dim}↑(j)/↓(k):选择  Enter(l):切换  r:测速  d:DIRECT  b:返回策略组  esc(q):退出\n${color.reset}`);
    process.stdout.write(` ${state.switching ? "切换中..." : state.message}`);
  }

  process.stdout.write("\x1b[0J");
}

async function loadSelectorList() {
  if (!client) return;
  state.loading = true;
  state.message = "获取策略组列表...";
  render();

  try {
    const res = await client.getProxies();
    const all = res.proxies;
    const selectors = Object.entries(all)
      .filter(([_, p]) => p.type === "Selector" && Array.isArray(p.all))
      .map(([n]) => n);
    state.selectorList = selectors;
    state.selectorIndex = 0;
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    render();
  }
}

async function enterSelector(selectorName: string) {
  state.viewMode = "node";
  state.selectorName = selectorName;
  state.nodeIndex = 0;
  state.nodes = [];
  state.delays.clear();
  await refreshNodes(false);
}

async function refreshNodes(withDelay: boolean) {
  if (inFlightRefresh || !client || !state.selectorName) return;
  inFlightRefresh = true;
  state.loading = true;
  state.message = withDelay ? "刷新并测速..." : "刷新节点...";
  render();

  try {
    const res = await client.getProxies();
    const sel = res.proxies[state.selectorName];
    if (!sel || !sel.all) throw new Error("无效策略组");

    state.nodes = sel.all;
    state.selectorCurrent = sel.now ?? null;

    if (state.nodeIndex >= state.nodes.length) {
      state.nodeIndex = Math.max(0, state.nodes.length - 1);
    }

    if (withDelay) {
      const delays = new Map<string, number | null>();
      const concurrency = Math.max(1, DEFAULT_CONCURRENCY);
      let cursor = 0;

      const worker = async () => {
        while (cursor < state.nodes.length) {
          const i = cursor++;
          const node = state.nodes[i];
          if (node.startsWith("REJECT")) {
            delays.set(node, null);
            continue;
          }
          const d = await client!.getDelay(node, DEFAULT_TIMEOUT, DEFAULT_TEST_URL);
          delays.set(node, d);
          state.delays = new Map(delays);
          render();
        }
      };

      await Promise.all(Array.from({ length: concurrency }, worker));
      state.delays = delays;
    }

    state.message = withDelay ? "测速完成" : "节点已加载";
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.loading = false;
    inFlightRefresh = false;
    render();
  }
}

async function switchToNode(name: string) {
  if (inFlightSwitch || !client || !state.selectorName) return;
  inFlightSwitch = true;
  state.switching = true;
  state.message = `切换到 ${name}...`;
  render();

  try {
    await client.selectNode(state.selectorName, name);
    state.selectorCurrent = name;
    state.message = `已切换至 ${name}`;
    state.lastOperationResult = state.message;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    state.message = "切换失败";
  } finally {
    state.switching = false;
    inFlightSwitch = false;
    render();
  }
}

function setupInput() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (chunk) => {
    const key = String(chunk);

    if (key === "\u001b" || key === "\u0003" || key === "q") {
      cleanupAndExit(0);
      return;
    }

    if (state.viewMode === "selector") {
      if (key === "\u001b[A" || key === "k") {
        state.selectorIndex = Math.max(0, state.selectorIndex - 1);
        render();
      } else if (key === "\u001b[B" || key === "j") {
        state.selectorIndex = Math.min(state.selectorList.length - 1, state.selectorIndex + 1);
        render();
      } else if (key === "\r" || key === "l") {
        const sel = state.selectorList[state.selectorIndex];
        if (sel) void enterSelector(sel);
      }
      return;
    }

    if (key === "b") {
      state.viewMode = "selector";
      state.error = null;
      render();
      return;
    }

    if (key === "\u001b[A" || key === "k") {
      state.nodeIndex = Math.max(0, state.nodeIndex - 1);
      render();
    } else if (key === "\u001b[B" || key === "j") {
      state.nodeIndex = Math.min(state.nodes.length - 1, state.nodeIndex + 1);
      render();
    } else if (key === "\r" || key === "l") {
      const node = state.nodes[state.nodeIndex];
      if (node) void switchToNode(node);
    } else if (key === "r") {
      void refreshNodes(true);
    } else if (key === "d") {
      void switchToNode("DIRECT");
    }
  });
}

function cleanupAndExit(code: number) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[?1049l\x1b[?25h");
  if (state.lastOperationResult) {
    process.stdout.write(`${state.lastOperationResult}\n`);
  }
  process.exit(code);
}

process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));

async function detectClient(opts: CliOptions) {
  const unixCfg = buildUnixConfig(opts);
  const httpCfg = buildHttpConfig(opts);

  const test = async (cfg: ControllerConfig, label: string) => {
    const c = new ClashClient(cfg);
    try {
      await c.getProxies();
      return { client: c, label };
    } catch {
      return null;
    }
  };

  if (opts.transport === "unix") {
    const r = await test(unixCfg, `unix:${opts.socketPath}`);
    if (!r) throw new Error("Unix 连接失败");
    return r;
  }
  if (opts.transport === "http") {
    const r = await test(httpCfg, `http:${opts.baseUrl}`);
    if (!r) throw new Error("HTTP 连接失败");
    return r;
  }

  const u = await test(unixCfg, `unix:${opts.socketPath}`);
  if (u) return u;
  const h = await test(httpCfg, `http:${opts.baseUrl}`);
  if (h) return h;
  throw new Error("无法连接到 Clash 控制器");
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Requires TTY terminal");
    process.exit(1);
  }

  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const opts = parseCliOptions();
  setupInput();
  render();

  try {
    const conn = await detectClient(opts);
    client = conn.client;
    state.controller = conn.label;
    state.lastOperationResult = `已连接：${conn.label}`;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    render();
    setTimeout(() => cleanupAndExit(1), 2000);
    return;
  }

  await loadSelectorList();
}

void main();
