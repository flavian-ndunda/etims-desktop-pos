# eTIMS Desktop POS

Offline-first desktop POS built with Electron + Laravel.
Wraps [etims-pos](https://github.com/flavian-ndunda/etims-pos) in a desktop shell.

## How It Works

- Laravel runs locally as an embedded PHP server on port 8765
- Sales are saved to SQLite instantly — no internet needed
- Queue worker syncs pending invoices to KRA when internet returns
- Connectivity monitor checks KRA API every 30 seconds
- System tray shows online/offline status and pending invoice count

## Requirements

- Node.js 18+
- PHP 8.2+ installed and in PATH
- [etims-pos](https://github.com/flavian-ndunda/etims-pos) cloned as a sibling folder

## Setup

```bash
# 1. Clone both repos side by side
git clone https://github.com/flavian-ndunda/etims-pos.git
git clone https://github.com/flavian-ndunda/etims-desktop-pos.git

# 2. Set up the Laravel app first
cd etims-pos
composer install
cp .env.example .env
php artisan key:generate
php artisan migrate --seed

# 3. Set up the desktop app
cd ../etims-desktop-pos
npm install
node scripts/setup.js

# 4. Launch
npm start
```

## Building for Distribution

```bash
# Windows installer
npm run build:win

# Linux AppImage
npm run build:linux
```

Output goes to the `dist/` folder.

## Offline Behavior

| Scenario | What Happens |
|---|---|
| No internet at startup | App works, queue paused |
| Internet drops | Queue pauses, sales continue locally |
| Internet returns | Queue resumes, all pending invoices sync to KRA |
| Power cut | Jobs in SQLite survive, sync resumes on reboot |

## License

MIT - Flavytech Solutions