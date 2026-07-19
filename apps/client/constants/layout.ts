// Shared chrome geometry. Anything that rests above the tab bar (docked
// composer, toasts) must use the same safe-area-aware height as navigation.
export const SCREEN_HEADER_HEIGHT = 56;
export const TAB_BAR_TOP_INSET = 6;
export const TAB_BAR_ITEM_HEIGHT = 44;
export const TAB_BAR_MIN_BOTTOM_INSET = 6;
export const TAB_BAR_LABEL_FONT_SIZE = 10;
// With labels the content reaches lower in the item, so give the bar extra
// bottom padding. Folded into the shared helpers below so the docked composer
// and toasts (which rest on the bar) follow the height automatically.
export const TAB_BAR_LABELS_BOTTOM_EXTRA = 6;

export const tabBarBottomInset = (safeAreaBottom: number, labels = false) =>
  Math.max(safeAreaBottom, TAB_BAR_MIN_BOTTOM_INSET) + (labels ? TAB_BAR_LABELS_BOTTOM_EXTRA : 0);

export const tabBarHeight = (safeAreaBottom: number, labels = false) =>
  TAB_BAR_TOP_INSET + TAB_BAR_ITEM_HEIGHT + tabBarBottomInset(safeAreaBottom, labels);
