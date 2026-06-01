# TaskFlow 开发计划

> 最后更新：2026-06-01（Round 3）

---

## 1. 功能目的

### 问题
1. **页面滚动 Bug**：iPhone 17 Pro Max 上无任务时页面仍可上下滑动。根因：滑动容器（Flow + Calendar 双面板并排）对整体内容设置了 `overflow-y-auto`，Calendar 面板超高时导致两个面板的父容器均可滚动。
2. **无用户系统**：当前所有数据存 `localStorage`，无法跨设备同步，无法多用户使用。

### 目标
1. **P0 – 滚动修复**：Flow 面板（含空状态）完全不可滚动；Calendar 面板内部独立滚动。
2. **P1 – 后端 + 登录**：开发 Node.js + Express + PostgreSQL 后端，实现注册/登录（邮箱 + 密码）与任务数据云端 CRUD；前端新增登录/注册页；Docker Compose 一键部署到自托管服务器。

### 范围边界（不在此次计划内）
- Google OAuth / 第三方登录
- 推送通知
- 多人协作 / 共享任务

---

## 2. TodoList

### Phase 0 – 滚动修复（前端）
| ID | 任务 |
|---|---|
| s-t1 | 外层滑动容器改 `overflow-hidden`，motion.div 加 `h-full items-stretch` |
| s-t2 | Flow 面板加 `h-full`，确保空状态垂直居中充满 |
| s-t3 | Calendar 面板内部加 `overflow-y-auto h-full` 独立滚动 |
| s-t4 | 构建验证 + 真机同步 |

### Phase 1 – 后端搭建
| ID | 任务 |
|---|---|
| b-t1 | 初始化 `backend/` 项目（Node.js + TypeScript + Express + Prisma） |
| b-t2 | 设计 Prisma schema（User、Task 表） |
| b-t3 | 实现 Auth 路由：`POST /auth/register`、`POST /auth/login`、`POST /auth/refresh` |
| b-t4 | 实现 Task CRUD 路由（带 JWT 鉴权中间件） |
| b-t5 | 编写 Docker Compose（app + PostgreSQL + Nginx） |
| b-t6 | 本地 Docker 联调通过 |

### Phase 2 – 前端登录页 + API 接入
| ID | 任务 |
|---|---|
| f-t1 | 新建 `LoginPage` / `RegisterPage` 组件（邮箱 + 密码表单） |
| f-t2 | Auth 状态管理（JWT 存 `localStorage`，自动续期） |
| f-t3 | API client 封装（`src/app/api.ts`，带 Bearer Token） |
| f-t4 | 将 task 增删改查替换为 API 调用（保留 localStorage 作本地缓存） |
| f-t5 | 登录态路由守卫（未登录跳转 LoginPage） |
| f-t6 | 端到端联调（真机 + 后端） |

---

## 3. 具体执行方案

### Phase 0：滚动修复

**根因**：`src/app/App.tsx` L749 的滑动容器：
```
<div className="... flex-1 overflow-y-auto ...">
  <motion.div style={{ width: '200%' }} className="flex items-start">
    {/* Flow 面板 */}   {/* Calendar 面板 */}
  </motion.div>
</div>
```
`overflow-y-auto` 作用于整个双面板容器，Calendar 面板的高度撑起了滚动区域。

**修复方案**：
```
外层 div: overflow-x-hidden overflow-hidden flex-1（去掉 overflow-y-auto）
motion.div: 加 h-full、items-stretch（替换 items-start）
Flow 面板 div: 加 h-full（内容不足也铺满，防止弹性收缩）
Calendar 面板 div: 加 h-full overflow-y-auto（Calendar 自管滚动）
```

---

### Phase 1：后端架构

**目录结构**：
```
backend/
  src/
    index.ts          # Express 入口
    routes/
      auth.ts         # 注册/登录/刷新
      tasks.ts        # 任务 CRUD
    middleware/
      auth.ts         # JWT 鉴权中间件
    prisma/
      schema.prisma   # User + Task 数据模型
  Dockerfile
  .env.example
docker-compose.yml    # 仓库根目录
nginx.conf
```

**数据模型（Prisma）**：
```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  password  String   // bcrypt hash
  createdAt DateTime @default(now())
  tasks     Task[]
}

model Task {
  id               String   @id @default(cuid())
  userId           String
  title            String
  priority         String   // P1/P2/P3
  estimateMinutes  Int
  status           String   // todo/doing/done/snoozed/skipped
  tag              String?
  progress         Int      @default(0)
  dueDate          String?
  sortOrder        Int      @default(0)  // 保存用户手动排序
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  user             User     @relation(fields: [userId], references: [id])
}
```

**Auth 流程**：
- `POST /auth/register` → bcrypt hash 密码，返回 accessToken（15min）+ refreshToken（7d）
- `POST /auth/login` → 校验密码，返回同上
- `POST /auth/refresh` → 验证 refreshToken，返回新 accessToken
- accessToken 存 `localStorage`；refreshToken 存 `httpOnly cookie`

**Task API**：
- `GET /tasks` → 返回当前用户所有任务（按 sortOrder）
- `POST /tasks` → 创建任务
- `PATCH /tasks/:id` → 更新状态/进度/排序
- `DELETE /tasks/:id` → 删除任务

---

### Phase 2：前端接入

**路由逻辑**（无 React Router，用状态机模拟）：
```
appState: 'loading' | 'auth' | 'app'
- loading: 检查 localStorage 是否有有效 token → 自动跳转
- auth: 显示 LoginPage / RegisterPage
- app: 显示当前 App 主界面
```

**API client（`src/app/api.ts`）**：
- 封装 `apiFetch(path, options)` 自动带 Bearer Token
- 401 时自动调用 `/auth/refresh`，刷新后重试原请求

**数据同步策略**：
- 登录后：从服务端拉取任务，覆盖本地 localStorage（以服务端为准）
- 操作任务：乐观更新本地 state，同时异步 API 请求；失败时回滚

---

## 4. 更新日志

| 版本 | 内容 |
|---|---|
| Round 1 | iOS viewport/字体修复，Add Task 动画改为 Bottom Sheet |
| Round 2 | 滚动锁定、Add Task 改居中卡片、Deadline 字段全宽 |
| Round 3 | 滚动 Bug 根因修复、后端 + 登录体系规划 |
| Review | 代码审查修复（6个问题）：React Hooks 违规（AppShell 拆分）、Express async 错误处理、access token localStorage → 内存、认证失败无退出路径、clearCookie 选项缺失、生产 nginx HTTP 时 Secure cookie 冲突 |


## 1. 功能目的

### 问题
TaskFlow 当前是一个功能完整的前端 SPA，所有数据存储在浏览器 `localStorage`，无法在 iPhone 上作为原生 App 使用，也无法跨设备同步数据。

### 目标
1. **Phase 1**：将现有 Web App 封装为原生 iOS App，通过 AltStore 旁加载部署到个人 iPhone，无需 Apple Developer Program。
2. **Phase 2**：开发后端服务（Node.js + Fastify + PostgreSQL），实现用户认证与任务数据云端同步。
3. **Phase 3**：集成后端的 App 继续通过 AltStore 旁加载测试，验证完整端到端流程，为未来上架 App Store 做准备。

### 范围边界
- Phase 1 不涉及任何后端或网络请求，数据继续存储在本地（Capacitor 的 Preferences/SQLite）。
- Phase 2 不涉及 App Store 上架，不需要购买 Apple Developer Program。
- Phase 3 不上架 App Store，仅个人设备测试验证。

---

## 2. TodoList

### Phase 1：Capacitor 封装 + AltStore 旁加载

- [ ] **P1-1** 移动端适配优化（viewport、safe area、touch 手势）
- [ ] **P1-2** 添加 Web App Manifest 和 iOS 图标/启动屏素材
- [ ] **P1-3** 安装并初始化 Capacitor，配置 `capacitor.config.ts`
- [ ] **P1-4** 构建 Web 产物，同步到 iOS 项目（`npx cap sync ios`）
- [ ] **P1-5** 用 Xcode 免费个人账号签名，通过 AltStore 安装到 iPhone
- [ ] **P1-6** 将 `localStorage` 迁移到 Capacitor Preferences 插件（持久化更稳定）
- [ ] **P1-7** 验收：App 在 iPhone 上正常运行，数据持久化，7 天重签流程走通

### Phase 2：后端开发

- [ ] **P2-1** 后端项目初始化（Fastify + TypeScript + PostgreSQL + Prisma ORM）
- [ ] **P2-2** 数据库 Schema 设计（users、tasks 表）
- [ ] **P2-3** 用户认证模块（注册/登录，JWT Access Token + Refresh Token）
- [ ] **P2-4** 任务 CRUD API（GET/POST/PUT/DELETE `/tasks`）
- [ ] **P2-5** 数据同步策略（last-write-wins，基于 `updatedAt` 时间戳）
- [ ] **P2-6** 前端接入：替换 `localStorage` 为 API 调用，增加离线缓存降级
- [ ] **P2-7** 后端部署（Railway 或 Render 免费层）
- [ ] **P2-8** 验收：App 在 iPhone 上登录、创建任务、换设备后数据同步

### Phase 3：集成测试与扩展准备

- [ ] **P3-1** 重新打包集成后端的 App，通过 AltStore 旁加载到 iPhone
- [ ] **P3-2** 端到端测试（离线 → 在线同步、冲突处理、token 刷新）
- [ ] **P3-3** 性能与体验优化（启动时间、动画流畅度、网络错误提示）
- [ ] **P3-4** 整理上架准备清单（截图、描述、隐私政策），为后续 App Store 提交做铺垫

---

## 3. 具体执行方案

### Phase 1：Capacitor 封装 + AltStore 旁加载

#### 涉及模块
- `index.html`：补充 iOS meta 标签（`apple-mobile-web-app-capable`、`viewport-fit=cover`）
- `src/app/App.tsx`：适配 safe area insets（底部导航避开 Home Indicator）
- `capacitor.config.ts`：新增文件，配置 App ID 和 Web 目录
- `ios/`：Capacitor 自动生成的 Xcode 项目目录

#### 执行步骤

```
1. 移动端 UI 适配
   → 验证：iPhone Safari 模拟器中无内容被遮挡

2. 安装 Capacitor
   pnpm add @capacitor/core @capacitor/cli @capacitor/ios @capacitor/preferences
   npx cap init TaskFlow com.yourname.taskflow --web-dir dist
   npx cap add ios
   → 验证：ios/ 目录生成，Xcode 可打开

3. 构建 + 同步
   pnpm run build && npx cap sync ios
   → 验证：Xcode 中 WKWebView 加载 App 正常

4. 签名与安装
   - Xcode → Signing & Capabilities → 选个人免费 Apple ID
   - 导出 IPA（Ad Hoc / Development）
   - AltStore 旁加载 IPA
   → 验证：iPhone 上 App 图标出现，可正常启动
```

#### 关于 7 天重签
- 免费 Apple ID 签发的证书 7 天过期。
- 使用 **AltStore**（需要电脑 + 同 Wi-Fi）或 **SideStore**（可自签，无需电脑）维持续签。
- SideStore 推荐用于长期使用。

---

### Phase 2：后端开发

#### 技术选型
| 层级 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js + TypeScript | 与前端同语言，复用类型定义 |
| Web 框架 | Fastify | 比 Express 更快，内置 Schema 校验 |
| ORM | Prisma | 类型安全，迁移工具完善 |
| 数据库 | PostgreSQL | 稳定，免费云服务（Railway/Neon）可用 |
| 认证 | JWT（Access 15min + Refresh 30d） | 无状态，适合移动端 |
| 部署 | Railway 或 Render（免费层） | 零成本启动 |

#### 数据库 Schema（简版）

```sql
-- users
id, email, password_hash, created_at

-- tasks
id, user_id, title, priority, estimate_minutes,
status, tag, progress, due_date, created_at, updated_at
```

#### API 设计

```
POST   /auth/register
POST   /auth/login
POST   /auth/refresh

GET    /tasks          -- 拉取当前用户所有任务
POST   /tasks          -- 创建任务
PUT    /tasks/:id      -- 更新任务（含状态、进度）
DELETE /tasks/:id      -- 删除任务
```

#### 同步策略
- 前端本地维护任务缓存（Capacitor Preferences）。
- App 启动时拉取服务端数据，以 `updatedAt` 最新的为准（last-write-wins）。
- 离线时操作写入本地，联网后批量同步。

---

### Phase 3：集成测试

#### 执行步骤
```
1. 前端切换 API baseURL 到生产环境地址
2. pnpm run build && npx cap sync ios
3. Xcode 重新签名 → AltStore/SideStore 安装
4. 在 iPhone 上完整测试：注册 → 创建任务 → 离线操作 → 恢复网络 → 验证同步
```

#### 未来上架准备（备忘）
- 购买 Apple Developer Program（$99/年）
- 配置 TestFlight，邀请测试用户
- 准备 App Store 截图、App 描述、隐私政策页面
- 提交审核

---

---

## iOS 动画 & 缩放修复计划（2026-05-31）

### 功能目的
修复 iPhone 上两个体验问题：
1. 点击添加任务时弹窗动画卡顿
2. 页面有时进入放大/非全屏状态

### 根因定位
| 问题 | 文件 | 根因 |
|---|---|---|
| 动画卡顿 | `App.tsx` L829 | Dialog 用 CSS 多属性动画（opacity+scale+translateX+translateY）+ backdrop-blur-sm |
| 页面放大 | `App.tsx` L837–869 | 表单 input/select `text-sm`（14px），iOS 聚焦自动缩放 |
| 页面放大 | `index.html` L8 | viewport meta 缺少 `maximum-scale=1, user-scalable=no` |

### TodoList
- **T1**：`index.html`：补充 `maximum-scale=1, user-scalable=no`
- **T2**：`App.tsx` 表单 input/select：移除 `text-sm`，确保字体 ≥ 16px
- **T3**：`App.tsx`：Add Task Dialog → Bottom Sheet（motion/react，仅 Y 轴，移除 backdrop-blur）

---

## 更新日志

### 2026-05-31 — UI 体验修复（Round 2）

**问题与方案：**
- **R2-T1** 空页面可滚动 → 根 div `min-h-screen` 改 `h-screen overflow-hidden`，内容区 `overflow-y-auto`
- **R2-T2** Add Task 动画异常 → Bottom Sheet 改居中卡片（motion/react scale+opacity spring）
- **R2-T3** Deadline 字段太窄 → Deadline 和 Category Tag 各自独占一整行

### 2026-05-31 — 代码审查修复

**代码审查发现的问题（已修复）：**

| 严重度 | 问题 | 受影响项 | 修复 |
|---|---|---|---|
| High | Bottom Sheet 未阻止点击事件冒泡，backdrop 点击可能穿透到 Sheet 内部元素 | T3 | Sheet `motion.div` 增加 `onClick={(e) => e.stopPropagation()}` |
| Medium | Escape 键处理函数缺少 `e.preventDefault()`，可能与其他处理器冲突 | T3 | Escape handler 增加 `e.preventDefault()` |

### 2026-05-31 — iOS 动画 & 缩放修复完成

**已完成的代码变更：**
- `index.html` — viewport meta 补充 `maximum-scale=1, user-scalable=no`，禁止 Capacitor App 被误操作缩放
- `src/app/App.tsx` — Add Task 表单所有 input/select 从 `text-sm`（14px）改为 `text-base`（16px），阻止 iOS WKWebView 自动缩放
- `src/app/App.tsx` — Add Task Dialog 改为 Bottom Sheet（`motion/react` spring，仅 Y 轴动画，移除 backdrop-blur-sm），增加 Escape 键关闭支持



**已完成的代码变更：**
- `index.html` — 添加 iOS PWA meta 标签（`viewport-fit=cover`、`apple-mobile-web-app-capable`、状态栏样式）和 manifest 链接
- `src/styles/theme.css` — 新增 `.pt-safe`、`.pb-safe`、`.bottom-safe` 安全区域 CSS 工具类
- `src/app/App.tsx` — 根 div 和 FAB 按钮使用安全区域类；启动时从 Capacitor Preferences 恢复数据
- `src/app/storage.ts` — 新增统一存储模块，写入 localStorage 同时异步备份到 Capacitor Preferences
- `public/manifest.json` — PWA manifest
- `capacitor.config.ts` — Capacitor 配置（App ID: `com.yourname.taskflow`）
- `package.json` — 版本升至 `1.0.0`，新增 `npm run ios`、`cap:sync`、`cap:open` 脚本
- Capacitor 包已安装：`@capacitor/core` / `cli` / `ios` / `preferences` / `splash-screen`

**待用户手动执行（需要 Mac + Xcode）：**
1. `npx cap add ios` — 生成 Xcode 项目
2. 替换 `public/icons/` 中的占位图标
3. Xcode 签名 → Archive → 导出 IPA → AltStore/SideStore 安装

**参考文档：**
- `doc/deploy-ios.md` — 完整部署步骤
- `doc/VERSIONING.md` — 版本号管理规范
