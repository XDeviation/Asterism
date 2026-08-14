# Asterism

Asterism 是一个面向单支 Puzzle Hunt 队伍的轻量协作白板：Discord Bot
负责创建画布并把频道消息单向同步到网站，网站内嵌
[Excalidraw](https://github.com/excalidraw/excalidraw)，并提供统一密码、画布索引和
只读消息侧栏。

## 功能范围

- 一个 Discord 文字频道或 Thread 对应一张固定白板。
- `/board` 幂等创建或返回画布；首次创建回填最近 200 条消息。
- 实时同步普通消息、编辑、删除、回复摘要、Discord Markdown 和图片。
- 图片直接使用 Discord 的签名 CDN URL，不在本机保存；Bot 会定时刷新 URL。
- Excalidraw 画布支持插入、粘贴图片，场景和图片由 App 持久化。
- 多个浏览器通过官方 `excalidraw-room` 协议实时同步画布，房间消息使用
  AES-GCM 加密，元素按 Excalidraw 的版本规则合并。
- App 不可用时，Bot 使用 SQLite outbox 持久化待投递事件。
- Bot 重启后从 App 的最后同步 Snowflake 继续补拉新增消息。
- 全站统一密码、14 天安全 Cookie、登录限速。
- 首页按 Discord Category 分组，并支持频道名筛选。

不在 MVP 中：网站向 Discord 发消息、非图片附件、reaction、贴纸、投票、
Discord Embed、多队伍权限、管理后台、自动清理、导出和整板 Clear。

## 架构

```text
浏览器 ──HTTPS──────> App（Excalidraw 前端、SQLite 持久化）
   └────WebSocket──> Room（官方 Excalidraw 协作协议）
                         ▲
                         │ 带服务令牌的 HTTPS API
Discord Gateway <────── Bot
```

App、Room 和画布数据部署在同一侧；Bot 可以部署在另一台服务器。Room 只转发
端到端加密的增量消息，App 的 SQLite 负责长期持久化。Bot 只保存频道映射及
outbox SQLite，两者不共享文件。

## 部署 App

要求：Docker Compose、一个指向服务器的域名，以及支持长连接的 HTTPS 反向代理。

1. 复制 App 配置：

   ```bash
   cp deploy/.env.app.example deploy/.env.app
   ```

2. 生成两个互不相同的随机值，分别填写 `SESSION_SECRET` 和
   `BOT_SERVICE_TOKEN`：

   ```bash
   openssl rand -hex 32
   ```

3. 安装依赖后生成全站密码的 Argon2id 哈希。以下方式不会把密码写入 shell
   历史；将输出完整复制到 `SITE_PASSWORD_HASH`，并保留单引号：

   ```bash
   read -sr ASTERISM_PASSWORD
   export ASTERISM_PASSWORD
   npm ci
   npm run hash-password
   unset ASTERISM_PASSWORD
   ```

4. 修改 `PUBLIC_URL` 后启动：

   ```bash
   docker compose -f deploy/compose.app.yml up -d --build
   ```

App 仅监听宿主机 `127.0.0.1:3000`，Room 仅监听 `127.0.0.1:3002`。外部
Nginx 需要关闭长连接响应缓冲、代理 `/socket.io/`，并允许画布图片请求体。
仓库内的 Nginx 配置还会通过 App 登录 Cookie 保护 Room 握手。

```nginx
location / {
    client_max_body_size 25m;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
}

location /socket.io/ {
    auth_request /_asterism_auth;
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $hunt_connection_upgrade;
    proxy_buffering off;
}
```

## 创建并部署 Discord Bot

1. 在 [Discord Developer Portal](https://discord.com/developers/applications)
   创建应用和 Bot。
2. 在 Bot 设置中启用 **Message Content Intent**。
3. 用 `bot` 与 `applications.commands` scope 邀请 Bot，并授予：
   View Channels、Send Messages、Read Message History。
4. 打开 Developer Mode，复制队伍 Server ID。
5. 在 Bot 服务器上复制并填写配置：

   ```bash
   cp deploy/.env.bot.example deploy/.env.bot
   ```

   `BOT_SERVICE_TOKEN` 必须与 App 完全相同，`APP_API_URL` 必须是 App 的公网
   HTTPS origin。

6. 独立启动 Bot：

   ```bash
   docker compose -f deploy/compose.bot.yml up -d --build
   ```

Bot 上线后会把 `/board` 注册为 guild-scoped command，通常立即可见。在任何
文字频道或 Thread 执行它即可。

## 配置参考

App：

| 变量 | 用途 |
| --- | --- |
| `PUBLIC_URL` | 网站公网 HTTPS origin |
| `SITE_PASSWORD_HASH` | Argon2id 密码哈希 |
| `SESSION_SECRET` | Cookie 签名密钥，至少 32 字符 |
| `BOT_SERVICE_TOKEN` | Bot 调用内部 API 的 Bearer token，至少 32 字符 |
| `COOKIE_SECURE` | 生产保持 `true`；本地 HTTP 才设 `false` |
| `TRUST_PROXY` | 可信反向代理跳数；单层 Nginx 设为 `1`，公网部署不要设为 `true` |
| `DATABASE_PATH` | App SQLite 路径 |

Bot：

| 变量 | 用途 |
| --- | --- |
| `DISCORD_TOKEN` | Discord Bot token |
| `DISCORD_GUILD_ID` | 唯一允许的队伍 Server |
| `APP_API_URL` | App 公网 origin |
| `BOT_SERVICE_TOKEN` | 与 App 相同的服务令牌 |
| `BOT_DATABASE_PATH` | Bot SQLite/outbox 路径 |
| `IMAGE_REFRESH_INTERVAL_MS` | CDN URL 刷新周期，默认 4 小时 |

## 本地开发与验证

项目要求 Node.js 22 或更高版本。

```bash
npm ci
npm run typecheck
npm test
npm run build
```

开发时可分别运行 `npm run dev:app`、`npm run dev:web`、`npm run dev:room`
和 `npm run dev:bot`。App 需要配置上述环境变量；本地 HTTP 环境应设置
`COOKIE_SECURE=false`。

## 数据与运维

- `app-data` 保存 Excalidraw 场景、房间密钥、画布图片、频道映射和 Discord 消息。
- `bot-data` 保存 Bot 频道映射和未投递 outbox。
- 从旧 WBO 部署升级时，频道映射和消息会继续使用，但原 WBO SVG 不会自动转换；
  对应 Excalidraw 画布会从空场景开始。旧 `wbo-data` volume 不会被 Compose 自动删除。
- 系统不自动删除数据。Hunt 结束后先停止服务并备份相应 Docker volumes，
  再由运维决定是否清理。
- 修改 `SITE_PASSWORD_HASH` 会让现有登录会话全部失效。
- 修改 `BOT_SERVICE_TOKEN` 时应先更新 App，再立即更新 Bot；期间事件会留在
  Bot outbox 中重试。

## 许可证

本仓库使用 GPLv3。Excalidraw 以 MIT 许可证作为前端依赖使用；详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
