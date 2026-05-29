# TaskFlow 开发计划

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

## 更新日志

### 2026-05-29 — Phase 1 代码已完成

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
