# TaskFlow 三合一修复计划

## 1. 功能目的

**问题 1 - Progress 拖动不实时更新**：在 Calendar 页面点开任务卡片后，拖动 progress 条时页面无实时变化，关闭卡片后变化才显示。

**问题 2 - 任务数据迁移到服务器**：当前所有任务数据仅存在 localStorage 中，无法多端同步。需要迁移到服务器端 PostgreSQL，前端保留 localStorage 作为离线缓存。

**问题 3 - 页面可上下滚动**：手机端页面存在非预期的上下滚动行为，需排查是 viewport 尺寸问题还是布局设计问题。

---

## 2. TodoList

| ID | 任务 | 说明 | 依赖 |
|----|------|------|------|
| `fix-progress-slider` | 修复 TaskDetailModal 中 progress slider 不实时更新 | CalendarView 中 detailTask 用 useState 存储的是快照，需改为通过 ID 派生 | 无 |
| `add-sortorder-frontend` | 前端 Task 类型补全 sortOrder 字段 | 后端已有 sortOrder，前端类型缺失 | 无 |
| `add-task-api-functions` | 在 api.ts 中添加 Task CRUD API 函数 | 封装 apiGetTasks / apiCreateTask / apiUpdateTask / apiDeleteTask / apiReorderTasks | `add-sortorder-frontend` |
| `replace-localstorage-with-api` | 替换 localStorage 持久化为 API 调用 | App.tsx 中 loadTasks/saveTasks → API，保留 localStorage 离线缓存 | `add-task-api-functions` |
| `add-userstats-backend` | 后端新增 UserStats 表及 API | Prisma 新增 UserStats 模型，创建 GET/PATCH /user/stats，添加数据库索引 | 无 |
| `connect-streak-to-api` | 前端 streak/completion 接入后端 API | 替换 localStorage 的 streak/completed 为 API + 离线缓存 | `add-userstats-backend` |
| `fix-page-scroll` | 修复移动端页面滚动问题 | h-screen → h-dvh，解决 100vh 包含浏览器 chrome 的问题 | 无 |
| `test-multi-task` | 端到端测试验证 | 验证 slider 实时更新、多端同步、页面不滚动 | 以上全部 |

---

## 3. 具体执行方案

### 3.1 修复 Progress Slider 不实时更新

**根因分析**：

`CalendarView` 中：
```ts
const [detailTask, setDetailTask] = useState<Task | null>(null);
```
当用户点击某天任务时，`setDetailTask(task)` 捕获的是当时的 task 快照。`TaskDetailModal` 中 `<TaskCard task={task} />` 使用的就是这个快照。

当用户拖动 progress slider → `handleProgressChange` → `setTasks` 更新了 AppShell 中的 `tasks` 数组 → `tasks` 作为 props 传入 `CalendarView`。但 `detailTask` 是独立 useState，不会随 props 更新。

**修复方案**：

将 `detailTask: Task | null` 改为 `detailTaskId: string | null`：
```ts
const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
const detailTask = detailTaskId ? tasks.find(t => t.id === detailTaskId) ?? null : null;
```
这样 detailTask 始终从最新的 tasks 中派生，slider 拖动时立即反映变化。

**影响文件**：`src/app/App.tsx` — CalendarView 组件内 `detailTask` 相关逻辑。

---

### 3.2 任务数据迁移到服务器

#### 3.2.1 前端 Task 类型补全 sortOrder

当前前端 `Task` 接口缺少 `sortOrder` 字段（后端 Prisma 已有）。需在 `App.tsx` 中补全：

```ts
interface Task {
  // ...existing fields...
  sortOrder: number;  // 新增
}
```

#### 3.2.2 api.ts 新增 Task CRUD 函数

```ts
// 类型（后端返回的任务格式）
interface TaskDTO {
  id: string; userId: string; title: string; priority: string;
  estimateMinutes: number; status: string; tag: string | null;
  progress: number; dueDate: string | null; sortOrder: number;
  createdAt: string; updatedAt: string;
}

export async function apiGetTasks(): Promise<TaskDTO[]>
export async function apiCreateTask(task: Partial<Task>): Promise<TaskDTO>
export async function apiUpdateTask(id: string, data: Partial<Task>): Promise<TaskDTO>
export async function apiDeleteTask(id: string): Promise<void>
export async function apiReorderTasks(order: Array<{ id: string; sortOrder: number }>): Promise<void>
```

#### 3.2.3 App.tsx 迁移策略

**数据流**：
```
加载：API → state (tasks) → localStorage (缓存)
保存：state (tasks) → API + localStorage (双写)
离线：localStorage → state → API (恢复联机后同步)
```

**具体改动**：
1. 移除 `loadTasks()` / `saveTasks()` 纯 localStorage 逻辑
2. 新增 `syncTasks()` 函数：
   - 启动时先尝试 API 获取，成功则写入 localStorage 缓存
   - API 失败则从 localStorage 读取作为降级
3. `handleAddTask` 中 `Math.random().toString(36)` → 等后端返回 id（或先用临时 ID 再替换）
4. 所有状态变更（complete/skip/snooze/progress/sortOrder）同步调用 API
5. 添加 `tasksLoading` / `tasksError` 状态管理

**离线策略**：
- 读：API 优先，失败回退 localStorage
- 写：先写 localStorage，再异步写 API（fire-and-forget with retry）
- 联机恢复：对比本地与远端时间戳，以远端为准合并

---

### 3.3 后端 UserStats 表及 API

#### 3.3.1 Prisma Schema 新增

```prisma
model UserStats {
  id            String   @id @default(cuid())
  userId        String   @unique
  streak        Int      @default(0)
  streakDate    String?  // YYYY-MM-DD, last streak date
  completedToday String? // YYYY-MM-DD
  todayCount    Int      @default(0)
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

#### 3.3.2 数据库索引优化

```prisma
model Task {
  // ...existing fields...
  @@index([userId, status])
  @@index([userId, dueDate])
  @@index([userId, sortOrder])
}
```

#### 3.3.3 API 端点

- `GET /user/stats` — 获取当前用户的 streak/completedToday
- `PATCH /user/stats` — 更新 streak/completedToday（完成任务时调用）

---

### 3.4 修复页面滚动问题

**根因分析**：

`App.tsx` 根 div 使用 `h-screen`（即 `100vh`），在移动端浏览器上 `100vh` 包含了地址栏等浏览器 chrome 的高度，导致实际可视区域小于 `100vh`，页面产生纵向滚动。

同样问题存在于 `AuthPage.tsx` 和 loading spinner。

**修复方案**：

将以下位置的 `h-screen` 替换为 `h-dvh`（Tailwind CSS v4.1+ 原生支持 `100dvh`）：

| 位置 | 文件 | 行号 |
|------|------|------|
| App 根 div | `src/app/App.tsx` | L726 |
| AuthPage 根 div | `src/app/AuthPage.tsx` | L37 |
| Loading spinner | `src/app/App.tsx` | L1010 |

`h-dvh` 使用动态视口高度（`100dvh`），随浏览器 chrome 显示/隐藏实时调整，避免溢出滚动。

---

### 3.5 执行顺序

```
Phase 1（独立）：
  ├── fix-progress-slider   ← 单文件、低风险
  ├── add-sortorder-frontend ← 类型补全
  └── fix-page-scroll        ← 3 处 h-screen → h-dvh

Phase 2（后端）：
  └── add-userstats-backend  ← Prisma + 路由

Phase 3（前端核心）：
  ├── add-task-api-functions
  ├── replace-localstorage-with-api
  └── connect-streak-to-api

Phase 4（验证）：
  └── test-multi-task
```

---

## 4. 代码审查

### 审查日期：2026-06-02

| 发现 | 严重度 | 状态 |
|------|--------|------|
| `restoreFromNativeStorage` 不再更新 React state（iOS 冷启动后数据丢失） | High | ✅ 已修复 — 恢复 `.then()` 链，Capacitor restore 后重新读取 state |
| 缺少离线合并策略 — 离线创建/修改的任务在重连后被远程数据覆写 | High | ✅ 已修复 — 新增 merge 逻辑：remote 优先，local-only 同步到服务器 |
| 新建任务 `sortOrder` 始终为 0，刷新后排序错误 | Medium | ✅ 已修复 — 基于 `insertIndex` 计算正确 `sortOrder` |
| `tasksLoading` 未在 UI 中使用 — 加载时显示误导的空态 | Medium | ✅ 已修复 — 添加加载 spinner |

### Plan 符合性

| Plan ID | 状态 |
|---------|------|
| `fix-progress-slider` | ✅ |
| `add-sortorder-frontend` | ✅ |
| `add-task-api-functions` | ✅ |
| `replace-localstorage-with-api` | ✅（含合并策略） |
| `add-userstats-backend` | ✅ |
| `connect-streak-to-api` | ✅ |
| `fix-page-scroll` | ✅ |
| `test-multi-task` | ⚠️ 需在手机端实际部署测试 |

---

## 5. 更新日志

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-06-02 | 初始计划创建 | Copilot |
| 2026-06-02 | 代码审查完成，修复 4 个问题 | Copilot |
