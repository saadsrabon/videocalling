/** PM2 process file — run: pm2 start deploy/ecosystem.config.cjs */
module.exports = {
  apps: [
    {
      name: "videocalling",
      cwd: __dirname + "/..",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
