// Card U8: the swarm's pixel robot, one per swarm agent, on a 12 x 14 grid. The console's
// swarm room and the swarm page draw the same one. Every pixel is an SVG rect with a class
// and no fill or style attribute: the stylesheet colours the screen by the agent's state,
// so the CSP needs nothing inline and no string from a model reaches this file.
export const AGENT_GRID = { width: 12, height: 14 };

/** The robot as [x, y, width, height, part]; part is 'body', 'screen' or 'eye'. Pure. */
export function swarmAgentPixels() {
  return [
    [5, 0, 2, 2, 'body'],                       // antenna
    [2, 2, 8, 6, 'body'],                       // head
    [3, 3, 6, 4, 'screen'],
    [4, 4, 1, 2, 'eye'], [7, 4, 1, 2, 'eye'],
    [5, 8, 2, 1, 'body'],                       // neck
    [3, 9, 6, 3, 'body'],                       // chest
    [1, 9, 2, 2, 'body'], [9, 9, 2, 2, 'body'], // arms
    [3, 12, 2, 2, 'body'], [7, 12, 2, 2, 'body'], // legs
  ];
}

const svgNs = 'http://www.w3.org/2000/svg';

/** One robot as an SVG element, hidden from assistive technology (its tile carries the words). */
export function swarmAgentSvg(doc = document) {
  const svg = doc.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${AGENT_GRID.width} ${AGENT_GRID.height}`);
  svg.setAttribute('class', 'swarm-agent');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('shape-rendering', 'crispEdges');
  for (const [x, y, width, height, part] of swarmAgentPixels()) {
    const rect = doc.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    rect.setAttribute('class', `sa-${part}`);
    svg.append(rect);
  }
  return svg;
}
