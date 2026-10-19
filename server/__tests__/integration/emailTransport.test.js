const net = require('net');

const mockSettings = {
    emailEnabled: true,
    email: 'recipient@example.test',
    smtpHost: '127.0.0.1',
    smtpUser: 'sender@example.test',
    smtpPass: 'local-test-secret',
    baseUrl: 'https://example.test'
};
jest.mock('../../models/settings', () => ({ get: () => mockSettings }));

const EmailService = require('../../emailService');

// Exercise the real SMTP transport and MIME/address parsing without delivering
// mail outside this process or relying on an external SMTP provider.
describe('email delivery through the installed Nodemailer transport', () => {
    let server;
    let messages;
    const sockets = new Set();

    beforeAll(async () => {
        server = net.createServer(socket => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.on('error', () => {});
            socket.setEncoding('utf8');
            let buffer = '';
            let data = null;
            let envelope = {};
            socket.write('220 localhost SMTP test receiver\r\n');
            socket.on('data', chunk => {
                buffer += chunk;
                let end;
                while ((end = buffer.indexOf('\r\n')) !== -1) {
                    const line = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    if (data !== null) {
                        if (line === '.') {
                            messages.push({ ...envelope, message: data.join('\r\n') });
                            data = null;
                            socket.write('250 2.0.0 accepted\r\n');
                        } else data.push(line);
                    } else if (/^EHLO|^HELO/.test(line)) {
                        socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
                    } else if (/^AUTH PLAIN /.test(line)) {
                        socket.write('235 2.7.0 authenticated\r\n');
                    } else if (/^MAIL FROM:/.test(line)) {
                        envelope = { from: line.slice('MAIL FROM:'.length) };
                        socket.write('250 2.1.0 OK\r\n');
                    } else if (/^RCPT TO:/.test(line)) {
                        envelope.to = line.slice('RCPT TO:'.length);
                        socket.write('250 2.1.5 OK\r\n');
                    } else if (line === 'DATA') {
                        data = [];
                        socket.write('354 End data with <CRLF>.<CRLF>\r\n');
                    } else if (line === 'QUIT') {
                        socket.end('221 Bye\r\n');
                    } else socket.write('250 OK\r\n');
                }
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        mockSettings.smtpPort = server.address().port;
    });

    beforeEach(() => {
        messages = [];
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    afterAll(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });

    test.each(['new results', 'digest', 'test email'])('delivers %s to the configured recipient', async kind => {
        const item = { title: 'Example kit', link: 'https://example.test/item', price: '1000', source: 'Rakuma' };
        const result = kind === 'new results'
            ? await EmailService.sendNewResultsEmail('Example', [item])
            : kind === 'digest'
                ? await EmailService.sendDigestEmail({ Example: [item] })
                : await EmailService.sendTestEmail();

        expect(kind === 'test email' ? result.success : result).toBe(true);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ from: '<sender@example.test>', to: '<recipient@example.test>' });
        expect(messages[0].message).toContain('Content-Type: text/html');
        expect(messages[0].message).toContain('To: recipient@example.test');
    });
});
