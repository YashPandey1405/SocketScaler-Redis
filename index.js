import express from "express";
import axios from "axios";
import Redis from "ioredis";
import http from "http";
import { Server } from "socket.io";

const app = express();

// The Actual redis Connection For Using Redis....
const redis = new Redis({ host: "localhost", port: Number(6379) });

// The Pub-Sub redis Connection For Using Redis [Horizontal Scaling Of Web Sockets]....
const publisher = new Redis({ host: "localhost", port: Number(6379) });
const subscriber = new Redis({ host: "localhost", port: Number(6379) });

// Http Server (Express Server ko mount kardiya http pr)
// HTTP Server --> Express + SocketIO ......
const httpServer = http.createServer(app);
const io = new Server(); // Socket Server
io.attach(httpServer);

const PORT = process.env.PORT ?? 8000;
app.use(express.static("./public"));

const stateKey = "state1";

// setnx() == Set If Not Exist......
redis.setnx(stateKey, JSON.stringify(new Array(100).fill(false)));

// Subscribe to the "server:broker" channel on Redis (Valkey)
subscriber.subscribe("server:broker");

// Listen for incoming messages on any subscribed channel
subscriber.on("message", (channel, message) => {
  // Parse the received message string into a JavaScript object
  const { event, data } = JSON.parse(message);

  // Broadcast the event and its data to all connected WebSocket clients via Socket.IO
  io.emit(event, data); // Relay the message to the frontend or other clients
});

// When a new client connects via Socket.IO
io.on("connection", (socket) => {
  // Log the connection with the unique socket ID
  console.log(`Socket Connected`, socket.id);

  // Listen for a 'message' event from the client
  socket.on("message", (msg) => {
    // Broadcast the received message to all connected clients under 'server-message' event
    io.emit("server-message", msg); // Global broadcast
  });

  // Listen for 'checkbox-update' event from the client (when a checkbox state changes)
  socket.on("checkbox-update", async (data) => {
    // Get the current checkbox state from Redis (e.g., ["true", "false", "false", ...])
    const state = await redis.get(stateKey);

    if (state) {
      // Parse the JSON string into an array
      const parsedState = JSON.parse(state);

      // Update the checkbox value at the given index
      parsedState[data.index] = data.value;

      // Save the updated state back to Redis
      await redis.set(stateKey, JSON.stringify(parsedState));
    }

    // Publish the update to the Redis pub/sub channel so that all subscriber instances (on other servers) receive it
    await publisher.publish(
      "server:broker", // Channel name
      JSON.stringify({ event: "checkbox-update", data }) // Payload: event name + checkbox data
    );
  });
});

// A custom middleware to apply rate limiting using Redis.....
// Rate Limiting -->  100 Requests Per Minute........
app.use(async function (req, res, next) {
  // Define a key to track the request count globally (can be modified per-IP or route)
  const key = "rate-limit";

  // Fetch the current count from Redis
  const value = await redis.get(key);

  // If the key doesn't exist (first request in the time window)
  if (value === null) {
    // Set the initial count to 0
    await redis.set(key, 0);

    // Set the key to expire in 60 seconds (1-minute time window)
    await redis.expire(key, 60);
  }

  // If the count exceeds 100 requests within the time window
  if (Number(value) > 100) {
    // Respond with HTTP 429 (Too Many Requests)
    return res.status(429).json({ message: "Too Many Requests" });
  }

  // Increment the count by 1 for each request
  await redis.incr(key);

  // Proceed to the next middleware or route handler
  next();
});

app.get("/state", async (req, res) => {
  // The stateKey Is An Array But Redis Stores This In An String.....
  // To Handle This , We Did JSON.parse() For The Array......
  const state = await redis.get(stateKey);

  if (state) {
    const parsedState = JSON.parse(state);
    // console.log({ parsedState }); // An Boolean Array Of Size 100.....
    return res.json({ state: parsedState });
  }

  // When No Array Exists In The redis......
  return res.json({ state: [] });
});

// An Basic Health-Check Route.......
app.get("/", (req, res) => {
  return res.json({ status: "success" });
});

// I Know This Well.....
httpServer.listen(PORT, () =>
  console.log(`HTTP Server is Running on PORT ${PORT}`)
);
