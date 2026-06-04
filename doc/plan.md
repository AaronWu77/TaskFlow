# TaskFlow Phase 9 — 前后端分离 + 删除深色模式 + README 重构

## 1. 功能目的

- 删除深色模式全部代码（CSS 变量、ThemeProvider、UI 控件、meta 标签）
- 清理前后端代码结构，明确前端/后端边界
- 重写 README 仓库结构图反映新架构
- **严格保证所有现有功能不变**

---

## 2. TodoList

| ID | 任务 | 描述 |
|----|------|------|
| `remove-dark-mode` | 删除深色模式 | theme.css 删 .dark + @custom-variant; main.tsx 删 ThemeProvider; App.tsx 删 useTheme + 主题切换 UI + dark: 类; index.html 删 dark meta/body; sonner.tsx 删 useTheme; package.json 删 next-themes |
| `restructure-code` | 前后端代码分离整理 | 明确 src/ = 前端, backend/ = 后端; 清理根目录无关注释 |
| `rewrite-readme` | 重写 README 结构图 | 中英文 README 用新结构替换旧结构图，附前后端边界说明 |

---

## 3. 具体执行方案

### 3.1 删除深色模式

| 文件 | 删除内容 |
|------|----------|
| `src/styles/theme.css` | `@custom-variant dark` 行; `.dark { ... }` 整个块; `html` 中 `color-scheme: dark light` |
| `src/main.tsx` | `import { ThemeProvider }` + `<ThemeProvider>` 包裹 |
| `src/app/App.tsx` | `import { useTheme }`;  `const { theme, setTheme }`; AccountPage 中主题切换 UI 三段选择器; PRIORITY_BADGE 中 `dark:` 类; 其他 `dark:` 类（App.tsx 内约 4 处） |
| `index.html` | `body.dark` 规则; dark `theme-color` meta; `color-scheme` meta |
| `src/app/components/ui/sonner.tsx` | `import { useTheme }` + `const { theme } = useTheme()` → 改用固定 `theme="light"` |
| `package.json` | 删除 `"next-themes"` 依赖 |

### 3.2 前后端分离

当前已是分离结构：`src/` 前端 + `backend/` 后端。本次仅做代码清理：
- 前端：`src/app/`（React 组件）+ `src/styles/`（样式）+ `src/i18n/`（国际化）
- 后端：`backend/src/`（Express API）+ `backend/src/prisma/`（数据库）

无需移动文件。

### 3.3 README 结构图

用清晰的前后端分界替换旧结构图，标注每个目录的职责。

### 3.4 影响范围

| 文件 | 改动类型 |
|------|----------|
| `src/styles/theme.css` | 删除 `.dark` 块 + `@custom-variant dark` |
| `src/main.tsx` | 删 ThemeProvider |
| `src/app/App.tsx` | 删 useTheme + 主题切换 + dark: 类 |
| `index.html` | 删 dark meta/styles |
| `src/app/components/ui/sonner.tsx` | 改固定 light 主题 |
| `package.json` | 删 next-themes |
| `README.md` + `README.zh.md` | 重写结构图 |
