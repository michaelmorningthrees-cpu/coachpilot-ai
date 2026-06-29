/**
 * Google OAuth routes for connecting a coach's own Google Calendar.
 *
 *   GET /oauth/google/start?coachId=xxx  → redirect to Google consent
 *   GET /oauth/google/callback           → exchange code, save tokens
 *
 * Security: coachId is validated before starting; tokens are never logged or
 * returned in responses.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../services/logger';
import {
  generateAuthUrl,
  exchangeCodeForTokens,
  saveCoachOAuthTokens,
} from '../config/googleOAuth';
import { getCoachByIdRaw } from '../services/coachResolverService';

const router = Router();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[
      ch
    ] ?? ch),
  );
}

function htmlPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title></head><body style="font-family:system-ui;max-width:480px;margin:64px auto;text-align:center">
<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></body></html>`;
}

router.get('/oauth/google/start', async (req: Request, res: Response) => {
  try {
    const coachId = (req.query.coachId as string | undefined)?.trim();
    if (!coachId) {
      res.status(400).send(htmlPage('Missing coachId', 'Provide ?coachId=...'));
      return;
    }

    const coach = await getCoachByIdRaw(coachId);
    if (!coach) {
      logger.warn(`[OAUTH START] Unknown coachId=${coachId}.`);
      res.status(404).send(htmlPage('Unknown coach', 'No coach found for that id.'));
      return;
    }

    const url = generateAuthUrl(coachId);
    logger.info(`[OAUTH START] Redirecting coach=${coachId} to Google consent.`);
    res.redirect(url);
  } catch (error) {
    logger.error('[OAUTH START] Failed to start OAuth flow.', error);
    res
      .status(500)
      .send(htmlPage('OAuth error', 'Could not start Google authorization.'));
  }
});

router.get('/oauth/google/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string | undefined;
    const coachId = (req.query.state as string | undefined)?.trim();
    const oauthError = req.query.error as string | undefined;

    if (oauthError) {
      logger.warn(`[OAUTH CALLBACK] Google returned error=${oauthError}.`);
      res
        .status(400)
        .send(htmlPage('Authorization cancelled', 'Google authorization was not completed.'));
      return;
    }

    if (!code || !coachId) {
      res
        .status(400)
        .send(htmlPage('Invalid callback', 'Missing authorization code or state.'));
      return;
    }

    const coach = await getCoachByIdRaw(coachId);
    if (!coach) {
      logger.warn(`[OAUTH CALLBACK] Unknown coachId=${coachId} in state.`);
      res.status(404).send(htmlPage('Unknown coach', 'No coach found for that id.'));
      return;
    }

    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.accessToken) {
      logger.error(`[OAUTH CALLBACK] No access token returned for coach=${coachId}.`);
      res
        .status(502)
        .send(htmlPage('OAuth error', 'Google did not return an access token.'));
      return;
    }

    const saved = await saveCoachOAuthTokens(coach, tokens);
    if (!saved) {
      res
        .status(500)
        .send(htmlPage('OAuth error', 'Could not save Google Calendar connection.'));
      return;
    }

    res
      .status(200)
      .send(
        htmlPage(
          'Connected',
          'Google Calendar connected successfully. You can close this page.',
        ),
      );
  } catch (error) {
    logger.error('[OAUTH CALLBACK] Token exchange failed.', error);
    res
      .status(500)
      .send(htmlPage('OAuth error', 'Could not complete Google authorization.'));
  }
});

export default router;
