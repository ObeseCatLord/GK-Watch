const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function extractProductStructure() {
    const COOKIES_FILE = path.join(__dirname, 'server/data/taobao_cookies.json');
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    await page.setCookie(...cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.taobao.com',
        path: c.path || '/',
        expires: c.expirationDate,
        httpOnly: c.httpOnly || false,
        secure: c.secure || false
    })));

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto('https://s.taobao.com/search?q=东方', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    // Extract first 3 products with all available info
    const products = await page.evaluate(() => {
        const results = [];

        // Try multiple selectors
        const selectors = [
            '[class*="doubleCard"]',
            '[class*="Card"]',
            '[data-index]'
        ];

        for (const selector of selectors) {
            const cards = Array.from(document.querySelectorAll(selector)).slice(0, 3);

            if (cards.length > 0) {
                console.log(`Found ${cards.length} cards with selector: ${selector}`);

                for (const card of cards) {
                    const links = Array.from(card.querySelectorAll('a'));
                    const images = Array.from(card.querySelectorAll('img'));
                    const priceElements = Array.from(card.querySelectorAll('*')).filter(el =>
                        el.textContent.match(/¥|元/) || el.className.toLowerCase().includes('price')
                    );

                    results.push({
                        selector,
                        className: card.className,
                        innerText: card.innerText.substring(0, 200),
                        links: links.map(a => ({ href: a.href, text: a.textContent.substring(0, 50) })),
                        images: images.map(img => ({ src: img.src, alt: img.alt })),
                        prices: priceElements.map(p => ({ text: p.textContent, class: p.className })),
                        html: card.outerHTML.substring(0, 1000)
                    });
                }

                if (results.length > 0) break;
            }
        }

        return results;
    });

    console.log('Extracted Products:');
    console.log(JSON.stringify(products, null, 2));

    fs.writeFileSync('/tmp/taobao_products.json', JSON.stringify(products, null, 2));
    console.log('\nSaved to /tmp/taobao_products.json');

    await browser.close();
}

extractProductStructure().catch(console.error);
