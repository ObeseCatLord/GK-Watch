const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const encodeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const normalizeNamePart = (value) =>
  encodeHtml(String(value ?? '').trim())
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '');

const formatDateSuffix = (now = new Date()) => {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) {
    return 'export';
  }
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

export const sanitizeHttpUrl = (value) => {
  if (!value) return '';

  try {
    const url = new URL(String(value));
    if (!ALLOWED_PROTOCOLS.has(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
};

export const makeExportFilename = (baseName = 'search_results', timestamp = new Date()) => {
  const safeBase = normalizeNamePart(baseName) || 'search_results';
  const safeTimestamp = formatDateSuffix(timestamp);
  return `${safeBase}_${safeTimestamp}.html`.slice(0, 255);
};

const buildSafeLink = (href) => {
  const safeHref = sanitizeHttpUrl(href);
  if (!safeHref) {
    return `<span class="link-text">${encodeHtml(href || '')}</span>`;
  }

  return `<a
    href="${encodeHtml(safeHref)}"
    target="_blank"
    rel="noopener noreferrer"
  >${encodeHtml(href)}</a>`;
};

const buildImageCell = (url) => {
  const safeSrc = sanitizeHttpUrl(url);
  if (!safeSrc) {
    return '';
  }
  return `<img src="${encodeHtml(safeSrc)}" alt="Item image" loading="lazy" />`;
};

export const buildExportHtml = ({
  heading = 'Search Results',
  subtitle = '',
  variant = 'light',
  items = []
}) => {
  const encodedHeading = encodeHtml(heading);
  const encodedSubtitle = encodeHtml(subtitle);
  const itemRows = (Array.isArray(items) ? items : []).map((item) => {
    const title = encodeHtml(item?.title || '');
    const price = encodeHtml(item?.price || item?.binPrice || 'N/A');
    const bidPrice = encodeHtml(item?.bidPrice || '');
    const source = encodeHtml(item?.source || '');
    const sourceText = source || 'Unknown';
    const isNew = item?.isNew ? 'Yes' : 'No';
    const image = buildImageCell(item?.image);

    return `<tr>
      <td>${title}</td>
      <td>${image ? `<div class="image-cell">${image}</div>` : 'No image'}</td>
      <td>${buildSafeLink(item?.link || item?.url)}</td>
      <td>${sourceText}</td>
      <td>${price}</td>
      <td>${bidPrice}</td>
      <td>${isNew}</td>
    </tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'; manifest-src 'none';" />
    <meta http-equiv="X-Content-Type-Options" content="nosniff" />
    <meta name="referrer" content="no-referrer" />
    <title>${encodedHeading}</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 24px; background: #0f1115; color: #e6e8ec; }
      h1 { margin: 0 0 8px; }
      .subtitle { color: #98a0b0; margin-bottom: 16px; }
      .meta { margin: 0 0 16px; color: #98a0b0; }
      .variant { display: inline-block; padding: 4px 8px; border-radius: 6px; font-size: 12px; margin-bottom: 10px; background: ${variant === 'watchlist' ? '#17324e' : '#2f3b28'}; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { border: 1px solid #2f3746; padding: 8px; text-align: left; vertical-align: top; }
      thead th { background: #212737; position: sticky; top: 0; }
      tbody tr:nth-child(2n) { background: #161a24; }
      .link-text { color: #98a0b0; }
      .image-cell { width: 120px; max-width: 120px; }
      .image-cell img { width: 80px; height: auto; max-height: 80px; object-fit: contain; }
      a { color: #8ab4f8; }
    </style>
  </head>
  <body>
    <main>
      <span class="variant">${variant === 'watchlist' ? 'Watchlist Export' : 'Live Export'}</span>
      <h1>${encodedHeading}</h1>
      <p class="subtitle">${encodedSubtitle}</p>
      <p class="meta">${itemRows.length} item${itemRows.length === 1 ? '' : 's'}</p>
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Image</th>
            <th>Link</th>
            <th>Source</th>
            <th>Price</th>
            <th>Bid</th>
            <th>New</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows || '<tr><td colspan="7">No results found.</td></tr>'}
        </tbody>
      </table>
    </main>
  </body>
</html>`;
};

export const downloadExportHtml = ({ filename, html }) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const safeFilename = String(filename || makeExportFilename('export')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
};

export const hasServerPaginationResponse = (payload) => {
  const hasItems = payload && Array.isArray(payload.items);
  if (!hasItems) return false;

  const numericFields = ['total', 'page', 'pageSize', 'totalPages'];
  return numericFields.every((key) => Number.isFinite(Number(payload[key])));
};
