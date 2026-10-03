import { closeLabel } from '@estate/shared-ui';

/** The name this site gives the toast's close control. */
export const CLOSE_NAME = 'Close';

/** The shared library's name for the same control. */
export const sharedCloseName = () => closeLabel();

/** The toast this site renders. */
export function renderNotice(message) {
  return `<div role="status">${message}<button aria-label="${CLOSE_NAME}">x</button></div>`;
}
