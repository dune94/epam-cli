#!/bin/bash

# Update demo instance from main project

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEMO_DIR="/home/bjerome/projects/ai/epam-cli-demo"

echo "Updating demo instance..."

# Copy updated files
cp -r "$PROJECT_DIR/src" "$DEMO_DIR/"
cp -r "$PROJECT_DIR/dist" "$DEMO_DIR/" 2>/dev/null || true
cp "$PROJECT_DIR/package.json" "$DEMO_DIR/"
cp "$PROJECT_DIR/package-lock.json" "$DEMO_DIR/"

echo "Demo updated successfully!"
echo ""
echo "Next steps:"
echo "  cd $DEMO_DIR"
echo "  npm install"
echo "  npm run build"
