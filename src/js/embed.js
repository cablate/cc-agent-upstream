// Two ways the app can be opened besides its normal shell:
//   ?split=1                  the admin's split view, a grid of conversations
//   ?conversation=<id>&embed=1 one conversation inside a split-view cell
// Read once at load; the address of a cell never changes while it is open.
const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
export const embedded = params.get('embed') === '1';
export const splitView = !embedded && params.get('split') === '1';
