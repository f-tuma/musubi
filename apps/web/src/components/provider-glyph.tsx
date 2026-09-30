/**
 * Brand marks for the sign-in buttons.
 *
 * Not `ProviderIcon` from the calendar side: that one is a *source* mark (this
 * event came from Google), drawn in the app's own line style. A sign-in button
 * is the provider speaking for itself — a calendar glyph next to "Continue with
 * Google" reads as connecting a calendar, and Google's own guidance asks for the
 * G. Same marks the phone uses, so the two front doors look like one product.
 * Calendar chips opt into monochrome to use their own calendar pigment.
 */
export function ProviderGlyph({ provider, monochrome = false }: { provider: string; monochrome?: boolean }) {
  if (provider === "google") {
    return (
      <svg aria-hidden="true" focusable="false" height="18" viewBox="0 0 48 48" width="18">
        <path
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          fill={monochrome ? "currentColor" : "#EA4335"}
        />
        <path
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          fill={monochrome ? "currentColor" : "#4285F4"}
        />
        <path
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
          fill={monochrome ? "currentColor" : "#FBBC05"}
        />
        <path
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          fill={monochrome ? "currentColor" : "#34A853"}
        />
      </svg>
    );
  }

  if (provider === "microsoft") {
    return (
      <svg aria-hidden="true" focusable="false" height="17" viewBox="0 0 23 23" width="17">
        <path d="M1 1h10v10H1z" fill={monochrome ? "currentColor" : "#F25022"} />
        <path d="M12 1h10v10H12z" fill={monochrome ? "currentColor" : "#7FBA00"} />
        <path d="M1 12h10v10H1z" fill={monochrome ? "currentColor" : "#00A4EF"} />
        <path d="M12 12h10v10H12z" fill={monochrome ? "currentColor" : "#FFB900"} />
      </svg>
    );
  }

  if (provider === "apple") {
    // `currentColor`, unlike the other two: Apple's mark is monochrome and has to
    // read on both the light and the dark surface the button sits on.
    return (
      <svg aria-hidden="true" fill="currentColor" focusable="false" height="18" viewBox="0 0 24 24" width="18">
        <path d="M17.05 12.04c-.03-2.43 1.99-3.6 2.08-3.66-1.13-1.66-2.89-1.89-3.52-1.92-1.5-.15-2.93.88-3.69.88-.76 0-1.93-.86-3.17-.84-1.63.02-3.13.95-3.97 2.41-1.69 2.94-.43 7.29 1.21 9.68.8 1.17 1.76 2.48 3.01 2.43 1.21-.05 1.67-.78 3.13-.78 1.46 0 1.87.78 3.15.76 1.3-.02 2.12-1.19 2.92-2.36.92-1.35 1.3-2.66 1.32-2.73-.03-.01-2.53-.97-2.56-3.85zM14.63 4.84c.67-.81 1.12-1.94.99-3.07-.96.04-2.13.64-2.82 1.45-.62.72-1.16 1.87-1.02 2.97 1.07.08 2.17-.54 2.85-1.35z" />
      </svg>
    );
  }

  return null;
}
