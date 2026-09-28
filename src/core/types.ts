export type Side = 'left' | 'right';

export interface SourceFile {
  id: string;
  side: Side;
  relativePath: string;
  absolutePath: string;
  rawText: string;
  checksum: string;
  includedBy: string | null;
  includeRawToken: string | null;
  includeDepth: number;
}

export interface PhysicalLine {
  id: string;
  sourceId: string;
  lineNumber: number;
  rawText: string;
  continuation: boolean;
}

export interface LogicalLine {
  id: string;
  sourceId: string;
  startLine: number;
  endLine: number;
  rawText: string;
  continuationText: string;
  physicalLineIds: string[];
}

export type ParamOrigin = 'root' | 'subckt-default' | 'instance-override';

export interface ParameterSpec {
  name: string;
  rawValue: string;
  expressionText: string;
  quoted: boolean;
  sourceLineId: string;
}

export interface ParameterBinding {
  id: string;
  name: string;
  rawValue: string;
  expressionText: string;
  origin: ParamOrigin;
  scopePath: string;
  sourceLineId: string;
  defaultSourceLineId: string | null;
  dependencies: string[];
  quantity: Quantity;
}

export interface Quantity {
  raw: string;
  normalized: number | null;
  unit: string | null;
  scalePrefix: string | null;
  spiceUnit: string | null;
  basis: 'SI' | 'raw-only';
  diagnostic: string | null;
}

export interface ParameterScope {
  id: string;
  path: string;
  kind: 'root' | 'subckt-instance';
  parentPath: string | null;
  bindings: ParameterBinding[];
}

export interface ModelDefinition {
  id: string;
  name: string;
  kind: string;
  sourceId: string;
  sourceLineId: string;
  rawFields: Record<string, string>;
  normalizedFields: Record<string, Quantity>;
  version: string | null;
}

export interface PrimitiveStatement {
  kind: 'primitive';
  id: string;
  sourceId: string;
  line: LogicalLine;
  prefix: string;
  localName: string;
  terminals: string[];
  modelName: string | null;
  params: ParameterSpec[];
  freeTokens: string[];
  opaque: boolean;
}

export interface InstanceCall {
  kind: 'instance-call';
  id: string;
  sourceId: string;
  line: LogicalLine;
  localName: string;
  terminals: string[];
  subcktName: string;
  params: ParameterSpec[];
}

export interface SubcktDefinition {
  kind: 'subckt-definition';
  id: string;
  sourceId: string;
  line: LogicalLine;
  endLineId: string | null;
  name: string;
  ports: string[];
  defaults: ParameterSpec[];
  body: Statement[];
}

export interface ModelStatement {
  kind: 'model';
  id: string;
  sourceId: string;
  line: LogicalLine;
  model: ModelDefinition;
}

export interface ParamStatement {
  kind: 'param';
  id: string;
  sourceId: string;
  line: LogicalLine;
  params: ParameterSpec[];
}

export interface IncludeStatement {
  kind: 'include';
  id: string;
  sourceId: string;
  line: LogicalLine;
  rawPath: string;
  resolvedPath: string | null;
  targetSourceId: string | null;
}

export interface UnknownStatement {
  kind: 'unknown';
  id: string;
  sourceId: string;
  line: LogicalLine;
  rawText: string;
}

export type Statement =
  | PrimitiveStatement
  | InstanceCall
  | SubcktDefinition
  | ModelStatement
  | ParamStatement
  | IncludeStatement
  | UnknownStatement;

export interface Diagnostic {
  id: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  sourceId: string | null;
  lineId: string | null;
  relatedSourceId: string | null;
  stableKey: string;
}

export interface ParsedSource {
  file: SourceFile;
  physicalLines: PhysicalLine[];
  logicalLines: LogicalLine[];
}

export interface ParsedSide {
  side: Side;
  rootPath: string;
  sources: ParsedSource[];
  rootStatements: Statement[];
  definitions: SubcktDefinition[];
  models: ModelDefinition[];
  diagnostics: Diagnostic[];
  includeGraph: Array<{ from: string; to: string; rawToken: string; lineId: string }>;
}

export interface FlatPrimitive {
  id: string;
  stablePath: string;
  prefix: string;
  localName: string;
  terminals: Array<{ port: string; nodeId: string; symmetric: boolean }>;
  modelName: string | null;
  parameters: ParameterBinding[];
  sourceStatementId: string;
  sourceLineId: string;
  sourceId: string;
  opaque: boolean;
}

export interface FlatInstance {
  id: string;
  stablePath: string;
  localName: string;
  definitionSourceId: string;
  definitionLineId: string;
  definitionId: string;
  terminals: Array<{ port: string; nodeId: string }>;
  parameters: ParameterBinding[];
  children: FlatInstance[];
  primitives: FlatPrimitive[];
  sourceLineId: string;
  sourceId: string;
}

export interface FlatNode {
  id: string;
  localName: string;
  scopePath: string;
  displayName: string;
  external: boolean;
  ground: boolean;
}

export interface DefinitionChoice {
  instancePath: string;
  definitionId: string;
  sourceId: string;
  sourceLineId: string;
}

export interface FlatCandidate {
  id: string;
  choiceKey: string;
  choices: DefinitionChoice[];
  rootInstances: FlatInstance[];
  rootPrimitives: FlatPrimitive[];
  nodes: FlatNode[];
  scopes: ParameterScope[];
  allPrimitives: FlatPrimitive[];
  diagnostics: Diagnostic[];
}

export interface SnapshotAnalysis {
  side: Side;
  parsed: ParsedSide;
  candidates: FlatCandidate[];
  artifacts: ArtifactState[];
  diagnostics: Diagnostic[];
}

export interface ArtifactState {
  id: string;
  kind: string;
  stableIdentity: string;
  hash: string;
  dependsOn: string[];
  status: 'created' | 'reused' | 'invalidated' | 'error';
  reason: string;
}

export type DifferenceSeverity = 'hard' | 'uncertain' | 'info';

export interface Difference {
  id: string;
  stableKey: string;
  severity: DifferenceSeverity;
  code: string;
  message: string;
  leftArtifactIds: string[];
  rightArtifactIds: string[];
  leftSourceLineIds: string[];
  rightSourceLineIds: string[];
  dependencyEdges: Array<{ from: string; to: string; label: string }>;
}

export interface MinimalSubgraph {
  id: string;
  differenceIds: string[];
  nodeIds: { left: string[]; right: string[] };
  instanceIds: { left: string[]; right: string[] };
}

export interface NodeMapping {
  leftNodeId: string;
  rightNodeId: string;
}

export interface InstanceMapping {
  leftInstanceId: string;
  rightInstanceId: string;
  kind: 'primitive' | 'subcircuit';
}

export interface EquivalenceCandidate {
  id: string;
  leftCandidateId: string;
  rightCandidateId: string;
  status: 'equivalent' | 'inequivalent' | 'uncertain';
  nodeMappings: NodeMapping[];
  instanceMappings: InstanceMapping[];
  differences: Difference[];
  minimalSubgraphs: MinimalSubgraph[];
  score: number;
}

export interface ReviewEvent {
  id: string;
  parentId: string | null;
  seq: number;
  at: string;
  actor: string;
  type: 'import' | 'replay-stage' | 'parameter-adjustment' | 'accept' | 'reject' | 'conflict' | 'conflict-resolved' | 'note';
  summary: string;
  payload: unknown;
  directSourceId: string | null;
  derivationVersionId: string | null;
  baseVersionId: string | null;
}

export interface ReviewState {
  id: string;
  caseId: string;
  stageId: string;
  title: string;
  ruleVersion: string;
  left: SnapshotAnalysis;
  right: SnapshotAnalysis;
  equivalenceCandidates: EquivalenceCandidate[];
  selectedCandidateIds: string[];
  rejectedCandidateIds: string[];
  events: ReviewEvent[];
  currentEventId: string;
  diagnostics: Diagnostic[];
  createdAt: string;
}
