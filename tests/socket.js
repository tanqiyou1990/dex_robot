const WebSocket = require("ws");
const ws = new WebSocket(
  "wss://go.getblock.io/170446b6e2ad4fa9909c54257449c363"
);

ws.on("open", () => {
  console.log("连接成功");
  ws.close();
});

ws.on("error", (error) => {
  console.log("连接失败:", error.message);
});
