"use client";

import React, { useEffect, useRef, useState } from "react";
import { db, onAuthReady } from "@/lib/firebase";
import {
  doc,
  runTransaction,
  serverTimestamp,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  getDoc,
 
} from "firebase/firestore";

export default function PlayPage() {
  const [name, setName] = useState("");

  // pose cycle state: only use the poses that currently have detection logic.
  const POSES = ["Arms Down", "Y-Pose", "T-Pose"];
  const [currentPoseIdx, setCurrentPoseIdx] = useState(() => Math.floor(Math.random() * POSES.length));
  // boolean flag that indicates the round ended and we should update to a new pose
  const [poseNeedsUpdate, setPoseNeedsUpdate] = useState(false);
  const poseNeedsUpdateRef = React.useRef<boolean>(false);
  const [intervalSec, setIntervalSec] = useState(10);
  const [timeLeft, setTimeLeft] = useState(intervalSec);
  const MIN_INTERVAL = 3; // minimum seconds per round (will not shrink below this)
  const intervalSecRef = React.useRef<number>(intervalSec);
  const maxIntervalRef = React.useRef<number>(intervalSec);
  const [currentProgress, setCurrentProgress] = useState(0); // progress from child 0..1
  const currentProgressRef = React.useRef<number>(0);
  const [playerScore, setPlayerScore] = useState(0);
  const [confirmedPulseIdx, setConfirmedPulseIdx] = useState(0);
  const [lives, setLives] = useState(3); // number of lives to display
  const [gameOver, setGameOver] = useState(false);
  const gameOverRef = React.useRef<boolean>(false);
  const uidRef = React.useRef<string | null>(null);
  const controlWsRef = React.useRef<WebSocket | null>(null);

  const pickDifferentIndex = React.useCallback(
    (prev: number, desired?: number) => {
      if (POSES.length <= 1) return prev;
      if (
        typeof desired === "number" &&
        desired >= 0 &&
        desired < POSES.length &&
        desired !== prev
      ) {
        return desired;
      }
      const candidates: number[] = [];
      for (let i = 0; i < POSES.length; i++) {
        if (i !== prev) candidates.push(i);
      }
      return candidates[Math.floor(Math.random() * candidates.length)] ?? prev;
    },
    [POSES.length]
  );

  const setPoseIdxDifferent = React.useCallback(
    (desired?: number) => {
      setCurrentPoseIdx((prev) => pickDifferentIndex(prev, desired));
    },
    [pickDifferentIndex]
  );
  // guard to prevent double-awarding points within a short window
  const awardLockRef = React.useRef(false);
  // guard to prevent double-decrementing lives within a short window
  const lifeLockRef = React.useRef(false);

  // keep ref in sync with state so interval closure can see latest value
  useEffect(() => {
    gameOverRef.current = gameOver;
  }, [gameOver]);

  // keep poseNeedsUpdateRef in sync with state for closures
  useEffect(() => {
    poseNeedsUpdateRef.current = poseNeedsUpdate;
  }, [poseNeedsUpdate]);

  // when poseNeedsUpdate is set (end of round), perform the actual pose transition here
  useEffect(() => {
    if (!poseNeedsUpdate) return;
    // only update when not gameOver
    if (!gameOverRef.current) {
      setPoseIdxDifferent();
    }
    // reset flag
    setPoseNeedsUpdate(false);
  }, [poseNeedsUpdate, setPoseIdxDifferent]);

  useEffect(() => {
    // get authenticated uid and load player profile from Firestore
    onAuthReady(async (uid) => {
      try {
        // store uid locally for use in transactions
        uidRef.current = uid;
        // fetch player profile
        const ref = doc(db, "players", uid);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const data = snap.data() as any;
          if (data.name) setName(data.name);
          if (typeof data.completedCount === "number") setPlayerScore(data.completedCount);
        }
      } catch (e) {
        console.error("failed to load player profile", e);
      }
    });
  }, []);

  // countdown timer that triggers pose changes and speeds up over time.
  // Use a ref for intervalSec so the ticking closure always sees the latest
  // interval length without needing to recreate the interval on every change.
  useEffect(() => {
    intervalSecRef.current = intervalSec;
    // keep the maxIntervalRef in sync so round resets consistently use the latest interval
    maxIntervalRef.current = intervalSec;
    // also ensure visible timer aligns when interval is changed externally
    setTimeLeft(intervalSec);
  }, [intervalSec]);

  useEffect(() => {
    // initialize timeLeft to current interval
    setTimeLeft(intervalSecRef.current);

    // award threshold (fixed)
    const THRESH = 0.65;
    const t = setInterval(() => {
      setTimeLeft((s) => {
        if (s < 1) {
          // don't do anything if the game is over
          if (gameOverRef.current) return 0;

          // end of round: log current progress & threshold and award or penalize
          try {
            // debug log to help diagnose missed awards
            console.log("[PlayPage] end-of-round check", { progress: currentProgressRef.current, thresh: THRESH });
            if (currentProgressRef.current >= THRESH) {
              try {
                awardPointToPlayer();
                console.log("[PlayPage] awarded point. New score:", playerScore + 1);
              } catch (err) {
                console.error("[PlayPage] awardPointToPlayer threw:", err);
              }
            } else {
              // failed the round: lose a life (guard against double decrements)
              if (!lifeLockRef.current) {
                lifeLockRef.current = true;
                // release lock after short window (same as award lock)
                window.setTimeout(() => {
                  lifeLockRef.current = false;
                }, 1200);
                setLives((prev) => {
                  const next = Math.max(0, prev - 1);
                  if (next <= 0) {
                    // trigger game over
                    setGameOver(true);
                    gameOverRef.current = true;
                  }
                  return next;
                });
              } else {
                console.log("[PlayPage] skipped duplicate life-decrement due to lifeLock");
              }
            }
          } catch (e) {
            console.error("[PlayPage] error during end-of-round check:", e);
          }

          // advance pose only if not gameOver
          if (!gameOverRef.current) {
            // request the server to choose the next pose; fallback to local update
            try {
              const ws = controlWsRef.current;
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "next" }));
              } else {
                // fallback: local update
                setPoseNeedsUpdate(true);
              }
            } catch (e) {
              // on any error, fallback to local update
              setPoseNeedsUpdate(true);
            }
            return maxIntervalRef.current;
          }

          return 0;
        }
        return s - 1;
      });
    }, 1000);

    return () => clearInterval(t);
    // run once on mount; intervalSec updates are handled via the ref
  }, []);

  // connect to control websocket for server-driven pose selection
  useEffect(() => {
    try {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.hostname || "localhost";
      const url = `${proto}//${host}:8000/ws/control`;
      const ws = new WebSocket(url);
      ws.onopen = () => {
        console.log("control ws open");
      };
      ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data as string);
          if (d?.type === "pose" && typeof d.pose === "string") {
            const idx = POSES.indexOf(d.pose);
            if (idx >= 0) setPoseIdxDifferent(idx);
          }
        } catch (e) {
          console.error("control ws message parse error", e);
        }
      };
      ws.onclose = () => console.log("control ws closed");
      ws.onerror = (e) => console.error("control ws error", e);
      controlWsRef.current = ws;
      return () => {
        try {
          ws.close();
        } catch {}
        controlWsRef.current = null;
      };
    } catch (e) {
      console.error("failed to open control websocket", e);
    }
  }, []);

  // keep ref in sync with state without triggering the timer effect
  useEffect(() => {
    currentProgressRef.current = currentProgress;
  }, [currentProgress]);


  // load initial score from local leaderboard
  useEffect(() => {
    const p = localStorage.getItem("playerName") || "Player";
    // read player's current completedCount from Firestore if available
    (async () => {
      try {
        const id = encodeURIComponent(p);
        const ref = doc(db, "leaderboard", id);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const data = snap.data() as any;
          setPlayerScore((data.completedCount as number) || 0);
        }
      } catch (e) {
        // ignore
      }
    })();
  }, []);

  const awardPointToPlayer = () => {
    // prevent double awards in quick succession (e.g. duplicate timer triggers)
    if (awardLockRef.current) return;
    awardLockRef.current = true;
    // release lock after 1200ms
    window.setTimeout(() => {
      awardLockRef.current = false;
    }, 1200);
    const uid = uidRef.current;
    if (!uid) {
      console.warn("no auth uid available; cannot write score to Firestore");
    }
    const id = uid || encodeURIComponent(localStorage.getItem("playerName") || "Player");
    const ref = doc(db, "players", id);
    // Use a transaction to safely increment completedCount and set metadata
    runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        tx.set(ref, {
          name: name || "Player",
          completedCount: 1,
          totalAttempts: 1,
          accuracy: 1,
          lastPose: currentPoseName,
          lastUpdated: serverTimestamp(),
        });
        return 1;
      }
      const data = snap.data() as any;
      const nextCompleted = (data.completedCount || 0) + 1;
      const nextAttempts = (data.totalAttempts || 0) + 1;
      const nextAccuracy = nextCompleted / nextAttempts;
      tx.update(ref, {
        completedCount: nextCompleted,
        totalAttempts: nextAttempts,
        accuracy: nextAccuracy,
        lastPose: currentPoseName,
        lastUpdated: serverTimestamp(),
      });
      return nextCompleted;
    })
      .then((newCount) => {
        setPlayerScore(newCount as number);
      })
      .catch((e) => {
        console.error("awardPoint transaction failed", e);
      });
    // trigger pulse in child
    setConfirmedPulseIdx((n) => n + 1);
    // shorten the interval (make rounds faster) on each successful score
    try {
      const newInterval = Math.max(MIN_INTERVAL, Math.max(1, intervalSecRef.current - 1));
      setIntervalSec(newInterval);
      intervalSecRef.current = newInterval;
      // reset the displayed timer so the next round uses the shorter time
      setTimeLeft(newInterval);
    } catch (e) {
      // ignore
    }
  };

  const restartGame = () => {
    // reset core game state but keep player name and leaderboard
    setLives(3);
    setGameOver(false);
    gameOverRef.current = false;
  setIntervalSec(10);
  intervalSecRef.current = 10;
    // pick a random starting pose
    if (POSES.length > 0) {
      const randomIdx = Math.floor(Math.random() * POSES.length);
      setPoseIdxDifferent(randomIdx);
    }
    // align displayed timer with the intervalSec we just set above
    setTimeLeft(intervalSecRef.current);
    setCurrentProgress(0);
    // nudge a pulse so child clears any success pulse UI
    setConfirmedPulseIdx((n) => n + 1);
    // prevent accidental immediate life/award changes from a racing timer
    lifeLockRef.current = true;
    awardLockRef.current = true;
    window.setTimeout(() => {
      lifeLockRef.current = false;
      awardLockRef.current = false;
    }, 1300);
  };

  const currentPoseName = POSES && POSES.length > 0 ? (POSES[currentPoseIdx] ?? POSES[currentPoseIdx % POSES.length]) : "Pose";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-black text-white">
    <p className="opacity-80 mt-2 text-xl font-semibold">Do: {currentPoseName} — Next change in {timeLeft}s</p>

      <div className="mt-10 border border-gray-700 w-full h-[640px] p-2">
        <div className="w-full h-full flex gap-2">
          {/* Left: main panel (takes remaining width) */}
          <div className="flex-1 px-1 relative">
            <WebcamPosePanel targetPose={POSES[currentPoseIdx]} onProgressChange={setCurrentProgress} confirmedPulseIdx={confirmedPulseIdx} />
            {/* player score bottom-left overlay */}
            <div className="absolute left-6 bottom-6 text-sm text-white bg-black/60 px-3 py-1 rounded">
              {name || "Player"}: {playerScore} pts
            </div>
            {/* lives bottom-right overlay */}
            <div className="absolute right-6 bottom-6 text-sm text-white bg-black/60 px-3 py-1 rounded flex items-center gap-2">
              <div className="opacity-90 mr-1">Lives:</div>
              <div className="flex items-center gap-1">
                {Array.from({ length: lives }).map((_, i) => (
                  <span key={i} className="text-red-400 text-lg leading-none">❤</span>
                ))}
              </div>
            </div>
          </div>
            {/* game over overlay */}
            {gameOver && (
              <div className="fixed inset-0 z-50 flex items-center justify-center">
                <div className="bg-black/80 p-6 rounded-lg text-center text-white border border-gray-700">
                  <h2 className="text-2xl font-bold mb-2">Game Over</h2>
                  <p className="mb-4">You ran out of lives. Try again?</p>
                  <div className="flex justify-center gap-3">
                    <button
                      className="px-4 py-2 bg-green-600 rounded hover:bg-green-500"
                      onClick={restartGame}
                    >
                      Restart
                    </button>
                  </div>
                </div>
              </div>
            )}
          {/* Right: leaderboard (fixed width) */}
          <div className="flex-none w-[300px] px-1">
            <div className="sticky top-2">
              <Leaderboard />
            </div>
          </div>
        </div>
      </div>
      
    </main>
  );
}



function Leaderboard() {
  const [entries, setEntries] = React.useState<Array<any>>([]);

  useEffect(() => {
    // subscribe to top 20 players by completedCount
  const q = query(collection(db, "players"), orderBy("completedCount", "desc"), limit(20));
    const unsub = onSnapshot(q, (snap) => {
      setEntries(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))
      );
    }, (err) => {
      console.error("leaderboard snapshot error", err);
    });
    return () => unsub();
  }, []);

  return (
    <div className="w-full bg-black/50 p-3 rounded max-h-[560px] overflow-auto">
      <h3 className="text-sm font-semibold mb-1">Leaderboard</h3>
      {entries.length === 0 ? (
        <div className="text-sm text-gray-400">No scores yet</div>
      ) : (
        <ol className="list-decimal list-inside space-y-1 text-sm">
          {entries.map((e, i) => (
            <li key={e.id || i} className="flex justify-between">
              <span className="truncate pr-2">{e.name}</span>
              <span className="font-mono">{e.completedCount ?? 0}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}


function WebsocketTestPanel() {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
    };
  }, []);

  // auto-connect on mount
  useEffect(() => {
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushMessage = (msg: string) => setMessages((m) => [msg, ...m].slice(0, 200));

  const connect = () => {
    if (connected) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname || "localhost";
    const url = `${proto}//${host}:8000/ws/test`;
    const ws = new WebSocket(url);
    ws.onopen = () => {
      setConnected(true);
      pushMessage("[connected]");
    };
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data as string);
        if (d?.type === "stdin") pushMessage(d.text);
        else if (d?.type === "ack") pushMessage(`(ack) ${d.received}`);
        else pushMessage(JSON.stringify(d));
      } catch (e) {
        pushMessage(String(ev.data));
      }
    };
    ws.onclose = () => {
      setConnected(false);
      pushMessage("[disconnected]");
    };
    ws.onerror = (e) => {
      console.error("ws error", e);
      pushMessage("[error]");
    };
    wsRef.current = ws;
  };

  const disconnect = () => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    setConnected(false);
  };

  // sending from UI removed per request

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex gap-2 items-center mb-2">
        <button
          className={`px-3 py-2 rounded ${connected ? "bg-red-600" : "bg-gray-600"}`}
          onClick={() => {
            if (connected) disconnect();
          }}
          disabled={!connected}
        >
          {connected ? "Disconnect" : "Connecting..."}
        </button>
        <div className="flex-1 text-sm text-gray-300">Listening for backend broadcasts...</div>
      </div>

      <div className="flex-1 overflow-auto bg-black/80 p-2 rounded">
        {messages.length === 0 ? (
          <div className="text-gray-400">No messages yet. If connected, type in the backend terminal to broadcast lines to clients.</div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className="text-sm text-green-200 py-1 border-b border-black/20">{m}</div>
          ))
        )}
      </div>
    </div>
  );
}


function WebcamPosePanel({ targetPose, onProgressChange, confirmedPulseIdx }: { targetPose?: string; onProgressChange?: (p: number) => void; confirmedPulseIdx?: number }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const captureCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const displayCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const targetPoseRef = React.useRef<string | undefined>(targetPose);
  const landmarksRef = React.useRef<any[] | null>(null);
  const smoothedRef = React.useRef<any[] | null>(null);
  const drawLoopRef = React.useRef<number | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const intervalRef = React.useRef<number | null>(null);
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState(0); // 0..1
  const [showSuccessPulse, setShowSuccessPulse] = React.useState(false);
  const confirmedPulseRef = React.useRef<number | null>(null);
  const [lastLandmarkCount, setLastLandmarkCount] = React.useState<number | null>(null);
  const [lastServerMsg, setLastServerMsg] = React.useState<string | null>(null);

  useEffect(() => {
    targetPoseRef.current = targetPose;
    setProgress(0);
    if (onProgressChange) onProgressChange(0);
  }, [targetPose, onProgressChange]);

  // connections between keypoints (approximate MediaPipe indices)
  const CONNECTIONS: Array<[number, number]> = [
    [11, 13], // left shoulder -> left elbow
    [13, 15], // left elbow -> left wrist
    [12, 14], // right shoulder -> right elbow
    [14, 16], // right elbow -> right wrist
    [11, 12], // shoulders
    [23, 24], // hips
    [11, 23], // left shoulder -> left hip
    [12, 24], // right shoulder -> right hip
    [23, 25], // left hip -> left knee
    [25, 27], // left knee -> left ankle
    [24, 26], // right hip -> right knee
    [26, 28], // right knee -> right ankle
    [0, 1], // nose -> ??? (small placeholder)
  ];

  const start = async () => {
    if (running) return;
    try {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 600 } });
      const v = document.createElement("video");
      v.autoplay = true;
      v.playsInline = true;
      v.srcObject = stream;
      videoRef.current = v;

      // create offscreen capture canvas
  const capture = document.createElement("canvas");
  capture.width = 960;
  capture.height = 640;
      captureCanvasRef.current = capture;

      // setup display canvas in DOM
      const display = displayCanvasRef.current;
      if (display) {
        display.width = 960;
        display.height = 640;
      }

      // connect to pose websocket
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.hostname || "localhost";
      const url = `${proto}//${host}:8000/ws`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => console.log("pose ws open");
      // Throttle visual updates to reduce React state thrashing and CPU usage.
      // We'll compute a lightweight per-frame score (progress) from landmark geometry
      // and only run the full detectTargetPose check at round end.
  const lastUpdateRef = { t: 0 } as { t: number };
      const progressRef = { v: 0 } as { v: number };

      ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data as string);
          // debug info
          if (d?.landmarks) setLastLandmarkCount(d.landmarks.length);
          setLastServerMsg(JSON.stringify(Object.keys(d).slice(0,5)));

          if (d?.landmarks) {
            const lm = d.landmarks;
            // store latest landmarks (no React state here)
            landmarksRef.current = lm;
            // initialize smoothed if needed
            if (!smoothedRef.current) {
              // deep copy of positions
              smoothedRef.current = lm.map((p: any) => ({ ...p }));
            }

            // lightweight metric: horizontal wrist spread relative to shoulder width
            // mirror inputs because the camera is mirrored in the browser
            const disp = displayCanvasRef.current;
            const width = disp ? disp.width : 960;
            const lshRaw = lm[11];
            const rshRaw = lm[12];
            const lwrRaw = lm[15];
            const rwrRaw = lm[16];
            // compute mirrored x positions for metric calculation
            const mirrorXCoord = (p: any) => ({ x: typeof p.x === 'number' && p.x > 1 ? width - p.x : (typeof p.x === 'number' ? 1 - p.x : p.x), y: p.y, visibility: p.visibility });
            const lsh = lshRaw ? mirrorXCoord(lshRaw) : undefined;
            const rsh = rshRaw ? mirrorXCoord(rshRaw) : undefined;
            const lwr = lwrRaw ? mirrorXCoord(lwrRaw) : undefined;
            const rwr = rwrRaw ? mirrorXCoord(rwrRaw) : undefined;
            if (lsh && rsh && lwr && rwr) {
              const shoulderWidth = Math.max(1, Math.abs(rsh.x - lsh.x));
              const torsoCenterX = (lsh.x + rsh.x) / 2;
              const activePose = targetPoseRef.current;
              // If the current target pose is Y-Pose, compute a Y-specific progress metric
              if (activePose === "Y-Pose") {
                const shoulderY = (lsh.y + rsh.y) / 2;
                // helper: angle between shoulder->wrist and vertical (degrees)
                const angleDeg = (shoulder: any, wrist: any) => {
                  const dx = (wrist.x || 0) - (shoulder.x || 0);
                  const dy = (wrist.y || 0) - (shoulder.y || 0);
                  const len = Math.hypot(dx, dy) || 1e-6;
                  const cosTheta = Math.max(-1, Math.min(1, (-(dy)) / len));
                  const theta = Math.acos(cosTheta);
                  return (theta * 180) / Math.PI;
                };
                const leftAngle = angleDeg(lsh, lwr);
                const rightAngle = angleDeg(rsh, rwr);
                // map angle -> score where 45deg -> 1, and falloff to 20/70 -> 0
                const mapAngleToScore = (a: number) => {
                  const center = 30;
                  const range = 20; // +/-20 -> 10..50
                  const d = Math.abs(a - center);
                  return Math.max(0, 1 - d / range);
                };
                const leftScore = mapAngleToScore(leftAngle);
                const rightScore = mapAngleToScore(rightAngle);
                // require wrists to be above shoulders somewhat and outward
                const above = ((lwr.y || 0) < (shoulderY - dispHeightEstimate() * 0.02)) && ((rwr.y || 0) < (shoulderY - dispHeightEstimate() * 0.02));
                const torsoCenterX = (lsh.x + rsh.x) / 2;
                const outward = ((lwr.x || 0) < torsoCenterX - (shoulderWidth * 0.12)) && ((rwr.x || 0) > torsoCenterX + (shoulderWidth * 0.12));
                const angleScore = Math.min(leftScore, rightScore);
                const prog = above && outward ? angleScore : angleScore * 0.45; // penalize if not clearly above/outward
                progressRef.v = Math.max(0, Math.min(1, prog));
              } else if (activePose === "Arms Down") {
                  // Arms Down per-frame progress: measure how close wrists are to hip level
                  const lhipRaw = lm[23];
                  const rhipRaw = lm[24];
                  if (lhipRaw && rhipRaw) {
                    const hipY = ((lhipRaw.y || 0) + (rhipRaw.y || 0)) / 2;
                    const shoulderY = (lsh.y + rsh.y) / 2;
                    const toPixels = (y: number) => (y <= 1 ? y * (disp ? disp.height : dispHeightEstimate()) : y);
                    const lwrY = toPixels(lwr.y || 0);
                    const rwrY = toPixels(rwr.y || 0);
                    const hipYPx = toPixels(hipY || 0);
                    const shoulderYPx = toPixels(shoulderY || 0);
                    // vertical closeness: wrists near hip level (closer -> higher score)
                    const maxDist = Math.max(1, (hipYPx - shoulderYPx) * 1.1);
                    const leftV = Math.max(0, 1 - Math.abs(lwrY - hipYPx) / maxDist);
                    const rightV = Math.max(0, 1 - Math.abs(rwrY - hipYPx) / maxDist);
                    // horizontal closeness: wrists near shoulder x (close to body)
                    const leftNear = Math.max(0, 1 - Math.abs((lwr.x || 0) - (lsh.x || 0)) / (shoulderWidth * 0.8));
                    const rightNear = Math.max(0, 1 - Math.abs((rwr.x || 0) - (rsh.x || 0)) / (shoulderWidth * 0.8));
                    const vScore = Math.min(leftV, rightV);
                    const nearScore = Math.min(leftNear, rightNear);
                    // combine: prioritize vertical position, but require near-body
                    const prog = Math.max(0, Math.min(1, (vScore * 0.8 + nearScore * 0.2)));
                    progressRef.v = prog;
                  } else {
                    progressRef.v = 0;
                  }
              } else {
                const leftDist = Math.max(0, torsoCenterX - lwr.x);
                const rightDist = Math.max(0, rwr.x - torsoCenterX);
                // normalized by shoulder width, clamp
                const raw = Math.min(1, (Math.min(leftDist, rightDist) / (shoulderWidth * 0.6)));
                // require wrists vertically near shoulders as one multiplier
                const shoulderY = (lsh.y + rsh.y) / 2;
                const yScoreShoulder = Math.max(0, 1 - Math.abs((lwr.y + rwr.y) / 2 - shoulderY) / (dispHeightEstimate() * 0.25));
                // also require wrists to be roughly level with respective elbows (flat fingers/arms)
                const lel = lm[13];
                const rel = lm[14];
                // threshold for elbow-wrist vertical alignment (about 8% of display height)
                const elbowWristThresh = dispHeightEstimate() * 0.08;
                let elbowWristScore = 1;
                if (lel && rel) {
                  const leftDiff = Math.abs((lwr.y || 0) - (lel.y || 0));
                  const rightDiff = Math.abs((rwr.y || 0) - (rel.y || 0));
                  const avg = (leftDiff + rightDiff) / 2;
                  elbowWristScore = Math.max(0, 1 - avg / elbowWristThresh);
                }
                // finger-level checks: try to find finger landmarks by name (backend may include names).
                // If present, require finger tips to be near the wrist y-level and to be level across hands.
                const fingerNames = ["index", "middle", "ring", "pinky", "thumb", "tip"];
                const findFingerYs = (side: string) => {
                  try {
                    return lm
                      .filter((p: any) => p?.name && p.name.toLowerCase().includes(side) && fingerNames.some((f) => p.name.toLowerCase().includes(f)))
                      .map((p: any) => (typeof p.y === "number" ? p.y : 0));
                  } catch (e) {
                    return [] as number[];
                  }
                };
                const leftFingerYs = findFingerYs("left");
                const rightFingerYs = findFingerYs("right");
                let fingerLevelScore = 1;
                const fingerThresh = dispHeightEstimate() * 0.06; // about 6% canvas height
                if (leftFingerYs.length || rightFingerYs.length) {
                  // compute average distance from wrist for each side (pixels or normalized)
                  const toPixels = (y: number): number => (y <= 1 ? y * (disp ? disp.height : dispHeightEstimate()) : y);
                  const leftAvg = leftFingerYs.length ? leftFingerYs.map((yy: number) => toPixels(yy)).reduce((a: number, b: number) => a + b, 0) / leftFingerYs.length : null;
                  const rightAvg = rightFingerYs.length ? rightFingerYs.map((yy: number) => toPixels(yy)).reduce((a: number, b: number) => a + b, 0) / rightFingerYs.length : null;
                  const lwrY = toPixels(lwr.y || 0);
                  const rwrY = toPixels(rwr.y || 0);
                  const dLeft = leftAvg !== null ? Math.abs(leftAvg - lwrY) : 0;
                  const dRight = rightAvg !== null ? Math.abs(rightAvg - rwrY) : 0;
                  const avgFingerDiff = (dLeft + dRight) / ( (leftAvg !== null ? 1 : 0) + (rightAvg !== null ? 1 : 0) || 1 );
                  fingerLevelScore = Math.max(0, 1 - avgFingerDiff / fingerThresh);
                  // also penalize if left/right finger averages are far apart (hands not level)
                  if (leftAvg !== null && rightAvg !== null) {
                    const handsDiff = Math.abs(leftAvg - rightAvg);
                    fingerLevelScore = Math.max(0, fingerLevelScore * Math.max(0, 1 - handsDiff / (fingerThresh * 1.2)));
                  }
                }

                // combine vertical alignment scores (shoulder alignment + elbow alignment + finger-level)
                const yScore = Math.max(0, Math.min(1, yScoreShoulder * 0.7 + elbowWristScore * 0.15 + fingerLevelScore * 0.15));
                const prog = Math.max(0, Math.min(1, raw * yScore));
                progressRef.v = prog;
              }
            } else {
              progressRef.v = 0;
            }

            // throttle updates to state and parent callback (every 150ms)
            const now = performance.now();
            if (now - lastUpdateRef.t > 150) {
              lastUpdateRef.t = now;
              setProgress(progressRef.v);
              if (onProgressChange) onProgressChange(progressRef.v);
            }
            // mark that new landmarks are available; draw loop will composite
            // no direct drawing here to avoid flicker/layout thrash
          }
        } catch (e) {
          console.error(e);
        }
      };
      ws.onerror = (e) => console.error("pose ws error", e);
      ws.onclose = () => console.log("pose ws closed");
      wsRef.current = ws;

      // wait for video to be ready
      await new Promise((res) => {
        v.onloadedmetadata = () => res(true);
      });

      // start capture loop (~5 fps) that draws into offscreen capture and sends bytes
      const ctx = capture.getContext("2d");
      intervalRef.current = window.setInterval(async () => {
        if (!ctx) return;
        try {
          ctx.drawImage(v, 0, 0, capture.width, capture.height);

          // send JPEG bytes
          capture.toBlob(async (blob) => {
            if (!blob) return;
            const ab = await blob.arrayBuffer();
            try {
              wsRef.current?.send(ab);
            } catch (e) {
              // ignore send errors
            }
          }, "image/jpeg", 0.8);
        } catch (e) {
          console.error(e);
        }
      }, 200); // ~5 fps

      // start a requestAnimationFrame loop that composites the latest capture frame
      // with smoothed landmarks to avoid flicker
      const drawLoop = () => {
        const disp = displayCanvasRef.current;
        const cap = captureCanvasRef.current;
        if (disp && cap) {
          const dctx = disp.getContext("2d");
          if (dctx) {
            // draw the latest video frame as background
            dctx.drawImage(cap, 0, 0, disp.width, disp.height);

            // if landmarks available, smooth them (EMA) and draw overlays
            const raw = landmarksRef.current;
            if (raw && raw.length) {
              const alpha = 0.4; // EMA smoothing factor
              if (!smoothedRef.current) smoothedRef.current = raw.map((p: any) => ({ ...p }));
              const S = smoothedRef.current;
              for (let i = 0; i < raw.length; i++) {
                const r = raw[i];
                if (!S[i]) S[i] = { x: r.x, y: r.y, z: r.z, visibility: r.visibility };
                // update numeric fields only
                S[i].x = (alpha * r.x) + ((1 - alpha) * S[i].x);
                S[i].y = (alpha * r.y) + ((1 - alpha) * S[i].y);
                S[i].z = (alpha * r.z) + ((1 - alpha) * (S[i].z ?? r.z));
                S[i].visibility = (alpha * (r.visibility ?? 1)) + ((1 - alpha) * (S[i].visibility ?? 1));
                // keep other metadata
                S[i].index = r.index;
                S[i].name = r.name;
              }
              // draw using smoothed landmarks — create a mirrored copy for drawing
              const M = S.map((p: any) => {
                const copy = { ...p };
                if (typeof copy.x === "number") {
                  if (copy.x <= 1) {
                    copy.x = 1 - copy.x; // normalized -> mirrored normalized
                  } else {
                    copy.x = disp.width - copy.x; // pixel -> mirrored pixel
                  }
                }
                return copy;
              });
              drawLandmarks(M, progressRef.v, false, /*drawBackground*/ false);
            }
          }
        }
        drawLoopRef.current = requestAnimationFrame(drawLoop);
      };
      drawLoopRef.current = requestAnimationFrame(drawLoop);

      setRunning(true);
    } catch (e) {
      console.error("webcam start failed", e);
    }
  };

  // auto-start webcam & websocket when component mounts
  useEffect(() => {
    start();
    return () => {
      stop();
    };
    // intentionally only run once on mount/unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // trigger success pulse when parent increments confirmedPulseIdx
  useEffect(() => {
    if (typeof confirmedPulseIdx === "number") {
      if (confirmedPulseRef.current === confirmedPulseIdx) return;
      confirmedPulseRef.current = confirmedPulseIdx;
      setShowSuccessPulse(true);
      window.setTimeout(() => setShowSuccessPulse(false), 1400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmedPulseIdx]);

  const stop = () => {
    if (!running) return;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (drawLoopRef.current) {
      try {
        cancelAnimationFrame(drawLoopRef.current);
      } catch {}
      drawLoopRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    if (videoRef.current && videoRef.current.srcObject) {
      const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
      tracks.forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    setRunning(false);
  };

  const drawLandmarks = (landmarks: any[], progressVal: number, mirror?: boolean, drawBackground: boolean = true) => {
    const disp = displayCanvasRef.current;
    if (!disp) return;
    const ctx = disp.getContext("2d");
    if (!ctx) return;

    // Optionally draw the video background (if requested). The draw loop already
    // draws the background; callers in that loop pass drawBackground=false.
    if (drawBackground) {
      const cap = captureCanvasRef.current;
      if (cap) {
        ctx.drawImage(cap, 0, 0, disp.width, disp.height);
      } else {
        ctx.clearRect(0, 0, disp.width, disp.height);
      }
    }

  // overlay keypoints - compute color between blue and green based on progressVal
    const prog = Math.max(0, Math.min(1, progressVal || 0));
    // blue = (0,200,255), green = (0,220,0)
    const r = Math.round(0 * (1 - prog) + 0 * prog);
    const g = Math.round(200 * (1 - prog) + 220 * prog);
    const b = Math.round(255 * (1 - prog) + 0 * prog);
    ctx.fillStyle = `rgba(${r},${g},${b},0.9)`;
    ctx.strokeStyle = `rgba(${r},${g},${b},0.95)`;
    ctx.lineWidth = 2;

    // draw connections
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      let pa = landmarks[a];
      let pb = landmarks[b];
      if (!pa || !pb) continue;

      // handle normalized coords (0..1) returned from server
      let ax = pa.x;
      let ay = pa.y;
      let bx = pb.x;
      let by = pb.y;
      if (ax <= 1 && ay <= 1) {
        ax = ax * disp.width;
        ay = ay * disp.height;
      }
      if (bx <= 1 && by <= 1) {
        bx = bx * disp.width;
        by = by * disp.height;
      }
      if (mirror) {
        ax = disp.width - ax;
        bx = disp.width - bx;
      }

      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();

    // draw points
    for (const lm of landmarks) {
      if (lm.visibility !== undefined && lm.visibility < 0.3) continue;
      let x = lm.x;
      let y = lm.y;
      if (x <= 1 && y <= 1) {
        x = x * disp.width;
        y = y * disp.height;
      }
      if (mirror) x = disp.width - x;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // if success pulse is active, draw a label
    if (showSuccessPulse) {
      ctx.fillStyle = "rgba(0,200,0,0.95)";
      ctx.font = "20px sans-serif";
      ctx.fillText("T-Pose ✓", 10, 24);
    }
  };

  const detectTargetPose = (landmarks: any[]) => {
    const poseName = targetPoseRef.current;
    if (!poseName || poseName === "T-Pose") {
      // require keypoints: L/R shoulders (11/12), L/R elbows (13/14), L/R wrists (15/16)
      const idx = { LSH: 11, RSH: 12, LEL: 13, REL: 14, LWR: 15, RWR: 16 };
      const needed = [11, 12, 13, 14, 15, 16];
      for (const i of needed) if (!landmarks[i]) return false;

      const lsh = landmarks[idx.LSH];
      const rsh = landmarks[idx.RSH];
  const lel = landmarks[idx.LEL];
  const rel = landmarks[idx.REL];
  const lwr = landmarks[idx.LWR];
  const rwr = landmarks[idx.RWR];

  // basic visibility check
  const minVis = 0.4;
  if ((lsh.visibility ?? 0) < minVis || (rsh.visibility ?? 0) < minVis) return false;

  const shoulderY = (lsh.y + rsh.y) / 2;
  const shoulderWidth = Math.abs(rsh.x - lsh.x) || 1;
  const yThresh = dispHeightEstimate() * 0.12; // ~12% of canvas height

  // elbows & wrists should be near shoulder Y (within threshold)
  const condElbows = Math.abs(lel.y - shoulderY) < yThresh && Math.abs(rel.y - shoulderY) < yThresh;
  const condWrists = Math.abs(lwr.y - shoulderY) < yThresh && Math.abs(rwr.y - shoulderY) < yThresh;

  // additionally require wrists roughly level with elbows (flat arms)
  const elbowWristThresh = dispHeightEstimate() * 0.08;
  const condWristLevel = Math.abs(lwr.y - lel.y) < elbowWristThresh && Math.abs(rwr.y - rel.y) < elbowWristThresh;

  // use torso center so detection is robust to mirrored video
  const torsoCenterX = (lsh.x + rsh.x) / 2;
  const xThresh = shoulderWidth * 0.4;
  const condWristX = lwr.x < torsoCenterX - xThresh && rwr.x > torsoCenterX + xThresh;

  // drop finger-level checks: treat T-Pose detection as based on shoulders/elbows/wrists only
  return condElbows && condWrists && condWristX && condWristLevel;
    }
    // L-Pose: one arm down alongside the body, the other arm extended horizontally
    if (poseName === "L-Pose") {
      // require keypoints: L/R shoulders (11/12), L/R elbows (13/14), L/R wrists (15/16), hips (23/24)
      const needed = [11, 12, 13, 14, 15, 16, 23, 24];
      for (const i of needed) if (!landmarks[i]) return false;

      const lsh = landmarks[11];
      const rsh = landmarks[12];
      const lel = landmarks[13];
      const rel = landmarks[14];
      const lwr = landmarks[15];
      const rwr = landmarks[16];
      const lhip = landmarks[23];
      const rhip = landmarks[24];

      const shoulderY = (lsh.y + rsh.y) / 2;
      const torsoCenterX = (lsh.x + rsh.x) / 2;
      const shoulderWidth = Math.abs(rsh.x - lsh.x) || 1;
      const yThresh = dispHeightEstimate() * 0.12; // vertical alignment tolerance
      const xThresh = shoulderWidth * 0.35; // horizontal reach threshold

      // helper checks
      const isHoriz = (wrist: any) => Math.abs((wrist.y || 0) - shoulderY) < yThresh && Math.abs((wrist.x || 0) - torsoCenterX) > xThresh;
      const isDownNearBody = (wrist: any, shoulder: any, hip: any) => {
        // wrist should be well below the shoulder and nearer the side of the body
        const downThresh = dispHeightEstimate() * 0.22;
        const condY = (wrist.y || 0) > shoulderY + downThresh;
        const condX = Math.abs((wrist.x || 0) - (shoulder.x || 0)) < shoulderWidth * 0.45;
        // and roughly below the hip level or near it
        const nearHip = (wrist.y || 0) > ((hip.y || 0) - dispHeightEstimate() * 0.05);
        return condY && condX && nearHip;
      };

      const leftHoriz = isHoriz(lwr);
      const rightHoriz = isHoriz(rwr);
      const leftDown = isDownNearBody(lwr, lsh, lhip);
      const rightDown = isDownNearBody(rwr, rsh, rhip);

      // accept either orientation: left horizontal + right down OR right horizontal + left down
      return (leftHoriz && rightDown) || (rightHoriz && leftDown);
    }

  // Y-Pose: both arms raised diagonally up (roughly 10-50 degrees from vertical; centered ~30°)
    if (poseName === "Y-Pose") {
      // require keypoints: L/R shoulders (11/12), L/R elbows (13/14), L/R wrists (15/16)
      const needed = [11, 12, 13, 14, 15, 16];
      for (const i of needed) if (!landmarks[i]) return false;

      const lsh = landmarks[11];
      const rsh = landmarks[12];
      const lel = landmarks[13];
      const rel = landmarks[14];
      const lwr = landmarks[15];
      const rwr = landmarks[16];

      const shoulderY = (lsh.y + rsh.y) / 2;
      const torsoCenterX = (lsh.x + rsh.x) / 2;
      const shoulderWidth = Math.abs(rsh.x - lsh.x) || 1;

      const minVis = 0.35; // allow a bit lower visibility for raised arms
      if ((lsh.visibility ?? 0) < minVis || (rsh.visibility ?? 0) < minVis) return false;

      const xThresh = shoulderWidth * 0.12;

  const angleFromVerticalDeg = (shoulder: any, wrist: any) => {
        const dx = (wrist.x || 0) - (shoulder.x || 0);
        const dy = (wrist.y || 0) - (shoulder.y || 0);
        const len = Math.hypot(dx, dy) || 1e-6;
        // dot with vertical up (0,-1) => (-(dy))/len
        const cosTheta = Math.max(-1, Math.min(1, (-(dy)) / len));
        const theta = Math.acos(cosTheta); // radians
        return (theta * 180) / Math.PI; // degrees
      };

      const leftAngle = angleFromVerticalDeg(lsh, lwr);
      const rightAngle = angleFromVerticalDeg(rsh, rwr);

  // want roughly between 10 and 50 degrees from vertical (approx 30±20)
  const okLeftAngle = leftAngle >= 10 && leftAngle <= 50;
  const okRightAngle = rightAngle >= 10 && rightAngle <= 50;

      // wrists should be above the shoulder somewhat
      const aboveThresh = dispHeightEstimate() * 0.02;
      const leftAbove = (lwr.y || 0) < (shoulderY - aboveThresh);
      const rightAbove = (rwr.y || 0) < (shoulderY - aboveThresh);

      // wrists should be outward relative to torso center
      const leftOut = (lwr.x || 0) < torsoCenterX - xThresh;
      const rightOut = (rwr.x || 0) > torsoCenterX + xThresh;

      return okLeftAngle && okRightAngle && leftAbove && rightAbove && leftOut && rightOut;
    }

    return false;
  };

  const dispHeightEstimate = () => {
    const disp = displayCanvasRef.current;
    return disp ? disp.height || 640 : 640;
  };

  return (
    <div className="w-full h-full flex flex-col relative">
      {/* progress bar */}
      <div className="w-full px-2 mb-2">
        <div className="w-full h-3 bg-black/60 rounded overflow-hidden">
          <div
            className="h-3 bg-green-500 transition-all duration-200"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center">
        <div className="relative">
          <canvas
            ref={displayCanvasRef}
            className="bg-black block"
            style={{ width: "100%", height: "100%", display: "block" }}
          />

          {/* debug overlay */}
          <div className="absolute top-2 left-2 bg-black/60 text-xs text-white px-2 py-1 rounded">
            <div>WS: {wsRef.current && wsRef.current.readyState === WebSocket.OPEN ? 'open' : 'closed'}</div>
            <div>landmarks: {lastLandmarkCount ?? '-'}</div>
            <div className="truncate">msg: {lastServerMsg ?? '-'}</div>
          </div>

          {/* mirror toggle removed — camera is assumed flipped by default */}

          {/* success pulse / animation overlay */}
          {showSuccessPulse && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center">
                <div className="text-4xl font-bold text-green-400 transform animate-scale-up">
                  ✅
                </div>
                <div className="text-lg text-green-300 mt-2">Great!</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// small CSS for the scale-up animation
// Tailwind doesn't include a custom keyframe here, so we inject a tiny style tag
const styleTag = `
@keyframes scaleUp { 0% { transform: scale(0.6); opacity: 0 } 50% { transform: scale(1.15); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
.animate-scale-up { animation: scaleUp 700ms ease forwards; }
`;

// Inject style into document head when component is used (client-side only)
if (typeof window !== "undefined") {
  if (!document.getElementById("pose-animations-css")) {
    const s = document.createElement("style");
    s.id = "pose-animations-css";
    s.innerHTML = styleTag;
    document.head.appendChild(s);
  }
}
