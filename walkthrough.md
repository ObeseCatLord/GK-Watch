# Doorzo Fallback Implementation Walkthrough

## Overview
Replaced the unstable and resource-heavy Yahoo Puppeteer scraper with a lightweight, API-based Doorzo fallback. This change improves reliability and performance when the primary Yahoo Axios scraper fails.

## Key Changes
- **Implemented Doorzo API Scraper**: Use `https://sig.doorzo.com/` with the `AppYahoo.Search` endpoint (POST) for reliable data retrieval.
- **Micro-Pagination**: Added support for deep pagination (up to 200 pages) to retrieve more results than the native scraper loop.
- **Strict Filtering**: Integrated the existing strict filtering logic to ensure result relevance.
- **Removed Puppeteer**: Completely removed the Puppeteer dependency for Yahoo scraping search, eliminating browser launch overhead and stability issues.

## Verification Results

A comparison test was run between the Native Yahoo scraper (Axios) and the new Doorzo Fallback.

**Test Scenario**: `東方 ガレージキット` (Touhou Garage Kit)

| Metric | Native Yahoo (Axios) | New Doorzo Fallback | 
| :--- | :--- | :--- |
| **Method** | HTML Scraping | API Request (POST) |
| **Items Found** | 50 (Single Page Cap) | **86** (Multi-Page) |
| **Strict Filtered** | 47 | **82** |
| **Execution Time** | Fast | Fast (Parallel Req) |
| **Stability** | High (Primary) | High (Fallback) |

### Detailed Comparison Output
```
Scenario                                          Native  Doorzo(raw)  Doorzo(filt)
-----------------------------------------------------------------------------------
1. "東方 ガレージキット" — Lax                                 50           86            86
2. "東方 ガレージキット" — Strict                              47           86            82
3. "\"東方\" ガレージキット" — Lax                             47           86            82
4. "\"東方\" ガレージキット" — Strict                          47           86            82
```

The Doorzo fallback successfully retrieved **72% more items** (86 vs 50) due to its ability to paginate beyond the first page of results, confirming it as a highly effective fallback.

## Implementation Details
- **Endpoint**: `https://sig.doorzo.com/?n=Sig.Front.SubSite.AppYahoo.Search`
- **Method**: POST
- **Pagination**: Integer-based (`page: 1`, `page: 2`...)
- **Rate Limiting**: 500ms delay between page requests to be respectful to the API.
