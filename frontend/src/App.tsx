import { useEffect, useRef, useState } from "react";
import {
  CalibrationPanel,
  type CapturedCorner,
  type StringTriple,
} from "./components/CalibrationPanel";
import { ClickReadout } from "./components/ClickReadout";
import { IntrinsicsDropdown } from "./components/IntrinsicsDropdown";
import { LayoutToggle, type Layout } from "./components/LayoutToggle";
import {
  MeasurementLog,
  useMeasurementLog,
} from "./components/MeasurementLog";
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
  const [calRobotInputsSeed, setCalRobotInputsSeed] = useState<
    StringTriple[] | undefined
  >(undefined);
  const [moveState, setMoveState] = useState<MoveState>({ kind: "idle" });
  const [zOffsetMm, setZOffsetMm] = useStoredZOffset(100);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const wasConnected = useRef(false);
  const [logOn, setLogOn] = useState(false);
  const log = useMeasurementLog();

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
        if (logOn) {
          const cam = clickRes.ok.camera_xyz_m;
          log.append({
            mode: "move-robot",
            pixel: [x, y],
            depth_mm: clickRes.ok.depth_metres * 1000,
            cam_xyz_mm: [cam[0] * 1000, cam[1] * 1000, cam[2] * 1000],
            cmd_xyz_mm: targetMm,
            snapped: clickRes.ok.snapped,
          });
        }
      }
      return;
    }
    setReadout({ kind: "loading", pixel: [x, y] });
    const res = await clickPixel(x, y, snap);
    if ("ok" in res) {
      setReadout({ kind: "ok", result: res.ok });
      if (logOn) {
        const cam = res.ok.camera_xyz_m;
        log.append({
          mode: "view",
          pixel: [x, y],
          depth_mm: res.ok.depth_metres * 1000,
          cam_xyz_mm: [cam[0] * 1000, cam[1] * 1000, cam[2] * 1000],
          cmd_xyz_mm: null,
          snapped: res.ok.snapped,
        });
      }
    } else setReadout({ kind: "err", pixel: [x, y], error: res.err });
  };

  const onClick = isConnected ? handlePixel : undefined;

  const calibMarkers: Marker[] = calCorners.map((c, i) => ({
    pixelX: c.pixel[0],
    pixelY: c.pixel[1],
    label: String(i + 1),
  }));

  // Dragging a calibration corner. Move = visual only (just update the
  // pixel so the X follows the cursor). Drop = re-deproject so the
  // corner's camera_xyz_m matches its new pixel before the user saves.
  const onMarkerMove = (index: number, x: number, y: number) => {
    setCalCorners((cs) =>
      cs.map((c, i) => (i === index ? { ...c, pixel: [x, y] } : c)),
    );
  };
  const onMarkerDrop = async (index: number, x: number, y: number) => {
    const res = await clickPixel(x, y, false);
    if ("ok" in res) {
      setCalCorners((cs) =>
        cs.map((c, i) =>
          i === index ? { pixel: [x, y], camera_xyz_m: res.ok.camera_xyz_m } : c,
        ),
      );
    } else {
      // Depth lookup failed at the drop pixel (likely a depth hole). Keep
      // the pixel where the user dropped it but flag the issue in the
      // readout so they know the corner's camera_xyz_m is now stale.
      setReadout({ kind: "err", pixel: [x, y], error: res.err });
    }
  };

  const startCalibrate = () => {
    setMode("calibrate");
    // Pre-fill corners and robot XYZ inputs from the loaded calibration so
    // the user can re-capture one bad corner without re-typing all four
    // robot coordinates. Units snap back to whatever was saved.
    if (calibration && calibration.point_pairs.length > 0) {
      setCalCorners(
        calibration.point_pairs.map((pp) => ({
          pixel: pp.pixel,
          camera_xyz_m: pp.camera_xyz_m,
        })),
      );
      setCalUnits(calibration.units_input as "mm" | "m");
      const scale = calibration.units_input === "mm" ? 1000 : 1;
      setCalRobotInputsSeed(
        calibration.point_pairs.map((pp) => ({
          x: String(pp.robot_xyz_m[0] * scale),
          y: String(pp.robot_xyz_m[1] * scale),
          z: String(pp.robot_xyz_m[2] * scale),
        })),
      );
    } else {
      setCalCorners([]);
      setCalRobotInputsSeed(undefined);
    }
  };
  const cancelCalibrate = () => {
    setMode("view");
    setCalCorners([]);
    setCalRobotInputsSeed(undefined);
  };
  const onSavedCalibration = (cal: Calibration) => {
    setCalibration(cal);
    setMode("view");
    setCalCorners([]);
    setCalRobotInputsSeed(undefined);
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
          <button
            type="button"
            className={"calibrate-btn" + (logOn ? " calibrate-btn--active" : "")}
            onClick={() => setLogOn((v) => !v)}
            title="When on, every view-mode and move-robot click is appended to the measurement log"
          >
            {logOn ? `Log: on (${log.rows.length})` : "Log: off"}
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
              onMarkerMove={mode === "calibrate" ? onMarkerMove : undefined}
              onMarkerDrop={mode === "calibrate" ? onMarkerDrop : undefined}
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
              initialRobotInputs={calRobotInputsSeed}
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
      {logOn && (
        <section className="app__log">
          <MeasurementLog
            rows={log.rows}
            onUpdate={log.update}
            onDelete={log.remove}
            onClear={log.clear}
          />
        </section>
      )}
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
