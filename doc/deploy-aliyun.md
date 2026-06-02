# TaskFlow 阿里云部署指南

> 从零开始，将 TaskFlow 后端完整部署到阿里云 ECS，iPhone 通过 HTTPS 访问。

---

## 目录

1. [服务器选购与初始化](#1-服务器选购与初始化)
2. [域名准备（可选但推荐）](#2-域名准备可选但推荐)
3. [服务器环境配置](#3-服务器环境配置)
4. [部署 TaskFlow 后端](#4-部署-taskflow-后端)
5. [配置 HTTPS（Let's Encrypt）](#5-配置-httpslets-encrypt)
6. [前端重新构建 & iPhone 测试](#6-前端重新构建--iphone-测试)
7. [日常运维](#7-日常运维)
8. [故障排查](#8-故障排查)

---

## 1. 服务器选购与初始化

### 1.1 推荐配置

| 项目 | 推荐值 | 说明 |
|------|--------|------|
| 实例规格 | 2 vCPU / 2 GB 内存 | 个人使用绰绰有余 |
| 系统盘 | 40 GB ESSD | 系统 + Docker + 数据库 |
| 操作系统 | Ubuntu 22.04 LTS | Docker 支持最好 |
| 带宽 | 按量计费（1-3 Mbps） | 任务管理 App 流量极小 |
| 地域 | 离你最近的节点 | 降低延迟 |

**参考价格**：阿里云 ECS 共享型或轻量应用服务器，约 ¥50-100/月。

> 新手推荐「轻量应用服务器」，自带应用镜像 + 固定带宽，比 ECS 简单。

### 1.2 安全组配置

在阿里云控制台 → 安全组 → 添加规则：

| 端口 | 协议 | 来源 | 用途 |
|------|------|------|------|
| 22 | TCP | 你的 IP（建议限定） | SSH 登录 |
| 80 | TCP | 0.0.0.0/0 | HTTP（Let's Encrypt 验证 + 重定向到 HTTPS） |
| 443 | TCP | 0.0.0.0/0 | HTTPS 访问 |

> **不要**开放 3000 和 5432 端口到公网（后端和数据库只通过 Docker 内部网络通信）。

### 1.3 SSH 登录

```bash
# 在 Mac 终端
ssh root@<你的服务器公网IP>
```

---

## 2. 域名准备（可选但推荐）

没有域名也可以部署，但 iOS WKWebView 强制 HTTPS，你需要一个域名来申请免费 SSL 证书。

### 方案 A：购买域名（推荐）

- 阿里云万网选购（`.com` 约 ¥60/年，`.top` 约 ¥10/年）
- 在 DNS 解析中添加 A 记录：`@ → 你的服务器 IP`

### 方案 B：免费服务（零成本）

- **nip.io**：`https://<IP>.nip.io` 自动解析到对应 IP，无需购买域名
- 免费域名 + Cloudflare DNS

### 验证 DNS

```bash
nslookup yourdomain.com
# 应返回你的服务器 IP
```

---

## 3. 服务器环境配置

### 3.1 安装 Docker

```bash
# 一键安装
curl -fsSL https://get.docker.com | sh

# 启动 Docker
systemctl enable docker
systemctl start docker

# 将当前用户加入 docker 组（避免每次 sudo）
usermod -aG docker $USER

# 重新登录使权限生效
exit
ssh root@<IP>
```

### 3.2 验证安装

```bash
docker --version    # >= 24
docker compose version
```

---

## 4. 部署 TaskFlow 后端

### 4.1 克隆代码

```bash
cd /opt
git clone https://github.com/AaronWu77/TaskFlow.git
cd TaskFlow
```

### 4.2 配置环境变量

```bash
# 生成安全密钥（在服务器上执行）
JWT_ACCESS_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
JWT_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

# 编辑 .env 文件
cat > .env << EOF
POSTGRES_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
CORS_ORIGIN=https://yourdomain.com,capacitor://localhost
COOKIE_SECURE=false
EOF

# 查看确认
cat .env
```

> 将 `yourdomain.com` 替换为你的真实域名。如果暂时没有域名，先用 `https://<IP>.nip.io`。

### 4.3 启动服务

```bash
# 构建镜像 + 启动所有服务
docker compose build
docker compose up -d
```

### 4.4 验证部署

```bash
# 检查容器运行状态
docker compose ps

# 应看到 postgres、api、nginx 三个服务都是 Up 状态

# 测试健康检查
curl http://localhost/health
# → {"status":"ok"}

# 测试注册 API
curl -X POST http://localhost/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@server.com","password":"12345678"}'
# → {"accessToken":"...", "user":{...}}
```

---

## 5. 配置 HTTPS（Let's Encrypt）

### 5.1 安装 certbot

```bash
apt update
apt install -y certbot
```

### 5.2 申请证书

```bash
# 先停掉 nginx（certbot 需要占用 80 端口验证）
docker compose stop nginx

# 申请证书（替换为你的域名）
certbot certonly --standalone -d yourdomain.com

# 证书位置：
# /etc/letsencrypt/live/yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/yourdomain.com/privkey.pem
```

### 5.3 复制证书到项目目录

```bash
mkdir -p ssl
cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem ssl/
cp /etc/letsencrypt/live/yourdomain.com/privkey.pem ssl/
```

### 5.4 启用 Nginx HTTPS

编辑 `nginx.conf`，取消 HTTPS server 块和 HTTP→HTTPS 重定向的注释：

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # 取消下面的注释
    return 301 https://$host$request_uri;

    # 注释掉下面的 location 块
    # location /api/ {
    #     proxy_pass http://api:3000/;
    #     ...
    # }
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location /api/ {
        proxy_pass http://api:3000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://api:3000/health;
    }
}
```

然后更新 `CORS_ORIGIN` 并重启 Nginx：

```bash
# 在 .env 中确认（应为你的实际域名）
# CORS_ORIGIN=https://yourdomain.com,capacitor://localhost

# 重启 nginx
docker compose up -d nginx
```

### 5.5 验证 HTTPS

```bash
curl https://yourdomain.com/health
# → {"status":"ok"}
curl -X POST https://yourdomain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"https@test.com","password":"12345678"}'
# → {"accessToken":"...","user":{...}}
```

### 5.6 设置证书自动续期

Let's Encrypt 证书有效期 90 天，设置 crontab 自动续：

```bash
crontab -e
# 添加以下两行：
0 3 * * * certbot renew --quiet && cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem /opt/TaskFlow/ssl/ && cp /etc/letsencrypt/live/yourdomain.com/privkey.pem /opt/TaskFlow/ssl/ && cd /opt/TaskFlow && docker compose restart nginx
```

---

## 6. 前端重新构建 & iPhone 测试

后端部署完成后，在 **Mac 上**重新构建 iOS App：

### 6.1 浏览器先验证

```bash
# 在你的 Mac 上
cd ~/Desktop/TaskFlow

# 创建临时环境变量指向线上后端
echo "VITE_API_URL=https://yourdomain.com" > .env.local

# 启动本地前端（浏览器测试）
pnpm run dev
# → http://localhost:5173
```

浏览器打开，注册一个新账号，确认一切正常。

### 6.2 构建 iOS App

```bash
# 测试无误后，构建 iOS
VITE_API_URL=https://yourdomain.com npm run ios
```

Xcode 打开后：
- **模拟器测试**：选 iPhone 17 Simulator → `⌘R`
- **真机测试**：USB 连 iPhone → 选设备 → `⌘R`

### 6.3 iPhone 上验证

1. 打开 App → 注册 / 登录
2. 创建任务、修改、完成、删除
3. 在 Mac 浏览器登录同一账号 → 确认数据同步

---

## 7. 日常运维

### 更新后端代码

```bash
cd /opt/TaskFlow
git pull
docker compose build api
docker compose up -d api
```

### 查看日志

```bash
docker compose logs -f api       # API 日志
docker compose logs -f nginx     # 访问日志
docker compose logs -f postgres  # 数据库日志
```

### 备份数据库

```bash
# 导出 PostgreSQL 数据
docker compose exec postgres pg_dump -U taskflow taskflow > backup_$(date +%Y%m%d).sql

# 恢复到新实例
docker compose exec -T postgres psql -U taskflow taskflow < backup_20250601.sql
```

### 更多安全建议

```bash
# 1. 禁用 root SSH 密码登录（只用密钥）
# 编辑 /etc/ssh/sshd_config:
#   PermitRootLogin prohibit-password
#   PasswordAuthentication no

# 2. 安装 fail2ban 防暴力破解
apt install fail2ban

# 3. 定期更新系统
apt update && apt upgrade -y
```

---

## 8. 故障排查

### 容器未启动

```bash
docker compose ps
docker compose logs api         # 查看错误信息
```

### 数据库连接失败

```bash
docker compose exec postgres psql -U taskflow -d taskflow -c "SELECT 1"
```

### API 返回 500

```bash
docker compose logs api | tail -50
```

### iPhone 无法连接

1. 确认 `VITE_API_URL` 已设置为 `https://yourdomain.com`
2. 确认服务器 443 端口已开放
3. 确认 SSL 证书未过期：`curl -vI https://yourdomain.com/health`
4. 确认 `CORS_ORIGIN` 包含 `capacitor://localhost`
