"""Document builders shared by every Wave 1 industry. Each builder returns a list of pages (rows, see render.py).

House style for the sample paperwork: a letterhead, one title line, labelled "Label: value" lines for every fact a
customer would look up, and line items where a real document has them. Dates are MM/DD/YYYY, money is $1,234.56.
"""
from datetime import date, timedelta


def money(x):
    neg = x < 0
    s = f"${abs(x):,.2f}"
    return f"-{s}" if neg else s


def d(s):
    """'2026-03-14' -> '03/14/2026'"""
    y, m, dd = s.split("-")
    return f"{m}/{dd}/{y}"


def long_date(s):
    y, m, dd = map(int, s.split("-"))
    return date(y, m, dd).strftime("%B %-d, %Y")


def add_days(s, n):
    y, m, dd = map(int, s.split("-"))
    return (date(y, m, dd) + timedelta(days=n)).isoformat()


def letterhead(co, with_lic=True):
    rows = [("brand", co["name"]), ("head", co["address"]), ("head", co["phone"])]
    if with_lic and co.get("license"):
        rows.append(("head", co["license"]))
    return rows


def items_table(items, cols=("Description", "Qty", "Rate", "Amount")):
    rows = []
    for it in items:
        desc, qty, rate = it
        rows.append([desc, f"{qty:g}", money(rate), money(qty * rate)])
    return ("table", list(cols), rows)


def totals(items, tax_rate=0.0, taxable_share=1.0):
    sub = round(sum(q * r for _, q, r in items), 2)
    tax = round(sub * taxable_share * tax_rate, 2)
    return sub, tax, round(sub + tax, 2)


def invoice(co, no, dt, bill_to, address, items, tech=None, tax_rate=0.0, taxable_share=1.0, paid=None, terms="Net 30",
            title="INVOICE", extra=None, notes=None, po=None, label_tech="Technician", style="table", work=None, due_days=30):
    """paid=None -> paid in full (prints "Status: Paid in full"); paid=0 -> unpaid (Balance Due = Total);
    0 < paid < total -> a deposit was taken (Deposit Received + Balance Due).
    style="table": line-item table; style="work": one "Work Performed" line (the form most field-service software prints)."""
    sub, tax, total = totals(items, tax_rate, taxable_share)
    paid = total if paid is None else paid
    bal = round(total - paid, 2)
    rows = letterhead(co) + [("title", title), ("kv", "Invoice #", no), ("kv", "Invoice Date", d(dt)),
                              ("kv", "Bill To", bill_to), ("kv", "Service Address", address)]
    if tech:
        rows.append(("kv", label_tech, tech))
    for k, v in (extra or []):
        rows.append(("kv", k, v))
    if style == "work":
        rows.append(("kv", "Work Performed", work or "; ".join(i[0] for i in items)))
    else:
        rows.append(items_table(items))
    if tax:
        rows += [("kv", "Subtotal", money(sub)), ("kv", "Sales Tax", money(tax))]
    rows.append(("kv", "Total", money(total)))
    if bal <= 0:
        rows.append(("kv", "Status", "Paid in full"))
    else:
        if paid > 0:
            rows.append(("kv", "Deposit Received", money(paid)))
        rows += [("kv", "Balance Due", money(bal)), ("kv", "Due Date", d(add_days(dt, due_days)))]
    if notes:
        rows.append(("kv", "Notes", notes))
    return [rows], {"total": total, "paid": paid, "balance": bal, "subtotal": sub, "tax": tax}


def receipt_from_vendor(vendor, no, dt, sold_to, items, tax_rate=0.0, paid_by="VISA ending 4021"):
    sub, tax, total = totals(items, tax_rate)
    rows = letterhead(vendor, with_lic=False) + [("title", "RECEIPT"), ("kv", "Receipt #", no), ("kv", "Date", d(dt)),
                                                ("kv", "Sold To", sold_to)]
    rows.append(items_table(items))
    rows += [("kv", "Subtotal", money(sub)), ("kv", "Sales Tax", money(tax)), ("kv", "Total", money(total)),
             ("kv", "Payment", paid_by)]
    return [rows], {"total": total}


def vendor_invoice(vendor, no, dt, bill_to, items, tax_rate=0.0, paid=0.0, terms="Net 30", ship_to=None, service_address=None):
    sub, tax, total = totals(items, tax_rate)
    rows = letterhead(vendor, with_lic=False) + [("title", "INVOICE"), ("kv", "Invoice #", no), ("kv", "Invoice Date", d(dt)),
                                                ("kv", "Bill To", bill_to), ("kv", "Remit To", vendor["name"])]
    if ship_to:
        rows.append(("kv", "Ship To", ship_to))
    if service_address:
        rows.append(("kv", "Service Address", service_address))
    rows.append(items_table(items))
    rows += [("kv", "Subtotal", money(sub))]
    if tax:
        rows.append(("kv", "Sales Tax", money(tax)))
    rows += [("kv", "Total", money(total)), ("kv", "Amount Paid", money(paid)), ("kv", "Balance Due", money(round(total - paid, 2))),
             ("kv", "Terms", terms)]
    return [rows], {"total": total, "balance": round(total - paid, 2)}


def purchase_order(co, no, dt, vendor_name, items, ship_to, needed_by=None, buyer=None):
    sub, _, total = totals(items)
    rows = letterhead(co) + [("title", "PURCHASE ORDER"), ("kv", "PO #", no), ("kv", "PO Date", d(dt)), ("kv", "Vendor", vendor_name),
                             ("kv", "Ship To", ship_to)]
    if needed_by:
        rows.append(("kv", "Needed By", d(needed_by)))
    if buyer:
        rows.append(("kv", "Ordered By", buyer))
    rows.append(items_table(items))
    rows += [("kv", "Order Total", money(total))]
    return [rows], {"total": total}


def proposal(co, no, dt, customer, address, items, valid_days=30, prepared_by=None, scope=None, status=None, title="PROPOSAL",
             tax_rate=0.0, style="table"):
    sub, tax, total = totals(items, tax_rate)
    if style == "work":
        rows = letterhead(co) + [("title", title), ("kv", "Customer", customer), ("kv", "Job Address", address), ("kv", "Date", d(dt)),
                                 ("kv", "Proposed Work", scope or "; ".join(i[0] for i in items)), ("kv", "Quote Total", money(total))]
        if status:
            rows.append(("kv", "Notes", f"Proposal {no}. {status}."))
        else:
            rows.append(("kv", "Notes", f"Proposal {no}. Valid for {valid_days} days."))
        return [rows], {"total": total}
    rows = letterhead(co) + [("title", title), ("kv", "Proposal #", no), ("kv", "Proposal Date", d(dt)), ("kv", "Customer", customer),
                             ("kv", "Job Address", address)]
    if prepared_by:
        rows.append(("kv", "Prepared By", prepared_by))
    rows.append(("kv", "Valid Until", d(add_days(dt, valid_days))))
    if scope:
        rows += [("gap",), ("text", scope)]
    rows.append(items_table(items))
    if tax:
        rows += [("kv", "Subtotal", money(sub)), ("kv", "Sales Tax", money(tax))]
    rows += [("kv", "Total", money(total))]
    if status:
        rows.append(("kv", "Status", status))
    rows += [("gap",), ("sig", "Customer acceptance / date")]
    return [rows], {"total": total}


def work_order(co, no, dt, customer, address, tech, problem, work_done, title="WORK ORDER", status="Completed", extra=None,
               label_tech="Technician", phone=None):
    rows = letterhead(co) + [("title", title), ("kv", "Work Order #", no), ("kv", "Date", d(dt)), ("kv", "Customer", customer),
                             ("kv", "Service Address", address)]
    if phone:
        rows.append(("kv", "Phone", phone))
    rows.append(("kv", label_tech, tech))
    for k, v in (extra or []):
        rows.append(("kv", k, v))
    rows += [("kv", "Problem Reported", problem), ("kv", "Work Performed", work_done), ("kv", "Status", status),
             ("gap",), ("sig", "Customer signature")]
    return [rows]


def agreement_onepage(co, title, no, customer, address, start, end, price, kvs=None, terms_text=None, label_price="Annual Price"):
    rows = letterhead(co) + [("title", title), ("kv", "Agreement #", no), ("kv", "Customer", customer), ("kv", "Service Address", address),
                             ("kv", "Effective Date", d(start)), ("kv", "Expiration Date", d(end))]
    for k, v in (kvs or []):
        rows.append(("kv", k, v))
    rows.append(("kv", label_price, money(price)))
    if terms_text:
        rows += [("gap",), ("text", terms_text)]
    rows += [("gap",), ("sig", "Customer signature / date"), ("sig", f"{co['name']} / date")]
    return [rows]


def warranty_registration(co, customer, address, brand, model, serial, install, parts_end, labor_end, equipment, reg_no):
    rows = letterhead(co) + [("title", "WARRANTY REGISTRATION"), ("kv", "Registration #", reg_no), ("kv", "Customer", customer),
                             ("kv", "Service Address", address), ("kv", "Equipment", equipment), ("kv", "Brand", brand),
                             ("kv", "Model", model), ("kv", "Serial", serial), ("kv", "Install Date", d(install)),
                             ("kv", "Parts Warranty Expires", d(parts_end)), ("kv", "Labor Warranty Expires", d(labor_end))]
    return [rows]


def permit(jurisdiction, kind, no, issued, expires, contractor, owner, address, work, status="Issued", fee=None, inspections=None):
    rows = [("brand", jurisdiction["name"]), ("head", jurisdiction["address"]), ("head", jurisdiction["phone"]),
            ("title", f"{kind.upper()} PERMIT"), ("kv", "Permit #", no), ("kv", "Issue Date", d(issued)),
            ("kv", "Expiration Date", d(expires)), ("kv", "Contractor", contractor), ("kv", "Property Owner", owner),
            ("kv", "Job Address", address), ("kv", "Work Description", work), ("kv", "Permit Status", status)]
    if fee is not None:
        rows.append(("kv", "Permit Fee", money(fee)))
    if inspections:
        rows += [("gap",), ("table", ["Inspection", "Date", "Result"], inspections)]
    return [rows]


def inspection_report(co, no, dt, customer, address, inspector, findings, recommendation, result=None, title="INSPECTION REPORT",
                      extra=None, label_inspector="Inspector"):
    rows = letterhead(co) + [("title", title), ("kv", "Report #", no), ("kv", "Inspection Date", d(dt)), ("kv", "Customer", customer),
                             ("kv", "Property Address", address), ("kv", label_inspector, inspector)]
    for k, v in (extra or []):
        rows.append(("kv", k, v))
    if result:
        rows.append(("kv", "Result", result))
    rows += [("kv", "Findings", findings), ("kv", "Recommendation", recommendation)]
    return [rows]


def contract_pages(co, title, no, parties_rows, key_rows_p1, sections, key_rows_p2=None, sign_labels=("Owner", "Contractor")):
    """A multi-page agreement: page 1 parties + headline terms + early sections, later pages more sections + signatures."""
    p1 = letterhead(co) + [("title", title), ("kv", "Contract #", no)] + parties_rows + key_rows_p1 + [("gap",)]
    pages = [p1]
    cur = pages[0]
    budget = 30 - len(p1)
    for heading, body in sections:
        need = 2 + len(body) // 85
        if need > budget:
            cur = []
            pages.append(cur)
            budget = 44
        cur.append(("text", heading.upper()))
        cur.append(("text", body))
        cur.append(("gap",))
        budget -= need + 1
    last = pages[-1]
    if key_rows_p2:
        last += key_rows_p2
    for s in sign_labels:
        last.append(("sig", f"{s} signature / date"))
    return pages


def letter(co, dt, to_lines, subject, paras, signer, title="LETTER"):
    rows = letterhead(co) + [("text", long_date(dt)), ("gap",)] + [("text", t) for t in to_lines] + [("gap",), ("text", f"Re: {subject}"), ("gap",)]
    for p in paras:
        rows += [("text", p), ("gap",)]
    rows += [("text", "Sincerely,"), ("gap",), ("text", signer)]
    return [rows]


def coi(insurer, no, insured, holder, eff, exp, gl_limit, wc=True, producer=None):
    rows = [("brand", producer or "Certificate of Liability Insurance"), ("title", "CERTIFICATE OF INSURANCE"), ("kv", "Certificate #", no),
            ("kv", "Insured", insured), ("kv", "Carrier", insurer), ("kv", "Certificate Holder", holder),
            ("kv", "Policy Effective", d(eff)), ("kv", "Policy Expiration", d(exp)),
            ("kv", "General Liability Each Occurrence", money(gl_limit)), ("kv", "General Aggregate", money(gl_limit * 2))]
    if wc:
        rows.append(("kv", "Workers Compensation", "Statutory limits"))
    rows += [("gap",), ("text", "This certificate is issued as a matter of information only and confers no rights upon the certificate holder.")]
    return [rows]


# ---- field-service forms in the layout most shop software prints (one fact per labelled line)
def service_ticket(co, no, dt, customer, address, tech, service_type, work, findings=None, notes=None, title="SERVICE TICKET",
                   phone=None, label_tech="Technician", label_no="Ticket #"):
    rows = letterhead(co) + [("title", title), ("kv", "Customer", customer), ("kv", "Service Address", address)]
    if phone:
        rows.append(("kv", "Phone", phone))
    rows += [("kv", label_no, no), ("kv", "Service Date", d(dt)), ("kv", label_tech, tech), ("kv", "Service Type", service_type)]
    if findings:
        rows.append(("kv", "Findings", findings))
    rows.append(("kv", "Work Performed", work))
    if notes:
        rows.append(("kv", "Notes", notes))
    rows += [("gap",), ("sig", "Customer signature")]
    return [rows]


def maint_agreement(co, no, customer, address, start, end, fee, notes=None, title="MAINTENANCE AGREEMENT", label_fee="Annual Fee"):
    rows = letterhead(co) + [("title", title), ("kv", "Customer", customer), ("kv", "Service Address", address),
                             ("kv", "Agreement Term", f"{d(start)} - {d(end)}"), ("kv", "Expires", d(end)), ("kv", label_fee, money(fee)),
                             ("kv", "Notes", f"Agreement {no}. " + (notes or ""))]
    rows += [("gap",), ("sig", "Customer signature / date"), ("sig", f"{co['name']} / date")]
    return [rows]


def warranty_reg(co, customer, address, brand, model, serial, install, expires, notes=None, equipment=None):
    rows = letterhead(co) + [("title", "WARRANTY REGISTRATION"), ("kv", "Customer", customer), ("kv", "Service Address", address)]
    if equipment:
        rows.append(("kv", "Equipment Type", equipment))
    rows += [("kv", "Brand", brand), ("kv", "Model", model), ("kv", "Serial", serial), ("kv", "Install Date", d(install)),
             ("kv", "Warranty Expires", d(expires))]
    if notes:
        rows.append(("kv", "Notes", notes))
    return [rows]


def inspection(co, dt, customer, address, tech, findings, notes=None, title="INSPECTION REPORT", label_tech="Technician"):
    rows = letterhead(co) + [("title", title), ("kv", "Customer", customer), ("kv", "Service Address", address),
                             ("kv", "Inspection Date", d(dt)), ("kv", label_tech, tech), ("kv", "Findings", findings)]
    if notes:
        rows.append(("kv", "Notes", notes))
    return [rows]


def permit_simple(jur, kind, no, dt, owner, address, contractor, work, status="Issued", notes=None):
    rows = [("brand", jur["name"]), ("head", jur["address"]), ("head", jur["phone"]), ("title", f"{kind.upper()} PERMIT"),
            ("kv", "Permit #", no), ("kv", "Date", d(dt)), ("kv", "Property Owner", owner), ("kv", "Job Address", address),
            ("kv", "Contractor", contractor), ("kv", "Work Description", work), ("kv", "Status", status)]
    if notes:
        rows.append(("kv", "Notes", notes))
    return [rows]


def receipt_simple(co, no, dt, received_from, address, amount, method, title="RECEIPT", for_what=None, label_addr="Property Address"):
    rows = letterhead(co) + [("title", title), ("kv", "Receipt #", no), ("kv", "Date Received", d(dt)), ("kv", "Received From", received_from)]
    if address:
        rows.append(("kv", label_addr, address))
    if for_what:
        rows.append(("kv", "For", for_what))
    rows += [("kv", "Amount Received", money(amount)), ("kv", "Payment Method", method)]
    return [rows], {"total": amount}


def statement(co, title, no, dt, to_name, kvs, rows_table=None, total=None, label_total="Total"):
    rows = letterhead(co) + [("title", title), ("kv", "Statement #", no), ("kv", "Statement Date", d(dt)), ("kv", "Customer", to_name)]
    for k, v in kvs:
        rows.append(("kv", k, v))
    if rows_table:
        rows.append(("table", rows_table[0], rows_table[1]))
    if total is not None:
        rows.append(("kv", label_total, money(total)))
    return [rows], {"total": total}
