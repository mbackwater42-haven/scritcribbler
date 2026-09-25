// PM2: ~/node_modules/.bin/pm2 start ecosystem.config.cjs && ~/node_modules/.bin/pm2 save
module.exports = {
  apps: [{
    name: "scrit-recorder",
    script: "src/index.mjs",
    cwd: __dirname,
    interpreter: process.execPath,
    kill_timeout: 10000,   // let SIGTERM flush open audio files
    max_memory_restart: "1G",
    time: true
  }]
};
