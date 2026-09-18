import express, { type Express } from "express";

/**
 * @shera-bot/control-plane — authentication, sessions, the five-account cap,
 * approvals, credits, and control-plane persistence (PostgreSQL).
 *
 * S01 ships the seam only: a factory that returns an empty Express app. No
 * routes, no listener, no middleware — application behavior starts with S05
 * (Google OAuth, five-account cap, sessions, admin flag).
 * Governing records: D23 (layout), PRD §17, PRD §15 (admin as API/CLI — D47).
 */
export function createControlPlaneApp(): Express {
  return express();
}
