import winston from "winston";
import "winston-daily-rotate-file";
import os from "os";
import PriceMonitor from "./PriceMonitor.js";

class ProcessManager {
  constructor() {
    this.monitor = null;
    this.isShuttingDown = false;
    this.setupLogger();
    this.setupSignalHandlers();
  }

  setupLogger() {
    // 配置日志轮转
    const dailyRotateTransport = new winston.transports.DailyRotateFile({
      filename: "logs/%DATE%-combined.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "14d",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    });

    const errorRotateTransport = new winston.transports.DailyRotateFile({
      filename: "logs/%DATE%-error.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "14d",
      level: "error",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    });

    // 配置控制台输出
    const consoleTransport = new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    });

    // 重新配置全局logger
    global.logger = winston.createLogger({
      level: "info",
      transports: [
        dailyRotateTransport,
        errorRotateTransport,
        consoleTransport,
      ],
    });
  }

  setupSignalHandlers() {
    // 处理进程信号
    process.on("SIGTERM", () => this.gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => this.gracefulShutdown("SIGINT"));
    process.on("uncaughtException", (error) => {
      logger.error("未捕获的异常:", error);
      this.gracefulShutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason, promise) => {
      logger.error("未处理的Promise拒绝:", { reason, promise });
    });
  }

  async start() {
    try {
      // 记录启动信息
      logger.info("正在启动应用...", {
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
      });

      // 初始化并启动价格监控
      this.monitor = await new PriceMonitor().initialize();

      // 启动健康检查
      this.startHealthCheck();

      logger.info("应用启动成功");
    } catch (error) {
      logger.error("应用启动失败:", error);
      process.exit(1);
    }
  }

  startHealthCheck() {
    // 每5分钟进行一次健康检查
    setInterval(() => {
      try {
        const memoryUsage = process.memoryUsage();
        const healthInfo = {
          uptime: process.uptime(),
          memoryUsage: {
            heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memoryUsage.rss / 1024 / 1024),
          },
          isMonitorRunning: this.monitor && this.monitor.isRunning,
        };

        logger.info("健康检查信息:", healthInfo);

        // 如果发现监控服务未运行，尝试重启
        if (!healthInfo.isMonitorRunning && !this.isShuttingDown) {
          logger.warn("检测到监控服务未运行，尝试重启...");
          this.restartMonitor();
        }
      } catch (error) {
        logger.error("健康检查失败:", error);
      }
    }, 5 * 60 * 1000);
  }

  async restartMonitor() {
    try {
      if (this.monitor) {
        await this.monitor.close();
      }
      this.monitor = await new PriceMonitor().initialize();
      logger.info("监控服务重启成功");
    } catch (error) {
      logger.error("监控服务重启失败:", error);
    }
  }

  async gracefulShutdown(signal) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info(`收到${signal}信号，开始优雅停止...`);

    try {
      // 停止监控服务
      if (this.monitor) {
        await this.monitor.close();
        logger.info("监控服务已停止");
      }

      // 等待所有日志写入完成
      await new Promise((resolve) => {
        logger.on("finish", resolve);
        logger.end();
      });

      logger.info("应用已成功停止");
      process.exit(0);
    } catch (error) {
      logger.error("应用停止过程中发生错误:", error);
      process.exit(1);
    }
  }
}

export default ProcessManager;
