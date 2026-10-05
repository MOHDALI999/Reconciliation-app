# Reconciliation

Split deployment structure:

- `frontend/` — React + Vite application. Deploy this folder to Vercel.
- `backend/` — Node.js + Express API with Worker Threads. Deploy this as a persistent Node service.

## Frontend environment variable

Set:

`VITE_API_BASE=https://YOUR-BACKEND-DOMAIN`

The existing frontend API layer already supports `VITE_API_BASE`; application/reconciliation logic was not changed.

## Backend environment

Set:

`PORT=8787`

Recommended:

`ALLOWED_ORIGINS=https://YOUR-FRONTEND-DOMAIN`

## Local

Backend:
`cd backend && npm install && npm start`

Frontend:
`cd frontend && npm install && npm run dev`

## Why the backend is kept as a normal Node service

This backend stores uploaded files and active reconciliation runs in process memory/temp storage, uses Worker Threads, and exposes Server-Sent Events. Those are stateful server behaviors. Moving the same implementation to a serverless function would change its runtime assumptions and can cause lost runs/files or large-upload failures.

For Vercel, deploy the frontend. Use a persistent Node host for the backend unless the backend is intentionally redesigned around durable object storage/state and direct uploads.
