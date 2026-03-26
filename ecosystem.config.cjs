module.exports = {
  apps: [
    {
      name: "superposng",
      cwd: "/opt/superposng-server",
      script: "src/index.js",
      env: {
        NODE_ENV: "production",
        PORT: "8080",
        DB_FILE: "/opt/superposng-server/db.json",
        JWT_SECRET: "change_me_to_long_random_secret",
        API_RATE_LIMIT_PER_MIN: "240",

        // Firebase Admin SDK service account JSON (server-side only)
        GOOGLE_APPLICATION_CREDENTIALS: "/opt/superposng-server/secrets/firebase-admin.json",

        // Optional: enable extra FCM logs in pm2 logs (set to 0 to silence)
        FCM_LOG: "1",

        // Smart Reminder Engine
        STMN_REMINDER_ENABLED: "1",
        STMN_REMINDER_INTERVAL_MS: "120000"
      }
    }
  ]
};
