// ============================================================
// chat.js — Netlify serverless function
// Proxies chat requests from the browser to the Anthropic API,
// and gives Claude tools to query live Supabase data instead of
// reasoning from its own knowledge.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

// ---- Config (from Netlify environment variables) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- System prompt ----
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
- If a component's immediate parent assembly already has enough stock on
  its own, a raw-material shortage on that component is NOT a real build
  blocker — the business will use the assembled stock on the shelf rather
  than build more of that assembly from scratch. Only report genuine,
  actionable shortages.
- Never guess or estimate figures. Always call the appropriate tool to get
  real data. If a tool returns no data or an error, say so plainly rather
  than filling in a plausible-sounding number.
- Always state currency as R (ZAR) for any monetary figure.
- Be concise and direct. These are busy operational stakeholders who need
  clear answers, not lengthy explanations.`;

// ---- Tool definitions Claude can call ----
const TOOLS = [
  {
    name: 'get_rll_shortfall',
    description: 'Returns the genuine, actionable stock shortages preventing '
      + 'a build of N units of RLL right now (default 1). Excludes '
      + 'structural BOM container nodes (assembly groupings with no '
      + 'physical stock of their own) and excludes raw-material shortages '
      + 'whose parent assembly already has sufficient stock on hand. Use '
      + 'this whenever asked about RLL stock readiness, build blockers, or '
      + 'what is missing to build RLL.',
    input_schema: {
      type: 'object',
      properties: {
        qty: {
          type: 'integer',
          description: 'Number of RLL units to check readiness for. Defaults to 1.'
        }
      }
    }
  }
];

// ---- Tool implementation ----
async function get_rll_shortfall(qty = 1) {
  const { data: allRows, error } = await supabase
    .from('v_rll_build_readiness')
    .select('component_id, dependant_code, item_name, stock_code, storeroom, available_qty, on_order_qty, supplier_earliest_eta, need_for_1_rll, shortfall, build_status, is_assembly_group');

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

  const realShortages = scaledRows.filter(row => {
    if (row.build_status === 'CONTAINER') return false;

    if (row.available_qty >= row.scaled_need) return false;

    const parent = row.dependant_code ? byComponentId[row.dependant_code] : null;

    if (!parent) return true;

    // The only thing that matters is whether the parent itself already
    // holds enough physical stock to cover the need — NOT whether it is
    // flagged is_assembly_group. That flag is unreliable: some real,
    // physically-stocked sub-assemblies (e.g. TRIGGER GUARD ASSEMBLY,
    // which can carry hundreds of units in Main Store) are still flagged
    // is_assembly_group = true, same as pure structural nodes that never
    // hold stock (e.g. FRONT GROUP). Comparing the parent's own
    // available_qty against its own need is what actually determines
    // whether the shelf already covers this requirement.
    if (parent.available_qty >= parent.scaled_need) return false;

    return true;
  });

  return {
    product: 'RLL',
    build_qty: qty,
    total_shortages: realShortages.length,
    shortages: realShortages.map(r => ({
      item_name: r.item_name,
      stock_code: r.stock_code,
      available: r.available_qty,
      needed: r.scaled_need,
      on_order: r.on_order_qty,
      supplier_eta: r.supplier_earliest_eta,
      gap_after_on_order: Math.max(0, r.scaled_need - r.available_qty - r.on_order_qty)
    }))
  };
}

// ---- Tool dispatch ----
async function runTool(name, input) {
  if (name === 'get_rll_shortfall') {
    return get_rll_shortfall(input.qty || 1);
  }
  return { error: `Unknown tool: ${name}` };
}

// ---- Main handler ----
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
