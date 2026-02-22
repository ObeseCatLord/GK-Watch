/**
 * Unit Tests: queryMatcher
 * 
 * Tests the query parsing and matching engine that powers
 * strict filtering across all scrapers.
 */

const {
    parseQuery,
    matchesQuery,
    matchTitle,
    getSearchTerms,
    getMissingTerms,
    hasQuotedTerms,
    GK_VARIANTS
} = require('../../utils/queryMatcher');

// ─── parseQuery ──────────────────────────────────────────────

describe('parseQuery', () => {
    test('returns empty AND for null/undefined/empty input', () => {
        expect(parseQuery(null)).toEqual({ type: 'AND', children: [] });
        expect(parseQuery(undefined)).toEqual({ type: 'AND', children: [] });
        expect(parseQuery('')).toEqual({ type: 'AND', children: [] });
        expect(parseQuery('   ')).toEqual({ type: 'AND', children: [] });
    });

    test('parses a single term', () => {
        const result = parseQuery('ガレージキット');
        expect(result).toEqual({ type: 'TERM', value: 'ガレージキット', quoted: false });
    });

    test('parses implicit AND (space-separated terms)', () => {
        const result = parseQuery('東方 ガレージキット');
        expect(result.type).toBe('AND');
        expect(result.children).toHaveLength(2);
        expect(result.children[0].value).toBe('東方');
        expect(result.children[1].value).toBe('ガレージキット');
    });

    test('parses explicit AND (&&)', () => {
        const result = parseQuery('東方 && ガレージキット');
        expect(result.type).toBe('AND');
        expect(result.children).toHaveLength(2);
    });

    test('parses OR (|) within a single group', () => {
        const result = parseQuery('セイバー|アルトリア');
        expect(result.type).toBe('OR');
        expect(result.children).toHaveLength(2);
        expect(result.children[0].value).toBe('セイバー');
        expect(result.children[1].value).toBe('アルトリア');
    });

    test('parses mixed AND + OR', () => {
        const result = parseQuery('ガレージキット セイバー|アルトリア');
        expect(result.type).toBe('AND');
        expect(result.children).toHaveLength(2);
        expect(result.children[0].type).toBe('TERM');
        expect(result.children[1].type).toBe('OR');
        expect(result.children[1].children).toHaveLength(2);
    });

    test('normalizes spaces around | operator', () => {
        const result = parseQuery('セイバー | アルトリア');
        expect(result.type).toBe('OR');
        expect(result.children[0].value).toBe('セイバー');
        expect(result.children[1].value).toBe('アルトリア');
    });

    test('parses quoted single-word term', () => {
        const result = parseQuery('"Saber"');
        expect(result.type).toBe('TERM');
        expect(result.value).toBe('Saber');
        expect(result.quoted).toBe(true);
    });

    test('quoted multi-word phrase is split by spaces (parser behavior)', () => {
        // The parser splits on spaces first, so "Exact Phrase" becomes two AND children
        // Each word retains partial quote marks but doesn't get quoted=true
        // because individual halves don't have matching start+end quotes
        const result = parseQuery('"Exact Phrase"');
        expect(result.type).toBe('AND');
        expect(result.children).toHaveLength(2);
    });
});

// ─── matchesQuery ────────────────────────────────────────────

describe('matchesQuery', () => {
    test('returns false for null/empty title', () => {
        const parsed = parseQuery('test');
        expect(matchesQuery(null, parsed)).toBe(false);
        expect(matchesQuery('', parsed)).toBe(false);
    });

    test('returns false for null query', () => {
        expect(matchesQuery('test title', null)).toBe(false);
    });

    test('matches single term (case-insensitive)', () => {
        const parsed = parseQuery('saber');
        expect(matchesQuery('Fate Saber Figure', parsed)).toBe(true);
        expect(matchesQuery('ULTIMATE SABER', parsed)).toBe(true);
        expect(matchesQuery('Archer Figure', parsed)).toBe(false);
    });

    test('matches AND - all terms required', () => {
        const parsed = parseQuery('東方 ガレージキット');
        expect(matchesQuery('東方 ガレージキット フィギュア', parsed)).toBe(true);
        expect(matchesQuery('東方 フィギュア', parsed)).toBe(false);
    });

    test('matches OR - any term sufficient', () => {
        const parsed = parseQuery('セイバー|アルトリア');
        expect(matchesQuery('セイバー フィギュア', parsed)).toBe(true);
        expect(matchesQuery('アルトリア フィギュア', parsed)).toBe(true);
        expect(matchesQuery('ランサー フィギュア', parsed)).toBe(false);
    });

    test('matches mixed AND + OR', () => {
        const parsed = parseQuery('ガレージキット セイバー|アルトリア');
        expect(matchesQuery('ガレージキット セイバー', parsed)).toBe(true);
        expect(matchesQuery('ガレージキット アルトリア', parsed)).toBe(true);
        expect(matchesQuery('セイバー フィギュア', parsed)).toBe(false);
    });

    test('handles negation with -term', () => {
        const parsed = parseQuery('ガレージキット -ジャンク');
        expect(matchesQuery('ガレージキット 美少女', parsed)).toBe(true);
        expect(matchesQuery('ガレージキット ジャンク品', parsed)).toBe(false);
    });

    test('non-strict mode passes non-quoted, non-negated terms', () => {
        const parsed = parseQuery('saber figure');
        expect(matchesQuery('random title', parsed, false)).toBe(true);
    });

    test('non-strict mode still enforces quoted terms', () => {
        // Construct a query with a quoted TERM node directly
        const parsed = {
            type: 'AND',
            children: [
                { type: 'TERM', value: 'saber', quoted: true },
                { type: 'TERM', value: 'figure', quoted: false }
            ]
        };
        expect(matchesQuery('saber other stuff', parsed, false)).toBe(true);
        expect(matchesQuery('random title', parsed, false)).toBe(false);
    });

    test('non-strict mode still enforces negation', () => {
        const parsed = parseQuery('figure -ジャンク');
        expect(matchesQuery('ジャンク figure', parsed, false)).toBe(false);
    });

    test('GK synonym expansion matches any variant', () => {
        const parsed = parseQuery('ガレージキット');
        expect(matchesQuery('レジンキット フィギュア', parsed)).toBe(true);
        expect(matchesQuery('ガレキ セイバー', parsed)).toBe(true);
        expect(matchesQuery('レジンキャストキット', parsed)).toBe(true);
        expect(matchesQuery('キャストキット セイバー', parsed)).toBe(true);
        expect(matchesQuery('プラモデル フィギュア', parsed)).toBe(false);
    });

    test('GK negation excludes all variants', () => {
        const parsed = parseQuery('-ガレージキット');
        expect(matchesQuery('レジンキット フィギュア', parsed)).toBe(false);
        expect(matchesQuery('プラモデル フィギュア', parsed)).toBe(true);
    });

    test('empty AND matches everything', () => {
        const parsed = { type: 'AND', children: [] };
        expect(matchesQuery('anything', parsed)).toBe(true);
    });

    test('empty OR matches nothing', () => {
        const parsed = { type: 'OR', children: [] };
        expect(matchesQuery('anything', parsed)).toBe(false);
    });

    test('normalizes kana for matching (small vs large)', () => {
        // "ガァルル" in title, "ガアルル" in query
        const parsed1 = parseQuery('ガアルル');
        expect(matchesQuery('ガァルル フィギュア', parsed1)).toBe(true);

        // "ガアルル" in title, "ガァルル" in query
        const parsed2 = parseQuery('ガァルル');
        expect(matchesQuery('ガアルル フィギュア', parsed2)).toBe(true);

        // Small tsu
        const parsed3 = parseQuery('キツネ');
        expect(matchesQuery('キツネ', parsed3)).toBe(true);
        expect(matchesQuery('キッネ', parsed3)).toBe(true);
    });
});

// ─── matchTitle ──────────────────────────────────────────────

describe('matchTitle', () => {
    test('works with a raw query string', () => {
        expect(matchTitle('Saber Figure', 'saber')).toBe(true);
        expect(matchTitle('Archer Figure', 'saber')).toBe(false);
    });

    test('works with a pre-parsed query object', () => {
        const parsed = parseQuery('saber');
        expect(matchTitle('Saber Figure', parsed)).toBe(true);
    });

    test('respects strict parameter', () => {
        expect(matchTitle('random title', 'saber', false)).toBe(true);
        expect(matchTitle('random title', 'saber', true)).toBe(false);
    });
});

// ─── getSearchTerms ──────────────────────────────────────────

describe('getSearchTerms', () => {
    test('returns empty string for null/empty', () => {
        expect(getSearchTerms(null)).toBe('');
        expect(getSearchTerms('')).toBe('');
    });

    test('strips OR operators', () => {
        expect(getSearchTerms('セイバー|アルトリア')).toBe('セイバー アルトリア');
    });

    test('strips AND operators', () => {
        expect(getSearchTerms('term1 && term2')).toBe('term1 term2');
    });

    test('normalizes whitespace', () => {
        expect(getSearchTerms('  term1   term2  ')).toBe('term1 term2');
    });
});

// ─── hasQuotedTerms ──────────────────────────────────────────

describe('hasQuotedTerms', () => {
    test('returns false for null', () => {
        expect(hasQuotedTerms(null)).toBe(false);
    });

    test('returns false when no quoted terms', () => {
        const parsed = parseQuery('saber figure');
        expect(hasQuotedTerms(parsed)).toBe(false);
    });

    test('returns true for directly constructed quoted term', () => {
        const parsed = { type: 'TERM', value: 'saber', quoted: true };
        expect(hasQuotedTerms(parsed)).toBe(true);
    });

    test('detects quoted single-word term', () => {
        const parsed = parseQuery('"saber"');
        expect(hasQuotedTerms(parsed)).toBe(true);
    });
});

// ─── getMissingTerms ─────────────────────────────────────────

describe('getMissingTerms', () => {
    test('returns empty array when all terms match', () => {
        expect(getMissingTerms('東方 ガレージキット', '東方 ガレージキット')).toEqual([]);
    });

    test('returns missing terms', () => {
        const missing = getMissingTerms('東方 フィギュア', '東方 ガレージキット');
        expect(missing).toContain('ガレージキット');
        expect(missing).not.toContain('東方');
    });

    test('GK variant match means nothing is missing', () => {
        const missing = getMissingTerms('レジンキット セイバー', 'ガレージキット セイバー');
        expect(missing).toEqual([]);
    });

    test('does not report negated terms as missing', () => {
        const missing = getMissingTerms('some title', '-badterm');
        expect(missing).toEqual([]);
    });

    test('OR group: nothing missing if any child matches', () => {
        const missing = getMissingTerms('セイバー フィギュア', 'セイバー|アルトリア');
        expect(missing).toEqual([]);
    });

    test('OR group: reports all children if none match', () => {
        const missing = getMissingTerms('ランサー', 'セイバー|アルトリア');
        expect(missing).toContain('セイバー');
        expect(missing).toContain('アルトリア');
    });

    test('normalizes kana when checking for missing', () => {
        const missing = getMissingTerms('ガァルル', 'ガアルル');
        expect(missing).toEqual([]);

        const missing2 = getMissingTerms('ガアルル', 'ガァルル');
        expect(missing2).toEqual([]);
    });
});

// ─── GK_VARIANTS ─────────────────────────────────────────────

describe('GK_VARIANTS', () => {
    test('contains expected variants', () => {
        expect(GK_VARIANTS).toContain('ガレージキット');
        expect(GK_VARIANTS).toContain('レジンキット');
        expect(GK_VARIANTS).toContain('ガレキ');
        expect(GK_VARIANTS.length).toBeGreaterThanOrEqual(5);
    });
});
