import { closeLabel } from '@estate/shared-ui';

/** The toast this site renders, with its close control named through closeLabel(). */
export function renderNotice(message) {
  return `<div role="status">${message}<button aria-label="${closeLabel()}">x</button></div>`;
}
