# 隔离 New API 协议测试部署

## 实测部署记录

该实例只用于协议侦察，不连接生产数据库、生产用户或生产渠道。

| 项目 | 实测值 |
|---|---|
| 部署时间 | 2026-07-28T20:17:43Z |
| 页面 / OCI 版本 | `v1.0.0-rc.22` |
| 源码 Revision | `bc14c18f6024e79cba1c08d02cd007796e12d668` |
| 镜像 | `calciumion/new-api:latest`（拉取后按下列 Digest 固定） |
| 镜像 Digest | `sha256:d600f20c2781e1a173c2a02f8c33b0c4b1b4e8e5a8b107bafaf2442ae2c9386c` |
| 网络绑定 | `127.0.0.1:3100:3000` |
| 启动参数 | `--log-dir /app/logs` |
| 数据目录 | `/opt/acu-protocol-recon/new-api/data` |
| 日志目录 | `/opt/acu-protocol-recon/new-api/logs` |
| 数据库 | 实例独立 SQLite；未配置外部数据库或 Redis |
| 缓存 | `MEMORY_CACHE_ENABLED=false` |
| Failure Retry Count | 基线 `0`；仅 Retry 对照 Fixture 临时设为 `1`，随后恢复为 `0` |

容器通过单容器方式启动，因为该主机没有 Docker Compose 插件。等价且可审计的启动模板位于 `tools/protocol-capture/new-api/docker-run.example.sh`。模板要求使用不可变 Digest，只绑定 loopback，并把数据和日志挂载到独立目录。

## 账户与 Secret 边界

初始化了独立测试管理员、测试用户和测试 Token。真实密码、访问 Token、渠道 Key 仅保存在服务器本地 mode `0600` 文件 `/opt/acu-protocol-recon/new-api/secrets.env`，不在本文、Fixture、容器参数或 Git 中出现。Fixture 只保留确定性占位符。

## 渠道与 Capture 插入方式

New API 渠道 Base URL 指向仅在 Docker bridge 地址监听的 Capture B；Capture B 再透明转发到测试 ACU、CloseAI 或受控 Mock。客户端连接 loopback Capture A，Capture A 转发到 New API。Capture 不修改 Path、Query、Header、Body 或响应字节。

测试渠道包括 CloseAI OpenAI、CloseAI Anthropic、当前 ACU、受控 Responses Mock 和受控 Messages Mock。Mock 结论只用于 Retry/错误所有权，不声明真实 Provider 兼容。

## 重建步骤

1. 在仓库外创建独立数据、日志和 mode `0600` 环境文件。
2. 将已审计的镜像 Digest 和随机测试 Secret 写入本地环境。
3. 运行启动模板并确认 `docker port` 只显示 `127.0.0.1:3100`。
4. 通过页面完成一次性管理员初始化，创建测试用户和 Token。
5. 将 Retry 设为 `0`、关闭缓存，再创建仅指向 Capture B 的隔离渠道。
6. 记录容器 `Created`、OCI Labels、Digest 和页面版本；不得记录 Secret 值。
