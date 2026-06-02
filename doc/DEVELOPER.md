# TaskFlow 开发者文档

> 面向参与开发的工程师，涵盖项目架构、本地搭建、后端开发、部署流程与 iOS 构建全流程。

---

## 目录

1. [项目架构概览](#1-项目架构概览)
2. [本地开发环境搭建](#2-本地开发环境搭建)
3. [前端架构详解](#3-前端架构详解)
4. [后端架构详解](#4-后端架构详解)
5. [认证流程](#5-认证流程)
6. [数据库 Schema](#6-数据库-schema)
7. [Docker 生产部署](#7-docker-生产部署)
8. [iOS (Capacitor) 构建与部署](#8-ios-capacitor-构建与部署)
9. [环境变量参考](#9-环境变量参考)
10. [常见问题](#10-常见问题)

---

## 1. 项目架构概览

```
TaskFlow/
├── src/                    # 前端 React + Vite SPA
│   └── app/
│       ├── App.tsx         # 主应用（所有 UI 组件和状态）
│       ├── AuthPage.tsx    # 登录 / 注册页面
│       ├── api.ts          # API 客户端（自动 Token 刷新）
│       ├── storage.ts      # localStorage + Capacitor Preferences 适配层
│       └── components/
│           └── ui/         # shadcn/ui 组件（勿修改）
├── backend/                # Node.js + Express + Prisma 后端
│   ├── src/
│   │   ├── index.ts        # Express 入口
│   │   ├── middleware/
│   │   │   └── auth.ts     # JWT Bearer Token 鉴权中间件
│   │   ├── routes/
│   │   │   ├── auth.ts     # 注册 / 登录 / 刷新 / 登出
│   │   │   └── tasks.ts    # 任务 CRUD + 批量排序
│   │   └── prisma/
│   │       └── schema.prisma
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── docker-compose.yml      # 生产三件套：API + PostgreSQL + Nginx
├── nginx.conf              # 反向代理配置
├── capacitor.config.ts     # iOS Capacitor 配置
├── vite.config.ts          # Vite + Tailwind + Figma 资产插件
└── doc/
    ├── plan.md             # 项目规划（同步更新）
    └── DEVELOPER.md        # 本文件
```

### 请求链路（生产环境）

```
iPhone (Capacitor WKWebView)
  └─ HTTPS → Nginx :443
                └─ proxy_pass → API (Express) :3000
                                    └─ Prisma → PostgreSQL :5432
```

---

## 2. 本地开发环境搭建

### 2.1 前提条件

- Node.js 18+（推荐 22）
- pnpm（`npm i -g pnpm`）
- Docker + Docker Compose（用于运行 PostgreSQL）

### 2.2 前端

```bash
# 在仓库根目录
pnpm install
pnpm run dev     # → http://localhost:5173
```

默认情况下前端不连接任何后端（`VITE_API_URL` 未设置时，`api.ts` 使用 `http://localhost:3000`）。

### 2.3 后端

**方式 A：Docker 启动 PostgreSQL，Node 本地运行（推荐开发）**

```bash
# 启动数据库
docker run -d \
  --name taskflow-pg \
  -e POSTGRES_DB=taskflow \
  -e POSTGRES_USER=taskflow \
  -e POSTGRES_PASSWORD=taskflow_password \
  -p 5432:5432 \
  postgres:16-alpine

# 安装后端依赖
cd backend
cp .env.example .env   # 默认值已与上面的 docker run 匹配

npm install
npm run db:generate    # 生成 Prisma Client
npx prisma migrate dev --schema=src/prisma/schema.prisma --name init
npm run dev            # → http://localhost:3000
```

**方式 B：完整 Docker Compose（含 Nginx）**

```bash
cp .env.example .env   # 填写密钥
docker compose up -d
```

### 2.4 联调前端 + 后端

在根目录创建 `.env.local`（Vite 会自动加载）：

```
VITE_API_URL=http://localhost:3000
```

然后重启前端开发服务器：

```bash
pnpm run dev
```

---

## 3. 前端架构详解

### 3.1 单文件应用（App.tsx）

整个应用逻辑集中在 `src/app/App.tsx`（约 1000 行）。无路由，一切通过 React state 控制显示。

**AppState 状态机**（认证流）：

```
localStorage 有 token?
  ├── 是 → authUser = null（检查中）→ setAuthUser(placeholder)  → 渲染主 App
  └── 否 → authUser = false → 渲染 AuthPage
```

实际 token 有效性验证发生在第一次 API 调用时（401 → 自动刷新）。

### 3.2 视图布局（滚动修复）

```
Root div: h-screen overflow-hidden          ← 锁死屏幕高度，禁止全局滚动
  Header（固定高度）
  ViewToggle（固定高度）
  Sliding container: flex-1 overflow-hidden ← 剩余空间，禁止外部滚动
    motion.div: h-full items-stretch        ← 双面板等高
      Flow 面板: h-full                     ← 内容不足也撑满，不产生滚动
      Calendar 面板: h-full overflow-y-auto ← 内容超出时内部独立滚动
```

### 3.3 API 客户端（api.ts）

```
apiFetch(path, options)
  ├── 注入 Authorization: Bearer <accessToken>
  ├── 发起请求
  └── 如果 401:
        ├── 调用 /auth/refresh（携带 httpOnly cookie）
        ├── 刷新成功 → 更新 accessToken → 重试原请求
        └── 刷新失败 → 返回 401 响应（调用方负责登出）
```

accessToken 存在 `localStorage['taskflow_access_token']`；refreshToken 存在 httpOnly Cookie（服务端设置，JS 不可读）。

### 3.4 任务插入排序（insertIndex）

新任务插入时不重排所有任务，只寻找第一个"比新任务优先级低"的 `todo` 任务位置：

```
优先级比较规则：
1. 新任务有 deadline，现有任务没有 → 新任务靠前
2. 都有 deadline → deadline 越早越靠前
3. 同 deadline 或都无 deadline → P1 > P2 > P3
4. 找不到 → 追加到末尾
```

---

## 4. 后端架构详解

### 4.1 Express 路由结构

```
GET  /health              → 健康检查（无鉴权）
POST /auth/register       → 注册
POST /auth/login          → 登录
POST /auth/refresh        → 刷新 accessToken（读 httpOnly cookie）
POST /auth/logout         → 登出（清除 cookie）

[以下需要 Bearer Token]
GET    /tasks             → 获取当前用户所有任务（按 sortOrder）
POST   /tasks             → 创建任务
PATCH  /tasks/:id         → 更新任务字段
DELETE /tasks/:id         → 删除任务
PUT    /tasks/reorder     → 批量更新 sortOrder（拖拽排序）
```

### 4.2 JWT 鉴权中间件

`backend/src/middleware/auth.ts` 从 `Authorization: Bearer <token>` 头提取并验证 accessToken，将 `userId` 注入 `req.userId`。

所有任务操作均检查 `task.userId === req.userId`，防止越权访问。

### 4.3 Prisma Client 位置

schema 文件位于 `backend/src/prisma/schema.prisma`（非默认 `prisma/schema.prisma`），所有 Prisma CLI 命令需加 `--schema=src/prisma/schema.prisma`：

```bash
npx prisma migrate dev --schema=src/prisma/schema.prisma --name <name>
npx prisma studio --schema=src/prisma/schema.prisma
```

---

## 5. 认证流程

### 注册 / 登录

```
客户端 → POST /auth/register { email, password }
服务端：
  1. 检查邮箱唯一性
  2. bcrypt.hash(password, 12)
  3. 写入 User 表
  4. 签发 accessToken（15min，HS256，JWT_ACCESS_SECRET）
  5. 签发 refreshToken（7d，HS256，JWT_REFRESH_SECRET）
  6. Set-Cookie: taskflow_refresh=<refreshToken>; HttpOnly; SameSite=Strict
  7. 返回 { accessToken, user: { id, email } }

客户端：
  1. 存 accessToken 到 localStorage
  2. Cookie 由浏览器自动管理
```

### Token 刷新

```
客户端 → POST /auth/refresh（自动携带 Cookie）
服务端：
  1. 读取 req.cookies.taskflow_refresh
  2. jwt.verify(token, JWT_REFRESH_SECRET)
  3. 签发新 accessToken
  4. 返回 { accessToken }
```

### 安全注意事项

- **生产环境**必须在 HTTPS 下运行，否则 `httpOnly` cookie 的 `Secure` 属性无法生效
- JWT 密钥至少 32 字节随机字符串，生成方法：
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- refreshToken 目前未存储于数据库（无法单独吊销），如需支持"踢出设备"，需改为数据库存储并在刷新时验证

---

## 6. 数据库 Schema

```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  password  String   // bcrypt hash，永远不返回给客户端
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  tasks     Task[]
}

model Task {
  id              String   @id @default(cuid())
  userId          String
  title           String
  priority        String   // "P1" | "P2" | "P3"
  estimateMinutes Int
  status          String   // "todo" | "doing" | "done" | "snoozed" | "skipped"
  tag             String?
  progress        Int      @default(0)   // 0–100
  dueDate         String?  // "YYYY-MM-DD"
  sortOrder       Int      @default(0)   // 用户自定义位置
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

### 数据库迁移

```bash
# 开发环境（自动创建迁移文件）
cd backend
npx prisma migrate dev --schema=src/prisma/schema.prisma --name <描述>

# 生产环境（应用已有迁移，不创建新文件）
npx prisma migrate deploy --schema=src/prisma/schema.prisma
```

Docker Compose 启动时 `api` 服务会自动执行 `prisma migrate deploy`。

---

## 7. Docker 生产部署

### 7.1 服务器准备

```bash
# 安装 Docker + Docker Compose（Debian/Ubuntu）
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

### 7.2 部署步骤

```bash
# 1. 克隆仓库
git clone https://github.com/AaronWu77/TaskFlow.git
cd TaskFlow

# 2. 配置环境变量
cp .env.example .env
vim .env   # 填写以下三项（必填）：
           # POSTGRES_PASSWORD=<强密码>
           # JWT_ACCESS_SECRET=<随机64字符>
           # JWT_REFRESH_SECRET=<随机64字符>
           # CORS_ORIGIN=https://你的前端域名

# 3. 启动所有服务
docker compose up -d

# 4. 验证
curl http://localhost/health   # → {"status":"ok"}
docker compose logs -f api     # 查看 API 日志
```

### 7.3 启用 HTTPS（Let's Encrypt）

```bash
# 申请证书
sudo apt install certbot
certbot certonly --standalone -d yourdomain.com

# 将证书挂载进 nginx 容器
mkdir -p ssl
cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem ssl/
cp /etc/letsencrypt/live/yourdomain.com/privkey.pem ssl/

# 编辑 nginx.conf，取消 HTTPS server 块的注释
# 将 HTTP → HTTPS 重定向取消注释
docker compose restart nginx
```

### 7.4 更新部署

```bash
git pull
docker compose build api
docker compose up -d api   # 滚动重启，不影响 postgres 和 nginx
```

---

## 8. iOS (Capacitor) 构建与部署

### 8.1 当前可用性说明

> **重要：当前版本直接部署到 iPhone，应用可以正常启动，但功能受限。**

| 功能 | 状态 | 原因 |
|---|---|---|
| 界面显示 | ✅ 正常 | 纯前端，无需后端 |
| 滚动修复 | ✅ 已修复 | Phase 0 已完成 |
| 登录 / 注册 | ❌ 无法连接 | 后端未部署，`localhost:3000` 在手机上不可达 |
| 任务数据 | ⚠️ 仅本地 | 无后端时降级为 localStorage（当前未实现离线降级逻辑） |

**要让认证功能在 iPhone 上可用**，必须：
1. 在公网服务器上部署后端（见第 7 节）
2. 构建前端时设置 `VITE_API_URL`（见下方）

### 8.2 构建流程

```bash
# 1. 设置后端地址（必须是 HTTPS，否则 WKWebView 会拦截）
VITE_API_URL=https://your-backend.com/api pnpm run build

# 2. 同步到 Capacitor iOS 项目
npx cap sync ios

# 3. 打开 Xcode
npx cap open ios

# 4. 在 Xcode 中选择你的设备并 Build（⌘R）
```

### 8.3 Capacitor 配置要点

`capacitor.config.ts` 中的关键配置：

```ts
{
  appId: 'com.wuyuchen.taskflow',
  ios: {
    contentInset: 'always',   // 暴露 safe-area-inset-* CSS 变量
  }
}
```

`src/styles/theme.css` 中的 safe area 工具类：

```css
.pt-safe  { padding-top: max(2rem, calc(0.5rem + env(safe-area-inset-top))); }
.pb-safe  { padding-bottom: max(6rem, calc(4rem + env(safe-area-inset-bottom))); }
.bottom-safe { bottom: max(1.5rem, calc(0.25rem + env(safe-area-inset-bottom))); }
```

### 8.4 iOS WKWebView 注意事项

- **字体大小**：所有 `<input>` 和 `<select>` 必须 `font-size ≥ 16px`（`text-base`），否则 iOS 会自动缩放页面
- **viewport meta**：已设置 `maximum-scale=1, user-scalable=no` 防止双指缩放
- **httpOnly Cookie**：Capacitor WKWebView 默认不发送 Cookie。需在 `capacitor.config.ts` 中启用：
  ```ts
  ios: {
    allowsLinkPreview: false,
    // 如遇 Cookie 问题，可配置 WKWebView 的 cookiePolicy
  }
  ```
  或改为将 refreshToken 存入 `localStorage`（牺牲部分安全性）。

---

## 9. 环境变量参考

### 根目录 `.env`（Docker Compose 用）

| 变量 | 必填 | 示例 | 说明 |
|---|---|---|---|
| `POSTGRES_PASSWORD` | ✅ | `s3cr3t123` | PostgreSQL 密码 |
| `JWT_ACCESS_SECRET` | ✅ | `abc123...` | AccessToken 签名密钥（≥32字符） |
| `JWT_REFRESH_SECRET` | ✅ | `xyz789...` | RefreshToken 签名密钥（≥32字符） |
| `CORS_ORIGIN` | 推荐 | `https://app.yourdomain.com` | 前端域名（CORS 白名单） |

### `backend/.env`（本地开发用）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | `postgresql://taskflow:taskflow_password@localhost:5432/taskflow` | PostgreSQL 连接字符串 |
| `JWT_ACCESS_SECRET` | — | 同上 |
| `JWT_REFRESH_SECRET` | — | 同上 |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | AccessToken 有效期 |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | RefreshToken 有效期 |
| `PORT` | `3000` | 监听端口 |
| `NODE_ENV` | `development` | 环境标识 |
| `CORS_ORIGIN` | `capacitor://localhost,http://localhost:5173` | 允许的前端来源 |

### 前端环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | 后端 API 地址（构建时注入） |

---

## 10. 常见问题

**Q: iPhone 上登录时提示网络错误？**  
A: `localhost:3000` 在手机上不可达。需要在公网部署后端，并用 `VITE_API_URL` 指向正确地址重新构建前端。

**Q: 后端返回 401，但 Token 刚刚获取？**  
A: 检查 `JWT_ACCESS_SECRET` 两端是否一致，以及服务器时间是否准确（Token 包含时间戳）。

**Q: Docker Compose 启动失败，postgres 健康检查超时？**  
A: 可能是端口冲突，检查本机 5432 是否被占用：`lsof -i :5432`。

**Q: Prisma 迁移报错 "schema not found"？**  
A: 始终加 `--schema=src/prisma/schema.prisma`，因为 schema 不在默认路径。

**Q: 前端构建产物如何部署到 Nginx？**  
A: `pnpm run build` 输出到 `dist/`，将该目录映射为 Nginx 的静态文件根目录，或单独用 CDN 托管。当前 `nginx.conf` 仅反代 API，前端静态文件托管需额外配置（或直接打包进 Capacitor）。

**Q: 开发时想跳过登录直接看主界面？**  
A: 在 `App.tsx` 的 `App` 函数顶部临时改为：
```ts
const [authUser, setAuthUser] = useState<AuthUser | null | false>({ id: 'dev', email: 'dev@local' });
```
**注意：提交代码前必须还原。**
