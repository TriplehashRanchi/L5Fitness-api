const { Router } = require('express');

const authController = require('../controllers/auth.controller');
const uploadController = require('../controllers/upload.controller');
const fitness = require('../controllers/fitness.controller');
const classController = require('../controllers/class.controller');
const { health } = require('../controllers/health.controller');
const { requireAuth } = require('../middleware/require-auth');
const { loginLimiter, registerLimiter } = require('../middleware/rate-limit');

const router = Router();

router.get('/health', health);

// Auth (Neon Auth)
router.post('/auth/register', registerLimiter, authController.register);
router.post('/auth/login', loginLimiter, authController.login);
router.get('/auth/me', requireAuth, authController.me);
router.post('/auth/logout', requireAuth, authController.logout);

// Everything below needs a logged-in member.
router.use(requireAuth);

// Home screen: plan, today's stats, weekly streak, programs and today's classes in one call
router.get('/home', fitness.home);

// Workout catalog
router.get('/workouts', fitness.listWorkouts);
router.get('/workouts/categories', fitness.listCategories);

// Tracking: the workouts a member has done, and their weekly goal
router.post('/workout-logs', fitness.createLog);
router.get('/workout-logs', fitness.listLogs);
router.delete('/workout-logs/:id', fitness.removeLog);
router.get('/me/goal', fitness.getGoal);
router.put('/me/goal', fitness.setGoal);

// Classes and bookings
router.get('/classes', classController.list);
router.post('/classes/:id/bookings', classController.book);
router.delete('/classes/:id/bookings/:date', classController.cancel);

// Uploads (Postgres row + object in storage)
router.post('/uploads', uploadController.create);
router.get('/uploads', uploadController.list);
router.post('/uploads/:id/complete', uploadController.complete);
router.delete('/uploads/:id', uploadController.remove);

module.exports = router;
