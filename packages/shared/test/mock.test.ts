import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { createMockApp, mockCompile } from "../mocks/app";
import { createPoiClient, PoiApiError } from "../src/client";
import { benignTrace, poisonedTrace } from "../src/fixtures";
import {
  EVENTS,
  LIVE_NAMESPACE,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "../src/events";

const { httpServer, io: ioServer } = createMockApp({ checkIntervalMs: 5 });
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((r) => httpServer.listen(0, r));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await ioServer.close();
});

describe("mock POI API", () => {
  it("serves the demo VOID verification", async () => {
    const poi = createPoiClient({ baseUrl });
    const v = await poi.getVerification("demo");
    expect(v.verdict).toBe("VOID");
    expect(v.checks).toHaveLength(4);
  });

  it("returns contract-shaped errors", async () => {
    const poi = createPoiClient({ baseUrl });
    await expect(poi.getIntent("nope")).rejects.toMatchObject({
      status: 404,
      code: "INTENT_NOT_FOUND",
    } satisfies Partial<PoiApiError>);
    await expect(poi.compileIntent("")).rejects.toMatchObject({ status: 400 });
  });

  it("runs compile -> sign -> attach -> authorize and streams a VOID over sockets", async () => {
    const poi = createPoiClient({ baseUrl });
    const { draft } = await poi.compileIntent(
      "USB-C hub under $40 with 4K HDMI, one-time, new only",
    );
    const { intentId } = await poi.signIntent(draft);
    const orderId = "MOCK-ORDER-1";
    await poi.attachOrder(orderId, { intentId, agentTrace: poisonedTrace, mode: "live" });

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
      baseUrl + LIVE_NAMESPACE,
      {
        transports: ["websocket"],
      },
    );
    await new Promise<void>((r) => socket.on("connect", () => r()));
    socket.emit(EVENTS.subscribe, { orderId });
    await new Promise((r) => setTimeout(r, 50)); // let the join land

    const checks: string[] = [];
    socket.on(EVENTS.verifyCheck, (p) => checks.push(p.check.check));
    const settled = new Promise<string>((r) => socket.on(EVENTS.orderSettled, (p) => r(p.action)));

    const { verificationId } = await poi.authorizeOrder(orderId);
    expect(await settled).toBe("VOIDED");
    socket.close();

    expect(checks).toEqual(["amount", "recurrence", "addons", "semantic"]);
    const v = await poi.getVerification(verificationId);
    expect(v.status).toBe("DONE");
    expect(v.settlement?.action).toBe("VOIDED");

    const record = await poi.getVerifyRecord(orderId);
    expect(record.chainValid).toBe(true);
    const ledger = await poi.getLedger({ limit: 10 });
    expect(ledger.rows.some((r) => r.orderId === orderId)).toBe(true);
  });

  it("dry-run on a benign trace ends in CAPTURE with no settlement", async () => {
    const poi = createPoiClient({ baseUrl });
    const { intentId } = await poi.signIntent(mockCompile("USB-C hub under $40").draft);
    await poi.attachOrder("MOCK-ORDER-2", { intentId, agentTrace: benignTrace, mode: "dry-run" });
    const { verificationId } = await poi.verifyOrder("MOCK-ORDER-2");
    const v = await poi.waitForVerification(verificationId, { intervalMs: 10 });
    expect(v.verdict).toBe("CAPTURE");
    expect(v.settlement?.action).toBe("NONE");
  });
});

describe("mockCompile", () => {
  it("extracts the budget and flags missing ones", () => {
    expect(mockCompile("USB-C hub under $40, one-time, new only").draft.maxTotal.value).toBe(
      "40.00",
    );
    const vague = mockCompile("get me a decent hub");
    expect(vague.ambiguities.map((a) => a.field)).toContain("maxTotal");
  });
});
