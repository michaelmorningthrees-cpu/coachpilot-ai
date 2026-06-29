/**
 * Webhook route definitions. Maps HTTP verbs to controller handlers.
 */

import { Router } from 'express';
import {
  handleVerification,
  handleIncomingEvent,
} from '../controllers/webhookController';

const router = Router();

router.get('/webhook', handleVerification);
router.post('/webhook', handleIncomingEvent);

export default router;
