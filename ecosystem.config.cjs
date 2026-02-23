module.exports = {
  apps: [
    {
      name: "superposng",
      cwd: "/opt/superposng-server",
      script: "src/index.js",
      env: {
        // Firebase Admin SDK service account JSON (server-side only)
        // Recommended path (matches the deploy steps below):
        GOOGLE_APPLICATION_CREDENTIALS: "/opt/superposng-server/secrets/firebase-admin.json",

        // Optional: enable extra FCM logs in pm2 logs (set to 0 to silence)
        FCM_LOG: "1",

        // Smart Reminder Engine
        STMN_REMINDER_ENABLED: "1",
        // Default: 120000 (2 mins)
        STMN_REMINDER_INTERVAL_MS: "120000"
      }
    }
  ]
};
