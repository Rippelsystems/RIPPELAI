// ============================================================
// chat.js — Netlify serverless function
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const VAT_RATE = 0.15;

const SYSTEM_PROMPT = `You are RippelAI, an internal financial and production
intelligence assistant for Rippel Effect Systems, a South African firearms
manufacturer. Your users are Fritz (CEO/MD), Siva (Finance), and Michiel
(Technical Manager). Currency is always South African Rand (ZAR).

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
- VAT: every PMS PO value (po_lines, v_po_line_commitment) EXCLUDES 15%
  VAT. Siva's Finance payment figures and all payment/cashflow PLANNING
  numbers include 15% VAT — that is what actually gets paid. Whenever a
  PMS value and a payment-planning value are shown together, ALWAYS show
  three figures explicitly: the PMS amount (excl. VAT), the VAT amount
  (15% of it), and the payment-planning amount (incl. VAT). Never show
  only one and make the user infer the difference.
- "finance_pending" (v_finance_po_reconciliation) = an amount Finance has
  SCHEDULED to pay in an upcoming bank run. It has NOT been paid yet —
  it clears once the bank run executes and is referenced to the PO. This
  is a planned outflow, not a reconciliation problem.
- outcome = "AMOUNT DIFFERENCE" is usually NOT an error — it typically
  means more stock was received than the PO originally specified (see
  is_over_receipt / over_receipt_value in v_po_line_commitment), so the
  invoiced amount legitimately exceeds the original PO value. Report the
  difference factually; do not call it a discrepancy by default.
- PCA vs POA reference prefix: "POA..." = normal payment for goods/stock.
  "PCA..." = a CREDIT reference — either a supplier credit note reducing
  what's owed, OR a penalty deducted because the supplier missed their
  committed delivery date (from the RFQ/PO). Never read a PCA as
  unexplained spend — it is money owed back or a legitimate deduction.
- Supplier deposits: some suppliers require an upfront deposit before
  starting a job, paid before any delivery or invoice exists. A deposit
  against a PO with no matching delivery yet is NORMAL, not a discrepancy.
- "#" mark on an invoice number: Siva marks legacy (non-PMS) POs with "#"
  on her payment sheet — that line is excluded from sync and never reaches
  finance_payment_lines / v_finance_po_reconciliation.
- outcome = "UNKNOWN PO": the sync could not match a payment to a PMS PO.
  This is a FLAG TO INVESTIGATE, not an automatic error — it may be (1) a
  legacy PO not yet marked "#", (2) something unrelated to current tracked
  projects, or (3) a genuine mapping error. Report which case applies if
  determinable, otherwise say it needs review — never dismiss it, never
  call it a confirmed error.
- outcome = "MATCHED": Finance and PMS agree — no action needed.

Never guess. Always call the appropriate tool. Always state currency as
R (ZAR). Be concise and direct — these are busy operational stakeholders.`;

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
    name: 'get_open_po_value',
    description: 'True cash position on open POs: gross committed (PMS, excl '
      + 'VAT), already-paid, prepaid deposits, net still owed — shown both '
      + 'excl and incl 15% VAT. Use for PO exposure, outstanding commitments, '
      + 'or cashflow questions.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_payment_schedule',
    description: 'Upcoming unpaid supplier deliveries within N days (default '
      + '30) with net cash required (excl and incl VAT), plus overdue unpaid '
      + 'lines. Use for cashflow planning or overdue PO follow-up.',
    input_schema: { type: 'object', properties: {
      days: { type: 'integer', description: 'Days ahead to look. Defaults to 30.' }
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
    name: 'list_projects',
    description: 'Returns all project names/codes currently in the system, '
      + 'with their budget and status. Use when the user asks what projects '
      + 'exist, or names a project ambiguously and you need to find the '
      + 'exact project_name to pass to get_project_financial_summary.',
    input_schema: { type: 'object', properties: {} }
  }
];

// ── Shared BOM shortfall logic ──────────────────────────────────────────────

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

// ── Stock tools ──────────────────────────────────────────────────────────────

async function get_rll_shortfall(qty = 1) {
  const { data: allRows, error } = await supabase
    .from('v_rll_build_readiness')
    .select('component_id, dependant_code, item_name, stock_code, storeroom, '
          + 'available_qty, wo_committed_qty, so_committed_qty, holding_qty, '
          + 'on_order_qty, supplier_earliest_eta, need_for_1_rll, req_per_unit, '
          + 'shortfall, build_status, is_assembly_group');
  if (error) return { error: `Query failed: ${error.message}` };

  const { data: crossStoreRows } = await supabase
    .from('stock_items').select('stock_code, stock_qty, storeroom')
    .in('storeroom', ['XRGL Store', 'GRN40 Store', 'RLL Legacy Store']).gt('stock_qty', 0);

  const crossStoreMap = {};
  for (const row of (crossStoreRows || [])) {
    const code = row.stock_code ? row.stock_code.split('_')[0] : '';
    if (code) crossStoreMap[code] = (crossStoreMap[code] || 0) + row.stock_qty;
  }

  const shortages = buildShortfallResult(allRows, qty, 'need_for_1_rll').map(r => {
    const crossStore = crossStoreMap[r.stock_code] || 0;
    return {
      ...r,
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

// ── Finance / PO tools ───────────────────────────────────────────────────────

async function get_open_po_value() {
  const { data, error } = await supabase
    .from('v_finance_po_reconciliation')
    .select('po_base, finance_net_paid_excl, finance_pending, pms_cash_paid, difference, outcome');
  if (error) return { error: `Query failed: ${error.message}` };

  const { data: commitData, error: err2 } = await supabase
    .from('v_po_line_commitment')
    .select('committed_value, is_cancelled');
  if (err2) return { error: `Query failed: ${err2.message}` };

  const grossCommittedExclVat = (commitData || [])
    .filter(r => !r.is_cancelled)
    .reduce((s, r) => s + (r.committed_value || 0), 0);

  const totalPaid   = data.reduce((s, r) => s + (r.finance_net_paid_excl || 0), 0);
  const totalPending = data.reduce((s, r) => s + (r.finance_pending || 0), 0);
  const netOwedExclVat = Math.max(0, grossCommittedExclVat - totalPaid);

  return {
    excl_vat: {
      gross_committed_zar: grossCommittedExclVat,
      already_paid_zar:    totalPaid,
      scheduled_pending_zar: totalPending,
      net_still_owed_zar: netOwedExclVat,
    },
    incl_vat_15pct: {
      gross_committed_zar: grossCommittedExclVat * (1 + VAT_RATE),
      net_still_owed_zar:  netOwedExclVat * (1 + VAT_RATE),
      vat_amount_on_net_owed_zar: netOwedExclVat * VAT_RATE,
    },
    note: 'PMS figures are captured excl. 15% VAT. Payment planning must use the incl_vat_15pct figures — that is what actually gets paid to suppliers.'
  };
}

async function get_payment_schedule(days = 30) {
  const { data, error } = await supabase
    .from('v_payment_schedule')
    .select('po_number, description, line_status, committed_date, qty_outstanding, '
          + 'unit_price, line_value, prepaid_amount, invoice_paid');
  if (error) return { error: `Query failed: ${error.message}` };

  const unpaid = data.filter(r => r.invoice_paid !== true);
  const today  = new Date(); today.setHours(0,0,0,0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + days);

  const due     = unpaid.filter(r => { const d=new Date(r.committed_date); return d>=today && d<=cutoff; });
  const overdue = unpaid.filter(r => new Date(r.committed_date) < today);
  const sum     = (arr, f) => arr.reduce((s,r) => s+(r[f]||0), 0);

  const dueNetExcl     = Math.max(0, sum(due,'line_value') - sum(due,'prepaid_amount'));
  const overdueNetExcl = Math.max(0, sum(overdue,'line_value') - sum(overdue,'prepaid_amount'));

  return {
    period_days: days,
    due_in_period: {
      line_count: due.length,
      excl_vat_zar: dueNetExcl,
      incl_vat_15pct_zar: dueNetExcl * (1 + VAT_RATE),
    },
    overdue_unpaid: {
      line_count: overdue.length,
      excl_vat_zar: overdueNetExcl,
      incl_vat_15pct_zar: overdueNetExcl * (1 + VAT_RATE),
      note: overdue.length > 0
        ? 'Past committed delivery date, unpaid, still open — follow up with suppliers urgently'
        : 'No overdue unpaid lines'
    },
    note: 'PMS values are excl. 15% VAT. Payment planning must use incl_vat_15pct_zar figures.'
  };
}

async function get_po_reconciliation_summary() {
  const { data, error } = await supabase
    .from('v_finance_po_reconciliation')
    .select('outcome, finance_net_paid_excl, finance_pending, difference');
  if (error) return { error: `Query failed: ${error.message}` };

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
          + 'finance_pending, difference, credit_notes, finance_documents, outcome');

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

  const { data: lines, error: linesErr } = await supabase
    .from('v_po_line_commitment')
    .select('product, ordered_value, received_value, committed_value, over_receipt_value, is_over_receipt, is_cancelled')
    .eq('project', project_name);
  if (linesErr) return { error: `Query failed: ${linesErr.message}` };

  const active = (lines || []).filter(r => !r.is_cancelled);
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

// ── Router ──────────────────────────────────────────────────────────────────

async function runTool(name, input) {
  if (name === 'get_rll_shortfall')             return get_rll_shortfall(input.qty || 1);
  if (name === 'get_grn40_shortfall')           return get_grn40_shortfall(input.qty || 1);
  if (name === 'get_open_po_value')             return get_open_po_value();
  if (name === 'get_payment_schedule')          return get_payment_schedule(input.days || 30);
  if (name === 'get_po_reconciliation_summary') return get_po_reconciliation_summary();
  if (name === 'get_po_reconciliation_issues')  return get_po_reconciliation_issues(input.outcome_filter);
  if (name === 'get_project_financial_summary') return get_project_financial_summary(input.project_name);
  if (name === 'list_projects')                 return list_projects();
  return { error: `Unknown tool: ${name}` };
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { messages } = JSON.parse(event.body);
    let conversation  = [...messages];
    let finalResponse = null;

    for (let i = 0; i < 6; i++) {
      const res  = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 2000,
          system:     SYSTEM_PROMPT,
          tools:      TOOLS,
          messages:   conversation
        })
      });
      const data = await res.json();

      if (data.stop_reason === 'tool_use') {
        conversation.push({ role: 'assistant', content: data.content });
        const results = [];
        for (const block of data.content.filter(b => b.type === 'tool_use')) {
          results.push({
            type: 'tool_result', tool_use_id: block.id,
            content: JSON.stringify(await runTool(block.name, block.input))
          });
        }
        conversation.push({ role: 'user', content: results });
        continue;
      }
      finalResponse = data;
      break;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalResponse)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

