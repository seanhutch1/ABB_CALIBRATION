# Backend — Camera Service

FastAPI service that captures aligned RGB + depth from an Intel RealSense D435,
streams both as MJPEG, and exposes a click → 3D point endpoint.

## Run

Normally launched together with the frontend via `npm start` at the repo root.

To run the backend alone (for debugging):

```bash
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

The camera is opened on app startup and torn down on shutdown.

## Endpoints

| Method | Path                  | Notes                                               |
| ------ | --------------------- | --------------------------------------------------- |
| GET    | `/api/health`         | liveness                                            |
| GET    | `/api/status`         | device info + USB type + active profile             |
| GET    | `/api/intrinsics`     | camera intrinsics + depth scale                     |
| GET    | `/stream/color`       | MJPEG live RGB feed                                 |
| GET    | `/stream/depth`       | MJPEG live colorized-depth feed                     |
| POST   | `/api/click`          | `{x, y}` pixel → `{X, Y, Z}` metres in camera frame |

## Layout

- `app/camera/realsense.py` — clean RealSense wrapper, context-managed.
- `app/streaming/frame_store.py` — thread-safe latest-frame holder.
- `app/streaming/capture.py` — background capture thread (camera → store).
- `app/streaming/mjpeg.py` — `multipart/x-mixed-replace` generator.
- `app/main.py` — FastAPI app + endpoints.
- `app/config.py` — pydantic settings; override via env vars (`CAMERA_FPS=15`, etc.).
