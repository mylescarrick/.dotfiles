export type SkillInvocationMode = "agent-invocable" | "manual-only";

export type SkillSource =
  | { kind: "global"; root: string }
  | { kind: "user"; root: string }
  | { kind: "project"; root: string }
  | { kind: "project-legacy"; root: string }
  | { kind: "unknown"; root: string };

export interface LocatedSkillFile {
  editable: boolean;
  filePath: string;
  source: SkillSource;
}

export type SkillDiagnosticSeverity = "info" | "warning" | "error";

export interface SkillDiagnostic {
  message: string;
  severity: SkillDiagnosticSeverity;
}

export interface SkillRecord {
  baseDir: string;
  description: string;
  diagnostics: SkillDiagnostic[];
  editable: boolean;
  filePath: string;
  id: string;
  mode: SkillInvocationMode;
  name: string;
  source: SkillSource;
}

export interface SkillDraft {
  desiredMode: SkillInvocationMode;
  skill: SkillRecord;
}

export interface FrontmatterDocument {
  bodyText: string;
  contentStart: number;
  fields: Record<string, unknown>;
  frontmatterEnd: number;
  frontmatterStart: number;
  frontmatterText: string;
  hasFrontmatter: boolean;
  lineEnding: "\n" | "\r\n";
  raw: string;
}

export interface FrontmatterPatch {
  newText: string;
  oldText: string;
}

export interface SkillChange {
  filePath: string;
  from: SkillInvocationMode;
  patch: FrontmatterPatch;
  skill: SkillRecord;
  to: SkillInvocationMode;
}

export interface ApplyResult {
  applied: SkillChange[];
  errors: Array<{ skill?: SkillRecord; message: string }>;
  skipped: Array<{ skill: SkillRecord; reason: string }>;
}

export interface SkillToggleUiResult {
  action: "apply" | "cancel";
  drafts: SkillDraft[];
}
