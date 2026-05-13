const RAW_SHA = import.meta.env.VITE_GIT_SHA ?? "dev";
const REPO_URL = "https://github.com/seandavi/fda-approval-app";

export const FULL_SHA: string = RAW_SHA;
export const SHORT_SHA: string =
  RAW_SHA === "dev" ? "dev" : RAW_SHA.slice(0, 7);

export const COMMIT_URL: string | undefined =
  RAW_SHA === "dev" ? undefined : `${REPO_URL}/commit/${RAW_SHA}`;
