import type { TextStyle } from 'react-native'

import type { DeepPartial } from '../utils/utility-types'

export interface Palette {
  main: string
  contrastText: string
}

export type Typography = Pick<
  TextStyle,
  'fontFamily' | 'fontWeight' | 'fontSize' | 'lineHeight' | 'letterSpacing' | 'textAlign'
>

export interface ThemeInterface {
  palette: {
    primary: Palette
    nowIndicator: string
    gray: {
      100: string
      200: string
      300: string
      500: string
      800: string
    }
    moreLabel: string
  }
  isRTL: boolean
  typography: {
    fontFamily?: string
    xs: Typography
    sm: Typography
    xl: Typography
    moreLabel: Typography
  }
  eventCellOverlappings: readonly Palette[]
}

export type PartialTheme = DeepPartial<ThemeInterface>
