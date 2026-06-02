# TaskFlow Phase 3 — 自动登录 + 市场建议

## 1. 功能目的

**问题**：当前 auto-login 依赖 httpOnly cookie + `sameSite: 'strict'`。在 Capacitor WKWebView 中，`capacitor://localhost` 与服务器跨站，cookie 不被发送，`apiRefresh()` 始终失败，用户每次重启 App 都要重新登录。

**目标**：后端 login/register 返回 refreshToken 到 Body，前端存入 localStorage，刷新时用 Authorization header 发送，兼容所有环境（HTTP/HTTPS/Capacitor/Browser）。

---

## 2. TodoList

| ID | 任务 | 描述 | 依赖 |
|----|------|------|------|
| `backend-refresh-token-body` | 后端 login/register 返回 refreshToken | JSON body 新增 `refreshToken` 字段 | 无 |
| `backend-refresh-accept-header` | refresh 端点接受 Header 传 token | 同时支持 cookie 和 `Authorization: Bearer <refreshToken>` | 无 |
| `frontend-store-refresh-token` | 前端存储使用 refreshToken | login 存 localStorage，refresh 用 header 发送，logout 清除 | 以上两者 |
| `frontend-auto-login` | 前端自动登录 | on mount 用存储的 refreshToken 自动刷新 | 前端存储 |

---

## 3. 具体执行方案

### 3.1 后端：login/register 返回 refreshToken

```ts
// 在 login/register 响应 JSON 中新增
res.json({ accessToken, refreshToken, user: { id, email } });
```

### 3.2 后端：refresh 端点同时接受 cookie 和 header

```ts
// POST /auth/refresh
// 优先用 cookie，其次用 Authorization header
const token = req.cookies?.[REFRESH_COOKIE] 
  || req.headers.authorization?.split(' ')[1];
```

### 3.3 前端：存储和使用 refreshToken

```ts
// api.ts
let refreshToken: string | null = null;

export async function apiLogin(...) {
  // ...login call...
  refreshToken = data.refreshToken;
  localStorage.setItem('taskflow_refresh_token', refreshToken);
}

export async function apiRefresh() {
  const token = refreshToken || localStorage.getItem('taskflow_refresh_token');
  // Send as Authorization: Bearer <token>
  // Also try cookie fallback
}
```

### 3.4 影响范围

| 文件 | 改动 |
|------|------|
| `backend/src/routes/auth.ts` | login/register 返回 refreshToken，refresh 接受 header |
| `src/app/api.ts` | 存储/使用 refreshToken |
| `src/app/App.tsx` | logout 时清除 refreshToken |

---

## 4. 市场建议

### 建议优先实现的功能（按价值排序）

1. **统计面板** — 完成任务趋势图、每日/每周完成率，让用户有成就感
2. **任务搜索** — 历史任务快速搜索
3. **自定义标签颜色** — 让用户个性化分类
4. **App 图标 + 启动画面** — 专业的第一印象
5. **推送通知** — 到期提醒，提升日活留存
6. **深色模式自动/手动切换** — 已有样式支持，加个 toggle
7. **引导页** — 首次使用 3 屏介绍核心功能
8. **数据导出** — JSON/CSV 导出，降低用户迁移成本

### App Store 准备

- 应用名称、副标题、关键词优化（ASO）
- 至少 3 张高质量截图（Flow 视图 + Calendar + 统计）
- 隐私政策页面
