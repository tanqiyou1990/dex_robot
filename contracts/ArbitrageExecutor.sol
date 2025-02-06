// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external view returns (uint256 amountOut);
}

interface IQuoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);
}

interface ILendingPool {
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata modes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

contract ArbitrageExecutor is Ownable, ReentrancyGuard {
    // 常量
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public minProfitBps = 10; // 最小利润率（基点）
    
    // DEX路由合约
    ISwapRouter public immutable pancakeRouter;
    ISwapRouter public immutable biswapRouter;
    IQuoter public immutable quoter;
    
    // Aave闪电贷池合约
    ILendingPool public immutable lendingPool;
    
    // 事件
    event ArbitrageExecuted(
        address indexed token1,
        address indexed token2,
        uint256 amount,
        uint256 profit,
        string buyDex,
        string sellDex
    );
    
    constructor(
        address initialOwner,
        address _pancakeRouter,
        address _biswapRouter,
        address _lendingPool,
        address _quoter
    ) Ownable(initialOwner) {
        pancakeRouter = ISwapRouter(_pancakeRouter);
        biswapRouter = ISwapRouter(_biswapRouter);
        lendingPool = ILendingPool(_lendingPool);
        quoter = IQuoter(_quoter);
    }
    
    // 设置最小利润率
    function setMinProfitBps(uint256 _minProfitBps) external onlyOwner {
        require(_minProfitBps > 0, "Min profit must be > 0");
        minProfitBps = _minProfitBps;
    }
    
    // 执行套利
    function executeArbitrage(
        address token1,
        address token2,
        uint256 amount,
        bool isPancakeswapBuy
    ) external nonReentrant {
        // 验证输入参数
        require(token1 != address(0) && token2 != address(0), "Invalid token addresses");
        require(amount > 0, "Amount must be greater than 0");
        require(token1 != token2, "Tokens must be different");

        // 检查代币合约是否存在
        require(IERC20(token1).totalSupply() > 0, "Token1 contract does not exist");
        require(IERC20(token2).totalSupply() > 0, "Token2 contract does not exist");
        
        // 计算预期收益
        ISwapRouter buyRouter = isPancakeswapBuy ? pancakeRouter : biswapRouter;
        ISwapRouter sellRouter = isPancakeswapBuy ? biswapRouter : pancakeRouter;
        
        // 准备闪电贷参数
        address[] memory assets = new address[](1);
        assets[0] = token1;
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // 无抵押模式
        
        // 编码套利参数
        bytes memory params = abi.encode(
            token1,
            token2,
            buyRouter,
            sellRouter
        );
        
        // 执行闪电贷
        try lendingPool.flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            0 // referral code
        ) {
            // 闪电贷执行成功
        } catch Error(string memory reason) {
            // 处理已知错误
            revert(string(abi.encodePacked("Flash loan failed: ", reason)));
        } catch (bytes memory) {
            // 处理未知错误
            revert("Flash loan failed with unknown error");
        }
    }

    // 紧急暂停功能
    bool public paused;
    
    event ContractPaused(address indexed owner);
    event ContractUnpaused(address indexed owner);
    
    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }
    
    function pause() external onlyOwner {
        require(!paused, "Contract already paused");
        paused = true;
        emit ContractPaused(msg.sender);
    }
    
    function unpause() external onlyOwner {
        require(paused, "Contract not paused");
        paused = false;
        emit ContractUnpaused(msg.sender);
    }
    
    // 执行套利交易的内部函数
    function _executeSwap(
        address token1,
        address token2,
        uint256 amount,
        ISwapRouter router,
        bool isBuyTrade
    ) internal returns (uint256) {
        address tokenIn = isBuyTrade ? token1 : token2;
        address tokenOut = isBuyTrade ? token2 : token1;
        
        // 先将授权金额设为0，防止授权累加
        IERC20(tokenIn).approve(address(router), 0);
        IERC20(tokenIn).approve(address(router), amount);

        // 获取预期输出金额并设置滑点保护
        uint256 expectedAmountOut = quoter.quoteExactInputSingle(
            tokenIn,
            tokenOut,
            3000, // 使用0.3%费率池
            amount,
            0
        );
        uint256 minAmountOut = expectedAmountOut * (1 - minProfitBps / BASIS_POINTS);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: 3000, // 使用0.3%费率池
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amount,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0
        });

        return router.exactInputSingle(params);
    }
    
    // 闪电贷回调函数
    function executeOperation(
        address[] calldata _assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(lendingPool), "Caller must be lending pool");
        require(initiator == address(this), "Initiator must be this contract");
        
        // 解码套利参数
        (address token1, address token2, ISwapRouter buyRouter, ISwapRouter sellRouter) = 
            abi.decode(params, (address, address, ISwapRouter, ISwapRouter));
        
        uint256 flashLoanAmount = amounts[0];
        uint256 fee = premiums[0];
        
        // 预估最小所需利润（闪电贷费用 + 额外利润）
        uint256 minRequiredProfit = fee + (flashLoanAmount * minProfitBps / BASIS_POINTS);
        
        // 执行买入交易
        uint256 buyAmount = _executeSwap(token1, token2, flashLoanAmount, buyRouter, true);
        
        // 执行卖出交易
        uint256 sellAmount = _executeSwap(token2, token1, buyAmount, sellRouter, false);
        
        // 计算净利润（扣除闪电贷费用）
        uint256 netProfit = sellAmount > (flashLoanAmount + fee) ?
            sellAmount - (flashLoanAmount + fee) : 0;
            
        // 检查是否达到最小所需利润
        require(netProfit >= minRequiredProfit, "Insufficient profit to cover fees");
        
        // 先将授权金额设为0，防止授权累加
        IERC20(token1).approve(address(lendingPool), 0);
        IERC20(token1).approve(address(lendingPool), flashLoanAmount + fee);
        
        emit ArbitrageExecuted(
            token1,
            token2,
            flashLoanAmount,
            netProfit,
            address(buyRouter) == address(pancakeRouter) ? "PancakeSwap" : "BiSwap",
            address(sellRouter) == address(pancakeRouter) ? "PancakeSwap" : "BiSwap"
        );
        
        return true;
    }
    
    // 紧急提款功能
    function emergencyWithdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance to withdraw");
        IERC20(token).transfer(owner(), balance);
    }

    // 检查代币余额
    function checkBalance(address token) public view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // 检查代币授权额度
    function checkAllowance(address token, address spender) public view returns (uint256) {
        return IERC20(token).allowance(address(this), spender);
    }

    // 撤销代币授权
    function revokeAllowance(address token, address spender) external onlyOwner {
        IERC20(token).approve(spender, 0);
    }
}