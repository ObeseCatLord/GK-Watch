const puppeteer = require('puppeteer');
const fs = require('fs');

const target = process.argv[2];
const query = 'gundam';

(async () => {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    try {
        let url = '';
        if (target === 'surugaya') {
            url = `https://www.suruga-ya.jp/search?category=&search_word=${query}`;
        } else if (target === 'mandarake') {
            url = `https://order.mandarake.co.jp/order/listPage/list?keyword=${query}`;
        } else if (target === 'mercari') {
            url = `https://jp.mercari.com/search?keyword=${query}`;
        }

        console.log(`Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait a bit for dynamic content
        await new Promise(r => setTimeout(r, 5000));

        const content = await page.content();
        fs.writeFileSync(`${target}_puppeteer.html`, content);
        console.log(`Dumped ${content.length} bytes to ${target}_puppeteer.html`);

    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
})();
