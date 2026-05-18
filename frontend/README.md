# Frontend — Camera Viewer

Vite + React + TypeScript. Two MJPEG `<img>` panels (colour + colorized depth)
side-by-side. Clicking the colour panel POSTs the pixel to `/api/click` and
shows the resulting (X, Y, Z) in camera frame.

## First-time setup

```powershell
npm install
```

## Run dev server

```powershell
npm run dev
```

Vite proxies `/api` and `/stream` to the backend at `127.0.0.1:8000`, so start
the backend (`backend/run.ps1`) first.
