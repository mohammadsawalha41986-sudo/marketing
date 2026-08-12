/** Report export rendering. Self-contained HTML, or Markdown. */

import type { Report } from '@prisma/client';

interface ReportPayload {
  client: { name: string; businessName: string };
  period: { from: string; to: string };
  totals: Record<string, number>;
  changes: Record<string, number | null>;
  platforms: Array<{ label: string; spend: number; impressions: number; clicks: number; conversions: number; ctr: number; roas: number }>;
  campaigns: Array<{ name: string; status: string; budget: number; spend: number }>;
  analysis: null | {
    summary: string;
    working: string[];
    failing: string[];
    recommendations: Array<{ title: string; detail: string; impact: string; area: string }>;
    nextActions: string[];
  };
  aiMeta: { provider: string; isFallback: boolean } | null;
  generatedAt: string;
}

const money = (value: number) => `$${Math.round(value).toLocaleString('en-US')}`;
const num = (value: number) => Math.round(value).toLocaleString('en-US');
const pct = (value: number, digits = 2) => `${(value * 100).toFixed(digits)}%`;
const delta = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

const esc = (value: unknown) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function payloadOf(report: Report): ReportPayload {
  return report.payload as unknown as ReportPayload;
}

export function renderReportMarkdown(report: Report): string {
  const data = payloadOf(report);
  const lines: string[] = [];

  lines.push(`# ${report.title}`, '');
  lines.push(`**Client:** ${data.client.businessName}  `);
  lines.push(`**Period:** ${data.period.from} to ${data.period.to}  `);
  lines.push(`**Generated:** ${new Date(data.generatedAt).toISOString().slice(0, 10)}`, '');

  if (data.analysis) {
    lines.push('## Executive summary', '', data.analysis.summary, '');
  }

  lines.push('## Performance', '');
  lines.push('| Measure | This period | vs previous |', '| --- | --- | --- |');
  lines.push(`| Spend | ${money(data.totals.spend ?? 0)} | ${delta(data.changes.spend)} |`);
  lines.push(`| Reach | ${num(data.totals.reach ?? 0)} | ${delta(data.changes.reach)} |`);
  lines.push(`| Impressions | ${num(data.totals.impressions ?? 0)} | — |`);
  lines.push(`| Clicks | ${num(data.totals.clicks ?? 0)} | ${delta(data.changes.clicks)} |`);
  lines.push(`| CTR | ${pct(data.totals.ctr ?? 0)} | — |`);
  lines.push(`| Conversions | ${num(data.totals.conversions ?? 0)} | ${delta(data.changes.conversions)} |`);
  lines.push(`| Revenue | ${money(data.totals.revenue ?? 0)} | — |`);
  lines.push(`| ROAS | ${(data.totals.roas ?? 0).toFixed(2)}x | ${delta(data.changes.roas)} |`, '');

  if (data.platforms.length > 0) {
    lines.push('## By platform', '');
    lines.push('| Platform | Spend | Impressions | Clicks | CTR | Conversions | ROAS |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of data.platforms) {
      lines.push(
        `| ${row.label} | ${money(row.spend)} | ${num(row.impressions)} | ${num(row.clicks)} | ${pct(row.ctr)} | ${num(row.conversions)} | ${row.roas.toFixed(2)}x |`,
      );
    }
    lines.push('');
  }

  if (data.campaigns.length > 0) {
    lines.push('## Campaigns', '');
    lines.push('| Campaign | Status | Budget | Spend |', '| --- | --- | --- | --- |');
    for (const campaign of data.campaigns) {
      lines.push(`| ${campaign.name} | ${campaign.status} | ${money(campaign.budget)} | ${money(campaign.spend)} |`);
    }
    lines.push('');
  }

  if (data.analysis) {
    if (data.analysis.working.length > 0) {
      lines.push('## What is working', '', ...data.analysis.working.map((item) => `- ${item}`), '');
    }
    if (data.analysis.failing.length > 0) {
      lines.push('## What needs attention', '', ...data.analysis.failing.map((item) => `- ${item}`), '');
    }
    lines.push('## Recommendations', '');
    for (const rec of data.analysis.recommendations) {
      lines.push(`### ${rec.title}`, '', `_${rec.impact} impact · ${rec.area}_`, '', rec.detail, '');
    }
    if (data.analysis.nextActions.length > 0) {
      lines.push('## Next actions', '', ...data.analysis.nextActions.map((item) => `- ${item}`), '');
    }
    lines.push('---', '');
    lines.push(
      data.aiMeta?.isFallback
        ? '_Insights produced by the built-in rule-based analyst. Every figure quoted is measured, not estimated. Recommendations are for a human to weigh._'
        : '_Insights produced by a language model from measured campaign data. Recommendations are for a human to weigh._',
    );
  }

  return lines.join('\n');
}

export function renderReportHtml(report: Report): string {
  const data = payloadOf(report);

  const kpi = (label: string, value: string, change?: number | null) => `
    <div class="kpi">
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value">${esc(value)}</div>
      ${change === undefined ? '' : `<div class="kpi-change ${change !== null && change >= 0 ? 'up' : 'down'}">${esc(delta(change ?? null))}</div>`}
    </div>`;

  const platformRows = data.platforms
    .map(
      (row) => `<tr>
        <td>${esc(row.label)}</td><td class="n">${esc(money(row.spend))}</td>
        <td class="n">${esc(num(row.impressions))}</td><td class="n">${esc(num(row.clicks))}</td>
        <td class="n">${esc(pct(row.ctr))}</td><td class="n">${esc(num(row.conversions))}</td>
        <td class="n">${row.roas.toFixed(2)}x</td>
      </tr>`,
    )
    .join('');

  const campaignRows = data.campaigns
    .map(
      (campaign) => `<tr>
        <td>${esc(campaign.name)}</td><td>${esc(campaign.status)}</td>
        <td class="n">${esc(money(campaign.budget))}</td><td class="n">${esc(money(campaign.spend))}</td>
      </tr>`,
    )
    .join('');

  const analysisSection = data.analysis
    ? `
    <h2>Executive summary</h2>
    <p class="lede">${esc(data.analysis.summary)}</p>
    ${data.analysis.working.length ? `<h2>What is working</h2><ul>${data.analysis.working.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
    ${data.analysis.failing.length ? `<h2>What needs attention</h2><ul>${data.analysis.failing.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
    <h2>Recommendations</h2>
    ${data.analysis.recommendations
      .map(
        (rec) => `<div class="rec">
          <div class="rec-head"><strong>${esc(rec.title)}</strong><span class="tag ${esc(rec.impact)}">${esc(rec.impact)} impact</span><span class="tag">${esc(rec.area)}</span></div>
          <p>${esc(rec.detail)}</p>
        </div>`,
      )
      .join('')}
    ${data.analysis.nextActions.length ? `<h2>Next actions</h2><ul>${data.analysis.nextActions.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
    <p class="footnote">${
      data.aiMeta?.isFallback
        ? 'Insights produced by the built-in rule-based analyst. Every figure quoted is measured, not estimated.'
        : 'Insights produced by a language model from measured campaign data.'
    } Recommendations are for a human to weigh, not instructions.</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(report.title)}</title>
<style>
  :root { --bg:#ffffff; --fg:#101828; --muted:#667085; --line:#e4e7ec; --brand:#6366f1; --up:#12805c; --down:#b42318; --surface:#f9fafb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b0f1a; --fg:#e8ebf2; --muted:#98a2b0; --line:#242a35; --brand:#818cf8; --up:#4cc3a1; --down:#f28b82; --surface:#141922; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width: 900px; margin:0 auto; padding:40px 24px 80px; }
  h1 { font-size:28px; margin:0 0 6px; letter-spacing:-.02em; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:40px 0 12px; }
  .meta { color:var(--muted); font-size:14px; }
  .lede { font-size:17px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-top:16px; }
  .kpi { border:1px solid var(--line); border-radius:10px; padding:14px 16px; background:var(--surface); }
  .kpi-label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  .kpi-value { font-size:24px; font-weight:650; margin-top:4px; font-variant-numeric:tabular-nums; }
  .kpi-change { font-size:13px; margin-top:2px; font-variant-numeric:tabular-nums; }
  .kpi-change.up { color:var(--up); } .kpi-change.down { color:var(--down); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
  .scroll { overflow-x:auto; }
  .rec { border:1px solid var(--line); border-left:3px solid var(--brand); border-radius:8px; padding:12px 16px; margin-bottom:10px; background:var(--surface); }
  .rec-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:4px; }
  .rec p { margin:0; color:var(--muted); }
  .tag { font-size:11px; text-transform:uppercase; letter-spacing:.05em; border:1px solid var(--line); border-radius:999px; padding:1px 8px; color:var(--muted); }
  .tag.high { color:var(--down); border-color:currentColor; }
  .footnote { color:var(--muted); font-size:13px; border-top:1px solid var(--line); padding-top:14px; margin-top:32px; }
</style></head>
<body><div class="wrap">
  <h1>${esc(report.title)}</h1>
  <div class="meta">${esc(data.client.businessName)} · ${esc(data.period.from)} to ${esc(data.period.to)} · generated ${esc(new Date(data.generatedAt).toISOString().slice(0, 10))}</div>

  <h2>Performance</h2>
  <div class="kpis">
    ${kpi('Spend', money(data.totals.spend ?? 0), data.changes.spend)}
    ${kpi('Reach', num(data.totals.reach ?? 0), data.changes.reach)}
    ${kpi('Clicks', num(data.totals.clicks ?? 0), data.changes.clicks)}
    ${kpi('CTR', pct(data.totals.ctr ?? 0))}
    ${kpi('Conversions', num(data.totals.conversions ?? 0), data.changes.conversions)}
    ${kpi('ROAS', `${(data.totals.roas ?? 0).toFixed(2)}x`, data.changes.roas)}
  </div>

  ${platformRows ? `<h2>By platform</h2><div class="scroll"><table><thead><tr><th>Platform</th><th class="n">Spend</th><th class="n">Impressions</th><th class="n">Clicks</th><th class="n">CTR</th><th class="n">Conversions</th><th class="n">ROAS</th></tr></thead><tbody>${platformRows}</tbody></table></div>` : ''}
  ${campaignRows ? `<h2>Campaigns</h2><div class="scroll"><table><thead><tr><th>Campaign</th><th>Status</th><th class="n">Budget</th><th class="n">Spend</th></tr></thead><tbody>${campaignRows}</tbody></table></div>` : ''}
  ${analysisSection}
</div></body></html>`;
}
