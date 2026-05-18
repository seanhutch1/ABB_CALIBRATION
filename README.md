# ABB_Calibration

Vision-guided picking system for an ABB IRB120 robot using an Intel RealSense D435.
Clean rebuild of the legacy code preserved under `Legacy Files for Reference/`.

See [CLAUDE.md](CLAUDE.md) for project context, what the legacy system does, and
the rebuild's thesis-level deliverables.

## Repo layout

```
backend/    FastAPI camera service (Python)
frontend/   Vite + React + TS viewer
start.js    Cross-platform launcher (spawns both)
setup.js    Cross-platform installer
```

## Prerequisites

- **Node.js 18+** (for the launcher and frontend).
- **Python 3.11+** on PATH. Anything works — system Python, conda env, venv,
  uv-managed env. Override with `PYTHON_BIN=/path/to/python` if needed.
- **Intel RealSense D435** plugged into a **USB 3** port directly on your laptop
  for full quality. USB 2 / hub / dock works but the app drops to a degraded
  profile and shows a warning.

## First time

```bash
npm run setup
```

Installs Python deps from `backend/requirements.txt` and `npm install` in `frontend/`.

## Run

```bash
npm start
```

Spawns the backend (FastAPI, port 8000) and the frontend (Vite, port 5173) in
parallel. Open http://localhost:5173.

You should see the live RGB feed on the left, colorized depth on the right, and
a status pill in the header showing the active camera profile. Click anywhere
on the colour feed to read out the 3D point in camera frame.

Ctrl+C in the launcher terminates both processes cleanly.

## Configuration (env vars)

| Variable        | Default       | Notes                                                |
| --------------- | ------------- | ---------------------------------------------------- |
| `PYTHON_BIN`    | `python`      | Path to the Python executable.                       |
| `BACKEND_HOST`  | `127.0.0.1`   | uvicorn host.                                        |
| `BACKEND_PORT`  | `8000`        | uvicorn port.                                        |
| `CAMERA_MODE`   | `auto`        | `auto` / `usb3` / `usb2` — override USB detection.   |
| `CAMERA_JPEG_QUALITY` | `80`    | MJPEG encode quality.                                |
