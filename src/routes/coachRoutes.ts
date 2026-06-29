/**
 * Coach self-service portal (Firebase Auth email/password).
 *
 *   GET  /coach/login              login form
 *   POST /coach/login              authenticate (Firebase) → session cookie
 *   POST /coach/logout             clear session
 *   GET  /coach/change-password    forced/optional password change
 *   POST /coach/change-password    set new password
 *   GET  /coach                    own dashboard (only their own data)
 *   POST /coach/profile            update own profile / hours / FAQ / pricing
 *   POST /coach/whatsapp           manual WhatsApp config (own)
 *   POST /coach/whatsapp/embedded  Embedded Signup result (own, JSON)
 *   GET  /coach/google/start       begin Google Calendar OAuth (own coachId)
 *
 * Authorization: every authenticated route derives the coachId from the
 * session (req.coach), never from the URL — a coach can only touch their own
 * record.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../services/logger';
import {
  requireCoach,
  setCoachCookie,
  clearCoachCookie,
} from '../config/coachAuth';
import {
  signInWithEmailPassword,
  createCoachSessionCookie,
  updateCoachPassword,
} from '../services/coachAuthService';
import { getCoachByAuthUid } from '../services/coachResolverService';
import { CoachFaq, CoachPricing } from '../types/coach';
import {
  updateCoachProfile,
  saveCoachWhatsApp,
  saveWhatsAppSetupStatus,
  clearMustChangePassword,
  isCoachReady,
} from '../services/coachAdminService';
import { runWhatsAppSetup } from '../services/metaWhatsAppSetupService';
import { parseWorkingHours } from '../services/coachConfigService';
import {
  getEmbeddedSignupConfig,
  exchangeEmbeddedSignupCode,
} from '../services/whatsappOnboardingService';
import { generateAuthUrl } from '../config/googleOAuth';

const router = Router();
const MIN_PASSWORD_LENGTH = 8;

// --- Auth ------------------------------------------------------------------

router.get('/coach/login', (req: Request, res: Response) => {
  const errorMap: Record<string, string> = {
    '1': 'Invalid email or password.',
    nolink: 'This account is not linked to a coach. Contact your admin.',
  };
  res.render('coachLogin', {
    title: 'Coach Login',
    error: errorMap[String(req.query.error ?? '')] ?? null,
  });
});

router.post('/coach/login', async (req: Request, res: Response) => {
  const email = String(req.body.email ?? '').trim();
  const password = String(req.body.password ?? '');
  if (!email || !password) {
    res.redirect('/coach/login?error=1');
    return;
  }

  try {
    const { uid, idToken } = await signInWithEmailPassword(email, password);

    // Must be linked to a coach to use the portal.
    const coach = await getCoachByAuthUid(uid);
    if (!coach) {
      res.redirect('/coach/login?error=nolink');
      return;
    }

    const sessionCookie = await createCoachSessionCookie(idToken);
    setCoachCookie(res, sessionCookie);
    logger.info(`[COACH AUTH] Login ok coach=${coach.coachId}.`);

    res.redirect(coach.mustChangePassword ? '/coach/change-password' : '/coach');
  } catch (error) {
    logger.warn('[COACH AUTH] Login attempt failed.');
    if (error instanceof Error && error.message.includes('FIREBASE_API_KEY')) {
      res.status(500).send('Coach login is not configured (FIREBASE_API_KEY missing).');
      return;
    }
    res.redirect('/coach/login?error=1');
  }
});

router.post('/coach/logout', (_req: Request, res: Response) => {
  clearCoachCookie(res);
  res.redirect('/coach/login');
});

// --- Forced / optional password change -------------------------------------

router.get('/coach/change-password', requireCoach, (req: Request, res: Response) => {
  res.render('coachChangePassword', {
    title: 'Change Password',
    coach: req.coach,
    forced: Boolean(req.coach?.mustChangePassword),
    error: null,
  });
});

router.post('/coach/change-password', requireCoach, async (req: Request, res: Response) => {
  const coach = req.coach!;
  const password = String(req.body.password ?? '');
  const confirm = String(req.body.confirm ?? '');

  const render = (error: string): void => {
    res.status(400).render('coachChangePassword', {
      title: 'Change Password',
      coach,
      forced: Boolean(coach.mustChangePassword),
      error,
    });
  };

  if (password.length < MIN_PASSWORD_LENGTH) {
    render(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    return;
  }
  if (password !== confirm) {
    render('Passwords do not match.');
    return;
  }
  if (!coach.authUid) {
    render('This coach has no linked login account.');
    return;
  }

  try {
    await updateCoachPassword(coach.authUid, password);
    await clearMustChangePassword(coach.coachId);

    // Changing the password revokes the current session cookie, so mint a fresh
    // one with the new password to keep the coach logged in seamlessly.
    const { idToken } = await signInWithEmailPassword(coach.email, password);
    const sessionCookie = await createCoachSessionCookie(idToken);
    setCoachCookie(res, sessionCookie);

    logger.info(`[COACH AUTH] Password changed coach=${coach.coachId}.`);
    res.redirect('/coach?changed=1');
  } catch (error) {
    logger.error('[COACH AUTH] Password change failed.', error);
    render('Could not update password. Please try again.');
  }
});

// --- Dashboard -------------------------------------------------------------

router.get('/coach', requireCoach, (req: Request, res: Response) => {
  const coach = req.coach!;
  res.render('coachSelf', {
    title: coach.name,
    coach,
    ready: isCoachReady(coach),
    workingHoursJson: JSON.stringify(coach.workingHours ?? {}, null, 2),
    embedded: getEmbeddedSignupConfig(),
    supportEmail: process.env.SUPPORT_EMAIL?.trim() || 'support@coachpilot.ai',
    saved: req.query.saved === '1',
    changed: req.query.changed === '1',
  });
});

router.post('/coach/profile', requireCoach, async (req: Request, res: Response) => {
  const coach = req.coach!;
  try {
    const workingHoursRaw = String(req.body.workingHoursJson ?? '').trim();

    // Firestore rejects `undefined`, so only include populated FAQ/pricing keys.
    const faq: CoachFaq = {};
    const faqVenue = String(req.body.faqVenue ?? '').trim();
    const faqDuration = String(req.body.faqDuration ?? '').trim();
    if (faqVenue) faq.venue = faqVenue;
    if (faqDuration) faq.duration = faqDuration;

    const pricing: CoachPricing = {};
    const pricingText = String(req.body.pricingText ?? '').trim();
    if (pricingText) pricing.text = pricingText;

    await updateCoachProfile(coach.coachId, {
      name: String(req.body.name ?? '').trim(),
      sport: String(req.body.sport ?? '').trim(),
      timezone: String(req.body.timezone ?? '').trim(),
      language: req.body.language === 'zh' ? 'zh' : 'en',
      calendarId: String(req.body.calendarId ?? '').trim(),
      workingHours: parseWorkingHours(workingHoursRaw),
      faq,
      pricing,
    });
    res.redirect('/coach?saved=1');
  } catch (error) {
    logger.error('[COACH] Failed to update own profile.', error);
    res.status(500).send('Failed to save profile.');
  }
});

// --- WhatsApp (own) --------------------------------------------------------

router.post('/coach/whatsapp', requireCoach, async (req: Request, res: Response) => {
  const coach = req.coach!;
  const phoneNumberId = String(req.body.phoneNumberId ?? '').trim();
  const accessToken = String(req.body.accessToken ?? '').trim();
  if (!phoneNumberId || !accessToken) {
    res.status(400).send('phoneNumberId and accessToken are required.');
    return;
  }
  try {
    await saveCoachWhatsApp(coach.coachId, {
      phoneNumberId,
      accessToken,
      displayPhoneNumber: String(req.body.displayPhoneNumber ?? '').trim() || undefined,
    });
    res.redirect('/coach?saved=1');
  } catch (error) {
    logger.error('[COACH] Failed to save WhatsApp config.', error);
    res.status(500).send('Failed to save WhatsApp config.');
  }
});

router.post(
  '/coach/whatsapp/embedded/callback',
  requireCoach,
  async (req: Request, res: Response) => {
    const coach = req.coach!;
    logger.info(`[WHATSAPP EMBEDDED START] coach=${coach.coachId}`);

    const code = String(req.body.code ?? '').trim();
    const phoneNumberId = String(req.body.phoneNumberId ?? '').trim();
    const wabaId = String(req.body.wabaId ?? '').trim();

    if (!code || !phoneNumberId) {
      res.status(400).json({ ok: false, error: 'Missing code or phoneNumberId.' });
      return;
    }
    // Never log the code itself — only that one was received.
    logger.info(
      `[WHATSAPP EMBEDDED CODE RECEIVED] coach=${coach.coachId} phoneNumberId=${phoneNumberId} wabaId=${wabaId || 'n/a'}`,
    );

    try {
      const accessToken = await exchangeEmbeddedSignupCode(code);
      logger.info(`[WHATSAPP EMBEDDED TOKEN EXCHANGED] coach=${coach.coachId}`);

      await saveCoachWhatsApp(coach.coachId, {
        phoneNumberId,
        accessToken,
        wabaId: wabaId || undefined,
      });
      logger.info(`[WHATSAPP EMBEDDED CONNECTED] coach=${coach.coachId}`);

      // Best-effort post-signup automation (token / webhook / phone). Never
      // blocks the response — warnings are surfaced on the dashboard.
      const status = await runWhatsAppSetup({
        accessToken,
        phoneNumberId,
        wabaId: wabaId || undefined,
        registrationPin: coach.whatsapp?.registrationPin,
      });
      await saveWhatsAppSetupStatus(coach.coachId, status);

      res.json({ ok: true });
    } catch (error) {
      logger.error('[COACH] Embedded Signup failed.', error);
      res.status(502).json({ ok: false, error: 'Embedded Signup exchange failed.' });
    }
  },
);

// --- Retry WhatsApp setup (own) --------------------------------------------

router.post('/coach/whatsapp/retry-setup', requireCoach, async (req: Request, res: Response) => {
  const coach = req.coach!;
  const wa = coach.whatsapp;
  if (!wa?.accessToken || !wa?.phoneNumberId) {
    res.status(400).send('WhatsApp is not connected yet — nothing to set up.');
    return;
  }
  try {
    const status = await runWhatsAppSetup({
      accessToken: wa.accessToken,
      phoneNumberId: wa.phoneNumberId,
      wabaId: wa.wabaId,
      registrationPin: wa.registrationPin,
    });
    await saveWhatsAppSetupStatus(coach.coachId, status);
    res.redirect('/coach?saved=1');
  } catch (error) {
    logger.error('[COACH] Retry WhatsApp setup failed.', error);
    res.status(500).send('Failed to retry WhatsApp setup.');
  }
});

// --- Google Calendar OAuth (own coachId from session) ----------------------

router.get('/coach/google/start', requireCoach, (req: Request, res: Response) => {
  const coach = req.coach!;
  try {
    res.redirect(generateAuthUrl(coach.coachId));
  } catch (error) {
    logger.error('[COACH] Failed to start Google OAuth.', error);
    res.status(500).send('Google OAuth is not configured.');
  }
});

export default router;
