#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS_DIR="$DIR/.run/test-keys"
KEY_FILE="$KEYS_DIR/test_rsa"

mkdir -p "$KEYS_DIR"

if [ ! -f "$KEY_FILE" ]; then
  echo "Generating test SSH pair at $KEY_FILE..."
  ssh-keygen -t rsa -b 4096 -f "$KEY_FILE" -N "" -q
  chmod 600 "$KEY_FILE"
  echo "SSH keys generated."
else
  echo "Test SSH keys already exist at $KEY_FILE."
fi
