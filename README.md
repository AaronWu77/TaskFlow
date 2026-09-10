# TaskFlow

> 一次只专注一件事的跨设备任务管理工具。

TaskFlow 以“任务流”代替容易令人焦虑的长清单：打开应用时，先完成眼前最重要的任务；需要时再用日历、筛选和排序掌握全局。任务可在 Web 与 iPhone 间同步，并在离线后自动补传。

## 核心体验

- **Flow**：以卡片展示当前任务，支持完成、稍后处理与跳过。
- **Calendar**：按月查看任务排期、重复任务与已完成记录。
- **灵活组织**：优先级、截止日期、提醒、标签、预计时长与拖拽排序。
- **多端同步**：登录后通过操作队列、游标拉取和版本校验同步；冲突可自动合并或在应用内选择最终内容。
- **账号与数据控制**：邮箱验证、数据导出、最近删除和账号删除。
- **中英双语与 iOS 支持**：React 界面运行于浏览器和 Capacitor iOS 容器，提醒使用本地通知。

## 技术概览

前端使用 React、Vite、Tailwind CSS 和 Capacitor；后端为 Express、Prisma 与 PostgreSQL，通过 Docker Compose 和 Nginx 部署。默认生产 API 为 `https://taskflow.top/api`。

## 开发与部署

完整的本地开发、同步设计、环境变量、iOS 构建、服务器部署和发布检查，请阅读 [开发者手册](doc/DEVELOPER.md)。

常用命令：

```bash
npm install
npm run dev       # 启动 Web 开发服务器
npm run check     # 构建前后端并运行回归测试
npm run ios       # 构建、同步 Capacitor，并打开 Xcode
```

第三方资源声明见 [ATTRIBUTIONS.md](ATTRIBUTIONS.md)。
