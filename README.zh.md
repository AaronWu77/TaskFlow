# TaskFlow

> 以「任务流」为核心的个人任务管理应用 —— 始终聚焦于**当前最该做的那一件事**。

TaskFlow 用卡片堆叠界面取代了永无止境的清单，让你每次只面对一张任务卡。完成、延后、跳过，一步到位。可选切换日历视图查看任务排期。所有数据存储在浏览器本地，无需注册账号。

## 功能亮点

- **任务流视图** — 每次只展示一张任务卡，支持完成、延后（Snooze）、跳过操作
- **日历视图** — 月度网格，按天展示任务列表，点击任务打开详情弹窗
- **拖拽排序** — 底部抽屉支持通过拖拽手柄对待办队列重新排序
- **进度追踪** — 每个任务附带进度滑块（0–100%），实时波浪填充动效
- **连续打卡** — 统计连续完成任务的天数（Streak），存储于 `localStorage`
- **重复任务** — 在日历视图中一键将已完成任务重新加入队列
- **深色模式** — 通过 CSS 自定义属性实现完整的亮色/暗色主题

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)（推荐）或 npm

### 安装依赖

```bash
pnpm install
```

### 启动开发服务器

```bash
pnpm run dev
```

打开浏览器访问 [http://localhost:5173](http://localhost:5173)。

### 生产构建

```bash
pnpm run build
```

> [!NOTE]
> 项目使用 `pnpm-workspace.yaml` 工作区配置，`pnpm` 与 `npm` 均可使用，推荐使用 `pnpm`。

## 技术栈

| 层级 | 库 |
|---|---|
| 框架 | React 18 + Vite 6 |
| 样式 | Tailwind CSS v4（`@tailwindcss/vite`） |
| 动画 | `motion/react`（弹簧物理动效） |
| UI 基础组件 | shadcn/ui — Radix UI 封装，位于 `src/app/components/ui/` |
| 弹窗 | `@radix-ui/react-dialog`（任务弹窗直接使用原语） |
| 图标 | `lucide-react` |
| 数据持久化 | `localStorage`（无后端） |

## 项目结构

```
src/
├── app/
│   ├── App.tsx                  # 整个应用 —— 所有类型、状态与组件均在此文件
│   └── components/
│       ├── ui/                  # shadcn/ui 组件库（请勿修改）
│       └── figma/
│           └── ImageWithFallback.tsx
├── styles/
│   ├── theme.css                # CSS 自定义属性（设计 Token，亮色 + 暗色）
│   └── index.css
└── main.tsx
```

> [!IMPORTANT]
> 所有业务逻辑集中在单一文件 `src/app/App.tsx` 中，本项目无路由，为单页应用。

## 数据模型

```ts
interface Task {
  id: string;
  title: string;
  priority: 'P1' | 'P2' | 'P3';   // 高 / 中 / 低
  estimateMinutes: number;
  status: 'todo' | 'doing' | 'done' | 'snoozed' | 'skipped';
  tag?: string;                    // 枚举值：Work、Personal、Study、Planning、Health、Other
  progress: number;                // 0–100
  dueDate?: string | null;         // 'YYYY-MM-DD'
}
```

数据通过以下三个 `localStorage` 键持久化：

| 键名 | 内容 |
|---|---|
| `taskflow_tasks` | 任务数组 |
| `taskflow_streak` | `{ count, lastDate }` |
| `taskflow_completed_today` | `{ date, count }` |

## 设计系统

所有颜色和间距 Token 以 CSS 自定义属性的形式定义在 `src/styles/theme.css` 中，并通过 `@theme inline` 映射为 Tailwind 类名。请使用语义化 Tailwind 类（如 `bg-card`、`text-primary`、`border-border`），不要硬编码十六进制颜色值。

暗色模式通过在父元素上添加 `.dark` 类来激活。

条件合并类名请使用 `src/app/components/ui/utils.ts` 中导出的 `cn()` 工具函数（`clsx` + `tailwind-merge` 的封装）。

## 致谢

UI 设计与资产生成由 [Figma Make](https://www.figma.com/design/qG1eukwOvwztxOcpCx1h5j/) 提供。  
第三方依赖归属详见 [ATTRIBUTIONS.md](./ATTRIBUTIONS.md)。
