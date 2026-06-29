/**
 * Coach onboarding dashboard (server-rendered EJS, pilot-grade).
 *
 *   GET  /admin/login                          login form
 *   POST /admin/login                          authenticate
 *   POST /admin/logout                         clear session
 *   GET  /admin                                coaches list
 *   GET  /admin/coaches/new                    create form
 *   POST /admin/coaches                        create coach
 *   GET  /admin/coaches/:id                    detail / edit
 *   POST /admin/coaches/:id                    update profile
 *   POST /admin/coaches/:id/status             set status
 *   POST /admin/coaches/:id/whatsapp           manual WhatsApp config
 *   POST /admin/coaches/:id/whatsapp/embedded  Embedded Signup result (JSON)
 *
 * All /admin pages except login require the admin cookie.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../services/logger';
import {
  requireAdmin,
  verifyAdminPassword,
  setAdminCookie,
  clearAdminCookie,
  isAdminConfigured,
} from '../config/adminAuth';
import {
  listCoaches,
  createCoach,
  updateCoachProfile,
  setCoachStatus,
  saveCoachWhatsApp,
  saveWhatsAppSetupStatus,
  linkCoachAuth,
  isCoachReady,
} from '../services/coachAdminService';
import { runWhatsAppSetup } from '../services/metaWhatsAppSetupService';
import {
  upsertCoachAuthUser,
  generateTempPassword,
} from '../services/coachAuthService';
import { getCoachByIdRaw } from '../services/coachResolverService';
import { parseWorkingHours } from '../services/coachConfigService';
import {
  getEmbeddedSignupConfig,
  exchangeEmbeddedSignupCode,
} from '../services/whatsappOnboardingService';
import { Coach, CoachStatus } from '../types/coach';

const router = Router();

// --- Auth ------------------------------------------------------------------

router.get('/admin/login', (req: Request, res: Response) => {
  res.render('login', {
    title: 'Admin Login',
    error: req.query.error === '1' ? 'Incorrect password.' : null,
    configured: isAdminConfigured(),
  });
});

router.post('/admin/login', (req: Request, res: Response) => {
  const password = String(req.body.password ?? '');
  if (verifyAdminPassword(password)) {
    setAdminCookie(res);
    res.redirect('/admin');
    return;
  }
  res.redirect('/admin/login?error=1');
});

router.post('/admin/logout', (_req: Request, res: Response) => {
  clearAdminCookie(res);
  res.redirect('/admin/login');
});

// --- Coaches list ----------------------------------------------------------

router.get('/admin', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const coaches = await listCoaches();
    res.render('coaches', {
      title: 'Coaches',
      coaches,
      isCoachReady,
    });
  } catch (error) {
    logger.error('[ADMIN] Failed to list coaches.', error);
    res.status(500).send('Failed to load coaches. Is Firestore configured?');
  }
});

// --- Debug: coaches JSON (no tokens) ---------------------------------------

router.get('/admin/debug/coaches', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const coaches = await listCoaches();
    res.json(
      coaches.map((c) => ({
        coachId: c.coachId,
        status: c.status,
        phoneNumberId: c.whatsapp?.phoneNumberId || null,
        calendarId: c.calendar?.calendarId || null,
        calendarMode:
          c.calendar?.serviceAccountMode === false ? 'oauth' : 'service_account',
        whatsappConnected: Boolean(
          c.whatsapp?.phoneNumberId && c.whatsapp?.accessToken,
        ),
      })),
    );
  } catch (error) {
    logger.error('[ADMIN] Failed to dump coaches.', error);
    res.status(500).json({ error: 'Failed to load coaches.' });
  }
});

// --- Create coach ----------------------------------------------------------

router.get('/admin/coaches/new', requireAdmin, (_req: Request, res: Response) => {
  res.render('coachNew', {
    title: 'New Coach',
    defaultWorkingHours: JSON.stringify(
      {
        mon: [{ start: '18:00', end: '22:00' }],
        tue: [{ start: '18:00', end: '22:00' }],
        wed: [{ start: '18:00', end: '22:00' }],
        thu: [{ start: '18:00', end: '22:00' }],
        fri: [{ start: '18:00', end: '22:00' }],
        sat: [{ start: '10:00', end: '18:00' }],
        sun: [],
      },
      null,
      0,
    ),
    error: null,
  });
});

router.post('/admin/coaches', requireAdmin, async (req: Request, res: Response) => {
  const coachId = String(req.body.coachId ?? '').trim();
  const name = String(req.body.name ?? '').trim();

  if (!coachId || !name) {
    res.render('coachNew', {
      title: 'New Coach',
      defaultWorkingHours: String(req.body.workingHoursJson ?? ''),
      error: 'coachId and name are required.',
    });
    return;
  }

  try {
    await createCoach({
      coachId,
      name,
      email: String(req.body.email ?? '').trim(),
      sport: String(req.body.sport ?? '').trim() || 'Coaching',
      timezone: String(req.body.timezone ?? '').trim() || 'Asia/Hong_Kong',
      language: req.body.language === 'zh' ? 'zh' : 'en',
      calendarId: String(req.body.calendarId ?? '').trim(),
      workingHoursJson: String(req.body.workingHoursJson ?? ''),
    });
    res.redirect(`/admin/coaches/${encodeURIComponent(coachId)}`);
  } catch (error) {
    logger.error('[ADMIN] Failed to create coach.', error);
    res.render('coachNew', {
      title: 'New Coach',
      defaultWorkingHours: String(req.body.workingHoursJson ?? ''),
      error: error instanceof Error ? error.message : 'Failed to create coach.',
    });
  }
});

// --- Coach detail / edit ---------------------------------------------------

router.get('/admin/coaches/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const coach = await getCoachByIdRaw(req.params.id);
    if (!coach) {
      res.status(404).send('Coach not found.');
      return;
    }
    res.render('coachDetail', {
      title: coach.name,
      coach,
      ready: isCoachReady(coach),
      workingHoursJson: JSON.stringify(coach.workingHours ?? {}, null, 2),
      embedded: getEmbeddedSignupConfig(),
      saved: req.query.saved === '1',
      tempPassword: null,
    });
  } catch (error) {
    logger.error('[ADMIN] Failed to load coach.', error);
    res.status(500).send('Failed to load coach.');
  }
});

router.post('/admin/coaches/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const workingHoursRaw = String(req.body.workingHoursJson ?? '').trim();
    await updateCoachProfile(req.params.id, {
      name: String(req.body.name ?? '').trim(),
      email: String(req.body.email ?? '').trim(),
      sport: String(req.body.sport ?? '').trim(),
      timezone: String(req.body.timezone ?? '').trim(),
      language: req.body.language === 'zh' ? 'zh' : 'en',
      calendarId: String(req.body.calendarId ?? '').trim(),
      workingHours: parseWorkingHours(workingHoursRaw),
    });
    res.redirect(`/admin/coaches/${encodeURIComponent(req.params.id)}?saved=1`);
  } catch (error) {
    logger.error('[ADMIN] Failed to update coach.', error);
    res.status(500).send('Failed to update coach.');
  }
});

router.post('/admin/coaches/:id/status', requireAdmin, async (req: Request, res: Response) => {
  const status = String(req.body.status ?? '') as CoachStatus;
  const allowed: CoachStatus[] = ['active', 'inactive', 'setup_pending'];
  if (!allowed.includes(status)) {
    res.status(400).send('Invalid status.');
    return;
  }
  try {
    await setCoachStatus(req.params.id, status);
    res.redirect(`/admin/coaches/${encodeURIComponent(req.params.id)}?saved=1`);
  } catch (error) {
    logger.error('[ADMIN] Failed to set status.', error);
    res.status(500).send('Failed to set status.');
  }
});

// --- Coach login: create / reset temporary password -----------------------

router.post('/admin/coaches/:id/auth', requireAdmin, async (req: Request, res: Response) => {
  let coach: Coach | null;
  try {
    coach = await getCoachByIdRaw(req.params.id);
  } catch (error) {
    logger.error('[ADMIN] Failed to load coach for auth.', error);
    res.status(500).send('Failed to load coach.');
    return;
  }
  if (!coach) {
    res.status(404).send('Coach not found.');
    return;
  }

  const renderDetail = (extra: Record<string, unknown>): void => {
    res.render('coachDetail', {
      title: coach!.name,
      coach,
      ready: isCoachReady(coach!),
      workingHoursJson: JSON.stringify(coach!.workingHours ?? {}, null, 2),
      embedded: getEmbeddedSignupConfig(),
      saved: false,
      tempPassword: null,
      ...extra,
    });
  };

  if (!coach.email) {
    renderDetail({ authError: 'Coach has no email address — add one before creating a login.' });
    return;
  }

  try {
    const tempPassword = generateTempPassword();
    const uid = await upsertCoachAuthUser(coach.email, tempPassword);
    await linkCoachAuth(coach.coachId, uid, true);
    logger.info(`[ADMIN] Coach login issued coach=${coach.coachId}.`);
    // Reload so the rendered page reflects authUid/mustChangePassword.
    coach = (await getCoachByIdRaw(req.params.id)) ?? coach;
    renderDetail({ tempPassword });
  } catch (error) {
    logger.error('[ADMIN] Failed to issue coach login.', error);
    const message =
      error instanceof Error && error.message.includes('not configured')
        ? 'Firebase Auth is not configured (check Firebase env vars).'
        : 'Failed to create coach login.';
    renderDetail({ authError: message });
  }
});

// --- WhatsApp: manual ------------------------------------------------------

router.post('/admin/coaches/:id/whatsapp', requireAdmin, async (req: Request, res: Response) => {
  const phoneNumberId = String(req.body.phoneNumberId ?? '').trim();
  const accessToken = String(req.body.accessToken ?? '').trim();
  if (!phoneNumberId || !accessToken) {
    res.status(400).send('phoneNumberId and accessToken are required.');
    return;
  }
  try {
    await saveCoachWhatsApp(req.params.id, {
      phoneNumberId,
      accessToken,
      displayPhoneNumber: String(req.body.displayPhoneNumber ?? '').trim() || undefined,
    });
    res.redirect(`/admin/coaches/${encodeURIComponent(req.params.id)}?saved=1`);
  } catch (error) {
    logger.error('[ADMIN] Failed to save WhatsApp config.', error);
    res.status(500).send('Failed to save WhatsApp config.');
  }
});

// --- WhatsApp: retry post-signup setup -------------------------------------

router.post(
  '/admin/coaches/:id/whatsapp/retry-setup',
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const coach = await getCoachByIdRaw(req.params.id);
      if (!coach) {
        res.status(404).send('Coach not found.');
        return;
      }
      const wa = coach.whatsapp;
      if (!wa?.accessToken || !wa?.phoneNumberId) {
        res.status(400).send('WhatsApp is not connected yet — nothing to set up.');
        return;
      }
      const status = await runWhatsAppSetup({
        accessToken: wa.accessToken,
        phoneNumberId: wa.phoneNumberId,
        wabaId: wa.wabaId,
        registrationPin: wa.registrationPin,
      });
      await saveWhatsAppSetupStatus(coach.coachId, status);
      res.redirect(`/admin/coaches/${encodeURIComponent(req.params.id)}?saved=1`);
    } catch (error) {
      logger.error('[ADMIN] Retry WhatsApp setup failed.', error);
      res.status(500).send('Failed to retry WhatsApp setup.');
    }
  },
);

// --- WhatsApp: Embedded Signup (JSON from the browser SDK) ------------------

router.post(
  '/admin/coaches/:id/whatsapp/embedded',
  requireAdmin,
  async (req: Request, res: Response) => {
    const code = String(req.body.code ?? '').trim();
    // Accept both snake_case (Embedded Signup) and camelCase (manual) keys.
    const phoneNumberId = String(
      req.body.phone_number_id ?? req.body.phoneNumberId ?? '',
    ).trim();
    const wabaId = String(req.body.waba_id ?? req.body.wabaId ?? '').trim();

    if (!code) {
      res.status(400).json({ ok: false, error: 'Missing authorization code.' });
      return;
    }

    try {
      // Exchange the code first so an invalid code surfaces clearly.
      const accessToken = await exchangeEmbeddedSignupCode(code);

      if (!phoneNumberId) {
        res.status(422).json({
          ok: false,
          error:
            'WhatsApp authorized, but no phone number was detected. Please retry the connection.',
        });
        return;
      }

      await saveCoachWhatsApp(req.params.id, {
        phoneNumberId,
        accessToken,
        wabaId: wabaId || undefined,
      });
      res.json({ ok: true });
    } catch (error) {
      logger.error('[ADMIN] Embedded Signup failed.', error);
      res.status(502).json({ ok: false, error: 'Embedded Signup exchange failed.' });
    }
  },
);

export default router;
