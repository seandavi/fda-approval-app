export type ApprovalStatus =
  | "approved"            // active NDA/BLA/ANDA application
  | "otc_monograph"       // legally marketed under OTC monograph (no application)
  | "unapproved_marketed" // marketed under UNAPPROVED * categories (homeopathic, etc.)
  | "discontinued"        // approved but all products discontinued
  | "not_found"           // no FDA record found after all layers
  | "pending"             // lookup in progress
  | "error";              // network/parse error

export type ResolvedVia =
  | "openfda_brand"
  | "openfda_generic"
  | "openfda_label"
  | "openfda_ndc"
  | "rxnorm"
  | "chembl"
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
  marketingCategory?: string; // populated for NDC-resolved results (e.g. "OTC MONOGRAPH DRUG")
  sources: SourceHit[];
  cached: boolean;
  lookedUpAt: string;
}

export interface AppSettings {
  openfdaApiKey: string;
  cacheTtlDays: number;
  showSourcesByDefault: boolean;
}
