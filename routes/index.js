const { Router } = require('express');

const authController = require('../controllers/auth.controller');
const uploadController = require('../controllers/upload.controller');
const fitness = require('../controllers/fitness.controller');
const classController = require('../controllers/class.controller');
const wellness = require('../controllers/wellness.controller');
const { health } = require('../controllers/health.controller');
const profile = require('../controllers/profile.controller');
const dietController = require('../controllers/diet.controller');
const adminController = require('../controllers/admin.controller');
const notify = require('../controllers/notification.controller');
const { requireAuth, requireDietitian, requireAdmin } = require('../middleware/require-auth');
const { adminLoginLimiter } = require('../middleware/rate-limit');

const router = Router();

router.get('/health', health);

// The console admin's own sign-in (email + password from the API's .env)
router.post('/staff/login', adminLoginLimiter, adminController.adminLogin);

// Who is signed in? (sign-up, login and Google sign-in are done in the app, with Firebase)
router.get('/auth/me', requireAuth, authController.me);

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
router.get('/workout-logs/history', fitness.logHistory);
router.delete('/workout-logs/:id', fitness.removeLog);

// Profile (the setup questions) and weight
router.get('/me/profile', profile.getProfile);
router.put('/me/profile', profile.saveProfile);
router.post('/me/onboarding/complete', profile.completeOnboarding);
router.post('/me/weight', profile.addWeight);

// Diet plan: read what the dietitian posted and tick what was done
router.get('/diet', dietController.getMyDiet);
router.put('/diet/items/:id/done', dietController.markDone);
router.delete('/diet/items/:id/done', dietController.markUndone);

// Who am I, for the web console's sign-in gate (works for any signed-in person)
router.get('/staff/me', adminController.staffMe);

// Push notifications: the admin and dietitians send from the console (a dietitian only to their own clients)
router.use('/staff/notifications', requireDietitian);
router.get('/staff/notifications', notify.sent);
router.get('/staff/notifications/reach', notify.reach);
router.post('/staff/notifications', notify.send);

// Push notifications on the phone: register this phone, read the inbox, mute
router.post('/me/push-token', notify.registerToken);
router.post('/me/push-token/remove', notify.removeToken);
router.put('/me/notification-settings', notify.setPreferences);
router.get('/notifications', notify.inbox);
router.post('/notifications/read', notify.markRead);

// Dietitian tools: clients, their details, and their plans (a dietitian sees only their own clients)
router.use('/dietitian', requireDietitian);
router.get('/dietitian/clients', dietController.listClients);
router.get('/dietitian/clients/:id', dietController.clientDetail);
router.get('/dietitian/clients/:id/plan', dietController.clientPlan);
router.post('/dietitian/clients/:id/plan', dietController.addItem);
router.post('/dietitian/clients/:id/plan/copy', dietController.copyDay);
router.delete('/dietitian/plan-items/:id', dietController.removeItem);

// Admin: the one admin manages dietitians, assignments and the gym's catalog
router.use('/admin', requireAdmin);
router.get('/admin/overview', adminController.overview);
router.get('/admin/dietitians', adminController.listDietitians);
router.post('/admin/dietitians', adminController.inviteDietitian);
router.patch('/admin/dietitians/:id', adminController.updateDietitian);
router.delete('/admin/dietitians/:id', adminController.removeDietitian);
router.delete('/admin/dietitian-invites/:email', adminController.removeInvite);
router.get('/admin/members', adminController.listMembers);
router.put('/admin/members/:id/assignment', adminController.setAssignment);
router.get('/admin/workouts', adminController.listWorkouts);
router.post('/admin/workouts', adminController.createWorkout);
router.put('/admin/workouts/:id', adminController.updateWorkout);
router.delete('/admin/workouts/:id', adminController.deactivateWorkout);
router.post('/admin/categories', adminController.createCategory);
router.get('/admin/plan', adminController.weeklyPlan);
router.put('/admin/plan/:weekday', adminController.setPlanDay);
router.get('/admin/classes', adminController.listClasses);
router.post('/admin/classes', adminController.createClass);
router.put('/admin/classes/:id', adminController.updateClass);
router.delete('/admin/classes/:id', adminController.deactivateClass);

// Settings (goals), water intake, meals with photos, and account deletion
router.get('/me/settings', wellness.getSettings);
router.put('/me/settings', wellness.updateSettings);
router.delete('/me', wellness.deleteAccountData);
router.post('/water', wellness.addWater);
router.get('/water', wellness.listWater);
router.delete('/water/:id', wellness.removeWater);
router.post('/meals', wellness.createMeal);
router.get('/meals', wellness.listMeals);
router.delete('/meals/:id', wellness.removeMeal);

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
