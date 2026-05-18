import { useRef, type MouseEvent } from "react";

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
};

export function VideoPanel({
  title,
  streamUrl,
  onPixelClick,
  intrinsicWidth,
  intrinsicHeight,
  markers,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);

  const handleClick = (e: MouseEvent<HTMLImageElement>) => {
    if (!onPixelClick || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const sx = (intrinsicWidth ?? imgRef.current.naturalWidth ?? rect.width) / rect.width;
    const sy = (intrinsicHeight ?? imgRef.current.naturalHeight ?? rect.height) / rect.height;
    const x = Math.round((e.clientX - rect.left) * sx);
    const y = Math.round((e.clientY - rect.top) * sy);
    onPixelClick(x, y);
  };

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
                  <span className="video-panel__marker-dot" />
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
