# Asterism 项目状态与开发笔记

> 更新时间：2026-08-21。本文档面向后续开发者（人或 AI session），记录当前架构、部署方式和进行中的工作。

## 项目是什么

面向单支 Puzzle Hunt 队伍的协作工具：Discord 消息单向同步到网站，网站内嵌 Excalidraw 白板。正在从「纯白板」演进为「Puzzle Hunt 作战中枢」。

## 核心数据模型（Discord 镜像）

```
Discord 服务器 (Guild)   →  Hunt        (hunts 表, guild_id 唯一)
  分类 (Category)        →  大题/meta   (categories 表)
    文字频道 (Channel)    →  小题        (puzzles 表, board_id 关联白板)
```

- 每个小题 = 频道讨论（消息侧栏）+ Excalidraw 白板 + 状态机（new/in_progress/stuck/solved）+ 答案 + 备注
- Round 概念已废弃删除（第一期遗留）
- 同步是幂等的：`/api/internal/sync/{guild,category,channel}`，Bot 在 guildCreate/channelCreate 和 /board 命令时调用
- **Bot 启动时自动回填**：遍历现有 guild 的分类/频道，把已有 board 映射的频道补建成题目（commit f281ad6）

## 架构

- `apps/app` — Fastify + better-sqlite3，API + 静态托管前端 + SSE 事件流
- `apps/bot` — discord.js Bot，消息同步 + 频道同步 + outbox 兜底
- `apps/room` — Excalidraw 官方协作协议（socket.io，AES-GCM 加密）
- `apps/web` — React 前端（Vite）
- `packages/shared` — 共享类型

## 部署（无 Docker）

- **App + Room**：在另一台服务器（hunt.lost-deviation.com → 175.178.199.125），systemd 用户 `asterism-app`，发布目录 `/opt/asterism/current`，env 在 `/etc/asterism/app.env`
- **Bot**：本机（VM-0-12-ubuntu），systemd 服务 `asterism-bot.service`，目录 `/opt/asterism-bot`，env 在 `/etc/asterism/bot.env`
- 部署命令（在各自服务器上）：`./deploy/deploy.sh [app|room|bot]`（build + rsync + systemctl restart，未安装的服务自动跳过）
- **部署顺序铁律：先 App 后 Bot**（新版 Bot 依赖 App 的 /api/internal/sync/* 路由）
- 本机 GitHub push 走 SSH key `~/.ssh/id_ed25519_github`（公钥已加到 XDeviation 账号）

## 开发验证

```bash
npm ci
npm run typecheck   # 全 workspace
npm test --workspace @asterism/app
```

## 已完成（2026-08-21，commit 至 f281ad6）

1. `70060b4` 白板协作者改名（localStorage 持久化）
2. `239cb84` Hunt 结构化第一期（hunts/rounds/puzzles）
3. `a8010c6` Discord 镜像重构（server=hunt, category=大题, channel=小题；删旧表重建——开发期策略，**结构稳定后需改为渐进式迁移**）
4. `2cce7b2` 无 Docker 部署脚本 `deploy/deploy.sh`
5. `1f759bb` 题目页（白板为主界面 + 顶部状态条 + 消息侧栏，路由 /puzzles/:puzzleId）
6. `f281ad6` 历史数据回填 + /boards/:id 自动跳题目页

## 进行中 / 待办

- **进行中**：入口合并 + 设计语言统一（Hunt 看板升为首页、白板列表退役、全站深色统一、状态徽章配色）
- 待部署：上述改造完成后，App 服务器跑 `cd ~/Asterism && git pull && sudo ./deploy/deploy.sh app room`
- **轻量提取表**：TanStack Table + Yjs 协同，挂题目页底部抽屉（用户已认可方案，拒绝 Univer——体积/部署太重，拒绝经典密码学小工具——觉得没用）
- 解题小工具：等用户描述真实痛点再定
- 撒花动效：解出答案庆祝（用户认可但不急）
- 技术债：数据库删表重建式迁移要改渐进式；大题（Category）自己的白板入口

## 用户偏好备忘

- 单队自用，不要注册/多账户系统；登录保持现有全站密码（Google OAuth 已否决——服务器在中国境内）
- 白板是核心，一切页面以白板为主体
- Discord 结构是天然分类，数据从 Discord 自动镜像，不做手动录入
- 讨论就在每个小题频道里，无独立讨论区
