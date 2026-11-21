# Marketplace search providers

## Current routes

| Marketplace | Search order |
| --- | --- |
| PayPay Flea Market | J-Subculture → Doorzo |
| Mercari | J-Subculture → Doorzo → native API → Neokyo → DEJapan → native Chromium |
| Rakuma / Fril | J-Subculture → Doorzo → native Fril → DEJapan |
| Yahoo Auctions | Native Yahoo first for live searches and authenticated watches. Doorzo first for unauthenticated watches. Neokyo and Jauce are later fallbacks. |
| Suruga-ya | Doorzo → Neokyo → DEJapan. Native Suruga-ya item pages can supply missing prices. |
| Mandarake | Native Mandarake with configured cookies, plus catalog metadata for garage-kit mode. |
| Taobao and Goofish | Native browser searches with configured cookies. |

A completed J-Subculture search with matching results ends the search. Empty, failed, and incomplete searches can reach Doorzo. If pagination fails after yielding results, the results already found can be merged with the fallback by canonical marketplace URL.

## Free search candidates

November 2026 spot checks used Japanese garage-kit queries and compared canonical listing IDs. “Browser” refers to an interactive browser unless Chromium on Foundry is specified.

| Provider | Verified behavior |
| --- | --- |
| [J-Subculture](https://www.j-subculture.com/en/pages/search) | PayPay, Mercari, Rakuma, and Suruga-ya searches worked over HTTP from Foundry. PayPay recovered ten active listings Doorzo missed and had distinct 100-item pages. Mercari and Rakuma surfaced additional active Asuka listings. In the Suruga-ya sample, apparent differences resolved to existing catalog IDs with branch-number URLs. Yahoo Auctions redirected to sign-in. |
| [Doorzo](https://www.doorzo.com/) | Free HTTP fallback for PayPay, Mercari, Rakuma, Yahoo Auctions, and Suruga-ya. Can omit active items even when a response contains results. |
| [Rakufun](https://www.rakufun.com/newSite/PAYPAY) | PayPay worked over HTTP from Foundry and recovered all ten test misses. Results can include Yahoo Auctions IDs. |
| [Japan Proxy Shopping](https://japanproxyshopping.com/en/products/jdirectitems-fleamarket) | Foundry Chromium found the PayPay Rei and Asuka test listings. The Remilia query timed out. A plain HTTP request returned the app shell. |
| [Sendico](https://sendico.com/shop/paypayfleamarket/catalog), [Buyee](https://buyee.jp/paypayfleamarket/), [FROM JAPAN](https://www.fromjapan.co.jp/japan/en/jdirectitems-fleamarket/category/-/), [Neokyo](https://neokyo.com/en/jdirectitems-fleamarket-introduction) | Local browser searches recovered the missing Rei listings. Foundry HTTP requests for PayPay returned 403. This result applies to PayPay and does not establish the behavior of their other marketplaces. |
| [Direct Yahoo Flea Market](https://paypayfleamarket.yahoo.co.jp/) | Successful native searches provided reference results. Foundry later received 429 with HTTP and Chromium. [Yahoo's mobile app](https://paypayfleamarket.yahoo.co.jp/notice/function/post_1047/) offers alerts for eligible saved searches. |
| [DEJapan](https://www.dejapan.com/en), [Goody Japan](https://www.goody-japan.com/en) | PayPay purchase requests accept known listing URLs. Their tested marketplace selectors lacked PayPay keyword search. DEJapan still has Mercari and Rakuma routes. |
| [Letaoyifan](https://letaoyifan.com/site/PAYPAY), [GS Express](https://www.j-gsexpress.com/gsbuy/index.php/Paypay/category), [JPFans](https://jpfans.com/paypayfleamarket/platform) | Sign-in or verification blocked the tested Foundry routes. |
| [Janbox](https://janbox.com/us/paypay-fleamarket), [Meiluwang](https://www.meiluwang.com/paypay), [Yangtaowang](https://www.yangtaowang.com/paypay), [Rimaiwang](https://www.rimaiwang.com/brands/paypay/y), [Suzuki](https://suzukitrade.com/en/helpcenter/shopping/supported-marketplaces) | Public pages loaded. PayPay keyword coverage remains unverified. |
| [Wameiji](https://meruki.cn/), [ZenMarket](https://zenmarket.jp/en/blog/post/16968/fleamarket-is-here), [JPSearch](https://jpsearch.moe/) | Wameiji shares Doorzo support. ZenMarket announced a December 1 PayPay launch. JPSearch advertises only three free searches per day. |

## Paid reference services

- ReefAPI's public demo recovered all ten known PayPay misses. Searches took 2.2–3.7 seconds per page across four calls. It supports two pages and labels unrelated suggestions when there is no useful match. [ReefAPI](https://reefapi.com/paypay-flea-market-api)
- Apify advertises deeper PayPay paging. Anysite documents PayPay listing search. Live coverage was unverified for both. [Apify](https://apify.com/neverempty/yahoo-fleamarket-japan-listings-monitor) · [Anysite](https://app.anysite.io/docs/api/post-api-paypayfleamarket-products)

For future comparisons, use the same query and stock filters on both providers, paginate, compare IDs with tracking parameters removed, and check missing items on the original marketplace. Distinguish sold items, catalog variants, login pages, and rate limits from genuine misses. The spot checks did not establish sustained throughput at Foundry's scheduled volume.
