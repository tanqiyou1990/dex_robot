import { ethers } from "ethers";
import config from "../config/config.js";
import tokens from "../config/tokens.js";
import winston from "winston";
import WebSocket from "ws";
import chalk from "chalk";

// 创建日志记录器
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

class PriceMonitor {
  constructor() {
    this.provider = null;
    this.wsProvider = null;
    this.dexes = {};
    this.isRunning = false;
    this.pairContracts = {};
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectInterval = 5000; // 5秒
  }

  async initialize() {
    try {
      // 初始化HTTP provider
      this.provider = new ethers.JsonRpcProvider(config.network.rpc);

      // 初始化WebSocket provider
      if (!config.network.wsRpc) {
        throw new Error("未配置WebSocket RPC地址");
      }
      this.wsProvider = new ethers.WebSocketProvider(config.network.wsRpc);

      // 初始化DEX接口
      for (const [dexKey, dexConfig] of Object.entries(config.dexes)) {
        this.dexes[dexKey] = {
          router: new ethers.Contract(
            dexConfig.routerAddress,
            [
              "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
            ],
            this.provider
          ),
          factory: new ethers.Contract(
            dexConfig.factoryAddress,
            [
              "function getPair(address tokenA, address tokenB) external view returns (address pair)",
              "event PairCreated(address indexed token0, address indexed token1, address pair, uint)",
            ],
            this.wsProvider
          ),
          name: dexConfig.name,
        };
      }

      // 初始化交易对合约
      await this.initializePairContracts();

      // 设置WebSocket事件处理
      this.setupWebSocketHandlers();

      // 启动价格监控
      await this.startMonitoring();
      return this;
    } catch (error) {
      logger.error("初始化失败:", error);
      throw error;
    }
  }

  async getPrice(dex, baseToken, quoteToken, amount) {
    try {
      const path = [baseToken.address, quoteToken.address];
      logger.info(
        `尝试获取${dex.name}价格，输入金额: ${ethers.formatUnits(
          amount,
          baseToken.decimals
        )} ${baseToken.symbol}`
      );
      const amounts = await dex.router.getAmountsOut(amount, path);
      logger.info(
        `${dex.name}返回价格: ${ethers.formatUnits(
          amounts[1],
          quoteToken.decimals
        )} ${quoteToken.symbol}`
      );
      return amounts[1];
    } catch (error) {
      logger.error(`获取${dex.name}价格失败:`, error);
      return null;
    }
  }

  async checkPrices() {
    for (const pair of tokens.pairs) {
      const amount = ethers.parseUnits("1", pair.baseToken.decimals);

      // 获取PancakeSwap价格
      const pancakePrice = await this.getPrice(
        this.dexes.pancakeswap,
        pair.baseToken,
        pair.quoteToken,
        amount
      );

      // 获取BiSwap价格
      const biswapPrice = await this.getPrice(
        this.dexes.biswap,
        pair.baseToken,
        pair.quoteToken,
        amount
      );

      if (pancakePrice && biswapPrice) {
        const pancakePriceFormatted = parseFloat(
          ethers.formatUnits(pancakePrice, pair.quoteToken.decimals)
        ).toFixed(6);
        const biswapPriceFormatted = parseFloat(
          ethers.formatUnits(biswapPrice, pair.quoteToken.decimals)
        ).toFixed(6);

        // 将格式化后的价格转换为数字进行计算
        const pancakePriceNum = parseFloat(pancakePriceFormatted);
        const biswapPriceNum = parseFloat(biswapPriceFormatted);
        const priceDiff =
          Math.abs(pancakePriceNum - biswapPriceNum) / pancakePriceNum;

        // 计算套利成本（最保守估计）
        const dexFee = 0.0025; // 每个DEX的交易手续费0.25%
        const flashLoanFee = 0.0009; // 闪电贷费用0.09%
        const slippageTolerance = 0.01; // 预留1%的滑点损失

        // 计算总成本比例
        const totalCostRatio = dexFee * 2 + flashLoanFee + slippageTolerance;

        // 计算实际利润率（价差减去总成本）
        const profitRatio = priceDiff - totalCostRatio;

        // 只有当预期利润大于0时才输出信息
        if (profitRatio > 0) {
          // 确定价格高低
          const highDex =
            pancakePriceNum > biswapPriceNum ? "PancakeSwap" : "BiSwap";
          const lowDex =
            pancakePriceNum > biswapPriceNum ? "BiSwap" : "PancakeSwap";
          const highPrice =
            pancakePriceNum > biswapPriceNum
              ? pancakePriceFormatted
              : biswapPriceFormatted;
          const lowPrice =
            pancakePriceNum > biswapPriceNum
              ? biswapPriceFormatted
              : pancakePriceFormatted;

          // 在控制台打印格式化的价格信息
          console.log(
            `\n${chalk.cyan(pair.name)} 价格信息:\n` +
              `${highDex}(高): ${chalk.red(highPrice)} ${
                pair.quoteToken.symbol
              }\n` +
              `${lowDex}(低): ${chalk.green(lowPrice)} ${
                pair.quoteToken.symbol
              }\n` +
              `价格差异: ${chalk.green((priceDiff * 100).toFixed(6) + "%")}\n` +
              `预估成本: ${chalk.yellow(
                (totalCostRatio * 100).toFixed(6) + "%"
              )}\n` +
              `预期利润: ${chalk.green((profitRatio * 100).toFixed(6) + "%")}`
          );

          // 同时记录到日志文件
          logger.info({
            pair: pair.name,
            highDex,
            highPrice,
            lowDex,
            lowPrice,
            priceDiff: (priceDiff * 100).toFixed(6) + "%",
            totalCost: (totalCostRatio * 100).toFixed(6) + "%",
            expectedProfit: (profitRatio * 100).toFixed(6) + "%",
          });
        }
      }
    }
  }

  async initializePairContracts() {
    const pairAbi = [
      "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)",
      "event Sync(uint112 reserve0, uint112 reserve1)",
    ];

    for (const pair of tokens.pairs) {
      for (const [dexKey, dex] of Object.entries(this.dexes)) {
        try {
          const pairAddress = await dex.factory.getPair(
            pair.baseToken.address,
            pair.quoteToken.address
          );
          if (pairAddress && pairAddress !== ethers.ZeroAddress) {
            if (!this.pairContracts[dexKey]) {
              this.pairContracts[dexKey] = {};
            }
            // 使用provider而不是wsProvider来创建合约实例，以确保更稳定的价格查询
            this.pairContracts[dexKey][pair.name] = new ethers.Contract(
              pairAddress,
              pairAbi,
              this.provider
            );
            logger.info(
              `成功初始化${dex.name}的${pair.name}交易对合约，地址: ${pairAddress}`
            );
          }
        } catch (error) {
          logger.error(`获取${dex.name}交易对合约失败:`, error);
        }
      }
    }
  }

  setupWebSocketHandlers() {
    if (this.wsProvider && this.wsProvider._websocket) {
      this.wsProvider._websocket.on("close", () => {
        logger.warn("WebSocket连接已断开，尝试重新连接...");
        this.reconnect();
      });

      this.wsProvider._websocket.on("error", (error) => {
        logger.error("WebSocket错误:", error);
        this.reconnect();
      });
    } else {
      logger.error("WebSocket提供者未正确初始化");
    }
  }

  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error("达到最大重连次数，停止重连");
      return;
    }

    this.reconnectAttempts++;
    logger.info(`第${this.reconnectAttempts}次尝试重连...`);

    try {
      // 增加指数退避重试间隔
      const backoffInterval =
        this.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1);
      logger.info(`等待 ${backoffInterval / 1000} 秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, backoffInterval));

      this.wsProvider = new ethers.WebSocketProvider(config.network.wsRpc);

      // 添加速率限制处理
      this.wsProvider._websocket.on("message", (data) => {
        try {
          const response = JSON.parse(data);
          if (
            response.error &&
            response.error.message &&
            response.error.message.includes("rate limit")
          ) {
            logger.warn("触发WebSocket速率限制，将在重试间隔后重新连接...");
            this.reconnect();
          }
        } catch (error) {
          // 如果消息不是JSON格式，检查是否包含速率限制信息
          if (data.toString().includes("rate limit")) {
            logger.warn("触发WebSocket速率限制，将在重试间隔后重新连接...");
            this.reconnect();
          }
        }
      });

      await this.initializePairContracts();
      this.setupWebSocketHandlers();
      this.reconnectAttempts = 0;
      logger.info("WebSocket重连成功");
    } catch (error) {
      logger.error("WebSocket重连失败:", error);
      this.reconnect();
    }
  }

  async startMonitoring() {
    this.isRunning = true;

    // 启动时先查询一次价格
    await this.checkPrices();

    // 监听所有交易对的Swap和Sync事件
    for (const [dexKey, pairs] of Object.entries(this.pairContracts)) {
      for (const [pairName, contract] of Object.entries(pairs)) {
        try {
          contract.on(
            "Swap",
            async (
              sender,
              amount0In,
              amount1In,
              amount0Out,
              amount1Out,
              to
            ) => {
              if (!this.isRunning) return;
              logger.info(`收到${this.dexes[dexKey].name}的Swap事件`);
              await this.checkPrices();
            }
          );

          contract.on("Sync", async (reserve0, reserve1) => {
            if (!this.isRunning) return;
            logger.info(
              `收到${this.dexes[dexKey].name}的Sync事件，储备金更新：${reserve0}, ${reserve1}`
            );
            await this.checkPrices();
          });

          logger.info(
            `开始监听${this.dexes[dexKey].name}的${pairName}交易对事件`
          );
        } catch (error) {
          logger.error(`设置${this.dexes[dexKey].name}事件监听失败:`, error);
        }
      }
    }
  }

  async close() {
    this.isRunning = false;

    // 移除所有事件监听
    for (const pairs of Object.values(this.pairContracts)) {
      for (const contract of Object.values(pairs)) {
        contract.removeAllListeners();
      }
    }

    // 关闭WebSocket连接
    if (this.wsProvider) {
      await this.wsProvider.destroy();
    }
  }
}

export default PriceMonitor;
