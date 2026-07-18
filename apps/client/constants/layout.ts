// Shared chrome geometry. Anything that rests above the tab bar (docked
// composer, toasts) must use the same safe-area-aware height as navigation.
export const SCREEN_HEADER_HEIGHT = 56;
export const TAB_BAR_ITEM_HEIGHT = 44;
export const TAB_BAR_MIN_BOTTOM_INSET = 6;

export const tabBarBottomInset = (safeAreaBottom: number) =>
  Math.max(safeAreaBottom, TAB_BAR_MIN_BOTTOM_INSET);

export const tabBarHeight = (safeAreaBottom: number) =>
  TAB_BAR_ITEM_HEIGHT + tabBarBottomInset(safeAreaBottom);
