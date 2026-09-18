#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_USER="${SUDO_USER:-$USER}"

if [ "$1" == "--system" ] || [ "$EUID" -eq 0 ]; then
    echo "Installing HomeDock system-wide service for user '$TARGET_USER' at '$REPO_DIR'..."
    cat <<EOF | sudo tee /etc/systemd/system/homedock.service > /dev/null
[Unit]
Description=HomeDock — Modern Web-Based Server Manager
After=network.target local-fs.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_USER
WorkingDirectory=$REPO_DIR
ExecStart=$REPO_DIR/run.sh
Restart=always
RestartSec=5

# Environment configuration
Environment=HOMEDOCK_HOST=0.0.0.0
Environment=HOMEDOCK_PORT=8090
Environment=PYTHONUNBUFFERED=1

# Security Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
PrivateTmp=true
RestrictRealtime=true

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    echo "System service installed to /etc/systemd/system/homedock.service"
    echo "To enable and start:"
    echo "  sudo systemctl enable --now homedock.service"
else
    echo "Installing HomeDock user service for '$USER' at '$REPO_DIR'..."
    mkdir -p ~/.config/systemd/user
    cat <<EOF > ~/.config/systemd/user/homedock.service
[Unit]
Description=HomeDock — Lightweight Web-Based Server Manager
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$REPO_DIR/run.sh
Restart=always
RestartSec=3
KillMode=process
TimeoutStopSec=10
NoNewPrivileges=true
LimitNOFILE=65535

# Environment
Environment=HOMEDOCK_HOST=0.0.0.0
Environment=HOMEDOCK_PORT=8090
Environment=PYTHONPATH=$REPO_DIR
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    echo "User service installed to ~/.config/systemd/user/homedock.service"
    echo "To enable and start:"
    echo "  loginctl enable-linger \$USER"
    echo "  systemctl --user enable --now homedock.service"
fi
