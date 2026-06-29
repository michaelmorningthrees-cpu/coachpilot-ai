/**
 * Augments Express's Request with the raw body buffer captured by the
 * express.json `verify` hook, used for webhook signature verification.
 */

import 'express';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      /** Authenticated coach, populated by the requireCoach middleware. */
      coach?: import('./coach').Coach;
    }
  }
}

export {};
