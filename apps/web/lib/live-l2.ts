"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  LIVE_NAMESPACE,
  type ArenaGenerationEvent,
  type ArenaRunEvent,
  type ArenaTrialEvent,
  type CalibrationUpdatedEvent,
  type ImmuneMintedEvent,
  type ImmunePromotionEvent,
  type LiveClientToServerEvents,
  type LiveServerToClientEvents,
} from "@poi/shared";
import { POI_API_URL } from "./config";

export function useLiveArena(runId: string | undefined) {
  const [runEvent, setRunEvent] = useState<ArenaRunEvent | null>(null);
  const [trials, setTrials] = useState<ArenaTrialEvent[]>([]);
  const [generations, setGenerations] = useState<ArenaGenerationEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket<LiveServerToClientEvents, LiveClientToServerEvents> | null>(null);

  useEffect(() => {
    if (!runId) return;
    setTrials([]);
    setGenerations([]);
    const socket: Socket<LiveServerToClientEvents, LiveClientToServerEvents> = io(
      `${POI_API_URL}${LIVE_NAMESPACE}`,
      { transports: ["websocket", "polling"] },
    );
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("arena:subscribe", { runId });
    });

    socket.on("disconnect", () => setConnected(false));

    socket.on("arena:run", (p) => {
      if (p.runId === runId) setRunEvent(p);
    });

    socket.on("arena:trial", (p) => {
      if (p.runId === runId) {
        setTrials((prev) => [p, ...prev].slice(0, 50));
      }
    });

    socket.on("arena:generation", (p) => {
      if (p.runId === runId) {
        setGenerations((prev) => [...prev.filter((g) => g.generation !== p.generation), p]);
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [runId]);

  return { connected, runEvent, trials, generations };
}

export function useLiveImmune() {
  const [minted, setMinted] = useState<ImmuneMintedEvent[]>([]);
  const [promoted, setPromoted] = useState<ImmunePromotionEvent[]>([]);
  const [rejected, setRejected] = useState<ImmunePromotionEvent[]>([]);
  const [calibration, setCalibration] = useState<CalibrationUpdatedEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket<LiveServerToClientEvents, LiveClientToServerEvents> | null>(null);

  useEffect(() => {
    const socket: Socket<LiveServerToClientEvents, LiveClientToServerEvents> = io(
      `${POI_API_URL}${LIVE_NAMESPACE}`,
      { transports: ["websocket", "polling"] },
    );
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("immune:subscribe");
    });

    socket.on("disconnect", () => setConnected(false));

    socket.on("immune:minted", (p) => setMinted((prev) => [p, ...prev].slice(0, 20)));
    socket.on("immune:promoted", (p) => setPromoted((prev) => [p, ...prev].slice(0, 20)));
    socket.on("immune:rejected", (p) => setRejected((prev) => [p, ...prev].slice(0, 20)));
    socket.on("calibration:updated", (p) => setCalibration(p));

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, []);

  return { connected, minted, promoted, rejected, calibration };
}
