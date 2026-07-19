import { WebSocketServer } from "ws";

let wss;

export function startWsServer(port) {
  wss = new WebSocketServer({ port });
  wss.on("error", (error) => {
    // Prevent unhandled WS server errors from crashing the process.
    console.error("WebSocket server error", error);
  });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected", message: "Print Panda WS ready" }));
  });
  return wss;
}

export function broadcast(event, payload) {
  if (!wss) {
    return;
  }

  const packet = JSON.stringify({ type: event, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(packet);
    }
  }
}
