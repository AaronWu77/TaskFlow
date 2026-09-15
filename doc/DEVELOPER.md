# TaskFlow 开发者手册

本手册是 TaskFlow 唯一的工程文档来源，覆盖本地开发、同步架构、部署、iOS 构建与发布。

## 架构与目录

```text
src/                    React + Vite 前端
  app/App.tsx           主界面、任务交互、同步与冲突处理
  app/api.ts            API 客户端、认证刷新与默认 API 地址
  app/storage.ts        Web / Capacitor 本地存储适配
  i18n/locales/         中英文文案，修改界面文本时同时更新
backend/                Express + Prisma API
  src/routes/           auth、tasks、sync、user 路由
  src/prisma/           schema 与迁移文件
ios/                    Capacitor iOS 工程
scripts/                Node 内建测试运行器的回归测试
```

生产请求链路为：`iOS/Web -> HTTPS Nginx -> /api -> Express -> Prisma -> PostgreSQL`。Nginx 将 `/api/` 转发到 API 容器；`/live` 只验证进程存活，`/ready` 和兼容路径 `/health` 还会验证数据库可用。

## 环境要求与本地运行

需要 Node.js 22、npm 与 Docker Compose。根目录使用 npm；后端依赖单独安装。

```bash
# 前端
npm install
npm run dev                         # http://localhost:5173

# 本地 PostgreSQL
docker run -d --name taskflow-pg -e POSTGRES_DB=taskflow \
  -e POSTGRES_USER=taskflow -e POSTGRES_PASSWORD=taskflow_password \
  -p 5432:5432 postgres:16-alpine

# 后端
cd backend
cp .env.example .env
npm install
npm run db:generate
npm run db:migrate:dev
npm run dev                         # http://localhost:3000
```

根目录 `.env.local` 控制前端构建时的 API 地址。默认已是 `https://taskflow.top/api`；本地联调可覆盖为：

```env
VITE_API_URL=http://localhost:3000
```

## 构建、测试与代码约定

```bash
npm run build                       # 输出 dist/
npm --prefix backend run build      # 编译后端到 backend/dist/
npm test                            # scripts/*.test.mjs
npm run check                       # 前端构建 + 后端构建 + 测试
npm run cap:sync                    # 构建并写入 ios/App/App/public/
npm run ios                         # cap:sync 后打开 Xcode
```

使用 TypeScript、两空格缩进、函数式 React 组件。组件用 PascalCase，函数和变量用 camelCase。优先使用 `src/styles/theme.css` 中的语义化 Tailwind token 和 `cn()`；用户可见文案必须同时更新 `src/i18n/locales/zh.json` 与 `en.json`。回归测试放在 `scripts/*.test.mjs`，涉及认证、同步、排序、重复任务或 iOS 的改动必须补充对应断言。

## 认证与数据同步

认证采用短期 access token 和可轮换 refresh session。Web 使用 httpOnly Cookie；Capacitor 会额外安全保存 refresh token 作为 Cookie 不可用时的回退。生产环境必须 HTTPS，并设置 `COOKIE_SECURE=true`。

同步不再调用任务 CRUD 逐条上传。客户端把 `create`、`update`、`soft-delete`、`restore`、`permanent-delete`、`reorder` 和 `resolve-conflict` 写入按用户隔离的本地操作队列（`pendingOperations`）；网络恢复、回到前台或用户重试时按以下顺序执行：

1. `POST /sync/push` 提交可用操作及设备 ID；服务端以 `operationId` 去重并校验任务版本。
2. `GET /sync?cursor=<n>` 拉取 `TaskChange`，直到游标追平；首次登录使用 `GET /sync/bootstrap` 获取任务、删除记录、统计和游标。
3. 服务端为任务维护 `version`，为排序维护 `taskOrderVersion`。不同字段并发编辑自动合并；同字段编辑、删除与编辑、永久删除和排序冲突进入应用内冲突处理页。

冲突页支持逐字段选“本机 / 云端 / 自定义”、全部采用一侧、重新应用本机顺序，以及把被永久删除的本机任务复制为新任务。不要恢复旧的全局缓存或旧同步协议；当前项目处于开发阶段，数据模型直接以 `Device`、`UserSyncState`、`TaskChange` 和 `TaskOperation` 为准。

## 数据库与 API

Prisma schema 位于 `backend/src/prisma/schema.prisma`，手动 Prisma 命令必须显式指定路径：

```bash
cd backend
npx prisma migrate dev --schema=src/prisma/schema.prisma --name <change-name>
npx prisma migrate deploy --schema=src/prisma/schema.prisma
npx prisma studio --schema=src/prisma/schema.prisma
```

`migrate dev` 只用于开发环境；生产只使用 `migrate deploy`，Docker API 容器启动时会自动执行。所有任务、同步和用户数据接口都要求 Bearer access token，只有 `/health` 无需认证。任务写入统一经过 `POST /sync/push`，`/tasks` 仅保留兼容性的只读查询，旧写接口返回 `410 SYNC_PROTOCOL_REQUIRED`，避免绕过版本号与变更日志；`/user/export` 导出用户数据，`PATCH /user/preferences` 保存统计所需的时区和语言，`DELETE /user/account` 删除用户及级联数据。

## 环境变量

根目录 `.env` 供 Docker Compose 使用，`backend/.env` 供本地 API 使用；两者都不能提交。生产至少配置：

```env
POSTGRES_PASSWORD=<strong-password>
JWT_ACCESS_SECRET=<random-48-byte-hex>
JWT_REFRESH_SECRET=<random-48-byte-hex>
CORS_ORIGIN=https://taskflow.top,https://www.taskflow.top,capacitor://localhost
COOKIE_SECURE=true
EMAIL_VERIFICATION_CONSOLE=false
RESEND_API_KEY=<server-only-secret>
EMAIL_FROM=TaskFlow <verify@taskflow.top>
```

本地 `backend/.env` 使用 `DATABASE_URL=postgresql://taskflow:taskflow_password@localhost:5432/taskflow`、`NODE_ENV=development`、`COOKIE_SECURE=false` 和 `EMAIL_VERIFICATION_CONSOLE=true`。生成 JWT 密钥：`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`。

## 生产部署与运维

服务器首次部署：

```bash
git clone git@github.com:AaronWu77/TaskFlow.git /opt/TaskFlow
cd /opt/TaskFlow
cp .env.example .env
# 编辑 .env，填入生产变量，并准备 ssl/fullchain.pem 与 ssl/privkey.pem
docker compose up -d --build
curl -i https://taskflow.top/api/health
```

Nginx 监听 80/443，服务器安全组需开放 80 与 443；不要暴露 PostgreSQL。域名必须能在目标网络解析到服务器，且 iOS 必须使用 HTTPS API。更新 API：

```bash
cd /opt/TaskFlow
git pull
docker compose up -d --build api
docker compose logs -f api
```

同步故障优先检查 `https://taskflow.top/api/health`、API 日志和 `/api/sync/bootstrap`（未登录应返回 401；返回 404 代表线上服务未更新）。生产备份、OSS 上传、恢复演练、监控阈值和 systemd timer 的唯一操作手册位于 `ops/README.md`；不要再以同机纯 SQL 文件作为正式备份。紧急手工导出可使用：

```bash
docker compose exec postgres pg_dump -U taskflow taskflow > taskflow-backup.sql
```

## iOS 与发布

`npm run ios` 会按默认生产 API 构建前端、同步到 Capacitor，再打开 Xcode。修改 `VITE_API_URL`、Web 代码或 Capacitor 配置后必须重新执行；真机在 Xcode 选择设备后运行。`ios/App/App/public/` 是生成目录，不提交也不手改。

每次发布遵循语义化版本：破坏性变更提升 major，新功能提升 minor，修复提升 patch；iOS 的 Marketing Version 与 `package.json` 保持一致，Build 号每次上传 TestFlight 或 App Store 都递增。提交信息保持短小、聚焦、可读，例如 `4.0.4 修复任务排序`。

发布前至少执行 `npm run check`、`plutil -lint ios/App/App/Info.plist ios/App/App/PrivacyInfo.xcprivacy`，并在真机回归登录、邮箱验证、创建/编辑/提醒/重复任务、排序、离线后恢复同步、冲突处理、退出登录、账号删除、中英双语和隐私/支持页。提交 App Store 前确认生产迁移已应用、`/api/health` 可用、CORS 与 HTTPS 正确、App 隐私标签与 `PrivacyInfo.xcprivacy` 及 `public/privacy/` 一致，并提供审核测试账号。
