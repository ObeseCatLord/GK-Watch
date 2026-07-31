const nodemailer = require('nodemailer');
const Settings = require('./models/settings');

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeHttpUrl(value) {
    try {
        const url = new URL(String(value));
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
    } catch (_) { return null; }
}

function itemHtml(item) {
    const image = safeHttpUrl(item.image);
    const link = safeHttpUrl(item.link);
    const title = escapeHtml(item.title);
    const imageHtml = image ? `<img src="${escapeHtml(image)}" alt="${title}" style="max-width: 150px; float: left; margin-right: 15px; border-radius: 4px;">` : '';
    const linkHtml = link ? `<a href="${escapeHtml(link)}" style="color: #646cff;">View Item →</a>` : '';
    return `<div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 8px;">${imageHtml}<h3 style="margin: 0 0 10px 0;">${title}</h3><p style="font-size: 1.2em; color: #646cff; font-weight: bold;">${escapeHtml(item.price)}</p><p style="color: #888;">${escapeHtml(item.source)}</p>${linkHtml}<div style="clear: both;"></div></div>`;
}

function digestItemHtml(item) {
    const link = safeHttpUrl(item.link);
    const image = safeHttpUrl(item.image);
    const title = escapeHtml(String(item.title ?? '').slice(0, 50));
    const priceHtml = item.isPriceUpdate
        ? `<p style="font-size: 10px; color: #888; margin: 0;">Favorite price update</p><p style="font-size: 11px; color: #777; margin: 2px 0 0 0;">Old: <span style="text-decoration: line-through;">${escapeHtml(item.oldPrice)}</span></p><p style="font-size: 12px; color: #d32f2f; font-weight: bold; margin: 0;">New: ${escapeHtml(item.newPrice)}</p>`
        : `<p style="font-size: 12px; color: #d32f2f; font-weight: bold; margin: 0;">${escapeHtml(item.price)}</p>`;
    const content = `${image ? `<img src="${escapeHtml(image)}" alt="" style="width: 100%; max-height: 80px; object-fit: contain; border-radius: 4px; margin-bottom: 5px;">` : ''}<p style="font-size: 11px; color: #333; margin: 0 0 5px 0; line-height: 1.2; max-height: 28px; overflow: hidden;">${title}${String(item.title ?? '').length > 50 ? '...' : ''}</p>${priceHtml}<p style="font-size: 10px; color: #888; margin: 2px 0 0 0;">${escapeHtml(item.source)}</p>`;
    return `<td style="width: 33%; padding: 8px; vertical-align: top;"><div style="border: 1px solid #eee; border-radius: 6px; background-color: #fafafa; padding: 8px; height: 100%;">${link ? `<a href="${escapeHtml(link)}" style="text-decoration: none; color: inherit;">${content}</a>` : content}</div></td>`;
}

const EmailService = {
    sendNewResultsEmail: async (term, newResults) => {
        const settings = Settings.get();

        if (!settings.emailEnabled || !settings.email) {
            console.log('[Email] Notifications disabled or no email configured');
            return false;
        }

        if (newResults.length === 0) {
            console.log('[Email] No new results to send');
            return false;
        }

        try {
            // Create transporter - use environment variables or settings
            let transporter;

            if (settings.smtpHost) {
                // Use configured SMTP
                const port = parseInt(settings.smtpPort, 10) || 587;
                const isSecure = port === 465; // Port 465 uses implicit TLS

                console.log(`[Email] Connecting to ${settings.smtpHost}:${port}, secure=${isSecure}`);

                transporter = nodemailer.createTransport({
                    host: settings.smtpHost,
                    port: port,
                    secure: isSecure, // true for 465, false for 587/other ports
                    disableFileAccess: true,
                    disableUrlAccess: true,
                    auth: {
                        user: settings.smtpUser,
                        pass: settings.smtpPass
                    },
                    // For servers that require STARTTLS on port 587
                    tls: {
                        rejectUnauthorized: true
                    }
                });
            } else {
                // Use ethereal for testing (creates a test account)
                console.log('[Email] No SMTP configured, using Ethereal test account');
                const testAccount = await nodemailer.createTestAccount();
                transporter = nodemailer.createTransport({
                    host: 'smtp.ethereal.email',
                    port: 587,
                    secure: false,
                    disableFileAccess: true,
                    disableUrlAccess: true,
                    auth: {
                        user: testAccount.user,
                        pass: testAccount.pass
                    }
                });
            }

            // Build HTML email
            const itemsHtml = newResults.map(itemHtml).join('');

            // Use smtpUser as sender if available, otherwise fallback
            const sender = settings.smtpUser ? `"GKWatch" <${settings.smtpUser}>` : '"GKWatch" <gkwatch@localhost>';

            const info = await transporter.sendMail({
                from: sender,
                to: settings.email,
                subject: `🆕 ${newResults.length} New Results for "${String(term).replace(/[\r\n]/g, ' ')}"`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h1 style="color: #646cff;">GKWatch Alert</h1>
                        <p>Found <strong>${newResults.length}</strong> new item(s) for "<strong>${escapeHtml(term)}</strong>":</p>
                        ${itemsHtml}
                        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
                        <p style="color: #888; font-size: 0.9em;">Sent by GKWatch Scheduler</p>
                    </div>
                `
            });

            console.log(`[Email] Sent notification to ${settings.email}:`, info.messageId);

            // If using Ethereal, log preview URL
            if (!settings.smtpHost) {
                console.log('[Email] Preview URL:', nodemailer.getTestMessageUrl(info));
            }

            return true;
        } catch (err) {
            console.error('[Email] Failed to send:', err);
            return false;
        }
    },
    sendDigestEmail: async (allNewResults) => {
        // allNewResults: { [term]: [item1, item2], [term2]: [item3] }
        const settings = Settings.get();

        if (!settings.emailEnabled || !settings.email) {
            console.log('[Email] Notifications disabled or no email configured');
            return false;
        }

        const terms = Object.keys(allNewResults);
        if (terms.length === 0) {
            console.log('[Email] No new results to send');
            return false;
        }

        try {
            // Re-use transporter creation logic 
            // (ideally refactor getTransporter but copying for safety/speed now)
            let transporter;
            if (settings.smtpHost) {
                const port = parseInt(settings.smtpPort, 10) || 587;
                const isSecure = port === 465;
                console.log(`[Email] Connecting to ${settings.smtpHost}:${port}, secure=${isSecure}`);
                transporter = nodemailer.createTransport({
                    host: settings.smtpHost,
                    port: port,
                    secure: isSecure,
                    disableFileAccess: true,
                    disableUrlAccess: true,
                    auth: { user: settings.smtpUser, pass: settings.smtpPass },
                    tls: { rejectUnauthorized: true }
                });
            } else {
                console.log('[Email] No SMTP configured, using Ethereal test account');
                const testAccount = await nodemailer.createTestAccount();
                transporter = nodemailer.createTransport({
                    host: 'smtp.ethereal.email',
                    port: 587,
                    secure: false,
                    disableFileAccess: true,
                    disableUrlAccess: true,
                    auth: { user: testAccount.user, pass: testAccount.pass }
                });
            }

            // Build HTML Digest
            let emailBody = '';
            let totalCount = 0;

            for (const [term, items] of Object.entries(allNewResults)) {
                totalCount += items.length;
                emailBody += `<h2 style="color: #4CAF50; border-bottom: 2px solid #ddd; padding-bottom: 5px; margin-top: 30px;">${escapeHtml(term)} (${items.length})</h2>`;

                // Build 3-column grid using table for email compatibility
                emailBody += '<table style="width: 100%; border-collapse: collapse;">';

                for (let i = 0; i < items.length; i += 3) {
                    emailBody += '<tr>';
                    for (let j = 0; j < 3; j++) {
                        const item = items[i + j];
                        if (item) {
                            emailBody += digestItemHtml(item);
                        } else {
                            emailBody += '<td style="width: 33%;"></td>';
                        }
                    }
                    emailBody += '</tr>';
                }

                emailBody += '</table>';
            }

            // Use smtpUser as sender if available, otherwise fallback
            const sender = settings.smtpUser ? `"GKWatch" <${settings.smtpUser}>` : '"GKWatch" <gkwatch@localhost>';

            const info = await transporter.sendMail({
                from: sender,
                to: settings.email,
                subject: `🆕 GKWatch Digest: ${totalCount} New Items / Updates`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
                        <div style="background-color: #333; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
                            <h1 style="margin: 0;">GKWatch Digest</h1>
                            <p style="margin: 5px 0 0 0;">Found ${totalCount} new items or favorite price updates across ${terms.length} watches</p>
                        </div>
                        <div style="padding: 20px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 8px 8px;">
                            ${emailBody}
                            <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
                            <p style="color: #888; font-size: 0.9em; text-align: center;">Sent by GKWatch Scheduler</p>
                            <div style="text-align: center; margin-top: 10px;">
                                ${safeHttpUrl(settings.baseUrl) ? `<a href="${escapeHtml(safeHttpUrl(settings.baseUrl))}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Open Dashboard</a>` : ''}
                            </div>
                        </div>
                    </div>
                `
            });

            console.log(`[Email] Sent digest to ${settings.email}:`, info.messageId);

            if (!settings.smtpHost) {
                console.log('[Email] Preview URL:', nodemailer.getTestMessageUrl(info));
                return nodemailer.getTestMessageUrl(info);
            }

            return true;
        } catch (err) {
            console.error('[Email] Failed to send digest:', err);
            return false;
        }
    },
    sendTestEmail: async () => {
        const settings = Settings.get();

        if (!settings.email) {
            throw new Error('No email address configured');
        }

        try {
            let transporter;
            let previewUrl = null;

            if (settings.smtpHost) {
                const port = parseInt(settings.smtpPort, 10) || 587;
                const isSecure = port === 465;

                console.log(`[Email] Test: Connecting to ${settings.smtpHost}:${port}, secure=${isSecure}`);

                transporter = nodemailer.createTransport({
                    host: settings.smtpHost,
                    port: port,
                    secure: isSecure,
                    disableFileAccess: true,
                    disableUrlAccess: true,
                    auth: {
                        user: settings.smtpUser,
                        pass: settings.smtpPass
                    },
                    tls: {
                        rejectUnauthorized: true
                    }
                });
            } else {
                console.log('[Email] No SMTP configured, using Ethereal test account');
                const testAccount = await nodemailer.createTestAccount();
                transporter = nodemailer.createTransport({
                    host: 'smtp.ethereal.email',
                    port: 587,
                    secure: false,
                    disableFileAccess: true,
                    disableUrlAccess: true,
                    auth: {
                        user: testAccount.user,
                        pass: testAccount.pass
                    }
                });
            }

            // Use smtpUser as sender if available, otherwise fallback
            const sender = settings.smtpUser ? `"GKWatch" <${settings.smtpUser}>` : '"GKWatch" <gkwatch@localhost>';

            const info = await transporter.sendMail({
                from: sender,
                to: settings.email,
                subject: '✅ GKWatch Test Email',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h1 style="color: #646cff;">🎉 Test Email Successful!</h1>
                        <p>Great news! Your GKWatch email settings are configured correctly.</p>
                        <p>You will receive notifications when new items are found during scheduled searches.</p>
                        ${safeHttpUrl(settings.baseUrl) ? `<p>Dashboard Link: <a href="${escapeHtml(safeHttpUrl(settings.baseUrl))}">${escapeHtml(settings.baseUrl)}</a></p>` : ''}
                        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
                        <p style="color: #888; font-size: 0.9em;">Sent at: ${new Date().toLocaleString()}</p>
                    </div>
                `
            });

            if (!settings.smtpHost) {
                previewUrl = nodemailer.getTestMessageUrl(info);
                console.log('[Email] Test email preview URL:', previewUrl);
            }

            return { success: true, messageId: info.messageId, previewUrl };
        } catch (err) {
            console.error('[Email] Test email failed:', err);
            throw err;
        }
    }
};

module.exports = EmailService;
