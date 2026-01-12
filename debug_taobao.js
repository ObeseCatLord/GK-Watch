const axios = require('axios');
const cheerio = require('cheerio');

async function quickTest() {
    const url = 'https://s.taobao.com/search?q=%E4%B8%9C%E6%96%B9%20%E7%99%BD%E6%A8%A1';

    console.log('Fetching Taobao search page...');
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        }
    });

    console.log('Status:', response.status);
    console.log('Content length:', response.data.length);

    // Save HTML for inspection
    const fs = require('fs');
    fs.writeFileSync('/tmp/taobao_test.html', response.data);
    console.log('Saved HTML to /tmp/taobao_test.html');

    // Try to parse
    const $ = cheerio.load(response.data);

    // Look for common selectors
    console.log('\nLooking for product elements...');
    console.log('.item elements:', $('.item').length);
    console.log('.Card--doubleCardWrapper--L2XFE73:', $('.Card--doubleCardWrapper--L2XFE73').length);
    console.log('[class*="Card"]:', $('[class*="Card"]').length);
    console.log('[class*="item"]:', $('[class*="item"]').length);

    // Check page structure
    console.log('\nPage title:', $('title').text());
    console.log('Body text length:', $('body').text().length);

    // Look for script tags with g_page_config
    const scripts = $('script').toArray();
    console.log('\nScript tags:', scripts.length);

    for (let script of scripts) {
        const scriptContent = $(script).html();
        if (scriptContent && scriptContent.includes('g_page_config')) {
            console.log('\nFound g_page_config!');
            // Try to extract data
            const match = scriptContent.match(/g_page_config\s*=\s*({.*?});/s);
            if (match) {
                try {
                    const config = JSON.parse(match[1]);
                    console.log('Config keys:', Object.keys(config));
                    if (config.mods && config.mods.itemlist) {
                        console.log('Item list found!');
                        console.log('Data structure:', JSON.stringify(config.mods.itemlist, null, 2).substring(0, 500));
                    }
                } catch (e) {
                    console.log('Could not parse config:', e.message);
                }
            }
            break;
        }
    }
}

quickTest().catch(console.error);
