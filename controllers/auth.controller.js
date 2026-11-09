/**
 * Sign-up, login and Google sign-in happen in the app with Firebase. This API only answers
 * "who am I?" for a token Firebase issued.
 */
function me(req, res) {
  res.json({ user: req.user });
}

module.exports = { me };
