#!/bin/bash
set -e

echo "Stopping old PM2..."
pm2 delete superpos || true

echo "Cleaning old server..."
rm -rf /opt/superposng-server

echo "Recreating directory..."
mkdir -p /opt/superposng-server

echo "Installing fresh files..."
cp -r ./* /opt/superposng-server/

cd /opt/superposng-server

echo "Installing dependencies..."
npm install

echo "Starting PM2..."
pm2 start src/index.js --name superpos

echo "Saving PM2..."
pm2 save

echo "Done."
