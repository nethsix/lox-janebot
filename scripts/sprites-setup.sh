#!/bin/bash
# sprites-setup.sh - Set up janebot on a Sprite
#
# Usage:
#   1. Create a sprite: sprite create janebot
#   2. Copy this repo: sprite exec -s janebot -- git clone <your-repo> /app
#   3. Run setup: sprite exec -s janebot -- bash /app/scripts/sprites-setup.sh
#   4. Set secrets: sprite exec -s janebot -- bash -c 'cat > /app/.env << EOF
#      SLACK_BOT_TOKEN=xoxb-...
#      SLACK_APP_TOKEN=xapp-...
#      AMP_ACCESS_TOKEN=...
#      EOF'
#   5. Start: sprite exec -s janebot -- systemctl --user start janebot
#   6. Checkpoint: sprite checkpoint -s janebot

set -e

cd /app

# Install Node.js if not present
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# Install pnpm
corepack enable
corepack prepare pnpm@latest --activate

# Install dependencies and build
pnpm install
pnpm build

# Create systemd user service for persistence
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/janebot.service << 'EOF'
[Unit]
Description=janebot Slack Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/app
ExecStart=/usr/bin/node /app/dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/app/.env

[Install]
WantedBy=default.target
EOF

# Enable lingering so user services run without login
loginctl enable-linger $(whoami) 2>/dev/null || true

# Reload and enable service
systemctl --user daemon-reload
systemctl --user enable janebot

echo "✅ janebot installed!"
echo ""
echo "Next steps:"
echo "  1. Create /app/.env with your secrets"
echo "  2. Start: systemctl --user start janebot"
echo "  3. Check logs: journalctl --user -u janebot -f"
echo "  4. Checkpoint: sprite checkpoint -s janebot"
