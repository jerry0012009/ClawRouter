# ACU 原生协议侦察运行手册

> 状态：执行基线  
> 适用分支：`productization/protocol-recon-v1`

## 安全边界

- 原始抓包只能写入仓库外目录，默认建议 `/var/lib/acu-protocol-captures/`，本地开发可用被 Git 忽略的 `.protocol-captures-raw/`。
- 仓库内只允许提交确定性脱敏后的 Fixture。
- 不打印、记录或提交真实 API Key、Authorization、Cookie、账户身份或私人项目内容。
- 采集代理只转发和记录；不运行 Judge、不路由、不修复协议、不注入正文。
- 真实测试只使用 `test/protocol-sandbox/`，不对生产项目运行 Coding Agent。

## 多采集点拓扑

根据部署权限分别启动实例，实例之间仍保持原始 HTTP/SSE 字节流：

```text
Codex / Claude Code
  -> Capture A -> New API
  -> Capture B -> ACU
  -> Capture C -> Provider
  -> Capture D (响应观察，可与对应请求实例合并记录)
```

每个实例设置独立的 `PROTOCOL_CAPTURE_PORT`、`PROTOCOL_CAPTURE_POINT` 和 `PROTOCOL_CAPTURE_UPSTREAM`。无法插入的采集点必须在 Fixture manifest 中省略，并把 `capture_status` 标为 `partial` 或 `blocked`。

## 环境准备

1. 复制 `.env.protocol-recon.example` 为 `.env.protocol-recon`。
2. 使用可丢弃 New API 用户、Key 和余额；不要使用生产用户。
3. 确认 New API 渠道 Base URL 可指向 Capture B，ACU Provider Base URL 可指向 Capture C。
4. 将 `PROTOCOL_CAPTURE_DIR` 指向仓库外且权限受限的目录。
5. 固定客户端、New API、ACU、Provider、模型和操作系统版本。
6. 每次运行前重置 `test/protocol-sandbox/`。

## 事实标记

- 只有原生 Codex / Claude Code 实际产生且能追溯到脱敏 Fixture 的行为可写为“实测确认”。
- Mock Provider 只证明客户端和 Harness 行为，不能证明真实 Provider 兼容。
- 缺少客户端、凭证、余额、部署权限或日志权限时标记“未执行/阻塞”，不补写推断结果。
