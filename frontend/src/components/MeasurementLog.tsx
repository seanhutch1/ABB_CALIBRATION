import { useEffect, useState } from "react";

export type MeasurementMode = "view" | "move-robot";

export type MeasurementRow = {
  id: string;
  timestamp: string;
  mode: MeasurementMode;
  pixel: [number, number];
  depth_mm: number | null;
  cam_xyz_mm: [number, number, number] | null;
  cmd_xyz_mm: [number, number, number] | null;
  snapped: boolean | null;
  actual_x: string;
  actual_y: string;
  actual_z: string;
  notes: string;
};

const STORAGE_KEY = "abb.measurementLog.rows";

export function useMeasurementLog(): {
  rows: MeasurementRow[];
  append: (
    seed: Omit<MeasurementRow, "id" | "timestamp" | "actual_x" | "actual_y" | "actual_z" | "notes">,
  ) => void;
  update: (id: string, patch: Partial<MeasurementRow>) => void;
  remove: (id: string) => void;
  clear: () => void;
} {
  const [rows, setRows] = useState<MeasurementRow[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as MeasurementRow[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    }
  }, [rows]);

  const append: ReturnType<typeof useMeasurementLog>["append"] = (seed) => {
    setRows((rs) => [
      ...rs,
      {
        ...seed,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        actual_x: "",
        actual_y: "",
        actual_z: "",
        notes: "",
      },
    ]);
  };

  const update = (id: string, patch: Partial<MeasurementRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const remove = (id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id));
  };

  const clear = () => setRows([]);

  return { rows, append, update, remove, clear };
}

type Props = {
  rows: MeasurementRow[];
  onUpdate: (id: string, patch: Partial<MeasurementRow>) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
};

// Returns the reference XYZ a row's "actual" fields are compared against:
// commanded (move-robot) or camera-frame (view). Returns null if there's
// no reference (view-mode click with no depth, for instance).
function referenceXyzMm(r: MeasurementRow): [number, number, number] | null {
  if (r.mode === "move-robot") return r.cmd_xyz_mm;
  return r.cam_xyz_mm;
}

// Parse one actual field. Empty/whitespace = "not filled" (null). A finite
// number = a real entry. Anything else (e.g. "abc") also returns null.
function parseActual(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

type RowErrors = {
  ex: number | null;
  ey: number | null;
  ez: number | null;
  eEuclid: number | null;
};

function computeErrors(r: MeasurementRow): RowErrors {
  const ref = referenceXyzMm(r);
  if (!ref) return { ex: null, ey: null, ez: null, eEuclid: null };
  const ax = parseActual(r.actual_x);
  const ay = parseActual(r.actual_y);
  const az = parseActual(r.actual_z);
  const ex = ax == null ? null : ax - ref[0];
  const ey = ay == null ? null : ay - ref[1];
  const ez = az == null ? null : az - ref[2];
  // Euclidean error only meaningful when all three axes were measured.
  const eEuclid =
    ex != null && ey != null && ez != null ? Math.sqrt(ex * ex + ey * ey + ez * ez) : null;
  return { ex, ey, ez, eEuclid };
}

function fmt(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: MeasurementRow[]): string {
  const headers = [
    "timestamp",
    "mode",
    "pixel_x",
    "pixel_y",
    "depth_mm",
    "cam_x_mm",
    "cam_y_mm",
    "cam_z_mm",
    "cmd_x_mm",
    "cmd_y_mm",
    "cmd_z_mm",
    "actual_x_mm",
    "actual_y_mm",
    "actual_z_mm",
    "err_x_mm",
    "err_y_mm",
    "err_z_mm",
    "err_euclid_mm",
    "snapped",
    "notes",
  ];
  const lines: string[] = [headers.join(",")];
  for (const r of rows) {
    const err = computeErrors(r);
    const cells = [
      r.timestamp,
      r.mode,
      String(r.pixel[0]),
      String(r.pixel[1]),
      r.depth_mm == null ? "" : r.depth_mm.toFixed(3),
      r.cam_xyz_mm ? r.cam_xyz_mm[0].toFixed(3) : "",
      r.cam_xyz_mm ? r.cam_xyz_mm[1].toFixed(3) : "",
      r.cam_xyz_mm ? r.cam_xyz_mm[2].toFixed(3) : "",
      r.cmd_xyz_mm ? r.cmd_xyz_mm[0].toFixed(3) : "",
      r.cmd_xyz_mm ? r.cmd_xyz_mm[1].toFixed(3) : "",
      r.cmd_xyz_mm ? r.cmd_xyz_mm[2].toFixed(3) : "",
      r.actual_x,
      r.actual_y,
      r.actual_z,
      err.ex == null ? "" : err.ex.toFixed(3),
      err.ey == null ? "" : err.ey.toFixed(3),
      err.ez == null ? "" : err.ez.toFixed(3),
      err.eEuclid == null ? "" : err.eEuclid.toFixed(3),
      r.snapped == null ? "" : String(r.snapped),
      r.notes,
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function downloadCsv(rows: MeasurementRow[]) {
  const csv = rowsToCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `measurement-log-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function MeasurementLog({ rows, onUpdate, onDelete, onClear }: Props) {
  const handleClear = () => {
    if (rows.length === 0) return;
    if (window.confirm(`Clear all ${rows.length} log row(s)? This cannot be undone.`)) {
      onClear();
    }
  };

  return (
    <div className="mlog">
      <div className="mlog__head">
        <h3 className="mlog__title">Measurement log ({rows.length})</h3>
        <div className="mlog__actions">
          <button
            type="button"
            className="cal__btn cal__btn--ghost"
            onClick={handleClear}
            disabled={rows.length === 0}
          >
            Clear
          </button>
          <button
            type="button"
            className="cal__btn cal__btn--primary"
            onClick={() => downloadCsv(rows)}
            disabled={rows.length === 0}
          >
            Download CSV
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mlog__empty">
          Log is on. Each click in view mode or move-robot mode will append a row. Fill the
          <em> Actual X/Y/Z</em> cells with the value you read from the FlexPendant or tape, then
          download as CSV.
        </div>
      ) : (
        <div className="mlog__scroll">
          <table className="mlog__table">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Mode</th>
                <th>Pixel</th>
                <th>Depth (mm)</th>
                <th>Cam XYZ (mm)</th>
                <th>Cmd XYZ (mm)</th>
                <th>Actual X</th>
                <th>Actual Y</th>
                <th>Actual Z</th>
                <th>Err XYZ (mm)</th>
                <th>‖Err‖ (mm)</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const err = computeErrors(r);
                const ref = referenceXyzMm(r);
                const refLabel = r.mode === "move-robot" ? "vs Cmd" : "vs Cam";
                return (
                  <tr key={r.id}>
                    <td>{i + 1}</td>
                    <td title={r.timestamp}>{r.timestamp.slice(11, 19)}</td>
                    <td>{r.mode === "move-robot" ? "move" : "view"}</td>
                    <td>
                      ({r.pixel[0]}, {r.pixel[1]})
                    </td>
                    <td>{fmt(r.depth_mm)}</td>
                    <td>
                      {r.cam_xyz_mm
                        ? `${fmt(r.cam_xyz_mm[0])}, ${fmt(r.cam_xyz_mm[1])}, ${fmt(r.cam_xyz_mm[2])}`
                        : "—"}
                    </td>
                    <td>
                      {r.cmd_xyz_mm
                        ? `${fmt(r.cmd_xyz_mm[0])}, ${fmt(r.cmd_xyz_mm[1])}, ${fmt(r.cmd_xyz_mm[2])}`
                        : "—"}
                    </td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        className="mlog__input"
                        value={r.actual_x}
                        onChange={(e) => onUpdate(r.id, { actual_x: e.target.value })}
                        placeholder={ref ? fmt(ref[0]) : ""}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        className="mlog__input"
                        value={r.actual_y}
                        onChange={(e) => onUpdate(r.id, { actual_y: e.target.value })}
                        placeholder={ref ? fmt(ref[1]) : ""}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        className="mlog__input"
                        value={r.actual_z}
                        onChange={(e) => onUpdate(r.id, { actual_z: e.target.value })}
                        placeholder={ref ? fmt(ref[2]) : ""}
                      />
                    </td>
                    <td title={refLabel}>
                      {err.ex == null && err.ey == null && err.ez == null
                        ? "—"
                        : `${fmt(err.ex)}, ${fmt(err.ey)}, ${fmt(err.ez)}`}
                    </td>
                    <td>{fmt(err.eEuclid)}</td>
                    <td>
                      <input
                        type="text"
                        className="mlog__input mlog__input--notes"
                        value={r.notes}
                        onChange={(e) => onUpdate(r.id, { notes: e.target.value })}
                        placeholder="free text"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="cal__corner-x"
                        onClick={() => onDelete(r.id)}
                        aria-label="Delete row"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
