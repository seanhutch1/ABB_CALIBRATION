import { useEffect, useRef, useState } from "react";
import type { Calibration, CameraStatus, Intrinsics } from "../api";

type Props = {
  status: CameraStatus | null;
  intrinsics: Intrinsics | null;
  calibration: Calibration | null;
};

const fmt = (n: number, d = 4) => n.toFixed(d);

export function IntrinsicsDropdown({ status, intrinsics, calibration }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="info-dropdown" ref={ref}>
      <button
        type="button"
        className="info-dropdown__btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        info {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="info-dropdown__panel" role="dialog" aria-label="Camera info">
          {!status ? (
            <div className="info-dropdown__hint">No camera info yet.</div>
          ) : (
            <Sections status={status} intrinsics={intrinsics} calibration={calibration} />
          )}
        </div>
      )}
    </div>
  );
}

function Sections({
  status,
  intrinsics,
  calibration,
}: {
  status: CameraStatus;
  intrinsics: Intrinsics | null;
  calibration: Calibration | null;
}) {
  return (
    <>
      <Section title="Device">
        <Row label="Name" value={status.device?.name ?? "—"} />
        <Row label="Serial" value={status.device?.serial ?? "—"} mono />
        <Row label="Firmware" value={status.device?.firmware ?? "—"} mono />
        <Row label="USB" value={status.device ? `${status.device.usb_type}${status.device.is_usb2 ? " (degraded)" : ""}` : "—"} />
      </Section>
      <Section title="Stream profile">
        <Row label="Profile" value={status.profile?.name ?? "—"} />
        <Row label="Resolution" value={status.profile ? `${status.profile.width}×${status.profile.height}` : "—"} />
        <Row label="Frame rate" value={status.profile ? `${status.profile.fps} fps` : "—"} />
        <Row label="Mode setting" value={status.mode_setting} />
      </Section>
      <Section title="Intrinsics (factory)">
        {!intrinsics ? (
          <div className="info-dropdown__hint">Not available.</div>
        ) : (
          <>
            <Row label="fx" value={fmt(intrinsics.fx, 3)} mono />
            <Row label="fy" value={fmt(intrinsics.fy, 3)} mono />
            <Row label="cx (ppx)" value={fmt(intrinsics.ppx, 3)} mono />
            <Row label="cy (ppy)" value={fmt(intrinsics.ppy, 3)} mono />
            <Row label="Distortion model" value={intrinsics.model} mono />
            <Row label="Distortion coeffs" value={intrinsics.coeffs.map((c) => fmt(c, 4)).join(", ")} mono />
            <Row label="Depth scale" value={`${intrinsics.depth_scale.toExponential(3)} m / unit`} mono />
          </>
        )}
      </Section>
      <Section title="Calibration">
        {!calibration ? (
          <div className="info-dropdown__hint info-dropdown__hint--err">Not calibrated.</div>
        ) : (
          <>
            <Row label="Calibrated" value={describeAge(calibration.created_at)} />
            <Row label="Points" value={String(calibration.num_points)} />
            <Row label="RMSE" value={`${calibration.rmse_mm.toFixed(2)} mm`} mono />
            <Row label="Input units" value={calibration.units_input} />
          </>
        )}
      </Section>
      <p className="info-dropdown__footnote">
        Intrinsics shown are the factory calibration baked into the camera.
      </p>
    </>
  );
}

function describeAge(isoTimestamp: string): string {
  const t = new Date(isoTimestamp).getTime();
  if (Number.isNaN(t)) return isoTimestamp;
  const seconds = (Date.now() - t) / 1000;
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} hr ago`;
  const days = hours / 24;
  return `${Math.round(days)} days ago`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="info-dropdown__section">
      <h4 className="info-dropdown__h">{title}</h4>
      {children}
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info-dropdown__row">
      <span className="info-dropdown__label">{label}</span>
      <span className={"info-dropdown__value" + (mono ? " info-dropdown__value--mono" : "")}>{value}</span>
    </div>
  );
}
