const puppeteer = require('puppeteer');

async function testPuppeteer() {
    console.log('Testing Taobao with Puppeteer...\n');

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    const url = 'https://s.taobao.com/search?q=东方+白模';
    console.log('Navigating to:', url);

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    console.log('Page loaded, waiting for content...\n');

    // Wait a bit for JS to render
    await new Promise(r => setTimeout(r, 3000));

    // Try different selectors
    const results = await page.evaluate(() => {
        const selectors = [
            '.item',
            '.Card--doubleCardWrapper--L2XFE73',
            '[class*="itemCard"]',
            '[class*="Item"]',
            '[data-index]'
        ];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
                console.log(`Found ${elements.length} elements with selector: ${selector}`);

                // Try to extract first item
                const first = elements[0];
                return {
                    selector,
                    count: elements.length,
                    firstElement: {
                        html: first.outerHTML.substring(0, 500),
                        text: first.innerText.substring(0, 200)
                    }
                };
            }
        }

        return { error: 'No elements found with any selector' };
    });

    console.log('Results:', JSON.stringify(results, null, 2));

    // Get page title and body info
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText);

    console.log('\nPage title:', title);
    console.log('Body text length:', bodyText.length);
    console.log('Body preview:', bodyText.substring(0, 300));

    await browser.close();
}

testPuppeteer().catch(console.error);
