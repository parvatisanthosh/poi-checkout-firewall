import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  EVENTS,
  LIVE_NAMESPACE,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@poi/shared";
import { attachSocketServer } from "../src/realtime/socket";

const http = createServer((_req, res) => res.end("app"));
const sockets = attachSocketServer(http, { origins: ["http://localhost:3000"] });
let url = "";
beforeAll(async () => {
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(() => sockets.close());

it("delivers events only to the order's room, and leaves other HTTP to the app", async () => {
  const connect = () =>
    new Promise<Socket<ServerToClientEvents, ClientToServerEvents>>((resolve) => {
      const s: Socket<ServerToClientEvents, ClientToServerEvents> = io(url + LIVE_NAMESPACE, {
        transports: ["websocket"],
      });
      s.on("connect", () => resolve(s));
    });
  const a = await connect();
  const b = await connect();
  a.emit(EVENTS.subscribe, { orderId: "ORDER-A" });
  b.emit(EVENTS.subscribe, { orderId: "ORDER-B" });
  a.emit(EVENTS.subscribe, { orderId: "../../evil room" }); // rejected by the id check
  await new Promise((r) => setTimeout(r, 50));

  const gotA = new Promise((r) => a.on(EVENTS.verifyVerdict, r));
  let bGot = false;
  b.on(EVENTS.verifyVerdict, () => (bGot = true));
  sockets.emitter.verdict({
    verificationId: "v1",
    orderId: "ORDER-A",
    verdict: "VOID",
    summary: "Voided: x",
  });
  expect(await gotA).toMatchObject({ orderId: "ORDER-A", verdict: "VOID" });
  await new Promise((r) => setTimeout(r, 30));
  expect(bGot).toBe(false);
  a.close();
  b.close();

  expect(await (await fetch(`${url}/api/health`)).text()).toBe("app");
});
