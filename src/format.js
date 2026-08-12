/** Shared formatting for the terminal, the markdown reports, and the dashboard. */

const NUMBER = new Intl.NumberFormat('en-US');

export function num(value) {
  if (value === null || value === undefined) return '—';
  return NUMBER.format(Math.round(value));
}

export function usd(value, { compact = false } = {}) {
  if (value === null || value === undefined) return '—';
  if (compact) {
    const abs = Math.abs(value);
    if (abs >= 1e6) return `$${(value / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
    if (abs >= 1e3) return `$${Math.round(value / 1e3)}k`;
  }
  return `$${NUMBER.format(Math.round(value))}`;
}

export function pct(value, { digits = 1 } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** Signed percentage, for a delta against plan. */
export function delta(value, { digits = 0 } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const shown = (value * 100).toFixed(digits);
  return `${value >= 0 ? '+' : ''}${shown}%`;
}

export const STATUS_LABEL = {
  ahead: 'Ahead',
  'on-track': 'On track',
  'at-risk': 'At risk',
  behind: 'Behind',
};

export function titleCase(slug) {
  return String(slug)
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Render a fixed-width table for the terminal. `align` is per column. */
export function table(headers, rows, align = []) {
  const widths = headers.map((header, i) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[i] ?? '').length)),
  );
  const line = (cells) =>
    cells
      .map((cell, i) => (align[i] === 'right' ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}
