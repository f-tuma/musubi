// Generated from packages/design-system. Edit TypeScript sources and regenerate.
import SwiftUI

enum WidgetTokens {
  enum Layout {
    static let minListWidth: CGFloat = 180
    static let minListHeight: CGFloat = 180
    static let minCalendarWidth: CGFloat = 250
    static let minCalendarHeight: CGFloat = 280
    static let inset: CGFloat = 16
    static let radius: CGFloat = 20
    static let rowRadius: CGFloat = 10
    static let headerHeight: CGFloat = 48
    static let controlSize: CGFloat = 44
    static let controlGlyphSize: CGFloat = 24
    static let controlIconSize: CGFloat = 18
    static let footerHeight: CGFloat = 44
    static let taskCheckSize: CGFloat = 18
    static let metaIconSize: CGFloat = 12
    static let groupHeight: CGFloat = 24
    static let minGroupedListHeight: CGFloat = 256
    static let dividerWidth: CGFloat = 1
    static let headerActionGap: CGFloat = 4
    static let rowHeight: CGFloat = 48
    static let iosHeaderHeight: CGFloat = 32
    static let iosFooterHeight: CGFloat = 24
    static let iosRowHeight: CGFloat = 38
    static let rowGap: CGFloat = 4
    static let contentGap: CGFloat = 8
    static let stripeWidth: CGFloat = 2
    static let timeColumnWidth: CGFloat = 48
    static let timeColumnWideWidth: CGFloat = 96
    static let calendarWeekdayHeight: CGFloat = 24
    static let calendarDotRowHeight: CGFloat = 8
    static let calendarDotSize: CGFloat = 4
    static let calendarDotGap: CGFloat = 2
    static let calendarDotGroupWidth: CGFloat = 16
    static let calendarNumberAreaHeight: CGFloat = 24
    static let calendarTodaySize: CGFloat = 24
    static let calendarPillHeight: CGFloat = 20
    static let calendarPillGap: CGFloat = 2
    static let calendarPillInset: CGFloat = 4
    static let calendarOverflowHeight: CGFloat = 12
    static let yearWidth: CGFloat = 32
    static let yearHeight: CGFloat = 24
  }
  enum Type {
    static let titleSize: CGFloat = 14
    static let headerTitleSize: CGFloat = 18
    static let metaSize: CGFloat = 12
    static let groupSize: CGFloat = 11
    static let dateSize: CGFloat = 12
    static let statusSize: CGFloat = 12
    static let monthTitleSize: CGFloat = 20
    static let markSize: CGFloat = 24
    static let calendarDaySize: CGFloat = 13
    static let calendarNumberSize: CGFloat = 12
    static let calendarPillSize: CGFloat = 11
    static let calendarOverflowSize: CGFloat = 11
    static let yearSize: CGFloat = 16
  }
  static func surface(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 19 / 255.0, green: 19 / 255.0, blue: 22 / 255.0, opacity: 1) : Color(.sRGB, red: 239 / 255.0, green: 235 / 255.0, blue: 224 / 255.0, opacity: 1)
  }
  static func surfaceRaised(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 26 / 255.0, green: 26 / 255.0, blue: 30 / 255.0, opacity: 1) : Color(.sRGB, red: 232 / 255.0, green: 227 / 255.0, blue: 213 / 255.0, opacity: 1)
  }
  static func foreground(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 232 / 255.0, green: 228 / 255.0, blue: 217 / 255.0, opacity: 1) : Color(.sRGB, red: 28 / 255.0, green: 27 / 255.0, blue: 24 / 255.0, opacity: 1)
  }
  static func foregroundSecondary(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 232 / 255.0, green: 228 / 255.0, blue: 217 / 255.0, opacity: 0.72) : Color(.sRGB, red: 28 / 255.0, green: 27 / 255.0, blue: 24 / 255.0, opacity: 0.74)
  }
  static func foregroundMuted(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 232 / 255.0, green: 228 / 255.0, blue: 217 / 255.0, opacity: 0.56) : Color(.sRGB, red: 28 / 255.0, green: 27 / 255.0, blue: 24 / 255.0, opacity: 0.64)
  }
  static func accent(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 200 / 255.0, green: 85 / 255.0, blue: 61 / 255.0, opacity: 1) : Color(.sRGB, red: 179 / 255.0, green: 73 / 255.0, blue: 47 / 255.0, opacity: 1)
  }
  static func accentText(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 223 / 255.0, green: 116 / 255.0, blue: 92 / 255.0, opacity: 1) : Color(.sRGB, red: 167 / 255.0, green: 68 / 255.0, blue: 45 / 255.0, opacity: 1)
  }
  static func onAccent(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 0 / 255.0, green: 0 / 255.0, blue: 0 / 255.0, opacity: 1) : Color(.sRGB, red: 255 / 255.0, green: 255 / 255.0, blue: 255 / 255.0, opacity: 1)
  }
  static func controlFill(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 232 / 255.0, green: 228 / 255.0, blue: 217 / 255.0, opacity: 1) : Color(.sRGB, red: 74 / 255.0, green: 71 / 255.0, blue: 65 / 255.0, opacity: 1)
  }
  static func onControl(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 12 / 255.0, green: 12 / 255.0, blue: 14 / 255.0, opacity: 1) : Color(.sRGB, red: 244 / 255.0, green: 241 / 255.0, blue: 232 / 255.0, opacity: 1)
  }
  static func line(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 232 / 255.0, green: 228 / 255.0, blue: 217 / 255.0, opacity: 0.06) : Color(.sRGB, red: 28 / 255.0, green: 27 / 255.0, blue: 24 / 255.0, opacity: 0.08)
  }
  static func dayFeedback(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 200 / 255.0, green: 85 / 255.0, blue: 61 / 255.0, opacity: 0.25) : Color(.sRGB, red: 179 / 255.0, green: 73 / 255.0, blue: 47 / 255.0, opacity: 0.25)
  }
  static func pillInk(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 0 / 255.0, green: 0 / 255.0, blue: 0 / 255.0, opacity: 1) : Color(.sRGB, red: 0 / 255.0, green: 0 / 255.0, blue: 0 / 255.0, opacity: 1)
  }
  static func pillInkLight(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(.sRGB, red: 255 / 255.0, green: 255 / 255.0, blue: 255 / 255.0, opacity: 1) : Color(.sRGB, red: 255 / 255.0, green: 255 / 255.0, blue: 255 / 255.0, opacity: 1)
  }
}
