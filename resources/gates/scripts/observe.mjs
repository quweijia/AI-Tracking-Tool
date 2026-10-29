#!/usr/bin/env node
/**
 * Did the agent follow the rules? Read what the hooks recorded and say so.
 *
 * The hooks write one event per session start, per UI edit (with what each
 * fast gate found) and per end of turn (which pages were measured, and whether
 * the Stop hook passed, blocked, or let the agent go while pages were still
 * open). Gate receipts say what was measured and when. This joins the two into
 * one verdict per session, from rules that can be counted:
 *
 *   1. measured   every page edited had a passing gate before the session ended
 *   2. fixed      no fast-gate finding was left on a file's latest version
 *   3. not quit   the agent never finished while the Stop hook still had pages open
 *
 * It reports counts, never a score for taste, and reads local files only.
 *
 * Usage:
 *   node scripts/observe.mjs                  sessions from the last 7 days, every project
 *   node scripts/observe.mjs --project [dir]  only this project (default: cwd)
 *   node scripts/observe.mjs --days 30
 *   node scripts/observe.mjs --session <id>   one session's timeline (a prefix is enough)
 *   node scripts/observe.mjs --last           the most recent session's timeline
 *   node scripts/observe.mjs --json           the same data, machine-readable
 *   node scripts/observe.mjs --html [file]    write a dashboard page (default: observe.html)
 *   node scripts/observe.mjs --data <dir>     read this data dir instead of searching
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES = new Set(['.html', '.htm']);
/** A gate run counts toward a session if it happened up to this long after the last event. */
const GRACE_MS = 15 * 60 * 1000;

function readJsonl(f) {
  try {
    return readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const list = d => { try { return readdirSync(d); } catch { return []; } };

/** Every data dir the hooks may have written to on this machine. */
export function dataDirs({ data, cwd = process.cwd() } = {}) {
  if (data) return [resolve(data)];
  const dirs = [];
  if (process.env.CLAUDE_PLUGIN_DATA) dirs.push(process.env.CLAUDE_PLUGIN_DATA);
  const plugins = join(homedir(), '.claude/plugins/data');
  for (const d of list(plugins)) if (d.startsWith('ux-ui-agent-skills')) dirs.push(join(plugins, d));
  // A clone or `init` install keeps everything in the project.
  dirs.push(join(cwd, '.ds-receipts'));
  return [...new Set(dirs.map(d => resolve(d)))].filter(d => existsSync(d));
}

/** Events live in <data>/observe, or in <project>/.ds-receipts/observe. */
export function loadEvents(dirs) {
  const out = [];
  for (const d of dirs) {
    const ev = join(d, 'observe');
    for (const f of list(ev)) if (/^events-.*\.jsonl$/.test(f)) out.push(...readJsonl(join(ev, f)));
  }
  return out.filter(e => e && e.v === 1 && e.session && e.at).sort((a, b) => a.at.localeCompare(b.at));
}

/** Receipts from the data dirs and from every project the events name. */
export function loadReceipts(dirs, projects = []) {
  const places = new Set();
  for (const d of dirs) places.add(basename(d) === '.ds-receipts' ? d : join(d, 'receipts'));
  for (const p of projects) places.add(join(p, '.ds-receipts'));
  const out = [];
  for (const d of places) {
    for (const f of list(d)) {
      if (!f.endsWith('.jsonl') || f.startsWith('edited-')) continue;
      out.push(...readJsonl(join(d, f)));
    }
  }
  const seen = new Set();
  return out.filter(r => {
    if (!r || !r.at || !Array.isArray(r.targets)) return false;
    const key = `${r.at}|${r.gate}|${JSON.stringify(r.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const isPage = p => PAGES.has(extname(p).toLowerCase());

/** One session's record, joined with the gate runs that measured its files. */
function buildSession(id, events, receipts) {
  const start = events[0].at;
  const end = events[events.length - 1].at;
  const project = events.find(e => e.project)?.project || null;
  const startEv = events.find(e => e.kind === 'session_start');
  const edits = events.filter(e => e.kind === 'edit');
  const stops = events.filter(e => e.kind === 'stop');
  const files = [...new Set(edits.map(e => e.path))];
  const pages = files.filter(isPage);

  // Rule 2: a finding counts as open when the file's LAST edit still has it.
  const latest = new Map();
  for (const e of edits) latest.set(e.path, e);
  const findings = edits.flatMap(e => (e.gates || []).filter(g => g.exit === 1)
    .map(g => ({ at: e.at, path: e.path, gate: g.gate, lines: g.findings || [] })));
  const openFindings = [...latest.values()].flatMap(e => (e.gates || []).filter(g => g.exit === 1)
    .map(g => ({ at: e.at, path: e.path, gate: g.gate, lines: g.findings || [] })));

  const until = Date.parse(end) + GRACE_MS;
  const fileSet = new Set(files);
  const gateRuns = receipts.filter(r => {
    const t = Date.parse(r.at);
    return t >= Date.parse(start) && t <= until && r.targets.some(x => fileSet.has(x.path));
  }).sort((a, b) => a.at.localeCompare(b.at));

  const lastStop = stops[stops.length - 1] || null;
  const lastEdit = edits[edits.length - 1] || null;
  const blocks = stops.filter(s => s.outcome === 'block').length;
  const released = stops.some(s => s.outcome === 'released');

  const rules = [];
  let verdict;
  if (!edits.length) {
    verdict = 'no_ui';
  } else if (!lastStop || lastStop.at < lastEdit.at) {
    verdict = 'unfinished';
  } else if (lastStop.outcome === 'block') {
    // Blocked, and nothing after: the session was closed while the hook waited.
    verdict = 'unfinished';
  } else {
    const open = (lastStop.pages || []).filter(p => p.state !== 'passing');
    const measured = lastStop.outcome !== 'warn_no_browser' && !open.length;
    rules.push({ rule: 'measured', ok: measured,
      detail: lastStop.outcome === 'warn_no_browser'
        ? 'no browser on this machine: pages could not be measured'
        : open.length ? `${open.length} of ${(lastStop.pages || []).length} page(s) unmeasured or failing at the end`
          : (lastStop.pages || []).length ? `${lastStop.pages.length} page(s), all with a passing gate`
            : 'no pages edited, nothing to measure' });
    rules.push({ rule: 'fixed', ok: !openFindings.length,
      detail: openFindings.length ? `${openFindings.length} finding(s) still on the latest version`
        : findings.length ? `${findings.length} finding(s) caught on write, all fixed` : 'no findings on write' });
    rules.push({ rule: 'not quit', ok: !released,
      detail: released ? 'finished while the Stop hook still had pages open'
        : blocks ? `blocked ${blocks} time(s), resolved each` : 'never blocked' });
    verdict = lastStop.outcome === 'warn_no_browser' && !openFindings.length && !released ? 'unmeasurable'
      : rules.every(r => r.ok) ? 'followed' : 'broke';
  }

  return {
    session: id, project, start, end,
    version: startEv?.version || null,
    browser: startEv ? Boolean(startEv.browser && startEv.playwright) : null,
    files, pages, edits: edits.length, findings, openFindings,
    stops: stops.map(s => ({ at: s.at, outcome: s.outcome, reentry: Boolean(s.reentry), pages: s.pages || [] })),
    blocks, released, gateRuns: gateRuns.map(r => ({
      at: r.at, gate: r.gate, exit: r.exit, skipped: Boolean(r.skipped),
      files: r.targets.map(t => t.path).filter(p => fileSet.has(p)),
    })),
    rules, verdict, events,
  };
}

export function summarize(events, receipts, { days = 7, project = null, now = Date.now() } = {}) {
  const since = now - days * 86400000;
  const bySession = new Map();
  for (const e of events) {
    if (Date.parse(e.at) < since) continue;
    if (project && e.project !== project) continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }
  const sessions = [...bySession].map(([id, evs]) => buildSession(id, evs, receipts))
    .sort((a, b) => b.start.localeCompare(a.start));
  const ui = sessions.filter(s => s.verdict !== 'no_ui');
  const count = v => ui.filter(s => s.verdict === v).length;
  const judged = count('followed') + count('broke');
  return {
    generated: new Date(now).toISOString(), days, project,
    totals: {
      sessions: sessions.length, ui: ui.length,
      followed: count('followed'), broke: count('broke'),
      unfinished: count('unfinished'), unmeasurable: count('unmeasurable'),
      rate: judged ? count('followed') / judged : null,
      pagesEdited: ui.reduce((n, s) => n + s.pages.length, 0),
      blocks: ui.reduce((n, s) => n + s.blocks, 0),
      released: ui.filter(s => s.released).length,
      findings: ui.reduce((n, s) => n + s.findings.length, 0),
      openFindings: ui.reduce((n, s) => n + s.openFindings.length, 0),
    },
    sessions,
  };
}

/* ---------- text ---------- */

const VERDICT = {
  followed: 'followed', broke: 'BROKE A RULE', unfinished: 'unfinished',
  unmeasurable: 'unmeasured (no browser)', no_ui: 'no UI edits',
};
const short = id => id.slice(0, 8);
const day = at => at.slice(0, 16).replace('T', ' ');
const where = (p, project) => (project && p.startsWith(project + '/') ? relative(project, p) : p);
const pct = r => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);

export function renderText(sum) {
  const t = sum.totals;
  const out = [];
  out.push(`ux-ui-agent-skills observe - last ${sum.days} day(s)${sum.project ? `, ${sum.project}` : ', every project'}`);
  out.push('');
  if (!t.ui) {
    out.push(`No session edited a UI file in this window (${t.sessions} session(s) seen).`);
    out.push('Events are written by the plugin hooks from 2.10.0 on; DS_OBSERVE=0 turns them off.');
    return out.join('\n');
  }
  out.push(`Followed the rules: ${t.followed} of ${t.followed + t.broke} finished session(s) (${pct(t.rate)})`);
  out.push(`  broke a rule ${t.broke}, unfinished ${t.unfinished}, unmeasured for lack of a browser ${t.unmeasurable}`);
  out.push(`  pages edited ${t.pagesEdited}, Stop hook blocks ${t.blocks}, finished while blocked ${t.released}`);
  out.push(`  findings caught on write ${t.findings}, still open ${t.openFindings}`);
  out.push('');
  out.push('SESSION   STARTED           VERDICT                  PAGES  BLOCKS  OPEN  PROJECT');
  for (const s of sum.sessions.filter(x => x.verdict !== 'no_ui')) {
    out.push(`${short(s.session)}  ${day(s.start)}  ${VERDICT[s.verdict].padEnd(23)}  ${String(s.pages.length).padStart(5)}  ${String(s.blocks).padStart(6)}  ${String(s.openFindings.length).padStart(4)}  ${s.project || ''}`);
  }
  out.push('');
  out.push('A timeline for one session: --session <id>   (or --last)');
  return out.join('\n');
}

/** Everything that happened in one session, in order. */
export function timeline(s) {
  const rows = [];
  for (const e of s.events) {
    if (e.kind === 'session_start') rows.push({ at: e.at, kind: 'start', text: `session start (${e.source || 'startup'}), kit ${e.version || '?'}, render gates ${e.browser && e.playwright ? 'can run' : 'CANNOT run'}` });
    if (e.kind === 'edit') {
      const bad = (e.gates || []).filter(g => g.exit === 1);
      rows.push({ at: e.at, kind: bad.length ? 'finding' : 'edit',
        text: `${e.tool || 'edit'} ${where(e.path, s.project)}${bad.length ? ` - caught: ${bad.map(g => g.gate).join(', ')}` : ''}`,
        detail: bad.flatMap(g => g.findings || []) });
    }
    if (e.kind === 'stop') {
      const open = (e.pages || []).filter(p => p.state !== 'passing');
      const label = { pass: 'end of turn: passed', block: 'end of turn: BLOCKED', released: 'end of turn: let go with pages OPEN',
        warn_no_browser: 'end of turn: warned, no browser', no_pages: 'end of turn: no pages edited' }[e.outcome] || e.outcome;
      rows.push({ at: e.at, kind: e.outcome, text: `${label}${open.length ? ` (${open.map(p => `${where(p.path, s.project)} ${p.state.replace('_', ' ')}`).join('; ')})` : ''}` });
    }
  }
  for (const r of s.gateRuns) {
    rows.push({ at: r.at, kind: r.exit === 0 && !r.skipped ? 'gate-pass' : 'gate-fail',
      text: `gate ${r.gate} on ${r.files.map(f => where(f, s.project)).join(', ')}: exit ${r.exit}${r.skipped ? ', SKIPPED' : ''}` });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

export function renderTimeline(s) {
  const out = [];
  out.push(`Session ${s.session}`);
  out.push(`  project  ${s.project}`);
  out.push(`  ${day(s.start)} to ${day(s.end)}, kit ${s.version || '?'}`);
  out.push(`  verdict  ${VERDICT[s.verdict]}`);
  for (const r of s.rules) out.push(`    ${r.ok ? 'pass' : 'FAIL'}  ${r.rule.padEnd(9)} ${r.detail}`);
  out.push('');
  for (const r of timeline(s)) {
    out.push(`  ${r.at.slice(11, 19)}  ${r.text}`);
    for (const d of r.detail || []) out.push(`              ${d.trim()}`);
  }
  return out.join('\n');
}

/* ---------- html ---------- */

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderHtml(sum) {
  // The kit's own theme, inlined so the page is one file. Comments are dropped:
  // they are notes for the theme's authors, not part of the page.
  const theme = readFileSync(join(ROOT, 'examples/brandkit-demo/theme.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const t = sum.totals;
  const judged = t.followed + t.broke;
  const VTONE = { followed: 'ok', broke: 'bad', unfinished: 'muted', unmeasurable: 'warn', no_ui: 'muted' };
  const ui = sum.sessions.filter(s => s.verdict !== 'no_ui');

  const rows = ui.map(s => {
    const tl = timeline(s).map(r => `
          <li class="tl tl-${esc(r.kind)}"><time datetime="${esc(r.at)}">${esc(r.at.slice(11, 19))}</time>
            <span>${esc(r.text)}</span>${(r.detail || []).length ? `<ul class="detail">${r.detail.map(d => `<li>${esc(d.trim())}</li>`).join('')}</ul>` : ''}</li>`).join('');
    const rules = s.rules.map(r => `<li><span class="mark ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'pass' : 'fail'}</span> <strong>${esc(r.rule)}</strong> ${esc(r.detail)}</li>`).join('');
    return `
      <details class="session">
        <summary>
          <svg class="chev" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          <span class="verdict ${VTONE[s.verdict]}">${esc(VERDICT[s.verdict])}</span>
          <span class="sid">${esc(short(s.session))}</span>
          <span class="when"><time datetime="${esc(s.start)}">${esc(day(s.start))}</time></span>
          <span class="proj">${esc(s.project ? basename(s.project) : '')}</span>
          <span class="counts">${s.pages.length} page(s), ${s.blocks} block(s), ${s.openFindings.length} open</span>
        </summary>
        <div class="body">
          <p class="path">${esc(s.project || '')}</p>
          ${rules ? `<ul class="rules">${rules}</ul>` : '<p class="note">No verdict yet: the session has not ended a turn since its last edit.</p>'}
          <ol class="timeline">${tl}
          </ol>
        </div>
      </details>`;
  }).join('');

  const rate = t.rate === null ? 'n/a' : `${Math.round(t.rate * 100)}%`;
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent observability</title>
<style>
${theme}
*{box-sizing:border-box;margin:0}
html{color-scheme:light}
:root[data-theme="dark"]{color-scheme:dark}
body{font-family:var(--font-sans);background:var(--color-surface-page);color:var(--color-text-primary);line-height:var(--leading-normal);font-size:var(--text-base)}
main{max-inline-size:72rem;margin-inline:auto;padding:var(--space-6) var(--space-4) var(--space-12)}
header{display:grid;gap:var(--space-2);margin-block-end:var(--space-8)}
.eyebrow{font-size:var(--text-sm);color:var(--color-text-secondary)}
h1{font-size:var(--text-3xl);line-height:var(--leading-snug)}
.lead{display:grid;gap:var(--space-6);padding:var(--space-6);background:var(--color-surface-card);border:var(--border-width-thin) solid var(--color-border-default);border-radius:var(--radius-card);margin-block-end:var(--space-8)}
.rate{font-size:var(--text-6xl);line-height:var(--leading-tight);font-weight:700}
.rate-label{color:var(--color-text-secondary)}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}
.facts div{display:grid;gap:var(--space-1)}
.facts dt{font-size:var(--text-sm);color:var(--color-text-secondary)}
.facts dd{font-size:var(--text-xl);font-weight:600}
h2{font-size:var(--text-xl);margin-block-end:var(--space-4)}
.sessions{display:grid;gap:var(--space-3)}
.session{background:var(--color-surface-card);border:var(--border-width-thin) solid var(--color-border-default);border-radius:var(--radius-card)}
.session summary{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-4);padding:var(--space-4);cursor:pointer;border-radius:var(--radius-card);min-block-size:2.75rem}
.session summary:hover{background:var(--color-surface-raised)}
.session summary:focus-visible{outline:none;box-shadow:var(--shadow-focus-ring)}
.session summary::-webkit-details-marker{display:none}
.chev{inline-size:var(--space-4);block-size:var(--space-4);flex:none;color:var(--color-text-secondary);transition:transform var(--duration-fast) var(--ease-out)}
.session[open] .chev{transform:rotate(90deg)}
.session summary:active{background:var(--color-surface-brand)}
.verdict{font-weight:600;font-size:var(--text-sm);padding:var(--space-1) var(--space-2);border-radius:var(--radius-sm);border:var(--border-width-thin) solid currentColor}
.verdict.ok,.mark.ok{color:var(--color-feedback-success)}
.verdict.bad,.mark.bad{color:var(--color-text-error)}
.verdict.warn{color:var(--color-feedback-warning)}
.verdict.muted{color:var(--color-text-secondary)}
.sid{font-family:ui-monospace,monospace;font-size:var(--text-sm)}
.when,.counts,.path,.note{color:var(--color-text-secondary);font-size:var(--text-sm)}
.proj{font-weight:600;overflow-wrap:anywhere;min-inline-size:0}
.body{padding:0 var(--space-4) var(--space-4);display:grid;gap:var(--space-4)}
.path{overflow-wrap:anywhere}
.rules{list-style:none;padding:0;display:grid;gap:var(--space-2)}
.mark{font-weight:700;text-transform:uppercase;font-size:var(--text-xs)}
.timeline{list-style:none;padding:0;display:grid;gap:var(--space-2);border-block-start:var(--border-width-thin) solid var(--color-border-default);padding-block-start:var(--space-4)}
.tl{display:grid;grid-template-columns:5rem minmax(0,1fr);gap:var(--space-2);font-size:var(--text-sm);overflow-wrap:anywhere}
.tl time{font-family:ui-monospace,monospace;color:var(--color-text-secondary)}
.tl-block span,.tl-released span,.tl-finding span,.tl-gate-fail span{color:var(--color-text-error);font-weight:600}
.tl-pass span,.tl-gate-pass span{color:var(--color-feedback-success)}
.detail{grid-column:2;padding-inline-start:var(--space-4);color:var(--color-text-secondary)}
.empty{padding:var(--space-8);background:var(--color-surface-card);border:var(--border-width-thin) solid var(--color-border-default);border-radius:var(--radius-card);display:grid;gap:var(--space-2)}
footer{margin-block-start:var(--space-8);color:var(--color-text-secondary);font-size:var(--text-sm)}
p,.rules li{max-inline-size:65ch}
@media (min-width:48rem){
  main{padding-inline:var(--space-8)}
  .lead{grid-template-columns:minmax(0,1fr) minmax(0,2fr);align-items:center}
  .facts{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<main>
  <header>
    <p class="eyebrow">ux-ui-agent-skills, last ${esc(sum.days)} day(s)${sum.project ? `, ${esc(basename(sum.project))}` : ', every project'}</p>
    <h1>Did the agent follow the rules?</h1>
  </header>
  ${ui.length ? `
  <section class="lead" aria-labelledby="rate-h">
    <div>
      <p class="rate" id="rate-h">${esc(rate)}</p>
      <p class="rate-label">of finished sessions followed every rule (${t.followed} of ${judged})</p>
    </div>
    <dl class="facts">
      <div><dt>Broke a rule</dt><dd>${t.broke}</dd></div>
      <div><dt>Pages edited</dt><dd>${t.pagesEdited}</dd></div>
      <div><dt>Stop hook blocks</dt><dd>${t.blocks}</dd></div>
      <div><dt>Finished while blocked</dt><dd>${t.released}</dd></div>
      <div><dt>Findings caught on write</dt><dd>${t.findings}</dd></div>
      <div><dt>Findings still open</dt><dd>${t.openFindings}</dd></div>
    </dl>
  </section>
  <section aria-labelledby="sessions-h">
    <h2 id="sessions-h">Sessions that edited UI (${ui.length})</h2>
    <div class="sessions">${rows}
    </div>
  </section>` : `
  <section class="empty">
    <h2>No session edited a UI file in this window</h2>
    <p>${t.sessions} session(s) were seen. Events are written by the plugin hooks from 2.10.0 on, and DS_OBSERVE=0 turns them off.</p>
  </section>`}
  <footer>
    <p>Generated ${esc(sum.generated.slice(0, 16).replace('T', ' '))} UTC from local hook events and gate receipts. Nothing here was sent anywhere. These are counts of rules kept, not a judgement of design quality.</p>
  </footer>
</main>
<script>
  try { if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark'; } catch {}
</script>
</body>
</html>
`;
}

/* ---------- cli ---------- */

function main(argv) {
  const opt = { days: 7, project: null, session: null, last: false, json: false, html: null, data: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : null);
    if (a === '--days') opt.days = Number(next()) || 7;
    else if (a === '--project') opt.project = resolve(next() || process.cwd());
    else if (a === '--session') opt.session = next();
    else if (a === '--last') opt.last = true;
    else if (a === '--json') opt.json = true;
    else if (a === '--html') opt.html = next() || 'observe.html';
    else if (a === '--data') opt.data = next();
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/Usage:[\s\S]*?\*\//)[0].replace(/\n \*\/?/g, '\n').replace(/ \*/g, ''));
      return 0;
    } else { console.error(`observe: unknown option ${a}`); return 2; }
  }
  if (opt.session || opt.last) opt.days = Math.max(opt.days, 30);

  const dirs = dataDirs({ data: opt.data });
  const events = loadEvents(dirs);
  const projects = [...new Set(events.map(e => e.project).filter(Boolean))];
  const sum = summarize(events, loadReceipts(dirs, projects), { days: opt.days, project: opt.project });

  if (opt.session || opt.last) {
    const ui = sum.sessions.filter(s => s.verdict !== 'no_ui');
    const s = opt.last ? ui[0] : sum.sessions.find(x => x.session.startsWith(opt.session));
    if (!s) { console.error(opt.last ? 'observe: no session edited UI in the last 30 days.' : `observe: no session starts with ${opt.session}.`); return 1; }
    if (opt.json) console.log(JSON.stringify({ ...s, timeline: timeline(s) }, null, 2));
    else console.log(renderTimeline(s));
    return 0;
  }
  if (opt.html) {
    writeFileSync(opt.html, renderHtml(sum));
    console.log(`observe: wrote ${resolve(opt.html)}`);
    return 0;
  }
  if (opt.json) {
    console.log(JSON.stringify({ ...sum, sessions: sum.sessions.map(({ events: _e, ...s }) => s) }, null, 2));
    return 0;
  }
  console.log(renderText(sum));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
