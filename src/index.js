import PriceMonitor from "./core/PriceMonitor.js";

// 创建并初始化价格监控实例
async function startMonitor() {
  let monitor = null;
  try {
    console.log("正在初始化价格监控服务...");
    monitor = await new PriceMonitor().initialize();
    console.log("价格监控服务启动成功");

    // 处理程序退出信号
    process.on("SIGINT", async () => {
      console.log("\n接收到退出信号，正在清理资源...");
      if (monitor) {
        await monitor.close();
      }
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("\n接收到终止信号，正在清理资源...");
      if (monitor) {
        await monitor.close();
      }
      process.exit(0);
    });
  } catch (error) {
    console.error("价格监控服务启动失败:", error);
    if (monitor) {
      await monitor.close();
    }
    process.exit(1);
  }
}

// 启动监控服务
startMonitor();
