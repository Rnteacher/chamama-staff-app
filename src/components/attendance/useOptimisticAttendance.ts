"use client";

import { useCallback, useMemo, useRef, useState } from "react";

/**
 * OPTIMISTIC attendance state with a background, per-student serialized save
 * queue. The UI updates and advances INSTANTLY (<100ms); persistence is
 * asynchronous through the fast server actions (no route refresh in the
 * interaction loop).
 *
 * Guarantees:
 *  - latest state wins: a newer tap supersedes an in-flight save (the queue
 *    re-saves the latest desired value after the current write settles);
 *  - per-student ordering: each student's saves run in tap order;
 *  - failures are visible ("לא נשמר") and retriable without losing the
 *    teacher's chosen value or kicking the flow backwards;
 *  - no duplicate rows (the RPC upserts one canonical row per student/date).
 */

export type OptimisticStatus = "present" | "absent" | "late";
export type SaveState = "pending" | "saving" | "saved" | "error";

export interface OptimisticEntry {
  status: OptimisticStatus;
  arrival: string | null;
  save: SaveState;
}

export interface OptimisticSaveApi<TExtra = undefined> {
  /** Local overlay per student (only students touched this session). */
  state: Record<string, OptimisticEntry>;
  /** Update locally + enqueue the background save. Returns immediately. */
  mark: (
    studentId: string,
    status: OptimisticStatus,
    arrival?: string | null,
    extra?: TExtra
  ) => void;
  /** Re-enqueue a failed student (keeps the chosen value). */
  retry: (studentId: string) => void;
  /** Retry every failed student. */
  retryAll: () => void;
  pendingCount: number;
  errorIds: string[];
}

export function useOptimisticAttendance<TExtra = undefined>(
  saveOne: (input: {
    studentId: string;
    status: OptimisticStatus;
    arrivalTime?: string;
    extra?: TExtra;
  }) => Promise<{ ok: true } | { ok: false; error: string }>,
  onAllSettled?: () => void
): OptimisticSaveApi<TExtra> {
  const [state, setState] = useState<Record<string, OptimisticEntry>>({});
  // desired value per student (latest tap wins); extra travels with the tap
  const desired = useRef<Map<string, {
    status: OptimisticStatus;
    arrival: string | null;
    extra?: TExtra;
  }>>(new Map());
  // per-student chains — serialized saves per student
  const chains = useRef<Map<string, Promise<void>>>(new Map());
  const inFlight = useRef(0);
  const onSettledRef = useRef(onAllSettled);
  onSettledRef.current = onAllSettled;

  const setEntry = useCallback((id: string, entry: OptimisticEntry | null) => {
    setState((prev) => {
      if (entry === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: entry };
    });
  }, []);

  const runChain = useCallback(
    (studentId: string) => {
      const exec = async (): Promise<void> => {
        for (;;) {
          const want = desired.current.get(studentId);
          if (!want) return;
          const entry: OptimisticEntry = { ...want, save: "saving" };
          setEntry(studentId, entry);
          let res: { ok: true } | { ok: false; error: string };
          try {
            res = await saveOne({
              studentId,
              status: want.status,
              arrivalTime: want.arrival ?? undefined,
              extra: want.extra,
            });
          } catch {
            res = { ok: false, error: "השמירה נכשלה" }; // network abort etc.
          }
          const latest = desired.current.get(studentId);
          const superseded =
            !latest ||
            latest.status !== want.status ||
            (latest.arrival ?? null) !== (want.arrival ?? null);
          if (superseded) continue; // newer tap arrived — save the latest value
          if (res.ok) {
            setEntry(studentId, { ...want, save: "saved" });
          } else {
            setEntry(studentId, { ...want, save: "error" });
          }
          return;
        }
      };
      const prev = chains.current.get(studentId) ?? Promise.resolve();
      const next = prev.then(exec, exec).finally(() => {
        desired.current.delete(studentId);
        inFlight.current = Math.max(0, inFlight.current - 1);
        if (inFlight.current === 0) {
          onSettledRef.current?.();
        }
      });
      inFlight.current += 1;
      chains.current.set(studentId, next);
    },
    [saveOne, setEntry]
  );

  const mark = useCallback(
    (studentId: string, status: OptimisticStatus, arrival?: string | null, extra?: TExtra) => {
      desired.current.set(studentId, { status, arrival: arrival ?? null, extra });
      setEntry(studentId, { status, arrival: arrival ?? null, save: "pending" });
      runChain(studentId);
    },
    [runChain, setEntry]
  );

  const retry = useCallback(
    (studentId: string) => {
      const cur = state[studentId];
      if (!cur || cur.save !== "error") return;
      desired.current.set(studentId, { status: cur.status, arrival: cur.arrival });
      runChain(studentId);
    },
    [runChain, state]
  );

  const retryAll = useCallback(() => {
    for (const [id, entry] of Object.entries(state)) {
      if (entry.save === "error") retry(id);
    }
  }, [retry, state]);

  const pendingCount = useMemo(
    () =>
      Object.values(state).filter((e) => e.save === "pending" || e.save === "saving").length,
    [state]
  );
  const errorIds = useMemo(
    () =>
      Object.entries(state)
        .filter(([, e]) => e.save === "error")
        .map(([id]) => id),
    [state]
  );

  return { state, mark, retry, retryAll, pendingCount, errorIds };
}
