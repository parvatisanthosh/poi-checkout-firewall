import {
  arenaRoom,
  IMMUNE_ROOM,
  L2_EVENTS,
  LIVE_NAMESPACE,
  type ArenaGenerationEvent,
  type ArenaRunEvent,
  type ArenaTrialEvent,
  type CalibrationUpdatedEvent,
  type ImmuneMintedEvent,
  type ImmunePromotionEvent,
  type LiveServerToClientEvents,
} from "@poi/shared";

/** Layer 2 events (CONTRACTS-L2 4.7): arena:* to room arena:{runId}; immune:* and calibration to "immune". */
export interface ArenaEmitter {
  run(p: ArenaRunEvent): void;
  trial(p: ArenaTrialEvent): void;
  generation(p: ArenaGenerationEvent): void;
  minted(p: ImmuneMintedEvent): void;
  promoted(p: ImmunePromotionEvent): void;
  rejected(p: ImmunePromotionEvent): void;
  calibration(p: CalibrationUpdatedEvent): void;
}

export const noopArenaEmitter: ArenaEmitter = {
  run() {},
  trial() {},
  generation() {},
  minted() {},
  promoted() {},
  rejected() {},
  calibration() {},
};

interface RoomTarget {
  of(ns: string): {
    to(room: string): {
      emit<E extends keyof LiveServerToClientEvents>(
        ev: E,
        ...args: Parameters<LiveServerToClientEvents[E]>
      ): unknown;
    };
  };
}

export function arenaRoomEmitter(target: RoomTarget): ArenaEmitter {
  const to = (room: string) => target.of(LIVE_NAMESPACE).to(room);
  return {
    run: (p) => void to(arenaRoom(p.runId)).emit(L2_EVENTS.arenaRun, p),
    trial: (p) => void to(arenaRoom(p.runId)).emit(L2_EVENTS.arenaTrial, p),
    generation: (p) => void to(arenaRoom(p.runId)).emit(L2_EVENTS.arenaGeneration, p),
    minted: (p) => void to(IMMUNE_ROOM).emit(L2_EVENTS.immuneMinted, p),
    promoted: (p) => void to(IMMUNE_ROOM).emit(L2_EVENTS.immunePromoted, p),
    rejected: (p) => void to(IMMUNE_ROOM).emit(L2_EVENTS.immuneRejected, p),
    calibration: (p) => void to(IMMUNE_ROOM).emit(L2_EVENTS.calibrationUpdated, p),
  };
}
