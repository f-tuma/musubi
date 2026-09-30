import { createContext, useContext } from "react";

/**
 * Portals keep React context, so a picker opened inside an elevated dialog
 * knows to paint above it instead of behind it.
 */
export const ElevatedLayerContext = createContext(false);

export function useElevatedLayer() {
  return useContext(ElevatedLayerContext);
}
