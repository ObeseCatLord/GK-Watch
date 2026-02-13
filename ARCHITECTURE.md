# GK Watcher Architecture & Security Report

## System Overview

GK Watcher is a web application designed to monitor Japanese marketplaces (Yahoo! Auctions, Mercari, Suruga-ya, etc.) for new items matching specific search terms.

### Components

1.  **Backend (`server/`)**:
    -   **Runtime**: Node.js
    -   **Framework**: Express.js
    -   **Database**: SQLite (`better-sqlite3`) with WAL mode enabled.
    -   **Scraping**: Puppeteer (Headless Chrome) and Axios (Direct API).
    -   **Scheduling**: `node-cron` for periodic tasks.
    -   **Notification**: Nodemailer (Email) and Ntfy.

2.  **Frontend (`client/`)**:
    -   **Framework**: React (Vite).
    -   **State Management**: React Context / Hooks.
    -   **Communication**: REST API.

## Security Improvements Implemented

The following security enhancements have been applied to the codebase:

### 1. Persistent Session Management
-   **Change**: Replaced the in-memory `activeSessions` Map with a persistent SQLite table `sessions`.
-   **Benefit**: Sessions now survive server restarts. This improves user experience and security auditing capabilities.
-   **Mechanism**:
    -   `x-auth-token` header is checked against the database.
    -   Sessions have an expiration time (24 hours).
    -   Expired sessions are automatically cleaned up periodically.

### 2. Global Rate Limiting
-   **Change**: Implemented a global rate limiter for all `/api/` endpoints.
-   **Limit**: 100 requests per 15 minutes per IP.
-   **Benefit**: Mitigates Denial-of-Service (DoS) attacks and abusive scraping of the API itself.
-   **Note**: The login endpoint retains its stricter specific limit (10 attempts/15 mins).

### 3. Content Security Policy (CSP)
-   **Change**: Enabled and configured `helmet`'s Content Security Policy.
-   **Policy**:
    -   `default-src 'self'`: Only allow resources from the same origin by default.
    -   `script-src 'self' 'unsafe-inline' 'unsafe-eval'`: Allows Vite/React execution (unsafe-eval is often needed for dev/HMR).
    -   `img-src 'self' data: https:`: Allows loading images from external sites (essential for scraper results).
-   **Benefit**: Mitigates Cross-Site Scripting (XSS) attacks by restricting where scripts can load and execute from.

## Optimization Improvements

### 1. Configurable Concurrency
-   **Change**: Made the scraping concurrency limit configurable via `Settings`.
-   **Default**: 3 concurrent tasks.
-   **Benefit**: Users can adjust the load based on their server's capabilities (CPU/RAM) and network bandwidth.

## Future Architectural Recommendations

To further improve the stability, scalability, and security of the application, the following changes are recommended:

### 1. Robust Job Queue System
-   **Current**: `Promise.all` batches in a cron loop. Failures can disrupt the batch.
-   **Recommendation**: Migrate to a dedicated job queue system like **BullMQ** (requires Redis) or a SQLite-backed queue.
-   **Benefit**: Better error handling, retries, priority management, and observability of scraping tasks.

### 2. Dependency Management & Build Process
-   **Current**: `npm install` in `server/` fails due to Puppeteer binary download issues in some environments.
-   **Recommendation**:
    -   Use a custom Docker image with Chromium pre-installed.
    -   Set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` and `PUPPETEER_EXECUTABLE_PATH` to the system chromium.
    -   Use a lockfile (`package-lock.json`) strictly.

### 3. Frontend/Backend Separation
-   **Current**: The server likely serves the frontend static files in production (implied).
-   **Recommendation**: Serve the frontend via a dedicated web server (Nginx) which reverse-proxies API requests to the Node.js backend.
-   **Benefit**: Better performance for static assets, easier SSL termination, and additional security layer (WAF).

### 4. Secret Management
-   **Current**: Secrets (SMTP password, login password) are encrypted in SQLite using a static key (`master.key`).
-   **Recommendation**: Use environment variables for all sensitive configuration in production. Consider a secret management service (Vault) if scaling up.

### 5. Automated Testing
-   **Current**: Manual smoke tests and ad-hoc verification scripts.
-   **Recommendation**: Implement a proper test runner (Jest or Mocha) with:
    -   **Unit Tests**: For utility functions and parsers.
    -   **Integration Tests**: Using a temporary SQLite DB to test Models and API routes.
    -   **E2E Tests**: Using Playwright/Cypress to test the full flow including the frontend.
