# TaskFlow 问题修复实施计划（第二轮）

## 1. 功能目的

### 1.1 问题

用户报告当前版本存在三类可感知问题：

1. **自动登录失效**：退出 App 并关闭后台后再次进入，未能自动恢复登录状态，需要重新输入邮箱和密码。
2. **任务卡片交互异常**：在 Flow 与 Calendar 界面中，进度条只能点击不能滑动（滑动触发 Snooze），且点击 Snooze/Skip 按钮实际触发的是 Complete 动作。
3. **主色调切换**：账户页需要提供主色调切换功能（经代码审查发现此功能已实现，需验证是否正常工作）。

### 1.2 目标

1. 自动登录在冷启动后稳定恢复，refresh token 机制在 Web 和 iOS 两端均可靠工作。
2. 进度条可正常拖动滑动；Snooze/Skip/Complete 三个按钮各自触发正确动作，互不干扰。
3. 确认主色调切换功能正常工作，如有问题则修复。
4. Web 与 iOS（Capacitor）两端行为一致。

### 1.3 范围边界

1. 本次不重构整体架构，不拆分 `src/app/App.tsx`。
2. 不修改 shadcn/ui 组件库源码，仅在业务层修复。
3. 不引入新的依赖。

---

## 2. 根因分析

### 2.1 自动登录失效

**当前架构**：
- Access token 仅存内存（`api.ts:10`），页面刷新即丢失
- Web 端 refresh token 仅依赖 httpOnly cookie `taskflow_refresh`（`api.ts:34-36` 返回 null）
- iOS 端 refresh token 存 Capacitor Preferences（`api.ts:38-43`）
- 启动时 `restoreSession()` 调用 `apiRefreshDetailed()` 尝试刷新（`App.tsx:1980`）

**可能根因**：
1. **Web 端 cookie 丢失**：`SameSite: 'strict'`（`backend/src/routes/auth.ts:31`）在某些场景下阻止 cookie 发送；浏览器可能在关闭后清除 cookie
2. **iOS 端 Capacitor Preferences 不可靠**：WKWebView 的 httpOnly cookie 不保证跨重启持久化；Preferences 存储可能被 iOS 清理
3. **后端 JWT secret 变更**：如果后端重启导致 `JWT_REFRESH_SECRET` 变化，所有已签发的 refresh token 失效
4. **`canUseSession` 逻辑缺陷**：`isSessionExpired` 基于客户端时间戳（7天TTL），但 `clearSession()` 直接删除 session 而非设置 `signedOut: true`，导致 `signedOut` 守卫形同虚设（`App.tsx:90-94`）

### 2.2 任务卡片交互异常

**2.0.0 版本（正常）**：
- 按钮使用简单 `onClick` + `isSlidingProgress` 守卫
- 进度条有完整的 `onPointerDown/Up/Cancel` + `onMouseUp` + `onTouchStart/End` 处理

**当前版本（异常）**：
- 按钮增加了 `onPointerDown`/`onPointerUp` 用于视觉反馈（`pressedAction`），但 **未调用 `e.stopPropagation()`**
- 进度条移除了 `onMouseUp` 和 `onTouchStart/End`，仅保留 pointer 事件
- 新增 `runAction()` 包装函数，引入 `canTriggerAction()` 检查和 `blockActionUntilRef` 防抖

**可能根因**：
1. **Pointer 事件冒泡**：按钮的 `onPointerDown` 未 `stopPropagation()`，事件可能冒泡到父容器干扰其他组件
2. **`isSlidingProgress` 状态竞争**：React state 异步更新，`runAction` 中检查的 `isSlidingProgress` 可能是过期值
3. **CSS 层叠问题**：Complete 按钮 `z-20` 与 Snooze/Skip 容器 `z-20` 相同，Complete 按钮可能在视觉上覆盖了 Snooze/Skip 的点击区域

### 2.3 主色调切换

**现状**：代码中已实现 5 套预设主色调（lavender/ocean/forest/sunset/rose），AccountPage 中已有色块选择 UI，且有 `accentThemeReady` 门控防止 iOS 冷启动覆盖。**此功能可能已正常工作**，需用户确认。

---

## 3. TodoList

| ID | 任务 | 描述 | 验收标准 |
|---|---|---|---|
| `fix-auto-login` | 修复自动登录 | 诊断并修复 refresh token 在冷启动时不可用的问题 | 退出 App 关闭后台后重新进入，自动恢复登录状态 |
| `fix-card-interaction` | 修复任务卡片交互 | 恢复进度条滑动能力，修复按钮误触问题 | 进度条可拖动；Snooze/Skip/Complete 各自触发正确动作 |
| `verify-accent-theme` | 验证主色调切换 | 确认现有主色调切换功能是否正常工作 | 切换后全局主色实时变化；重启后保持 |
| `regression-test` | 回归测试 | 在 Web 和 iOS 上验证所有修复 | 三个问题均稳定修复，无新回归 |

---

## 4. 具体执行方案

### 阶段 A：修复自动登录

**涉及模块**：
- `src/app/api.ts`（refresh token 读取逻辑）
- `src/app/App.tsx`（`restoreSession` 函数）
- `backend/src/routes/auth.ts`（cookie 配置）

**执行步骤**：

1. **诊断 cookie 持久性**：检查 `COOKIE_OPTS` 配置（`auth.ts:28-33`），确认 `sameSite`/`secure`/`maxAge` 设置是否导致 cookie 在重启后丢失
2. **增加 Web 端 refresh token fallback**：在 `api.ts` 的 `getStoredRefreshToken()` 中，为 web 端增加 localStorage fallback（存储加密或混淆后的 token），作为 httpOnly cookie 的后备
3. **修复 `clearSession` 逻辑**：`clearSession()` 应设置 `signedOut: true` 而非直接删除，使 `canUseSession` 守卫生效
4. **增加诊断日志**：在 `restoreSession` 中增加关键节点日志（开发模式），帮助定位 refresh 失败的具体原因
5. **统一清理策略**：`handleLogout`、`onAuthFailure`、session 过期三条路径使用统一的清理函数

### 阶段 B：修复任务卡片交互

**涉及模块**：
- `src/app/App.tsx`（`TaskCard` 组件，约 391-560 行）

**执行步骤**：

1. **恢复按钮的 `stopPropagation`**：所有按钮的 `onPointerDown` 处理器增加 `e.stopPropagation()`，防止事件冒泡干扰
2. **简化 `runAction` 逻辑**：移除 `canTriggerAction()` 中的时间戳防抖（`blockActionUntilRef`），仅保留 `isSlidingProgress` 守卫，与 2.0.0 版本行为一致
3. **恢复进度条的多路径事件处理**：在 `onPointerUp` 基础上，增加 `onBlur` 兜底（已有），确保滑动结束时 `isSlidingProgress` 被正确重置
4. **修复 CSS 层叠**：确保 Complete 按钮的 `z-index` 不覆盖 Snooze/Skip 区域，或将按钮容器的 `z-index` 提高
5. **统一 Flow 与 Calendar 行为**：两处复用同一 `TaskCard`，确保 `TaskDetailModal` 中的交互一致

### 阶段 C：验证主色调切换

**涉及模块**：
- `src/app/App.tsx`（`AccountPage` + `applyAccentTheme`）

**执行步骤**：

1. **功能验证**：确认 5 个色块点击后 CSS 变量正确更新
2. **持久化验证**：确认重启后主题保持
3. **iOS 冷启动验证**：确认 `accentThemeReady` 门控正常工作
4. 如发现问题，按现有模式修复

### 阶段 D：回归测试

**执行步骤**：

1. Web 端全流程：登录 → 退出 → 关闭浏览器 → 重新打开 → 确认自动登录
2. Web 端 Flow 卡片：进度条滑动 → Snooze → Skip → Complete，确认各动作正确
3. Web 端 Calendar 详情卡：同上测试
4. 账户页：切换 5 种主色调，确认实时生效和持久化
5. 如有 iOS 环境，重复以上测试

---

## 更新日志

- 2026-06-07：第一轮计划与审查完成（主题持久化、任务卡交互、防泄漏 token、存储恢复健壮性）。
- 2026-06-07：用户报告问题仍存在，启动第二轮诊断与修复计划。重点：自动登录 cookie 持久性、按钮事件冒泡、进度条滑动恢复。
