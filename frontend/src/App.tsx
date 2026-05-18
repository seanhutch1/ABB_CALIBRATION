import { useEffect, useRef, useState } from "react";
import { CalibrationPanel, type CapturedCorner } from "./components/CalibrationPanel";
import { ClickReadout } from "./components/ClickReadout";
import { IntrinsicsDropdown } from "./components/IntrinsicsDropdown";
import { LayoutToggle, type Layout } from "./components/LayoutToggle";
import {
  MoveRobotPanel,
  useStoredZOffset,
  type MoveState,
} from "./components/MoveRobotPanel";
import { VideoPanel, type Marker } from "./components/VideoPanel";
import {
  clickPixel,
  fetchCalibration,
  fetchIntrinsics,
  fetchStatus,
  robotMoveTo,
  type Calibration,
  type CameraStatus,
  type ClickError,
  type ClickResult,
  type Intrinsics,
} from "./api";
import "./App.css";

type Mode = "view" | "calibrate" | "move-robot";

type ReadoutState =
  | { kind: "idle" }
  | { kind: "loading"; pixel: [number, number] }
  | { kind: "ok"; result: ClickResult }
  | { kind: "err"; pixel: [number, number]; error: ClickError };

const STATUS_POLL_MS = 500;

export default function App() {
  const [intr, setIntr] = useState<Intrinsics | null>(null);
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [readout, setReadout] = useState<ReadoutState>({ kind: "idle" });
  const [layout, setLayout] = useState<Layout>("both");
  const [snap, setSnap] = useState(true);
  const [mode, setMode] = useState<Mode>("view");
  const [calCorners, setCalCorners] = useState<CapturedCorner[]>([]);
  const [calUnits, setCalUnits] = useState<"mm" | "m">("mm");
  const [moveState, setMoveState] = useState<MoveState>({ kind: "idle" });
  const [zOffsetMm, setZOffsetMm] = useStoredZOffset(100);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const wasConnected = useRef(false);

  // Initial intrinsics + calibration fetch
  useEffect(() => {
    let alive = true;
    fetchIntrinsics()
      .then((i) => {
        if (alive) setIntr(i);
      })
      .catch(() => undefined);
    fetchCalibration()
      .then((c) => {
        if (alive) setCalibration(c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Status polling
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await fetchStatus();
        if (!alive) return;
        setStatusErr(null);
        setStatus(s);
        if (s.is_connected && !wasConnected.current) {
          setStreamEpoch((n) => n + 1);
          fetchIntrinsics().then((i) => {
            if (alive) setIntr(i);
          }).catch(() => undefined);
        }
        wasConnected.current = s.is_connected;
      } catch (e) {
        if (!alive) return;
        setStatusErr(e instanceof Error ? e.message : String(e));
        setStatus(null);
        wasConnected.current = false;
      }
    };
    poll();
    const id = window.setInterval(poll, STATUS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const isConnected = status?.is_connected ?? false;
  const colorUrl = isConnected ? `/stream/color?t=${streamEpoch}` : null;
  const depthUrl = isConnected ? `/stream/depth?t=${streamEpoch}` : null;
  const showColor = layout === "both" || layout === "color";
  const showDepth = layout === "both" || layout === "depth";

  const handlePixel = async (x: number, y: number) => {
    if (mode === "calibrate") {
      // Always raw camera-3D for calibration (snap=false). The current
      // calibration's plane is irrelevant when defining a new one.
      const res = await clickPixel(x, y, false);
      if ("ok" in res) {
        const corner: CapturedCorner = {
          pixel: [x, y],
          camera_xyz_m: res.ok.camera_xyz_m,
        };
        setCalCorners((cs) => (cs.length >= 4 ? cs : [...cs, corner]));
      } else {
        // Surface error — reuse the readout slot for visibility.
        setReadout({ kind: "err", pixel: [x, y], error: res.err });
      }
      return;
    }
    if (mode === "move-robot") {
      // Click → deproject → calibration transform → add Z offset → send to robot.
      setMoveState({ kind: "loading", pixel: [x, y] });
      const clickRes = await clickPixel(x, y, true); // snap to plane for stable Z
      if ("err" in clickRes) {
        setMoveState({ kind: "err", pixel: [x, y], error: clickRes.err });
        return;
      }
      if (!clickRes.ok.calibrated || !clickRes.ok.robot_xyz_m) {
        setMoveState({
          kind: "err",
          pixel: [x, y],
          error: { status: 400, detail: "Camera is not calibrated to robot frame." },
        });
        return;
      }
      const [rxM, ryM, rzM] = clickRes.ok.robot_xyz_m;
      const targetMm: [number, number, number] = [
        rxM * 1000,
        ryM * 1000,
        rzM * 1000 + zOffsetMm,
      ];
      const moveRes = await robotMoveTo(...targetMm);
      if ("err" in moveRes) {
        setMoveState({ kind: "err", pixel: [x, y], error: moveRes.err });
      } else {
        setMoveState({ kind: "ok", pixel: [x, y], target_mm: targetMm });
      }
      return;
    }
    setReadout({ kind: "loading", pixel: [x, y] });
    const res = await clickPixel(x, y, snap);
    if ("ok" in res) setReadout({ kind: "ok", result: res.ok });
    else setReadout({ kind: "err", pixel: [x, y], error: res.err });
  };

  const onClick = isConnected ? handlePixel : undefined;

  const calibMarkers: Marker[] = calCorners.map((c, i) => ({
    pixelX: c.pixel[0],
    pixelY: c.pixel[1],
    label: String(i + 1),
  }));

  const startCalibrate = () => {
    setMode("calibrate");
    setCalCorners([]);
  };
  const cancelCalibrate = () => {
    setMode("view");
    setCalCorners([]);
  };
  const onSavedCalibration = (cal: Calibration) => {
    setCalibration(cal);
    setMode("view");
    setCalCorners([]);
  };

  const startMoveRobot = () => {
    setMode("move-robot");
    setMoveState({ kind: "idle" });
  };
  const exitMoveRobot = () => {
    setMode("view");
    setMoveState({ kind: "idle" });
  };

  return (
    <div className="app">
      <header className="app__header">
        <h1>ABB Calibration - Camera</h1>
        <div className="app__header-right">
          <button
            type="button"
            className={"calibrate-btn" + (mode === "calibrate" ? " calibrate-btn--active" : "")}
            onClick={mode === "calibrate" ? cancelCalibrate : startCalibrate}
            disabled={mode === "move-robot"}
          >
            {mode === "calibrate" ? "Cancel calibration" : "Calibrate"}
          </button>
          <button
            type="button"
            className={"calibrate-btn" + (mode === "move-robot" ? " calibrate-btn--active" : "")}
            onClick={mode === "move-robot" ? exitMoveRobot : startMoveRobot}
            disabled={mode === "calibrate"}
            title="Click on the colour stream to send the robot to that point"
          >
            {mode === "move-robot" ? "Exit move mode" : "Move robot"}
          </button>
          <LayoutToggle value={layout} onChange={setLayout} />
          <IntrinsicsDropdown status={status} intrinsics={intr} calibration={calibration} />
          <CameraStatusPill status={status} error={statusErr} />
        </div>
      </header>
      {status?.device?.is_usb2 && status.is_connected && (
        <div className="banner banner--warn">
          <strong>USB 2 detected.</strong> The camera is in degraded mode (
          {status.profile?.width}×{status.profile?.height} @ {status.profile?.fps} fps). For full
          quality, connect the D435 to a USB 3 port directly on the laptop chassis instead of a
          hub or dock.
        </div>
      )}
      <main className="app__main">
        <div className={"app__streams app__streams--" + layout}>
          {showColor && (
            <VideoPanel
              title="Colour"
              streamUrl={colorUrl}
              onPixelClick={onClick}
              intrinsicWidth={intr?.width}
              intrinsicHeight={intr?.height}
              markers={mode === "calibrate" ? calibMarkers : undefined}
            />
          )}
          {showDepth && (
            <VideoPanel
              title="Depth"
              streamUrl={depthUrl}
              onPixelClick={mode !== "calibrate" ? onClick : undefined}
              intrinsicWidth={intr?.width}
              intrinsicHeight={intr?.height}
            />
          )}
        </div>
        <aside className="app__side">
          {mode === "calibrate" && (
            <CalibrationPanel
              corners={calCorners}
              units={calUnits}
              onUnitsChange={setCalUnits}
              onResetCorners={() => setCalCorners([])}
              onRemoveCorner={(i) =>
                setCalCorners((cs) => cs.filter((_, idx) => idx !== i))
              }
              onSaved={onSavedCalibration}
              onCancel={cancelCalibrate}
            />
          )}
          {mode === "move-robot" && (
            <MoveRobotPanel
              state={moveState}
              zOffsetMm={zOffsetMm}
              onZOffsetChange={setZOffsetMm}
              calibrated={calibration !== null}
              onCancel={exitMoveRobot}
              onHomePressed={(s) => setMoveState(s)}
            />
          )}
          {mode === "view" && (
            <ClickReadout
              state={readout}
              calibration={calibration}
              snap={snap}
              onSnapChange={setSnap}
            />
          )}
        </aside>
      </main>
    </div>
  );
}

function CameraStatusPill({
  status,
  error,
}: {
  status: CameraStatus | null;
  error: string | null;
}) {
  if (error) {
    return <span className="status status--err">backend: {error}</span>;
  }
  if (!status) {
    return <span className="status">connecting…</span>;
  }
  if (!status.is_connected) {
    return <span className="status status--err">disconnected</span>;
  }
  const klass = status.device?.is_usb2 ? "status status--warn" : "status status--ok";
  return (
    <span className={klass} title={`Serial ${status.device?.serial} · fw ${status.device?.firmware}`}>
      {status.device?.name} · USB {status.device?.usb_type} · {status.profile?.width}×
      {status.profile?.height} @ {status.profile?.fps} fps
    </span>
  );
}
