# TaskFlow 生产部署计划

## 1. 功能目的

**问题**：当前后端只在 Mac 本地运行（`localhost:3000`），离开开发环境后 iPhone 无法访问。

**目标**：将后端部署到一台持续在线的机器上，让 iPhone（通过 Capacitor App）和浏览器都能随时随地使用 TaskFlow。

**范围边界**：
- 本次只涉及后端 + 数据库 + Nginx 的生产部署
- 前端构建在 macOS 本地完成（`npm run ios`），只是把 `VITE_API_URL` 指向部署后的服务器
- 不涉及 CI/CD、监控、日志收集等高级运维

---

## 2. TodoList

| ID | 任务 | 说明 |
|----|------|------|
| `fix-docker-prisma` | 修复 Dockerfile 中 Prisma 迁移所需的文件缺失 | 当前 runner 阶段缺少 migrations 目录和 prisma CLI |
| `self-host-plan` | 制定「自有电脑 24h 部署」方案 | 含公网访问、动态 IP 处理、HTTPS、端口映射 |
| `cloud-host-plan` | 制定「云服务器部署」方案 | 含服务器选购、安全组、域名、HTTPS |
| `docker-compose-fix` | 修复 docker-compose.yml 中的 schema 路径问题 | `--schema=prisma/schema.prisma` vs 实际路径 |
| `ios-rebuild-guide` | 编写 iPhone 重新构建指南 | 部署完成后如何让 App 指向新服务器 |
| `update-doc` | 更新 TUTORIAL.md 添加部署章节 | 将两个方案写入教程，提供完整操作步骤 |

---

## 3. 具体执行方案

### 3.1 方案 A：自有电脑 24h 部署（免费）

**架构**：

```
iPhone (Capacitor WKWebView)
  └─ HTTPS → Cloudflare Tunnel（自动 HTTPS）
                └─ localhost:80 → Nginx（Docker）
                                    ├─ /api/* → Express :3000
                                    └─ /health
                                        └─ Prisma → PostgreSQL :5432
```

**核心组件**：

| 组件 | 作用 |
|------|------|
| Docker Compose | 运行 PostgreSQL + Express + Nginx |
| Cloudflare Tunnel (`cloudflared`) | 免费内网穿透，自动 HTTPS，无需公网 IP |
| Cloudflare 域名（可选） | 用 `*.trycloudflare.com` 免费域名也行 |

**步骤**：
1. 在自有电脑上安装 Docker + Docker Compose
2. 配置 `.env` 文件（密钥等）
3. `docker compose up -d` 启动所有服务
4. 安装 Cloudflare Tunnel 并指向本地 `http://localhost:80`
5. 获取公网 URL（如 `https://taskflow-xxx.trycloudflare.com`）
6. 在 Mac 上用 `VITE_API_URL=https://xxx.trycloudflare.com npm run ios` 重新构建 iOS App

**优点**：完全免费、数据在自己电脑上、无需租服务器
**缺点**：电脑必须 24h 开机、依赖 Cloudflare 中转有轻微延迟、免费域名每次重启会变（需付费域名固定）

---

### 3.2 方案 B：云服务器部署

**架构**：

```
iPhone (Capacitor WKWebView)
  └─ HTTPS → 云服务器公网 IP
                └─ Nginx :443（Let's Encrypt 证书）
                      ├─ /api/* → Express :3000
                      └─ /health
                          └─ Prisma → PostgreSQL :5432
```

**推荐配置**：
- 2 核 2G RAM，40G 硬盘（阿里云 ECS / 腾讯云轻量 / 华为云，约 ¥50-100/月）
- 操作系统：Ubuntu 22.04 或 Debian 12
- 需绑定域名（申请免费 Let's Encrypt 证书）

**步骤**：
1. 购买云服务器，开放 80/443 端口
2. SSH 登录，安装 Docker + Docker Compose
3. `git clone` 仓库，配置 `.env`
4. `docker compose up -d` 启动
5. 配置域名 DNS 解析到服务器 IP
6. 用 certbot 申请 HTTPS 证书，启用 nginx.conf SSL 块
7. Mac 上 `VITE_API_URL=https://yourdomain.com npm run ios` 重新构建

**优点**：公网 IP 固定、稳定性高、无需自己维护硬件
**缺点**：需要付费、需要域名

---

### 3.3 方案对比

| 维度 | 自有电脑 + Cloudflare Tunnel | 云服务器 |
|------|------------------------------|----------|
| 费用 | ¥0（电费忽略不计） | ¥50-100/月 |
| 公网 IP | 不需要 | 自带 |
| HTTPS | Cloudflare 自动提供 | 需手动配置 Let's Encrypt |
| 稳定性 | 依赖家庭网络和电脑 | 99.9% SLA |
| 延迟 | 通过 Cloudflare 中转，稍高 | 直连，最低延迟 |
| 域名 | 可用免费 `*.trycloudflare.com` | 建议购买域名（¥30-60/年） |
| 数据安全 | 数据在自己电脑上 | 在云端 |
| 适用场景 | 个人使用、快速验证 | 正式使用、多人共享 |

---

### 3.4 当前代码中需修复的问题

1. **Dockerfile 缺少 migrations 目录**：runner 阶段只复制了 `schema.prisma`，没有复制 `migrations/` 目录，导致 `prisma migrate deploy` 找不到迁移文件。

2. **Dockerfile 缺少 prisma CLI**：runner 阶段用 `npm ci --omit=dev`，但 `prisma` 是 devDependency，`prisma migrate deploy` 找不到命令。

3. **docker-compose.yml 中 schema 路径**：`--schema=prisma/schema.prisma` 在容器内路径是 `/app/prisma/schema.prisma`，需确认路径一致。

**修复方案**：在 Dockerfile 的 runner 阶段补充复制 `migrations/` 目录和安装 `prisma` CLI，或在 docker-compose.yml 中将 migrate 命令改为在 builder 阶段执行。
