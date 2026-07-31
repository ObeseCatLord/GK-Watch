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
    }],

    deploy: {
        production: {
            // User and host to be configured by the user
            user: "USER",
            host: "HOST",
            ref: "origin/main",
            repo: "GIT_REPOSITORY",
            path: "/path/to/gkwatch",
            "pre-deploy-local": "",
            "post-deploy": "if command -v gcc-10 >/dev/null 2>&1; then export CC=gcc-10 CXX=g++-10; fi; cd server && npm ci && npm audit --omit=dev --audit-level=high && npm test -- --runInBand && cd ../client && npm ci && npm audit --omit=dev --audit-level=high && npm run lint && npm test -- --run && npm run build && cd .. && pm2 startOrReload ecosystem.config.js --env production && sleep 3 && curl --fail --silent http://127.0.0.1:3000/api/health",
            "pre-setup": ""
        }
    }
};
