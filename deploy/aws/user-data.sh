#!/bin/bash
# EC2 user data for Amazon Linux 2023. Installs Docker, Compose and git, then clones SchemaForge.
# Secrets are NOT set here: SSH in afterwards and create deploy/.env from deploy/.env.example.
set -euo pipefail
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
sudo -u ec2-user git clone https://github.com/harshaxyZ/schemaforge.git /home/ec2-user/schemaforge
