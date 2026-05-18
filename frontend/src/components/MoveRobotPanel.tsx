import { useEffect, useState } from "react";
import { robotStep, type RobotError } from "../api";

export type MoveState =
  | { kind: "idle" }
  | { kind: "loading"; pixel: [number, number] }
  | { kind: "ok"; pixel: [number, number]; target_mm: [number, number, number] }
  | { kind: "err"; pixel: [number, number] | null; error: RobotError };

type Props = {
  state: MoveState;
  zOffsetMm: number;
  onZOffsetChange: (z: number) => void;
  calibrated: boolean;
  onCancel: () => void;
  onHomePressed: (state: MoveState) => void;
};

const HOME_STEP = 40;
const Z_OFFSET_KEY = "abb.moveRobot.zOffsetMm";

export function useStoredZOffset(initial: number): [number, (v: number) => void] {
  const [value, setValue] = useState<number>(() => {
    if (typeof window === "undefined") return initial;
    const raw = window.localStorage.getItem(Z_OFFSET_KEY);
    const parsed = raw == null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : initial;
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(Z_OFFSET_KEY, String(value));
    }
  }, [value]);
  return [value, setValue];
}

export function MoveRobotPanel({
  state,
  zOffsetMm,
  onZOffsetChange,
  calibrated,
  onCancel,
  onHomePressed,
}: Props) {
  const [zInput, setZInput] = useState(String(zOffsetMm));
  const [homing, setHoming] = useState(false);

  useEffect(() => {
    setZInput(String(zOffsetMm));
  }, [zOffsetMm]);

  const commitZ = () => {
    const n = Number(zInput);
    if (Number.isFinite(n)) onZOffsetChange(n);
    else setZInput(String(zOffsetMm));
  };

  const sendHome = async () => {
    setHoming(true);
    const res = await robotStep(HOME_STEP);
    setHoming(false);
    if ("err" in res) {
      onHomePressed({ kind: "err", pixel: null, error: res.err });
    } else {
      onHomePressed({ kind: "idle" });
    }
  };

  return (
    <div className="cal">
      <div className="cal__head">
        <h3 className="cal__title">Move robot</h3>
        <button type="button" className="cal__close" onClick={onCancel} aria-label="Exit mode">
          ×
        </button>
      </div>

      <p className="cal__hint">
        Click anywhere on the colour stream. The clicked pixel is deprojected, transformed into
        robot frame using the saved calibration, raised by the Z offset below, and sent as a
        linear move. Wrist orientation is locked to pHome1 on the controller side.
      </p>

      {!calibrated && (
        <div className="cal__err">
          Not calibrated. Run calibration first — click-to-move needs a camera→robot transform.
        </div>
      )}

      <div className="cal__section">
        <div className="cal__section-head">
          <span className="cal__section-title">Z offset above click</span>
        </div>
        <div className="moverobot__zrow">
          <input
            type="number"
            step="any"
            inputMode="decimal"
            className="moverobot__zinput"
            value={zInput}
            onChange={(e) => setZInput(e.target.value)}
            onBlur={commitZ}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <span className="moverobot__zunit">mm above clicked surface</span>
        </div>
      </div>

      <div className="cal__section">
        <div className="cal__section-head">
          <span className="cal__section-title">Last move</span>
        </div>
        {state.kind === "idle" && (
          <div className="readout__hint">Click on the stream to send the robot.</div>
        )}
        {state.kind === "loading" && (
          <div className="readout__hint">
            Sending ({state.pixel[0]}, {state.pixel[1]})…
          </div>
        )}
        {state.kind === "err" && (
          <div className="cal__err">
            {state.pixel ? `(${state.pixel[0]}, ${state.pixel[1]}): ` : ""}
            {state.error.status}: {state.error.detail}
          </div>
        )}
        {state.kind === "ok" && (
          <table className="readout__table">
            <tbody>
              <tr>
                <th>Pixel</th>
                <td>
                  ({state.pixel[0]}, {state.pixel[1]})
                </td>
              </tr>
              <tr className="readout__sep">
                <th colSpan={2}>Target (mm, robot frame)</th>
              </tr>
              <tr>
                <th>X</th>
                <td>{state.target_mm[0].toFixed(1)}</td>
              </tr>
              <tr>
                <th>Y</th>
                <td>{state.target_mm[1].toFixed(1)}</td>
              </tr>
              <tr>
                <th>Z</th>
                <td>{state.target_mm[2].toFixed(1)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="cal__actions">
        <button
          type="button"
          className="cal__btn cal__btn--ghost"
          onClick={sendHome}
          disabled={homing}
          title="Send STEP 40 (Step_Home → mvHome) to the controller"
        >
          {homing ? "Homing…" : "Home (step 40)"}
        </button>
        <button type="button" className="cal__btn cal__btn--ghost" onClick={onCancel}>
          Exit
        </button>
      </div>
    </div>
  );
}
