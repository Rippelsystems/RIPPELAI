// ============================================================
// chat.js — Netlify serverless function
// Proxies chat requests from the browser to the Anthropic API,
// and gives Claude tools to query live Supabase data instead of
// reasoning from its own knowledge.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SYSTEM_PROMPT = `You are RippelAI, an internal financial and production
intelligence assistant for Rippel Effect Systems, a South African firearms
manufacturer. Your users are Fritz (CEO/MD), Siva (Finance), and Michiel
(Technical Manager). Currency is always South African Rand (ZAR).

Product lines: XRGL40, GRN40, and RLL.

IMPORTANT DATA RULES:
- "On Order" quantities are informational only for planning. They do NOT
  count as available stock. Only physically available stock (Main Store or
  pooled COTS Store quantities) counts toward whether something is ready
  to build right now.
- "Holding Store WIP" (holding_wip) is stock that physically exists and
  has already been paid for, but is currently mid-process (e.g. machining,
  anodizing, external service) and is NOT yet usable in a build. Always
  report this separately from available stock and from on-order stock.
  The correct action for a holding_wip shortage is to chase the in-process
  step to completion — NOT to raise a new purchase order. Only report
  "needs sourcing from scratch" (needs_sourcing) for the quantity that is
  genuinely unaccounted for after subtracting available + holding_wip +
  on_order from the effective need.
- If a parent assembly already has partial stock on the shelf, the child
  raw parts only need to cover the parent's REMAINING gap — not the full
  build quantity. Example: if you need 400 assemblies and already have 244
  built, you only need to build 156 more, so the raw parts only need to
  cover 156 units worth, not 400.
- If a component's immediate parent assembly already has enough stock on
  its own to cover the full need, a raw-material shortage on that component
  is NOT a real build blocker at all.
- Never guess or estimate figures. Always call the appropriate tool to get
  real data. If a tool returns no data or an error, say so plainly rather
  than filling in a plausible-sounding number.
- Always state currency as R (ZAR) for any monetary figure.
- Lines with no unit_price are excluded from value totals — always flag
  how many unpriced lines exist so the user knows the total may be understated.
- Be concise and direct. These are busy operational stakeholders who need
  clear answers, not lengthy explanations.`;

const TOOLS = [
  {
    name: 'get_rll_shortfall',
    description: 'Returns the genuine, actionable stock shortages preventing '
      + 'a build of N units of RLL right now (default 1). Excludes '
      + 'structural BOM container nodes (assembly groupings with no '
      + 'physical stock of their own), excludes raw-material shortages '
      + 'whose parent assembly already has sufficient stock on hand, and '
      + 'correctly accounts for partial parent coverage (e.g. if 244 '
      + 'assemblies already exist for a 400-unit build, child parts only '
      + 'need to cover the remaining 156). Use this whenever asked about '
      + 'RLL stock readiness, build blockers, or what is missing to build RLL.',
    input_schema: {
      type: 'object',
      properties: {
        qty: {
          type: 'integer',
          description: 'Number of RLL units to check readiness for. Defaults to 1.'
        }
      }
    }
  },
  {
    name: 'get_open_po_value',
    description: 'Returns the total ZAR value of all open (outstanding) purchase '
      + 'order lines — i.e. everything ordered but not yet fully received. '
      + 'Also returns the count of lines, how many have no unit price (and '
      + 'are therefore excluded from the total), and the total prepaid amount '
      + 'already paid against open lines. Use this whenever asked about total '
      + 'open PO value, how much is on order, outstanding commitments, or '
      + 'overall purchasing exposure.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  }
];

async function get_rll_shortfall(qty = 1) {
  const { data: allRows, error } = await supabase
    .from('v_rll_build_readiness')
    .select('component_id, dependant_code, item_name, stock_code, storeroom, available_qty, holding_qty, on_order_qty, supplier_earliest_eta, need_for_1_rll, req_per_unit, shortfall, build_status, is_assembly_group');

  if (error) {
    return { error: `Query failed: ${error.message}` };
  }

  const scaledRows = allRows.map(row => ({
    ...row,
    scaled_need: row.need_for_1_rll * qty
  }));

  const byComponentId = {};
  for (const row of scaledRows) {
    if (row.component_id) byComponentId[row.component_id] = row;
  }

  // Compute effective need for a child row.
  // If the parent assembly already has some units built on the shelf, the child
  // only needs to cover the parent's REMAINING GAP × child's req_per_unit —
  // not the full scaled_need. This prevents falsely reporting a shortage on a
  // raw part when the parent assembly already has most of what is needed.
  function getEffectiveNeed(row) {
    const parent = row.dependant_code ? byComponentId[row.dependant_code] : null;
    if (!parent) return row.scaled_need;
    if (parent.available_qty >= parent.scaled_need) return 0;
    return Math.max(0, parent.scaled_need - parent.available_qty) * row.req_per_unit;
  }

  const realShortages = scaledRows
    .filter(row => {
      if (row.build_status === 'CONTAINER') return false;

      const parent = row.dependant_code ? byComponentId[row.dependant_code] : null;

      // If parent already has enough stock on hand, child shortage is irrelevant
      if (parent && parent.available_qty >= parent.scaled_need) return false;

      // Only report if something genuinely still needs sourcing from scratch
      // after accounting for available, WIP in Holding Store, and on-order
      const need = getEffectiveNeed(row);
      const needsSourcing = Math.max(0, need - row.available_qty - row.holding_qty - row.on_order_qty);
      return needsSourcing > 0;
    })
    .map(r => {
      const need = getEffectiveNeed(r);
      return {
        item_name: r.item_name,
        stock_code: r.stock_code,
        available: r.available_qty,
        holding_wip: r.holding_qty,
        needed: need,
        on_order: r.on_order_qty,
        supplier_eta: r.supplier_earliest_eta,
        needs_sourcing: Math.max(0, need - r.available_qty - r.holding_qty - r.on_order_qty)
      };
    });

  return {
    product: 'RLL',
    build_qty: qty,
    total_shortages: realShortages.length,
    shortages: realShortages
  };
}

async function get_open_po_value() {
  const { data, error } = await supabase
    .from('v_open_po_value')
    .select('po_number, description, line_status, qty_outstanding, unit_price, line_value, committed_date, invoice_paid, prepaid_amount');

  if (error) {
    return { error: `Query failed: ${error.message}` };
  }

  const totalValue    = data.reduce((sum, r) => sum + (r.line_value     || 0), 0);
  const totalPrepaid  = data.reduce((sum, r) => sum + (r.prepaid_amount  || 0), 0);
  const unpricedCount = data.filter(r => !r.unit_price || r.unit_price === 0).length;

  return {
    total_open_po_value_zar: totalValue,
    total_line_count: data.length,
    unpriced_line_count: unpricedCount,
    total_prepaid_zar: totalPrepaid,
    note: unpricedCount > 0
      ? `${unpricedCount} line(s) have no unit price and are excluded from the total — actual exposure is higher`
      : null
  };
}

async function runTool(name, input) {
  if (name === 'get_rll_shortfall') return get_rll_shortfall(input.qty || 1);
  if (name === 'get_open_po_value') return get_open_po_value();
  return { error: `Unknown tool: ${name}` };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { messages } = JSON.parse(event.body);

    let conversation = [...messages];
    let finalResponse = null;

    for (let i = 0; i < 5; i++) {
      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: conversation
        })
      });

      const data = await apiResponse.json();

      if (data.stop_reason === 'tool_use') {
        const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');

        conversation.push({ role: 'assistant', content: data.content });

        const toolResults = [];
        for (const block of toolUseBlocks) {
          const result = await runTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        }

        conversation.push({ role: 'user', content: toolResults });
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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
