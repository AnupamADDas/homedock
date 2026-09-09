# HomeDock — Web-Based Server Manager

<p align="center">
  <strong>A lightweight, modern, responsive, and secure web-based server management dashboard.</strong>
</p>

---

## 1. Overview

**HomeDock** is a self-hosted server manager designed to deliver a single, unified interface for:

1. **Real-time System Monitoring** (CPU, RAM, per-core utilization, network throughput, temperatures, and fan speeds).
2. **Drive & Storage Management** with **Dynamic Hot-Plug Detection** for attached USB drives and internal NVMe SSDs.
3. **Web-Based File Manager** with breadcrumb navigation, drag-and-drop uploads, and path-traversal-protected archive extraction.
4. **Integrated Download Manager** (AriaNg-inspired) powered by an internal `aria2c` engine supporting HTTP/HTTPS, BitTorrent, and Magnet links with global and per-task rate limiting.
5. **Robust Security & RBAC** featuring bcrypt password hashing, JWT sessions, brute-force IP rate-limiting, secure headers, and strict allowed-root directory boundary enforcement.

HomeDock is specifically engineered to run efficiently on Linux servers and laptop-servers such as the **ASUS ZenBook 13 UX331UAL** without requiring root privileges or heavy third-party kernel modules.

---

## 2. Key Features

### 2.1 Live System Telemetry & Header
* **Global Header Status:** Shows real-time CPU utilization, CPU temperature, RAM usage (used / total), and live network download/upload rates.
* **Rolling History Sparklines:** Zero-dependency HTML5 Canvas graphs tracking CPU, RAM, and Network traffic over a 60-second sliding window.
* **Hardware Sensors:** Reads CPU Package & per-core temperatures and ASUS WMI fan RPM directly from Linux `/sys/class/hwmon` without elevated root privileges. Gracefully degrades to *"Fan speed unavailable"* if sensors are not exposed on the host.

### 2.2 Storage & Drive Hot-Plug Support
* **Dynamic Drive Discovery:** Automatically recognizes internal NVMe drives and hot-plugged external USB HDDs/SSDs via `lsblk` and kernel `NETLINK_KOBJECT_UEVENT` block notifications.
* **Storage Metrics:** Displays device path, drive model, serial number, transport type (USB/NVMe/SATA), filesystem type, mount points, used/free storage bars, and real-time read/write throughput calculated from `/proc/diskstats`.
* **Zero Restart Hot-Plugging:** When a USB drive is attached or disconnected, HomeDock dynamically updates the dashboard and file manager storage chips in real-time via WebSockets without requiring a service restart.

### 2.3 Secure File Manager & Background Task Engine
* **Navigation:** Browse directories with interactive breadcrumbs, and quick-jump storage chips for all mounted disks.
* **Interactive Directory Browser:** PulseDL-inspired visual folder navigation with breadcrumb trail, drive shortcuts, and subfolder listing for seamless directory selection.
* **Drag-and-Drop Uploads:** Stream uploads directly onto the directory drop zone with live progress indicators.
* **Operations:** Open, download, create folder, rename, delete, copy, move, multi-select batch actions, and comprehensive item metadata inspection.
* **Asynchronous File Operations with Real-Time Progress:**
  - Background workers handle large **Copy**, **Move**, and **Archive Extraction** tasks asynchronously without blocking the UI.
  - Live progress modal displays real-time percent completion, source/destination paths, and transfer state.
  - Instant **Task Cancellation:** Cancel any ongoing copy, move, or extraction operation with automatic cleanup of partially transferred files.
* **Path-Traversal Protected Archive Extraction:**
  - Formats: `.zip`, `.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tbz2`, `.tar.xz`, `.txz`, and `.7z`.
  - Security: Validates every archive member prior to extraction, rejecting directory traversal sequences (e.g. `../../etc/passwd`), null bytes, or symlinks pointing outside the designated destination.
* **Allowed Roots Boundary:** Strictly prevents access or traversal outside administrator-configured allowed storage roots.

### 2.4 AriaNg-Style Download Manager
* **Multi-Protocol Support:** Paste HTTP, HTTPS, FTP, or Magnet URLs, or upload `.torrent` files.
* **Dynamic Destination & Default Synchronization:**
  - Configurable default download directory (defaults to external `/DATA/HDD/Downloads` when present).
  - Dynamically updates the running `aria2c` daemon's global download directory via JSON-RPC (`aria2.changeGlobalOption`) without requiring service restarts.
  - Streamlined "New Download" task modal: Uses active default directory automatically, with an optional destination override and a **"Save as default"** persistence option.
  - Automatic Whitelisting: Configured default download locations are automatically permitted in allowed storage roots.
* **Speed Limiting & Download Settings:**
  - Dedicated **Settings & Limits** modal to configure default download folders and bandwidth limits directly within the Download Manager.
  - Global maximum download and upload rate limits with live header pill and metric card indicators.
  - Per-task rate limits applied directly to the underlying download engine with visual badges and capped indicators.
* **Optimized Throughput:** Configured with socket receive buffers (`64K`), disk cache (`16M`), and multi-connection concurrency to fully saturate gigabit internet connections.
* **Download Controls:** Start, pause, resume, retry, cancel, and delete tasks (with optional on-disk file removal).
* **Secure RPC:** HomeDock runs `aria2c` strictly bound to `127.0.0.1` using an internal, high-entropy secret token. RPC interfaces are never exposed to the public internet or the client browser.

### 2.5 Security, RBAC & Settings
* **Authentication:** Password verification via `bcrypt` (work factor 12) and cryptographically signed JWT access tokens with unique `jti` revocation tracking.
* **Brute-Force Shield:** IP rate-limiting locks out IPs exceeding 5 failed authentication attempts for 15 minutes.
* **Role-Based Access Control (RBAC):**
  - **Administrator:** Full access to all telemetry, storage roots configuration, system settings, speed limits, and user administration.
  - **Standard User:** Restricted strictly to assigned storage directories and downloads; cannot modify global settings or manage users.
* **Visual Storage Roots Management:** Interactively browse, select, and manage Global Allowed Storage Roots with visual chips, folder browser integration, and instant removal.
* **Instant Auto-Save:** Selecting a default download folder from the directory picker saves the configuration immediately with cross-component event notification (`homedock:default_dir_changed`).
* **Hardened Headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection`, `Referrer-Policy`, and strict `Content-Security-Policy`.

---

## 3. Architecture & Design

```
+-------------------------------------------------------------------------+
|                              Web Browser                                |
|        (Desktop / Tablet / Mobile - Responsive Single Page UI)          |
|  - Real-time Header & Live Widgets (WebSockets / Fallback Polling)      |
|  - Dashboard (CPU, RAM, Net, Storage, Temps, Fan RPM, Histories)        |
|  - File Manager (Browse, Upload, DnD, Download, Ops, Safe Extraction)   |
|  - Download Manager (AriaNg style: HTTP, Torrents, Magnets, Limits)     |
|  - Settings & RBAC User Management (Allowed Roots, Limits, Defaults)    |
+------------------------------------+------------------------------------+
                                     | HTTPS / WSS (via Reverse Proxy)
                                     v
+-------------------------------------------------------------------------+
|                         HomeDock Core Backend                           |
|                       (FastAPI + Python 3.12)                           |
|                                                                         |
|  +--------------------+  +--------------------+  +--------------------+ |
|  |   Auth & Security  |  |  System & Sensors  |  |   Storage Monitor  | |
|  |  - JWT + Sessions  |  |  - /proc/stat, mem |  |  - Netlink UEvent  | |
|  |  - bcrypt Hashing  |  |  - /proc/net/dev   |  |  - /proc/mounts    | |
|  |  - Rate Limiter    |  |  - /proc/diskstats |  |  - lsblk JSON      | |
|  |  - RBAC Middleware |  |  - hwmon / sensors |  |  - Hot-plug events | |
|  +--------------------+  +--------------------+  +--------------------+ |
|                                                                         |
|  +--------------------+  +--------------------+  +--------------------+ |
|  |    File Manager    |  |  Download Service  |  |   WebSocket Hub    | |
|  |  - Allowed Roots   |  |  - aria2 RPC Client|  |  - Metrics Stream  | |
|  |  - Traversal Check |  |  - Rate Limit Mgmt |  |  - Hot-plug Push   | |
|  |  - Safe Extraction |  |  - Torrents/Magnets|  |  - Download Events | |
|  +--------------------+  +--------------------+  +--------------------+ |
|                                                                         |
|  +--------------------------------------------------------------------+ |
|  |                    SQLite Persistent Storage                       |
|  |      - Users & Roles  |  - Config & Limits  |  - Audit Log         |
|  +--------------------------------------------------------------------+ |
+------------------------------------+------------------------------------+
                                     |
                                     | Localhost RPC (Secret Token: 127.0.0.1)
                                     v
+-------------------------------------------------------------------------+
|                           aria2c Daemon                                 |
|            (Bound strictly to 127.0.0.1:6810, Unprivileged)             |
+-------------------------------------------------------------------------+
```

---

## 4. Hardware Compatibility & Research

### Target System: ASUS ZenBook 13 UX331UAL
* **CPU:** Intel(R) Core(TM) i7-8550U (4 Cores / 8 Threads, up to 4.0 GHz)
* **Kernel & OS:** Linux 7.0.0-31-generic (Ubuntu 24.04 noble LTS)
* **Sensors:**
  - **CPU Temperature:** Read directly from `/sys/class/hwmon/hwmon7` (`coretemp`). Reports package and per-core millidegrees C without root.
  - **Fan RPM:** Read directly from `/sys/class/hwmon/hwmon5/fan1_input` (`asus-isa-0000`). Reports real-time fan RPM (e.g. ~3200-5000 RPM) without root.
  - **NVMe Disk Temperature:** Read from `/sys/class/hwmon/hwmon3/temp1_input`.
  - **SMART Health:** `smartctl` requires elevated root ioctls. In accordance with the least-privilege principle, HomeDock avoids requesting root privileges and reports SMART as *"Unavailable (unprivileged access)"*.
* **Drive Detection:**
  - Internal NVMe: `nvme0n1` partitions `/` and `/boot/efi`.
  - External USB Drives: Detected via `lsblk -J` (e.g. `sda` / `sda1` on `/DATA/HDD`). Dynamic addition and removal are tracked using kernel netlink sockets.

---

## 5. Dependencies & Selection Rationale

Every dependency in HomeDock was chosen after verifying compatibility, resource overhead, and security:

| Dependency | Purpose | Rationale & Justification |
|---|---|---|
| **FastAPI** | REST API & WebSocket Server | High-performance asynchronous framework with native OpenAPI documentation, automatic validation via Pydantic, and low memory footprint. |
| **Uvicorn** | ASGI Web Server | Lightning-fast asynchronous server built on `uvloop` and `httptools`. |
| **psutil** | System Resource Metrics | Well-maintained standard for cross-process memory and network statistics. Low CPU impact when polled periodically. |
| **bcrypt** | Password Hashing | Cryptographic industry standard for password hashing with adaptive work factors (12 rounds) and salting. |
| **PyJWT** | Session Token Management | Standard RFC 7519 JSON Web Token implementation with expiration and revocation support. |
| **httpx** | Async HTTP Client | Asynchronous client used for localhost JSON-RPC communication with aria2c. |
| **aria2c** | Download Engine | High-performance, mature multi-protocol download utility supporting HTTP, BitTorrent, and Magnet links with native rate limiting. Bound strictly to `127.0.0.1`. |
| **SQLite (WAL)** | Application Database | Zero-configuration, serverless relational database running in Write-Ahead Logging (WAL) mode for maximum concurrency and reliability. |
| **Canvas & Vanilla JS** | Web Frontend | Zero multi-megabyte npm dependencies. Pure ES modules with HTML5 Canvas charts delivering < 100ms load times and dark/light theme support. |

---

## 6. Installation & Quick Start

### 6.1 Prerequisites
* Linux OS (Ubuntu 22.04 / 24.04, Debian 12, Arch, or Fedora)
* Python 3.10+
* System utilities: `lsblk`, `p7zip-full` (for 7z extraction)

### 6.2 Setup
Clone or navigate to the HomeDock directory:
```bash
cd /home/asus/homedock
```

Install Python dependencies:
```bash
python3 -m pip install -r requirements.txt
```

### 6.3 Start HomeDock
Run the startup script:
```bash
./run.sh
```

By default, HomeDock starts on `http://0.0.0.0:8090`.

### 6.4 Default Credentials
Upon first initialization, HomeDock creates an initial administrator account and saves the credentials to `data/initial_admin_credentials.txt`:
* **Default Username:** `admin`
* **Default Password:** `homedock2026!` *(or set via `HOMEDOCK_ADMIN_PASSWORD`)*

> [!IMPORTANT]
> Log into the dashboard and immediately navigate to **Settings** to update the administrator password.

---

## 7. Configuration

HomeDock is configured via environment variables or settings in the web interface:

| Environment Variable | Default | Description |
|---|---|---|
| `HOMEDOCK_HOST` | `0.0.0.0` | Host IP address to bind to. |
| `HOMEDOCK_PORT` | `8090` | Port to listen on. |
| `HOMEDOCK_DATA_DIR` | `/home/asus/homedock/data` | Directory storing SQLite DB, session files, and logs. |
| `HOMEDOCK_SECRET_KEY` | *(Auto-generated)* | 64-character secret key for signing JWT tokens. |
| `HOMEDOCK_ARIA2_BIN` | `/home/asus/homedock/bin/aria2c` | Path to aria2c executable wrapper. |
| `HOMEDOCK_ARIA2_PORT` | `6810` | Localhost port for internal aria2 RPC. |
| `HOMEDOCK_SESSION_EXPIRE_HOURS` | `24` | Hours before an active session expires. |
| `HOMEDOCK_RATE_LIMIT_MAX` | `5` | Maximum failed login attempts before lockout. |
| `HOMEDOCK_RATE_LIMIT_LOCKOUT` | `900` | Lockout duration in seconds (15 minutes). |

---

## 8. Systemd Service Setup

HomeDock can run automatically on boot as either a **User Service** (recommended, non-root) or a **System Service**.

### Option A: User Service (Recommended, No Root Required)
1. Ensure systemd user lingering is enabled (so the service runs even when not logged into an active GUI session):
   ```bash
   loginctl enable-linger $USER
   ```

2. Create the user service directory and link/copy the unit file:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp /home/asus/homedock/deploy/homedock.service ~/.config/systemd/user/
   ```

3. Reload, enable, and start:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now homedock.service
   ```

4. Check service status:
   ```bash
   systemctl --user status homedock.service
   ```

### Option B: System-Wide Service (Requires Sudo)
1. Copy the system service file:
   ```bash
   sudo cp /home/asus/homedock/systemd/homedock.service /etc/systemd/system/
   ```

2. Reload systemd daemon:
   ```bash
   sudo systemctl daemon-reload
   ```

3. Enable and start the service:
   ```bash
   sudo systemctl enable --now homedock.service
   ```

4. Check service status:
   ```bash
   sudo systemctl status homedock.service
   ```

---

## 9. Reverse Proxy & Production Deployment

When exposing HomeDock to the internet, always place it behind a reverse proxy terminating HTTPS.

### Example Nginx Configuration (`/etc/nginx/sites-available/homedock`)
```nginx
server {
    listen 80;
    server_name homedock.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name homedock.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/homedock.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/homedock.yourdomain.com/privkey.pem;

    # Client upload size limit (match maximum expected file upload)
    client_max_body_size 50G;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### Example Caddy Configuration (`Caddyfile`)
```caddy
homedock.yourdomain.com {
    reverse_proxy 127.0.0.1:8090
    request_body {
        max_size 50GB
    }
}
```

---

## 10. Verification & Test Suite

HomeDock includes an automated pytest suite covering authentication, security bounds, file operations, storage, and download manager:

```bash
cd /home/asus/homedock
python3 -m pytest tests/ -v
```

### Test Coverage (29 automated test cases):
* `tests/test_auth.py`: Login, invalid credentials, IP brute-force lockout, session expiration, token revocation upon logout.
* `tests/test_files.py`: File upload, chunked download, rename, copy, move, delete, `../../` path traversal blocking, symlink breakout prevention, and safe archive extraction.
* `tests/test_storage.py`: Dynamic block device discovery, mounted filesystem statistics, and hot-plug event registration.
* `tests/test_system.py`: CPU, RAM, network rates, fan RPM reading, and missing sensor fallbacks.
* `tests/test_downloads.py`: Add URIs, allowed root boundary enforcement, default download directory endpoints (`GET`/`PUT`), dynamic `save_as_default` directory updates, pause/resume, speed limits, and file deletion.

---

## 11. Security Recommendations

1. **Never run HomeDock as `root`:** Run under a dedicated system user (e.g. `asus`).
2. **Restrict Allowed Roots:** Keep configured allowed filesystem roots limited strictly to user storage locations (e.g. `/DATA/HDD`, `/home/asus/storage`). Never add `/` or `/etc`.
3. **Always use HTTPS:** Deploy behind Nginx, Caddy, or Cloudflare Tunnels with TLS.
4. **Change Default Credentials:** Change the default `admin` password immediately after initial deployment.

---

## 12. Troubleshooting

* **Address already in use (Port 8090):** Set a different port via `export HOMEDOCK_PORT=8095` before running `./run.sh`.
* **Fan Speed reports "Fan speed unavailable":** Normal behavior on systems without an ASUS WMI fan sensor or running inside a virtual machine.
* **SMART Status shows "Unavailable":** Preserves security by not requesting root privileges or raw disk ioctl access.
* **USB Drive not detected automatically:** Click **"Rescan Drives"** in the Storage section or verify the filesystem is mounted via `df -h`.

---

## 13. License

Open-source under the MIT License.
