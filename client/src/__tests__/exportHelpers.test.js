import { describe, it, expect } from 'vitest';
import {
  sanitizeHttpUrl,
  buildExportHtml,
  makeExportFilename,
  hasServerPaginationResponse
} from '../utils/exportHelpers';

describe('exportHelpers', () => {
  it('sanitizes only http/https URLs', () => {
    expect(sanitizeHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(sanitizeHttpUrl('http://example.com/path')).toBe('http://example.com/path');
    expect(sanitizeHttpUrl('JavaScript:alert(1)')).toBe('');
    expect(sanitizeHttpUrl('JaVaScRiPt:alert(1)')).toBe('');
    expect(sanitizeHttpUrl('javascript:\u0008alert(1)')).toBe('');
    expect(sanitizeHttpUrl('ftp://example.com')).toBe('');
    expect(sanitizeHttpUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeHttpUrl('<img src=x>')).toBe('');
  });

  it('adds a restrictive CSP to exported HTML output', () => {
    const html = buildExportHtml({
      heading: 'Live Export',
      items: [],
      variant: 'light'
    });

    expect(html).toContain("http-equiv=\"Content-Security-Policy\"");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('script-src \'none\'');
  });

  it('escapes potentially unsafe item fields and invalid URLs', () => {
    const html = buildExportHtml({
      heading: 'Export Test',
      items: [
        {
          title: '<img src=x onerror=alert(1)>',
          link: 'javascript:alert(2)',
          image: 'javascript:alert(3)',
          source: 'test',
          price: '<script>alert(4)</script>'
        }
      ],
      variant: 'watchlist'
    });

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('javascript:alert(2)');
    expect(html).toContain('<span class="link-text">javascript:alert(2)</span>');
    expect(html).not.toContain('<img src="javascript:alert(3)"');
    expect(html).not.toContain('<script>alert(4)</script>');
    expect(html).toContain('No image');
  });

  it('renders mixed-case javascript URLs and control-character link inputs safely', () => {
    const html = buildExportHtml({
      heading: 'Export Test',
      items: [
        {
          title: 'Safe Title',
          link: 'JaVaScRiPt:alert(1)',
          image: 'javascript:alert(2)',
          source: 'test',
          price: '100'
        },
        {
          title: 'Control Char',
          link: 'javaScript:\u0009alert(3)',
          image: 'javascript:alert(4)',
          source: 'test',
          price: '200'
        }
      ],
      variant: 'watchlist'
    });

    expect(html).toContain('<span class="link-text">JaVaScRiPt:alert(1)</span>');
    expect(html).toContain('<span class="link-text">javaScript:\talert(3)</span>');
    expect(html).not.toContain('<img src="javascript:');
    expect(html).toContain('No image');
  });

  it('generates deterministic and safe filenames', () => {
    const fixedDate = new Date(2026, 6, 31, 12, 34, 56);
    expect(makeExportFilename('Search Results', fixedDate))
      .toBe('Search_Results_2026-07-31_12-34-56.html');
    expect(makeExportFilename('Bad/Name:With*Chars', fixedDate))
      .toBe('BadNameWithChars_2026-07-31_12-34-56.html');
  });

  it('detects server-side watchlist response contract shape', () => {
    expect(hasServerPaginationResponse({
      items: [],
      total: 10,
      page: 1,
      pageSize: 24,
      totalPages: 1
    })).toBe(true);

    expect(hasServerPaginationResponse({
      items: [],
      total: 'x',
      page: 1,
      pageSize: 24,
      totalPages: 1
    })).toBe(false);
  });
});
