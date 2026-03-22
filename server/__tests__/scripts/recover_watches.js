const fs = require('fs');

try {
    const results = JSON.parse(fs.readFileSync('remote_results.json', 'utf8'));
    const watches = new Map();

    // Candidates extracted from server logs
    const candidateTerms = [
        "コメットさん ガレージキット",
        "みれぃ ガレージキット",
        "アイカツ ガレージキット",
        "フェアリーテイル レクイエム",
        "東方 ガレージキット",
        "プリキュア ガレージキット",
        "剛本堂 ガアルル",
        "おジャ魔女どれみ ガレージキット",
        "メテオさん ガレージキット"
    ];

    Object.keys(results).forEach(watchId => {
        const watchData = results[watchId];
        let term = watchData.term;

        // Strategy 1: Suruga-ya Placeholder
        if (!term && watchData.items) {
            const surugayaItem = watchData.items.find(i => i.title && i.title.includes('Search Suruga-ya for'));
            if (surugayaItem) {
                const match = surugayaItem.title.match(/Search Suruga-ya for "([^"]+)"/);
                if (match && match[1]) term = match[1];
            }
        }

        // Strategy 2: Item.term property
        if (!term && watchData.items) {
            const itemWithTerm = watchData.items.find(i => i.term);
            if (itemWithTerm) term = itemWithTerm.term;
        }

        // Strategy 3: Match against candidate terms
        // Count how many items contain each candidate term provided the item title exists
        if (!term && watchData.items && watchData.items.length > 0) {
            let bestCandidate = null;
            let maxMatches = 0;

            candidateTerms.forEach(cand => {
                // Split candidate into words for fuzzier matching if needed, 
                // but usually the full term is in the title for strict matches
                // Let's use simple inclusion
                const keywords = cand.split(' ');

                let matches = 0;
                watchData.items.forEach(item => {
                    if (item.title) {
                        // Check if ALL keywords are present
                        const allKeywordsPresent = keywords.every(k => item.title.toLowerCase().includes(k.toLowerCase()));
                        if (allKeywordsPresent) matches++;
                    }
                });

                if (matches > 0 && matches > maxMatches) {
                    maxMatches = matches;
                    bestCandidate = cand;
                }
            });

            if (bestCandidate) {
                term = bestCandidate;
            }
        }

        // Fallback
        if (!term) {
            if (watchId.match(/^\d+$/)) {
                term = "Recovered Watch " + watchId;
            } else {
                term = watchId;
            }
        }

        if (!watches.has(watchId)) {
            watches.set(watchId, {
                id: watchId,
                name: term,
                term: term,
                terms: [term],
                active: true,
                emailNotify: true,
                createdAt: new Date().toISOString(),
                lastRun: watchData.lastRun || null,
                strict: true,
                enabledSites: {
                    mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true, taobao: false
                }
            });
        }
    });

    const recoveredList = Array.from(watches.values());
    console.log(`Recovered ${recoveredList.length} watches.`);

    // Sort for easier reading
    recoveredList.sort((a, b) => a.name.localeCompare(b.name));

    recoveredList.forEach(w => console.log(`- ${w.name}`));

    fs.writeFileSync('recovered_watchlist.json', JSON.stringify(recoveredList, null, 2));

} catch (err) {
    console.error('Error:', err);
}
