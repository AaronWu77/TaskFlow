# TaskFlow

> 以「任务流」为核心的个人任务管理应用 —— 始终聚焦于**当前最该做的那一件事**。

TaskFlow 用卡片堆叠界面取代了永无止境的清单，让你每次只面对一张任务卡。完成、延后、跳过，一步到位。可选切换日历视图查看任务排期。登录后，任务数据通过自托管后端在所有设备间同步。

## 功能亮点

- **任务流视图** — 每次只展示一张任务卡，支持完成、延后（Snooze）、跳过操作
- **日历视图** — 月度网格，按天展示任务列表，点击任务打开详情弹窗
- **拖拽排序** — 底部抽屉支持通过拖拽手柄对待办队列重新排序
- **智能插入** — 新任务按截止日期和优先级自动插入到正确位置
- **进度追踪** — 每个任务附带进度滑块（0–100%），实时波浪填充动效
- **连续打卡** — 统计连续完成任务的天数（Streak），跨设备同步
- **重复任务** — 在日历视图中一键将已完成任务重新加入队列
- **深色模式** — 通过 CSS 自定义属性实现完整的亮色/暗色主题
- **账号系统** — 邮箱 + 密码注册/登录，JWT 访问令牌 + httpOnly 刷新 Cookie
- **自托管后端** — Docker Compose 一键启动（Node.js API + PostgreSQL + Nginx）

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)（推荐）或 npm

### 前端 — 本地开发

```bash
pnpm install
pnpm run dev          # http://localhost:5173
```

### 后端 — 本地开发

```bash
cd backend
cp .env.example .env  # 填写密钥
npm install
npm run db:generate   # 生成 Prisma Client
# 先启动本地 PostgreSQL，然后：
npm run dev           # http://localhost:3000
```

### 生产部署 — Docker Compose

```bash
cp .env.example .env  # 填写 POSTGRES_PASSWORD、JWT_ACCESS_SECRET、JWT_REFRESH_SECRET
docker compose up -d
```

API 将通过 `http://你的服务器/api/` 访问。

> [!NOTE]
> 构建前端前，请设置 `VITE_API_URL=https://你的服务器/api`，使前端指向正确的后端地址。

### 生产构建（前端）

```bash
VITE_API_URL=https://你的服务器/api pnpm run build
```

## 技术栈

### 前端
| 层级 | 库 |
|---|---|
| 框架 | React 18 + Vite 6 |
| 样式 | Tailwind CSS v4（`@tailwindcss/vite`） |
| 动画 | `motion/react`（弹簧物理动效） |
| UI 基础组件 | shadcn/ui — Radix UI 封装，位于 `src/app/components/ui/` |
| 弹窗 | `@radix-ui/react-dialog`（任务弹窗直接使用原语） |
| 图标 | `lucide-react` |
| 移动端 | Capacitor（iOS） |

### 后端
| 层级 | 库 |
|---|---|
| 运行时 | Node.js 22 |
| 框架 | Express 4 + TypeScript |
| ORM | Prisma 5 + PostgreSQL 16 |
| 认证 | bcryptjs + jsonwebtoken |
| 部署 | Docker Compose + Nginx |

## 项目结构

```
├── src/                       # 前端（React + Vite）
│   └── app/
│       ├── App.tsx            # 所有 UI 组件、状态与逻辑
│       ├── AuthPage.tsx       # 登录 / 注册页
│       ├── api.ts             # API 客户端（自动刷新 Token）
│       └── components/ui/    # shadcn/ui 组件库
├── backend/                   # 后端 API
│   └── src/
│       ├── index.ts           # Express 入口
│       ├── middleware/auth.ts # JWT 鉴权中间件
│       ├── routes/auth.ts     # 注册 / 登录 / 刷新 / 登出
│       ├── routes/tasks.ts    # 任务 CRUD + 排序
│       └── prisma/schema.prisma
├── docker-compose.yml         # 生产部署配置
├── nginx.conf                 # 反向代理配置
└── .env.example               # 环境变量模板
```

## 数据模型

```ts
interface Task {
  id: string;
  title: string;
  priority: 'P1' | 'P2' | 'P3';   // 高 / 中 / 低
  estimateMinutes: number;
  status: 'todo' | 'doing' | 'done' | 'snoozed' | 'skipped';
  tag?: string;                    // Work | Personal | Study | Planning | Health | Other
  progress: number;                // 0–100
  dueDate?: string | null;         // 'YYYY-MM-DD'
  sortOrder: number;               // 用户自定义顺序
}
```

## API 接口

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| POST | `/auth/register` | — | 注册账号 |
| POST | `/auth/login` | — | 登录，返回令牌 |
| POST | `/auth/refresh` | cookie | 刷新访问令牌 |
| POST | `/auth/logout` | — | 清除刷新 Cookie |
| GET | `/tasks` | Bearer | 获取所有任务 |
| POST | `/tasks` | Bearer | 创建任务 |
| PATCH | `/tasks/:id` | Bearer | 更新任务 |
| DELETE | `/tasks/:id` | Bearer | 删除任务 |
| PUT | `/tasks/reorder` | Bearer | 批量更新排序 |

## 设计系统

所有颜色和间距 Token 以 CSS 自定义属性的形式定义在 `src/styles/theme.css` 中，并通过 `@theme inline` 映射为 Tailwind 类名。请使用语义化 Tailwind 类（如 `bg-card`、`text-primary`、`border-border`），不要硬编码十六进制颜色值。

暗色模式通过在父元素上添加 `.dark` 类来激活。

条件合并类名请使用 `src/app/components/ui/utils.ts` 中导出的 `cn()` 工具函数（`clsx` + `tailwind-merge` 的封装）。

## 致谢

UI 设计与资产生成由 [Figma Make](https://www.figma.com/design/qG1eukwOvwztxOcpCx1h5j/) 提供。  
第三方依赖归属详见 [ATTRIBUTIONS.md](./ATTRIBUTIONS.md)。

## 版本

### 1.0.0 — 前后端流程测试
### 1.0.1 — 修复 Progress Slider 不实时更新、任务数据迁移到服务器