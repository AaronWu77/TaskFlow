# TaskFlow Phase 2 — UI 完善 & 账户系统

## 1. 功能目的

1. 消除登录页 iOS 弹性回弹
2. 主界面退出图标 → 用户头像按钮
3. 新增账户页面（头像 + 用户名 + 退出）
4. 清空测试数据

---

## 2. TodoList

| ID | 任务 | 描述 |
|----|------|------|
| `fix-auth-bounce` | 修复 AuthPage iOS bounce | 加 `overscroll-none` 消除橡胶回弹 |
| `add-avatar-button` | 替换退出图标为头像按钮 | Header 右侧 LogOut → 圆形头像，点击跳转账户页 |
| `create-account-page` | 创建 AccountPage 组件 | 居中头像 + email 前缀用户名 + 底部退出按钮 |
| `clear-test-data` | 清空数据库测试数据 | 删除所有 User/Task/UserStats |

---

## 3. 具体执行方案

### 3.1 AuthPage iOS bounce

在根 div 加 Tailwind 类 `overscroll-none`：
```html
<div className="h-dvh ... overscroll-none">
```

### 3.2 用户头像按钮

Header 右侧：
- 移除 `<LogOut>` 图标
- 替换为 32px 圆形头像 div（灰色占位背景 + 用户图标）
- 点击设置 `accountOpen: true`

### 3.3 AccountPage 组件

```tsx
function AccountPage({ email, onClose, onLogout }: {
  email: string; onClose: () => void; onLogout: () => void;
}) {
  const displayName = email.split('@')[0];
  return (
    <div className="h-dvh ...">
      {/* 关闭按钮 左上 */}
      {/* 头像 居中 */}
      {/* 用户名 */}
      {/* 退出按钮 底部 */}
    </div>
  );
}
```

使用 `motion/react` 做进入/退出动画。

### 3.4 清空数据库

```sql
DELETE FROM "UserStats";
DELETE FROM "Task";
DELETE FROM "User";
```

或通过 Prisma: `prisma.user.deleteMany()`
