import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

// A minimal in-tree portal. Why not RN <Modal>? Each <Modal> is a separate
// native window, and presenting one over another (a modal opened from a modal)
// is broken on iOS — the inner one doesn't show and its transparent layer eats
// every touch. Rendering all overlays into ONE host in the ONE React tree makes
// them stack correctly (by mount order) on both platforms. The host lives under
// ServerProvider/SafeAreaProvider (see _layout) so portaled content keeps
// useServer()/insets context.

type Ctx = { mount: (id: string, node: ReactNode) => void; unmount: (id: string) => void };
const PortalContext = createContext<Ctx | null>(null);

export function PortalProvider({ children }: { children: ReactNode }) {
  // Insertion-ordered map (string keys preserve order) → later-opened overlays
  // render last = on top.
  const [nodes, setNodes] = useState<Record<string, ReactNode>>({});

  const ctx: Ctx = {
    mount: (id, node) => setNodes((prev) => ({ ...prev, [id]: node })),
    unmount: (id) => setNodes((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    }),
  };

  const ids = Object.keys(nodes);
  return (
    <PortalContext.Provider value={ctx}>
      {children}
      {/* Mount the host ONLY when something is portaled. An always-present
          absoluteFill host — even with pointerEvents="box-none" — swallowed all
          touches on Android (box-none pass-through to a lower-z sibling is
          unreliable there); with no overlays there must be no host at all. */}
      {ids.length > 0 && (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {ids.map((id) => (
            <View key={id} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
              {nodes[id]}
            </View>
          ))}
        </View>
      )}
    </PortalContext.Provider>
  );
}

/** Render `children` into the root PortalProvider host instead of here in place. */
export function Portal({ children }: { children: ReactNode }) {
  const ctx = useContext(PortalContext);
  const id = useId();
  // Keep the hosted node fresh as children change; drop it on unmount.
  useEffect(() => {
    ctx?.mount(id, children);
  });
  useEffect(() => () => ctx?.unmount(id), []);
  return null;
}
