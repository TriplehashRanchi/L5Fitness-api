# Acceptance and personal plans

Deploy the API database migration before starting the updated API, then deploy the console and app:

```sh
npm run migrate
npm run build
```

Migration `011_client_acceptance_training.sql` adds explicit acceptance. Existing assignments become pending; a dietitian must accept them in Clients before they can manage or deliver personalized plans. Existing diet items and workout logs are retained. Assigning a different dietitian resets acceptance; assigning the same one preserves it.

Members complete their fitness profile and enable sharing. Dietitians see identity-only pending requests for unassigned members and members assigned to them. Accepting a request atomically claims it, after which the member’s health profile, diet editor and daily exercise editor become available in the console and mobile staff view. Admins can assign members and manage accepted clients but cannot accept on behalf of a dietitian.

Diet is shown in the member’s Diet tab. The exercise plan for the phone’s current day, including exercises/sets/reps/rest notes, is shown on Home and stays available during a workout. Plans reload on screen focus or pull-to-refresh. Generic gym-wide weekday plans are no longer used as personal Home plans. The workout catalog remains available.

No-consent, awaiting-acceptance, accepted-with-no-plan and planned states are distinct. Revoking sharing or disabling a dietitian hides personalized plans. Previously completed workout logs stay available.

Integration tests use a disposable schema on an explicitly supplied test database; they never load `.env` or access Firebase/S3. All SQL migrations are applied to that schema, then the tests exercise the real controllers/models. The schema is removed afterward.

```sh
COACHING_TEST_DATABASE_URL='postgresql://localhost/l5_test' npm run test:coaching
```

Use a separate local/test database; do not point this command at production. Coverage: pre-acceptance guards, consent, admin role restrictions, simultaneous acceptance, ownership, diet/exercise delivery, validation, personal workout logging, reassignment, disabled dietitians and sharing withdrawal.
