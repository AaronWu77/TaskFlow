# Codex Instructions

## Project Overview

TaskFlow is a personal task management web app centered on a "task flow" model — the default view is the next task to focus on, not a calendar. It's a Figma-generated React + Vite + Tailwind CSS v4 SPA.

## Commands

```bash
pnpm install        # install dependencies (uses pnpm workspace)
pnpm run dev        # start dev server (Vite)
pnpm run build      # production build
```

> The README says `npm i` / `npm run dev`, but the workspace config is pnpm (`pnpm-workspace.yaml`). Either works; prefer pnpm.

## Architecture

The entire application lives in **`src/app/App.tsx`** — one large file containing all types, helpers, components, and the root `App` component. There is no routing (single page). Two view modes are implemented inline:

- **Flow view** — card-stack interface showing the current task with swipe/action buttons (Complete, Snooze, Skip). Uses `motion/react` `Reorder` for drag-to-reorder via a bottom sheet.
- **Calendar view** — month grid with per-day task lists. Clicking a day shows tasks; clicking a task opens a `TaskDetailModal`.

All state is managed with `useState`/`useEffect` inside `App`. Tasks persist to `localStorage` under these keys:
- `taskflow_tasks` — task array
- `taskflow_streak` — `{ count, lastDate }`
- `taskflow_completed_today` — `{ date, count }`

**`src/app/components/ui/`** — shadcn/ui component library (Radix UI wrappers). These are pre-built and should not be modified; import from here instead of writing primitives.

**`src/app/components/figma/ImageWithFallback.tsx`** — Figma asset helper.

**`src/styles/theme.css`** — CSS custom properties for the design tokens (light + dark). All color/spacing tokens are defined here and mapped to Tailwind via `@theme inline`.

## Key Conventions

### Styling
- **Tailwind CSS v4** with the `@tailwindcss/vite` plugin. All design tokens (`--primary`, `--card`, `--border`, etc.) are CSS variables defined in `src/styles/theme.css` and consumed as Tailwind classes (`bg-card`, `text-primary`, `border-border`).
- Dark mode is applied via the `.dark` class on a parent element (`@custom-variant dark (&:is(.dark *))`).
- Use `cn()` from `src/app/components/ui/utils.ts` (re-export of `clsx` + `tailwind-merge`) for conditional class merging.
- Do **not** add `.css`, `.tsx`, or `.ts` files to `vite.config.ts`'s `assetsInclude`; only `.svg` and `.csv` are raw-imported.

### Path Alias
`@` resolves to `./src` — use `@/app/components/ui/button` etc.

### Figma Asset Imports
Assets can be imported with the `figma:asset/<filename>` virtual module (resolved to `src/assets/` by the custom Vite plugin in `vite.config.ts`).

### Task Data Model
```ts
interface Task {
  id: string;
  title: string;
  priority: 'P1' | 'P2' | 'P3';   // P1 = High, P2 = Medium, P3 = Low
  estimateMinutes: number;
  status: 'todo' | 'doing' | 'done' | 'snoozed' | 'skipped';
  tag?: string;
  progress: number;                 // 0–100
  dueDate?: string | null;          // 'YYYY-MM-DD'
}
```

Priority colors: P1 → rose, P2 → amber, P3 → emerald (constants `PRIORITY_BADGE`, `DOT_COLOR`).

### Animations
Use `motion/react` (the `motion` package, not `framer-motion`). The codebase uses `AnimatePresence`, `Reorder`, `useDragControls`, and spring transitions. Prefer spring physics (`type: 'spring'`) over duration-based easing for interactive elements.

### Modals
Use `@radix-ui/react-dialog` primitives directly (not the shadcn `Dialog` wrapper) for task-specific modals like `TaskDetailModal` and `RepeatTaskModal`. Always include `Dialog.Title` and `Dialog.Description` (use `className="sr-only"` if visually hidden) for accessibility.

### Preset Tags
Tags are limited to `['Work', 'Personal', 'Study', 'Planning', 'Health', 'Other']` (constant `PRESET_TAGS`). Do not introduce free-text tags without updating this list.


## Plan 模式约束

1. 进入 plan 模式后，任何方案都不能直接定稿。
2. 每形成一个计划步骤、设计决策或执行方案，必须先调用 `ask_user` 逐项询问用户是否接受。
3. 只有当前步骤得到用户明确确认后，才能进入下一步。
4. 所有计划细节确认后，除更新会话内计划外，还必须在仓库根目录创建或更新 `/doc/plan.md` 供用户审阅。
5. 若已有 `/doc/plan.md`，每次计划更新后都要同步更新该文件，确保用户可查看最新计划。

## `/doc/plan.md` 固定结构

`/doc/plan.md` 必须按以下顺序编写：

1. **功能目的**：问题、目标、范围边界。
2. **TodoList**：任务拆分。
3. **具体执行方案**：实施阶段、涉及模块、落地方式。

## Autopilot 模式约束

1. 进入 autopilot 模式后，不得直接开始执行。
2. 每次准备实施前，必须先调用 `ask_user`，确认是否按当前 `/doc/plan.md` 执行。
3. 只有在用户明确同意后，才能继续修改代码、运行命令或推进任务。
4. 若 `/doc/plan.md` 不存在、已过期，或用户要求调整方案，必须先回到计划确认流程。
5. 完成修改后，提醒用户运行 `/review`。

## `/review` 约束

1. 用户要求 `/review` 时，先检查 `/doc/plan.md` 与本次改动是否一致。
2. 若审查通过，在本文档末尾维护简要更新日志；若无更新日志则主动创建。
3. 若审查发现问题，调用 `ask_user` 反馈问题，并在 `/doc/plan.md` 追加代码审查部分，标注问题与受影响 TodoList 项，最后提醒用户重新执行 `/plan`。

## 执行行为准则

### 1. 编码前思考

**不要假设。不要隐藏困惑。呈现权衡。**

- **明确说明假设** — 如果不确定，询问而不是猜测
- **呈现多种解释** — 当存在歧义时，不要默默选择
- **适时提出异议** — 如果存在更简单的方法，说出来
- **困惑时停下来** — 指出不清楚的地方并要求澄清

### 2. 简洁优先

**用最少的代码解决问题。不要过度推测。**

- 不要添加要求之外的功能
- 不要为一次性代码创建抽象
- 不要添加未要求的"灵活性"或"可配置性"
- 不要为不可能发生的场景做错误处理
- 如果 200 行代码可以写成 50 行，重写它

**检验标准：** 资深工程师会觉得这过于复杂吗？如果是，简化。

### 3. 精准修改

**只碰必须碰的。只清理自己造成的混乱。**

编辑现有代码时：

- 不要"改进"相邻的代码、注释或格式
- 不要重构没坏的东西
- 匹配现有风格，即使你更倾向于不同的写法
- 如果注意到无关的死代码，提一下 —— 不要删除它

当你的改动产生孤儿代码时：

- 删除因你的改动而变得无用的导入/变量/函数
- 不要删除预先存在的死代码，除非被要求

**检验标准：** 每一行修改都应该能直接追溯到用户的请求。

### 4. 目标驱动执行

**定义成功标准。循环验证直到达成。**

将指令式任务转化为可验证的目标：

| 不要这样做... | 转化为... |
|--------------|-----------------|
| "添加验证" | "为无效输入编写测试，然后让它们通过" |
| "修复 bug" | "编写重现 bug 的测试，然后让它通过" |
| "重构 X" | "确保重构前后测试都能通过" |

对于多步骤任务，说明一个简短的计划：

```
1. [步骤] → 验证: [检查]
2. [步骤] → 验证: [检查]
3. [步骤] → 验证: [检查]
```