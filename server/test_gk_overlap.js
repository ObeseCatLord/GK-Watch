/**
 * Test script to analyze GK search term overlap
 * Checks if ガレージキット, レジンキット, and レジンキャストキット produce unique results
 */

const scrapers = require('./scrapers');

const BASE_TERMS = ['東方', 'プリキュア', '初音 ミク', 'ガンダム'];
const GK_SUFFIXES = ['ガレージキット', 'レジンキット', 'レジンキャストキット'];

async function runTest() {
    console.log('='.repeat(80));
    console.log('GK Search Term Overlap Analysis');
    console.log('='.repeat(80));
    console.log('');

    const allResults = {};

    for (const baseTerm of BASE_TERMS) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Testing: ${baseTerm}`);
        console.log('='.repeat(60));

        const termResults = {};

        for (const suffix of GK_SUFFIXES) {
            const query = `${baseTerm} ${suffix}`;
            console.log(`\nSearching: "${query}"...`);

            try {
                const results = await scrapers.searchAll(query);
                termResults[suffix] = results;
                console.log(`  Found ${results.length} results`);
            } catch (err) {
                console.error(`  Error: ${err.message}`);
                termResults[suffix] = [];
            }

            // Small delay between searches
            await new Promise(r => setTimeout(r, 1000));
        }

        // Analyze overlaps
        console.log(`\n--- Analysis for ${baseTerm} ---`);

        const linksBySuffix = {};
        for (const suffix of GK_SUFFIXES) {
            linksBySuffix[suffix] = new Set(termResults[suffix].map(r => r.link));
        }

        // Find unique to each suffix
        for (const suffix of GK_SUFFIXES) {
            const otherSuffixes = GK_SUFFIXES.filter(s => s !== suffix);
            const otherLinks = new Set();
            for (const other of otherSuffixes) {
                linksBySuffix[other].forEach(l => otherLinks.add(l));
            }

            const uniqueLinks = [...linksBySuffix[suffix]].filter(l => !otherLinks.has(l));
            console.log(`\n${suffix}:`);
            console.log(`  Total: ${linksBySuffix[suffix].size}`);
            console.log(`  Unique (not in other searches): ${uniqueLinks.length}`);

            if (uniqueLinks.length > 0 && uniqueLinks.length <= 10) {
                const uniqueItems = termResults[suffix].filter(r => uniqueLinks.includes(r.link));
                console.log('  Unique items:');
                uniqueItems.forEach(item => {
                    console.log(`    - [${item.source}] ${item.title.substring(0, 60)}...`);
                });
            }
        }

        // Check if レジンキット results are subset of ガレージキット
        const gkLinks = linksBySuffix['ガレージキット'];
        const resinLinks = linksBySuffix['レジンキット'];
        const castLinks = linksBySuffix['レジンキャストキット'];

        const resinOnlyInGK = [...resinLinks].filter(l => gkLinks.has(l));
        const castOnlyInGK = [...castLinks].filter(l => gkLinks.has(l));
        const castInResin = [...castLinks].filter(l => resinLinks.has(l));

        console.log('\n--- Overlap Summary ---');
        console.log(`レジンキット results also in ガレージキット: ${resinOnlyInGK.length}/${resinLinks.size}`);
        console.log(`レジンキャストキット results also in ガレージキット: ${castOnlyInGK.length}/${castLinks.size}`);
        console.log(`レジンキャストキット results also in レジンキット: ${castInResin.length}/${castLinks.size}`);

        allResults[baseTerm] = { termResults, linksBySuffix };
    }

    // Final summary
    console.log('\n' + '='.repeat(80));
    console.log('FINAL SUMMARY');
    console.log('='.repeat(80));

    let totalGK = 0, totalResin = 0, totalCast = 0;
    let uniqueGK = 0, uniqueResin = 0, uniqueCast = 0;

    for (const baseTerm of BASE_TERMS) {
        const { linksBySuffix } = allResults[baseTerm];

        totalGK += linksBySuffix['ガレージキット'].size;
        totalResin += linksBySuffix['レジンキット'].size;
        totalCast += linksBySuffix['レジンキャストキット'].size;

        // Count unique across all terms
        const gkSet = linksBySuffix['ガレージキット'];
        const resinSet = linksBySuffix['レジンキット'];
        const castSet = linksBySuffix['レジンキャストキット'];

        [...gkSet].forEach(l => {
            if (!resinSet.has(l) && !castSet.has(l)) uniqueGK++;
        });
        [...resinSet].forEach(l => {
            if (!gkSet.has(l) && !castSet.has(l)) uniqueResin++;
        });
        [...castSet].forEach(l => {
            if (!gkSet.has(l) && !resinSet.has(l)) uniqueCast++;
        });
    }

    console.log('\nAcross all 4 base terms:');
    console.log(`ガレージキット: ${totalGK} total, ${uniqueGK} unique`);
    console.log(`レジンキット: ${totalResin} total, ${uniqueResin} unique`);
    console.log(`レジンキャストキット: ${totalCast} total, ${uniqueCast} unique`);

    console.log('\n--- RECOMMENDATION ---');
    if (uniqueResin === 0 && uniqueCast === 0) {
        console.log('レジンキット and レジンキャストキット do NOT provide unique results.');
        console.log('Searching only ガレージキット would be sufficient.');
    } else if (uniqueCast === 0) {
        console.log('レジンキャストキット does NOT provide unique results.');
        console.log('Could reduce to just ガレージキット + レジンキット.');
    } else {
        console.log('All three terms provide some unique results and should be kept.');
    }

    console.log('\nDone!');
}

runTest().catch(console.error);
