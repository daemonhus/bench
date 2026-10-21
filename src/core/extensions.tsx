import { createContext, useContext, type ReactNode } from 'react';
import type { FeatureKind } from './types';

/** Another project's feature, as the host resolves a "<project>:<id>" reference to it. */
export interface ForeignFeature {
  /** The reference: "<project>:<id>". */
  ref: string;
  project: string;
  projectName: string;
  id: string;
  title: string;
  kind: FeatureKind;
  operation?: string;
  fileId?: string;
  description?: string;
  /** The project or the feature is gone. */
  missing?: boolean;
}

/** Another project's finding, likewise. */
export interface ForeignFinding {
  ref: string;
  project: string;
  projectName: string;
  id: string;
  title: string;
  severity: string;
  status: string;
  missing?: boolean;
}

/** Other projects of the same server, for links that span them (see core/cross-refs). */
export interface OtherProjects {
  /** Other projects' features matching a query, for the link picker. */
  searchFeatures(q: string): Promise<ForeignFeature[]>;
  /** Resolves "<project>:<id>" feature references (missing ones flagged). */
  features(refs: string[]): Promise<ForeignFeature[]>;
  /** Resolves "<project>:<id>" finding references. */
  findings(refs: string[]): Promise<ForeignFinding[]>;
  /** Opens a page of another project: its hash route, e.g. "#/feature/<id>". */
  open(project: string, hash: string): void;
}

/**
 * Optional content a host (e.g. the platform) can contribute to workbench pages.
 * A host that provides none leaves every slot empty.
 */
export interface WorkbenchExtensions {
  /** Extra cards for the feature detail page's side column, under Provenance. */
  featureDetailAside?: (featureId: string) => ReactNode;
  /** Extra cards for the finding detail page's side column, under Provenance. */
  findingDetailAside?: (findingId: string) => ReactNode;
  /** A control at the start of the tab bar's actions, top right (the platform's search). */
  tabBarSearch?: ReactNode;
  /** The server's other projects: features and findings can link to theirs. */
  otherProjects?: OtherProjects;
}

const Ctx = createContext<WorkbenchExtensions>({});
export const WorkbenchExtensionsProvider = Ctx.Provider;
export const useWorkbenchExtensions = () => useContext(Ctx);
