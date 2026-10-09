/* The demo's logic, kept apart from the page so it can be tested in Node.
 *
 * Every figure starts from demo-data.js, which the real engine produced
 * (affordability/scripts/export_static_demo.py). What happens here:
 *
 *  - accepting a finding applies the changes the real engine worked out for it
 *  - recategorising a transaction re-averages the bank figures and re-runs the
 *    spending check -- the one rule this page repeats: the bank's figure is taken
 *  - totals are recalculated the way the fact find does it
 *  - forms are filled in the browser from the same mapping files
 */
(function (root) {
  "use strict";

  const INCOME_FIELDS = ["basic_salary", "bonus", "overtime", "commission",
                         "self_employed_profit", "other_income"];
  const INCOME_CATS = ["SALARY", "BENEFITS", "PENSION_INCOME", "OTHER_INCOME"];
  const NOT_SPENDING = ["TRANSFER", "REFUND", "UNCATEGORISED"];

  // --- paths --------------------------------------------------------------------
  function splitPath(path) {
    const out = [];
    path.replace(/([^.[\]]+)|\[(\d+)\]/g, (_, key, idx) => { out.push(idx !== undefined ? +idx : key); });
    return out;
  }
  function getPath(data, path, dflt) {
    let node = data;
    for (const part of splitPath(path)) {
      if (node === null || node === undefined || !(part in Object(node))) return dflt;
      node = node[part];
    }
    return node === null || node === undefined ? dflt : node;
  }
  function setPath(data, path, value) {
    const parts = splitPath(path);
    let node = data;
    parts.slice(0, -1).forEach((part, i) => {
      if (node[part] === null || node[part] === undefined) {
        node[part] = typeof parts[i + 1] === "number" ? [] : {};
      }
      node = node[part];
    });
    node[parts[parts.length - 1]] = value;
  }
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const money2 = (n) => (Math.round(n * 100) / 100).toFixed(2);

  // --- taxonomy -----------------------------------------------------------------
  function creditLineFor(type, lines) {
    const kind = String(type || "").toUpperCase().replace(/[ -]/g, "_");
    const hit = lines.find((l) => l.commitment_types.includes(kind));
    return hit ? hit.key : "other_long_term_loans";
  }
  const isIncome = (c) => INCOME_CATS.includes(c);
  const isSpending = (c) => !isIncome(c) && !NOT_SPENDING.includes(c);

  // --- totals, as FactFind.recalculate --------------------------------------------
  function recalculate(ff, lines) {
    const data = ff.data, prov = ff.provenance;
    const people = new Set(data.applicants.map((a) => a.key));
    const credit = {};
    lines.filter((l) => l.commitment_types.length).forEach((l) => { credit[l.key] = 0; });
    data.commitments.forEach((c) => {
      if (c && !c.repay_on_completion && people.has(c.owner)) {
        credit[creditLineFor(c.type, lines)] += num(c.monthly_payment);
      }
    });
    Object.entries(credit).forEach(([key, v]) => {
      setPath(data, "expenditure." + key, money2(v));
      prov["expenditure." + key] = { origin: "C2C", status: "DERIVED" };
    });
    let gross = 0, net = 0;
    data.applicants.forEach((a, i) => {
      const total = INCOME_FIELDS.reduce((s, f) => s + num(getPath(data, `applicants[${i}].income.${f}`)), 0);
      setPath(data, `applicants[${i}].income.total`, money2(total));
      gross += total;
      net += num(getPath(data, `applicants[${i}].income.net_monthly`));
    });
    const group = (g) => lines.filter((l) => l.group === g)
      .reduce((s, l) => s + num(getPath(data, "expenditure." + l.key)), 0);
    const committed = group("Committed"), essential = group("Basic Essential"),
          quality = group("Basic Quality of Living");
    const outgoings = committed + essential + quality;
    data.summary = {
      total_committed: money2(committed), total_essential: money2(essential),
      total_quality: money2(quality), gross_annual_income: money2(gross),
      net_monthly_income: money2(net),
      monthly_commitments: money2(Object.values(credit).reduce((a, b) => a + b, 0)),
      monthly_expenditure: money2(outgoings),
      // Net pay is already after tax, so the Income Tax line is not taken off again.
      disposable_monthly: money2(net - (outgoings - num(getPath(data, "expenditure.income_tax")))),
    };
  }

  // --- decisions ------------------------------------------------------------------
  function now() { return new Date().toISOString(); }

  function accept(kase, findingId, who, lines) {
    const f = kase.findings.find((x) => x.id === findingId);
    if (!f || !f.acceptable || f.decision) return false;
    const ff = kase.factfind;
    f.effects.changes.forEach((c) => {
      const old = getPath(ff.data, c.path, null);
      setPath(ff.data, c.path, c.new);
      ff.provenance[c.path] = { origin: c.origin, status: c.status };
      ff.audit.push({ at: now(), by: who, path: c.path, old: old, new: c.new,
                      origin: c.origin, status: c.status, reason: f.message });
    });
    f.decision = { kind: "ACCEPT", by: who, at: now() };
    kase.findings.forEach((x) => {
      if (f.effects.resolves.includes(x.id) && !x.decision) x.decision = { kind: "RESOLVED", by: who, at: now() };
    });
    recalculate(ff, lines);
    return true;
  }

  function dismiss(kase, findingId, who, reason) {
    const f = kase.findings.find((x) => x.id === findingId);
    if (!f || f.decision || !reason) return false;
    f.decision = { kind: "DISMISS", by: who, at: now(), reason: reason };
    return true;
  }

  // --- bank transactions ------------------------------------------------------------
  function bankLines(kase) {
    // Planner lines per month over complete months, summed over people.
    const lines = {}, byCat = {};
    Object.entries(kase.months).forEach(([party, months]) => {
      if (!months.length) return;
      const set = new Set(months);
      const totals = {};
      kase.transactions.filter((t) => t.party === party && set.has(t.date.slice(0, 7))).forEach((t) => {
        const amt = num(t.amount);
        if (isSpending(t.category) && amt < 0) totals[t.category] = (totals[t.category] || 0) - amt;
        if (isIncome(t.category) && amt > 0) totals[t.category] = (totals[t.category] || 0) + amt;
      });
      Object.entries(totals).forEach(([cat, v]) => {
        const avg = Math.round(v / months.length * 100) / 100;
        byCat[cat] = (byCat[cat] || 0) + avg;
      });
    });
    Object.entries(byCat).forEach(([cat, v]) => { lines[cat.toLowerCase()] = v; });
    return { lines: lines, byCat: byCat };
  }

  // Full income and expenditure month by month, with the average, as the
  // service's openbanking.aggregate.breakdown. Recategorising changes it.
  function breakdown(kase, party, account) {
    const months = kase.months[party] || [];
    const at = {}; months.forEach((m, i) => { at[m] = i; });
    const zeros = () => months.map(() => 0);
    const income = {}, spending = {}, moneyIn = zeros(), moneyOut = zeros();
    kase.transactions.filter((t) => t.party === party && (!account || t.account === account)).forEach((t) => {
      const i = at[t.date.slice(0, 7)];
      if (i === undefined) return;
      const a = num(t.amount);
      if (a > 0 && t.category !== "TRANSFER" && t.category !== "REFUND") moneyIn[i] += a;
      if (a < 0 && t.category !== "TRANSFER") moneyOut[i] -= a;
      if (isIncome(t.category) && a > 0) (income[t.category] = income[t.category] || zeros())[i] += a;
      else if (isSpending(t.category) && a < 0) (spending[t.category] = spending[t.category] || zeros())[i] -= a;
    });
    const r2 = (v) => Math.round(v * 100) / 100;
    const avg = (vals) => months.length ? r2(vals.reduce((s, v) => s + v, 0) / months.length) : 0;
    const table = (rows) => Object.entries(rows)
      .map(([cat, vals]) => ({ category: cat, months: vals.map(r2), average: avg(vals) }))
      .sort((a, b) => b.average - a.average);
    const total = (rows) => { const sums = months.map((_, i) => rows.reduce((s, r) => s + r.months[i], 0));
                              return { months: sums.map(r2), average: avg(sums) }; };
    const inc = table(income), exp = table(spending);
    return { months: months, income: inc, incomeTotal: total(inc), expenditure: exp, expenditureTotal: total(exp),
             moneyIn: { months: moneyIn.map(r2), average: avg(moneyIn) },
             moneyOut: { months: moneyOut.map(r2), average: avg(moneyOut) } };
  }

  // The bank has priority: wherever it measures a line, its figure is taken
  // by default, higher or lower, as the service's validation does.
  const DEFAULT_BY = "C2C (source figure by default)";
  function recheckSpending(kase, lineDefs) {
    const bank = bankLines(kase);
    const ff = kase.factfind;
    lineDefs.filter((l) => !l.commitment_types.length).forEach((l) => {
      const path = "expenditure." + l.key;
      const p = ff.provenance[path] || {};
      const banked = money2(bank.lines[l.key] || 0);
      const id = "household:" + path + ":OPEN_BANKING";
      const existing = kase.findings.find((x) => x.id === id);
      if (p.origin === "OPEN_BANKING" && p.status === "PREFILLED") {
        setPath(ff.data, path, banked);
        return;
      }
      // Taken by default before: keep following the bank.
      if (existing && existing.decision && existing.decision.default) {
        if (num(banked)) {
          setPath(ff.data, path, banked);
          Object.assign(existing, { evidence: banked, proposed: banked,
            message: `${l.label} entered as £${fmt(num(existing.declared))} a month; the bank shows £${fmt(num(banked))} on average.` });
        }
        return;
      }
      if (!["DECLARED", "VERIFIED"].includes(p.status) || (existing && existing.decision)) return;
      const declared = num(getPath(ff.data, path));
      const b = num(banked);
      let finding = null;
      if (b && money2(declared) !== banked) {
        const message = `${l.label} entered as £${fmt(declared)} a month; the bank shows £${fmt(b)} on average.`;
        setPath(ff.data, path, banked);
        ff.provenance[path] = { origin: "OPEN_BANKING", status: "REPLACED" };
        ff.audit.push({ at: now(), by: DEFAULT_BY, path: path, old: money2(declared), new: banked,
                        origin: "OPEN_BANKING", status: "REPLACED", reason: message });
        finding = {
          id: id, party: null, path: path, outcome: "DIFFERENCE", source: "OPEN_BANKING", message: message,
          declared: money2(declared), evidence: banked, proposed: banked, acceptable: true, action: "REPLACE",
          decision: { kind: "ACCEPT", by: DEFAULT_BY, at: now(), default: true },
        };
      } else if (b) {
        finding = { id: id, party: null, path: path, outcome: "MATCH", source: "OPEN_BANKING",
                    message: `${l.label} is in line with the bank.`, declared: money2(declared),
                    evidence: banked, acceptable: false };
      }
      kase.findings = kase.findings.filter((x) => x.id !== id);
      if (finding) kase.findings.push(finding);
    });

    // Gambling, and what is still uncategorised.
    const gid = "household:expenditure.gambling:OPEN_BANKING:gambling";
    const gambling = bank.byCat.GAMBLING || 0;
    kase.findings = kase.findings.filter((x) => x.id !== gid || x.decision);
    if (gambling >= 50 && !kase.findings.some((x) => x.id === gid)) {
      kase.findings.push({ id: gid, party: null, path: "expenditure.gambling", outcome: "ALERT",
                           source: "OPEN_BANKING", evidence: money2(gambling), acceptable: false,
                           message: `Gambling transactions average £${fmt(gambling)} a month.` });
    }
    Object.keys(kase.months).forEach((party) => {
      const uid = `${party}:banking.${party}.uncategorised:OPEN_BANKING`;
      const left = kase.transactions.filter((t) => t.party === party && t.category === "UNCATEGORISED");
      kase.findings = kase.findings.filter((x) => x.id !== uid);
      if (left.length) {
        const name = (kase.parties.find((p) => p.key === party) || {}).name || party;
        const out = left.reduce((s, t) => s + Math.max(0, -num(t.amount)), 0);
        kase.findings.push({ id: uid, party: party, path: `banking.${party}.uncategorised`,
                             outcome: "UNVERIFIABLE", source: "OPEN_BANKING", acceptable: false,
                             message: `${left.length} transaction(s) for ${name} could not be categorised ` +
                                      `(£${fmt(out)} out in total). Categorise them below.` });
      }
    });
    recalculate(ff, lineDefs);
  }

  // Merchant memory is shared by every case, as in the service.
  function recategorise(cases, kase, txId, category, remember, who, demo) {
    const tx = kase.transactions.find((t) => t.id === txId);
    if (!tx) return false;
    tx.category = category; tx.basis = "OVERRIDE";
    if (remember && tx.merchant) {
      cases.forEach((c) => c.transactions.forEach((t) => {
        if (t !== tx && t.merchant === tx.merchant && t.basis !== "OVERRIDE") {
          t.category = category; t.basis = "MEMORY";
        }
      }));
    }
    kase.factfind.audit.push({ at: now(), by: who, path: "transaction " + tx.description, old: null,
                               new: category, origin: "BROKER", status: remember ? "REMEMBERED" : "OVERRIDE",
                               reason: remember ? "Categorised, and remembered for this merchant" : "Categorised" });
    cases.forEach((c) => recheckSpending(c, demo.lines));
    return true;
  }

  function fmt(n) {
    return num(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // --- filling a workbook (mapping/spec.py, in the browser) ---------------------------
  function formatValue(value, format, typed) {
    format = format || "text";
    if (value === null || value === undefined || value === "") return typed ? null : "";
    if (["money", "money_gbp", "whole", "monthly", "annual"].includes(format)) {
      let n = num(value);
      if (format === "monthly") n = n / 12;
      if (format === "annual") n = n * 12;
      n = format === "whole" ? Math.round(n) : Math.round(n * 100) / 100;
      if (typed) return n;
      return format === "money_gbp" ? "£" + fmt(n) : (format === "whole" ? String(n) : money2(n));
    }
    if (format.startsWith("date:")) {
      const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${m[3]}/${m[2]}/${m[1]}` : String(value);
    }
    if (format === "yesno") {
      const yes = value === true || ["true", "yes", "1", "y"].includes(String(value).toLowerCase());
      return yes ? "Yes" : "No";
    }
    return typeof value === "number" && typed ? value : String(value);
  }

  function render(mapping, data, lines) {
    const values = [], missing = [];
    (mapping.fields || []).forEach((s) => {
      let v;
      if (s.sum) {
        // Several lines into one cell, e.g. a firm's "Gas & electric".
        v = money2(s.sum.reduce((t, p) => t + num(getPath(data, p, 0)), 0));
      } else if ("value" in s) {
        v = s.value.replace(/\{([^{}]+)\}/g, (_, p) => getPath(data, p, "") || "").replace(/\s+/g, " ").trim();
      } else v = getPath(data, s.path, null);
      if (v === null || v === "") missing.push(s.target);
      values.push([s.target, v, s.format]);
    });
    (mapping.repeats || []).forEach((r) => {
      let items = (getPath(data, r.over, []) || []).filter(Boolean);
      if (r.line) items = items.filter((i) => creditLineFor(i.type, lines) === r.line);
      const limit = r.max || items.length, start = r.start_row || 1;
      items.slice(0, limit).forEach((item, i) => {
        r.fields.forEach((s) => {
          const target = s.target.replace("{n}", i + 1).replace("{row}", start + i);
          values.push([target, getPath(item, s.path, null), s.format]);
        });
      });
      if (items.length > limit) missing.push(`${r.line || r.over}: ${items.length - limit} more than the template holds`);
    });
    return { values: values, missing: missing };
  }

  async function fillWorkbook(ExcelJS, templateBuffer, rendered) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(templateBuffer);
    rendered.values.forEach(([target, value, format]) => {
      const i = target.lastIndexOf("!");
      const sheet = i >= 0 ? wb.getWorksheet(target.slice(0, i).replace(/^'|'$/g, "")) : wb.worksheets[0];
      if (!sheet) return;
      // Numbers stay numbers so the firm's own sums work; Yes/No as the words.
      sheet.getCell(target.slice(i + 1)).value = formatValue(value, format, format !== "yesno");
    });
    return wb;
  }

  function addC2CSheets(wb, kase) {
    const checks = wb.addWorksheet("C2C checks");
    checks.addRow(["Outcome", "Source", "Finding", "Entered", "Source shows", "Decision"]);
    kase.findings.forEach((f) => checks.addRow([f.outcome, f.source, f.message,
      f.declared ? num(f.declared) : null, f.evidence ? num(f.evidence) : null,
      f.decision ? f.decision.kind : ""]));
    checks.getRow(1).font = { bold: true };
    checks.getColumn(3).width = 90;
    const audit = wb.addWorksheet("C2C audit");
    audit.addRow(["When", "Who", "Field", "Was", "Now", "From", "Status", "Reason"]);
    kase.factfind.audit.forEach((e) => audit.addRow([e.at, e.by, e.path, e.old, e.new, e.origin, e.status, e.reason]));
    audit.getRow(1).font = { bold: true };
  }

  // --- cases from the exported variants ---------------------------------------------
  // A case is one precomputed engine run (the variant for the HMRC choices
  // made) plus what does not depend on those choices.
  function makeCase(def, variantKey, extra) {
    const v = def.variants[variantKey || def.default_variant];
    const c = JSON.parse(JSON.stringify({
      id: def.id, reference: def.reference, type: def.type, adviser: def.adviser,
      opened: def.opened, company: def.company, people: def.people,
      variant: variantKey || def.default_variant,
      parties: v.parties, factfind: v.factfind, findings: v.findings, pack: v.pack,
      transactions: def.transactions, months: def.months, accounts: def.accounts,
    }));
    c.status = "REVIEW";
    Object.assign(c, extra || {});
    c.baseline = JSON.parse(JSON.stringify(c.factfind.data));
    return c;
  }

  // Put the presenter's names in place of the sample's. The figures are the
  // sample's either way -- the same as the HMRC demo, which returns one fixed
  // test record whatever is entered.
  function rename(c, names) {
    const swaps = [];
    if (names.company && c.company) swaps.push([c.company, names.company]);
    c.people.forEach((p, i) => {
      const n = names.people[i];
      if (!n || !n.first || !n.last) return;
      const [first, ...rest] = p.name.split(" ");
      const last = rest.join(" ");
      const alias = first === "Tom" ? "Thomas" : null;    // the credit file's spelling
      swaps.push([p.name, `${n.first} ${n.last}`]);
      if (alias) swaps.push([`${alias} ${last}`, `${n.first} ${n.last}`], [alias, n.first]);
      swaps.push([first, n.first]);
    });
    const firstLast = names.people[0] && names.people[0].last;
    const oldLast = c.people[0].name.split(" ").slice(1).join(" ");
    if (firstLast && oldLast) swaps.push([oldLast, firstLast]);
    let text = JSON.stringify(c);
    swaps.forEach(([from, to]) => {
      text = text.replace(new RegExp("\\b" + from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"),
                          to.replace(/\$/g, "$$$$"));
    });
    const out = JSON.parse(text);
    names.people.forEach((n, i) => {
      const a = out.factfind.data.applicants[i];
      if (a && n && n.last) { a.last_name = n.last; a.full_name = `${n.first} ${n.last}`; }
    });
    return out;
  }

  // --- at a glance --------------------------------------------------------------------
  const BACKED = ["VERIFIED", "REPLACED", "ADDED"];
  function glance(c) {
    const ff = c.factfind, s = ff.data.summary;
    let backed = 0, total = 0;
    Object.entries(ff.provenance).forEach(([path, p]) => {
      if (p.status === "DERIVED" || !/^(applicants\[\d+\]\.income|expenditure|commitments)/.test(path)) return;
      if (/\.(owner|owner_name|type|account_number|repay_on_completion|start_date|term_months|lender|credit_limit|original_balance)$/.test(path)) return;
      if (!num(getPath(ff.data, path, 0))) return;
      total += 1;
      if (BACKED.includes(p.status) || (p.status === "PREFILLED" && p.origin !== "CUSTOMER")) backed += 1;
    });
    return {
      disposable: num(s.disposable_monthly), outgoings: num(s.monthly_expenditure),
      net: num(s.net_monthly_income), gross: num(s.gross_annual_income),
      backed: backed, total: total,
      differences: c.findings.filter((f) => !f.decision && f.outcome === "DIFFERENCE").length,
      alerts: c.findings.filter((f) => !f.decision && f.outcome === "ALERT").length,
    };
  }

  // Each figure that changed since the customer's entry: first value, now.
  // A commitment added from the credit file is one row, not one per field.
  function changes(c) {
    const seen = {};
    c.factfind.audit.forEach((e) => {
      const added = e.status === "ADDED" && /^commitments\[(\d+)\]\./.exec(e.path);
      const path = added ? `commitments[${added[1]}]` : e.path;
      if (!/^(applicants|expenditure|commitments|company)/.test(path)) return;
      if (!(path in seen)) seen[path] = { path: path, was: added ? null : e.old, added: !!added };
      seen[path].origin = e.origin; seen[path].by = e.by;
    });
    return Object.values(seen).map((x) => {
      if (x.added) {
        const row = getPath(c.factfind.data, x.path, {});
        const kind = String(row.type || "").replace(/_/g, " ").toLowerCase();
        return { ...x, label: `Commitment added: ${row.lender} ${kind}`.trim(), now: row.monthly_payment };
      }
      return { ...x, now: getPath(c.factfind.data, x.path, null) };
    }).filter((x) => x.added || String(x.was) !== String(x.now));
  }

  // --- the bank report (affordability/bankreport.py; the two must agree) -------------------
  const r2 = (v) => Math.round(v * 100) / 100;
  const DAY = 86400000;
  // As Python's %b: "Sep", where some browsers' en-GB says "Sept".
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Who paid it, from the statement line, as bankreport.payer.
  function payer(description) {
    const words = String(description || "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/)
      .filter((w) => w.length > 1 && !["BGC", "FPI", "BACS", "REF", "FP"].includes(w));
    return words.slice(0, 4).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ") || "Unknown payer";
  }
  // [primary, sub] for a category; ``paths`` is the demo data's category_paths.
  function categoryPath(category, description, paths) {
    const p = paths[category];
    if (!p) return ["Other spending", String(category).replace(/_/g, " ").toLowerCase().replace(/^./, (x) => x.toUpperCase())];
    return [p[0], p[1] === null ? payer(description) : p[1]];
  }
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

  function bankReport(txs, months, business, end, paths) {
    months = months.slice().sort();
    const n = months.length, at = {}, zeros = () => months.map(() => 0);
    months.forEach((m, i) => { at[m] = i; });
    const money = (vals) => { vals = vals.map(r2); const total = r2(vals.reduce((s, v) => s + v, 0));
                              return { months: vals, total: total, average: n ? r2(total / n) : 0 }; };
    const mIn = zeros(), mOut = zeros(), groups = { income: {}, expenditure: {} };
    txs.forEach((t) => {
      const i = at[t.date.slice(0, 7)];
      if (i === undefined) return;
      const a = num(t.amount);
      if (a > 0 && t.category !== "TRANSFER" && t.category !== "REFUND") mIn[i] += a;
      if (a < 0 && t.category !== "TRANSFER") mOut[i] -= a;
      const kind = isIncome(t.category) && a > 0 ? "income" : isSpending(t.category) && a < 0 ? "expenditure" : null;
      if (!kind) return;
      const [p, s] = categoryPath(t.category, t.description, paths);
      const g = groups[kind][p] = groups[kind][p] || {};
      (g[s] = g[s] || zeros())[i] += Math.abs(a);
    });
    const table = (kind) => {
      const rows = Object.entries(groups[kind]).map(([p, subs]) => {
        const sums = months.map((_, i) => Object.values(subs).reduce((s, v) => s + v[i], 0));
        return Object.assign({ primary: p }, money(sums), { subs: Object.entries(subs)
          .map(([s, v]) => Object.assign({ sub: s }, money(v))).sort((a, b) => b.total - a.total) });
      }).sort((a, b) => b.total - a.total);
      return [rows, money(months.map((_, i) => rows.reduce((s, r) => s + r.months[i], 0)))];
    };
    const [income, incomeTotal] = table("income"), [expenditure, expenditureTotal] = table("expenditure");
    let overview, ins, outs;
    if (business) {
      overview = [Object.assign({ label: "Money in" }, money(mIn)), Object.assign({ label: "Money out" }, money(mOut)),
                  Object.assign({ label: "Net", bold: true }, money(mIn.map((v, i) => v - mOut[i])))];
      ins = mIn.map(r2); outs = mOut.map(r2);
    } else {
      ins = incomeTotal.months; outs = expenditureTotal.months;
      overview = [Object.assign({ label: "Calculated income" }, incomeTotal),
                  Object.assign({ label: "Calculated expenditure" }, expenditureTotal),
                  Object.assign({ label: "Disposable income", bold: true }, money(ins.map((v, i) => v - outs[i])))];
    }
    const recentRows = recent(txs, end, paths);
    const labels = months.map((m) => MONTHS[+m.slice(5, 7) - 1] + " " + m.slice(0, 4));
    return { months: months, labels: labels, business: !!business, overview: overview,
             income: income, incomeTotal: incomeTotal, expenditure: expenditure, expenditureTotal: expenditureTotal,
             credits: recentRows[0], debits: recentRows[1], chart: chart(ins, outs, labels.map((l) => l.slice(0, 3))) };
  }

  // How many and how much in the last 30 and 90 days, by sub category.
  function recent(txs, end, paths) {
    if (!txs.length) return [[], []];
    const day = (iso) => Date.parse(iso + "T00:00:00Z") / DAY;
    const last = end ? day(end) : Math.max(...txs.map((t) => day(t.date)));
    const out = { credits: {}, debits: {} };
    txs.forEach((t) => {
      const a = num(t.amount);
      const kind = isIncome(t.category) && a > 0 ? "credits" : isSpending(t.category) && a < 0 ? "debits" : null;
      const d = day(t.date);
      if (!kind || d > last || d <= last - 90) return;
      const [p, s] = categoryPath(t.category, t.description, paths), key = p + "\u0000" + s;
      const row = out[kind][key] = out[kind][key] || { primary: p, sub: s, n30: 0, v30: 0, n90: 0, v90: 0 };
      row.n90++; row.v90 = r2(row.v90 + Math.abs(a));
      if (d > last - 30) { row.n30++; row.v30 = r2(row.v30 + Math.abs(a)); }
    });
    const rows = (k) => Object.values(out[k]).sort((a, b) => cmp(a.primary, b.primary) || cmp(a.sub, b.sub));
    return [rows("credits"), rows("debits")];
  }

  // Every transaction, oldest first, with its account's balance after it,
  // worked back from the account's balance today.
  function statement(txs, balances, paths) {
    const rows = txs.slice().sort((a, b) => cmp(a.date, b.date));
    const running = {};
    Object.entries(balances).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== "") running[k] = num(v); });
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const t = rows[i], balance = running[t.account];
      const [p, s] = categoryPath(t.category, t.description, paths);
      out.push(Object.assign({}, t, { primary: p, sub: s, balance: balance === undefined ? null : r2(balance) }));
      if (balance !== undefined) running[t.account] = r2(balance - num(t.amount));
    }
    return out.reverse();
  }

  // The graph's geometry, as bankreport.chart: bars for income and
  // expenditure, a line for what is left over.
  const CHART = { w: 640, h: 220, left: 64, right: 12, top: 14, bottom: 30 };
  function nice(value) {
    if (value <= 0) return 100;
    const step = Math.pow(10, String(Math.trunc(value)).length - 1);
    for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * k >= value) return step * k;
    return step * 10;
  }
  function chart(ins, outs, labels) {
    if (!ins.length) return null;
    const left = ins.map((v, i) => v - outs[i]);
    const low = Math.min(0, ...left);
    const top = nice(Math.max(0, ...ins, ...outs)), bottom = low < 0 ? -nice(-low) : 0;
    const plotH = CHART.h - CHART.top - CHART.bottom, plotW = CHART.w - CHART.left - CHART.right;
    const y = (v) => CHART.top + (top - v) / (top - bottom) * plotH;
    const r1 = (v) => Math.round(v * 10) / 10;
    const group = plotW / ins.length, bars = [], points = [], ticks = [], grid = [];
    ins.forEach((a, i) => {
      const x = CHART.left + group * i, w = group * 0.3, b = outs[i], d = left[i];
      bars.push({ x: r1(x + group * 0.17), y: r1(y(a)), w: r1(w), h: r1(y(0) - y(a)), kind: "in", value: a });
      bars.push({ x: r1(x + group * 0.53), y: r1(y(b)), w: r1(w), h: r1(y(0) - y(b)), kind: "out", value: b });
      points.push({ x: r1(x + group / 2), y: r1(y(d)), value: r2(d) });
      ticks.push({ x: r1(x + group / 2), label: labels[i] });
    });
    for (let k = 0; k < 5; k++) {
      const v = bottom + (top - bottom) * k / 4;
      grid.push({ y: r1(y(v)), label: (v < 0 ? "-£" : "£") + Math.trunc(Math.abs(v)).toLocaleString("en-GB") });
    }
    return { w: CHART.w, h: CHART.h, left: CHART.left, right: CHART.w - CHART.right, zero: r1(y(0)),
             bars: bars, points: points, ticks: ticks, grid: grid, base: CHART.h - CHART.bottom + 16 };
  }
  function chartSvg(g) {
    if (!g) return "";
    const money = (v) => (v < 0 ? "-£" + fmt(-v) : "£" + fmt(v));
    return `<svg viewBox="0 0 ${g.w} ${g.h}" class="chart" role="img" aria-label="Income and expenditure by month">`
      + g.grid.map((l) => `<line x1="${g.left}" x2="${g.right}" y1="${l.y}" y2="${l.y}" class="grid"/><text x="${g.left - 6}" y="${l.y + 3}" text-anchor="end">${l.label}</text>`).join("")
      + `<line x1="${g.left}" x2="${g.right}" y1="${g.zero}" y2="${g.zero}" class="axis"/>`
      + g.bars.map((b) => `<rect x="${b.x}" y="${Math.min(b.y, g.zero)}" width="${b.w}" height="${Math.abs(b.h)}" class="bar-${b.kind}"><title>${money(b.value)}</title></rect>`).join("")
      + `<path d="${g.points.map((p, i) => (i ? "L" : "M") + p.x + "," + p.y).join(" ")}" class="left"/>`
      + g.points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3" class="left-dot"><title>Left over ${money(p.value)}</title></circle>`).join("")
      + g.ticks.map((t) => `<text x="${t.x}" y="${g.base}" text-anchor="middle">${t.label}</text>`).join("") + "</svg>";
  }

  // --- the C2C Data Pack, as it stands now ------------------------------------------------
  function dataPack(c, lines) {
    const pack = JSON.parse(JSON.stringify(c.pack));
    pack.generated = new Date().toISOString();
    pack.reference = c.reference;
    pack.parties.forEach((p) => {
      if (!p.banking) return;
      const mine = c.transactions.filter((t) => t.party === p.key);
      const only = { ...c, transactions: mine, months: { [p.key]: c.months[p.key] || [] } };
      const bank = bankLines(only);
      p.banking.planner = {};
      lines.filter((l) => !l.commitment_types.length).forEach((l) => {
        if (bank.lines[l.key]) p.banking.planner[l.key] = money2(bank.lines[l.key]);
      });
      p.banking.monthly_by_category = Object.fromEntries(
        Object.entries(bank.byCat).map(([k, v]) => [k, money2(v)]));
      p.banking.accounts = (c.accounts[p.key] || {}).accounts;
      p.banking.transactions = mine.map(({ party, ...t }) => t);
    });
    return pack;
  }

  const api = { getPath, setPath, recalculate, accept, dismiss, recategorise, recheckSpending,
                bankLines, breakdown, render, fillWorkbook, addC2CSheets, formatValue, creditLineFor, fmt, num,
                makeCase, rename, glance, changes, dataPack, bankReport, statement, chart, chartSvg, payer,
                categoryPath, MONTHS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
