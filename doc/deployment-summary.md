# TaskFlow 部署全流程总结

> 从本地开发到阿里云生产部署的完整记录，含所有踩坑与正确配置。

---

## 架构总览

```
iPhone (Capacitor WKWebView)
  └─ HTTPS → Nginx :443（taskflow.top / 阿里云 47.95.226.89）
                      ├─ /api/* → Express :3000（Docker 内部网络）
                      └─ /health
                          └─ Prisma → PostgreSQL :5432（Docker 内部网络）
```

**关键设计：** 前端 `VITE_API_URL` 必须带 `/api` 后缀，如 `https://taskflow.top/api`。Nginx 代理 `/api/` 到 API 容器，`/health` 用于健康检查。

---

## 一、服务器配置

### 1. 选购

| 项目 | 推荐值 |
|------|--------|
| 实例 | 阿里云 ECS / 轻量服务器，2C2G |
| 系统 | Ubuntu 22.04 |
| 安全组 | 开放 22 / 80 / 443 |
| 域名 | taskflow.top（阿里云万网） |
| Git | GitHub SSH key 免密访问 |

### 2. DNS

在阿里云 DNS 控制台添加 A 记录：

| 主机记录 | 类型 | 值 |
|----------|------|-----|
| `@` | A | `47.95.226.89` |
| `www` | A | `47.95.226.89` |

### 3. 安装 Docker（国内镜像源）

官方脚本被墙，使用阿里云镜像：

```bash
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable docker && systemctl start docker
```

### 4. Git 配置（服务器）

```bash
# 生成 SSH key
ssh-keygen -t ed25519 -C "server@taskflow" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# → 复制公钥，添加到 https://github.com/settings/keys

# 测试连接
ssh -T git@github.com
```

### 5. Docker 镜像加速

```bash
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
  "registry-mirrors": ["https://docker.m.daocloud.io"]
}
EOF
systemctl daemon-reload && systemctl restart docker
```

---

## 二、代码部署

### 1. 首次克隆（服务器）

```bash
mkdir -p /opt && cd /opt
git clone git@github.com:AaronWu77/TaskFlow.git
cd TaskFlow
```

### 2. 配置环境变量

```bash
cat > .env << EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_ACCESS_SECRET=$(openssl rand -hex 48)
JWT_REFRESH_SECRET=$(openssl rand -hex 48)
CORS_ORIGIN=https://taskflow.top,https://www.taskflow.top,capacitor://localhost
COOKIE_SECURE=true
EMAIL_VERIFICATION_CONSOLE=false
RESEND_API_KEY=<Resend API Key，必须在 Resend 后台创建并妥善保存>
EMAIL_FROM=TaskFlow <verify@taskflow.top>
EMAIL_VERIFICATION_WEBHOOK_URL=
EMAIL_VERIFICATION_WEBHOOK_TOKEN=
EOF
```

### 3. 启动

```bash
docker compose up -d --build
```

### 4. 验证

```bash
docker compose ps          # 三个容器均为 Up
curl https://taskflow.top/health    # → {"status":"ok"}
```

### 5. 后续更新（标准流程）

```bash
# Mac 本地 → 推送到 GitHub
cd ~/Desktop/TaskFlow
git add .
git commit -m "描述你的改动"
git push origin main

# 服务器 → 拉取并重建
ssh root@47.95.226.89
cd /opt/TaskFlow
git pull
docker compose up -d --build
```

如果出现了env里内容不匹配的问题，则
```bash
cat /opt/TaskFlow/.env
nano /opt/TaskFlow/.env
```

---

## 四、前端构建（iOS）

### 浏览器调试

```bash
cd ~/Desktop/TaskFlow
echo "VITE_API_URL=https://taskflow.top/api" > .env.local   # ← 注意 /api 后缀
pnpm run dev    # → http://localhost:5173
```

### 模拟器 / 真机

```bash
cd ~/Desktop/TaskFlow
VITE_API_URL=https://taskflow.top/api npm run ios
# Xcode 打开后 → Clean Build Folder → ⌘R
```

> ⚠️ 每次修改 `VITE_API_URL` 或 Info.plist，必须重新 `npm run ios` + Clean Build Folder。

### HTTPS 证书配置

```bash
# 1. 服务器申请 Let's Encrypt（HTTP 验证失败时使用 DNS 验证）
apt install -y certbot
docker compose down
certbot certonly --manual --preferred-challenges dns -d taskflow.top -d www.taskflow.top

# 2. 按 Certbot 提示在阿里云 DNS 添加 TXT 记录：
# _acme-challenge
# _acme-challenge.www

# 3. 证书签发后复制到项目 ssl 目录
mkdir -p /opt/TaskFlow/ssl
cp /etc/letsencrypt/live/taskflow.top/fullchain.pem /opt/TaskFlow/ssl/fullchain.pem
cp /etc/letsencrypt/live/taskflow.top/privkey.pem /opt/TaskFlow/ssl/privkey.pem

# 4. 启动服务并验证
docker compose up -d --build
curl https://taskflow.top/health

# 5. 重新构建 iOS
VITE_API_URL=https://taskflow.top/api npm run ios
```

> 注意：手动 DNS 证书不会自动续期。当前证书到期前需要重新运行 DNS 验证命令，复制新证书后 `docker compose restart nginx`。

---

## 三、清空旧数据库并以新结构为准

如果确认旧数据完全不需要，可以删除 Docker volume，让 PostgreSQL 重新初始化，并由 API 容器启动时执行 Prisma migrations。

**危险：以下命令会永久删除生产数据库数据。执行前确认不需要备份。**

```bash
cd /opt/TaskFlow
docker compose down -v
docker compose up -d --build
```

如果想先备份再清空：

```bash
docker compose exec postgres pg_dump -U taskflow taskflow > backup_$(date +%Y%m%d_%H%M%S).sql
docker compose down -v
docker compose up -d --build
```

重置后需要重新注册账号，并通过 Resend 邮箱验证码完成验证。

Phase 2 之后，本地缓存按 `userId` 隔离。旧版浏览器或 iOS WebView 中残留的全局 key（如 `taskflow_tasks`）不会再被新版本读取。如果要在测试设备上完全清空旧本地数据，可以退出登录后清理浏览器站点数据，或卸载重装 iOS 测试包。

---

## 五、常用运维命令

```bash
# 更新代码
cd /opt/TaskFlow && git pull && docker compose up -d --build

# 查看日志
docker compose logs -f api
docker compose logs -f nginx

# 备份数据库
docker compose exec postgres pg_dump -U taskflow taskflow > backup_$(date +%Y%m%d).sql

# 重启单个服务
docker compose up -d api
```

---

## 六、配置文件最终状态

### `backend/Dockerfile`

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate --schema=src/prisma/schema.prisma
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma   ./node_modules/.prisma
COPY --from=builder /app/node_modules/prisma     ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma    ./node_modules/@prisma
COPY --from=builder /app/src/prisma/schema.prisma   ./prisma/schema.prisma
COPY --from=builder /app/src/prisma/migrations      ./prisma/migrations
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### `backend/src/prisma/schema.prisma`（generator 部分）

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-musl-openssl-3.0.x"]
}
```

### `backend/src/index.ts`（CORS 部分）

```ts
app.use(cors({
  origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
  credentials: true,
}));
```

### `.env`（服务器）

```
POSTGRES_PASSWORD=<随机生成>
JWT_ACCESS_SECRET=<随机生成>
JWT_REFRESH_SECRET=<随机生成>
CORS_ORIGIN=https://taskflow.top,https://www.taskflow.top,capacitor://localhost
COOKIE_SECURE=true
EMAIL_VERIFICATION_CONSOLE=false
RESEND_API_KEY=<server-only secret>
EMAIL_FROM=TaskFlow <verify@taskflow.top>
```

### `.env.local`（Mac 前端）

```
VITE_API_URL=https://taskflow.top/api
```

### `ios/App/App/Info.plist`（ATS 部分）

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key>
    <true/>
</dict>
```
