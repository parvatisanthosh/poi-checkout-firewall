/**
 * Socket.IO contract (docs/CONTRACTS.md section 6). Namespace /live, one room per order.
 * Use the interfaces as socket.io generics on both server and client:
 *   new Server<ClientToServerEvents, ServerToClientEvents>()
 *   io(url + LIVE_NAMESPACE) as Socket<ServerToClientEvents, ClientToServerEvents>
 */
import type { CheckResult, Verdict } from "./schemas";

export const LIVE_NAMESPACE = "/live";
export const orderRoom = (orderId: string) => `order:${orderId}`;

export const EVENTS = {
  subscribe: "subscribe",
  verifyStarted: "verify:started",
  verifyCheck: "verify:check",
  verifyVerdict: "verify:verdict",
  orderSettled: "order:settled",
} as const;

export interface SubscribePayload {
  orderId: string;
}
export interface VerifyStartedPayload {
  verificationId: string;
  orderId: string;
  stages: string[];
}
export interface VerifyCheckPayload {
  verificationId: string;
  orderId: string;
  check: CheckResult;
}
export interface VerifyVerdictPayload {
  verificationId: string;
  orderId: string;
  verdict: Verdict;
  summary: string;
}
export interface OrderSettledPayload {
  orderId: string;
  action: "CAPTURED" | "VOIDED";
  paypalStatus: string;
}

export interface ServerToClientEvents {
  "verify:started": (p: VerifyStartedPayload) => void;
  "verify:check": (p: VerifyCheckPayload) => void;
  "verify:verdict": (p: VerifyVerdictPayload) => void;
  "order:settled": (p: OrderSettledPayload) => void;
}

export interface ClientToServerEvents {
  subscribe: (p: SubscribePayload) => void;
}
