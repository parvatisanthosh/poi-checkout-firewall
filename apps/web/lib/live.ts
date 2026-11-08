"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  EVENTS,
  LIVE_NAMESPACE,
  type CheckResult,
  type ClientToServerEvents,
  type OrderSettledPayload,
  type ServerToClientEvents,
  type VerifyVerdictPayload,
} from "@poi/shared";
import { POI_API_URL } from "./config";

export interface LiveState {
  verificationId?: string;
  stages: string[];
  checks: CheckResult[];
  verdict?: VerifyVerdictPayload;
  settled?: OrderSettledPayload;
  connected: boolean;
}

const EMPTY: LiveState = { stages: [], checks: [], connected: false };

/**
 * Subscribes to POI's /live room for one order. Checks are reset when a new verify:started
 * arrives (a retried job starts over), so the list always shows the current attempt.
 */
export function useLiveOrder(orderId: string | undefined) {
  const [state, setState] = useState<LiveState>(EMPTY);
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

  useEffect(() => {
    if (!orderId) return;
    setState(EMPTY);
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
      `${POI_API_URL}${LIVE_NAMESPACE}`,
      { transports: ["websocket", "polling"] },
    );
    socketRef.current = socket;
    socket.on("connect", () => {
      socket.emit(EVENTS.subscribe, { orderId });
      setState((s) => ({ ...s, connected: true }));
    });
    socket.on("disconnect", () => setState((s) => ({ ...s, connected: false })));
    socket.on(EVENTS.verifyStarted, (p) =>
      setState((s) => ({
        ...s,
        verificationId: p.verificationId,
        stages: p.stages,
        checks: [],
        verdict: undefined,
      })),
    );
    socket.on(EVENTS.verifyCheck, (p) =>
      setState((s) => ({ ...s, checks: [...s.checks, p.check] })),
    );
    socket.on(EVENTS.verifyVerdict, (p) => setState((s) => ({ ...s, verdict: p })));
    socket.on(EVENTS.orderSettled, (p) => setState((s) => ({ ...s, settled: p })));
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [orderId]);

  /** For replay mode and polling fallback: push state without a socket. */
  const patch = useCallback((p: Partial<LiveState>) => setState((s) => ({ ...s, ...p })), []);
  return { live: state, patch };
}
