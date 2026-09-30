const control =
  '[data-slot="dialog-body"] :is(input, textarea, select, button, [tabindex="0"]):not(:disabled)';

/**
 * Open a provider dialog on its first control rather than on the help "?"
 * beside the title: that button shows its help on focus, so landing on it
 * would cover the form the person came to fill.
 */
export function focusDialogBody(event: Event) {
  const content = event.target;
  if (!(content instanceof HTMLElement)) return;
  event.preventDefault();
  (content.querySelector<HTMLElement>(control) ?? content).focus();
}
