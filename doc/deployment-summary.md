# TaskFlow 部署全流程总结

> 从本地开发到阿里云生产部署的完整记录，含所有踩坑与正确配置。

---

## 架构总览

```
iPhone (Capacitor WKWebView)
  └─ HTTP/HTTPS → Nginx :80/443（阿里云 47.95.226.89）
                      ├─ /api/* → Express :3000（Docker 内部网络）
                      └─ /health
                          └─ Prisma → PostgreSQL :5432（Docker 内部网络）
```

**关键设计：** 前端 `VITE_API_URL` 必须带 `/api` 后缀，如 `http://47.95.226.89/api`。Nginx 只代理 `/api/` 路径，不带此前缀的请求会 404。

---

## 一、服务器配置

### 1. 选购

| 项目 | 推荐值 |
|------|--------|
| 实例 | 阿里云 ECS / 轻量服务器，2C2G |
| 系统 | Ubuntu 22.04 |
| 安全组 | 开放 22 / 80 / 443 |
| 域名 | taskflow.top（阿里云万网） |

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

### 4. Docker 镜像加速

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

### 1. 上传代码（Mac → 服务器）

```bash
# Mac 端——打包（排除 .git 和 node_modules）
cd ~/Desktop
COPYFILE_DISABLE=1 tar --exclude='TaskFlow/.git' \
  --exclude='TaskFlow/node_modules' \
  --exclude='TaskFlow/backend/node_modules' \
  -czf taskflow.tar.gz TaskFlow/

# 上传
scp taskflow.tar.gz root@47.95.226.89:/opt/

# SSH 端——解压
cd /opt && tar xzf taskflow.tar.gz && cd TaskFlow
```

### 2. 配置环境变量

```bash
cat > .env << EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_ACCESS_SECRET=$(openssl rand -hex 48)
JWT_REFRESH_SECRET=$(openssl rand -hex 48)
CORS_ORIGIN=http://47.95.226.89,capacitor://localhost,http://localhost:5173
COOKIE_SECURE=false
EOF
```

### 3. 启动

```bash
docker compose build
docker compose up -d
```

### 4. 验证

```bash
docker compose ps          # 三个容器均为 Up
curl http://localhost/health    # → {"status":"ok"}
```

---

## 四、前端构建（iOS）

### 浏览器调试

```bash
cd ~/Desktop/TaskFlow
echo "VITE_API_URL=http://47.95.226.89/api" > .env.local   # ← 注意 /api 后缀
pnpm run dev    # → http://localhost:5173
```

### 模拟器 / 真机

```bash
cd ~/Desktop/TaskFlow
VITE_API_URL=http://47.95.226.89/api npm run ios
# Xcode 打开后 → Clean Build Folder → ⌘R
```

> ⚠️ 每次修改 `VITE_API_URL` 或 Info.plist，必须重新 `npm run ios` + Clean Build Folder。

### 域名通过后切换 HTTPS

```bash
# 1. 服务器申请 Let's Encrypt
apt install -y certbot
docker compose stop nginx
certbot certonly --standalone -d taskflow.top -d www.taskflow.top
mkdir -p /opt/TaskFlow/ssl
cp /etc/letsencrypt/live/taskflow.top/fullchain.pem /opt/TaskFlow/ssl/
cp /etc/letsencrypt/live/taskflow.top/privkey.pem /opt/TaskFlow/ssl/

# 2. 编辑 nginx.conf，取消 HTTPS server 块和 HTTP 重定向注释
# 3. 更新 .env CORS_ORIGIN 为 HTTPS 域名
# 4. 删除 Info.plist 中的 NSAllowsArbitraryLoadsInWebContent（HTTPS 不再需要）
# 5. 重新构建 iOS
VITE_API_URL=https://taskflow.top/api npm run ios
```

---

## 五、常用运维命令

```bash
# 更新代码（Mac 上传新文件后）
scp <文件> root@47.95.226.89:/opt/TaskFlow/<路径>
# SSH 重建
cd /opt/TaskFlow && docker compose build && docker compose up -d

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
CORS_ORIGIN=http://47.95.226.89,capacitor://localhost,http://localhost:5173
COOKIE_SECURE=false
```

### `.env.local`（Mac 前端）

```
VITE_API_URL=http://47.95.226.89/api
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
