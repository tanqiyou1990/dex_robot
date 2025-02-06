import dotenv from "dotenv";

dotenv.config();

export default {
  // 区块链网络配置
  network: {
    rpc: process.env.RPC_URL || "https://bsc-dataseed.binance.org",
    chainId: 56, // BSC主网
    wsRpc: process.env.WS_RPC_URL,
  },

  // DEX配置
  dexes: {
    pancakeswap: {
      name: "PancakeSwap",
      routerAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      factoryAddress: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    },
    biswap: {
      name: "BiSwap",
      routerAddress: "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8",
      factoryAddress: "0x858E3312ed3A876947EA49d572A7C42DE08af7EE",
    },
  },

  // 监控配置
  monitor: {
    interval: 1000, // 价格检查间隔（毫秒）
    priceImpact: 0.005, // 价格影响阈值 (0.5%)
    gasLimit: 300000,
    minProfit: 0.01, // 最小利润（BNB）
  },
};
