# 版本号管理规范

## 语义化版本（Semantic Versioning）

TaskFlow 遵循 [SemVer 2.0.0](https://semver.org/lang/zh-CN/) 规范：

```
MAJOR.MINOR.PATCH
  │      │     └─ PATCH：Bug 修复，向后兼容
  │      └─────── MINOR：新功能，向后兼容
  └────────────── MAJOR：破坏性变更（如 API 不兼容、数据格式变更）
```

### 示例

| 场景 | 变更前 | 变更后 |
|---|---|---|
| 修复任务排序 Bug | `1.0.1` | `1.0.2` |
| 新增「归档」功能 | `1.0.2` | `1.1.0` |
| 引入后端，数据格式变更 | `1.1.0` | `2.0.0` |

---

## 版本号在哪里维护？

### 1. `package.json`（主版本号来源）

```json
{
  "version": "1.0.0"
}
```

### 2. `capacitor.config.ts`（iOS App 版本）

iOS App 有两个概念：

| 字段 | 含义 | 示例 |
|---|---|---|
| `CFBundleShortVersionString`（Version） | 展示给用户看的版本号 | `1.0.0` |
| `CFBundleVersion`（Build） | 构建序号，每次打包 +1 | `3` |

**修改方法：**
- 直接在 Xcode 中：项目 → General → Identity → Version / Build
- 或通过 `capacitor.config.ts` 配置（会在 `npx cap sync` 时写入 Xcode）：

```ts
ios: {
  version: '1.0.0',   // CFBundleShortVersionString
  buildNumber: '1',    // CFBundleVersion
}
```

> 规则：Version 对应 `package.json` 的 `version`，Build 每次提交 App Store 或分发新 IPA 时 +1。

---

## 版本发布流程（建议）

```
1. 在 package.json 改版本号
   npm version patch   # 1.0.0 → 1.0.1（自动改 package.json + 打 git tag）
   npm version minor   # 1.0.0 → 1.1.0
   npm version major   # 1.0.0 → 2.0.0

2. 同步到 capacitor.config.ts（手动）
   - 更新 ios.version 与 package.json 保持一致
   - Build 号 +1

3. 构建并同步
   npm run ios

4. Xcode 打 Archive，导出 IPA，通过 AltStore/SideStore 安装
```

---

## 阶段版本规划（参考）

| 版本 | 里程碑 |
|---|---|
| `1.0.0` | Phase 1 完成：Capacitor 封装，iPhone 本地运行 |
| `1.1.0` | 小功能迭代（UI 优化、新标签等） |
| `2.0.0` | Phase 2 完成：接入后端，引入用户账号和云同步 |
| `2.1.0` | Phase 3：App Store 发布 |

---

## Git Tag 约定

每个发布版本都打一个 git tag：

```bash
git tag v1.0.0
git push origin v1.0.0
```

Tag 格式：`v{MAJOR}.{MINOR}.{PATCH}`
