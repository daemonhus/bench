import { createContext, useContext, type ReactNode } from 'react';

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
}

const Ctx = createContext<WorkbenchExtensions>({});
export const WorkbenchExtensionsProvider = Ctx.Provider;
export const useWorkbenchExtensions = () => useContext(Ctx);
