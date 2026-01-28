/**
 * Query Matcher Utility
 * 
 * Parses and matches search queries with OR (|) and AND (&&) operators.
 * 
 * Syntax:
 *   - term1 term2       → term1 AND term2 (implicit AND via space)
 *   - term1|term2       → term1 OR term2
 *   - term1 && term2    → term1 AND term2 (explicit)
 *   - Mixed: ガレージキット セイバー|アルトリア → GK AND (Saber OR Altria)
 *   - "Exact Term"      → Enforces exact match even in non-strict mode
 * 
 * Operator precedence: | binds tighter than && (and space)
 */

// GK synonym variants - any of these match each other
const GK_VARIANTS = [
    'ガレージキット',
    'レジンキット',
    'レジンキャスト',
    'レジンキャストキット',
    'ガレキ',
    'キャストキット'
];

/**
 * Parse a query string into a structured representation.
 * Returns an object with type 'AND' or 'OR' and children, or type 'TERM' with value.
 * 
 * @param {string} query - Raw query string
 * @returns {Object} Parsed query tree
 */
function parseQuery(query) {
    if (!query || typeof query !== 'string') {
        return { type: 'AND', children: [] };
    }

    // Normalize whitespace
    query = query.trim();
    if (!query) {
        return { type: 'AND', children: [] };
    }

    // IMPORTANT: Normalize spaces around | operator BEFORE splitting by spaces
    // This converts "term1 | term2" to "term1|term2"
    query = query.replace(/\s*\|\s*/g, '|');

    // Split by && first (explicit AND, lowest precedence)
    // Also treat multiple spaces as AND separators
    const andParts = query.split(/\s*&&\s*|\s+/).filter(part => part.length > 0);

    if (andParts.length === 0) {
        return { type: 'AND', children: [] };
    }

    if (andParts.length === 1) {
        // Check for OR within this single part
        return parseOrGroup(andParts[0]);
    }

    // Multiple AND parts
    return {
        type: 'AND',
        children: andParts.map(part => parseOrGroup(part))
    };
}

/**
 * Parse a single term, stripping quotes if present.
 */
function parseTerm(term) {
    let value = term;
    let quoted = false;

    // Check for surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        if (value.length > 2) {
            value = value.substring(1, value.length - 1);
            quoted = true;
        }
    }

    return { type: 'TERM', value, quoted };
}

/**
 * Parse a single group that may contain OR operators (|)
 * 
 * @param {string} group - A single group (no spaces or &&)
 * @returns {Object} Parsed node
 */
function parseOrGroup(group) {
    if (!group.includes('|')) {
        // Simple term
        return parseTerm(group);
    }

    // Split by |
    const orParts = group.split('|').filter(part => part.length > 0);

    if (orParts.length === 1) {
        return parseTerm(orParts[0]);
    }

    return {
        type: 'OR',
        children: orParts.map(part => parseTerm(part))
    };
}

/**
 * Check if a title matches a parsed query.
 * 
 * @param {string} title - Item title to check
 * @param {Object} parsedQuery - Parsed query tree from parseQuery()
 * @param {boolean} strict - If true, all terms must match. If false, only quoted terms must match.
 * @returns {boolean} True if title matches query
 */
function matchesQuery(title, parsedQuery, strict = true) {
    if (!title || !parsedQuery) return false;

    const titleLower = title.toLowerCase();

    switch (parsedQuery.type) {
        case 'TERM': {
            let termLower = parsedQuery.value.toLowerCase();
            let isNegated = false;

            if (termLower.startsWith('-') && termLower.length > 1) {
                isNegated = true;
                termLower = termLower.slice(1);
            }

            // If NOT strict mode, we ONLY check if the term is quoted or negated.
            // If it's NOT quoted and NOT negated, we return true (pass) because we assume
            // non-strict mode relies on the scraper's fuzzy search.
            if (!strict && !parsedQuery.quoted && !isNegated) {
                return true;
            }

            // Check for GK synonym match
            // If negated, we want to ensure NONE of the variants are present
            if (GK_VARIANTS.some(v => v.toLowerCase() === termLower)) {
                const hasVariant = GK_VARIANTS.some(variant =>
                    titleLower.includes(variant.toLowerCase())
                );
                return isNegated ? !hasVariant : hasVariant;
            }

            const hasTerm = titleLower.includes(termLower);
            return isNegated ? !hasTerm : hasTerm;
        }

        case 'AND': {
            if (!parsedQuery.children || parsedQuery.children.length === 0) {
                return true; // Empty AND = match all
            }
            return parsedQuery.children.every(child => matchesQuery(title, child, strict));
        }

        case 'OR': {
            if (!parsedQuery.children || parsedQuery.children.length === 0) {
                return false; // Empty OR = match none
            }
            return parsedQuery.children.some(child => matchesQuery(title, child, strict));
        }

        default:
            return false;
    }
}

/**
 * Convenience function: parse query and match title in one call.
 * 
 * @param {string} title - Item title to check
 * @param {string} query - Raw query string
 * @param {boolean} strict - Whether to enforce strict matching
 * @returns {boolean} True if title matches query
 */
function matchTitle(title, query, strict = true) {
    const parsed = parseQuery(query);
    return matchesQuery(title, parsed, strict);
}

/**
 * Check if the parsed query contains any quoted terms.
 * Useful for determining if we should force strict checking even if global strict is off.
 */
function hasQuotedTerms(parsedQuery) {
    if (!parsedQuery) return false;

    if (parsedQuery.type === 'TERM') {
        return !!parsedQuery.quoted;
    }

    if (parsedQuery.children && parsedQuery.children.length > 0) {
        return parsedQuery.children.some(child => hasQuotedTerms(child));
    }

    return false;
}

/**
 * Extract plain search terms from a query (strips operators).
 * Used to construct search URLs for sites that don't support operators.
 * 
 * @param {string} query - Raw query string  
 * @returns {string} Space-separated terms for URL encoding
 */
function getSearchTerms(query) {
    if (!query || typeof query !== 'string') return '';

    // Replace operators with spaces and normalize
    return query
        .replace(/\|/g, ' ')
        .replace(/&&/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

module.exports = {
    parseQuery,
    matchesQuery,
    matchTitle,
    getSearchTerms,
    getMissingTerms,
    hasQuotedTerms,
    GK_VARIANTS
};

/**
 * Identify which terms in the query are NOT present in the title.
 * Returns a flat array of missing terms.
 * 
 * @param {string} title 
 * @param {string} query 
 * @returns {string[]} Array of missing terms
 */
function getMissingTerms(title, query) {
    const parsed = parseQuery(query);
    return findMissing(title, parsed);
}

function findMissing(title, node) {
    if (!title || !node) return [];
    const titleLower = title.toLowerCase();

    switch (node.type) {
        case 'TERM': {
            // Check logic identical to matchesQuery
            let termLower = node.value.toLowerCase();
            let isNegated = false;

            if (termLower.startsWith('-') && termLower.length > 1) {
                isNegated = true;
                termLower = termLower.slice(1);
            }

            let hasMatch = false;
            // NOTE: We don't check quoted status here because getMissingTerms 
            // is usually for diagnostic or strict fallback where we WANT to know what's missing.
            // If we strictly want to ignore non-quoted terms in "missing", we'd need a flag.
            // For now, behave as strict=true (report all missing).

            if (GK_VARIANTS.some(v => v.toLowerCase() === termLower)) {
                hasMatch = GK_VARIANTS.some(variant => titleLower.includes(variant.toLowerCase()));
            } else {
                hasMatch = titleLower.includes(termLower);
            }

            if (isNegated) return [];

            return hasMatch ? [] : [node.value];
        }

        case 'AND': {
            // Return failures from ALL children
            if (!node.children) return [];
            return node.children.flatMap(child => findMissing(title, child));
        }

        case 'OR': {
            // If ANY child matches, then nothing is missing.
            if (matchesQuery(title, node, true)) return []; // Pass strict=true just to check match
            return node.children.flatMap(child => findMissing(title, child));
        }

        default:
            return [];
    }
}
