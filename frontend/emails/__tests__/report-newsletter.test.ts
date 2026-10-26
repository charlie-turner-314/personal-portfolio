import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";
import ReportNewsletter from "../report-newsletter";

const props = {
  reportName: "Personal Portfolio | Weekly Digest",
  generatedAt: "2026-07-20T08:00:00Z",
  periodLabel: "Last 7 days",
  totalBalance: "3394.04",
  totalCurrency: "EUR",
  accounts: [{
    name: "ABN AMRO Giannis", institution: "ABN AMRO",
    logoUrl: "http://localhost:8080/uploads/logos/abnamro.com.png",
    balance: "591.51", currency: "EUR",
  }],
  transactionsModeLabel: "Top 8 expenses",
  transactions: [{ description: "British Airways Plc", date: "2026-07-16", amount: "829.94", currency: "EUR", direction: "out" as const }],
  manageUrl: "http://localhost:8080/reports/1",
};

describe("ReportNewsletter", () => {
  it("renders the period label in the masthead", async () => {
    const html = await render(ReportNewsletter(props));
    expect(html).toContain("Last 7 days");
  });

  it("puts the page backdrop on a table wrapper, not only <body>", async () => {
    // Apple Mail overrides the <body> background but honours table cells,
    // which previously produced a dark card on a light page.
    const html = await render(ReportNewsletter(props));
    expect(html).toContain("sy-page");
  });

  it("ships a prefers-color-scheme dark block", async () => {
    const html = await render(ReportNewsletter(props));
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("#121110"); // dark backdrop = --background
  });

  it("uses no rounded corners and no green", async () => {
    const html = await render(ReportNewsletter(props));
    expect(html).not.toContain("border-radius");
    expect(html).not.toContain("#10B981");
  });

  it("omits the total block when the total is unavailable", async () => {
    const html = await render(ReportNewsletter({ ...props, totalBalance: null }));
    expect(html).not.toMatch(/total balance/i);
  });

  it("renders the report name through the full component tree", async () => {
    const html = await render(ReportNewsletter(props));
    expect(html).toContain("Personal Portfolio | Weekly Digest");
  });
  it("labels the economic scope, preserves bank units and renders unknown values as unavailable",async()=>{
    const html=await render(ReportNewsletter({...props,scopeLabel:"My view · economic share",coverageNote:"Only Joint is included; private accounts are excluded.",totalBalance:null,accounts:[{...props.accounts[0],balance:null}],transactions:[{...props.transactions[0],amount:null,original_amount:"-1000.00",original_currency:"AUD",amount_label:"Consumption allocation"}]}));
    expect(html).toContain("My view");expect(html).toContain("private accounts are excluded");
    expect(html).toContain("Unavailable");expect(html).not.toContain("NaN");
    expect(html).toContain("Bank -1,000.00 AUD");expect(html).toContain("Consumption allocation");
  });

});
