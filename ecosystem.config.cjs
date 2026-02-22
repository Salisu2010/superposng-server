module.exports = {
  apps: [
    {
      name: "superposng",
      cwd: "/opt/superposng-server",
      script: "src/index.js",
      env: {
        // Put your Firebase Admin SDK service account file here (server-side only).
        // Example:
        // GOOGLE_APPLICATION_CREDENTIALS: "/etc/stmn/secrets/firebase-adminsdk.json"
      }
    }
  ]
};
