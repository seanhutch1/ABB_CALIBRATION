# ABB_Calibration

Vision-guided picking system for an ABB IRB120 robot using an Intel RealSense D435. 

## What it does

- **Live camera feed** — RGB + colorized depth shown side-by-side in the browser.
- **Click readout** — click any pixel on the colour feed to see the deprojected 3D point in camera frame (and robot frame once calibrated).
- **Hand-eye calibration** — capture 4 table corners, enter their robot-frame XYZ, save. Persisted between sessions.
- **Click-to-move** — toggle "Move robot" mode in the header, click anywhere on the feed, the IRB120 moves to that point plus a configurable Z safety offset.
- **State-machine bridge** — a bidirectional TCP socket protocol lets Python drive the RAPID program. Step numbers from the controller-side `States.mod` (e.g. `40` home, `110`/`120` top-right, `210`/`220` bottom-left) can be invoked from Python with `step N`.
- **Headless CLI** — the same robot client is usable standalone without the browser: `python -m app.robot {ping | home | move-to X Y Z | step N}`.

## Repo layout

```
backend/                FastAPI service
  app/
    camera/             RealSense pipeline (D435 wrapper, deprojection)
    streaming/          MJPEG endpoints + frame store + capture worker
    calibration/        Camera->robot transform, persistence
    robot/              TCP client for the IRC5 + CLI entry point
    main.py             FastAPI app
    config.py           Pydantic settings (env-driven)
frontend/               Vite + React + TS viewer
  src/
    components/         VideoPanel, ClickReadout, CalibrationPanel, MoveRobotPanel, ...
    api.ts              Typed REST client
    App.tsx             Mode state machine (view / calibrate / move-robot)
start.js                Cross-platform launcher (spawns backend + frontend)
setup.js                Cross-platform installer
```

The RAPID module that pairs with `backend/app/robot/` is deployed directly to the IRC5 controller and is not tracked in this repo.

## Prerequisites

- **Node.js 18+** — for the launcher and Vite.
- **Python 3.11+** on PATH. System Python, conda, venv, uv — anything works. Override with `PYTHON_BIN=/path/to/python` if needed.
- **Intel RealSense D435** plugged into a **USB 3** port directly on your laptop chassis for full quality (640×480 @ 30 fps). USB 2 / hub / dock falls back to a 424×240 @ 15 fps profile that uses YUYV color encoding to fit USB 2 bandwidth; you'll see a warning banner when this happens.
- *(Optional, for robot integration)* **ABB IRC5 controller** reachable on the LAN at `192.168.125.1:5000`, running a RAPID server module that speaks the line-framed ASCII protocol defined at the top of [`backend/app/robot/client.py`](backend/app/robot/client.py). RobotWare needs the Socket Messaging option (standard on most IRC5s).

## First time

```bash
npm run setup
```

Installs Python deps from `backend/requirements.txt` and runs `npm install` in `frontend/`.

## Run

```bash
npm start
```

Spawns the backend (FastAPI, port 8000) and the frontend (Vite, port 5173) in parallel with prefixed coloured logs. Open http://localhost:5173.

You should see the live RGB feed on the left, colorized depth on the right, and a status pill in the header showing the active camera profile.

**Header controls**:

| Button | Behaviour |
|---|---|
| **Calibrate** | Click 4 corners on the colour stream, enter their robot-frame XYZ, save. Required before click-to-move can work. |
| **Move robot** | Once calibrated, click anywhere on the colour or depth feed and the robot moves to that point with a configurable Z offset (default +100 mm above the clicked surface). Includes a "Home (step 40)" button that invokes `Step_Home` on the controller. |
| **Layout toggle** | Show colour-only, depth-only, or both side-by-side. |

Ctrl+C in the launcher terminates both processes cleanly (graceful uvicorn shutdown, then force-kill if anything hangs).

## Robot CLI

The robot client is runnable standalone for testing without the browser or backend:

```bash
cd backend
python -m app.robot ping                       # round-trip check, no motion
python -m app.robot home                       # move to the controller's HOME pose
python -m app.robot move-to 450 0 350          # absolute X Y Z in mm, robot frame
python -m app.robot step 40                    # invoke ExecStepMachine(40)
python -m app.robot --host 192.168.125.1 ping  # override host / port per-invocation
```

The CLI uses the same `RobotClient` class the FastAPI backend uses, so any behaviour you see from the CLI matches what the browser triggers.

## Wire protocol (Python <-> RAPID)

Bidirectional TCP on port 5000, ASCII, LF-terminated lines. Full spec at the top of [`backend/app/robot/client.py`](backend/app/robot/client.py).

```
Python -> RAPID:  PING <seq>\n
                  HOME <seq>\n
                  MOVE <seq> <x_mm> <y_mm> <z_mm>\n
                  STEP <seq> <stepNum>\n
                  QUIT <seq>\n
RAPID  -> Python: ACK  <seq> <result>\n
```

Result codes: `0` OK, `1` UNREACHABLE, `2` PROTOCOL_ERROR, `3` INTERNAL_ERROR.

## Configuration (env vars, all optional)

| Variable                  | Default           | Notes                                              |
| ------------------------- | ----------------- | -------------------------------------------------- |
| `PYTHON_BIN`              | `python`          | Path to the Python executable.                     |
| `BACKEND_HOST`            | `127.0.0.1`       | uvicorn host.                                      |
| `BACKEND_PORT`            | `8000`            | uvicorn port.                                      |
| `CAMERA_MODE`             | `auto`            | `auto` / `usb3` / `usb2` — override USB detection. |
| `CAMERA_JPEG_QUALITY`     | `80`              | MJPEG encode quality.                              |
| `ROBOT_HOST`              | `192.168.125.1`   | IRC5 controller IP.                                |
| `ROBOT_PORT`              | `5000`            | RAPID socket server port.                          |
| `ROBOT_CONNECT_TIMEOUT_S` | `5.0`             | TCP connect + non-motion ack deadline.             |
| `ROBOT_MOTION_TIMEOUT_S`  | `30.0`            | Ack deadline for motion commands.                  |

Set via `.env` file in `backend/` or as shell exports — both work.
