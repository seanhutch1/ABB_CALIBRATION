import { useState } from "react";
import {
  postCalibration,
  type Calibration,
  type CalibrationCornerInput,
} from "../api";

export type CapturedCorner = {
  pixel: [number, number];
  camera_xyz_m: [number, number, number];
};

export type StringTriple = { x: string; y: string; z: string };

type Props = {
  corners: CapturedCorner[];
  units: "mm" | "m";
  onUnitsChange: (units: "mm" | "m") => void;
  onResetCorners: () => void;
  onRemoveCorner: (index: number) => void;
  onSaved: (cal: Calibration) => void;
  onCancel: () => void;
  // Optional pre-fill for the robot XYZ text fields — used when entering
  // Calibrate mode with an already-saved calibration so the user doesn't
  // have to retype values they already entered.
  initialRobotInputs?: StringTriple[];
};

const REQUIRED = 4;

const emptyTriple = (): StringTriple => ({ x: "", y: "", z: "" });

export function CalibrationPanel({
  corners,
  units,
  onUnitsChange,
  onResetCorners,
  onRemoveCorner,
  onSaved,
  onCancel,
  initialRobotInputs,
}: Props) {
  const [robotInputs, setRobotInputs] = useState<StringTriple[]>(
    () => {
      const seed = initialRobotInputs ?? [];
      return Array.from({ length: REQUIRED }, (_, i) => seed[i] ?? emptyTriple());
    },
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allCornersClicked = corners.length >= REQUIRED;
  const allRobotFilled = robotInputs
    .slice(0, REQUIRED)
    .every((r) => r.x.trim() !== "" && r.y.trim() !== "" && r.z.trim() !== "");
  const canSubmit = allCornersClicked && allRobotFilled && !submitting;

  const updateInput = (i: number, key: keyof StringTriple, value: string) => {
    setRobotInputs((rows) => rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  };

  const submit = async () => {
    setError(null);
    const parsed: CalibrationCornerInput[] = [];
    for (let i = 0; i < REQUIRED; i++) {
      const c = corners[i];
      const r = robotInputs[i];
      const xn = Number(r.x);
      const yn = Number(r.y);
      const zn = Number(r.z);
      if (!Number.isFinite(xn) || !Number.isFinite(yn) || !Number.isFinite(zn)) {
        setError(`Corner ${i + 1}: enter numeric values for X, Y, Z.`);
        return;
      }
      parsed.push({
        pixel: c.pixel,
        camera_xyz_m: c.camera_xyz_m,
        robot_xyz: [xn, yn, zn],
      });
    }
    setSubmitting(true);
    const res = await postCalibration(parsed, units);
    setSubmitting(false);
    if ("err" in res) {
      setError(`${res.err.status}: ${res.err.detail}`);
      return;
    }
    onSaved(res.ok);
  };

  return (
    <div className="cal">
      <div className="cal__head">
        <h3 className="cal__title">Calibration</h3>
        <button type="button" className="cal__close" onClick={onCancel} aria-label="Cancel">
          ×
        </button>
      </div>

      <p className="cal__hint">
        Click each of the 4 table corners on the live colour stream, then enter the matching
        robot XYZ for each.
      </p>

      <div className="cal__section">
        <div className="cal__section-head">
          <span className="cal__section-title">
            Corners {corners.length} / {REQUIRED}
          </span>
          <button
            type="button"
            className="cal__btn cal__btn--ghost"
            onClick={onResetCorners}
            disabled={corners.length === 0}
          >
            Reset
          </button>
        </div>
        <ul className="cal__corners">
          {Array.from({ length: REQUIRED }, (_, i) => i).map((i) => {
            const c = corners[i];
            return (
              <li key={i} className={"cal__corner" + (c ? "" : " cal__corner--empty")}>
                <span className="cal__corner-num">{i + 1}</span>
                {c ? (
                  <>
                    <span className="cal__corner-info">
                      ({c.pixel[0]}, {c.pixel[1]}) → cam ({c.camera_xyz_m[0].toFixed(3)},{" "}
                      {c.camera_xyz_m[1].toFixed(3)}, {c.camera_xyz_m[2].toFixed(3)}) m
                    </span>
                    <button
                      type="button"
                      className="cal__corner-x"
                      onClick={() => onRemoveCorner(i)}
                      aria-label={`Remove corner ${i + 1}`}
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <span className="cal__corner-empty-text">click on the stream</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="cal__section">
        <div className="cal__section-head">
          <span className="cal__section-title">Robot XYZ</span>
          <select
            className="cal__units"
            value={units}
            onChange={(e) => onUnitsChange(e.target.value as "mm" | "m")}
          >
            <option value="mm">mm</option>
            <option value="m">m</option>
          </select>
        </div>
        <table className="cal__table">
          <thead>
            <tr>
              <th />
              <th>X</th>
              <th>Y</th>
              <th>Z</th>
            </tr>
          </thead>
          <tbody>
            {robotInputs.map((row, i) => (
              <tr key={i}>
                <th scope="row">{i + 1}</th>
                {(["x", "y", "z"] as const).map((axis) => (
                  <td key={axis}>
                    <input
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={row[axis]}
                      onChange={(e) => updateInput(i, axis, e.target.value)}
                      disabled={!corners[i]}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <div className="cal__err">{error}</div>}

      <div className="cal__actions">
        <button type="button" className="cal__btn cal__btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="cal__btn cal__btn--primary"
          onClick={submit}
          disabled={!canSubmit}
          title={
            !allCornersClicked
              ? "Click all 4 corners on the stream first"
              : !allRobotFilled
              ? "Fill all robot XYZ fields"
              : ""
          }
        >
          {submitting ? "Saving…" : "Compute & save"}
        </button>
      </div>
    </div>
  );
}
