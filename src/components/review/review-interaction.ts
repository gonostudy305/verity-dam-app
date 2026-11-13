/**
 * Shared keyboard guard for review controls. It deliberately includes ARIA
 * combobox/textbox roles because the product picker is not always a native
 * input element.
 */
export function isReviewTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;

  return Boolean(element.closest(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"]'
  ));
}
