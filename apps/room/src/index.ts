import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";

type UserToFollow = {
  socketId: string;
  username: string;
};

type OnUserFollowedPayload = {
  userToFollow: UserToFollow;
  action: "FOLLOW" | "UNFOLLOW";
};

const port = Number.parseInt(process.env.PORT ?? "3002", 10);
const host = process.env.HOST ?? "127.0.0.1";
const corsOrigins = (process.env.CORS_ORIGIN ?? process.env.PUBLIC_URL ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const server = createServer((request, response) => {
  if (request.url === "/" || request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(404).end();
});

const io = new SocketIOServer(server, {
  transports: ["websocket", "polling"],
  cors: {
    allowedHeaders: ["Content-Type", "Authorization"],
    origin: corsOrigins,
    credentials: true,
  },
  allowEIO3: true,
});

io.on("connection", (socket) => {
  io.to(socket.id).emit("init-room");

  socket.on("join-room", async (roomId: unknown) => {
    if (typeof roomId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(roomId)) {
      socket.disconnect(true);
      return;
    }
    await socket.join(roomId);
    const sockets = await io.in(roomId).fetchSockets();
    if (sockets.length <= 1) {
      io.to(socket.id).emit("first-in-room");
    } else {
      socket.broadcast.to(roomId).emit("new-user", socket.id);
    }
    io.in(roomId).emit("room-user-change", sockets.map((client) => client.id));
  });

  socket.on(
    "server-broadcast",
    (roomId: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
      socket.broadcast.to(roomId).emit("client-broadcast", encryptedData, iv);
    },
  );

  socket.on(
    "server-volatile-broadcast",
    (roomId: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
      socket.volatile.broadcast.to(roomId).emit("client-broadcast", encryptedData, iv);
    },
  );

  socket.on("user-follow", async (payload: OnUserFollowedPayload) => {
    if (!payload?.userToFollow?.socketId) return;
    const roomId = `follow@${payload.userToFollow.socketId}`;
    if (payload.action === "FOLLOW") {
      await socket.join(roomId);
    } else if (payload.action === "UNFOLLOW") {
      await socket.leave(roomId);
    } else {
      return;
    }
    const sockets = await io.in(roomId).fetchSockets();
    io.to(payload.userToFollow.socketId).emit(
      "user-follow-room-change",
      sockets.map((client) => client.id),
    );
  });

  socket.on("disconnecting", async () => {
    for (const roomId of socket.rooms) {
      const otherClients = (await io.in(roomId).fetchSockets())
        .filter((client) => client.id !== socket.id);
      const isFollowRoom = roomId.startsWith("follow@");
      if (!isFollowRoom && otherClients.length > 0) {
        socket.broadcast.to(roomId).emit(
          "room-user-change",
          otherClients.map((client) => client.id),
        );
      }
      if (isFollowRoom && otherClients.length === 0) {
        io.to(roomId.slice("follow@".length)).emit("broadcast-unfollow");
      }
    }
  });
});

server.listen(port, host, () => {
  console.log(`Excalidraw room listening at http://${host}:${port}`);
});

function shutdown(): void {
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
