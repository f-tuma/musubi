import type { ThemeInterface } from './ThemeInterface'

export const defaultTheme: ThemeInterface = {
  isRTL: false,
  palette: {
    primary: {
      main: 'rgb(66, 133, 244)',
      contrastText: '#fff',
    },
    nowIndicator: 'red',
    gray: {
      100: '#f5f5f5',
      200: '#eeeeee',
      300: '#e0e0e0',
      500: '#9e9e9e',
      800: '#424242',
    },
    moreLabel: '#000000',
  },
  eventCellOverlappings: [
    { main: '#E26245', contrastText: '#fff' },
    { main: '#4AC001', contrastText: '#fff' },
    { main: '#5934C7', contrastText: '#fff' },
  ],
  typography: {
    xs: { fontSize: 10 },
    sm: { fontSize: 12 },
    xl: { fontSize: 22 },
    moreLabel: { fontSize: 11, fontWeight: 'bold' },
  },
}
