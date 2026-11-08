import {
  EVENTS,
  LIVE_NAMESPACE,
  orderRoom,
  type OrderSettledPayload,
  type ServerToClientEvents,
  type VerifyCheckPayload,
  type VerifyStartedPayload,
  type VerifyVerdictPayload,
} from "@poi/shared";

/** How the pipeline talks to browsers. Typed by the shared socket contract. */
export interface Emitter {
  started(p: VerifyStartedPayload): void;
  check(p: VerifyCheckPayload): void;
  verdict(p: VerifyVerdictPayload): void;
  settled(p: OrderSettledPayload): void;
}

export const noopEmitter: Emitter = { started() {}, check() {}, verdict() {}, settled() {} };

/** Anything with socket.io's `.of(ns).to(room).emit(event, payload)` shape: a Server or a redis Emitter. */
interface RoomTarget {
  of(ns: string): {
    to(room: string): {
      emit<E extends keyof ServerToClientEvents>(
        ev: E,
        ...args: Parameters<ServerToClientEvents[E]>
      ): unknown;
    };
  };
}

export function roomEmitter(target: RoomTarget): Emitter {
  const to = (orderId: string) => target.of(LIVE_NAMESPACE).to(orderRoom(orderId));
  return {
    started: (p) => void to(p.orderId).emit(EVENTS.verifyStarted, p),
    check: (p) => void to(p.orderId).emit(EVENTS.verifyCheck, p),
    verdict: (p) => void to(p.orderId).emit(EVENTS.verifyVerdict, p),
    settled: (p) => void to(p.orderId).emit(EVENTS.orderSettled, p),
  };
}
