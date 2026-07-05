import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { SpoonsRoom } from "./SpoonsRoom.js";

const port = Number(process.env.PORT || 2567);
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("Spoons server is running."));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, service: "spoons", time: new Date().toISOString() }));

const server = createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server }) });

gameServer.define("spoons", SpoonsRoom).filterBy(["roomCode"]);

gameServer.listen(port);
console.log(`Spoons Colyseus server listening on ${port}`);
