# Phase 1 部署指南：安装到 iPhone（免费，无需 Developer Program）

## 前置条件

| 工具 | 说明 |
|---|---|
| **macOS** | 必须，Xcode 只有 macOS 版本 |
| **Xcode 15+** | 从 Mac App Store 免费下载 |
| **Apple ID** | 普通免费账号即可，不需要付费 Developer Program |
| **SideStore**（推荐）或 **AltStore** | 旁加载工具，安装到 iPhone 后可自签续签 |
| **Node.js 18+** | 已有 |

---

## 第一步：添加 iOS 平台

> 只需执行一次。

```bash
cd /path/to/TaskFlow
npx cap add ios
```

这会生成 `ios/` 目录（Xcode 项目）。

---

## 第二步：构建并同步到 Xcode

每次修改代码后都需要执行：

```bash
npm run ios
# 等同于：npm run build && npx cap sync ios && npx cap open ios
```

或者分步执行：

```bash
npm run build       # 编译 React 产物到 dist/
npx cap sync ios    # 将 dist/ 同步进 Xcode 项目
npx cap open ios    # 用 Xcode 打开项目
```

---

## 第三步：在 Xcode 中配置签名

1. 打开 `ios/App/App.xcworkspace`（如果 `npm run ios` 已自动打开则跳过）
2. 点击左侧 **App** 项目 → 选 **Signing & Capabilities** Tab
3. **Team**：点击下拉菜单 → 选你的 Apple ID（若未登录：Xcode → Preferences → Accounts → 添加账号）
4. **Bundle Identifier**：改为 `com.yourname.taskflow`（与 `capacitor.config.ts` 保持一致）
5. 勾选 **Automatically manage signing**

> 免费账号签名的证书有效期 **7 天**，到期后需重签（见下文）。

---

## 第四步：在 Xcode 中安装到 iPhone

### 方式 A：有线连接（最简单）

1. 用 USB 线连接 iPhone
2. Xcode 顶部设备选择器选你的 iPhone
3. 点击 ▶ Run（或 `⌘R`）
4. iPhone 弹出"信任此电脑"提示 → 点信任
5. 首次安装后需在 iPhone 上信任开发者：**设置 → 通用 → VPN 与设备管理 → 选你的 Apple ID → 信任**

### 方式 B：导出 IPA，通过 AltStore/SideStore 安装（推荐长期使用）

1. Xcode 菜单 → **Product → Archive**（需稍等几分钟）
2. Archive 完成后点 **Distribute App** → **Ad Hoc** → 导出 IPA 文件
3. 安装 **AltStore**（需要电脑同 Wi-Fi）或 **SideStore**（可自签，不需要电脑）
4. 将 IPA 拖入 AltStore / SideStore 安装

---

## 第五步：处理 7 天证书过期（免费账号限制）

### 推荐方案：SideStore（自签，无需电脑）

1. 在 iPhone 上安装 [SideStore](https://sidestore.io)（按官网步骤，需要一次电脑辅助初始化）
2. 之后 SideStore 可以在 iPhone 上**自动续签**，无需再连电脑

### 备选方案：AltStore（需要保持电脑开机 + 同 Wi-Fi）

1. 安装 [AltStore](https://altstore.io) 到 Mac 并安装配套 AltServer 服务
2. AltServer 在后台每 7 天自动帮 iPhone 上的 App 续签

---

## 图标替换（上架前必做）

当前 `public/icons/` 目录只有占位符，需要替换为真实设计资源。

**快速生成方法（无 canvas 包时）：**
1. 打开 [Favicon.io 文字图标生成器](https://favicon.io/favicon-generator/)，设置背景色 `#4f46e5`，文字 `T`，颜色白色
2. 或使用 [Maskable.app 编辑器](https://maskable.app/editor) 制作 maskable 图标
3. 将生成的 `192×192` 和 `512×512` 图片分别命名并放入 `public/icons/`

iOS 在 `index.html` 中通过 `<link rel="apple-touch-icon">` 读取图标，已配置为 `icon-192.png`。

---

## 常用命令速查

```bash
npm run dev        # 在浏览器中开发调试
npm run build      # 编译 Web 产物
npm run cap:sync   # 编译 + 同步到 Xcode（不打开 Xcode）
npm run ios        # 编译 + 同步 + 打开 Xcode
```

---

## 版本号管理

见 [版本管理规范](./VERSIONING.md)。
