import type { Calibration, ClickError, ClickResult } from "../api";

type Props = {
  state:
    | { kind: "idle" }
    | { kind: "loading"; pixel: [number, number] }
    | { kind: "ok"; result: ClickResult }
    | { kind: "err"; pixel: [number, number]; error: ClickError };
  calibration: Calibration | null;
  snap: boolean;
  onSnapChange: (snap: boolean) => void;
};

const fmtM = (n: number) => n.toFixed(3);
const fmtMm = (n: number) => (n * 1000).toFixed(1);

export function ClickReadout({ state, calibration, snap, onSnapChange }: Props) {
  return (
    <div className="readout">
      <div className="readout__head">
        <span className="readout__title">Click readout</span>
        <label
          className={"readout__snap" + (calibration ? "" : " readout__snap--disabled")}
          title={calibration ? "" : "Calibrate first to enable snap-to-table"}
        >
          <input
            type="checkbox"
            checked={snap && !!calibration}
            disabled={!calibration}
            onChange={(e) => onSnapChange(e.target.checked)}
          />
          Snap to table
        </label>
      </div>

      {state.kind === "idle" && (
        <div className="readout__hint">Click anywhere on the colour stream.</div>
      )}
      {state.kind === "loading" && (
        <div className="readout__hint">
          Looking up depth at ({state.pixel[0]}, {state.pixel[1]})…
        </div>
      )}
      {state.kind === "err" && (
        <div className="readout__err">
          ({state.pixel[0]}, {state.pixel[1]}): {state.error.detail}
        </div>
      )}
      {state.kind === "ok" && (
        <table className="readout__table">
          <tbody>
            <tr>
              <th>Pixel</th>
              <td>
                ({state.result.pixel[0]}, {state.result.pixel[1]})
              </td>
            </tr>
            <tr>
              <th>Depth</th>
              <td>{fmtM(state.result.depth_metres)} m</td>
            </tr>
            <tr className="readout__sep">
              <th colSpan={2}>Camera frame (m)</th>
            </tr>
            <tr>
              <th>X</th>
              <td>{fmtM(state.result.camera_xyz_m[0])}</td>
            </tr>
            <tr>
              <th>Y</th>
              <td>{fmtM(state.result.camera_xyz_m[1])}</td>
            </tr>
            <tr>
              <th>Z</th>
              <td>{fmtM(state.result.camera_xyz_m[2])}</td>
            </tr>
            {state.result.calibrated && state.result.robot_xyz_m && (
              <>
                <tr className="readout__sep">
                  <th colSpan={2}>
                    Robot frame (mm)
                    {state.result.snapped && (
                      <span className="readout__tag">snapped</span>
                    )}
                  </th>
                </tr>
                <tr>
                  <th>X</th>
                  <td>{fmtMm(state.result.robot_xyz_m[0])}</td>
                </tr>
                <tr>
                  <th>Y</th>
                  <td>{fmtMm(state.result.robot_xyz_m[1])}</td>
                </tr>
                <tr>
                  <th>Z</th>
                  <td>{fmtMm(state.result.robot_xyz_m[2])}</td>
                </tr>
                {state.result.residual_to_plane_mm !== null && (
                  <tr>
                    <th>Above plane</th>
                    <td>{state.result.residual_to_plane_mm.toFixed(1)} mm</td>
                  </tr>
                )}
              </>
            )}
            {!state.result.calibrated && (
              <tr>
                <td colSpan={2} className="readout__note">
                  Not calibrated — robot frame unavailable.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
