// Puppeteer 25 is ESM. Keep browser side effects explicit in the CommonJS Jest
// suites; test:browser exercises the real package with Node's native loader.
jest.mock('puppeteer', () => ({
    launch: jest.fn(() => {
        throw new Error('Browser-dependent tests must provide a Puppeteer launch fixture');
    })
}));
