# Clash Verge TUI Control

一个 TypeScript 终端 TUI，用于方便你只有 ssh 或 TTY 的情况下控制桌面端 Clash Verge Rev 切换节点。

> 本程序不是基于 Mihomo 的 TUI 客户端，而是用于在你已经安装了其他 Mihomo GUI 的情况下提供多一种应急控制方式。  


![运行效果](https://github.com/zyf2007/clash-verge-tui-control/blob/main/example.jpg)


支持以下功能：

- 查看策略组可选节点
- 显示每个节点的延迟
- 切换节点
- 一键切到 `DIRECT`（直连）

## 默认连接方式

默认使用 `auto` 自动发现：
- 先尝试 Unix Socket：`/tmp/verge/verge-mihomo.sock`
- 失败后再尝试 HTTP：`http://127.0.0.1:9090`
- 默认策略组：`🚀 节点选择`

## Clash Verge Rev 设置

如果要开启 HTTP 控制器（external-controller），需要配置：

```yaml
external-controller: 127.0.0.1:9090
secret: your-secret
```

然后运行时设置：

```bash
CLASH_BASE_URL=http://127.0.0.1:9090 CLASH_SECRET=your-secret npm run dev
```

## 安装与运行

```bash
npm i -g clash-verge-tui-control
clashtui
```

## 按键

- `↑ / ↓`：选择节点
- `Enter`：切换到选中节点
- `r`：刷新节点并测速（启动时默认不测速）
- `d`：切换到 `DIRECT`
- `q`：退出

## 环境变量

- `CLASH_UNIX_SOCKET`：Unix Socket 路径（默认 `/tmp/verge/verge-mihomo.sock`）
- `CLASH_BASE_URL`：HTTP 控制器地址（默认 `http://127.0.0.1:9090`）
- `CLASH_SECRET`：如果设置了 API secret，填这里
- `CLASH_SELECTOR`：策略组名称（默认 `🚀 节点选择`）
- `CLASH_TEST_URL`：测速 URL（默认 `https://www.gstatic.com/generate_204`）
- `CLASH_TIMEOUT_MS`：测速超时毫秒（默认 `5000`）
- `CLASH_CONCURRENCY`：并发测速数量（默认 `8`）

## 示例

## 命令行参数

- `--transport auto|unix|http`：强制指定传输方式（默认 `auto`）
- `--socket-path /path/to.sock`：覆盖 Unix Socket 路径
- `--base-url http://127.0.0.1:9090`：覆盖 HTTP 控制器地址
- `--secret your-secret`：覆盖 API secret

## 示例

强制用 HTTP：

```bash
clashtui --transport http --base-url http://127.0.0.1:9090 --secret your-secret
```

强制用 Unix Socket：

```bash
clashtui --transport unix --socket-path /tmp/verge/verge-mihomo.sock
```
