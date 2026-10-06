// ============================================================
// chat.js — Netlify serverless function  (RippelAI / Rippel Matrix)
// Read-only AI layer over the Matrix Supabase data.
//
// 06-10-2026: added get_unit_component_cost — component-only cost of one
// finished RLL or GRN40, rolled up from the BOM readiness view and priced
// first from the Component Pricing screen (frm_pricing.py →
// component_pricing), then from the latest purchase PO line (service POs
// excluded). component_pricing is also added to the query_data sources.
// Nothing else changed.
// System prompt gains a COMPONENT COST section; stock_items source
// description now mentions its price columns. Nothing else changed.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const VAT_RATE = 0.15;

// Business facts used by the tools (stated by Gerhard)
const PROJECT_400      = '2026 400 RLL';
const DEADLINE_400     = '2026-11-30';   // 400 RLLs to be delivered by end November 2026
const DEFAULT_PAY_DAYS = 30;             // suppliers paid 30 days after delivery (subject to QC)

const SYSTEM_PROMPT = `You are RippelAI, an internal financial and production
intelligence assistant for Rippel Effect Systems, a South African firearms
manufacturer. Your users are Fritz (CEO/MD), Siva (Finance), and Michiel
(Technical Manager). Currency is always South African Rand (ZAR). The
system is called Rippel Matrix, or "Matrix" for short.

Product lines: XRGL40, GRN40, and RLL. Projects (e.g. "2026 400 RLL",
"2026 1100 GRN") group POs and spending — a project is not the same as
a product line.

CORE GUARDRAIL (applies to every answer):
Never invent financial, project, schedule, costing or operational data.
Use only data returned by tools. Clearly distinguish actual, budget,
committed, estimated and forecast values. If information needed to answer
a question is unavailable, explicitly state what is missing rather than
guessing or estimating. Never imply a calculation was done in software if
it was not.

PRODUCT NOTES:
- RLL is a gun build. Components live in RLL Store, COTS Store, Holding
  Store. Cross-store availability from XRGL/GRN40 stores reported when relevant.
- GRN40 is a SIGHT build, not a gun. Components live in GRN40 Store, COTS
  Store (pooled), Holding Store only — never RLL/XRGL stores.
- RLL launchers do not carry sights. XRGL40 launchers carry a GRN40 sight.

COMPONENT COST PER UNIT:
- Component prices ARE held in Matrix: the Component Pricing screen
  (invoice prices, table component_pricing) is the main source, and every
  PO line carries a unit price (excl VAT). Never say costing is not in the
  system. stock_items.unit_price is mostly empty — never use
  it to conclude a part has no price.
- "What does an RLL / a GRN40 sight cost to build", "component cost per
  unit", "BOM cost" -> get_unit_component_cost (product RLL or GRN40).
- That figure is an ESTIMATED standard cost: quantity per finished unit
  from the BOM x the price on file. It is NOT actual project spend — say
  so. It covers component purchase price only: outside processing
  (LSO/ESO), annealing, paint/sand, freight, labour and overheads are
  excluded — say so in one line.
- Always state how many BOM lines were priced and how many were not. If
  any line has no price, the total is understated — say so and list the
  unpriced lines when asked.
- XRGL40 has no BOM view the assistant can read yet — say so plainly.
- Show the total excl. VAT, VAT and incl. VAT, then the cost by
  sub-assembly and the costliest lines.
- Do not refer the user to "the Matrix admin" or to another person for
  data that a tool can return.

KEY PROJECT AND DEADLINE:
- Project "2026 400 RLL": 400 RLL units must be DELIVERED by the end of
  November 2026 (30 Nov 2026). It is the first project and the template
  for the others. The tools report days remaining to that deadline.
- FOUR DISTINCT QUESTIONS on the RLL build — keep them separate, each
  has its own tool, never mix finished guns with sub-builds, and answer
  ONLY the question asked:
  1) "How many and which sub-builds are completed?" -> get_sub_builds_completed
  2) "Which sub-builds are hampering the process?" -> get_sub_builds_hampering
  3) "Which sub-builds should be prioritised to speed things up?" -> get_sub_build_priorities
  4) "How many guns are assembled and have serials allocated?" ->
     get_rll_units_built. ONLY call this tool for question 4 (or when the
     user asks about finished guns / serial numbers). Never call it for
     questions 1-3 or for shortages. It reports assembled guns from the
     Production Progress position FIRST (step 1), then the Blue Card serial
     register (step 2), which can include test builds from the tablets —
     say so if that count is tiny.
  Sub-builds are the BOM sub-assemblies. Questions 1-3 use the same method
  and the same views as the Matrix Production Progress screen (sets of each
  assembly counted recursively: built, buildable from shelf, in process,
  on order, no cover) and the Build Sequence rules, so your numbers match
  what the team sees on that screen.
- For part-level shortages and "will we make the date" use
  get_rll_deadline_risk and get_project_progress; for assembly work still
  open use get_open_work_orders. These plan against the full 400 target;
  sub-assemblies already on the shelf are credited automatically through
  parent coverage. They do not use the gun register.
- PRIORITISATION ORDER when recommending what to expedite:
  1) parts NOT ordered at all (nothing on order) — the longest lead time
     first; if the known lead time is longer than the days remaining the
     deadline cannot be met for that part without a shortcut;
  2) parts on order with NO committed date or an ETA AFTER 30 Nov;
  3) parts on order but only partly covering the need;
  4) parts stuck in Holding Store processes (machining, anodizing,
     external service) — chase the process step, do not raise a new PO;
  5) assembly work orders still outstanding.
  Say clearly when a lead time or committed date is missing — never
  estimate one. Say which sub-assemblies gate the final build.
- Do not claim a "% complete" for the whole gun unless a tool returned it.
  The progress tool reports material coverage per BOM line, which is not
  the same as build completion. Build time per sub-build is NOT held in
  the system, so never state a build-time estimate.

STOCK/BUILD READINESS RULES:
- "Available" = physical qty MINUS parts reserved to open Work Orders
  MINUS parts out on open Service Orders (LSO/ESO) — both already committed
  and unusable for a new build even though they may still show in stock_qty.
- "Holding Store WIP" = parts mid-process (machining, anodizing, external
  service) — not yet usable. Action: chase the process step, not a new PO.
- "On Order" = not yet received — informational only, never counts as available.
- Parent-assembly partial coverage: if a parent has some units built on the
  shelf, child parts only need to cover the parent's REMAINING gap.
- If parent fully covers the need, child shortages are not real blockers.

FINANCE / PO RULES (permanent business knowledge):
- PMS/FINANCE GRANULARITY: a single PMS PO can have multiple deliveries/
  batches (separate po_lines rows) to control stock intake timing and
  cashflow. Finance always pays and records against the PO AS A WHOLE
  (po_base) — never against one delivery line. Never compare a Finance
  payment to a single po_lines row; always aggregate PMS data to po_base
  level first, or the comparison is invalid and will show false mismatches.
- VAT: every PMS PO value EXCLUDES 15% VAT. Siva's Finance payment figures
  and all payment/cashflow PLANNING numbers include 15% VAT — that is what
  actually gets paid. ALWAYS show three figures: the amount excl. VAT, the
  VAT amount (15%), and the amount incl. VAT. Never show only one.
- PAYMENT TERMS: suppliers are paid 30 days after delivery, subject to QC
  and any rejections. There is no per-supplier payment-terms field in the
  system, so 30 days after delivery is the DEFAULT assumption — say so
  whenever you give a payment date. Dates derived this way are FORECASTS.
- RECEIPT AGEING: Finance records payments per PO, not per delivery, so
  when ageing unpaid goods the tool applies a PO's payments to its OLDEST
  deliveries first. State that assumption when you give ageing figures.
- THREE PAYABLES BUCKETS (per PO base, excl. VAT):
  received-not-paid (goods in, Finance has not paid it yet),
  paid-not-received (prepaid/deposit, goods not yet in — "limbo"),
  ordered-not-received (still to be delivered, commitment).
  Finance payments that match no PMS PO (non-PMS or UNKNOWN PO) are NOT
  counted in these buckets; they are reported separately.
- Finance payments only exist in the system from when the SharePoint sync
  started. A PO with goods received and no Finance record may have been
  paid before the sync — flag it for review, do not call it unpaid debt.
- "finance_pending" = an amount Finance has SCHEDULED for an upcoming bank
  run. It has NOT been paid yet. It is a planned outflow, not a problem.
- outcome = "AMOUNT DIFFERENCE" is usually NOT an error — it typically
  means more stock was received than the PO originally specified, so the
  invoiced amount legitimately exceeds the original PO value. Report the
  difference factually; do not call it a discrepancy by default.
- PCA vs POA reference prefix: "POA..." = normal payment for goods/stock.
  "PCA..." = a CREDIT reference — either a supplier credit note reducing
  what's owed, OR a penalty deducted because the supplier missed their
  committed delivery date. Never read a PCA as unexplained spend.
- Supplier deposits: some suppliers require an upfront deposit before
  starting a job. A deposit against a PO with no delivery yet is NORMAL,
  not a discrepancy.
- "#" mark on an invoice number: Siva marks legacy (non-PMS) POs with "#"
  — that line is excluded from sync and never reaches the reconciliation.
- outcome = "UNKNOWN PO": the sync could not match a payment to a PMS PO.
  This is a FLAG TO INVESTIGATE, not an automatic error — it may be a
  legacy PO not yet marked "#", something unrelated to current projects,
  or a genuine mapping error. Never dismiss it, never call it a confirmed
  error.
- outcome = "MATCHED": Finance and PMS agree — no action needed.
- PROJECT FINANCIALS: budgets and contract values are NOT yet loaded for
  any project (budget is R0 everywhere; the contracts and deposits tables
  are empty). Never state profit, margin or budget remaining for a project
  until a tool returns real values. Say the data has not been captured yet.

Never guess. Always call the appropriate tool. Always state currency as
R (ZAR). Be concise and direct — these are busy operational stakeholders.

GENERAL QUESTIONS (no specific tool fits): use list_data_sources, then
list_data_sources(source) to get that source's REAL columns, then query_data
(filters, sorting, or group_by with sum_columns for totals). Never guess a
column name. Prefer a specific tool when one fits. Use at most three or four
query_data calls per answer, and say plainly if the data needed is not in any
available source. Remember "po_lines" values exclude 15% VAT and Finance pays
per PO, not per line.

ANSWER LENGTH (important — long answers time out): keep every answer under
about 350 words. Use ONE compact table for lists, show at most the top 10-15
rows and say how many more there are, and never repeat the same data in a
table and again in prose. Lead with the answer, then the table, then at most
three short action points. Offer detail only if asked.

SHOWING ALL ROWS: tools cap their lists, and every capped list reports
"shown" and "total". Always say plainly when you are showing only part of a
list ("showing 20 of 37"). When the person asks for "all", "the rest", "the
full list" or "the remaining ones": for the deadline-risk view call
get_rll_deadline_risk again with show_all=true; for the component cost call
get_unit_component_cost again with show_all=true; for anything else use
query_data on the underlying source with a higher limit (up to 200). Then
list EVERY row as one compact table with no extra prose, up to 60 rows; if
there are more than 60, show the first 60 and offer the next batch. Never
reply that the rows exist without showing them when asked for them.`;

const TOOLS = [
  {
    name: 'get_rll_shortfall',
    description: 'Genuine, actionable stock shortages preventing a build of N '
      + 'RLL units (default 1). Accounts for WO/service-order commitments, '
      + 'parent-assembly partial coverage, Holding Store WIP, on-order '
      + 'quantities, and cross-store availability. Use for RLL readiness, '
      + 'build blockers, or ordering questions.',
    input_schema: { type: 'object', properties: {
      qty: { type: 'integer', description: 'RLL units to check. Defaults to 1.' }
    }}
  },
  {
    name: 'get_grn40_shortfall',
    description: 'Genuine, actionable stock shortages preventing a build of N '
      + 'GRN40 sights (default 1). Components in GRN40 Store, COTS Store '
      + '(pooled), Holding Store. Accounts for WO/service-order commitments, '
      + 'parent-assembly partial coverage, WIP, on-order. Use for GRN40 '
      + 'readiness or what needs to be ordered.',
    input_schema: { type: 'object', properties: {
      qty: { type: 'integer', description: 'GRN40 units to check. Defaults to 1.' }
    }}
  },
  {
    name: 'get_unit_component_cost',
    description: 'ESTIMATED component cost of ONE finished RLL or GRN40 sight: '
      + 'BOM quantity per unit x the latest price on the Component Pricing '
      + 'screen, else the latest purchase PO line price, excl VAT, '
      + 'VAT and incl VAT, with cost per sub-assembly, the costliest lines, '
      + 'and every line with no price. Component purchase price only — '
      + 'excludes outside processing, annealing, paint, freight, labour and '
      + 'overheads. Use for "what does an RLL cost to build", "component '
      + 'cost per unit", "BOM cost".',
    input_schema: { type: 'object', properties: {
      product: { type: 'string', description: 'RLL or GRN40. Defaults to RLL.' },
      show_all: { type: 'boolean', description: 'Set true when the person asks for all lines / the full list. Raises the line list cap from 15 to 60.' }
    }}
  },
  {
    name: 'get_rll_units_built',
    description: 'QUESTION 4 for the RLL build: how many guns are assembled '
      + '(from the Production Progress position) and then how many serial '
      + 'numbers are allocated (from the Blue Card serial register, counts by '
      + 'status, may include test builds). Call ONLY when asked about '
      + 'finished/assembled guns or serial allocation — never for '
      + 'sub-builds, shortages or priorities.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_sub_builds_completed',
    description: 'QUESTION 1 for the RLL build: how many sub-builds (BOM '
      + 'sub-assemblies) are completed and which ones, measured against the '
      + 'quantity still needed. Lists complete, partly done, in a Holding '
      + 'Store process, and not started. Use for "how many sub builds are '
      + 'done / which are completed". This is about SUB-ASSEMBLIES, not '
      + 'finished guns (use get_rll_units_built for guns). Same method as the Matrix Production Progress screen.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_sub_builds_hampering',
    description: 'QUESTION 2 for the RLL build: which incomplete sub-builds '
      + 'are being held up, and by exactly what (parts not ordered, partly '
      + 'ordered, on order with a late or missing date, or a sub-assembly '
      + 'that is itself short). Use for "what is hampering/blocking the '
      + 'build process".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_sub_build_priorities',
    description: 'QUESTION 3 for the RLL build: which sub-builds to '
      + 'prioritise to speed up the whole build, in order: unblock first '
      + '(order now), then chase dates, then sub-builds that can be started '
      + 'right now from stock. Use for "what is the priority to enhance/'
      + 'expedite the process".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_project_progress',
    description: 'Material coverage for the 2026 400 RLL build per BOM line: '
      + 'how much of the total need is ready, in Holding Store WIP, on order '
      + 'or still a gap, with the worst lines listed. This is material '
      + 'coverage, NOT a % complete of finished guns. Use for "how far are '
      + 'we" and "what is still short" questions on the 400 RLL project.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_rll_deadline_risk',
    description: 'Deadline-risk view for the RLL build against 30 Nov 2026: '
      + 'parts NOT ordered (with known lead time vs days remaining), parts '
      + 'on order with no committed date or an ETA after the deadline, '
      + 'partially ordered parts, and parts stuck in Holding Store '
      + 'processes. Use for "what must be prioritised/expedited", "will we '
      + 'make the date" and "what processes are outstanding". qty defaults '
      + 'to the full project target (400).',
    input_schema: { type: 'object', properties: {
      qty: { type: 'integer', description: 'RLL units to plan for. Defaults to the project target (400).' },
      show_all: { type: 'boolean', description: 'Set true when the person asks for all rows / the rest / the full list. Raises the per-list cap from 20-25 to 60.' }
    }}
  },
  {
    name: 'get_open_work_orders',
    description: 'Open work orders for a project (final assembly still '
      + 'outstanding) plus open service orders (external processes out at '
      + 'suppliers). Use for "what processes still need to be done" and '
      + 'assembly-status questions.',
    input_schema: { type: 'object', properties: {
      project_name: { type: 'string', description: 'Project name. Defaults to "2026 400 RLL".' }
    }}
  },
  {
    name: 'get_open_po_value',
    description: 'True cash position on open POs, aggregated per PO base and '
      + 'counting only POs that exist in the PMS: committed, already paid, '
      + 'scheduled-pending, and net still owed — excl VAT, VAT and incl VAT. '
      + 'Finance payments that match no PMS PO are reported separately, not '
      + 'subtracted. Use for PO exposure, outstanding commitments, cashflow.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_payables_summary',
    description: 'Three-bucket payables per PO base: received-not-paid, '
      + 'paid-not-received (prepaid/limbo) and ordered-not-received, with '
      + 'the biggest POs and suppliers in each bucket, all excl VAT, VAT and '
      + 'incl VAT. Optional project filter. Use for "what do we owe", '
      + '"what have we received but not paid", payables questions.',
    input_schema: { type: 'object', properties: {
      project_name: { type: 'string', description: 'Optional project name to filter by.' }
    }}
  },
  {
    name: 'get_prepaid_limbo',
    description: 'POs where Finance has paid more than has been received — '
      + 'deposits/prepayments with goods still outstanding — with supplier, '
      + 'amount, and whether the committed delivery date has passed. Use for '
      + '"what money is tied up in deposits" or "what have we paid for but '
      + 'not received".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_supplier_spend',
    description: 'Per-supplier totals: PO count, committed, received, paid, '
      + 'still outstanding, received-not-paid and prepaid, excl VAT, VAT and '
      + 'incl VAT. Optional supplier name filter (partial match). Use for '
      + '"how much have we spent with X" or "who are our biggest suppliers".',
    input_schema: { type: 'object', properties: {
      supplier: { type: 'string', description: 'Optional supplier name (partial match).' }
    }}
  },
  {
    name: 'get_receipt_ageing',
    description: 'Ageing of goods RECEIVED but not yet paid, using the actual '
      + 'delivery (receipt) dates from po_deliveries. Finance pays per PO, so '
      + 'payments are applied oldest delivery first within each PO. Shows how '
      + 'many days since receipt, what is past the 30-day term, and by '
      + 'supplier, excl VAT, VAT and incl VAT. Use for "which suppliers are '
      + 'we late paying", "what is overdue for payment", "ageing of '
      + 'creditors".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_payment_schedule',
    description: 'FORECAST cash required for supplier payments, using the '
      + 'default term of 30 days after delivery: amounts already received '
      + 'but not paid, forecast payments by month for deliveries still to '
      + 'come (net of any prepaid deposit), and late deliveries whose '
      + 'payment date cannot be forecast, with the supplier named. Use for '
      + 'cashflow planning and "which suppliers are late" questions.',
    input_schema: { type: 'object', properties: {
      days: { type: 'integer', description: 'Days ahead for the near-term window. Defaults to 30.' }
    }}
  },
  {
    name: 'get_po_reconciliation_summary',
    description: 'Summary of PMS-vs-Finance PO reconciliation: count and total '
      + 'value per outcome category (MATCHED, AMOUNT DIFFERENCE, UNKNOWN PO, '
      + 'NOT YET PAID PER FINANCE). Use for overall reconciliation health or '
      + '"do our numbers match Finance" questions.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_po_reconciliation_issues',
    description: 'Detailed list of POs needing attention in the Finance '
      + 'reconciliation, filtered by outcome category. Includes supplier, '
      + 'difference amount, credit notes, and finance documents per line. '
      + 'Use when asked to list, investigate, or explain specific '
      + 'reconciliation problems (not just the summary count).',
    input_schema: { type: 'object', properties: {
      outcome_filter: {
        type: 'string',
        description: 'One of: AMOUNT DIFFERENCE, UNKNOWN PO, NOT YET PAID PER FINANCE, MATCHED. Omit to return all non-MATCHED issues.'
      }
    }}
  },
  {
    name: 'get_project_financial_summary',
    description: 'Financial summary for a named project: approved budget, '
      + 'total ordered, total received, total committed (incl. any '
      + 'over-receipt), remaining budget, and % of budget consumed. Also '
      + 'breaks committed value down by product. Use for project financial '
      + 'health, cost-to-complete, or budget-vs-actual questions.',
    input_schema: { type: 'object', properties: {
      project_name: {
        type: 'string',
        description: 'Exact project name/code as used in the PMS, e.g. "2026 400 RLL", "2026 1100 GRN". Required.'
      }
    }, required: ['project_name'] }
  },
  {
    name: 'list_data_sources',
    description: 'Lists the tables and views the assistant is allowed to read, '
      + 'with a one-line description of each. Pass a source name to also get '
      + 'its REAL column names and one sample row (always do this before '
      + 'query_data on a source you have not used in this conversation — never '
      + 'guess column names). Use for any question no specific tool covers.',
    input_schema: { type: 'object', properties: {
      source: { type: 'string', description: 'Optional table/view name to get its columns and a sample row.' }
    }}
  },
  {
    name: 'query_data',
    description: 'Flexible READ-ONLY lookup on one allowed table/view: choose '
      + 'columns, filter, sort, limit — or group and total. Use for questions '
      + 'the specific tools do not cover. Prefer a specific tool when one '
      + 'fits. Call list_data_sources(source) first to get real column names. '
      + 'Keep it to a few calls per answer. For totals/counts per group set '
      + 'group_by (and sum_columns); otherwise rows are returned (max 200).',
    input_schema: { type: 'object', properties: {
      source:  { type: 'string', description: 'Allowed table/view name from list_data_sources.' },
      select:  { type: 'string', description: 'Comma-separated column names, or * (default). No functions or joins.' },
      filters: { type: 'array', description: 'AND-ed conditions.', items: { type: 'object', properties: {
        column: { type: 'string' },
        op:     { type: 'string', description: 'eq, neq, gt, gte, lt, lte, like, ilike, in, is_null, not_null' },
        value:  { description: 'Value to compare (array for "in"; use % wildcards for like/ilike). Not needed for is_null/not_null.' }
      }, required: ['column', 'op'] } },
      order_by:  { type: 'string', description: 'Column to sort by (rows mode).' },
      descending:{ type: 'boolean', description: 'Sort descending. Default false.' },
      limit:     { type: 'integer', description: 'Max rows/groups. Default 50, max 200.' },
      group_by:  { type: 'string', description: 'Column to group by; returns one row per value with a count and sums.' },
      sum_columns: { type: 'array', items: { type: 'string' }, description: 'Numeric columns to total per group (with group_by).' }
    }, required: ['source'] }
  },
  {
    name: 'list_projects',
    description: 'Returns all project names/codes currently in the system, '
      + 'with their budget and status. Use when the user asks what projects '
      + 'exist, or names a project ambiguously and you need to find the '
      + 'exact project_name to pass to get_project_financial_summary.',
    input_schema: { type: 'object', properties: {} }
  }
];

// ── Helpers ─────────────────────────────────────────────────────────────────

// Short-lived cache (warm function instances only) so the same heavy view is
// not queried several times inside one conversation.
const _cache = new Map();
async function cached(key, ttlMs, loader) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await loader();
  if (!v || !v.error) _cache.set(key, { t: Date.now(), v });
  return v;
}


const num = v => Number(v) || 0;
const r2  = v => Math.round((v + Number.EPSILON) * 100) / 100;

// Three-figure VAT presentation: excl, VAT, incl
function vat3(excl) {
  const e = num(excl);
  return { excl_vat_zar: r2(e), vat_zar: r2(e * VAT_RATE), incl_vat_zar: r2(e * (1 + VAT_RATE)) };
}

// Supabase returns max ~1000 rows per request — page through everything.
async function fetchAll(table, cols, opts = {}) {
  const out = [];
  const size = 1000;
  const maxRows = opts.maxRows || 50000;
  for (let from = 0; from < maxRows; from += size) {
    let q = supabase.from(table).select(cols).range(from, from + size - 1);
    if (opts.order) q = q.order(opts.order, { ascending: true });
    if (opts.mod)   q = opts.mod(q);
    const { data, error } = await q;
    if (error) return { error: `Query on ${table} failed: ${error.message}` };
    out.push(...data);
    if (data.length < size) break;
  }
  return { data: out };
}

function pick(row, keys) {
  const o = {};
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) o[k] = row[k];
  return o;
}

function daysUntil(isoDate) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(isoDate + 'T00:00:00');
  return Math.round((d - today) / 86400000);
}

// ── Shared BOM shortfall logic (unchanged behaviour) ────────────────────────

function buildShortfallResult(allRows, qty, needCol) {
  const scaledRows = allRows.map(row => ({
    ...row,
    scaled_need: (row[needCol] || 0) * qty
  }));
  const byId = {};
  for (const row of scaledRows) if (row.component_id) byId[row.component_id] = row;

  function effectiveNeed(row) {
    const parent = row.dependant_code ? byId[row.dependant_code] : null;
    if (!parent) return row.scaled_need;
    if (parent.available_qty >= parent.scaled_need) return 0;
    return Math.max(0, parent.scaled_need - parent.available_qty) * row.req_per_unit;
  }

  return scaledRows
    .filter(row => {
      if (row.build_status === 'CONTAINER') return false;
      const parent = row.dependant_code ? byId[row.dependant_code] : null;
      if (parent && parent.available_qty >= parent.scaled_need) return false;
      const need = effectiveNeed(row);
      return Math.max(0, need - row.available_qty - row.holding_qty - row.on_order_qty) > 0;
    })
    .map(r => {
      const need = effectiveNeed(r);
      const needsSourcing = Math.max(0, need - r.available_qty - r.holding_qty - r.on_order_qty);
      const out = {
        item_name: r.item_name, stock_code: r.stock_code, storeroom: r.storeroom,
        available: r.available_qty, holding_wip: r.holding_qty, on_order: r.on_order_qty,
        supplier_eta: r.supplier_earliest_eta, needed: need, needs_sourcing: needsSourcing,
      };
      if ((r.wo_committed_qty || 0) > 0) out.wo_committed = r.wo_committed_qty;
      if ((r.so_committed_qty || 0) > 0) out.so_committed = r.so_committed_qty;
      return out;
    });
}

// Same effective-need logic, but returns every non-container row with its need
function computeNeeds(allRows, qty, needCol) {
  const scaled = allRows.map(row => ({ ...row, scaled_need: (row[needCol] || 0) * qty }));
  const byId = {};
  for (const row of scaled) if (row.component_id) byId[row.component_id] = row;
  const out = [];
  for (let i = 0; i < scaled.length; i++) {
    const row = scaled[i];
    const orig = allRows[i];
    if (row.build_status === 'CONTAINER') continue;
    const parent = row.dependant_code ? byId[row.dependant_code] : null;
    let need;
    if (!parent) need = row.scaled_need;
    else if (parent.available_qty >= parent.scaled_need) need = 0;
    else need = Math.max(0, parent.scaled_need - parent.available_qty) * row.req_per_unit;
    out.push({ row, orig, need });
  }
  return out;
}

async function getCrossStoreMap() {
  const { data } = await supabase
    .from('stock_items').select('stock_code, stock_qty, storeroom')
    .in('storeroom', ['XRGL Store', 'GRN40 Store', 'RLL Legacy Store']).gt('stock_qty', 0);
  const map = {};
  for (const row of (data || [])) {
    const code = row.stock_code ? row.stock_code.split('_')[0] : '';
    if (code) map[code] = (map[code] || 0) + row.stock_qty;
  }
  return map;
}

const RLL_READINESS_COLS =
  'component_id, dependant_code, item_name, stock_code, storeroom, '
  + 'available_qty, wo_committed_qty, so_committed_qty, holding_qty, '
  + 'on_order_qty, supplier_earliest_eta, need_for_1_rll, req_per_unit, '
  + 'shortfall, build_status, is_assembly_group';

// ── Stock tools ──────────────────────────────────────────────────────────────

async function get_rll_shortfall(qty = 1) {
  const [{ data: allRows, error }, crossStoreMap, ltRes] = await Promise.all([
    cached('rll_readiness', 45000, async () => supabase.from('v_rll_build_readiness').select(RLL_READINESS_COLS)),
    getCrossStoreMap(),
    supabase.from('part_lead_times').select('stock_code, supplier, lead_days').limit(5000)
  ]);
  if (error) return { error: `Query failed: ${error.message}` };
  const leadMap = {};
  for (const l of (ltRes.data || [])) if (l.stock_code) leadMap[l.stock_code] = l;

  const shortages = buildShortfallResult(allRows, qty, 'need_for_1_rll').map(r => {
    const crossStore = crossStoreMap[r.stock_code] || 0;
    const lt = leadMap[r.stock_code] || leadMap[(r.stock_code || '').split('_')[0]];
    return {
      ...r,
      lead_days: lt && lt.lead_days != null ? lt.lead_days : undefined,
      lead_time_on_file: lt ? undefined : false,
      other_store_stock: crossStore || undefined,
      other_store_note: crossStore >= r.needs_sourcing && crossStore > 0
        ? 'Fully covered by other product store stock — management transfer required'
        : crossStore > 0
          ? `${crossStore} available in other product stores — partial cover, transfer required`
          : undefined
    };
  });

  return { product: 'RLL', build_qty: qty, total_shortages: shortages.length, shortages };
}

async function get_grn40_shortfall(qty = 1) {
  const { data: allRows, error } = await supabase
    .from('v_grn40_build_readiness')
    .select('component_id, dependant_code, item_name, stock_code, storeroom, '
          + 'available_qty, wo_committed_qty, so_committed_qty, holding_qty, '
          + 'on_order_qty, supplier_earliest_eta, need_for_1_grn40, req_per_unit, '
          + 'shortfall, build_status, is_assembly_group');
  if (error) return { error: `Query failed: ${error.message}` };
  const shortages = buildShortfallResult(allRows, qty, 'need_for_1_grn40');
  return { product: 'GRN40', build_qty: qty, total_shortages: shortages.length, shortages };
}

// ── Component cost per finished unit (06-10-2026) ───────────────────────────
// ESTIMATED standard component cost of ONE finished unit.
//   Quantity: need_for_1_* from the BOM readiness view (quantity per finished
//             unit, the same column the shortfall tools scale by qty).
//   Lines:    leaf lines only (no BOM children), so an assembly is never
//             costed on top of its own parts; CONTAINER rows and STTE Store
//             rows skipped.
//   Price:    FIRST the Component Pricing screen (frm_pricing.py →
//             component_pricing): the latest record per part, ordered by
//             price_date then created_at, as on its Latest Prices tab.
//             Matched on stock_code (exact, then without the process
//             suffix, then the part's BN number from stock_items.
//             supplier_code), then on item name within the same product — the
//             Latest Prices tab itself groups by item name.
//             THEN, where nothing has been captured on that screen, the most
//             recent purchase PO line (po_lines.unit_price, excl VAT, any
//             project — a shared part costs the same whichever project
//             bought it): internal_part_no exact → base code →
//             supplier_item_code (BN number). Service POs (-GS / -RS / -XS)
//             and cancelled lines are ignored: those are process costs.
//             LAST, a pricing record with the same item name on another
//             product, flagged for checking.
//             stock_items.unit_price is NOT used: on LIVE only 2 of 812 rows
//             carry a price (06-10-2026).
//   Excludes: outside processing, annealing, paint/sand, freight, labour,
//             overheads. Read-only.

const COST_VIEWS = {
  RLL:   { view: 'v_rll_build_readiness',   needCol: 'need_for_1_rll',   label: 'RLL',         product: 'RLL' },
  GRN40: { view: 'v_grn40_build_readiness', needCol: 'need_for_1_grn40', label: 'GRN40 sight', product: 'GRN40' },
};

// Codes are compared case-blind, with long/short dashes and spacing made
// uniform ("BN8699 – M10 X 20MM" = "BN8699 - M10 x 20mm").
const normCode = c => String(c || '').toUpperCase().replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/\s+/g, ' ').trim();
const baseCode = c => normCode(c).split('_')[0].trim();
const normName = c => String(c || '').trim().toUpperCase().replace(/\s+/g, ' ');
const isServicePo = po => /-[GRX]S$/i.test(String(po || '').trim().split('/')[0]);

async function get_unit_component_cost(productArg, showAll) {
  const p = String(productArg || 'RLL').toUpperCase().replace(/\s+/g, '');
  const key = p === 'GRN' || p === 'GRN40SIGHT' ? 'GRN40' : p;
  const cfg = COST_VIEWS[key];
  if (!cfg) {
    return { error: `No BOM costing is available for "${productArg}". Available: RLL and GRN40. XRGL40 has no BOM readiness view the assistant can read yet.` };
  }

  const [bom, si, pl, cp] = await Promise.all([
    fetchAll(cfg.view, `component_id, dependant_code, item_name, stock_code, storeroom, build_status, is_assembly_group, ${cfg.needCol}`,
      { order: 'component_id' }),
    fetchAll('stock_items', '*', { order: 'id' }),
    fetchAll('po_lines', '*', { order: 'id', mod: q => q.gt('unit_price', 0) }),
    fetchAll('component_pricing', 'id, stock_item_id, item_name, stock_code, supplier, po_number, invoice_number, unit_price, currency, price_date, product, created_at',
      { order: 'id', mod: q => q.gt('unit_price', 0) })
  ]);
  if (bom.error) return { error: bom.error };
  if (bom.data.length === 0) return { error: `${cfg.view} returned no rows.` };
  if (pl.error)  return { error: pl.error };
  const cpWarning = cp.error ? `The Component Pricing records (component_pricing) could not be read (${cp.error}); PO prices only.` : null;

  const put = (map, k, rec) => {
    if (!k) return;
    const cur = map[k];
    map[k] = cur
      ? { ...rec, min: Math.min(cur.min, rec.price), max: Math.max(cur.max, rec.price), pos: cur.pos + 1 }
      : { ...rec, min: rec.price, max: rec.price, pos: 1 };
  };

  // Component Pricing screen records — sorted oldest → newest by price_date,
  // then created_at, so the latest record wins (same as its Latest Prices tab).
  const cpRows = (cp.data || [])
    .filter(r => !r.currency || String(r.currency).toUpperCase() === 'ZAR')
    .sort((x, y) => String(x.price_date || '').localeCompare(String(y.price_date || ''))
                 || String(x.created_at || '').localeCompare(String(y.created_at || '')));
  const cpCode = {}, cpBase = {}, cpOwn = {}, cpAny = {};
  let cpLinked = 0;
  for (const r of cpRows) {
    const rec = { price: num(r.unit_price), po: r.po_number || null, invoice: r.invoice_number || null,
                  date: r.price_date ? String(r.price_date).slice(0, 10) : null };
    if (normCode(r.stock_code)) { cpLinked++; put(cpCode, normCode(r.stock_code), rec); put(cpBase, baseCode(r.stock_code), rec); }
    const n = normName(r.item_name);
    put(cpAny, n, rec);
    if (String(r.product || '').toUpperCase().replace(/\s+/g, '') === cfg.product) put(cpOwn, n, rec);
  }

  // PO line price maps — ascending id, so the latest purchase price wins.
  const poExact = {}, poBase = {}, poBn = {};
  let serviceSkipped = 0, cancelledSkipped = 0;
  for (const r of pl.data) {
    if (isServicePo(r.po_number)) { serviceSkipped++; continue; }
    if (/cancel/i.test(String(r.line_status || ''))) { cancelledSkipped++; continue; }
    const rec = { price: num(r.unit_price), po: r.line_ref || r.po_number || null };
    put(poExact, normCode(r.internal_part_no), rec);
    put(poBase, baseCode(r.internal_part_no), rec);
    put(poBn, normCode(r.supplier_item_code), rec);
  }

  // BN number per stock code (stock_items.supplier_code), so a fastener
  // whose BOM line carries its 1E1 code still finds a price captured
  // against its BN number. Skipped quietly if stock_items can't be read.
  const bnFor = {};
  for (const r of (si.error ? [] : si.data)) {
    const c = normCode(r.stock_code), bn = normCode(r.supplier_code);
    if (c && bn && bn !== c && !bnFor[c]) bnFor[c] = bn;
  }

  const rows = bom.data.filter(r => r.storeroom !== 'STTE Store');
  const byId = {}, hasKids = new Set();
  for (const r of rows) {
    if (r.component_id) byId[r.component_id] = r;
    if (r.dependant_code) hasKids.add(r.dependant_code);
  }

  // Top-level sub-assembly a line rolls up to (the child of the root).
  const topOf = r => {
    let cur = r, guard = 0;
    while (cur && cur.dependant_code && byId[cur.dependant_code] && byId[cur.dependant_code].dependant_code && guard++ < 20) {
      cur = byId[cur.dependant_code];
    }
    if (!cur || !cur.dependant_code) return '(top level)';
    if (cur === r) return '(fitted directly to the final assembly)';
    return cur.item_name || cur.component_id || '(unnamed)';
  };

  const SOURCES = ['Pricing screen (part no)', 'Pricing screen (base part no)', 'Pricing screen (BN number)',
    'Pricing screen (item name)',
    'PO price (part no)', 'PO price (base part no)', 'PO price (BN number)',
    'Pricing screen (item name, other product)'];
  const bySource = Object.fromEntries(SOURCES.map(s => [s, 0]));
  const priced = [], unpriced = [], spread = [];
  const bySub = {};
  let total = 0;

  for (const r of rows) {
    if (r.build_status === 'CONTAINER') continue;
    if (r.component_id && hasKids.has(r.component_id)) continue;   // assembly: its parts are costed
    const qty = num(r[cfg.needCol]);
    if (qty <= 0) continue;
    const code = normCode(r.stock_code);
    const base = baseCode(code);
    const name = normName(r.item_name);
    const bn = bnFor[code] || bnFor[base] || null;

    const order = [[cpCode, code], [cpBase, base], [cpCode, bn], [cpOwn, name],
                   [poExact, code], [poBase, base], [poBn, code], [poExact, bn], [cpAny, name]];
    const srcIdx = [0, 1, 2, 3, 4, 5, 6, 6, 7];   // order entry → SOURCES label
    let hit = null, source = null;
    for (let i = 0; i < order.length; i++) {
      const [map, k] = order[i];
      if (k && map[k]) { hit = map[k]; source = SOURCES[srcIdx[i]]; break; }
    }

    const sub = topOf(r);
    if (!hit) {
      unpriced.push({ item_name: r.item_name, stock_code: r.stock_code, storeroom: r.storeroom, qty_per_unit: qty, sub_assembly: sub });
      continue;
    }
    const lineCost = qty * hit.price;
    total += lineCost;
    bySource[source]++;
    if (!bySub[sub]) bySub[sub] = { sub_assembly: sub, lines: 0, cost: 0 };
    bySub[sub].lines++; bySub[sub].cost += lineCost;
    priced.push({ item_name: r.item_name, stock_code: r.stock_code, sub_assembly: sub, qty_per_unit: qty,
      unit_price_excl_vat_zar: r2(hit.price), line_cost_excl_vat_zar: r2(lineCost),
      price_source: source, from: hit.po || undefined, invoice: hit.invoice || undefined,
      price_date: hit.date || undefined });
    if (hit.pos > 1 && hit.max > hit.min * 1.05) {
      spread.push({ item_name: r.item_name, stock_code: r.stock_code, price_used: r2(hit.price),
        lowest_on_file: r2(hit.min), highest_on_file: r2(hit.max), lines_on_file: hit.pos });
    }
  }

  const cap = showAll ? 60 : 15;
  priced.sort((a, b) => b.line_cost_excl_vat_zar - a.line_cost_excl_vat_zar);
  spread.sort((a, b) => (b.highest_on_file - b.lowest_on_file) - (a.highest_on_file - a.lowest_on_file));
  const part = list => ({ shown: Math.min(list.length, cap), total: list.length, rows: list.slice(0, cap) });
  const fromScreen = bySource[SOURCES[0]] + bySource[SOURCES[1]] + bySource[SOURCES[2]] + bySource[SOURCES[3]];
  const byName = bySource[SOURCES[3]] + bySource[SOURCES[7]];

  return {
    product: cfg.label,
    value_type: 'ESTIMATED standard component cost per finished unit — latest captured price x BOM quantity. NOT actual project spend.',
    component_cost_per_unit: vat3(total),
    bom_lines_costed: priced.length + unpriced.length,
    lines_priced: priced.length,
    lines_without_price: unpriced.length,
    price_sources_used: bySource,
    cost_by_sub_assembly: Object.values(bySub).sort((a, b) => b.cost - a.cost).slice(0, 25)
      .map(s => ({ sub_assembly: s.sub_assembly, lines: s.lines, ...vat3(s.cost) })),
    costliest_lines: part(priced),
    lines_without_price_list: part(unpriced),
    parts_bought_at_different_prices: spread.length ? part(spread) : undefined,
    excludes: 'Outside processing (LSO/ESO service POs), annealing, paint/sand, freight, labour and overheads. Component purchase price only.',
    notes: [
      unpriced.length ? `${unpriced.length} BOM line(s) have no price on file, so the total is UNDERSTATED by their cost.` : 'Every BOM line has a price on file.',
      `Price = the latest record on the Component Pricing screen (${fromScreen} line(s)); where none is captured, the most recent purchase PO line, any project. Service POs and cancelled lines are ignored.`,
      'Quantity per unit comes from the BOM readiness view; leaf lines only, so assemblies are not double counted. Parts unlinked in the BOM tree have no quantity per unit and are not costed.',
      'PO prices exclude VAT, like all Matrix PO values.',
      byName ? `${byName} line(s) were matched to a pricing record by item name only (no part number on the record) — check these.` : null,
      'Pricing screen prices are the invoice unit price as captured; whether they exclude VAT is not confirmed.',
      cfg.label === 'RLL' ? 'An RLL carries no sight unless specially requested, so no sight is included.' : null,
      cpWarning
    ].filter(Boolean),
    pricing_records_read: { total: cpRows.length, with_part_number: cpLinked },
    po_lines_ignored: { service_po_lines: serviceSkipped, cancelled_lines: cancelledSkipped }
  };
}

// ── 2026 400 RLL project tools ──────────────────────────────────────────────

async function readBlueCardRegister() {
  const [projRes, serRes] = await Promise.all([
    supabase.from('projects').select('project_name, target_qty, status, end_date')
      .eq('project_name', PROJECT_400).limit(1),
    supabase.from('weapon_serials').select('*').eq('card_type', 'RLL').limit(5000)
  ]);
  const proj = projRes.data;
  const target = proj && proj[0] ? num(proj[0].target_qty) : 0;
  const { data, error } = serRes;
  if (error) {
    return { target_qty: target || null, error: `Could not read the serial register: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return {
      target_qty: target || null,
      note: 'No RLL rows came back from the serial register. Either none exist, or the table has no read policy for the bot (RLS returns zero rows silently). Built count unknown.'
    };
  }

  const statusKey = ['status', 'build_status', 'state'].find(k => k in data[0]);
  if (!statusKey) {
    return {
      target_qty: target || null, serials_in_register: data.length,
      note: 'The serial register has no recognisable status column, so the built count cannot be determined.',
      columns_found: Object.keys(data[0])
    };
  }

  const byStatus = {};
  for (const r of data) {
    const s = String(r[statusKey] ?? 'BLANK').toUpperCase();
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  const doneRe = /(COMPLETE|RELEASED|SHIPPED|DELIVERED|DONE|PASSED|FINISHED)/;
  let completed = 0, inProgress = 0, unbuilt = 0;
  for (const [s, n] of Object.entries(byStatus)) {
    if (s === 'UNBUILT') unbuilt += n;
    else if (doneRe.test(s)) completed += n;
    else inProgress += n;
  }

  return {
    project: PROJECT_400,
    target_qty: target || null,
    serials_in_register: data.length,
    status_column: statusKey,
    counts_by_status: byStatus,
    completed_units: completed,
    in_progress_units: inProgress,
    unbuilt_units: unbuilt,
    serials_allocated_or_in_use: completed + inProgress,
    remaining_to_build: target ? Math.max(0, target - completed) : null,
    days_to_deadline: daysUntil(DEADLINE_400),
    deadline: DEADLINE_400,
    note: 'This is the Blue Card gun register — it can include test builds still being run on the tablets (they show as in progress). It is NOT sub-builds. completed_units counts statuses that look like COMPLETE/RELEASED/SHIPPED/DELIVERED/DONE/PASSED. Check counts_by_status if the labels differ. This is the serial register for card type RLL (one contract: 400 units).'
  };
}


// Target quantity for the 400 RLL project (does NOT touch the Blue Card register)
function targetFromProject(projRes) {
  const t = projRes && projRes.data && projRes.data[0] ? num(projRes.data[0].target_qty) : 0;
  return t > 0 ? t : 400;
}

// ── Production Progress model (mirrors the Matrix Production Progress screen) ─
// Reads v_rll_build_progress + v_rll_build_effective (per project) and the
// Build Sequence rules in build_dependencies, and counts complete SETS of
// every assembly recursively, exactly as frm_production_progress.py does.

async function loadProgressModel() {
  return cached('progress_model', 45000, loadProgressModelUncached);
}

async function loadProgressModelUncached() {
  const byProject = q => q.eq('project_name', PROJECT_400);
  const [projRes, prog, eff, deps] = await Promise.all([
    supabase.from('projects').select('project_name, target_qty, start_date, end_date')
      .eq('project_name', PROJECT_400).limit(1),
    fetchAll('v_rll_build_progress', '*', { mod: byProject }),
    fetchAll('v_rll_build_effective', '*', { mod: byProject }),
    fetchAll('build_dependencies', '*', { order: 'sequence_no' })
  ]);
  if (prog.error) return { error: prog.error };
  if (eff.error)  return { error: eff.error };
  if (prog.data.length === 0) return { error: `v_rll_build_progress has no rows for project "${PROJECT_400}".` };

  const target = targetFromProject(projRes);
  const rows = prog.data;
  const effRows = eff.data;
  const depRows = deps.error ? [] : deps.data;

  const byId = {}, children = {}, effById = {};
  for (const r of rows) {
    if (r.component_id) byId[r.component_id] = r;
    if (r.dependant_code) (children[r.dependant_code] = children[r.dependant_code] || []).push(r);
  }
  for (const e of effRows) if (e.component_id) effById[e.component_id] = e;

  const cache = new Map();
  const qtyFor = (row, mode) => {
    let q = num(row.available_qty);
    if (mode === 'wip' || mode === 'order') q += num(row.holding_qty) + num(row.in_process_qty);
    if (mode === 'order') q += num(row.on_order_qty);
    return Math.max(q, 0);
  };
  function capacity(row, mode, seen) {
    const cid = row.component_id;
    const key = cid ? cid + '|' + mode : null;
    if (key && cache.has(key)) return cache.get(key);
    const sn = new Set(seen || []);
    if (cid) { if (sn.has(cid)) return 0; sn.add(cid); }
    let own = qtyFor(row, mode);
    const kids = cid ? (children[cid] || []) : [];
    if (kids.length) {
      let fromKids = null;
      for (const k of kids) {
        const req = num(k.req_per_unit) || 1;
        const sets = Math.floor(capacity(k, mode, sn) / req);
        fromKids = fromKids === null ? sets : Math.min(fromKids, sets);
      }
      own += Math.max(fromKids || 0, 0);
    }
    if (key) cache.set(key, own);
    return own;
  }
  const hasChildren = r => !!(r.component_id && (children[r.component_id] || []).length);
  const isAssembly  = r => hasChildren(r) || !!r.is_assembly_group || r.build_status === 'CONTAINER';

  const roots = rows.filter(r => !r.dependant_code);
  const root = rows.find(r => r.component_id === 'RLLMB1')
    || roots.slice().sort((a, b) => ((children[b.component_id] || []).length) - ((children[a.component_id] || []).length))[0]
    || null;

  function bands(row, need) {
    if (need <= 0) return { built: 0, buildable: 0, wip: 0, onOrder: 0, gap: 0 };
    const built = Math.min(Math.max(num(row.available_qty), 0), need);
    const ready = Math.min(capacity(row, 'ready'), need);
    const wip   = Math.min(capacity(row, 'wip'), need);
    const order = Math.min(capacity(row, 'order'), need);
    return { built, buildable: Math.max(ready - built, 0), wip: Math.max(wip - ready, 0),
             onOrder: Math.max(order - wip, 0), gap: Math.max(need - order, 0) };
  }

  // Assemblies waiting behind a node: the node itself, then everything the
  // Build Sequence rules put behind it, in order.
  const waiters = {};
  for (const d of depRows) {
    const p = d.depends_on_component_id, c = d.component_id;
    if (p && c) (waiters[p] = waiters[p] || []).push(c);
  }
  function heldUpBy(row) {
    const cid = row.component_id, pcode = row.dependant_code;
    let start = null;
    if (pcode && byId[pcode]) start = pcode;
    else if (cid && isAssembly(row)) start = cid;
    if (!start) return [];
    const names = [], seen = new Set([start]), queue = [start];
    while (queue.length) {
      const node = queue.shift();
      for (const nxt of (waiters[node] || [])) {
        if (seen.has(nxt)) continue;
        seen.add(nxt); queue.push(nxt);
        if (byId[nxt]) names.push(byId[nxt].item_name || nxt);
      }
    }
    const first = byId[start];
    return [first ? first.item_name : null, ...names].filter(Boolean);
  }

  // Direct real children, looking through CONTAINER grouping rows
  function realKids(row, depth = 0) {
    const out = [];
    for (const k of (children[row.component_id] || [])) {
      if (k.build_status === 'CONTAINER' && depth < 6) out.push(...realKids(k, depth + 1));
      else out.push(k);
    }
    return out;
  }

  return { target, rows, effRows, depRows, depsError: deps.error || null, byId, children, effById,
           capacity, bands, isAssembly, hasChildren, root, heldUpBy, realKids, project: projRes.data && projRes.data[0] };
}

const SUB_STATE_RANK = { 'NOT ORDERED': 1, 'PARTLY ORDERED': 2, 'ON ORDER - ETA PASSED': 3, 'ON ORDER - NO DATE': 3,
  'ON ORDER - ETA AFTER DEADLINE': 4, 'SUB-ASSEMBLY ITSELF SHORT': 5, 'ON ORDER': 6 };

function assemblyList(m) {
  const out = [];
  for (const a of m.rows) {
    // The Production Progress screen treats CONTAINER rows as assemblies
    // (they carry the assembled stock), so they are included here.
    if (!m.isAssembly(a) || a === m.root) continue;
    const need = m.target;               // the screen scores every node against the project target
    const b = m.bands(a, need);
    const parent = a.dependant_code ? m.byId[a.dependant_code] : null;
    const rec = {
      item_name: a.item_name, stock_code: a.stock_code,
      feeds: parent && parent !== m.root ? parent.item_name : 'final RLL',
      needed: need, built: b.built, in_stock: num(a.available_qty),
      buildable_now_from_stock: b.buildable,
      in_holding_or_service_process: b.wip, on_order_sets: b.onOrder, no_cover_anywhere: b.gap,
      pct_built: Math.round(Math.min(100, b.built / need * 100)),
    };
    rec.state = b.built >= need ? 'COMPLETE' : (b.built > 0 ? 'PARTLY BUILT' : 'NOT STARTED');
    rec._row = a; rec._need = need;
    out.push(rec);
  }
  return out;
}

function blockersFor(m, rec) {
  const blockers = [], processes = [];
  const a = rec._row;
  for (const c of (m.children[a.component_id] || [])) {
    const e = m.effById[c.component_id] || {};
    const isAsm = m.isAssembly(c);
    const cneed = isAsm ? m.target : num(e.effective_need !== undefined ? e.effective_need : c.need_total);
    if (cneed <= 0) continue;
    const avail = num(c.available_qty);
    const proc  = num(c.holding_qty) + num(c.in_process_qty);
    const oo    = num(c.on_order_qty);
    const short = Math.max(0, cneed - avail);
    if (short === 0) continue;
    const eta = (e.supplier_latest_eta || c.supplier_latest_eta || c.supplier_earliest_eta)
      ? String(e.supplier_latest_eta || c.supplier_latest_eta || c.supplier_earliest_eta).slice(0, 10) : null;
    const base = { item_name: c.item_name, stock_code: c.stock_code, short_on_shelf: short,
                   in_process: proc, on_order: oo, supplier_eta: eta };

    if (isAsm) {
      const cb = m.bands(c, m.target);
      if (cb.built < m.target) {
        blockers.push({ ...base, kind: 'sub-assembly', state: 'SUB-ASSEMBLY ITSELF SHORT',
          built: cb.built, can_still_build_from_shelf: cb.buildable, sets_with_no_cover: cb.gap });
      }
      continue;
    }
    const afterProc = Math.max(0, short - proc);
    if (afterProc === 0) { processes.push({ item_name: c.item_name, stock_code: c.stock_code, in_process: proc }); continue; }
    const needsSourcing = num(e.needs_sourcing);
    let st;
    if (needsSourcing > 0) st = oo > 0 ? 'PARTLY ORDERED' : 'NOT ORDERED';
    else if (e.eta_overdue === true) st = 'ON ORDER - ETA PASSED';
    else if (!eta) st = 'ON ORDER - NO DATE';
    else if (eta > DEADLINE_400) st = 'ON ORDER - ETA AFTER DEADLINE';
    else st = 'ON ORDER';
    blockers.push({ ...base, kind: 'part', needs_sourcing: needsSourcing || undefined, state: st });
  }
  return { blockers, processes };
}

function feedersBehind(m, rec) {
  const out = [];
  for (const d of m.depRows) {
    if (d.component_id !== rec._row.component_id) continue;
    const fr = m.byId[d.depends_on_component_id];
    if (!fr) continue;
    const fneed = num(fr.need_total) || m.target;
    const pct = Math.round(Math.min(100, Math.max(num(fr.available_qty), 0) / fneed * 100));
    if (pct < 100) out.push({ feeder: fr.item_name, pct_built: pct, sequence_no: d.sequence_no });
  }
  return out.sort((x, y) => x.pct_built - y.pct_built);
}

function screenSummary(m) {
  const real = m.rows.filter(r => r.build_status !== 'CONTAINER');
  const asm  = m.rows.filter(r => m.isAssembly(r));
  const built   = m.root ? Math.min(Math.max(num(m.root.available_qty), 0), m.target) : 0;
  const canMake = m.root ? Math.min(m.capacity(m.root, 'ready'), m.target) : 0;
  const secured = m.root ? Math.min(m.capacity(m.root, 'order'), m.target) : 0;
  const sourcing = m.effRows.filter(r => r.build_status !== 'CONTAINER' && num(r.needs_sourcing) > 0).length;
  let asmPct = null;
  if (asm.length && m.target > 0) {
    const done = asm.reduce((s, r) => s + Math.min(Math.max(num(r.available_qty), 0), m.target), 0);
    asmPct = Math.round(done / (asm.length * m.target) * 100);
  }
  let limiting = null;
  if (real.length) limiting = real.reduce((lo, r) => num(r.pct_ready) < num(lo.pct_ready) ? r : lo, real[0]);
  return {
    guns_assembled_in_stock: built, buildable_now_from_shelf_stock: canMake,
    secured_incl_process_and_on_order: secured, target: m.target,
    assembly_completion_pct: asmPct, lines_needing_sourcing: sourcing,
    gating_line: limiting ? { item_name: limiting.item_name, stock_code: limiting.stock_code,
      in_store: num(limiting.available_qty), needed: num(limiting.need_total),
      holds_up: m.heldUpBy(limiting).slice(0, 6) } : null
  };
}

const MODEL_NOTE = 'Same method as the Matrix Production Progress screen: sets of each assembly are counted recursively from shelf stock, then Holding Store and service-order processes, then open POs. Build time per sub-build is not in the system. Rows the BOM marks as CONTAINER are counted as assemblies, as on the screen.';

function sequenceNote(m) {
  return m.depsError
    ? { build_sequence_rules: 'could not be read: ' + m.depsError }
    : (m.depRows.length === 0
        ? { build_sequence_rules: 'none returned — either none are set up or the bot has no read access to build_dependencies (RLS returns zero rows silently), so downstream "holds up" lists are empty' }
        : { build_sequence_rules: m.depRows.length });
}

async function get_sub_builds_completed() {
  const m = await loadProgressModel();
  if (m.error) return m;
  const all = assemblyList(m);
  const slim = x => ({ item_name: x.item_name, stock_code: x.stock_code, feeds: x.feeds, needed: x.needed,
    in_stock: x.in_stock, built: x.built, pct_built: x.pct_built, can_still_build_from_shelf: x.buildable_now_from_stock || undefined,
    in_process: x.in_holding_or_service_process || undefined, on_order_sets: x.on_order_sets || undefined });
  const complete = all.filter(x => x.state === 'COMPLETE');
  const partial  = all.filter(x => x.state === 'PARTLY BUILT').sort((x, y) => y.pct_built - x.pct_built);
  const notStarted = all.filter(x => x.state === 'NOT STARTED');
  return {
    project: PROJECT_400, target: m.target, deadline: DEADLINE_400, days_remaining: daysUntil(DEADLINE_400),
    sub_assemblies: all.length, completed: complete.length, partly_built: partial.length, not_started: notStarted.length,
    completed_list: complete.map(slim),
    partly_built_list: partial.slice(0, 40).map(slim),
    not_started_list: notStarted.slice(0, 40).map(slim),
    guns_view: screenSummary(m),
    ...sequenceNote(m),
    note: 'COMPLETE = the assembly\'s own stock on the shelf (after WO/service-order commitments) covers the quantity needed. ' + MODEL_NOTE
  };
}

async function get_sub_builds_hampering() {
  const m = await loadProgressModel();
  if (m.error) return m;
  const hampered = [];
  for (const rec of assemblyList(m)) {
    if (rec.state === 'COMPLETE') continue;
    const { blockers, processes } = blockersFor(m, rec);
    if (blockers.length === 0 && rec.no_cover_anywhere === 0) continue;
    hampered.push({ rec, blockers, processes });
  }
  hampered.sort((x, y) => (y.rec.needed - y.rec.built) - (x.rec.needed - x.rec.built));
  const byState = {};
  for (const h of hampered) for (const b of h.blockers) byState[b.state] = (byState[b.state] || 0) + 1;
  return {
    project: PROJECT_400, target: m.target, deadline: DEADLINE_400, days_remaining: daysUntil(DEADLINE_400),
    hampered_sub_builds: hampered.length,
    blocking_items_by_type: byState,
    sub_builds: hampered.slice(0, 30).map(h => ({
      item_name: h.rec.item_name, stock_code: h.rec.stock_code, feeds: h.rec.feeds,
      built: h.rec.built, needed: h.rec.needed, pct_built: h.rec.pct_built,
      sets_with_no_cover_anywhere: h.rec.no_cover_anywhere,
      blocked_by: h.blockers.slice().sort((p, q) => (SUB_STATE_RANK[p.state] || 9) - (SUB_STATE_RANK[q.state] || 9)).slice(0, 8),
      also_waiting_on_process: h.processes.length ? h.processes.slice(0, 5) : undefined,
      feeder_assemblies_still_behind: feedersBehind(m, h.rec).slice(0, 4)
    })),
    ...sequenceNote(m),
    note: 'Parts that only need a Holding Store or service-order process to finish are listed as waiting_on_process (chase the process, not a PO). feeder_assemblies_still_behind comes from the Build Sequence rules — information for chasing, never a block. ' + MODEL_NOTE
  };
}

async function get_sub_build_priorities() {
  const m = await loadProgressModel();
  if (m.error) return m;
  const items = [];
  for (const rec of assemblyList(m)) {
    if (rec.state === 'COMPLETE') continue;
    const { blockers, processes } = blockersFor(m, rec);
    const held = m.heldUpBy(rec._row);
    items.push({ rec, blockers, processes, holdsUp: held.filter(n => n !== rec.item_name),
      worst: blockers.length ? Math.min(...blockers.map(b => SUB_STATE_RANK[b.state] || 9)) : 99,
      toMake: rec._need - rec.built });
  }
  const order = (x, y) => x.worst - y.worst || y.holdsUp.length - x.holdsUp.length || y.toMake - x.toMake;
  const unblock = items.filter(x => x.worst <= 2).sort(order);
  const chase   = items.filter(x => x.worst >= 3 && x.worst <= 5).sort(order);
  const waiting = items.filter(x => x.worst === 6).sort(order);
  const startNow = items.filter(x => x.blockers.length === 0 && x.rec.buildable_now_from_stock > 0)
    .sort((x, y) => y.holdsUp.length - x.holdsUp.length || y.rec.buildable_now_from_stock - x.rec.buildable_now_from_stock);
  const processOnly = items.filter(x => x.blockers.length === 0 && x.rec.buildable_now_from_stock === 0 && x.processes.length > 0);

  const fmt = x => ({ item_name: x.rec.item_name, stock_code: x.rec.stock_code, feeds: x.rec.feeds,
    built: x.rec.built, needed: x.rec.needed, pct_built: x.rec.pct_built,
    holds_up: x.holdsUp.length ? x.holdsUp.slice(0, 5) : undefined,
    blocked_by: x.blockers.slice().sort((p, q) => (SUB_STATE_RANK[p.state] || 9) - (SUB_STATE_RANK[q.state] || 9)).slice(0, 5),
    waiting_on_process: x.processes.length ? x.processes.slice(0, 3) : undefined });

  return {
    project: PROJECT_400, target: m.target, deadline: DEADLINE_400, days_remaining: daysUntil(DEADLINE_400),
    gating_view: screenSummary(m),
    priority_1_unblock_now_parts_not_or_partly_ordered: { count: unblock.length, sub_builds: unblock.slice(0, 20).map(fmt) },
    priority_2_chase_supplier_dates_or_short_sub_assemblies: { count: chase.length, sub_builds: chase.slice(0, 20).map(fmt) },
    priority_3_on_order_within_date: { count: waiting.length, sub_builds: waiting.slice(0, 15).map(fmt) },
    priority_4_start_now_all_parts_in_stock: { count: startNow.length,
      sub_builds: startNow.slice(0, 25).map(x => ({ ...fmt(x), can_build_now_sets: x.rec.buildable_now_from_stock })) },
    chase_the_process_only: { count: processOnly.length, sub_builds: processOnly.slice(0, 15).map(fmt) },
    ...sequenceNote(m),
    method: 'Ranked: (1) any part not ordered or partly ordered, (2) late/undated deliveries or a short sub-assembly, (3) deliveries on order within date, (4) sub-builds with every part in stock — start these now to use floor time. Within a tier, sub-builds that hold up the most other assemblies (per the Build Sequence rules and BOM parent) come first, then larger quantities still to make.',
    note: 'Build time per sub-build is not in the system, so ranking cannot weigh how long each takes. A missing lead time or date is never estimated. ' + MODEL_NOTE
  };
}

// QUESTION 4: guns assembled (from Production Progress / stock), THEN the
// Blue Card serial register for allocation — never the other way round.
async function get_rll_units_built() {
  const m = await loadProgressModel();
  const stockView = m.error ? { error: m.error } : screenSummary(m);
  const register = await readBlueCardRegister();
  return {
    step_1_assembled_per_production_progress: stockView,
    step_2_serials_per_blue_card_register: register,
    note: 'Step 1 is the finished-gun stock position on the Production Progress screen (the root assembly\'s own stock). Step 2 is the Blue Card serial register — counts by status; test builds on the tablets show as in progress, so a tiny count there may be test data.'
  };
}

async function get_project_progress() {
  const [projRes, prog] = await Promise.all([
    supabase.from('projects').select('project_name, target_qty, status, start_date, end_date, manager')
      .eq('project_name', PROJECT_400).limit(1),
    fetchAll('v_rll_build_progress', '*', { mod: q => q.eq('project_name', PROJECT_400) })
  ]);
  const proj = projRes.data;
  if (prog.error) return { error: prog.error };
  const rows = prog.data;
  if (rows.length === 0) return { error: 'v_rll_build_progress returned no rows.' };

  const colsFound = Object.keys(rows[0]);
  const idKeys = ['item_name', 'stock_code', 'storeroom', 'supplier_earliest_eta'];
  const bands = ['need_total', 'band_ready', 'band_wip', 'band_on_order', 'band_gap'];
  const missing = bands.filter(k => !(k in rows[0]));
  if (missing.length) {
    return { error: `Progress view is missing expected columns: ${missing.join(', ')}`, columns_found: colsFound };
  }

  const lines = rows.filter(r => num(r.need_total) > 0);
  const fullyReady = lines.filter(r => num(r.band_ready) >= num(r.need_total)).length;
  const withGap    = lines.filter(r => num(r.band_gap) > 0);
  const withWip    = lines.filter(r => num(r.band_wip) > 0);
  const onOrder    = lines.filter(r => num(r.band_on_order) > 0);
  const pctReadyAvg = lines.length
    ? r2(lines.reduce((s, r) => s + Math.min(1, num(r.band_ready) / num(r.need_total)), 0) / lines.length * 100)
    : null;
  const pctSecuredAvg = lines.length
    ? r2(lines.reduce((s, r) =>
        s + Math.min(1, (num(r.band_ready) + num(r.band_wip) + num(r.band_on_order)) / num(r.need_total)), 0)
        / lines.length * 100)
    : null;

  const worst = withGap
    .sort((a, b) => num(b.band_gap) - num(a.band_gap))
    .slice(0, 40)
    .map(r => ({ ...pick(r, idKeys), need_total: num(r.need_total), ready: num(r.band_ready),
                 wip: num(r.band_wip), on_order: num(r.band_on_order), gap: num(r.band_gap),
                 eta_overdue: r.eta_overdue ?? undefined }));

  return {
    project: PROJECT_400,
    target_qty: proj && proj[0] ? proj[0].target_qty : null,
    deadline: DEADLINE_400,
    days_to_deadline: daysUntil(DEADLINE_400),
    bom_lines_checked: lines.length,
    lines_fully_ready: fullyReady,
    lines_with_gap_not_ordered: withGap.length,
    lines_with_holding_wip: withWip.length,
    lines_with_open_orders: onOrder.length,
    average_line_pct_ready: pctReadyAvg,
    average_line_pct_secured_incl_wip_and_on_order: pctSecuredAvg,
    eta_overdue_lines: lines.filter(r => r.eta_overdue === true).length,
    largest_gaps: worst,
    note: 'This is MATERIAL COVERAGE per BOM line (ready / in Holding Store process / on order / gap), not a % complete of finished guns. Build time per sub-build is not held in the system. Lines unlinked in the BOM tree are invisible here.'
  };
}

async function get_rll_deadline_risk(qtyArg, showAll) {
  const [projRes, readiness, crossStoreMap, lt] = await Promise.all([
    supabase.from('projects').select('target_qty').eq('project_name', PROJECT_400).limit(1),
    cached('rll_readiness', 45000, async () => supabase.from('v_rll_build_readiness').select(RLL_READINESS_COLS)),
    getCrossStoreMap(),
    supabase.from('part_lead_times').select('stock_code, item_name, supplier, lead_days').limit(5000)
  ]);
  const qty = qtyArg || targetFromProject(projRes);
  const qtyBasis = qtyArg
    ? 'qty supplied by caller'
    : `full project target of ${qty}; the Blue Card gun register is not used. If finished guns have already left stock, shortages for those units may be overstated.`;

  if (readiness.error) return { error: `Query failed: ${readiness.error.message}` };
  const allRows = readiness.data;

  const ltData = lt.data;
  const leadMap = {};
  for (const l of (ltData || [])) if (l.stock_code) leadMap[l.stock_code] = l;

  const daysLeft = daysUntil(DEADLINE_400);
  const needs = computeNeeds(allRows, qty, 'need_for_1_rll');

  const notOrdered = [], partlyOrdered = [], onOrderRisk = [], wipToChase = [];

  for (const { row: r, need } of needs) {
    if (need <= 0) continue;
    const avail = num(r.available_qty), hold = num(r.holding_qty), oo = num(r.on_order_qty);
    const gapAfterStockAndWip = Math.max(0, need - avail - hold);
    const base = { item_name: r.item_name, stock_code: r.stock_code, storeroom: r.storeroom, needed: need };

    // Process-stuck: Holding Store WIP is what bridges the gap
    if (hold > 0 && need - avail > 0) {
      wipToChase.push({ ...base, available: avail, in_holding_process: hold,
        action: 'Chase the process step (machining/anodize/external service) — no new PO' });
    }

    if (gapAfterStockAndWip <= 0) continue;
    const eta = r.supplier_earliest_eta ? String(r.supplier_earliest_eta).slice(0, 10) : null;
    const lt  = leadMap[r.stock_code] || leadMap[(r.stock_code || '').split('_')[0]];
    const cross = crossStoreMap[(r.stock_code || '').split('_')[0]] || 0;
    const uncovered = Math.max(0, gapAfterStockAndWip - oo);

    if (oo === 0) {
      notOrdered.push({ ...base, available: avail, short_by: gapAfterStockAndWip,
        lead_days: lt ? lt.lead_days : null,
        lead_time_supplier: lt ? lt.supplier : null,
        cannot_meet_deadline_if_ordered_today: lt && lt.lead_days != null ? lt.lead_days > daysLeft : undefined,
        lead_time_missing: lt ? undefined : true,
        other_store_stock: cross || undefined });
    } else if (uncovered > 0) {
      partlyOrdered.push({ ...base, available: avail, on_order: oo, still_to_order: uncovered,
        supplier_eta: eta, eta_after_deadline: eta ? eta > DEADLINE_400 : undefined,
        other_store_stock: cross || undefined });
    } else {
      // Fully covered by the order, but is the date safe?
      let risk = null;
      if (!eta) risk = 'NO COMMITTED DATE';
      else if (eta > DEADLINE_400) risk = 'ETA AFTER DEADLINE';
      else if (daysUntil(eta) < 0) risk = 'ETA ALREADY PASSED — LATE';
      else if (daysLeft - daysUntil(eta) < 14) risk = 'TIGHT — less than 14 days before the deadline';
      if (risk) onOrderRisk.push({ ...base, available: avail, on_order: oo, supplier_eta: eta, risk });
    }
  }

  const byGap = (a, b) => (b.short_by || b.still_to_order || 0) - (a.short_by || a.still_to_order || 0);
  const byLead = (a, b) => (b.lead_days ?? -1) - (a.lead_days ?? -1);
  // Every list reports shown/total so the bot can say when it is partial.
  const cap = showAll ? 60 : null;
  const part = (list, dflt) => { const n = cap || dflt; return { shown: Math.min(list.length, n), total: list.length, rows: list.slice(0, n) }; };

  return {
    project: PROJECT_400,
    deadline: DEADLINE_400,
    days_remaining: daysLeft,
    quantity_planned_for: qty,
    quantity_basis: qtyBasis,
    summary: {
      not_ordered_parts: notOrdered.length,
      partly_ordered_parts: partlyOrdered.length,
      on_order_but_date_risk: onOrderRisk.length,
      parts_in_holding_processes: wipToChase.length,
      not_ordered_with_no_lead_time_on_file: notOrdered.filter(x => x.lead_time_missing).length,
    },
    not_ordered: part(notOrdered.sort(byLead), 25),
    partly_ordered: part(partlyOrdered.sort(byGap), 20),
    on_order_date_risk: part(onOrderRisk, 20),
    holding_store_processes_to_chase: part(wipToChase, 20),
    notes: [
      'Lead times come from part_lead_times, which is only partly filled (GRN40 entries by Lodewikus). A missing lead time is shown as lead_time_missing, never estimated.',
      'Parts fully covered by other product stores (other_store_stock) need a management transfer, not a PO.',
      'Raw material is not included. Seven RLL BOM parts that are unlinked in the BOM tree are invisible here.',
    ]
  };
}

async function get_open_work_orders(projectName) {
  const project = projectName || PROJECT_400;
  const closedRe = /^(complete|completed|closed|cancelled|canceled)$/i;

  const out = { project };

  const wo = await supabase.from('work_orders').select('*').eq('customer', project).limit(1000);
  if (wo.error) {
    out.work_orders = { error: `Could not read work_orders: ${wo.error.message}` };
  } else {
    const rows = wo.data || [];
    const statusKey = rows[0] && ['status', 'wo_status'].find(k => k in rows[0]);
    const open = statusKey ? rows.filter(r => !closedRe.test(String(r[statusKey] || '').trim())) : rows;
    out.work_orders = {
      total_rows: rows.length,
      open_count: open.length,
      status_column: statusKey || 'none found — all rows returned',
      rows: open.slice(0, 60).map(r => {
        const o = {};
        for (const [k, v] of Object.entries(r)) {
          if (v !== null && v !== '' && !/(^id$|_at$|created|updated)/i.test(k)) o[k] = typeof v === 'string' ? v.slice(0, 80) : v;
        }
        return o;
      }),
      note: rows.length === 0
        ? 'No rows returned. Either there are no work orders for this project, or the bot has no read access to work_orders (RLS returns zero rows silently).'
        : '"Partially Complete" means parts are fully issued but assembly work is still outstanding.'
    };
  }

  const so = await supabase.from('service_orders').select('*').limit(1000);
  if (so.error) {
    out.service_orders = { error: `Could not read service_orders: ${so.error.message}` };
  } else {
    const rows = so.data || [];
    const statusKey = rows[0] && ['status', 'so_status'].find(k => k in rows[0]);
    const open = statusKey ? rows.filter(r => !closedRe.test(String(r[statusKey] || '').trim())) : rows;
    out.service_orders = {
      total_rows: rows.length,
      open_count: open.length,
      status_column: statusKey || 'none found — all rows returned',
      rows: open.slice(0, 60).map(r => {
        const o = {};
        for (const [k, v] of Object.entries(r)) {
          if (v !== null && v !== '' && !/(^id$|_at$|created|updated)/i.test(k)) o[k] = typeof v === 'string' ? v.slice(0, 80) : v;
        }
        return o;
      }),
      note: 'Service orders are not filtered by project (no project link confirmed) — all open ones are shown.'
    };
  }
  return out;
}

// ── Finance / PO tools ───────────────────────────────────────────────────────

const PAYABLES_COLS =
  'po_base, supplier, project, po_type, line_count, open_lines, next_committed_date, '
  + 'received_excl, outstanding_excl, committed_excl, finance_paid_excl, finance_pending, '
  + 'recon_outcome, has_finance_record, received_not_paid_excl, paid_not_received_excl, '
  + 'ordered_not_received_excl';

async function loadPayables(projectName) {
  const res = await fetchAll('v_po_payables', PAYABLES_COLS, {
    order: 'po_base',
    mod: projectName ? q => q.ilike('project', projectName) : null
  });
  return res;
}

async function get_open_po_value() {
  const pay = await loadPayables();
  if (pay.error) return { error: pay.error };
  const rows = pay.data;

  const sum = f => rows.reduce((s, r) => s + num(r[f]), 0);
  const committed = sum('committed_excl');
  const paid      = sum('finance_paid_excl');
  const pending   = sum('finance_pending');
  // per-PO still owed: an overpaid PO must not offset another PO's debt
  const stillOwed = rows.reduce((s, r) => s + Math.max(0, num(r.committed_excl) - num(r.finance_paid_excl)), 0);
  const overpaid  = rows.reduce((s, r) => s + Math.max(0, num(r.finance_paid_excl) - num(r.committed_excl)), 0);

  // Finance payments that match no PMS PO — reported, never subtracted
  const rec = await fetchAll('v_finance_po_reconciliation', 'po_base, finance_net_paid_excl, outcome',
    { order: 'po_base', mod: q => q.eq('outcome', 'UNKNOWN PO') });

  return {
    basis: 'Aggregated per PO base, PMS POs only. Committed = greater of ordered and received. Finance paid = payments matched to those POs.',
    pms_pos_counted: rows.length,
    gross_committed: vat3(committed),
    already_paid_per_finance: vat3(paid),
    scheduled_pending_not_yet_paid: vat3(pending),
    net_still_owed: vat3(stillOwed),
    overpaid_pos_value: vat3(overpaid),
    finance_payments_not_matched_to_a_pms_po: rec.error
      ? { error: rec.error }
      : { count: rec.data.length, ...vat3(rec.data.reduce((s, r) => s + num(r.finance_net_paid_excl), 0)),
          note: 'UNKNOWN PO — legacy, unrelated, or a mapping error. EXCLUDED from the figures above; needs review.' },
    caveat: 'Payments made before the Finance sync started are not in the system, so older fully-delivered POs without a Finance record can make net_still_owed look higher than reality.',
    vat_note: 'PMS figures exclude 15% VAT; payment planning must use incl_vat_zar.'
  };
}

async function get_payables_summary(projectName) {
  const pay = await loadPayables(projectName);
  if (pay.error) return { error: pay.error };
  const rows = pay.data;
  if (rows.length === 0) {
    return { error: projectName
      ? `No POs found for project "${projectName}". Use list_projects for valid names.`
      : 'No PO data returned.' };
  }

  const sum = (arr, f) => arr.reduce((s, r) => s + num(r[f]), 0);
  const rnp = rows.filter(r => num(r.received_not_paid_excl) > 1);
  const pnr = rows.filter(r => num(r.paid_not_received_excl) > 1);
  const onr = rows.filter(r => num(r.ordered_not_received_excl) > 1);

  const topPOs = (arr, f) => arr
    .sort((a, b) => num(b[f]) - num(a[f])).slice(0, 15)
    .map(r => ({ po_base: r.po_base, supplier: r.supplier, project: r.project,
      excl_vat_zar: r2(num(r[f])), incl_vat_zar: r2(num(r[f]) * (1 + VAT_RATE)),
      has_finance_record: r.has_finance_record, recon_outcome: r.recon_outcome || undefined }));

  const bySupplier = (arr, f) => {
    const m = {};
    for (const r of arr) {
      const k = r.supplier || 'Unknown supplier';
      if (!m[k]) m[k] = { supplier: k, po_count: 0, excl_vat_zar: 0 };
      m[k].po_count++; m[k].excl_vat_zar += num(r[f]);
    }
    return Object.values(m).sort((a, b) => b.excl_vat_zar - a.excl_vat_zar).slice(0, 12)
      .map(s => ({ ...s, excl_vat_zar: r2(s.excl_vat_zar), incl_vat_zar: r2(s.excl_vat_zar * (1 + VAT_RATE)) }));
  };

  const noFin = rnp.filter(r => !r.has_finance_record);

  return {
    project_filter: projectName || 'all projects',
    pos_counted: rows.length,
    basis: 'Per PO base, PMS POs only, all values excl. 15% VAT unless shown. Receipt dates are not in this view, so received-not-paid cannot be aged; default term is 30 days after delivery.',
    received_not_paid: {
      po_count: rnp.length, ...vat3(sum(rnp, 'received_not_paid_excl')),
      of_which_no_finance_record_at_all: { po_count: noFin.length, ...vat3(sum(noFin, 'received_not_paid_excl')),
        note: 'May have been paid before the Finance sync started — verify with Siva, do not treat as confirmed debt.' },
      scheduled_by_finance_not_yet_paid: vat3(sum(rnp, 'finance_pending')),
      largest_pos: topPOs(rnp, 'received_not_paid_excl'),
      by_supplier: bySupplier(rnp, 'received_not_paid_excl'),
    },
    paid_not_received_prepaid_limbo: {
      po_count: pnr.length, ...vat3(sum(pnr, 'paid_not_received_excl')),
      largest_pos: topPOs(pnr, 'paid_not_received_excl'),
      note: 'Deposits/prepayments are normal; late ones need chasing.'
    },
    ordered_not_received: {
      po_count: onr.length, ...vat3(sum(onr, 'ordered_not_received_excl')),
      largest_pos: topPOs(onr, 'ordered_not_received_excl'),
      by_supplier: bySupplier(onr, 'ordered_not_received_excl'),
    }
  };
}

async function get_prepaid_limbo() {
  const pay = await loadPayables();
  if (pay.error) return { error: pay.error };
  const today = new Date().toISOString().slice(0, 10);
  const rows = pay.data.filter(r => num(r.paid_not_received_excl) > 1)
    .sort((a, b) => num(b.paid_not_received_excl) - num(a.paid_not_received_excl));

  const list = rows.slice(0, 40).map(r => ({
    po_base: r.po_base, supplier: r.supplier, project: r.project,
    paid_excl_vat_zar: r2(num(r.finance_paid_excl)),
    received_excl_vat_zar: r2(num(r.received_excl)),
    prepaid_not_yet_delivered_excl_vat_zar: r2(num(r.paid_not_received_excl)),
    prepaid_incl_vat_zar: r2(num(r.paid_not_received_excl) * (1 + VAT_RATE)),
    open_lines: r.open_lines,
    next_committed_date: r.next_committed_date || null,
    delivery_date_passed: r.next_committed_date ? r.next_committed_date < today : undefined,
    no_committed_date: r.open_lines > 0 && !r.next_committed_date ? true : undefined,
  }));

  const late = rows.filter(r => r.next_committed_date && r.next_committed_date < today);
  return {
    po_count: rows.length,
    total_prepaid_not_received: vat3(rows.reduce((s, r) => s + num(r.paid_not_received_excl), 0)),
    of_which_delivery_date_already_passed: { po_count: late.length,
      ...vat3(late.reduce((s, r) => s + num(r.paid_not_received_excl), 0)) },
    largest: list,
    note: 'Paid per Finance exceeds goods received per PMS. A deposit before delivery is normal; POs with a passed delivery date are the ones to chase. If paid is well above even the PO commitment, check for a mapping error.'
  };
}

async function get_supplier_spend(supplierName) {
  const pay = await loadPayables();
  if (pay.error) return { error: pay.error };
  let rows = pay.data;
  if (supplierName) {
    const t = supplierName.toLowerCase();
    rows = rows.filter(r => (r.supplier || '').toLowerCase().includes(t));
    if (rows.length === 0) return { error: `No supplier matching "${supplierName}" found on PMS POs.` };
  }

  const m = {};
  for (const r of rows) {
    const k = r.supplier || 'Unknown supplier';
    if (!m[k]) m[k] = { supplier: k, po_count: 0, committed: 0, received: 0, paid: 0, outstanding: 0, rnp: 0, prepaid: 0 };
    const s = m[k];
    s.po_count++;
    s.committed += num(r.committed_excl); s.received += num(r.received_excl);
    s.paid += num(r.finance_paid_excl);   s.outstanding += num(r.outstanding_excl);
    s.rnp += num(r.received_not_paid_excl); s.prepaid += num(r.paid_not_received_excl);
  }
  const list = Object.values(m).sort((a, b) => b.committed - a.committed).slice(0, supplierName ? 20 : 25)
    .map(s => ({
      supplier: s.supplier, po_count: s.po_count,
      committed: vat3(s.committed), received: vat3(s.received), paid_per_finance: vat3(s.paid),
      ordered_not_received: vat3(s.outstanding),
      received_not_paid: vat3(s.rnp), prepaid_not_received: vat3(s.prepaid),
    }));

  const out = {
    filter: supplierName || 'all suppliers (top by committed value)',
    suppliers: list,
    caveat: 'PMS POs only, aggregated per PO base. Payments before the Finance sync started and non-PMS payments are not included.'
  };
  if (supplierName) {
    out.pos = rows.sort((a, b) => num(b.committed_excl) - num(a.committed_excl)).slice(0, 25).map(r => ({
      po_base: r.po_base, project: r.project, committed_excl_zar: r2(num(r.committed_excl)),
      received_excl_zar: r2(num(r.received_excl)), paid_excl_zar: r2(num(r.finance_paid_excl)),
      outstanding_excl_zar: r2(num(r.outstanding_excl)), recon_outcome: r.recon_outcome || undefined,
    }));
  }
  return out;
}

// Ageing of received-but-unpaid goods. Finance pays per PO, so we apply the
// PO's total Finance payments to its deliveries OLDEST FIRST (an assumption,
// stated in the output) and age whatever is left from the receipt date.
async function get_receipt_ageing() {
  let del = await fetchAll('po_deliveries', '*', { order: 'id' });
  if (del.error) del = await fetchAll('po_deliveries', '*');
  if (del.error) return { error: del.error };
  const dRows = del.data;
  if (dRows.length === 0) {
    return { error: 'po_deliveries returned no rows — either empty or the bot has no read access (RLS returns zero rows silently).' };
  }

  const cols = Object.keys(dRows[0]);
  const poKey   = ['po_number', 'po_ref', 'po_line', 'po'].find(k => cols.includes(k));
  const dateKey = ['delivery_date', 'received_date', 'date_received', 'receipt_date', 'arrival_date', 'created_at'].find(k => cols.includes(k));
  const qtyKey  = ['qty_received', 'qty_delivered', 'qty', 'quantity', 'delivered_qty'].find(k => cols.includes(k));
  if (!poKey || !dateKey || !qtyKey) {
    return {
      error: 'Could not identify the PO, date and quantity columns in po_deliveries.',
      columns_found: cols,
      detected: { po: poKey || null, date: dateKey || null, qty: qtyKey || null }
    };
  }

  const lines = await fetchAll('po_lines', 'po_number, unit_price', { order: 'po_number' });
  if (lines.error) return { error: lines.error };
  const price = {};
  const priceByBase = {};
  for (const l of lines.data) {
    if (l.po_number && price[l.po_number] === undefined) price[l.po_number] = num(l.unit_price);
    const b = String(l.po_number || '').split('/')[0];
    if (b && priceByBase[b] === undefined) priceByBase[b] = num(l.unit_price);
  }

  const pay = await loadPayables();
  if (pay.error) return { error: pay.error };
  const payMap = {};
  for (const r of pay.data) payMap[r.po_base] = r;

  // Group deliveries by PO base
  const byBase = {};
  let unvalued = 0, undated = 0;
  for (const d of dRows) {
    const po = String(d[poKey] || '');
    const base = po.split('/')[0];
    if (!base) continue;
    const qty = num(d[qtyKey]);
    if (qty <= 0) continue;
    const unit = price[po] !== undefined ? price[po] : priceByBase[base];
    if (unit === undefined) { unvalued++; continue; }
    const dt = d[dateKey] ? String(d[dateKey]).slice(0, 10) : null;
    if (!dt) { undated++; continue; }
    (byBase[base] = byBase[base] || []).push({ date: dt, value: qty * unit });
  }

  const today = new Date().toISOString().slice(0, 10);
  const ageDays = dt => Math.round((new Date(today) - new Date(dt)) / 86400000);

  const buckets = { '0-30 days (not yet due)': 0, '31-60 days': 0, '61-90 days': 0, 'over 90 days': 0 };
  const unpaidPOs = [];
  const bySupplier = {};
  let noFinTotal = 0, noFinCount = 0;

  for (const [base, arr] of Object.entries(byBase)) {
    const meta = payMap[base];
    if (!meta) continue; // not a PMS PO in the payables view
    arr.sort((a, b) => a.date.localeCompare(b.date));
    let paid = num(meta.finance_paid_excl);
    const open = [];
    for (const x of arr) {
      if (paid >= x.value - 0.01) { paid -= x.value; continue; }
      open.push({ date: x.date, value: x.value - paid });
      paid = 0;
    }
    if (open.length === 0) continue;
    const openTotal = open.reduce((s, x) => s + x.value, 0);

    if (!meta.has_finance_record) { noFinTotal += openTotal; noFinCount++; continue; }

    const oldest = open[0].date;
    let overdue = 0;
    for (const x of open) {
      const a = ageDays(x.date);
      if (a <= 30) buckets['0-30 days (not yet due)'] += x.value;
      else if (a <= 60) buckets['31-60 days'] += x.value;
      else if (a <= 90) buckets['61-90 days'] += x.value;
      else buckets['over 90 days'] += x.value;
      if (a > 30) overdue += x.value;
    }
    unpaidPOs.push({ po_base: base, supplier: meta.supplier, project: meta.project,
      unpaid_received_excl: openTotal, overdue_excl: overdue,
      oldest_receipt: oldest, days_since_oldest_receipt: ageDays(oldest),
      finance_scheduled_pending: num(meta.finance_pending) });
    const k = meta.supplier || 'Unknown supplier';
    if (!bySupplier[k]) bySupplier[k] = { supplier: k, po_count: 0, unpaid: 0, overdue: 0, oldest: oldest };
    bySupplier[k].po_count++; bySupplier[k].unpaid += openTotal; bySupplier[k].overdue += overdue;
    if (oldest < bySupplier[k].oldest) bySupplier[k].oldest = oldest;
  }

  const totUnpaid  = unpaidPOs.reduce((s, r) => s + r.unpaid_received_excl, 0);
  const totOverdue = unpaidPOs.reduce((s, r) => s + r.overdue_excl, 0);

  return {
    basis: 'Receipt dates from po_deliveries; PO-level Finance payments applied to the OLDEST deliveries first (Finance does not record which delivery a payment covers, so this is an assumption). Term = 30 days after receipt, subject to QC and rejections — QC status is not considered here.',
    columns_used: { po: poKey, date: dateKey, qty: qtyKey },
    received_unpaid_with_finance_record: { po_count: unpaidPOs.length, ...vat3(totUnpaid) },
    past_30_day_term: vat3(totOverdue),
    ageing_buckets: Object.entries(buckets).map(([bucket, v]) => ({ bucket, ...vat3(v) })),
    by_supplier_overdue_first: Object.values(bySupplier).sort((a, b) => b.overdue - a.overdue).slice(0, 15).map(s => ({
      supplier: s.supplier, po_count: s.po_count, oldest_receipt: s.oldest,
      unpaid: vat3(s.unpaid), past_term: vat3(s.overdue) })),
    oldest_unpaid_pos: unpaidPOs.sort((a, b) => b.days_since_oldest_receipt - a.days_since_oldest_receipt).slice(0, 15).map(r => ({
      po_base: r.po_base, supplier: r.supplier, project: r.project, oldest_receipt: r.oldest_receipt,
      days_since_oldest_receipt: r.days_since_oldest_receipt, unpaid_excl_vat_zar: r2(r.unpaid_received_excl),
      unpaid_incl_vat_zar: r2(r.unpaid_received_excl * (1 + VAT_RATE)),
      past_term_excl_vat_zar: r2(r.overdue_excl), finance_scheduled_pending_zar: r2(r.finance_scheduled_pending) })),
    no_finance_record_at_all: { po_count: noFinCount, ...vat3(noFinTotal),
      note: 'Received but Finance has no record for the PO. May have been paid before the sync started — verify with Siva; not counted above.' },
    data_quality: { deliveries_without_a_price: unvalued, deliveries_without_a_date: undated }
  };
}

async function get_payment_schedule(days = 30) {
  const [pay, fc] = await Promise.all([
    loadPayables(),
    fetchAll('v_payment_forecast_lines',
      'po_base, po_number, supplier, project, description, committed_date, expected_pay_date, outstanding_excl',
      { order: 'po_number' })
  ]);
  if (pay.error) return { error: pay.error };
  if (fc.error)  return { error: fc.error };

  // Prepaid deposit reduces what is still to be paid on that PO base
  const factor = {};
  for (const r of pay.data) {
    const out = num(r.outstanding_excl);
    factor[r.po_base] = out > 0 ? Math.max(0, out - num(r.paid_not_received_excl)) / out : 0;
  }

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const late = [], noDate = [], future = [];
  for (const l of fc.data) {
    const f = factor[l.po_base] !== undefined ? factor[l.po_base] : 1;
    const net = num(l.outstanding_excl) * f;
    const item = { ...l, net_excl: net };
    if (!l.committed_date) noDate.push(item);
    else if (l.committed_date < today) late.push(item);
    else future.push(item);
  }
  const tot = arr => arr.reduce((s, r) => s + r.net_excl, 0);

  // Late deliveries by supplier
  const lateBySup = {};
  for (const l of late) {
    const k = l.supplier || 'Unknown supplier';
    if (!lateBySup[k]) lateBySup[k] = { supplier: k, line_count: 0, net_excl: 0, gross_excl: 0, oldest_committed_date: l.committed_date };
    lateBySup[k].line_count++; lateBySup[k].net_excl += l.net_excl; lateBySup[k].gross_excl += num(l.outstanding_excl);
    if (l.committed_date < lateBySup[k].oldest_committed_date) lateBySup[k].oldest_committed_date = l.committed_date;
  }
  const lateList = Object.values(lateBySup).sort((a, b) => b.net_excl - a.net_excl).map(s => ({
    supplier: s.supplier, line_count: s.line_count, oldest_committed_date: s.oldest_committed_date,
    days_late_oldest: -daysUntil(s.oldest_committed_date),
    outstanding_order_value_excl_vat_zar: r2(s.gross_excl),
    net_after_prepaid: vat3(s.net_excl)
  }));

  // Forecast by month (delivery + 30 days)
  const byMonth = {};
  for (const l of future) {
    const k = String(l.expected_pay_date).slice(0, 7);
    byMonth[k] = (byMonth[k] || 0) + l.net_excl;
  }
  const monthList = Object.keys(byMonth).sort().map(k => ({ month: k, ...vat3(byMonth[k]) }));
  const nearTerm = future.filter(l => l.expected_pay_date <= cutoffStr);

  const rnp = pay.data.filter(r => num(r.received_not_paid_excl) > 1);

  return {
    basis: `FORECAST. Payment date = committed delivery date + ${DEFAULT_PAY_DAYS} days (default term, subject to QC and rejections). Net of any prepaid deposit on the PO.`,
    received_not_paid_now: {
      po_count: rnp.length, ...vat3(rnp.reduce((s, r) => s + num(r.received_not_paid_excl), 0)),
      already_scheduled_by_finance: vat3(rnp.reduce((s, r) => s + num(r.finance_pending), 0)),
      note: 'Goods already received per PMS but not covered by Finance payments. Receipt dates are not available here, so these cannot be dated — Finance decides timing. Some may have been paid before the Finance sync started.'
    },
    near_term_window: { days, up_to: cutoffStr, line_count: nearTerm.length, ...vat3(tot(nearTerm)) },
    forecast_by_month_future_deliveries: monthList,
    late_deliveries_payment_date_unknown: {
      line_count: late.length, ...vat3(tot(late)), by_supplier: lateList,
      note: 'Committed delivery date has passed and the goods are not received. Payment falls 30 days after ACTUAL delivery, so it cannot be forecast until the supplier gives a new date. Chase these suppliers.'
    },
    no_committed_date: { line_count: noDate.length, ...vat3(tot(noDate)),
      note: 'Open lines with no committed date — cannot be placed on the forecast.' },
    vat_note: 'PMS values exclude 15% VAT; payment planning must use incl_vat_zar.'
  };
}

async function get_po_reconciliation_summary() {
  const res = await fetchAll('v_finance_po_reconciliation',
    'po_base, outcome, finance_net_paid_excl, finance_pending, difference', { order: 'po_base' });
  if (res.error) return { error: res.error };
  const data = res.data;

  const byOutcome = {};
  for (const r of data) {
    const key = r.outcome || 'UNKNOWN';
    if (!byOutcome[key]) byOutcome[key] = { outcome: key, count: 0, total_paid_excl_zar: 0, total_pending_zar: 0, total_difference_zar: 0 };
    byOutcome[key].count++;
    byOutcome[key].total_paid_excl_zar += r.finance_net_paid_excl || 0;
    byOutcome[key].total_pending_zar   += r.finance_pending || 0;
    byOutcome[key].total_difference_zar += r.difference || 0;
  }

  return {
    total_pos: data.length,
    by_outcome: Object.values(byOutcome).sort((a,b) => b.count - a.count),
  };
}

async function get_po_reconciliation_issues(outcome_filter) {
  let query = supabase
    .from('v_finance_po_reconciliation')
    .select('po_base, pms_po_number, mapped_supplier, finance_net_paid_excl, '
          + 'finance_pending, difference, credit_notes, finance_documents, outcome')
    .limit(1000);

  if (outcome_filter) {
    query = query.eq('outcome', outcome_filter);
  } else {
    query = query.neq('outcome', 'MATCHED');
  }

  const { data, error } = await query;
  if (error) return { error: `Query failed: ${error.message}` };

  return {
    filter: outcome_filter || 'all non-MATCHED',
    count: data.length,
    issues: data.map(r => ({
      po_base:        r.po_base,
      pms_po_number:  r.pms_po_number,
      supplier:       r.mapped_supplier,
      paid_excl_vat_zar: r.finance_net_paid_excl,
      pending_zar:    r.finance_pending,
      difference_zar: r.difference,
      credit_notes:   r.credit_notes,
      finance_documents: r.finance_documents,
      outcome:        r.outcome,
    }))
  };
}

async function list_projects() {
  const { data, error } = await supabase
    .from('projects')
    .select('project_name, product, status, budget, start_date, end_date, manager');
  if (error) return { error: `Query failed: ${error.message}` };
  return { projects: data };
}

async function get_project_financial_summary(project_name) {
  if (!project_name) return { error: 'project_name is required' };

  const { data: proj, error: projErr } = await supabase
    .from('projects')
    .select('project_name, product, status, budget, start_date, end_date, manager')
    .eq('project_name', project_name)
    .maybeSingle();
  if (projErr) return { error: `Query failed: ${projErr.message}` };
  if (!proj) return { error: `No project found named "${project_name}". Use list_projects to see valid names.` };

  const lr = await fetchAll('v_po_line_commitment',
    'product, ordered_value, received_value, committed_value, over_receipt_value, is_over_receipt, is_cancelled',
    { mod: q => q.eq('project', project_name) });
  if (lr.error) return { error: lr.error };

  const active = (lr.data || []).filter(r => !r.is_cancelled);
  const sum = (arr, f) => arr.reduce((s,r) => s+(r[f]||0), 0);

  const totalOrdered    = sum(active, 'ordered_value');
  const totalReceived   = sum(active, 'received_value');
  const totalCommitted  = sum(active, 'committed_value');
  const totalOverReceipt = sum(active, 'over_receipt_value');
  const overReceiptLines = active.filter(r => r.is_over_receipt).length;

  const budget = proj.budget || 0;
  const remaining = budget - totalCommitted;
  const pctConsumed = budget > 0 ? (totalCommitted / budget) * 100 : null;

  const byProduct = {};
  for (const r of active) {
    const p = r.product || 'Unspecified';
    if (!byProduct[p]) byProduct[p] = { product: p, ordered_value: 0, received_value: 0, committed_value: 0 };
    byProduct[p].ordered_value   += r.ordered_value || 0;
    byProduct[p].received_value  += r.received_value || 0;
    byProduct[p].committed_value += r.committed_value || 0;
  }

  return {
    project_name: proj.project_name,
    status: proj.status,
    manager: proj.manager,
    budget_zar: budget,
    total_ordered_excl_vat_zar:   totalOrdered,
    total_received_excl_vat_zar:  totalReceived,
    total_committed_excl_vat_zar: totalCommitted,
    remaining_budget_zar: remaining,
    percent_budget_consumed: pctConsumed !== null ? Math.round(pctConsumed * 10) / 10 : null,
    over_receipt: overReceiptLines > 0
      ? { line_count: overReceiptLines, total_value_zar: totalOverReceipt,
          note: 'Received more stock than originally ordered on these lines — already included in total_committed, not an error.' }
      : null,
    breakdown_by_product: Object.values(byProduct),
    caveats: budget === 0
      ? ['This project has no budget captured in the PMS — remaining budget and % consumed cannot be calculated.']
      : []
  };
}


// ── Generic read-only data access (whitelisted sources only) ────────────────

const DATA_SOURCES = {
  // Build / stock
  v_rll_build_readiness:   'RLL BOM readiness per line: stock, WO/service-order committed, holding (process) qty, on order, supplier ETA',
  v_grn40_build_readiness: 'GRN40 BOM readiness per line (same shape as the RLL one)',
  v_rll_build_progress:    'Production Progress per BOM line for a project (project_name): ready / process / on order / gap bands',
  v_rll_build_effective:   'Production Progress lines with parent-buffer correction: effective_need, needs_sourcing, ETAs',
  build_dependencies:      'Build Sequence rules: which assembly waits for which, with sequence_no',
  stock_items:             'Stock rows per part and storeroom (stock_code, stock_qty, storeroom, batch_ref)',
  part_lead_times:         'Supplier lead times per part (partly filled)',
  work_orders:             'Work orders; customer holds the project name',
  service_orders:          'Open/closed service orders (LSO/ESO) — parts out on external processes',
  rejection_tracking:      'QC rejections per delivery/part with status and quantities',
  weapon_serials:          'Blue Card serial register: serial, card_type, status per contract',
  // Purchasing / finance
  po_lines:                'PO delivery lines: po_number, description, qty_ordered, qty_received, unit_price (excl VAT), committed_date, line_status',
  component_pricing:       'Component Pricing screen records (invoice unit prices): stock_item_id, item_name, stock_code, supplier, po_number, invoice_number, unit_price, price_date, product',
  po_deliveries:           'Actual deliveries received against POs, with dates',
  supplier_po:             'PO headers/lines with supplier, project, product, po_type',
  suppliers:               'Supplier master list',
  v_po_payables:           'Per PMS PO: committed, received, outstanding, Finance paid/pending, received-not-paid, paid-not-received (excl VAT)',
  v_payment_forecast_lines:'Outstanding PO lines with forecast pay date (committed date + 30 days)',
  v_po_line_commitment:    'Per PO line ordered/received/committed value, over-receipt flags, project, product',
  v_finance_po_reconciliation: 'Finance vs PMS PO reconciliation: paid, pending, difference, outcome, credit notes',
  finance_payment_lines:   'Finance payment lines synced from SharePoint',
  // Projects
  projects:                'Projects: name, product, status, budget, target_qty, dates, manager',
  contracts:               'Contract values per project (currently empty)',
  project_deposits:        'Customer deposits per project (currently empty)',
  contract_opex:           'Non-PO operating costs per project',
  project_fund_transfers:  'Fund transfers between projects',
  consumable_project_allocations: 'Paint/sand consumable cost allocated to projects'
};

const validIdent = x => typeof x === 'string' && /^[A-Za-z0-9_]+$/.test(x);

function trimCell(v) {
  return typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
}
function trimRows(rows) {
  return rows.map(r => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = trimCell(v); return o; });
}
function capPayload(obj, key) {
  // keep the JSON handed to the model small (speed + token cost)
  let rows = obj[key];
  while (rows.length > 1 && JSON.stringify(obj).length > 14000) {
    rows = rows.slice(0, Math.max(1, Math.floor(rows.length * 0.7)));
    obj[key] = rows; obj.truncated_for_size = true;
  }
  return obj;
}

async function list_data_sources(source) {
  if (!source) {
    return {
      sources: Object.entries(DATA_SOURCES).map(([name, description]) => ({ name, description })),
      note: 'Read-only. Call list_data_sources with a source name to see its real columns before querying it.'
    };
  }
  if (!DATA_SOURCES[source]) return { error: `"${source}" is not an available source. Use list_data_sources with no argument to see the list.` };
  const { data, error } = await supabase.from(source).select('*').limit(1);
  if (error) return { error: `Could not read ${source}: ${error.message}` };
  if (!data || data.length === 0) {
    return { source, description: DATA_SOURCES[source], columns: null,
      note: 'No rows came back — the table may be empty, or the bot has no read access to it (RLS returns zero rows silently), so columns are unknown.' };
  }
  return { source, description: DATA_SOURCES[source], columns: Object.keys(data[0]), sample_row: trimRows(data)[0] };
}

async function query_data(args) {
  const source = args.source;
  if (!DATA_SOURCES[source]) return { error: `"${source}" is not an available source. Use list_data_sources to see the list.` };

  const selParts = String(args.select || '*').split(',').map(x => x.trim()).filter(Boolean);
  for (const c of selParts) if (c !== '*' && !validIdent(c)) return { error: `Invalid column "${c}" in select (plain column names only).` };
  const sel = selParts.join(',') || '*';

  const filters = Array.isArray(args.filters) ? args.filters : [];
  for (const f of filters) if (!validIdent(f.column)) return { error: `Invalid filter column "${f.column}".` };
  if (args.order_by && !validIdent(args.order_by)) return { error: `Invalid order_by "${args.order_by}".` };
  if (args.group_by && !validIdent(args.group_by)) return { error: `Invalid group_by "${args.group_by}".` };
  const sums = (Array.isArray(args.sum_columns) ? args.sum_columns : []);
  for (const c of sums) if (!validIdent(c)) return { error: `Invalid sum column "${c}".` };

  const applyFilters = q => {
    for (const f of filters) {
      const v = f.value;
      switch (f.op) {
        case 'eq':  q = q.eq(f.column, v); break;
        case 'neq': q = q.neq(f.column, v); break;
        case 'gt':  q = q.gt(f.column, v); break;
        case 'gte': q = q.gte(f.column, v); break;
        case 'lt':  q = q.lt(f.column, v); break;
        case 'lte': q = q.lte(f.column, v); break;
        case 'like':  q = q.like(f.column, String(v)); break;
        case 'ilike': q = q.ilike(f.column, String(v)); break;
        case 'in':  q = q.in(f.column, Array.isArray(v) ? v : [v]); break;
        case 'is_null':  q = q.is(f.column, null); break;
        case 'not_null': q = q.not(f.column, 'is', null); break;
        default: throw new Error(`Unsupported filter operator "${f.op}".`);
      }
    }
    return q;
  };

  try {
    // Grouped totals: pull up to 5,000 matching rows and aggregate here
    if (args.group_by) {
      const cols = [args.group_by, ...sums].join(',');
      const res = await fetchAll(source, cols, { order: args.group_by, mod: applyFilters, maxRows: 5000 });
      if (res.error) return { error: res.error };
      const groups = {};
      for (const r of res.data) {
        const k = r[args.group_by] === null || r[args.group_by] === undefined ? 'NULL' : String(r[args.group_by]);
        if (!groups[k]) { groups[k] = { [args.group_by]: k, row_count: 0 }; for (const c of sums) groups[k][c + '_total'] = 0; }
        groups[k].row_count++;
        for (const c of sums) groups[k][c + '_total'] += num(r[c]);
      }
      const sortKey = sums.length ? sums[0] + '_total' : 'row_count';
      const limit = Math.min(Math.max(parseInt(args.limit) || 30, 1), 100);
      const list = Object.values(groups).sort((a, b) => num(b[sortKey]) - num(a[sortKey]));
      const out = { source, group_by: args.group_by, groups_total: list.length, groups: list.slice(0, limit).map(g => {
        const o = {}; for (const [k, v] of Object.entries(g)) o[k] = typeof v === 'number' ? r2(v) : v; return o; }),
        rows_scanned: res.data.length,
        note: res.data.length >= 5000 ? 'Scanned the first 5,000 matching rows only — totals may be incomplete; narrow the filters.' : undefined };
      return capPayload(out, 'groups');
    }

    // Plain rows
    const limit = Math.min(Math.max(parseInt(args.limit) || 50, 1), 200);
    let q = supabase.from(source).select(sel);
    q = applyFilters(q);
    if (args.order_by) q = q.order(args.order_by, { ascending: !args.descending });
    q = q.limit(limit);
    const { data, error } = await q;
    if (error) return { error: `Query on ${source} failed: ${error.message}` };
    const out = { source, row_count: data.length, rows: trimRows(data),
      note: data.length === 0 ? 'No rows. Either nothing matches, or the bot has no read access to this table (RLS returns zero rows silently).'
        : (data.length >= limit ? `Showing the first ${limit} rows — there may be more.` : undefined) };
    return data.length ? capPayload(out, 'rows') : out;
  } catch (e) {
    return { error: e.message };
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

async function runTool(name, input) {
  try {
    if (name === 'get_rll_shortfall')             return await get_rll_shortfall(input.qty || 1);
    if (name === 'get_grn40_shortfall')           return await get_grn40_shortfall(input.qty || 1);
    if (name === 'get_unit_component_cost')       return await get_unit_component_cost(input.product, input.show_all === true);
    if (name === 'get_rll_units_built')           return await get_rll_units_built();
    if (name === 'get_sub_builds_completed')      return await get_sub_builds_completed();
    if (name === 'get_sub_builds_hampering')      return await get_sub_builds_hampering();
    if (name === 'get_sub_build_priorities')      return await get_sub_build_priorities();
    if (name === 'get_project_progress')          return await get_project_progress();
    if (name === 'get_rll_deadline_risk')         return await get_rll_deadline_risk(input.qty, input.show_all === true);
    if (name === 'get_open_work_orders')          return await get_open_work_orders(input.project_name);
    if (name === 'get_open_po_value')             return await get_open_po_value();
    if (name === 'get_payables_summary')          return await get_payables_summary(input.project_name);
    if (name === 'get_prepaid_limbo')             return await get_prepaid_limbo();
    if (name === 'get_supplier_spend')            return await get_supplier_spend(input.supplier);
    if (name === 'get_receipt_ageing')            return await get_receipt_ageing();
    if (name === 'get_payment_schedule')          return await get_payment_schedule(input.days || 30);
    if (name === 'get_po_reconciliation_summary') return await get_po_reconciliation_summary();
    if (name === 'get_po_reconciliation_issues')  return await get_po_reconciliation_issues(input.outcome_filter);
    if (name === 'get_project_financial_summary') return await get_project_financial_summary(input.project_name);
    if (name === 'list_data_sources')             return await list_data_sources(input.source);
    if (name === 'query_data')                    return await query_data(input);
    if (name === 'list_projects')                 return await list_projects();
    return { error: `Unknown tool: ${name}` };
  } catch (err) {
    return { error: `Tool ${name} failed: ${err.message}` };
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'Method Not Allowed' };

  const started = Date.now();
  const BUDGET_MS = 52000;     // Netlify cuts synchronous functions off at 60s
  const elapsed = () => Date.now() - started;
  const say = text => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }) });

  try {
    const { messages } = JSON.parse(event.body);
    let conversation  = [...messages];
    let finalResponse = null;

    const todayStr = new Date().toISOString().slice(0, 10);
    const systemWithDate = SYSTEM_PROMPT
      + `\n\nTODAY'S DATE: ${todayStr}. Days remaining to the 2026 400 RLL delivery deadline (${DEADLINE_400}): ${daysUntil(DEADLINE_400)}.`;

    for (let i = 0; i < 8; i++) {
      const remaining = BUDGET_MS - elapsed();
      if (remaining < 8000) {
        console.log(`[chat] out of time before iteration ${i} at ${elapsed()}ms`);
        return say('That question needed more time than this chat allows (60 seconds). Please ask for a narrower version — for example "top 10 only", or one tool at a time — and I will answer it straight away.');
      }
      const t0 = Date.now();
      let res;
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: AbortSignal.timeout(remaining),
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model:      'claude-sonnet-4-6',
            max_tokens: 2400,
            system:     systemWithDate,
            tools:      TOOLS,
            messages:   conversation
          })
        });
      } catch (e) {
        console.log(`[chat] Claude call ${i} aborted after ${Date.now() - t0}ms: ${e.message}`);
        return say('The answer took too long to write and was cut off at the 60-second limit. Please ask for a shorter version (for example "top 10 only") and I will answer it straight away.');
      }
      const data = await res.json();
      console.log(`[chat] Claude call ${i}: ${Date.now() - t0}ms, stop=${data.stop_reason}, out_tokens=${data.usage && data.usage.output_tokens}`);

      if (data.stop_reason === 'tool_use') {
        conversation.push({ role: 'assistant', content: data.content });
        const tools = data.content.filter(b => b.type === 'tool_use');
        const results = await Promise.all(tools.map(async block => {
          const t1 = Date.now();
          const out = JSON.stringify(await runTool(block.name, block.input));
          console.log(`[chat] tool ${block.name}: ${Date.now() - t1}ms, ${out.length} chars`);
          return { type: 'tool_result', tool_use_id: block.id, content: out };
        }));
        conversation.push({ role: 'user', content: results });
        continue;
      }
      finalResponse = data;
      break;
    }

    if (!finalResponse) return say('I could not finish that in the allowed steps. Please ask a narrower question.');
    console.log(`[chat] done in ${elapsed()}ms`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalResponse)
    };
  } catch (err) {
    console.log(`[chat] error after ${elapsed()}ms: ${err.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
