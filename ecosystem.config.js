module.exports = {
    apps: [{
        name: "gkwatch",
        script: "./server/server.js",
        interpreter: "node",
        cwd: __dirname,
        instances: 1,
        exec_mode: "fork",
        autorestart: true,
        watch: false,
        max_memory_restart: "1G",
        env: {
            NODE_ENV: "development",
            PORT: 3000,
        },
        env_production: {
            NODE_ENV: "production",
            PORT: 3000,
        }
    }, {
        name: "gkwatch-backup",
        script: "./server/utils/backup.js",
        interpreter: "node",
        cwd: __dirname,
        instances: 1,
        exec_mode: "fork",
        autorestart: false,
        cron_restart: "0 3 * * *",
        watch: false,
        env_production: {
            NODE_ENV: "production",
        }
    }]
};
