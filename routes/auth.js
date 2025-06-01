// routes/auth.js
const express = require("express");
const router = express.Router();
const { authGmail, authCallback, authUser } = require("../controllers/auth");

router.get("/auth/gmail", authGmail);

router.get("/auth/gmail/callback", authCallback);

router.get("/auth/users", authUser);

module.exports = router;
