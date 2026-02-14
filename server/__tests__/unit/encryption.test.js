/**
 * Unit Tests: encryption
 * 
 * Tests the AES-256-CBC encrypt/decrypt utility.
 * Uses the actual encryption module which will create/use a master key.
 */

const Encryption = require('../../utils/encryption');

describe('Encryption', () => {
    describe('encrypt', () => {
        test('returns null/empty for null/empty input', () => {
            expect(Encryption.encrypt(null)).toBeNull();
            expect(Encryption.encrypt('')).toBe('');
            expect(Encryption.encrypt(undefined)).toBeUndefined();
        });

        test('returns a string with IV separator', () => {
            const encrypted = Encryption.encrypt('hello world');
            expect(typeof encrypted).toBe('string');
            expect(encrypted).toContain(':');
        });

        test('produces different ciphertext for same input (random IV)', () => {
            const encrypted1 = Encryption.encrypt('same text');
            const encrypted2 = Encryption.encrypt('same text');
            expect(encrypted1).not.toBe(encrypted2);
        });
    });

    describe('decrypt', () => {
        test('returns null/empty for null/empty input', () => {
            expect(Encryption.decrypt(null)).toBeNull();
            expect(Encryption.decrypt('')).toBe('');
        });

        test('returns plaintext for non-encrypted string (no colon separator)', () => {
            // Migration support: strings without IV separator are returned as-is
            expect(Encryption.decrypt('plaintext')).toBe('plaintext');
        });

        test('decrypts back to original after encrypting', () => {
            const original = 'my secret password 🔐';
            const encrypted = Encryption.encrypt(original);
            const decrypted = Encryption.decrypt(encrypted);
            expect(decrypted).toBe(original);
        });

        test('round-trips unicode/Japanese text correctly', () => {
            const original = 'テスト SMTP パスワード 123';
            const encrypted = Encryption.encrypt(original);
            const decrypted = Encryption.decrypt(encrypted);
            expect(decrypted).toBe(original);
        });

        test('handles invalid encrypted data gracefully', () => {
            // Returns original text if decryption fails (e.g., wrong format)
            const result = Encryption.decrypt('invalid:data');
            expect(typeof result).toBe('string');
        });
    });

    describe('round-trip', () => {
        const testCases = [
            'simple password',
            'password with special chars !@#$%^&*()',
            '日本語テスト',
            'a'.repeat(1000), // long string
            '🔐🔑🗝️', // emoji
        ];

        test.each(testCases)('encrypts and decrypts: %s', (input) => {
            const encrypted = Encryption.encrypt(input);
            const decrypted = Encryption.decrypt(encrypted);
            expect(decrypted).toBe(input);
        });
    });
});
