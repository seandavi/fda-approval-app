import type { DrugResult } from "./types";

const REPO =
  import.meta.env.VITE_GITHUB_REPO ?? "seandavi/fda-approval-app";

export const repoUrl = `https://github.com/${REPO}`;

interface IssueArgs {
  title: string;
  body: string;
  labels?: string[];
}

function buildIssueUrl({ title, body, labels }: IssueArgs): string {
  const u = new URL(`https://github.com/${REPO}/issues/new`);
  u.searchParams.set("title", title);
  u.searchParams.set("body", body);
  if (labels?.length) u.searchParams.set("labels", labels.join(","));
  return u.toString();
}

function envSummary(): string {
  if (typeof window === "undefined") return "";
  return [
    `- App URL: ${window.location.href}`,
    `- Browser: ${navigator.userAgent}`,
  ].join("\n");
}

export function genericFeedbackUrl(): string {
  const body = [
    "## What were you trying to do?",
    "",
    "<!-- e.g. look up a list of drugs from our pipeline -->",
    "",
    "## What happened?",
    "",
    "",
    "## What did you expect to happen?",
    "",
    "",
    "---",
    "<sub>Submitted via the in-app feedback link.</sub>",
    "",
    envSummary(),
  ].join("\n");
  return buildIssueUrl({
    title: "",
    body,
    labels: ["user-report"],
  });
}

// Cap on inlined raw label text. Real labels for big oncology drugs can
// run 15-20 KB, which would balloon the GitHub issue body — and the
// URL — past usable size. We include a head excerpt so reports retain
// some context, and the maintainer can refetch the full label.
const REPORT_LABEL_EXCERPT_CHARS = 1200;

export function reportResultUrl(result: DrugResult): string {
  const facts: string[] = [
    `- **Input**: \`${result.inputName}\``,
    `- **Normalized**: \`${result.normalizedName}\``,
    `- **Status**: ${result.status}`,
  ];
  if (result.resolvedINN) facts.push(`- **Resolved INN**: ${result.resolvedINN}`);
  if (result.resolvedVia) facts.push(`- **Resolved via**: ${result.resolvedVia}`);
  if (result.applicationNumber)
    facts.push(
      `- **Application**: ${result.applicationType ?? ""} ${result.applicationNumber}`.trim()
    );
  if (result.brandName) facts.push(`- **Brand**: ${result.brandName}`);
  if (result.genericName) facts.push(`- **Generic**: ${result.genericName}`);
  if (result.approvalDate) facts.push(`- **Approval date**: ${result.approvalDate}`);
  if (result.sponsor) facts.push(`- **Sponsor**: ${result.sponsor}`);
  if (result.marketingCategory)
    facts.push(`- **Marketing category**: ${result.marketingCategory}`);

  // Layer 7 arbiter context — when the LLM was the decision-maker (or
  // disagreed with the pipeline), the bug evidence lives here.
  const llmFacts: string[] = [];
  if (result.llmAgreement)
    llmFacts.push(`- **LLM agreement**: ${result.llmAgreement}`);
  if (result.llmConfidence)
    llmFacts.push(`- **LLM confidence**: ${result.llmConfidence}`);
  if (result.llmRationale)
    llmFacts.push(`- **LLM rationale**: ${result.llmRationale}`);
  if (result.pipelineApplicationNumber)
    llmFacts.push(
      `- **Pipeline (overridden)**: ${result.pipelineApplicationNumber}` +
        (result.pipelineApprovalDate
          ? ` / ${result.pipelineApprovalDate}`
          : "") +
        (result.pipelineResolvedVia
          ? ` (via ${result.pipelineResolvedVia})`
          : "")
    );

  const indicationFacts: string[] = [];
  if (result.originalIndication)
    indicationFacts.push(
      `- **Original indication** _(LLM)_: ${result.originalIndication}`
    );
  if (result.currentIndications && result.currentIndications.length > 0) {
    indicationFacts.push(
      "- **Current indications** _(verbatim from current FDA label)_:"
    );
    for (const ind of result.currentIndications) {
      indicationFacts.push(`  - ${ind}`);
    }
  }

  const sourceRows = result.sources.map(
    (s) =>
      `| \`${s.api}\` | ${s.hit ? "✓" : "·"} | ${(s.detail ?? "").replace(/\|/g, "\\|")} |`
  );

  const labelExcerpt =
    result.labelIndicationText && result.labelIndicationText.trim()
      ? result.labelIndicationText.length > REPORT_LABEL_EXCERPT_CHARS
        ? result.labelIndicationText.slice(0, REPORT_LABEL_EXCERPT_CHARS) +
          `\n…[truncated — ${result.labelIndicationText.length - REPORT_LABEL_EXCERPT_CHARS} more chars]`
        : result.labelIndicationText
      : null;

  const sections: string[] = [
    "## What's wrong with this result?",
    "",
    "<!-- e.g. the resolved INN is wrong; the approval date is stale; we should have found this drug -->",
    "",
    "## What should it be?",
    "",
    "",
    "## Result snapshot",
    "",
    ...facts,
  ];

  if (llmFacts.length > 0) {
    sections.push("", "### LLM arbiter (Layer 7)", "", ...llmFacts);
  }
  if (indicationFacts.length > 0) {
    sections.push("", "### Indications", "", ...indicationFacts);
  }

  sections.push(
    "",
    "<details><summary>Source detail (every API the pipeline tried)</summary>",
    "",
    "| API | Hit | Detail |",
    "| --- | --- | --- |",
    ...sourceRows,
    "",
    "</details>"
  );

  if (labelExcerpt) {
    sections.push(
      "",
      "<details><summary>Raw FDA-label indications text (excerpt)</summary>",
      "",
      "```",
      labelExcerpt,
      "```",
      "",
      "</details>"
    );
  }

  sections.push("", "---", envSummary());

  return buildIssueUrl({
    title: `Result issue: ${result.inputName}`,
    body: sections.join("\n"),
    labels: ["user-report", "wrong-result"],
  });
}
