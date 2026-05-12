import type { DrugResult } from "./types";

const REPO =
  import.meta.env.VITE_GITHUB_REPO ?? "seandavi/fda-approval-app";

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
  if (result.sponsor) facts.push(`- **Sponsor**: ${result.sponsor}`);

  const sourceRows = result.sources.map(
    (s) =>
      `| \`${s.api}\` | ${s.hit ? "✓" : "·"} | ${(s.detail ?? "").replace(/\|/g, "\\|")} |`
  );

  const body = [
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
    "",
    "<details><summary>Source detail (every API the pipeline tried)</summary>",
    "",
    "| API | Hit | Detail |",
    "| --- | --- | --- |",
    ...sourceRows,
    "",
    "</details>",
    "",
    "---",
    envSummary(),
  ].join("\n");

  return buildIssueUrl({
    title: `Result issue: ${result.inputName}`,
    body,
    labels: ["user-report", "wrong-result"],
  });
}
