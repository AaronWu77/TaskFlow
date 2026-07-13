# TaskFlow 多端同步完善计划

## 1. 当前同步基础状态

TaskFlow 的基础多端同步架构已完成第一阶段落地，旧的“脏任务逐条上传”路径已经被新的 cursor + operation 模型替代。本项目仍处于开发阶段，因此继续不要求前向兼容旧同步协议、旧本地缓存或旧数据库数据，后续可以直接按新模型重构。

已完成内容：

- 数据库已加入 `Device`、`UserSyncState`、`TaskChange`、`Task.version`、`Task.lastChangedByDeviceId`。
- 后端已提供 `/sync/bootstrap`、`/sync?cursor=`、`/sync/push`。
- 客户端已使用 `syncCursor`、`pendingOperations`、`deviceId` 执行 push-pull 同步。
- create、update、soft-delete、restore、permanent-delete、reorder 已进入统一 operation 队列。
- 本地临时 ID 已做就绪判断和服务端 ID 回填，避免把 `local-*` 操作推给后端。
- 最近删除、永久删除 tombstone、排序版本和基础冲突状态已接入。

后续计划只关注：冲突处理页、字段级 merge、同步状态和冲突处理 UIUX。

## 2. 下一阶段目标

目标是把当前“能发现冲突”的同步系统，升级为“用户能理解、能处理、能恢复”的同步系统：

1. 同字段并发编辑必须进入明确的冲突处理流程。
2. 不同字段并发编辑应尽量自动合并，减少用户打断。
3. 删除与编辑、排序与排序、永久删除与本地修改要有清晰策略。
4. 同步状态要让用户知道：已同步、等待同步、离线、失败、需要处理。
5. 冲突处理界面要简单、可信，不像技术错误页。

## 3. 冲突数据模型

### 3.1 Pending Operation 扩展

为 `pendingOperations` 中的冲突操作补充可恢复上下文：

- `status: 'conflict'`
- `conflictType: 'field' | 'delete-edit' | 'order' | 'permanent-delete'`
- `serverTask`
- `clientPayload`
- `baseTaskSnapshot`
- `serverVersion`
- `conflictedFields`
- `detectedAt`

`baseTaskSnapshot` 用于判断“本机改了哪些字段”，`serverTask` 用于判断“云端现在是什么”，`clientPayload` 用于生成最终 merge operation。

### 3.2 字段比较范围

第一版字段级 merge 支持这些任务字段：

- `title`
- `priority`
- `estimateMinutes`
- `status`
- `tag`
- `dueDate`
- `reminderAt`
- `repeatRule`
- `repeatUntilDate`
- `deletedAt`

排序冲突单独处理，不混入任务字段 merge。

## 4. 字段级 Merge 逻辑

### Phase A：自动合并

实现 `buildFieldMerge(base, localPatch, serverTask)`：

1. 如果某字段只有本机改，采用本机值。
2. 如果某字段只有云端改，采用云端值。
3. 如果本机和云端改了同一字段且值相同，采用该值。
4. 如果本机和云端改了同一字段且值不同，标记为 `conflictedFields`。
5. 如果没有 `conflictedFields`，自动生成 `resolve-conflict` operation 并继续同步。

### Phase B：用户手动合并

当存在 `conflictedFields` 时，进入冲突处理页。用户可以：

- 逐字段选择“使用本机”或“使用云端”。
- 对文本字段手动编辑最终值。
- 一键“全部使用本机”。
- 一键“全部使用云端”。
- 保存合并结果，生成新的 `resolve-conflict` operation。

生成的 operation 必须基于最新 `serverVersion`，不能直接改 clean 数据：

```ts
{
  type: 'resolve-conflict',
  taskId,
  baseVersion: serverVersion,
  payload: mergedFields
}
```

## 5. 删除与排序冲突

### 删除 vs 编辑

如果云端已 soft-delete，本机有未提交编辑：

- 默认展示“云端已删除，本机有修改”。
- 用户可选择“恢复并保留本机修改”或“接受删除”。
- “恢复并保留本机修改”生成 `restore` + `resolve-conflict`。
- “接受删除”移除本机 pending operation。

### 永久删除 vs 本地修改

如果云端已 permanent-delete：

- 默认不可直接覆盖。
- 展示该任务已从其他设备永久删除。
- 用户只能选择“放弃本机修改”或“复制为新任务”。
- “复制为新任务”生成新的 `create` operation。

### 排序冲突

如果 `baseOrderVersion` 落后：

- 第一版采用轻量策略：提示“任务顺序已被其他设备更新”。
- 用户可选择“使用云端顺序”或“重新应用本机顺序”。
- 重新应用时基于最新 `taskOrderVersion` 生成新的 `reorder` operation。

## 6. 冲突处理页 UIUX

### 入口设计

冲突入口放在两个位置：

1. 顶部同步状态条：当 `syncStatus === 'conflict'` 时显示“有冲突需要处理”。
2. 账号页同步卡片：显示冲突数量，并提供“处理冲突”按钮。

入口文案避免技术词，例如：

- 中文：“有 2 个任务需要确认”
- 英文：“2 tasks need review”

### 页面结构

冲突处理页使用全屏页面，不使用小弹窗：

1. 顶部：返回、标题、冲突数量。
2. 列表：每张卡片显示任务标题、冲突类型、涉及字段。
3. 详情：左右或上下对比“本机修改”和“云端版本”。
4. 底部固定操作区：保存合并、全部使用本机、全部使用云端。

移动端使用上下布局；桌面宽屏可使用左右对比布局。

### 字段级选择组件

每个冲突字段使用一行清晰控件：

- 字段名：例如“标题”“截止日期”“提醒时间”。
- 本机值。
- 云端值。
- 分段选择控件：本机 / 云端 / 自定义。

文本字段支持自定义输入；日期、优先级、状态使用原有选择控件，避免用户手写格式。

### 情绪与反馈设计

冲突不是错误，应弱化红色警告。建议：

- 使用 amber/blue 表示“需要确认”。
- 只有同步失败、数据无法保存时使用 destructive。
- 文案强调“你的修改已保存”，减少用户焦虑。

示例：

- “这台设备和另一台设备都改过此任务，请选择最终版本。”
- “未处理前，其他任务仍会继续同步。”

## 7. 同步状态 UIUX 优化

### 顶部状态条

当前已有同步状态条，下一步优化为更明确的状态层级：

- `idle`：默认隐藏，仅账号页显示“已同步”。
- `syncing`：轻量显示旋转图标和“正在同步”。
- `pending`：显示“已离线保存，等待同步”。
- `offline`：显示“离线中，修改会稍后同步”。
- `error`：显示“同步失败，点击重试”。
- `conflict`：显示“有任务需要确认”，点击进入冲突页。

### 账号页同步卡片

账号页同步区域应展示：

- 当前状态。
- 最近同步时间。
- 待同步操作数量。
- 冲突数量。
- 当前设备名。
- 手动重试按钮。

状态说明不显示内部字段名，如 `cursor`、`operationId`、`version`。

### 任务卡片级提示

对有 pending/conflict 的任务，在任务详情或列表中增加小状态：

- 等待同步
- 同步失败
- 需要确认

不要在主 Flow 卡片上堆太多技术状态，只在需要用户行动时显著提示。

## 8. 实施顺序

1. 定义 `ConflictRecord` 和字段 diff helper。
2. 后端 `/sync/push` conflict 响应补齐 `serverTask`、`clientOperation`、`baseVersion`。
3. 客户端保存 conflict 上下文，而不是只把 operation 标成 `conflict`。
4. 实现自动字段 merge，无冲突字段时自动生成 `resolve-conflict`。
5. 实现冲突处理页路由/状态和列表入口。
6. 实现字段级选择 UI。
7. 实现删除冲突和永久删除冲突处理。
8. 实现排序冲突处理。
9. 优化顶部同步状态条和账号页同步卡片。
10. 补齐中英文 i18n 文案。
11. 添加单元测试、集成测试和真机多端回归。

## 9. 测试计划

### 单元测试

- 字段 diff：本机改、云端改、双方同字段改、双方同值改。
- 自动 merge：无冲突时生成正确 payload。
- 手动 merge：字段选择后生成 `resolve-conflict`。
- 删除冲突：restore + merge、接受删除。
- permanent-delete 冲突：放弃修改、复制为新任务。
- 排序冲突：使用云端顺序、重新应用本机顺序。

### 集成测试

- A 离线改标题，B 在线改优先级，A 恢复后自动合并。
- A 离线改标题，B 在线改标题，A 恢复后进入冲突页。
- A 删除任务，B 编辑任务，产生删除冲突。
- A 永久删除任务，B 编辑任务，只允许放弃或复制为新任务。
- A 和 B 同时排序，产生排序确认。
- 冲突未处理时，其他无关任务仍可继续同步。

### UIUX 验证

- iPhone 小屏下字段对比不横向溢出。
- 桌面宽屏下左右对比清晰。
- 中文长标题、英文长标题、空值、日期和提醒字段都可读。
- 用户能在 10 秒内理解哪个值来自本机、哪个值来自云端。
- 处理完成后状态条、账号页和任务卡片状态同步消失。

## 10. 完成定义

- [x] 基础 sync schema、`TaskChange`、`UserSyncState` 已建立。
- [x] `/sync/bootstrap`、`/sync?cursor=`、`/sync/push` 已建立。
- [x] 客户端 `pendingOperations`、`syncCursor`、`deviceId` 已接入。
- [x] 本地临时 ID 到服务端 ID 的回填与队列重映射已完成。
- [ ] 不同字段并发编辑可自动 merge。
- [ ] 同字段并发编辑进入冲突处理页。
- [ ] 用户可逐字段选择本机/云端/自定义值。
- [ ] 删除、永久删除、排序冲突都有明确 UI 和恢复策略。
- [ ] 同步状态条和账号页同步卡片能清楚表达状态与行动入口。
- [ ] `npm run check`、后端构建、同步单元测试和多端集成测试全部通过。
