module.exports = {
    apps: [{
        name: "gkwatch-server",
        cwd: "./server",
        script: "server.js",
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: "1G",
        env: {
            NODE_ENV: "development",
        },
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
            "post-deploy": "cd server && npm install && cd ../client && npm install && npm run build && cd .. && pm2 reload ecosystem.config.js --env production && cd server && npm run test:smoke",
            "pre-setup": ""
        }
    }
};
