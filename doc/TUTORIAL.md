# TaskFlow 全栈本地测试 & iPhone 真机调试教程

> 整合了 `DEVELOPER.md` 与 `deploy-ios.md`，覆盖 macOS 本地全栈联调、iPhone 17 真机安装、以及 Linux 服务器部署可行性分析。

---

## 目录

1. [macOS 本地全栈测试（前端 + 后端 + 数据库）](#1-macos-本地全栈测试前端--后端--数据库)
2. [iPhone 17 真机安装与调试](#2-iphone-17-真机安装与调试)
3. [Linux 平台构建可行性分析](#3-linux-平台构建可行性分析)
4. [后端依赖清单（requirements.txt）](#4-后端依赖清单)
5. [常用命令速查](#5-常用命令速查)

---

## 1. macOS 本地全栈测试（前端 + 后端 + 数据库）

### 1.1 前提条件

| 工具 | 版本要求 | 安装方式 |
|------|----------|----------|
| Node.js | 18+（推荐 22） | `brew install node` 或 [nodejs.org](https://nodejs.org) |
| pnpm | 最新 | `npm i -g pnpm` |
| Docker Desktop | 最新 | [docker.com](https://www.docker.com/products/docker-desktop/) |
| Xcode | 15+（仅 iOS 构建需要） | Mac App Store |

### 1.2 第一步：启动 PostgreSQL 数据库

只需要一行命令，启动一个本地 PostgreSQL 容器：

```bash

docker stop taskflow-pg #停止已有任务
docker rm taskflow-pg #先删除已有任务

docker run -d \
  --name taskflow-pg \
  -e POSTGRES_DB=taskflow \
  -e POSTGRES_USER=taskflow \
  -e POSTGRES_PASSWORD=taskflow_password \
  -p 5432:5432 \
  postgres:16-alpine
```

验证数据库是否就绪：

```bash
docker ps | grep taskflow-pg
# 应看到一条运行中的容器记录
```

> 后续再次开机后，如果容器已停止，用 `docker start taskflow-pg` 重新启动即可。

### 1.3 第二步：启动后端

```bash
# 进入后端目录
cd backend

# 复制环境变量模板（默认值已匹配上面的 Docker 命令）
cp .env.example .env

# 安装依赖
npm install

# 生成 Prisma Client
npm run db:generate

# 初始化数据库表结构
npm run db:migrate:dev -- --name init

# 启动后端开发服务器 → http://localhost:3000
npm run dev
```

验证后端是否正常：

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

### 1.4 第三步：启动前端开发服务器（浏览器调试）

回到仓库根目录，**新建**一个 `.env.local` 文件，告诉前端去哪找后端：

```bash
# 在仓库根目录
echo "VITE_API_URL=http://localhost:3000" > .env.local
```

然后启动前端：

```bash
pnpm install
pnpm run dev
# → http://localhost:5173
```

现在浏览器打开 `http://localhost:5173` 即可注册登录、增删改查。

> 如果要构建 iOS App（Xcode 模拟器 / 真机），用 `npm run ios` 代替 `pnpm run dev`，见 [1.7 节](#17-在-xcode-模拟器中调试无需-iphone)。

### 1.5 第四步：联调验证

1. 浏览器打开 `http://localhost:5173`
2. 点击「注册」，用任意邮箱 + 密码创建一个账号
3. 创建几个任务，试试拖拽排序、修改优先级、标记完成
4. 刷新页面 → 任务数据应该都在（说明数据已持久化到 PostgreSQL）
5. 退出登录 → 重新登录 → 数据依然在

> **至此，你已经完成了 macOS 上前后端 + 数据库的完整联调。**

### 1.6 一键启动脚本（可选）

如果你懒得每次都手动执行上述步骤，可以在仓库根目录创建一个启动脚本：

```bash
cat > start-dev.sh << 'EOF'
#!/bin/bash
set -e

echo "📦 启动 PostgreSQL..."
docker start taskflow-pg 2>/dev/null || docker run -d \
  --name taskflow-pg \
  -e POSTGRES_DB=taskflow \
  -e POSTGRES_USER=taskflow \
  -e POSTGRES_PASSWORD=taskflow_password \
  -p 5432:5432 \
  postgres:16-alpine

echo "🔧 启动后端..."
cd backend
npm run dev &
BACKEND_PID=$!
cd ..

echo "🌐 启动前端..."
pnpm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ 后端: http://localhost:3000"
echo "✅ 前端: http://localhost:5173"
echo ""
echo "按 Ctrl+C 停止所有服务"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
EOF

chmod +x start-dev.sh
./start-dev.sh
```

### 1.7 在 Xcode 模拟器中调试（无需 iPhone）

如果你想先不连真机，直接在 Mac 上用 Xcode 模拟器验证全栈功能，这是最简单的方式：

```bash
# 1. 确保后端在运行
cd backend && npm run dev          # localhost:3000

# 2. 确保前端已配置后端地址（模拟器可用 localhost）
echo "VITE_API_URL=http://localhost:3000" > .env.local

# 3. 构建并打开 Xcode
npm run ios
```

在 Xcode 中：
1. 顶部设备选择器 → 选 **iPhone 17 Pro Simulator**（或其他模拟器）
2. 确保 `backend/.env` 的 `CORS_ORIGIN` 包含所需来源（逗号分隔）：`CORS_ORIGIN=capacitor://localhost,http://localhost:5173`，重启后端
3. 点击 ▶ Run（`⌘R`），模拟器会自动启动并安装 App
4. 注册、登录、任务 CRUD 全部可用，和浏览器联调体验一致

> **好处**：无需签名、无需 Apple ID、无需 USB 连线，适合快速迭代验证。

---

## 2. iPhone 17 真机安装与调试

> 本节整合自 `deploy-ios.md`，已在仅前端版本上验证可用。增加后端后，构建时需要额外配置 `VITE_API_URL`。

### 2.1 前置条件

| 工具 | 说明 |
|------|------|
| **macOS** | 必须（Xcode 仅支持 macOS） |
| **Xcode 16+** | Mac App Store 免费下载 |
| **Apple ID** | 免费账号即可（每 7 天需重签） |
| **USB 数据线** | 连接 iPhone 到 Mac |
| **SideStore**（推荐）或 **AltStore** | 旁加载工具，可实现自动续签 |

### 2.2 第一步：添加 iOS 平台（仅首次）

```bash
cd /path/to/TaskFlow
npx cap add ios
```

这会在仓库根目录生成 `ios/` 目录（Xcode 项目）。

### 2.3 第二步：构建前端并同步到 Xcode

> ⚠️ **关键区别**：有后端时，必须在构建时指定你的后端地址。本地联调时指向 `localhost`，真机测试时需要指向你 Mac 的局域网 IP 或公网服务器地址。

**场景 A：后端在 Mac 本地，iPhone 同 Wi-Fi 测试**

先获取 Mac 的局域网 IP：

```bash
ipconfig getifaddr en0
# 例如输出: 192.168.1.42
```

然后构建前端：

```bash
VITE_API_URL=http://192.168.1.42:3000 npm run build
npx cap sync ios
npx cap open ios
```

**场景 B：后端已部署到公网服务器**

```bash
VITE_API_URL=https://your-server.com npm run build
npx cap sync ios
npx cap open ios
```

> 也可以一步到位：`npm run ios`（等同于 `npm run build && npx cap sync ios && npx cap open ios`），但需要先设置环境变量。

**注意**：如果后端运行在本地且使用 HTTP，需要在 `backend/.env` 中将 `CORS_ORIGIN` 设为 `capacitor://localhost`，否则 WKWebView 发起的请求会被 CORS 拦截。或者更简单的做法是在后端添加 Capacitor 来源白名单。

### 2.4 第三步：在 Xcode 中配置签名

1. Xcode 打开后，左侧点击 **App** 项目 → 选择 **Signing & Capabilities** Tab
2. **Team**：下拉选择你的 Apple ID（若未登录：Xcode → Settings → Accounts → 添加账号）
3. **Bundle Identifier**：确认是 `com.wuyuchen.taskflow`（与 `capacitor.config.ts` 一致）
4. 勾选 **Automatically manage signing**

> 免费账号证书有效期 **7 天**，到期需重签。

### 2.5 第四步：安装到 iPhone

**方式 A：USB 有线连接（最简单，推荐首次使用）**

1. 用 USB 线连接 iPhone 到 Mac
2. iPhone 上点击「信任此电脑」
3. Xcode 顶部设备选择器选中你的 iPhone（不要选 Simulator）
4. 点击 ▶ Run（或 `⌘R`）
5. 首次安装后，在 iPhone 上：**设置 → 通用 → VPN 与设备管理 → 点击你的 Apple ID → 信任**

**方式 B：导出 IPA 通过 SideStore 安装（推荐长期使用）**

1. Xcode 菜单 → **Product → Archive**
2. Archive 完成后 → **Distribute App** → **Ad Hoc** → 导出 IPA
3. 将 IPA 通过 AirDrop 发到 iPhone
4. 在 iPhone 上用 SideStore 打开安装

### 2.6 第五步：处理 7 天证书过期

| 方案 | 优点 | 缺点 |
|------|------|------|
| **SideStore**（推荐） | iPhone 上自动续签，无需电脑 | 首次初始化需要电脑辅助 |
| **AltStore** | Mac 后台自动续签 | 需 Mac 开机 + 同 Wi-Fi |
| **手动重签** | 无需额外工具 | 每 7 天连一次电脑 |

SideStore 安装教程：[sidestore.io](https://sidestore.io)

### 2.7 常见问题排查

**Q: iPhone 登录时提示"网络错误"？**

检查以下几点：
- `VITE_API_URL` 是否已在构建时正确设置
- iPhone 和 Mac 是否在同一 Wi-Fi 下（如果用局域网 IP）
- Mac 防火墙是否允许 3000 端口：**系统设置 → 网络 → 防火墙 → 选项**
- 后端是否在运行：`curl http://<你的IP>:3000/health`

**Q: Xcode 签名报错 "Communication with Apple failed"？**

1. 用 USB 连接 iPhone，解锁并点「信任此电脑」
2. Xcode → Settings → Accounts → 选 Apple ID → Manage Certificates → 确认有 **Apple Development** 证书
3. Product → Clean Build Folder，然后重试 `⌘R`
4. 检查是否已接受最新 Apple Developer 协议：[developer.apple.com/account](https://developer.apple.com/account)

**Q: WKWebView 不发送 Cookie，导致 refreshToken 无法刷新？**

这是 Capacitor WKWebView 的已知限制。解决方案：
1. 在 `capacitor.config.ts` 中配置 WKWebView 相关设置
2. 或将 refreshToken 改为存入 `localStorage`（牺牲部分安全性，但对个人任务管理 App 可接受）

---

## 3. Linux 平台构建可行性分析

### 3.1 结论：完全可以构建和部署，只是不能构建 iOS 原生包

| 能力 | macOS | Linux | 说明 |
|------|-------|-------|------|
| 前端开发 (`pnpm run dev`) | ✅ | ✅ | Vite 跨平台 |
| 前端构建 (`pnpm run build`) | ✅ | ✅ | 生成 `dist/` 静态文件 |
| 后端开发 (`npm run dev`) | ✅ | ✅ | Node.js 跨平台 |
| 后端构建 (`npm run build`) | ✅ | ✅ | TypeScript 编译 |
| Docker 部署 (`docker compose up`) | ✅ | ✅ | **推荐生产部署方式** |
| iOS 原生构建 (`npx cap sync ios`) | ✅ | ❌ | 必须 Xcode（仅 macOS） |
| 作为 PWA 在浏览器使用 | ✅ | ✅ | 不需要任何原生构建 |

### 3.2 推荐的 Linux 部署架构

```
用户浏览器 / iPhone Safari
        │
        ▼
   Nginx :443 (HTTPS)
        │
   ├── /api/* → Express :3000
   └── /*     → dist/ 静态文件
        │
        ▼
   PostgreSQL :5432
```

### 3.3 Linux 部署步骤

```bash
# 1. 安装 Docker + Docker Compose
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 2. 克隆仓库
git clone https://github.com/AaronWu77/TaskFlow.git
cd TaskFlow

# 3. 配置环境变量
cp .env.example .env
vim .env   # 填写 POSTGRES_PASSWORD, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET

# 4. 一键启动
docker compose up -d

# 5. 验证
curl http://localhost/health
```

> 如果 iPhone 需要通过 Capacitor 使用，只需在 macOS 构建一次 iOS 包（`npm run ios`），之后后端 API 地址指向 Linux 服务器即可。**前端代码不需要每次都在 macOS 上重新构建**——只需保证构建时 `VITE_API_URL` 指向 Linux 服务器地址。

### 3.4 跨平台开发工作流建议

```
macOS（开发机）            Linux（服务器）
    │                          │
    ├─ 写代码                  │
    ├─ pnpm run dev（浏览器调试）│
    ├─ npm run ios（iPhone 构建）│
    │                          ├─ docker compose up（运行后端）
    │                          └─ PostgreSQL 持久化存储
    │                          │
    └─ iPhone App ──── HTTPS ──┘
```

---

## 4. 后端依赖清单

### 4.1 系统级依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | ≥ 18 | JavaScript 运行时 |
| pnpm / npm | 最新 | 包管理器 |
| PostgreSQL | 16 | 数据库 |
| Docker（可选） | 最新 | 容器化运行 PostgreSQL |

### 4.2 Node.js 运行时依赖（生产环境）

| 包名 | 版本 | 用途 |
|------|------|------|
| `@prisma/client` | ^5.22.0 | 数据库 ORM 客户端 |
| `bcryptjs` | ^2.4.3 | 密码哈希 |
| `cookie-parser` | ^1.4.7 | 解析 HTTP Cookie |
| `cors` | ^2.8.5 | 跨域请求处理 |
| `dotenv` | ^16.4.7 | 加载 `.env` 环境变量 |
| `express` | ^4.21.2 | Web 框架 |
| `jsonwebtoken` | ^9.0.2 | JWT 签发与验证 |

### 4.3 Node.js 开发依赖（仅本地开发需要）

| 包名 | 版本 | 用途 |
|------|------|------|
| `typescript` | ^5.7.2 | TypeScript 编译器 |
| `tsx` | ^4.19.2 | TypeScript 开发服务器 |
| `prisma` | ^5.22.0 | 数据库迁移 CLI |
| `@types/bcryptjs` | ^2.4.6 | bcryptjs 类型定义 |
| `@types/cookie-parser` | ^1.4.8 | cookie-parser 类型定义 |
| `@types/cors` | ^2.8.17 | cors 类型定义 |
| `@types/express` | ^5.0.0 | express 类型定义 |
| `@types/jsonwebtoken` | ^9.0.7 | jsonwebtoken 类型定义 |
| `@types/node` | ^22.10.0 | Node.js 类型定义 |

> ⚠️ **注意**：TaskFlow 后端是 **Node.js** 项目，依赖管理使用 `package.json`，而非 Python 的 `requirements.txt`。后端依赖安装命令为：
> ```bash
> cd backend && npm install
> ```

---

## 5. 常用命令速查

### 前端

```bash
pnpm run dev          # 启动前端开发服务器 (localhost:5173)
pnpm run build        # 生产构建 → dist/
pnpm run ios          # 构建 + 同步 Capacitor + 打开 Xcode
pnpm run cap:sync     # 构建 + 同步 Capacitor（不打开 Xcode）
```

### 后端

```bash
cd backend
npm run dev           # 启动后端开发服务器 (localhost:3000)
npm run build         # TypeScript 编译 → dist/
npm run db:generate   # 生成 Prisma Client
npm run db:studio     # 打开 Prisma 数据库管理界面
npx prisma migrate dev --schema=src/prisma/schema.prisma --name init  # 数据库迁移
```

### Docker

```bash
docker start taskflow-pg            # 启动已有 PostgreSQL 容器
docker stop taskflow-pg             # 停止 PostgreSQL 容器
docker compose up -d                # 生产部署（API + PostgreSQL + Nginx）
docker compose logs -f api          # 查看 API 日志
docker compose build api            # 重新构建 API 镜像
docker compose up -d api            # 滚动更新 API 服务
```

---

## 附录：环境变量速查

### 后端 `.env`（本地开发）

| 变量 | 示例值 |
|------|--------|
| `DATABASE_URL` | `postgresql://taskflow:taskflow_password@localhost:5432/taskflow` |
| `JWT_ACCESS_SECRET` | 至少 32 字符随机字符串 |
| `JWT_REFRESH_SECRET` | 至少 32 字符随机字符串 |
| `CORS_ORIGIN` | `http://localhost:5173` |
| `PORT` | `3000` |

### 前端 `.env.local`

| 变量 | 本地开发 | iPhone 真机测试 |
|------|----------|----------------|
| `VITE_API_URL` | `http://localhost:3000` | `http://<Mac局域网IP>:3000` 或 `https://<服务器域名>` |
