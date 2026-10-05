# Reconciliation Backend

This folder contains the original Express backend and worker/core logic separated from the React/Vite frontend.

Run locally:
1. npm install
2. npm start

Health check:
GET /api/health

Important:
The backend intentionally remains a normal long-running Node/Express service so its in-memory run state, Worker Threads, SSE progress, temporary files, and 80 MB upload configuration continue to work as designed.
