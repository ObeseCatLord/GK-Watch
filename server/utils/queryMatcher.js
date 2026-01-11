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
 * Parse a single group that may contain OR operators (|)
 * 
 * @param {string} group - A single group (no spaces or &&)
 * @returns {Object} Parsed node
 */
function parseOrGroup(group) {
    if (!group.includes('|')) {
        // Simple term
        return { type: 'TERM', value: group };
    }

    // Split by |
    const orParts = group.split('|').filter(part => part.length > 0);

    if (orParts.length === 1) {
        return { type: 'TERM', value: orParts[0] };
    }

    return {
        type: 'OR',
        children: orParts.map(part => ({ type: 'TERM', value: part }))
    };
}

/**
 * Check if a title matches a parsed query.
 * 
 * @param {string} title - Item title to check
 * @param {Object} parsedQuery - Parsed query tree from parseQuery()
 * @returns {boolean} True if title matches query
 */
function matchesQuery(title, parsedQuery) {
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

            // Check for GK synonym match (only if not negated? Or negated synonyms too?)
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
            return parsedQuery.children.every(child => matchesQuery(title, child));
        }

        case 'OR': {
            if (!parsedQuery.children || parsedQuery.children.length === 0) {
                return false; // Empty OR = match none
            }
            return parsedQuery.children.some(child => matchesQuery(title, child));
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
 * @returns {boolean} True if title matches query
 */
function matchTitle(title, query) {
    const parsed = parseQuery(query);
    return matchesQuery(title, parsed);
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
    GK_VARIANTS
};
