# 使用Node.js官方镜像作为基础镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制package.json和yarn.lock
COPY package.json yarn.lock ./

# 安装依赖
RUN yarn install --frozen-lockfile

# 复制应用代码
COPY . .

# 设置环境变量
ENV NODE_ENV=production

# 创建日志目录
RUN mkdir -p /app/logs

# 暴露应用端口（如果需要）
# EXPOSE 3000

# 启动应用
CMD ["node", "src/index.js"]