/* The demo's logic, kept apart from the page so it can be tested in Node.
 *
 * Every figure starts from demo-data.js, which the real engine produced
 * (affordability/scripts/export_static_demo.py). What happens here:
 *
 *  - accepting a finding applies the changes the real engine worked out for it
 *  - recategorising a transaction re-averages the bank figures and re-runs the
 *    spending check -- the one rule this page repeats, with the same tolerance
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

  function within(a, b, tol) {
    return Math.abs(a - b) <= Math.max(tol.abs, tol.rel * Math.max(Math.abs(a), Math.abs(b)));
  }

  function recheckSpending(kase, lineDefs, tolerances) {
    const tol = { abs: num(tolerances.spending_abs), rel: num(tolerances.spending_rel) };
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
      if (!["DECLARED", "VERIFIED"].includes(p.status) || (existing && existing.decision)) return;
      const declared = num(getPath(ff.data, path));
      const b = num(banked);
      let finding = null;
      if (b > declared && !within(declared, b, tol)) {
        finding = {
          id: id, party: null, path: path, outcome: "DIFFERENCE", source: "OPEN_BANKING",
          message: `${l.label} entered as £${fmt(declared)} a month; the bank shows £${fmt(b)} on average.`,
          declared: money2(declared), evidence: banked, proposed: banked, acceptable: true,
          action: "REPLACE",
          effects: { changes: [{ path: path, old: money2(declared), new: banked,
                                 origin: "OPEN_BANKING", status: "REPLACED" }], resolves: [] },
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
    cases.forEach((c) => recheckSpending(c, demo.lines, demo.tolerances));
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
      if ("value" in s) {
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

  const api = { getPath, setPath, recalculate, accept, dismiss, recategorise, recheckSpending,
                bankLines, render, fillWorkbook, addC2CSheets, formatValue, creditLineFor, fmt, num };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
