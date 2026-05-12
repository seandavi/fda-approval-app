export type ApprovalStatus =
  | "approved"
  | "discontinued"
  | "not_found"
  | "pending"
  | "error";

export type ResolvedVia =
  | "openfda_brand"
  | "openfda_generic"
  | "openfda_label"
  | "rxnorm"
  | "nci"
  | "clinicaltrials";

export interface SourceHit {
  api: string;
  url: string;
  hit: boolean;
  detail?: string;
}

export interface DrugResult {
  inputName: string;
  normalizedName: string;
  resolvedINN?: string;
  resolvedVia?: ResolvedVia;
  status: ApprovalStatus;
  applicationNumber?: string;
  applicationType?: "NDA" | "BLA" | "ANDA";
  brandName?: string;
  genericName?: string;
  approvalDate?: string;
  sponsor?: string;
  sources: SourceHit[];
  cached: boolean;
  lookedUpAt: string;
}

export interface AppSettings {
  openfdaApiKey: string;
  gaMeasurementId: string;
  cacheTtlDays: number;
  showSourcesByDefault: boolean;
}
