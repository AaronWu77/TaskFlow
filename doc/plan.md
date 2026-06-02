# TaskFlow 同步策略重构计划

## 1. 功能目的

当前同步存在多个问题：缺少同步状态追踪、退出不清除本地数据、离线任务重复创建。需重新设计为以云端为主的同步架构。

**核心策略**：
1. **登录时**：云端拉取全量 → 本地存储（标记已同步 + 时间戳）
2. **操作时**：本地优先 → 标记脏数据 → 后台推送到云端 → 失败弹 toast
3. **退出时**：推送所有脏数据 → 彻底清除本地数据库

---

## 2. TodoList

| ID | 任务 | 描述 | 依赖 |
|----|------|------|------|
| `add-sync-metadata` | 添加同步元数据 | Task 类型加 `_dirty` 字段，localStorage 加 `taskflow_last_sync` 时间戳 | 无 |
| `redesign-init-login` | 重构登录/初始化流程 | 云端拉取全量任务 → 标记 `_dirty: false` → 存本地 | `add-sync-metadata` |
| `redesign-write-flow` | 重构写入流程 | 所有操作：先写本地 → 标记 dirty → 后台推送 → 成功后标记 clean → 失败弹 toast | `add-sync-metadata` |
| `add-logout-sync` | 添加退出同步 | 退出时推送所有脏数据 → 清除全部 localStorage | `redesign-write-flow` |
| `add-toast-notifications` | 添加同步失败 toast 提示 | 用 sonner toast 通知用户推送失败 | `redesign-write-flow` |
| `test-sync-redesign` | 端到端测试 | 验证登录拉取 → 操作推送 → 退出清除 全流程 | 以上全部 |

---

## 3. 具体执行方案

### 3.1 同步元数据

**Task 类型**（仅前端内部使用）：
```ts
interface Task {
  // ...existing fields...
  _dirty?: boolean;
}
```

**localStorage 新增键值**：`taskflow_last_sync`（ISO 时间戳）

### 3.2 登录/初始化流程

```
login → apiGetTasks() → 全部标记 _dirty: false → saveTasksToCache + lastSyncTime
     → apiGetUserStats() → setStreak/setCompletedToday
如果 offline：使用 localStorage 缓存
```

### 3.3 写入流程

所有操作统一模式：
```
1. 乐观更新 state
2. 标记 _dirty: true → saveTasksToCache
3. 后台推送 API → 成功: _dirty: false + saveTasksToCache
                    失败: toast.error + 保持 dirty
```

### 3.4 退出同步

```
logout →
  1. flushDirtyTasks() → 逐个推送 apiUpdateTask
  2. apiUpdateUserStats() → 推送当前统计
  3. apiLogout()
  4. clear localStorage (tasks, streak, stats, lastSync, logged_in)
```

### 3.5 Toast

```ts
import { toast } from 'sonner';
toast.error('Sync failed — retrying on next action');
```

### 3.6 执行顺序

```
Phase 1: add-sync-metadata
Phase 2: redesign-init-login + redesign-write-flow (并行)
Phase 3: add-toast-notifications → add-logout-sync
Phase 4: test-sync-redesign
```

## 6. 代码审查（2026-06-02 同步策略重构）

| 发现 | 严重度 | 修复 |
|------|--------|------|
| `Toaster` 组件未 import — 运行时崩溃 | 🔴 Critical | ✅ `import { toast, Toaster } from 'sonner'` |
| 退出 flush 不调 `apiCreateTask` — 新建脏数据丢失 | 🔴 High | ✅ 用 `flushDirtyTasks()` 替代 inline 逻辑 |
| Init 云端拉取丢弃本地脏数据 — 刷新丢数据 | 🔴 High | ✅ 保留 localStorage 中 `_dirty: true` 的任务 |
| `completedToday` stale closure — 快速完成多个任务计数丢失 | 🟡 Medium | ✅ 改用 `setCompletedToday(c => { const n = c+1; push(n); return n })` |

构建验证 ✅
