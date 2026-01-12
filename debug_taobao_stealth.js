const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

async function testWithStealth() {
    console.log('Testing Taobao with Puppeteer Stealth mode...\n');

    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage'
        ]
    });

    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Realistic headers
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const url = 'https://s.taobao.com/search?q=东方+白模&sort=default';
    console.log('Navigating to:', url);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for page to fully load
    await new Promise(r => setTimeout(r, 5000));

    // Take screenshot
    await page.screenshot({ path: '/tmp/taobao_stealth.png' });
    console.log('Screenshot saved to /tmp/taobao_stealth.png');

    // Check what we get
    const pageInfo = await page.evaluate(() => {
        return {
            title: document.title,
            bodyTextLength: document.body.innerText.length,
            bodyPreview: document.body.innerText.substring(0, 500),
            hasLoginText: document.body.innerText.includes('登录') || document.body.innerText.includes('login'),
            itemCount: document.querySelectorAll('.item').length,
            cardCount: document.querySelectorAll('[class*="Card"]').length,
        };
    });

    console.log('\nPage Info:');
    console.log(JSON.stringify(pageInfo, null, 2));

    await browser.close();
}

testWithStealth().catch(console.error);
