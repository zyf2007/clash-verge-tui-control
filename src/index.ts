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

const DEFAULT_SELECTOR = process.env.CLASH_SELECTOR ?? "🚀 节点选择";
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

type UiState = {
  loading: boolean;
  error: string | null;
  controller: string;
  selectorName: string;
  selectedIndex: number;
  selectorCurrent: string | null;
  nodes: string[];
  delays: DelayMap;
  switching: boolean;
  message: string;
  lastOperationResult: string; // 记录最后操作结果
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
  selectorName: DEFAULT_SELECTOR,
  selectedIndex: 0,
  selectorCurrent: null,
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
  const subtitle = `${color.dim}selector:${color.reset} ${state.selectorName}  ${color.dim}current:${color.reset} ${state.selectorCurrent ?? "-"}`;
  const connLine = `${color.dim}controller:${color.reset} ${state.controller}`;
  process.stdout.write(`${header}\n${subtitle}\n\n`);
  process.stdout.write(`${connLine}\n\n`);

  if (state.error) {
    process.stdout.write(`${color.red}错误: ${state.error}${color.reset}\n\n`);
  }

  if (state.loading) {
    process.stdout.write("加载中...\n");
  } else {
    const maxRows = Math.max(10, process.stdout.rows - 9);
    const start = Math.max(0, Math.min(state.selectedIndex - Math.floor(maxRows / 2), Math.max(0, state.nodes.length - maxRows)));
    const end = Math.min(state.nodes.length, start + maxRows);

    for (let i = start; i < end; i += 1) {
      const node = state.nodes[i];
      const selected = i === state.selectedIndex;
      const current = node === state.selectorCurrent;
      const cursor = selected ? `${color.cyan}>${color.reset}` : " ";
      const currentMark = current ? `${color.green}*${color.reset}` : " ";
      const delay = fmtDelay(state.delays.get(node));
      process.stdout.write(`${cursor}${currentMark} ${node}  ${delay}\n`);
    }
    
    const emptyLines = Math.max(0, maxRows - (end - start));
    for (let i = 0; i < emptyLines; i++) {
      process.stdout.write("\n");
    }
  }

  process.stdout.write(
    `\n ${color.dim}↑(j)/↓(k):选择  Enter(l):切换  r:测速并刷新  d:DIRECT  esc(q):退出\n${color.reset} ${state.switching ? "切换中..." : state.message}`
  );
  
  process.stdout.write("\x1b[0J");
}

async function refreshData(withDelayTest: boolean): Promise<void> {
  if (inFlightRefresh) return;
  if (!client) return;
  const api = client;
  inFlightRefresh = true;
  state.loading = true;
  state.error = null;
  state.message = withDelayTest ? "刷新节点并测速..." : "刷新节点...";
  render();

  try {
    const all = await api.getProxies();
    const selector = all.proxies[state.selectorName];
    if (!selector || !selector.all) {
      throw new Error(`找不到策略组: ${state.selectorName}`);
    }

    state.nodes = selector.all;
    state.selectorCurrent = selector.now ?? null;

    if (state.selectedIndex >= state.nodes.length) {
      state.selectedIndex = Math.max(0, state.nodes.length - 1);
    }

    const delays = new Map<string, number | null>();
    if (withDelayTest) {
      const workers: Promise<void>[] = [];
      let cursor = 0;
      const workerCount = Number.isFinite(DEFAULT_CONCURRENCY)
        ? Math.max(1, DEFAULT_CONCURRENCY)
        : 8;

      const runWorker = async (): Promise<void> => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= state.nodes.length) {
            return;
          }

          const node = state.nodes[index];
          if (node === "REJECT" || node === "REJECT-DROP") {
            delays.set(node, null);
            continue;
          }

          const d = await api.getDelay(node, DEFAULT_TIMEOUT, DEFAULT_TEST_URL);
          delays.set(node, d);
          state.delays = delays;
          render();
        }
      };

      for (let i = 0; i < workerCount; i += 1) {
        workers.push(runWorker());
      }
      await Promise.all(workers);
    }

    state.delays = delays;
    state.loading = false;
    const resultMsg = withDelayTest
      ? `已刷新 ${state.nodes.length} 个选项并完成测速`
      : `已加载 ${state.nodes.length} 个选项（未测速，按 r 开始）`;
    state.message = resultMsg;
    state.lastOperationResult = resultMsg; // 记录操作结果
  } catch (err) {
    state.loading = false;
    state.error = err instanceof Error ? err.message : String(err);
    state.message = "刷新失败";
    state.lastOperationResult = `刷新失败: ${state.error}`; // 记录错误结果
  } finally {
    inFlightRefresh = false;
    render();
  }
}

async function switchTo(nodeName: string): Promise<void> {
  if (inFlightSwitch) return;
  if (!client) return;
  const api = client;
  inFlightSwitch = true;
  state.switching = true;
  state.error = null;
  state.message = `切换到 ${nodeName}...`;
  render();

  try {
    await api.selectNode(state.selectorName, nodeName);
    state.selectorCurrent = nodeName;
    const resultMsg = `已切换到 ${nodeName}`;
    state.message = resultMsg;
    state.lastOperationResult = resultMsg; // 记录切换成功结果
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.message = "切换失败";
    state.lastOperationResult = `切换失败: ${state.error}`; // 记录切换失败结果
  } finally {
    state.switching = false;
    inFlightSwitch = false;
    render();
  }
}

function setupInput(): void {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (key: string) => {
    // ESC 退出 (\u001b 是 ESC 字符)
    if (key === "\u001b" || key === "\u0003" || key === "q") {
      cleanupAndExit(0);
      return;
    }

    // 向上：↑ 或 k (Vim 风格)
    if (key === "\u001b[A" || key === "k") {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      render();
      return;
    }

    // 向下：↓ 或 j (Vim 风格)
    if (key === "\u001b[B" || key === "j") {
      state.selectedIndex = Math.min(state.nodes.length - 1, state.selectedIndex + 1);
      render();
      return;
    }

    // 选中：Enter 或 l (Vim 风格)
    if (key === "\r" || key === "l") {
      const node = state.nodes[state.selectedIndex];
      if (node) {
        void switchTo(node);
      }
      return;
    }

    if (key === "r") {
      void refreshData(true);
      return;
    }

    if (key === "d") {
      void switchTo("DIRECT");
    }
  });
}

function cleanupAndExit(code: number): void {
  // 恢复终端状态
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  // 退出备用屏幕，恢复到之前的终端状态
  process.stdout.write("\x1b[?1049l");
  // 显示光标
  process.stdout.write("\x1b[?25h");

  // 打印最后操作结果
  if (state.lastOperationResult) {
    process.stdout.write(`${state.lastOperationResult}\n`);
  }

  process.exit(code);
}

process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));

async function detectClient(opts: CliOptions): Promise<{ client: ClashClient; label: string }> {
  const unixConfig = buildUnixConfig(opts);
  const httpConfig = buildHttpConfig(opts);

  const tryClient = async (
    cfg: ControllerConfig,
    label: string,
  ): Promise<{ client: ClashClient; label: string } | null> => {
    const c = new ClashClient(cfg);
    try {
      await c.getProxies();
      return { client: c, label };
    } catch {
      return null;
    }
  };

  if (opts.transport === "unix") {
    const r = await tryClient(unixConfig, `unix:${opts.socketPath}`);
    if (!r) throw new Error(`无法连接 Unix Socket: ${opts.socketPath}`);
    return r;
  }

  if (opts.transport === "http") {
    const r = await tryClient(httpConfig, `http:${opts.baseUrl}`);
    if (!r) throw new Error(`无法连接 HTTP 控制器: ${opts.baseUrl}`);
    return r;
  }

  const unixFirst = await tryClient(unixConfig, `unix:${opts.socketPath}`);
  if (unixFirst) return unixFirst;

  const httpSecond = await tryClient(httpConfig, `http:${opts.baseUrl}`);
  if (httpSecond) return httpSecond;

  throw new Error(
    `自动发现失败：Unix(${opts.socketPath}) 和 HTTP(${opts.baseUrl}) 都无法连接`,
  );
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("This TUI requires a TTY terminal.");
    process.exit(1);
  }

  // 进入备用屏幕
  process.stdout.write("\x1b[?1049h");
  // 隐藏光标
  process.stdout.write("\x1b[?25l");

  const opts = parseCliOptions();
  setupInput();
  state.message = "检测控制器连接...";
  render();
  try {
    const detected = await detectClient(opts);
    client = detected.client;
    state.controller = detected.label;
    state.message = "连接成功";
    state.lastOperationResult = `成功连接到 ${detected.label}`;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.message = "连接失败";
    state.lastOperationResult = `连接失败: ${state.error}`;
    render();
    // 延迟退出，让用户看到错误信息
    setTimeout(() => cleanupAndExit(1), 2000);
    return;
  }

  await refreshData(false);
}

void main();