import { useEffect, useRef, useState, type MouseEvent } from "react";

export type Marker = {
  pixelX: number;
  pixelY: number;
  label: string;
};

type Props = {
  title: string;
  streamUrl: string | null;
  onPixelClick?: (x: number, y: number) => void;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  markers?: Marker[];
  // Drag callbacks. onMarkerMove fires continuously while dragging (used to
  // keep the marker under the cursor); onMarkerDrop fires once at mouse-up
  // and is where the parent should refresh expensive state (e.g. re-fetch
  // the deprojected camera_xyz_m for the new pixel).
  onMarkerMove?: (index: number, pixelX: number, pixelY: number) => void;
  onMarkerDrop?: (index: number, pixelX: number, pixelY: number) => void;
};

export function VideoPanel({
  title,
  streamUrl,
  onPixelClick,
  intrinsicWidth,
  intrinsicHeight,
  markers,
  onMarkerMove,
  onMarkerDrop,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const pixelFromMouseEvent = (clientX: number, clientY: number) => {
    if (!imgRef.current) return null;
    const rect = imgRef.current.getBoundingClientRect();
    const naturalW = imgRef.current.naturalWidth || rect.width;
    const naturalH = imgRef.current.naturalHeight || rect.height;
    const sx = (intrinsicWidth ?? naturalW) / rect.width;
    const sy = (intrinsicHeight ?? naturalH) / rect.height;
    const targetW = intrinsicWidth ?? naturalW;
    const targetH = intrinsicHeight ?? naturalH;
    const x = Math.round(Math.max(0, Math.min(rect.width, clientX - rect.left)) * sx);
    const y = Math.round(Math.max(0, Math.min(rect.height, clientY - rect.top)) * sy);
    return {
      x: Math.max(0, Math.min(targetW - 1, x)),
      y: Math.max(0, Math.min(targetH - 1, y)),
    };
  };

  const handleClick = (e: MouseEvent<HTMLImageElement>) => {
    if (!onPixelClick) return;
    const p = pixelFromMouseEvent(e.clientX, e.clientY);
    if (p) onPixelClick(p.x, p.y);
  };

  const handleMarkerDown = (index: number, e: MouseEvent<SVGSVGElement>) => {
    if (!onMarkerMove && !onMarkerDrop) return;
    // Suppress the underlying image-click and any text selection during drag.
    e.preventDefault();
    e.stopPropagation();
    setDragIndex(index);
  };

  useEffect(() => {
    if (dragIndex === null) return;
    const handleMove = (e: globalThis.MouseEvent) => {
      const p = pixelFromMouseEvent(e.clientX, e.clientY);
      if (p) onMarkerMove?.(dragIndex, p.x, p.y);
    };
    const handleUp = (e: globalThis.MouseEvent) => {
      const p = pixelFromMouseEvent(e.clientX, e.clientY);
      if (p) onMarkerDrop?.(dragIndex, p.x, p.y);
      setDragIndex(null);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    // pixelFromMouseEvent reads intrinsic{Width,Height} from current props;
    // intentionally re-bind when those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragIndex, intrinsicWidth, intrinsicHeight, onMarkerMove, onMarkerDrop]);

  return (
    <div className="video-panel">
      <div className="video-panel__title">{title}</div>
      {streamUrl ? (
        <div className="video-panel__media">
          <img
            ref={imgRef}
            className="video-panel__img"
            src={streamUrl}
            alt={title}
            onClick={onPixelClick ? handleClick : undefined}
            style={{ cursor: onPixelClick ? "crosshair" : "default" }}
          />
          {markers && markers.length > 0 && intrinsicWidth && intrinsicHeight && (
            <div className="video-panel__overlay" aria-hidden="true">
              {markers.map((m, i) => (
                <div
                  key={i}
                  className="video-panel__marker"
                  style={{
                    left: `${(m.pixelX / intrinsicWidth) * 100}%`,
                    top: `${(m.pixelY / intrinsicHeight) * 100}%`,
                  }}
                >
                  <svg
                    className={
                      "video-panel__marker-cross" +
                      (dragIndex === i ? " video-panel__marker-cross--dragging" : "")
                    }
                    width="20"
                    height="20"
                    viewBox="0 0 20 20"
                    onMouseDown={(e) => handleMarkerDown(i, e)}
                  >
                    {/* dark outline beneath the strokes so the X stays
                        visible against bright image regions */}
                    <line x1="4" y1="4" x2="16" y2="16" stroke="#14171c" strokeWidth="4" strokeLinecap="round" />
                    <line x1="16" y1="4" x2="4" y2="16" stroke="#14171c" strokeWidth="4" strokeLinecap="round" />
                    <line x1="4" y1="4" x2="16" y2="16" stroke="#f9d27a" strokeWidth="2" strokeLinecap="round" />
                    <line x1="16" y1="4" x2="4" y2="16" stroke="#f9d27a" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <span className="video-panel__marker-label">{m.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="video-panel__placeholder">No feed</div>
      )}
    </div>
  );
}
