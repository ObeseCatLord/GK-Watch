## Why Cookies?

Taobao requires authentication to view product listings. The scraper uses cookie-based authentication to bypass login prompts and access search results.

## Cookie Extraction Steps

**Install Extension**
   - Chrome: https://chrome.google.com/webstore/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg
   - Edge: https://microsoftedge.microsoft.com/addons/detail/editthiscookie/neaplmfkghagebokkhpjpoebhdledlfi

**Login to https://www.taobao.com **

**Export Cookies**
   - Click the EditThisCookie extension icon
   - Click the "Export" button (looks like a document with an arrow)
   - Cookies will be copied to clipboard as JSON
   - Save the contents as `server/data/taobao_cookies.json`
