const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function testCookiesDetailed() {
    const COOKIES_FILE = path.join(__dirname, 'server/data/taobao_cookies.json');
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));

    console.log(`Loaded ${cookies.length} cookies\n`);

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Set cookies
    await page.setCookie(...cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.taobao.com',
        path: c.path || '/',
        expires: c.expirationDate,
        httpOnly: c.httpOnly || false,
        secure: c.secure || false
    })));

    console.log('Cookies set!\n');

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    const url = 'https://s.taobao.com/search?q=东方';
    console.log('Navigating to:', url);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for JS to render
    console.log('Waiting for page to render...');
    await new Promise(r => setTimeout(r, 5000));

    // Take screenshot
    await page.screenshot({ path: '/tmp/taobao_with_cookies.png', fullPage: true });
    console.log('Screenshot saved to /tmp/taobao_with_cookies.png\n');

    // Get detailed page info
    const pageInfo = await page.evaluate(() => {
        return {
            title: document.title,
            url: window.location.href,
            bodyText: document.body.innerText.substring(0, 1000),
            hasLogin: document.body.innerText.includes('登录') || document.body.innerText.includes('請登'),
            selectors: {
                '.item': document.querySelectorAll('.item').length,
                '.Card--doubleCardWrapper--L2XFE73': document.querySelectorAll('.Card--doubleCardWrapper--L2XFE73').length,
                '[class*="Card"]': document.querySelectorAll('[class*="Card"]').length,
                '[class*="item"]': document.querySelectorAll('[class*="item"]').length,
                '[data-index]': document.querySelectorAll('[data-index]').length,
            },
            firstItemHTML: document.querySelector('.item') ? document.querySelector('.item').outerHTML.substring(0, 500) : 'No .item found',
            bodyClasses: document.body.className,
            allClasses: Array.from(new Set(Array.from(document.querySelectorAll('*')).map(el => el.className).filter(c => c))).slice(0, 50)
        };
    });

    console.log('Page Info:');
    console.log(JSON.stringify(pageInfo, null, 2));

    // Save HTML
    const html = await page.content();
    fs.writeFileSync('/tmp/taobao_with_cookies.html', html);
    console.log('\nHTML saved to /tmp/taobao_with_cookies.html');

    await browser.close();
}

testCookiesDetailed().catch(console.error);
