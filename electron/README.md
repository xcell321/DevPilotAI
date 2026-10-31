# DevPilot AI — Desktop App (Electron)

Run DevPilot AI as a native Windows desktop app. No browser, no terminal.

## For the developer (one-time setup on the build PC)

Prerequisites: Node.js 18+, Windows 10/11.

```powershell
# 1. Install dependencies (from repo root)
npm install

# 2. Rebuild native modules for Electron (node-pty needs this)
npx electron-rebuild

# 3. Build backend + frontend + installer
npm run electron:build
```

The installer lands in `dist-electron/` (e.g. `DevPilot AI Setup 0.1.0.exe`).
Run it once — DevPilot AI appears in the Start Menu.

### Dev mode (no packaging)

```powershell
# Terminal 1: start backend + frontend as usual
npm run dev

# Terminal 2: open the Electron shell against it
npm run electron:dev
```

### Optional: app icon

Convert `logo/app-icon-3.svg` to `.ico` (e.g. via an online converter),
save as `logo/app-icon-3.ico`, then uncomment the `icon:` line in
`electron-builder.yml` and rebuild.

## How it works

- `electron/main.cjs` spawns the Express backend (`server/dist/index.js`)
  as a child process, waits for `/api/health`, then opens the window.
- The backend already serves the built frontend statically, so the
  window just loads `http://127.0.0.1:<port>`.
- Closing the window (or quitting) terminates the backend child.
- Everything stays on `127.0.0.1` — local-only by design, never exposed
  to the network.

## Notes

- `node-pty` is a native module: after every `npm install`, re-run
  `npx electron-rebuild` before `npm run electron:build`.
- The installer is unsigned; Windows SmartScreen will ask for confirmation
  on first run. This is normal for self-built apps.
